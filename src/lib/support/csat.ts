// ============================================================
// CSAT survey (migration 074) — pure rules, no I/O: the settings shape,
// how a customer's reply is read as a score or a comment, and whether a
// resolved conversation may be surveyed. The cron (csat-cron.ts) and the
// inbound interception (csat-inbound.ts) both use these.
// ============================================================

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
}

export const CSAT_LIMITS = {
  delay_minutes: { min: 0, max: 1440 },
  cooldown_days: { min: 0, max: 365 },
  message_text: 1000,
  thanks_text: 500,
  comment: 500,
  /** A reply longer than this is never read as a comment. */
  comment_candidate: 1000,
} as const

/** The customer has this long, after the survey, to answer it. */
export const CSAT_ANSWER_WINDOW_MS = 48 * 60 * 60 * 1000
/** ...and this long, after the comment question, to leave a comment. */
export const CSAT_COMMENT_WINDOW_MS = 24 * 60 * 60 * 1000
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

const WORDS: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5 }
const DIGIT_RE = /^(?:nota )?([1-5]|um|uma|dois|duas|tres|quatro|cinco)(?: ?\/ ?5)?(?: (?:estrelas?|pontos?))?[.!]*$/

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
  if (/^👍+$/u.test(t)) return 5
  if (/^👎+$/u.test(t)) return 1
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

/**
 * May this reply be taken as the comment? Text only, not a question (a
 * question is a new request, not feedback) and not absurdly long.
 */
export function isCommentCandidate(text: string | null | undefined): boolean {
  const t = (text ?? '').trim()
  return t.length > 0 && t.length <= CSAT_LIMITS.comment_candidate && !t.includes('?')
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
  | 'cooldown'
  | 'window_closed'
  | 'no_phone'

export const CSAT_JOB_ONLY_REASONS: readonly CsatSkipReason[] = [
  'reopened',
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
  }
  /** `csat_jobs.service_count`: the attendance this job was queued for. */
  jobServiceCount: number
  contact: { opted_out_at: string | null; anonymized_at: string | null; phone: string | null }
  /** Latest survey really sent to this contact (not skipped), ISO. */
  lastSentAt: string | null
  now: Date
}

export function csatSkipReason(i: CsatEligibilityInput): CsatSkipReason | null {
  const c = i.conversation
  if (c.status !== 'closed' || (c.service_count ?? 1) !== i.jobServiceCount) return 'reopened'
  if (!i.settings.enabled) return 'disabled'
  if (c.resolution && i.settings.skip_resolutions.includes(c.resolution)) return 'resolution_excluded'
  if (i.settings.only_categories.length > 0 && !(c.category_id && i.settings.only_categories.includes(c.category_id))) {
    return 'category_excluded'
  }
  if (i.contact.opted_out_at || i.contact.anonymized_at) return 'opted_out'
  if (!i.contact.phone) return 'no_phone'
  if (!c.last_customer_message_at) return 'no_customer_message'
  if (i.settings.cooldown_days > 0 && i.lastSentAt) {
    const since = i.now.getTime() - Date.parse(i.lastSentAt)
    if (Number.isFinite(since) && since < i.settings.cooldown_days * 86_400_000) return 'cooldown'
  }
  if (c.channel !== 'qr') {
    const last = Date.parse(c.last_customer_message_at)
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
