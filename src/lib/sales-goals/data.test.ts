import { describe, expect, it, vi } from 'vitest'

import { fetchGoalProgress, goalKey, setGoal } from './data'

describe('fetchGoalProgress', () => {
  it('calls the RPC with the account and month and coerces numerics', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ scope: 'team', team_id: 't1', user_id: null, metric: 'won_value', target: '400.00', achieved: '150.5', since: '2026-09-01' }],
      error: null,
    })
    const rows = await fetchGoalProgress({ rpc } as never, 'acc', '2026-11-01')
    expect(rpc).toHaveBeenCalledWith('sales_goal_progress', { p_account_id: 'acc', p_month: '2026-11-01' })
    expect(rows).toEqual([{ scope: 'team', team_id: 't1', user_id: null, metric: 'won_value', target: 400, achieved: 150.5, since: '2026-09-01' }])
  })
  it('throws the database error', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: new Error('nope') })
    await expect(fetchGoalProgress({ rpc } as never, 'acc', '2026-11-01')).rejects.toThrow('nope')
  })
})

describe('setGoal', () => {
  it('sends only the reference that belongs to the scope', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null })
    await setGoal({ rpc } as never, 'acc', { scope: 'member', teamId: 'stray', userId: 'u1', metric: 'won_count', month: '2026-11-01', target: 12 })
    expect(rpc).toHaveBeenCalledWith('sales_goal_set', {
      p_account_id: 'acc', p_scope: 'member', p_team_id: null, p_user_id: 'u1', p_metric: 'won_count', p_month: '2026-11-01', p_target: 12,
    })
  })
  it('null target is a removal and errors surface', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: 'sales_goal_past_month' } })
    await expect(setGoal({ rpc } as never, 'acc', { scope: 'account', metric: 'won_value', month: '2026-01-01', target: null })).rejects.toBeTruthy()
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_target: null, p_team_id: null, p_user_id: null })
  })
})

describe('goalKey', () => {
  it('is distinct per target and metric', () => {
    const a = goalKey({ scope: 'account', team_id: null, user_id: null, metric: 'won_value' })
    expect(a).not.toBe(goalKey({ scope: 'account', team_id: null, user_id: null, metric: 'won_count' }))
    expect(a).not.toBe(goalKey({ scope: 'team', team_id: 't', user_id: null, metric: 'won_value' }))
  })
})
