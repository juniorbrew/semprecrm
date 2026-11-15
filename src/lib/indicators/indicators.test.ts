import { describe, expect, it, vi } from 'vitest'

import { aiIsEmpty, fetchAiReport, fetchTeamReport, sortTeam, winRatePct, type AiReport } from './reports'
import { canHaveSpend, formatRoas, loadSpend, parseMoneyToCents, saveSpend, spendMetrics } from './spend'

const base = { customers: 4, deals_won: 2, won_value: 1500 }

describe('spendMetrics', () => {
  it('cost per customer, cost per sale and return from the spend in cents', () => {
    const m = spendMetrics({ ...base, spend_cents: 30000 })
    expect(m).toEqual({ spend: 300, costPerCustomer: 75, costPerSale: 150, roas: 5 })
  })
  it('no spend typed (null, 0 or garbage): every column is empty', () => {
    const empty = { spend: null, costPerCustomer: null, costPerSale: null, roas: null }
    expect(spendMetrics({ ...base, spend_cents: null })).toEqual(empty)
    expect(spendMetrics({ ...base, spend_cents: 0 })).toEqual(empty)
    expect(spendMetrics({ ...base, spend_cents: Number.NaN })).toEqual(empty)
  })
  it('dividing by zero customers or sales gives null, never Infinity', () => {
    const m = spendMetrics({ customers: 0, deals_won: 0, won_value: 0, spend_cents: 10000 })
    expect(m.costPerCustomer).toBeNull()
    expect(m.costPerSale).toBeNull()
    expect(m.roas).toBe(0)
  })
  it('only named origins that are not "direct" can carry a spend', () => {
    expect(canHaveSpend({ origin_type: 'ad', name: 'Promo' })).toBe(true)
    expect(canHaveSpend({ origin_type: 'direct', name: '' })).toBe(false)
    // "Ad without a title": ad_spend.name must not be blank, so no button for it
    expect(canHaveSpend({ origin_type: 'ad', name: '' })).toBe(false)
  })
})

describe('formatRoas', () => {
  it('one decimal with the reader separator and the times sign', () => {
    expect(formatRoas(4.25, 'pt-BR')).toBe('4,3×')
    expect(formatRoas(4.2, 'pt-BR')).toBe('4,2×')
    expect(formatRoas(0, 'pt-BR')).toBe('0,0×')
    expect(formatRoas(null, 'pt-BR')).toBe('—')
  })
})

describe('parseMoneyToCents', () => {
  it.each([
    ['1.234,56', 123456],
    ['1234.56', 123456],
    ['R$ 1.234', 123400],
    ['1,5', 150],
    ['50', 5000],
    ['0,05', 5],
    ['1.234.567,8', 123456780],
    ['1,234,567', 123456700],
  ])('%s -> %i cents', (text, cents) => expect(parseMoneyToCents(text)).toBe(cents))
  it.each([[''], ['abc'], ['1,234,56x7,891'], ['12,345,6'], ['999999999999']])('"%s" is refused', (text) =>
    expect(parseMoneyToCents(text)).toBeNull(),
  )
})

describe('winRatePct', () => {
  it('won / (won + lost) with one decimal', () => {
    expect(winRatePct(2, 1)).toBe(66.7)
    expect(winRatePct(1, 0)).toBe(100)
    expect(winRatePct(0, 3)).toBe(0)
  })
  it('nothing closed: null, not NaN', () => expect(winRatePct(0, 0)).toBeNull())
})

describe('sortTeam', () => {
  const row = (userId: string, wonValue: number, handled: number) => ({
    userId, handled, resolved: 0, firstResponseAvgSeconds: null, tasksCompleted: 0, openAssigned: 0, dealsWon: 0, dealsLost: 0, wonValue,
  })
  it('the row without an owner is always last, even with the most sold', () => {
    const sorted = sortTeam([row('x', 0, 0), { ...row('x', 9999, 0), userId: null }, row('y', 5, 0)], (id) => id)
    expect(sorted.map((r) => r.userId)).toEqual(['y', 'x', null])
  })
  it('most sold first, then the busiest, then by name', () => {
    const names: Record<string, string> = { a: 'Zé', b: 'Ana', c: 'Bia', d: 'Caio' }
    const sorted = sortTeam([row('a', 0, 5), row('b', 100, 1), row('c', 0, 5), row('d', 0, 9)], (id) => names[id])
    expect(sorted.map((r) => r.userId)).toEqual(['b', 'd', 'c', 'a'])
  })
})

