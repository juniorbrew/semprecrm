import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Download da mídia que o app pede para ENVIAR (`POST /sessions/:id/send`).
 *
 * O Baileys trata `{ url }` assim: `data:` inline, `http(s)://` busca na rede
 * e QUALQUER outra coisa vira `createReadStream(url)` — um caminho local. Uma
 * URL vinda do app nunca chega ao Baileys: o gateway baixa os bytes aqui e
 * entrega um Buffer. Regras:
 *   - só `http:`/`https:`, sem usuário/senha na URL;
 *   - a origem tem de estar na lista permitida: as origens do storage
 *     (SUPABASE_URL / SUPABASE_PUBLIC_URL) e as de MEDIA_ALLOWED_ORIGINS;
 *   - origem que NÃO é do storage passa também pela régua de IP: host que
 *     resolve para loopback/rede privada/link-local/metadata é recusado
 *     (o storage costuma ser interno, por isso fica isento);
 *   - redirects seguidos à mão (até 3), cada destino conferido de novo;
 *   - timeout e teto de tamanho aplicado durante a leitura.
 *
 * Não protege contra DNS rebinding (host que resolve público na conferência e
 * privado na conexão) — o fetch não deixa fixar o IP; risco residual, só para
 * origens extras de MEDIA_ALLOWED_ORIGINS.
 */

export const OUTBOUND_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
export const OUTBOUND_MEDIA_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

export interface MediaPolicy {
  /** Origens do storage (confiáveis mesmo sendo internas). */
  storageOrigins: string[];
  /** Origens extras (MEDIA_ALLOWED_ORIGINS) — passam pela régua de IP. */
  extraOrigins: string[];
}

export interface DownloadMediaOptions {
  fetchImpl?: typeof fetch;
  lookup?: (host: string) => Promise<string[]>;
  maxBytes?: number;
  timeoutMs?: number;
}

/** A URL não é permitida (vira 400); falha de rede/HTTP é `Error` comum (502). */
export class MediaUrlRejected extends Error {
  constructor(reason: string) {
    super(`URL de mídia não permitida: ${reason}`);
    this.name = "MediaUrlRejected";
  }
}

/** Origem normalizada (`https://host[:porta]`) de uma URL absoluta; null se não for http(s). */
export function httpOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

function ipv4Privado(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a >= 224;
}

function gruposIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    s = s.slice(0, s.length - v4[0].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const partes = s.split("::");
  if (partes.length > 2) return null;
  const esq = partes[0] ? partes[0].split(":") : [];
  const dir = partes.length === 2 && partes[1] ? partes[1].split(":") : [];
  const faltam = 8 - esq.length - dir.length;
  if ((partes.length === 1 && faltam !== 0) || faltam < 0) return null;
  const todos = [...esq, ...Array(partes.length === 2 ? faltam : 0).fill("0"), ...dir];
  if (todos.length !== 8) return null;
  const nums = todos.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/** Cópia de src/lib/webhooks/ssrf.ts (o gateway é outro pacote). */
export function isPrivateOrReservedIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return ipv4Privado(Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4]));
  const g = gruposIpv6(ip);
  if (!g) return true;
  const zeros = (de: number, ate: number) => g.slice(de, ate).every((x) => x === 0);
  const ipv4Do = () => ipv4Privado(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff);
  if (zeros(0, 8)) return true;
  if (zeros(0, 7) && g[7] === 1) return true;
  if (zeros(0, 5) && g[5] === 0xffff) return ipv4Do();
  if (zeros(0, 6)) return ipv4Do();
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return ipv4Do();
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xff00) === 0xff00) return true;
  return g[0] === 0x2001 && g[1] === 0x0db8;
}

async function defaultLookup(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true })).map((r) => r.address);
}

/** Confere uma URL contra a política; devolve a URL normalizada ou lança `MediaUrlRejected`. */
export async function checkMediaUrl(
  raw: string,
  policy: MediaPolicy,
  lookup: (host: string) => Promise<string[]> = defaultLookup,
): Promise<URL> {
  if (typeof raw !== "string" || /[\0-\x1f\\]/.test(raw)) throw new MediaUrlRejected("formato inválido");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MediaUrlRejected("não é uma URL absoluta");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new MediaUrlRejected("esquema não suportado");
  if (url.username || url.password) throw new MediaUrlRejected("credenciais na URL");
  if (policy.storageOrigins.includes(url.origin)) return url;
  if (!policy.extraOrigins.includes(url.origin)) throw new MediaUrlRejected("origem fora da lista permitida");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  let ips: string[];
  if (isIP(host)) ips = [host];
  else {
    try {
      ips = await lookup(host);
    } catch {
      throw new MediaUrlRejected("host não resolve");
    }
  }
  if (ips.length === 0 || ips.some(isPrivateOrReservedIp)) throw new MediaUrlRejected("destino interno");
  return url;
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("mídia maior que o limite");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Baixa a mídia de `raw` respeitando a política. `mimetype` é o tipo pedido
 * pelo app: para imagem/vídeo/áudio a resposta tem de ser do mesmo tipo
 * principal (ou genérica, `application/octet-stream`).
 */
export async function downloadOutboundMedia(
  raw: string,
  mimetype: string,
  policy: MediaPolicy,
  opts: DownloadMediaOptions = {},
): Promise<Buffer> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? OUTBOUND_MEDIA_MAX_BYTES;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? OUTBOUND_MEDIA_TIMEOUT_MS);

  let url = await checkMediaUrl(raw, policy, opts.lookup);
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(url.toString(), { redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get("location");
      if (!location || hop >= MAX_REDIRECTS) throw new Error(`redirecionamento recusado (HTTP ${res.status})`);
      url = await checkMediaUrl(new URL(location, url).toString(), policy, opts.lookup);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`mídia respondeu HTTP ${res.status}`);
    }
    const kind = mimetype.split("/")[0].toLowerCase();
    const got = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (
      ["image", "video", "audio"].includes(kind) &&
      got &&
      got !== "application/octet-stream" &&
      got.split("/")[0] !== kind
    ) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`tipo da mídia não confere: ${got}`);
    }
    if (Number(res.headers.get("content-length") ?? "0") > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error("mídia maior que o limite");
    }
    const buffer = await readCapped(res, maxBytes);
    if (buffer.length === 0) throw new Error("mídia vazia");
    return buffer;
  }
}
