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

export interface MediaStoreOptions {
  supabaseUrl: string;
  /** Base pública das URLs devolvidas (padrão: `supabaseUrl`). */
  supabasePublicUrl?: string;
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
  private readonly baseUrl: string;
  private readonly publicUrl: string | undefined;

  constructor(opts: MediaStoreOptions) {
    this.baseUrl = opts.supabaseUrl.replace(/\/+$/, "");
    this.publicUrl = opts.supabasePublicUrl;
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
