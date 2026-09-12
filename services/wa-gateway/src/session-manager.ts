import fs from "node:fs/promises";
import path from "node:path";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type AnyMessageContent,
  type ConnectionState,
  type WAMessage,
  type WAMessageUpdate,
  type WASocket,
  type WAVersion,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import type { AppClient } from "./app-client.js";
import { jidToPhone, mapInboundMessage } from "./inbound-mapper.js";
import type { Logger } from "./logger.js";
import type { MediaStore } from "./media.js";
import type { AckStatus, SendRequest, SendResponse, SessionStatus, SessionStatusResponse } from "./types.js";

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code: "not_connected" | "not_on_whatsapp" | "invalid_request" | "send_failed",
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

interface Session {
  accountId: string;
  status: SessionStatus;
  qr?: string;
  phone?: string;
  name?: string;
  connectedAt?: string;
  lastError?: string;
  sock?: WASocket;
  reconnectAttempts: number;
  reconnectTimer?: NodeJS.Timeout;
  /** logout em andamento: não reconectar */
  stopping: boolean;
  /** evita duas `startSocket` concorrentes para a mesma conta */
  starting: boolean;
}

export interface SessionManagerOptions {
  dataDir: string;
  appClient: Pick<AppClient, "sendInbound" | "sendStatus" | "sendAck">;
  mediaStore: Pick<MediaStore, "storeInbound">;
  logger: Logger;
  /** injeção para testes */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

const PN_SUFFIX = "@s.whatsapp.net";

/** proto.WebMessageInfo.Status → ack do app. `null` = sem ack relevante. */
export function ackFromStatus(status: number | null | undefined): AckStatus | null {
  switch (status) {
    case 2: // SERVER_ACK
      return "sent";
    case 3: // DELIVERY_ACK
      return "delivered";
    case 4: // READ
    case 5: // PLAYED
      return "read";
    default:
      return null;
  }
}

export function toJid(to: string): string {
  const digits = to.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new GatewayError(`número inválido: ${to}`, "invalid_request", 400);
  }
  return `${digits}${PN_SUFFIX}`;
}

function userPhone(user: WASocket["user"]): string | undefined {
  if (!user) return undefined;
  const candidate = user.phoneNumber ?? user.id;
  return jidToPhone(candidate) ?? candidate.split("@")[0].split(":")[0].replace(/\D/g, "") ?? undefined;
}

function userName(user: WASocket["user"]): string | undefined {
  return user?.name ?? user?.notify ?? user?.verifiedName ?? undefined;
}

function disconnectCode(update: Partial<ConnectionState>): number | undefined {
  const err = update.lastDisconnect?.error;
  if (!err) return undefined;
  if (err instanceof Boom) return err.output?.statusCode;
  return (err as { output?: { statusCode?: number } }).output?.statusCode;
}

