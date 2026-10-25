import { describe, expect, it, vi } from 'vitest';

import { AccountReadOnlyError } from '@/lib/billing/read-only';
import { makeFakeDb } from '@/lib/lgpd/fake-db.test-helper';
import { GatewayRequestError } from '@/lib/whatsapp/qr-gateway';
import { TEMPLATE_NEEDS_SYNC_ERROR } from '@/lib/whatsapp/template-row-guard';

import { pickConversation, runReminderDispatch } from './reminders';
import { REMINDER_OPTIONS_TEXT } from './reminders-core';

type Row = Record<string, unknown>;

const ACC = 'acc-1';
const NOW = new Date('2026-10-30T12:00:00Z');
const STARTS = '2026-10-31T17:30:00.000Z'; // Saturday 14:30 in São Paulo
const iso = (ms: number) => new Date(ms).toISOString();

/** Postgres twin of agenda_reminders_claim: pending and due -> sending, attempts + 1, in one step. */
function claimRpc(fn: string, args: Record<string, unknown>, tables: Record<string, Row[]>) {
  if (fn !== 'agenda_reminders_claim') return { data: null, error: { message: `no rpc ${fn}` } };
  const now = Date.parse(args.p_now as string);
  const due = tables.agenda_reminders
    .filter((r) => r.state === 'pending' && Date.parse((r.next_try_at ?? r.due_at) as string) <= now)
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)))
    .slice(0, args.p_limit as number);
  for (const r of due) Object.assign(r, { state: 'sending', claimed_at: iso(now), attempts: (r.attempts as number) + 1 });
  return { data: due.map((r) => ({ ...r })), error: null };
}

function world(over: { reminder?: Row; conv?: Row; contact?: Row; event?: Row; settings?: Row | null } = {}) {
  const tables: Record<string, Row[]> = {
    accounts: [{ id: ACC, owner_user_id: 'owner', preferences: { business_hours: { timezone: 'America/Sao_Paulo' } } }],
    agenda_reminder_settings:
      over.settings === null
        ? []
        : [{ account_id: ACC, enabled: true, first_offset_minutes: 1440, second_offset_minutes: 120, message_text: null, template_name: null, template_language: 'pt_BR', ...over.settings }],
    agenda_reminders: [
      { id: 'r1', account_id: ACC, event_id: 'e1', slot: 1, offset_minutes: 1440, for_starts_at: STARTS, due_at: iso(NOW.getTime() - 60_000), state: 'pending', attempts: 0, next_try_at: null, ...over.reminder },
    ],
    calendar_events: [
      { id: 'e1', account_id: ACC, status: 'scheduled', starts_at: STARTS, contact_id: 'c1', conversation_id: 'v1', service_id: 's1', resource_id: 'p1', owner_user_id: 'u-pro', created_by: 'u-rec', ...over.event },
    ],
    contacts: [{ id: 'c1', account_id: ACC, name: 'Maria Silva', phone: '5511999990000', opted_out_at: null, anonymized_at: null, ...over.contact }],
    conversations: [
      { id: 'v1', account_id: ACC, contact_id: 'c1', status: 'open', channel: 'qr', last_customer_message_at: null, assigned_agent_id: 'u-agent', last_message_at: iso(NOW.getTime() - 3_600_000), created_at: '2026-10-01T00:00:00Z', ...over.conv },
    ],
    agenda_services: [{ id: 's1', name: 'Corte' }],
    agenda_resources: [{ id: 'p1', name: 'Ana' }],
  };
  const fake = makeFakeDb(tables, { rpc: claimRpc });
  const sendText = vi.fn().mockResolvedValue({ whatsapp_message_id: 'wamid.1' });
  const sendTemplate = vi.fn().mockResolvedValue({ whatsapp_message_id: 'wamid.2' });
  const notifyFailure = vi.fn().mockResolvedValue(undefined);
  const deps = { sendText, sendTemplate, notifyFailure, writable: async () => true };
  const run = (extra: Record<string, unknown> = {}, now = NOW) => runReminderDispatch(fake.db, { ...deps, ...extra, now });
  return { ...fake, tables, sendText, sendTemplate, notifyFailure, run, state: () => tables.agenda_reminders[0] };
}

