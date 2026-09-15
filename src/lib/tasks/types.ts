// ============================================================
// Tasks module — shared types (migration 027).
//
// Everything the UI, the inbox / pipelines integrations and the
// automation step need to talk about tasks lives here. Row shapes
// mirror the DB columns; the `*Input` types are what the mutations
// accept.
// ============================================================

export const TASK_STATUS_KINDS = ['open', 'in_progress', 'done'] as const;
export type TaskStatusKind = (typeof TASK_STATUS_KINDS)[number];

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value);
}

/** One column of the account's task board (`task_statuses`). */
export interface TaskStatus {
  id: string;
  account_id: string;
  name: string;
  color: string;
  position: number;
  kind: TaskStatusKind;
  /** The status new tasks land on (exactly one per account). */
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

/** Minimal contact projection embedded on a task row. */
export interface TaskContactRef {
  id: string;
  name: string | null;
  phone: string;
  avatar_url: string | null;
}

/** Minimal deal projection embedded on a task row. */
export interface TaskDealRef {
  id: string;
  title: string;
  pipeline_id: string;
}

/**
 * An account member as the tasks UI needs it (assignee picker,
 * assignee chips, comment authors). Keyed by `user_id` because
 * `tasks.assignee_user_id` references `auth.users`.
 */
export interface TaskMember {
  user_id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
}

/** A `tasks` row plus the embedded refs `listTasks` selects. */
export interface Task {
  id: string;
  account_id: string;
  status_id: string;
  title: string;
  description: string | null;
  priority: TaskPriority;
  assignee_user_id: string | null;
  created_by: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  deal_id: string | null;
  due_at: string | null;
  completed_at: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  contact?: TaskContactRef | null;
  deal?: TaskDealRef | null;
  /** Resolved client-side from the members list (see `attachAssignees`). */
  assignee?: TaskMember | null;
}

export interface TaskComment {
  id: string;
  account_id: string;
  task_id: string;
  user_id: string | null;
  body: string;
  created_at: string;
  /** Resolved client-side from the members list. */
  author?: TaskMember | null;
}

/** Fields accepted when creating a task. Only `title` is required. */
export interface TaskInput {
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  /** Defaults to the account's default status when omitted. */
  status_id?: string | null;
  assignee_user_id?: string | null;
  contact_id?: string | null;
  conversation_id?: string | null;
  deal_id?: string | null;
  /** ISO timestamp. */
  due_at?: string | null;
}

/** Partial update — every field optional, `null` clears nullable ones. */
export type TaskPatch = Partial<TaskInput>;

export interface TaskStatusInput {
  name: string;
  color?: string;
  kind?: TaskStatusKind;
  is_default?: boolean;
}

/**
 * The quick-filter chips on /tasks.
 *   mine    — assigned to the current user, not done
 *   today   — due today (or overdue), not done
 *   overdue — due before now, not done
 *   all     — everything, done included
 */
export const TASK_SCOPES = ['mine', 'today', 'overdue', 'all'] as const;
export type TaskScope = (typeof TASK_SCOPES)[number];

export interface TaskListFilters {
  scope: TaskScope;
  /** `null` / undefined = any assignee; `'unassigned'` = no assignee. */
  assigneeUserId?: string | 'unassigned' | null;
  statusId?: string | null;
  priority?: TaskPriority | null;
  /** Case-insensitive match on title / description / contact name. */
  search?: string;
}

export interface TaskCounts {
  open: number;
  overdue: number;
  dueToday: number;
  mine: number;
}
