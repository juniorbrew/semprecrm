import { describe, expect, it } from 'vitest'
import {
  compileFormula,
  evaluate,
  evaluateStored,
  fieldRef,
  isReservedFieldName,
  parseStored,
  sampleVars,
  storedFieldIds,
  stringify,
  storedRefs,
  toDisplay,
  FORMULA_MAX_CHARS,
  type FieldRef,
  type Vars,
} from './formula'

const ID_CUSTO = '11111111-1111-4111-8111-111111111111'
const ID_FRETE = '22222222-2222-4222-8222-222222222222'
const ID_COM = '33333333-3333-4333-8333-333333333333'
const ID_MARGEM = '44444444-4444-4444-8444-444444444444'

const FIELDS: FieldRef[] = [
  { id: ID_CUSTO, name: 'Custo', kind: 'currency' },
  { id: ID_FRETE, name: 'Frete', kind: 'number' },
  { id: ID_COM, name: '% comissão', kind: 'percent' },
  { id: ID_MARGEM, name: 'Margem', kind: 'formula' },
]

const run = (text: string, vars: Vars = {}) => {
  const c = compileFormula(text, FIELDS)
  if (!c.ok) throw new Error(`compile failed: ${c.error.code}`)
  return evaluate(c.ast, vars)
}
const val = (text: string, vars: Vars = {}) => run(text, vars).value
const errCode = (text: string) => {
  const c = compileFormula(text, FIELDS)
  return c.ok ? null : c.error.code
}

describe('arithmetic', () => {
  it('respects precedence and parentheses', () => {
    expect(val('1 + 2 * 3')).toBe(7)
    expect(val('(1 + 2) * 3')).toBe(9)
    expect(val('10 - 4 - 3')).toBe(3)
    expect(val('100 / 10 / 5')).toBe(2)
    expect(val('2 * (3 + (4 - 1)) / 3')).toBe(4)
  })
  it('accepts keyboard and unicode operators', () => {
    expect(val('6 × 7')).toBe(42)
    expect(val('6 * 7')).toBe(42)
    expect(val('84 ÷ 2')).toBe(42)
    expect(val('84 / 2')).toBe(42)
    expect(val('50 − 8')).toBe(42)
    expect(val('50 - 8')).toBe(42)
  })
  it('accepts comma or dot as the decimal separator', () => {
    expect(val('0,05 * 100')).toBe(5)
    expect(val('0.05 * 100')).toBe(5)
    expect(val('1,5 + 1.5')).toBe(3)
  })
  it('refuses a number with two separators (no thousands separator)', () => {
    expect(errCode('1.500,50')).toBe('bad_number')
    expect(errCode('1,5,5')).toBe('bad_number')
    expect(errCode('1.2.3')).toBe('bad_number')
    expect(errCode('5,')).toBe('bad_number')
    expect(errCode(',5')).toBe('bad_number')
    expect(val('1.500')).toBe(1.5) // documented: one separator is always decimal
  })
  it('handles unary minus', () => {
    expect(val('-5 + 2')).toBe(-3)
    expect(val('2 * -3')).toBe(-6)
    expect(val('--4')).toBe(4)
    expect(val('-(1 + 2)')).toBe(-3)
    expect(val('−5')).toBe(-5)
  })
  it('trims float noise', () => {
    expect(val('0,1 + 0,2')).toBe(0.3)
    expect(val('0 * -1')).toBe(0)
    expect(Object.is(val('0 * -1'), -0)).toBe(false)
  })
})

