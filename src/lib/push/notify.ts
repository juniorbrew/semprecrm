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
//   (f) notifyCalendarReminders     — /api/automations/cron
//                                     agenda reminders, migration 040
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { eventHref } from '@/lib/calendar/links'
import { asChatAttachment, attachmentPreview } from '@/lib/chat/attachments'
import { DEFAULT_LANGUAGE, translateLiteral } from '@/lib/i18n'

import { isFocusedOn, isFocusedOnChatThread } from './focus'
import { parseNotificationPrefs, type PushEventKind } from './prefs'
import { sendPushToUsers, type SendPushResult } from './send'

export { notifyNewLeads } from './leads'

const NOOP: SendPushResult = { users: 0, sent: 0, failed: 0, removed: 0, configured: true }

/**
 * Notification copy is rendered server-side, where the viewer's
 * browser language is unknown — use the app default (pt-BR) through
 * the same catalogue the UI uses (entries live in i18n-extra.ts).
 */
function tr(english: string): string {
  return translateLiteral(english, DEFAULT_LANGUAGE)
}

/**
 * Inbound media arrives with no caption as a `[image]`-style
 * placeholder (see whatsapp/inbound.ts). The push body shows the
 * kind in the user's language instead of the raw bracketed key.
 */
const MEDIA_PLACEHOLDER: Record<string, string> = {
  image: 'Image',
  sticker: 'Sticker',
  video: 'Video',
  audio: 'Audio',
  voice: 'Audio',
  document: 'Document',
  location: 'Location',
  contacts: 'Contact',
  reaction: 'Reaction',
  unsupported: 'Unsupported message',
}

export function inboundPushBody(preview: string): string {
  const text = String(preview ?? '').replace(/\s+/g, ' ').trim()
  const match = text.match(/^\[([a-z_]+)\]$/i)
  if (!match) return text
  const label = MEDIA_PLACEHOLDER[match[1].toLowerCase()]
  return label ? `📎 ${tr(label)}` : text
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
      body: inboundPushBody(notice.preview),
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
      .select('id, account_id, thread_id, sender_id, body, kind, attachment, deleted_at')
      .eq('id', notice.messageId)
      .eq('account_id', notice.accountId)
      .maybeSingle()
    if (error || !message) return { ...NOOP }
    if (message.sender_id !== notice.actorUserId) return { ...NOOP }
    // System lines (group events) and already-deleted rows never push.
    if ((message.kind ?? 'text') !== 'text' || message.deleted_at) return { ...NOOP }

    const { data: members, error: membersError } = await admin
      .from('chat_thread_members')
      .select('user_id')
      .eq('thread_id', message.thread_id)
    if (membersError) return { ...NOOP }
    const others = ((members ?? []) as { user_id: string }[])
      .map((m) => m.user_id)
      .filter((uid) => uid !== notice.actorUserId)
    if (others.length === 0) return { ...NOOP }

    const [profiles, actor, thread] = await Promise.all([
      loadProfiles(admin, notice.accountId, others),
      actorName(admin, notice.actorUserId),
      admin
        .from('chat_threads')
        .select('kind, title')
        .eq('id', message.thread_id)
        .maybeSingle()
        .then((r) => (r.data as { kind?: string; title?: string | null } | null) ?? null),
    ])
    const recipients = allowed(profiles, 'chat_message').filter(
      (uid) => !isFocusedOnChatThread(uid, message.thread_id as string),
    )
    if (recipients.length === 0) return { ...NOOP }

    const body = chatPushBody(message.body, message.attachment)
    // Groups: "Ana · Vendas" so the recipient knows where it landed.
    const groupTitle = thread?.kind === 'group' ? thread.title?.trim() : ''
    const who = actor ?? tr('New chat message')
    return await sendPushToUsers(admin, recipients, {
      title: groupTitle ? `${who} · ${groupTitle}` : who,
      body: body.length > CHAT_PREVIEW_MAX ? `${body.slice(0, CHAT_PREVIEW_MAX - 1)}…` : body,
      url: chatThreadUrl(message.thread_id as string),
      tag: `chat:${message.thread_id}`,
    })
  } catch (err) {
    console.error('[push] notifyChatMessage threw:', err)
    return { ...NOOP }
  }
}

/**
 * Push body for a chat message: the text, else a placeholder for the
 * attachment ("🎤 Áudio" for voice notes, "📎 Anexo" otherwise) — the
 * same wording the thread preview trigger uses (migration 039).
 */
