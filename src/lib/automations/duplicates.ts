// ============================================================
// Duplicate automation warning. Two ACTIVE automations listening to the
// same trigger (same type, same trigger settings) usually means a rule
// was saved twice or copied and forgotten — and the customer gets every
// reply in double. Pure: works on the rows the list page already has.
// ============================================================

import type { Automation } from '@/types'

type Row = Pick<Automation, 'id' | 'name' | 'trigger_type' | 'trigger_config' | 'is_active'>

/** Stable key: trigger type + trigger settings with sorted keys / keywords. */
export function triggerSignature(a: Pick<Automation, 'trigger_type' | 'trigger_config'>): string {
  return `${a.trigger_type}:${stableStringify(a.trigger_config ?? {})}`
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) {
    const items = v.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : x))
    const sorted = items.every((x) => typeof x === 'string') ? [...items].sort() : items
    return `[${sorted.map(stableStringify).join(',')}]`
  }
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined && obj[k] !== '' && obj[k] !== null)
      .sort()
      .map((k) => `${k}:${stableStringify(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

/**
 * For every active automation that shares its trigger with another
 * active one, the names of the others. Inactive rows never count.
 */
export function findDuplicateAutomations(rows: Row[]): Map<string, string[]> {
  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    if (!r.is_active) continue
    const key = triggerSignature(r)
    const g = groups.get(key)
    if (g) g.push(r)
    else groups.set(key, [r])
  }
  const out = new Map<string, string[]>()
  for (const g of groups.values()) {
    if (g.length < 2) continue
    for (const r of g) {
      out.set(
        r.id,
        g.filter((o) => o.id !== r.id).map((o) => o.name),
      )
    }
  }
  return out
}
