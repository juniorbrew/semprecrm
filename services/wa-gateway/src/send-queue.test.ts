import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendQueue, typingDurationMs, DEFAULT_SEND_QUEUE } from "./send-queue.js";

// random()=0 → intervalo sempre no mínimo (determinístico)
const CFG = { delayMinMs: 1000, delayMaxMs: 3000, maxPerMinute: 100, maxWaitMs: 60_000, maxQueue: 10 };
const mk = (cfg = {}) => new SendQueue({ ...CFG, ...cfg }, { random: () => 0 });

/** registra a ordem e o instante (relativo) em que cada envio executou */
function recorder() {
  const t0 = Date.now();
  const log: Array<{ id: string; at: number }> = [];
  const task = (id: string) => async () => {
    log.push({ id, at: Date.now() - t0 });
    return id;
  };
  return { log, task };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SendQueue", () => {
  it("bulk: primeiro sai na hora, os seguintes espaçados pelo intervalo, em ordem FIFO", async () => {
    const q = mk();
    const { log, task } = recorder();
    const ps = ["a", "b", "c"].map((id) => q.run("acc", "bulk", task(id)));
    await vi.advanceTimersByTimeAsync(0);
    expect(log.map((l) => l.id)).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(log.map((l) => l.id)).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(log.map((l) => l.id)).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(Promise.all(ps)).resolves.toEqual(["a", "b", "c"]);
    expect(log.map((l) => l.at)).toEqual([0, 1000, 2000]);
  });

  it("intervalo aleatório fica dentro de [min, max]", async () => {
    const q = new SendQueue({ ...CFG }, { random: () => 0.999 });
    const { log, task } = recorder();
    const ps = [q.run("acc", "bulk", task("a")), q.run("acc", "bulk", task("b"))];
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all(ps);
    const gap = log[1].at - log[0].at;
    expect(gap).toBeGreaterThan(2900);
    expect(gap).toBeLessThanOrEqual(3000);
  });

  it("teto por minuto: o excedente espera a janela de 60 s liberar", async () => {
    const q = mk({ delayMinMs: 0, delayMaxMs: 0, maxPerMinute: 2, maxWaitMs: 120_000 });
    const { log, task } = recorder();
    const ps = ["a", "b", "c"].map((id) => q.run("acc", "bulk", task(id)));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(log.map((l) => l.id)).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(ps);
    expect(log.map((l) => l.at)).toEqual([0, 0, 60_000]);
  });

  it("interactive nunca espera, nem com backlog bulk e teto estourado", async () => {
    const q = mk({ maxPerMinute: 1 });
    const { log, task } = recorder();
    const bulk = ["b1", "b2", "b3"].map((id) => q.run("acc", "bulk", task(id)));
    bulk.forEach((p) => p.catch(() => undefined));
    await vi.advanceTimersByTimeAsync(0);
    await q.run("acc", "interactive", task("agent"));
    expect(log.map((l) => l.id)).toEqual(["b1", "agent"]);
    expect(log[1].at).toBe(0);
    expect(q.stats().queued).toBe(2);
    q.shutdown();
  });

  it("envio interactive empurra o próximo bulk (intervalo conta do último envio de qualquer prioridade)", async () => {
    const q = mk();
    const { log, task } = recorder();
    const a = q.run("acc", "bulk", task("a"));
    const b = q.run("acc", "bulk", task("b"));
    await vi.advanceTimersByTimeAsync(800);
    await q.run("acc", "interactive", task("agent"));
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([a, b]);
    expect(log.map((l) => [l.id, l.at])).toEqual([
      ["a", 0],
      ["agent", 800],
      ["b", 1800],
    ]);
  });

  it("um envio de cada vez por conta: o bulk seguinte só começa depois que o anterior termina", async () => {
    const q = mk({ delayMinMs: 0, delayMaxMs: 0 });
    let release!: () => void;
    const slow = q.run("acc", "bulk", () => new Promise<string>((r) => (release = () => r("slow"))));
    const fast = vi.fn(async () => "fast");
    const p2 = q.run("acc", "bulk", fast);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fast).not.toHaveBeenCalled();
    release();
    await slow;
    await vi.advanceTimersByTimeAsync(0);
    expect(fast).toHaveBeenCalled();
    await p2;
  });

  it("contas não se bloqueiam entre si", async () => {
    const q = mk();
    const { log, task } = recorder();
    const ps = [q.run("A", "bulk", task("a1")), q.run("B", "bulk", task("b1")), q.run("A", "bulk", task("a2"))];
    await vi.advanceTimersByTimeAsync(0);
    expect(log.map((l) => l.id).sort()).toEqual(["a1", "b1"]);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(ps);
  });

  it("fila cheia → SendThrottledError(queue_full) sem rodar a tarefa", async () => {
    const q = mk({ maxQueue: 2, maxWaitMs: 1_000_000 });
    const ps = [1, 2, 3].map((i) => q.run("acc", "bulk", async () => i)); // 1 sai, 2 e 3 enfileirados
    const spare = vi.fn(async () => 4);
    await vi.advanceTimersByTimeAsync(0);
    await expect(q.run("acc", "bulk", spare)).rejects.toMatchObject({ reason: "queue_full" });
    expect(spare).not.toHaveBeenCalled();
    expect(q.stats().throttled).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(ps);
  });

  it("pedido com prazo curto: espera estimada acima do prazo → recusa na hora (wait_too_long)", async () => {
    const q = mk({ delayMinMs: 2000, delayMaxMs: 2000 });
    const first = q.run("acc", "bulk", async () => 1, { maxWaitMs: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    // estimativas: 2 s e 4 s cabem em 5 s; a terceira (6 s) não
    const queued = [
      q.run("acc", "bulk", async () => 2, { maxWaitMs: 5000 }),
      q.run("acc", "bulk", async () => 3, { maxWaitMs: 5000 }),
    ];
    await expect(q.run("acc", "bulk", async () => 4, { maxWaitMs: 5000 })).rejects.toMatchObject({
      reason: "wait_too_long",
    });
    // prazo 0: só entra se puder sair agora
    await expect(q.run("acc", "bulk", async () => 5, { maxWaitMs: 0 })).rejects.toMatchObject({
      reason: "wait_too_long",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(Promise.all([first, ...queued])).resolves.toEqual([1, 2, 3]);
  });

  it("o teto por minuto entra na estimativa", async () => {
    const q = mk({ delayMinMs: 0, delayMaxMs: 0, maxPerMinute: 1, maxWaitMs: 120_000 });
    void q.run("acc", "bulk", async () => 1);
    await vi.advanceTimersByTimeAsync(0);
    await expect(q.run("acc", "bulk", async () => 2, { maxWaitMs: 30_000 })).rejects.toMatchObject({
      reason: "wait_too_long",
    });
    const ok = q.run("acc", "bulk", async () => 3, { maxWaitMs: 61_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(ok).resolves.toBe(3);
  });

  it("sem prazo no pedido não há recusa por estimativa: o limite é maxQueue, de verdade", async () => {
    const q = mk({ maxQueue: 100, maxWaitMs: 90_000, delayMinMs: 3000, delayMaxMs: 8000 });
    const ps = Array.from({ length: 101 }, (_, i) => q.run("acc", "bulk", async () => i));
    ps.forEach((p) => p.catch(() => undefined));
    await vi.advanceTimersByTimeAsync(0);
    expect(q.stats().queued).toBe(100); // 1 saiu, 100 esperando: nenhum recusado
    expect(q.stats().throttled).toBe(0);
    await expect(q.run("acc", "bulk", async () => 0)).rejects.toMatchObject({ reason: "queue_full" });
    q.shutdown();
  });

  it("fan-out de 50 destinatários: quem leva 429 estaciona e o cron retoma; os 50 saem, nenhum se perde", async () => {
    // Modelo do app: os envios chegam juntos (eventos concorrentes) com prazo de 15 s; em 429
    // `throttled` o passo é estacionado (pending execution, run_at +60 s). O cron roda a cada
    // minuto, retoma as linhas vencidas em sequência com orçamento de 45 s e re-estaciona o que
    // levar 429 de novo.
    const q = new SendQueue(
      { delayMinMs: 3000, delayMaxMs: 8000, maxPerMinute: 15, maxQueue: 100, maxWaitMs: 90_000 },
      { random: () => 0.5 },
    );
    const sent: number[] = [];
    const pending = new Map<number, number>(); // id → run_at
    let parked = 0;
    const attempt = async (id: number, maxWaitMs: number): Promise<void> => {
      try {
        await q.run("acc", "bulk", async () => void sent.push(id), { maxWaitMs });
        pending.delete(id);
      } catch (err) {
        expect(err).toMatchObject({ name: "SendThrottledError" });
        parked += 1;
        pending.set(id, Date.now() + 60_000);
      }
    };
    const cronTick = async () => {
      const deadline = Date.now() + 45_000;
      for (const [id, runAt] of [...pending]) {
        const left = deadline - Date.now();
        if (runAt > Date.now() || left < 1000) continue;
        await attempt(id, Math.min(15_000, left));
      }
    };
    const fanOut = Array.from({ length: 50 }, (_, i) => attempt(i, 15_000));
    for (let tick = 0; tick < 12 && (sent.length < 50 || pending.size); tick += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      void cronTick();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(fanOut);
    expect([...sent].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(new Set(sent).size).toBe(50); // nenhum enviado duas vezes
    expect(pending.size).toBe(0);
    expect(parked).toBeGreaterThan(0); // o prazo curto realmente estacionou gente
    expect(q.stats()).toMatchObject({ queued: 0, sent_bulk: 50 });
  });

  it("vez que não chega em maxWaitMs → SendThrottledError(max_wait) e sai da fila", async () => {
    const q = mk({ maxWaitMs: 5000, delayMinMs: 1000, delayMaxMs: 1000, maxPerMinute: 1 });
    const done = vi.fn(async () => "x");
    void q.run("acc", "bulk", done);
    const late = q.run("acc", "bulk", done);
    const assertion = expect(late).rejects.toMatchObject({ reason: "max_wait" });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(done).toHaveBeenCalledTimes(1);
    expect(q.stats().queued).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000); // nada roda depois de recusado
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("erro da tarefa propaga e não trava a fila", async () => {
    const q = mk({ delayMinMs: 0, delayMaxMs: 0 });
    const bad = q.run("acc", "bulk", async () => {
      throw new Error("boom");
    });
    const ok = q.run("acc", "bulk", async () => "ok");
    await expect(bad).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(0);
    await expect(ok).resolves.toBe("ok");
  });

  it("enabled=false: tudo sai na hora, sem fila", async () => {
    const q = mk({ enabled: false });
    const { log, task } = recorder();
    await Promise.all([q.run("acc", "bulk", task("a")), q.run("acc", "bulk", task("b"))]);
    expect(log.map((l) => l.at)).toEqual([0, 0]);
  });

  it("stats: fila, enviados por prioridade e recusados", async () => {
    const q = mk();
    const ps = [q.run("acc", "bulk", async () => 1), q.run("acc", "bulk", async () => 2)];
    await vi.advanceTimersByTimeAsync(0);
    await q.run("acc", "interactive", async () => 3);
    expect(q.stats()).toMatchObject({
      queued: 1,
      active_accounts: 1,
      sent_bulk: 1,
      sent_interactive: 1,
      max_queue_depth: 1,
    });
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(ps);
    expect(q.stats()).toMatchObject({ queued: 0, sent_bulk: 2 });
  });

  it("shutdown recusa o que esperava (nada some em silêncio)", async () => {
    const q = mk();
    void q.run("acc", "bulk", async () => 1);
    const waiting = q.run("acc", "bulk", async () => 2);
    await vi.advanceTimersByTimeAsync(0);
    q.shutdown();
    await expect(waiting).rejects.toMatchObject({ reason: "shutdown" });
  });
});

describe("typingDurationMs", () => {
  const cfg = { ...DEFAULT_SEND_QUEUE, typingMsPerChar: 40, typingMaxMs: 4000 };
  it("proporcional ao tamanho, com teto e variação de ±20 %", () => {
    expect(typingDurationMs(10, cfg, () => 0.5)).toBe(400);
    expect(typingDurationMs(10, cfg, () => 0)).toBe(320);
    expect(typingDurationMs(10, cfg, () => 1)).toBe(480);
    expect(typingDurationMs(5000, cfg, () => 1)).toBe(4000);
  });
  it("zero quando desligado ou sem texto", () => {
    expect(typingDurationMs(50, { ...cfg, typingEnabled: false })).toBe(0);
    expect(typingDurationMs(0, cfg)).toBe(0);
  });
});
