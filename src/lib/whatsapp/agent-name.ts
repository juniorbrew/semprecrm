// "Show the agent's name to the customer" (accounts.preferences.show_agent_name).
// Only the text the customer receives carries the name; the stored message stays
// plain because the inbox bubble already shows who sent it.

const MAX_NAME = 40

/** Display name safe to put inside WhatsApp bold markers: no *_~` and no line breaks. */
export function cleanAgentName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return [...raw.replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim()].slice(0, MAX_NAME).join('').trim()
}

/**
 * WhatsApp (official and QR) gets "*Ana:*\n<text>"; Instagram / Messenger have no
 * bold, so "Ana:\n<text>". Empty text or an empty name returns the text unchanged.
 */
export function withAgentName(text: string, name: unknown, channel: string | null | undefined): string {
  const clean = cleanAgentName(name)
  if (!text || !clean) return text
  const plain = channel === 'instagram' || channel === 'messenger'
  return plain ? `${clean}:\n${text}` : `*${clean}:*\n${text}`
}
