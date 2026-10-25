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

function world(over: { reminders?: Row[]; events?: Row[]; flows?: Row[]; messages?: Row[]; rpc?: typeof respondRpc } = {}) {
  const tables: Record<string, Row[]> = {
    accounts: [{ id: ACC, preferences: {} }],
    agenda_reminders: (over.reminders ?? [
      { id: 'r1', account_id: ACC, event_id: 'e1', state: 'sent', response: null, for_starts_at: STARTS, sent_at: iso(NOW.getTime() - 3_600_000) },
    ]).map((r) => ({ ...r })),
    calendar_events: (over.events ?? [
      { id: 'e1', account_id: ACC, contact_id: 'c1', status: 'scheduled', starts_at: STARTS, service_id: 's1', owner_user_id: 'u-pro', created_by: 'u-rec' },
    ]).map((e) => ({ ...e })),
    agenda_services: [{ id: 's1', name: 'Corte' }],
    conversations: [{ id: 'v1', assigned_agent_id: 'u-agent' }],
    conversation_events: [],
    flow_runs: over.flows ?? [],
    messages: over.messages ?? [],
  };
  tables.conversations.push({ id: 'v1', account_id: ACC, contact_id: 'c1' });
  const fake = makeFakeDb(tables, { rpc: over.rpc ?? respondRpc });
  const send = vi.fn().mockResolvedValue({ whatsapp_message_id: 'w' });
  const notify = vi.fn().mockResolvedValue(undefined);
  const reply = (text: string | null, type = 'text', contactId = 'c1', quotedMessageId: string | null = null) =>
    tryHandleReminderReply(fake.db, { accountId: ACC, contactId, conversationId: 'v1', userId: 'owner', type, text, quotedMessageId, now: NOW }, { send: send as never, notify });
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

describe('review fixes', () => {
  const SENT = iso(NOW.getTime() - 3_600_000);
  const waiting = { id: 'r1', account_id: ACC, event_id: 'e1', state: 'sent', response: null, for_starts_at: STARTS, sent_at: SENT, wa_message_id: 'wamid.rem' };

  it('word + emoji confirms ("Confirmo 👍", "Sim 👍")', async () => {
    for (const t of ['Confirmo 👍', 'Sim 👍', 'sim sim']) {
      const w = world();
      expect(await w.reply(t), t).toBe('confirmed');
    }
  });

  it('finds the contact reminder among more than 30 reminders of other contacts', async () => {
    const others = Array.from({ length: 45 }, (_, i) => ({ id: `o${i}`, account_id: ACC, event_id: `x${i}`, state: 'sent', response: null, for_starts_at: STARTS, sent_at: iso(NOW.getTime() - 60_000 - i * 1000), wa_message_id: null }));
    const otherEvents = others.map((o) => ({ id: o.event_id, account_id: ACC, contact_id: 'someone-else', status: 'scheduled', starts_at: STARTS, service_id: 's1', owner_user_id: null, created_by: null }));
    const w = world({
      reminders: [...others, { ...waiting, sent_at: iso(NOW.getTime() - 20 * 3_600_000) }],
      events: [...otherEvents, { id: 'e1', account_id: ACC, contact_id: 'c1', status: 'scheduled', starts_at: STARTS, service_id: 's1', owner_user_id: null, created_by: null }],
    });
    expect(await w.reply('1')).toBe('confirmed');
    expect(w.rpcCalls[0].args.p_reminder_id).toBe('r1');
  });

  it('vague words ("ok", 👍, "certo") confirm only if nobody wrote to the customer after the reminder', async () => {
    const agentLater = [{ id: 'm1', conversation_id: 'v1', sender_type: 'agent', created_at: iso(NOW.getTime() - 60_000) }];
    for (const t of ['ok', 'Ok 👍', 'certo', 'beleza', 'pode ser', '👍']) {
      const quiet = world({ reminders: [waiting], messages: [{ id: 'm0', conversation_id: 'v1', sender_type: 'bot', created_at: iso(NOW.getTime() - 2 * 3_600_000) }] });
      expect(await quiet.reply(t), t).toBe('confirmed');
      const busy = world({ reminders: [waiting], messages: agentLater });
      expect(await busy.reply(t), t).toBeNull();
      expect(busy.rpcCalls).toHaveLength(0);
    }
    // A bot / automation message after the reminder counts too; the customer's own do not.
    const bot = world({ reminders: [waiting], messages: [{ id: 'm2', conversation_id: 'v1', sender_type: 'bot', created_at: iso(NOW.getTime() - 60_000) }] });
    expect(await bot.reply('ok')).toBeNull();
    const own = world({ reminders: [waiting], messages: [{ id: 'm3', conversation_id: 'v1', sender_type: 'customer', created_at: iso(NOW.getTime() - 60_000) }] });
    expect(await own.reply('ok')).toBe('confirmed');
  });

  it('a vague word that QUOTES the reminder confirms even after an agent message', async () => {
    const agentLater = [{ id: 'm1', conversation_id: 'v1', sender_type: 'agent', created_at: iso(NOW.getTime() - 60_000) }];
    const w = world({ reminders: [waiting], messages: agentLater });
    expect(await w.reply('ok', 'text', 'c1', 'wamid.other')).toBeNull();
    expect(await w.reply('ok', 'text', 'c1', 'wamid.rem')).toBe('confirmed');
  });

  it('clear words ("1", "sim", "confirmo", "2", "remarcar") keep working after an agent message', async () => {
    const agentLater = [{ id: 'm1', conversation_id: 'v1', sender_type: 'agent', created_at: iso(NOW.getTime() - 60_000) }];
    for (const [t, a] of [['1', 'confirmed'], ['sim', 'confirmed'], ['confirmo', 'confirmed'], ['2', 'reschedule_requested'], ['remarcar', 'reschedule_requested']] as const) {
      const w = world({ reminders: [waiting], messages: agentLater });
      expect(await w.reply(t), t).toBe(a);
    }
  });

  it('errors after the RPC succeeded (timezone, pill, ack) never turn the result into "not handled"', async () => {
    const w = world();
    const real = w.db.from.bind(w.db);
    w.db.from = (table: string) => {
      if (table === 'accounts' || table === 'conversation_events') throw new Error('db hiccup');
      return real(table);
    };
    expect(await w.reply('1')).toBe('confirmed');
    expect(w.tables.calendar_events[0].status).toBe('confirmed');
    expect(w.rpcCalls).toHaveLength(1);
  });

  it('quoted replies select that reminder, even when another appointment was reminded more recently', async () => {
    const events = ['e1', 'e2'].map((id) => ({ id, account_id: ACC, contact_id: 'c1', status: 'scheduled', starts_at: STARTS }));
    const reminders = [waiting, { ...waiting, id: 'r2', event_id: 'e2', wa_message_id: 'wamid.new', sent_at: iso(NOW.getTime() - 60_000) }];
    for (const text of ['confirmo', 'ok', '2']) {
      const w = world({ events, reminders });
      expect(await w.reply(text, 'text', 'c1', 'wamid.rem')).toBe(text === '2' ? 'reschedule_requested' : 'confirmed');
      expect(w.rpcCalls[0].args.p_reminder_id).toBe('r1');
      expect(w.tables.calendar_events[1].customer_response).toBeUndefined();
    }
  });

  it('quotes of unrelated, old, moved, or other-contact reminders never fall back to the latest appointment', async () => {
    for (const quoted of ['wamid.unrelated', 'wamid.old', 'wamid.moved', 'wamid.other-contact']) {
      const w = world({ reminders: [waiting,
        { ...waiting, id: 'old', wa_message_id: 'wamid.old', sent_at: iso(NOW.getTime() - 49 * 3_600_000) },
        { ...waiting, id: 'moved', wa_message_id: 'wamid.moved', for_starts_at: '2026-11-03T17:30:00Z' },
        { ...waiting, id: 'other', event_id: 'someone-else', wa_message_id: 'wamid.other-contact' },
      ] });
      expect(await w.reply('confirmo', 'text', 'c1', quoted)).toBeNull();
      expect(w.rpcCalls).toHaveLength(0);
    }
  });

  it('the persisted reminder itself does not block an unquoted vague reply, but a later agent message does', async () => {
    const messages = [{ id: 'm-rem', message_id: 'wamid.rem', conversation_id: 'v1', sender_type: 'bot', created_at: iso(NOW.getTime() - 3_600_000 + 1000) }];
    const quiet = world({ reminders: [waiting], messages });
    expect(await quiet.reply('Ok 👍')).toBe('confirmed');
    const busy = world({ reminders: [waiting], messages: [...messages,
      { id: 'agent', message_id: null, conversation_id: 'v1', sender_type: 'agent', created_at: iso(NOW.getTime() - 60_000) },
    ] });
    expect(await busy.reply('ok')).toBeNull();
  });

  it('an agent message during reminder finalization still blocks a vague reply', async () => {
    const w = world({
      reminders: [{ ...waiting, quota_reserved_at: iso(NOW.getTime() - 60_000) }],
      messages: [
        { id: 'rem', message_id: 'wamid.rem', conversation_id: 'v1', sender_type: 'bot', created_at: iso(NOW.getTime() - 3_600_000 + 1000) },
        { id: 'agent', message_id: 'wamid.agent', conversation_id: 'v1', sender_type: 'agent', created_at: iso(NOW.getTime() - 120_000) },
      ],
    });
    expect(await w.reply('ok')).toBeNull();
    expect(w.rpcCalls).toHaveLength(0);
  });
});
