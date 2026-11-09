// Formula engine for deal fields (spec 2026-11-07). Pure: no React, no eval, no Function.
//
// Two texts exist for one formula:
//   - DISPLAY text, what the admin types and sees: names in braces, like `{Valor} − {Custo} × 0,05`
//     (`{Valor}`, `{Chance}`, `{Itens}`, `{Dias para fechar}`, `{<field name>}`). There is no `%` sign:
//     type 0,05 for 5%.
//   - STORED text, what goes in deal_fields.expression: references by stable id
//     (`{valor}`, `{chance}`, `{itens}`, `{dias}`, `{f:<uuid>}`), ASCII operators, dot decimals.
// Renaming a field or switching language never breaks a formula, and a deleted field shows
// up as "campo excluído" (see toDisplay) instead of silently changing meaning.
//
// Numbers: ONE decimal separator, comma or dot ("0,05", "1.5"). A number with both
// ("1.500,50") is refused: there is no thousands separator. So "1.500" is 1.5, not 1500.
// Percent fields and {chance} enter the math as fractions (5% = 0.05); the caller builds vars.
//
// Nothing here throws on user input: every entry point returns an error object. Length (300),
// token count and nesting depth are bounded, so hostile text is refused quickly.

export const FORMULA_MAX_CHARS = 300
export const FORMULA_MAX_TOKENS = 100
export const FORMULA_MAX_DEPTH = 32
const NAME_MAX = 60

export type FormulaErrorCode =
  | 'empty'
  | 'too_long'
  | 'too_complex'
  | 'unbalanced_paren'
  | 'empty_parens'
  | 'unexpected_char'
  | 'bad_number'
  | 'unterminated_ref'
  | 'unknown_field'
  | 'ambiguous_field'
  | 'formula_reference'
  | 'dangling_operator'
  | 'missing_operator'

export interface FormulaError {
  code: FormulaErrorCode
  /** Index in the text that was parsed (0-based), when there is one. */
  pos: number
  /** The offending name or character, for the message. */
  detail?: string
}

export type Ast =
  | { t: 'num'; v: number }
  | { t: 'var'; ref: string }
  | { t: 'neg'; a: Ast }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; a: Ast; b: Ast }

export type ParseResult =
  | { ok: true; ast: Ast; refs: string[] }
  | { ok: false; error: FormulaError }

/** Built-in numbers of a deal. Names are fixed pt-BR (they are part of the stored contract). */
export const BUILTIN_VARS = [
  { ref: 'valor', name: 'Valor' },
  { ref: 'chance', name: 'Chance' },
  { ref: 'itens', name: 'Itens' },
  { ref: 'dias', name: 'Dias para fechar' },
] as const

export const FIELD_REF_PREFIX = 'f:'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface FieldRef {
  id: string
  name: string
  kind: 'number' | 'currency' | 'percent' | 'formula'
}

// ---- tokenizer ---------------------------------------------------------------------------

type Tok =
  | { k: 'num'; v: number; pos: number }
  | { k: 'op'; v: '+' | '-' | '*' | '/'; pos: number }
  | { k: 'lp' | 'rp'; pos: number }
  | { k: 'var'; name: string; pos: number }

type Fail = { error: FormulaError }

const fail = (code: FormulaErrorCode, pos: number, detail?: string): Fail => ({
  error: { code, pos, detail },
})

const OPS: Record<string, '+' | '-' | '*' | '/'> = {
  '+': '+',
  '-': '-',
  '−': '-', // U+2212
  '–': '-', // en dash, what some keyboards autocorrect to
  '*': '*',
  '×': '*',
  '/': '/',
  '÷': '/',
}

function tokenize(src: string): Tok[] | Fail {
  const toks: Tok[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (toks.length >= FORMULA_MAX_TOKENS) return fail('too_complex', i)
    if (ch in OPS) {
      toks.push({ k: 'op', v: OPS[ch], pos: i })
      i++
    } else if (ch === '(') {
      toks.push({ k: 'lp', pos: i })
      i++
    } else if (ch === ')') {
      toks.push({ k: 'rp', pos: i })
      i++
    } else if (ch === '{') {
      const end = src.indexOf('}', i + 1)
      const inner = end === -1 ? src.slice(i + 1) : src.slice(i + 1, end)
      if (end === -1 || inner.includes('{')) return fail('unterminated_ref', i)
      const name = inner.trim()
      if (!name || name.length > NAME_MAX) return fail('unknown_field', i, name.slice(0, NAME_MAX))
      toks.push({ k: 'var', name, pos: i })
      i = end + 1
    } else if ((ch >= '0' && ch <= '9') || ch === '.' || ch === ',') {
      let j = i
      while (j < src.length && /[0-9.,]/.test(src[j])) j++
      const raw = src.slice(i, j)
      if (!/^\d{1,15}([.,]\d{1,10})?$/.test(raw)) return fail('bad_number', i, raw.slice(0, 20))
      toks.push({ k: 'num', v: Number(raw.replace(',', '.')), pos: i })
      i = j
    } else {
      return fail('unexpected_char', i, ch)
    }
  }
  return toks
}

