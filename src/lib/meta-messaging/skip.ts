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

/**
 * The send may already have reached Instagram / Messenger (timeout, network error, Meta 5xx, a 2xx we
 * could not read). Never sent again by the automatic senders: `isUncertainSend` recognises it.
 */
export class MessagingUncertainSendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MessagingUncertainSendError'
  }
}

/** Meta definitively refused the message (a 4xx that is not a skip): nothing was sent, retrying is safe. */
export class MessagingSendRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MessagingSendRefusedError'
  }
}
