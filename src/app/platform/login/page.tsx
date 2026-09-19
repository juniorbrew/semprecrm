import { notFound, redirect } from "next/navigation";

import { PlatformGateForm } from "@/components/platform/gate-form";
import { getPlatformAdmin } from "@/lib/platform/server";

// /platform/login — the master area's own lock. Only a signed-in
// platform admin gets here (404 for everyone else, like the rest of
// /platform); with the gate already open it goes straight to the list.
export default async function PlatformLoginPage() {
  const ctx = await getPlatformAdmin();
  if (!ctx) notFound();
  if (ctx.gateOpen) redirect("/platform");
  return <PlatformGateForm mode={ctx.gate ? "login" : "setup"} />;
}
