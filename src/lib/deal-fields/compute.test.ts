import { describe, expect, it } from 'vitest'

import {
  buildVars,
  cardFields,
  cardNeedsItems,
  computeFieldRows,
  daysToClose,
  fieldIdsForCard,
  formatFieldNumber,
  formulasUsing,
  missingNames,
  parseFieldInput,
  valueToInput,
} from './compute'
import { compileFormula, fieldRef } from './formula'
import type { DealField } from './types'

const NOW = new Date(2026, 10, 7, 15, 0, 0).getTime() // 7 Nov 2026

const base = { account_id: 'a', expression: null, result_format: null, show_on_card: false } as const
const CUSTO: DealField = { ...base, id: '11111111-1111-4111-8111-111111111111', name: 'Custo', kind: 'currency', position: 0 }
const COM: DealField = { ...base, id: '22222222-2222-4222-8222-222222222222', name: '% comissão', kind: 'percent', position: 1 }
const FRETE: DealField = { ...base, id: '33333333-3333-4333-8333-333333333333', name: 'Frete', kind: 'number', position: 2 }

function formula(id: string, name: string, text: string, fmt: DealField['result_format'], over: Partial<DealField> = {}): DealField {
  const c = compileFormula(text, [CUSTO, COM, FRETE])
  if (!c.ok) throw new Error(`compile ${text}: ${c.error.code}`)
  return { ...base, id, name, kind: 'formula', expression: c.stored, result_format: fmt, position: 9, ...over }
}
const MARGEM = formula('44444444-4444-4444-8444-444444444444', 'Margem', '{Valor} − {Custo} − {Frete}', 'currency')
const COMISSAO = formula('55555555-5555-4555-8555-555555555555', 'Comissão', '{Valor} × {% comissão}', 'currency')
const PCT = formula('66666666-6666-4666-8666-666666666666', 'Margem %', '({Valor} − {Custo}) / {Valor}', 'percent')
const FIELDS = [CUSTO, COM, FRETE, MARGEM, COMISSAO, PCT]

const DEAL = { value: 2000, chance: 0.6, itemsSum: 1500, expectedCloseDate: '2026-11-10' }

describe('buildVars', () => {
  it('uses fractions for percent and chance, null for empty, skips formulas', () => {
    const vars = buildVars(FIELDS, { [CUSTO.id]: 500, [COM.id]: 5 }, DEAL, NOW)
    expect(vars).toMatchObject({ valor: 2000, chance: 0.6, itens: 1500, dias: 3 })
    expect(vars[fieldRef(CUSTO.id)]).toBe(500)
    expect(vars[fieldRef(COM.id)]).toBe(0.05)
    expect(vars[fieldRef(FRETE.id)]).toBeNull()
    expect(fieldRef(MARGEM.id) in vars).toBe(false)
  })
  it('days: negative once past, null with no date', () => {
    expect(daysToClose('2026-11-01', NOW)).toBe(-6)
    expect(daysToClose('2026-11-07', NOW)).toBe(0)
    expect(daysToClose(null, NOW)).toBeNull()
    expect(daysToClose('', NOW)).toBeNull()
    expect(buildVars([], {}, { ...DEAL, expectedCloseDate: undefined }, NOW).dias).toBeNull()
  })
})

