import { ModuleGuard } from "@/components/plans/module-guard";
import I18nChunk from "@/lib/i18n-chunks/d-chat";

// Plan gate for the `internal_chat` module (see src/lib/plans.ts).
// Lives in the segment layout so every nested route is covered
// without touching the feature page itself.
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <I18nChunk />
      <ModuleGuard module="internal_chat">{children}</ModuleGuard>
    </>
  );
}
