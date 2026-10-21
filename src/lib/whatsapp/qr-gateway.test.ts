import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayRequestError, isGatewayThrottled, sendViaGateway } from './qr-gateway'

describe('sendViaGateway priority', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    process.env.WA_GATEWAY_URL = 'http://gateway.test:3201'
    process.env.WA_GATEWAY_SECRET = 'shh'
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ message_id: 'M' }), { status: 200 }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('defaults to interactive', async () => {
    await sendViaGateway({ accountId: 'a', to: '5511999990000', text: 'oi' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ priority: 'interactive' })
  })

  it('forwards bulk and waits longer for the gateway queue than for an interactive send', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    await sendViaGateway({ accountId: 'a', to: '5511999990000', text: 'oi' })
    await sendViaGateway({ accountId: 'a', to: '5511999990000', text: 'oi', priority: 'bulk' })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ priority: 'bulk' })
    const delays = spy.mock.calls.map((c) => c[1])
    expect(delays).toContain(30_000)
    expect(delays).toContain(150_000)
  })

  it('maps 429 throttled to a GatewayRequestError with pt-BR copy', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'throttled', message: 'fila cheia' }), { status: 429 }),
    )
    const err = await sendViaGateway({ accountId: 'a', to: '5511999990000', text: 'oi', priority: 'bulk' }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(GatewayRequestError)
    expect(isGatewayThrottled(err)).toBe(true)
    expect((err as GatewayRequestError).status).toBe(429)
    expect((err as GatewayRequestError).message).toMatch(/fila/i)
    expect(isGatewayThrottled(new GatewayRequestError('x', 409, 'not_connected'))).toBe(false)
  })
})
