import { describe, expect, it, vi } from 'vitest'

import { applyOriginFilter, cleanOriginText, hasOriginFilter, ORIGIN_EMBED } from './filter'
import {
  fetchOriginReport,
  originPeriodBounds,
  originReportToCsv,
  originRowLabel,
  rowOriginName,
  topSellingOrigins,
} from './report'
import type { OriginReportRow } from './types'

const row = (over: Partial<OriginReportRow> = {}): OriginReportRow => ({
  origin_type: 'ad',
  channel: 'instagram',
  name: 'Promoção sofás',
  source: '',
  customers: 2,
  deals_created: 3,
  deals_won: 2,
  won_value: 1500,
  conversion_pct: 66.7,
  avg_ticket: 750,
  ...over,
})

describe('originPeriodBounds', () => {
  it('calendar days of the account time zone, end exclusive', () => {
    expect(originPeriodBounds({ from: '2026-11-01', to: '2026-11-30' }, 'America/Sao_Paulo')).toEqual({
      start: '2026-11-01T03:00:00.000Z',
      end: '2026-12-01T03:00:00.000Z',
    })
    expect(originPeriodBounds({ from: '2026-12-31', to: '2026-12-31' }, 'UTC')).toEqual({
      start: '2026-12-31T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z',
    })
  })
})

describe('fetchOriginReport', () => {
  it('passes the bounds and filters, and turns numeric strings into numbers', async () => {
    const rpc = vi.fn(async () => ({
      data: [{ origin_type: 'direct', channel: '', name: '', source: '', customers: 1, deals_created: '2', deals_won: 0, won_value: '12.50', conversion_pct: 0, avg_ticket: 0 }],
      error: null,
    }))
    const rows = await fetchOriginReport({ rpc } as never, { from: '2026-11-01', to: '2026-11-01' }, 'UTC', { channel: 'whatsapp', pipelineId: 'p1' })
    expect(rpc).toHaveBeenCalledWith('origin_report', {
      p_start: '2026-11-01T00:00:00.000Z',
      p_end: '2026-11-02T00:00:00.000Z',
      p_channel: 'whatsapp',
      p_pipeline_id: 'p1',
    })
    expect(rows[0]).toMatchObject({ deals_created: 2, won_value: 12.5, origin_type: 'direct' })
  })
  it('throws the database error and treats null data as empty', async () => {
    await expect(fetchOriginReport({ rpc: async () => ({ data: null, error: new Error('x') }) } as never, { from: '2026-11-01', to: '2026-11-01' }, 'UTC')).rejects.toThrow('x')
    expect(await fetchOriginReport({ rpc: async () => ({ data: null, error: null }) } as never, { from: '2026-11-01', to: '2026-11-01' }, 'UTC')).toEqual([])
  })
})

describe('naming and ranking', () => {
  it('labels rows like stored touches', () => {
    expect(originRowLabel(row())).toBe('Anúncio "Promoção sofás" · Instagram')
    expect(originRowLabel(row({ origin_type: 'campaign', channel: 'site_bot', name: 'bf', source: 'google' }))).toBe('Campanha "bf" · google · Site')
    expect(originRowLabel(row({ origin_type: 'referrer', channel: 'site_bot', name: 'blog.example.org' }))).toBe('Site de origem blog.example.org')
    expect(originRowLabel(row({ origin_type: 'direct', channel: '', name: '' }))).toBe('Direto ou não identificado')
    expect(rowOriginName(row({ origin_type: 'campaign', source: '' }))).toMatchObject({ type: 'campaign', source: null })
  })
  it('top selling: by value then by won deals, only what sold, capped', () => {
    const rows = [
      row({ name: 'a', won_value: 100, deals_won: 1 }),
      row({ name: 'b', won_value: 500, deals_won: 1 }),
      row({ name: 'c', won_value: 0, deals_won: 0 }),
      row({ name: 'd', won_value: 100, deals_won: 3 }),
    ]
    expect(topSellingOrigins(rows).map((r) => r.name)).toEqual(['b', 'd', 'a'])
    expect(topSellingOrigins(rows, 2).map((r) => r.name)).toEqual(['b', 'd'])
    expect(topSellingOrigins([])).toEqual([])
  })
})

describe('originReportToCsv', () => {
  it('writes the period, the header and one line per origin (with BOM)', () => {
    const csv = originReportToCsv({ from: '2026-11-01', to: '2026-11-30' }, [row(), row({ origin_type: 'direct', channel: '', name: '', won_value: 0, deals_won: 0, avg_ticket: 0, conversion_pct: 0 })])
    const lines = csv.replace('﻿', '').trimEnd().split('\r\n')
    expect(csv.startsWith('﻿')).toBe(true)
    expect(lines[0]).toBe('periodo;2026-11-01;2026-11-30')
    expect(lines[1]).toBe('origem;canal;clientes_novos;negocios_criados;negocios_ganhos;valor_ganho;taxa_de_conversao_pct;ticket_medio')
    expect(lines[2]).toBe('"Anúncio ""Promoção sofás"" · Instagram";Instagram;2;3;2;1500.00;66.7;750.00')
    expect(lines[3]).toBe('Direto ou não identificado;;2;3;0;0.00;0;0.00')
  })
  it('a name full of separators, quotes and newlines stays in one cell', () => {
    const csv = originReportToCsv({ from: '2026-11-01', to: '2026-11-30' }, [row({ name: 'a;b"c\nd' })])
    expect(csv).toContain('"Anúncio ""a;b""c\nd"" · Instagram"')
  })
})

describe('contacts origin filter', () => {
  it('detects when a filter is on (channel or any real text)', () => {
    expect(hasOriginFilter({ channel: '', text: '' })).toBe(false)
    expect(hasOriginFilter({ channel: '', text: ' ,() ' })).toBe(false)
    expect(hasOriginFilter({ channel: 'instagram', text: '' })).toBe(true)
    expect(hasOriginFilter({ channel: '', text: 'sofás' })).toBe(true)
    expect(ORIGIN_EMBED).toContain('contacts_first_origin_id_fkey!inner')
  })
  it('strips the characters that mean something inside or=(...)', () => {
    expect(cleanOriginText('a,b(c)d%e*f\\g"h')).toBe('a b c d e f g h')
    expect(cleanOriginText('x'.repeat(500))).toHaveLength(100)
  })
  it('filters the embedded first touch by channel and by ad / campaign / ref text', () => {
    const calls: unknown[][] = []
    const q = {
      eq(...a: unknown[]) {
        calls.push(['eq', ...a])
        return q
      },
      or(...a: unknown[]) {
        calls.push(['or', ...a])
        return q
      },
    }
    applyOriginFilter(q, { channel: 'instagram', text: ' Black Friday ' })
    expect(calls).toEqual([
      ['eq', 'first_origin.channel', 'instagram'],
      ['or', 'headline.ilike.%Black Friday%,utm_campaign.ilike.%Black Friday%,source_id.ilike.%Black Friday%', { referencedTable: 'first_origin' }],
    ])
    calls.length = 0
    applyOriginFilter(q, { channel: '', text: '' })
    applyOriginFilter(q, { channel: 'telegram' as never, text: '' })
    expect(calls).toEqual([])
  })
})
