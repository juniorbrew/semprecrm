import { isPlan, PLAN_CATALOG, type PlanAccountFields } from '@/lib/plans';
/** Initial immutable grant for legacy route scenarios; production never uses this fallback. */
export function assignedPlanFixture<T extends PlanAccountFields>(row: T) {
  const id = '39000000-0000-4000-8000-000000000001';
  return {
    ...row,
    plan_version_id: id,
    plan_version: {
      id,
      plan: row.plan,
      definition: isPlan(row.plan) ? PLAN_CATALOG[row.plan] : null,
    },
  };
}
