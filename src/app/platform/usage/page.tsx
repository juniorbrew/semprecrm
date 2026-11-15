import { PlatformUsageTable } from '@/components/platform/usage-table';
import {
  getPlatformUsage,
  listPlatformAccounts,
  requirePlatformAdmin,
} from '@/lib/platform/server';
import { buildUsageRows, currentMonth, parseMonth } from '@/lib/platform/usage';

export default async function PlatformUsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The gate runs first: nothing is read (and no service-role client is
  // touched) for anyone who is not the platform owner.
  const supabase = await requirePlatformAdmin();
  const now = new Date();
  const month =
    parseMonth((await searchParams).month, now) ?? currentMonth(now);
  const [accounts, usage] = await Promise.all([
    listPlatformAccounts(supabase),
    getPlatformUsage(month),
  ]);
  return (
    <PlatformUsageTable
      rows={buildUsageRows(accounts, usage, now)}
      month={month}
      maxMonth={currentMonth(now)}
    />
  );
}
