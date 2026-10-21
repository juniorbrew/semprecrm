/**
 * Fila de envio anti-banimento (canal QR).
 *
 * Rajadas de mensagens de um número conectado por QR são o padrão que o
 * anti-spam do WhatsApp procura. Cada conta tem uma pista (`Lane`) com duas
 * prioridades:
 *
 *   - `interactive` (atendente digitando na caixa de entrada): NUNCA espera.
 *     Roda na hora, mesmo com a fila de bulk cheia — não existe como ser
 *     atropelado por um backlog. Só entra na contabilidade (a mensagem conta
 *     no teto por minuto e empurra o próximo bulk).
 *   - `bulk` (automações, fluxos, resposta automática da IA, campanhas): FIFO
 *     por conta, uma por vez, com intervalo aleatório [delayMinMs, delayMaxMs]
 *     entre o fim do envio anterior (de qualquer prioridade) e o início do
 *     próximo, e teto de `maxPerMinute` numa janela deslizante de 60 s.
 *
 * Nada se perde em silêncio: fila cheia, espera estimada acima do limite, ou
 * a vez que não chega em `maxWaitMs` → `SendThrottledError` (o gateway
 * responde 429 `throttled` e o app tenta de novo). Contas não se bloqueiam
 * entre si. A fila vive na memória do processo; no desligamento os pedidos
 * em espera são recusados (429), nunca descartados.
 */

import type { SendPriority } from "./types.js";

export type { SendPriority };

export interface SendQueueConfig {
  /** `false` desliga tudo: todo envio sai na hora (como antes da fila). */
  enabled: boolean;
  /** intervalo aleatório entre dois envios bulk da mesma conta */
  delayMinMs: number;
  delayMaxMs: number;
  /** teto de envios (qualquer prioridade) por conta em 60 s; só segura bulk */
  maxPerMinute: number;
  /** quantos bulk podem esperar por conta */
  maxQueue: number;
  /** tempo máximo que um bulk espera a sua vez */
  maxWaitMs: number;
  /** "digitando…" antes de texto bulk */
  typingEnabled: boolean;
  typingMsPerChar: number;
  typingMaxMs: number;
}

export const DEFAULT_SEND_QUEUE: SendQueueConfig = {
  enabled: true,
  delayMinMs: 3_000,
  delayMaxMs: 8_000,
  maxPerMinute: 15,
  maxQueue: 100,
  maxWaitMs: 90_000,
  typingEnabled: true,
  typingMsPerChar: 40,
  typingMaxMs: 4_000,
};

export class SendThrottledError extends Error {
  constructor(
    message: string,
    readonly reason: "queue_full" | "wait_too_long" | "max_wait" | "shutdown",
  ) {
    super(message);
    this.name = "SendThrottledError";
  }
}

export interface SendQueueStats {
  enabled: boolean;
  /** bulk esperando a vez, somando as contas */
  queued: number;
  /** contas com envio em andamento ou bulk na fila */
  active_accounts: number;
  sent_interactive: number;
  sent_bulk: number;
  /** pedidos recusados com 429 desde a subida */
  throttled: number;
  /** maior fila atual entre as contas */
  max_queue_depth: number;
  /** quanto o bulk mais antigo da fila já esperou (ms) */
  oldest_wait_ms: number;
}

interface Item {
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
  /** intervalo sorteado para este item */
  gapMs: number;
  waitTimer?: NodeJS.Timeout;
}

interface Lane {
  queue: Item[];
  running: boolean;
  /** envios em andamento (interactive + bulk) */
  inflight: number;
  timer?: NodeJS.Timeout;
  /** início dos envios dos últimos 60 s (qualquer prioridade) */
  sends: number[];
  /** fim do último envio */
  lastEndAt?: number;
}

const WINDOW_MS = 60_000;

export interface SendQueueDeps {
  now?: () => number;
  random?: () => number;
}

export class SendQueue {
  private readonly lanes = new Map<string, Lane>();
  private readonly cfg: SendQueueConfig;
  private readonly now: () => number;
  private readonly random: () => number;
  private sentInteractive = 0;
  private sentBulk = 0;
  private throttled = 0;

