/**
 * Media URL helpers for the same-origin Supabase setup.
 *
 * When `NEXT_PUBLIC_SUPABASE_URL` is a path (`/supabase`, proxied by nginx
 * in front of the app) the browser's `getPublicUrl()` yields
 * `http://<whatever origin the user opened>/supabase/storage/v1/object/public/...`.
 * Persisting that would pin the row to one hostname (localhost vs LAN IP vs
 * VPN), so we store the ORIGIN-RELATIVE path instead and re-absolutise it
 * only where an absolute URL is unavoidable:
 *
 *   - `toStoredMediaUrl`   browser, right after `getPublicUrl()` → what goes in the DB
 *   - `accountMediaUrlForServer` / `storageUrlForServer`  server code that
 *                          must FETCH the bytes (or hand the URL to the
 *                          WhatsApp gateway) — validated, see below
 *   - `mediaUrlForPublic`  links handed to third parties (Meta Cloud API
 *                          `link` fields, web-push icons)
 *
 * `<img src>`, `<audio src>` and `<a href>` resolve relative paths natively,
 * so renderers need no help. `toStoredMediaUrl` and `mediaUrlForPublic` are
 * no-ops for absolute URLs (Meta CDN links, pre-existing rows, external logos).
 *
 * Client-safe: only `NEXT_PUBLIC_*` variables are read in the browser;
 * `SUPABASE_INTERNAL_URL` is only meaningful on the server.
 */

import { isRelativeSupabaseUrl } from '@/lib/supabase/public-url'

export interface MediaUrlEnv {
  NEXT_PUBLIC_SUPABASE_URL?: string
  SUPABASE_INTERNAL_URL?: string
  NEXT_PUBLIC_SITE_URL?: string
}

/**
 * `process.env` is typed as `ProcessEnv` (an index signature) which TS
 * refuses to assign to a bag of optional named keys. In the browser Next
 * inlines each `process.env.NEXT_PUBLIC_*` access individually, so the
 * keys are read one by one rather than spreading the object.
 */
function defaultEnv(): MediaUrlEnv {
  return {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_INTERNAL_URL: process.env.SUPABASE_INTERNAL_URL,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  }
}

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

/** A single leading slash — not `//host` (protocol-relative) and not a scheme. */
export function isRelativeMediaUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')
}

/**
 * Normalise a URL produced by the browser Supabase client for storage in
 * the database. When the URL points at the page's own origin (the
 * same-origin proxy case) only the path is kept:
 *
 *   http://192.168.1.10:3101/supabase/storage/v1/object/public/chat-media/x.png
 *   → /supabase/storage/v1/object/public/chat-media/x.png
 *
 * Anything else (absolute Supabase host, foreign URL) is returned as is.
 * Safe to call on the server: without a `window` it is a no-op.
 */
export function toStoredMediaUrl(url: string, origin?: string): string {
  const base =
    origin ?? (typeof window !== 'undefined' ? window.location?.origin : undefined)
  if (!base || !url) return url
  const o = trimSlashes(base)
  if (url === o) return '/'
  if (url.startsWith(o + '/')) return url.slice(o.length)
  return url
}

/**
 * Absolute URL for links handed to third parties that fetch them from the
 * outside (Meta Cloud API `link`, push-notification icons):
 *
 *   /supabase/storage/...  → NEXT_PUBLIC_SITE_URL + /supabase/storage/...
 *   https://anything       → unchanged
 *
 * In the browser (template preview, etc.) `window.location.origin` stands
 * in when `NEXT_PUBLIC_SITE_URL` is unset. On the server with no site URL
 * the path is returned unchanged rather than throwing — Meta will reject
 * it with a clear "link" error and, more importantly, an unrelated caller
 * (a text-only send) is never blocked by media config.
 */
export function mediaUrlForPublic(url: string, env: MediaUrlEnv = defaultEnv()): string {
  if (!isRelativeMediaUrl(url)) return url
  const site =
    env.NEXT_PUBLIC_SITE_URL?.trim() ||
    (typeof window !== 'undefined' ? window.location?.origin : undefined)
  if (!site) return url
  return trimSlashes(site) + url
}

// ------------------------------------------------------------
// Validação de URL de mídia para ENVIO (gateway do canal QR / Meta).
//
// O gateway entrega `media.url` ao Baileys, que abre como arquivo local
// tudo o que não for http(s)/data: — uma URL arbitrária vinda do cliente
// leria arquivos do servidor ou rede interna e mandaria os bytes para um
// número qualquer. Só passa mídia do NOSSO storage público:
//   (a) caminho relativo `${prefixo}/storage/v1/object/public/...`, ou
//   (b) URL absoluta numa origem configurada do Supabase com esse caminho;
// sem `..`, `//`, barra invertida, traversal codificado, CR/LF, query,
// fragmento ou credenciais. A saída é sempre reconstruída a partir do
// caminho do objeto sobre a base do servidor — nunca a string de entrada.
// ------------------------------------------------------------

export const STORAGE_PUBLIC_PATH = '/storage/v1/object/public/'

/** Buckets cujos objetos ficam em `account-<id>/…` (migrations 020/023). */
const ACCOUNT_MEDIA_BUCKETS = new Set(['chat-media', 'flow-media'])

