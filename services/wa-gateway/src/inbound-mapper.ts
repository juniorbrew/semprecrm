import type { proto, WAMessage } from "@whiskeysockets/baileys";
import type { InboundPayload, InboundType, RevokePayload } from "./types.js";

/**
 * Mídia que o gateway ainda precisa baixar/subir antes de entregar ao app.
 * O mapper é puro: ele só descreve a mídia; quem baixa é o session-manager.
 */
export interface PendingMedia {
  mimetype: string;
  filename?: string;
}

export type SkipReason =
  | "own-send"
  | "self-chat"
  | "no-message"
  | "group"
  | "status-broadcast"
  | "newsletter"
  | "broadcast"
  | "no-phone"
  | "protocol"
  | "unsupported-type";

/**
 * - `message`: mensagem do cliente → `POST /api/channels/qr/inbound`.
 * - `echo`: mensagem que NÓS mandamos por fora do gateway (o celular
 *   conectado, o WhatsApp Web ou outro aparelho vinculado) →
 *   `POST /api/channels/qr/echo`. `from` é o telefone do CLIENTE (a
 *   conversa), não o nosso; `push_name` vai vazio (seria o nosso nome).
 * - `revoke`: "apagar para todos" → `POST /api/channels/qr/revoke`.
 */
export type MappedInbound =
  | { kind: "message"; payload: InboundPayload; media?: PendingMedia }
  | { kind: "echo"; payload: InboundPayload; media?: PendingMedia }
  | { kind: "revoke"; payload: RevokePayload }
  | { kind: "skip"; reason: SkipReason };

const PN_SUFFIX = "@s.whatsapp.net";

/** Remove o sufixo `@s.whatsapp.net` e o `:device`, deixando só dígitos. */
export function jidToPhone(jid: string | null | undefined): string | undefined {
  if (!jid || !jid.endsWith(PN_SUFFIX)) return undefined;
  const digits = jid.slice(0, -PN_SUFFIX.length).split(":")[0].replace(/\D/g, "");
  return digits || undefined;
}

/**
 * Baileys 7 pode entregar o `remoteJid` no formato LID (`123@lid`); nesse caso
 * o número de telefone vem em `remoteJidAlt`. Aceita também um JID resolvido
 * pelo chamador (via `signalRepository.lidMapping.getPNForLID`).
 */
export function resolveSenderPhone(key: WAMessage["key"], resolvedPn?: string): string | undefined {
  return jidToPhone(key.remoteJid) ?? jidToPhone(key.remoteJidAlt) ?? jidToPhone(resolvedPn);
}

/** Desembrulha wrappers (efêmera, view-once, documento com legenda, edição). */
export function unwrapContent(message: proto.IMessage | null | undefined): proto.IMessage | undefined {
  let content: proto.IMessage | null | undefined = message;
  for (let i = 0; i < 6 && content; i++) {
    const inner =
      content.ephemeralMessage?.message ??
      content.viewOnceMessage?.message ??
      content.viewOnceMessageV2?.message ??
      content.viewOnceMessageV2Extension?.message ??
      content.documentWithCaptionMessage?.message ??
      content.editedMessage?.message ??
      content.deviceSentMessage?.message;
    if (!inner) break;
    content = inner;
  }
  return content ?? undefined;
}

function toUnixSeconds(ts: WAMessage["messageTimestamp"]): number {
  if (ts == null) return Math.floor(Date.now() / 1000);
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") return Number.parseInt(ts, 10);
  // protobuf Long
  const maybeLong = ts as { toNumber?: () => number; low?: number };
  if (typeof maybeLong.toNumber === "function") return maybeLong.toNumber();
  if (typeof maybeLong.low === "number") return maybeLong.low;
  return Math.floor(Date.now() / 1000);
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "application/pdf": "pdf",
};

export function extFromMime(mimetype: string): string {
  const base = mimetype.split(";")[0].trim().toLowerCase();
  if (MIME_EXT[base]) return MIME_EXT[base];
  const sub = base.split("/")[1];
  const cleaned = sub ? sub.replace(/[^a-z0-9]+/g, "") : "";
  return cleaned || "bin";
}

function defaultFilename(kind: InboundType, mimetype: string): string {
  return `${kind}.${extFromMime(mimetype)}`;
}

const MAX_VCARDS = 10;
const MAX_VCARD_CHARS = 8 * 1024;

