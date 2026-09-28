/**
 * Foto de perfil dos contatos (canal QR).
 *
 * O app pede `POST /sessions/:id/avatar` quando um contato do canal QR aparece
 * sem foto ou com a foto verificada há mais de ~7 dias (quem decide é o app,
 * que guarda `contacts.avatar_checked_at`). Aqui:
 *
 *   1. `AvatarThrottle` serializa as consultas por conta e espaça cada uma
 *      (`minIntervalMs`, padrão 4 s) — rajadas de `profilePictureUrl` num
 *      número conectado por QR são o tipo de tráfego que leva a banimento.
 *      O espaçamento vale também entre pedidos que não se sobrepõem (o
 *      último início por conta sobrevive à fila esvaziar). Fila cheia, ou
 *      a vez do pedido chegando depois de `maxWaitMs` na fila →
 *      `ThrottledError` (o app tenta de novo mais tarde).
 *   2. `fetchProfilePictureUrl` chama `sock.profilePictureUrl(jid, "image")`.
 *      Privacidade ("só meus contatos"), contato sem foto ou número fora do
 *      WhatsApp respondem 401/403/404 / `not-authorized` / `item-not-found`:
 *      isso vira `null` (sem foto), não erro.
 *   3. `downloadAvatar` baixa a imagem da CDN do WhatsApp (URL assinada que
 *      EXPIRA em poucos dias — por isso não guardamos a URL dela): só https
 *      em *.whatsapp.net / *.fbcdn.net, sem seguir redirecionamento, com
 *      timeout e teto de tamanho aplicado durante a leitura; o `MediaStore`
 *      sobe no bucket `contact-avatars`.
 *
 * Orçamento de tempo: o app espera a resposta por AVATAR_APP_TIMEOUT_MS
 * (60 s, src/lib/whatsapp/qr-gateway.ts). Um pedido espera na fila no
 * máximo AVATAR_MAX_WAIT_MS (25 s) e depois gasta até ~2 × 8 s (consulta
 * + download) mais o upload — abaixo do timeout do app, para o gateway
 * não trabalhar numa resposta que ninguém vai ler.
 *
 * A API oficial da Meta (Cloud API) não expõe foto de perfil — esse caminho
 * só existe no canal QR.
 */

export const AVATAR_MAX_BYTES = 1024 * 1024; // igual ao limite do bucket (migration 055)
export const AVATAR_MIN_INTERVAL_MS = 4_000;
export const AVATAR_MAX_PENDING = 20;
/** Tempo máximo de espera na fila antes de desistir (ver orçamento acima). */
export const AVATAR_MAX_WAIT_MS = 25_000;
/** Timeout do app para `POST /avatar` — o orçamento acima tem de caber nele. */
export const AVATAR_APP_TIMEOUT_MS = 60_000;
export const AVATAR_STEP_TIMEOUT_MS = 8_000;
const DEFAULT_TIMEOUT_MS = AVATAR_STEP_TIMEOUT_MS;
/** Hosts de onde o WhatsApp serve fotos de perfil. */
export const AVATAR_HOST_SUFFIXES = [".whatsapp.net", ".fbcdn.net"] as const;

export class ThrottledError extends Error {
  constructor() {
    super("muitas consultas de foto em fila para esta conta");
    this.name = "ThrottledError";
  }
}

export interface AvatarThrottleOptions {
  minIntervalMs?: number;
  maxPending?: number;
  /** Desiste (ThrottledError) quando a vez chega depois disso na fila. */
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Lane {
  tail: Promise<void>;
  pending: number;
}

/**
 * Fila serial por chave (conta) com intervalo mínimo entre o INÍCIO de duas
 * tarefas. Uma falha não trava a fila.
 */
export class AvatarThrottle {
  private readonly lanes = new Map<string, Lane>();
  /**
   * Último início por conta — fora da `Lane` de propósito: a fila é apagada
   * quando esvazia, e o espaçamento tem de valer também para o próximo
   * pedido que chegar sozinho logo depois.
   */
  private readonly lastStartedAt = new Map<string, number>();
  private readonly minIntervalMs: number;
  private readonly maxPending: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: AvatarThrottleOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? AVATAR_MIN_INTERVAL_MS;
    this.maxPending = opts.maxPending ?? AVATAR_MAX_PENDING;
    this.maxWaitMs = opts.maxWaitMs ?? AVATAR_MAX_WAIT_MS;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
  }

