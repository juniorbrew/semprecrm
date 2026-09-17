// ============================================================
// Calendar — read side. Every function takes the Supabase client so
// it works with the browser client (RLS-scoped) and the service-role
// client (cron) alike. No `next/*` imports. Errors are thrown.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { eventOverlaps } from './range';
import type { CalendarEvent, CalendarMember, CalendarScope } from './types';

export type CalendarClient = Pick<SupabaseClient, 'from'>;

/** Columns + embeds every event read uses. */
export const EVENT_SELECT =
  '*, attendees:calendar_event_attendees(event_id, user_id, response), ' +
  'contact:contacts(id, name, phone, avatar_url), deal:deals(id, title, pipeline_id), ' +
  'task:tasks(id, title), chat_thread:chat_threads(id, kind, title)';

function fail(prefix: string, error: { message: string } | null): never {
  throw new Error(`${prefix}: ${error?.message ?? 'unknown error'}`);
}

/** PostgREST may hand an embed back as a one-element array. */
function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function normalizeEvent(raw: unknown): CalendarEvent {
  const row = raw as Record<string, unknown>;
  return {
    ...(row as unknown as CalendarEvent),
    attendees: Array.isArray(row.attendees) ? (row.attendees as CalendarEvent['attendees']) : [],
    contact: one(row.contact as CalendarEvent['contact']),
    deal: one(row.deal as CalendarEvent['deal']),
    task: one(row.task as CalendarEvent['task']),
    chat_thread: one(row.chat_thread as CalendarEvent['chat_thread']),
  };
}

// ------------------------------------------------------------
// Members
// ------------------------------------------------------------

/** Account members for the owner select / attendee chips (profiles RLS = same account). */
export async function listCalendarMembers(
  db: CalendarClient,
  accountId?: string | null,
): Promise<CalendarMember[]> {
  let q = db.from('profiles').select('user_id, full_name, email, avatar_url').order('full_name');
  if (accountId) q = q.eq('account_id', accountId);
  const { data, error } = await q;
  if (error) fail('Failed to load members', error);
  return (data ?? []) as CalendarMember[];
}

// ------------------------------------------------------------
// Scope filter (pure)
// ------------------------------------------------------------

/** Whether `userId` owns or attends the event. */
export function involvesUser(event: Pick<CalendarEvent, 'owner_user_id' | 'attendees'>, userId: string): boolean {
  if (event.owner_user_id === userId) return true;
  return (event.attendees ?? []).some((a) => a.user_id === userId);
}

/**
 * Narrow a team list to a scope. Done client-side because "owner OR
 * attendee" spans an embed, which PostgREST cannot OR across without
 * an inner join that would drop the attendee rows.
 */
export function filterByScope<T extends Pick<CalendarEvent, 'owner_user_id' | 'attendees'>>(
  events: readonly T[],
  scope: CalendarScope,
  currentUserId: string | null,
): T[] {
  if (scope === 'team') return [...events];
  const uid = scope === 'mine' ? currentUserId : scope.userId;
  if (!uid) return [...events];
  return events.filter((e) => involvesUser(e, uid));
}

// ------------------------------------------------------------
// Events
// ------------------------------------------------------------

export interface ListEventsOptions {
  accountId?: string | null;
  /** Half-open `[from, to)` overlap on `starts_at` / `ends_at`. */
  from: Date | string;
  to: Date | string;
  /** Default: hide cancelled events. */
  includeCancelled?: boolean;
  /** Owner filter applied server-side (attendee scopes go through `filterByScope`). */
  ownerUserId?: string;
  limit?: number;
}

/** Events overlapping a range, start order. */
export async function listEventsInRange(db: CalendarClient, opts: ListEventsOptions): Promise<CalendarEvent[]> {
  const from = new Date(opts.from).toISOString();
  const to = new Date(opts.to).toISOString();
  let q = db
    .from('calendar_events')
    .select(EVENT_SELECT)
    .lt('starts_at', to)
    .gt('ends_at', from)
    .order('starts_at', { ascending: true })
    .order('ends_at', { ascending: false });
  if (opts.accountId) q = q.eq('account_id', opts.accountId);
  if (!opts.includeCancelled) q = q.eq('status', 'confirmed');
  if (opts.ownerUserId) q = q.eq('owner_user_id', opts.ownerUserId);
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) fail('Failed to load events', error);
  return ((data ?? []) as unknown[]).map(normalizeEvent);
}

