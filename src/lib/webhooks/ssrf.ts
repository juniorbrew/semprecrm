// ============================================================
// SSRF guard for outbound requests whose URL is account-controlled.
//
// Portado do wacrm (lib/webhooks/ssrf.ts) e endurecido no SempreCRM:
//   - IPv6 que carrega um IPv4 (mapeado `::ffff:`, compatível `::`, NAT64
//     `64:ff9b::/96`) é decodificado e o IPv4 passa pela mesma régua. O
//     parser de URL reescreve `[::ffff:127.0.0.1]` como `[::ffff:7f00:1]`, e a
//     versão original só reconhecia a forma com pontos — o loopback passava.
//   - faixas reservadas que faltavam (multicast, 240/4, broadcast, 198.18/15,
//     192.0.0/24, TEST-NETs).
//   - `fetchSeguro`: segue até 3 redirects À MÃO, conferindo cada `Location`
//     — `redirect: 'manual'` sozinho quebrava http→https e CDNs legítimos.
//
// A webhook URL is attacker-influenced and our server makes the request,
// so an unguarded fetch is a Server-Side Request Forgery primitive: a URL
// pointing at `127.0.0.1`, a cloud metadata IP (`169.254.169.254`), or an
// RFC1918 host would let a caller probe / POST to internal services.
//
// DNS rebinding (a host that resolves public on the check but private on
// connect): `fetchSeguro` sends hostname requests through node:http(s) with
// a socket `lookup` that resolves again, vets every address and connects only
// to a vetted one — the address checked is the address dialled.
// ============================================================

import type { LookupAddress } from 'node:dns';
import { lookup as lookupAsync } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

/** Resolves a hostname to all its addresses (injectable for tests). */
export type Resolver = (host: string) => Promise<LookupAddress[]>;
const resolverPadrao: Resolver = (host) => lookupAsync(host, { all: true });

function ipv4Privado(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast 224/4, reserved 240/4, broadcast
  return false;
}

/** Expande um IPv6 (com ou sem IPv4 no fim) em 8 grupos de 16 bits; null se inválido. */
function gruposIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  // IPv4 no fim (forma com pontos) vira os dois últimos grupos.
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    s = s.slice(0, s.length - v4[0].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const partes = s.split('::');
  if (partes.length > 2) return null;
  const esq = partes[0] ? partes[0].split(':') : [];
  const dir = partes.length === 2 && partes[1] ? partes[1].split(':') : [];
  const faltam = 8 - esq.length - dir.length;
  if (partes.length === 1 && faltam !== 0) return null;
  if (faltam < 0) return null;
  const todos = [...esq, ...Array(partes.length === 2 ? faltam : 0).fill('0'), ...dir];
  if (todos.length !== 8) return null;
  const nums = todos.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/** True for loopback / private / link-local / reserved IPv4 or IPv6. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return ipv4Privado(Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4]));

  const g = gruposIpv6(ip);
  if (!g) return true; // não é IP válido: não confia
  const zeros = (de: number, ate: number) => g.slice(de, ate).every((x) => x === 0);
  const ipv4Do = () => ipv4Privado(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff);

  if (zeros(0, 8)) return true; // :: unspecified
  if (zeros(0, 7) && g[7] === 1) return true; // ::1 loopback
  if (zeros(0, 5) && g[5] === 0xffff) return ipv4Do(); // ::ffff:a.b.c.d (mapeado)
  if (zeros(0, 6)) return ipv4Do(); // ::a.b.c.d (compatível, obsoleto)
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return ipv4Do(); // NAT64
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentação
  return false;
}

/**
 * True if `rawUrl`'s host resolves only to publicly-routable
 * address(es). Returns false for a malformed URL, a non-http(s) scheme, an
 * obvious internal name (`localhost`, `*.local`, `*.internal`), a literal
 * private IP, or a hostname that resolves to any private/reserved address.
 */
export async function isDeliverableUrl(rawUrl: string, resolver: Resolver = resolverPadrao): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host)) return !isPrivateOrReservedIp(host);

  const lower = host.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    return false;
  }

  try {
    const results = await resolver(host);
    if (results.length === 0) return false;
    return results.every((r) => !isPrivateOrReservedIp(r.address));
  } catch {
    return false; // unresolvable → not deliverable
  }
}

/** O destino (ou um redirect dele) aponta para dentro: a chamada não sai. */
export class DestinoNaoPermitido extends Error {
  constructor() {
    super('destination not allowed');
    this.name = 'DestinoNaoPermitido';
  }
}

/**
 * Socket `lookup` that resolves the name again at connect time and refuses
 * (DestinoNaoPermitido) unless EVERY address is public — then connects only
 * to those vetted addresses. Closes the check-then-connect rebinding gap.
 */
