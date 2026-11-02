import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runSpy = vi.hoisted(() => vi.fn(async () => ({ woken: 3, notified: 2, errors: 0 })))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))
const alertsSpy = vi.hoisted(() => vi.fn(async () => ({ claimed: 1, notified: 1, errors: 0 })))
vi.mock('@/lib/conversations/snooze-wake', () => ({ runSnoozeWake: runSpy }))
vi.mock('@/lib/conversations/manager-alerts', () => ({ runManagerAlerts: alertsSpy }))

import { GET, POST } from './route'

const req = (secret?: string) =>
  new Request('http://127.0.0.1:3000/api/inbox/snooze/cron', {
    headers: secret === undefined ? {} : { 'x-cron-secret': secret },
  })

describe('GET /api/inbox/snooze/cron', () => {
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
    const res = await GET(req('s3cret'))
    expect(res.status).toBe(503)
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('401 on a missing or wrong secret (any length)', async () => {
    for (const s of [undefined, '', 's3cre', 's3creT', 's3cret-longer']) {
      expect((await GET(req(s))).status).toBe(401)
    }
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('runs the wake and the manager alerts with the service client (GET and POST)', async () => {
    const res = await GET(req('s3cret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      woken: 3,
      notified: 2,
      errors: 0,
      alerts: { claimed: 1, notified: 1, errors: 0 },
    })
    expect(runSpy).toHaveBeenCalledWith({ admin: true })
    expect(alertsSpy).toHaveBeenCalledWith({ admin: true })
    expect((await POST(req('s3cret'))).status).toBe(200)
  })

  it('a failing alerts run never fails the wake', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    alertsSpy.mockRejectedValueOnce(new Error('boom'))
    const res = await GET(req('s3cret'))
    expect(res.status).toBe(200)
    expect((await res.json()).alerts).toEqual({ claimed: 0, notified: 0, errors: 1 })
    err.mockRestore()
  })

  it('500 without leaking the error detail', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    runSpy.mockRejectedValueOnce(new Error('password=hunter2 at db.internal'))
    const res = await GET(req('s3cret'))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('hunter2')
    err.mockRestore()
  })
})
