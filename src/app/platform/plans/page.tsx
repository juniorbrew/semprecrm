import { requirePlatformAdmin } from '@/lib/platform/server';
import { loadCurrentPlanCatalog } from '@/lib/plan-catalog-server';
import { PlanCatalogList } from '@/components/platform/plan-catalog-list';
export default async function PlansPage() {
  const db = await requirePlatformAdmin();
  return <PlanCatalogList plans={await loadCurrentPlanCatalog(db)} />;
}
