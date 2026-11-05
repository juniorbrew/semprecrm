// Pure helpers for the Pipelines board: the header/KPI numbers and the
// per-user card density. No React, no Supabase — unit tested.

import type { Deal, PipelineStage } from '@/types'

/**
 * Stage probability for the weighted value and the forecast: the chance the
 * admin set on the stage (0-100) or, when empty, the automatic one.
 */
export function stageProbability(
  stage: Pick<PipelineStage, 'id' | 'win_probability'>,
  sortedStages: readonly Pick<PipelineStage, 'id'>[],
): number {
  const set = stage.win_probability
  if (typeof set === 'number' && set >= 0 && set <= 100) return set / 100
  return automaticStageProbability(stage, sortedStages)
}

/**
 * Automatic chance of a stage (0-1): first stage ≈ 10%, stages interpolate up
 * to 90% before the final stage, final stage (Won) = 100%. Mirrored in SQL by
 * private.stage_probs (migration 106); both are tested with the same cases.
 */
export function automaticStageProbability(
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

/** Stage order everywhere (and in SQL, private.stage_probs): position, then created_at, then id. */
export function compareStages(
  a: Pick<PipelineStage, 'position' | 'created_at' | 'id'>,
  b: Pick<PipelineStage, 'position' | 'created_at' | 'id'>,
): number {
  return (
    a.position - b.position ||
    (a.created_at ?? '').localeCompare(b.created_at ?? '') ||
    a.id.localeCompare(b.id)
  )
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
  const sorted = [...stages].sort(compareStages)
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
