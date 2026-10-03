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

import { PRIORITY_LABELS, memberLabel, statusName } from "./task-chips";

export type TaskView = "list" | "board";

const SCOPE_LABELS: Record<TaskScope, string> = {
  mine: "Mine",
  today: "Today",
  overdue: "Overdue tasks",
  all: "All tasks",
};

const SELECT_CLASS =
  "h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none transition-colors duration-150 hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none";

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
  const { t, language } = useLanguage();
  const chipCount: Record<TaskScope, number | null> = {
    mine: counts.mine,
    today: counts.dueToday + counts.overdue,
    overdue: counts.overdue,
    all: null,
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
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
                  "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  active
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {scope === "overdue" && n !== null && n > 0 && (
                  <span aria-hidden className="size-1.5 rounded-full bg-red-500" />
                )}
                {t(SCOPE_LABELS[scope])}
                {n !== null && n > 0 && (
                  <span
                    className={cn(
                      "text-[11px] font-bold tabular-nums",
                      active ? "text-primary" : "text-muted-foreground",
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
          <option value="unassigned">{t("No assignee")}</option>
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
              {statusName(s, language)}
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
            className="h-8 pl-8 text-xs md:text-xs"
          />
        </div>

        <div
          role="tablist"
          aria-label={t("View")}
          className="flex items-center gap-0.5 rounded-md bg-muted p-0.5"
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
        "inline-flex h-7 items-center gap-1.5 rounded-[calc(var(--radius)-4px)] px-2 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        active ? "bg-background text-primary shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
