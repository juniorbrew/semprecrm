import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { downloadMediaMessage, type WAMessage, type WASocket } from "@whiskeysockets/baileys";
import type { Logger } from "./logger.js";
import type { PendingMedia } from "./inbound-mapper.js";

export const CHAT_MEDIA_BUCKET = "chat-media";

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

export interface MediaStoreOptions {
  supabaseUrl: string;
  serviceRoleKey: string;
  logger: Logger;
  /** injeção para testes */
  client?: SupabaseClient;
  download?: (msg: WAMessage, sock: WASocket) => Promise<Buffer>;
}

export class MediaStore {
  private readonly client: SupabaseClient;
  private readonly download: (msg: WAMessage, sock: WASocket) => Promise<Buffer>;
  private readonly log: Logger;

  constructor(opts: MediaStoreOptions) {
    this.client =
      opts.client ??
      createClient(opts.supabaseUrl, opts.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    this.log = opts.logger.child({ module: "media" });
    this.download =
      opts.download ??
      ((msg, sock) =>
        downloadMediaMessage(
          msg,
          "buffer",
          {},
          { logger: this.log, reuploadRequest: sock.updateMediaMessage },
        ));
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
    const buffer = await this.download(msg, sock);
    const path = buildQrMediaPath(accountId, media.filename ?? "file");
    const { error } = await this.client.storage.from(CHAT_MEDIA_BUCKET).upload(path, buffer, {
      contentType: media.mimetype,
      upsert: false,
    });
    if (error) {
      throw new Error(`upload no bucket ${CHAT_MEDIA_BUCKET} falhou: ${error.message}`);
    }
    const { data } = this.client.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path);
    this.log.debug({ accountId, path, bytes: buffer.length }, "mídia armazenada");
    return { url: data.publicUrl, path };
  }
}
