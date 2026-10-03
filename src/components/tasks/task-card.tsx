"use client";

import type { Ref } from "react";
import { Check, PanelRightOpen } from "lucide-react";

import { useLanguage } from "@/hooks/use-language";
import { isDoneStatus, type Task, type TaskMember, type TaskStatus } from "@/lib/tasks";
import { cn } from "@/lib/utils";

import { tasksCopy } from "./copy";
import { AssigneeAvatar, DueChip, PriorityChip, TaskLinkChip } from "./task-chips";

export interface TaskCardProps {
  task: Task;
  status: TaskStatus | null;
  assignee: TaskMember | null;
  onOpen: (task: Task) => void;
  /** Quick "Concluir" on hover / focus; omitted for read-only viewers. */
  onComplete?: (task: Task) => void;
  isOverlay?: boolean;
  /** This card's placeholder while its overlay is being dragged. */
  dragging?: boolean;
  compact?: boolean;
  /** Drag handle wiring (dnd-kit listeners + attributes) for the main button. */
  handleRef?: Ref<HTMLButtonElement>;
  handleProps?: Record<string, unknown>;
}

const QUICK_BUTTON =
  "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";

/**
 * Board card, same language as the deal card: flat, hairline border,
 * 3 px status accent, title + priority, a quiet line with link · due and
 * the owner. Quick actions (open, complete) on hover / focus-within.
 */
export function TaskCard({
  task,
  status,
  assignee,
  onOpen,
  onComplete,
  isOverlay,
  dragging,
  compact,
  handleRef,
  handleProps,
}: TaskCardProps) {
  const { language } = useLanguage();
  const copy = tasksCopy(language);
  const done = isDoneStatus(status);
  return (
    <div
      data-testid="task-card"
      className={cn(
        "group/card relative rounded-[calc(var(--radius)-2px)] border bg-card transition-[border-color,box-shadow] duration-150 motion-reduce:transition-none",
        isOverlay
          ? "border-primary/50 shadow-lg ring-2 ring-primary/30"
          : "border-border hover:border-primary/30 focus-within:border-primary/40",
      )}
    >
      <span
        aria-hidden
        className="absolute inset-y-2 left-0 w-[3px] rounded-r-full"
        style={{ backgroundColor: status?.color ?? "var(--muted-foreground)" }}
      />
      <button
        ref={handleRef}
        {...handleProps}
        type="button"
        aria-label={copy.open(task.title)}
        onClick={(e) => {
          // A tap still clicks: the PointerSensor needs 5px of movement
          // before it counts as a drag.
          if (isOverlay) return;
          e.stopPropagation();
          onOpen(task);
        }}
        className={cn(
          "block w-full cursor-pointer touch-none rounded-[inherit] pl-3.5 pr-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          compact ? "py-2" : "py-2.5",
        )}
      >
        <span className="flex items-start gap-2">
          <span
            className={cn(
              "flex-1 break-words text-sm font-medium leading-snug text-foreground",
              compact ? "line-clamp-1" : "line-clamp-2",
              done && "text-muted-foreground line-through",
            )}
          >
            {task.title}
          </span>
          <PriorityChip priority={task.priority} compact />
        </span>
        {!compact && task.description && (
          <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">{task.description}</span>
        )}
        <span className={cn("flex items-center gap-2", compact ? "mt-1" : "mt-2")}>
          <DueChip dueAt={task.due_at} done={done} className="-ml-1.5" />
          <AssigneeAvatar member={assignee} className="ml-auto" />
        </span>
      </button>
      {/* The link lives outside the main button (no nested interactives). */}
      {!compact && (task.deal || task.contact) && (
        <div className="-mt-1.5 pb-2 pl-2 pr-3">
          <TaskLinkChip task={task} />
        </div>
      )}

      {!isOverlay && !dragging && (
        <div
          role="toolbar"
          aria-label={copy.toolbar(task.title)}
          data-testid="task-quick-actions"
          className="absolute right-1.5 top-1.5 hidden gap-0.5 rounded-md border border-border bg-popover p-0.5 shadow-sm group-focus-within/card:flex group-hover/card:flex"
        >
          <button
            type="button"
            onClick={() => onOpen(task)}
            aria-label={copy.open(task.title)}
            title={copy.open(task.title)}
            className={QUICK_BUTTON}
          >
            <PanelRightOpen className="size-3.5" aria-hidden />
          </button>
          {onComplete && !done && (
            <button
              type="button"
              onClick={() => onComplete(task)}
              aria-label={copy.completeAria(task.title)}
              title={copy.complete}
              data-action="complete"
              className={cn(QUICK_BUTTON, "hover:text-emerald-600 dark:hover:text-emerald-400")}
            >
              <Check className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
