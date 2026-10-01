import { ModuleGuard } from "@/components/plans/module-guard";

// Same plan module as the dashboard (see src/lib/plans.ts). The page itself
// is for owners / admins; the database function enforces the same rule.
export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard module="dashboard">{children}</ModuleGuard>;
}
