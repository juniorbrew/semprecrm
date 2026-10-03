// Pure helpers for the Pipelines board: the header/KPI numbers and the
// per-user card density. No React, no Supabase — unit tested.

import type { Deal, PipelineStage } from '@/types'

/**
 * Stage probability for the weighted value: first stage ≈ 10%, stages
 * interpolate up to 90% before the final stage, final stage (Won) = 100%.
 */
export function stageProbability(
  stage: Pick<PipelineStage, 'id'>,
  sortedStages: readonly Pick<PipelineStage, 'id'>[],
): number {
  const n = sortedStages.length
  if (n <= 1) return 1
  const index = sortedStages.findIndex((s) => s.id === stage.id)
  if (index < 0) return 0
  if (index === n - 1) return 1
  const slots = n - 1
  if (slots <= 1) return 0.1
  const t = index / (slots - 1)
  return 0.1 + t * (0.9 - 0.1)
}

export interface PipelineStats {
  /** Deals not marked lost (won included). */
  totalCount: number
  totalValue: number
  avgValue: number
  /** Open deals × stage probability. */
  weightedValue: number
  wonThisMonth: number
  lostThisMonth: number
}

export function pipelineStats(
  deals: readonly Deal[],
  stages: readonly PipelineStage[],
  now: Date = new Date(),
): PipelineStats {
  const sorted = [...stages].sort((a, b) => a.position - b.position)
  const active = deals.filter((d) => d.status !== 'lost')
  const totalCount = active.length
  const totalValue = active.reduce((sum, d) => sum + Number(d.value || 0), 0)

  const stageById = new Map(sorted.map((s) => [s.id, s]))
  const weightedValue = active
    .filter((d) => d.status !== 'won')
    .reduce((sum, d) => {
      const stage = stageById.get(d.stage_id)
      return stage ? sum + Number(d.value || 0) * stageProbability(stage, sorted) : sum
    }, 0)

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const thisMonth = (d: Deal) => {
    const ts = d.updated_at ?? d.created_at
    return ts ? new Date(ts) >= monthStart : false
  }

  return {
    totalCount,
    totalValue,
    avgValue: totalCount > 0 ? totalValue / totalCount : 0,
    weightedValue,
    wonThisMonth: deals.filter((d) => d.status === 'won' && thisMonth(d)).length,
    lostThisMonth: deals.filter((d) => d.status === 'lost' && thisMonth(d)).length,
  }
}

/** Card density on the board, per user on this device. */
export type BoardDensity = 'comfortable' | 'compact'
const DENSITY_KEY_PREFIX = 'sempre:pipelines:density:'

export function readBoardDensity(userId: string): BoardDensity {
  try {
    return localStorage.getItem(DENSITY_KEY_PREFIX + userId) === 'compact'
      ? 'compact'
      : 'comfortable'
  } catch {
    return 'comfortable'
  }
}

export function writeBoardDensity(userId: string, density: BoardDensity): void {
  try {
    localStorage.setItem(DENSITY_KEY_PREFIX + userId, density)
  } catch {
    // Remembering is a convenience only.
  }
}
