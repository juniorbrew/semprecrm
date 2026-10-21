/**
 * Contratos HTTP entre o gateway e o app
 * (docs/superpowers/specs/2026-09-12-whatsapp-qr-channel-design.md, seção 1).
 * Os nomes dos campos são a interface com o app — não renomear sem alinhar os dois lados.
 */

export type SessionStatus = "disconnected" | "qr" | "connecting" | "connected";

export interface SessionStatusResponse {
  status: SessionStatus;
  /** data URL (image/png) do último QR recebido; só em status `qr` */
  qr?: string;
  phone?: string;
  name?: string;
  connected_at?: string;
}

/**
 * `interactive`: atendente na caixa de entrada — sai na hora, nunca espera na
 * fila anti-banimento. `bulk`: automações, fluxos, IA, campanhas — entra na
 * fila da conta, com intervalos aleatórios e teto por minuto (send-queue.ts).
 */
export type SendPriority = "interactive" | "bulk";

export interface SendRequest {
  to: string;
  /** padrão `interactive` (compatível com apps antigos que não mandam o campo) */
  priority?: SendPriority;
  text?: string;
  media?: {
    url: string;
    mimetype: string;
    filename?: string;
    caption?: string;
    ptt?: boolean;
  };
}

/** `POST /sessions/:id/read` — confirmação de leitura (✓✓ azul) das mensagens recebidas. */
export interface ReadRequest {
  /** telefone do contato (dígitos), usado quando o id não está no cache */
  to: string;
  message_ids: string[];
}

export interface ReadResponse {
  read: number;
}

/** `POST /sessions/:id/avatar` — foto de perfil do contato (canal QR). */
export interface AvatarRequest {
  /** telefone do contato (dígitos) */
  to: string;
  /** `contacts.id` no app — nome do arquivo no bucket `contact-avatars` */
  contact_id: string;
}

/** `url: null` = o contato não tem foto visível para nós (privacidade ou sem foto). */
export interface AvatarResponse {
  url: string | null;
}

/**
 * `POST /sessions/:id/react` — reação do atendente a uma mensagem da conversa.
 * `emoji: ""` remove a reação.
 */
export interface ReactRequest {
  /** telefone do contato (dígitos) */
  to: string;
  /** id WhatsApp da mensagem reagida (`messages.message_id` no app) */
  message_id: string;
  /** a mensagem reagida foi enviada por nós (atendente/bot/celular) */
  from_me: boolean;
  emoji: string;
  /** chat em que a mensagem do cliente chegou (`InboundPayload.chat_jid`), se o app guardou */
  chat_jid?: string;
}

/** `POST /sessions/:id/presence` — "digitando..." no celular do cliente. */
export interface PresenceRequest {
  /** telefone do contato (dígitos) */
  to: string;
  state: "composing" | "paused";
}

export interface SendResponse {
  message_id: string;
}

export type InboundType = "text" | "image" | "audio" | "video" | "document" | "sticker" | "location";

export interface InboundPayload {
  account_id: string;
  message_id: string;
  /** só dígitos, ex.: "5511999999999" */
  from: string;
  push_name: string;
  /** Unix epoch em segundos (mesma semântica do webhook da Meta) */
  timestamp: number;
  type: InboundType;
  text?: string;
  media?: { url: string; mimetype: string; filename?: string };
  quoted_message_id?: string;
  /** chat como o Baileys endereçou (`…@s.whatsapp.net` ou `…@lid`); a reação precisa dele */
  chat_jid?: string;
}

/**
 * `POST /api/channels/qr/revoke` — o cliente (ou o nosso celular) apagou a
 * mensagem `message_id` para todos. O app marca a linha; nunca apaga.
 */
export interface RevokePayload {
  account_id: string;
  /** id da mensagem APAGADA (não o do aviso de revogação) */
  message_id: string;
  /** telefone do cliente da conversa (dígitos) */
  from: string;
  revoked_by: "customer" | "phone";
  timestamp: number;
}

/**
 * `POST /api/channels/qr/reaction` — o cliente reagiu (ou tirou a reação,
 * `emoji: ""`) a uma mensagem da conversa.
 */
export interface ReactionPayload {
  account_id: string;
  /** id da mensagem REAGIDA */
  message_id: string;
  /** telefone do cliente (dígitos) */
  from: string;
  emoji: string;
  timestamp: number;
}

export interface StatusEventPayload {
  account_id: string;
  status: SessionStatus;
  phone?: string;
  name?: string;
  error?: string;
}

export type AckStatus = "sent" | "delivered" | "read";

export interface AckPayload {
  account_id: string;
  message_id: string;
  status: AckStatus;
}
