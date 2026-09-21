import { PlatformLeadsTable } from '@/components/platform/leads-table';
import { requirePlatformAdmin } from '@/lib/platform/server';
import type { LeadList } from '@/lib/platform/leads';

export default async function PlatformLeadsPage() {
  const supabase = await requirePlatformAdmin();
  const { data, error } = await supabase.rpc('platform_list_leads', {
    p_limit: 25,
    p_offset: 0,
    p_status: null,
    p_kind: null,
    p_search: '',
  });
  return <PlatformLeadsTable initialData={error ? null : (data as LeadList)} />;
}
