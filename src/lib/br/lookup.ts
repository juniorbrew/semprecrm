// ============================================================
// Company / address lookup — pure helpers.
//
// The signup page and Settings → Empresa fill the form from two
// public sources: BrasilAPI's CNPJ endpoint (Receita Federal data)
// and a CEP service (BrasilAPI v2, ViaCEP as fallback). The API
// routes under /api/lookup fetch; this module only maps their JSON
// to our shapes, masks phone/CEP, humanises the Receita's ALL-CAPS
// and validates the contact block stored on `accounts`.
//
// Isomorphic: no browser globals, no network.
// ============================================================

// ------------------------------------------------------------
// Shapes
// ------------------------------------------------------------

export interface AccountAddress {
  /** 8 digits, no mask. */
  cep: string
  street: string
  number: string
  complement: string
  neighborhood: string
  city: string
  /** Two-letter UF, upper-case. */
  state: string
}

export interface AddressLookup {
  cep: string
  street: string
  neighborhood: string
  city: string
  state: string
}

export interface CompanyLookup {
  taxId: string
  legalName: string
  tradeName: string
  address: AccountAddress
  /** Digits only (DDD + number); '' when the Receita has none. */
  phone: string
  email: string
  /** Receita status text, e.g. "ATIVA", "BAIXADA". */
  status: string
}

export const UF_LIST = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const

export const EMPTY_ADDRESS: AccountAddress = {
  cep: '',
  street: '',
  number: '',
  complement: '',
  neighborhood: '',
  city: '',
  state: '',
}

// ------------------------------------------------------------
// CEP
// ------------------------------------------------------------

export const CEP_LENGTH = 8

export function normalizeCep(raw: string): string {
  return (raw ?? '').replace(/\D/g, '').slice(0, CEP_LENGTH)
}

export function isValidCep(value: string): boolean {
  return /^\d{8}$/.test(value) && !/^(\d)\1{7}$/.test(value)
}

/** `01001000` → `01001-000`, progressively while typing. */
export function formatCep(raw: string): string {
  const d = normalizeCep(raw)
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d
}

// ------------------------------------------------------------
// Phone (Brazilian: DDD + 8 or 9 digits)
// ------------------------------------------------------------

export function normalizePhone(raw: string): string {
  let d = (raw ?? '').replace(/\D/g, '')
  // Drop a leading country code when the rest still looks like DDD + number.
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2)
  return d.slice(0, 11)
}

export function isValidPhone(digits: string): boolean {
  return /^\d{10,11}$/.test(digits)
}

/** `5136354333` → `(51) 3635-4333`; `11912345678` → `(11) 91234-5678`, progressively. */
export function formatPhone(raw: string): string {
  const d = normalizePhone(raw)
  if (d.length === 0) return ''
  if (d.length <= 2) return `(${d}`
  const ddd = d.slice(0, 2)
  const rest = d.slice(2)
  if (rest.length <= 4) return `(${ddd}) ${rest}`
  const split = rest.length > 8 ? 5 : 4
  return `(${ddd}) ${rest.slice(0, split)}-${rest.slice(split)}`
}

// ------------------------------------------------------------
// Text
// ------------------------------------------------------------

const LOWER_WORDS = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'em', 'a', 'o', 'as', 'os'])
const KEEP_UPPER = new Set(['LTDA', 'LTDA.', 'ME', 'EPP', 'EIRELI', 'MEI', 'CIA', 'CIA.', 'SS', 'S/A', 'SA', 'S.A', 'S.A.'])

