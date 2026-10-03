// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Deal, PipelineStage } from '@/types'
import {
  pipelineStats,
  readBoardDensity,
  stageProbability,
  writeBoardDensity,
} from './board'

const stage = (id: string, position: number) =>
  ({ id, position, pipeline_id: 'p', name: id, color: '#000' }) as PipelineStage
const deal = (p: Partial<Deal>) =>
  ({ id: Math.random().toString(), stage_id: 'a', value: 0, created_at: '2026-10-01T10:00:00Z', ...p }) as Deal

describe('stageProbability', () => {
  const stages = [stage('a', 0), stage('b', 1), stage('c', 2), stage('d', 3)]
  it('goes 10% → 90% and the last stage is 100%', () => {
    expect(stageProbability(stages[0], stages)).toBeCloseTo(0.1)
    expect(stageProbability(stages[2], stages)).toBeCloseTo(0.9)
    expect(stageProbability(stages[3], stages)).toBe(1)
    expect(stageProbability(stage('x', 9), stages)).toBe(0)
    expect(stageProbability(stages[0], [stages[0]])).toBe(1)
  })
})

describe('pipelineStats', () => {
  const stages = [stage('b', 1), stage('a', 0)] // unsorted on purpose
  const now = new Date(2026, 9, 15)
  it('excludes lost from totals and won from the weighted value', () => {
    const s = pipelineStats(
      [
        deal({ stage_id: 'a', value: 100 }),
        deal({ stage_id: 'b', value: 50, status: 'won', updated_at: '2026-10-02T00:00:00Z' }),
        deal({ stage_id: 'a', value: 999, status: 'lost', updated_at: '2026-09-01T00:00:00Z' }),
      ],
      stages,
      now,
    )
    expect(s.totalCount).toBe(2)
    expect(s.totalValue).toBe(150)
    expect(s.avgValue).toBe(75)
    expect(s.weightedValue).toBeCloseTo(10) // 100 × 10% (first of two stages)
    expect(s.wonThisMonth).toBe(1)
    expect(s.lostThisMonth).toBe(0)
  })
  it('is all zeros on an empty board', () => {
    expect(pipelineStats([], stages, now)).toEqual({
      totalCount: 0, totalValue: 0, avgValue: 0, weightedValue: 0, wonThisMonth: 0, lostThisMonth: 0,
    })
  })
})

describe('board density', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })
  it('round-trips per user and defaults to comfortable', () => {
    expect(readBoardDensity('u1')).toBe('comfortable')
    writeBoardDensity('u1', 'compact')
    expect(readBoardDensity('u1')).toBe('compact')
    expect(readBoardDensity('u2')).toBe('comfortable')
  })
  it('never throws when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => writeBoardDensity('u1', 'compact')).not.toThrow()
    expect(readBoardDensity('u1')).toBe('comfortable')
  })
})
