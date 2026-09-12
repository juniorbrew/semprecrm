// System events shown as centred pills in the inbox thread ("Ana atribuiu
// para si", "Conversa resolvida", "Etiqueta VIP adicionada").
//
// The log is server-backed: one row per action in `conversation_events`
// (migration 024), account-shared through RLS and streamed to open
// threads through Supabase Realtime. This module holds the pure parts —
// row → view-model mapping, list merging, the baseline pills for threads
// that predate the table, and the pt-BR / en-US copy. Reading, writing
// and subscribing live in `@/hooks/use-conversation-events` (thread) and
// `insertConversationEvent` below (any component with a supabase client).

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  Conversation,
  ConversationEventPayload,
  ConversationEventRecord,
  ConversationEventType,
  ConversationStatus,
} from '@/types'
import type { Language } from '@/lib/i18n'

export type { ConversationEventType } from '@/types'

/**
 * Flattened, display-ready shape of a `conversation_events` row. Names
 * are resolved (live profile name first, stored snapshot second) so the
 * pill component only has to format.
 */
export interface ConversationEvent {
  id: string
  conversation_id: string
  type: ConversationEventType
  /** ISO timestamp. */
  created_at: string
  actor_user_id?: string | null
  /** Display name of who did it; undefined when only the outcome is known. */
  actor_name?: string
  /** `assigned`: who received the conversation. */
  assignee_user_id?: string
  assignee_name?: string
  /** `assigned`: true when the actor assigned it to themselves. */
  self_assigned?: boolean
  /** `status_changed`: the resulting status. */
  status?: ConversationStatus
  previous_status?: ConversationStatus
  /** `label_added` / `label_removed`: the label's name. */
  tag_id?: string
  tag_name?: string
  /** `note_added`: the `contact_notes` row. */
  note_id?: string
  /**
   * Baseline pills (derived from the conversation row, not from a logged
   * event) are flagged so the thread can tell them apart.
   */
  derived?: boolean
}

/** Resolves a user id to a display name; undefined when unknown. */
export type ResolveUserName = (userId: string) => string | undefined

/** Minimal shape of what a UI action logs — the hook fills in the rest. */
export interface ConversationEventDraft {
  event_type: ConversationEventType
  payload?: ConversationEventPayload
}

/** Full row to insert (what the hook / sidebar build from a draft). */
export interface NewConversationEvent extends ConversationEventDraft {
  account_id: string
  conversation_id: string
  actor_user_id: string | null
}

/**
 * Turn a table row into the display shape. `resolveName` supplies live
 * profile names; the payload snapshots (`actor_name`, `assignee_name`)
 * are the fallback for users who have since left the account.
 */
export function eventFromRecord(
  row: ConversationEventRecord,
  resolveName: ResolveUserName = () => undefined,
): ConversationEvent {
  const payload = row.payload ?? {}
  const actorId = row.actor_user_id ?? null
  const actor_name =
    (actorId ? resolveName(actorId) : undefined) ?? payload.actor_name ?? undefined
  const assigneeId = payload.assignee_user_id
  const assignee_name =
    (assigneeId ? resolveName(assigneeId) : undefined) ??
    payload.assignee_name ??
    undefined
  const self_assigned =
    payload.self_assigned ?? (!!actorId && !!assigneeId && actorId === assigneeId)
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    type: row.event_type,
    created_at: row.created_at,
    actor_user_id: actorId,
    actor_name,
    assignee_user_id: assigneeId,
    assignee_name,
    self_assigned: row.event_type === 'assigned' ? self_assigned : undefined,
    status: payload.status,
    previous_status: payload.previous_status,
    tag_id: payload.tag_id,
    tag_name: payload.tag_name,
    note_id: payload.note_id,
  }
}

function stamp(iso: string): number {
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? 0 : t
}

/**
 * Add `row` to `list` unless an equal id is already there (the optimistic
 * insert result and the realtime echo race each other), keeping the list
 * ordered by `created_at`.
 */
export function upsertEventRecord(
  list: ConversationEventRecord[],
  row: ConversationEventRecord,
): ConversationEventRecord[] {
  if (list.some((e) => e.id === row.id)) return list
  const next = [...list, row]
  next.sort((a, b) => stamp(a.created_at) - stamp(b.created_at))
  return next
}

/**
 * INSERT one event. Returns the stored row (with id + timestamp) or
 * `null` after logging the error — the pill is a nice-to-have, so the
 * calling action (assign / resolve / tag) never fails because of it.
 */
export async function insertConversationEvent(
  supabase: SupabaseClient,
  input: NewConversationEvent,
): Promise<ConversationEventRecord | null> {
  const { data, error } = await supabase
    .from('conversation_events')
    .insert({
      account_id: input.account_id,
      conversation_id: input.conversation_id,
      actor_user_id: input.actor_user_id,
      event_type: input.event_type,
      payload: input.payload ?? {},
    })
    .select('*')
    .single()
  if (error || !data) {
    console.error('Failed to log conversation event:', {
      message: error?.message,
      details: error?.details,
      code: error?.code,
      event_type: input.event_type,
    })
    return null
  }
  return data as ConversationEventRecord
}

