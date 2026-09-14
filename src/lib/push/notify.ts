// ============================================================
// Push triggers (spec round 2 §5) — who gets what.
//
// One function per trigger; each resolves the recipients server-side
// (never trusting a client-supplied list), drops the users whose
// `notification_prefs` turned the kind off, drops the actor, and hands
// the rest to `sendPushToUsers`. All of them swallow errors: a push
// must never break the inbound webhook, a task save or the cron.
//
//   (a) notifyInboundMessage        — inbound.ts, after the message row
//   (b) notifyTaskAssigned          — POST /api/push/notify (task_assigned)
//   (c) notifyTasksDueSoon          — /api/automations/cron
//   (d) notifyConversationAssigned  — POST /api/push/notify
//                                     (conversation_assigned)
//   (e) notifyChatMessage           — POST /api/push/notify (chat_message)
//                                     internal team chat, migration 038
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { DEFAULT_LANGUAGE, translateLiteral } from '@/lib/i18n'

import { isFocusedOn, isFocusedOnChatThread } from './focus'
import { parseNotificationPrefs, type PushEventKind } from './prefs'
import { sendPushToUsers, type SendPushResult } from './send'

const NOOP: SendPushResult = { users: 0, sent: 0, failed: 0, removed: 0, configured: true }

/**
 * Notification copy is rendered server-side, where the viewer's
 * browser language is unknown — use the app default (pt-BR) through
 * the same catalogue the UI uses (entries live in i18n-extra.ts).
 */
function tr(english: string): string {
  return translateLiteral(english, DEFAULT_LANGUAGE)
}

const AGENT_PLUS = ['owner', 'admin', 'agent'] as const

interface ProfileLite {
  user_id: string
  account_id: string
  account_role: string
  availability: string | null
  notification_prefs: unknown
}

async function loadProfiles(
  admin: SupabaseClient,
  accountId: string,
  userIds: readonly string[] | null,
): Promise<ProfileLite[]> {
  let q = admin
    .from('profiles')
    .select('user_id, account_id, account_role, availability, notification_prefs')
    .eq('account_id', accountId)
  if (userIds) {
    if (userIds.length === 0) return []
    q = q.in('user_id', userIds as string[])
  }
  const { data, error } = await q
  if (error) {
    console.error('[push] failed to load profiles:', error.message)
    return []
  }
  return (data ?? []) as ProfileLite[]
}

function allowed(profiles: ProfileLite[], kind: PushEventKind): string[] {
  return profiles
    .filter((p) => parseNotificationPrefs(p.notification_prefs)[kind])
    .map((p) => p.user_id)
}

/** Conversation deep link the inbox understands (`?c=<id>`). */
export function conversationUrl(conversationId: string): string {
  return `/inbox?c=${encodeURIComponent(conversationId)}`
}

export function taskUrl(taskId: string): string {
  return `/tasks?task=${encodeURIComponent(taskId)}`
}

/** Internal chat deep link (`/chat?t=<thread id>`). */
export function chatThreadUrl(threadId: string): string {
  return `/chat?t=${encodeURIComponent(threadId)}`
}

// ------------------------------------------------------------
// (a) Inbound message
// ------------------------------------------------------------

export interface InboundMessageNotice {
  accountId: string
  conversationId: string
  /** `conversations.assigned_agent_id` after auto-assign, if any. */
  assigneeUserId: string | null
  contactName: string
  /** Message text or a `[image]`-style placeholder. */
  preview: string
}

/**
 * Assigned → the assignee. Unassigned → every available agent+ member.
 * Users focused on the conversation (POST /api/push/seen) are skipped.
 */
export async function notifyInboundMessage(
  admin: SupabaseClient,
  notice: InboundMessageNotice,
): Promise<SendPushResult> {
  try {
    const profiles = notice.assigneeUserId
      ? await loadProfiles(admin, notice.accountId, [notice.assigneeUserId])
      : (await loadProfiles(admin, notice.accountId, null)).filter(
          (p) =>
            (AGENT_PLUS as readonly string[]).includes(p.account_role) &&
            (p.availability ?? 'available') === 'available',
        )
    const recipients = allowed(profiles, 'inbound_message').filter(
      (uid) => !isFocusedOn(uid, notice.conversationId),
    )
    if (recipients.length === 0) return { ...NOOP }
    return await sendPushToUsers(admin, recipients, {
      title: notice.contactName || tr('New message'),
      body: notice.preview,
      url: conversationUrl(notice.conversationId),
      tag: `conversation:${notice.conversationId}`,
    })
  } catch (err) {
    console.error('[push] notifyInboundMessage threw:', err)
    return { ...NOOP }
  }
}

