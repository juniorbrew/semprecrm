import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./server.js";
import { GatewayError } from "./session-manager.js";

const SECRET = "test-secret-with-length";

function makeApp() {
  const sessions = {
    connect: vi.fn(async (_id: string) => ({ status: "connecting" as const })),
    logout: vi.fn(async (_id: string) => ({ status: "disconnected" as const })),
    getStatus: vi.fn((_id: string) => ({ status: "qr" as const, qr: "data:image/png;base64,AAA" })),
    send: vi.fn(async (_id: string, _req: unknown) => ({ message_id: "M1" })),
    markRead: vi.fn(async (_id: string, _req: unknown) => ({ read: 1 })),
    listAccountIds: vi.fn(() => ["a"]),
  };
  const app = createApp({ secret: SECRET, sessions, logger: pino({ level: "silent" }) });
  return { app, sessions };
}

const auth = { "x-gateway-secret": SECRET };

describe("HTTP", () => {
  it("401 sem o header, inclusive em /health", async () => {
    const { app } = makeApp();
    expect((await app.request("/health")).status).toBe(401);
    expect((await app.request("/sessions/test")).status).toBe(401);
    expect((await app.request("/sessions/test", { headers: { "x-gateway-secret": "errado" } })).status).toBe(401);
  });

  it("GET /health com secret → 200", async () => {
    const { app } = makeApp();
    const res = await app.request("/health", { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sessions: 1 });
  });

  it("GET /sessions/:id devolve o status com qr", async () => {
    const { app, sessions } = makeApp();
    const res = await app.request("/sessions/acc-1", { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "qr", qr: "data:image/png;base64,AAA" });
    expect(sessions.getStatus).toHaveBeenCalledWith("acc-1");
  });

  it("POST connect / logout", async () => {
    const { app, sessions } = makeApp();
    const c = await app.request("/sessions/acc-1/connect", { method: "POST", headers: auth });
    expect(await c.json()).toEqual({ status: "connecting" });
    expect(sessions.connect).toHaveBeenCalledWith("acc-1");
    const l = await app.request("/sessions/acc-1/logout", { method: "POST", headers: auth });
    expect(await l.json()).toEqual({ status: "disconnected" });
  });

  it("POST send valida o corpo e propaga GatewayError como HTTP", async () => {
    const { app, sessions } = makeApp();
    const bad = await app.request("/sessions/acc-1/send", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ text: "sem to" }),
    });
    expect(bad.status).toBe(400);

    const ok = await app.request("/sessions/acc-1/send", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ to: "5511999999999", text: "oi" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ message_id: "M1" });

    sessions.send.mockRejectedValueOnce(new GatewayError("sessão não conectada", "not_connected", 409));
    const notConnected = await app.request("/sessions/acc-1/send", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ to: "5511999999999", text: "oi" }),
    });
    expect(notConnected.status).toBe(409);
    expect(await notConnected.json()).toEqual({ error: "not_connected", message: "sessão não conectada" });
  });

  it("POST read valida o corpo e repassa para markRead", async () => {
    const { app, sessions } = makeApp();
    const post = (body: unknown) =>
      app.request("/sessions/acc-1/read", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ message_ids: ["A"] })).status).toBe(400);
    expect((await post({ to: "5511999999999", message_ids: "A" })).status).toBe(400);
    expect((await post({ to: "5511999999999", message_ids: [1] })).status).toBe(400);

    const ok = await post({ to: "5511999999999", message_ids: ["A"] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ read: 1 });
    expect(sessions.markRead).toHaveBeenCalledWith("acc-1", { to: "5511999999999", message_ids: ["A"] });
  });

  it("rejeita accountId com caracteres estranhos", async () => {
    const { app } = makeApp();
    const res = await app.request("/sessions/..%2Fetc/connect", { method: "POST", headers: auth });
    expect(res.status).toBe(400);
  });
});
