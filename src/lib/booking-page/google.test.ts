import { describe, expect, it, vi } from 'vitest'

import { googleAuthUrl, googleUser, signGoogleState, verifyGoogleState } from './google'

const SECRET = 'c'.repeat(64)
const NONCE = 'a'.repeat(32)
const ENV = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' }

describe('Google state', () => {
  const now = 1_700_000_000_000
  const state = signGoogleState({ slug: 'barbearia-do-joao', nonce: NONCE, now }, SECRET)

  it('gives back the page only with the same nonce, in time', () => {
    expect(verifyGoogleState(state, NONCE, { now, secret: SECRET })).toBe('barbearia-do-joao')
  })
  it('refuses another nonce, an old state, another key or a tampered one', () => {
    expect(verifyGoogleState(state, 'b'.repeat(32), { now, secret: SECRET })).toBeNull()
    expect(verifyGoogleState(state, NONCE, { now: now + 11 * 60_000, secret: SECRET })).toBeNull()
    expect(verifyGoogleState(state, NONCE, { now, secret: 'd'.repeat(64) })).toBeNull()
    const forged = Buffer.from(JSON.stringify({ s: 'outra-pagina', n: NONCE, t: now })).toString('base64url')
    expect(verifyGoogleState(`${forged}.${state.split('.')[1]}`, NONCE, { now, secret: SECRET })).toBeNull()
    expect(verifyGoogleState(state, undefined, { now, secret: SECRET })).toBeNull()
  })
  it('asks Google only for openid, e-mail and profile', () => {
    const url = new URL(googleAuthUrl({ clientId: 'cid', redirectUri: 'https://x/api/agendar/google/retorno', state }))
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(url.searchParams.get('state')).toBe(state)
  })
})

describe('googleUser', () => {
  const answer = (userinfo: object) =>
    vi.fn(async (url: string | URL | Request) =>
      String(url).includes('token')
        ? new Response(JSON.stringify({ access_token: 'at' }), { status: 200 })
        : new Response(JSON.stringify(userinfo), { status: 200 }),
    ) as unknown as typeof fetch

  it('returns the verified account, e-mail in lowercase', async () => {
    const user = await googleUser(
      { code: 'c', redirectUri: 'r' },
      { env: ENV, fetch: answer({ sub: '123', email: 'Ana@Gmail.com', email_verified: true, name: 'Ana' }) },
    )
    expect(user).toEqual({ sub: '123', email: 'ana@gmail.com', name: 'Ana' })
  })
  it('refuses an e-mail Google did not verify, a failed exchange, or no Google client', async () => {
    expect(
      await googleUser({ code: 'c', redirectUri: 'r' }, { env: ENV, fetch: answer({ sub: '1', email: 'a@b.com', email_verified: false }) }),
    ).toBeNull()
    const refused = vi.fn(async () => new Response('{}', { status: 400 })) as unknown as typeof fetch
    expect(await googleUser({ code: 'c', redirectUri: 'r' }, { env: ENV, fetch: refused })).toBeNull()
    expect(await googleUser({ code: 'c', redirectUri: 'r' }, { env: {}, fetch: refused })).toBeNull()
  })
})
