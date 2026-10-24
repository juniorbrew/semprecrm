import { describe, expect, it } from 'vitest';

import { makeFakeDb } from '@/lib/lgpd/fake-db.test-helper';

import { AgendaError, fromRpcError } from './errors';
import { bookAppointment, getAvailability, rescheduleAppointment, setAppointmentStatus } from './service';

type Row = Record<string, unknown>;

const ACC = 'acc-1';
const NOW = new Date('2026-10-24T12:00:00Z'); // Saturday 09:00 in São Paulo
const MON_10 = '2026-10-26T13:00:00.000Z'; // Monday 10:00 local
const MON_11 = '2026-10-26T14:00:00.000Z';
const MIN = 60_000;

function baseTables(): Record<string, Row[]> {
  const hours = (resource: string) => [{ account_id: ACC, resource_id: resource, weekday: 1, start_minute: 540, end_minute: 780 }]; // Mon 09-13
  return {
    accounts: [{ id: ACC, preferences: { business_hours: { timezone: 'America/Sao_Paulo' } } }],
    agenda_services: [
      { id: 's1', account_id: ACC, name: 'Corte', duration_minutes: 60, buffer_before_minutes: 0, buffer_after_minutes: 0, is_active: true, sort_order: 0, price_cents: null, description: null, color: null },
      { id: 's2', account_id: ACC, name: 'Off', duration_minutes: 30, buffer_before_minutes: 0, buffer_after_minutes: 0, is_active: false, sort_order: 1, price_cents: null, description: null, color: null },
    ],
    agenda_resources: [
      { id: 'r1', account_id: ACC, name: 'Ana', kind: 'professional', user_id: 'u1', is_active: true, sort_order: 0, color: null },
      { id: 'r2', account_id: ACC, name: 'Bia', kind: 'professional', user_id: 'u2', is_active: true, sort_order: 1, color: null },
      { id: 'r3', account_id: ACC, name: 'Sala', kind: 'room', user_id: null, is_active: true, sort_order: 2, color: null },
    ],
    agenda_resource_services: [
      { account_id: ACC, resource_id: 'r1', service_id: 's1' },
      { account_id: ACC, resource_id: 'r2', service_id: 's1' },
    ],
    agenda_working_hours: [...hours('r1'), ...hours('r2'), ...hours('r3')],
    agenda_exceptions: [],
    agenda_settings: [],
    calendar_events: [],
  };
}

/** Postgres twin: same-resource overlap of the blocks = exclusion violation, atomically. */
function fakeRpc(fn: string, args: Record<string, unknown>, tables: Record<string, Row[]>) {
  const events = tables.calendar_events;
  const overlap = (resource: unknown, from: number, to: number, except?: unknown) =>
    events.some(
      (e) =>
        e.resource_id === resource &&
        e.id !== except &&
        ['scheduled', 'confirmed', 'completed'].includes(e.status as string) &&
        Date.parse(e.block_starts_at as string) < to &&
        Date.parse(e.block_ends_at as string) > from,
    );
  const taken = { data: null, error: { code: 'AG001', message: 'agenda_slot_taken' } };
  if (fn === 'agenda_book_appointment') {
    const svc = tables.agenda_services.find((s) => s.id === args.p_service_id)!;
    const start = Date.parse(args.p_starts_at as string);
    const end = start + (svc.duration_minutes as number) * MIN;
    const from = start - (svc.buffer_before_minutes as number) * MIN;
    const to = end + (svc.buffer_after_minutes as number) * MIN;
    if (overlap(args.p_resource_id, from, to)) return taken;
    const row: Row = {
      id: `ev-${events.length + 1}`,
      account_id: args.p_account_id,
      service_id: args.p_service_id,
      resource_id: args.p_resource_id,
      contact_id: args.p_contact_id,
      status: args.p_status,
      booking_source: args.p_source,
      idempotency_key: args.p_idempotency_key,
      starts_at: new Date(start).toISOString(),
      ends_at: new Date(end).toISOString(),
      block_starts_at: new Date(from).toISOString(),
      block_ends_at: new Date(to).toISOString(),
      owner_user_id: null,
      all_day: false,
    };
    events.push(row);
    return { data: row, error: null };
  }
  if (fn === 'agenda_reschedule_appointment') {
    const ev = events.find((e) => e.id === args.p_event_id)!;
    const start = Date.parse(args.p_starts_at as string);
    const end = start + (Date.parse(ev.ends_at as string) - Date.parse(ev.starts_at as string));
    const resource = args.p_resource_id ?? ev.resource_id;
    if (overlap(resource, start, end, ev.id)) return taken;
    Object.assign(ev, {
      resource_id: resource,
      starts_at: new Date(start).toISOString(),
      ends_at: new Date(end).toISOString(),
      block_starts_at: new Date(start).toISOString(),
      block_ends_at: new Date(end).toISOString(),
    });
    return { data: ev, error: null };
  }
  if (fn === 'agenda_set_appointment_status') {
    const ev = events.find((e) => e.id === args.p_event_id);
    if (!ev) return { data: null, error: { code: 'AG009', message: 'agenda_appointment_not_found' } };
    ev.status = args.p_status;
    return { data: ev, error: null };
  }
  return { data: null, error: { message: `no rpc ${fn}` } };
}

