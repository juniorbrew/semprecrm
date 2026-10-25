// ============================================================
// Agenda — thin DB layer. Takes the Supabase client so it works with the
// caller's RLS-scoped client (routes) and the service-role client (the AI,
// later). Errors are mapped to AgendaError.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { safeTimezone } from '@/lib/calendar/range';

import type { BusyInterval, ResourceSchedule } from './availability';
import { AgendaError, fromRpcError } from './errors';
import {
  ACTIVE_APPOINTMENT_STATUSES,
  DEFAULT_AGENDA_SETTINGS,
  type AgendaConfig,
  type AgendaResource,
  type AgendaResourceService,
  type AgendaService,
  type AgendaSettings,
  type DayException,
  type WorkingInterval,
} from './types';

export type AgendaDb = Pick<SupabaseClient, 'from' | 'rpc'>;

/** Widest buffer a service can have (migration 096 CHECK) — busy windows are fetched this much wider. */
const MAX_BUFFER_MS = 240 * 60_000;

const PAGE = 1000;

/**
 * PostgREST caps a response at 1000 rows (max_rows). Read every page so a wide
 * scan can never silently lose busy time or exceptions.
 */
export async function fetchAll<T>(
  build: () => { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { code?: string; message: string } | null }> },
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await build().range(from, from + PAGE - 1);
    if (res.error) throw fromRpcError(res.error);
    const rows = res.data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

function check<T>(res: { data: T | null; error: { code?: string; message: string } | null }): T {
  if (res.error) throw fromRpcError(res.error);
  return (res.data ?? ([] as unknown)) as T;
}

/** The account timezone every wall-clock rule is evaluated in. */
export async function loadTimezone(db: AgendaDb, accountId: string): Promise<string> {
  const res = await db.from('accounts').select('preferences').eq('id', accountId).maybeSingle();
  if (res.error) throw fromRpcError(res.error);
  const prefs = res.data?.preferences as { business_hours?: { timezone?: unknown } } | null | undefined;
  return safeTimezone(prefs?.business_hours?.timezone);
}

export interface ConfigRange {
  /** Only exceptions on or after this local date ("YYYY-MM-DD"). Default: two days ago (UTC). */
  from?: string;
  /** ... and on or before this one. Default: no upper bound. */
  to?: string;
}

export async function loadConfig(db: AgendaDb, accountId: string, range: ConfigRange = {}): Promise<AgendaConfig> {
  const from = range.from ?? new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const [tz, services, resources, links, hours, exceptions, settings] = await Promise.all([
    loadTimezone(db, accountId),
    db.from('agenda_services').select('*').eq('account_id', accountId).order('sort_order').order('name'),
    db.from('agenda_resources').select('*').eq('account_id', accountId).order('sort_order').order('name'),
    db.from('agenda_resource_services').select('resource_id, service_id').eq('account_id', accountId),
    db.from('agenda_working_hours').select('*').eq('account_id', accountId),
    fetchAll<DayException>(() => {
      let q = db.from('agenda_exceptions').select('*').eq('account_id', accountId).gte('on_date', from);
      if (range.to) q = q.lte('on_date', range.to);
      return q.order('on_date').order('id');
    }),
    db.from('agenda_settings').select('*').eq('account_id', accountId).maybeSingle(),
  ]);
  if (settings.error) throw fromRpcError(settings.error);
  const s = settings.data as Partial<AgendaSettings> | null;
  return {
    timezone: tz,
    settings: {
      min_notice_minutes: s?.min_notice_minutes ?? DEFAULT_AGENDA_SETTINGS.min_notice_minutes,
      max_days_ahead: s?.max_days_ahead ?? DEFAULT_AGENDA_SETTINGS.max_days_ahead,
      slot_step_minutes: s?.slot_step_minutes ?? DEFAULT_AGENDA_SETTINGS.slot_step_minutes,
    },
    services: check<AgendaService[]>(services),
    resources: check<AgendaResource[]>(resources),
    resource_services: check<AgendaResourceService[]>(links),
    working_hours: check<WorkingInterval[]>(hours),
    exceptions,
  };
}

