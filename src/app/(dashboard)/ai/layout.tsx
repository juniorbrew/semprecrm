import { ModuleGuard } from "@/components/plans/module-guard";

// Plan gate for the `ai` module (see src/lib/plans.ts) — covers every
// /ai/* page. The API routes re-check server-side.
export default function AiLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard module="ai">{children}</ModuleGuard>;
}