describe('variables', () => {
  it('reads built-ins and fields by name (case and spaces ignored)', () => {
    const vars: Vars = { valor: 1000, chance: 0.6, itens: 700, dias: -3, [fieldRef(ID_CUSTO)]: 250 }
    expect(val('{Valor} − {Custo}', vars)).toBe(750)
    expect(val('{ valor } * {CHANCE}', vars)).toBe(600)
    expect(val('{Itens} + {dias para fechar}', vars)).toBe(697)
  })
  it('percent enters as a fraction: valor x % comissão', () => {
    // the caller passes percent fields as fractions (5 -> 0.05)
    expect(val('{Valor} × {% comissão}', { valor: 2000, [fieldRef(ID_COM)]: 0.05 })).toBe(100)
  })
  it('stores references by id', () => {
    const c = compileFormula('{Valor} − {Custo} × {Frete}', FIELDS)
    expect(c.ok && c.stored).toBe(`{valor} - {f:${ID_CUSTO}} * {f:${ID_FRETE}}`)
    expect(c.ok && c.refs).toEqual(['valor', fieldRef(ID_CUSTO), fieldRef(ID_FRETE)])
  })
  it('an unknown field is an error with the name', () => {
    const c = compileFormula('{Lucro} + 1', FIELDS)
    expect(c).toMatchObject({ ok: false, error: { code: 'unknown_field', detail: 'Lucro' } })
  })
  it('a formula cannot use another formula', () => {
    expect(errCode('{Margem} + 1')).toBe('formula_reference')
  })
  it('empty value gives null and lists what is missing', () => {
    const r = run('{Valor} − {Custo} − {Frete}', { valor: 100, [fieldRef(ID_CUSTO)]: null, [fieldRef(ID_FRETE)]: null })
    expect(r.value).toBeNull()
    expect(r.reason).toBe('missing')
    expect(r.missing).toEqual([fieldRef(ID_CUSTO), fieldRef(ID_FRETE)])
  })
  it('a ref without an entry means the field was deleted', () => {
    const r = run('{Valor} − {Custo}', { valor: 100 })
    expect(r.value).toBeNull()
    expect(r.reason).toBe('deleted')
    expect(r.deleted).toEqual([fieldRef(ID_CUSTO)])
  })
  it('division by zero gives null', () => {
    const r = run('{Valor} / {Frete}', { valor: 100, [fieldRef(ID_FRETE)]: 0 })
    expect(r).toMatchObject({ value: null, reason: 'div_zero' })
    expect(run('1 / (2 - 2)').value).toBeNull()
  })
  it('overflow gives null instead of Infinity', () => {
    expect(run('{Valor} * {Valor}', { valor: 1e300 })).toMatchObject({ value: null, reason: 'overflow' })
  })
  it('non-finite var values read as missing', () => {
    expect(run('{Valor} + 1', { valor: Number.NaN })).toMatchObject({ value: null, reason: 'missing' })
    expect(run('{Valor} + 1', { valor: Infinity })).toMatchObject({ value: null, reason: 'missing' })
  })
  it('prototype names are plain unknown fields, never read off Object', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(errCode(`{${name}} + 1`)).toBe('unknown_field')
    }
    // and a hostile stored ref does not resolve through the prototype either
    expect(parseStored('{constructor}').ok).toBe(false)
    const ast = parseStored('{valor}')
    if (!ast.ok) throw new Error('parse')
    expect(evaluate(ast.ast, Object.create({ valor: 5 }) as Vars)).toMatchObject({ value: null, reason: 'deleted' })
  })
})

describe('validation errors', () => {
  it('empty', () => {
    expect(errCode('')).toBe('empty')
    expect(errCode('   ')).toBe('empty')
  })
  it('unbalanced parentheses', () => {
    expect(errCode('(1 + 2')).toBe('unbalanced_paren')
    expect(errCode('1 + 2)')).toBe('unbalanced_paren')
    expect(errCode(')(')).toBe('unbalanced_paren')
    expect(errCode('((1)')).toBe('unbalanced_paren')
  })
  it('empty parentheses', () => {
    expect(errCode('()')).toBe('empty_parens')
    expect(errCode('1 + ()')).toBe('empty_parens')
  })
  it('dangling operator', () => {
    expect(errCode('1 +')).toBe('dangling_operator')
    expect(errCode('* 2')).toBe('dangling_operator')
    expect(errCode('1 + * 2')).toBe('dangling_operator')
    expect(errCode('(1 +)')).toBe('dangling_operator')
    expect(errCode('-')).toBe('dangling_operator')
  })
  it('two values with no operator', () => {
    expect(errCode('1 2')).toBe('missing_operator')
    expect(errCode('{Valor} {Frete}')).toBe('missing_operator')
    expect(errCode('(1)(2)')).toBe('missing_operator')
    expect(errCode('2 {Valor}')).toBe('missing_operator')
  })
  it('stray characters and unterminated references', () => {
    expect(errCode('1 + a')).toBe('unexpected_char')
    expect(errCode('1 % 2')).toBe('unexpected_char')
    expect(errCode('1 ^ 2')).toBe('unexpected_char')
    expect(errCode('Valor + 1')).toBe('unexpected_char')
    expect(errCode('{Valor + 1')).toBe('unterminated_ref')
    expect(errCode('{Va{lor}')).toBe('unterminated_ref')
    expect(errCode('{}')).toBe('unknown_field')
    expect(errCode('5abc')).toBe('unexpected_char')
  })
  it('reports the position', () => {
    const c = compileFormula('1 + a', FIELDS)
    expect(c).toMatchObject({ ok: false, error: { code: 'unexpected_char', pos: 4, detail: 'a' } })
  })
})

