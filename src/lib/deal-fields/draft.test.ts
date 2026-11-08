import { describe, expect, it } from 'vitest'

import { FORMULA_ERROR_TEXT, validateFieldDraft, type FieldDraft } from './draft'
import type { FormulaErrorCode } from './formula'
import type { DealField } from './types'

const base = { account_id: 'a', expression: null, result_format: null, show_on_card: false, position: 0 } as const
const CUSTO: DealField = { ...base, id: '11111111-1111-4111-8111-111111111111', name: 'Custo', kind: 'currency' }
const MARGEM: DealField = {
  ...base,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Margem',
  kind: 'formula',
  expression: '{valor} - {f:11111111-1111-4111-8111-111111111111}',
  result_format: 'currency',
}

const draft = (over: Partial<FieldDraft> = {}): FieldDraft => ({
  name: 'Frete',
  kind: 'number',
  formulaText: '',
  resultFormat: 'number',
  showOnCard: false,
  ...over,
})

describe('validateFieldDraft', () => {
  it('accepts a number field and trims the name', () => {
    expect(validateFieldDraft(draft({ name: '  Frete  ' }), [CUSTO])).toEqual({
      ok: true,
      input: { name: 'Frete', kind: 'number', expression: null, result_format: null, show_on_card: false },
    })
  })
  it('compiles a formula to the stored text', () => {
    const r = validateFieldDraft(draft({ name: 'Lucro', kind: 'formula', formulaText: '{Valor} − {Custo}', resultFormat: 'currency' }), [CUSTO])
    expect(r).toEqual({
      ok: true,
      input: {
        name: 'Lucro',
        kind: 'formula',
        expression: '{valor} - {f:11111111-1111-4111-8111-111111111111}',
        result_format: 'currency',
        show_on_card: false,
      },
    })
  })
  it('name rules', () => {
    const err = (name: string, fields = [CUSTO]) => {
      const r = validateFieldDraft(draft({ name }), fields)
      return r.ok ? null : r.errors.name
    }
    expect(err('   ')).toBe('name')
    expect(err('x'.repeat(41))).toBe('name-max')
    expect(err('x'.repeat(40))).toBeNull()
    expect(err('A {B}')).toBe('name-chars')
    expect(err('A\u0007B')).toBe('name-chars')
    expect(err('A\tB')).toBe('name-chars')
    expect(err(' valor ')).toBe('name-reserved')
    expect(err('Dias para fechar')).toBe('name-reserved')
    expect(err(' CUSTO ')).toBe('name-dup')
  })
  it('editing keeps the own name and ignores itself for the duplicate check', () => {
    expect(validateFieldDraft(draft({ name: 'Custo', kind: 'currency' }), [CUSTO], CUSTO).ok).toBe(true)
    expect(validateFieldDraft(draft({ name: 'margem', kind: 'number' }), [CUSTO, MARGEM], CUSTO)).toMatchObject({ ok: false, errors: { name: 'name-dup' } })
  })
  it('formula errors carry the code and every code has a message', () => {
    const r = validateFieldDraft(draft({ name: 'F', kind: 'formula', formulaText: '{Valor} +' }), [CUSTO])
    expect(r).toMatchObject({ ok: false, errors: { formula: { code: 'dangling_operator' } } })
    const codes: FormulaErrorCode[] = ['empty', 'too_long', 'too_complex', 'unbalanced_paren', 'empty_parens', 'unexpected_char', 'bad_number', 'unterminated_ref', 'unknown_field', 'formula_reference', 'dangling_operator', 'missing_operator', 'ambiguous_field']
    for (const c of codes) expect(FORMULA_ERROR_TEXT[c]).toBeTruthy()
  })
  it('a formula cannot use another formula, nor a field that does not exist', () => {
    expect(validateFieldDraft(draft({ name: 'F', kind: 'formula', formulaText: '{Margem} + 1' }), [CUSTO, MARGEM])).toMatchObject({ ok: false, errors: { formula: { code: 'formula_reference' } } })
    expect(validateFieldDraft(draft({ name: 'F', kind: 'formula', formulaText: '{Nada}' }), [CUSTO])).toMatchObject({ ok: false, errors: { formula: { code: 'unknown_field' } } })
  })
  it('a formula being edited cannot reference itself', () => {
    expect(validateFieldDraft(draft({ name: 'Margem', kind: 'formula', formulaText: '{Margem} + 1' }), [CUSTO, MARGEM], MARGEM)).toMatchObject({ ok: false, errors: { formula: { code: 'unknown_field' } } })
  })
  it('at most 2 fields on the card, counting the others only', () => {
    const f = (id: string, card: boolean): DealField => ({ ...base, id, name: `C${id}`, kind: 'number', show_on_card: card })
    const full = [f('1', true), f('2', true), f('3', false)]
    expect(validateFieldDraft(draft({ showOnCard: true }), full)).toMatchObject({ ok: false, errors: { card: true } })
    expect(validateFieldDraft(draft({ showOnCard: false }), full).ok).toBe(true)
    // a field already on the card can be saved with the flag on
    expect(validateFieldDraft(draft({ name: 'C1', showOnCard: true }), full, full[0]).ok).toBe(true)
    expect(validateFieldDraft(draft({ name: 'C3', showOnCard: true }), full, full[2])).toMatchObject({ ok: false, errors: { card: true } })
  })
  it('at most 50 fields', () => {
    const fifty = Array.from({ length: 50 }, (_, i): DealField => ({ ...base, id: `id${i}`, name: `N${i}`, kind: 'number' }))
    expect(validateFieldDraft(draft({ name: 'Mais um' }), fifty)).toMatchObject({ ok: false, errors: { limit: true } })
    expect(validateFieldDraft(draft({ name: 'N1' }), fifty, fifty[1]).ok).toBe(true)
  })
})
