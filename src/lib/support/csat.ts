// ============================================================
// CSAT survey (migration 074) — pure rules, no I/O: the settings shape,
// how a customer's reply is read as a score or a comment, and whether a
// resolved conversation may be surveyed. The cron (csat-cron.ts) and the
// inbound interception (csat-inbound.ts) both use these.
// ============================================================

import type { Language } from '@/lib/i18n'

export type CsatScale = 'stars5' | 'thumbs'
export const CSAT_SCALES: readonly CsatScale[] = ['stars5', 'thumbs']
export const CSAT_RESOLUTIONS = ['resolved', 'not_applicable', 'closed_by_customer', 'expired', 'duplicate'] as const

export interface CsatSettings {
  enabled: boolean
  scale: CsatScale
  delay_minutes: number
  message_text: string
  thanks_text: string
  ask_comment: boolean
  cooldown_days: number
  only_categories: string[]
  skip_resolutions: string[]
  /** Only survey when the customer wrote within this many hours before the conversation was resolved. */
  max_age_hours: number
}

export const CSAT_MESSAGE_DEFAULTS: Record<CsatScale, string> = {
  stars5: 'Como foi o atendimento? Responda de 1 a 5, sendo 5 muito bom.',
  thumbs: 'Como foi o atendimento? Responda 👍 se foi bom ou 👎 se não foi.',
}
export const CSAT_COMMENT_PROMPT = 'Quer deixar um comentário? (opcional)'

export const CSAT_DEFAULTS: CsatSettings = {
  enabled: false,
  scale: 'stars5',
  delay_minutes: 5,
  message_text: CSAT_MESSAGE_DEFAULTS.stars5,
  thanks_text: 'Obrigado pela sua avaliação!',
  ask_comment: true,
  cooldown_days: 7,
  only_categories: [],
  skip_resolutions: ['not_applicable', 'duplicate', 'expired'],
  max_age_hours: 72,
}

export const CSAT_LIMITS = {
  delay_minutes: { min: 0, max: 1440 },
  cooldown_days: { min: 0, max: 365 },
  message_text: 1000,
  thanks_text: 500,
  max_age_hours: { min: 1, max: 720 },
  comment: 500,
  /** A reply longer than this is never taken as a comment (it is a normal message). */
  comment_candidate: 200,
  /** Surveys sent per account per hour; the rest waits (QR bursts after a bulk resolve). */
  burst_per_hour: 20,
} as const

/** The customer has this long, after the survey, to answer it. */
export const CSAT_ANSWER_WINDOW_MS = 48 * 60 * 60 * 1000
/** ...and this long, after the comment question was SENT, to leave a comment. */
export const CSAT_COMMENT_WINDOW_MS = 10 * 60 * 1000
/** Official channel: free text only inside 24 h of the customer's last message. */
export const META_WINDOW_MS = 24 * 60 * 60 * 1000

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

/** A `csat_settings` row (or nothing) -> settings; tolerant of missing / bad values. */
export function parseCsatSettings(raw: unknown): CsatSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const scale: CsatScale = r.scale === 'thumbs' ? 'thumbs' : 'stars5'
  const text = (v: unknown, fallback: string, max: number) =>
    typeof v === 'string' && v.trim() ? v.slice(0, max) : fallback
  return {
    enabled: r.enabled === true,
    scale,
    delay_minutes: clampInt(r.delay_minutes, 0, 1440, CSAT_DEFAULTS.delay_minutes),
    message_text: text(r.message_text, CSAT_MESSAGE_DEFAULTS[scale], CSAT_LIMITS.message_text),
    thanks_text: typeof r.thanks_text === 'string' ? r.thanks_text.slice(0, CSAT_LIMITS.thanks_text) : CSAT_DEFAULTS.thanks_text,
    ask_comment: r.ask_comment === undefined ? CSAT_DEFAULTS.ask_comment : r.ask_comment === true,
    cooldown_days: clampInt(r.cooldown_days, 0, 365, CSAT_DEFAULTS.cooldown_days),
    max_age_hours: clampInt(r.max_age_hours, 1, 720, CSAT_DEFAULTS.max_age_hours),
    only_categories: Array.isArray(r.only_categories) ? r.only_categories.filter((x): x is string => typeof x === 'string') : [],
    skip_resolutions: Array.isArray(r.skip_resolutions)
      ? r.skip_resolutions.filter((x): x is string => typeof x === 'string')
      : [...CSAT_DEFAULTS.skip_resolutions],
  }
}

