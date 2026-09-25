import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Boom } from "@hapi/boom";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sockets: FakeSock[] = [];
  class FakeSock {
    ev = new EventEmitter();
    user: { id: string; name?: string; notify?: string; phoneNumber?: string } | undefined;
    sendMessage = vi.fn(async (_jid: string, _content: unknown) => ({ key: { id: "SENT1", fromMe: true } }));
    onWhatsApp = vi.fn(async (..._n: string[]) => [] as { jid: string; exists: boolean }[]);
    logout = vi.fn(async () => undefined);
    end = vi.fn();
    updateMediaMessage = vi.fn();
    readMessages = vi.fn(async (_keys: unknown[]) => undefined);
    signalRepository = { lidMapping: { getPNForLID: vi.fn(async () => null as string | null) } };
    emit(event: string, payload: unknown) {
      this.ev.emit(event, payload);
    }
  }
  const makeWASocket = vi.fn(() => {
    const s = new FakeSock();
    sockets.push(s);
    return s;
  });
  const saveCreds = vi.fn(async () => undefined);
  const useMultiFileAuthState = vi.fn(async (_dir: string) => ({ state: { creds: {}, keys: {} }, saveCreds }));
  const fetchLatestBaileysVersion = vi.fn(async () => ({ version: [2, 3000, 0], isLatest: true }));
  return { sockets, FakeSock, makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, saveCreds };
});

vi.mock("@whiskeysockets/baileys", () => ({
  default: mocks.makeWASocket,
  makeWASocket: mocks.makeWASocket,
  useMultiFileAuthState: mocks.useMultiFileAuthState,
  fetchLatestBaileysVersion: mocks.fetchLatestBaileysVersion,
  Browsers: { ubuntu: (n: string) => ["Ubuntu", n, "1.0"] },
  DisconnectReason: {
    connectionClosed: 428,
    connectionLost: 408,
    connectionReplaced: 440,
    loggedOut: 401,
    badSession: 500,
    restartRequired: 515,
    timedOut: 408,
  },
  downloadMediaMessage: vi.fn(),
}));

import { SessionManager, GatewayError, ackFromStatus, buildContent, toJid } from "./session-manager.js";

const logger = pino({ level: "silent" });
const ACCOUNT = "11111111-2222-3333-4444-555555555555";

const flush = () => new Promise((r) => setTimeout(r, 0));
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout esperando condição");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeManager(dataDir: string, extra: { sendWaitMs?: number; markOnline?: boolean } = {}) {
  const appClient = {
    sendInbound: vi.fn(async () => true),
    sendStatus: vi.fn(async () => true),
    sendAck: vi.fn(async () => true),
  };
  const mediaStore = {
    storeInbound: vi.fn(async () => ({ url: "https://cdn.local/chat-media/x.jpg", path: "x.jpg" })),
  };
  const manager = new SessionManager({
    dataDir,
    appClient,
    mediaStore,
    logger,
    reconnectBaseMs: 5,
    reconnectMaxMs: 20,
    sendWaitMs: 300,
    ...extra,
  });
  return { manager, appClient, mediaStore };
}

let dataDir: string;
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-gw-test-"));
  mocks.sockets.length = 0;
  mocks.makeWASocket.mockClear();
  mocks.useMultiFileAuthState.mockClear();
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("SessionManager — presença (recibos de entrega)", () => {
  it("conecta online por padrão, para o Baileys mandar recibo de entrega (✓✓)", async () => {
    const { manager } = makeManager(dataDir);
    await manager.connect(ACCOUNT);
    expect(mocks.makeWASocket.mock.calls[0][0]).toMatchObject({ markOnlineOnConnect: true });
  });

  it("respeita markOnline=false (prioriza as notificações do celular)", async () => {
    const { manager } = makeManager(dataDir, { markOnline: false });
    await manager.connect(ACCOUNT);
    expect(mocks.makeWASocket.mock.calls[0][0]).toMatchObject({ markOnlineOnConnect: false });
  });
});

