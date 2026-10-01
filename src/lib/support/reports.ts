// ============================================================
// Support reports (migration 075) — the typed face of `support_report()`
// and `support_report_backlog()`, plus the pure helpers the /reports page and
// the CSV route share: periods (calendar days of the account's time zone),
// durations, percentages and the CSV writer.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Language } from '@/lib/i18n'

export type ReportGroup = 'all' | 'category' | 'team' | 'agent' | 'priority'
export type ReportChannel = 'official' | 'qr'

/** One row of `support_report()`: `group_key` is an id (or a priority), null = none. */
export interface ReportRow {
  group_key: string | null
  opened: number
  resolved: number
  backlog: number
  fr_count: number
  fr_avg_seconds: number | null
  fr_median_seconds: number | null
  fr_p90_seconds: number | null
  res_count: number
  res_avg_seconds: number | null
  res_median_seconds: number | null
  res_p90_seconds: number | null
  sla_met: number
  sla_missed: number
  reopened: number
  csat_sent: number
  csat_answered: number
  csat_avg: number | null
}

export type BacklogBucket = 'lt1d' | 'd1_3' | 'd3_7' | 'gt7'
export const BACKLOG_BUCKETS: readonly BacklogBucket[] = ['lt1d', 'd1_3', 'd3_7', 'gt7']
export interface BacklogRow {
  bucket: BacklogBucket
  total: number
}

export interface ReportFilters {
  team_id?: string | null
  category_id?: string | null
  agent_id?: string | null
  channel?: ReportChannel | null
}

/** Calendar days, inclusive, `YYYY-MM-DD`, in the account's time zone. */
export interface ReportPeriod {
  from: string
  to: string
}

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo'
export const MAX_PERIOD_DAYS = 366
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Today's date (`YYYY-MM-DD`) as the account's clock reads it. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

function parseDay(day: string): number {
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))
}

/** `day` plus `n` calendar days (negative to go back); pure date arithmetic, no zone. */
export function addDays(day: string, n: number): string {
  return new Date(parseDay(day) + n * 86_400_000).toISOString().slice(0, 10)
}

/** The last `days` days including today. */
export function lastDays(days: 7 | 30 | 90, timezone: string, now: Date = new Date()): ReportPeriod {
  const to = todayIn(timezone, now)
  return { from: addDays(to, -(days - 1)), to }
}

/** A period the database accepts: real dates, from <= to, at most a year. */
export function isValidPeriod(p: ReportPeriod): boolean {
  if (!DATE_RE.test(p.from) || !DATE_RE.test(p.to)) return false
  if (Number.isNaN(parseDay(p.from)) || Number.isNaN(parseDay(p.to))) return false
  // Reject 2026-02-31 (JS would roll it over).
  if (addDays(p.from, 0) !== p.from || addDays(p.to, 0) !== p.to) return false
  const span = (parseDay(p.to) - parseDay(p.from)) / 86_400_000
  return span >= 0 && span <= MAX_PERIOD_DAYS
}

const rpcArgs = (accountId: string, filters: ReportFilters) => ({
  p_account_id: accountId,
  p_team_id: filters.team_id || null,
  p_category_id: filters.category_id || null,
  p_agent_id: filters.agent_id || null,
  p_channel: filters.channel || null,
})

export async function fetchSupportReport(
  supabase: Pick<SupabaseClient, 'rpc'>,
  accountId: string,
  period: ReportPeriod,
  group: ReportGroup,
  filters: ReportFilters = {},
): Promise<ReportRow[]> {
  const { data, error } = await supabase.rpc('support_report', {
    ...rpcArgs(accountId, filters),
    p_from: period.from,
    p_to: period.to,
    p_group: group,
  })
  if (error) throw error
  return (data ?? []) as ReportRow[]
}

export async function fetchSupportBacklog(
  supabase: Pick<SupabaseClient, 'rpc'>,
  accountId: string,
  filters: ReportFilters = {},
): Promise<BacklogRow[]> {
  const { data, error } = await supabase.rpc('support_report_backlog', rpcArgs(accountId, filters))
  if (error) throw error
  return (data ?? []) as BacklogRow[]
}

