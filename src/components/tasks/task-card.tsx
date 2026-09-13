"use client";

import { isDoneStatus, type Task, type TaskMember, type TaskStatus } from "@/lib/tasks";
import { cn } from "@/lib/utils";

import { AssigneeAvatar, DueChip, PriorityChip, TaskLinkChip } from "./task-chips";

export interface TaskCardProps {
  task: Task;
  status: TaskStatus | null;
  assignee: TaskMember | null;
  onOpen: (task: Task) => void;
  isOverlay?: boolean;
}

/** Board card. Left accent = column colour; due + priority + link + owner. */
export function TaskCard({ task, status, assignee, onOpen, isOverlay }: TaskCardProps) {
  const done = isDoneStatus(status);
  return (
    <button
      type="button"
      onClick={(e) => {
        // Fires only for a real click: the PointerSensor needs 5px of
        // movement before it counts as a drag.
        if (isOverlay) return;
        e.stopPropagation();
        onOpen(task);
      }}
      className={cn(
        "group relative w-full cursor-pointer rounded-xl border border-border/50 bg-muted/70 py-2.5 pl-4 pr-3 text-left shadow-sm transition-all",
        isOverlay
          ? "shadow-xl"
          : "hover:-translate-y-0.5 hover:border-border hover:bg-muted hover:shadow-lg",
      )}
    >
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-1 rounded-l-xl"
        style={{ backgroundColor: status?.color ?? "#94a3b8" }}
      />
      <div className="flex items-start justify-between gap-2">
        <h4
          className={cn(
            "flex-1 break-words text-sm font-semibold leading-snug text-foreground",
            done && "text-muted-foreground line-through",
          )}
        >
          {task.title}
        </h4>
        <PriorityChip priority={task.priority} compact />
      </div>
      {task.description && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.description}</p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <TaskLinkChip task={task} className="-ml-1.5" />
          <DueChip dueAt={task.due_at} done={done} />
        </div>
        <AssigneeAvatar member={assignee} />
      </div>
    </button>
  );
}
