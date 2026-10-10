import { PlatformOverview } from '@/components/platform/overview';
import {
  listPlatformAccounts,
  getPlatformChannelAlerts,
  requirePlatformAdmin,
} from '@/lib/platform/server';

export default async function PlatformPage() {
  const supabase = await requirePlatformAdmin();
  const [rows, channelAlerts] = await Promise.all([
    listPlatformAccounts(supabase),
    getPlatformChannelAlerts(supabase),
  ]);
  return (
    <PlatformOverview
      rows={rows.map((row) => ({ ...row, ...channelAlerts[row.id] }))}
      snapshotAt={new Date().toISOString()}
    />
  );
}