// ---- parser (recursive descent) ---------------------------------------------------------------

/** Maps the text inside `{}` to a canonical ref, or null when unknown. */
export type Resolver = (name: string, pos: number) => string | FormulaError

function parseTokens(toks: Tok[], resolve: Resolver): ParseResult {
  let p = 0
  const refs = new Set<string>()
  let err: FormulaError | null = null
  const bad = (e: FormulaError): null => {
    if (!err) err = e
    return null
  }

  function primary(depth: number): Ast | null {
    const t = toks[p]
    if (!t) return bad({ code: 'dangling_operator', pos: toks.length ? toks[toks.length - 1].pos : 0 })
    if (t.k === 'num') {
      p++
      return { t: 'num', v: t.v }
    }
    if (t.k === 'var') {
      const r = resolve(t.name, t.pos)
      if (typeof r !== 'string') return bad(r)
      p++
      refs.add(r)
      return { t: 'var', ref: r }
    }
    if (t.k === 'lp') {
      if (depth >= FORMULA_MAX_DEPTH) return bad({ code: 'too_complex', pos: t.pos })
      p++
      if (toks[p]?.k === 'rp') return bad({ code: 'empty_parens', pos: t.pos })
      const inner = expr(depth + 1)
      if (!inner) return null
      if (toks[p]?.k !== 'rp') return bad({ code: 'unbalanced_paren', pos: t.pos })
      p++
      return inner
    }
    if (t.k === 'rp') {
      return bad({ code: toks[p - 1]?.k === 'op' ? 'dangling_operator' : 'unbalanced_paren', pos: t.pos })
    }
    return bad({ code: 'dangling_operator', pos: t.pos })
  }

  function unary(depth: number): Ast | null {
    const t = toks[p]
    if (t && t.k === 'op' && t.v === '-') {
      if (depth >= FORMULA_MAX_DEPTH) return bad({ code: 'too_complex', pos: t.pos })
      p++
      const a = unary(depth + 1)
      return a && { t: 'neg', a }
    }
    return primary(depth)
  }

  function term(depth: number): Ast | null {
    let a = unary(depth)
    while (a) {
      const t = toks[p]
      if (!t || t.k !== 'op' || (t.v !== '*' && t.v !== '/')) break
      p++
      const b = unary(depth)
      if (!b) return null
      a = { t: 'bin', op: t.v, a, b }
    }
    return a
  }

  function expr(depth: number): Ast | null {
    let a = term(depth)
    while (a) {
      const t = toks[p]
      if (!t || t.k !== 'op' || (t.v !== '+' && t.v !== '-')) break
      p++
      const b = term(depth)
      if (!b) return null
      a = { t: 'bin', op: t.v, a, b }
    }
    return a
  }

  const ast = expr(0)
  if (!ast) return { ok: false, error: err ?? { code: 'empty', pos: 0 } }
  if (p < toks.length) {
    const t = toks[p]
    return {
      ok: false,
      error: { code: t.k === 'rp' ? 'unbalanced_paren' : 'missing_operator', pos: t.pos },
    }
  }
  return { ok: true, ast, refs: [...refs] }
}

function parseWith(src: string, resolve: Resolver, maxChars: number): ParseResult {
  if (typeof src !== 'string' || !src.trim()) return { ok: false, error: { code: 'empty', pos: 0 } }
  if (src.length > maxChars) return { ok: false, error: { code: 'too_long', pos: maxChars } }
  const toks = tokenize(src)
  if (!Array.isArray(toks)) return { ok: false, error: toks.error }
  return parseTokens(toks, resolve)
}

// ---- stored text -----------------------------------------------------------------------------

/** Stored refs may be longer than names (uuids), so the DB column allows more than 300. */
export const STORED_MAX_CHARS = 4000

const BUILTIN_REFS: Set<string> = new Set(BUILTIN_VARS.map((b) => b.ref))

export function isFieldRef(ref: string): boolean {
  return ref.startsWith(FIELD_REF_PREFIX) && UUID_RE.test(ref.slice(FIELD_REF_PREFIX.length))
}

export const fieldRef = (id: string): string => FIELD_REF_PREFIX + id

const storedResolver: Resolver = (name, pos) =>
  BUILTIN_REFS.has(name) || isFieldRef(name) ? name : { code: 'unknown_field', pos, detail: name }

