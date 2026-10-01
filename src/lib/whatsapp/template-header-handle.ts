import { uploadResumableMedia } from '@/lib/whatsapp/meta-api'
import { MEDIA_HEADER_SPECS, isMediaHeaderKind } from '@/lib/whatsapp/media-header-types'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import { isRelativeMediaUrl, storageObjectPath, storageUrlForServer } from '@/lib/storage/media-url'
import { fetchSeguro } from '@/lib/webhooks/ssrf'

/**
 * Meta requires an `example.header_handle` (from the Resumable Upload
 * API) to create/edit a template with a media header — IMAGE, VIDEO or
 * DOCUMENT alike. A plain public URL is not accepted at creation time
 * and fails with "Invalid parameter" (wacrm #230 for images, #562 /
 * upstream 8223896 for the other two). This helper turns the template's
 * `header_media_url` (whether the user uploaded a file or pasted a link)
 * into a handle and writes it onto the payload, so both the upload path
 * and the legacy URL path actually succeed.
 *
 * No-op unless the header is a media header that has a URL but no handle
 * yet. Accepted formats and size ceilings per kind live in
 * `media-header-types.ts` and mirror Meta's Cloud API media reference.
 */

/**
 * Read a response body, aborting as soon as it exceeds `maxBytes`.
 * Falls back to arrayBuffer() (still size-checked) when there is no
 * readable stream.
 */
async function readCapped(
  res: Response,
  maxBytes: number,
  tooLarge: (size: number) => Error,
): Promise<Uint8Array> {
  const reader = res.body?.getReader()
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > maxBytes) throw tooLarge(buf.byteLength)
    return buf
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw tooLarge(total)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

export async function ensureMediaHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
): Promise<void> {
  const kind = payload.header_type
  if (!isMediaHeaderKind(kind)) return
  if (payload.header_handle) return // already have one
  if (!payload.header_media_url) return // validator already requires url-or-handle

  const spec = MEDIA_HEADER_SPECS[kind]

  const appId = process.env.META_APP_ID
  if (!appId) {
    throw new Error(
      'Media-header templates need META_APP_ID set (used for Meta’s Resumable Upload). Add it to your environment, or remove the media header.',
    )
  }

  // Fetch the sample bytes (works for our uploaded chat-media URL —
  // possibly origin-relative, resolved through the internal Supabase route —
  // and for a manually-pasted public link).
  // SSRF guard (wacrm GHSA-6fr5). Uma URL ABSOLUTA foi colada por alguém e o
  // fetch é do servidor: fetchSeguro recusa destino interno (loopback, rede
  // privada, metadata de nuvem) antes de sair e a cada redirect. A URL
  // RELATIVA é mídia do próprio SempreCRM e vai pela rota interna do storage
  // (storageUrlForServer) — mas só para o caminho de objeto público do storage,
  // senão `/supabase/../rest/v1/…` alcançaria qualquer rota do gateway interno.
  // Toda recusa usa a mensagem do host inalcançável (a falha não vira oráculo)
  // — a MESMA para imagem, vídeo e documento, senão o tipo vira um bit a mais.
  const INALCANCAVEL = 'Could not fetch the header media URL. Make sure it is publicly reachable.'
  let res: Response
  try {
    if (isRelativeMediaUrl(payload.header_media_url)) {
      // Mesma régua do envio de mídia (storageObjectPath): só objeto público
      // do storage, sem `..`/`//`/traversal codificado; a URL buscada é
      // reconstruída sobre a rota interna (ou NEXT_PUBLIC_SITE_URL).
      const objeto = storageObjectPath(payload.header_media_url)
      res = await fetch(storageUrlForServer(objeto), { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    } else {
      res = await fetchSeguro(payload.header_media_url, { signal: AbortSignal.timeout(10_000) })
    }
  } catch {
    throw new Error(INALCANCAVEL)
  }
  if (!res.ok) {
    throw new Error(`Header ${kind} URL returned ${res.status}. It must be publicly reachable.`)
  }

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (contentType && !spec.mimeTypes.includes(contentType)) {
    throw new Error(`Header ${kind} must be ${spec.formats} (got ${contentType}).`)
  }

  const tooLarge = (size: number) =>
    new Error(
      `Header ${kind} is ${(size / 1024 / 1024).toFixed(1)} MB — Meta's limit is ${spec.maxBytes / 1024 / 1024} MB.`,
    )

  // Refuse before downloading when the server announces the size, and
  // never buffer more than the limit even when it doesn't (or lies): a
  // pasted link must not make the server hold an arbitrary body in memory.
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > spec.maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    throw tooLarge(declared)
  }
  const bytes = await readCapped(res, spec.maxBytes, tooLarge)
  if (bytes.byteLength === 0) {
    throw new Error(`Header ${kind} is empty.`)
  }

  // A sample served without a Content-Type is assumed to be the kind's
  // most common format (JPEG / MP4 / PDF).
  const mimeType = spec.mimeTypes.includes(contentType) ? contentType : spec.mimeTypes[0]
  const fileName = `header.${spec.extensions[mimeType]}`

  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName,
    mimeType,
    bytes,
  })
  payload.header_handle = handle
}