export interface EventLinkFilter {
  contactId?: string | null;
  conversationId?: string | null;
  dealId?: string | null;
  taskId?: string | null;
  chatThreadId?: string | null;
}

export interface ListLinkedEventsOptions extends EventLinkFilter {
  /** Only events ending after this instant (default: now). Pass `null` for all. */
  after?: Date | string | null;
  includeCancelled?: boolean;
  limit?: number;
}

/**
 * Events linked to one record — the "Agenda" sections. A contact
 * filter also matches events linked only through the contact's
 * conversation / deal when those ids are passed along.
 */
export async function listLinkedEvents(db: CalendarClient, opts: ListLinkedEventsOptions): Promise<CalendarEvent[]> {
  const ors: string[] = [];
  if (opts.contactId) ors.push(`contact_id.eq.${opts.contactId}`);
  if (opts.conversationId) ors.push(`conversation_id.eq.${opts.conversationId}`);
  if (opts.dealId) ors.push(`deal_id.eq.${opts.dealId}`);
  if (opts.taskId) ors.push(`task_id.eq.${opts.taskId}`);
  if (opts.chatThreadId) ors.push(`chat_thread_id.eq.${opts.chatThreadId}`);
  if (ors.length === 0) return [];

  let q = db
    .from('calendar_events')
    .select(EVENT_SELECT)
    .or(ors.join(','))
    .order('starts_at', { ascending: true });
  if (opts.after !== null) {
    q = q.gt('ends_at', new Date(opts.after ?? Date.now()).toISOString());
  }
  if (!opts.includeCancelled) q = q.eq('status', 'confirmed');
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) fail('Failed to load events', error);
  return ((data ?? []) as unknown[]).map(normalizeEvent);
}

export async function getEvent(db: CalendarClient, eventId: string): Promise<CalendarEvent | null> {
  const { data, error } = await db.from('calendar_events').select(EVENT_SELECT).eq('id', eventId).maybeSingle();
  if (error) fail('Failed to load event', error);
  return data ? normalizeEvent(data) : null;
}

/**
 * My events of the zone-local day `[dayStart, dayEnd)` — the
 * dashboard card. Owner or attendee, confirmed only.
 */
export async function listMyEventsInRange(
  db: CalendarClient,
  opts: { accountId?: string | null; userId: string; from: Date; to: Date },
): Promise<CalendarEvent[]> {
  const rows = await listEventsInRange(db, { accountId: opts.accountId, from: opts.from, to: opts.to });
  return filterByScope(rows, 'mine', opts.userId);
}

/** Window of the sidebar badge (ms). */
export const UPCOMING_WINDOW_MS = 2 * 60 * 60_000;

/**
 * My confirmed events starting within the next two hours (not yet
 * started) — the sidebar badge on "Agenda".
 */
export async function listUpcomingEvents(
  db: CalendarClient,
  opts: { accountId?: string | null; userId: string; now?: Date },
): Promise<CalendarEvent[]> {
  const now = opts.now ?? new Date();
  const to = new Date(now.getTime() + UPCOMING_WINDOW_MS);
  let q = db
    .from('calendar_events')
    .select(EVENT_SELECT)
    .eq('status', 'confirmed')
    .eq('all_day', false)
    .gte('starts_at', now.toISOString())
    .lte('starts_at', to.toISOString())
    .order('starts_at', { ascending: true })
    .limit(100);
  if (opts.accountId) q = q.eq('account_id', opts.accountId);
  const { data, error } = await q;
  if (error) fail('Failed to load upcoming events', error);
  return filterByScope(((data ?? []) as unknown[]).map(normalizeEvent), 'mine', opts.userId);
}

/** Split a day's list into "still to come" first, then the ones already over. */
export function sortUpcomingFirst<T extends Pick<CalendarEvent, 'starts_at' | 'ends_at'>>(
  events: readonly T[],
  now: Date | number = Date.now(),
): T[] {
  const t = new Date(now).getTime();
  const over = (e: T) => new Date(e.ends_at).getTime() <= t;
  return [...events].sort((a, b) => {
    const oa = over(a) ? 1 : 0;
    const ob = over(b) ? 1 : 0;
    if (oa !== ob) return oa - ob;
    return new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
  });
}

/** Events of the list overlapping `[from, to)` — re-exported for the views. */
export function eventsOverlapping<T extends Pick<CalendarEvent, 'starts_at' | 'ends_at'>>(
  events: readonly T[],
  from: Date | number,
  to: Date | number,
): T[] {
  return events.filter((e) => eventOverlaps(e, from, to));
}
