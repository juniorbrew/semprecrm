import { PlatformGateSettings } from "@/components/platform/gate-settings";
import { requirePlatformAdminContext } from "@/lib/platform/server";

// /platform/acesso — change the username / password that unlock the
// panel. Same guard as every platform page (gate must be open).
export default async function PlatformAccessPage() {
  const ctx = await requirePlatformAdminContext();
  return <PlatformGateSettings username={ctx.gate?.username ?? ""} />;
}
