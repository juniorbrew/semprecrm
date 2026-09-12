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
