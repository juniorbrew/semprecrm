// ============================================================
// "Origem dos clientes" report (migration 109): the typed face of origin_report() plus the
// pure helpers the Reports section uses. The numbers are computed in SQL; nothing here sums.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { addDays, type ReportPeriod } from '@/lib/support/reports'
import { fromZonedParts } from '@/lib/calendar/range'
import { csvCell } from '@/lib/support/reports'

import { CHANNEL_LABEL, DIRECT_LABEL, type OriginName } from './label'
import type { OriginChannel, OriginReportRow } from './types'

export const REPORT_CHANNELS: readonly OriginChannel[] = ['whatsapp', 'whatsapp_qr', 'instagram', 'messenger', 'site_bot', 'webhook']

export interface OriginReportFilters {
  channel?: OriginChannel | null
  pipelineId?: string | null
}

/** [start, end) as ISO instants: the calendar days `period.from`..`period.to` of the account's time zone. */
export function originPeriodBounds(period: ReportPeriod, timezone: string): { start: string; end: string } {
  const at = (day: string) =>
    fromZonedParts({ year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)), day: Number(day.slice(8, 10)) }, timezone).toISOString()
  return { start: at(period.from), end: at(addDays(period.to, 1)) }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)

export async function fetchOriginReport(
  db: Pick<SupabaseClient, 'rpc'>,
  period: ReportPeriod,
  timezone: string,
  filters: OriginReportFilters = {},
): Promise<OriginReportRow[]> {
  const { start, end } = originPeriodBounds(period, timezone)
  const { data, error } = await db.rpc('origin_report', {
    p_start: start,
    p_end: end,
    p_channel: filters.channel || null,
    p_pipeline_id: filters.pipelineId || null,
  })
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    origin_type: r.origin_type as OriginReportRow['origin_type'],
    channel: (r.channel ?? '') as OriginReportRow['channel'],
    name: String(r.name ?? ''),
    source: String(r.source ?? ''),
    customers: num(r.customers),
    deals_created: num(r.deals_created),
    deals_won: num(r.deals_won),
    won_value: num(r.won_value),
    conversion_pct: num(r.conversion_pct),
    avg_ticket: num(r.avg_ticket),
  }))
}

/** Plain-text name of a report row (CSV, chart axis). Same wording as originLabel(). */
export function originRowLabel(row: Pick<OriginReportRow, 'origin_type' | 'channel' | 'name' | 'source'>): string {
  const channel = row.channel ? CHANNEL_LABEL[row.channel] : ''
  switch (row.origin_type) {
    case 'ad':
      return `${row.name ? `Anúncio "${row.name}"` : 'Anúncio'}${channel ? ` · ${channel}` : ''}`
    case 'campaign':
      return `Campanha "${row.name}"${row.source ? ` · ${row.source}` : ''}${channel ? ` · ${channel}` : ''}`
    case 'referrer':
      return `Site de origem ${row.name}`
    case 'paid':
      return row.name
    default:
      return DIRECT_LABEL
  }
}

/** The row as the same naming object the stored touches use (see originName). */
export function rowOriginName(row: Pick<OriginReportRow, 'origin_type' | 'channel' | 'name' | 'source'>): OriginName {
  const channel = row.channel as OriginChannel
  switch (row.origin_type) {
    case 'ad':
      return { type: 'ad', name: row.name, channel }
    case 'campaign':
      return { type: 'campaign', name: row.name, source: row.source || null, channel }
    case 'referrer':
      return { type: 'referrer', name: row.name, channel }
    case 'paid':
      return { type: 'paid', name: row.name }
    default:
      return { type: 'direct' }
  }
}

/** The origins that sold the most (won value, then won deals), nothing that sold nothing. */
export function topSellingOrigins(rows: OriginReportRow[], limit = 10): OriginReportRow[] {
  return rows
    .filter((r) => r.deals_won > 0)
    .sort((a, b) => b.won_value - a.won_value || b.deals_won - a.deals_won)
    .slice(0, limit)
}

export const ORIGIN_CSV_HEADER = [
  'origem',
  'canal',
  'clientes_novos',
  'negocios_criados',
  'negocios_ganhos',
  'valor_ganho',
  'taxa_de_conversao_pct',
  'ticket_medio',
] as const

/**
 * The report as CSV (same writer and `;` separator as the support report; names are the
 * customer's ad / campaign text, so csvCell defuses formulas).
 */
export function originReportToCsv(period: ReportPeriod, rows: OriginReportRow[]): string {
  const lines = [`periodo;${period.from};${period.to}`, ORIGIN_CSV_HEADER.join(';')]
  for (const r of rows) {
    lines.push(
      [
        csvCell(originRowLabel(r)),
        csvCell(r.channel ? CHANNEL_LABEL[r.channel] : ''),
        r.customers,
        r.deals_created,
        r.deals_won,
        r.won_value.toFixed(2),
        r.conversion_pct,
        r.avg_ticket.toFixed(2),
      ].join(';'),
    )
  }
  // BOM so Excel reads UTF-8 (accents in names), like the support report.
  return `﻿${lines.join('\r\n')}\r\n`
}
