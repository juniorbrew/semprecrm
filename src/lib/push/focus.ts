// ============================================================
// "Who is looking at what" (spec round 2 §5 + internal chat).
//
// The inbox POSTs /api/push/seen when a conversation is focused; the
// inbound-message push skips users whose focus is on that conversation.
// The internal chat does the same with `chat_thread_id` so a teammate
// reading the thread is not pushed about it. The two are tracked
// separately — a user may have the inbox and the chat open in two tabs.
// Module-level maps with a 60 s TTL — per process, which is fine for the
// single-process dev / PM2 deployment this targets. A multi-instance
// deploy would move this to Redis / a table; the API is shaped so only
// this file changes.
// ============================================================

export const FOCUS_TTL_MS = 60_000;

interface FocusEntry {
  id: string;
  expiresAt: number;
}

const conversationFocus = new Map<string, FocusEntry>();
const chatThreadFocus = new Map<string, FocusEntry>();

function set(map: Map<string, FocusEntry>, userId: string, id: string | null, now: number): void {
  if (!id) {
    map.delete(userId);
    return;
  }
  map.set(userId, { id, expiresAt: now + FOCUS_TTL_MS });
  // Opportunistic sweep so the map cannot grow unbounded.
  if (map.size > 500) sweep(map, now);
}

function has(map: Map<string, FocusEntry>, userId: string, id: string, now: number): boolean {
  const entry = map.get(userId);
  if (!entry) return false;
  if (entry.expiresAt <= now) {
    map.delete(userId);
    return false;
  }
  return entry.id === id;
}

function sweep(map: Map<string, FocusEntry>, now: number): void {
  for (const [userId, entry] of map) {
    if (entry.expiresAt <= now) map.delete(userId);
  }
}

/** Record (or clear, with `null`) the conversation `userId` has open. */
export function setConversationFocus(
  userId: string,
  conversationId: string | null,
  now: number = Date.now(),
): void {
  set(conversationFocus, userId, conversationId, now);
}

/** True when `userId` reported focus on `conversationId` within the TTL. */
export function isFocusedOn(
  userId: string,
  conversationId: string,
  now: number = Date.now(),
): boolean {
  return has(conversationFocus, userId, conversationId, now);
}

/** Record (or clear, with `null`) the internal chat thread `userId` has open. */
export function setChatThreadFocus(
  userId: string,
  threadId: string | null,
  now: number = Date.now(),
): void {
  set(chatThreadFocus, userId, threadId, now);
}

/** True when `userId` reported focus on chat thread `threadId` within the TTL. */
export function isFocusedOnChatThread(
  userId: string,
  threadId: string,
  now: number = Date.now(),
): boolean {
  return has(chatThreadFocus, userId, threadId, now);
}

/** Tests only. */
export function _resetFocusForTests(): void {
  conversationFocus.clear();
  chatThreadFocus.clear();
}
