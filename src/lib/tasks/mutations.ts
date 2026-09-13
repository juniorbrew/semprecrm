// ============================================================
// Tasks — write side. Same client contract as queries.ts: pass the
// Supabase client in, get the updated row back, errors are thrown.
//
// RLS (027): agent+ writes tasks / comments, admin+ writes statuses.
// The DB trigger keeps `completed_at` in sync with the status kind,
// so nothing here touches that column.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { TASK_SELECT, type TasksClient } from './queries';
import {
  canDeleteStatus,
  defaultStatus,
  defaultStatusForKind,
  doneStatus,
  nextStatusPosition,
} from './statuses';
import type {
  Task,
  TaskComment,
  TaskInput,
  TaskPatch,
  TaskStatus,
  TaskStatusInput,
} from './types';

type WriteClient = Pick<SupabaseClient, 'from'>;

function fail(prefix: string, error: { message: string } | null): never {
  throw new Error(`${prefix}: ${error?.message ?? 'unknown error'}`);
}

function clean(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

// ------------------------------------------------------------
// Tasks
// ------------------------------------------------------------

export interface CreateTaskContext {
  accountId: string;
  /** Becomes `created_by`. */
  userId: string | null;
  /** Needed to resolve the default status when `input.status_id` is empty. */
  statuses: readonly TaskStatus[];
}

/** Insert a task. `title` is trimmed and required. */
export async function createTask(
  db: WriteClient,
  ctx: CreateTaskContext,
  input: TaskInput,
): Promise<Task> {
  const title = input.title.trim();
  if (!title) throw new Error('Task title is required');
  const statusId = input.status_id || defaultStatus(ctx.statuses)?.id;
  if (!statusId) throw new Error('No task status available');

  const { data, error } = await db
    .from('tasks')
    .insert({
      account_id: ctx.accountId,
      created_by: ctx.userId,
      status_id: statusId,
      title,
      description: clean(input.description),
      priority: input.priority ?? 'normal',
      assignee_user_id: input.assignee_user_id || null,
      contact_id: input.contact_id || null,
      conversation_id: input.conversation_id || null,
      deal_id: input.deal_id || null,
      due_at: input.due_at || null,
    })
    .select(TASK_SELECT)
    .single();
  if (error || !data) fail('Failed to create task', error);
  return data as Task;
}

/** Patch any subset of editable fields. */
export async function updateTask(
  db: WriteClient,
  taskId: string,
  patch: TaskPatch,
): Promise<Task> {
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error('Task title is required');
    row.title = title;
  }
  if (patch.description !== undefined) row.description = clean(patch.description);
  if (patch.priority !== undefined) row.priority = patch.priority;
  if (patch.status_id !== undefined && patch.status_id) row.status_id = patch.status_id;
  if (patch.assignee_user_id !== undefined) row.assignee_user_id = patch.assignee_user_id || null;
  if (patch.contact_id !== undefined) row.contact_id = patch.contact_id || null;
  if (patch.conversation_id !== undefined) row.conversation_id = patch.conversation_id || null;
  if (patch.deal_id !== undefined) row.deal_id = patch.deal_id || null;
  if (patch.due_at !== undefined) row.due_at = patch.due_at || null;

  const { data, error } = await db
    .from('tasks')
    .update(row)
    .eq('id', taskId)
    .select(TASK_SELECT)
    .single();
  if (error || !data) fail('Failed to update task', error);
  return data as Task;
}

/**
 * Board move: new column and slot. `position` is the index inside
 * the target column; siblings are not renumbered (ties resolve by
 * created_at), which keeps a drag to one round-trip.
 */
export async function moveTask(
  db: WriteClient,
  taskId: string,
  statusId: string,
  position: number,
): Promise<Task> {
  const { data, error } = await db
    .from('tasks')
    .update({ status_id: statusId, position })
    .eq('id', taskId)
    .select(TASK_SELECT)
    .single();
  if (error || !data) fail('Failed to move task', error);
  return data as Task;
}

/**
 * Board drop with ordering: `orderedIds` is the full id list of the
 * target column after the drop (the moved task included). The moved
 * task gets the new status; every task in the column gets its index
 * as `position`. Columns are small, so parallel single-row updates
 * beat an upsert that would have to echo every NOT NULL column.
 */
export async function moveTaskInColumn(
  db: WriteClient,
  taskId: string,
  statusId: string,
  orderedIds: readonly string[],
): Promise<void> {
  const writes = orderedIds.map((id, position) =>
    db
      .from('tasks')
      .update(id === taskId ? { status_id: statusId, position } : { position })
      .eq('id', id),
  );
  if (!orderedIds.includes(taskId)) {
    writes.push(db.from('tasks').update({ status_id: statusId, position: orderedIds.length }).eq('id', taskId));
  }
  const results = await Promise.all(writes);
  const failed = results.find((r) => r.error);
  if (failed?.error) fail('Failed to move task', failed.error);
}

/** Checkbox / "Concluir": move to the first `done` status. */
export async function completeTask(
  db: WriteClient,
  taskId: string,
  statuses: readonly TaskStatus[],
): Promise<Task> {
  const done = doneStatus(statuses);
  if (!done) throw new Error('No done status configured');
  return moveTask(db, taskId, done.id, 0);
}

