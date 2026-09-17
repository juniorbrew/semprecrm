import { ModuleGuard } from "@/components/plans/module-guard";

// Plan gate for the `calendar` module (see src/lib/plans.ts). Lives in
// the segment layout so every nested route is covered without
// touching the feature page itself.
export default function AgendaLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard module="calendar">{children}</ModuleGuard>;
}
