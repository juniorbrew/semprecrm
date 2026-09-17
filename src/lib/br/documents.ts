// ============================================================
// Brazilian registration documents — pure helpers.
//
// A SempreCRM account (tenant) belongs either to a pessoa física
// (CPF) or a pessoa jurídica (CNPJ). The signup page, the account
// settings panel and PATCH /api/account all validate through
// `validateAccountRegistration` so the rules live in one place.
//
// CNPJ: since July 2026 the Receita Federal issues alphanumeric
// CNPJs — the first twelve positions may be digits or upper-case
// letters; the two check digits are always numeric and are computed
// over `charCode - 48` (so 'A' weighs 17). Numeric CNPJs are a
// subset, so one routine covers both.
//
// Isomorphic: no browser globals, no network.
// ============================================================

export const PERSON_TYPES = ['pf', 'pj'] as const
export type PersonType = (typeof PERSON_TYPES)[number]

export const CPF_LENGTH = 11
export const CNPJ_LENGTH = 14
export const MAX_NAME_LEN = 80

export function isPersonType(value: unknown): value is PersonType {
  return value === 'pf' || value === 'pj'
}

/** Strip mask characters (dots, slash, dash, spaces) and upper-case letters. */
export function normalizeTaxId(raw: string): string {
  return raw.replace(/[^0-9a-zA-Z]/g, '').toUpperCase()
}

function allSame(value: string): boolean {
  return value.split('').every((c) => c === value[0])
}

function mod11Digit(values: number[], weights: number[]): number {
  const sum = values.reduce((acc, v, i) => acc + v * weights[i], 0)
  const rest = sum % 11
  return rest < 2 ? 0 : 11 - rest
}

export function isValidCpf(value: string): boolean {
  if (!/^\d{11}$/.test(value) || allSame(value)) return false
  const digits = value.split('').map(Number)
  const d1 = mod11Digit(digits.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2])
  const d2 = mod11Digit(digits.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2])
  return digits[9] === d1 && digits[10] === d2
}

export function isValidCnpj(value: string): boolean {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(value) || allSame(value)) return false
  const values = value.split('').map((c) => c.charCodeAt(0) - 48)
  const d1 = mod11Digit(values.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  const d2 = mod11Digit(values.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  return values[12] === d1 && values[13] === d2
}

export function isValidTaxId(personType: PersonType, value: string): boolean {
  return personType === 'pf' ? isValidCpf(value) : isValidCnpj(value)
}

/**
 * Mask a (possibly partial) document for display / while typing.
 * CPF keeps digits only; CNPJ keeps digits and letters. Input longer
 * than the document is truncated.
 */
export function formatTaxId(personType: PersonType, raw: string): string {
  if (personType === 'pf') {
    const d = raw.replace(/\D/g, '').slice(0, CPF_LENGTH)
    return d
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4')
  }
  const d = normalizeTaxId(raw).slice(0, CNPJ_LENGTH)
  return d
    .replace(/^([0-9A-Z]{2})([0-9A-Z])/, '$1.$2')
    .replace(/^([0-9A-Z]{2})\.([0-9A-Z]{3})([0-9A-Z])/, '$1.$2.$3')
    .replace(/^([0-9A-Z]{2})\.([0-9A-Z]{3})\.([0-9A-Z]{3})([0-9A-Z])/, '$1.$2.$3/$4')
    .replace(/^([0-9A-Z]{2})\.([0-9A-Z]{3})\.([0-9A-Z]{3})\/([0-9A-Z]{4})([0-9A-Z])/, '$1.$2.$3/$4-$5')
}

// ------------------------------------------------------------
// Registration form validation (shared by signup, settings, API)
// ------------------------------------------------------------

export interface RegistrationInput {
  personType: PersonType
  /** CPF or CNPJ, masked or not. */
  taxId: string
  /** Razão social — pessoa jurídica only. */
  legalName?: string | null
  /** Nome fantasia — pessoa jurídica only; optional. */
  tradeName?: string | null
  /** Name of the person signing up / the responsible person. */
  fullName: string
}

export interface Registration {
  personType: PersonType
  /** Normalised document (digits / upper-case letters, no mask). */
  taxId: string
  legalName: string | null
  /** What the tenant is called across the app (`accounts.name`). */
  accountName: string
  fullName: string
}

export type RegistrationErrorCode = 'required' | 'invalid' | 'too_long'
export type RegistrationField = 'personType' | 'taxId' | 'legalName' | 'tradeName' | 'fullName'
export type RegistrationErrors = Partial<Record<RegistrationField, RegistrationErrorCode>>

export type RegistrationResult =
  | { ok: true; value: Registration }
  | { ok: false; errors: RegistrationErrors }

function nameError(value: string, required: boolean): RegistrationErrorCode | null {
  if (value.length === 0) return required ? 'required' : null
  if (value.length > MAX_NAME_LEN) return 'too_long'
  return null
}

export interface DocumentInput {
  personType: PersonType
  taxId: string
  legalName?: string | null
}

export interface AccountDocument {
  personType: PersonType
  taxId: string
  legalName: string | null
}

export type DocumentResult =
  | { ok: true; value: AccountDocument }
  | { ok: false; errors: RegistrationErrors }

/**
 * Type + document (+ razão social for pessoa jurídica). Used on its own
 * by Settings → Empresa / PATCH /api/account, and by
 * `validateAccountRegistration` for signup.
 */
export function validateAccountDocument(input: DocumentInput): DocumentResult {
  if (!isPersonType(input.personType)) return { ok: false, errors: { personType: 'invalid' } }

  const errors: RegistrationErrors = {}
  const personType = input.personType
  const taxId = normalizeTaxId(input.taxId ?? '')
  const legalName = (input.legalName ?? '').trim()

  if (taxId.length === 0) errors.taxId = 'required'
  else if (!isValidTaxId(personType, taxId)) errors.taxId = 'invalid'

  if (personType === 'pj') {
    const legalErr = nameError(legalName, true)
    if (legalErr) errors.legalName = legalErr
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, value: { personType, taxId, legalName: personType === 'pj' ? legalName : null } }
}

export function validateAccountRegistration(input: RegistrationInput): RegistrationResult {
  const doc = validateAccountDocument(input)
  const errors: RegistrationErrors = doc.ok ? {} : { ...doc.errors }
  if (errors.personType) return { ok: false, errors }

  const fullName = (input.fullName ?? '').trim()
  const tradeName = (input.tradeName ?? '').trim()

  const fullNameErr = nameError(fullName, true)
  if (fullNameErr) errors.fullName = fullNameErr

  if (input.personType === 'pj') {
    const tradeErr = nameError(tradeName, false)
    if (tradeErr) errors.tradeName = tradeErr
  }

  if (!doc.ok || Object.keys(errors).length > 0) return { ok: false, errors }

  return {
    ok: true,
    value: {
      ...doc.value,
      accountName: doc.value.personType === 'pj' ? tradeName || doc.value.legalName! : fullName,
      fullName,
    },
  }
}
