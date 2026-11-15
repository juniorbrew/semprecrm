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
    // A module from a newer migration is ignored (off), not fatal.
    expect(
      parsePlanDefinition({ modules: ['tasks', 'from_the_future'], limits: PLAN_CATALOG.pro.limits })
    ).toEqual({ modules: ['tasks'], limits: PLAN_CATALOG.pro.limits });
    for (const modules of [['tasks', 'tasks'], ['inbox'], [3], ['x', 'x']])
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
  it('accepts optional extra prices and rejects bad ones (migration 114)', () => {
    const withPrices = {
      ...PLAN_CATALOG.pro,
      extra_user_price_cents: 1500,
      extra_channel_price_cents: 0,
    };
    expect(parsePlanDefinition(withPrices)).toEqual(withPrices);
    expect(
      parsePlanDefinition({ ...PLAN_CATALOG.pro, extra_user_price_cents: 1500 })
    ).toEqual({ ...PLAN_CATALOG.pro, extra_user_price_cents: 1500 });
    // Absent = not offered; the definition without the keys is unchanged.
    expect(parsePlanDefinition(PLAN_CATALOG.pro)).not.toHaveProperty(
      'extra_user_price_cents'
    );
    for (const bad of [-1, 1.5, '1500', null, 10_000_001, Infinity, NaN])
      for (const key of ['extra_user_price_cents', 'extra_channel_price_cents'])
        expect(
          parsePlanDefinition({ ...PLAN_CATALOG.pro, [key]: bad }),
          `${key}=${String(bad)}`
        ).toBeNull();
    expect(
      parsePlanDefinition({ ...PLAN_CATALOG.pro, extra_user_price_cents: 10_000_000 })
    ).not.toBeNull();
  });
  it('extras raise finite limits only, and only for an available plan', () => {
    const acct = { ...old, extras: { users: 2, channels: 1 } };
    expect(resolveEntitlements(acct).limits).toEqual({ max_users: 12, max_channels: 3 });
    expect(resolveEntitlements(acct).extras).toEqual({ users: 2, channels: 1 });
    const unlimited = resolveEntitlements({
      ...acct,
      plan_definition: { modules: [], limits: { max_users: null, max_channels: 5 } },
    });
    expect(unlimited.limits).toEqual({ max_users: null, max_channels: 6 });
    expect(unlimited.extras).toEqual({ users: 0, channels: 1 });
    // junk never lowers a limit; the cap stops absurd values
    expect(resolveEntitlements({ ...old, extras: { users: -5, channels: 1.5 } }).limits).toEqual(PLAN_CATALOG.pro.limits);
    expect(resolveEntitlements({ ...old, extras: { users: 100000, channels: 0 } }).limits.max_users).toBe(110);
    // overrides first, extras on top
    expect(
      resolveEntitlements({ ...acct, limit_overrides: { max_users: 4 } }).limits.max_users
    ).toBe(6);
    expect(resolveEntitlements({ ...acct, plan_version_id: 'bad' }).limits).toEqual({ max_users: 0, max_channels: 0 });
  });
  it('reads extras from the joined account_billing row (object or array, junk = none)', () => {
    const base = { ...old, plan_version: { id, plan: 'pro', definition: PLAN_CATALOG.pro } };
    const users = (billing: unknown) =>
      resolveEntitlements(normalizeAssignedPlan({ ...base, account_billing: billing })).limits.max_users;
    expect(users({ extra_users: 3, extra_channels: 0 })).toBe(13);
    expect(users([{ extra_users: 3, extra_channels: 0 }])).toBe(13);
    expect(users(null)).toBe(10); // an agent: RLS hides the row
    expect(users({ extra_users: '3' })).toBe(10);
    expect(users(undefined)).toBe(10);
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
