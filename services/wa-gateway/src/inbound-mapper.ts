import type { proto, WAMessage } from "@whiskeysockets/baileys";
import type { InboundPayload, InboundType } from "./types.js";

/**
 * Mídia que o gateway ainda precisa baixar/subir antes de entregar ao app.
 * O mapper é puro: ele só descreve a mídia; quem baixa é o session-manager.
 */
export interface PendingMedia {
  mimetype: string;
  filename?: string;
}

export type SkipReason =
  | "from-me"
  | "no-message"
  | "group"
  | "status-broadcast"
  | "newsletter"
  | "broadcast"
  | "no-phone"
  | "protocol"
  | "unsupported-type";

export type MappedInbound =
  | { kind: "message"; payload: InboundPayload; media?: PendingMedia }
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
}

/**
 * Converte uma WAMessage do Baileys no payload de `POST /api/channels/qr/inbound`.
 * Puro: não faz I/O; mídia volta como `media` pendente para o chamador baixar.
 */
export function mapInboundMessage(accountId: string, msg: WAMessage, opts: MapOptions = {}): MappedInbound {
  const key = msg.key;
  if (key.fromMe) return { kind: "skip", reason: "from-me" };
  const jid = key.remoteJid ?? "";
  if (jid.endsWith("@g.us")) return { kind: "skip", reason: "group" };
  if (jid === "status@broadcast") return { kind: "skip", reason: "status-broadcast" };
  if (jid.endsWith("@newsletter")) return { kind: "skip", reason: "newsletter" };
  if (jid.endsWith("@broadcast")) return { kind: "skip", reason: "broadcast" };

  const content = unwrapContent(msg.message);
  if (!content) return { kind: "skip", reason: "no-message" };

  const extracted = extract(content);
  if ("skip" in extracted) return { kind: "skip", reason: extracted.skip };

  const from = resolveSenderPhone(key, opts.resolvedPn);
  if (!from) return { kind: "skip", reason: "no-phone" };
  if (!key.id) return { kind: "skip", reason: "no-message" };

  const payload: InboundPayload = {
    account_id: accountId,
    message_id: key.id,
    from,
    push_name: msg.pushName ?? "",
    timestamp: toUnixSeconds(msg.messageTimestamp),
    type: extracted.type,
  };
  if (extracted.text != null && extracted.text !== "") payload.text = extracted.text;
  const quoted = extracted.contextInfo?.stanzaId;
  if (quoted) payload.quoted_message_id = quoted;

  return extracted.media ? { kind: "message", payload, media: extracted.media } : { kind: "message", payload };
}
