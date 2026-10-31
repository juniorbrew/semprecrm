// A send that was refused on purpose (kept in its own light module: inbound.ts imports it).

export type MessagingSkipCode =
  | 'window_closed'
  | 'module_off'
  | 'channel_not_connected'
  | 'channel_expired'
  | 'permission_denied'
  | 'template_unsupported'
  | 'text_too_long'
  | 'contact_identity_missing'

/** The send was refused on purpose (not a failure to retry). `message` is pt-BR and safe to show. */
export class MessagingSkipError extends Error {
  readonly code: MessagingSkipCode
  constructor(code: MessagingSkipCode, message: string) {
    super(message)
    this.name = 'MessagingSkipError'
    this.code = code
  }
}
