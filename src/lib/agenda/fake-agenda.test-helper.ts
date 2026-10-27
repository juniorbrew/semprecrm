// Test-only: the agenda tables of one account (Mon 09-13 hours) and an
// in-memory twin of the booking RPCs (same-resource overlap = slot taken).
// Shared by the agenda service tests and the AI booking tests.

import { makeFakeDb } from '@/lib/lgpd/fake-db.test-helper';

export type Row = Record<string, unknown>;

export const ACC = 'acc-1';
export const NOW = new Date('2026-10-24T12:00:00Z'); // Saturday 09:00 in São Paulo
export const MON_10 = '2026-10-26T13:00:00.000Z'; // Monday 10:00 local
export const MON_11 = '2026-10-26T14:00:00.000Z';
export const MIN = 60_000;

export function baseTables(): Record<string, Row[]> {
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
export function fakeRpc(fn: string, args: Record<string, unknown>, tables: Record<string, Row[]>) {
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

export function setup(mutate?: (t: Record<string, Row[]>) => void, rpc = fakeRpc) {
  const tables = baseTables();
  mutate?.(tables);
  const fake = makeFakeDb(tables, { rpc });
  return { ...fake, tables };
}
