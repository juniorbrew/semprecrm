// ============================================================
// Página de agendamento (115) — "Continuar com Google".
//
//   iniciar   /api/agendar/google/iniciar?pagina=<slug> → signed state {slug,
//             nonce, time} + the nonce in an HttpOnly cookie → Google consent
//             (openid email profile).
//   retorno   /api/agendar/google/retorno (ONE fixed address registered in the
//             Google Cloud client the calendar sync already uses) → state +
//             nonce + age checked → code exchanged → userinfo → only a
//             Google-verified e-mail is accepted → identity → session.
//
// Same GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET as the calendar sync.
// ============================================================

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { providerCredentials } from '@/lib/calendar/sync/config'
import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL } from '@/lib/calendar/sync/google'

import { isValidSlug } from './core'

export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
export const GOOGLE_NONCE_COOKIE = 'sc_agendar_google'
export const GOOGLE_STATE_MAX_AGE_MS = 10 * 60_000
export const GOOGLE_CALLBACK_PATH = '/api/agendar/google/retorno'

export function googleConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!providerCredentials('google', env)
}

function stateKey(secret: string | undefined = process.env.ENCRYPTION_KEY): Buffer {
  const hex = (secret ?? '').trim()
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('ENCRYPTION_KEY must be 64 hex chars to sign the Google state')
  return createHmac('sha256', Buffer.from(hex, 'hex')).update('booking-google-state:v1').digest()
}

const sign = (payload: string, secret?: string) => createHmac('sha256', stateKey(secret)).update(payload).digest('hex')

export function newNonce(): string {
  return randomBytes(16).toString('hex')
}

export function signGoogleState(input: { slug: string; nonce: string; now?: number }, secret?: string): string {
  const payload = Buffer.from(JSON.stringify({ s: input.slug, n: input.nonce, t: input.now ?? Date.now() }), 'utf8').toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

/** The slug, when the signature, age and nonce (from the cookie) all match; else null. */
export function verifyGoogleState(
  state: string | null | undefined,
  nonce: string | null | undefined,
  opts: { now?: number; secret?: string } = {},
): string | null {
  if (typeof state !== 'string' || state.length > 1024 || typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) return null
  const dot = state.indexOf('.')
  if (dot <= 0) return null
  const payload = state.slice(0, dot)
  let expected: string
  try {
    expected = sign(payload, opts.secret)
  } catch {
    return null
  }
  const a = Buffer.from(state.slice(dot + 1), 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let body: { s?: unknown; n?: unknown; t?: unknown }
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof body.s !== 'string' || !isValidSlug(body.s) || body.n !== nonce || typeof body.t !== 'number') return null
  const now = opts.now ?? Date.now()
  if (body.t > now + 60_000 || now - body.t > GOOGLE_STATE_MAX_AGE_MS) return null
  return body.s
}

export function googleAuthUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: input.state,
    prompt: 'select_account',
  })
  return `${GOOGLE_AUTH_URL}?${q}`
}

export interface GoogleUser {
  sub: string
  email: string
  name: string | null
}

/** Code → access token → userinfo. Null when Google refuses or the e-mail is not verified. */
export async function googleUser(
  input: { code: string; redirectUri: string },
  deps: { fetch?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<GoogleUser | null> {
  const creds = providerCredentials('google', deps.env ?? process.env)
  if (!creds) return null
  const f = deps.fetch ?? fetch
  const token = await f(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: input.code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!token.ok) return null
  const accessToken = ((await token.json()) as { access_token?: unknown }).access_token
  if (typeof accessToken !== 'string') return null
  const info = await f(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!info.ok) return null
  const u = (await info.json()) as { sub?: unknown; email?: unknown; email_verified?: unknown; name?: unknown }
  if (typeof u.sub !== 'string' || !u.sub || typeof u.email !== 'string' || u.email_verified !== true) return null
  return { sub: u.sub, email: u.email.toLowerCase(), name: typeof u.name === 'string' ? u.name : null }
}