/** Parse what is in deal_fields.expression. */
export function parseStored(stored: string): ParseResult {
  return parseWith(stored, storedResolver, STORED_MAX_CHARS)
}

// The board evaluates the same few expressions for every card: parse each text once.
const parsed = new Map<string, ParseResult>()
const PARSED_MAX = 500

function parseCached(stored: string): ParseResult {
  const hit = parsed.get(stored)
  if (hit) return hit
  const result = parseStored(stored)
  if (parsed.size >= PARSED_MAX) parsed.clear()
  parsed.set(stored, result)
  return result
}

/** Every ref (`valor`, `dias`, `f:<uuid>`) a stored formula reads; empty when it does not parse. */
export function storedRefs(stored: string): string[] {
  const r = parseCached(stored)
  return r.ok ? r.refs : []
}

/** Plain decimal text (String(1e-10) would give an exponent the tokenizer refuses). */
const trimNum = (n: number): string => n.toFixed(10).replace(/\.?0+$/, '')

const PREC = { '+': 1, '-': 1, '*': 2, '/': 2 } as const

/** Canonical stored text of an AST: ASCII operators, dot decimals, minimal safe parentheses. */
export function stringify(ast: Ast): string {
  return write(ast, (ref) => `{${ref}}`, trimNum, ' ')
}

function write(
  ast: Ast,
  v: (ref: string) => string,
  num: (n: number) => string,
  sp: string,
  ops: Record<'+' | '-' | '*' | '/', string> = { '+': '+', '-': '-', '*': '*', '/': '/' },
  neg = '-',
): string {
  const rec = (a: Ast) => write(a, v, num, sp, ops, neg)
  switch (ast.t) {
    case 'num':
      return num(ast.v)
    case 'var':
      return v(ast.ref)
    case 'neg':
      return ast.a.t === 'num' || ast.a.t === 'var' ? `${neg}${rec(ast.a)}` : `${neg}(${rec(ast.a)})`
    case 'bin': {
      const pr = PREC[ast.op]
      const left =
        ast.a.t === 'bin' && PREC[ast.a.op] < pr ? `(${rec(ast.a)})` : rec(ast.a)
      const right =
        ast.b.t === 'bin' && PREC[ast.b.op] <= pr ? `(${rec(ast.b)})` : rec(ast.b)
      return `${left}${sp}${ops[ast.op]}${sp}${right}`
    }
  }
}

// ---- display text (what the admin edits) -------------------------------------------------------------

export const DELETED_FIELD_LABEL = 'campo excluído'

const norm = (s: string) => s.trim().toLowerCase()

const BUILTIN_BY_NAME = new Map(BUILTIN_VARS.map((b) => [norm(b.name), b.ref]))

/** True when `name` collides with a built-in variable (the DB refuses these names too). */
export function isReservedFieldName(name: string): boolean {
  return BUILTIN_BY_NAME.has(norm(name))
}

export type CompileResult =
  | { ok: true; stored: string; ast: Ast; refs: string[] }
  | { ok: false; error: FormulaError }

/**
 * What the admin typed -> stored text. Names are matched ignoring case and surrounding
 * spaces. `selfId` (when editing an existing field) is accepted by name only like any
 * other field; a formula referencing another formula is refused, and so is itself.
 */
export function compileFormula(display: string, fields: FieldRef[]): CompileResult {
  const byName = new Map<string, FieldRef>()
  // Two fields that read the same name must not resolve by luck (last one wins): refuse the name.
  const ambiguous = new Set<string>()
  for (const f of fields) {
    const key = norm(f.name)
    if (byName.has(key)) ambiguous.add(key)
    byName.set(key, f)
  }
  const resolve: Resolver = (name, pos) => {
    const b = BUILTIN_BY_NAME.get(norm(name))
    if (b) return b
    if (ambiguous.has(norm(name))) return { code: 'ambiguous_field', pos, detail: name }
    const f = byName.get(norm(name))
    if (!f) return { code: 'unknown_field', pos, detail: name }
    if (f.kind === 'formula') return { code: 'formula_reference', pos, detail: f.name }
    return fieldRef(f.id)
  }
  const parsed = parseWith(display, resolve, FORMULA_MAX_CHARS)
  if (!parsed.ok) return parsed
  const stored = stringify(parsed.ast)
  if (stored.length > STORED_MAX_CHARS) return { ok: false, error: { code: 'too_long', pos: 0 } }
  return { ok: true, stored, ast: parsed.ast, refs: parsed.refs }
}

const fmtNumber = (n: number) => trimNum(n).replace('.', ',')

