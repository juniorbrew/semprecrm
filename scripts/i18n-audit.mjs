#!/usr/bin/env node
// ============================================================
// i18n audit — finds user-facing English that leaks into pt-BR.
//
// The app translates at runtime: `t('English key')` and a DOM walker
// both look the English text up in EN_TO_PT (src/lib/i18n.ts +
// src/lib/i18n-extra.ts + src/lib/i18n-dict/*). Anything not in the
// dictionary renders in English for a pt-BR user. This script parses
// every file under src/ with the TypeScript compiler and lists every
// literal that (a) looks like English UI copy and (b) has no entry.
//
//   node scripts/i18n-audit.mjs            # summary + per-file list
//   node scripts/i18n-audit.mjs --json     # machine-readable
//   node scripts/i18n-audit.mjs --dir src/components/inbox
//
// Exit code 1 when anything is missing, so it can gate CI.
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const args = process.argv.slice(2)
const asJson = args.includes('--json')
// --en: list Portuguese literals with no PT->EN reverse entry (they would leak into en-US)
const checkEnglishSide = args.includes('--en')
const dirArg = args[args.indexOf('--dir') + 1]
const SCAN_DIR = args.includes('--dir') ? path.resolve(ROOT, dirArg) : path.join(ROOT, 'src')

// ------------------------------------------------------------
// Dictionary keys
// ------------------------------------------------------------
function collectDictionaryKeys() {
  const files = [
    path.join(ROOT, 'src/lib/i18n.ts'),
    path.join(ROOT, 'src/lib/i18n-extra.ts'),
  ]
  const dictDir = path.join(ROOT, 'src/lib/i18n-dict')
  if (fs.existsSync(dictDir)) {
    for (const f of fs.readdirSync(dictDir)) if (f.endsWith('.ts')) files.push(path.join(dictDir, f))
  }
  const keys = new Set()
  const values = new Set()
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node) => {
      if (ts.isPropertyAssignment(node)) {
        const n = node.name
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) keys.add(normalize(n.text))
        else if (ts.isIdentifier(n)) keys.add(normalize(n.text))
        const v = node.initializer
        if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) values.add(normalize(v.text))
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { keys, values }
}

function normalize(s) {
  return s.trim().replace(/\s+/g, ' ')
}

// ------------------------------------------------------------
// Language heuristics
// ------------------------------------------------------------
const EN_WORDS = new Set(`the a an and or of to in on at for with from by is are was were be been not no yes this that these those your you we our it its as if then else when while all any new add save delete remove cancel edit search loading failed error success done ok close open more less show hide select choose enter type name email phone password sign log out account settings member members team invite invited invitation pending active inactive enabled disabled unknown none yet again please try could cannot can't couldn't won't don't doesn't isn't wasn't aren't only just already still never always first last next previous back send sent message messages conversation conversations contact contacts deal deals pipeline stage tag tags task tasks note notes file files upload download create created update updated change changed changes required optional invalid valid at least must should will would may might about after before between during into over under without within`.split(/\s+/))
const PT_WORDS = new Set(`de da do das dos para com não sem seu sua seus suas você em um uma uns umas por que como mais menos ao aos à às ou o os as este esta esse essa isso aqui já ainda também só apenas todos todas nenhum nenhuma pelo pela nos nas`.split(/\s+/))
// Portuguese UI words that carry no accent and could pass for English tokens.
const PT_UI = new Set(`fechar salvar cancelar excluir editar novo nova buscar carregando enviar voltar entrar sair confirmar remover adicionar abrir criar atualizar anterior sim nenhum todos ativo inativo pendente concluido aguardando senha nome sobrenome telefone endereco cidade estado empresa conta contato contatos negocio negocios funil funis tarefa tarefas etiqueta etiquetas disparo disparos fluxo fluxos modelo modelos credenciais ajuda continuar comecar limpar filtrar filtros ordenar exportar importar copiar copiado colar desfazer refazer visualizar detalhes resumo painel caixa entrada pesquisar procurar selecionar selecione digite informe escolha marque desmarque`.split(/\s+/))

