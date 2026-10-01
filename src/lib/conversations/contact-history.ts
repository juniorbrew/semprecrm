// Contact panel "Conversas anteriores" + "Histórico" (inbox redesign,
// stage 3): pure mapping over rows the panel already loads (the contact's
// conversations) plus one small query for the CSAT answers (migration 074).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Conversation } from '@/types'
import { sortConversationsNewestFirst } from './find-by-contact'

/** How many earlier conversations the panel lists. */
export const PREVIOUS_CONVERSATIONS_LIMIT = 5

export interface CsatAnswer {
  conversation_id: string
  score: number | null
}

export interface PreviousConversationRow {
  id: string
  /** Last activity (ISO). */
  at: string
  /** Subject, else the category name, else the last message. */
  title: string | null
  status: Conversation['status']
  csat: number | null
  conversation: Conversation
}

export interface ContactHistorySummary {
  count: number
  /** Mean CSAT (1–5) over answered surveys, one decimal; null without answers. */
  csatAverage: number | null
  /** Earliest of the contact row and its first conversation (ISO). */
  since: string | null
}

/** conversation id → score, ignoring rows without a valid 1–5 score. */
export function csatByConversation(rows: readonly CsatAnswer[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const r of rows) {
    const score = Number(r.score)
    if (Number.isInteger(score) && score >= 1 && score <= 5) map.set(r.conversation_id, score)
  }
  return map
}

export function previousConversationRows(
  conversations: readonly Conversation[],
  currentId: string | null,
  csat: ReadonlyMap<string, number>,
  categoryName: (id: string) => string | undefined,
  limit = PREVIOUS_CONVERSATIONS_LIMIT,
): PreviousConversationRow[] {
  return sortConversationsNewestFirst(conversations.filter((c) => c.id !== currentId))
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      at: c.last_message_at ?? c.created_at,
      title:
        c.subject?.trim() ||
        (c.category_id ? categoryName(c.category_id) : undefined) ||
        c.last_message_text ||
        null,
      status: c.status,
      csat: csat.get(c.id) ?? null,
      conversation: c,
    }))
}

export function contactHistorySummary(
  conversations: readonly Pick<Conversation, 'created_at'>[],
  csat: ReadonlyMap<string, number>,
  contactCreatedAt: string | null | undefined,
): ContactHistorySummary {
  const scores = [...csat.values()]
  const csatAverage = scores.length
    ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
    : null
  const stamps = [contactCreatedAt, ...conversations.map((c) => c.created_at)]
    .map((iso) => (iso ? Date.parse(iso) : NaN))
    .filter((t) => Number.isFinite(t))
  const since = stamps.length ? new Date(Math.min(...stamps)).toISOString() : null
  return { count: conversations.length, csatAverage, since }
}

type Client = Pick<SupabaseClient, 'from'>

/** The contact's answered surveys (member-readable, one row per conversation). */
export async function listCsatAnswersByContact(
  supabase: Client,
  contactId: string,
): Promise<CsatAnswer[]> {
  if (!contactId) return []
  const { data, error } = await supabase
    .from('csat_responses')
    .select('conversation_id, score')
    .eq('contact_id', contactId)
    .not('score', 'is', null)
  if (error || !data) return []
  return data as CsatAnswer[]
}
