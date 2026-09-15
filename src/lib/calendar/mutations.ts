// ============================================================
// Calendar — write side. Same client contract as queries.ts: pass
// the Supabase client in, get the fresh row back, errors are thrown.
//
// RLS (040): agent+ creates; the owner, the creator or an admin+
// edits / cancels / deletes; an attendee updates only their own
// response. The DB trigger clears `reminded_at` whenever the start
// or the reminder changes, so nothing here touches that column.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { EVENT_SELECT, normalizeEvent } from './queries';
import type {
  CalendarAttendeeResponse,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventPatch,
} from './types';

type WriteClient = Pick<SupabaseClient, 'from'>;

function fail(prefix: string, error: { message: string } | null): never {
  throw new Error(`${prefix}: ${error?.message ?? 'unknown error'}`);
}

function clean(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

function assertRange(startsAt: string, endsAt: string) {
  const s = new Date(startsAt).getTime();
  const e = new Date(endsAt).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) throw new Error('Invalid event dates');
  if (e <= s) throw new Error('The event must end after it starts');
}

/** Attendee ids without duplicates and without the owner. */
export function normalizeAttendees(ids: readonly string[] | undefined, ownerUserId: string | null): string[] {
  const out: string[] = [];
  for (const id of ids ?? []) {
    if (!id || id === ownerUserId || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

export interface CreateEventContext {
  accountId: string;
  /** Becomes `created_by` and the default owner. */
  userId: string | null;
}

/** Insert an event (+ its attendee rows). */
export async function createEvent(
  db: WriteClient,
  ctx: CreateEventContext,
  input: CalendarEventInput,
): Promise<CalendarEvent> {
  const title = input.title.trim();
  if (!title) throw new Error('Event title is required');
  assertRange(input.starts_at, input.ends_at);
  const owner = input.owner_user_id === undefined ? ctx.userId : input.owner_user_id || null;

  const { data, error } = await db
    .from('calendar_events')
    .insert({
      account_id: ctx.accountId,
      created_by: ctx.userId,
      owner_user_id: owner,
      title,
      description: clean(input.description),
      location: clean(input.location),
      color: clean(input.color),
      starts_at: input.starts_at,
      ends_at: input.ends_at,
      all_day: !!input.all_day,
      reminder_minutes: input.reminder_minutes ?? null,
      contact_id: input.contact_id || null,
      conversation_id: input.conversation_id || null,
      deal_id: input.deal_id || null,
      task_id: input.task_id || null,
      chat_thread_id: input.chat_thread_id || null,
    })
    .select('id')
    .single();
  if (error || !data) fail('Failed to create event', error);
  const id = (data as { id: string }).id;

  const attendees = normalizeAttendees(input.attendee_user_ids, owner);
  if (attendees.length > 0) {
    const { error: attErr } = await db
      .from('calendar_event_attendees')
      .insert(attendees.map((user_id) => ({ event_id: id, user_id })));
    if (attErr) fail('Failed to add attendees', attErr);
  }
  return reload(db, id, 'Failed to create event');
}

/** Patch any subset of editable fields; syncs the attendee roster when given. */
export async function updateEvent(db: WriteClient, event: CalendarEvent, patch: CalendarEventPatch): Promise<CalendarEvent> {
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error('Event title is required');
    row.title = title;
  }
  if (patch.description !== undefined) row.description = clean(patch.description);
  if (patch.location !== undefined) row.location = clean(patch.location);
  if (patch.color !== undefined) row.color = clean(patch.color);
  if (patch.all_day !== undefined) row.all_day = !!patch.all_day;
  if (patch.owner_user_id !== undefined) row.owner_user_id = patch.owner_user_id || null;
  if (patch.reminder_minutes !== undefined) row.reminder_minutes = patch.reminder_minutes ?? null;
  if (patch.contact_id !== undefined) row.contact_id = patch.contact_id || null;
  if (patch.conversation_id !== undefined) row.conversation_id = patch.conversation_id || null;
  if (patch.deal_id !== undefined) row.deal_id = patch.deal_id || null;
  if (patch.task_id !== undefined) row.task_id = patch.task_id || null;
  if (patch.chat_thread_id !== undefined) row.chat_thread_id = patch.chat_thread_id || null;
  if (patch.status !== undefined) row.status = patch.status;
  const startsAt = patch.starts_at ?? event.starts_at;
  const endsAt = patch.ends_at ?? event.ends_at;
  if (patch.starts_at !== undefined || patch.ends_at !== undefined) {
    assertRange(startsAt, endsAt);
    row.starts_at = startsAt;
    row.ends_at = endsAt;
  }

  if (Object.keys(row).length > 0) {
    const { error } = await db.from('calendar_events').update(row).eq('id', event.id);
    if (error) fail('Failed to update event', error);
  }

  if (patch.attendee_user_ids !== undefined) {
    const owner = (row.owner_user_id as string | null | undefined) ?? event.owner_user_id;
    const wanted = normalizeAttendees(patch.attendee_user_ids, owner ?? null);
    const current = (event.attendees ?? []).map((a) => a.user_id);
    const toRemove = current.filter((id) => !wanted.includes(id));
    const toAdd = wanted.filter((id) => !current.includes(id));
    if (toRemove.length > 0) {
      const { error } = await db
        .from('calendar_event_attendees')
        .delete()
        .eq('event_id', event.id)
        .in('user_id', toRemove);
      if (error) fail('Failed to remove attendees', error);
    }
    if (toAdd.length > 0) {
      const { error } = await db
        .from('calendar_event_attendees')
        .insert(toAdd.map((user_id) => ({ event_id: event.id, user_id })));
      if (error) fail('Failed to add attendees', error);
    }
  }
  return reload(db, event.id, 'Failed to update event');
}

/** Drag on the grid: new start, same duration (or explicit new end). */
export async function moveEvent(
  db: WriteClient,
  event: CalendarEvent,
  range: { starts_at: string; ends_at: string },
): Promise<CalendarEvent> {
  return updateEvent(db, event, range);
}

/** Bottom-handle resize: new end only. */
export async function resizeEvent(db: WriteClient, event: CalendarEvent, endsAt: string): Promise<CalendarEvent> {
  return updateEvent(db, event, { ends_at: endsAt });
}

export async function cancelEvent(db: WriteClient, event: CalendarEvent): Promise<CalendarEvent> {
  return updateEvent(db, event, { status: 'cancelled' });
}

export async function restoreEvent(db: WriteClient, event: CalendarEvent): Promise<CalendarEvent> {
  return updateEvent(db, event, { status: 'confirmed' });
}

export async function deleteEvent(db: WriteClient, eventId: string): Promise<void> {
  const { error } = await db.from('calendar_events').delete().eq('id', eventId);
  if (error) fail('Failed to delete event', error);
}

/** An attendee's own answer (RLS lets only the row owner do this). */
export async function respondToEvent(
  db: WriteClient,
  eventId: string,
  userId: string,
  response: CalendarAttendeeResponse,
): Promise<CalendarEvent> {
  const { error } = await db
    .from('calendar_event_attendees')
    .update({ response })
    .eq('event_id', eventId)
    .eq('user_id', userId);
  if (error) fail('Failed to save response', error);
  return reload(db, eventId, 'Failed to save response');
}

async function reload(db: WriteClient, id: string, prefix: string): Promise<CalendarEvent> {
  const { data, error } = await db.from('calendar_events').select(EVENT_SELECT).eq('id', id).single();
  if (error || !data) fail(prefix, error);
  return normalizeEvent(data);
}
