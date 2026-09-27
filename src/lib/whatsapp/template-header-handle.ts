import { uploadResumableMedia } from '@/lib/whatsapp/meta-api'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import { isRelativeMediaUrl, mediaUrlForServer } from '@/lib/storage/media-url'
import { fetchSeguro } from '@/lib/webhooks/ssrf'

/**
 * Meta requires an `example.header_handle` (from the Resumable Upload
 * API) to create/edit a template with an IMAGE header — a plain public
 * URL is not accepted at creation time. This helper turns the template's
 * `header_media_url` (whether the user uploaded a file or pasted a link)
 * into a handle and writes it onto the payload, so both the upload path
 * and the legacy URL path actually succeed.
 *
 * No-op unless the header is an image that has a URL but no handle yet.
 * Image-only for now (the #230 scope); video/document handles can follow
 * the same shape.
 */

// Meta's image-header sample limits.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png']

export async function ensureImageHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
): Promise<void> {
  if (payload.header_type !== 'image') return
  if (payload.header_handle) return // already have one
  if (!payload.header_media_url) return // validator already requires url-or-handle

  const appId = process.env.META_APP_ID
  if (!appId) {
    throw new Error(
      'Image-header templates need META_APP_ID set (used for Meta’s Resumable Upload). Add it to your environment, or remove the image header.',
    )
  }

  // Fetch the sample image bytes (works for our uploaded chat-media URL —
  // possibly origin-relative, resolved through the internal Supabase route —
  // and for a manually-pasted public link).
  // SSRF guard (wacrm GHSA-6fr5). Uma URL ABSOLUTA foi colada por alguém e o
  // fetch é do servidor: fetchSeguro recusa destino interno (loopback, rede
  // privada, metadata de nuvem) antes de sair e a cada redirect. A URL
  // RELATIVA é mídia do próprio SempreCRM e vai pela rota interna do storage
  // (mediaUrlForServer) — mas só para o caminho de objeto público do storage,
  // senão `/supabase/../rest/v1/…` alcançaria qualquer rota do gateway interno.
  // Toda recusa usa a mensagem do host inalcançável (a falha não vira oráculo).
  const INALCANCAVEL = 'Could not fetch the header image URL. Make sure it is publicly reachable.'
  let res: Response
  try {
    if (isRelativeMediaUrl(payload.header_media_url)) {
      // O caminho é conferido ANTES de resolver (normalizado, sem `..`), contra
      // o prefixo público do Supabase: vale com SUPABASE_INTERNAL_URL ou só com
      // NEXT_PUBLIC_SITE_URL, as duas formas que mediaUrlForServer aceita.
      const caminho = new URL(payload.header_media_url, 'http://x').pathname
      const publico = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? ''
      const prefixo = publico.startsWith('/') ? publico.replace(/\/+$/, '') : ''
      if (!caminho.startsWith(`${prefixo}/storage/v1/object/public/`)) throw new Error(INALCANCAVEL)
      res = await fetch(mediaUrlForServer(caminho), { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    } else {
      res = await fetchSeguro(payload.header_media_url, { signal: AbortSignal.timeout(10_000) })
    }
  } catch {
    throw new Error('Could not fetch the header image URL. Make sure it is publicly reachable.')
  }
  if (!res.ok) {
    throw new Error(`Header image URL returned ${res.status}. It must be publicly reachable.`)
  }

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (contentType && !ALLOWED_IMAGE_TYPES.includes(contentType)) {
    throw new Error(`Header image must be JPEG or PNG (got ${contentType}).`)
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new Error('Header image is empty.')
  }
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    throw new Error(
      `Header image is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — Meta's limit is 5 MB.`,
    )
  }

  const mimeType = ALLOWED_IMAGE_TYPES.includes(contentType) ? contentType : 'image/jpeg'
  const fileName = mimeType === 'image/png' ? 'header.png' : 'header.jpg'

  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName,
    mimeType,
    bytes,
  })
  payload.header_handle = handle
}
