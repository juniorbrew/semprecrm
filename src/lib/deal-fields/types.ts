export type FieldKind = 'number' | 'currency' | 'percent' | 'formula'
export type ResultFormat = 'number' | 'currency' | 'percent'

export interface DealField {
  id: string
  account_id: string
  name: string
  kind: FieldKind
  /** Stored formula text (ids, not names); only for kind = 'formula'. */
  expression: string | null
  result_format: ResultFormat | null
  show_on_card: boolean
  position: number
}

/** field id -> the number the deal has for it (empty fields have no entry). */
export type FieldValues = Record<string, number>

/** What an admin edits. `expression` is already compiled to the stored text. */
export interface DealFieldInput {
  name: string
  kind: FieldKind
  expression?: string | null
  result_format?: ResultFormat | null
  show_on_card?: boolean
}

export const MAX_DEAL_FIELDS = 50
export const MAX_CARD_FIELDS = 2
export const FIELD_NAME_MAX = 40
