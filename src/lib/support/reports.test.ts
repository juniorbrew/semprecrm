import { describe, expect, it, vi } from 'vitest'

import {
  CSV_HEADER,
  addDays,
  csvCell,
  fetchSupportBacklog,
  fetchSupportReport,
  formatDuration,
  formatScore,
  isValidPeriod,
  lastDays,
  percent,
  reportsToCsv,
  slaRate,
  todayIn,
  type ReportRow,
} from './reports'

const row = (over: Partial<ReportRow> = {}): ReportRow => ({
  group_key: 'k',
  opened: 10,
  resolved: 8,
  backlog: 2,
  fr_count: 5,
  fr_avg_seconds: 160,
  fr_median_seconds: 120,
  fr_p90_seconds: 264,
  res_count: 8,
  res_avg_seconds: 7200,
  res_median_seconds: 3600,
  res_p90_seconds: 20000,
  sla_met: 6,
  sla_missed: 2,
  reopened: 1,
  csat_sent: 4,
  csat_answered: 3,
  csat_avg: 4.33,
  ...over,
})

describe('periods are calendar days of the account time zone', () => {
  it('todayIn follows the account clock, not the server clock', () => {
    // 2026-03-02 01:30 UTC is still 2026-03-01 in São Paulo (UTC-3), already 03-02 in Tokyo.
    const now = new Date('2026-03-02T01:30:00Z')
    expect(todayIn('America/Sao_Paulo', now)).toBe('2026-03-01')
    expect(todayIn('Asia/Tokyo', now)).toBe('2026-03-02')
    expect(todayIn('Not/AZone', now)).toBe('2026-03-01')
  })
  it('lastDays includes today and goes back N-1 days', () => {
    const now = new Date('2026-03-02T15:00:00Z')
    expect(lastDays(7, 'America/Sao_Paulo', now)).toEqual({ from: '2026-02-24', to: '2026-03-02' })
    expect(lastDays(30, 'America/Sao_Paulo', now)).toEqual({ from: '2026-02-01', to: '2026-03-02' })
  })
  it('addDays crosses months and leap days', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
  it('isValidPeriod: real dates, ordered, at most a year', () => {
    expect(isValidPeriod({ from: '2026-03-01', to: '2026-03-01' })).toBe(true)
    expect(isValidPeriod({ from: '2026-03-02', to: '2026-03-01' })).toBe(false)
    expect(isValidPeriod({ from: '2026-02-31', to: '2026-03-01' })).toBe(false)
    expect(isValidPeriod({ from: '2026-03-1', to: '2026-03-02' })).toBe(false)
    expect(isValidPeriod({ from: '', to: '' })).toBe(false)
    expect(isValidPeriod({ from: '2025-03-01', to: '2026-03-02' })).toBe(true)
    expect(isValidPeriod({ from: '2025-01-01', to: '2026-03-02' })).toBe(false)
  })
})

describe('numbers', () => {
  it('formatDuration', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(0)).toBe('0 s')
    expect(formatDuration(45)).toBe('45 s')
    expect(formatDuration(90)).toBe('2 min')
    expect(formatDuration(3600)).toBe('1 h')
    expect(formatDuration(7500)).toBe('2 h 5 min')
    expect(formatDuration(90000)).toBe('1 d 1 h')
    expect(formatDuration(172800)).toBe('2 d')
  })
  it('slaRate and percent are null with nothing to judge', () => {
    expect(slaRate(0, 0)).toBeNull()
    expect(slaRate(6, 2)).toBe(75)
    expect(percent(1, 10)).toBe(10)
    expect(percent(1, 0)).toBeNull()
  })
  it('formatScore', () => {
    expect(formatScore(null)).toBe('—')
    expect(formatScore(4.333, 'pt-BR')).toBe('4,3')
    expect(formatScore(4.333, 'en-US')).toBe('4.3')
  })
})

describe('rpc wrappers', () => {
  it('pass the period, the group and the filters to support_report', async () => {
    const rpc = vi.fn(async () => ({ data: [row()], error: null }))
    const out = await fetchSupportReport({ rpc } as never, 'acc', { from: '2026-03-01', to: '2026-03-07' }, 'team', { team_id: 't1', channel: 'qr' })
    expect(out).toHaveLength(1)
    expect(rpc).toHaveBeenCalledWith('support_report', {
      p_account_id: 'acc',
      p_from: '2026-03-01',
      p_to: '2026-03-07',
      p_group: 'team',
      p_team_id: 't1',
      p_category_id: null,
      p_agent_id: null,
      p_channel: 'qr',
    })
  })
  it('backlog takes only the filters', async () => {
    const rpc = vi.fn(async () => ({ data: [{ bucket: 'lt1d', total: 3 }], error: null }))
    await fetchSupportBacklog({ rpc } as never, 'acc', { agent_id: 'u1' })
    expect(rpc).toHaveBeenCalledWith('support_report_backlog', { p_account_id: 'acc', p_team_id: null, p_category_id: null, p_agent_id: 'u1', p_channel: null })
  })
  it('a database error is thrown, not swallowed', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'reports are for account admins', code: '42501' } }))
    await expect(fetchSupportReport({ rpc } as never, 'acc', { from: '2026-03-01', to: '2026-03-07' }, 'all')).rejects.toMatchObject({ code: '42501' })
  })
})

describe('CSV', () => {
  it('quotes what needs it and defuses spreadsheet formulas', () => {
    expect(csvCell('Cobrança')).toBe('Cobrança')
    expect(csvCell('a;b')).toBe('"a;b"')
    expect(csvCell('diz "oi"')).toBe('"diz ""oi"""')
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`)
    expect(csvCell('+55')).toBe("'+55")
    expect(csvCell('-1')).toBe("'-1")
    expect(csvCell('@cmd')).toBe("'@cmd")
    expect(csvCell(5)).toBe('5')
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell(null)).toBe('')
  })

  it('writes the period, a header, a row per group and the backlog', () => {
    const csv = reportsToCsv(
      { from: '2026-03-01', to: '2026-03-07' },
      [
        { section: 'visao_geral', label: () => 'total', rows: [row({ group_key: 'all' })] },
        { section: 'equipe', label: (k) => (k === 't1' ? 'Financeiro' : 'Sem definição'), rows: [row({ group_key: 't1' }), row({ group_key: null, csat_avg: null, fr_avg_seconds: null })] },
      ],
      [{ label: 'Menos de 1 dia', total: 3 }],
    )
    const lines = csv.replace('﻿', '').trimEnd().split('\r\n')
    expect(csv.startsWith('﻿')).toBe(true)
    expect(lines[0]).toBe('periodo;2026-03-01;2026-03-07')
    expect(lines[1]).toBe(CSV_HEADER.join(';'))
    expect(lines[2].split(';').slice(0, 5)).toEqual(['visao_geral', 'total', '10', '8', '2'])
    expect(lines[3].startsWith('equipe;Financeiro;')).toBe(true)
    expect(lines[4].split(';')[1]).toBe('Sem definição')
    // no data -> empty cells, not "null"
    expect(lines[4]).not.toContain('null')
    expect(lines[5]).toBe('fila_por_idade;Menos de 1 dia;3')
    // every data line has exactly as many cells as the header
    for (const l of lines.slice(2, 5)) expect(l.split(';')).toHaveLength(CSV_HEADER.length)
  })

  it('only knows names and numbers: the header has no contact, phone, message or comment column', () => {
    expect(CSV_HEADER.join(' ')).not.toMatch(/contato|telefone|phone|mensagem|comentario|email/i)
  })
})
