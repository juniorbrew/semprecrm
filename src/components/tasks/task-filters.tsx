"use client";

import { LayoutList, Kanban, Search } from "lucide-react";

import { useLanguage } from "@/hooks/use-language";
import {
  TASK_PRIORITIES,
  TASK_SCOPES,
  type TaskCounts,
  type TaskListFilters,
  type TaskMember,
  type TaskPriority,
  type TaskScope,
  type TaskStatus,
} from "@/lib/tasks";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { PRIORITY_LABELS, memberLabel } from "./task-chips";

export type TaskView = "list" | "board";

const SCOPE_LABELS: Record<TaskScope, string> = {
  mine: "Mine",
  today: "Today",
  overdue: "Overdue tasks",
  all: "All tasks",
};

const SELECT_CLASS =
  "h-8 rounded-lg border border-border bg-card px-2 text-xs text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary";

export interface TaskFiltersProps {
  filters: TaskListFilters;
  onChange: (next: TaskListFilters) => void;
  counts: TaskCounts;
  statuses: TaskStatus[];
  members: TaskMember[];
  view: TaskView;
  onViewChange: (view: TaskView) => void;
}

/** Chips (Minhas / Hoje / Atrasadas / Todas), selects, search and the Lista | Quadro toggle. */
export function TaskFilters({
  filters,
  onChange,
  counts,
  statuses,
  members,
  view,
  onViewChange,
}: TaskFiltersProps) {
  const { t } = useLanguage();
  const chipCount: Record<TaskScope, number | null> = {
    mine: counts.mine,
    today: counts.dueToday + counts.overdue,
    overdue: counts.overdue,
    all: null,
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1">
          {TASK_SCOPES.map((scope) => {
            const active = filters.scope === scope;
            const n = chipCount[scope];
            return (
              <button
                key={scope}
                type="button"
                onClick={() => onChange({ ...filters, scope })}
                aria-pressed={active}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {t(SCOPE_LABELS[scope])}
                {n !== null && n > 0 && (
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[10px] font-semibold",
                      scope === "overdue"
                        ? "bg-red-500/15 text-red-600 dark:text-red-400"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <select
          value={filters.assigneeUserId ?? ""}
          onChange={(e) =>
            onChange({
              ...filters,
              assigneeUserId: (e.target.value || null) as TaskListFilters["assigneeUserId"],
            })
          }
          aria-label={t("Assignee")}
          className={SELECT_CLASS}
        >
          <option value="">{t("Any assignee")}</option>
          <option value="unassigned">{t("Unassigned")}</option>
          {members.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {memberLabel(m)}
            </option>
          ))}
        </select>

        <select
          value={filters.statusId ?? ""}
          onChange={(e) => onChange({ ...filters, statusId: e.target.value || null })}
          aria-label={t("Status")}
          className={SELECT_CLASS}
        >
          <option value="">{t("Any status")}</option>
          {statuses.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <select
          value={filters.priority ?? ""}
          onChange={(e) =>
            onChange({ ...filters, priority: (e.target.value || null) as TaskPriority | null })
          }
          aria-label={t("Priority")}
          className={SELECT_CLASS}
        >
          <option value="">{t("Any priority")}</option>
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {t(PRIORITY_LABELS[p])}
            </option>
          ))}
        </select>

        <div className="relative ml-auto min-w-[180px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.search ?? ""}
            onChange={(e) => onChange({ ...filters, search: e.target.value })}
            placeholder={t("Search tasks")}
            aria-label={t("Search tasks")}
            className="h-8 border-border bg-card pl-8 text-xs text-foreground md:text-xs"
          />
        </div>

        <div
          role="tablist"
          aria-label={t("View")}
          className="flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5"
        >
          <ViewButton
            active={view === "list"}
            onClick={() => onViewChange("list")}
            label={t("List")}
            icon={<LayoutList className="h-3.5 w-3.5" />}
          />
          <ViewButton
            active={view === "board"}
            onClick={() => onViewChange("board")}
            label={t("Board")}
            icon={<Kanban className="h-3.5 w-3.5" />}
          />
        </div>
      </div>
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      title={label}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
        active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