// ---- reading the customer's reply ---------------------------------

/** Lowercase, no accents, no skin-tone / variation marks, single spaces. */
function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\u{1F3FB}-\u{1F3FF}️‍]/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

// "uma" is deliberately absent: "uma" alone is an article, not a rating.
const WORDS: Record<string, number> = { um: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5 }
const DIGIT_RE = /^(?:nota )?([1-5]|um|dois|duas|tres|quatro|cinco)(?: ?\/ ?5)?(?: (?:estrelas?|pontos?))?[.!]*$/
/** A digit followed by words: "5 mas demorou". The words are a comment. */
const SCORE_PLUS_RE = /^(?:nota )?([1-5])(?!\d)(?: ?\/ ?5)?[\s,.:;!-]+([\s\S]+)$/

/**
 * The score a reply carries, or null. Only a reply that is JUST a score is
 * read: "5", "nota 4", "5 estrelas", "três", "4/5", ⭐⭐⭐, 👍 (5) or 👎 (1).
 * Anything with more in it ("5 mas demorou", "10", "não sei") is null — it
 * stays a normal message and the survey keeps waiting.
 */
export function parseCsatScore(text: string | null | undefined): number | null {
  if (!text) return null
  const t = normalise(text)
  if (!t || t.length > 24) return null
  // One thumb is an answer; several ("👍👍") are just friendliness (isPoliteReply).
  if (/^👍$/u.test(t)) return 5
  if (/^👎$/u.test(t)) return 1
  const stars = /^[⭐🌟]+$/u.exec(t)
  if (stars) {
    const n = Array.from(t).length
    return n >= 1 && n <= 5 ? n : null
  }
  const m = DIGIT_RE.exec(t)
  if (!m) return null
  const raw = m[1]
  return /^\d$/.test(raw) ? Number(raw) : (WORDS[raw] ?? null)
}

const DECLINE_RE = /^(?:nao|n|nope|nada|pular|pula|sem comentarios?|nao quero|nao obrigad[oa]|obrigad[oa]|ok|nao precisa)[.!]*$/

/** "não", "pular", "obrigado": the customer does not want to comment. */
export function isCommentDecline(text: string | null | undefined): boolean {
  return !!text && DECLINE_RE.test(normalise(text))
}

/** Words that make a reply a request or a complaint, never just feedback. */
const REQUEST_RE =
  /\b(?:cancel\w*|problema\w*|nao funciona\w*|nao (?:consigo|recebi|chegou)|erro\w*|boleto\w*|pedido\w*|preciso|precisando|quero|queria|ajuda\w*|segunda via|nota fiscal|nf|suporte|reembols\w*|estorn\w*|defeito\w*|reclam\w*|urgente|atras\w*|cobranca\w*|trocar|troca|devol\w*)\b/

export function hasRequestWords(text: string): boolean {
  return REQUEST_RE.test(normalise(text))
}

const POLITE_RE =
  /^(?:muito )?(?:obrigad[oa]s?|obg|valeu|vlw|otim[oa]|show|top|blz|beleza|joia|perfeito|excelente|legal|bom|ok|tudo certo|disponha|nota 10|10|100)[.!]*$/

/**
 * A short, friendly non-score reply to the survey ("obrigado", "ótimo", "10",
 * "valeu", "👍👍"). It is store-only: it neither reopens the conversation nor
 * starts a flow, and the survey keeps waiting for a real score.
 */
export function isPoliteReply(text: string | null | undefined): boolean {
  if (!text) return false
  const t = normalise(text)
  if (!t || t.length > 24 || parseCsatScore(text) !== null) return false
  if (/^[👍👎🙏❤♥👏😀😊😁🙂\s]+$/u.test(t)) return true
  return POLITE_RE.test(t)
}

