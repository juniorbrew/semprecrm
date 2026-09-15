// ============================================================
// Calendar module — shared types (migration 040).
//
// Row shapes live in src/types (calendar block); this file adds the
// inputs the mutations accept, the option lists the UI renders and
// the view / scope enums the /agenda page persists.
// ============================================================

import type {
  CalendarAttendeeResponse,
  CalendarChatThreadRef,
  CalendarContactRef,
  CalendarDealRef,
  CalendarEvent,
  CalendarEventAttendee,
  CalendarEventStatus,
  CalendarTaskRef,
} from '@/types';

export type {
  CalendarAttendeeResponse,
  CalendarChatThreadRef,
  CalendarContactRef,
  CalendarDealRef,
  CalendarEvent,
  CalendarEventAttendee,
  CalendarEventStatus,
  CalendarTaskRef,
};

/** Reminder offsets the DB check constraint accepts (minutes). */
export const REMINDER_OPTIONS = [5, 10, 15, 30, 60, 1440] as const;
export type ReminderMinutes = (typeof REMINDER_OPTIONS)[number];

export function isReminderMinutes(value: unknown): value is ReminderMinutes {
  return typeof value === 'number' && (REMINDER_OPTIONS as readonly number[]).includes(value);
}

/** English labels for the reminder select — go through `t()`. */
export const REMINDER_LABELS: Record<ReminderMinutes, string> = {
  5: '5 minutes before',
  10: '10 minutes before',
  15: '15 minutes before',
  30: '30 minutes before',
  60: '1 hour before',
  1440: '1 day before',
};

export const CALENDAR_VIEWS = ['month', 'week', 'day'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export function isCalendarView(value: unknown): value is CalendarView {
  return typeof value === 'string' && (CALENDAR_VIEWS as readonly string[]).includes(value);
}

/**
 * Who the /agenda page shows: my events (owner or attendee), the
 * whole team, or one teammate (`{ userId }`).
 */
export type CalendarScope = 'mine' | 'team' | { userId: string };

/**
 * An account member as the calendar needs it (owner select, attendee
 * chips, colour palette). Same projection as the tasks module.
 */
export interface CalendarMember {
  user_id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
}

/** Fields accepted when creating an event. `title`, `starts_at`, `ends_at` required. */
export interface CalendarEventInput {
  title: string;
  description?: string | null;
  location?: string | null;
  color?: string | null;
  /** ISO timestamps (UTC). */
  starts_at: string;
  ends_at: string;
  all_day?: boolean;
  /** Defaults to the creator. */
  owner_user_id?: string | null;
  reminder_minutes?: ReminderMinutes | null;
  contact_id?: string | null;
  conversation_id?: string | null;
  deal_id?: string | null;
  task_id?: string | null;
  chat_thread_id?: string | null;
  /** User ids; the owner is never stored as an attendee. */
  attendee_user_ids?: string[];
}

/** Partial update — every field optional, `null` clears nullable ones. */
export type CalendarEventPatch = Partial<CalendarEventInput> & {
  status?: CalendarEventStatus;
};

/** The link kinds an event can carry, in display order. */
export const EVENT_LINK_KINDS = ['contact', 'conversation', 'deal', 'task', 'chat_thread'] as const;
export type EventLinkKind = (typeof EVENT_LINK_KINDS)[number];
