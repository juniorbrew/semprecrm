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
// NOT a defense against DNS rebinding (a host that resolves public here but
// flips to private before connect) — that needs pinning the resolved IP into
// the socket, which fetch doesn't expose; documented as a residual risk.
// ============================================================

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

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
export async function isDeliverableUrl(rawUrl: string): Promise<boolean> {
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
    const results = await lookup(host, { all: true });
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
 * `fetch` que confere o destino ANTES de sair e a cada redirect (até
 * `maxRedirects`), sem deixar o runtime seguir 3xx sozinho: uma URL pública
 * não consegue rebater para uma interna. 307/308 repetem o método e o corpo;
 * 301/302/303 viram GET sem corpo, como o navegador faz.
 */
export async function fetchSeguro(
  rawUrl: string,
  init: RequestInit = {},
  maxRedirects = 3,
): Promise<Response> {
  let url = rawUrl;
  let atual: RequestInit = { ...init, redirect: 'manual' };
  for (let i = 0; i <= maxRedirects; i++) {
    if (!(await isDeliverableUrl(url))) throw new DestinoNaoPermitido();
    const res = await fetch(url, atual);
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    url = new URL(location, url).toString();
    if (res.status === 301 || res.status === 302 || res.status === 303) {
      const semCorpo: RequestInit = { ...atual, method: 'GET' };
      delete (semCorpo as { body?: unknown }).body;
      atual = semCorpo;
    }
  }
  throw new DestinoNaoPermitido();
}
