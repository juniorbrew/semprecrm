// ============================================================
// The customer's answer to an appointment reminder (migration 097).
//
// Called by ingestInboundMessage right after the message is stored. When the
// text is an unambiguous "1 / sim / confirmo" or "2 / remarcar" and the contact
// has a reminder we SENT (latest first, within 48 h) whose appointment is still
// open and in the future:
//   - confirmed            -> `agenda_reminder_respond` (atomic): the appointment
//                             goes scheduled -> confirmed through the status RPC;
//   - reschedule_requested -> the appointment is flagged "pediu para remarcar"
//                             and the agents get a push; a human moves it (the
//                             AI flow comes in delivery C);
// then a pill (`agenda_reply`) lands in the conversation and a short
// acknowledgement goes back to the customer.
//
// Vague words ("ok", "certo", 👍...) only count when the customer QUOTED the
// reminder, or when nothing was written to them after it (otherwise "ok" may be
// the answer to the agent's last message). Anything ambiguous, late, already
// answered or on a read-only account returns null and the message is just a
// normal message for the human. Never throws; once the RPC succeeded the action
// is always returned, whatever the follow-ups (pill, acknowledgement, push) do.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { engineSendText } from '@/lib/automations/meta-send';
import { conversationUrl } from '@/lib/push/notify';
import { isPushConfigured, sendPushToUsers } from '@/lib/push/send';

import { loadTimezone } from './data';
import { formatWhen, parseReminderReplyDetailed, REPLY_WINDOW_MS, type ReminderAction } from './reminders-core';

export interface ReminderReplyInput {
  accountId: string;
  contactId: string;
  /** Conversation the customer wrote in (the pill goes here). */
  conversationId: string;
  /** `user_id` the acknowledgement is sent as (account owner). */
  userId: string;
  type: string;
  text: string | null;
  /** Provider id of the message the customer swiped-replied to, if any. */
  quotedMessageId?: string | null;
  now?: Date;
}

export interface ReminderReplyDeps {
  send?: typeof engineSendText;
  notify?: (userIds: string[], conversationId: string, body: string, eventId: string) => Promise<void>;
}

const TEXT_TYPES = new Set(['text', 'interactive', 'button']);

export const ACK_RESCHEDULE =
  'Certo! Avisei a nossa equipe, que vai entrar em contato para combinar um novo horário.';

export function ackConfirmed(data: string, hora: string): string {
  return `Confirmado! Te esperamos ${data} às ${hora}. Até lá!`;
}

export async function tryHandleReminderReply(
  db: SupabaseClient,
  input: ReminderReplyInput,
  deps: ReminderReplyDeps = {},
): Promise<ReminderAction | null> {
  try {
    return await handle(db, input, deps);
  } catch (err) {
    console.error('[agenda-reply] failed, message goes through:', err instanceof Error ? err.message : err);
    return null;
  }
}

interface SentReminder {
  id: string;
  event_id: string;
  for_starts_at: string;
  sent_at: string | null;
  wa_message_id: string | null;
}

interface OpenEvent {
  id: string;
  status: string;
  starts_at: string;
  service_id: string | null;
  owner_user_id: string | null;
  created_by: string | null;
}

async function handle(db: SupabaseClient, input: ReminderReplyInput, deps: ReminderReplyDeps): Promise<ReminderAction | null> {
  if (!TEXT_TYPES.has(input.type)) return null;
  const parsed = parseReminderReplyDetailed(input.text);
  if (!parsed) return null;
  const { action } = parsed;
  const now = input.now ?? new Date();

  // A bot flow waiting for an answer owns the message ("1" may be its menu option).
  const flow = await db
    .from('flow_runs')
    .select('id')
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .eq('status', 'active')
    .limit(1);
  if (flow.error || (flow.data ?? []).length > 0) return null;

  // This contact's open future appointments FIRST, then their reminders: an account-wide "latest
  // 30 reminders" would lose the contact's in a busy account.
  const evs = await db
    .from('calendar_events')
    .select('id, status, starts_at, service_id, owner_user_id, created_by')
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .in('status', ['scheduled', 'confirmed'])
    .gt('starts_at', now.toISOString())
    .limit(50);
  if (evs.error || !evs.data?.length) return null;
  const events = new Map((evs.data as OpenEvent[]).map((e) => [e.id, e]));

  let reminderQuery = db
    .from('agenda_reminders')
    .select('id, event_id, for_starts_at, sent_at, wa_message_id')
    .eq('account_id', input.accountId)
    .eq('state', 'sent')
    .is('response', null)
    .in('event_id', [...events.keys()])
    .gte('sent_at', new Date(now.getTime() - REPLY_WINDOW_MS).toISOString())
    .order('sent_at', { ascending: false });
  if (input.quotedMessageId) reminderQuery = reminderQuery.eq('wa_message_id', input.quotedMessageId);
  const rem = await reminderQuery.limit(30);
  if (rem.error || !rem.data?.length) return null;

  // A quoted message must match that reminder; only unquoted replies use the latest one.
  const target = (rem.data as SentReminder[]).find((r) => {
    const e = events.get(r.event_id);
    return !!e && Date.parse(e.starts_at) === Date.parse(r.for_starts_at);
  });
  if (!target) return null;
  const event = events.get(target.event_id)!;

  if (parsed.vague && !(await answersReminder(db, input, target))) return null;

  const res = await db.rpc('agenda_reminder_respond', {
    p_account_id: input.accountId,
    p_reminder_id: target.id,
    p_action: action,
  });
  // Lost the race / already answered / read-only account: a normal message.
  if (res.error) return null;

  // From here the appointment IS updated: nothing below may turn the result into "not handled".
  try {
    await followUp(db, input, deps, action, event);
  } catch (err) {
    console.error('[agenda-reply] follow-up failed:', err instanceof Error ? err.message : err);
  }
  return action;
}

