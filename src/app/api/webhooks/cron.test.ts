import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rpcs: [] as string[], dispatchFails: false, purgeFails: false }))

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: async (fn: string) => {
      h.rpcs.push(fn)
      if (h.purgeFails && fn === 'webhook_purge') throw new Error('purge down')
      return { data: 2, error: null }
    },
  }),
}))
vi.mock('@/lib/webhooks/dispatcher', () => ({
  runDispatch: async () => {
    if (h.dispatchFails) throw new Error('claim failed')
    return { claimed: 1, delivered: 1, retrying: 0, failed: 0, held: 0, errors: 0 }
  },
}))

import { GET } from './cron/route'

const req = () => new Request('https://app.test/api/webhooks/cron', { headers: { 'x-cron-secret': 's3cret' } })

describe('GET /api/webhooks/cron', () => {
  beforeEach(() => {
    process.env.AUTOMATION_CRON_SECRET = 's3cret'
    h.rpcs = []
    h.dispatchFails = false
    h.purgeFails = false
  })
  afterEach(() => vi.restoreAllMocks())

  it('rejects a wrong secret', async () => {
    const res = await GET(new Request('https://app.test/api/webhooks/cron', { headers: { 'x-cron-secret': 'nope' } }))
    expect(res.status).toBe(401)
    expect(h.rpcs).toEqual([])
  })

  it('dispatches and purges', async () => {
    const res = await GET(req())
    expect(await res.json()).toMatchObject({ delivered: 1, purged: 4 })
    expect(h.rpcs).toEqual(['webhook_purge', 'api_purge'])
  })

  it('still runs both purges when the dispatch pass throws (then reports the failure)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    h.dispatchFails = true
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(h.rpcs).toEqual(['webhook_purge', 'api_purge'])
  })

  it('one failing purge does not skip the other', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    h.purgeFails = true
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(h.rpcs).toEqual(['webhook_purge', 'api_purge'])
  })
})