function setup(mutate?: (t: Record<string, Row[]>) => void, rpc = fakeRpc) {
  const tables = baseTables();
  mutate?.(tables);
  const fake = makeFakeDb(tables, { rpc });
  return { ...fake, tables };
}

const book = (db: unknown, over: Record<string, unknown> = {}) =>
  bookAppointment(db as never, {
    accountId: ACC,
    serviceId: 's1',
    resourceId: 'r1',
    contactId: 'c1',
    startsAt: MON_10,
    now: NOW,
    ...over,
  });

const failCode = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AgendaError);
    return (err as AgendaError).code;
  }
  throw new Error('expected a rejection');
};

describe('getAvailability', () => {
  it('lists the free slots of every professional that offers the service', async () => {
    const { db } = setup();
    const res = await getAvailability(db, { accountId: ACC, serviceId: 's1', from: '2026-10-26', to: '2026-10-26', now: NOW });
    expect(res.timezone).toBe('America/Sao_Paulo');
    // Mon 09-13, step 30, 60 min: 09:00 .. 12:00 = 7 starts; Ana and Bia each; the room does not offer s1.
    expect(res.slots).toHaveLength(7);
    expect(res.slots[0]).toEqual({ starts_at: '2026-10-26T12:00:00.000Z', ends_at: '2026-10-26T13:00:00.000Z', resource_ids: ['r1', 'r2'] });
  });

  it("subtracts an appointment's block and the member's own events", async () => {
    const { db } = setup((t) => {
      t.calendar_events.push(
        { id: 'a', account_id: ACC, resource_id: 'r1', owner_user_id: 'u1', status: 'scheduled', all_day: false, starts_at: MON_10, ends_at: MON_11, block_starts_at: MON_10, block_ends_at: MON_11 },
        { id: 'b', account_id: ACC, resource_id: null, owner_user_id: 'u2', status: 'confirmed', all_day: false, starts_at: '2026-10-26T12:00:00.000Z', ends_at: '2026-10-26T16:00:00.000Z', block_starts_at: null, block_ends_at: null },
        { id: 'c', account_id: ACC, resource_id: 'r1', owner_user_id: 'u1', status: 'cancelled', all_day: false, starts_at: '2026-10-26T15:00:00.000Z', ends_at: '2026-10-26T16:00:00.000Z', block_starts_at: '2026-10-26T15:00:00.000Z', block_ends_at: '2026-10-26T16:00:00.000Z' },
      );
    });
    const res = await getAvailability(db, { accountId: ACC, serviceId: 's1', resourceId: 'r1', from: '2026-10-26', to: '2026-10-26', now: NOW });
    const starts = res.slots.map((s) => s.starts_at);
    expect(starts).not.toContain('2026-10-26T13:00:00.000Z'); // 10:00 busy
    expect(starts).not.toContain('2026-10-26T13:30:00.000Z');
    expect(starts).toContain('2026-10-26T14:00:00.000Z'); // 11:00 free
    expect(starts).toContain('2026-10-26T15:00:00.000Z'); // cancelled event frees 12:00
    // u2 (Bia) is busy the whole morning: any-professional slots only list Ana.
    const any = await getAvailability(db, { accountId: ACC, serviceId: 's1', from: '2026-10-26', to: '2026-10-26', now: NOW });
    expect(any.slots.every((s) => !s.resource_ids.includes('r2'))).toBe(true);
  });

  it('rejects unknown, inactive, not-offered and out-of-range requests with clear codes', async () => {
    const { db } = setup();
    const q = { accountId: ACC, from: '2026-10-26', to: '2026-10-26', now: NOW };
    expect(await failCode(getAvailability(db, { ...q, serviceId: 'nope' }))).toBe('not_found');
    expect(await failCode(getAvailability(db, { ...q, serviceId: 's2' }))).toBe('service_unavailable');
    expect(await failCode(getAvailability(db, { ...q, serviceId: 's1', resourceId: 'r3' }))).toBe('service_not_offered');
    expect(await failCode(getAvailability(db, { ...q, serviceId: 's1', resourceId: 'zzz' }))).toBe('not_found');
    expect(await failCode(getAvailability(db, { ...q, serviceId: 's1', from: '2026-10-27' }))).toBe('validation');
    expect(await failCode(getAvailability(db, { ...q, serviceId: 's1', to: '2027-12-31' }))).toBe('validation');
  });
});

