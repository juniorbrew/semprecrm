// ============================================================
// Internal chat module — public surface (migration 038).
//
//   status     sent / delivered / read, unread counts, day groups,
//              last-seen wording, people rows
//   queries    members, threads, unread, paginated messages
//   mutations  direct thread, send, delivered / read receipts,
//              last-seen heartbeat
//   presence   presence-state and typing reducers
//
// Import from '@/lib/chat' (this file) or from the sub-module.
// ============================================================

export * from './status';
export * from './queries';
export * from './mutations';
export * from './presence';
