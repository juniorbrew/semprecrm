/**
 * Received WhatsApp contact cards travel as vCard text in `content_text`
 * (text messages that start with BEGIN:VCARD). This module reads them for
 * the inbox card and builds one from the Meta webhook's structured
 * `contacts` payload. Sending vCards is out of scope.
 */

export interface VCardContact {
  name: string
  /** Phone numbers as written (display), first one is the primary. */
  phones: string[]
  /** Digits only (`waid` when the vCard carries it), same order as `phones`. */
  digits: string[]
}

const MAX_CONTACTS = 10
export const MAX_VCARD_CHARS = 8 * 1024

const cache = new Map<string, VCardContact[] | null>()

export function isVCardText(text: string | null | undefined): boolean {
  return !!text && /^\s*BEGIN:VCARD/i.test(text)
}

/** vCard line folding: a line starting with space / tab continues the previous one. */
function unfold(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (/^[ \t]/.test(line) && out.length > 0) out[out.length - 1] += line.slice(1)
    else out.push(line)
  }
  return out
}

function unescapeValue(v: string): string {
  return v.replace(/\\([,;nN\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? ' ' : c)).trim()
}

/** All cards in `text` (null when it is not a vCard); capped, never throws. */
export function parseVCards(text: string | null | undefined): VCardContact[] | null {
  if (!isVCardText(text)) return null
  const key = text as string
  if (cache.has(key)) return cache.get(key) ?? null
  const parsed = parseUncached(key)
  if (cache.size > 200) cache.clear() // small memo: threads re-render often
  cache.set(key, parsed)
  return parsed
}

function parseUncached(text: string): VCardContact[] | null {
  const cards: VCardContact[] = []
  let cur: { fn: string; n: string; phones: string[]; digits: string[] } | null = null
  for (const line of unfold(text)) {
    const upper = line.toUpperCase()
    if (upper.startsWith('BEGIN:VCARD')) {
      cur = { fn: '', n: '', phones: [], digits: [] }
    } else if (upper.startsWith('END:VCARD')) {
      if (cur) {
        const name = cur.fn || cur.n || cur.phones[0] || ''
        cards.push({ name, phones: cur.phones, digits: cur.digits })
        if (cards.length >= MAX_CONTACTS) break
      }
      cur = null
    } else if (cur) {
      const colon = line.indexOf(':')
      if (colon < 0) continue
      const head = line.slice(0, colon)
      const value = line.slice(colon + 1)
      const prop = head.split(';')[0].toUpperCase().replace(/^ITEM\d+\./, '')
      if (prop === 'FN') cur.fn = unescapeValue(value)
      else if (prop === 'N' && !cur.n) {
        // family;given;additional;prefix;suffix -> "given family"
        const [family = '', given = ''] = value.split(';')
        cur.n = [given, family].map(unescapeValue).filter(Boolean).join(' ')
      } else if (prop === 'TEL') {
        const shown = unescapeValue(value)
        const waid = /(?:^|;)waid=(\d+)/i.exec(head)?.[1]
        const digits = waid ?? shown.replace(/\D/g, '')
        if (shown) {
          cur.phones.push(shown)
          cur.digits.push(digits)
        }
      }
    }
  }
  return cards.length > 0 ? cards : null
}

/** One-line text for the list preview / push ("Contact: Ana"). */
export function vcardPreview(text: string | null | undefined): string | null {
  const cards = parseVCards(text)
  if (!cards) return null
  const first = cards[0].name || cards[0].phones[0] || ''
  return cards.length > 1 ? `${first} +${cards.length - 1}` : first
}

function esc(v: string): string {
  return v.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, ' ')
}

/** vCard 3.0 text for Meta's `contacts[]` (name + phones). */
export function buildVCards(
  contacts: {
    name?: { formatted_name?: string; first_name?: string; last_name?: string }
    phones?: { phone?: string; wa_id?: string }[]
  }[],
): string {
  return contacts
    .slice(0, MAX_CONTACTS)
    .map((c) => {
      const fn =
        c.name?.formatted_name ||
        [c.name?.first_name, c.name?.last_name].filter(Boolean).join(' ') ||
        c.phones?.[0]?.phone ||
        ''
      const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(fn)}`]
      for (const p of c.phones ?? []) {
        if (!p.phone) continue
        lines.push(`TEL${p.wa_id ? `;waid=${p.wa_id.replace(/\D/g, '')}` : ''}:${esc(p.phone)}`)
      }
      lines.push('END:VCARD')
      return lines.join('\n')
    })
    .join('\n')
}

/**
 * Text that automations, flows and the AI may read: a vCard (name + number
 * of a third party) becomes a neutral placeholder, anything else is unchanged.
 */
export function plainMessageText(text: string | null | undefined): string {
  if (!isVCardText(text)) return text ?? ''
  const name = parseVCards(text)?.[0]?.name
  return name ? `[Contato compartilhado: ${name}]` : '[Contato compartilhado]'
}
