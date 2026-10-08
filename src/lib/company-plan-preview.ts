import {
  LIMIT_KEYS,
  type Limits,
  type Plan,
  type PlanAccountFields,
} from './plans';
import type { PlanVersion } from './plan-catalog';

export function getCapacityExcess(
  usage: {
    members_count: number;
    pending_invites_count: number;
    channels_count: number;
  },
  limits: Limits
) {
  const used = {
    max_users:
      Number(usage.members_count) + Number(usage.pending_invites_count),
    max_channels: Number(usage.channels_count),
  };
  return LIMIT_KEYS.flatMap((key) =>
    limits[key] !== null && used[key] > limits[key]
      ? [{ key, used: used[key], limit: limits[key] }]
      : []
  );
}
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
