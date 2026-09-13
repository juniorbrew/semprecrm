// ============================================================
// accounts.preferences (migration 030) — typed access.
//
// The column is a free-form jsonb so new keys never need a
// migration. Everything that reads it goes through
// `parseAccountPreferences`, which tolerates a missing / malformed
// value (older rows, a hand-edited JSON) by falling back per key to
// the defaults below.
// ============================================================

import type { AccountPreferences } from '@/types'

export const DEFAULT_ACCOUNT_PREFERENCES: AccountPreferences = {
  inbox_sla_minutes: 15,
  cooling_hours: 24,
  opt_out_keywords: ['parar', 'sair', 'stop', 'cancelar'],
}

/** Bounds the settings form and the parser agree on. */
export const PREFERENCE_LIMITS = {
  inbox_sla_minutes: { min: 1, max: 1440 },
  cooling_hours: { min: 1, max: 720 },
  opt_out_keyword_max_length: 30,
  opt_out_keywords_max: 20,
} as const

function positiveNumber(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  if (n < min || n > max) return null
  return n
}

/**
 * Normalise a keyword the way the opt-out matcher compares messages:
 * trimmed, lower-case, no accents. Empty result → dropped.
 */
export function normalizeOptOutKeyword(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
  if (!cleaned) return null
  return cleaned.slice(0, PREFERENCE_LIMITS.opt_out_keyword_max_length)
}

function keywordList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    const k = normalizeOptOutKeyword(item)
    if (k && !out.includes(k)) out.push(k)
    if (out.length >= PREFERENCE_LIMITS.opt_out_keywords_max) break
  }
  return out
}

/**
 * Parse the raw jsonb into a full `AccountPreferences`. Each key falls
 * back independently, so one bad value never wipes the others. An
 * explicitly empty keyword list is honoured (the account chose to
 * disable opt-out words); a non-array is not.
 */
export function parseAccountPreferences(raw: unknown): AccountPreferences {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
  const d = DEFAULT_ACCOUNT_PREFERENCES
  return {
    inbox_sla_minutes:
      positiveNumber(
        obj.inbox_sla_minutes,
        PREFERENCE_LIMITS.inbox_sla_minutes.min,
        PREFERENCE_LIMITS.inbox_sla_minutes.max,
      ) ?? d.inbox_sla_minutes,
    cooling_hours:
      positiveNumber(
        obj.cooling_hours,
        PREFERENCE_LIMITS.cooling_hours.min,
        PREFERENCE_LIMITS.cooling_hours.max,
      ) ?? d.cooling_hours,
    opt_out_keywords: keywordList(obj.opt_out_keywords) ?? [...d.opt_out_keywords],
  }
}

/**
 * What the settings form writes back. Merges over the existing jsonb so
 * keys owned by other features survive; values are validated the same
 * way `parseAccountPreferences` reads them.
 */
export function mergeAccountPreferences(
  existing: unknown,
  patch: Partial<AccountPreferences>,
): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  const parsed = parseAccountPreferences({ ...base, ...patch })
  if (patch.inbox_sla_minutes !== undefined) base.inbox_sla_minutes = parsed.inbox_sla_minutes
  if (patch.cooling_hours !== undefined) base.cooling_hours = parsed.cooling_hours
  if (patch.opt_out_keywords !== undefined) base.opt_out_keywords = parsed.opt_out_keywords
  return base
}
