import { ModuleGuard } from "@/components/plans/module-guard";
import I18nChunk from "@/lib/i18n-chunks/d-reports";

// Same plan module as the dashboard (see src/lib/plans.ts). The page itself
// is for owners / admins; the database function enforces the same rule.
export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <I18nChunk />
      <ModuleGuard module="dashboard">{children}</ModuleGuard>
    </>
  );
}
