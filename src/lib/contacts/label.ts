/** How a contact is named in lists and headers: name, else phone, else its Instagram / Messenger id. */
export function contactLabel(c: {
  name?: string | null
  phone?: string | null
  instagram_id?: string | null
  messenger_id?: string | null
}): string {
  return c.name || c.phone || c.instagram_id || c.messenger_id || ''
}