export function chatPushBody(body: unknown, attachment: unknown): string {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim()
  if (text) return text
  const att = asChatAttachment(attachment)
  if (!att) return ''
  const { emoji, label } = attachmentPreview(att.mime)
  return `${emoji} ${tr(label)}`
}

// ------------------------------------------------------------
// (f) Calendar reminders (cron)
// ------------------------------------------------------------

/** Largest reminder offset the DB accepts (one day), in minutes. */
const CALENDAR_MAX_REMINDER_MIN = 1440

export interface CalendarRemindersResult {
  scanned: number
  notified: number
}

/**
 * Confirmed events with a reminder whose `starts_at - reminder_minutes`
 * is now or past, not reminded yet (`reminded_at IS NULL`; the DB
 * trigger clears it when the start or the reminder changes). The
 * owner and every attendee get the push unless their prefs turned
 * `calendar_reminder` off. Each row is claimed (stamped) before the
 * push so a slow tick never reminds twice; rows whose window closed
 * more than an hour ago are left alone.
 */
export async function notifyCalendarReminders(
  admin: SupabaseClient,
  now: Date = new Date(),
): Promise<CalendarRemindersResult> {
  const result: CalendarRemindersResult = { scanned: 0, notified: 0 }
  try {
    const floor = new Date(now.getTime() - 60 * 60_000).toISOString()
    const horizon = new Date(now.getTime() + CALENDAR_MAX_REMINDER_MIN * 60_000).toISOString()
    const { data, error } = await admin
      .from('calendar_events')
      .select('id, account_id, title, owner_user_id, starts_at, ends_at, all_day, reminder_minutes, location')
      .eq('status', 'confirmed')
      .is('reminded_at', null)
      .not('reminder_minutes', 'is', null)
      .gte('starts_at', floor)
      .lte('starts_at', horizon)
      .order('starts_at', { ascending: true })
      .limit(500)
    if (error) {
      // Missing table (pre-040 schema) → skip silently.
      if (!/42P01|42703|PGRST|does not exist|schema cache/i.test(`${error.code} ${error.message}`)) {
        console.error('[push] calendar reminder scan failed:', error.message)
      }
      return result
    }
    const rows = (data ?? []) as {
      id: string
      account_id: string
      title: string
      owner_user_id: string | null
      starts_at: string
      ends_at: string
      all_day: boolean
      reminder_minutes: number
      location: string | null
    }[]
    // `starts_at - reminder_minutes <= now` cannot be expressed as a
    // PostgREST filter, so the window is applied here.
    const due = rows.filter(
      (r) => new Date(r.starts_at).getTime() - r.reminder_minutes * 60_000 <= now.getTime(),
    )
    result.scanned = due.length
    if (due.length === 0) return result

    const stamp = now.toISOString()
    for (const ev of due) {
      const { data: claimed } = await admin
        .from('calendar_events')
        .update({ reminded_at: stamp })
        .eq('id', ev.id)
        .is('reminded_at', null)
        .select('id')
        .maybeSingle()
      if (!claimed) continue

      const { data: att } = await admin
        .from('calendar_event_attendees')
        .select('user_id')
        .eq('event_id', ev.id)
      const userIds = new Set<string>()
      if (ev.owner_user_id) userIds.add(ev.owner_user_id)
      for (const a of (att ?? []) as { user_id: string }[]) userIds.add(a.user_id)
      if (userIds.size === 0) continue

      const profiles = await loadProfiles(admin, ev.account_id, [...userIds])
      const recipients = allowed(profiles, 'calendar_reminder')
      if (recipients.length === 0) continue

      const minutes = Math.max(0, Math.round((new Date(ev.starts_at).getTime() - now.getTime()) / 60_000))
      const title = ev.all_day
        ? tr('Appointment today')
        : minutes > 0
          ? `${tr('Appointment in')} ${minutes} min`
          : tr('Appointment starting now')
      const body = ev.location ? `${ev.title} · ${ev.location}` : ev.title
      const res = await sendPushToUsers(admin, recipients, {
        title,
        body,
        url: eventHref(ev.id),
        tag: `calendar:${ev.id}`,
      })
      if (res.sent > 0) result.notified++
    }
    return result
  } catch (err) {
    console.error('[push] notifyCalendarReminders threw:', err)
    return result
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