// ---- derived numbers -------------------------------------------------

/** met / (met + missed) as a whole percent, null when nothing was judged. */
export function slaRate(met: number, missed: number): number | null {
  const total = met + missed
  return total > 0 ? Math.round((met / total) * 100) : null
}

export function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null
}

/** "2 h 5 min", "45 min", "30 s", "3 d 4 h"; "—" when there is no data. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  const min = Math.round(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`
}

export function formatScore(score: number | null | undefined, language: Language = 'pt-BR'): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return '—'
  return score.toLocaleString(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

// ---- copy ----------------------------------------------------------------

export interface ReportsCopy {
  title: string
  intro: string
  period: string
  days: (n: number) => string
  custom: string
  from: string
  to: string
  team: string
  category: string
  agent: string
  channel: string
  channels: Record<ReportChannel, string>
  all: string
  none: string
  export: string
  loading: string
  error: string
  retry: string
  forbidden: string
  empty: string
  overview: string
  byCategory: string
  byTeam: string
  byAgent: string
  byPriority: string
  backlogByAge: string
  metrics: {
    opened: string
    resolved: string
    backlog: string
    firstResponse: string
    resolution: string
    median: string
    p90: string
    sla: string
    reopenRate: string
    csat: string
    csatRate: string
    csatAnswers: (answered: number, sent: number) => string
  }
  columns: {
    group: string
    opened: string
    resolved: string
    firstResponse: string
    resolution: string
    csat: string
    sla: string
    met: string
    missed: string
    total: string
  }
  buckets: Record<BacklogBucket, string>
  priorities: Record<string, string>
}

const COPY: Record<Language, ReportsCopy> = {
  'pt-BR': {
    title: 'Relatórios',
    intro: 'Atendimento no período: volume, tempos, prazos e satisfação.',
    period: 'Período',
    days: (n) => `${n} dias`,
    custom: 'Personalizado',
    from: 'De',
    to: 'Até',
    team: 'Equipe',
    category: 'Categoria',
    agent: 'Atendente',
    channel: 'Canal',
    channels: { official: 'API oficial', qr: 'QR code' },
    all: 'Todos',
    none: 'Sem definição',
    export: 'Exportar CSV',
    loading: 'Carregando',
    error: 'Não foi possível carregar os relatórios.',
    retry: 'Tentar de novo',
    forbidden: 'Somente administradores veem os relatórios.',
    empty: 'Nenhuma conversa no período.',
    overview: 'Visão geral',
    byCategory: 'Por categoria',
    byTeam: 'Por equipe',
    byAgent: 'Por atendente',
    byPriority: 'Por prioridade',
    backlogByAge: 'Fila por idade',
    metrics: {
      opened: 'Abertas',
      resolved: 'Resolvidas',
      backlog: 'Em aberto agora',
      firstResponse: 'Primeira resposta',
      resolution: 'Resolução',
      median: 'mediana',
      p90: 'p90',
      sla: 'Prazos cumpridos',
      reopenRate: 'Reabertas',
      csat: 'Satisfação',
      csatRate: 'Respostas',
      csatAnswers: (a, s) => `${a} de ${s}`,
    },
    columns: {
      group: '',
      opened: 'Abertas',
      resolved: 'Resolvidas',
      firstResponse: 'Primeira resposta',
      resolution: 'Resolução',
      csat: 'Nota',
      sla: 'Prazos',
      met: 'Cumpridos',
      missed: 'Estourados',
      total: 'Conversas',
    },
    buckets: { lt1d: 'Menos de 1 dia', d1_3: '1 a 3 dias', d3_7: '3 a 7 dias', gt7: 'Mais de 7 dias' },
    priorities: { low: 'Baixa', normal: 'Normal', high: 'Alta', urgent: 'Urgente' },
  },
  'en-US': {
    title: 'Reports',
    intro: 'Support in the period: volume, times, deadlines and satisfaction.',
    period: 'Period',
    days: (n) => `${n} days`,
    custom: 'Custom',
    from: 'From',
    to: 'To',
    team: 'Team',
    category: 'Category',
    agent: 'Agent',
    channel: 'Channel',
    channels: { official: 'Official API', qr: 'QR code' },
    all: 'All',
    none: 'Not set',
    export: 'Export CSV',
    loading: 'Loading',
    error: 'Could not load the reports.',
    retry: 'Try again',
    forbidden: 'Only admins can see the reports.',
    empty: 'No conversations in the period.',
    overview: 'Overview',
    byCategory: 'By category',
    byTeam: 'By team',
    byAgent: 'By agent',
    byPriority: 'By priority',
    backlogByAge: 'Backlog by age',
    metrics: {
      opened: 'Opened',
      resolved: 'Resolved',
      backlog: 'Open now',
      firstResponse: 'First response',
      resolution: 'Resolution',
      median: 'median',
      p90: 'p90',
      sla: 'Deadlines met',
      reopenRate: 'Reopened',
      csat: 'Satisfaction',
      csatRate: 'Answers',
      csatAnswers: (a, s) => `${a} of ${s}`,
    },
    columns: {
      group: '',
      opened: 'Opened',
      resolved: 'Resolved',
      firstResponse: 'First response',
      resolution: 'Resolution',
      csat: 'Score',
      sla: 'Deadlines',
      met: 'Met',
      missed: 'Missed',
      total: 'Conversations',
    },
    buckets: { lt1d: 'Under 1 day', d1_3: '1 to 3 days', d3_7: '3 to 7 days', gt7: 'Over 7 days' },
    priorities: { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' },
  },
}

export function reportsCopy(language: Language): ReportsCopy {
  return COPY[language] ?? COPY['pt-BR']
}

// ---- CSV ---------------------------------------------------------------------

/**
 * One CSV cell. Quotes when needed, and a leading = + - @ (or tab / CR) is
 * defused with a quote so a name like "=HYPERLINK(...)" is text in a
 * spreadsheet, not a formula.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  let text = String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export interface CsvSection {
  section: string
  /** Display name of a group key (category / team / agent / priority). */
  label: (key: string | null) => string
  rows: ReportRow[]
}

