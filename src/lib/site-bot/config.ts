// ============================================================
// bot_config validation + the public projection. Pure.
// ============================================================

import { BOT_LIMITS, type BotConfig, type BotQuestion, type PublicBotConfig } from './types'

const COLOR_RE = /^#[0-9a-fA-F]{6}$/
const QUESTION_ID_RE = /^[a-z][a-z0-9_]{0,23}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/

export type ConfigResult = { ok: true; config: BotConfig } | { ok: false; errors: string[] }

/**
 * Hostname for a typed domain ("https://www.Loja.com.br/x" -> "loja.com.br").
 * Null when it is not a plausible hostname. A single label is only
 * accepted for `localhost`.
 */
export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== 'string') return null
  let s = input.trim().toLowerCase()
  if (!s) return null
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  s = s.split(/[/?#]/)[0]
  s = s.replace(/:\d+$/, '').replace(/\.$/, '')
  s = s.replace(/^www\./, '')
  if (!HOST_RE.test(s)) return null
  if (!s.includes('.') && s !== 'localhost') return null
  return s
}

export function defaultBotConfig(): BotConfig {
  return {
    appearance: { botName: 'Assistente', color: '#2563eb', bubbleText: 'Posso ajudar?', side: 'right' },
    greeting: 'Olá! Posso te ajudar? Responda algumas perguntas rápidas.',
    questions: [
      { id: 'nome', text: 'Qual é o seu nome?', type: 'name', required: true },
      { id: 'whatsapp', text: 'Qual é o seu WhatsApp (com DDD)?', type: 'phone', required: true },
    ],
    end: {
      thanks: 'Obrigado! Recebemos seus dados e já vamos falar com você.',
      whatsappEnabled: false,
      whatsappNumber: '',
      messageTemplate: 'Olá! Sou {nome}, vim pelo site.',
    },
    lgpd: { text: 'Concordo em compartilhar meus dados para receber contato.', linkUrl: '' },
    domains: [],
  }
}

function str(v: unknown, max: number, label: string, errors: string[], opts: { required?: boolean } = {}): string {
  if (v === undefined || v === null) v = ''
  if (typeof v !== 'string') {
    errors.push(`${label} must be text`)
    return ''
  }
  const s = v.trim()
  if (opts.required && !s) errors.push(`${label} is required`)
  if (s.length > max) {
    errors.push(`${label} must be ${max} characters or fewer`)
    return s.slice(0, max)
  }
  return s
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Validate untrusted input (editor body or a DB row) into a clean BotConfig. */
export function validateBotConfig(raw: unknown): ConfigResult {
  const errors: string[] = []
  if (!isObj(raw)) return { ok: false, errors: ['config must be an object'] }
  const ap = isObj(raw.appearance) ? raw.appearance : {}
  const end = isObj(raw.end) ? raw.end : {}
  const lgpd = isObj(raw.lgpd) ? raw.lgpd : {}

  const botName = str(ap.botName, BOT_LIMITS.botName, 'botName', errors, { required: true })
  const bubbleText = str(ap.bubbleText, BOT_LIMITS.bubbleText, 'bubbleText', errors)
  const color = typeof ap.color === 'string' ? ap.color.trim() : ''
  if (!COLOR_RE.test(color)) errors.push('color must be #rrggbb')
  const side = ap.side === 'left' ? 'left' : ap.side === 'right' || ap.side === undefined ? 'right' : null
  if (side === null) errors.push('side must be left or right')
  const greeting = str(raw.greeting, BOT_LIMITS.greeting, 'greeting', errors, { required: true })

  // questions
  const questions: BotQuestion[] = []
  if (!Array.isArray(raw.questions)) {
    errors.push('questions must be a list')
  } else {
    if (raw.questions.length > BOT_LIMITS.maxQuestions) {
      errors.push(`at most ${BOT_LIMITS.maxQuestions} questions`)
    }
    const seen = new Set<string>()
    for (const [i, q] of raw.questions.slice(0, BOT_LIMITS.maxQuestions).entries()) {
      const at = `question ${i + 1}`
      if (!isObj(q)) {
        errors.push(`${at}: the question is malformed`)
        continue
      }
      const id = typeof q.id === 'string' ? q.id : ''
      if (!QUESTION_ID_RE.test(id)) errors.push(`${at}: the question id is invalid`)
      else if (seen.has(id)) errors.push(`${at}: the question id is repeated`)
      seen.add(id)
      const type = q.type
      if (type !== 'text' && type !== 'choice' && type !== 'name' && type !== 'phone' && type !== 'email') {
        errors.push(`${at}: the answer type is invalid`)
        continue
      }
      const rawText = typeof q.text === 'string' ? q.text.trim() : ''
      if (!rawText) errors.push(`${at}: the question needs a text`)
      else if (rawText.length > BOT_LIMITS.question) errors.push(`${at}: the question text is over ${BOT_LIMITS.question} characters`)
      const text = rawText.slice(0, BOT_LIMITS.question)
      const question: BotQuestion = { id, text, type, required: q.required === true }
      if (type === 'name' || type === 'phone') question.required = true
      if (type === 'choice') {
        const opts = Array.isArray(q.options) ? q.options : []
        const clean = opts.map((o) => (typeof o === 'string' ? o.trim() : ''))
        if (clean.length < BOT_LIMITS.minOptions || clean.length > BOT_LIMITS.maxOptions) {
          errors.push(`${at}: choose ${BOT_LIMITS.minOptions} to ${BOT_LIMITS.maxOptions} answer buttons`)
        }
        if (clean.some((o) => !o || o.length > BOT_LIMITS.option)) {
          errors.push(`${at}: each answer button needs 1 to ${BOT_LIMITS.option} characters`)
        }
        if (new Set(clean).size !== clean.length) errors.push(`${at}: answer buttons must be different`)
        question.options = clean
      }
      if (type === 'text' || type === 'choice') {
        const target = q.target === 'custom' ? 'custom' : 'note'
        question.target = target
        if (target === 'custom') {
          if (typeof q.customFieldId !== 'string' || !UUID_RE.test(q.customFieldId)) {
            errors.push(`${at}: pick the contact field for this answer`)
          } else {
            question.customFieldId = q.customFieldId
          }
        }
      }
      questions.push(question)
    }
    const count = (t: string) => questions.filter((q) => q.type === t).length
    if (count('name') !== 1) errors.push('exactly one name question is required')
    if (count('phone') !== 1) errors.push('exactly one phone question is required')
    if (count('email') > 1) errors.push('at most one email question')
    const customs = questions.filter((q) => q.target === 'custom').map((q) => q.customFieldId)
    if (new Set(customs).size !== customs.length) errors.push('each custom field can be used once')
  }

  // end screen
  const whatsappEnabled = end.whatsappEnabled === true
  const whatsappNumber = typeof end.whatsappNumber === 'string' ? end.whatsappNumber.replace(/\D/g, '') : ''
  if (whatsappEnabled && !/^[1-9]\d{9,14}$/.test(whatsappNumber)) {
    errors.push('whatsappNumber must have the country code and area code')
  }
  const thanks = str(end.thanks, BOT_LIMITS.thanks, 'thanks', errors, { required: true })
  const messageTemplate = str(end.messageTemplate, BOT_LIMITS.messageTemplate, 'messageTemplate', errors)

  // LGPD
  const lgpdText = str(lgpd.text, BOT_LIMITS.lgpdText, 'consent text', errors, { required: true })
  const linkUrl = str(lgpd.linkUrl, BOT_LIMITS.url, 'privacy link', errors)
  if (linkUrl) {
    let ok = false
    try {
      const u = new URL(linkUrl)
      ok = u.protocol === 'https:' && !u.username && !u.password
    } catch {
      // invalid URL: reported below
    }
    if (!ok) errors.push('privacy link must be an https address')
  }

  // domains
  const domains: string[] = []
  if (raw.domains !== undefined && !Array.isArray(raw.domains)) {
    errors.push('domains must be a list')
  } else {
    const list = (raw.domains ?? []) as unknown[]
    if (list.length > BOT_LIMITS.maxDomains) errors.push(`at most ${BOT_LIMITS.maxDomains} domains`)
    for (const d of list.slice(0, BOT_LIMITS.maxDomains)) {
      const n = normalizeDomain(d)
      if (!n) errors.push(`invalid domain: ${typeof d === 'string' ? d.slice(0, 60) : '?'}`)
      else if (!domains.includes(n)) domains.push(n)
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    config: {
      appearance: { botName, color: color.toLowerCase(), bubbleText, side: side as 'left' | 'right' },
      greeting,
      questions,
      end: {
        thanks,
        whatsappEnabled,
        whatsappNumber: whatsappEnabled ? whatsappNumber : '',
        messageTemplate,
      },
      lgpd: { text: lgpdText, linkUrl },
      domains,
    },
  }
}

/** The projection a visitor's browser gets: no field ids, no number, no domains. */
export function publicBotConfig(c: BotConfig): PublicBotConfig {
  return {
    name: c.appearance.botName,
    color: c.appearance.color,
    bubbleText: c.appearance.bubbleText,
    side: c.appearance.side,
    greeting: c.greeting,
    questions: c.questions.map((q) => ({
      id: q.id,
      text: q.text,
      type: q.type,
      ...(q.type === 'choice' ? { options: [...(q.options ?? [])] } : {}),
      required: q.required,
    })),
    consent: { text: c.lgpd.text, linkUrl: c.lgpd.linkUrl },
    thanks: c.end.thanks,
    whatsapp: c.end.whatsappEnabled,
  }
}
