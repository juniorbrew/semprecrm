// ============================================================
// Pieces shared by the manual reply (manual-send.ts) and the automatic sender
// (engine-send.ts): the user-facing wording and the mapping of Meta's errors.
// ============================================================

import type { MetaMessagingChannel } from '@/types'

import { MESSAGING_LABEL } from './channels'
import { MessagingApiError } from './graph'

export interface SendFailure {
  status: number
  code: 'window_closed' | 'channel_expired' | 'permission_denied' | 'send_failed'
  message: string
  /** The token is dead: flag the connection so Settings shows "Reconectar". */
  tokenInvalid?: boolean
}

export function textLimitMessage(kind: MetaMessagingChannel): string {
  return kind === 'instagram'
    ? 'Mensagem longa demais para o Instagram: o limite é de 1000 bytes (cerca de 1000 letras sem acento; acentos e emojis ocupam mais).'
    : 'Mensagem longa demais para o Messenger: o limite é de 2000 caracteres.'
}

export function windowClosedMessage(kind: MetaMessagingChannel): string {
  return `A janela de 24 h do ${MESSAGING_LABEL[kind]} está encerrada: só é possível responder até 24 h depois da última mensagem do cliente. Aguarde ele escrever de novo.`
}

/** Meta's error → fixed pt-BR text (Meta's own text can quote ids). Logs status/code/subcode only. */
export function classifyMetaSendError(kind: MetaMessagingChannel, err: unknown): SendFailure {
  const label = MESSAGING_LABEL[kind]
  if (err instanceof MessagingApiError) {
    if (err.outsideWindow) {
      return { status: 409, code: 'window_closed', message: `A janela de 24 h do ${label} está encerrada. Aguarde o cliente escrever de novo.` }
    }
    console.error(`[meta-messaging] send failed: status ${err.status} code ${err.code} subcode ${err.subcode}`)
    if (err.tokenInvalid) {
      return { status: 400, code: 'channel_expired', tokenInvalid: true, message: `O ${label} recusou a conexão (acesso expirado ou revogado). Reconecte o canal nas configurações.` }
    }
    if (err.permissionDenied) {
      return { status: 403, code: 'permission_denied', message: `O ${label} recusou o envio por falta de permissão. Confira as permissões do app e reconecte o canal.` }
    }
    return { status: 502, code: 'send_failed', message: `O ${label} não aceitou a mensagem. Tente novamente em instantes.` }
  }
  console.error('[meta-messaging] send failed: network')
  return { status: 502, code: 'send_failed', message: `Não foi possível falar com o ${label}. Tente novamente.` }
}
