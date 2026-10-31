// ============================================================
// WhatsApp appointment reminders (migration 097) — the cron's sender.
//
// `agenda_reminders_claim()` flips pending -> sending in ONE SQL statement
// (FOR UPDATE SKIP LOCKED), so overlapping ticks split the rows and a reminder
// is never sent twice; the (event, slot, start) unique key means the same
// reminder is never even planned twice. Each claimed row is re-checked against
// the world as it is NOW (settings, appointment, contact, plan, window), then
// sent through the shared engine senders. Every outcome is written back:
// `sent`, `skipped` + a reason code, `failed` + text, or — when the QR gateway
// is throttled — back to `pending` with a later `next_try_at` (never lost).
//
//   QR        free text + "Responda 1 para confirmar ou 2 para remarcar",
//             priority 'bulk' (paced by the gateway queue).
//   Official  inside the 24 h window: same free text. Outside: the approved
//             template the account configured, else skipped (window_closed).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { engineSendTemplate, engineSendText } from '@/lib/automations/meta-send';
import { AccountReadOnlyError } from '@/lib/billing/read-only';
import { isPushConfigured, sendPushToUsers } from '@/lib/push/send';
import { conversationUrl } from '@/lib/push/notify';
import { accountIsWritable } from '@/lib/plans-server';
import { TEMPLATE_NEEDS_SYNC_ERROR } from '@/lib/whatsapp/template-row-guard';
import { findSuppressedPhones } from '@/lib/lgpd/suppression';
import { GatewayRequestError, isGatewayThrottled } from '@/lib/whatsapp/qr-gateway';

import { loadTimezone } from './data';
import {
  canRetry,
  formatWhen,
  isTooLate,
  MAX_SEND_ATTEMPTS,
  maskDigits,
  planSend,
  reconnectDelayMs,
  reminderBody,
  retryDelayMs,
  safeFirstName,
  templateParams,
  type ReminderSettings,
  type ReminderVars,
  type SkipReason,
} from './reminders-core';

export const REMINDER_BATCH = 25;
export const REMINDER_MAX_BATCHES = 4;

export interface ReminderRow {
  id: string;
  account_id: string;
  event_id: string;
  slot: number;
  offset_minutes: number;
  for_starts_at: string;
  due_at: string;
  attempts: number;
}

export interface ReminderDeps {
  sendText?: typeof engineSendText;
  sendTemplate?: typeof engineSendTemplate;
  /** Account not blocked (read-only mode sends nothing); defaults to the plan check. */
  writable?: (db: SupabaseClient, accountId: string) => Promise<boolean>;
  notifyFailure?: (userIds: string[], conversationId: string | null, reason: string, reminderId: string) => Promise<void>;
}

export interface ReminderDispatchResult {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  retrying: number;
}

type Outcome =
  | { state: 'sent'; wa_message_id: string | null; channel: 'qr' | 'official'; error_code?: string }
  | { state: 'skipped'; reason: SkipReason }
  | { state: 'failed'; reason: string; error_text: string }
  | { state: 'retry'; delayMs: number };

class Skip extends Error {
  constructor(readonly reason: SkipReason) {
    super(reason);
  }
}

interface EventRow {
  id: string;
  account_id: string;
  status: string;
  starts_at: string;
  contact_id: string | null;
  conversation_id: string | null;
  service_id: string | null;
  resource_id: string | null;
  owner_user_id: string | null;
  created_by: string | null;
}

interface ConversationRow {
  id: string;
  status: string;
  channel: string | null;
  last_customer_message_at: string | null;
  assigned_agent_id: string | null;
  last_message_at: string | null;
  created_at: string;
}

/** A DB failure AFTER the provider accepted the message: it went out, never retry it. */
const ALREADY_SENT_RE = /(sent to Meta|sent via gateway) but DB insert failed/i;

function one<T>(res: { data: unknown; error: { message: string } | null }): T | null {
  if (res.error) throw new Error(res.error.message);
  return (res.data as T | null) ?? null;
}

/** The conversation to send in: an open one first, else the appointment's own, else the newest. */
export function pickConversation(rows: ConversationRow[], preferredId: string | null): ConversationRow | null {
  if (rows.length === 0) return null;
  const stamp = (c: ConversationRow) => Date.parse(c.last_message_at ?? c.created_at) || 0;
  const byRecent = [...rows].sort((a, b) => stamp(b) - stamp(a));
  return byRecent.find((c) => c.status !== 'closed') ?? rows.find((c) => c.id === preferredId) ?? byRecent[0];
}

