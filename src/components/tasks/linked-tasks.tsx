"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useLanguage } from "@/hooks/use-language";
import {
  completeTask,
  isDoneStatus,
  listTasksByContact,
  listTasksByDeal,
  sortTasks,
  type Task,
  type TaskStatus,
} from "@/lib/tasks";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

import { useTaskStatuses, useTasksRealtime } from "./hooks";
import { DueChip, PriorityChip } from "./task-chips";

// ------------------------------------------------------------
// useLinkedTasks — open tasks of one contact or one deal, kept live
// through the tasks realtime channel. Shared by the inbox contact
// panel and the deal drawer so both surfaces behave the same way.
// ------------------------------------------------------------

export interface UseLinkedTasksOptions {
  contactId?: string | null;
  dealId?: string | null;
  /** Skip loading (module off, viewer without a contact, …). */
  enabled?: boolean;
}

export interface LinkedTasksState {
  tasks: Task[];
  statuses: TaskStatus[];
  loading: boolean;
  refresh: () => Promise<void>;
  /** Optimistic complete via the account's done status. */
  complete: (task: Task) => Promise<void>;
  /** Append a task the quick-create just inserted. */
  add: (task: Task) => void;
  /** Merge a row edited in the drawer (drops it when it is now done). */
  patch: (task: Task) => void;
  remove: (taskId: string) => void;
}

export function useLinkedTasks({
  contactId,
  dealId,
  enabled = true,
}: UseLinkedTasksOptions): LinkedTasksState {
  const { t } = useLanguage();
  const active = enabled && !!(contactId || dealId);
  const { statuses } = useTaskStatuses({ enabled: active });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(active);

  const refresh = useCallback(async () => {
    if (!active || statuses.length === 0) return;
    try {
      const db = createClient();
      const rows = dealId
        ? await listTasksByDeal(db, dealId, statuses)
        : await listTasksByContact(db, contactId as string, statuses);
      setTasks(sortTasks(rows, statuses));
    } catch (err) {
      console.error("[tasks] linked list:", err);
    } finally {
      setLoading(false);
    }
  }, [active, statuses, dealId, contactId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Teammates completing or adding tasks show up without a reload.
  useTasksRealtime(() => void refresh(), { enabled: active, tables: ["tasks"] });

  const complete = useCallback(
    async (task: Task) => {
      setTasks((prev) => prev.filter((x) => x.id !== task.id));
      try {
        await completeTask(createClient(), task.id, statuses);
        toast.success(t("Task completed"));
      } catch (err) {
        console.error("[tasks] complete:", err);
        toast.error(t("Failed to save task"));
        void refresh();
      }
    },
    [statuses, t, refresh],
  );

  const add = useCallback(
    (task: Task) => {
      setTasks((prev) => sortTasks([task, ...prev.filter((x) => x.id !== task.id)], statuses));
    },
    [statuses],
  );

  const patch = useCallback(
    (task: Task) => {
      setTasks((prev) => {
        const status = statuses.find((s) => s.id === task.status_id) ?? null;
        const next = prev.filter((x) => x.id !== task.id);
        if (isDoneStatus(status)) return next;
        return sortTasks([...next, task], statuses);
      });
    },
    [statuses],
  );

  const remove = useCallback((taskId: string) => {
    setTasks((prev) => prev.filter((x) => x.id !== taskId));
  }, []);

  return useMemo(
    () => ({ tasks, statuses, loading, refresh, complete, add, patch, remove }),
    [tasks, statuses, loading, refresh, complete, add, patch, remove],
  );
}

// ------------------------------------------------------------
// LinkedTaskRows — compact rows for a side panel: checkbox, title,
// due chip (red overdue / amber today), priority when it matters.
// ------------------------------------------------------------

export interface LinkedTaskRowsProps {
  tasks: Task[];
  onComplete: (task: Task) => void;
  onOpen?: (task: Task) => void;
  readOnly?: boolean;
  emptyLabel: string;
  className?: string;
}

export function LinkedTaskRows({
  tasks,
  onComplete,
  onOpen,
  readOnly,
  emptyLabel,
  className,
}: LinkedTaskRowsProps) {
  const { t } = useLanguage();

  if (tasks.length === 0) {
    return <p className={cn("text-xs text-muted-foreground", className)}>{emptyLabel}</p>;
  }

  return (
    <ul className={cn("space-y-1", className)}>
      {tasks.map((task) => (
        <li
          key={task.id}
          className="group/task flex items-start gap-2 rounded-lg bg-muted px-2 py-1.5 transition-colors hover:bg-muted/70"
        >
          <Checkbox
            checked={false}
            disabled={readOnly}
            aria-label={t("Complete task")}
            title={t("Complete task")}
            onCheckedChange={(checked) => {
              if (checked === true) onComplete(task);
            }}
            className="mt-0.5"
          />
          <button
            type="button"
            onClick={() => onOpen?.(task)}
            disabled={!onOpen}
            className="min-w-0 flex-1 text-left disabled:cursor-default"
          >
            <span className="block truncate text-xs font-medium text-foreground">
              {task.title}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-1 gap-y-0.5">
              <DueChip dueAt={task.due_at} className="-ml-1.5" />
              <PriorityChip priority={task.priority} compact />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
