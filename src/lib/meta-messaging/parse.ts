// ============================================================
// Instagram Direct / Messenger webhook → normalized events.
//
// Both products post the same envelope: `object` ('instagram' | 'page') and
// `entry[].messaging[]`. Only messages and echoes become events; reads,
// deliveries, postbacks, reactions and unsends are ignored in part A.
// ============================================================

import type { MetaMessagingChannel } from '@/types'

export interface MessagingAttachment {
  /** Meta's type: image | video | audio | file | location | share | story_mention | ig_reel | fallback … */
  type: string
  url: string | null
  title: string | null
}

export interface MessagingEvent {
  kind: MetaMessagingChannel
  /** The business side (Page id / Instagram professional account id) — resolves the account. */
  businessId: string
  /** The customer (PSID / IGSID). */
  customerId: string
  /** Sent by the business itself (Instagram/Facebook app or our own API call). */
  echo: boolean
  mid: string
  /** Epoch millis. */
  timestamp: number
  text: string | null
  attachments: MessagingAttachment[]
  replyToMid: string | null
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const idOf = (v: unknown): string | null => (isObj(v) ? str(v.id) : null)

function parseAttachment(raw: unknown): MessagingAttachment | null {
  if (!isObj(raw)) return null
  const type = str(raw.type)
  if (!type) return null
  const payload = isObj(raw.payload) ? raw.payload : {}
  return { type, url: str(payload.url) ?? str(raw.url), title: str(payload.title) ?? str(raw.title) }
}

/** The events of a webhook body; an empty list for anything we do not handle. */
export function parseMessagingWebhook(body: unknown): MessagingEvent[] {
  if (!isObj(body) || !Array.isArray(body.entry)) return []
  const kind: MetaMessagingChannel | null =
    body.object === 'instagram' ? 'instagram' : body.object === 'page' ? 'messenger' : null
  if (!kind) return []

  const events: MessagingEvent[] = []
  for (const entry of body.entry) {
    if (!isObj(entry) || !Array.isArray(entry.messaging)) continue
    const entryId = str(entry.id)
    for (const m of entry.messaging) {
      if (!isObj(m) || !isObj(m.message)) continue
      const msg = m.message
      const mid = str(msg.mid)
      const sender = idOf(m.sender)
      const recipient = idOf(m.recipient)
      if (!mid || !sender || !recipient || msg.is_deleted === true) continue
      const echo = msg.is_echo === true
      // The account is resolved from the business id; it must be the entry's own id
      // (recipient, or sender on an echo). A mismatch is never ours to route.
      if (entryId && entryId !== (echo ? sender : recipient)) continue
      const attachments = (Array.isArray(msg.attachments) ? msg.attachments : [])
        .map(parseAttachment)
        .filter((a): a is MessagingAttachment => a !== null)
      const text = str(msg.text)
      if (!text && attachments.length === 0) continue
      const replyTo = isObj(msg.reply_to) ? str(msg.reply_to.mid) : null
      events.push({
        kind,
        businessId: echo ? sender : recipient,
        customerId: echo ? recipient : sender,
        echo,
        mid,
        timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
        text,
        attachments,
        replyToMid: replyTo,
      })
    }
  }
  return events
}
