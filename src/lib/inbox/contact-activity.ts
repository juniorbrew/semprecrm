// "Atividade" feed of the inbox panel: rows come from the
// `contact_activity` RPC (migration 070); this module maps a row to an
// icon key, a language-keyed sentence and a link target.

import type { SupabaseClient } from '@supabase/supabase-js'

import {
  eventFromRecord,
  formatConversationEvent,
} from '@/lib/conversations/events'
import type { Language } from '@/lib/i18n'
import type { ConversationEventPayload, ConversationEventType } from '@/types'

export const ACTIVITY_PAGE_SIZE = 20

export interface ContactActivityRow {
  id: string
  type: string
  at: string
  title: string | null
  payload: Record<string, unknown> | null
  actor_name: string | null
  link_kind: 'conversation' | 'deal' | 'task' | 'event' | 'note' | 'company' | 'broadcast'
  link_id: string | null
  conversation_id: string | null
}

export type ActivityIcon =
  | 'conversation'
  | 'deal'
  | 'won'
  | 'lost'
  | 'task'
  | 'done'
  | 'appointment'
  | 'note'
  | 'company'
  | 'tag'
  | 'campaign'
  | 'ai'

export interface ActivityView {
  icon: ActivityIcon
  text: string
  href: string | null
}

/** One page of the feed, newest first; `before` = `at` of the last row seen. */
export async function fetchContactActivity(
  supabase: Pick<SupabaseClient, 'rpc'>,
  contactId: string,
  opts: { limit?: number; before?: string | null } = {},
): Promise<ContactActivityRow[]> {
  const { data, error } = await supabase.rpc('contact_activity', {
    p_contact_id: contactId,
    p_limit: opts.limit ?? ACTIVITY_PAGE_SIZE,
    p_before: opts.before ?? null,
  })
  if (error) throw error
  return (data ?? []) as ContactActivityRow[]
}

function href(row: ContactActivityRow): string | null {
  const id = row.link_id ? encodeURIComponent(row.link_id) : null
  if (!id) return null
  switch (row.link_kind) {
    case 'conversation':
      return `/inbox?c=${id}`
    case 'deal':
      return `/pipelines?deal=${id}`
    case 'company':
      return `/companies?company=${id}`
    case 'task':
      return '/tasks'
    case 'event':
      return '/agenda'
    case 'broadcast':
      return '/broadcasts'
    default:
      return null
  }
}

function conversationIcon(type: ConversationEventType): ActivityIcon {
  if (type === 'label_added' || type === 'label_removed') return 'tag'
  if (type === 'deal_stage_changed') return 'deal'
  if (type.startsWith('ai_')) return 'ai'
  return 'conversation'
}

const COPY: Record<Language, Record<string, (t: string) => string>> = {
  'pt-BR': {
    deal_created: (t) => `Negócio ${t} criado`,
    deal_won: (t) => `Negócio ${t} ganho`,
    deal_lost: (t) => `Negócio ${t} perdido`,
    task_created: (t) => `Tarefa criada: ${t}`,
    task_done: (t) => `Tarefa concluída: ${t}`,
    appointment: (t) => `Compromisso: ${t}`,
    note: (t) => `Nota: ${t}`,
    company_linked: (t) => `Empresa ${t} vinculada`,
    campaign_sent: (t) => `Recebeu a campanha ${t}`,
    campaign_failed: (t) => `Falha ao enviar a campanha ${t}`,
  },
  'en-US': {
    deal_created: (t) => `Deal ${t} created`,
    deal_won: (t) => `Deal ${t} won`,
    deal_lost: (t) => `Deal ${t} lost`,
    task_created: (t) => `Task created: ${t}`,
    task_done: (t) => `Task completed: ${t}`,
    appointment: (t) => `Appointment: ${t}`,
    note: (t) => `Note: ${t}`,
    company_linked: (t) => `Company ${t} linked`,
    campaign_sent: (t) => `Received campaign ${t}`,
    campaign_failed: (t) => `Campaign ${t} failed to send`,
  },
}

const ICONS: Record<string, ActivityIcon> = {
  deal_created: 'deal',
  deal_won: 'won',
  deal_lost: 'lost',
  task_created: 'task',
  task_done: 'done',
  appointment: 'appointment',
  note: 'note',
  company_linked: 'company',
  campaign_sent: 'campaign',
  campaign_failed: 'campaign',
}

/** Row -> what the panel draws. Unknown types render nothing (null). */
export function describeActivity(row: ContactActivityRow, language: Language): ActivityView | null {
  if (row.type.startsWith('conv_')) {
    const event_type = row.type.slice(5) as ConversationEventType
    const event = eventFromRecord({
      id: row.id,
      account_id: '',
      conversation_id: row.conversation_id ?? '',
      event_type,
      payload: {
        ...(row.payload as ConversationEventPayload | null),
        actor_name: row.actor_name ?? undefined,
      },
      created_at: row.at,
    })
    const text = formatConversationEvent(event, language)
    return text ? { icon: conversationIcon(event_type), text, href: href(row) } : null
  }
  const copy = (COPY[language] ?? COPY['pt-BR'])[row.type]
  if (!copy) return null
  const text = copy(row.title?.trim() || '—')
  return {
    icon: ICONS[row.type] ?? 'conversation',
    text: row.actor_name && row.type !== 'note' ? `${text} · ${row.actor_name}` : text,
    href: href(row),
  }
}
