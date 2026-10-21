/**
 * Event catalog for outbound webhooks. The types are emitted by the
 * triggers of migration 093 (messages / conversations / contacts), so every
 * write path is covered; `webhook.test` is sent by the "send test event"
 * button only.
 */
export const WEBHOOK_EVENTS = [
  'message.received',
  'message.sent',
  'message.status',
  'conversation.created',
  'conversation.closed',
  'conversation.reopened',
  'contact.created',
] as const

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number]

export const WEBHOOK_TEST_EVENT = 'webhook.test'

/** `*` subscribes the endpoint to every current and future event type. */
export const ALL_EVENTS = '*'

export const WEBHOOK_API_VERSION = '2026-10-01'

/** English description (translated in the UI through the i18n dictionary). */
export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEventType, string> = {
  'message.received': 'A customer message arrived',
  'message.sent': 'A message was sent to a customer (agent, bot, automation, API)',
  'message.status': 'A message status changed (sent, delivered, read, failed)',
  'conversation.created': 'A new conversation started',
  'conversation.closed': 'A conversation was resolved',
  'conversation.reopened': 'A resolved conversation was reopened',
  'contact.created': 'A new contact was created',
}

/** Normalises a requested event list: known types only, `*` wins, no duplicates. */
export function normalizeEvents(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length === 0) return null
  const known = new Set<string>([...WEBHOOK_EVENTS, ALL_EVENTS])
  const out = new Set<string>()
  for (const e of input) {
    if (typeof e !== 'string' || !known.has(e)) return null
    out.add(e)
  }
  return out.has(ALL_EVENTS) ? [ALL_EVENTS] : [...out]
}

export function eventPublicId(uuid: string): string {
  return `evt_${uuid.replace(/-/g, '')}`
}
