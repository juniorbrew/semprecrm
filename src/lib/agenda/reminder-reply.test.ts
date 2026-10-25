import { describe, expect, it, vi } from 'vitest';

import { makeFakeDb } from '@/lib/lgpd/fake-db.test-helper';

import { ACK_RESCHEDULE, ackConfirmed, tryHandleReminderReply } from './reminder-reply';

type Row = Record<string, unknown>;

const ACC = 'acc-1';
const NOW = new Date('2026-10-30T12:00:00Z');
const STARTS = '2026-10-31T17:30:00.000Z'; // Saturday 14:30 in São Paulo
const iso = (ms: number) => new Date(ms).toISOString();

/** Twin of agenda_reminder_respond: the latest-first selection already happened in the app. */
function respondRpc(fn: string, args: Record<string, unknown>, tables: Record<string, Row[]>) {
  if (fn !== 'agenda_reminder_respond') return { data: null, error: { message: `no rpc ${fn}` } };
  const rem = tables.agenda_reminders.find((r) => r.id === args.p_reminder_id && r.state === 'sent' && r.response == null);
  if (!rem) return { data: null, error: { code: 'AG009', message: 'agenda_appointment_not_found' } };
  const ev = tables.calendar_events.find((e) => e.id === rem.event_id)!;
  if (args.p_action === 'confirmed' && ev.status === 'scheduled') ev.status = 'confirmed';
  for (const r of tables.agenda_reminders) if (r.event_id === ev.id && r.state === 'sent' && r.response == null) r.response = args.p_action;
  ev.customer_response = args.p_action;
  return { data: ev, error: null };
}

function world(over: { reminders?: Row[]; events?: Row[]; flows?: Row[]; rpc?: typeof respondRpc } = {}) {
  const tables: Record<string, Row[]> = {
    accounts: [{ id: ACC, preferences: {} }],
    agenda_reminders: over.reminders ?? [
      { id: 'r1', account_id: ACC, event_id: 'e1', state: 'sent', response: null, for_starts_at: STARTS, sent_at: iso(NOW.getTime() - 3_600_000) },
    ],
    calendar_events: over.events ?? [
      { id: 'e1', account_id: ACC, contact_id: 'c1', status: 'scheduled', starts_at: STARTS, service_id: 's1', owner_user_id: 'u-pro', created_by: 'u-rec' },
    ],
    agenda_services: [{ id: 's1', name: 'Corte' }],
    conversations: [{ id: 'v1', assigned_agent_id: 'u-agent' }],
    conversation_events: [],
    flow_runs: over.flows ?? [],
  };
  const fake = makeFakeDb(tables, { rpc: over.rpc ?? respondRpc });
  const send = vi.fn().mockResolvedValue({ whatsapp_message_id: 'w' });
  const notify = vi.fn().mockResolvedValue(undefined);
  const reply = (text: string | null, type = 'text', contactId = 'c1') =>
    tryHandleReminderReply(fake.db, { accountId: ACC, contactId, conversationId: 'v1', userId: 'owner', type, text, now: NOW }, { send: send as never, notify });
  return { ...fake, tables, send, notify, reply };
}

