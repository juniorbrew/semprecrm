import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { downloadMediaMessage, type WAMessage, type WASocket } from "@whiskeysockets/baileys";
import type { Logger } from "./logger.js";
import type { PendingMedia } from "./inbound-mapper.js";

export const CHAT_MEDIA_BUCKET = "chat-media";
/** Fotos de perfil dos contatos (migration 055): pública, só a service role grava. */
export const CONTACT_AVATARS_BUCKET = "contact-avatars";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Caminho da foto de um contato: `account-<id>/<contact_id>`. Um arquivo por
 * contato (sobrescrito a cada atualização); o id do contato, e não o
 * telefone, para não expor números em URLs públicas.
 */
export function buildAvatarPath(accountId: string, contactId: string): string {
  if (!UUID_RE.test(contactId)) throw new Error("contact_id inválido");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) throw new Error("account_id inválido");
  return `account-${accountId}/${contactId.toLowerCase()}`;
}

/**
 * Caminho no bucket: `account-<id>/qr/<ts>-<nome>`. O primeiro segmento
 * (`account-<uuid>`) é o que as policies do bucket usam; o segundo separa a
 * mídia do canal QR da mídia enviada pelo inbox/oficial.
 */
export function buildQrMediaPath(accountId: string, filename: string, now: number = Date.now()): string {
  const hasExt = /\.[^.]+$/.test(filename);
  const ext = hasExt ? filename.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin" : "bin";
  const base =
    filename
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 40) || "file";
  return `account-${accountId}/qr/${now}-${base}.${ext}`;
}

/** Mídia recebida acima disso não é baixada (o WhatsApp limita vídeo a 16 MB). */
export const MAX_INBOUND_MEDIA_BYTES = 16 * 1024 * 1024;
/** Downloads simultâneos por processo; os demais esperam na fila. */
export const MAX_CONCURRENT_DOWNLOADS = 3;
/** Fila cheia (inundação de mídia): a mensagem segue com o placeholder. */
export const MAX_QUEUED_DOWNLOADS = 50;
/** Prazo de cada download (por vaga). */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

export class MediaTooLargeError extends Error {
  constructor(bytes: number) {
    super(`mídia de ${bytes} bytes acima do limite de ${MAX_INBOUND_MEDIA_BYTES}`);
    this.name = "MediaTooLargeError";
  }
}

const MEDIA_KEYS = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage", "ptvMessage"];
const WRAPPER_KEYS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
];

/**
 * `fileLength` que o remetente declarou na mensagem (antes de baixar), ou
 * undefined se não houver. Desembrulha efêmera / visualização única /
 * documento com legenda.
 */