describe('computeFieldRows', () => {
  it('computes formulas and formats by kind', () => {
    const rows = computeFieldRows(FIELDS, { [CUSTO.id]: 500, [COM.id]: 5, [FRETE.id]: 20 }, DEAL, 'BRL', 'drawer', NOW)
    const by = (f: DealField) => rows.find((r) => r.field.id === f.id)!
    expect(by(CUSTO).text).toMatch(/R\$\s?500,00/)
    expect(by(COM).text).toBe('5%')
    expect(by(FRETE).text).toBe('20')
    expect(by(MARGEM).value).toBe(1480)
    expect(by(MARGEM).text).toMatch(/R\$\s?1\.480,00/)
    expect(by(COMISSAO).value).toBe(100)
    expect(by(PCT).value).toBe(0.75)
    expect(by(PCT).text).toBe('75%')
  })
  it('an empty input leaves the formula empty and names it', () => {
    const rows = computeFieldRows(FIELDS, { [CUSTO.id]: 500 }, DEAL, 'BRL', 'drawer', NOW)
    const margem = rows.find((r) => r.field.id === MARGEM.id)!
    expect(margem.value).toBeNull()
    expect(margem.text).toBeNull()
    expect(missingNames(margem.eval!, FIELDS)).toEqual(['Frete'])
    const com = rows.find((r) => r.field.id === COMISSAO.id)!
    expect(missingNames(com.eval!, FIELDS)).toEqual(['% comissão'])
  })
  it('{Chance}, {Itens} and {Dias para fechar} come from the deal', () => {
    const f = formula('77777777-7777-4777-8777-777777777777', 'X', '{Itens} × {Chance} + {Dias para fechar}', 'number')
    const [row] = computeFieldRows([f], {}, DEAL, 'BRL', 'drawer', NOW)
    expect(row.value).toBe(1500 * 0.6 + 3)
  })
  it('no close date makes {Dias para fechar} missing', () => {
    const f = formula('77777777-7777-4777-8777-777777777778', 'Y', '{Dias para fechar} + 1', 'number')
    const [row] = computeFieldRows([f], {}, { ...DEAL, expectedCloseDate: null }, 'BRL', 'drawer', NOW)
    expect(row.value).toBeNull()
    expect(missingNames(row.eval!, [f])).toEqual(['Dias para fechar'])
  })
  it('division by zero is empty, a deleted field is flagged', () => {
    const div = formula('88888888-8888-4888-8888-888888888888', 'Z', '{Valor} / {Frete}', 'number')
    const [row] = computeFieldRows([FRETE, div], { [FRETE.id]: 0 }, DEAL, 'BRL', 'drawer', NOW).slice(1)
    expect(row.value).toBeNull()
    expect(row.eval?.reason).toBe('div_zero')
    const orphan = computeFieldRows([MARGEM], { [CUSTO.id]: 1 }, DEAL, 'BRL', 'drawer', NOW)[0]
    expect(orphan.eval?.reason).toBe('deleted')
  })
  it('card mode drops the cents', () => {
    const [row] = computeFieldRows([MARGEM], {}, DEAL, 'BRL', 'card', NOW)
    expect(row.text).toBeNull()
    expect(formatFieldNumber(320.4, 'currency', 'BRL', 'card')).toMatch(/R\$\s?320$/)
    expect(formatFieldNumber(320.4, 'currency', 'BRL', 'drawer')).toMatch(/R\$\s?320,40/)
  })
  it('a malformed currency code does not throw', () => {
    expect(() => formatFieldNumber(1, 'currency', 'United States')).not.toThrow()
  })
})

describe('card fields', () => {
  it('takes the marked ones in order, at most two', () => {
    const marked = FIELDS.map((f) => (f.id === CUSTO.id || f.id === MARGEM.id || f.id === FRETE.id ? { ...f, show_on_card: true } : f))
    expect(cardFields(marked).map((f) => f.name)).toEqual(['Custo', 'Frete'])
  })
  it('loads the field a card formula needs, and only then the items', () => {
    const m = { ...MARGEM, show_on_card: true }
    expect(fieldIdsForCard([CUSTO, FRETE, m]).sort()).toEqual([CUSTO.id, FRETE.id].sort())
    expect(cardNeedsItems([CUSTO, FRETE, m])).toBe(false)
    const it = { ...formula('99999999-9999-4999-8999-999999999999', 'I', '{Itens} - {Custo}', 'currency'), show_on_card: true }
    expect(cardNeedsItems([CUSTO, it])).toBe(true)
    expect(fieldIdsForCard([CUSTO, it])).toEqual([CUSTO.id])
    expect(fieldIdsForCard([CUSTO, FRETE])).toEqual([])
  })
})

describe('formulasUsing', () => {
  it('lists the formulas that read a field', () => {
    expect(formulasUsing(FIELDS, CUSTO.id).map((f) => f.name).sort()).toEqual(['Margem', 'Margem %'])
    expect(formulasUsing(FIELDS, COM.id).map((f) => f.name)).toEqual(['Comissão'])
    expect(formulasUsing(FIELDS, MARGEM.id)).toEqual([])
  })
})

describe('parseFieldInput', () => {
  const ok = (s: string) => {
    const r = parseFieldInput(s)
    return r.ok ? r.value : 'bad'
  }
  it('reads pt-BR numbers', () => {
    expect(ok('12,5')).toBe(12.5)
    expect(ok('1.500,50')).toBe(1500.5)
    expect(ok('1.500')).toBe(1500)
    expect(ok('12.5')).toBe(12.5)
    expect(ok('R$ 150')).toBe(150)
    expect(ok('R$150,25')).toBe(150.25)
    expect(ok('5%')).toBe(5)
    expect(ok('-3,2')).toBe(-3.2)
    expect(ok('-R$ 10')).toBe(-10)
    expect(ok('0,0001')).toBe(0.0001)
  })
  it('empty clears', () => {
    expect(ok('')).toBeNull()
    expect(ok('   ')).toBeNull()
  })
  it('refuses nonsense and out-of-range', () => {
    for (const s of ['abc', '1,2,3', '12,12345', '1e5', '--1', '1000000000000', '-1000000000000', 'NaN', 'Infinity', '1..5']) {
      expect(ok(s), s).toBe('bad')
    }
    expect(ok('999999999999')).toBe(999999999999)
    expect(ok('-0')).toBe(0)
  })
  it('round-trips into the input box', () => {
    expect(valueToInput(12.5)).toBe('12,5')
    expect(valueToInput(undefined)).toBe('')
    expect(ok(valueToInput(1234.5678))).toBe(1234.5678)
  })
})
