import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PLANS, type Plan } from './plans';
import {
  parsePlanVersion,
  type PlanVersion,
  type PlanVersionHistory,
} from './plan-catalog';
import {
  ACTIVITY_PAGE_SIZE,
  type ActivityPage,
} from './platform/activity-types';

export async function loadCurrentPlanCatalog(
  db: SupabaseClient
): Promise<PlanVersion[]> {
  const { data, error } = await db.rpc('public_plan_catalog');
  if (error || !Array.isArray(data))
    throw new Error('Catálogo de planos indisponível');
  const parsed = data.map(parsePlanVersion);
  if (
    parsed.length !== PLANS.length ||
    parsed.some((v) => !v) ||
    new Set(parsed.map((v) => v?.plan)).size !== PLANS.length
  )
    throw new Error('Catálogo de planos inválido');
  return PLANS.map((plan) => parsed.find((v) => v?.plan === plan)!);
}

export async function loadPlanVersionHistory(
  db: SupabaseClient,
  plan: Plan,
  cursor: string | null
): Promise<ActivityPage<PlanVersionHistory>> {
  if (
    cursor !== null &&
    (!/^[1-9]\d*$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
  )
    throw new Error('Cursor inválido');
  let query = db
    .from('platform_plan_versions')
    .select(
      'id,plan,revision,definition,price_monthly_cents,created_at,actor_name'
    )
    .eq('plan', plan)
    .order('revision', { ascending: false })
    .limit(ACTIVITY_PAGE_SIZE + 1);
  if (cursor !== null) query = query.lt('revision', Number(cursor));
  const { data, error } = await query;
  if (error || !Array.isArray(data))
    throw new Error('Histórico de planos indisponível');
  const items: PlanVersionHistory[] = data.map((raw) => {
    const version = parsePlanVersion(raw);
    if (
      !version ||
      version.plan !== plan ||
      typeof raw.created_at !== 'string' ||
      !Number.isFinite(Date.parse(raw.created_at)) ||
      !(raw.actor_name === null || typeof raw.actor_name === 'string')
    )
      throw new Error('Histórico de planos inválido');
    return {
      ...version,
      created_at: raw.created_at,
      actor_name: raw.actor_name,
    };
  });
  return {
    items: items.slice(0, ACTIVITY_PAGE_SIZE),
    nextCursor:
      items.length > ACTIVITY_PAGE_SIZE
        ? String(items[ACTIVITY_PAGE_SIZE - 1].revision)
        : null,
  };
}
