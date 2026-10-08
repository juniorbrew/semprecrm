import type { Plan, PlanAccountFields } from './plans';
import type { PlanVersion } from './plan-catalog';
export function companyPlanPreview(
  account: PlanAccountFields,
  plan: Plan,
  adopt: boolean,
  catalog: PlanVersion[]
) {
  const chooseCurrent = account.plan !== plan || adopt;
  const current = catalog.find((v) => v.plan === plan);
  return {
    plan,
    plan_version_id: chooseCurrent
      ? (current?.id ?? null)
      : account.plan_version_id,
    plan_definition: chooseCurrent
      ? (current?.definition ?? null)
      : account.plan_definition,
    expected_plan_version_id: chooseCurrent ? current?.id : undefined,
  };
}
