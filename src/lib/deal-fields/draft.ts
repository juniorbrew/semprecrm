// What an admin types in the field editor, validated before it reaches the database.
// The database enforces the same rules (unique name, 50 fields, 2 on the card) as the
// last line; this gives friendly messages first.

import {
  compileFormula,
  isReservedFieldName,
  type FieldRef,
  type FormulaError,
  type FormulaErrorCode,
} from './formula'
import {
  FIELD_NAME_MAX,
  MAX_CARD_FIELDS,
  MAX_DEAL_FIELDS,
  type DealField,
  type DealFieldInput,
  type FieldKind,
  type ResultFormat,
} from './types'

export interface FieldDraft {
  name: string
  kind: FieldKind
  /** The formula as the admin sees it (names in braces). */
  formulaText: string
  resultFormat: ResultFormat
  showOnCard: boolean
}

export type NameError = 'name' | 'name-max' | 'name-chars' | 'name-reserved' | 'name-dup'

export interface DraftErrors {
  name?: NameError
  formula?: FormulaError
  /** Already two other fields on the card. */
  card?: true
  /** 50 fields already. */
  limit?: true
}

export type DraftResult = { ok: true; input: DealFieldInput } | { ok: false; errors: DraftErrors }

/** English message keys for `t()`. */
export const NAME_ERROR_TEXT: Record<NameError, string> = {
  name: 'Type a name for the field',
  'name-max': 'The name can have at most 40 characters',
  'name-chars': 'The name cannot contain { or }',
  'name-reserved': 'This name is used by a number of the deal (Valor, Chance, Itens, Dias para fechar)',
  'name-dup': 'A field with this name already exists',
}

export const FORMULA_ERROR_TEXT: Record<FormulaErrorCode, string> = {
  empty: 'Type the formula',
  too_long: 'The formula can have at most 300 characters',
  too_complex: 'The formula is too complex',
  unbalanced_paren: 'Check the parentheses: one is open or closed without a match',
  empty_parens: 'There is nothing inside the parentheses',
  unexpected_char: 'Only numbers, fields in braces, + − × ÷ and parentheses are allowed',
  bad_number: 'This number is not valid. Use one comma or dot for decimals, like 0,05',
  unterminated_ref: 'A field name is missing its closing brace }',
  unknown_field: 'This field does not exist',
  formula_reference: 'A formula cannot use another formula',
  dangling_operator: 'The calculation is incomplete: an operator is missing a number',
  missing_operator: 'Put an operator (+ − × ÷) between the values',
}

export function toFieldRefs(fields: DealField[]): FieldRef[] {
  return fields.map((f) => ({ id: f.id, name: f.name, kind: f.kind }))
}

/** `editing` is the field being edited (its own name is not a duplicate of itself). */
export function validateFieldDraft(draft: FieldDraft, fields: DealField[], editing?: DealField | null): DraftResult {
  const errors: DraftErrors = {}
  const name = draft.name.trim()
  const others = fields.filter((f) => f.id !== editing?.id)

  if (!name) errors.name = 'name'
  else if (name.length > FIELD_NAME_MAX) errors.name = 'name-max'
  else if (/[{}]/.test(name)) errors.name = 'name-chars'
  else if (isReservedFieldName(name)) errors.name = 'name-reserved'
  else if (others.some((f) => f.name.trim().toLowerCase() === name.toLowerCase())) errors.name = 'name-dup'

  if (!editing && fields.length >= MAX_DEAL_FIELDS) errors.limit = true
  if (draft.showOnCard && others.filter((f) => f.show_on_card).length >= MAX_CARD_FIELDS) errors.card = true

  let expression: string | null = null
  if (draft.kind === 'formula') {
    const compiled = compileFormula(draft.formulaText, toFieldRefs(others))
    if (compiled.ok) expression = compiled.stored
    else errors.formula = compiled.error
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    input: {
      name,
      kind: draft.kind,
      expression,
      result_format: draft.kind === 'formula' ? draft.resultFormat : null,
      show_on_card: draft.showOnCard,
    },
  }
}
