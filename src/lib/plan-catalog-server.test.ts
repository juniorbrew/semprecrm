import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
vi.mock('server-only', () => ({}));
import {
  loadCurrentPlanCatalog,
  loadPlanVersionHistory,
} from './plan-catalog-server';
import { PLAN_CATALOG, PLANS } from './plans';
const version = (plan: (typeof PLANS)[number], revision = 1) => ({
  id: `39000000-0000-4000-8000-${String(revision).padStart(12, '0')}`,
  plan,
  revision,
  definition: PLAN_CATALOG[plan],
  price_monthly_cents: plan === 'trial' ? 0 : plan === 'empresa' ? null : 8990,
});
describe('catalog reads', () => {
  it('accepts exactly four validated public terms', async () => {
    const db = {
      rpc: vi.fn().mockResolvedValue({
        data: PLANS.map((plan) => version(plan)),
        error: null,
      }),
    } as unknown as SupabaseClient;
    expect((await loadCurrentPlanCatalog(db)).map((v) => v.plan)).toEqual(
      PLANS
    );
  });
  it.each([
    { rows: [] },
    { rows: [version('pro')] },
    {
      rows: PLANS.map((p) => ({
        ...version(p),
        definition: {
          modules: ['invalid'],
          limits: { max_users: 2, max_channels: 1 },
        },
      })),
    },
    { rows: PLANS.map(() => version('pro')) },
  ])('fails closed for incomplete/corrupt catalogs', async ({ rows }) => {
    const db = {
      rpc: vi.fn().mockResolvedValue({ data: rows, error: null }),
    } as unknown as SupabaseClient;
    await expect(loadCurrentPlanCatalog(db)).rejects.toThrow();
  });
  it('pages by revision and omits internal metadata', async () => {
    const data = Array.from({ length: 26 }, (_, i) => ({
      ...version('pro', 100 - i),
      created_at: '2026-10-07T12:00:00Z',
      actor_name: 'Historical administrator',
      actor_user_id: 'PRIVATE',
      secret: 'PRIVATE',
    }));
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
      lt: vi.fn(),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data, error: null }).then(resolve),
    };
    for (const method of ['select', 'eq', 'order', 'limit', 'lt'] as const)
      query[method].mockReturnValue(query);
    const db = {
      from: vi.fn().mockReturnValue(query),
    } as unknown as SupabaseClient;
    const page = await loadPlanVersionHistory(db, 'pro', '101');
    expect(page.items).toHaveLength(25);
    expect(page.nextCursor).toBe('76');
    expect(query.eq).toHaveBeenCalledWith('plan', 'pro');
    expect(query.lt).toHaveBeenCalledWith('revision', 101);
    expect(JSON.stringify(page)).not.toContain('PRIVATE');
    expect(page.items[0].actor_name).toBe('Historical administrator');
  });
});