  pending(key: string): number {
    return this.lanes.get(key)?.pending ?? 0;
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { tail: Promise.resolve(), pending: 0 };
      this.lanes.set(key, lane);
    }
    if (lane.pending >= this.maxPending) return Promise.reject(new ThrottledError());
    lane.pending += 1;
    const l = lane;
    const enqueuedAt = this.now();
    const result = l.tail.then(async () => {
      const last = this.lastStartedAt.get(key) ?? Number.NEGATIVE_INFINITY;
      const wait = Math.max(0, last + this.minIntervalMs - this.now());
      // A vez chegaria tarde demais para o app ainda estar esperando.
      if (this.now() + wait - enqueuedAt > this.maxWaitMs) throw new ThrottledError();
      if (wait > 0) await this.sleep(wait);
      this.lastStartedAt.set(key, this.now());
      return task();
    });
    const settle = () => {
      l.pending -= 1;
      if (l.pending === 0 && this.lanes.get(key) === l) this.lanes.delete(key);
    };
    l.tail = result.then(settle, settle);
    return result;
  }
}

/** Erro do WhatsApp que significa "não há foto visível para nós". */
export function isNoPictureError(err: unknown): boolean {
  const e = err as { output?: { statusCode?: number }; data?: unknown; message?: string } | null;
  const code = e?.output?.statusCode;
  if (code === 401 || code === 403 || code === 404) return true;
  const msg = String(e?.message ?? err).toLowerCase();
  return /not-authorized|item-not-found|not-acceptable|forbidden|no profile picture/.test(msg);
}

export interface ProfilePictureSource {
  profilePictureUrl: (jid: string, type?: "preview" | "image", timeoutMs?: number) => Promise<string | undefined>;
}

/** URL (assinada, temporária) da foto em alta, ou `null` quando não há foto visível. */
export async function fetchProfilePictureUrl(
  sock: ProfilePictureSource,
  jid: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const url = await sock.profilePictureUrl(jid, "image", timeoutMs);
    return url || null;
  } catch (err) {
    if (isNoPictureError(err)) return null;
    throw err;
  }
}

export interface DownloadedAvatar {
  buffer: Buffer;
  contentType: string;
}

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Só https em hosts da CDN do WhatsApp (evita SSRF se a URL vier estranha). */
export function isAllowedAvatarUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== "443") return false;
  const host = parsed.hostname.toLowerCase();
  return AVATAR_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

/**
 * Baixa a imagem da CDN; recusa hosts fora da lista, redirecionamentos,
 * tipos que não são imagem e arquivos grandes demais (o teto vale durante a
 * leitura do corpo, não só pelo `content-length`).
 */
export async function downloadAvatar(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<DownloadedAvatar> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? AVATAR_MAX_BYTES;
  if (!isAllowedAvatarUrl(url)) throw new Error("URL de foto inesperada");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: "manual" });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      throw new Error("CDN respondeu com redirecionamento");
    }
    if (!res.ok) throw new Error(`CDN respondeu HTTP ${res.status}`);
    const contentType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(contentType)) throw new Error(`tipo de imagem não suportado: ${contentType}`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new Error("foto maior que o limite");
    const buffer = await readCapped(res, maxBytes, controller);
    if (buffer.length === 0) throw new Error("foto vazia");
    return { buffer, contentType };
  } finally {
    clearTimeout(timer);
  }
}

/** Lê o corpo em pedaços e aborta assim que passar de `maxBytes`. */
async function readCapped(res: Response, maxBytes: number, controller: AbortController): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      throw new Error("foto maior que o limite");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