/** "5 mas demorou": the score and the words after it, or null. */
export function parseScoreWithComment(text: string | null | undefined): { score: number; comment: string } | null {
  if (!text || text.length > CSAT_LIMITS.comment_candidate + 8) return null
  const m = SCORE_PLUS_RE.exec(text.trim())
  if (!m) return null
  const comment = m[2].trim()
  if (!comment || comment.length > CSAT_LIMITS.comment_candidate || comment.includes('?')) return null
  if (/^(?:estrelas?|pontos?)[.!]*$/i.test(normalise(comment))) return null
  return { score: Number(m[1]), comment }
}

/**
 * What to do with the reply that follows the comment question.
 *   decline  - "não", "pular", a repeated score: close the question, store only
 *   consume  - a short neutral comment: keep it as the comment, store only
 *   record   - it reads as a complaint or request (or the score was 1-2): keep it
 *              as the comment AND let it flow as a normal message
 *   flow     - a question, long text or empty: a normal message, nothing recorded
 * When in doubt it flows.
 */
export type CommentVerdict = 'decline' | 'consume' | 'record' | 'flow'
export function judgeComment(text: string | null | undefined, score: number | null): CommentVerdict {
  const t = (text ?? '').trim()
  if (!t || t.length > CSAT_LIMITS.comment_candidate || t.includes('?')) return 'flow'
  if (parseCsatScore(t) !== null || isCommentDecline(t)) return 'decline'
  if (hasRequestWords(t) || (score !== null && score <= 2)) return 'record'
  return 'consume'
}

// ---- eligibility ---------------------------------------------------

/**
 * Why a survey was not sent. The first group leaves no `csat_responses`
 * row (the conversation may be surveyed after another resolve); the rest
 * is recorded as `skipped` with the reason.
 */
export type CsatSkipReason =
  | 'reopened'
  | 'disabled'
  | 'resolution_excluded'
  | 'category_excluded'
  | 'opted_out'
  | 'no_customer_message'
  | 'no_agent_message'
  | 'stale'
  | 'contact_active'
  | 'cooldown'
  | 'window_closed'
  | 'no_phone'

export const CSAT_JOB_ONLY_REASONS: readonly CsatSkipReason[] = [
  'reopened',
  'contact_active',
  'disabled',
  'resolution_excluded',
  'category_excluded',
]

export interface CsatEligibilityInput {
  settings: CsatSettings
  conversation: {
    status: string
    service_count: number | null
    resolution: string | null
    category_id: string | null
    channel: string | null
    last_customer_message_at: string | null
    /** Someone (agent, bot) answered in this conversation. */
    last_agent_message_at?: string | null
    resolved_at?: string | null
  }
  /** `csat_jobs.service_count`: the attendance this job was queued for. */
  jobServiceCount: number
  contact: { opted_out_at: string | null; anonymized_at: string | null; phone: string | null }
  /** The contact has a non-closed conversation right now (checked just before sending). */
  hasActiveConversation?: boolean
  /** The contact's newest customer message in ANY conversation (Meta 24 h window). */
  contactLastCustomerAt?: string | null
  /** Latest survey sent to this contact (sent, answered or expired; not skipped), ISO. */
  lastSentAt: string | null
  now: Date
}

export function csatSkipReason(i: CsatEligibilityInput): CsatSkipReason | null {
  const c = i.conversation
  if (c.status !== 'closed' || (c.service_count ?? 1) !== i.jobServiceCount) return 'reopened'
  if (i.hasActiveConversation) return 'contact_active'
  if (!i.settings.enabled) return 'disabled'
  if (c.resolution && i.settings.skip_resolutions.includes(c.resolution)) return 'resolution_excluded'
  if (i.settings.only_categories.length > 0 && !(c.category_id && i.settings.only_categories.includes(c.category_id))) {
    return 'category_excluded'
  }
  if (i.contact.opted_out_at || i.contact.anonymized_at) return 'opted_out'
  if (!i.contact.phone) return 'no_phone'
  if (!c.last_customer_message_at) return 'no_customer_message'
  if (c.last_agent_message_at === null) return 'no_agent_message'
  if (c.resolved_at) {
    const gap = Date.parse(c.resolved_at) - Date.parse(c.last_customer_message_at)
    if (Number.isFinite(gap) && gap > i.settings.max_age_hours * 3_600_000) return 'stale'
  }
  if (i.settings.cooldown_days > 0 && i.lastSentAt) {
    const since = i.now.getTime() - Date.parse(i.lastSentAt)
    if (Number.isFinite(since) && since < i.settings.cooldown_days * 86_400_000) return 'cooldown'
  }
  if (c.channel !== 'qr') {
    const last = Date.parse(i.contactLastCustomerAt ?? c.last_customer_message_at)
    if (!Number.isFinite(last) || i.now.getTime() - last > META_WINDOW_MS) return 'window_closed'
  }
  return null
}