async function prepare(
  db: SupabaseClient,
  row: ReminderRow,
  now: Date,
  deps: ReminderDeps,
): Promise<{
  event: EventRow;
  conv: ConversationRow;
  settings: ReminderSettings;
  vars: ReminderVars;
  userId: string;
  plan: ReturnType<typeof planSend>;
}> {
  const settings = one<ReminderSettings>(
    await db.from('agenda_reminder_settings').select('*').eq('account_id', row.account_id).maybeSingle(),
  );
  const offset = row.slot === 1 ? settings?.first_offset_minutes : settings?.second_offset_minutes;
  if (!settings || !settings.enabled || offset == null) throw new Skip('disabled');

  const event = one<EventRow>(
    await db
      .from('calendar_events')
      .select('id, account_id, status, starts_at, contact_id, conversation_id, service_id, resource_id, owner_user_id, created_by')
      .eq('id', row.event_id)
      .eq('account_id', row.account_id)
      .maybeSingle(),
  );
  if (
    !event ||
    !event.contact_id ||
    (event.status !== 'scheduled' && event.status !== 'confirmed') ||
    Date.parse(event.starts_at) !== Date.parse(row.for_starts_at) ||
    Date.parse(event.starts_at) <= now.getTime()
  ) {
    throw new Skip('appointment_closed');
  }

  // Claimed long after it was due (cron down): a stale "see you tomorrow" is worse than none.
  if (isTooLate(now, row.due_at, row.offset_minutes)) throw new Skip('late');

  if (!(await (deps.writable ?? accountIsWritable)(db, row.account_id))) throw new Skip('read_only');

  const contact = one<{ name: string | null; phone: string | null; opted_out_at: string | null; anonymized_at: string | null }>(
    await db
      .from('contacts')
      .select('name, phone, opted_out_at, anonymized_at')
      .eq('id', event.contact_id)
      .eq('account_id', row.account_id)
      .maybeSingle(),
  );
  if (!contact) throw new Skip('appointment_closed');
  if (contact.anonymized_at) throw new Skip('anonymized');
  if (contact.opted_out_at) throw new Skip('opted_out');
  if (!contact.phone || !contact.phone.trim()) throw new Skip('no_phone');
  // LGPD suppression list (erased / opted-out numbers that no longer have a contact row). A failed
  // lookup is an error (the row fails visibly), never a send.
  if ((await findSuppressedPhones(db, row.account_id, [contact.phone])).has(contact.phone)) throw new Skip('opted_out');

  const convs = await db
    .from('conversations')
    .select('id, status, channel, last_customer_message_at, assigned_agent_id, last_message_at, created_at')
    .eq('account_id', row.account_id)
    .eq('contact_id', event.contact_id)
    .order('created_at', { ascending: false })
    .limit(10);
  if (convs.error) throw new Error(convs.error.message);
  // Reminders are WhatsApp-only on purpose: they go out a day / two hours before the appointment, almost
  // always outside Instagram's / Messenger's 24 h window (and those channels have no templates), so an
  // Instagram / Messenger conversation is never a candidate.
  const whatsappConvs = ((convs.data ?? []) as ConversationRow[]).filter(
    (c) => c.channel !== 'instagram' && c.channel !== 'messenger',
  );
  const conv = pickConversation(whatsappConvs, event.conversation_id);
  if (!conv) throw new Skip('no_conversation');

  const [service, resource, tz] = await Promise.all([
    event.service_id ? db.from('agenda_services').select('name').eq('id', event.service_id).maybeSingle() : null,
    event.resource_id ? db.from('agenda_resources').select('name').eq('id', event.resource_id).maybeSingle() : null,
    loadTimezone(db, row.account_id),
  ]);
  const when = formatWhen(event.starts_at, tz);
  const vars: ReminderVars = {
    cliente: safeFirstName(contact.name),
    servico: (service?.data as { name?: string } | null)?.name ?? 'atendimento',
    profissional: (resource?.data as { name?: string } | null)?.name ?? 'nossa equipe',
    data: when.data,
    hora: when.hora,
  };

  const plan = planSend({
    channel: conv.channel === 'qr' ? 'qr' : 'official',
    lastCustomerMessageAt: conv.last_customer_message_at,
    now,
    hasTemplate: !!settings.template_name,
  });
  if (plan.kind === 'skip') throw new Skip(plan.reason);

  const userId = event.created_by ?? event.owner_user_id ?? (await accountOwner(db, row.account_id));
  if (!userId) throw new Error('account has no owner to send as');
  return { event, conv, settings, vars, userId, plan };
}