function looksPortuguese(s) {
  if (/[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(s)) return true
  const words = s.toLowerCase().split(/[^a-zà-ú]+/).filter(Boolean)
  if (words.length === 0) return false
  const pt = words.filter((w) => PT_WORDS.has(w) || PT_UI.has(w)).length
  const en = words.filter((w) => EN_WORDS.has(w)).length
  if (words.length === 1) return PT_UI.has(words[0])
  return pt >= 2 || (pt >= 1 && en === 0)
}

function looksEnglish(s) {
  const words = s.toLowerCase().split(/[^a-z']+/).filter(Boolean)
  if (words.length === 0) return false
  if (words.length === 1) return EN_WORDS.has(words[0]) || /^[A-Z][a-z]{3,}$/.test(s.trim())
  const hits = words.filter((w) => EN_WORDS.has(w)).length
  return hits >= 1 || words.length >= 3
}

/** Things that are never copy: ids, classes, urls, code, single symbols, numbers. */
function isNoise(s) {
  const t = s.trim()
  if (t.length < 2) return true
  if (/^[\d\s.,:%/+\-–—()·•|…&_$#*=<>[\]{}"'`!?@]+$/.test(t)) return true
  if (/^https?:\/\//.test(t) || /^\/[a-z0-9_\-/[\]]*$/i.test(t)) return true
  if (/^[a-z0-9_.-]+$/.test(t) && !EN_WORDS.has(t)) return true // identifiers, keys
  if (/^[A-Z0-9_]{2,}$/.test(t)) return true // CONSTANTS, UF codes
  if (/^(\w+[-:.]\w+)+$/.test(t)) return true // class-like, dotted
  if (/^[\w\s-]*\{|\}[\w\s-]*$/.test(t)) return true // JSX expressions leftovers
  if (/^(px|rem|em|%|ms|s)$/.test(t)) return true
  if (/^[+\-]?\d/.test(t) && t.split(/\s+/).length <= 2) return true
  if (/^(data|aria|on[A-Z])/.test(t)) return true
  // Tailwind / class lists: several lowercase tokens with -, :, / or []
  const toks = t.split(/\s+/)
  if (toks.length >= 2 && toks.every((w) => /^[a-z0-9!@:/\[\]().%#-]+$/.test(w)) && toks.filter((w) => /[-:/\[]/.test(w)).length >= toks.length / 2) return true
  return false
}

// ------------------------------------------------------------
// Extraction
// ------------------------------------------------------------
const ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt', 'label', 'description', 'emptyMessage', 'helperText', 'tooltip', 'confirmText', 'cancelText', 'hint', 'subtitle', 'heading'])
const TOAST_RE = /^toast(\.(success|error|info|warning|message|loading))?$/

function extractFromFile(file, dict) {
  const src = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found = []
  const isApiRoute = /[\\/]app[\\/]api[\\/]/.test(file)
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')

  const add = (text, kind, node, opts = {}) => {
    const n = normalize(text)
    if (isNoise(n)) return
    if (checkEnglishSide) {
      // en-US side: Portuguese hardcoded in the code needs a reverse entry
      if (!looksPortuguese(n) || dictValues.has(n)) return
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      found.push({ file: rel, line: line + 1, kind: `pt:${kind}`, text: n })
      return
    }
    if (looksPortuguese(n) && !opts.forceEnglishCheck) return // pt-BR copy is fine in pt-BR
    if (!looksEnglish(n)) return
    if (dict.has(n)) return
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    found.push({ file: rel, line: line + 1, kind, text: n })
  }

  const visit = (node) => {
    // <p>Some text</p>
    if (ts.isJsxText(node)) {
      const t = node.text
      if (t.trim()) add(t, 'jsx-text', node)
    }
    // <Input placeholder="..." title="..." />
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf)
      if (ATTRS.has(name)) {
        const init = node.initializer
        if (ts.isStringLiteral(init)) add(init.text, `attr:${name}`, init)
        else if (ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression))) add(init.expression.text, `attr:${name}`, init)
      }
    }
    // {'text'} inside JSX, and {cond ? 'A' : 'B'}
    if (ts.isJsxExpression(node) && node.expression) {
      const e = node.expression
      const lits = []
      const collect = (x) => {
        if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) lits.push(x)
        else if (ts.isConditionalExpression(x)) { collect(x.whenTrue); collect(x.whenFalse) }
        else if (ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken)) { collect(x.left); collect(x.right) }
        else if (ts.isParenthesizedExpression(x)) collect(x.expression)
      }
      collect(e)
      for (const l of lits) {
        if (/^[a-z][a-z0-9_-]*$/.test(l.text.trim())) continue // 'password', 'text', variant ids
        add(l.text, 'jsx-expr', l)
      }
      if (ts.isTemplateExpression(e)) add(templateShape(e), 'jsx-template', e)
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf)
      const first = node.arguments[0]
      // t('...')
      if ((callee === 't' || callee.endsWith('.t')) && first) {
        if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) add(first.text, 't()', first)
        else if (ts.isTemplateExpression(first)) add(templateShape(first), 't(template)', first)
      }
      // toast.error('...') / toast('...')
      if (TOAST_RE.test(callee) && first) {
        if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) add(first.text, 'toast', first)
        else if (ts.isTemplateExpression(first)) add(templateShape(first), 'toast(template)', first)
        else if (ts.isConditionalExpression(first)) {
          for (const b of [first.whenTrue, first.whenFalse]) if (ts.isStringLiteral(b)) add(b.text, 'toast', b)
        }
      }
      // confirm('...') / window.confirm
      if (/^(window\.)?confirm$/.test(callee) && first && ts.isStringLiteral(first)) add(first.text, 'confirm', first)
      // setError('...') / setXError('...')
      if (/^set[A-Za-z]*Error$/.test(callee) && first && ts.isStringLiteral(first)) add(first.text, 'setError', first)
      // new Error('...') thrown to the UI
      // NextResponse.json({ error: '...' }) in API routes
      if (isApiRoute && /NextResponse\.json$/.test(callee) && first && ts.isObjectLiteralExpression(first)) {
        for (const p of first.properties) {
          if (ts.isPropertyAssignment(p) && ['error', 'message'].includes(p.name.getText(sf))) {
            if (ts.isStringLiteral(p.initializer)) add(p.initializer.text, 'api-error', p.initializer)
            else if (ts.isTemplateExpression(p.initializer)) add(templateShape(p.initializer), 'api-error(template)', p.initializer)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function templateShape(tpl) {
  let s = tpl.head.text
  for (const span of tpl.templateSpans) s += '${…}' + span.literal.text
  return s
}

// ------------------------------------------------------------
// Walk
// ------------------------------------------------------------
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '.next', '__tests__'].includes(entry.name)) continue
      walk(p, out)
    } else if (/\.(tsx|ts)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !/i18n(-extra|-dict)?/.test(p)) {
      out.push(p)
    }
  }
  return out
}

const { keys: dict, values: dictValues } = collectDictionaryKeys()
const files = walk(SCAN_DIR)
const all = []
for (const f of files) all.push(...extractFromFile(f, dict))

// de-dupe identical text per file+line
const seen = new Set()
const findings = all.filter((x) => {
  const k = `${x.file}:${x.line}:${x.text}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})

const byArea = {}
for (const f of findings) {
  const area = f.file.split('/').slice(0, 3).join('/')
  byArea[area] = (byArea[area] ?? 0) + 1
}
const uniqueTexts = new Set(findings.map((f) => f.text))

if (asJson) {
  process.stdout.write(JSON.stringify({ dictionaryKeys: dict.size, files: files.length, findings, byArea, unique: uniqueTexts.size }, null, 2))
} else {
  let current = ''
  for (const f of findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    if (f.file !== current) { current = f.file; console.log(`\n${f.file}`) }
    console.log(`  ${String(f.line).padStart(4)}  ${f.kind.padEnd(16)} ${f.text}`)
  }
  console.log('\n--- by area ---')
  for (const [a, n] of Object.entries(byArea).sort((x, y) => y[1] - x[1])) console.log(`${String(n).padStart(5)}  ${a}`)
  console.log(`\nfiles scanned: ${files.length} · dictionary keys: ${dict.size} · missing: ${findings.length} (${uniqueTexts.size} unique texts)`)
}
process.exit(findings.length > 0 ? 1 : 0)
