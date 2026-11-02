// Sales goals data access (migration 103): the typed face of
// sales_goal_progress() and sales_goal_set(). Called from the browser with
// the user's session; RLS and the functions decide who sees / writes what.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { GoalMetric, GoalScope } from './pace'

type Client = Pick<SupabaseClient, 'rpc'>

/** One effective goal of a month with what was achieved (sales_goal_progress). */
export interface GoalProgress {
  scope: GoalScope
  team_id: string | null
  user_id: string | null
  metric: GoalMetric
  target: number
  achieved: number
  /** Month of the goal row this month inherits from. */
  since: string
}

export interface GoalInput {
  scope: GoalScope
  teamId?: string | null
  userId?: string | null
  metric: GoalMetric
  /** 'YYYY-MM-01', current month or later (the database refuses the past). */
  month: string
  /** null removes the goal from `month` on. */
  target: number | null
}

export async function fetchGoalProgress(db: Client, accountId: string, month: string): Promise<GoalProgress[]> {
  const { data, error } = await db.rpc('sales_goal_progress', { p_account_id: accountId, p_month: month })
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    scope: r.scope as GoalScope,
    team_id: (r.team_id as string | null) ?? null,
    user_id: (r.user_id as string | null) ?? null,
    metric: r.metric as GoalMetric,
    target: Number(r.target),
    achieved: Number(r.achieved),
    since: r.since as string,
  }))
}

export async function setGoal(db: Client, accountId: string, goal: GoalInput): Promise<void> {
  const { error } = await db.rpc('sales_goal_set', {
    p_account_id: accountId,
    p_scope: goal.scope,
    p_team_id: goal.scope === 'team' ? goal.teamId ?? null : null,
    p_user_id: goal.scope === 'member' ? goal.userId ?? null : null,
    p_metric: goal.metric,
    p_month: goal.month,
    p_target: goal.target,
  })
  if (error) throw error
}

/** Stable key of a goal's target + metric (rows of the card and of the dialog). */
export function goalKey(g: Pick<GoalProgress, 'scope' | 'team_id' | 'user_id' | 'metric'>): string {
  return `${g.scope}:${g.team_id ?? ''}:${g.user_id ?? ''}:${g.metric}`
}
