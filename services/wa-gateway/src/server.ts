import { Hono } from "hono";
import { HEADER_SECRET } from "./app-client.js";
import type { Logger } from "./logger.js";
import { GatewayError, type SessionManager } from "./session-manager.js";
import type { SendRequest } from "./types.js";

export interface ServerDeps {
  secret: string;
  sessions: Pick<SessionManager, "connect" | "logout" | "getStatus" | "send" | "listAccountIds">;
  logger: Logger;
}

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

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
      return c.json({ error: err.code, message: err.message }, err.httpStatus as 400 | 409 | 422 | 502);
    }
    log.error({ err: err.message, path: c.req.path }, "erro não tratado");
    return c.json({ error: "internal", message: err.message }, 500);
  });

  app.get("/health", (c) =>
    c.json({ ok: true, sessions: deps.sessions.listAccountIds().length, uptime: Math.floor(process.uptime()) }),
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
    const result = await deps.sessions.send(c.req.param("accountId"), body);
    return c.json(result);
  });

  return app;
}
