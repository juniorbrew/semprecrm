// ============================================================
// Quick replies — "/termo" detection and ranking.
//
//   shortcut equals the term       → first
//   shortcut starts with the term  → next
//   title contains the term        → last
//   anything else                  → dropped
//
// Matching is case- and accent-insensitive on the title; shortcuts
// are already lower-case ASCII.
// ============================================================

import type { QuickReply } from '@/types';

export const QUICK_REPLY_SHORTCUT_RE = /^[a-z0-9_-]{1,30}$/;

/** Max entries shown in the composer popover. */
export const QUICK_REPLY_MAX_RESULTS = 8;

/** True when `shortcut` is a valid quick-reply shortcut. */
export function isValidShortcut(shortcut: string): boolean {
  return QUICK_REPLY_SHORTCUT_RE.test(shortcut);
}

/** Lower-case, strip diacritics. */
export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export interface SlashToken {
  /** Index of the "/" in the text. */
  start: number;
  /** Index just past the term (== caret). */
  end: number;
  /** Text after the "/" (may be empty). */
  term: string;
}

/**
 * Find the "/termo" the caret is sitting on: a "/" at the start of the
 * text or right after whitespace, followed by non-space characters up
 * to the caret. Returns null when the caret is not inside such a token
 * (e.g. "a/b", "5/10", or "/x y" with the caret after the space).
 */
export function findSlashToken(text: string, caret: number): SlashToken | null {
  const upto = text.slice(0, caret);
  const slash = upto.lastIndexOf('/');
  if (slash < 0) return null;
  if (slash > 0 && !/\s/.test(upto[slash - 1] ?? '')) return null;
  const term = upto.slice(slash + 1);
  if (/\s/.test(term)) return null;
  return { start: slash, end: caret, term };
}

/**
 * Filter + rank. Empty term → every reply, sorted by shortcut. The
 * result is capped at `limit` (default 8).
 */
export function matchQuickReplies(
  replies: readonly QuickReply[],
  term: string,
  limit: number = QUICK_REPLY_MAX_RESULTS,
): QuickReply[] {
  const q = normalizeForMatch(term);
  const ranked: { reply: QuickReply; rank: number }[] = [];
  for (const reply of replies) {
    const shortcut = reply.shortcut.toLowerCase();
    let rank: number;
    if (!q) rank = 0;
    else if (shortcut === q) rank = -1;
    else if (shortcut.startsWith(q)) rank = 0;
    else if (normalizeForMatch(reply.title).includes(q)) rank = 1;
    else continue;
    ranked.push({ reply, rank });
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.reply.shortcut.localeCompare(b.reply.shortcut) ||
      a.reply.title.localeCompare(b.reply.title),
  );
  return ranked.slice(0, Math.max(0, limit)).map((r) => r.reply);
}

/**
 * Replace the "/termo" token in `text` with `insert`, adding a space
 * when the token is glued to following text. Returns the new text and
 * where the caret should land (right after the insertion).
 */
export function replaceSlashToken(
  text: string,
  token: SlashToken,
  insert: string,
): { text: string; caret: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  const needsSpace = after.length > 0 && !/^\s/.test(after);
  const value = insert + (needsSpace ? ' ' : '');
  return { text: before + value + after, caret: before.length + value.length };
}
