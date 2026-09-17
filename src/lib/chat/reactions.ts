// ============================================================
// Internal chat — reactions (phase 2). Pure helpers.
//
//   QUICK_REACTIONS     the six-emoji quick picker
//   aggregateReactions  rows → chips (emoji, count, mine, users)
//   toggleReactionRows  optimistic add / remove in a local list
// ============================================================

import type { ChatMessageReaction } from '@/types';

export const QUICK_REACTIONS: readonly string[] = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export interface ReactionChip {
  emoji: string;
  count: number;
  /** The viewer reacted with this emoji. */
  mine: boolean;
  userIds: string[];
}

/**
 * Chips for one message, in order of first reaction. Duplicate rows
 * (same user + emoji) collapse to one.
 */
export function aggregateReactions(
  reactions: readonly Pick<ChatMessageReaction, 'message_id' | 'user_id' | 'emoji' | 'created_at'>[],
  messageId: string,
  userId: string,
): ReactionChip[] {
  const rows = reactions
    .filter((r) => r.message_id === messageId)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const chips = new Map<string, ReactionChip>();
  for (const r of rows) {
    let chip = chips.get(r.emoji);
    if (!chip) {
      chip = { emoji: r.emoji, count: 0, mine: false, userIds: [] };
      chips.set(r.emoji, chip);
    }
    if (chip.userIds.includes(r.user_id)) continue;
    chip.userIds.push(r.user_id);
    chip.count++;
    if (r.user_id === userId) chip.mine = true;
  }
  return [...chips.values()];
}

/** Does `userId` already have `emoji` on `messageId`? */
export function hasReaction(
  reactions: readonly Pick<ChatMessageReaction, 'message_id' | 'user_id' | 'emoji'>[],
  messageId: string,
  userId: string,
  emoji: string,
): boolean {
  return reactions.some((r) => r.message_id === messageId && r.user_id === userId && r.emoji === emoji);
}

/**
 * Pure optimistic toggle: removes the viewer's row when present,
 * otherwise appends one (thread_id is filled by the DB trigger).
 */
export function toggleReactionRows(
  reactions: readonly ChatMessageReaction[],
  messageId: string,
  userId: string,
  emoji: string,
  now: string = new Date().toISOString(),
): { next: ChatMessageReaction[]; added: boolean } {
  if (hasReaction(reactions, messageId, userId, emoji)) {
    return {
      next: reactions.filter((r) => !(r.message_id === messageId && r.user_id === userId && r.emoji === emoji)),
      added: false,
    };
  }
  return {
    next: [...reactions, { message_id: messageId, user_id: userId, emoji, thread_id: null, created_at: now }],
    added: true,
  };
}

/** Merge realtime / fetched rows into a list without duplicates. */
export function mergeReactions(
  existing: readonly ChatMessageReaction[],
  incoming: readonly ChatMessageReaction[],
): ChatMessageReaction[] {
  const key = (r: ChatMessageReaction) => `${r.message_id}|${r.user_id}|${r.emoji}`;
  const byKey = new Map<string, ChatMessageReaction>();
  for (const r of existing) byKey.set(key(r), r);
  for (const r of incoming) byKey.set(key(r), r);
  return [...byKey.values()];
}

export function removeReaction(
  existing: readonly ChatMessageReaction[],
  row: Pick<ChatMessageReaction, 'message_id' | 'user_id' | 'emoji'>,
): ChatMessageReaction[] {
  return existing.filter(
    (r) => !(r.message_id === row.message_id && r.user_id === row.user_id && r.emoji === row.emoji),
  );
}
