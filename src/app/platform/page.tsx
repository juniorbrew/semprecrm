import { PlatformOverview } from '@/components/platform/overview';
import {
  listPlatformAccounts,
  requirePlatformAdmin,
} from '@/lib/platform/server';

// Summary uses the existing admin-only RPC; no broader data access.
export default async function PlatformPage() {
  const supabase = await requirePlatformAdmin();
  const rows = await listPlatformAccounts(supabase);
  return <PlatformOverview rows={rows} snapshotAt={new Date().toISOString()} />;
}