export function declaredMediaBytes(msg: WAMessage): number | undefined {
  let content = msg.message as Record<string, unknown> | null | undefined;
  for (let i = 0; i < 4 && content; i++) {
    const wrapper = WRAPPER_KEYS.map((k) => content![k] as { message?: Record<string, unknown> } | undefined).find(
      (w) => w?.message,
    );
    if (!wrapper) break;
    content = wrapper.message;
  }
  if (!content) return undefined;
  for (const key of MEDIA_KEYS) {
    const media = content[key] as { fileLength?: unknown } | undefined;
    if (!media) continue;
    const v = media.fileLength;
    const n =
      typeof v === "object" && v !== null && "toNumber" in v
        ? (v as { toNumber: () => number }).toNumber()
        : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  return undefined;
}

/** Lê o stream até `max` bytes; acima disso destrói o stream e lança MediaTooLargeError. */
export async function readCapped(
  stream: AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => void },
  max: number = MAX_INBOUND_MEDIA_BYTES,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > max) {
      const err = new MediaTooLargeError(total);
      stream.destroy?.(err);
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export interface MediaStoreOptions {
  supabaseUrl: string;
  /** Base pública das URLs devolvidas (padrão: `supabaseUrl`). */
  supabasePublicUrl?: string;
  serviceRoleKey: string;
  logger: Logger;
  /** injeção para testes */
  client?: SupabaseClient;
  download?: (msg: WAMessage, sock: WASocket, signal: AbortSignal) => Promise<Buffer>;
  /** injeção para testes (padrão MAX_CONCURRENT_DOWNLOADS) */
  maxConcurrentDownloads?: number;
  /** injeção para testes (padrão DOWNLOAD_TIMEOUT_MS) */
  downloadTimeoutMs?: number;
}

/**
 * Tipo para o Storage sem parâmetros: o WhatsApp manda áudio de voz como
 * `audio/ogg; codecs=opus`, e o bucket `chat-media` só aceita `audio/ogg`
 * (allowed_mime_types compara o tipo inteiro). Sem isso TODO áudio
 * recebido virava "[audio não disponível]".
 */
export function storageMimeType(mimetype: string): string {
  return mimetype.split(";")[0].trim().toLowerCase() || "application/octet-stream";
}

export class MediaStore {
  private readonly client: SupabaseClient;
  private readonly download: (msg: WAMessage, sock: WASocket, signal: AbortSignal) => Promise<Buffer>;
  private readonly downloadTimeoutMs: number;
  private readonly log: Logger;
  private readonly baseUrl: string;
  private readonly publicUrl: string | undefined;
  private readonly maxConcurrent: number;
  private activeDownloads = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(opts: MediaStoreOptions) {
    this.baseUrl = opts.supabaseUrl.replace(/\/+$/, "");
    this.publicUrl = opts.supabasePublicUrl;
    this.client =
      opts.client ??
      createClient(opts.supabaseUrl, opts.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    this.log = opts.logger.child({ module: "media" });
    this.maxConcurrent = opts.maxConcurrentDownloads ?? MAX_CONCURRENT_DOWNLOADS;
    this.downloadTimeoutMs = opts.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    // Stream com teto de bytes: o modo "buffer" do Baileys guardaria a mídia
    // inteira em memória, qualquer que fosse o tamanho.
    this.download =
      opts.download ??
      (async (msg, sock, signal) => {
        const stream = await downloadMediaMessage(
          msg,
          "stream",
          {},
          { logger: this.log, reuploadRequest: sock.updateMediaMessage },
        );
        const onAbort = () => stream.destroy(signal.reason as Error);
        if (signal.aborted) onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          return await readCapped(stream);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      });
  }

  /** Vaga de download (no máximo `maxConcurrent` simultâneos); fila cheia → erro. */
  private async acquireDownloadSlot(): Promise<void> {
    if (this.activeDownloads < this.maxConcurrent) {
      this.activeDownloads++;
      return;
    }
    if (this.waiting.length >= MAX_QUEUED_DOWNLOADS) throw new Error("fila de downloads de mídia cheia");
    // a vaga é repassada por releaseDownloadSlot sem decrementar o contador
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private releaseDownloadSlot(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.activeDownloads--;
  }

  /**
   * Baixa a mídia da mensagem (descriptografada pelo Baileys) e sobe no bucket
   * `chat-media` com a service role. Retorna a URL pública.
   */
  async storeInbound(
    accountId: string,
    msg: WAMessage,
    sock: WASocket,
    media: PendingMedia,
  ): Promise<{ url: string; path: string }> {
    // Tamanho declarado pelo remetente: acima do teto nem baixa (placeholder).
    const declared = declaredMediaBytes(msg);
    if (declared !== undefined && declared > MAX_INBOUND_MEDIA_BYTES) throw new MediaTooLargeError(declared);
    // A vaga cobre download + upload: é o tempo em que o buffer vive em memória.
    await this.acquireDownloadSlot();
    const path = buildQrMediaPath(accountId, media.filename ?? "file");
    let bytes: number;
    try {
      // Prazo por download: um CDN lento não segura a vaga para sempre.
      const signal = AbortSignal.timeout(this.downloadTimeoutMs);
      const buffer = await Promise.race([
        this.download(msg, sock, signal),
        new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("download de mídia excedeu o prazo")), {
            once: true,
          }),
        ),
      ]);
      if (buffer.length > MAX_INBOUND_MEDIA_BYTES) throw new MediaTooLargeError(buffer.length);
      bytes = buffer.length;
      const { error } = await this.client.storage.from(CHAT_MEDIA_BUCKET).upload(path, buffer, {
        contentType: storageMimeType(media.mimetype),
        upsert: false,
      });
      if (error) {
        throw new Error(`upload no bucket ${CHAT_MEDIA_BUCKET} falhou: ${error.message}`);
      }
    } finally {
      this.releaseDownloadSlot();
    }
    const { data } = this.client.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path);
    this.log.debug({ accountId, path, bytes }, "mídia armazenada");
    return { url: this.toPublicUrl(data.publicUrl), path };
  }

  /**
   * Grava (sobrescreve) a foto do contato no bucket `contact-avatars`. A URL
   * devolvida leva `?v=<ts>` para o navegador não mostrar a versão antiga do
   * cache depois de uma troca de foto.
   */
  async storeAvatar(
    accountId: string,
    contactId: string,
    buffer: Buffer,
    contentType: string,
    now: number = Date.now(),
  ): Promise<{ url: string; path: string }> {
    const path = buildAvatarPath(accountId, contactId);
    const { error } = await this.client.storage.from(CONTACT_AVATARS_BUCKET).upload(path, buffer, {
      contentType,
      upsert: true,
      cacheControl: "3600",
    });
    if (error) {
      throw new Error(`upload no bucket ${CONTACT_AVATARS_BUCKET} falhou: ${error.message}`);
    }
    const { data } = this.client.storage.from(CONTACT_AVATARS_BUCKET).getPublicUrl(path);
    return { url: `${this.toPublicUrl(data.publicUrl)}?v=${now}`, path };
  }

  /** Apaga a foto guardada (o contato tirou a foto ou escondeu por privacidade). */
  async removeAvatar(accountId: string, contactId: string): Promise<void> {
    const path = buildAvatarPath(accountId, contactId);
    const { error } = await this.client.storage.from(CONTACT_AVATARS_BUCKET).remove([path]);
    if (error) this.log.debug({ accountId, path, err: error.message }, "remoção da foto falhou (ignorado)");
  }

  private toPublicUrl(publicUrl: string): string {
    const publicBase = (this.publicUrl ?? "").replace(/\/+$/, "");
    return publicBase && publicUrl.startsWith(this.baseUrl)
      ? publicBase + publicUrl.slice(this.baseUrl.length)
      : publicUrl;
  }
}