describe('hostile input is refused without hanging', () => {
  const t0 = () => Date.now()
  it('too long', () => {
    expect(errCode('1+'.repeat(FORMULA_MAX_CHARS))).toBe('too_long')
    expect(errCode('1'.repeat(FORMULA_MAX_CHARS + 1))).toBe('too_long')
  })
  it('exactly the limit still parses', () => {
    expect(errCode('1'.repeat(15) + '+'.repeat(0))).toBeNull()
    const ok = Array(30).fill('1234567').join('+') // < 300 chars
    expect(ok.length).toBeLessThanOrEqual(FORMULA_MAX_CHARS)
    expect(errCode(ok)).toBeNull()
  })
  it('1000 parentheses', () => {
    const s = Date.now()
    expect(errCode('('.repeat(1000) + '1' + ')'.repeat(1000))).toBe('too_long')
    expect(Date.now() - s).toBeLessThan(500)
  })
  it('deep nesting inside the length limit', () => {
    expect(errCode('('.repeat(40) + '1' + ')'.repeat(40))).toBe('too_complex')
    expect(errCode('('.repeat(30) + '1' + ')'.repeat(30))).toBeNull()
    expect(errCode('-'.repeat(60) + '1')).toBe('too_complex')
    expect(errCode('-'.repeat(20) + '1')).toBeNull()
  })
  it('too many tokens', () => {
    expect(errCode(Array(101).fill('1').join('+'))).toBe('too_complex')
  })
  it('malicious text', () => {
    const t = t0()
    for (const bad of [
      'constructor',
      '__proto__',
      'constructor.constructor("return 1")()',
      'alert(1)',
      '1; process.exit()',
      'this',
      '"x"',
      "'; DROP TABLE deals; --",
      '${1+1}',
      '`1`',
      '{__proto__}',
      '{constructor}',
      '\u0000',
      '1e308 * 1e308',
      '0x10',
      'Infinity',
      'NaN',
    ]) {
      expect(errCode(bad), bad).not.toBeNull()
    }
    expect(Date.now() - t).toBeLessThan(500)
  })
  it('non-string input does not throw', () => {
    expect(compileFormula(undefined as unknown as string, FIELDS).ok).toBe(false)
    expect(parseStored(null as unknown as string).ok).toBe(false)
  })
  it('stored text that is not ours is refused', () => {
    expect(parseStored('{f:not-a-uuid}').ok).toBe(false)
    expect(parseStored('{Valor}').ok).toBe(false) // stored uses ids, not names
    expect(parseStored('').ok).toBe(false)
  })
})

