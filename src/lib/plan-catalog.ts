import {
  isModule,
  MAX_EXTRAS,
  isOptionalModule,
  isPlan,
  LIMIT_KEYS,
  type Plan,
  type PlanAccountFields,
  type PlanDefinition,
} from './plans';

export interface PlanVersion {
  id: string;
  plan: Plan;
  revision: number;
  definition: PlanDefinition;
  price_monthly_cents: number | null;
}
export interface PlanVersionHistory extends PlanVersion {
  created_at: string;
  actor_name: string | null;
}
export const isVersionId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** Cap of an extra's monthly price in cents (R$ 100.000,00), same as the DB. */
export const MAX_EXTRA_PRICE_CENTS = 10_000_000;
const EXTRA_PRICE_KEYS = [
  'extra_user_price_cents',
  'extra_channel_price_cents',
] as const;
export function parsePlanDefinition(raw: unknown): PlanDefinition | null {
  if (
    !record(raw) ||
    !Object.keys(raw).every(
      (k) =>
        k === 'modules' ||
        k === 'limits' ||
        (EXTRA_PRICE_KEYS as readonly string[]).includes(k)
    ) ||
    !EXTRA_PRICE_KEYS.every(
      (k) =>
        !(k in raw) ||
        (typeof raw[k] === 'number' &&
          Number.isSafeInteger(raw[k]) &&
          raw[k] >= 0 &&
          raw[k] <= MAX_EXTRA_PRICE_CENTS)
    ) ||
    !Array.isArray(raw.modules) ||
    !raw.modules.every((m) => typeof m === 'string') ||
    // A module this build does not know yet (added by a newer migration that
    // ran before this code was replaced) is ignored, not fatal: it stays off.
    !raw.modules.every((m) => isOptionalModule(m) || !isModule(m)) ||
    new Set(raw.modules).size !== raw.modules.length ||
    !record(raw.limits) ||
    Object.keys(raw.limits).length !== 2
  )
    return null;
  const limits = raw.limits;
  if (
    !LIMIT_KEYS.every(
      (key) =>
        limits[key] === null ||
        (typeof limits[key] === 'number' &&
          Number.isSafeInteger(limits[key]) &&
          limits[key] >= 0)
    )
  )
    return null;
  return {
    modules: raw.modules.filter(isOptionalModule),
    limits: {
      max_users: limits.max_users as number | null,
      max_channels: limits.max_channels as number | null,
    },
    ...Object.fromEntries(
      EXTRA_PRICE_KEYS.filter((k) => k in raw).map((k) => [k, raw[k]])
    ),
  };
}
export function parsePlanVersion(raw: unknown): PlanVersion | null {
  if (
    !record(raw) ||
    !isVersionId(raw.id) ||
    !isPlan(raw.plan) ||
    typeof raw.revision !== 'number' ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 1
  )
    return null;
  const definition = parsePlanDefinition(raw.definition);
  const price = raw.price_monthly_cents;
  if (
    !definition ||
    !(
      price === null ||
      (typeof price === 'number' && Number.isSafeInteger(price) && price >= 0)
    ) ||
    (raw.plan === 'trial' && price !== 0)
  )
    return null;
  return {
    id: raw.id,
    plan: raw.plan,
    revision: raw.revision,
    definition,
    price_monthly_cents: price,
  };
}
/**
 * Extras joined from account_billing (object for the one-to-one embed, array
 * tolerated). Missing (agent: RLS hides the row) or malformed = no extras.
 */
function extrasOf(raw: { account_billing?: unknown }): PlanAccountFields['extras'] {
  const row = Array.isArray(raw.account_billing)
    ? raw.account_billing[0]
    : raw.account_billing;
  if (!record(row)) return null;
  const n = (v: unknown) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v > 0
      ? Math.min(v, MAX_EXTRAS)
      : 0;
  return { users: n(row.extra_users), channels: n(row.extra_channels) };
}
/** Normalize joined rows once; reject missing or mismatched assigned relationships. */
export function normalizeAssignedPlan(
  raw: PlanAccountFields & {
    plan_version?: unknown;
    account_billing?: unknown;
  }
): PlanAccountFields {
  const version = raw.plan_version;
  const definition =
    record(version) &&
    version.id === raw.plan_version_id &&
    version.plan === raw.plan
      ? parsePlanDefinition(version.definition)
      : null;
  return { ...raw, plan_definition: definition, extras: extrasOf(raw) };
}