/** URL de mídia recusada — a rota responde 400 com `message`. */
export class MediaUrlNaoPermitida extends Error {
  readonly code = 'invalid_media_url' as const
  readonly status = 400 as const
  constructor() {
    super('URL de mídia não permitida. Envie um arquivo pelo próprio SempreCRM (armazenamento da conta).')
    this.name = 'MediaUrlNaoPermitida'
  }
}

function relativeSupabasePrefix(env: MediaUrlEnv): string {
  return isRelativeSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL)
    ? trimSlashes(env.NEXT_PUBLIC_SUPABASE_URL)
    : ''
}

/** Bases absolutas pelas quais o storage pode ser referenciado. */
function storageBases(env: MediaUrlEnv): URL[] {
  const raw: string[] = []
  const pub = env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  if (pub && !isRelativeSupabaseUrl(pub)) raw.push(pub)
  if (env.SUPABASE_INTERNAL_URL?.trim()) raw.push(env.SUPABASE_INTERNAL_URL.trim())
  const site = env.NEXT_PUBLIC_SITE_URL?.trim()
  if (site && pub && isRelativeSupabaseUrl(pub)) raw.push(trimSlashes(site) + relativeSupabasePrefix(env))
  const out: URL[] = []
  for (const r of raw) {
    try {
      const u = new URL(r)
      if (u.protocol === 'http:' || u.protocol === 'https:') out.push(u)
    } catch {
      // base mal configurada: simplesmente não vale como origem
    }
  }
  return out
}

/**
 * Caminho do objeto (`/storage/v1/object/public/<bucket>/<...>`) de uma URL
 * de mídia do nosso storage; lança `MediaUrlNaoPermitida` para o resto.
 */
export function storageObjectPath(url: unknown, env: MediaUrlEnv = defaultEnv()): string {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) throw new MediaUrlNaoPermitida()
  // controle (CR/LF/NUL), espaço, barra invertida, query/fragmento, traversal codificado
  if (/[\x00-\x20\x7f\?#]/.test(url) || /%(2e|2f|5c|00)/i.test(url)) throw new MediaUrlNaoPermitida()

  let path: string
  if (url.startsWith('/') && !url.startsWith('//')) {
    path = url
    const prefix = relativeSupabasePrefix(env)
    if (!path.startsWith(prefix + STORAGE_PUBLIC_PATH)) throw new MediaUrlNaoPermitida()
    path = path.slice(prefix.length)
  } else {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new MediaUrlNaoPermitida()
    }
    if (u.username || u.password) throw new MediaUrlNaoPermitida()
    // o caminho CRU (o parser de URL já teria resolvido `..`)
    const rawPath = url.replace(/^https?:\/\/[^/]*/i, '')
    if (rawPath === url) throw new MediaUrlNaoPermitida() // outro esquema (file:, data:, ftp:…)
    const base = storageBases(env).find((b) => b.origin === u.origin)
    if (!base) throw new MediaUrlNaoPermitida()
    const basePath = trimSlashes(base.pathname)
    if (!rawPath.startsWith(basePath + STORAGE_PUBLIC_PATH)) throw new MediaUrlNaoPermitida()
    path = rawPath.slice(basePath.length)
  }

  const segments = path.slice(STORAGE_PUBLIC_PATH.length).split('/')
  // precisa de bucket + objeto; nenhum segmento vazio (`//`), `.` ou `..`
  if (segments.length < 2 || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new MediaUrlNaoPermitida()
  }
  return path
}

/** URL absoluta, alcançável pelo servidor (e pelo gateway), de um caminho de objeto. */
export function storageUrlForServer(objectPath: string, env: MediaUrlEnv = defaultEnv()): string {
  const internal = env.SUPABASE_INTERNAL_URL?.trim()
  if (internal) return trimSlashes(internal) + objectPath
  const pub = env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  if (pub && !isRelativeSupabaseUrl(pub)) return trimSlashes(pub) + objectPath
  const site = env.NEXT_PUBLIC_SITE_URL?.trim()
  if (site) return trimSlashes(site) + relativeSupabasePrefix(env) + objectPath
  throw new Error('Storage inalcançável pelo servidor: defina SUPABASE_INTERNAL_URL ou NEXT_PUBLIC_SITE_URL.')
}

/**
 * Valida a mídia de um ENVIO: além de ser do nosso storage, o objeto tem de
 * estar num bucket de mídia da conta e na pasta `account-<accountId>/` de
 * quem envia. Devolve o caminho do objeto.
 */
export function assertAccountMediaUrl(
  url: unknown,
  accountId: string,
  env: MediaUrlEnv = defaultEnv(),
): string {
  const objectPath = storageObjectPath(url, env)
  const [bucket, folder] = objectPath.slice(STORAGE_PUBLIC_PATH.length).split('/')
  if (!ACCOUNT_MEDIA_BUCKETS.has(bucket) || !accountId || folder !== `account-${accountId}`) {
    throw new MediaUrlNaoPermitida()
  }
  return objectPath
}

/** `assertAccountMediaUrl` + a URL que o servidor/gateway busca. */
export function accountMediaUrlForServer(
  url: unknown,
  accountId: string,
  env: MediaUrlEnv = defaultEnv(),
): string {
  return storageUrlForServer(assertAccountMediaUrl(url, accountId, env), env)
}