async function accountOwner(db: SupabaseClient, accountId: string): Promise<string | null> {
  const row = one<{ owner_user_id: string | null }>(
    await db.from('accounts').select('owner_user_id').eq('id', accountId).maybeSingle(),
  );
  return row?.owner_user_id ?? null;
}

async function send(
  db: SupabaseClient,
  row: ReminderRow,
  now: Date,
  deps: ReminderDeps,
): Promise<{ outcome: Outcome; notify: { userIds: string[]; conversationId: string | null } }> {
  let notify: { userIds: string[]; conversationId: string | null } = { userIds: [], conversationId: null };
  try {
    const p = await prepare(db, row, now, deps);
    notify = {
      userIds: [...new Set([p.conv.assigned_agent_id, p.event.owner_user_id, p.event.created_by].filter((u): u is string => !!u))],
      conversationId: p.conv.id,
    };
    const channel = p.conv.channel === 'qr' ? 'qr' : 'official';
    const base = { accountId: row.account_id, userId: p.userId, conversationId: p.conv.id, contactId: p.event.contact_id as string };
    // Serialize the account's quota across workers; a claim alone does not reserve a send.
    const reserved = await db.rpc('agenda_reminder_reserve_quota', {
      p_account_id: row.account_id,
      p_reminder_id: row.id,
    });
    if (reserved.error || (reserved.data !== true && reserved.data !== false)) {
      throw new Error('Não foi possível reservar a cota de lembretes.');
    }
    if (reserved.data === false) throw new Skip('daily_limit');
    try {
      const sent =
        p.plan.kind === 'template'
          ? await (deps.sendTemplate ?? engineSendTemplate)({
              ...base,
              templateName: p.settings.template_name as string,
              language: p.settings.template_language,
              params: templateParams(p.vars),
            })
          : await (deps.sendText ?? engineSendText)({
              ...base,
              text: reminderBody(p.settings.message_text, p.vars),
              origin: 'automation',
              // Paced by the gateway queue; a throttled answer parks the reminder for the next tries.
              priority: 'bulk',
            });
      return { outcome: { state: 'sent', wa_message_id: sent.whatsapp_message_id, channel }, notify };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (err instanceof AccountReadOnlyError) throw new Skip('read_only');
      if (raw === TEMPLATE_NEEDS_SYNC_ERROR || /template .* not found/i.test(raw)) throw new Skip('template_unavailable');
      if (ALREADY_SENT_RE.test(raw)) {
        return { outcome: { state: 'sent', wa_message_id: null, channel, error_code: 'not_saved' }, notify };
      }
      if (isGatewayThrottled(err)) {
        return row.attempts >= MAX_SEND_ATTEMPTS
          ? { outcome: { state: 'failed', reason: 'throttled', error_text: 'O WhatsApp está com a fila cheia; não foi possível enviar a tempo.' }, notify }
          : { outcome: { state: 'retry', delayMs: retryDelayMs(row.attempts) }, notify };
      }
      const down = disconnectReason(err, raw);
      if (down) {
        const delayMs = reconnectDelayMs(row.attempts);
        return canRetry({ now, delayMs, dueAt: row.due_at, offsetMinutes: row.offset_minutes, startsAt: p.event.starts_at })
          ? { outcome: { state: 'retry', delayMs }, notify }
          : { outcome: { state: 'skipped', reason: down }, notify };
      }
      return { outcome: { state: 'failed', reason: 'send_failed', error_text: failText(raw) }, notify };
    }
  } catch (err) {
    if (err instanceof Skip) return { outcome: { state: 'skipped', reason: err.reason }, notify };
    const raw = err instanceof Error ? err.message : String(err);
    return { outcome: { state: 'failed', reason: 'send_failed', error_text: failText(raw) }, notify };
  }
}

/** Gateway / provider error text can carry the recipient's number: never store or push it raw. */
function failText(raw: string): string {
  return maskDigits(`Falha ao enviar: ${raw}`).slice(0, 480);
}

/** The QR session is down, or the official channel was never set up: worth retrying while there is time. */
function disconnectReason(err: unknown, raw: string): SkipReason | null {
  if (err instanceof GatewayRequestError && err.code === 'not_connected') return 'whatsapp_disconnected';
  if (/WhatsApp not configured/i.test(raw)) return 'channel_not_configured';
  return null;
}

const WRITE_TRIES = 3;

