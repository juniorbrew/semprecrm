import { ModuleGuard } from "@/components/plans/module-guard";
import I18nChunk from "@/lib/i18n-chunks/d-reports";

// Plan gate for the `reports` module (see src/lib/plans.ts). The page itself
// is for owners / admins; the database function enforces the same rule.
export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <I18nChunk />
      <ModuleGuard module="reports">{children}</ModuleGuard>
    </>
  );
}
