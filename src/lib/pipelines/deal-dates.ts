// Date copy for the pipeline board and the deal drawer. Everything in
// here is assembled at runtime (relative ages, "due in N days"), so it
// can't ride the literal EN→PT catalogue in src/lib/i18n*.ts — each
// helper takes the active `Language` instead and returns finished
// pt-BR / en-US text.

import type { Language } from '@/lib/i18n'

const isPt = (lang: Language) => lang === 'pt-BR'
const DAY_MS = 86_400_000

/** "há 4 min" / "4m ago"; falls back to a short date after 30 days. */
export function relativeTime(
  iso: string,
  lang: Language,
  now: number = Date.now(),
): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffSec = Math.max(0, Math.round((now - then) / 1000))
  const pt = isPt(lang)
  if (diffSec < 60) return pt ? 'agora' : 'just now'
  if (diffSec < 3600) {
    const m = Math.floor(diffSec / 60)
    return pt ? `há ${m} min` : `${m}m ago`
  }
  if (diffSec < 86_400) {
    const h = Math.floor(diffSec / 3600)
    return pt ? `há ${h} h` : `${h}h ago`
  }
  if (diffSec < 30 * 86_400) {
    const d = Math.floor(diffSec / 86_400)
    return pt ? `há ${d} d` : `${d}d ago`
  }
  return new Date(then).toLocaleDateString(lang, {
    day: '2-digit',
    month: 'short',
  })
}

/** "12 de set. de 2026" / "Sep 12, 2026". */
export function longDate(iso: string, lang: Language): string {
  const d = parseDateOnly(iso)
  if (!d) return ''
  return d.toLocaleDateString(lang, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** "12 de set. de 2026, 14:32" / "Sep 12, 2026, 2:32 PM". */
export function longDateTime(iso: string, lang: Language): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(lang, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export type CloseDateTone = 'overdue' | 'today' | 'soon' | 'later'

export interface CloseDateInfo {
  /** Signed whole days from today to the close date (negative = past). */
  days: number
  tone: CloseDateTone
  /** Short label for a card: "Atrasado 2 d" / "Hoje" / "Em 3 d" / "18 de set." */
  short: string
  /** Sentence for the drawer: "Fechamento previsto para 18 de set. de 2026 (em 3 dias)". */
  long: string
}

/**
 * `expected_close_date` is a DATE column ("YYYY-MM-DD"). Parsing it
 * with `new Date()` would treat it as UTC midnight and shift the day
 * in western timezones, so it is parsed as a LOCAL calendar day.
 */
export function parseDateOnly(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return Number.isNaN(d.getTime()) ? null : d
  }
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function closeDateInfo(
  value: string,
  lang: Language,
  now: number = Date.now(),
): CloseDateInfo | null {
  const date = parseDateOnly(value)
  if (!date) return null
  const days = Math.round(
    (startOfDay(date.getTime()) - startOfDay(now)) / DAY_MS,
  )
  const pt = isPt(lang)
  const dateLabel = date.toLocaleDateString(lang, {
    day: 'numeric',
    month: 'short',
  })
  const full = date.toLocaleDateString(lang, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })

  let tone: CloseDateTone
  let short: string
  let rel: string
  if (days < 0) {
    tone = 'overdue'
    const n = -days
    short = pt ? `Atrasado ${n} d` : `${n}d overdue`
    rel = pt
      ? `atrasado ${n} ${n === 1 ? 'dia' : 'dias'}`
      : `${n} ${n === 1 ? 'day' : 'days'} overdue`
  } else if (days === 0) {
    tone = 'today'
    short = pt ? 'Hoje' : 'Today'
    rel = pt ? 'hoje' : 'today'
  } else if (days <= 7) {
    tone = 'soon'
    short = pt ? `Em ${days} d` : `In ${days}d`
    rel = pt
      ? `em ${days} ${days === 1 ? 'dia' : 'dias'}`
      : `in ${days} ${days === 1 ? 'day' : 'days'}`
  } else {
    tone = 'later'
    short = dateLabel
    rel = pt ? `em ${days} dias` : `in ${days} days`
  }

  const long = pt
    ? `Fechamento previsto para ${full} (${rel})`
    : `Expected to close ${full} (${rel})`

  return { days, tone, short, long }
}

/** "Movido para Negociação" / "Moved to Negotiation". */
export function movedToLabel(stageName: string, lang: Language): string {
  return isPt(lang) ? `Movido para ${stageName}` : `Moved to ${stageName}`
}

/** "Avançar para Negociação" / "Advance to Negotiation". */
export function advanceToLabel(stageName: string, lang: Language): string {
  return isPt(lang) ? `Avançar para ${stageName}` : `Advance to ${stageName}`
}