describe("SessionManager — máquina de estados", () => {
  it("status inicial de conta desconhecida é disconnected", () => {
    const { manager } = makeManager(dataDir);
    expect(manager.getStatus("nope")).toEqual({ status: "disconnected" });
  });

  it("connect → connecting → qr (data URL) → connected com telefone e nome", async () => {
    const { manager, appClient } = makeManager(dataDir);
    const st = await manager.connect(ACCOUNT);
    expect(st.status).toBe("connecting");
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(1);
    expect(mocks.useMultiFileAuthState).toHaveBeenCalledWith(path.join(dataDir, ACCOUNT));
    await flush();
    expect(appClient.sendStatus).toHaveBeenCalledWith({ account_id: ACCOUNT, status: "connecting" });

    const sock = mocks.sockets[0];
    sock.emit("connection.update", { qr: "1@abc,def,ghi" });
    await until(() => manager.getStatus(ACCOUNT).status === "qr");
    const qrState = manager.getStatus(ACCOUNT);
    expect(qrState.qr).toMatch(/^data:image\/png;base64,/);
    expect(appClient.sendStatus).toHaveBeenCalledWith({ account_id: ACCOUNT, status: "qr" });

    // connect de novo enquanto ativa é idempotente (não abre outro socket)
    const again = await manager.connect(ACCOUNT);
    expect(again.status).toBe("qr");
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(1);

    sock.user = { id: "5511999999999:7@s.whatsapp.net", name: "Loja Sempre" };
    sock.emit("connection.update", { connection: "open" });
    await until(() => manager.getStatus(ACCOUNT).status === "connected");
    const connected = manager.getStatus(ACCOUNT);
    expect(connected.phone).toBe("5511999999999");
    expect(connected.name).toBe("Loja Sempre");
    expect(connected.qr).toBeUndefined();
    expect(connected.connected_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(appClient.sendStatus).toHaveBeenLastCalledWith({
      account_id: ACCOUNT,
      status: "connected",
      phone: "5511999999999",
      name: "Loja Sempre",
    });
  });

  it("prefere user.phoneNumber quando user.id é LID", async () => {
    const { manager } = makeManager(dataDir);
    await manager.connect(ACCOUNT);
    const sock = mocks.sockets[0];
    sock.user = { id: "987654321@lid", phoneNumber: "5521988887777@s.whatsapp.net", notify: "Fulano" };
    sock.emit("connection.update", { connection: "open" });
    await until(() => manager.getStatus(ACCOUNT).status === "connected");
    expect(manager.getStatus(ACCOUNT)).toMatchObject({ phone: "5521988887777", name: "Fulano" });
  });

  it("queda de rede → disconnected com erro e reconexão automática", async () => {
    const { manager, appClient } = makeManager(dataDir);
    await manager.connect(ACCOUNT);
    const first = mocks.sockets[0];
    first.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: new Boom("Connection Terminated", { statusCode: 428 }), date: new Date() },
    });
    await until(() => appClient.sendStatus.mock.calls.some((c) => (c[0] as { status: string }).status === "disconnected"));
    expect(appClient.sendStatus).toHaveBeenCalledWith({
      account_id: ACCOUNT,
      status: "disconnected",
      error: "Connection Terminated",
    });
    await until(() => mocks.makeWASocket.mock.calls.length === 2);
    await until(() => manager.getStatus(ACCOUNT).status === "connecting");
    // credenciais preservadas
    await expect(fs.stat(path.join(dataDir, ACCOUNT))).resolves.toBeTruthy();
  });

  it("restartRequired (515) reconecta imediatamente", async () => {
    const { manager } = makeManager(dataDir);
    await manager.connect(ACCOUNT);
    mocks.sockets[0].emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: new Boom("restart", { statusCode: 515 }), date: new Date() },
    });
    await until(() => mocks.makeWASocket.mock.calls.length === 2, 500);
  });

  it("loggedOut → apaga credenciais, disconnected com error logged_out e NÃO reconecta", async () => {
    const { manager, appClient } = makeManager(dataDir);
    await manager.connect(ACCOUNT);
    await fs.writeFile(path.join(dataDir, ACCOUNT, "creds.json"), "{}");
    mocks.sockets[0].emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: new Boom("logged out", { statusCode: 401 }), date: new Date() },
    });
    await until(() => appClient.sendStatus.mock.calls.some((c) => (c[0] as { error?: string }).error === "logged_out"));
    expect(appClient.sendStatus).toHaveBeenLastCalledWith({
      account_id: ACCOUNT,
      status: "disconnected",
      error: "logged_out",
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(1);
    await expect(fs.stat(path.join(dataDir, ACCOUNT))).rejects.toThrow();
    expect(manager.getStatus(ACCOUNT)).toEqual({ status: "disconnected" });
  });

  it("logout encerra, apaga o diretório e emite disconnected", async () => {
    const { manager, appClient } = makeManager(dataDir);
    await manager.connect(ACCOUNT);
    await fs.writeFile(path.join(dataDir, ACCOUNT, "creds.json"), "{}");
    const sock = mocks.sockets[0];
    const st = await manager.logout(ACCOUNT);
    expect(st).toEqual({ status: "disconnected" });
    expect(sock.logout).toHaveBeenCalled();
    await expect(fs.stat(path.join(dataDir, ACCOUNT))).rejects.toThrow();
    expect(appClient.sendStatus).toHaveBeenLastCalledWith({ account_id: ACCOUNT, status: "disconnected" });
    // o close disparado pelo logout não reconecta
    sock.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: new Boom("x", { statusCode: 401 }), date: new Date() },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(1);
    expect(manager.listAccountIds()).toEqual([]);
  });

  it("resumeAll reconecta contas com creds.json em disco", async () => {
    await fs.mkdir(path.join(dataDir, "acc-a"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "acc-a", "creds.json"), "{}");
    await fs.mkdir(path.join(dataDir, "acc-empty"), { recursive: true });
    const { manager } = makeManager(dataDir);
    const resumed = await manager.resumeAll();
    expect(resumed).toEqual(["acc-a"]);
    await until(() => mocks.makeWASocket.mock.calls.length === 1);
  });
});