describe('tryHandleReminderReply', () => {
  it('"1" confirms: appointment confirmed, pill in the thread, acknowledgement sent, no push', async () => {
    const w = world();
    expect(await w.reply('1')).toBe('confirmed');
    expect(w.rpcCalls[0]).toEqual({ fn: 'agenda_reminder_respond', args: { p_account_id: ACC, p_reminder_id: 'r1', p_action: 'confirmed' } });
    expect(w.tables.calendar_events[0]).toMatchObject({ status: 'confirmed', customer_response: 'confirmed' });
    expect(w.tables.conversation_events).toEqual([
      { account_id: ACC, conversation_id: 'v1', actor_user_id: null, event_type: 'agenda_reply', payload: { action: 'confirmed', starts_at: STARTS, service_name: 'Corte' } },
    ]);
    expect(w.send.mock.calls[0][0]).toMatchObject({ conversationId: 'v1', contactId: 'c1', priority: 'interactive', text: ackConfirmed('sábado, 31/10', '14:30') });
    expect(w.notify).not.toHaveBeenCalled();
  });

  it('"2" asks to reschedule: flagged for a human, agents notified, status untouched', async () => {
    const w = world();
    expect(await w.reply('Quero remarcar')).toBe('reschedule_requested');
    expect(w.tables.calendar_events[0]).toMatchObject({ status: 'scheduled', customer_response: 'reschedule_requested' });
    expect(w.tables.conversation_events[0]).toMatchObject({ event_type: 'agenda_reply', payload: { action: 'reschedule_requested' } });
    expect(w.send.mock.calls[0][0]).toMatchObject({ text: ACK_RESCHEDULE });
    expect(w.notify).toHaveBeenCalledWith(['u-agent', 'u-pro', 'u-rec'], 'v1', expect.stringContaining('remarcar'), 'e1');
  });

  it('works for an interactive button reply (official template quick reply)', async () => {
    const w = world();
    expect(await w.reply('Confirmar', 'interactive')).toBe('confirmed');
    const w2 = world();
    expect(await w2.reply('Remarcar', 'button')).toBe('reschedule_requested');
  });

  it('never acts on ambiguous or unrelated text, nor on media', async () => {
    const w = world();
    for (const text of ['obrigado', 'não posso ir', 'cancelar', '1 e 2', 'sim mas remarcar', 'qual o endereço?', null]) {
      expect(await w.reply(text)).toBeNull();
    }
    expect(await w.reply('1', 'image')).toBeNull();
    expect(w.rpcCalls).toHaveLength(0);
    expect(w.send).not.toHaveBeenCalled();
    expect(w.tables.conversation_events).toHaveLength(0);
  });

  it('only answers a reminder that is waiting: not answered, not too old, appointment open and ahead, same contact', async () => {
    const waiting = { id: 'r1', account_id: ACC, event_id: 'e1', state: 'sent', response: null, for_starts_at: STARTS, sent_at: iso(NOW.getTime() - 3_600_000) };
    const ev = { id: 'e1', account_id: ACC, contact_id: 'c1', status: 'scheduled', starts_at: STARTS, service_id: 's1', owner_user_id: null, created_by: null };
    const cases: [string, Parameters<typeof world>[0], string?][] = [
      ['already answered', { reminders: [{ ...waiting, response: 'confirmed' }] }],
      ['reminder not sent (skipped)', { reminders: [{ ...waiting, state: 'skipped' }] }],
      ['older than 48 h', { reminders: [{ ...waiting, sent_at: iso(NOW.getTime() - 49 * 3_600_000) }] }],
      ['appointment cancelled', { events: [{ ...ev, status: 'cancelled' }] }],
      ['appointment moved after the reminder', { events: [{ ...ev, starts_at: '2026-11-03T17:30:00.000Z' }] }],
      ['appointment already started', { events: [{ ...ev, starts_at: '2026-10-30T11:00:00.000Z' }], reminders: [{ ...waiting, for_starts_at: '2026-10-30T11:00:00.000Z' }] }],
      ['someone else\'s appointment', { events: [{ ...ev, contact_id: 'c2' }] }],
      ['no reminders at all', { reminders: [] }],
      ['a bot flow is waiting for an answer', { flows: [{ account_id: ACC, contact_id: 'c1', status: 'active' }] }],
    ];
    for (const [name, over] of cases) {
      const w = world(over);
      expect(await w.reply('1'), name).toBeNull();
      expect(w.tables.conversation_events, name).toHaveLength(0);
      expect(w.send, name).not.toHaveBeenCalled();
    }
  });

  it('answers the LATEST reminder when the contact has several appointments', async () => {
    const mk = (id: string, ev: string, sent: number) => ({ id, account_id: ACC, event_id: ev, state: 'sent', response: null, for_starts_at: STARTS, sent_at: iso(NOW.getTime() - sent) });
    const e = (id: string) => ({ id, account_id: ACC, contact_id: 'c1', status: 'scheduled', starts_at: STARTS, service_id: 's1', owner_user_id: null, created_by: null });
    const w = world({ reminders: [mk('old', 'e1', 20 * 3_600_000), mk('new', 'e2', 3_600_000)], events: [e('e1'), e('e2')] });
    expect(await w.reply('sim')).toBe('confirmed');
    expect(w.rpcCalls[0].args.p_reminder_id).toBe('new');
    expect(w.tables.calendar_events.find((x) => x.id === 'e1')?.status).toBe('scheduled');
  });

  it('a refused response (read-only account, lost race) is just a normal message', async () => {
    const w = world({ rpc: () => ({ data: null, error: { code: '42501', message: 'read_only_account: x' } }) });
    expect(await w.reply('1')).toBeNull();
    expect(w.tables.conversation_events).toHaveLength(0);
    expect(w.send).not.toHaveBeenCalled();
  });

  it('never throws: a failing database falls through as a normal message', async () => {
    const w = world();
    w.db.from = () => {
      throw new Error('db down');
    };
    expect(await w.reply('1')).toBeNull();
  });
});