describe('stored <-> display', () => {
  it('round-trips through renaming', () => {
    const c = compileFormula('{Valor} − {Custo} × 0,5', FIELDS)
    if (!c.ok) throw new Error('compile')
    const renamed = FIELDS.map((f) => (f.id === ID_CUSTO ? { ...f, name: 'Custo base' } : f))
    expect(toDisplay(c.stored, renamed)).toBe('{Valor} − {Custo base} × 0,5')
    // and it compiles again to the same stored text
    const again = compileFormula(toDisplay(c.stored, renamed), renamed)
    expect(again.ok && again.stored).toBe(c.stored)
  })
  it('a deleted field shows as "campo excluído" and no longer compiles', () => {
    const c = compileFormula('{Valor} − {Custo}', FIELDS)
    if (!c.ok) throw new Error('compile')
    const text = toDisplay(c.stored, FIELDS.filter((f) => f.id !== ID_CUSTO))
    expect(text).toBe('{Valor} − {campo excluído}')
    expect(compileFormula(text, FIELDS.filter((f) => f.id !== ID_CUSTO))).toMatchObject({
      ok: false,
      error: { code: 'unknown_field' },
    })
  })
  it('keeps meaning with parentheses and unary minus', () => {
    const src = '(1 + 2) * -(3 - 4) / (5 − (6 − 7))'
    const c = compileFormula(src, FIELDS)
    if (!c.ok) throw new Error('compile')
    const back = compileFormula(toDisplay(c.stored, FIELDS), FIELDS)
    if (!back.ok) throw new Error('recompile')
    expect(evaluate(back.ast, {}).value).toBe(evaluate(c.ast, {}).value)
    expect(val(src)).toBe((3 * 1) / 6)
  })
  it('stringify keeps non-associative grouping', () => {
    for (const src of ['1 - (2 - 3)', '8 / (4 / 2)', '2 * (3 + 4)', '(1 + 2) * 3', '1 - 2 - 3']) {
      const c = compileFormula(src, FIELDS)
      if (!c.ok) throw new Error(src)
      const re = parseStored(c.stored)
      if (!re.ok) throw new Error(c.stored)
      expect(evaluate(re.ast, {}).value, src).toBe(val(src))
      expect(stringify(re.ast)).toBe(c.stored)
    }
  })
  it('tiny numbers are written without an exponent', () => {
    const c = compileFormula('0,0000001 + 1', FIELDS)
    expect(c.ok && c.stored).toBe('0.0000001 + 1')
  })
  it('lists the field ids a formula uses', () => {
    const c = compileFormula('{Custo} + {Frete} * {Custo} + {Valor}', FIELDS)
    if (!c.ok) throw new Error('compile')
    expect(storedFieldIds(c.stored).sort()).toEqual([ID_CUSTO, ID_FRETE].sort())
    expect(storedFieldIds('junk')).toEqual([])
  })
})

describe('evaluateStored and sampleVars', () => {
  it('evaluates stored text', () => {
    const c = compileFormula('{Valor} − {Custo}', FIELDS)
    if (!c.ok) throw new Error('compile')
    expect(evaluateStored(c.stored, { valor: 10, [fieldRef(ID_CUSTO)]: 4 }).value).toBe(6)
    expect(evaluateStored('garbage', {})).toMatchObject({ value: null, reason: 'deleted' })
  })
  it('sample values give a preview for every field kind', () => {
    const vars = sampleVars(FIELDS)
    expect(vars.valor).toBe(1000)
    expect(vars[fieldRef(ID_CUSTO)]).toBe(100)
    expect(vars[fieldRef(ID_FRETE)]).toBe(10)
    expect(vars[fieldRef(ID_COM)]).toBe(0.1)
    expect(vars[fieldRef(ID_MARGEM)]).toBeUndefined()
    expect(val('{Valor} × {% comissão} − {Custo}', vars)).toBe(0)
  })
  it('reserved names', () => {
    expect(isReservedFieldName(' VALOR ')).toBe(true)
    expect(isReservedFieldName('Dias para fechar')).toBe(true)
    expect(isReservedFieldName('Custo')).toBe(false)
  })
})

describe('ambiguous names and cached parsing', () => {
  it('two fields with the same name are refused, never last-wins', () => {
    const twins: FieldRef[] = [
      { id: ID_CUSTO, name: 'Custo', kind: 'currency' },
      { id: ID_FRETE, name: 'custo', kind: 'number' },
    ]
    expect(compileFormula('{Custo} + 1', twins)).toMatchObject({ ok: false, error: { code: 'ambiguous_field', detail: 'Custo' } })
    // the other names still work
    expect(compileFormula('{Valor} + 1', twins).ok).toBe(true)
  })
  it('lists every ref and evaluates the same text repeatedly with the same result', () => {
    const c = compileFormula('{Valor} + {Dias para fechar} - {Custo}', FIELDS)
    if (!c.ok) throw new Error('compile')
    expect(storedRefs(c.stored)).toEqual(['valor', 'dias', fieldRef(ID_CUSTO)])
    expect(storedRefs('junk')).toEqual([])
    for (let i = 0; i < 3; i++) {
      expect(evaluateStored(c.stored, { valor: 10, dias: 2, [fieldRef(ID_CUSTO)]: 4 }).value).toBe(8)
    }
  })
})
