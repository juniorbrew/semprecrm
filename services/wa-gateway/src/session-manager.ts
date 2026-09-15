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
  /** maior status já repassado ao app por message_id (recibos só andam para frente) */
  ackRank: Map<string, number>;
  /** jid discado → jid resolvido via onWhatsApp (evita consultar a cada envio) */
  jidCache: Map<string, string>;
  /** `send()` aguardando a sessão voltar a `connected` */
  connectWaiters: Array<() => void>;
}

export interface SessionManagerOptions {
  dataDir: string;
  appClient: Pick<AppClient, "sendInbound" | "sendStatus" | "sendAck">;
  mediaStore: Pick<MediaStore, "storeInbound">;
  logger: Logger;
  /** injeção para testes */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** quanto `send()` espera a sessão reconectar antes de responder 409 (padrão 15 s) */
  sendWaitMs?: number;
}

const PN_SUFFIX = "@s.whatsapp.net";
/** quantos message_ids lembramos por sessão para deduplicar recibos */
const ACK_RANK_MAX = 2000;

/** ordem dos acks: só repassamos ao app quando o novo status é maior que o último. */
const ACK_RANK: Record<AckStatus, number> = { sent: 1, delivered: 2, read: 3 };

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

/** Erro do Baileys típico de socket que caiu no meio do envio. */
function looksLikeConnectionError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  const code = (err as { output?: { statusCode?: number } })?.output?.statusCode;
  const connectionCodes: number[] = [
    DisconnectReason.connectionClosed,
    DisconnectReason.connectionLost,
    DisconnectReason.timedOut,
  ];
  return (
    (typeof code === "number" && connectionCodes.includes(code)) ||
    /connection (was )?(closed|lost|terminated)|reading 'attrs'|socket|ws is not open|query cancelled/.test(msg)
  );
}

