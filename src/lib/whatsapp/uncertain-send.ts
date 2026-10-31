import { MessagingUncertainSendError } from '@/lib/meta-messaging/skip'
import { MetaSendError } from '@/lib/whatsapp/meta-api'
import { GatewayUnreachableError } from '@/lib/whatsapp/qr-gateway'

/**
 * The send may have reached WhatsApp: Meta timeout / 5xx / network
 * ("uncertain"), gateway unreachable / timeout / no id, or delivered
 * but not stored, or the same on Instagram / Messenger. Such a bubble is never sent again (automatic AI replies,
 * satisfaction surveys). Only an error raised BEFORE the request left is
 * safe to retry.
 */
export function isUncertainSend(err: unknown): boolean {
  if (err instanceof MetaSendError) return err.uncertain
  if (err instanceof GatewayUnreachableError) return true
  // Instagram / Messenger: timeout, network error, Meta 5xx, unreadable 2xx.
  if (err instanceof MessagingUncertainSendError) return true
  const msg = err instanceof Error ? err.message : String(err)
  return /\bsent (to Meta|via gateway) but DB insert failed/i.test(msg)
}