interface BusyRow {
  id: string;
  resource_id: string | null;
  owner_user_id: string | null;
  starts_at: string;
  ends_at: string;
  block_starts_at: string | null;
  block_ends_at: string | null;
}

/**
 * Busy time per resource inside `[from, to)`: the blocks of its own
 * appointments (time + service buffers) and the plain events of the member
 * linked to it. `excludeEventId` lets a reschedule ignore itself.
 */
export async function loadBusy(
  db: AgendaDb,
  accountId: string,
  resources: readonly AgendaResource[],
  from: Date,
  to: Date,
  excludeEventId?: string,
): Promise<Map<string, BusyInterval[]>> {
  const out = new Map<string, BusyInterval[]>(resources.map((r) => [r.id, []]));
  if (resources.length === 0) return out;
  const lo = new Date(from.getTime() - MAX_BUFFER_MS).toISOString();
  const hi = new Date(to.getTime() + MAX_BUFFER_MS).toISOString();
  const cols = 'id, resource_id, owner_user_id, starts_at, ends_at, block_starts_at, block_ends_at';
  // 'completed' still holds resource time in the DB constraint, so it is busy here too.
  const resourceStatuses = [...ACTIVE_APPOINTMENT_STATUSES, 'completed'];
  const statuses = [...ACTIVE_APPOINTMENT_STATUSES];

  const userIds = resources.map((r) => r.user_id).filter((u): u is string => !!u);
  const [appointments, plain] = await Promise.all([
    fetchAll<BusyRow>(() =>
      db
        .from('calendar_events')
        .select(cols)
        .eq('account_id', accountId)
        .in('resource_id', resources.map((r) => r.id))
        .in('status', resourceStatuses)
        .lt('starts_at', hi)
        .gt('ends_at', lo)
        .order('id'),
    ),
    userIds.length > 0
      ? fetchAll<BusyRow>(() =>
          db
            .from('calendar_events')
            .select(cols)
            .eq('account_id', accountId)
            .in('owner_user_id', userIds)
            .is('resource_id', null)
            .eq('all_day', false)
            .in('status', statuses)
            .lt('starts_at', hi)
            .gt('ends_at', lo)
            .order('id'),
        )
      : Promise.resolve([] as BusyRow[]),
  ]);

  for (const row of appointments) {
    if (row.id === excludeEventId || !row.resource_id) continue;
    out.get(row.resource_id)?.push({
      starts_at: row.block_starts_at ?? row.starts_at,
      ends_at: row.block_ends_at ?? row.ends_at,
    });
  }
  for (const row of plain) {
    if (row.id === excludeEventId) continue;
    for (const r of resources) {
      if (r.user_id && r.user_id === row.owner_user_id) {
        out.get(r.id)?.push({ starts_at: row.starts_at, ends_at: row.ends_at });
      }
    }
  }
  return out;
}

/** Everything `computeSlots` needs for the given resources. */
export function toSchedules(
  config: AgendaConfig,
  resources: readonly AgendaResource[],
  busy: Map<string, BusyInterval[]>,
): ResourceSchedule[] {
  return resources.map((r) => ({
    id: r.id,
    hours: config.working_hours.filter((h) => h.resource_id === r.id),
    exceptions: config.exceptions.filter((e) => e.resource_id === r.id),
    busy: busy.get(r.id) ?? [],
  }));
}

/** Active resources that perform `serviceId`, config order. */
export function resourcesForService(config: AgendaConfig, serviceId: string): AgendaResource[] {
  const ids = new Set(config.resource_services.filter((l) => l.service_id === serviceId).map((l) => l.resource_id));
  return config.resources.filter((r) => r.is_active && ids.has(r.id));
}

export function requireService(config: AgendaConfig, serviceId: string): AgendaService {
  const svc = config.services.find((s) => s.id === serviceId);
  if (!svc) throw new AgendaError('not_found', 'Serviço não encontrado.');
  if (!svc.is_active) throw new AgendaError('service_unavailable');
  return svc;
}
