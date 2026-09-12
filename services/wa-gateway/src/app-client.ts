import type { Logger } from "./logger.js";
import type { AckPayload, InboundPayload, StatusEventPayload } from "./types.js";

export const HEADER_SECRET = "x-gateway-secret";

export interface AppClientOptions {
  appUrl: string;
  secret: string;
  logger: Logger;
  /** injeção para testes */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  requestTimeoutMs?: number;
}

interface Job {
  path: string;
  body: unknown;
  attempt: number;
  resolve: (ok: boolean) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Entrega eventos ao app (`/api/channels/qr/*`) com fila em memória e retry
 * com backoff exponencial. A fila é serial para preservar a ordem dos eventos
 * (um `status: connected` nunca ultrapassa o `qr` anterior, por exemplo).
 *
 * - 5xx, 408, 429 e falha de rede → retry (até `maxAttempts`).
 * - Demais 4xx → descarta (o payload não vai ficar válido tentando de novo).
 */
export class AppClient {
  private readonly queue: Job[] = [];
  private draining = false;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly log: Logger;

  constructor(private readonly opts: AppClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxAttempts = opts.maxAttempts ?? 8;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.maxDelayMs = opts.maxDelayMs ?? 60_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.log = opts.logger.child({ module: "app-client" });
  }

  get pending(): number {
    return this.queue.length + (this.draining ? 1 : 0);
  }

  sendInbound(payload: InboundPayload): Promise<boolean> {
    return this.enqueue("/api/channels/qr/inbound", payload);
  }

  sendStatus(payload: StatusEventPayload): Promise<boolean> {
    return this.enqueue("/api/channels/qr/status", payload);
  }

  sendAck(payload: AckPayload): Promise<boolean> {
    return this.enqueue("/api/channels/qr/ack", payload);
  }

  /** Resolve `true` quando o app aceitou, `false` quando desistimos. */
  enqueue(path: string, body: unknown): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.queue.push({ path, body, attempt: 0, resolve });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue[0];
        const outcome = await this.attempt(job);
        if (outcome === "ok") {
          this.queue.shift();
          job.resolve(true);
          continue;
        }
        if (outcome === "drop" || job.attempt >= this.maxAttempts) {
          this.queue.shift();
          this.log.error({ path: job.path, attempts: job.attempt }, "evento descartado após falhas");
          job.resolve(false);
          continue;
        }
        const delay = this.backoff(job.attempt);
        this.log.warn({ path: job.path, attempt: job.attempt, delayMs: delay }, "falha ao entregar evento; nova tentativa");
        await this.sleep(delay);
      }
    } finally {
      this.draining = false;
    }
  }

  backoff(attempt: number): number {
    const exp = this.baseDelayMs * 2 ** Math.max(0, attempt - 1);
    const jitter = Math.floor(Math.random() * this.baseDelayMs * 0.25);
    return Math.min(this.maxDelayMs, exp + jitter);
  }

  private async attempt(job: Job): Promise<"ok" | "retry" | "drop"> {
    job.attempt += 1;
    const url = `${this.opts.appUrl}${job.path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HEADER_SECRET]: this.opts.secret,
        },
        body: JSON.stringify(job.body),
        signal: controller.signal,
      });
      if (res.ok) return "ok";
      const text = await res.text().catch(() => "");
      if (res.status === 408 || res.status === 429 || res.status >= 500) {
        this.log.warn({ url, status: res.status, body: text.slice(0, 300) }, "app respondeu erro transitório");
        return "retry";
      }
      this.log.error({ url, status: res.status, body: text.slice(0, 300) }, "app rejeitou o evento");
      return "drop";
    } catch (err) {
      this.log.warn({ url, err: (err as Error).message }, "falha de rede ao chamar o app");
      return "retry";
    } finally {
      clearTimeout(timer);
    }
  }
}
