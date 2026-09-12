// Cross-component sync for team notes. `contact_notes` is not in the
// realtime publication, so the thread (which writes notes from the
// composer) and the contact panel (which lists them) coordinate through
// a DOM event instead of prop plumbing — the same pattern the system
// event log uses.

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