function isNotOnWhatsAppError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  const code = (err as { output?: { statusCode?: number } })?.output?.statusCode;
  return code === 404 || /not.?on.?whatsapp|no.?jid|item-not-found|recipient/.test(msg);
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly log: Logger;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private versionPromise?: Promise<WAVersion | undefined>;

  constructor(private readonly opts: SessionManagerOptions) {
    this.log = opts.logger.child({ module: "session-manager" });
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 2000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 60_000;
  }

  // ---------- API pública ----------

  getStatus(accountId: string): SessionStatusResponse {
    const s = this.sessions.get(accountId);
    if (!s) return { status: "disconnected" };
    const out: SessionStatusResponse = { status: s.status };
    if (s.status === "qr" && s.qr) out.qr = s.qr;
    if (s.phone) out.phone = s.phone;
    if (s.name) out.name = s.name;
    if (s.connectedAt) out.connected_at = s.connectedAt;
    return out;
  }

  listAccountIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Inicia (ou retoma) a sessão. Idempotente: se já está ativa, só devolve o status. */
  async connect(accountId: string): Promise<SessionStatusResponse> {
    let s = this.sessions.get(accountId);
    if (s?.sock && s.status !== "disconnected") return this.getStatus(accountId);
    if (s?.starting) return this.getStatus(accountId);
    if (!s) {
      s = { accountId, status: "disconnected", reconnectAttempts: 0, stopping: false, starting: false };
      this.sessions.set(accountId, s);
    }
    s.stopping = false;
    s.reconnectAttempts = 0;
    this.clearReconnect(s);
    await this.startSocket(s);
    return this.getStatus(accountId);
  }

  /** Encerra a sessão no WhatsApp e apaga as credenciais em disco. */
  async logout(accountId: string): Promise<SessionStatusResponse> {
    const s = this.sessions.get(accountId);
    if (!s) {
      await this.removeAuthDir(accountId);
      return { status: "disconnected" };
    }
    s.stopping = true;
    this.clearReconnect(s);
    const sock = s.sock;
    s.sock = undefined;
    if (sock) {
      try {
        // logout manda um IQ ao WhatsApp; não deixa o HTTP preso se a rede estiver ruim
        await Promise.race([sock.logout(), new Promise((r) => setTimeout(r, 8000).unref?.())]);
      } catch (err) {
        this.log.debug({ accountId, err: (err as Error).message }, "logout no WhatsApp falhou (ignorado)");
      }
      try {
        sock.ev.removeAllListeners("connection.update");
        sock.ev.removeAllListeners("messages.upsert");
        sock.ev.removeAllListeners("messages.update");
        sock.ev.removeAllListeners("creds.update");
        sock.end(undefined);
      } catch {
        /* socket já fechado */
      }
    }
    await this.removeAuthDir(accountId);
    this.setStatus(s, "disconnected", { phone: undefined, name: undefined, connectedAt: undefined, qr: undefined });
    this.emitStatus(s);
    this.sessions.delete(accountId);
    return { status: "disconnected" };
  }

  async send(accountId: string, req: SendRequest): Promise<SendResponse> {
    const s = this.sessions.get(accountId);
    if (!s?.sock || s.status !== "connected") {
      throw new GatewayError("sessão não conectada", "not_connected", 409);
    }
    if (!req.text && !req.media) {
      throw new GatewayError("informe text ou media", "invalid_request", 400);
    }
    const sock = s.sock;
    const jid = toJid(req.to);
    const content = buildContent(req);

    let result: WAMessage | undefined;
    try {
      result = await sock.sendMessage(jid, content);
    } catch (err) {
      if (!isNotOnWhatsAppError(err)) {
        this.log.error({ accountId, jid, err: (err as Error).message }, "sendMessage falhou");
        throw new GatewayError(`falha ao enviar: ${(err as Error).message}`, "send_failed", 502);
      }
      const resolved = await this.resolveJid(sock, jid);
      if (!resolved) {
        throw new GatewayError(`número não está no WhatsApp: ${req.to}`, "not_on_whatsapp", 422);
      }
      try {
        result = await sock.sendMessage(resolved, content);
      } catch (err2) {
        throw new GatewayError(`falha ao enviar: ${(err2 as Error).message}`, "send_failed", 502);
      }
    }
    const id = result?.key?.id;
    if (!id) throw new GatewayError("WhatsApp não devolveu id da mensagem", "send_failed", 502);
    return { message_id: id };
  }

  /** Retoma, na subida do processo, todas as contas com credenciais em disco. */
  async resumeAll(): Promise<string[]> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.opts.dataDir);
    } catch {
      return [];
    }
    const resumed: string[] = [];
    for (const name of entries) {
      try {
        await fs.access(path.join(this.opts.dataDir, name, "creds.json"));
      } catch {
        continue;
      }
      this.log.info({ accountId: name }, "retomando sessão salva");
      void this.connect(name).catch((err) => {
        this.log.error({ accountId: name, err: (err as Error).message }, "falha ao retomar sessão");
      });
      resumed.push(name);
    }
    return resumed;
  }

  /** Fecha todos os sockets sem apagar credenciais (shutdown do processo). */
  async shutdown(): Promise<void> {
    for (const s of this.sessions.values()) {
      s.stopping = true;
      this.clearReconnect(s);
      try {
        s.sock?.end(undefined);
      } catch {
        /* ignore */
      }
      s.sock = undefined;
    }
  }

  // ---------- internos ----------

  private authDir(accountId: string): string {
    return path.join(this.opts.dataDir, accountId);
  }

  private async removeAuthDir(accountId: string): Promise<void> {
    await fs.rm(this.authDir(accountId), { recursive: true, force: true });
  }

  private clearReconnect(s: Session): void {
    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = undefined;
    }
  }

  private async getVersion(): Promise<WAVersion | undefined> {
    if (!this.versionPromise) {
      this.versionPromise = fetchLatestBaileysVersion()
        .then((v) => v.version)
        .catch((err) => {
          this.log.warn({ err: (err as Error).message }, "fetchLatestBaileysVersion falhou; usando versão padrão");
          return undefined;
        });
    }
    return this.versionPromise;
  }

  private setStatus(
    s: Session,
    status: SessionStatus,
    patch: Partial<Pick<Session, "phone" | "name" | "connectedAt" | "qr" | "lastError">> = {},
  ): void {
    s.status = status;
    Object.assign(s, patch);
    if (status !== "qr") s.qr = undefined;
  }

  /** Enfileira o evento de status. Não bloqueia: a fila do app-client faz retry sozinha. */
  private emitStatus(s: Session): void {
    const payload = {
      account_id: s.accountId,
      status: s.status,
      ...(s.phone ? { phone: s.phone } : {}),
      ...(s.name ? { name: s.name } : {}),
      ...(s.lastError ? { error: s.lastError } : {}),
    };
    this.log.info({ accountId: s.accountId, status: s.status, error: s.lastError }, "status da sessão");
    void this.opts.appClient.sendStatus(payload);
  }

  private async startSocket(s: Session): Promise<void> {
    s.starting = true;
    try {
      const accountId = s.accountId;
      const dir = this.authDir(accountId);
      await fs.mkdir(dir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(dir);
      const version = await this.getVersion();

      this.setStatus(s, "connecting", { lastError: undefined });
      this.emitStatus(s);

      const sock = makeWASocket({
        auth: state,
        ...(version ? { version } : {}),
        logger: this.log.child({ accountId, lib: "baileys" }),
        browser: Browsers.ubuntu("SempreCRM"),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
      });
      s.sock = sock;

      sock.ev.on("creds.update", saveCreds);
      sock.ev.on("connection.update", (update) => {
        void this.onConnectionUpdate(s, sock, update);
      });
      sock.ev.on("messages.upsert", ({ messages, type }) => {
        if (type !== "notify") return;
        for (const msg of messages) void this.onInbound(s, sock, msg);
      });
      sock.ev.on("messages.update", (updates) => {
        void this.onMessagesUpdate(s, updates);
      });
    } catch (err) {
      this.setStatus(s, "disconnected", { lastError: (err as Error).message });
      this.emitStatus(s);
      throw err;
    } finally {
      s.starting = false;
    }
  }

  private async onConnectionUpdate(s: Session, sock: WASocket, update: Partial<ConnectionState>): Promise<void> {
    if (s.sock !== sock) return; // socket antigo (reconectado ou logout)

    if (update.qr) {
      try {
        const dataUrl = await QRCode.toDataURL(update.qr, { margin: 1, width: 320 });
        s.status = "qr";
        s.qr = dataUrl;
        s.lastError = undefined;
        this.emitStatus(s);
      } catch (err) {
        this.log.error({ accountId: s.accountId, err: (err as Error).message }, "falha ao gerar QR");
      }
    }

    if (update.connection === "connecting" && s.status === "disconnected") {
      this.setStatus(s, "connecting", { lastError: undefined });
      this.emitStatus(s);
    }

    if (update.connection === "open") {
      s.reconnectAttempts = 0;
      this.setStatus(s, "connected", {
        phone: userPhone(sock.user),
        name: userName(sock.user),
        connectedAt: new Date().toISOString(),
        lastError: undefined,
      });
      this.emitStatus(s);
    }

    if (update.connection === "close") {
      const code = disconnectCode(update);
      const reason = update.lastDisconnect?.error?.message ?? `código ${code ?? "?"}`;
      s.sock = undefined;
      try {
        sock.ev.removeAllListeners("connection.update");
        sock.ev.removeAllListeners("messages.upsert");
        sock.ev.removeAllListeners("messages.update");
      } catch {
        /* ignore */
      }

      if (code === DisconnectReason.loggedOut) {
        this.log.warn({ accountId: s.accountId }, "sessão deslogada pelo WhatsApp; apagando credenciais");
        await this.removeAuthDir(s.accountId);
        this.setStatus(s, "disconnected", {
          phone: undefined,
          name: undefined,
          connectedAt: undefined,
          lastError: "logged_out",
        });
        this.emitStatus(s);
        this.sessions.delete(s.accountId);
        return;
      }

      if (s.stopping) {
        this.setStatus(s, "disconnected", { lastError: undefined });
        return;
      }

      this.setStatus(s, "disconnected", { lastError: reason });
      this.emitStatus(s);
      this.scheduleReconnect(s, code);
    }
  }

  private scheduleReconnect(s: Session, code: number | undefined): void {
    this.clearReconnect(s);
    // 515 (restartRequired) é o fluxo normal logo após parear: reconecta na hora.
    const immediate = code === DisconnectReason.restartRequired;
    s.reconnectAttempts += 1;
    const delay = immediate
      ? 0
      : Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** Math.min(6, s.reconnectAttempts - 1));
    this.log.info({ accountId: s.accountId, delayMs: delay, attempt: s.reconnectAttempts }, "reconectando");
    s.reconnectTimer = setTimeout(() => {
      s.reconnectTimer = undefined;
      if (s.stopping) return;
      this.startSocket(s).catch((err) => {
        this.log.error({ accountId: s.accountId, err: (err as Error).message }, "reconexão falhou");
        this.scheduleReconnect(s, undefined);
      });
    }, delay);
    s.reconnectTimer.unref?.();
  }

  private async onInbound(s: Session, sock: WASocket, msg: WAMessage): Promise<void> {
    const accountId = s.accountId;
    try {
      let resolvedPn: string | undefined;
      const jid = msg.key.remoteJid ?? "";
      if (jid.endsWith("@lid") && !msg.key.remoteJidAlt) {
        try {
          resolvedPn = (await sock.signalRepository.lidMapping.getPNForLID(jid)) ?? undefined;
        } catch {
          resolvedPn = undefined;
        }
      }
      const mapped = mapInboundMessage(accountId, msg, { resolvedPn });
      if (mapped.kind === "skip") {
        this.log.debug({ accountId, reason: mapped.reason, jid, id: msg.key.id }, "mensagem ignorada");
        return;
      }
      const { payload, media } = mapped;
      if (media) {
        try {
          const stored = await this.opts.mediaStore.storeInbound(accountId, msg, sock, media);
          payload.media = { url: stored.url, mimetype: media.mimetype, ...(media.filename ? { filename: media.filename } : {}) };
        } catch (err) {
          this.log.error({ accountId, id: msg.key.id, err: (err as Error).message }, "falha ao armazenar mídia");
          // entrega o texto/legenda mesmo sem a mídia para não perder a mensagem
          payload.text = payload.text ?? `[${payload.type} não disponível]`;
        }
      }
      await this.opts.appClient.sendInbound(payload);
    } catch (err) {
      this.log.error({ accountId, id: msg.key.id, err: (err as Error).message }, "falha ao processar mensagem recebida");
    }
  }

  private async onMessagesUpdate(s: Session, updates: WAMessageUpdate[]): Promise<void> {
    for (const { key, update } of updates) {
      if (!key.fromMe || !key.id) continue;
      const ack = ackFromStatus(update.status);
      if (!ack) continue;
      await this.opts.appClient.sendAck({ account_id: s.accountId, message_id: key.id, status: ack });
    }
  }

  private async resolveJid(sock: WASocket, jid: string): Promise<string | undefined> {
    try {
      const results = await sock.onWhatsApp(jid);
      const hit = results?.find((r) => r.exists);
      return hit?.jid;
    } catch (err) {
      this.log.warn({ jid, err: (err as Error).message }, "onWhatsApp falhou");
      return undefined;
    }
  }
}

export function buildContent(req: SendRequest): AnyMessageContent {
  if (req.media) {
    const { url, mimetype, filename, caption, ptt } = req.media;
    const kind = mimetype.split("/")[0];
    const text = caption ?? req.text;
    if (kind === "image") {
      return { image: { url }, mimetype, ...(text ? { caption: text } : {}) };
    }
    if (kind === "video") {
      return { video: { url }, mimetype, ...(text ? { caption: text } : {}) };
    }
    if (kind === "audio") {
      return { audio: { url }, mimetype, ptt: ptt ?? false };
    }
    return {
      document: { url },
      mimetype,
      fileName: filename ?? "arquivo",
      ...(text ? { caption: text } : {}),
    };
  }
  return { text: req.text ?? "" };
}