/** Writes the outcome of a claimed row, checking the result and retrying; never throws (the send already happened). */
async function writeOutcome(db: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<boolean> {
  for (let i = 0; i < WRITE_TRIES; i++) {
    try {
      const { data, error } = await db.from('agenda_reminders').update(patch).eq('id', id).eq('state', 'sending').select('id');
      if (!error && ((data as unknown[] | null) ?? []).length > 0) return true;
      // The message really went out but the sweep parked the row as maybe_sent meanwhile: it ends as sent,
      // so the customer's reply can still match it.
      if (!error && patch.state === 'sent') {
        const parked = await db.from('agenda_reminders').update(patch).eq('id', id).eq('state', 'failed').eq('reason', 'maybe_sent').select('id');
        if (!parked.error) return true;
      }
      if (!error) return true;
      console.error('[agenda-reminders] outcome write failed:', error.message);
    } catch (err) {
      console.error('[agenda-reminders] outcome write threw:', err instanceof Error ? err.message : err);
    }
  }
  return false;
}

async function pushFailure(db: SupabaseClient, userIds: string[], conversationId: string | null, reason: string, reminderId: string): Promise<void> {
  if (!isPushConfigured() || userIds.length === 0) return;
  await sendPushToUsers(db, userIds, {
    title: 'Lembrete de agendamento não enviado',
    body: reason.slice(0, 140),
    url: conversationId ? conversationUrl(conversationId) : '/agenda',
    tag: `agenda-reminder:${reminderId}`,
  });
}

async function dispatchRow(db: SupabaseClient, row: ReminderRow, now: Date, deps: ReminderDeps): Promise<keyof Omit<ReminderDispatchResult, 'claimed'>> {
  // Reply ordering stays conservative: an agent may write while the sender finishes.
  const sentAt = new Date().toISOString();
  const { outcome, notify } = await send(db, row, now, deps);
  const stamp = new Date().toISOString();
  switch (outcome.state) {
    case 'sent':
      await writeOutcome(db, row.id, {
        state: 'sent',
        sent_at: sentAt,
        // Once sent, this column marks completion for the rolling quota window.
        quota_reserved_at: stamp,
        wa_message_id: outcome.wa_message_id,
        channel: outcome.channel,
        reason: null,
        ...(outcome.error_code ? { error_text: 'Enviado, mas não foi gravado na conversa.' } : {}),
        updated_at: stamp,
      });
      return 'sent';
    case 'skipped':
      await writeOutcome(db, row.id, { state: 'skipped', reason: outcome.reason, quota_reserved_at: null, updated_at: stamp });
      return 'skipped';
    case 'retry':
      await writeOutcome(db, row.id, {
        state: 'pending',
        next_try_at: new Date(now.getTime() + outcome.delayMs).toISOString(),
        claimed_at: null,
        quota_reserved_at: null,
        updated_at: stamp,
      });
      return 'retrying';
    case 'failed':
      await writeOutcome(db, row.id, { state: 'failed', reason: outcome.reason, error_text: outcome.error_text, quota_reserved_at: null, updated_at: stamp });
      try {
        await (deps.notifyFailure ?? ((u, c, why, id) => pushFailure(db, u, c, why, id)))(notify.userIds, notify.conversationId, outcome.error_text, row.id);
      } catch (err) {
        console.error('[agenda-reminders] failure push threw:', err instanceof Error ? err.message : err);
      }
      return 'failed';
  }
}

/** Claims what is due and sends it. Batches loop while a batch comes back full, capped per call. */
export async function runReminderDispatch(
  db: SupabaseClient,
  opts: { now?: Date } & ReminderDeps = {},
): Promise<ReminderDispatchResult> {
  const now = opts.now ?? new Date();
  const out: ReminderDispatchResult = { claimed: 0, sent: 0, skipped: 0, failed: 0, retrying: 0 };
  for (let i = 0; i < REMINDER_MAX_BATCHES; i++) {
    const { data, error } = await db.rpc('agenda_reminders_claim', { p_now: now.toISOString(), p_limit: REMINDER_BATCH });
    if (error) {
      // Migration 097 not applied yet reads as nothing to do.
      if (/42883|PGRST202|does not exist|schema cache/i.test(`${error.code ?? ''} ${error.message}`)) return out;
      throw new Error(`claim failed: ${error.message}`);
    }
    const rows = (data ?? []) as ReminderRow[];
    out.claimed += rows.length;
    // Sequential: QR numbers are rate-sensitive.
    for (const row of rows) out[await dispatchRow(db, row, now, opts)]++;
    if (rows.length < REMINDER_BATCH) break;
  }
  return out;
}
