// ============================================================
// Task statuses — pure helpers (no I/O).
//
// The account's statuses are its board columns. Rules enforced in
// the app (the DB only stores the rows):
//   - at least one status of each `kind` (open / in_progress / done)
//   - exactly one `is_default` (where new tasks land)
//   - deleting a status reassigns its tasks to the default of the
//     same kind
// ============================================================

import type { Task, TaskStatus, TaskStatusKind } from './types';
import { TASK_STATUS_KINDS } from './types';

/** Palette offered in Configurações → Tarefas (same family as pipeline stages). */
export const TASK_STATUS_COLORS = [
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#f43f5e',
  '#f97316',
  '#f59e0b',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#06b6d4',
  '#64748b',
] as const;

/** Seed the DB function `seed_task_statuses` also creates (kept for the UI's "restore defaults"). */
export const DEFAULT_TASK_STATUS_SEED: ReadonlyArray<
  Pick<TaskStatus, 'name' | 'color' | 'position' | 'kind' | 'is_default'>
> = [
  { name: 'A fazer', color: '#3b82f6', position: 0, kind: 'open', is_default: true },
  { name: 'Em andamento', color: '#f59e0b', position: 1, kind: 'in_progress', is_default: false },
  { name: 'Concluída', color: '#22c55e', position: 2, kind: 'done', is_default: false },
];

/** English keys (run through `t()`) for each kind. */
export const TASK_STATUS_KIND_LABELS: Record<TaskStatusKind, string> = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
};

export function isTaskStatusKind(value: unknown): value is TaskStatusKind {
  return (
    typeof value === 'string' &&
    (TASK_STATUS_KINDS as readonly string[]).includes(value)
  );
}

/** Stable board order: by position, then name as a tiebreaker. */
export function sortStatuses<T extends Pick<TaskStatus, 'position' | 'name'>>(
  statuses: readonly T[],
): T[] {
  return [...statuses].sort(
    (a, b) => a.position - b.position || a.name.localeCompare(b.name),
  );
}

/**
 * Where a new task lands: the flagged default, else the first `open`
 * status, else the first status at all. `null` only for an account
 * with no statuses (should not happen after the 027 backfill).
 */
export function defaultStatus(statuses: readonly TaskStatus[]): TaskStatus | null {
  const sorted = sortStatuses(statuses);
  return (
    sorted.find((s) => s.is_default) ??
    sorted.find((s) => s.kind === 'open') ??
    sorted[0] ??
    null
  );
}

/**
 * The status a task is moved to when it is "completed" (checkbox,
 * "Concluir" button): the first `done` status in board order.
 */
export function doneStatus(statuses: readonly TaskStatus[]): TaskStatus | null {
  return sortStatuses(statuses).find((s) => s.kind === 'done') ?? null;
}

/**
 * Default target for a given kind — used when deleting a status to
 * pick where its tasks go. Prefers the account default when it has
 * that kind, otherwise the first status of the kind in board order.
 * `exceptId` lets the caller skip the status being deleted.
 */
export function defaultStatusForKind(
  statuses: readonly TaskStatus[],
  kind: TaskStatusKind,
  exceptId?: string,
): TaskStatus | null {
  const candidates = sortStatuses(statuses).filter(
    (s) => s.kind === kind && s.id !== exceptId,
  );
  return candidates.find((s) => s.is_default) ?? candidates[0] ?? null;
}

/** `true` when the status' kind counts as finished. */
export function isDoneStatus(status: Pick<TaskStatus, 'kind'> | null | undefined): boolean {
  return status?.kind === 'done';
}

/** `true` when the task sits on a done status. */
export function isTaskDone(
  task: Pick<Task, 'status_id'>,
  statuses: readonly TaskStatus[],
): boolean {
  return isDoneStatus(statuses.find((s) => s.id === task.status_id));
}

/** Set of status ids whose kind is not `done` — handy for "open tasks" queries. */
export function openStatusIds(statuses: readonly TaskStatus[]): string[] {
  return statuses.filter((s) => s.kind !== 'done').map((s) => s.id);
}

export type StatusSetProblem =
  | { code: 'missing_kind'; kind: TaskStatusKind }
  | { code: 'no_default' }
  | { code: 'multiple_defaults' }
  | { code: 'empty_name'; id: string };

/**
 * Validate a full set of statuses (as the settings panel would save
 * it). Returns every problem found; an empty array means valid.
 */
export function validateStatusSet(
  statuses: readonly Pick<TaskStatus, 'id' | 'name' | 'kind' | 'is_default'>[],
): StatusSetProblem[] {
  const problems: StatusSetProblem[] = [];
  for (const kind of TASK_STATUS_KINDS) {
    if (!statuses.some((s) => s.kind === kind)) {
      problems.push({ code: 'missing_kind', kind });
    }
  }
  const defaults = statuses.filter((s) => s.is_default).length;
  if (defaults === 0 && statuses.length > 0) problems.push({ code: 'no_default' });
  if (defaults > 1) problems.push({ code: 'multiple_defaults' });
  for (const s of statuses) {
    if (!s.name.trim()) problems.push({ code: 'empty_name', id: s.id });
  }
  return problems;
}

/**
 * Whether `statusId` may be deleted: another status of the same kind
 * must remain so the "one of each kind" rule survives and there is a
 * place to move its tasks to.
 */
export function canDeleteStatus(
  statuses: readonly TaskStatus[],
  statusId: string,
): boolean {
  const target = statuses.find((s) => s.id === statusId);
  if (!target) return false;
  return statuses.some((s) => s.id !== statusId && s.kind === target.kind);
}

/** Next free `position` for a new status (append at the end). */
export function nextStatusPosition(statuses: readonly Pick<TaskStatus, 'position'>[]): number {
  return statuses.reduce((max, s) => Math.max(max, s.position + 1), 0);
}

/**
 * Apply `is_default = true` to `id` and clear it everywhere else —
 * the shape the settings panel writes back so exactly one default
 * remains.
 */
export function withDefault<T extends Pick<TaskStatus, 'id' | 'is_default'>>(
  statuses: readonly T[],
  id: string,
): T[] {
  return statuses.map((s) => ({ ...s, is_default: s.id === id }));
}

/** Re-number `position` 0..n-1 following the array order. */
export function renumberPositions<T extends Pick<TaskStatus, 'position'>>(
  statuses: readonly T[],
): T[] {
  return statuses.map((s, i) => ({ ...s, position: i }));
}
