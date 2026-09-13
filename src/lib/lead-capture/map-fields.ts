// ============================================================
// Payload → CRM fields.
//
// A lead source carries a `field_map` saying which payload key feeds
// each CRM field ("campo do CRM ← chave do payload"):
//
//   { "name": "nome", "phone": "telefone", "email": "email",
//     "company": "empresa", "custom": { "<custom_field_id>": "origem" } }
//
// Keys missing from the map fall back to the defaults below — the
// English names plus the pt-BR spellings every Brazilian form builder
// uses, so a source created with an empty map already understands
// `nome=Ana&telefone=5511…`. Map values may be dotted paths into a
// nested JSON body (`lead.telefone`). Pure, no I/O.
// ============================================================

import type { LeadSourceFieldMap } from '@/types'

import type { LeadPayload } from './parse-body'

export type LeadStandardField = 'name' | 'phone' | 'email' | 'company'

export const LEAD_STANDARD_FIELDS: readonly LeadStandardField[] = [
  'name',
  'phone',
  'email',
  'company',
]

/**
 * Keys tried, in order, when the map doesn't name one for the field.
 * The first key present (non-empty) in the payload wins.
 */
export const DEFAULT_FIELD_KEYS: Record<LeadStandardField, readonly string[]> = {
  name: ['name', 'nome', 'full_name', 'fullName', 'nome_completo', 'first_name', 'primeiro_nome'],
  phone: ['phone', 'telefone', 'celular', 'whatsapp', 'mobile', 'tel', 'phone_number', 'fone'],
  email: ['email', 'e-mail', 'e_mail', 'mail'],
  company: ['company', 'empresa', 'company_name', 'organization'],
}

/** Public defaults as a plain map (first alias of each), for the UI. */
export const DEFAULT_FIELD_MAP: Readonly<Record<LeadStandardField, string>> = {
  name: 'name',
  phone: 'phone',
  email: 'email',
  company: 'company',
}

export interface MappedLead {
  name: string | null
  phone: string | null
  email: string | null
  company: string | null
  /** custom_field_id → value, only for keys present in the payload. */
  custom: Record<string, string>
}

/**
 * Read `path` from the payload. The literal key is tried first (a form
 * field can legitimately be called `lead.telefone`), then the dotted
 * path is walked. Array indices work too (`items.0.phone`).
 */
export function getPath(payload: LeadPayload | null | undefined, path: string): unknown {
  if (!payload || !path) return undefined
  if (path in payload) return payload[path]
  if (!path.includes('.')) return undefined
  let cur: unknown = payload
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      const idx = Number(seg)
      if (!Number.isInteger(idx)) return undefined
      cur = cur[idx]
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg]
    } else {
      return undefined
    }
  }
  return cur
}

/**
 * Coerce a payload value into the string the CRM stores. Numbers and
 * booleans stringify (a phone posted as a JSON number is common);
 * arrays take their first usable element; objects and empties → null.
 */
export function coerceLeadValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    const s = value.trim()
    return s ? s : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = coerceLeadValue(v)
      if (s) return s
    }
    return null
  }
  return null
}

/**
 * Sanitize a `field_map` read from the DB / request body. Non-string
 * entries are dropped, so a hand-edited row can't crash the mapper.
 */
export function normalizeFieldMap(raw: unknown): LeadSourceFieldMap {
  const out: LeadSourceFieldMap = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const r = raw as Record<string, unknown>
  for (const f of LEAD_STANDARD_FIELDS) {
    const v = r[f]
    if (typeof v === 'string' && v.trim()) out[f] = v.trim()
  }
  const custom = r.custom
  if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
    const c: Record<string, string> = {}
    for (const [id, key] of Object.entries(custom as Record<string, unknown>)) {
      if (id && typeof key === 'string' && key.trim()) c[id] = key.trim()
    }
    if (Object.keys(c).length > 0) out.custom = c
  }
  return out
}

function readStandard(
  payload: LeadPayload,
  map: LeadSourceFieldMap,
  field: LeadStandardField,
): string | null {
  const mapped = map[field]
  if (mapped) return coerceLeadValue(getPath(payload, mapped))
  for (const key of DEFAULT_FIELD_KEYS[field]) {
    const v = coerceLeadValue(getPath(payload, key))
    if (v) return v
  }
  return null
}

/** Apply a source's field map to a payload. */
export function mapLeadFields(payload: LeadPayload, fieldMap: unknown): MappedLead {
  const map = normalizeFieldMap(fieldMap)
  const custom: Record<string, string> = {}
  for (const [fieldId, key] of Object.entries(map.custom ?? {})) {
    const v = coerceLeadValue(getPath(payload, key))
    if (v) custom[fieldId] = v
  }
  return {
    name: readStandard(payload, map, 'name'),
    phone: readStandard(payload, map, 'phone'),
    email: readStandard(payload, map, 'email'),
    company: readStandard(payload, map, 'company'),
    custom,
  }
}
