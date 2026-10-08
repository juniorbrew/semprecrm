import { notFound } from 'next/navigation';

import { PlatformAccountForm } from '@/components/platform/account-form';
import {
  getPlatformAccount,
  requirePlatformAdmin,
} from '@/lib/platform/server';
import { loadCurrentPlanCatalog } from '@/lib/plan-catalog-server';

// /platform/[accountId] — edit one account's plan, status, expiry,
// module / limit overrides and notes. Every write goes through the
// `platform_update_account` RPC from the client form; this page only
// gates access and loads the current row.
export default async function PlatformAccountPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;
  const supabase = await requirePlatformAdmin();
  const [row, catalog] = await Promise.all([
    getPlatformAccount(supabase, accountId),
    loadCurrentPlanCatalog(supabase),
  ]);
  if (!row) notFound();
  return (
    <PlatformAccountForm
      row={row}
      catalog={catalog}
      snapshotAt={new Date().toISOString()}
    />
  );
}