/** The text of the survey. */
export function surveyText(s: CsatSettings): string {
  return s.message_text.trim()
}

/** Thanks, plus the comment question when asked for. */
export function thanksText(s: CsatSettings): string {
  const thanks = s.thanks_text.trim()
  return s.ask_comment ? (thanks ? `${thanks}\n\n${CSAT_COMMENT_PROMPT}` : CSAT_COMMENT_PROMPT) : thanks
}

// ---- inbox ----------------------------------------------------------

/** The newest rating in a conversation's event log (`csat_answered`), or null. */
export function latestCsatScore(
  events: readonly { event_type: string; payload?: { score?: unknown } | null; created_at?: string }[],
): number | null {
  let best: { at: number; score: number } | null = null
  for (const [i, e] of events.entries()) {
    if (e.event_type !== 'csat_answered') continue
    const score = Number(e.payload?.score)
    if (!Number.isInteger(score) || score < 1 || score > 5) continue
    const at = e.created_at ? Date.parse(e.created_at) : i
    if (!best || at >= best.at) best = { at: Number.isFinite(at) ? at : i, score }
  }
  return best?.score ?? null
}

// ---- copy -----------------------------------------------------------

export interface CsatCopy {
  rating: (n: number) => string
  title: string
  intro: string
  enable: string
  scale: string
  scaleOptions: Record<CsatScale, string>
  message: string
  thanks: string
  delay: string
  minutes: string
  askComment: string
  cooldown: string
  days: string
  maxAge: string
  hours: string
  skip: string
  saveFailed: string
  readOnly: string
}

const COPY: Record<Language, CsatCopy> = {
  'pt-BR': {
    rating: (n) => `Nota ${n}`,
    title: 'Pesquisa de satisfação',
    intro: 'Depois de resolver, o cliente recebe uma pergunta pelo WhatsApp e responde com uma nota.',
    enable: 'Enviar pesquisa após resolver',
    scale: 'Escala',
    scaleOptions: { stars5: 'Nota de 1 a 5', thumbs: 'Positivo ou negativo' },
    message: 'Mensagem',
    thanks: 'Agradecimento',
    delay: 'Enviar depois de',
    minutes: 'minutos',
    askComment: 'Pedir um comentário depois da nota',
    cooldown: 'Não perguntar de novo ao mesmo contato por',
    days: 'dias',
    maxAge: 'Só perguntar se o cliente escreveu até',
    hours: 'horas antes de resolver',
    skip: 'Não enviar quando a conversa for resolvida como',
    saveFailed: 'Não foi possível salvar',
    readOnly: 'Somente administradores podem alterar a pesquisa.',
  },
  'en-US': {
    rating: (n) => `Rated ${n}`,
    title: 'Satisfaction survey',
    intro: 'After a conversation is resolved, the customer gets a question on WhatsApp and answers with a score.',
    enable: 'Send a survey after resolving',
    scale: 'Scale',
    scaleOptions: { stars5: 'Score from 1 to 5', thumbs: 'Thumbs up or down' },
    message: 'Message',
    thanks: 'Thank-you message',
    delay: 'Send after',
    minutes: 'minutes',
    askComment: 'Ask for a comment after the score',
    cooldown: 'Do not ask the same contact again for',
    days: 'days',
    maxAge: 'Only ask if the customer wrote within',
    hours: 'hours before resolving',
    skip: 'Do not send when the conversation is resolved as',
    saveFailed: 'Could not save',
    readOnly: 'Only admins can change the survey.',
  },
}

export function csatCopy(language: Language): CsatCopy {
  return COPY[language] ?? COPY['pt-BR']
}
