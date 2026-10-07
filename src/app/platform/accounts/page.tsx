import { PlatformAccountsTable } from '@/components/platform/accounts-table';
import {
  listPlatformAccounts,
  requirePlatformAdmin,
} from '@/lib/platform/server';
import { parseCompanyFilters } from '@/lib/platform/account-filters';

export default async function PlatformAccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await requirePlatformAdmin();
  const [rows, filters] = await Promise.all([
    listPlatformAccounts(supabase),
    searchParams,
  ]);
  const initialFilters = parseCompanyFilters(filters);
  return (
    <PlatformAccountsTable
      key={JSON.stringify(initialFilters)}
      rows={rows}
      initialFilters={initialFilters}
      snapshotAt={new Date().toISOString()}
    />
  );
}
