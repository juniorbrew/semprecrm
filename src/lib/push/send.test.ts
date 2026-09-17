import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// web-push is mocked wholesale: no crypto, no network. `WebPushError`
// keeps the real shape (statusCode) so `isGoneError` sees what it would
// see in production.
const { sendNotification, setVapidDetails, FakeWebPushError } = vi.hoisted(() => {
  class FakeWebPushError extends Error {
    statusCode: number
    constructor(statusCode: number) {
      super(`push ${statusCode}`)
      this.statusCode = statusCode
    }
  }
  return { sendNotification: vi.fn(), setVapidDetails: vi.fn(), FakeWebPushError }
})
vi.mock('web-push', () => ({
  default: { sendNotification, setVapidDetails },
  WebPushError: FakeWebPushError,
}))

import {
  _resetVapidForTests,
  buildPushMessage,
  isGoneError,
  readVapidConfig as readVapidConfigTyped,
  sendPushToUsers,
  truncateBody,
} from './send'

const readVapidConfig = (env: Record<string, string>) =>
  readVapidConfigTyped(env as NodeJS.ProcessEnv)

interface Row {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
}

/** Minimal chainable admin client over an in-memory subscriptions table. */
function makeAdmin(rows: Row[]) {
  const deleted: string[] = []
  const stamped: string[] = []
  const admin = {
    from(table: string) {
      expect(table).toBe('push_subscriptions')
      let op: 'select' | 'delete' | 'update' = 'select'
      const b = {
        select: () => b,
        delete: () => ((op = 'delete'), b),
        update: () => ((op = 'update'), b),
        in: (col: string, ids: string[]) => {
          if (op === 'select') {
            return Promise.resolve({
              data: rows.filter((r) => ids.includes(r.user_id)),
              error: null,
            })
          }
          if (op === 'delete') deleted.push(...ids)
          if (op === 'update') stamped.push(...ids)
          return Promise.resolve({ data: null, error: null })
        },
      }
      return b
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: admin as any, deleted, stamped }
}

const ROWS: Row[] = [
  { id: 's1', user_id: 'u1', endpoint: 'https://push.example/1', p256dh: 'p1', auth: 'a1' },
  { id: 's2', user_id: 'u1', endpoint: 'https://push.example/2', p256dh: 'p2', auth: 'a2' },
  { id: 's3', user_id: 'u2', endpoint: 'https://push.example/3', p256dh: 'p3', auth: 'a3' },
]

const PAYLOAD = { title: 'Maria', body: 'Olá, tudo bem?', url: '/inbox?c=abc', tag: 'conversation:abc' }

describe('readVapidConfig', () => {
  it('needs all three variables and a mailto:/https: subject', () => {
    expect(readVapidConfig({})).toBeNull()
    expect(
      readVapidConfig({ NEXT_PUBLIC_VAPID_PUBLIC_KEY: 'pk', VAPID_PRIVATE_KEY: 'sk' }),
    ).toBeNull()
    expect(
      readVapidConfig({
        NEXT_PUBLIC_VAPID_PUBLIC_KEY: 'pk',
        VAPID_PRIVATE_KEY: 'sk',
        VAPID_SUBJECT: 'admin@x.test',
      }),
    ).toBeNull()
    expect(
      readVapidConfig({
        NEXT_PUBLIC_VAPID_PUBLIC_KEY: ' pk ',
        VAPID_PRIVATE_KEY: 'sk',
        VAPID_SUBJECT: 'mailto:admin@x.test',
      }),
    ).toEqual({ publicKey: 'pk', privateKey: 'sk', subject: 'mailto:admin@x.test' })
  })
})

describe('buildPushMessage / truncateBody', () => {
  it('produces the JSON the service worker expects', () => {
    const msg = JSON.parse(buildPushMessage(PAYLOAD))
    expect(msg).toEqual({
      title: 'Maria',
      body: 'Olá, tudo bem?',
      tag: 'conversation:abc',
      data: { url: '/inbox?c=abc' },
    })
  })

  it('omits optional keys and collapses whitespace in the body', () => {
    const msg = JSON.parse(buildPushMessage({ title: 'T', body: '  a\n\n b   c ', url: '/x' }))
    expect(msg).toEqual({ title: 'T', body: 'a b c', data: { url: '/x' } })
    expect('tag' in msg).toBe(false)
    expect('icon' in msg).toBe(false)
  })

  it('absolutises an origin-relative icon for the service worker', () => {
    const prev = process.env.NEXT_PUBLIC_SITE_URL
    process.env.NEXT_PUBLIC_SITE_URL = 'https://crm.example.com/'
    try {
      const msg = JSON.parse(
        buildPushMessage({ ...PAYLOAD, icon: '/supabase/storage/v1/object/public/avatars/u/a.png' }),
      )
      expect(msg.icon).toBe('https://crm.example.com/supabase/storage/v1/object/public/avatars/u/a.png')
      expect(JSON.parse(buildPushMessage({ ...PAYLOAD, icon: 'https://cdn/x.png' })).icon).toBe('https://cdn/x.png')
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_SITE_URL
      else process.env.NEXT_PUBLIC_SITE_URL = prev
    }
  })

  it('truncates long bodies with an ellipsis', () => {
    const long = 'x'.repeat(500)
    const out = truncateBody(long)
    expect(out.length).toBe(160)
    expect(out.endsWith('…')).toBe(true)
    expect(truncateBody('short')).toBe('short')
    expect(truncateBody(null)).toBe('')
  })
})

describe('isGoneError', () => {
  it('is true for 404 / 410 only', () => {
    expect(isGoneError(new FakeWebPushError(404))).toBe(true)
    expect(isGoneError(new FakeWebPushError(410))).toBe(true)
    expect(isGoneError(new FakeWebPushError(500))).toBe(false)
    expect(isGoneError(new FakeWebPushError(429))).toBe(false)
    expect(isGoneError(new Error('boom'))).toBe(false)
    expect(isGoneError({ statusCode: 410 })).toBe(true)
  })
})

describe('sendPushToUsers', () => {
  const ENV = {
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: 'pk',
    VAPID_PRIVATE_KEY: 'sk',
    VAPID_SUBJECT: 'mailto:admin@semprecrm.local',
  }

  beforeEach(() => {
    _resetVapidForTests()
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', ENV.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
    vi.stubEnv('VAPID_PRIVATE_KEY', ENV.VAPID_PRIVATE_KEY)
    vi.stubEnv('VAPID_SUBJECT', ENV.VAPID_SUBJECT)
    sendNotification.mockReset()
    setVapidDetails.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('is a no-op without VAPID configuration', async () => {
    vi.stubEnv('VAPID_PRIVATE_KEY', '')
    _resetVapidForTests()
    const { admin } = makeAdmin(ROWS)
    const res = await sendPushToUsers(admin, ['u1'], PAYLOAD)
    expect(res.configured).toBe(false)
    expect(res.sent).toBe(0)
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('sends to every subscription of the given users and stamps last_used_at', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 })
    const { admin, stamped, deleted } = makeAdmin(ROWS)
    const res = await sendPushToUsers(admin, ['u1', 'u2', 'u1'], PAYLOAD)

    expect(setVapidDetails).toHaveBeenCalledWith('mailto:admin@semprecrm.local', 'pk', 'sk')
    expect(sendNotification).toHaveBeenCalledTimes(3)
    const [subArg, msgArg, optsArg] = sendNotification.mock.calls[0]
    expect(subArg).toEqual({
      endpoint: 'https://push.example/1',
      keys: { p256dh: 'p1', auth: 'a1' },
    })
    expect(JSON.parse(msgArg)).toEqual({
      title: 'Maria',
      body: 'Olá, tudo bem?',
      tag: 'conversation:abc',
      data: { url: '/inbox?c=abc' },
    })
    expect(optsArg).toEqual({ TTL: 3600 })

    expect(res).toEqual({ users: 2, sent: 3, failed: 0, removed: 0, configured: true })
    expect(stamped.sort()).toEqual(['s1', 's2', 's3'])
    expect(deleted).toEqual([])
  })

  it('deletes subscriptions whose endpoint answers 404 / 410 and counts other failures', async () => {
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith('/1')) throw new FakeWebPushError(410)
      if (sub.endpoint.endsWith('/2')) throw new FakeWebPushError(404)
      if (sub.endpoint.endsWith('/3')) throw new FakeWebPushError(500)
      return { statusCode: 201 }
    })
    const { admin, stamped, deleted } = makeAdmin(ROWS)
    const res = await sendPushToUsers(admin, ['u1', 'u2'], PAYLOAD)

    expect(res).toEqual({ users: 2, sent: 0, failed: 1, removed: 2, configured: true })
    expect(deleted.sort()).toEqual(['s1', 's2'])
    expect(stamped).toEqual([])
  })

  it('returns zeros for an empty recipient list without touching the DB', async () => {
    const from = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await sendPushToUsers({ from } as any, [], PAYLOAD)
    expect(res.sent).toBe(0)
    expect(from).not.toHaveBeenCalled()
  })
})
