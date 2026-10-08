import { notFound } from 'next/navigation';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { loadCurrentPlanCatalog } from '@/lib/plan-catalog-server';
import { isPlan } from '@/lib/plans';
import { PlanCatalogEditor } from '@/components/platform/plan-catalog-editor';
export default async function PlanPage({
  params,
}: {
  params: Promise<{ plan: string }>;
}) {
  const db = await requirePlatformAdmin();
  const { plan } = await params;
  if (!isPlan(plan)) notFound();
  const version = (await loadCurrentPlanCatalog(db)).find(
    (v) => v.plan === plan
  )!;
  return <PlanCatalogEditor initial={version} />;
}