export const CSV_HEADER = [
  'secao',
  'grupo',
  'abertas',
  'resolvidas',
  'em_aberto_agora',
  'primeira_resposta_media_s',
  'primeira_resposta_mediana_s',
  'primeira_resposta_p90_s',
  'resolucao_media_s',
  'resolucao_mediana_s',
  'resolucao_p90_s',
  'prazos_cumpridos',
  'prazos_estourados',
  'reabertas',
  'pesquisas_enviadas',
  'pesquisas_respondidas',
  'nota_media',
] as const

const sec = (n: number | null) => (n === null ? '' : Math.round(n))

/**
 * The reports as one CSV: a row per group of every section, then the backlog
 * by age. Names of categories / teams / agents only; no contact, phone,
 * message or comment ever reaches this function.
 */
export function reportsToCsv(
  period: ReportPeriod,
  sections: CsvSection[],
  backlog: { label: string; total: number }[],
): string {
  const lines: string[] = [`periodo;${period.from};${period.to}`, CSV_HEADER.join(';')]
  for (const s of sections) {
    for (const r of s.rows) {
      lines.push(
        [
          s.section,
          s.label(r.group_key),
          r.opened,
          r.resolved,
          r.backlog,
          sec(r.fr_avg_seconds),
          sec(r.fr_median_seconds),
          sec(r.fr_p90_seconds),
          sec(r.res_avg_seconds),
          sec(r.res_median_seconds),
          sec(r.res_p90_seconds),
          r.sla_met,
          r.sla_missed,
          r.reopened,
          r.csat_sent,
          r.csat_answered,
          r.csat_avg ?? '',
        ]
          .map(csvCell)
          .join(';'),
      )
    }
  }
  for (const b of backlog) lines.push(['fila_por_idade', b.label, b.total].map(csvCell).join(';'))
  // BOM so Excel reads UTF-8 (accents in names).
  return `﻿${lines.join('\r\n')}\r\n`
}