  constructor(cfg: Partial<SendQueueConfig> = {}, deps: SendQueueDeps = {}) {
    this.cfg = { ...DEFAULT_SEND_QUEUE, ...cfg };
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  get config(): Readonly<SendQueueConfig> {
    return this.cfg;
  }

  /**
   * Roda `run` quando for a vez. `interactive` roda já; `bulk` espera na fila
   * da conta. Rejeita com `SendThrottledError` sem ter rodado `run` — por
   * isso o chamador pode tentar de novo sem risco de duplicar.
   */
  run<T>(accountId: string, priority: SendPriority, run: () => Promise<T>): Promise<T> {
    if (!this.cfg.enabled) return run();
    const lane = this.lane(accountId);
    if (priority === "interactive") return this.exec(priority, run, lane);

    if (lane.queue.length >= this.cfg.maxQueue) {
      return this.refuse("fila de envio desta conta está cheia", "queue_full");
    }
    // Falha rápido em vez de segurar a conexão por maxWaitMs para depois recusar.
    const avgGap = (this.cfg.delayMinMs + this.cfg.delayMaxMs) / 2;
    if ((lane.queue.length + 1) * avgGap > this.cfg.maxWaitMs * 1.5) {
      return this.refuse("fila de envio desta conta está longa demais; tente mais tarde", "wait_too_long");
    }
    return new Promise<T>((resolve, reject) => {
      const item: Item = {
        run,
        resolve: resolve as (v: unknown) => void,
        reject,
        enqueuedAt: this.now(),
        gapMs: this.cfg.delayMinMs + Math.floor(this.random() * (this.cfg.delayMaxMs - this.cfg.delayMinMs + 1)),
      };
      item.waitTimer = setTimeout(() => {
        const i = lane.queue.indexOf(item);
        if (i < 0) return;
        lane.queue.splice(i, 1);
        this.throttled += 1;
        reject(new SendThrottledError("a vez deste envio não chegou a tempo; tente novamente", "max_wait"));
      }, this.cfg.maxWaitMs);
      item.waitTimer.unref?.();
      lane.queue.push(item);
      this.pump(lane);
    });
  }

  stats(): SendQueueStats {
    const now = this.now();
    let queued = 0;
    let active = 0;
    let deepest = 0;
    let oldest = 0;
    for (const lane of this.lanes.values()) {
      queued += lane.queue.length;
      if (lane.running || lane.queue.length) active += 1;
      deepest = Math.max(deepest, lane.queue.length);
      if (lane.queue[0]) oldest = Math.max(oldest, now - lane.queue[0].enqueuedAt);
    }
    return {
      enabled: this.cfg.enabled,
      queued,
      active_accounts: active,
      sent_interactive: this.sentInteractive,
      sent_bulk: this.sentBulk,
      throttled: this.throttled,
      max_queue_depth: deepest,
      oldest_wait_ms: oldest,
    };
  }

  /** Para o desligamento: recusa o que está na fila e solta os timers. */
  shutdown(): void {
    for (const lane of this.lanes.values()) {
      if (lane.timer) clearTimeout(lane.timer);
      lane.timer = undefined;
      for (const item of lane.queue.splice(0)) {
        clearTimeout(item.waitTimer);
        this.throttled += 1;
        item.reject(new SendThrottledError("gateway encerrando; tente novamente", "shutdown"));
      }
    }
  }

  private refuse(message: string, reason: SendThrottledError["reason"]): Promise<never> {
    this.throttled += 1;
    return Promise.reject(new SendThrottledError(message, reason));
  }

  private lane(accountId: string): Lane {
    // Varre as pistas ociosas (nada na fila, nada na janela): memória limitada.
    const now = this.now();
    for (const [id, l] of this.lanes) {
      if (id !== accountId && !l.inflight && !l.timer && !l.queue.length && (l.lastEndAt ?? 0) < now - WINDOW_MS) {
        this.lanes.delete(id);
      }
    }
    let lane = this.lanes.get(accountId);
    if (!lane) {
      lane = { queue: [], running: false, inflight: 0, sends: [] };
      this.lanes.set(accountId, lane);
    }
    return lane;
  }

  /** Executa já e contabiliza o envio (janela de 60 s + fim do último). */
  private async exec<T>(priority: SendPriority, run: () => Promise<T>, lane: Lane): Promise<T> {
    lane.sends.push(this.now());
    lane.inflight += 1;
    if (priority === "interactive") this.sentInteractive += 1;
    else this.sentBulk += 1;
    try {
      return await run();
    } finally {
      lane.inflight -= 1;
      lane.lastEndAt = this.now();
    }
  }

  private pump(lane: Lane): void {
    if (lane.running || lane.timer) return;
    const item = lane.queue[0];
    if (!item) return;
    const now = this.now();
    lane.sends = lane.sends.filter((t) => t > now - WINDOW_MS);
    let wait = lane.lastEndAt === undefined ? 0 : lane.lastEndAt + item.gapMs - now;
    if (lane.sends.length >= this.cfg.maxPerMinute) {
      wait = Math.max(wait, lane.sends[0] + WINDOW_MS - now);
    }
    if (wait > 0) {
      // Reavalia ao acordar: um envio interactive pode ter empurrado o próximo.
      lane.timer = setTimeout(() => {
        lane.timer = undefined;
        this.pump(lane);
      }, wait);
      lane.timer.unref?.();
      return;
    }
    lane.queue.shift();
    clearTimeout(item.waitTimer);
    lane.running = true;
    this.exec("bulk", item.run, lane)
      .then(item.resolve, item.reject)
      .finally(() => {
        lane.running = false;
        this.pump(lane);
      });
  }
}

/** Duração do "digitando…" para um texto: proporcional ao tamanho, com teto e ±20 % de variação. */
export function typingDurationMs(textLength: number, cfg: SendQueueConfig, random: () => number = Math.random): number {
  if (!cfg.enabled || !cfg.typingEnabled || textLength <= 0) return 0;
  const base = Math.min(cfg.typingMaxMs, textLength * cfg.typingMsPerChar);
  return Math.min(cfg.typingMaxMs, Math.round(base * (0.8 + random() * 0.4)));
}