export function lookupVetado(resolver: Resolver = resolverPadrao): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname).then(
      (todos) => {
        if (todos.length === 0 || todos.some((a) => isPrivateOrReservedIp(a.address))) {
          callback(new DestinoNaoPermitido(), '', 0);
          return;
        }
        const daFamilia = options.family ? todos.filter((a) => a.family === options.family) : todos;
        if (daFamilia.length === 0) {
          callback(new DestinoNaoPermitido(), '', 0);
          return;
        }
        if (options.all) callback(null, daFamilia);
        else callback(null, daFamilia[0].address, daFamilia[0].family);
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 0),
    );
  };
}

/**
 * Minimal fetch over node:http(s) with a custom socket `lookup`. Only what
 * fetchSeguro's callers use: method, headers, string/bytes body, signal.
 * No automatic redirects (fetchSeguro follows them by hand).
 */
export function requestFixado(rawUrl: string, init: RequestInit, lookupFn: LookupFunction): Promise<Response> {
  const url = new URL(rawUrl);
  const method = (init.method ?? 'GET').toUpperCase();
  const body = init.body;
  if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
    return Promise.reject(new TypeError('fetchSeguro: unsupported body type'));
  }
  const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    method,
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    lookup: lookupFn,
    // Fresh socket every time: a pooled keep-alive socket to the same host
    // may have been opened without this lookup (unvetted address).
    agent: false,
    signal: init.signal ?? undefined,
  });
  return new Promise((resolve, reject) => {
    req.on('error', reject);
    req.on('response', (res) => {
      const headers = new Headers();
      for (const [nome, valor] of Object.entries(res.headers)) {
        if (valor === undefined) continue;
        for (const v of Array.isArray(valor) ? valor : [valor]) headers.append(nome, v);
      }
      const status = res.statusCode ?? 502;
      const semCorpo = method === 'HEAD' || status === 204 || status === 205 || status === 304;
      if (semCorpo) res.resume();
      resolve(
        new Response(semCorpo ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
          status,
          statusText: res.statusMessage,
          headers,
        }),
      );
    });
    req.end(body ?? undefined);
  });
}

/** Cabeçalhos que podem atravessar para OUTRA origem num redirect. */
const CABECALHOS_ENTRE_ORIGENS = new Set(['content-type', 'accept']);

function soCabecalhosSeguros(headers: HeadersInit | undefined, semCorpo: boolean): Headers {
  const limpos = new Headers();
  new Headers(headers).forEach((valor, nome) => {
    if (!CABECALHOS_ENTRE_ORIGENS.has(nome)) return;
    if (semCorpo && nome === 'content-type') return;
    limpos.set(nome, valor);
  });
  return limpos;
}

/**
 * `fetch` que confere o destino ANTES de sair e a cada redirect (até
 * `maxRedirects`), sem deixar o runtime seguir 3xx sozinho: uma URL pública
 * não consegue rebater para uma interna. 307/308 repetem o método e o corpo;
 * 301/302/303 viram GET sem corpo, como o navegador faz. Redirect para OUTRA
 * origem leva só content-type/accept: o segredo do webhook (Authorization,
 * X-Api-Key…) não vai para um terceiro — o mesmo que o fetch nativo faz com
 * Authorization. O corpo de cada 3xx é descartado para soltar a conexão.
 */
export async function fetchSeguro(
  rawUrl: string,
  init: RequestInit = {},
  maxRedirects = 3,
  resolver: Resolver = resolverPadrao,
): Promise<Response> {
  let url = rawUrl;
  let atual: RequestInit = { ...init, redirect: 'manual' };
  for (let i = 0; i <= maxRedirects; i++) {
    if (!(await isDeliverableUrl(url, resolver))) throw new DestinoNaoPermitido();
    // A literal IP was vetted as is; a hostname is re-resolved and pinned
    // to a vetted address at connect time (DNS rebinding).
    const literal = isIP(new URL(url).hostname.replace(/^\[|\]$/g, '')) !== 0;
    const res = literal ? await fetch(url, atual) : await requestFixado(url, atual, lookupVetado(resolver));
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    await res.body?.cancel().catch(() => undefined);
    const proxima = new URL(location, url);
    const outraOrigem = proxima.origin !== new URL(url).origin;
    url = proxima.toString();
    const viraGet = res.status === 301 || res.status === 302 || res.status === 303;
    if (viraGet) {
      const semCorpo: RequestInit = { ...atual, method: 'GET' };
      delete (semCorpo as { body?: unknown }).body;
      atual = semCorpo;
    }
    if (outraOrigem) atual = { ...atual, headers: soCabecalhosSeguros(atual.headers, viraGet) };
  }
  throw new DestinoNaoPermitido();
}
