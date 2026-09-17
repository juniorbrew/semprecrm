import { describe, expect, it } from 'vitest'

import {
  formatTaxId,
  isValidCnpj,
  isValidCpf,
  normalizeTaxId,
  validateAccountDocument,
  validateAccountRegistration,
} from './documents'

describe('normalizeTaxId', () => {
  it('strips mask characters and upper-cases letters', () => {
    expect(normalizeTaxId('529.982.247-25')).toBe('52998224725')
    expect(normalizeTaxId(' 12.abc.345/01de-35 ')).toBe('12ABC34501DE35')
  })
})

describe('isValidCpf', () => {
  it('accepts a CPF with correct check digits', () => {
    expect(isValidCpf('52998224725')).toBe(true)
  })

  it('rejects wrong check digits, wrong length and repeated digits', () => {
    expect(isValidCpf('52998224726')).toBe(false)
    expect(isValidCpf('5299822472')).toBe(false)
    expect(isValidCpf('11111111111')).toBe(false)
    expect(isValidCpf('')).toBe(false)
  })
})

describe('isValidCnpj', () => {
  it('accepts a numeric CNPJ with correct check digits', () => {
    expect(isValidCnpj('11222333000181')).toBe(true)
  })

  it('accepts the alphanumeric CNPJ format (Receita Federal, 2026)', () => {
    // Official example from the Receita Federal spec: 12.ABC.345/01DE-35
    expect(isValidCnpj('12ABC34501DE35')).toBe(true)
  })

  it('rejects wrong check digits, wrong length, repeated digits and letters in the check digits', () => {
    expect(isValidCnpj('11222333000182')).toBe(false)
    expect(isValidCnpj('1122233300018')).toBe(false)
    expect(isValidCnpj('00000000000000')).toBe(false)
    expect(isValidCnpj('12ABC34501DE3A')).toBe(false)
  })
})

describe('formatTaxId', () => {
  it('masks a CPF progressively while typing', () => {
    expect(formatTaxId('pf', '529')).toBe('529')
    expect(formatTaxId('pf', '5299822')).toBe('529.982.2')
    expect(formatTaxId('pf', '52998224725')).toBe('529.982.247-25')
  })

  it('masks a CNPJ progressively and caps at 14 characters', () => {
    expect(formatTaxId('pj', '11222')).toBe('11.222')
    expect(formatTaxId('pj', '11222333000181')).toBe('11.222.333/0001-81')
    expect(formatTaxId('pj', '12ABC34501DE35')).toBe('12.ABC.345/01DE-35')
    expect(formatTaxId('pj', '112223330001819999')).toBe('11.222.333/0001-81')
  })

  it('drops letters from a CPF', () => {
    expect(formatTaxId('pf', '52A99')).toBe('529.9')
  })
})

describe('validateAccountRegistration', () => {
  it('returns normalised values for a valid pessoa física', () => {
    const r = validateAccountRegistration({
      personType: 'pf',
      taxId: '529.982.247-25',
      fullName: '  Ana Souza ',
    })
    expect(r).toEqual({
      ok: true,
      value: { personType: 'pf', taxId: '52998224725', legalName: null, accountName: 'Ana Souza', fullName: 'Ana Souza' },
    })
  })

  it('uses the trade name, falling back to the legal name, as the account name for pessoa jurídica', () => {
    const base = { personType: 'pj' as const, taxId: '11.222.333/0001-81', legalName: 'Padaria Sol Ltda', fullName: 'Ana Souza' }
    expect(validateAccountRegistration({ ...base, tradeName: 'Padaria do Sol' })).toEqual({
      ok: true,
      value: { personType: 'pj', taxId: '11222333000181', legalName: 'Padaria Sol Ltda', accountName: 'Padaria do Sol', fullName: 'Ana Souza' },
    })
    expect(validateAccountRegistration({ ...base, tradeName: '  ' })).toMatchObject({
      ok: true,
      value: { accountName: 'Padaria Sol Ltda' },
    })
  })

  it('reports field errors instead of throwing', () => {
    expect(validateAccountRegistration({ personType: 'pf', taxId: '529.982.247-26', fullName: '' })).toEqual({
      ok: false,
      errors: { taxId: 'invalid', fullName: 'required' },
    })
    expect(validateAccountRegistration({ personType: 'pj', taxId: '', legalName: '', fullName: 'Ana' })).toEqual({
      ok: false,
      errors: { taxId: 'required', legalName: 'required' },
    })
    expect(validateAccountRegistration({ personType: 'pj', taxId: '52998224725', legalName: 'X', fullName: 'Ana' })).toEqual({
      ok: false,
      errors: { taxId: 'invalid' },
    })
  })

  it('rejects an unknown person type and over-long names', () => {
    expect(validateAccountRegistration({ personType: 'xx' as never, taxId: '52998224725', fullName: 'Ana' })).toEqual({
      ok: false,
      errors: { personType: 'invalid' },
    })
    expect(
      validateAccountRegistration({ personType: 'pf', taxId: '52998224725', fullName: 'a'.repeat(81) }),
    ).toEqual({ ok: false, errors: { fullName: 'too_long' } })
  })
})

describe('validateAccountDocument', () => {
  it('validates type + document + legal name without a responsible person', () => {
    expect(validateAccountDocument({ personType: 'pj', taxId: '11.222.333/0001-81', legalName: ' Padaria Sol Ltda ' })).toEqual({
      ok: true,
      value: { personType: 'pj', taxId: '11222333000181', legalName: 'Padaria Sol Ltda' },
    })
    expect(validateAccountDocument({ personType: 'pf', taxId: '529.982.247-25', legalName: 'ignored for pf' })).toEqual({
      ok: true,
      value: { personType: 'pf', taxId: '52998224725', legalName: null },
    })
    expect(validateAccountDocument({ personType: 'pj', taxId: '11222333000182', legalName: '' })).toEqual({
      ok: false,
      errors: { taxId: 'invalid', legalName: 'required' },
    })
  })
})
