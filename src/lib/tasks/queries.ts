// ============================================================
// Tasks — read side. Every function takes the Supabase client so it
// works with the browser client (RLS-scoped) and the service-role
// client (automation engine) alike. No `next/*` imports.
//
// Errors are thrown (as `Error` with the PostgREST message) so
// callers can `try / catch` + toast in one place.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  Task,
  TaskComment,
  TaskMember,
  TaskStatus,
} from './types';

// The app's Supabase client is created without generated Database
// types, so the untyped default is what callers hold.
export type TasksClient = Pick<SupabaseClient, 'from'>;

/** Columns + embeds every task read uses. */
export const TASK_SELECT =
  '*, contact:contacts(id, name, phone, avatar_url), deal:deals(id, title, pipeline_id)';

function fail(prefix: string, error: { message: string } | null): never {
  throw new Error(`${prefix}: ${error?.message ?? 'unknown error'}`);
}

// ------------------------------------------------------------
// Statuses
// ------------------------------------------------------------

/** The account's statuses in board order. RLS scopes to the caller's account. */
export async function listTaskStatuses(
  db: TasksClient,
  accountId?: string | null,
): Promise<TaskStatus[]> {
  let q = db.from('task_statuses').select('*').order('position').order('name');
  if (accountId) q = q.eq('account_id', accountId);
  const { data, error } = await q;
  if (error) fail('Failed to load task statuses', error);
  return (data ?? []) as TaskStatus[];
}

// ------------------------------------------------------------
// Members
// ------------------------------------------------------------

/** Account members for the assignee picker / chips (profiles RLS = same account). */
export async function listTaskMembers(
  db: TasksClient,
  accountId?: string | null,
): Promise<TaskMember[]> {
  let q = db
    .from('profiles')
    .select('user_id, full_name, email, avatar_url')
    .order('full_name');
  if (accountId) q = q.eq('account_id', accountId);
  const { data, error } = await q;
  if (error) fail('Failed to load members', error);
  return (data ?? []) as TaskMember[];
}

/** Fill `task.assignee` from a members list (PostgREST can't embed auth.users). */
export function attachAssignees<T extends Pick<Task, 'assignee_user_id'>>(
  tasks: readonly T[],
  members: readonly TaskMember[],
): (T & { assignee: TaskMember | null })[] {
  const byId = new Map(members.map((m) => [m.user_id, m]));
  return tasks.map((t) => ({
    ...t,
    assignee: t.assignee_user_id ? byId.get(t.assignee_user_id) ?? null : null,
  }));
}

/** Same for comments (`author`). */
export function attachAuthors(
  comments: readonly TaskComment[],
  members: readonly TaskMember[],
): TaskComment[] {
  const byId = new Map(members.map((m) => [m.user_id, m]));
  return comments.map((c) => ({
    ...c,
    author: c.user_id ? byId.get(c.user_id) ?? null : null,
  }));
}

// ------------------------------------------------------------
// Tasks
// ------------------------------------------------------------

export interface ListTasksOptions {
  accountId?: string | null;
  contactId?: string;
  dealId?: string;
  conversationId?: string;
  assigneeUserId?: string;
  /** Restrict to these status ids (e.g. `openStatusIds(statuses)`). */
  statusIds?: readonly string[];
  /** Only tasks due strictly before this ISO timestamp. */
  dueBefore?: string;
  /** Only tasks due at/after this ISO timestamp. */
  dueAfter?: string;
  limit?: number;
}

/**
 * Tasks with contact / deal refs. Server-side narrowing is optional
 * — the /tasks page fetches the whole account and slices with
 * `applyTaskFilters`; the inbox / pipelines panels pass `contactId`
 * / `dealId` + `statusIds`.
 */
export async function listTasks(
  db: TasksClient,
  opts: ListTasksOptions = {},
): Promise<Task[]> {
  let q = db
    .from('tasks')
    .select(TASK_SELECT)
    .order('position')
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (opts.accountId) q = q.eq('account_id', opts.accountId);
  if (opts.contactId) q = q.eq('contact_id', opts.contactId);
  if (opts.dealId) q = q.eq('deal_id', opts.dealId);
  if (opts.conversationId) q = q.eq('conversation_id', opts.conversationId);
  if (opts.assigneeUserId) q = q.eq('assignee_user_id', opts.assigneeUserId);
  if (opts.statusIds) {
    if (opts.statusIds.length === 0) return [];
    q = q.in('status_id', [...opts.statusIds]);
  }
  if (opts.dueBefore) q = q.lt('due_at', opts.dueBefore);
  if (opts.dueAfter) q = q.gte('due_at', opts.dueAfter);
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) fail('Failed to load tasks', error);
  return (data ?? []) as Task[];
}

/** Open tasks of a contact (inbox panel). */
export function listTasksByContact(
  db: TasksClient,
  contactId: string,
  statuses: readonly TaskStatus[],
): Promise<Task[]> {
  return listTasks(db, {
    contactId,
    statusIds: statuses.filter((s) => s.kind !== 'done').map((s) => s.id),
  });
}

/** Open tasks of a deal (deal drawer). */
export function listTasksByDeal(
  db: TasksClient,
  dealId: string,
  statuses: readonly TaskStatus[],
): Promise<Task[]> {
  return listTasks(db, {
    dealId,
    statusIds: statuses.filter((s) => s.kind !== 'done').map((s) => s.id),
  });
}

/** One task (or null when missing / not visible). */
export async function getTask(db: TasksClient, taskId: string): Promise<Task | null> {
  const { data, error } = await db
    .from('tasks')
    .select(TASK_SELECT)
    .eq('id', taskId)
    .maybeSingle();
  if (error) fail('Failed to load task', error);
  return (data as Task | null) ?? null;
}

/**
 * Counts for the sidebar badge / dashboard without pulling every row:
 * open tasks, of which overdue, for the whole account or one user.
 */
export async function countOpenTasks(
  db: TasksClient,
  statuses: readonly TaskStatus[],
  opts: { accountId?: string | null; assigneeUserId?: string; now?: Date } = {},
): Promise<{ open: number; overdue: number }> {
  const openIds = statuses.filter((s) => s.kind !== 'done').map((s) => s.id);
  if (openIds.length === 0) return { open: 0, overdue: 0 };
  const nowIso = (opts.now ?? new Date()).toISOString();
  const base = () => {
    let q = db.from('tasks').select('id', { count: 'exact', head: true }).in('status_id', openIds);
    if (opts.accountId) q = q.eq('account_id', opts.accountId);
    if (opts.assigneeUserId) q = q.eq('assignee_user_id', opts.assigneeUserId);
    return q;
  };
  const [openRes, overdueRes] = await Promise.all([base(), base().lt('due_at', nowIso)]);
  if (openRes.error) fail('Failed to count tasks', openRes.error);
  if (overdueRes.error) fail('Failed to count tasks', overdueRes.error);
  return { open: openRes.count ?? 0, overdue: overdueRes.count ?? 0 };
}

// ------------------------------------------------------------
// Comments
// ------------------------------------------------------------

export async function listTaskComments(
  db: TasksClient,
  taskId: string,
): Promise<TaskComment[]> {
  const { data, error } = await db
    .from('task_comments')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at');
  if (error) fail('Failed to load comments', error);
  return (data ?? []) as TaskComment[];
}