/** Stored vCard text: at most 10 cards, PHOTO/LOGO lines (and folded continuations) dropped, 8 KB cap. */
export function capVCards(vcards: string[]): string {
  const out: string[] = [];
  for (const card of vcards.slice(0, MAX_VCARDS)) {
    let skipping = false;
    for (const line of card.split(/\r?\n|\r/)) {
      if (/^[ \t]/.test(line)) {
        if (!skipping) out.push(line);
        continue;
      }
      skipping = /^(PHOTO|LOGO)[;:]/i.test(line);
      if (!skipping) out.push(line);
    }
  }
  return out.join("\n").slice(0, MAX_VCARD_CHARS);
}

interface Extracted {
  type: InboundType;
  text?: string;
  media?: PendingMedia;
  contextInfo?: proto.IContextInfo | null;
}

function extract(content: proto.IMessage): Extracted | { skip: SkipReason } {
  if (content.conversation != null) {
    return { type: "text", text: content.conversation };
  }
  if (content.extendedTextMessage) {
    const m = content.extendedTextMessage;
    return { type: "text", text: m.text ?? "", contextInfo: m.contextInfo };
  }
  if (content.imageMessage) {
    const m = content.imageMessage;
    const mimetype = m.mimetype || "image/jpeg";
    return {
      type: "image",
      text: m.caption ?? undefined,
      media: { mimetype, filename: defaultFilename("image", mimetype) },
      contextInfo: m.contextInfo,
    };
  }
  if (content.videoMessage) {
    const m = content.videoMessage;
    const mimetype = m.mimetype || "video/mp4";
    return {
      type: "video",
      text: m.caption ?? undefined,
      media: { mimetype, filename: defaultFilename("video", mimetype) },
      contextInfo: m.contextInfo,
    };
  }
  if (content.audioMessage) {
    const m = content.audioMessage;
    const mimetype = m.mimetype || "audio/ogg";
    return {
      type: "audio",
      media: { mimetype, filename: defaultFilename("audio", mimetype) },
      contextInfo: m.contextInfo,
    };
  }
  if (content.documentMessage) {
    const m = content.documentMessage;
    const mimetype = m.mimetype || "application/octet-stream";
    return {
      type: "document",
      text: m.caption ?? undefined,
      media: { mimetype, filename: m.fileName || defaultFilename("document", mimetype) },
      contextInfo: m.contextInfo,
    };
  }
  if (content.stickerMessage) {
    const m = content.stickerMessage;
    const mimetype = m.mimetype || "image/webp";
    return {
      type: "sticker",
      media: { mimetype, filename: defaultFilename("sticker", mimetype) },
      contextInfo: m.contextInfo,
    };
  }
  const loc = content.locationMessage ?? content.liveLocationMessage;
  if (loc) {
    const lat = loc.degreesLatitude ?? 0;
    const lng = loc.degreesLongitude ?? 0;
    const name = "name" in loc ? loc.name : undefined;
    const address = "address" in loc ? loc.address : undefined;
    const label = [name, address].filter((s): s is string => !!s).join(" - ");
    const text = label ? `${label} (${lat},${lng})` : `${lat},${lng}`;
    return { type: "location", text, contextInfo: loc.contextInfo };
  }
  // Contact cards travel as vCard text ("BEGIN:VCARD..."): the inbox renders
  // a card from it (src/lib/inbox/vcard.ts).
  const vcards = [
    content.contactMessage?.vcard,
    ...(content.contactsArrayMessage?.contacts ?? []).map((c) => c.vcard),
  ].filter((v): v is string => !!v && /^\s*BEGIN:VCARD/i.test(v));
  if (vcards.length > 0) {
    const info = content.contactMessage?.contextInfo ?? content.contactsArrayMessage?.contextInfo;
    return { type: "text", text: vcards.join("\n"), contextInfo: info };
  }
  if (
    content.protocolMessage ||
    content.senderKeyDistributionMessage ||
    content.reactionMessage ||
    content.pollUpdateMessage
  ) {
    return { skip: "protocol" };
  }
  return { skip: "unsupported-type" };
}

