// Pure glue between deal fields, a deal and the formula engine: the variables a
// formula sees, the value of every field of a deal, number formatting and parsing.

import { formatCurrency, formatMoney } from '@/lib/currency'
import { closeDateInfo } from '@/lib/pipelines/deal-dates'

import {
  BUILTIN_VARS,
  evaluateStored,
  fieldRef,
  storedFieldIds,
  type EvalResult,
  type Vars,
} from './formula'
import { MAX_CARD_FIELDS, type DealField, type FieldValues, type ResultFormat } from './types'

/** What a deal contributes to formulas besides its custom fields. */
export interface DealFacts {
  value: number
  /** Chance of the stage, 0-1 (stageProbability in pipelines/board). */
  chance: number
  /** Sum of the item lines; 0 when the deal has none. */
  itemsSum: number
  /** deals.expected_close_date ("YYYY-MM-DD") or empty. */
  expectedCloseDate?: string | null
}

/** Signed days to the expected close date; null without one. */
export function daysToClose(date: string | null | undefined, now: number = Date.now()): number | null {
  return date ? closeDateInfo(date, 'pt-BR', now)?.days ?? null : null
}

/**
 * The variables of one deal. Percent fields enter as fractions (5 -> 0.05); a field with
 * no value is null; a formula field is not a variable (formulas cannot use formulas).
 */
export function buildVars(fields: DealField[], values: FieldValues, deal: DealFacts, now: number = Date.now()): Vars {
  const vars: Vars = {
    valor: Number.isFinite(deal.value) ? deal.value : null,
    chance: deal.chance,
    itens: deal.itemsSum,
    dias: daysToClose(deal.expectedCloseDate, now),
  }
  for (const f of fields) {
    if (f.kind === 'formula') continue
    const v = values[f.id]
    vars[fieldRef(f.id)] = v === undefined ? null : f.kind === 'percent' ? v / 100 : v
  }
  return vars
}

export type FormatMode = 'drawer' | 'card'

function formatPlain(n: number, maxDecimals: number): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: maxDecimals }).format(n)
}

/** Shown format of a number: `format` is the field kind (or a formula's result_format). */
export function formatFieldNumber(
  n: number,
  format: ResultFormat,
  currency: string,
  mode: FormatMode = 'drawer',
  /** A formula percent result is a fraction (0.05); a percent field already holds 5. */
  fraction = false,
): string {
  switch (format) {
    case 'currency':
      return mode === 'card' ? formatCurrency(n, currency) : formatMoney(n, currency)
    case 'percent':
      return `${formatPlain(fraction ? n * 100 : n, 2)}%`
    default:
      return formatPlain(n, 4)
  }
}

export interface FieldRow {
  field: DealField
  /** Number to show; null = empty / not computable. */
  value: number | null
  /** Formatted `value`, or null. */
  text: string | null
  /** Formulas only: why there is no value. */
  eval?: EvalResult
}

/** One row per field in the admin's order, formulas computed from the other values. */
export function computeFieldRows(
  fields: DealField[],
  values: FieldValues,
  deal: DealFacts,
  currency: string,
  mode: FormatMode = 'drawer',
  now: number = Date.now(),
): FieldRow[] {
  const vars = buildVars(fields, values, deal, now)
  return fields.map((field) => {
    if (field.kind === 'formula') {
      const result = evaluateStored(field.expression ?? '', vars)
      const format = field.result_format ?? 'number'
      return {
        field,
        eval: result,
        value: result.value,
        text: result.value === null ? null : formatFieldNumber(result.value, format, currency, mode, true),
      }
    }
    const v = values[field.id]
    return {
      field,
      value: v ?? null,
      text: v === undefined ? null : formatFieldNumber(v, field.kind, currency, mode),
    }
  })
}

/** Fields shown on the card: marked, in order, at most two. */
export function cardFields(fields: DealField[]): DealField[] {
  return fields.filter((f) => f.show_on_card).slice(0, MAX_CARD_FIELDS)
}

/** Field ids to load values for so the card fields (and the fields their formulas use) can be computed. */
export function fieldIdsForCard(fields: DealField[]): string[] {
  const ids = new Set<string>()
  for (const f of cardFields(fields)) {
    if (f.kind === 'formula') for (const id of storedFieldIds(f.expression ?? '')) ids.add(id)
    else ids.add(f.id)
  }
  return [...ids]
}

/** True when a card field's formula needs the item sum ({itens}). */
export function cardNeedsItems(fields: DealField[]): boolean {
  return cardFields(fields).some((f) => f.kind === 'formula' && /\{itens\}/.test(f.expression ?? ''))
}

/** Formula fields (other than `fieldId`) whose expression uses the field: warn before deleting it. */
export function formulasUsing(fields: DealField[], fieldId: string): DealField[] {
  return fields.filter((f) => f.kind === 'formula' && f.id !== fieldId && storedFieldIds(f.expression ?? '').includes(fieldId))
}

/** Names of the formula's empty inputs, for the "fill in Custo" hint. */
export function missingNames(result: EvalResult, fields: DealField[]): string[] {
  const names = new Map(fields.map((f) => [fieldRef(f.id), f.name]))
  const builtin = new Map(BUILTIN_VARS.map((b) => [b.ref as string, b.name]))
  return result.missing.map((ref) => names.get(ref) ?? builtin.get(ref) ?? ref)
}

// ---- typing a value ----------------------------------------------------------------------

export const FIELD_VALUE_MAX = 999_999_999_999

export type ParsedValue = { ok: true; value: number | null } | { ok: false }

/**
 * What a person typed into a number field: "12,5", "1.500,50", "R$ 150", "5%", "-3".
 * pt-BR: dots group thousands, comma is the decimal separator. Empty clears the value.
 * Up to 4 decimals, within the database range.
 */
export function parseFieldInput(text: string): ParsedValue {
  let s = text.trim().replace(/^(-?)\s*(?:R\$|US\$|[$€£])\s*/i, '$1').replace(/%$/, '').replace(/\s/g, '')
  if (!s) return { ok: true, value: null }
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '')
  if (!/^-?\d+(\.\d{1,4})?$/.test(s)) return { ok: false }
  const n = Number(s)
  if (Math.abs(n) > FIELD_VALUE_MAX) return { ok: false }
  return { ok: true, value: Object.is(n, -0) ? 0 : n }
}

/** Number as it goes into an input box ("12,5"). */
export function valueToInput(n: number | undefined): string {
  return n === undefined ? '' : String(n).replace('.', ',')
}

export interface FieldChange {
  fieldId: string
  /** null clears the value. */
  value: number | null
}

/**
 * What the form changed: for each number field, the typed text against what the deal had.
 * Unchanged fields are not written. A text that is not a number blocks the save (`invalid`).
 */
export function diffFieldInputs(
  fields: DealField[],
  texts: Record<string, string>,
  initial: FieldValues,
): { changes: FieldChange[]; invalid: string[] } {
  const changes: FieldChange[] = []
  const invalid: string[] = []
  for (const f of fields) {
    if (f.kind === 'formula' || !(f.id in texts)) continue
    const parsed = parseFieldInput(texts[f.id])
    if (!parsed.ok) {
      invalid.push(f.id)
      continue
    }
    const before = initial[f.id] ?? null
    if (parsed.value !== before) changes.push({ fieldId: f.id, value: parsed.value })
  }
  return { changes, invalid }
}
