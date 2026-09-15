"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckSquare, Plus } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { useLanguage } from "@/hooks/use-language";
import {
  applyTaskFilters,
  completeTask,
  computeTaskCounts,
  listTasks,
  moveTaskInColumn,
  reopenTask,
  sortTasks,
  TASK_SCOPES,
  type Task,
  type TaskInput,
  type TaskListFilters,
  type TaskScope,
} from "@/lib/tasks";
import {
  TaskBoard,
  TaskDrawer,
  TaskFilters,
  TaskList,
  useTaskMembers,
  useTaskStatuses,
  useTasksRealtime,
  type TaskView,
} from "@/components/tasks";
import { GatedButton } from "@/components/ui/gated-button";

const VIEW_STORAGE_KEY = "semprecrm-tasks-view";

function readStoredView(): TaskView {
  if (typeof window === "undefined") return "list";
  try {
    const v = localStorage.getItem(VIEW_STORAGE_KEY);
    return v === "board" ? "board" : "list";
  } catch {
    return "list";
  }
}

function isScope(value: string | null): value is TaskScope {
  return !!value && (TASK_SCOPES as readonly string[]).includes(value);
}

export default function TasksPage() {
  const supabase = useMemo(() => createClient(), []);
  const { t } = useLanguage();
  const { accountId, user } = useAuth();
  const canWrite = useCan("send-messages");
  const searchParams = useSearchParams();

  const { statuses, loading: statusesLoading, refresh: refreshStatuses } = useTaskStatuses();
  const { members } = useTaskMembers();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  // `?filter=today` (dashboard card) picks the chip on arrival.
  const [filters, setFilters] = useState<TaskListFilters>(() => {
    const raw = searchParams.get("filter");
    return { scope: isScope(raw) ? raw : "all" };
  });
  const [view, setView] = useState<TaskView>("list");

  // Persisted view preference — read after mount so SSR and the first
  // client render agree.
  useEffect(() => {
    setView(readStoredView());
  }, []);
  const changeView = (next: TaskView) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {}
  };

  // Drawer: only the id is stored so it always renders the live row.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null);
  const [drawerDefaults, setDrawerDefaults] = useState<Partial<TaskInput> | undefined>();

  const load = useCallback(async () => {
    if (!accountId) return;
    try {
      const rows = await listTasks(supabase, { accountId });
      setTasks(rows);
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to load tasks"));
    } finally {
      setLoading(false);
    }
  }, [supabase, accountId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useTasksRealtime(
    () => {
      void load();
      void refreshStatuses();
    },
    { enabled: !!accountId, tables: ["tasks", "task_statuses"] },
  );

  const ctx = useMemo(
    () => ({ userId: user?.id ?? null, statuses }),
    [user?.id, statuses],
  );
  const counts = useMemo(() => computeTaskCounts(tasks, ctx), [tasks, ctx]);
  const visible = useMemo(
    () => sortTasks(applyTaskFilters(tasks, filters, ctx), statuses),
    [tasks, filters, ctx, statuses],
  );

  // ---- handlers ---------------------------------------------------
  const upsertLocal = useCallback((task: Task) => {
    setTasks((prev) => {
      const i = prev.findIndex((x) => x.id === task.id);
      if (i < 0) return [task, ...prev];
      const next = [...prev];
      // Keep the embedded refs when the update payload lacks them.
      next[i] = { ...prev[i], ...task, contact: task.contact ?? prev[i].contact, deal: task.deal ?? prev[i].deal };
      return next;
    });
  }, []);

  async function handleToggleDone(task: Task, done: boolean) {
    try {
      const updated = done
        ? await completeTask(supabase, task.id, statuses)
        : await reopenTask(supabase, task.id, statuses);
      upsertLocal(updated);
      toast.success(done ? t("Task completed") : t("Task reopened"));
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to save task"));
    }
  }

  async function handleMove(taskId: string, statusId: string, orderedIds: string[]) {
    // Optimistic — the board already animated the card.
    setTasks((prev) =>
      prev.map((task) => {
        const idx = orderedIds.indexOf(task.id);
        if (task.id === taskId) return { ...task, status_id: statusId, position: Math.max(idx, 0) };
        if (idx >= 0) return { ...task, position: idx };
        return task;
      }),
    );
    try {
      await moveTaskInColumn(supabase, taskId, statusId, orderedIds);
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to move task"));
    }
    await load();
  }

  function openTask(task: Task) {
    setDrawerTaskId(task.id);
    setDrawerDefaults(undefined);
    setDrawerOpen(true);
  }

  // `?task=<id>` (push notification click) opens that task once the
  // list has loaded. Applied a single time so closing the drawer sticks.
  const deepLinkTaskId = searchParams.get("task");
  const deepLinkAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!deepLinkTaskId || loading) return;
    if (deepLinkAppliedRef.current === deepLinkTaskId) return;
    if (!tasks.some((x) => x.id === deepLinkTaskId)) return;
    deepLinkAppliedRef.current = deepLinkTaskId;
    setDrawerTaskId(deepLinkTaskId);
    setDrawerDefaults(undefined);
    setDrawerOpen(true);
  }, [deepLinkTaskId, loading, tasks]);

  function openCreate(statusId?: string) {
    setDrawerTaskId(null);
    setDrawerDefaults(statusId ? { status_id: statusId } : undefined);
    setDrawerOpen(true);
  }

  const drawerTask = drawerTaskId ? tasks.find((x) => x.id === drawerTaskId) ?? null : null;

  if (loading || statusesLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="h-8 w-40 animate-pulse rounded bg-muted" />
          <div className="h-9 w-32 animate-pulse rounded-lg bg-muted" />
        </div>
        <div className="h-9 w-full animate-pulse rounded-lg bg-muted/60" />
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-muted/50" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 board-fit:flex board-fit:h-full board-fit:flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <CheckSquare className="h-4.5 w-4.5" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">{t("Tasks")}</h1>
            <p className="text-xs text-muted-foreground">
              {counts.open} {counts.open === 1 ? t("open task") : t("open tasks")}
              {counts.overdue > 0 && (
                <>
                  {" · "}
                  <span className="font-medium text-red-600 dark:text-red-400">
                    {counts.overdue} {counts.overdue === 1 ? t("overdue task") : t("overdue tasks")}
                  </span>
                </>
              )}
            </p>
          </div>
        </div>
        <GatedButton
          canAct={canWrite}
          gateReason="create tasks"
          onClick={() => openCreate()}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="mr-1 h-4 w-4" />
          {t("New task")}
        </GatedButton>
      </div>

      <TaskFilters
        filters={filters}
        onChange={setFilters}
        counts={counts}
        statuses={statuses}
        members={members}
        view={view}
        onViewChange={changeView}
      />

      {view === "board" ? (
        <TaskBoard
          tasks={visible}
          statuses={statuses}
          members={members}
          onOpen={openTask}
          onMove={handleMove}
          onAdd={canWrite ? openCreate : undefined}
          readOnly={!canWrite}
        />
      ) : (
        <TaskList
          tasks={visible}
          statuses={statuses}
          members={members}
          onOpen={openTask}
          onToggleDone={handleToggleDone}
          readOnly={!canWrite}
        />
      )}

      <TaskDrawer
        open={drawerOpen}
        onOpenChange={(next) => {
          setDrawerOpen(next);
          if (!next) setDrawerTaskId(null);
        }}
        task={drawerTask}
        defaults={drawerDefaults}
        statuses={statuses}
        members={members}
        onCreated={(task) => upsertLocal(task)}
        onUpdated={(task) => upsertLocal(task)}
        onDeleted={(id) => setTasks((prev) => prev.filter((x) => x.id !== id))}
      />
    </div>
  );
}
