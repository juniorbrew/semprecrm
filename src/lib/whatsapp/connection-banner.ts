// ============================================================
// Which "WhatsApp not connected" banner (if any) the inbox shows.
//
// An account is connected when EITHER channel is up: the official
// Cloud API (`whatsapp_config.status`) or the QR-code session
// (`wa_qr_sessions.status`). Copy is English here — the runtime
// translator (`translateLiteral`) turns it into pt-BR from the i18n
// catalogue, like the rest of the inbox.
// ============================================================

import type { WaQrSessionStatus } from '@/types'

export type WhatsAppBannerKind = 'not_connected' | 'qr_disconnected'

export interface WhatsAppBanner {
  kind: WhatsAppBannerKind
  message: string
}

export const BANNER_NOT_CONNECTED = 'WhatsApp® is not connected. Go to Settings to connect your account.'
export const BANNER_QR_DISCONNECTED = 'WhatsApp via QR code is disconnected. Reconnect in Settings.'

export interface ConnectionBannerInput {
  /** `whatsapp_config.status` for the account, `null`/`undefined` when there is no row. */
  officialStatus: string | null | undefined
  /** `wa_qr_sessions.status` for the account, `null`/`undefined` when there is no row. */
  qrStatus: WaQrSessionStatus | string | null | undefined
}

/**
 * `null` = connected on at least one channel, no banner.
 * A QR session row that exists but is not `connected` (`qr`,
 * `connecting`, `disconnected`) gets its own message so the user knows
 * which channel to fix.
 */
export function whatsappConnectionBanner(input: ConnectionBannerInput): WhatsAppBanner | null {
  if (input.officialStatus === 'connected' || input.qrStatus === 'connected') return null
  if (input.qrStatus) return { kind: 'qr_disconnected', message: BANNER_QR_DISCONNECTED }
  return { kind: 'not_connected', message: BANNER_NOT_CONNECTED }
}
