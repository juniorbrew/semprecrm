import {
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
export function parsePlanDefinition(raw: unknown): PlanDefinition | null {
  if (
    !record(raw) ||
    Object.keys(raw).length !== 2 ||
    !Array.isArray(raw.modules) ||
    !raw.modules.every(isOptionalModule) ||
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
    modules: [...raw.modules],
    limits: {
      max_users: limits.max_users as number | null,
      max_channels: limits.max_channels as number | null,
    },
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
/** Normalize joined rows once; reject missing or mismatched assigned relationships. */
export function normalizeAssignedPlan(
  raw: PlanAccountFields & { plan_version?: unknown }
): PlanAccountFields {
  const version = raw.plan_version;
  const definition =
    record(version) &&
    version.id === raw.plan_version_id &&
    version.plan === raw.plan
      ? parsePlanDefinition(version.definition)
      : null;
  return { ...raw, plan_definition: definition };
}
