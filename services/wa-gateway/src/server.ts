import { Hono } from "hono";
import { HEADER_SECRET } from "./app-client.js";
import type { Logger } from "./logger.js";
import { httpOrigin } from "./outbound-media.js";
import { GatewayError, type SessionManager } from "./session-manager.js";
import type { AvatarRequest, PresenceRequest, ReactRequest, ReadRequest, SendRequest } from "./types.js";

export interface ServerDeps {
  secret: string;
  sessions: Pick<
    SessionManager,
    "connect" | "logout" | "getStatus" | "send" | "markRead" | "fetchAvatar" | "react" | "presence" | "listAccountIds"
  > &
    Partial<Pick<SessionManager, "sendQueueStats">>;
  logger: Logger;
}

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** chat 1:1 como o Baileys endereça: telefone ou LID (grupos ficam de fora) */
const CHAT_JID_RE = /^\d{5,20}(:\d+)?@(s\.whatsapp\.net|lid)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * HTTP interno do gateway. Todo request (inclusive /health) exige
 * `x-gateway-secret`; a porta deve ficar fechada para fora da máquina.
 */
export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();
  const log = deps.logger.child({ module: "http" });

  app.use("*", async (c, next) => {
    const provided = c.req.header(HEADER_SECRET) ?? "";
    if (!provided || !timingSafeEqual(provided, deps.secret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof GatewayError) {
      return c.json({ error: err.code, message: err.message }, err.httpStatus as 400 | 409 | 422 | 429 | 502);
    }
    log.error({ err: err.message, path: c.req.path }, "erro não tratado");
    return c.json({ error: "internal", message: err.message }, 500);
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      sessions: deps.sessions.listAccountIds().length,
      uptime: Math.floor(process.uptime()),
      send_queue: deps.sessions.sendQueueStats?.(),
    }),
  );

  app.use("/sessions/:accountId/*", async (c, next) => {
    if (!ACCOUNT_ID_RE.test(c.req.param("accountId"))) {
      return c.json({ error: "invalid_request", message: "accountId inválido" }, 400);
    }
    await next();
  });
  app.use("/sessions/:accountId", async (c, next) => {
    if (!ACCOUNT_ID_RE.test(c.req.param("accountId"))) {
      return c.json({ error: "invalid_request", message: "accountId inválido" }, 400);
    }
    await next();
  });

  app.get("/sessions/:accountId", (c) => c.json(deps.sessions.getStatus(c.req.param("accountId"))));

  app.post("/sessions/:accountId/connect", async (c) => {
    const status = await deps.sessions.connect(c.req.param("accountId"));
    return c.json(status);
  });

  app.post("/sessions/:accountId/logout", async (c) => {
    const status = await deps.sessions.logout(c.req.param("accountId"));
    return c.json(status);
  });

  app.post("/sessions/:accountId/send", async (c) => {
    let body: SendRequest;
    try {
      body = (await c.req.json()) as SendRequest;
    } catch {
      throw new GatewayError("JSON inválido", "invalid_request", 400);
    }
    if (!body || typeof body.to !== "string" || !body.to.trim()) {
      throw new GatewayError("campo `to` obrigatório", "invalid_request", 400);
    }
    if (body.media && (typeof body.media.url !== "string" || typeof body.media.mimetype !== "string")) {
      throw new GatewayError("media precisa de url e mimetype", "invalid_request", 400);
    }
    // Só http(s): qualquer outra coisa o Baileys abriria como arquivo local.
    // A origem é conferida no download (outbound-media.ts).
    if (body.media && !httpOrigin(body.media.url)) {
      throw new GatewayError("media.url precisa ser http(s)", "invalid_request", 400);
    }
    if (body.priority !== undefined && body.priority !== "interactive" && body.priority !== "bulk") {
      throw new GatewayError("priority precisa ser interactive ou bulk", "invalid_request", 400);
    }
    const result = await deps.sessions.send(c.req.param("accountId"), body);
    return c.json(result);
  });

  app.post("/sessions/:accountId/read", async (c) => {
    let body: ReadRequest;
    try {
      body = (await c.req.json()) as ReadRequest;
    } catch {
      throw new GatewayError("JSON inválido", "invalid_request", 400);
    }
    if (!body || typeof body.to !== "string" || !body.to.trim()) {
      throw new GatewayError("campo `to` obrigatório", "invalid_request", 400);
    }
    if (!Array.isArray(body.message_ids) || body.message_ids.some((id) => typeof id !== "string")) {
      throw new GatewayError("message_ids precisa ser uma lista de ids", "invalid_request", 400);
    }
    const result = await deps.sessions.markRead(c.req.param("accountId"), body);
    return c.json(result);
  });

  app.post("/sessions/:accountId/avatar", async (c) => {
    let body: AvatarRequest;
    try {
      body = (await c.req.json()) as AvatarRequest;
    } catch {
      throw new GatewayError("JSON inválido", "invalid_request", 400);
    }
    if (!body || typeof body.to !== "string" || !body.to.trim()) {
      throw new GatewayError("campo `to` obrigatório", "invalid_request", 400);
    }
    if (typeof body.contact_id !== "string" || !UUID_RE.test(body.contact_id)) {
      throw new GatewayError("contact_id precisa ser um uuid", "invalid_request", 400);
    }
    const result = await deps.sessions.fetchAvatar(c.req.param("accountId"), body);
    return c.json(result);
  });

  app.post("/sessions/:accountId/react", async (c) => {
    let body: ReactRequest;
    try {
      body = (await c.req.json()) as ReactRequest;
    } catch {
      throw new GatewayError("JSON inválido", "invalid_request", 400);
    }
    if (!body || typeof body.to !== "string" || !body.to.trim()) {
      throw new GatewayError("campo `to` obrigatório", "invalid_request", 400);
    }
    if (typeof body.message_id !== "string" || !body.message_id || typeof body.from_me !== "boolean") {
      throw new GatewayError("message_id e from_me obrigatórios", "invalid_request", 400);
    }
    // um emoji (com modificadores/ZWJ) cabe folgado em 32 unidades UTF-16
    if (typeof body.emoji !== "string" || body.emoji.length > 32) {
      throw new GatewayError("emoji inválido", "invalid_request", 400);
    }
    if (body.chat_jid !== undefined && (typeof body.chat_jid !== "string" || !CHAT_JID_RE.test(body.chat_jid))) {
      throw new GatewayError("chat_jid inválido", "invalid_request", 400);
    }
    await deps.sessions.react(c.req.param("accountId"), body);
    return c.json({ ok: true });
  });

  app.post("/sessions/:accountId/presence", async (c) => {
    let body: PresenceRequest;
    try {
      body = (await c.req.json()) as PresenceRequest;
    } catch {
      throw new GatewayError("JSON inválido", "invalid_request", 400);
    }
    if (!body || typeof body.to !== "string" || !body.to.trim()) {
      throw new GatewayError("campo `to` obrigatório", "invalid_request", 400);
    }
    if (body.state !== "composing" && body.state !== "paused") {
      throw new GatewayError("state precisa ser composing ou paused", "invalid_request", 400);
    }
    await deps.sessions.presence(c.req.param("accountId"), body);
    return c.json({ ok: true });
  });

  return app;
}
