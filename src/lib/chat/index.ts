// ============================================================
// Internal chat module — public surface (migrations 038 + 039).
//
//   status       sent / delivered / read, unread counts, day groups,
//                last-seen wording, people rows, edit / delete rules
//   groups       per-member receipts → status, system lines, list rows
//   attachments  validation, object paths, previews
//   reactions    quick picker, chip aggregation
//   queries      members, threads, unread, paginated messages,
//                receipts, reactions
//   mutations    direct thread, send, receipts, upload, edit / delete,
//                reactions, group management
//   presence     presence-state and typing reducers
//
// Import from '@/lib/chat' (this file) or from the sub-module.
// ============================================================

export * from './status';
export * from './groups';
export * from './attachments';
export * from './reactions';
export * from './queries';
export * from './mutations';
export * from './presence';
