import { ModuleGuard } from "@/components/plans/module-guard";
import I18nChunk from "@/lib/i18n-chunks/d-ai";

// Plan gate for the `ai` module (see src/lib/plans.ts) — covers every
// /ai/* page. The API routes re-check server-side.
export default function AiLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <I18nChunk />
      <ModuleGuard module="ai">{children}</ModuleGuard>
    </>
  );
}
