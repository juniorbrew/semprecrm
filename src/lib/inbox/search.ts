/**
 * Inbox search term -> ILIKE pattern for `inbox_conversation_page`
 * (p_pattern). The pattern is sent as an RPC parameter, so PostgREST filter
 * syntax (`, ( ) . :`) is irrelevant; what must be escaped are the LIKE
 * wildcards, otherwise typing "100%" or "a_b" would match everything.
 */
export const MAX_SEARCH_LENGTH = 100

/** Trim, collapse whitespace, cap the length. */
export function normalizeSearch(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_LENGTH).trim()
}

/** Escape `\`, `%` and `_` (Postgres' default LIKE escape is a backslash). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** `%term%` (escaped), or null when there is nothing to search for. */
export function buildSearchPattern(raw: string): string | null {
  const term = normalizeSearch(raw)
  return term ? `%${escapeLike(term)}%` : null
}