describe("SessionManager — mensagens", () => {
  async function connected() {
    const ctx = makeManager(dataDir);
    await ctx.manager.connect(ACCOUNT);
    const sock = mocks.sockets[0];
    sock.user = { id: "5511999999999@s.whatsapp.net", name: "Eu" };
    sock.emit("connection.update", { connection: "open" });
    await until(() => ctx.manager.getStatus(ACCOUNT).status === "connected");
    return { ...ctx, sock };
  }

  it("messages.upsert notify → POST inbound com payload mapeado", async () => {
    const { appClient, sock } = await connected();
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: "5511988887777@s.whatsapp.net", fromMe: false, id: "MSG1" },
          pushName: "Cliente",
          messageTimestamp: 1_757_700_100,
          message: { conversation: "Bom dia" },
        },
      ],
    });
    await until(() => appClient.sendInbound.mock.calls.length === 1);
    expect(appClient.sendInbound).toHaveBeenCalledWith({
      account_id: ACCOUNT,
      message_id: "MSG1",
      from: "5511988887777",
      push_name: "Cliente",
      timestamp: 1_757_700_100,
      type: "text",
      text: "Bom dia",
    });
  });

  it("confirmação de leitura usa a chave original da mensagem recebida (inclusive @lid)", async () => {
    const { manager, appClient, sock } = await connected();
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: "123456789@lid", remoteJidAlt: "5511988887777@s.whatsapp.net", fromMe: false, id: "LID1" },
          messageTimestamp: 1,
          message: { conversation: "oi" },
        },
      ],
    });
    await until(() => appClient.sendInbound.mock.calls.length === 1);

    const res = await manager.markRead(ACCOUNT, { to: "5511988887777", message_ids: ["LID1", "OLD9", "LID1"] });

    expect(res).toEqual({ read: 2 });
    expect(sock.readMessages).toHaveBeenCalledWith([
      { remoteJid: "123456789@lid", id: "LID1", fromMe: false },
      // desconhecido (ex.: gateway reiniciado): cai no jid do telefone
      { remoteJid: "5511988887777@s.whatsapp.net", id: "OLD9", fromMe: false },
    ]);
  });

  it("confirmação de leitura com a sessão desconectada responde 409", async () => {
    const { manager } = makeManager(dataDir);
    await expect(manager.markRead(ACCOUNT, { to: "5511988887777", message_ids: ["X"] })).rejects.toMatchObject({
      code: "not_connected",
      httpStatus: 409,
    });
  });

  it("mídia é baixada/subida e a URL pública vai no payload", async () => {
    const { appClient, mediaStore, sock } = await connected();
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: "5511988887777@s.whatsapp.net", fromMe: false, id: "IMG1" },
          pushName: "Cliente",
          messageTimestamp: 1,
          message: { imageMessage: { mimetype: "image/jpeg", caption: "foto" } },
        },
      ],
    });
    await until(() => appClient.sendInbound.mock.calls.length === 1);
    expect(mediaStore.storeInbound).toHaveBeenCalledTimes(1);
    expect(appClient.sendInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "image",
        text: "foto",
        media: { url: "https://cdn.local/chat-media/x.jpg", mimetype: "image/jpeg", filename: "image.jpg" },
      }),
    );
  });

  it("ignora append, fromMe e grupos", async () => {
    const { appClient, sock } = await connected();
    sock.emit("messages.upsert", {
      type: "append",
      messages: [{ key: { remoteJid: "5511@s.whatsapp.net", fromMe: false, id: "A" }, message: { conversation: "h" } }],
    });
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [
        { key: { remoteJid: "5511@s.whatsapp.net", fromMe: true, id: "B" }, message: { conversation: "eu" } },
        { key: { remoteJid: "1-2@g.us", fromMe: false, id: "C" }, message: { conversation: "grupo" } },
      ],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(appClient.sendInbound).not.toHaveBeenCalled();
  });

  it("resolve LID via signalRepository quando não há remoteJidAlt", async () => {
    const { appClient, sock } = await connected();
    sock.signalRepository.lidMapping.getPNForLID.mockResolvedValueOnce("5511900001111@s.whatsapp.net");
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [{ key: { remoteJid: "42@lid", fromMe: false, id: "L1" }, message: { conversation: "oi" } }],
    });
    await until(() => appClient.sendInbound.mock.calls.length === 1);
    expect(appClient.sendInbound).toHaveBeenCalledWith(expect.objectContaining({ from: "5511900001111" }));
  });

  it("messages.update com status das nossas mensagens → ack", async () => {
    const { appClient, sock } = await connected();
    sock.emit("messages.update", [
      { key: { remoteJid: "5511@s.whatsapp.net", fromMe: true, id: "S1" }, update: { status: 2 } },
      { key: { remoteJid: "5511@s.whatsapp.net", fromMe: true, id: "S1" }, update: { status: 3 } },
      { key: { remoteJid: "5511@s.whatsapp.net", fromMe: true, id: "S1" }, update: { status: 4 } },
      { key: { remoteJid: "5511@s.whatsapp.net", fromMe: false, id: "S2" }, update: { status: 4 } },
      { key: { remoteJid: "5511@s.whatsapp.net", fromMe: true, id: "S3" }, update: { pollUpdates: [] } },
    ]);
    await until(() => appClient.sendAck.mock.calls.length === 3);
    expect(appClient.sendAck.mock.calls.map((c) => (c[0] as { status: string }).status)).toEqual([
      "sent",
      "delivered",
      "read",
    ]);
  });

  it("recibos fora de ordem: SERVER_ACK depois de DELIVERY_ACK não volta o status", async () => {
    // Cenário real (Baileys 7 rc14): o recibo de entrega do contato chega e,
    // logo depois, o recibo type="sender" do nosso próprio celular (→ status 2).
    const { appClient, sock } = await connected();
    const key = { remoteJid: "126809077219420@lid", fromMe: true, id: "3EB0B4591546A5E6D285BB" };
    sock.emit("messages.update", [{ key, update: { status: 3, messageTimestamp: 1789261316 } }]);
    sock.emit("messages.update", [{ key, update: { status: 2, messageTimestamp: 1789261316 } }]);
    sock.emit("messages.update", [{ key, update: { status: 3, messageTimestamp: 1789261320 } }]); // duplicado
    sock.emit("messages.update", [{ key, update: { status: 4, messageTimestamp: 1789261330 } }]);
    sock.emit("messages.update", [{ key, update: { status: 5, messageTimestamp: 1789261331 } }]); // PLAYED = read de novo
    await until(() => appClient.sendAck.mock.calls.length === 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(appClient.sendAck.mock.calls.map((c) => c[0])).toEqual([
      { account_id: ACCOUNT, message_id: "3EB0B4591546A5E6D285BB", status: "delivered" },
      { account_id: ACCOUNT, message_id: "3EB0B4591546A5E6D285BB", status: "read" },
    ]);
  });

  it("dedupe de recibos é por message_id (outra mensagem começa do zero)", async () => {
    const { appClient, sock } = await connected();
    sock.emit("messages.update", [
      { key: { remoteJid: "1@lid", fromMe: true, id: "A" }, update: { status: 4 } },
      { key: { remoteJid: "1@lid", fromMe: true, id: "B" }, update: { status: 2 } },
    ]);
    await until(() => appClient.sendAck.mock.calls.length === 2);
    expect(appClient.sendAck.mock.calls.map((c) => (c[0] as { message_id: string; status: string }).status)).toEqual([
      "read",
      "sent",
    ]);
  });

  it("ackFromStatus mapeia o enum do proto", () => {
    expect(ackFromStatus(2)).toBe("sent");
    expect(ackFromStatus(3)).toBe("delivered");
    expect(ackFromStatus(4)).toBe("read");
    expect(ackFromStatus(5)).toBe("read");
    expect(ackFromStatus(1)).toBeNull();
    expect(ackFromStatus(undefined)).toBeNull();
  });
});