/** Undo a completion: back to the default (open) status. */
export async function reopenTask(
  db: WriteClient,
  taskId: string,
  statuses: readonly TaskStatus[],
): Promise<Task> {
  const target = defaultStatus(statuses);
  if (!target) throw new Error('No open status configured');
  return moveTask(db, taskId, target.id, 0);
}

export async function deleteTask(db: WriteClient, taskId: string): Promise<void> {
  const { error } = await db.from('tasks').delete().eq('id', taskId);
  if (error) fail('Failed to delete task', error);
}

// ------------------------------------------------------------
// Comments
// ------------------------------------------------------------

export async function addTaskComment(
  db: WriteClient,
  params: { accountId: string; taskId: string; userId: string | null; body: string },
): Promise<TaskComment> {
  const body = params.body.trim();
  if (!body) throw new Error('Comment is empty');
  const { data, error } = await db
    .from('task_comments')
    .insert({
      account_id: params.accountId,
      task_id: params.taskId,
      user_id: params.userId,
      body,
    })
    .select('*')
    .single();
  if (error || !data) fail('Failed to add comment', error);
  return data as TaskComment;
}

export async function deleteTaskComment(db: WriteClient, commentId: string): Promise<void> {
  const { error } = await db.from('task_comments').delete().eq('id', commentId);
  if (error) fail('Failed to delete comment', error);
}

// ------------------------------------------------------------
// Statuses (admin+)
// ------------------------------------------------------------

/** Append a status at the end of the board. */
export async function createTaskStatus(
  db: WriteClient,
  accountId: string,
  existing: readonly TaskStatus[],
  input: TaskStatusInput,
): Promise<TaskStatus> {
  const name = input.name.trim();
  if (!name) throw new Error('Status name is required');
  const { data, error } = await db
    .from('task_statuses')
    .insert({
      account_id: accountId,
      name,
      color: input.color ?? '#3b82f6',
      kind: input.kind ?? 'open',
      is_default: false,
      position: nextStatusPosition(existing),
    })
    .select('*')
    .single();
  if (error || !data) fail('Failed to create status', error);
  const created = data as TaskStatus;
  if (input.is_default) await setDefaultTaskStatus(db, accountId, created.id);
  return created;
}

export async function updateTaskStatus(
  db: WriteClient,
  statusId: string,
  patch: Partial<Pick<TaskStatus, 'name' | 'color' | 'kind'>>,
): Promise<TaskStatus> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('Status name is required');
    row.name = name;
  }
  if (patch.color !== undefined) row.color = patch.color;
  if (patch.kind !== undefined) row.kind = patch.kind;
  const { data, error } = await db
    .from('task_statuses')
    .update(row)
    .eq('id', statusId)
    .select('*')
    .single();
  if (error || !data) fail('Failed to update status', error);
  return data as TaskStatus;
}

/** Exactly one default per account: clear the others, flag this one. */
export async function setDefaultTaskStatus(
  db: WriteClient,
  accountId: string,
  statusId: string,
): Promise<void> {
  const clear = await db
    .from('task_statuses')
    .update({ is_default: false })
    .eq('account_id', accountId)
    .neq('id', statusId);
  if (clear.error) fail('Failed to update default status', clear.error);
  const set = await db.from('task_statuses').update({ is_default: true }).eq('id', statusId);
  if (set.error) fail('Failed to update default status', set.error);
}

/**
 * Persist a new board order. One upsert; the UNIQUE(account_id,
 * position) constraint is deferrable so swaps inside the statement
 * are fine.
 */
export async function reorderTaskStatuses(
  db: WriteClient,
  ordered: readonly TaskStatus[],
): Promise<void> {
  if (ordered.length === 0) return;
  const rows = ordered.map((s, i) => ({
    id: s.id,
    account_id: s.account_id,
    name: s.name,
    color: s.color,
    kind: s.kind,
    is_default: s.is_default,
    position: i,
  }));
  const { error } = await db.from('task_statuses').upsert(rows, { onConflict: 'id' });
  if (error) fail('Failed to reorder statuses', error);
}

/**
 * Delete a status, first moving its tasks to the default status of
 * the same kind. Refuses when it is the last of its kind (the app
 * rule "one of each kind"). Returns the id the tasks were moved to.
 */
export async function deleteTaskStatus(
  db: WriteClient,
  statuses: readonly TaskStatus[],
  statusId: string,
): Promise<{ movedTo: string }> {
  const target = statuses.find((s) => s.id === statusId);
  if (!target) throw new Error('Status not found');
  if (!canDeleteStatus(statuses, statusId)) {
    throw new Error('Cannot delete the last status of its kind');
  }
  const fallback = defaultStatusForKind(statuses, target.kind, statusId);
  if (!fallback) throw new Error('Cannot delete the last status of its kind');

  const moved = await db
    .from('tasks')
    .update({ status_id: fallback.id })
    .eq('status_id', statusId);
  if (moved.error) fail('Failed to reassign tasks', moved.error);

  const del = await db.from('task_statuses').delete().eq('id', statusId);
  if (del.error) fail('Failed to delete status', del.error);

  // Keep exactly one default when the deleted one carried the flag.
  if (target.is_default) {
    await setDefaultTaskStatus(db, target.account_id, fallback.id);
  }
  return { movedTo: fallback.id };
}

export type { TasksClient };
