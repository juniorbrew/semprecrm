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
 *      Fila cheia → `ThrottledError` (o app tenta de novo mais tarde).
 *   2. `fetchProfilePictureUrl` chama `sock.profilePictureUrl(jid, "image")`.
 *      Privacidade ("só meus contatos"), contato sem foto ou número fora do
 *      WhatsApp respondem 401/403/404 / `not-authorized` / `item-not-found`:
 *      isso vira `null` (sem foto), não erro.
 *   3. `downloadAvatar` baixa a imagem da CDN do WhatsApp (URL assinada que
 *      EXPIRA em poucos dias — por isso não guardamos a URL dela) com timeout
 *      e teto de tamanho; o `MediaStore` sobe no bucket `contact-avatars`.
 *
 * A API oficial da Meta (Cloud API) não expõe foto de perfil — esse caminho
 * só existe no canal QR.
 */

export const AVATAR_MAX_BYTES = 1024 * 1024; // igual ao limite do bucket (migration 055)
export const AVATAR_MIN_INTERVAL_MS = 4_000;
export const AVATAR_MAX_PENDING = 20;
const DEFAULT_TIMEOUT_MS = 10_000;

export class ThrottledError extends Error {
  constructor() {
    super("muitas consultas de foto em fila para esta conta");
    this.name = "ThrottledError";
  }
}

export interface AvatarThrottleOptions {
  minIntervalMs?: number;
  maxPending?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Lane {
  tail: Promise<void>;
  pending: number;
  lastStartedAt: number;
}

/**
 * Fila serial por chave (conta) com intervalo mínimo entre o INÍCIO de duas
 * tarefas. Uma falha não trava a fila.
 */
export class AvatarThrottle {
  private readonly lanes = new Map<string, Lane>();
  private readonly minIntervalMs: number;
  private readonly maxPending: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: AvatarThrottleOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? AVATAR_MIN_INTERVAL_MS;
    this.maxPending = opts.maxPending ?? AVATAR_MAX_PENDING;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
  }

  pending(key: string): number {
    return this.lanes.get(key)?.pending ?? 0;
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { tail: Promise.resolve(), pending: 0, lastStartedAt: Number.NEGATIVE_INFINITY };
      this.lanes.set(key, lane);
    }
    if (lane.pending >= this.maxPending) return Promise.reject(new ThrottledError());
    lane.pending += 1;
    const l = lane;
    const result = l.tail.then(async () => {
      const wait = l.lastStartedAt + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      l.lastStartedAt = this.now();
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

/** Baixa a imagem da CDN; recusa tipos que não são imagem e arquivos grandes demais. */
export async function downloadAvatar(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<DownloadedAvatar> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? AVATAR_MAX_BYTES;
  if (!/^https:\/\//i.test(url)) throw new Error("URL de foto inesperada");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`CDN respondeu HTTP ${res.status}`);
    const contentType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(contentType)) throw new Error(`tipo de imagem não suportado: ${contentType}`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new Error("foto maior que o limite");
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) throw new Error("foto vazia");
    if (buffer.length > maxBytes) throw new Error("foto maior que o limite");
    return { buffer, contentType };
  } finally {
    clearTimeout(timer);
  }
}
