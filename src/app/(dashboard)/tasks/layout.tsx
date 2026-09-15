import { ModuleGuard } from "@/components/plans/module-guard";

// Plan gate for the `tasks` module (see src/lib/plans.ts). Lives in
// the segment layout so every nested route is covered without
// touching the feature pages themselves.
export default function TasksLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard module="tasks">{children}</ModuleGuard>;
}