describe("SessionManager — envio", () => {
  async function connected() {
    const ctx = makeManager(dataDir);
    await ctx.manager.connect(ACCOUNT);
    const sock = mocks.sockets[0];
    sock.user = { id: "5511999999999@s.whatsapp.net" };
    sock.emit("connection.update", { connection: "open" });
    await until(() => ctx.manager.getStatus(ACCOUNT).status === "connected");
    return { ...ctx, sock };
  }

  it("recusa envio sem sessão conectada (409)", async () => {
    const { manager } = makeManager(dataDir);
    await expect(manager.send(ACCOUNT, { to: "5511999999999", text: "oi" })).rejects.toMatchObject({
      code: "not_connected",
      httpStatus: 409,
    });
  });

  it("texto: sendMessage(jid, { text }) e devolve message_id", async () => {
    const { manager, sock } = await connected();
    const res = await manager.send(ACCOUNT, { to: "+55 (11) 98888-7777", text: "olá" });
    expect(res).toEqual({ message_id: "SENT1" });
    expect(sock.sendMessage).toHaveBeenCalledWith("5511988887777@s.whatsapp.net", { text: "olá" });
  });

  it("mídia: monta image/video/audio/document", () => {
    expect(buildContent({ to: "1", media: { url: "u", mimetype: "image/png", caption: "c" } })).toEqual({
      image: { url: "u" },
      mimetype: "image/png",
      caption: "c",
    });
    expect(buildContent({ to: "1", media: { url: "u", mimetype: "video/mp4" } })).toEqual({
      video: { url: "u" },
      mimetype: "video/mp4",
    });
    expect(buildContent({ to: "1", media: { url: "u", mimetype: "audio/ogg", ptt: true } })).toEqual({
      audio: { url: "u" },
      mimetype: "audio/ogg",
      ptt: true,
    });
    expect(
      buildContent({ to: "1", media: { url: "u", mimetype: "application/pdf", filename: "a.pdf" }, text: "seg" }),
    ).toEqual({ document: { url: "u" }, mimetype: "application/pdf", fileName: "a.pdf", caption: "seg" });
  });

  it("not-on-whatsapp: resolve via onWhatsApp e reenvia com o jid certo", async () => {
    const { manager, sock } = await connected();
    sock.sendMessage.mockRejectedValueOnce(new Boom("not-on-whatsapp", { statusCode: 404 }));
    sock.onWhatsApp.mockResolvedValueOnce([{ jid: "551188887777@s.whatsapp.net", exists: true }]);
    const res = await manager.send(ACCOUNT, { to: "5511988887777", text: "oi" });
    expect(res.message_id).toBe("SENT1");
    expect(sock.onWhatsApp).toHaveBeenCalledWith("5511988887777@s.whatsapp.net");
    expect(sock.sendMessage).toHaveBeenLastCalledWith("551188887777@s.whatsapp.net", { text: "oi" });
  });

  it("número inexistente → 422 not_on_whatsapp", async () => {
    const { manager, sock } = await connected();
    sock.sendMessage.mockRejectedValueOnce(new Error("item-not-found"));
    sock.onWhatsApp.mockResolvedValueOnce([]);
    await expect(manager.send(ACCOUNT, { to: "5511988887777", text: "oi" })).rejects.toMatchObject({
      code: "not_on_whatsapp",
      httpStatus: 422,
    });
  });

  it("outros erros → 502 send_failed; número inválido → 400", async () => {
    const { manager, sock } = await connected();
    sock.sendMessage.mockRejectedValueOnce(new Error("timeout"));
    await expect(manager.send(ACCOUNT, { to: "5511988887777", text: "oi" })).rejects.toBeInstanceOf(GatewayError);
    expect(() => toJid("12")).toThrow(GatewayError);
  });

  it("jid resolvido via onWhatsApp fica em cache: o próximo envio não consulta de novo", async () => {
    const { manager, sock } = await connected();
    sock.sendMessage.mockRejectedValueOnce(new Boom("not-on-whatsapp", { statusCode: 404 }));
    sock.onWhatsApp.mockResolvedValueOnce([{ jid: "551188887777@s.whatsapp.net", exists: true }]);
    await manager.send(ACCOUNT, { to: "5511988887777", text: "oi" });
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(1);

    await manager.send(ACCOUNT, { to: "5511988887777", text: "de novo" });
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(1);
    expect(sock.sendMessage).toHaveBeenLastCalledWith("551188887777@s.whatsapp.net", { text: "de novo" });
    // envio normal nunca chama onWhatsApp antes do sendMessage
    await manager.send(ACCOUNT, { to: "5511977776666", text: "x" });
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(1);
    expect(sock.sendMessage).toHaveBeenLastCalledWith("5511977776666@s.whatsapp.net", { text: "x" });
  });

  async function dropConnection(sock: InstanceType<typeof mocks.FakeSock>) {
    sock.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: new Boom("Connection was lost", { statusCode: 408 }), date: new Date() },
    });
    await until(() => mocks.makeWASocket.mock.calls.length === 2);
    return mocks.sockets[1];
  }

  it("send durante reconexão espera a sessão voltar e usa o socket NOVO", async () => {
    const { manager, sock } = await connected();
    const sock2 = await dropConnection(sock);
    expect(manager.getStatus(ACCOUNT).status).toBe("connecting");

    const pending = manager.send(ACCOUNT, { to: "5511988887777", text: "oi" });
    await new Promise((r) => setTimeout(r, 30));
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(sock2.sendMessage).not.toHaveBeenCalled();

    sock2.user = { id: "5511999999999@s.whatsapp.net" };
    sock2.sendMessage.mockResolvedValueOnce({ key: { id: "SENT2", fromMe: true } });
    sock2.emit("connection.update", { connection: "open" });
    await expect(pending).resolves.toEqual({ message_id: "SENT2" });
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(sock2.sendMessage).toHaveBeenCalledWith("5511988887777@s.whatsapp.net", { text: "oi" });
  });

  it("send enquanto a reconexão está só agendada (disconnected + timer) também espera", async () => {
    const { manager, sock } = await connected();
    sock.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: new Boom("Connection was lost", { statusCode: 408 }), date: new Date() },
    });
    // logo após o close: status disconnected, reconexão agendada (5 ms)
    expect(manager.getStatus(ACCOUNT).status).toBe("disconnected");
    const pending = manager.send(ACCOUNT, { to: "5511988887777", text: "oi" });
    await until(() => mocks.makeWASocket.mock.calls.length === 2);
    const sock2 = mocks.sockets[1];
    sock2.user = { id: "5511999999999@s.whatsapp.net" };
    sock2.emit("connection.update", { connection: "open" });
    await expect(pending).resolves.toEqual({ message_id: "SENT1" });
    expect(sock2.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("send: sendMessage falha porque o socket caiu → tenta UMA vez após reconectar", async () => {
    const { manager, sock } = await connected();
    sock.sendMessage.mockImplementationOnce(async () => {
      // o socket morre no meio do envio (o que o Baileys devolve nesse caso)
      sock.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: new Boom("Connection was lost", { statusCode: 408 }), date: new Date() },
      });
      throw new TypeError("Cannot read properties of undefined (reading 'attrs')");
    });
    const pending = manager.send(ACCOUNT, { to: "5511988887777", media: { url: "https://x/a.jpg", mimetype: "image/jpeg" } });
    await until(() => mocks.makeWASocket.mock.calls.length === 2);
    const sock2 = mocks.sockets[1];
    sock2.user = { id: "5511999999999@s.whatsapp.net" };
    sock2.sendMessage.mockResolvedValueOnce({ key: { id: "RETRY1", fromMe: true } });
    sock2.emit("connection.update", { connection: "open" });
    await expect(pending).resolves.toEqual({ message_id: "RETRY1" });
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    expect(sock2.sendMessage).toHaveBeenCalledTimes(1);
    expect(sock2.sendMessage).toHaveBeenCalledWith("5511988887777@s.whatsapp.net", {
      image: { url: "https://x/a.jpg" },
      mimetype: "image/jpeg",
    });
  });

  it("send: se a segunda tentativa também falha → 502 (não tenta uma terceira)", async () => {
    const { manager, sock } = await connected();
    sock.sendMessage.mockImplementationOnce(async () => {
      sock.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: new Boom("Connection was lost", { statusCode: 408 }), date: new Date() },
      });
      throw new Error("Connection Closed");
    });
    const pending = manager.send(ACCOUNT, { to: "5511988887777", text: "oi" });
    await until(() => mocks.makeWASocket.mock.calls.length === 2);
    const sock2 = mocks.sockets[1];
    sock2.sendMessage.mockRejectedValueOnce(new Error("still broken"));
    sock2.emit("connection.update", { connection: "open" });
    await expect(pending).rejects.toMatchObject({ code: "send_failed", httpStatus: 502 });
    expect(sock2.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("send: reconexão não volta dentro de sendWaitMs → 409 not_connected", async () => {
    const ctx = makeManager(dataDir, { sendWaitMs: 40 });
    await ctx.manager.connect(ACCOUNT);
    const sock = mocks.sockets[0];
    sock.user = { id: "5511999999999@s.whatsapp.net" };
    sock.emit("connection.update", { connection: "open" });
    await until(() => ctx.manager.getStatus(ACCOUNT).status === "connected");
    await dropConnection(sock);
    const started = Date.now();
    await expect(ctx.manager.send(ACCOUNT, { to: "5511988887777", text: "oi" })).rejects.toMatchObject({
      code: "not_connected",
      httpStatus: 409,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });

  it("send após loggedOut (sem reconexão pendente) → 409 imediato", async () => {
    const { manager, sock } = await connected();
    sock.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: new Boom("logged out", { statusCode: 401 }), date: new Date() },
    });
    await until(() => manager.listAccountIds().length === 0);
    const started = Date.now();
    await expect(manager.send(ACCOUNT, { to: "5511988887777", text: "oi" })).rejects.toMatchObject({
      code: "not_connected",
      httpStatus: 409,
    });
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("send com sessão em status qr (nunca pareou) → 409 imediato, sem esperar", async () => {
    const { manager } = makeManager(dataDir);
    await manager.connect(ACCOUNT);
    mocks.sockets[0].emit("connection.update", { qr: "1@abc,def" });
    await until(() => manager.getStatus(ACCOUNT).status === "qr");
    const started = Date.now();
    await expect(manager.send(ACCOUNT, { to: "5511988887777", text: "oi" })).rejects.toMatchObject({
      code: "not_connected",
      httpStatus: 409,
    });
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("send em sessão parada por logout não espera", async () => {
    const { manager } = await connected();
    await manager.logout(ACCOUNT);
    await expect(manager.send(ACCOUNT, { to: "5511988887777", text: "oi" })).rejects.toMatchObject({
      code: "not_connected",
    });
  });
});
