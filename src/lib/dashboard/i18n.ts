// Dashboard copy that can't go through the literal catalogue in
// src/lib/i18n*.ts because it is assembled at runtime (counts,
// pluralisation, relative times, chart labels). Every helper takes
// the active `Language` from useLanguage() so the widgets stay pure
// and the DOM translator never has to guess at split text nodes
// like `{n} deals`.
//
// Static strings still go through `t()` / the catalogue; this file
// only owns the dynamic ones.

import type { Language } from '@/lib/i18n'
import { DOW_SHORT_MON_FIRST } from './date-utils'
import type { ActivityEvent, ActivityItem } from './types'

const isPt = (lang: Language) => lang === 'pt-BR'

/** Portuguese-style plural: "1 negócio" / "3 negócios". */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

function num(n: number, lang: Language): string {
  return n.toLocaleString(lang)
}

// --- Range toggle -----------------------------------------------------

export function rangeLabel(days: number, lang: Language): string {
  return isPt(lang) ? `${days} dias` : `${days} days`
}

// --- Counts -----------------------------------------------------------

/** Funnel legend: "1 negócio" / "3 negócios" / "1 deal" / "3 deals". */
export function dealsCount(n: number, lang: Language): string {
  return isPt(lang)
    ? `${num(n, lang)} ${plural(n, 'negócio', 'negócios')}`
    : `${num(n, lang)} ${plural(n, 'deal', 'deals')}`
}

/** KPI subtitle: "5 negócios abertos" / "5 open deals". */
export function openDealsCount(n: number, lang: Language): string {
  return isPt(lang)
    ? `${num(n, lang)} ${plural(n, 'negócio aberto', 'negócios abertos')}`
    : `${num(n, lang)} ${plural(n, 'open deal', 'open deals')}`
}

/**
 * KPI delta line. Kept short on purpose so all four cards stay on a
 * single line at 1440px (the long "novos hoje em relação a ontem"
 * copy wrapped and broke the card baselines).
 */
export function deltaVsYesterday(delta: number, lang: Language): string {
  if (delta === 0) return isPt(lang) ? 'Igual a ontem' : 'Same as yesterday'
  const sign = delta > 0 ? '+' : ''
  return isPt(lang)
    ? `${sign}${num(delta, lang)} vs. ontem`
    : `${sign}${num(delta, lang)} vs. yesterday`
}

// --- Time -------------------------------------------------------------

/**
 * Compact relative time for the activity feed. pt-BR follows the
 * automations module ("há 4 min", "há 1 h", "há 2 d"); anything older
 * than 30 days falls back to a locale date.
 */
export function relativeTime(iso: string, lang: Language, now: number = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffSec = Math.max(0, Math.round((now - then) / 1000))
  const pt = isPt(lang)
  if (diffSec < 60) return pt ? 'agora' : 'just now'
  if (diffSec < 3600) {
    const m = Math.floor(diffSec / 60)
    return pt ? `há ${m} min` : `${m}m ago`
  }
  if (diffSec < 86400) {
    const h = Math.floor(diffSec / 3600)
    return pt ? `há ${h} h` : `${h}h ago`
  }
  if (diffSec < 2_592_000) {
    const d = Math.floor(diffSec / 86400)
    return pt ? `há ${d} d` : `${d}d ago`
  }
  return new Date(then).toLocaleDateString(lang, { day: '2-digit', month: 'short' })
}

/** "Atualizado às 14:32" / "Updated at 2:32 PM". */
export function updatedAtLabel(date: Date, lang: Language): string {
  const time = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(date)
  return isPt(lang) ? `Atualizado às ${time}` : `Updated at ${time}`
}

// --- Response time ----------------------------------------------------

