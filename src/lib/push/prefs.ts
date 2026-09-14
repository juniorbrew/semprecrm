// ============================================================
// Push notification preferences (spec round 2 §5) — pure.
//
// `profiles.notification_prefs` (migration 036) is a jsonb of
// `{ <event kind>: boolean }`. A missing key means ON, so a user who
// never opened Settings → Notificações gets every kind once they
// enable a browser. The first four kinds are the four triggers of the
// spec; `chat_message` is the internal team chat (migration 038).
// ============================================================

export const PUSH_EVENT_KINDS = [
  'inbound_message',
  'task_assigned',
  'task_due',
  'conversation_assigned',
  'chat_message',
] as const;
export type PushEventKind = (typeof PUSH_EVENT_KINDS)[number];

export type NotificationPrefs = Record<PushEventKind, boolean>;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  inbound_message: true,
  task_assigned: true,
  task_due: true,
  conversation_assigned: true,
  chat_message: true,
};

/** English labels — go through `t()` in the UI. */
export const PUSH_EVENT_LABELS: Record<PushEventKind, { title: string; description: string }> = {
  inbound_message: {
    title: 'New customer message',
    description: 'When a conversation assigned to you (or unassigned) receives a message and you are not looking at it.',
  },
  task_assigned: {
    title: 'Task assigned to me',
    description: 'When someone assigns you a task.',
  },
  task_due: {
    title: 'Task due soon',
    description: 'Fifteen minutes before one of your tasks is due.',
  },
  conversation_assigned: {
    title: 'Conversation assigned to me',
    description: 'When a conversation is handed to you.',
  },
  chat_message: {
    title: 'Internal chat messages',
    description: 'When a teammate sends you a message in the internal chat and you do not have the conversation open.',
  },
};

export function isPushEventKind(value: unknown): value is PushEventKind {
  return typeof value === 'string' && (PUSH_EVENT_KINDS as readonly string[]).includes(value);
}

/** Fill defaults over the raw jsonb. Never throws. */
export function parseNotificationPrefs(raw: unknown): NotificationPrefs {
  const out: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  for (const kind of PUSH_EVENT_KINDS) {
    if (typeof r[kind] === 'boolean') out[kind] = r[kind] as boolean;
  }
  return out;
}

/** Whether `userId`'s prefs allow `kind`. Missing row / key → allowed. */
export function prefAllows(raw: unknown, kind: PushEventKind): boolean {
  return parseNotificationPrefs(raw)[kind];
}
