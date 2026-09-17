// ============================================================
// Internal chat — presence reducers (pure).
//
// The Supabase presence channel `presence:account:<id>` hands the
// client a `presenceState()` map keyed by the tracking key (we use the
// user id). "Online" = present in that map. Typing indicators are
// broadcasts on the same channel that expire 3 s after they were last
// received. Both are folded here so the provider stays thin and the
// rules are unit-testable without a socket.
// ============================================================

/** Channel name for an account's presence + typing traffic. */
export function presenceChannelName(accountId: string): string {
  return `presence:account:${accountId}`;
}

/** What each client tracks on the channel. */
export interface PresenceMeta {
  user_id: string;
  /** ISO timestamp of when the client joined. */
  at: string;
}

/** How long a typing broadcast stays visible without a refresh. */
export const TYPING_TTL_MS = 3_000;

/** Send another typing broadcast no more often than this while typing. */
export const TYPING_THROTTLE_MS = 1_500;

export interface TypingPayload {
  thread_id: string;
  user_id: string;
}

/** `presenceState()` → the set of online user ids. */
export function onlineIdsFromState(state: Record<string, readonly Partial<PresenceMeta>[]>): Set<string> {
  const ids = new Set<string>();
  for (const [key, metas] of Object.entries(state)) {
    // Tracking key is the user id, but fall back to the meta payload in
    // case a client tracked under a different key.
    if (metas.length === 0) continue;
    const uid = metas.find((m) => typeof m.user_id === 'string')?.user_id ?? key;
    ids.add(uid);
  }
  return ids;
}

/** `${threadId}:${userId}` → expiry (epoch ms). */
export type TypingMap = Map<string, number>;

export function typingKey(threadId: string, userId: string): string {
  return `${threadId}:${userId}`;
}

/** Record (refresh) a typing broadcast; returns a new map. */
export function applyTyping(
  map: TypingMap,
  payload: TypingPayload,
  now: number = Date.now(),
  ttl: number = TYPING_TTL_MS,
): TypingMap {
  const next = new Map(map);
  next.set(typingKey(payload.thread_id, payload.user_id), now + ttl);
  return next;
}

/** Drop expired entries; returns the same map when nothing changed. */
export function pruneTyping(map: TypingMap, now: number = Date.now()): TypingMap {
  let changed = false;
  const next: TypingMap = new Map();
  for (const [key, expiresAt] of map) {
    if (expiresAt > now) next.set(key, expiresAt);
    else changed = true;
  }
  return changed ? next : map;
}

/** User ids currently typing in `threadId` (excluding `exceptUserId`). */
export function typingUsersIn(
  map: TypingMap,
  threadId: string,
  exceptUserId: string | null,
  now: number = Date.now(),
): string[] {
  const out: string[] = [];
  const prefix = `${threadId}:`;
  for (const [key, expiresAt] of map) {
    if (expiresAt <= now) continue;
    if (!key.startsWith(prefix)) continue;
    const uid = key.slice(prefix.length);
    if (uid === exceptUserId) continue;
    out.push(uid);
  }
  return out;
}

/** Earliest expiry in the map (to schedule the next prune), or null. */
export function nextTypingExpiry(map: TypingMap): number | null {
  let min: number | null = null;
  for (const expiresAt of map.values()) {
    if (min === null || expiresAt < min) min = expiresAt;
  }
  return min;
}
