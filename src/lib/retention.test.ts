import { describe, expect, it } from 'vitest'

import { makeFakeDb } from '@/lib/lgpd/fake-db.test-helper'
import { runRetentionPurge } from './retention'

const NOW = new Date('2026-10-01T00:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

describe('runRetentionPurge', () => {
  it('purges only what is past each retention window', async () => {
    const { db, tables } = makeFakeDb({
      flow_runs: [
        { id: 'fr-old', ended_at: daysAgo(91) },
        { id: 'fr-recent', ended_at: daysAgo(10) },
        { id: 'fr-active', ended_at: null },
      ],
      ai_reply_jobs: [
        { id: 'j-done', status: 'done', updated_at: daysAgo(31) },
        { id: 'j-queued', status: 'queued', updated_at: daysAgo(60) },
        { id: 'j-new', status: 'done', updated_at: daysAgo(5) },
      ],
      csat_jobs: [
        { id: 1, processed_at: daysAgo(40) },
        { id: 2, processed_at: null },
      ],
      account_invitations: [
        { id: 'inv-expired', accepted_at: null, expires_at: daysAgo(31) },
        { id: 'inv-accepted', accepted_at: daysAgo(100), expires_at: daysAgo(90) },
        { id: 'inv-fresh', accepted_at: null, expires_at: daysAgo(1) },
      ],
      ai_handoffs: [
        { id: 'h-old', created_at: daysAgo(200), last_customer_words: 'socorro', reason: 'x' },
        { id: 'h-new', created_at: daysAgo(10), last_customer_words: 'oi' },
      ],
    })

    const res = await runRetentionPurge(db, NOW)

    expect(res).toEqual({
      flow_runs: 1,
      ai_reply_jobs: 1,
      csat_jobs: 1,
      account_invitations: 1,
      ai_handoffs: 1,
      lead_source_events: 0,
      audit_log: 0,
    })
    expect(tables.flow_runs.map((r) => r.id)).toEqual(['fr-recent', 'fr-active'])
    expect(tables.ai_reply_jobs.map((r) => r.id)).toEqual(['j-queued', 'j-new'])
    expect(tables.csat_jobs.map((r) => r.id)).toEqual([2])
    expect(tables.account_invitations.map((r) => r.id)).toEqual(['inv-accepted', 'inv-fresh'])
    // The hand-over row stays; only the quote goes.
    expect(tables.ai_handoffs).toEqual([
      { id: 'h-old', created_at: daysAgo(200), last_customer_words: null, reason: 'x' },
      { id: 'h-new', created_at: daysAgo(10), last_customer_words: 'oi' },
    ])
  })

  it('is bounded per tick and isolates failures', async () => {
    const { db, tables } = makeFakeDb(
      { flow_runs: Array.from({ length: 7 }, (_, i) => ({ id: `fr${i}`, ended_at: daysAgo(100) })) },
      { fail: (t) => (t === 'csat_jobs' ? { message: 'down' } : null) },
    )
    const res = await runRetentionPurge(db, NOW, 5)
    expect(res.flow_runs).toBe(5)
    expect(tables.flow_runs).toHaveLength(2)
    expect(res.csat_jobs).toBeNull()
    expect(res.account_invitations).toBe(0)
  })
})