/**
 * Stored text -> text for the editor, with the CURRENT names. A reference to a field that no
 * longer exists renders as `{campo excluído}`; compiling that text again reports it as unknown.
 */
export function toDisplay(stored: string, fields: Pick<FieldRef, 'id' | 'name'>[]): string {
  const parsed = parseStored(stored)
  if (!parsed.ok) return stored
  const names = new Map(fields.map((f) => [fieldRef(f.id), f.name]))
  const builtin = new Map(BUILTIN_VARS.map((b) => [b.ref as string, b.name]))
  return write(
    parsed.ast,
    (ref) => `{${builtin.get(ref) ?? names.get(ref) ?? DELETED_FIELD_LABEL}}`,
    fmtNumber,
    ' ',
    { '+': '+', '-': '−', '*': '×', '/': '÷' },
    '−',
  )
}

/** Field ids a stored formula points to (empty when it does not parse). */
export function storedFieldIds(stored: string): string[] {
  return storedRefs(stored)
    .filter(isFieldRef)
    .map((r) => r.slice(FIELD_REF_PREFIX.length))
}

// ---- evaluation ----------------------------------------------------------------------------------------

/** ref -> number, null when the deal has no value for it, undefined when the ref does not exist. */
export type Vars = Record<string, number | null | undefined>

export interface EvalResult {
  /** null when something is missing or the math is undefined. */
  value: number | null
  /** Refs whose value is empty. */
  missing: string[]
  /** Refs that do not exist any more (field deleted). */
  deleted: string[]
  /** Why value is null, when it is. */
  reason?: 'missing' | 'deleted' | 'div_zero' | 'overflow'
}

function walk(ast: Ast, vars: Vars, missing: Set<string>, deleted: Set<string>): void {
  switch (ast.t) {
    case 'var': {
      const v = Object.prototype.hasOwnProperty.call(vars, ast.ref) ? vars[ast.ref] : undefined
      if (v === undefined) deleted.add(ast.ref)
      else if (v === null || !Number.isFinite(v)) missing.add(ast.ref)
      return
    }
    case 'neg':
      return walk(ast.a, vars, missing, deleted)
    case 'bin':
      walk(ast.a, vars, missing, deleted)
      return walk(ast.b, vars, missing, deleted)
    default:
  }
}

class DivZero extends Error {}

function calc(ast: Ast, vars: Vars): number {
  switch (ast.t) {
    case 'num':
      return ast.v
    case 'var':
      return vars[ast.ref] as number
    case 'neg':
      return -calc(ast.a, vars)
    case 'bin': {
      const a = calc(ast.a, vars)
      const b = calc(ast.b, vars)
      switch (ast.op) {
        case '+':
          return a + b
        case '-':
          return a - b
        case '*':
          return a * b
        case '/':
          if (b === 0) throw new DivZero()
          return a / b
      }
    }
  }
}

/** Evaluate an AST. Never throws. Float noise is trimmed to 12 significant digits. */
export function evaluate(ast: Ast, vars: Vars): EvalResult {
  const missing = new Set<string>()
  const deleted = new Set<string>()
  walk(ast, vars, missing, deleted)
  const miss = [...missing]
  const del = [...deleted]
  if (del.length) return { value: null, missing: miss, deleted: del, reason: 'deleted' }
  if (miss.length) return { value: null, missing: miss, deleted: del, reason: 'missing' }
  try {
    const raw = calc(ast, vars)
    if (!Number.isFinite(raw)) return { value: null, missing: miss, deleted: del, reason: 'overflow' }
    const value = Number(raw.toPrecision(12))
    return { value: Object.is(value, -0) ? 0 : value, missing: miss, deleted: del }
  } catch {
    return { value: null, missing: miss, deleted: del, reason: 'div_zero' }
  }
}

/** Parse + evaluate stored text in one go (card and drawer). Parse failures read as a deleted field. */
export function evaluateStored(stored: string, vars: Vars): EvalResult {
  const result = parseCached(stored)
  if (!result.ok) return { value: null, missing: [], deleted: [], reason: 'deleted' }
  return evaluate(result.ast, vars)
}

/** Sample numbers for the editor preview: 1000 value, 50% chance, 800 items, 10 days; fields by kind. */
export function sampleVars(fields: Pick<FieldRef, 'id' | 'kind'>[]): Vars {
  const vars: Vars = { valor: 1000, chance: 0.5, itens: 800, dias: 10 }
  for (const f of fields) {
    if (f.kind === 'currency') vars[fieldRef(f.id)] = 100
    else if (f.kind === 'percent') vars[fieldRef(f.id)] = 0.1
    else if (f.kind === 'number') vars[fieldRef(f.id)] = 10
  }
  return vars
}