function newSession(accountId: string): Session {
  return {
    accountId,
    status: "disconnected",
    reconnectAttempts: 0,
    stopping: false,
    starting: false,
    ackRank: new Map(),
    jidCache: new Map(),
    connectWaiters: [],
  };
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly log: Logger;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly sendWaitMs: number;
  private versionPromise?: Promise<WAVersion | undefined>;

  constructor(private readonly opts: SessionManagerOptions) {
    this.log = opts.logger.child({ module: "session-manager" });
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 2000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 60_000;
    this.sendWaitMs = opts.sendWaitMs ?? 15_000;
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
      s = newSession(accountId);
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

  /**
   * Envia texto/mídia. Se a sessão está reconectando (`connecting`/`qr` com
   * socket, ou `disconnected` com reconexão agendada), espera até
   * `sendWaitMs` pela volta antes de responder 409. Se o socket cair no meio
   * do `sendMessage`, espera a reconexão e tenta mais uma vez — sempre com o
   * socket ATUAL da sessão, nunca com uma referência capturada antes.
   */
  async send(accountId: string, req: SendRequest): Promise<SendResponse> {
    const s = this.sessions.get(accountId);
    if (!s) {
      throw new GatewayError("sessão não conectada", "not_connected", 409);
    }
    if (!req.text && !req.media) {
      throw new GatewayError("informe text ou media", "invalid_request", 400);
    }
    const dialed = toJid(req.to);
    const content = buildContent(req);
    // jid já resolvido num envio anterior (número cujo jid difere do discado)
    let jid = s.jidCache.get(dialed) ?? dialed;

    let sock = await this.waitForConnected(s);
    let result: WAMessage | undefined;
    try {
      result = await sock.sendMessage(jid, content);
    } catch (err) {
      if (isNotOnWhatsAppError(err)) {
        // só aqui consultamos o servidor: o envio direto ao jid discado falhou
        const resolved = await this.resolveJid(s.sock ?? sock, dialed);
        if (!resolved) {
          throw new GatewayError(`número não está no WhatsApp: ${req.to}`, "not_on_whatsapp", 422);
        }
        s.jidCache.set(dialed, resolved);
        jid = resolved;
        try {
          result = await (s.sock ?? sock).sendMessage(jid, content);
        } catch (err2) {
          throw new GatewayError(`falha ao enviar: ${(err2 as Error).message}`, "send_failed", 502);
        }
      } else if (s.sock !== sock || s.status !== "connected" || looksLikeConnectionError(err)) {
        // o socket caiu (ou está caindo) durante o envio: espera reconectar e tenta uma vez
        this.log.warn(
          { accountId, jid, err: (err as Error).message, status: s.status },
          "sendMessage falhou durante reconexão; tentando de novo após reconectar",
        );
        sock = await this.waitForConnected(s);
        try {
          result = await sock.sendMessage(jid, content);
        } catch (err2) {
          this.log.error({ accountId, jid, err: (err2 as Error).message }, "sendMessage falhou na segunda tentativa");
          throw new GatewayError(`falha ao enviar: ${(err2 as Error).message}`, "send_failed", 502);
        }
      } else {
        this.log.error({ accountId, jid, err: (err as Error).message }, "sendMessage falhou");
        throw new GatewayError(`falha ao enviar: ${(err as Error).message}`, "send_failed", 502);
      }
    }
    const id = result?.key?.id;
    if (!id) throw new GatewayError("WhatsApp não devolveu id da mensagem", "send_failed", 502);
    return { message_id: id };
  }

  /**
   * Devolve o socket atual quando a sessão está `connected`. Se está no meio
   * de uma (re)conexão, espera até `sendWaitMs`. Se não há reconexão em
   * andamento nem agendada (logout, loggedOut, nunca conectou), responde 409
   * na hora.
   */
  private async waitForConnected(s: Session): Promise<WASocket> {
    if (s.status === "connected" && s.sock) return s.sock;
    // "qr" nunca é uma reconexão: o usuário ainda precisa escanear
    const reconnecting =
      !s.stopping &&
      s.status !== "qr" &&
      (s.starting || !!s.reconnectTimer || (!!s.sock && s.status !== "disconnected"));
    if (!reconnecting) {
      throw new GatewayError("sessão não conectada", "not_connected", 409);
    }
    this.log.info(
      { accountId: s.accountId, status: s.status, waitMs: this.sendWaitMs },
      "aguardando reconexão para enviar",
    );
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const idx = s.connectWaiters.indexOf(finish);
        if (idx >= 0) s.connectWaiters.splice(idx, 1);
        resolve();
      };
      const timer = setTimeout(finish, this.sendWaitMs);
      timer.unref?.();
      s.connectWaiters.push(finish);
    });
    if (s.status !== "connected" || !s.sock) {
      throw new GatewayError("sessão não conectada", "not_connected", 409);
    }
    return s.sock;
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
    if (status === "connected") this.wakeWaiters(s);
  }

  /** Libera quem espera em `waitForConnected` (conectou, ou desistimos: vai dar 409). */
  private wakeWaiters(s: Session): void {
    const waiters = s.connectWaiters.splice(0);
    for (const w of waiters) w();
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
        this.wakeWaiters(s);
        return;
      }

      if (s.stopping) {
        this.setStatus(s, "disconnected", { lastError: undefined });
        this.wakeWaiters(s);
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

  /**
   * Recibos das nossas mensagens. O Baileys (7.0.0-rc14, `handleReceipt` em
   * Socket/messages-recv) emite `messages.update` para conversas 1:1 com
   * `{ key: { remoteJid, id, fromMe: true }, update: { status, messageTimestamp } }`,
   * onde `status` é `proto.WebMessageInfo.Status` (2 SERVER_ACK, 3 DELIVERY_ACK,
   * 4 READ, 5 PLAYED). `message-receipt.update` só sai para grupos/status, que
   * ignoramos. Os recibos NÃO chegam em ordem: o `type="sender"` do nosso
   * próprio celular (→ SERVER_ACK) costuma chegar depois do de entrega, então só
   * repassamos ao app quando o status anda para frente.
   */
  private async onMessagesUpdate(s: Session, updates: WAMessageUpdate[]): Promise<void> {
    for (const { key, update } of updates) {
      this.log.debug({ accountId: s.accountId, key, update }, "messages.update recebido");
      if (!key.fromMe || !key.id) continue;
      const ack = ackFromStatus(update.status);
      if (!ack) continue;
      if (!this.advanceAck(s, key.id, ack)) {
        this.log.debug({ accountId: s.accountId, id: key.id, ack }, "recibo ignorado (não avança o status)");
        continue;
      }
      await this.opts.appClient.sendAck({ account_id: s.accountId, message_id: key.id, status: ack });
    }
  }

  /** `true` se `ack` é maior que o último repassado para esse id (e registra). */
  private advanceAck(s: Session, id: string, ack: AckStatus): boolean {
    const rank = ACK_RANK[ack];
    const prev = s.ackRank.get(id) ?? 0;
    if (rank <= prev) return false;
    if (prev) s.ackRank.delete(id); // reinsere no fim (Map preserva ordem de inserção)
    s.ackRank.set(id, rank);
    while (s.ackRank.size > ACK_RANK_MAX) {
      const oldest = s.ackRank.keys().next().value;
      if (oldest === undefined) break;
      s.ackRank.delete(oldest);
    }
    return true;
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
