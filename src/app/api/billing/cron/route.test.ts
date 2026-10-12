import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn(async () => ({ data: 2, error: null as { message: string } | null })))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({ rpc }) }))

import { GET } from './route'

const req = (secret?: string) =>
  new Request('http://127.0.0.1:3000/api/billing/cron', {
    headers: secret === undefined ? {} : { 'x-cron-secret': secret },
  })

describe('GET /api/billing/cron', () => {
  beforeEach(() => {
    rpc.mockClear()
    vi.stubEnv('AUTOMATION_CRON_SECRET', 's3cret')
  })

  it('needs the cron secret', async () => {
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req('wrong!'))).status).toBe(401)
    vi.stubEnv('AUTOMATION_CRON_SECRET', '')
    expect((await GET(req('s3cret'))).status).toBe(503)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('runs the expiry sweep', async () => {
    const res = await GET(req('s3cret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ expired: 2 })
    expect(rpc).toHaveBeenCalledWith('billing_expire_lapsed')
  })
})