export interface MapOptions {
  /** JID de telefone já resolvido para um remoteJid LID (opcional). */
  resolvedPn?: string;
  /**
   * Ids que o próprio gateway enviou (`send()`). Um `fromMe` com um desses
   * ids é o eco do nosso envio — o app já gravou (ou vai gravar) a linha.
   */
  ownSendIds?: { has(id: string): boolean };
  /** Nosso número (dígitos). "Mensagem para mim mesmo" não é conversa. */
  selfPhone?: string;
}

/**
 * Telefone do CLIENTE de uma conversa 1:1. Para `fromMe` num chat `@lid`,
 * o `remoteJidAlt` pode vir com o NOSSO número: a ordem é o JID de
 * telefone, depois o PN resolvido do LID (`getPNForLID`), e só então o
 * alt — sempre ignorando o nosso próprio número.
 */
export function resolveChatPhone(key: WAMessage["key"], fromMe: boolean, opts: MapOptions): string | undefined {
  if (!fromMe) return resolveSenderPhone(key, opts.resolvedPn);
  const candidates = [jidToPhone(key.remoteJid), jidToPhone(opts.resolvedPn), jidToPhone(key.remoteJidAlt)];
  return candidates.find((p) => p && p !== opts.selfPhone);
}

/** `proto.Message.ProtocolMessage.Type.REVOKE` ("apagar para todos"). */
const PROTOCOL_REVOKE = 0;

/** Id da mensagem apagada, quando `content` é um "apagar para todos". */
export function revokedMessageId(content: proto.IMessage | undefined): string | undefined {
  const pm = content?.protocolMessage;
  if (!pm || pm.type !== PROTOCOL_REVOKE) return undefined;
  return pm.key?.id || undefined;
}

/**
 * Classifica uma WAMessage do Baileys: mensagem do cliente, eco de algo que
 * mandamos pelo celular, "apagar para todos" ou descarte (ver MappedInbound).
 * Puro: não faz I/O; mídia volta como `media` pendente para o chamador baixar.
 */
export function mapInboundMessage(accountId: string, msg: WAMessage, opts: MapOptions = {}): MappedInbound {
  const key = msg.key;
  const fromMe = !!key.fromMe;
  if (fromMe && key.id && opts.ownSendIds?.has(key.id)) return { kind: "skip", reason: "own-send" };
  const jid = key.remoteJid ?? "";
  if (jid.endsWith("@g.us")) return { kind: "skip", reason: "group" };
  if (jid === "status@broadcast") return { kind: "skip", reason: "status-broadcast" };
  if (jid.endsWith("@newsletter")) return { kind: "skip", reason: "newsletter" };
  if (jid.endsWith("@broadcast")) return { kind: "skip", reason: "broadcast" };

  // "mensagem para mim mesmo" — não é conversa com cliente
  if (fromMe && opts.selfPhone && jidToPhone(key.remoteJid) === opts.selfPhone) {
    return { kind: "skip", reason: "self-chat" };
  }

  const content = unwrapContent(msg.message);
  if (!content) return { kind: "skip", reason: "no-message" };

  const revokedId = revokedMessageId(content);
  if (revokedId) {
    const from = resolveChatPhone(key, fromMe, opts);
    if (!from) return { kind: "skip", reason: "no-phone" };
    return {
      kind: "revoke",
      payload: {
        account_id: accountId,
        message_id: revokedId,
        from,
        revoked_by: fromMe ? "phone" : "customer",
        timestamp: toUnixSeconds(msg.messageTimestamp),
      },
    };
  }

  const extracted = extract(content);
  if ("skip" in extracted) return { kind: "skip", reason: extracted.skip };

  const from = resolveChatPhone(key, fromMe, opts);
  if (!from) return { kind: "skip", reason: "no-phone" };
  if (!key.id) return { kind: "skip", reason: "no-message" };

  const payload: InboundPayload = {
    account_id: accountId,
    message_id: key.id,
    from,
    // num eco o pushName é o NOSSO nome — não pode renomear o contato
    push_name: fromMe ? "" : (msg.pushName ?? ""),
    timestamp: toUnixSeconds(msg.messageTimestamp),
    type: extracted.type,
  };
  if (extracted.text != null && extracted.text !== "") payload.text = extracted.text;
  const quoted = extracted.contextInfo?.stanzaId;
  if (quoted) payload.quoted_message_id = quoted;

  const kind = fromMe ? "echo" : "message";
  return extracted.media ? { kind, payload, media: extracted.media } : { kind, payload };
}
