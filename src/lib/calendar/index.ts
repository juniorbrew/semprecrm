// ============================================================
// Calendar module — public surface (migration 040).
//
//   types      row shapes, inputs, reminder / view enums
//   range      zone-aware grids, drag snapping, input <-> ISO, formatting
//   queries    listEventsInRange, listLinkedEvents, listUpcomingEvents, …
//   mutations  createEvent, updateEvent, moveEvent, cancelEvent, respondToEvent, …
//   conflicts  findConflicts (same owner, overlapping, warning only)
//   links      eventLinks, linkHref, eventHref
//
// Import from '@/lib/calendar' (this file) or from the sub-module.
// ============================================================

export * from './types';
export * from './range';
export * from './queries';
export * from './mutations';
export * from './conflicts';
export * from './links';
