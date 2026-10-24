import { ModuleGuard } from "@/components/plans/module-guard";
import I18nChunk from "@/lib/i18n-chunks/d-pipelines";

// Plan gate for the `pipelines` module (see src/lib/plans.ts). Lives in
// the segment layout so every nested route is covered without
// touching the feature pages themselves.
export default function PipelinesLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <I18nChunk />
      <ModuleGuard module="pipelines">{children}</ModuleGuard>
    </>
  );
}