describe('fetchAiReport / fetchTeamReport', () => {
  const period = { from: '2026-11-01', to: '2026-11-30' }
  it('asks ai_report for the period in the time zone and maps the row', async () => {
    const rpc = vi.fn(async () => ({
      data: [{ ai_enabled: true, attended: 3, handed_off: '2', top_reason: 'preco', top_reason_count: 2, resolved_without_person: 1, ai_messages: 4,
        cost_by_feature: [{ feature: 'auto_reply', calls: 2, cost_cents: '15.0' }] }],
      error: null,
    }))
    const r = await fetchAiReport({ rpc } as never, 'acc', period, 'America/Sao_Paulo')
    expect(rpc).toHaveBeenCalledWith('ai_report', { p_account_id: 'acc', p_start: '2026-11-01T03:00:00.000Z', p_end: '2026-12-01T03:00:00.000Z' })
    expect(r).toEqual({ enabled: true, attended: 3, handedOff: 2, topReason: 'preco', topReasonCount: 2, resolvedWithoutPerson: 1, messages: 4,
      costByFeature: [{ feature: 'auto_reply', calls: 2, costCents: 15 }] })
  })
  it('an agent gets no cost (null), and an empty answer is all zeros', async () => {
    const r = await fetchAiReport({ rpc: async () => ({ data: [{ ai_enabled: false, cost_by_feature: null }], error: null }) } as never, 'acc', period, 'UTC')
    expect(r.costByFeature).toBeNull()
    expect(r.attended).toBe(0)
    expect(r.topReason).toBeNull()
    expect((await fetchAiReport({ rpc: async () => ({ data: [], error: null }) } as never, 'acc', period, 'UTC')).enabled).toBe(false)
  })
  it('throws the database error', async () => {
    await expect(fetchAiReport({ rpc: async () => ({ data: null, error: new Error('x') }) } as never, 'acc', period, 'UTC')).rejects.toThrow('x')
    await expect(fetchTeamReport({ rpc: async () => ({ data: null, error: new Error('y') }) } as never, 'acc', period, 'UTC')).rejects.toThrow('y')
  })
  it('a null user_id (deals without an owner) stays null', async () => {
    const rows = await fetchTeamReport({ rpc: async () => ({ data: [{ user_id: null, deals_won: 1, deals_lost: 2, won_value: 5 }], error: null }) } as never, 'acc', period, 'UTC')
    expect(rows[0]).toMatchObject({ userId: null, dealsWon: 1, dealsLost: 2, wonValue: 5 })
  })
  it('maps the team rows and keeps a missing first response as null', async () => {
    const rpc = vi.fn(async () => ({
      data: [{ user_id: 'u1', handled: 1, resolved: 2, first_response_avg_seconds: null, tasks_completed: 3, open_assigned: 4, deals_won: 5, deals_lost: 6, won_value: '7.5' }],
      error: null,
    }))
    const rows = await fetchTeamReport({ rpc } as never, 'acc', period, 'UTC')
    expect(rpc).toHaveBeenCalledWith('team_report', { p_account_id: 'acc', p_start: '2026-11-01T00:00:00.000Z', p_end: '2026-12-01T00:00:00.000Z' })
    expect(rows).toEqual([{ userId: 'u1', handled: 1, resolved: 2, firstResponseAvgSeconds: null, tasksCompleted: 3, openAssigned: 4, dealsWon: 5, dealsLost: 6, wonValue: 7.5 }])
  })
})

describe('aiIsEmpty', () => {
  const r = (over: Partial<AiReport> = {}): AiReport => ({ enabled: false, attended: 0, handedOff: 0, topReason: null, topReasonCount: 0, resolvedWithoutPerson: 0, messages: 0, costByFeature: [], ...over })
  it('AI off and nothing in the period is empty; any trace or the switch on is not', () => {
    expect(aiIsEmpty(r())).toBe(true)
    expect(aiIsEmpty(r({ enabled: true }))).toBe(false)
    expect(aiIsEmpty(r({ attended: 1 }))).toBe(false)
    expect(aiIsEmpty(r({ costByFeature: [{ feature: 'triage', calls: 1, costCents: 1 }] }))).toBe(false)
  })
})

describe('loadSpend / saveSpend', () => {
  const key = { origin_type: 'ad', channel: 'instagram', name: 'Promo', source: '' } as const
  it('reads the amount of one bucket and month', async () => {
    const eqs: [string, unknown][] = []
    const chain: Record<string, unknown> = {}
    chain.eq = (c: string, v: unknown) => (eqs.push([c, v]), chain)
    chain.maybeSingle = async () => ({ data: { amount_cents: '12345' }, error: null })
    const db = { from: () => ({ select: () => chain }) }
    expect(await loadSpend(db as never, 'acc-1', key, '2026-11')).toBe(12345)
    expect(eqs).toContainEqual(['account_id', 'acc-1'])
    expect(eqs).toContainEqual(['month', '2026-11-01'])
    expect(eqs).toContainEqual(['name', 'Promo'])
  })
  it('no row is null; an error throws', async () => {
    const mk = (res: unknown) => ({ from: () => ({ select: () => { const c: Record<string, unknown> = {}; c.eq = () => c; c.maybeSingle = async () => res; return c } }) })
    expect(await loadSpend(mk({ data: null, error: null }) as never, 'acc-1', key, '2026-11')).toBeNull()
    await expect(loadSpend(mk({ data: null, error: new Error('rls') }) as never, 'acc-1', key, '2026-11')).rejects.toThrow('rls')
  })
  it('upserts on the unique key with the first day of the month', async () => {
    const upsert = vi.fn(async () => ({ error: null }))
    await saveSpend({ from: () => ({ upsert }) } as never, 'acc', key, '2026-11', 5000)
    expect(upsert).toHaveBeenCalledWith(
      { account_id: 'acc', ...key, month: '2026-11-01', amount_cents: 5000 },
      { onConflict: 'account_id,origin_type,channel,name,source,month' },
    )
    await expect(saveSpend({ from: () => ({ upsert: async () => ({ error: new Error('no') }) }) } as never, 'acc', key, '2026-11', 1)).rejects.toThrow('no')
  })
})
