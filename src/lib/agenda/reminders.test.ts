import { describe, expect, it, vi } from 'vitest';

import { AccountReadOnlyError } from '@/lib/billing/read-only';
import { makeFakeDb } from '@/lib/lgpd/fake-db.test-helper';
import { suppressionHash } from '@/lib/lgpd/suppression';
import { GatewayRequestError } from '@/lib/whatsapp/qr-gateway';
import { TEMPLATE_NEEDS_SYNC_ERROR } from '@/lib/whatsapp/template-row-guard';

import { pickConversation, runReminderDispatch } from './reminders';
import { REMINDER_OPTIONS_TEXT } from './reminders-core';

type Row = Record<string, unknown>;

// The suppression list is HMAC-keyed; give the tests a key.
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

const ACC = 'acc-1';
const NOW = new Date('2026-10-30T12:00:00Z');
const STARTS = '2026-10-31T17:30:00.000Z'; // Saturday 14:30 in São Paulo
const iso = (ms: number) => new Date(ms).toISOString();

/** Postgres twin of agenda_reminders_claim: pending and due -> sending, attempts + 1, in one step. */
function claimRpc(fn: string, args: Record<string, unknown>, tables: Record<string, Row[]>) {
  if (fn === 'agenda_reminder_reserve_quota') {
    const row = tables.agenda_reminders.find((r) => r.id === args.p_reminder_id && r.account_id === args.p_account_id);
    if (!row || row.state !== 'sending' || row.quota_reserved_at) return { data: false, error: null };
    const cutoff = NOW.getTime() - 86_400_000;
    const used = tables.agenda_reminders.filter((r) => r.account_id === args.p_account_id && (
      (r.state === 'sent' && Date.parse((r.quota_reserved_at ?? r.sent_at) as string) > cutoff) ||
      (r.state === 'sending' && r.quota_reserved_at) ||
      (r.state === 'failed' && r.reason === 'maybe_sent' && Date.parse(r.updated_at as string) > cutoff)
    )).length;
    if (used >= 200) return { data: false, error: null };
    Object.assign(row, { quota_reserved_at: NOW.toISOString(), claimed_at: new Date().toISOString() });
    return { data: true, error: null };
  }
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

describe('hardening (review + audit)', () => {
  it('reserves the last quota slot before sending, so another worker cannot also send', async () => {
    const w = world();
    w.tables.agenda_reminders.push(...Array.from({ length: 199 }, (_, i) => ({
      id: `sent-${i}`, account_id: ACC, state: 'sent', sent_at: iso(NOW.getTime() - 3_600_000),
    })));
    let other: ReturnType<typeof w.run>;
    const send = vi.fn(async () => {
      expect(w.state().quota_reserved_at).toBeTruthy();
      w.tables.agenda_reminders.push({ ...w.state(), id: 'r2', state: 'pending', quota_reserved_at: null });
      other = w.run();
      await other;
      return { whatsapp_message_id: 'wamid.last' };
    });
    expect(await w.run({ sendText: send })).toMatchObject({ sent: 1 });
    expect(await other!).toMatchObject({ sent: 0, skipped: 1 });
    expect(w.sendText).not.toHaveBeenCalled();
    expect(w.tables.agenda_reminders.find((r) => r.id === 'r2')).toMatchObject({ state: 'skipped', reason: 'daily_limit' });
  });

  it.each([
    ['error', false], ['throw', false], ['null', false], ['false', false],
    ['error', true], ['throw', true], ['null', true], ['false', true],
  ] as const)('never sends when quota reservation returns %s (template: %s)', async (failure, template) => {
    const w = world(template ? {
      conv: { channel: 'official', last_customer_message_at: iso(NOW.getTime() - 30 * 3_600_000) },
      settings: { template_name: 'tpl' },
    } : {});
    const rpc = w.db.rpc.bind(w.db);
    w.db.rpc = (fn: string, args: Record<string, unknown>) => {
      if (fn !== 'agenda_reminder_reserve_quota') return rpc(fn, args);
      if (failure === 'throw') throw new Error('quota lookup unavailable');
      return Promise.resolve({ data: failure === 'false' ? false : null, error: failure === 'error' ? { message: 'quota lookup unavailable' } : null });
    };
    expect(await w.run()).toMatchObject(failure === 'false' ? { skipped: 1, sent: 0 } : { failed: 1, sent: 0 });
    expect(w.sendText).not.toHaveBeenCalled();
    expect(w.sendTemplate).not.toHaveBeenCalled();
  });

  it('releases a reservation on retry, then reserves again before the next send', async () => {
    const w = world();
    const throttled = vi.fn(async () => {
      expect(w.state().quota_reserved_at).toBeTruthy();
      throw new GatewayRequestError('fila cheia', 429, 'throttled');
    });
    expect(await w.run({ sendText: throttled })).toMatchObject({ retrying: 1 });
    expect(w.state()).toMatchObject({ state: 'pending', quota_reserved_at: null });
    const send = vi.fn(async () => {
      expect(w.state().quota_reserved_at).toBeTruthy();
      return { whatsapp_message_id: 'wamid.retry' };
    });
    expect(await w.run({ sendText: send }, new Date(NOW.getTime() + 120_001))).toMatchObject({ sent: 1 });
  });

  it('releases reservations on known failures and skips before another attempt', async () => {
    for (const error of [new Error('provider rejected'), new AccountReadOnlyError()]) {
      const w = world();
      const send = vi.fn(async () => {
        expect(w.state().quota_reserved_at).toBeTruthy();
        throw error;
      });
      expect(await w.run({ sendText: send })).toMatchObject({ sent: 0 });
      expect(w.state().quota_reserved_at).toBeNull();
    }
  });

  it('keeps reply ordering at send start and starts the quota window at completion', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const w = world();
      const completed = new Date(NOW.getTime() + 60_000);
      const send = vi.fn(async () => {
        vi.setSystemTime(completed);
        return { whatsapp_message_id: 'wamid.slow' };
      });
      expect(await w.run({ sendText: send })).toMatchObject({ sent: 1 });
      expect(w.state().sent_at).toBe(NOW.toISOString());
      expect(w.state().quota_reserved_at).toBe(completed.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it('a reminder claimed far too late is skipped as late (max(30 min, half the lead time))', async () => {
    const stale = world({ reminder: { due_at: iso(NOW.getTime() - 2 * 3_600_000), offset_minutes: 120 } });
    expect(await stale.run()).toMatchObject({ skipped: 1, sent: 0 });
    expect(stale.state()).toMatchObject({ state: 'skipped', reason: 'late' });
    const ok = world({ reminder: { due_at: iso(NOW.getTime() - 59 * 60_000), offset_minutes: 120 } });
    expect(await ok.run()).toMatchObject({ sent: 1 });
    const day = world({ reminder: { due_at: iso(NOW.getTime() - 5 * 3_600_000), offset_minutes: 1440 } });
    expect(await day.run()).toMatchObject({ sent: 1 }); // a 24 h reminder tolerates hours of delay
  });

  it('daily cap per account: 200 sent in the last 24 h stops further reminders (visible reason)', async () => {
    const mk = (n: number, hoursAgo: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `s${hoursAgo}-${i}`, account_id: ACC, state: 'sent', sent_at: iso(NOW.getTime() - hoursAgo * 3_600_000) }));
    const full = world();
    full.tables.agenda_reminders.push(...mk(200, 2));
    expect(await full.run()).toMatchObject({ skipped: 1, sent: 0 });
    expect(full.state()).toMatchObject({ state: 'skipped', reason: 'daily_limit' });
    const room = world();
    room.tables.agenda_reminders.push(...mk(199, 2), ...mk(300, 30)); // older than 24 h does not count
    expect(await room.run()).toMatchObject({ sent: 1 });
  });

  it('LGPD suppression list: a number that asked to stop gets nothing even without a contact flag', async () => {
    const w = world();
    w.tables.contact_suppressions = [{ account_id: ACC, phone_hash: suppressionHash(ACC, '5511999990000') }];
    expect(await w.run()).toMatchObject({ skipped: 1 });
    expect(w.state()).toMatchObject({ state: 'skipped', reason: 'opted_out' });
    expect(w.sendText).not.toHaveBeenCalled();
    // The same hash in another account does not matter.
    const other = world();
    other.tables.contact_suppressions = [{ account_id: 'acc-2', phone_hash: suppressionHash('acc-2', '5511999990000') }];
    expect(await other.run()).toMatchObject({ sent: 1 });
  });

  it('QR disconnected: retried with backoff while there is time, then skipped with a clear reason', async () => {
    const down = vi.fn().mockRejectedValue(new GatewayRequestError('WhatsApp desconectado', 409, 'not_connected'));
    const w = world();
    expect(await w.run({ sendText: down })).toMatchObject({ retrying: 1, failed: 0 });
    expect(w.state()).toMatchObject({ state: 'pending', attempts: 1 });
    expect(Date.parse(w.state().next_try_at as string)).toBe(NOW.getTime() + 300_000);
    // Reconnected later: sent.
    expect(await w.run({}, new Date(NOW.getTime() + 300_001))).toMatchObject({ sent: 1 });

    // The appointment starts before the next try would happen: no point retrying.
    const soon = world({ event: { starts_at: iso(NOW.getTime() + 180_000) }, reminder: { for_starts_at: iso(NOW.getTime() + 180_000) } });
    expect(await soon.run({ sendText: down })).toMatchObject({ skipped: 1, failed: 0 });
    expect(soon.state()).toMatchObject({ state: 'skipped', reason: 'whatsapp_disconnected' });
    expect(soon.notifyFailure).not.toHaveBeenCalled();

    // Too stale for another try (next try would be past max(30 min, half the lead time)).
    const stale = world({ reminder: { due_at: iso(NOW.getTime() - 58 * 60_000), offset_minutes: 120 } });
    expect(await stale.run({ sendText: down })).toMatchObject({ skipped: 1 });
    expect(stale.state().reason).toBe('whatsapp_disconnected');
  });

  it('official channel not configured: same retry-then-skip with its own reason', async () => {
    const none = vi.fn().mockRejectedValue(new Error('WhatsApp not configured for this account'));
    const w = world({ conv: { channel: 'official', last_customer_message_at: iso(NOW.getTime() - 3_600_000) } });
    expect(await w.run({ sendText: none })).toMatchObject({ retrying: 1 });
    const soon = world({
      conv: { channel: 'official', last_customer_message_at: iso(NOW.getTime() - 3_600_000) },
      event: { starts_at: iso(NOW.getTime() + 180_000) },
      reminder: { for_starts_at: iso(NOW.getTime() + 180_000) },
    });
    await soon.run({ sendText: none });
    expect(soon.state()).toMatchObject({ state: 'skipped', reason: 'channel_not_configured' });
  });

  it('never stores or pushes a phone number from a provider error', async () => {
    const w = world();
    const boom = vi.fn().mockRejectedValue(new Error('recipient +55 (11) 99999-0000 / 5511999990000 rejected'));
    await w.run({ sendText: boom });
    expect(w.state().state).toBe('failed');
    expect(String(w.state().error_text)).not.toMatch(/\d{6,}/);
    expect(String(w.state().error_text)).toContain('***');
    expect(String(w.notifyFailure.mock.calls[0][2])).not.toMatch(/\d{6,}/);
  });

  it('a reminder that really went out ends as sent even if the sweep parked it as maybe_sent meanwhile', async () => {
    const w = world();
    let claimAt = '';
    const slow = vi.fn(async () => {
      claimAt = String(w.state().claimed_at);
      Object.assign(w.state(), { state: 'failed', reason: 'maybe_sent' }); // the 10-minute sweep fired during the send
      return { whatsapp_message_id: 'wamid.9' };
    });
    expect(await w.run({ sendText: slow })).toMatchObject({ sent: 1 });
    expect(w.state()).toMatchObject({ state: 'sent', wa_message_id: 'wamid.9' });
    expect(w.state().reason).toBeNull();
    // The claim was renewed right before the provider call.
    expect(claimAt).not.toBe(NOW.toISOString());
  });

  it('{cliente} is sanitized and template parameters never carry newlines', async () => {
    const w = world({ contact: { name: 'Maria<b>{{x}} Silva' } });
    await w.run();
    expect((w.sendText.mock.calls[0][0] as Row).text).toContain('Olá, Mariabx!');
    const t = world({
      conv: { channel: 'official', last_customer_message_at: iso(NOW.getTime() - 30 * 3_600_000) },
      settings: { template_name: 'tpl' },
    });
    t.tables.agenda_services[0].name = 'Corte\n  e   barba';
    await t.run();
    expect((t.sendTemplate.mock.calls[0][0] as { params: string[] }).params[1]).toBe('Corte e barba');
  });
});
