// Log hygiene (LGPD): server logs must not carry customer phone numbers.

/** `+55 11 91234-5678` → `***5678` (last 4 digits only). */
export function maskPhone(phone: string | null | undefined): string {
  const d = (phone ?? '').replace(/\D/g, '')
  return d.length > 4 ? `***${d.slice(-4)}` : '***'
}

/** Masks every phone-like run (8+ digits, optional +, spaces, dots, dashes, parens) in free text. */
export function redactPhones(text: string): string {
  return text.replace(/\+?\d[\d\s().-]{6,}\d/g, (m) => (m.replace(/\D/g, '').length >= 8 ? maskPhone(m) : m))
}