function oneDecimal(v: number, lang: Language): string {
  return v.toLocaleString(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/** Header figures: "4,2 min" / "35 s" / "1,5 h" (en: "4.2m", "35s", "1.5h"). */
export function minutesLabel(mins: number | null, lang: Language): string {
  if (mins == null) return '—'
  const pt = isPt(lang)
  if (mins < 1) {
    const s = Math.max(1, Math.round(mins * 60))
    return pt ? `${s} s` : `${s}s`
  }
  if (mins < 60) return pt ? `${oneDecimal(mins, lang)} min` : `${oneDecimal(mins, lang)}m`
  const h = mins / 60
  return pt ? `${oneDecimal(h, lang)} h` : `${oneDecimal(h, lang)}h`
}

/**
 * Y-axis tick / tooltip formatter. Drops a trailing ".0" so the axis
 * reads "12 min" instead of "12,0 min" and never overflows its slot.
 */
export function minutesAxisLabel(v: number, lang: Language): string {
  const rounded = Math.round(v * 10) / 10
  const text = Number.isInteger(rounded)
    ? rounded.toLocaleString(lang)
    : oneDecimal(rounded, lang)
  return isPt(lang) ? `${text} min` : `${text}m`
}

/** The "meta 5 min" / "target 5m" pill. */
export function targetLabel(minutes: number, lang: Language): string {
  return isPt(lang) ? `meta ${minutes} min` : `target ${minutes}m`
}

/** Monday-first weekday abbreviations for the bar chart's x-axis. */
const DOW_SHORT_MON_FIRST_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

export function dowShort(lang: Language): readonly string[] {
  return isPt(lang) ? DOW_SHORT_MON_FIRST : DOW_SHORT_MON_FIRST_EN
}

// --- Line chart date labels ------------------------------------------

function parseDayKey(key: string): Date {
  // key is YYYY-MM-DD; building a local Date avoids timezone-shift
  // surprises across midnight.
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** "17 abr" / "Apr 17". */
export function shortDayLabel(key: string, lang: Language): string {
  return parseDayKey(key)
    .toLocaleDateString(lang, { month: 'short', day: 'numeric' })
    .replace('.', '')
}

/** "sex., 17 de abr." → "sex, 17 abr" / "Fri, Apr 17". */
export function longDayLabel(key: string, lang: Language): string {
  return parseDayKey(key)
    .toLocaleDateString(lang, { weekday: 'short', month: 'short', day: 'numeric' })
    .replace(/\./g, '')
    .replace(' de ', ' ')
}

/** Tooltip rows: "3 recebidas" / "3 incoming". */
export function directionCount(n: number, direction: 'incoming' | 'outgoing', lang: Language): string {
  const word = isPt(lang)
    ? direction === 'incoming' ? 'recebidas' : 'enviadas'
    : direction
  return `${num(n, lang)} ${word}`
}

// --- Activity feed ----------------------------------------------------

/** "Exibindo 5 de 43" / "Showing 5 of 43" (+ when the list is capped). */
export function showingLabel(visible: number, total: number, capped: boolean, lang: Language): string {
  const totalText = `${num(total, lang)}${capped ? '+' : ''}`
  return isPt(lang)
    ? `Exibindo ${num(visible, lang)} de ${totalText}`
    : `Showing ${num(visible, lang)} of ${totalText}`
}

const BROADCAST_STATUS_PT: Record<string, string> = {
  draft: 'rascunho',
  scheduled: 'agendado',
  sending: 'enviando',
  sent: 'enviado',
  failed: 'falhou',
  cancelled: 'cancelado',
  canceled: 'cancelado',
}

function q(text: string, lang: Language): string {
  return isPt(lang) ? `“${text}”` : `"${text}"`
}

/** Renders a structured activity event in the active language. */
export function activityEventText(event: ActivityEvent, lang: Language): string {
  const pt = isPt(lang)
  switch (event.type) {
    case 'message': {
      const who = event.who ?? (pt ? 'Desconhecido' : 'Unknown')
      return pt ? `Nova mensagem de ${who}` : `New message from ${who}`
    }
    case 'contact':
      return pt ? `Novo contato: ${event.who}` : `New contact: ${event.who}`
    case 'deal': {
      const title = q(event.title, lang)
      if (event.stage) {
        return pt ? `Negócio ${title} em ${event.stage}` : `Deal ${title} in ${event.stage}`
      }
      return pt ? `Negócio ${title} atualizado` : `Deal ${title} updated`
    }
    case 'broadcast': {
      const name = q(event.name, lang)
      const n = num(event.recipients, lang)
      if (event.status === 'sent') {
        return pt
          ? `Disparo ${name} enviado para ${n} ${plural(event.recipients, 'contato', 'contatos')}`
          : `Broadcast ${name} sent to ${n} ${plural(event.recipients, 'contact', 'contacts')}`
      }
      const status = pt ? (BROADCAST_STATUS_PT[event.status] ?? event.status) : event.status
      return pt
        ? `Disparo ${name} ${status} (${n} ${plural(event.recipients, 'destinatário', 'destinatários')})`
        : `Broadcast ${name} ${status} (${n} ${plural(event.recipients, 'recipient', 'recipients')})`
    }
    case 'automation': {
      const name = q(event.name ?? (pt ? 'Automação' : 'Automation'), lang)
      const who = event.who ?? (pt ? 'um contato' : 'a contact')
      if (event.failed) {
        return pt ? `Automação ${name} falhou para ${who}` : `Automation ${name} failed for ${who}`
      }
      return pt ? `Automação ${name} acionada para ${who}` : `Automation ${name} triggered for ${who}`
    }
  }
}

/** Feed row text: structured event when present, pre-formatted fallback otherwise. */
export function activityText(item: ActivityItem, lang: Language): string {
  return item.event ? activityEventText(item.event, lang) : item.text
}
