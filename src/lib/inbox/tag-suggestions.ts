import type { Tag } from '@/types'

/** How many one-click chips the panel offers. */
export const TAG_SUGGESTION_LIMIT = 8

/**
 * The account's most-used tags not yet on the contact, most used first
 * (name breaks ties so the order is stable).
 */
export function rankTagSuggestions(
  allTags: readonly Tag[],
  usage: Readonly<Record<string, number>>,
  appliedIds: ReadonlySet<string>,
  limit: number = TAG_SUGGESTION_LIMIT,
): Tag[] {
  return allTags
    .filter((t) => !appliedIds.has(t.id))
    .sort(
      (a, b) =>
        (usage[b.id] ?? 0) - (usage[a.id] ?? 0) || a.name.localeCompare(b.name),
    )
    .slice(0, limit)
}
