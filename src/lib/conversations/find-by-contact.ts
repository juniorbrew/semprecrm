// Shared "which conversation belongs to this contact?" lookup, used by
// the deal drawer (Pipelines) and the contact views so both agree on
// what "the contact's conversation" means: the one with the most
// recent message, regardless of status. Returns null when the
// contact has never talked to us.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Conversation } from '@/types'

/** Deep link the inbox understands (`?c=<id>` auto-selects the thread). */
export function inboxConversationHref(conversationId: string): string {
  return `/inbox?c=${encodeURIComponent(conversationId)}`
}

/**
 * Pure picker so the ordering rule is testable without a client:
 * newest `last_message_at` first, falling back to `created_at`
 * for conversations that never received a message.
 */
export function pickLatestConversation<
  T extends Pick<Conversation, 'last_message_at' | 'created_at'>,
>(rows: T[]): T | null {
  if (rows.length === 0) return null
  const stamp = (c: T) => {
    const t = new Date(c.last_message_at ?? c.created_at).getTime()
    return Number.isNaN(t) ? 0 : t
  }
  return [...rows].sort((a, b) => stamp(b) - stamp(a))[0] ?? null
}

/**
 * Same ordering rule as `pickLatestConversation`, but keeps every row:
 * newest activity first, so a "previous conversations" list reads
 * top-down from the most recent thread. Does not mutate the input.
 */
export function sortConversationsNewestFirst<
  T extends Pick<Conversation, 'last_message_at' | 'created_at'>,
>(rows: T[]): T[] {
  const stamp = (c: T) => {
    const t = new Date(c.last_message_at ?? c.created_at).getTime()
    return Number.isNaN(t) ? 0 : t
  }
  return [...rows].sort((a, b) => stamp(b) - stamp(a))
}

// Kept loose on purpose: the app's Supabase client is created without
// generated Database types, so `SupabaseClient` here is the untyped
// default (same as `createClient()` returns).
type Client = Pick<SupabaseClient, 'from'>

export async function findConversationByContact(
  supabase: Client,
  contactId: string,
): Promise<Conversation | null> {
  if (!contactId) return null
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('contact_id', contactId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(5)
  if (error || !data) return null
  return pickLatestConversation(data as Conversation[])
}

export async function findConversationById(
  supabase: Client,
  conversationId: string,
): Promise<Conversation | null> {
  if (!conversationId) return null
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .maybeSingle()
  if (error || !data) return null
  return data as Conversation
}

/**
 * Every conversation this contact has had with us, newest first.
 * Used by the contact panel's "Previous conversations" list; the
 * primary "Open conversation" action is simply the first entry.
 */
export async function listConversationsByContact(
  supabase: Client,
  contactId: string,
): Promise<Conversation[]> {
  if (!contactId) return []
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('contact_id', contactId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
  if (error || !data) return []
  return sortConversationsNewestFirst(data as Conversation[])
}

/**
 * The contact's live (open / pending) conversation other than
 * `excludeId`. A resolved conversation is final (migration 060): while
 * one of these exists, the resolved thread can neither be reopened nor
 * receive an inbox send — the agent is pointed here instead.
 */
export async function findOtherActiveConversation(
  supabase: Client,
  contactId: string,
  excludeId: string,
): Promise<Conversation | null> {
  if (!contactId) return null
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('contact_id', contactId)
    .neq('status', 'closed')
    .neq('id', excludeId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !data) return null
  return ((data as Conversation[])[0] as Conversation | undefined) ?? null
}

type ContinuityRow = Pick<
  Conversation,
  'id' | 'status' | 'created_at' | 'last_message_at' | 'updated_at'
>

/**
 * Pure: for the thread on screen, the resolved conversation right before
 * it (the "Conversa anterior encerrada em …" line) and, when the thread
 * itself is resolved, the contact's live conversation that replaced it.
 */
export function conversationContinuity<T extends ContinuityRow>(
  current: ContinuityRow,
  rows: T[],
): { previousClosed: T | null; activeOther: T | null } {
  const createdAt = (c: ContinuityRow) => {
    const t = new Date(c.created_at).getTime()
    return Number.isNaN(t) ? 0 : t
  }
  const others = rows.filter((c) => c.id !== current.id)
  const previousClosed =
    others
      .filter((c) => c.status === 'closed' && createdAt(c) < createdAt(current))
      .sort((a, b) => createdAt(b) - createdAt(a))[0] ?? null
  const activeOther =
    current.status === 'closed' ? (others.find((c) => c.status !== 'closed') ?? null) : null
  return { previousClosed, activeOther }
}

/**
 * "Reabrir" guard: moving a resolved `conversation` to `nextStatus`
 * (open / pending) is blocked while the contact has another live
 * conversation — returns that one so the UI can point to it. Null when
 * the change is not a reopen or nothing blocks it.
 */
export async function reopenBlockedBy(
  supabase: Client,
  conversation: Pick<Conversation, 'id' | 'status' | 'contact_id'>,
  nextStatus: Conversation['status'],
): Promise<Conversation | null> {
  if (conversation.status !== 'closed' || nextStatus === 'closed') return null
  return findOtherActiveConversation(supabase, conversation.contact_id, conversation.id)
}

/**
 * When this conversation was last resolved: the newest `status_changed`
 * → closed event (migration 024). Null when there is none (older data,
 * or closed by a path that logs no event) — callers fall back to
 * `last_message_at`.
 */
export async function findClosedAt(
  supabase: Client,
  conversationId: string,
): Promise<string | null> {
  if (!conversationId) return null
  const { data, error } = await supabase
    .from('conversation_events')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('event_type', 'status_changed')
    .eq('payload->>status', 'closed')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !data) return null
  return ((data as { created_at: string }[])[0]?.created_at as string | undefined) ?? null
}
