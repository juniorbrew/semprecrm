// ============================================================
// List filtering and counters — pure, so the /tasks chips and the
// dashboard numbers are unit-testable without a DB.
//
// `listTasks` (queries.ts) fetches the account's tasks once (with
// the contact / deal refs embedded); these helpers slice that array
// for the current chip / select combination.
// ============================================================

import { isDueToday, isDueTodayOrOverdue, isOverdue } from './due';
import { isTaskDone } from './statuses';
import type { Task, TaskCounts, TaskListFilters, TaskStatus } from './types';

export interface FilterContext {
  /** The signed-in user — drives the "Minhas" chip. */
  userId: string | null;
  statuses: readonly TaskStatus[];
  now?: number;
}

function matchesSearch(task: Task, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    task.title,
    task.description ?? '',
    task.contact?.name ?? '',
    task.contact?.phone ?? '',
    task.deal?.title ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

/**
 * Apply the /tasks filters. The scope chip decides whether done
 * tasks show at all (`all` keeps them); the selects narrow further.
 * Order is preserved — sort separately with `sortTasks`.
 */
export function applyTaskFilters(
  tasks: readonly Task[],
  filters: TaskListFilters,
  ctx: FilterContext,
): Task[] {
  const now = ctx.now ?? Date.now();
  return tasks.filter((task) => {
    const done = isTaskDone(task, ctx.statuses);
    switch (filters.scope) {
      case 'mine':
        if (done) return false;
        if (!ctx.userId || task.assignee_user_id !== ctx.userId) return false;
        break;
      case 'today':
        if (done) return false;
        if (!isDueTodayOrOverdue(task.due_at, now)) return false;
        break;
      case 'overdue':
        if (done) return false;
        if (!isOverdue(task.due_at, now)) return false;
        break;
      case 'all':
        break;
    }
    if (filters.assigneeUserId) {
      if (filters.assigneeUserId === 'unassigned') {
        if (task.assignee_user_id) return false;
      } else if (task.assignee_user_id !== filters.assigneeUserId) {
        return false;
      }
    }
    if (filters.statusId && task.status_id !== filters.statusId) return false;
    if (filters.priority && task.priority !== filters.priority) return false;
    if (filters.search && !matchesSearch(task, filters.search)) return false;
    return true;
  });
}

const PRIORITY_RANK: Record<Task['priority'], number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * List order: open before done, then by due date (soonest first,
 * undated last), then priority, then newest. Stable for equal keys.
 */
export function sortTasks(tasks: readonly Task[], statuses: readonly TaskStatus[]): Task[] {
  const stamp = (iso: string | null) => {
    if (!iso) return Number.POSITIVE_INFINITY;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  return [...tasks].sort((a, b) => {
    const da = isTaskDone(a, statuses) ? 1 : 0;
    const db = isTaskDone(b, statuses) ? 1 : 0;
    if (da !== db) return da - db;
    const ta = stamp(a.due_at);
    const tb = stamp(b.due_at);
    if (ta !== tb) return ta - tb;
    const pa = PRIORITY_RANK[a.priority] ?? 2;
    const pb = PRIORITY_RANK[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    return stamp(b.created_at) - stamp(a.created_at);
  });
}

/** Board column order: by `position`, then newest first. */
export function sortForBoard(tasks: readonly Task[]): Task[] {
  return [...tasks].sort(
    (a, b) =>
      a.position - b.position ||
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

/** Header counters for /tasks and the sidebar badge. */
export function computeTaskCounts(
  tasks: readonly Task[],
  ctx: FilterContext,
): TaskCounts {
  const now = ctx.now ?? Date.now();
  let open = 0;
  let overdue = 0;
  let dueToday = 0;
  let mine = 0;
  for (const task of tasks) {
    if (isTaskDone(task, ctx.statuses)) continue;
    open += 1;
    if (isOverdue(task.due_at, now)) overdue += 1;
    else if (isDueToday(task.due_at, now)) dueToday += 1;
    if (ctx.userId && task.assignee_user_id === ctx.userId) mine += 1;
  }
  return { open, overdue, dueToday, mine };
}

/** Group tasks by status id (every status gets a bucket, even when empty). */
export function groupByStatus(
  tasks: readonly Task[],
  statuses: readonly TaskStatus[],
): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const s of statuses) map.set(s.id, []);
  for (const task of tasks) {
    const bucket = map.get(task.status_id);
    if (bucket) bucket.push(task);
  }
  for (const [id, bucket] of map) map.set(id, sortForBoard(bucket));
  return map;
}
