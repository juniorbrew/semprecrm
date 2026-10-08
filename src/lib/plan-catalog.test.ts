import { describe, expect, it } from 'vitest';
import { PLAN_CATALOG, resolveEntitlements } from './plans';
import {
  normalizeAssignedPlan,
  parsePlanDefinition,
  parsePlanVersion,
} from './plan-catalog';

const id = '39000000-0000-4000-8000-000000000001';
const old = {
  plan: 'pro',
  plan_status: 'active',
  plan_version_id: id,
  plan_definition: PLAN_CATALOG.pro,
};
describe('assigned catalog', () => {
  it('preservesAssignedVersionAfterCatalogEdit', () => {
    const updated = {
      ...old,
      plan_definition: {
        modules: ['tasks'] as const,
        limits: { max_users: 20, max_channels: 3 },
      },
    };
    expect(resolveEntitlements(old).limits.max_users).toBe(10);
    expect(resolveEntitlements(updated).limits.max_users).toBe(20);
  });
  it('rejectsMissingOrMismatchedDefinition', () => {
    expect(resolveEntitlements({ plan: 'pro' }).blocked).toEqual({
      reason: 'plan_unavailable',
    });
    const mismatch = normalizeAssignedPlan({
      ...old,
      plan_version: { id, plan: 'basico', definition: PLAN_CATALOG.pro },
    });
    expect(resolveEntitlements(mismatch).modules.automations).toBe(false);
    expect(resolveEntitlements(mismatch).blocked).toEqual({
      reason: 'plan_unavailable',
    });
  });
  it('appliesOverridesToAssignedDefinition', () => {
    expect(
      resolveEntitlements({ ...old, limit_overrides: { max_users: 3 } }).limits
        .max_users
    ).toBe(3);
    expect(
      resolveEntitlements({
        ...old,
        plan_definition: {
          ...PLAN_CATALOG.pro,
          limits: { max_users: null, max_channels: 0 },
        },
      }).limits
    ).toEqual({ max_users: null, max_channels: 0 });
  });
  it('validates exact definitions and safe capacities', () => {
    expect(parsePlanDefinition(PLAN_CATALOG.pro)).toEqual(PLAN_CATALOG.pro);
    for (const modules of [['tasks', 'tasks'], ['inbox'], ['unknown']])
      expect(
        parsePlanDefinition({ modules, limits: PLAN_CATALOG.pro.limits })
      ).toBeNull();
    for (const max_users of [
      -1,
      1.5,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      '10',
    ])
      expect(
        parsePlanDefinition({
          modules: [],
          limits: { max_users, max_channels: 1 },
        })
      ).toBeNull();
    expect(
      parsePlanDefinition({ ...PLAN_CATALOG.pro, injected: true })
    ).toBeNull();
  });
  it('validates versions and free trial', () => {
    const version = {
      id,
      plan: 'pro',
      revision: 1,
      definition: PLAN_CATALOG.pro,
      price_monthly_cents: 8990,
    };
    expect(parsePlanVersion(version)).toEqual(version);
    expect(
      parsePlanVersion({ ...version, plan: 'trial', price_monthly_cents: 1 })
    ).toBeNull();
    expect(parsePlanVersion({ ...version, revision: 1.5 })).toBeNull();
    expect(parsePlanVersion({ ...version, id: 'invalid' })).toBeNull();
  });
});
