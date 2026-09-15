import { describe, expect, it } from 'vitest'

import { translateLiteral } from '@/lib/i18n'

import {
  BANNER_NOT_CONNECTED,
  BANNER_QR_DISCONNECTED,
  whatsappConnectionBanner,
} from './connection-banner'

describe('whatsappConnectionBanner', () => {
  it('no banner when the official channel is connected', () => {
    expect(whatsappConnectionBanner({ officialStatus: 'connected', qrStatus: null })).toBeNull()
    expect(whatsappConnectionBanner({ officialStatus: 'connected', qrStatus: 'disconnected' })).toBeNull()
  })

  it('no banner when the QR session is connected (official absent or not connected)', () => {
    expect(whatsappConnectionBanner({ officialStatus: null, qrStatus: 'connected' })).toBeNull()
    expect(whatsappConnectionBanner({ officialStatus: 'pending', qrStatus: 'connected' })).toBeNull()
  })

  it('generic banner when neither channel was ever set up', () => {
    expect(whatsappConnectionBanner({ officialStatus: null, qrStatus: null })).toEqual({
      kind: 'not_connected',
      message: BANNER_NOT_CONNECTED,
    })
    expect(whatsappConnectionBanner({ officialStatus: 'pending', qrStatus: undefined })).toMatchObject({
      kind: 'not_connected',
    })
  })

  it('QR-specific banner when a QR session exists but is not connected', () => {
    for (const qrStatus of ['qr', 'connecting', 'disconnected'] as const) {
      expect(whatsappConnectionBanner({ officialStatus: null, qrStatus })).toEqual({
        kind: 'qr_disconnected',
        message: BANNER_QR_DISCONNECTED,
      })
    }
  })

  it('both messages have pt-BR copy in the i18n catalogue', () => {
    expect(translateLiteral(BANNER_NOT_CONNECTED, 'pt-BR')).toBe(
      'O WhatsApp® não está conectado. Acesse Configurações para conectar sua conta.',
    )
    expect(translateLiteral(BANNER_QR_DISCONNECTED, 'pt-BR')).toBe(
      'WhatsApp via QR code desconectado. Reconecte em Configurações.',
    )
  })
})