// ------------------------------------------------------------
// (b) Task assigned to someone else
// ------------------------------------------------------------

export interface TaskAssignedNotice {
  accountId: string
  taskId: string
  /** Who did the assigning — never notified. */
  actorUserId: string
}

export async function notifyTaskAssigned(
  admin: SupabaseClient,
  notice: TaskAssignedNotice,
): Promise<SendPushResult> {
  try {
    const { data: task, error } = await admin
      .from('tasks')
      .select('id, account_id, title, assignee_user_id, due_at')
      .eq('id', notice.taskId)
      .eq('account_id', notice.accountId)
      .maybeSingle()
    if (error || !task) return { ...NOOP }
    const assignee = task.assignee_user_id as string | null
    if (!assignee || assignee === notice.actorUserId) return { ...NOOP }

    const [profiles, actor] = await Promise.all([
      loadProfiles(admin, notice.accountId, [assignee]),
      actorName(admin, notice.actorUserId),
    ])
    const recipients = allowed(profiles, 'task_assigned')
    if (recipients.length === 0) return { ...NOOP }
    return await sendPushToUsers(admin, recipients, {
      title: tr('Task assigned to you'),
      body: actor ? `${actor} · ${String(task.title ?? '')}` : String(task.title ?? ''),
      url: taskUrl(notice.taskId),
      tag: `task:${notice.taskId}`,
    })
  } catch (err) {
    console.error('[push] notifyTaskAssigned threw:', err)
    return { ...NOOP }
  }
}

// ------------------------------------------------------------
// (c) Tasks due within 15 minutes (cron)
// ------------------------------------------------------------

export const TASK_DUE_WINDOW_MS = 15 * 60_000

export interface TasksDueSoonResult {
  scanned: number
  notified: number
}

/**
 * Open tasks with a due date inside the next 15 minutes (or already
 * past, if the cron missed a tick) and no `reminded_at` yet. Each task
 * is stamped before the push so a slow tick never reminds twice.
 */
export async function notifyTasksDueSoon(
  admin: SupabaseClient,
  now: Date = new Date(),
): Promise<TasksDueSoonResult> {
  const result: TasksDueSoonResult = { scanned: 0, notified: 0 }
  try {
    const horizon = new Date(now.getTime() + TASK_DUE_WINDOW_MS).toISOString()
    // Look back one hour so a task whose window passed during downtime
    // still gets its (late) reminder; older ones are left alone.
    const floor = new Date(now.getTime() - 60 * 60_000).toISOString()
    const { data, error } = await admin
      .from('tasks')
      .select('id, account_id, title, assignee_user_id, due_at')
      .is('reminded_at', null)
      .is('completed_at', null)
      .not('assignee_user_id', 'is', null)
      .gte('due_at', floor)
      .lte('due_at', horizon)
      .limit(200)
    if (error) {
      // Missing column (pre-036 schema) or table → skip silently.
      if (!/42P01|42703|PGRST|does not exist|schema cache/i.test(`${error.code} ${error.message}`)) {
        console.error('[push] due-soon scan failed:', error.message)
      }
      return result
    }
    const tasks = (data ?? []) as {
      id: string
      account_id: string
      title: string
      assignee_user_id: string
      due_at: string
    }[]
    result.scanned = tasks.length
    if (tasks.length === 0) return result

    // Claim first (reminded_at IS NULL → now) so concurrent ticks split
    // the rows instead of double-sending.
    const stamp = now.toISOString()
    for (const task of tasks) {
      const { data: claimed } = await admin
        .from('tasks')
        .update({ reminded_at: stamp })
        .eq('id', task.id)
        .is('reminded_at', null)
        .select('id')
        .maybeSingle()
      if (!claimed) continue

      const profiles = await loadProfiles(admin, task.account_id, [task.assignee_user_id])
      const recipients = allowed(profiles, 'task_due')
      if (recipients.length === 0) continue
      const minutes = Math.max(0, Math.round((new Date(task.due_at).getTime() - now.getTime()) / 60_000))
      const res = await sendPushToUsers(admin, recipients, {
        title: minutes > 0 ? `${tr('Task due in')} ${minutes} min` : tr('Task due now'),
        body: task.title,
        url: taskUrl(task.id),
        tag: `task:${task.id}`,
      })
      if (res.sent > 0) result.notified++
    }
    return result
  } catch (err) {
    console.error('[push] notifyTasksDueSoon threw:', err)
    return result
  }
}

