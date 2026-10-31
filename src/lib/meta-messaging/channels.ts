// ============================================================
// Channel guard shared by every WhatsApp sender.
//
// Instagram / Messenger conversations (migration 100) live in the same inbox
// as WhatsApp ones. The WhatsApp-only primitives (Cloud API / QR gateway senders, receipts, typing,
// reactions, broadcasts, agenda reminders) must never see one of them: they call
// `assertWhatsAppChannel` first. The automatic features (automations, flows, AI, surveys, scheduled
// messages, the public API) route these channels to `engine-send.ts` instead (part C).
// ============================================================

import type { Module } from '@/lib/plans'
import type { ConversationChannel, MetaMessagingChannel, WhatsAppChannel } from '@/types'

/** Brand names: shown as-is in every language. */
export const MESSAGING_LABEL: Record<MetaMessagingChannel, string> = {
  instagram: 'Instagram',
  messenger: 'Messenger',
}

/** The plan module that gates each channel (migration 101). */
export function messagingModule(kind: MetaMessagingChannel): Module {
  return kind === 'instagram' ? 'channel_instagram' : 'channel_messenger'
}

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