/**
 * Pills for the conversation's *current* state when the log has nothing
 * covering it — threads that predate the events table still tell the
 * agent who owns them ("Atribuída a Ana") and whether they are resolved.
 * Stamped with `updated_at` (the row's last change) so they sort near
 * the end of the thread.
 */
export function deriveBaselineEvents(
  conversation: Pick<
    Conversation,
    'id' | 'status' | 'assigned_agent_id' | 'updated_at' | 'created_at'
  >,
  logged: ConversationEvent[],
  assigneeName: ResolveUserName,
): ConversationEvent[] {
  const out: ConversationEvent[] = []
  const at = conversation.updated_at ?? conversation.created_at
  const hasAssignEvent = logged.some(
    (e) => e.type === 'assigned' || e.type === 'unassigned',
  )
  const hasStatusEvent = logged.some((e) => e.type === 'status_changed')
  if (conversation.assigned_agent_id && !hasAssignEvent) {
    out.push({
      id: `derived-assigned-${conversation.id}`,
      conversation_id: conversation.id,
      type: 'assigned',
      created_at: at,
      assignee_user_id: conversation.assigned_agent_id,
      assignee_name: assigneeName(conversation.assigned_agent_id),
      derived: true,
    })
  }
  if (conversation.status !== 'open' && !hasStatusEvent) {
    out.push({
      id: `derived-status-${conversation.id}`,
      conversation_id: conversation.id,
      type: 'status_changed',
      created_at: at,
      status: conversation.status,
      derived: true,
    })
  }
  return out
}

/** "há 2 h" / "2h ago" — compact, language-aware, mirrors the list's ages. */
export function formatEventAge(
  iso: string,
  language: Language,
  now: number = Date.now(),
): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const pt = language === 'pt-BR'
  const sec = Math.max(0, Math.round((now - then) / 1000))
  if (sec < 60) return pt ? 'agora' : 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return pt ? `há ${min} min` : `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return pt ? `há ${h} h` : `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return pt ? `há ${d} d` : `${d}d ago`
  return new Date(iso).toLocaleDateString(language, {
    day: '2-digit',
    month: '2-digit',
  })
}

const STATUS_LABEL: Record<Language, Record<ConversationStatus, string>> = {
  'pt-BR': {
    open: 'Conversa reaberta',
    pending: 'Conversa marcada como pendente',
    closed: 'Conversa resolvida',
  },
  'en-US': {
    open: 'Conversation reopened',
    pending: 'Conversation marked pending',
    closed: 'Conversation resolved',
  },
}

/**
 * Human sentence for a pill, without the trailing "· há 2 h". Returns ''
 * for kinds that have no pill of their own (`note_added` — the amber note
 * bubble already sits in the thread).
 */
export function formatConversationEvent(
  event: ConversationEvent,
  language: Language,
): string {
  const pt = language === 'pt-BR'
  const actor = event.actor_name
  switch (event.type) {
    case 'assigned': {
      const who = event.assignee_name
      if (actor && event.self_assigned) {
        return pt ? `${actor} atribuiu para si` : `${actor} self-assigned`
      }
      if (actor && who) {
        return pt ? `${actor} atribuiu para ${who}` : `${actor} assigned to ${who}`
      }
      if (who) return pt ? `Atribuída a ${who}` : `Assigned to ${who}`
      return pt ? 'Conversa atribuída' : 'Conversation assigned'
    }
    case 'unassigned':
      return actor
        ? pt
          ? `${actor} removeu a atribuição`
          : `${actor} unassigned the conversation`
        : pt
          ? 'Atribuição removida'
          : 'Conversation unassigned'
    case 'status_changed': {
      const status = event.status ?? 'open'
      if (actor) {
        if (pt) {
          if (status === 'closed') return `${actor} resolveu a conversa`
          if (status === 'pending') return `${actor} marcou como pendente`
          return `${actor} reabriu a conversa`
        }
        if (status === 'closed') return `${actor} resolved the conversation`
        if (status === 'pending') return `${actor} marked as pending`
        return `${actor} reopened the conversation`
      }
      return STATUS_LABEL[language][status]
    }
    case 'label_added': {
      const base = pt
        ? `Etiqueta ${event.tag_name ?? ''} adicionada`
        : `Label ${event.tag_name ?? ''} added`
      return actor ? (pt ? `${base} por ${actor}` : `${base} by ${actor}`) : base
    }
    case 'label_removed': {
      const base = pt
        ? `Etiqueta ${event.tag_name ?? ''} removida`
        : `Label ${event.tag_name ?? ''} removed`
      return actor ? (pt ? `${base} por ${actor}` : `${base} by ${actor}`) : base
    }
    case 'note_added':
      return ''
    default:
      return ''
  }
}

/** Kinds that get a pill in the thread stream. */
export function isVisibleEvent(event: Pick<ConversationEvent, 'type'>): boolean {
  return event.type !== 'note_added'
}