// ------------------------------------------------------------
// (d) Conversation assigned to me
// ------------------------------------------------------------

export interface ConversationAssignedNotice {
  accountId: string
  conversationId: string
  actorUserId: string
}

export async function notifyConversationAssigned(
  admin: SupabaseClient,
  notice: ConversationAssignedNotice,
): Promise<SendPushResult> {
  try {
    const { data: conv, error } = await admin
      .from('conversations')
      .select('id, account_id, assigned_agent_id, contact:contacts(name, phone)')
      .eq('id', notice.conversationId)
      .eq('account_id', notice.accountId)
      .maybeSingle()
    if (error || !conv) return { ...NOOP }
    const assignee = conv.assigned_agent_id as string | null
    if (!assignee || assignee === notice.actorUserId) return { ...NOOP }

    const contactRaw = Array.isArray(conv.contact) ? conv.contact[0] : conv.contact
    const contact = contactRaw as { name?: string | null; phone?: string | null } | null
    const who = contact?.name || contact?.phone || tr('Conversation')

    const [profiles, actor] = await Promise.all([
      loadProfiles(admin, notice.accountId, [assignee]),
      actorName(admin, notice.actorUserId),
    ])
    const recipients = allowed(profiles, 'conversation_assigned')
    if (recipients.length === 0) return { ...NOOP }
    return await sendPushToUsers(admin, recipients, {
      title: tr('Conversation assigned to you'),
      body: actor ? `${who} · ${tr('by')} ${actor}` : who,
      url: conversationUrl(notice.conversationId),
      tag: `conversation:${notice.conversationId}`,
    })
  } catch (err) {
    console.error('[push] notifyConversationAssigned threw:', err)
    return { ...NOOP }
  }
}

// ------------------------------------------------------------
// (e) Internal chat message
// ------------------------------------------------------------

export interface ChatMessageNotice {
  accountId: string
  messageId: string
  /** The sender — never notified. */
  actorUserId: string
}

/** Cap on the push body so a long message stays a notification. */
const CHAT_PREVIEW_MAX = 140

/**
 * Every other member of the message's thread (in phase 1: the one other
 * person) gets a push unless their prefs turned `chat_message` off or
 * they reported the thread as open (POST /api/push/seen with
 * `chat_thread_id`). The message is re-read server-side and must belong
 * to the caller's account and be authored by the caller.
 */
export async function notifyChatMessage(
  admin: SupabaseClient,
  notice: ChatMessageNotice,
): Promise<SendPushResult> {
  try {
    const { data: message, error } = await admin
      .from('chat_messages')
      .select('id, account_id, thread_id, sender_id, body')
      .eq('id', notice.messageId)
      .eq('account_id', notice.accountId)
      .maybeSingle()
    if (error || !message) return { ...NOOP }
    if (message.sender_id !== notice.actorUserId) return { ...NOOP }

    const { data: members, error: membersError } = await admin
      .from('chat_thread_members')
      .select('user_id')
      .eq('thread_id', message.thread_id)
    if (membersError) return { ...NOOP }
    const others = ((members ?? []) as { user_id: string }[])
      .map((m) => m.user_id)
      .filter((uid) => uid !== notice.actorUserId)
    if (others.length === 0) return { ...NOOP }

    const [profiles, actor] = await Promise.all([
      loadProfiles(admin, notice.accountId, others),
      actorName(admin, notice.actorUserId),
    ])
    const recipients = allowed(profiles, 'chat_message').filter(
      (uid) => !isFocusedOnChatThread(uid, message.thread_id as string),
    )
    if (recipients.length === 0) return { ...NOOP }

    const body = String(message.body ?? '').replace(/\s+/g, ' ').trim()
    return await sendPushToUsers(admin, recipients, {
      title: actor ?? tr('New chat message'),
      body: body.length > CHAT_PREVIEW_MAX ? `${body.slice(0, CHAT_PREVIEW_MAX - 1)}…` : body,
      url: chatThreadUrl(message.thread_id as string),
      tag: `chat:${message.thread_id}`,
    })
  } catch (err) {
    console.error('[push] notifyChatMessage threw:', err)
    return { ...NOOP }
  }
}

async function actorName(admin: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await admin
    .from('profiles')
    .select('full_name')
    .eq('user_id', userId)
    .maybeSingle()
  const name = (data as { full_name?: string | null } | null)?.full_name?.trim()
  return name || null
}
