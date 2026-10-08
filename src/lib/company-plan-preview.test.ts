import { describe, expect, it } from 'vitest';
import { PLAN_CATALOG, resolveEntitlements } from './plans';
import { companyPlanPreview, getCapacityExcess } from './company-plan-preview';

describe('proposed capacity warnings', () => {
  it('counts pending invitations and connected channels before adoption', () => {
    expect(
      getCapacityExcess(
        { members_count: 2, pending_invites_count: 1, channels_count: 2 },
        { max_users: 2, max_channels: 1 }
      )
    ).toEqual([
      { key: 'max_users', used: 3, limit: 2 },
      { key: 'max_channels', used: 2, limit: 1 },
    ]);
  });
  it('preserves unlimited and zero meanings', () => {
    expect(
      getCapacityExcess(
        { members_count: 1, pending_invites_count: 0, channels_count: 0 },
        { max_users: null, max_channels: 0 }
      )
    ).toEqual([]);
  });
});
const id = '39000000-0000-4000-8000-000000000001';
const nextId = '39000000-0000-4000-8000-000000000002';
const account = {
  plan: 'pro',
  plan_status: 'active',
  plan_version_id: id,
  plan_definition: PLAN_CATALOG.pro,
  limit_overrides: { max_users: 3 },
};
const current = {
  id: nextId,
  plan: 'pro' as const,
  revision: 2,
  definition: {
    modules: ['tasks'] as const,
    limits: { max_users: 20, max_channels: 3 },
  },
  price_monthly_cents: 9990,
};
describe('company terms preview', () => {
  it('retains old terms until explicit adoption', () => {
    const draft = companyPlanPreview(account, 'pro', false, [current]);
    expect(draft.plan_version_id).toBe(id);
    expect(draft.plan_definition?.limits.max_users).toBe(10);
    expect(draft.expected_plan_version_id).toBeUndefined();
  });
  it('previews adopted terms while retaining per-company overrides', () => {
    const draft = companyPlanPreview(account, 'pro', true, [current]);
    expect(draft.plan_version_id).toBe(nextId);
    expect(draft.expected_plan_version_id).toBe(nextId);
    expect(resolveEntitlements({ ...account, ...draft }).limits.max_users).toBe(
      3
    );
    expect(
      resolveEntitlements({ ...account, ...draft }).limits.max_channels
    ).toBe(3);
  });
  it('tier switch uses current matching terms and missing catalog fails closed', () => {
    expect(
      companyPlanPreview({ ...account, plan: 'basico' }, 'pro', false, [
        current,
      ]).expected_plan_version_id
    ).toBe(nextId);
    expect(
      resolveEntitlements({
        ...account,
        ...companyPlanPreview(account, 'empresa', false, [current]),
      }).blocked
    ).toEqual({ reason: 'plan_unavailable' });
  });
});
