"use client";

import { useLanguage } from "@/hooks/use-language";
import { isDoneStatus, type Task, type TaskMember, type TaskStatus } from "@/lib/tasks";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

import { tasksCopy } from "./copy";
import {
  AssigneeAvatar,
  DueChip,
  PriorityChip,
  StatusChip,
  TaskLinkChip,
} from "./task-chips";

export interface TaskListProps {
  tasks: Task[];
  statuses: TaskStatus[];
  members: TaskMember[];
  onOpen: (task: Task) => void;
  /** Checkbox: complete (when open) or reopen (when done). */
  onToggleDone: (task: Task, done: boolean) => void;
  readOnly?: boolean;
  emptyLabel?: string;
  /** Compact rows: one line, no description. */
  compact?: boolean;
}

/**
 * Card-less rows for the /tasks list view: hairline dividers, the
 * complete checkbox, title + priority, then one quiet meta line (status
 * dot · due · link). The link chip sits outside the open button so no
 * interactive element is nested in another.
 */
export function TaskList({
  tasks,
  statuses,
  members,
  onOpen,
  onToggleDone,
  readOnly,
  emptyLabel,
  compact,
}: TaskListProps) {
  const { t, language } = useLanguage();
  const copy = tasksCopy(language);
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  const memberById = new Map(members.map((m) => [m.user_id, m]));

  if (tasks.length === 0) {
    return (
      <div className="border-t border-border py-12 text-center">
        <p className="text-sm text-foreground">{emptyLabel ?? t("No tasks here")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("Create a task or change the filters.")}</p>
      </div>
    );
  }

  return (
    <ul className="border-t border-border" data-density={compact ? "compact" : "comfortable"}>
      {tasks.map((task) => {
        const status = statusById.get(task.status_id) ?? null;
        const done = isDoneStatus(status);
        const assignee = task.assignee_user_id
          ? memberById.get(task.assignee_user_id) ?? null
          : null;
        return (
          <li
            key={task.id}
            className={cn(
              "flex gap-3 border-b border-border px-2 transition-colors duration-150 hover:bg-muted/50 motion-reduce:transition-none",
              compact ? "items-center py-1.5" : "items-start py-2.5",
            )}
          >
            <Checkbox
              checked={done}
              disabled={readOnly}
              aria-label={done ? t("Reopen task") : t("Complete task")}
              onCheckedChange={(checked) => onToggleDone(task, checked === true)}
              className={compact ? undefined : "mt-0.5"}
            />
            <div
              className={cn(
                "flex min-w-0 flex-1",
                compact ? "flex-row items-center gap-x-3" : "flex-col",
              )}
            >
              <button
                type="button"
                onClick={() => onOpen(task)}
                aria-label={copy.open(task.title)}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  compact ? "shrink" : "w-full",
                )}
              >
                <span
                  className={cn(
                    "truncate text-sm font-medium text-foreground",
                    done && "text-muted-foreground line-through",
                  )}
                >
                  {task.title}
                </span>
                <PriorityChip priority={task.priority} compact={task.priority === "normal"} />
              </button>
              <div
                className={cn(
                  "flex min-w-0 items-center gap-x-1 text-[11px]",
                  compact ? "shrink-0" : "-ml-1.5 mt-0.5 flex-wrap gap-y-0.5",
                )}
              >
                <StatusChip status={status} className="px-1.5" />
                <DueChip dueAt={task.due_at} done={done} />
                <TaskLinkChip task={task} />
                {!compact && task.description && (
                  <span className="hidden min-w-0 truncate px-1.5 text-xs text-muted-foreground sm:inline">
                    {task.description}
                  </span>
                )}
              </div>
            </div>
            <div className={cn("shrink-0", !compact && "pt-0.5")}>
              <AssigneeAvatar member={assignee} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
