// Cross-component sync for team notes. `contact_notes` is not in the
// realtime publication, so the thread (which writes notes from the
// composer) and the contact panel (which lists them) coordinate through
// a DOM event instead of prop plumbing — the same pattern the system
// event log uses.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContactNote } from '@/types'
import { insertConversationEvent } from './events'

export const CONTACT_NOTES_CHANGED = 'wacrm:inbox:notes-changed'

export interface ContactNotesChangedDetail {
  contactId: string
}

export function notifyContactNotesChanged(contactId: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<ContactNotesChangedDetail>(CONTACT_NOTES_CHANGED, {
      detail: { contactId },
    }),
  )
}

/**
 * Subscribe to note changes for one contact. Returns the unsubscribe
 * function so it slots straight into a `useEffect` cleanup.
 */
export function onContactNotesChanged(
  contactId: string,
  handler: () => void,
): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<ContactNotesChangedDetail>).detail
    if (!detail?.contactId || detail.contactId === contactId) handler()
  }
  window.addEventListener(CONTACT_NOTES_CHANGED, listener)
  return () => window.removeEventListener(CONTACT_NOTES_CHANGED, listener)
}

export interface AddContactNoteInput {
  contactId: string
  accountId: string
  userId: string
  text: string
  /**
   * Active thread — when set, a `note_added` row is written to the
   * conversation event log (audit only; the amber bubble is the visible
   * trace). Omit when the note is added outside any conversation.
   */
  conversationId?: string | null
  actorName?: string
}

/**
 * The single write path for team notes. The composer's "Nota interna"
 * tab and the contact panel's inline note both go through here so the
 * insert, the cross-component notification and the audit event never
 * drift apart. Throws on a failed insert; callers own the toast.
 */
export async function addContactNote(
  supabase: SupabaseClient,
  input: AddContactNoteInput,
): Promise<ContactNote> {
  const { data, error } = await supabase
    .from('contact_notes')
    .insert({
      contact_id: input.contactId,
      account_id: input.accountId,
      user_id: input.userId,
      note_text: input.text,
    })
    .select()
    .single()
  if (error || !data) {
    throw error ?? new Error('contact_notes insert returned no row')
  }
  const note = data as ContactNote
  notifyContactNotesChanged(input.contactId)
  if (input.conversationId) {
    void insertConversationEvent(supabase, {
      account_id: input.accountId,
      conversation_id: input.conversationId,
      actor_user_id: input.userId,
      event_type: 'note_added',
      payload: { actor_name: input.actorName, note_id: note.id },
    })
  }
  return note
}
