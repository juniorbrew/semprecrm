import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runSpy = vi.hoisted(() => vi.fn(async () => ({ claimed: 2, sent: 1, failed: 1 })))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))
vi.mock('@/lib/scheduled-messages/dispatch', () => ({ runScheduledDispatch: runSpy }))

import { GET, POST } from './route'

const req = (secret?: string) =>
  new Request('http://127.0.0.1:3000/api/inbox/scheduled/cron', {
    headers: secret === undefined ? {} : { 'x-cron-secret': secret },
  })

describe('GET /api/inbox/scheduled/cron', () => {
  const prev = process.env.AUTOMATION_CRON_SECRET
  beforeEach(() => {
    process.env.AUTOMATION_CRON_SECRET = 's3cret'
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.AUTOMATION_CRON_SECRET
    else process.env.AUTOMATION_CRON_SECRET = prev
  })

  it('503 when the secret is not configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    expect((await GET(req('s3cret'))).status).toBe(503)
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('401 on a missing or wrong secret', async () => {
    for (const s of [undefined, '', 's3cre', 's3creT', 's3cret-longer']) {
      expect((await GET(req(s))).status).toBe(401)
    }
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('dispatches with the service client (GET and POST)', async () => {
    const res = await GET(req('s3cret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ claimed: 2, sent: 1, failed: 1 })
    expect((await POST(req('s3cret'))).status).toBe(200)
    expect(runSpy).toHaveBeenCalledTimes(2)
  })

  it('500 when the dispatch throws', async () => {
    runSpy.mockRejectedValueOnce(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await GET(req('s3cret'))).status).toBe(500)
    spy.mockRestore()
  })
})
