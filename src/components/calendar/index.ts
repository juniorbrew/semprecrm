// ============================================================
// Calendar UI — public components (module `calendar`, migration 040).
//
//   <CalendarBoard>   the /agenda page: header + month / week / day grids
//   <EventDrawer>     create / edit sheet (links, attendees, reminder, conflicts)
//   <QuickCreate>     "title + when" popover / inline creator
//   <LinkedEvents>    "Agenda" side section: next 3 + inline "+" + drawer
//   <ScheduleButton>  "Agendar" trigger for the drawer with a prefill
//   <EventChip>       one-line chip
//   hooks             useCalendarTimezone, useCalendarMembers, useCalendarRealtime, useLinkedEvents
//   colors            colorForUser, eventColor, EVENT_COLORS
// ============================================================

export { CalendarBoard } from './calendar-board';
export { EventDrawer, type EventDrawerProps } from './event-drawer';
export { QuickCreate, type QuickCreateProps, type QuickCreateDraft } from './quick-create';
export { LinkedEvents, type LinkedEventsProps } from './linked-events';
export { ScheduleButton, type ScheduleButtonProps } from './schedule-button';
export { EventChip } from './event-chip';
export {
  memberName,
  useCalendarMembers,
  useCalendarRealtime,
  useCalendarTimezone,
  useLinkedEvents,
  type LinkedEventsState,
  type UseLinkedEventsOptions,
} from './hooks';
export { EVENT_COLORS, colorForUser, eventColor } from './colors';
