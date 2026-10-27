// ============================================================
// Channel guard shared by every WhatsApp sender.
//
// Instagram / Messenger conversations (migration 100) live in the same inbox
// as WhatsApp ones, but nothing automatic may send on them yet (part C).
// A sender that only knows `official` / `qr` must never fall into its
// `official` branch for one of them — it calls `assertWhatsAppChannel` first.
// ============================================================

import type { ConversationChannel, MetaMessagingChannel, WhatsAppChannel } from '@/types'

export function isMetaMessagingChannel(channel: unknown): channel is MetaMessagingChannel {
  return channel === 'instagram' || channel === 'messenger'
}

/** An automatic sender was pointed at an Instagram / Messenger conversation. */
export class ChannelNotSupportedError extends Error {
  constructor(public readonly channel: MetaMessagingChannel) {
    super(`automatic sending is not available on the ${channel} channel yet`)
    this.name = 'ChannelNotSupportedError'
  }
}

export function assertWhatsAppChannel(channel: ConversationChannel): WhatsAppChannel {
  if (isMetaMessagingChannel(channel)) throw new ChannelNotSupportedError(channel)
  return channel
}