describe('bookAppointment', () => {
  it('books a free slot through the RPC with the caller identity untouched', async () => {
    const { db, rpcCalls, tables } = setup();
    const ev = await book(db, { source: 'ai', actorId: 'bot', idempotencyKey: 'k1' });
    expect(ev.id).toBe('ev-1');
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args).toMatchObject({
      p_account_id: ACC, p_service_id: 's1', p_resource_id: 'r1', p_contact_id: 'c1',
      p_starts_at: MON_10, p_source: 'ai', p_idempotency_key: 'k1', p_status: 'scheduled', p_actor: 'bot',
    });
    expect(tables.calendar_events).toHaveLength(1);
  });

  it('names the rule that refuses the slot', async () => {
    const { db, rpcCalls } = setup();
    expect(await failCode(book(db, { startsAt: '2026-10-26T20:00:00.000Z' }))).toBe('outside_hours'); // 17:00
    expect(await failCode(book(db, { startsAt: '2026-10-27T13:00:00.000Z' }))).toBe('outside_hours'); // Tuesday
    expect(await failCode(book(db, { now: new Date('2026-10-26T12:00:00Z') }))).toBe('min_notice'); // 1h before, 2h notice
    expect(await failCode(book(db, { startsAt: '2027-03-01T13:00:00.000Z' }))).toBe('max_ahead');
    expect(await failCode(book(db, { startsAt: 'not a date' }))).toBe('validation');
    expect(await failCode(book(db, { resourceId: 'r3' }))).toBe('service_not_offered');
    expect(await failCode(book(db, { serviceId: 's2' }))).toBe('service_unavailable');
    expect(rpcCalls).toHaveLength(0);
  });

  it("treats the professional's personal event as busy, without touching the database", async () => {
    const { db, rpcCalls } = setup((t) => {
      t.calendar_events.push({ id: 'p', account_id: ACC, resource_id: null, owner_user_id: 'u1', status: 'confirmed', all_day: false, starts_at: MON_10, ends_at: MON_11, block_starts_at: null, block_ends_at: null });
    });
    expect(await failCode(book(db))).toBe('busy');
    expect(rpcCalls).toHaveLength(0);
  });

  it('"any professional" goes to the first one that is free', async () => {
    const { db, rpcCalls } = setup((t) => {
      t.calendar_events.push({ id: 'p', account_id: ACC, resource_id: null, owner_user_id: 'u1', status: 'confirmed', all_day: false, starts_at: MON_10, ends_at: MON_11, block_starts_at: null, block_ends_at: null });
    });
    await book(db, { resourceId: null });
    expect(rpcCalls.map((c) => c.args.p_resource_id)).toEqual(['r2']);
  });

  it('two concurrent bookings of the same slot: exactly one wins', async () => {
    const { db, tables } = setup();
    const results = await Promise.allSettled([book(db, { contactId: 'c1' }), book(db, { contactId: 'c2' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(AgendaError);
    expect(['slot_taken', 'busy']).toContain((lost.reason as AgendaError).code);
    expect(tables.calendar_events).toHaveLength(1);
  });

  it('a lost race (database says taken) is reported as slot_taken, not a crash', async () => {
    // The pre-check passes (nothing visible), but the RPC refuses: somebody else committed in between.
    const { db, tables } = setup(undefined, () => ({ data: null, error: { code: 'AG001', message: 'agenda_slot_taken' } }));
    expect(await failCode(book(db))).toBe('slot_taken');
    expect(tables.calendar_events).toHaveLength(0);
  });

  it('a lost race with "any professional" falls through to the next professional', async () => {
    let calls = 0;
    const { db, rpcCalls } = setup(undefined, (fn, args, tables) => {
      calls += 1;
      if (calls === 1) return { data: null, error: { code: 'AG001', message: 'agenda_slot_taken' } };
      return fakeRpc(fn, args, tables);
    });
    const ev = await book(db, { resourceId: null });
    expect(ev.resource_id).toBe('r2');
    expect(rpcCalls.map((c) => c.args.p_resource_id)).toEqual(['r1', 'r2']);
  });

  it('every professional taken: slot_taken', async () => {
    const { db } = setup(undefined, () => ({ data: null, error: { code: 'AG001', message: 'agenda_slot_taken' } }));
    expect(await failCode(book(db, { resourceId: null }))).toBe('slot_taken');
  });

  it('buffers: a booking too close to another one is refused by the block overlap', async () => {
    const { db } = setup((t) => {
      t.agenda_services[0].buffer_after_minutes = 15;
    });
    await book(db); // Mon 10:00-11:00, block until 11:15
    expect(await failCode(book(db, { startsAt: MON_11 }))).toBe('busy'); // 11:00 start overlaps the 11:15 block
    await expect(book(db, { startsAt: '2026-10-26T14:30:00.000Z' })).resolves.toBeTruthy(); // 11:30 ok
  });

  it('is idempotent: the same key returns the same appointment without a second RPC', async () => {
    const { db, rpcCalls, tables } = setup();
    const a = await book(db, { idempotencyKey: 'same' });
    const b = await book(db, { idempotencyKey: 'same' });
    expect(b.id).toBe(a.id);
    expect(rpcCalls).toHaveLength(1);
    expect(tables.calendar_events).toHaveLength(1);
  });

  it('maps a read-only account from the RPC', async () => {
    const { db } = setup(undefined, () => ({ data: null, error: { code: '42501', message: 'read_only_account: this account is read-only' } }));
    expect(await failCode(book(db))).toBe('read_only');
  });
});

describe('rescheduleAppointment', () => {
  it('moves to a free slot, keeping the duration', async () => {
    const { db, tables } = setup();
    const ev = await book(db);
    const moved = await rescheduleAppointment(db, { accountId: ACC, eventId: ev.id, startsAt: '2026-10-26T15:00:00.000Z', now: NOW });
    expect(moved.starts_at).toBe('2026-10-26T15:00:00.000Z');
    expect(tables.calendar_events[0].ends_at).toBe('2026-10-26T16:00:00.000Z');
  });

  it('may keep an overlapping time with itself (shift by 30 min)', async () => {
    const { db } = setup();
    const ev = await book(db);
    await expect(
      rescheduleAppointment(db, { accountId: ACC, eventId: ev.id, startsAt: '2026-10-26T13:30:00.000Z', now: NOW }),
    ).resolves.toBeTruthy();
  });

  it('refuses a taken slot, an out-of-hours slot, a closed appointment and a non-appointment', async () => {
    const { db, tables } = setup();
    const a = await book(db);
    await book(db, { startsAt: '2026-10-26T15:00:00.000Z' });
    expect(await failCode(rescheduleAppointment(db, { accountId: ACC, eventId: a.id, startsAt: '2026-10-26T15:00:00.000Z', now: NOW }))).toBe('busy');
    expect(await failCode(rescheduleAppointment(db, { accountId: ACC, eventId: a.id, startsAt: '2026-10-26T23:00:00.000Z', now: NOW }))).toBe('outside_hours');
    tables.calendar_events[0].status = 'cancelled';
    expect(await failCode(rescheduleAppointment(db, { accountId: ACC, eventId: a.id, startsAt: MON_11, now: NOW }))).toBe('not_reschedulable');
    tables.calendar_events.push({ id: 'plain', account_id: ACC, service_id: null, resource_id: null, status: 'confirmed' });
    expect(await failCode(rescheduleAppointment(db, { accountId: ACC, eventId: 'plain', startsAt: MON_11, now: NOW }))).toBe('not_found');
  });

  it('moves to another professional that offers the service', async () => {
    const { db, rpcCalls } = setup();
    const a = await book(db);
    await rescheduleAppointment(db, { accountId: ACC, eventId: a.id, startsAt: MON_10, resourceId: 'r2', now: NOW });
    expect(rpcCalls[1].args.p_resource_id).toBe('r2');
    expect(await failCode(rescheduleAppointment(db, { accountId: ACC, eventId: a.id, startsAt: MON_10, resourceId: 'r3', now: NOW }))).toBe('service_not_offered');
  });
});

describe('setAppointmentStatus', () => {
  it('passes the status to the RPC and maps errors', async () => {
    const { db, tables } = setup();
    const a = await book(db);
    const done = await setAppointmentStatus(db, { accountId: ACC, eventId: a.id, status: 'cancelled' });
    expect(done.status).toBe('cancelled');
    expect(tables.calendar_events[0].status).toBe('cancelled');
    expect(await failCode(setAppointmentStatus(db, { accountId: ACC, eventId: 'zzz', status: 'confirmed' }))).toBe('not_found');
  });
});

describe('fromRpcError', () => {
  it('maps named RPC errors, exclusion violations and unknowns', () => {
    expect(fromRpcError({ message: 'agenda_service_not_offered' }).code).toBe('service_not_offered');
    expect(fromRpcError({ code: '23P01', message: 'conflicting key value violates exclusion constraint' }).code).toBe('slot_taken');
    expect(fromRpcError({ code: '42501', message: 'read_only_account: x' }).code).toBe('read_only');
    expect(fromRpcError({ code: '42501', message: 'new row violates row-level security policy' }).code).toBe('forbidden');
    expect(fromRpcError({ code: '23503', message: 'fk' }).code).toBe('conflict');
    expect(fromRpcError({ code: 'XX000', message: 'boom' }).code).toBe('internal');
    expect(fromRpcError({ message: 'agenda_slot_taken' }).message).toMatch(/horário/);
  });
});
