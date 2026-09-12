import { PlatformAccountsTable } from "@/components/platform/accounts-table";
import { listPlatformAccounts, requirePlatformAdmin } from "@/lib/platform/server";

// /platform — every account on this instance. Server component:
// checks `is_platform_admin()` (404 otherwise) and loads the list
// through the SECURITY DEFINER RPC. Search / filter happen client-
// side in the table (the list is small: one row per customer).
export default async function PlatformPage() {
  const supabase = await requirePlatformAdmin();
  const rows = await listPlatformAccounts(supabase);
  return <PlatformAccountsTable rows={rows} />;
}
