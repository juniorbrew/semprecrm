"use client";

import { CheckSquare } from "lucide-react";

import { useLanguage } from "@/hooks/use-language";
import { isDoneStatus, type Task, type TaskMember, type TaskStatus } from "@/lib/tasks";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

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
}

/**
 * Flat rows for the /tasks list view (also reusable in a narrow
 * panel — chips wrap on small widths).
 */
export function TaskList({
  tasks,
  statuses,
  members,
  onOpen,
  onToggleDone,
  readOnly,
  emptyLabel,
}: TaskListProps) {
  const { t } = useLanguage();
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  const memberById = new Map(members.map((m) => [m.user_id, m]));

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
        <CheckSquare className="h-10 w-10 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium text-foreground">
          {emptyLabel ?? t("No tasks here")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("Create a task or change the filters.")}
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-card/60">
      {tasks.map((task) => {
        const status = statusById.get(task.status_id) ?? null;
        const done = isDoneStatus(status);
        const assignee = task.assignee_user_id
          ? memberById.get(task.assignee_user_id) ?? null
          : null;
        return (
          <li
            key={task.id}
            className="group flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50"
          >
            <Checkbox
              checked={done}
              disabled={readOnly}
              aria-label={done ? t("Reopen task") : t("Complete task")}
              onCheckedChange={(checked) => onToggleDone(task, checked === true)}
              className="mt-1"
            />
            <button
              type="button"
              onClick={() => onOpen(task)}
              className="min-w-0 flex-1 text-left"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  className={cn(
                    "text-sm font-medium text-foreground",
                    done && "text-muted-foreground line-through",
                  )}
                >
                  {task.title}
                </span>
                <PriorityChip priority={task.priority} compact={task.priority === "normal"} />
                <StatusChip status={status} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <TaskLinkChip task={task} className="-ml-1.5" />
                <DueChip dueAt={task.due_at} done={done} className="-ml-1.5" />
                {task.description && (
                  <span className="hidden truncate text-xs text-muted-foreground sm:inline">
                    {task.description}
                  </span>
                )}
              </div>
            </button>
            <div className="shrink-0 pt-0.5">
              <AssigneeAvatar member={assignee} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
