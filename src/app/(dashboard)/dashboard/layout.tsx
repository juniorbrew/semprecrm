import { ModuleGuard } from "@/components/plans/module-guard";

// Plan gate for the `dashboard` module (see src/lib/plans.ts). Lives in
// the segment layout so every nested route is covered without
// touching the feature pages themselves.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard module="dashboard">{children}</ModuleGuard>;
}