/** Vague words count only if they quote the reminder, or nobody wrote to the customer after it. */
async function answersReminder(db: SupabaseClient, input: ReminderReplyInput, reminder: SentReminder): Promise<boolean> {
  if (input.quotedMessageId && reminder.wa_message_id && input.quotedMessageId === reminder.wa_message_id) return true;
  if (!reminder.sent_at) return false;
  const convs = await db.from('conversations').select('id').eq('account_id', input.accountId).eq('contact_id', input.contactId);
  if (convs.error) return false;
  const ids = ((convs.data ?? []) as { id: string }[]).map((c) => c.id);
  if (ids.length === 0) return false;
  const laterMessages = () => db
    .from('messages')
    .select('id')
    .in('conversation_id', ids)
    .neq('sender_type', 'customer')
    .gt('created_at', reminder.sent_at!);
  // The sender persists the reminder after its sent_at stamp. Exclude only that message,
  // keeping local agent messages whose provider id is NULL (SQL <> would omit them).
  const later = reminder.wa_message_id
    ? await Promise.all([
        laterMessages().neq('message_id', reminder.wa_message_id).limit(1),
        laterMessages().is('message_id', null).limit(1),
      ])
    : [await laterMessages().limit(1)];
  return later.every((result) => !result.error && (result.data ?? []).length === 0);
}

async function followUp(
  db: SupabaseClient,
  input: ReminderReplyInput,
  deps: ReminderReplyDeps,
  action: ReminderAction,
  event: OpenEvent,
): Promise<void> {
  const [service, tz, conv] = await Promise.all([
    event.service_id ? db.from('agenda_services').select('name').eq('id', event.service_id).maybeSingle() : null,
    loadTimezone(db, input.accountId),
    db.from('conversations').select('assigned_agent_id').eq('id', input.conversationId).maybeSingle(),
  ]);
  const serviceName = (service?.data as { name?: string } | null)?.name ?? undefined;
  const when = formatWhen(event.starts_at, tz);

  const ev = await db.from('conversation_events').insert({
    account_id: input.accountId,
    conversation_id: input.conversationId,
    actor_user_id: null,
    event_type: 'agenda_reply',
    payload: { action, starts_at: event.starts_at, ...(serviceName ? { service_name: serviceName } : {}) },
  });
  if (ev.error) console.error('[agenda-reply] event insert failed:', ev.error.message);

  // Acknowledge to the customer (leaves at once: they just wrote).
  void (deps.send ?? engineSendText)({
    accountId: input.accountId,
    userId: input.userId,
    conversationId: input.conversationId,
    contactId: input.contactId,
    text: action === 'confirmed' ? ackConfirmed(when.data, when.hora) : ACK_RESCHEDULE,
    origin: 'automation',
    priority: 'interactive',
  }).catch((err: unknown) => console.error('[agenda-reply] ack not sent:', err instanceof Error ? err.message : err));

  if (action === 'reschedule_requested') {
    const assigned = (conv?.data as { assigned_agent_id?: string | null } | null)?.assigned_agent_id ?? null;
    const userIds = [...new Set([assigned, event.owner_user_id, event.created_by].filter((u): u is string => !!u))];
    const body = `Cliente pediu para remarcar${serviceName ? `: ${serviceName}` : ''}, ${when.data} às ${when.hora}.`;
    void (deps.notify ?? defaultNotify(db))(userIds, input.conversationId, body, event.id).catch((err: unknown) =>
      console.error('[agenda-reply] push failed:', err instanceof Error ? err.message : err),
    );
  }
}

function defaultNotify(db: SupabaseClient): NonNullable<ReminderReplyDeps['notify']> {
  return async (userIds, conversationId, body, eventId) => {
    if (!isPushConfigured() || userIds.length === 0) return;
    await sendPushToUsers(db, userIds, {
      title: 'Cliente pediu para remarcar',
      body,
      url: conversationUrl(conversationId),
      tag: `agenda-reschedule:${eventId}`,
    });
  };
}
