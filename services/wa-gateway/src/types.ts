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

export interface SendRequest {
  to: string;
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