describe('QR channel', () => {
  it('sends free text with the numbered options, in the account timezone, as a paced bulk send', async () => {
    const w = world();
    expect(await w.run()).toEqual({ claimed: 1, sent: 1, skipped: 0, failed: 0, retrying: 0 });
    expect(w.sendText).toHaveBeenCalledTimes(1);
    const arg = w.sendText.mock.calls[0][0] as Row;
    expect(arg).toMatchObject({ accountId: ACC, conversationId: 'v1', contactId: 'c1', priority: 'bulk', origin: 'automation', userId: 'u-rec' });
    expect(arg.text).toContain('Olá, Maria!');
    expect(arg.text).toContain('Corte com Ana, sábado, 31/10 às 14:30');
    expect(arg.text).toContain(REMINDER_OPTIONS_TEXT);
    expect(w.state()).toMatchObject({ state: 'sent', wa_message_id: 'wamid.1', channel: 'qr' });
    expect(w.sendTemplate).not.toHaveBeenCalled();
  });

  it('uses the account text when configured', async () => {
    const w = world({ settings: { message_text: 'Amanhã às {hora} com {profissional}' } });
    await w.run();
    expect((w.sendText.mock.calls[0][0] as Row).text).toBe(`Amanhã às 14:30 com Ana\n\n${REMINDER_OPTIONS_TEXT}`);
  });

  it('two overlapping ticks never send the same reminder twice', async () => {
    const w = world();
    const [a, b] = await Promise.all([w.run(), w.run()]);
    expect(a.sent + b.sent).toBe(1);
    expect(a.claimed + b.claimed).toBe(1);
    expect(w.sendText).toHaveBeenCalledTimes(1);
    expect((await w.run()).claimed).toBe(0); // a sent reminder is never claimed again
    expect(w.sendText).toHaveBeenCalledTimes(1);
  });

  it('a reminder that is not due yet stays pending', async () => {
    const w = world({ reminder: { due_at: iso(NOW.getTime() + 3_600_000) } });
    expect((await w.run()).claimed).toBe(0);
    expect(w.state().state).toBe('pending');
  });

  it('throttled: parked for a later try, not lost, then sent; gives up visibly after the cap', async () => {
    const w = world();
    const throttled = vi.fn().mockRejectedValue(new GatewayRequestError('fila cheia', 429, 'throttled'));
    expect(await w.run({ sendText: throttled })).toMatchObject({ claimed: 1, retrying: 1, sent: 0, failed: 0 });
    expect(w.state()).toMatchObject({ state: 'pending', attempts: 1 });
    const next = Date.parse(w.state().next_try_at as string);
    expect(next).toBe(NOW.getTime() + 120_000);

    expect((await w.run({}, NOW)).claimed).toBe(0); // not before next_try_at
    expect(await w.run({}, new Date(next + 1000))).toMatchObject({ claimed: 1, sent: 1 });
    expect(w.state().state).toBe('sent');

    const stuck = world({ reminder: { attempts: 8 } });
    expect(await stuck.run({ sendText: throttled })).toMatchObject({ failed: 1, retrying: 0 });
    expect(stuck.state()).toMatchObject({ state: 'failed', reason: 'throttled' });
    expect(stuck.notifyFailure).toHaveBeenCalledTimes(1);
  });

  it('other send errors fail visibly and warn the team; a DB error after the provider accepted it counts as sent', async () => {
    const w = world();
    const boom = vi.fn().mockRejectedValue(new Error('gateway offline'));
    expect(await w.run({ sendText: boom })).toMatchObject({ failed: 1 });
    expect(w.state()).toMatchObject({ state: 'failed', reason: 'send_failed' });
    expect(String(w.state().error_text)).toContain('gateway offline');
    expect(w.notifyFailure).toHaveBeenCalledWith(['u-agent', 'u-pro', 'u-rec'], 'v1', expect.stringContaining('gateway offline'), 'r1');

    const w2 = world();
    const half = vi.fn().mockRejectedValue(new Error('sent via gateway but DB insert failed: x'));
    expect(await w2.run({ sendText: half })).toMatchObject({ sent: 1, failed: 0 });
    expect(w2.state().state).toBe('sent');
  });
});

describe('official channel', () => {
  const OFFICIAL = { channel: 'official' };
  const OLD = iso(NOW.getTime() - 30 * 3_600_000);
  const FRESH = iso(NOW.getTime() - 3_600_000);

  it('inside the 24 h window: free text with the options', async () => {
    const w = world({ conv: { ...OFFICIAL, last_customer_message_at: FRESH } });
    expect(await w.run()).toMatchObject({ sent: 1 });
    expect(w.sendText).toHaveBeenCalledTimes(1);
    expect(w.state().channel).toBe('official');
  });

  it('outside the window with no template: skipped with a visible reason, nothing sent', async () => {
    const w = world({ conv: { ...OFFICIAL, last_customer_message_at: OLD } });
    expect(await w.run()).toMatchObject({ skipped: 1, sent: 0 });
    expect(w.state()).toMatchObject({ state: 'skipped', reason: 'window_closed' });
    expect(w.sendText).not.toHaveBeenCalled();
    expect(w.sendTemplate).not.toHaveBeenCalled();
  });

  it('outside the window with the configured template: sends it with the five body parameters', async () => {
    const w = world({ conv: { ...OFFICIAL, last_customer_message_at: OLD }, settings: { template_name: 'lembrete_agenda', template_language: 'pt_BR' } });
    expect(await w.run()).toMatchObject({ sent: 1 });
    expect(w.sendText).not.toHaveBeenCalled();
    expect(w.sendTemplate.mock.calls[0][0]).toMatchObject({
      accountId: ACC,
      conversationId: 'v1',
      contactId: 'c1',
      templateName: 'lembrete_agenda',
      language: 'pt_BR',
      params: ['Maria', 'Corte', 'Ana', 'sábado, 31/10', '14:30'],
    });
    expect(w.state()).toMatchObject({ state: 'sent', wa_message_id: 'wamid.2' });
  });

  it('a template that is not synced / approved is a visible skip, not a retry loop', async () => {
    const w = world({ conv: { ...OFFICIAL, last_customer_message_at: OLD }, settings: { template_name: 'x' } });
    const needsSync = vi.fn().mockRejectedValue(new Error(TEMPLATE_NEEDS_SYNC_ERROR));
    expect(await w.run({ sendTemplate: needsSync })).toMatchObject({ skipped: 1 });
    expect(w.state()).toMatchObject({ state: 'skipped', reason: 'template_unavailable' });
  });
});

