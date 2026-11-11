// The only place a Conversions API request leaves the server. Server only.
import { META_GRAPH_VERSION } from './payload'

export const SEND_TIMEOUT_MS = 10_000

export interface SendOutcome {
  ok: boolean
  /** Short, Portuguese, no personal data: stored in last_error and shown to the admin. */
  error: string | null
  /** Meta error code (190 = invalid / expired token). */
  code: number | null
  /** A later attempt may succeed. */
  retryable: boolean
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** Meta error code -> short Portuguese text. Never echoes Meta's message (it can contain request data). */
export function explainMetaError(code: number | null, status: number | null): { error: string; retryable: boolean } {
  if (code === 190) return { error: 'A chave de acesso é inválida ou venceu. Gere outra no Gerenciador de Eventos.', retryable: false }
  if (code === 100) return { error: 'A Meta recusou os dados do evento ou o ID do conjunto de dados.', retryable: false }
  if (code === 200 || code === 10 || code === 803) return { error: 'A chave de acesso não tem permissão para este conjunto de dados.', retryable: false }
  if (code === 4 || code === 17 || code === 32 || code === 613) return { error: 'A Meta pediu para esperar um pouco (muitos envios).', retryable: true }
  if (code === 1 || code === 2) return { error: 'A Meta teve um erro temporário.', retryable: true }
  if (status != null && status >= 500) return { error: 'A Meta está fora do ar no momento.', retryable: true }
  return { error: 'A Meta recusou o envio.', retryable: false }
}

export async function sendCapiEvents(opts: {
  datasetId: string
  token: string
  body: Record<string, unknown>
  fetchImpl?: FetchLike
}): Promise<SendOutcome> {
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
  try {
    const res = await doFetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(opts.datasetId)}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
      redirect: 'error',
    })
    const json = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null
    if (res.ok && !json?.error) return { ok: true, error: null, code: null, retryable: false }
    const code = typeof json?.error?.code === 'number' ? json.error.code : null
    const { error, retryable } = explainMetaError(code, res.status)
    return { ok: false, error, code, retryable }
  } catch (err) {
    const timeout = controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')
    return { ok: false, error: timeout ? 'A Meta demorou demais para responder.' : 'Não foi possível falar com a Meta.', code: null, retryable: true }
  } finally {
    clearTimeout(timer)
  }
}
