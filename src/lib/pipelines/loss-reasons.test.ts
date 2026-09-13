import { describe, expect, it } from 'vitest'
import type { Deal, DealLossReason } from '@/types'
import {
  NO_REASON_KEY,
  activeLossReasons,
  aggregateLossReasons,
  canDeleteLossReason,
  dealStatusPatch,
  nextLossReasonPosition,
  noReasonLabel,
  sortLossReasons,
} from './loss-reasons'

const reason = (id: string, name: string, position = 0, is_active = true): DealLossReason => ({
  id,
  account_id: 'acc',
  name,
  position,
  is_active,
  created_at: '2026-09-01T00:00:00Z',
})

const deal = (over: Partial<Deal>): Deal => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  user_id: 'u',
  pipeline_id: 'p',
  stage_id: 's',
  contact_id: null,
  title: 'Deal',
  value: 0,
  status: 'lost',
  created_at: '2026-09-01T00:00:00Z',
  ...over,
})

const REASONS = [
  reason('price', 'Preço', 0),
  reason('silence', 'Sem resposta', 1),
  reason('competitor', 'Escolheu concorrente', 2),
]

describe('aggregateLossReasons', () => {
  it('groups lost deals by reason with count and value, sorted by count desc', () => {
    const deals = [
      deal({ loss_reason_id: 'price', value: 100 }),
      deal({ loss_reason_id: 'price', value: 250 }),
      deal({ loss_reason_id: 'silence', value: 1000 }),
      deal({ loss_reason_id: 'competitor', value: 10 }),
      deal({ loss_reason_id: 'competitor', value: 20 }),
      deal({ loss_reason_id: 'competitor', value: 30 }),
    ]
    expect(aggregateLossReasons(deals, REASONS, 'pt-BR')).toEqual([
      { key: 'competitor', reason: 'Escolheu concorrente', count: 3, value: 60 },
      { key: 'price', reason: 'Preço', count: 2, value: 350 },
      { key: 'silence', reason: 'Sem resposta', count: 1, value: 1000 },
    ])
  })

  it('breaks count ties by value desc', () => {
    const deals = [
      deal({ loss_reason_id: 'price', value: 10 }),
      deal({ loss_reason_id: 'silence', value: 500 }),
    ]
    const keys = aggregateLossReasons(deals, REASONS, 'pt-BR').map((b) => b.key)
    expect(keys).toEqual(['silence', 'price'])
  })

  it('puts null and unknown reasons in the "Sem motivo" bucket', () => {
    const deals = [
      deal({ loss_reason_id: null, value: 5 }),
      deal({ loss_reason_id: undefined, value: 5 }),
      deal({ loss_reason_id: 'deleted-reason', value: 5 }),
      deal({ loss_reason_id: 'price', value: 1 }),
    ]
    const out = aggregateLossReasons(deals, REASONS, 'pt-BR')
    expect(out[0]).toEqual({ key: NO_REASON_KEY, reason: 'Sem motivo', count: 3, value: 15 })
    expect(aggregateLossReasons(deals, REASONS, 'en-US')[0].reason).toBe('No reason')
  })

  it('falls back to the joined loss_reason name when the reason list lacks it', () => {
    const deals = [
      deal({ loss_reason_id: 'x', loss_reason: { id: 'x', name: 'Orçamento' }, value: 1 }),
    ]
    expect(aggregateLossReasons(deals, [], 'pt-BR')).toEqual([
      { key: 'x', reason: 'Orçamento', count: 1, value: 1 },
    ])
  })

  it('ignores open and won deals and coerces numeric strings', () => {
    const deals = [
      deal({ status: 'open', loss_reason_id: 'price', value: 100 }),
      deal({ status: 'won', loss_reason_id: 'price', value: 100 }),
      deal({ loss_reason_id: 'price', value: '12.5' as unknown as number }),
    ]
    expect(aggregateLossReasons(deals, REASONS, 'pt-BR')).toEqual([
      { key: 'price', reason: 'Preço', count: 1, value: 12.5 },
    ])
  })

  it('returns an empty list when nothing is lost', () => {
    expect(aggregateLossReasons([deal({ status: 'open' })], REASONS, 'pt-BR')).toEqual([])
  })
})

describe('ordering helpers', () => {
  it('sorts by position then name and filters active', () => {
    const list = [reason('c', 'C', 2, false), reason('b', 'B', 1), reason('a', 'A', 0)]
    expect(sortLossReasons(list).map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(activeLossReasons(list).map((r) => r.id)).toEqual(['a', 'b'])
    expect(nextLossReasonPosition(list)).toBe(3)
    expect(nextLossReasonPosition([])).toBe(0)
  })
})

describe('dealStatusPatch', () => {
  it('stores reason and trimmed note when marking lost', () => {
    expect(dealStatusPatch('lost', { reasonId: 'price', note: '  caro demais ' })).toEqual({
      status: 'lost',
      loss_reason_id: 'price',
      lost_note: 'caro demais',
    })
    expect(dealStatusPatch('lost', { reasonId: 'price', note: '   ' }).lost_note).toBeNull()
  })

  it('clears both fields when reopening or winning', () => {
    expect(dealStatusPatch('open')).toEqual({ status: 'open', loss_reason_id: null, lost_note: null })
    expect(dealStatusPatch('won')).toEqual({ status: 'won', loss_reason_id: null, lost_note: null })
  })
})

describe('canDeleteLossReason / noReasonLabel', () => {
  it('only allows deleting unused reasons', () => {
    expect(canDeleteLossReason(0)).toBe(true)
    expect(canDeleteLossReason(3)).toBe(false)
  })
  it('labels the null bucket per language', () => {
    expect(noReasonLabel('pt-BR')).toBe('Sem motivo')
    expect(noReasonLabel('en-US')).toBe('No reason')
  })
})
