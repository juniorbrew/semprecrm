import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { AppClient, HEADER_SECRET } from "./app-client.js";

const logger = pino({ level: "silent" });

function makeClient(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof AppClient>[0]> = {}) {
  const sleeps: number[] = [];
  const client = new AppClient({
    appUrl: "http://app.local",
    secret: "s3cret-s3cret-s3cret",
    logger,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    baseDelayMs: 10,
    maxDelayMs: 100,
    maxAttempts: 4,
    ...extra,
  });
  return { client, sleeps };
}

describe("AppClient", () => {
  it("envia POST com o header x-gateway-secret e o path certo", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const { client } = makeClient(fetchImpl);
    const ok = await client.sendInbound({
      account_id: "a",
      message_id: "m",
      from: "5511",
      push_name: "x",
      timestamp: 1,
      type: "text",
      text: "oi",
    });
    expect(ok).toBe(true);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://app.local/api/channels/qr/inbound");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)[HEADER_SECRET]).toBe("s3cret-s3cret-s3cret");
    expect(JSON.parse(init.body as string)).toMatchObject({ account_id: "a", message_id: "m" });
  });

  it("faz retry com backoff em 5xx e falha de rede, depois entrega", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNREFUSED");
      if (calls === 2) return new Response("boom", { status: 503 });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const { client, sleeps } = makeClient(fetchImpl);
    const ok = await client.sendStatus({ account_id: "a", status: "connecting" });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThanOrEqual(sleeps[0]);
  });

  it("descarta após esgotar as tentativas", async () => {
    const fetchImpl = vi.fn(async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    const { client, sleeps } = makeClient(fetchImpl);
    const ok = await client.sendAck({ account_id: "a", message_id: "m", status: "sent" });
    expect(ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleeps).toHaveLength(3);
  });

  it("não faz retry em 4xx (payload inválido / secret errado)", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 401 })) as unknown as typeof fetch;
    const { client, sleeps } = makeClient(fetchImpl);
    const ok = await client.sendAck({ account_id: "a", message_id: "m", status: "sent" });
    expect(ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleeps).toHaveLength(0);
  });

  it("preserva a ordem da fila (serial)", async () => {
    const seen: string[] = [];
    let first = true;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { status: string };
      if (first) {
        first = false;
        return new Response("", { status: 500 }); // força retry do primeiro
      }
      seen.push(body.status);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const { client } = makeClient(fetchImpl);
    const p1 = client.sendStatus({ account_id: "a", status: "qr" });
    const p2 = client.sendStatus({ account_id: "a", status: "connected" });
    await Promise.all([p1, p2]);
    expect(seen).toEqual(["qr", "connected"]);
  });

  it("backoff cresce exponencialmente com teto", () => {
    const { client } = makeClient((async () => new Response()) as unknown as typeof fetch, {
      baseDelayMs: 1000,
      maxDelayMs: 5000,
    });
    expect(client.backoff(1)).toBeGreaterThanOrEqual(1000);
    expect(client.backoff(1)).toBeLessThan(1300);
    expect(client.backoff(3)).toBeGreaterThanOrEqual(4000);
    expect(client.backoff(10)).toBe(5000);
  });
});
