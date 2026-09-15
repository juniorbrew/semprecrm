// ============================================================
// "Who is looking at which conversation" (spec round 2 §5).
//
// The inbox POSTs /api/push/seen when a conversation is focused; the
// inbound-message push skips users whose focus is on that conversation.
// Module-level map with a 60 s TTL — per process, which is fine for the
// single-process dev / PM2 deployment this targets. A multi-instance
// deploy would move this to Redis / a table; the API is shaped so only
// this file changes.
// ============================================================

export const FOCUS_TTL_MS = 60_000;

interface FocusEntry {
  conversationId: string;
  expiresAt: number;
}

const focus = new Map<string, FocusEntry>();

/** Record (or clear, with `null`) the conversation `userId` has open. */
export function setConversationFocus(
  userId: string,
  conversationId: string | null,
  now: number = Date.now(),
): void {
  if (!conversationId) {
    focus.delete(userId);
    return;
  }
  focus.set(userId, { conversationId, expiresAt: now + FOCUS_TTL_MS });
  // Opportunistic sweep so the map cannot grow unbounded.
  if (focus.size > 500) sweep(now);
}

/** True when `userId` reported focus on `conversationId` within the TTL. */
export function isFocusedOn(
  userId: string,
  conversationId: string,
  now: number = Date.now(),
): boolean {
  const entry = focus.get(userId);
  if (!entry) return false;
  if (entry.expiresAt <= now) {
    focus.delete(userId);
    return false;
  }
  return entry.conversationId === conversationId;
}

function sweep(now: number): void {
  for (const [userId, entry] of focus) {
    if (entry.expiresAt <= now) focus.delete(userId);
  }
}

/** Tests only. */
export function _resetFocusForTests(): void {
  focus.clear();
}