describe('skips (the world changed since planning)', () => {
  const cases: [string, Parameters<typeof world>[0], string][] = [
    ['reminders switched off', { settings: { enabled: false } }, 'disabled'],
    ['settings deleted', { settings: null }, 'disabled'],
    ['that offset removed', { settings: { first_offset_minutes: null } }, 'disabled'],
    ['appointment cancelled', { event: { status: 'cancelled' } }, 'appointment_closed'],
    ['appointment rescheduled after the reminder was planned', { event: { starts_at: '2026-11-02T17:30:00.000Z' } }, 'appointment_closed'],
    ['appointment already started', { event: { starts_at: '2026-10-30T11:00:00.000Z' }, reminder: { for_starts_at: '2026-10-30T11:00:00.000Z' } }, 'appointment_closed'],
    ['contact erased (LGPD)', { event: { contact_id: null } }, 'appointment_closed'],
    ['contact anonymized', { contact: { anonymized_at: '2026-10-01T00:00:00Z' } }, 'anonymized'],
    ['contact opted out', { contact: { opted_out_at: '2026-10-01T00:00:00Z' } }, 'opted_out'],
    ['contact without a phone', { contact: { phone: ' ' } }, 'no_phone'],
    ['contact without any conversation', { conv: { contact_id: 'someone-else' } }, 'no_conversation'],
  ];
  it.each(cases)('%s', async (_name, over, reason) => {
    const w = world(over);
    expect(await w.run()).toMatchObject({ skipped: 1, sent: 0 });
    expect(w.state()).toMatchObject({ state: 'skipped', reason });
    expect(w.sendText).not.toHaveBeenCalled();
    expect(w.sendTemplate).not.toHaveBeenCalled();
  });

  it('read-only account: skipped before and also if the sender discovers it', async () => {
    const w = world();
    expect(await w.run({ writable: async () => false })).toMatchObject({ skipped: 1 });
    expect(w.state()).toMatchObject({ state: 'skipped', reason: 'read_only' });
    expect(w.sendText).not.toHaveBeenCalled();

    const w2 = world();
    const blocked = vi.fn().mockRejectedValue(new AccountReadOnlyError());
    expect(await w2.run({ sendText: blocked })).toMatchObject({ skipped: 1 });
    expect(w2.state()).toMatchObject({ state: 'skipped', reason: 'read_only' });
  });

  it('a confirmed appointment still gets its reminder', async () => {
    const w = world({ event: { status: 'confirmed' } });
    expect(await w.run()).toMatchObject({ sent: 1 });
  });
});

describe('plumbing', () => {
  it('migration 097 not applied reads as nothing to do; other claim errors surface', async () => {
    const missing = makeFakeDb({}, { rpc: () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function in the schema cache' } }) });
    expect(await runReminderDispatch(missing.db, { now: NOW })).toEqual({ claimed: 0, sent: 0, skipped: 0, failed: 0, retrying: 0 });
    const broken = makeFakeDb({}, { rpc: () => ({ data: null, error: { message: 'connection reset' } }) });
    await expect(runReminderDispatch(broken.db, { now: NOW })).rejects.toThrow('claim failed');
  });

  it('picks an open conversation first, then the appointment own one, then the newest', () => {
    const c = (id: string, status: string, at: string) => ({ id, status, channel: 'qr', last_customer_message_at: null, assigned_agent_id: null, last_message_at: at, created_at: at });
    const rows = [c('old-open', 'open', '2026-10-01T00:00:00Z'), c('new-open', 'pending', '2026-10-20T00:00:00Z'), c('closed', 'closed', '2026-10-25T00:00:00Z')];
    expect(pickConversation(rows, 'closed')?.id).toBe('new-open');
    expect(pickConversation([rows[2], c('closed2', 'closed', '2026-10-26T00:00:00Z')], 'closed')?.id).toBe('closed');
    expect(pickConversation([rows[2], c('closed2', 'closed', '2026-10-26T00:00:00Z')], null)?.id).toBe('closed2');
    expect(pickConversation([], 'x')).toBeNull();
  });
});