/** The Receita shouts. Title-case, keep connectives lower and company suffixes upper. */
export function titleCasePtBr(value: string): string {
  // "S A" (two tokens) is the Receita's way of writing S.A.; merge before casing.
  const words = (value ?? '').trim().split(/\s+/).filter(Boolean)
  const merged: string[] = []
  for (let i = 0; i < words.length; i++) {
    if (words[i].toUpperCase() === 'S' && words[i + 1]?.toUpperCase() === 'A') {
      merged.push('S.A.')
      i++
    } else {
      merged.push(words[i])
    }
  }
  return merged
    .map((word, i) => {
      const upper = word.toUpperCase()
      if (KEEP_UPPER.has(upper)) return upper === 'S.A' || upper === 'SA' ? 'S.A.' : upper === 'S/A' ? 'S/A' : upper
      const lower = word.toLowerCase()
      if (i > 0 && LOWER_WORDS.has(lower)) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

function stripLeadingZeros(value: string): string {
  const trimmed = value.trim()
  return /^\d+$/.test(trimmed) ? String(Number(trimmed)) : trimmed
}

// ------------------------------------------------------------
// Mappers
// ------------------------------------------------------------

type Json = Record<string, unknown>

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
}

/** https://brasilapi.com.br/api/cnpj/v1/{cnpj} */
export function mapBrasilApiCnpj(json: Json): CompanyLookup {
  const number = stripLeadingZeros(str(json.numero))
  let streetName = str(json.logradouro)
  // The Receita sometimes repeats the number at the end of the street.
  if (number && streetName.endsWith(' ' + number)) streetName = streetName.slice(0, -number.length).trimEnd()
  const street = titleCasePtBr([str(json.descricao_tipo_de_logradouro), streetName].filter(Boolean).join(' '))
  return {
    taxId: str(json.cnpj).replace(/[^0-9A-Za-z]/g, '').toUpperCase(),
    legalName: titleCasePtBr(str(json.razao_social)),
    tradeName: titleCasePtBr(str(json.nome_fantasia)),
    address: {
      cep: normalizeCep(str(json.cep)),
      street,
      number,
      complement: titleCasePtBr(str(json.complemento)),
      neighborhood: titleCasePtBr(str(json.bairro)),
      city: titleCasePtBr(str(json.municipio)),
      state: str(json.uf).toUpperCase(),
    },
    phone: normalizePhone(str(json.ddd_telefone_1) || str(json.ddd_telefone_2)),
    email: str(json.email).toLowerCase(),
    status: str(json.descricao_situacao_cadastral).toUpperCase(),
  }
}

/** https://brasilapi.com.br/api/cep/v2/{cep} */
export function mapBrasilApiCep(json: Json): AddressLookup {
  return {
    cep: normalizeCep(str(json.cep)),
    street: str(json.street),
    neighborhood: str(json.neighborhood),
    city: str(json.city),
    state: str(json.state).toUpperCase(),
  }
}

/** https://viacep.com.br/ws/{cep}/json/ — answers `{ erro: "true" }` for unknown CEPs. */
export function mapViaCep(json: Json): AddressLookup | null {
  if (json.erro === true || json.erro === 'true') return null
  return {
    cep: normalizeCep(str(json.cep)),
    street: str(json.logradouro),
    neighborhood: str(json.bairro),
    city: str(json.localidade),
    state: str(json.uf).toUpperCase(),
  }
}

// ------------------------------------------------------------
// Contact block validation (phone, email, address — all optional)
// ------------------------------------------------------------

export interface ContactInput {
  phone?: string | null
  email?: string | null
  address?: Partial<AccountAddress> | null
}

export interface AccountContact {
  phone: string | null
  email: string | null
  address: AccountAddress | null
}

export type ContactField = 'phone' | 'email' | 'cep' | 'state' | 'street' | 'number' | 'complement' | 'neighborhood' | 'city'
export type ContactErrors = Partial<Record<ContactField, 'invalid' | 'too_long'>>

export type ContactResult = { ok: true; value: AccountContact } | { ok: false; errors: ContactErrors }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_FIELD = 120

export function validateAccountContact(input: ContactInput): ContactResult {
  const errors: ContactErrors = {}

  const phone = normalizePhone(input.phone ?? '')
  if (phone.length > 0 && !isValidPhone(phone)) errors.phone = 'invalid'

  const email = (input.email ?? '').trim().toLowerCase()
  if (email.length > 0 && (!EMAIL_RE.test(email) || email.length > MAX_FIELD)) errors.email = 'invalid'

  let address: AccountAddress | null = null
  const raw = input.address ?? null
  if (raw) {
    const candidate: AccountAddress = {
      cep: normalizeCep(raw.cep ?? ''),
      street: (raw.street ?? '').trim(),
      number: (raw.number ?? '').trim(),
      complement: (raw.complement ?? '').trim(),
      neighborhood: (raw.neighborhood ?? '').trim(),
      city: (raw.city ?? '').trim(),
      state: (raw.state ?? '').trim().toUpperCase(),
    }
    const hasAny = Object.values(candidate).some((v) => v.length > 0)
    if (hasAny) {
      if (candidate.cep.length > 0 && !isValidCep(candidate.cep)) errors.cep = 'invalid'
      if (candidate.state.length > 0 && !(UF_LIST as readonly string[]).includes(candidate.state)) errors.state = 'invalid'
      for (const key of ['street', 'number', 'complement', 'neighborhood', 'city'] as const) {
        if (candidate[key].length > MAX_FIELD) errors[key] = 'too_long'
      }
      address = candidate
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, value: { phone: phone || null, email: email || null, address } }
}
