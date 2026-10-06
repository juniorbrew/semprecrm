import { PlatformAccountsTable } from '@/components/platform/accounts-table';
import {
  listPlatformAccounts,
  requirePlatformAdmin,
} from '@/lib/platform/server';
import { isPlanStatus } from '@/lib/plans';
import type { AttentionFilter } from '@/lib/platform/overview';

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
  const status = isPlanStatus(filters.status) ? filters.status : 'all';
  const attention: AttentionFilter =
    filters.attention === 'expired' ||
    filters.attention === 'expiring' ||
    filters.attention === 'limits'
      ? filters.attention
      : 'all';
  return (
    <PlatformAccountsTable
      key={`${status}:${attention}`}
      rows={rows}
      initialStatus={status}
      initialAttention={attention}
      snapshotAt={new Date().toISOString()}
    />
  );
}
