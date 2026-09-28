// ============================================================
// Cross-component sync for contact ↔ company links.
//
// `contact_companies` is not in the realtime publication, so the inbox
// contact panel (which links / unlinks) tells the conversation list
// (which shows the primary company under the contact name) through a
// DOM event — the same pattern as lib/conversations/notes.
// ============================================================

export const CONTACT_COMPANIES_CHANGED = 'semprecrm:contact-companies-changed';

export interface ContactCompaniesChangedDetail {
  contactId: string;
}

export function notifyContactCompaniesChanged(contactId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<ContactCompaniesChangedDetail>(CONTACT_COMPANIES_CHANGED, {
      detail: { contactId },
    }),
  );
}

/** Subscribe to link changes (any contact). Returns the unsubscribe function. */
export function onContactCompaniesChanged(handler: (contactId: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<ContactCompaniesChangedDetail>).detail;
    if (detail?.contactId) handler(detail.contactId);
  };
  window.addEventListener(CONTACT_COMPANIES_CHANGED, listener);
  return () => window.removeEventListener(CONTACT_COMPANIES_CHANGED, listener);
}
