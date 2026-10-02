/**
 * Command palette (Ctrl/Cmd+K): text matching / ranking, the recent list and
 * the active-option step. Pure, so the rules are unit-tested without a DOM;
 * `components/layout/command-palette.tsx` renders them.
 */

/** Lowercase without accents: "Configurações" matches "configuracoes". */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

/**
 * Match quality of `query` against `label` (+ extra `keywords`): 0 label
 * starts with it, 1 a word of the label starts with it, 2 the label contains
 * it, 3 only the keywords contain it; null = no match. An empty query
 * matches everything at 0.
 */
export function matchScore(query: string, label: string, keywords = ''): number | null {
  const q = foldText(query)
  if (!q) return 0
  const l = foldText(label)
  if (l.startsWith(q)) return 0
  if (l.split(/[\s·/-]+/).some((word) => word.startsWith(q))) return 1
  if (l.includes(q)) return 2
  if (keywords && foldText(keywords).includes(q)) return 3
  return null
}

/** Items matching `query`, best first; ties keep their original order. */
export function rankItems<T extends { label: string; keywords?: string }>(items: readonly T[], query: string): T[] {
  return items
    .map((item, index) => ({ item, index, score: matchScore(query, item.label, item.keywords) }))
    .filter((x): x is { item: T; index: number; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((x) => x.item)
}

/** Next active option: arrows wrap around; -1 when there is nothing. */
export function stepOption(current: number, dir: 1 | -1, length: number): number {
  if (length <= 0) return -1
  if (current < 0 || current >= length) return dir === 1 ? 0 : length - 1
  return (current + dir + length) % length
}

// ---- Recent items (per user, this device) ----

export interface RecentEntry {
  kind: 'page' | 'conversation' | 'contact'
  href: string
  label: string
}

export const RECENTS_MAX = 5

const recentsKey = (userId: string) => `semprecrm:palette:recent:${userId}`

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** `entry` first, without an older copy of the same link, capped at RECENTS_MAX. */
export function addRecent(list: readonly RecentEntry[], entry: RecentEntry): RecentEntry[] {
  return [entry, ...list.filter((x) => x.href !== entry.href)].slice(0, RECENTS_MAX)
}

function isRecent(value: unknown): value is RecentEntry {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    (v.kind === 'page' || v.kind === 'conversation' || v.kind === 'contact') &&
    typeof v.href === 'string' &&
    // Only in-app links: a tampered entry never sends the agent off-site.
    v.href.startsWith('/') &&
    !v.href.startsWith('//') &&
    typeof v.label === 'string'
  )
}

export function readRecents(userId: string | null | undefined, storage: StorageLike | null = defaultStorage()): RecentEntry[] {
  if (!userId) return []
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(recentsKey(userId)) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isRecent).slice(0, RECENTS_MAX) : []
  } catch {
    return []
  }
}

export function rememberRecent(
  userId: string | null | undefined,
  entry: RecentEntry,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!userId || !entry.label) return
  try {
    storage?.setItem(recentsKey(userId), JSON.stringify(addRecent(readRecents(userId, storage), entry)))
  } catch {
    // best-effort (private mode, quota)
  }
}
