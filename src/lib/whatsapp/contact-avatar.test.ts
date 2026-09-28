import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AVATAR_REFRESH_MS,
  AVATAR_RETRY_MS,
  avatarPatch,
  isAvatarStale,
  isStoredContactAvatar,
  purgeDeletedContactAvatars,
  refreshContactAvatar,
  removeContactAvatarObjects,
  type AvatarFetcher,
} from './contact-avatar'
import { fetchContactAvatarViaGateway } from './qr-gateway'

const NOW = Date.parse('2026-09-27T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const STORED = '/supabase/storage/v1/object/public/contact-avatars/account-a/c?v=1'

describe('isAvatarStale', () => {
  it('is stale when never checked, unreadable, or a week old', () => {
    expect(isAvatarStale(null, NOW)).toBe(true)
    expect(isAvatarStale('garbage', NOW)).toBe(true)
    expect(isAvatarStale(iso(NOW - AVATAR_REFRESH_MS), NOW)).toBe(true)
    expect(isAvatarStale(iso(NOW - AVATAR_REFRESH_MS + 60_000), NOW)).toBe(false)
    expect(isAvatarStale(iso(NOW - 3_600_000), NOW)).toBe(false)
  })
})

describe('avatarPatch', () => {
  it('stores a new photo and stamps the check', () => {
    expect(avatarPatch({ kind: 'photo', url: STORED }, null, NOW)).toEqual({
      avatar_url: STORED,
      avatar_checked_at: iso(NOW),
    })
  })

  it('clears only our own stored copy when the photo is gone / private', () => {
    expect(avatarPatch({ kind: 'none' }, STORED, NOW)).toEqual({ avatar_url: null, avatar_checked_at: iso(NOW) })
    expect(avatarPatch({ kind: 'none' }, 'https://example.com/me.png', NOW)).toEqual({ avatar_checked_at: iso(NOW) })
    expect(avatarPatch({ kind: 'none' }, null, NOW)).toEqual({ avatar_checked_at: iso(NOW) })
  })

  it('re-arms an unavailable lookup to retry after an hour, not a week', () => {
    const patch = avatarPatch({ kind: 'unavailable', reason: 'throttled' }, STORED, NOW)
    expect(patch).toEqual({ avatar_checked_at: iso(NOW - AVATAR_REFRESH_MS + AVATAR_RETRY_MS) })
    expect(isAvatarStale(patch.avatar_checked_at, NOW + AVATAR_RETRY_MS - 1)).toBe(false)
    expect(isAvatarStale(patch.avatar_checked_at, NOW + AVATAR_RETRY_MS)).toBe(true)
  })

  it('recognises stored copies by bucket', () => {
    expect(isStoredContactAvatar(STORED)).toBe(true)
    expect(isStoredContactAvatar('https://x/storage/v1/object/public/avatars/u/a.png')).toBe(false)
    expect(isStoredContactAvatar(undefined)).toBe(false)
  })
})

// A PostgREST-ish recorder: the first `contacts` update (claim) resolves
// with `claim`, the second (write) with `write`.
function fakeDb(
  claim: { data: unknown; error?: { code?: string; message: string } | null },
  writeError: unknown = null,
  /** Rows the guarded write matched (empty = anonymised / deleted meanwhile). */
  writeRows: unknown[] = [{ id: 'contact-1' }],
) {
  const updates: { patch: Record<string, unknown>; ops: [string, ...unknown[]][] }[] = []
  const removed: [string, string[]][] = []
  const db = {
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          removed.push([bucket, paths])
          return { data: [], error: null }
        },
      }),
    },
    from(table: string) {
      expect(table).toBe('contacts')
      const entry = { patch: {} as Record<string, unknown>, ops: [] as [string, ...unknown[]][] }
      const b: Record<string, unknown> = {}
      for (const op of ['eq', 'is', 'or', 'select']) {
        b[op] = (...args: unknown[]) => (entry.ops.push([op, ...args]), b)
      }
      b.update = (patch: Record<string, unknown>) => ((entry.patch = patch), updates.push(entry), b)
      b.maybeSingle = async () => ({ data: claim.data, error: claim.error ?? null })
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: writeError ? null : writeRows, error: writeError }).then(res)
      return b
    },
  }
  return { db: db as never, updates, removed }
}

const INPUT = { accountId: 'acc-1', contactId: 'contact-1', phone: '5511988887777' }

describe('refreshContactAvatar', () => {
  it('claims atomically (stale or never checked, not anonymised) before calling the gateway', async () => {
    const { db, updates } = fakeDb({ data: { id: 'contact-1', avatar_url: null } })
    const fetcher: AvatarFetcher = vi.fn(async () => ({ kind: 'photo' as const, url: STORED }))
    await expect(refreshContactAvatar(db, INPUT, fetcher, NOW)).resolves.toBe('photo')

    const claim = updates[0]
    expect(claim.patch).toEqual({ avatar_checked_at: iso(NOW) })
    expect(claim.ops).toContainEqual(['eq', 'id', 'contact-1'])
    expect(claim.ops).toContainEqual(['eq', 'account_id', 'acc-1'])
    expect(claim.ops).toContainEqual(['is', 'anonymized_at', null])
    expect(claim.ops).toContainEqual([
      'or',
      `avatar_checked_at.is.null,avatar_checked_at.lt.${iso(NOW - AVATAR_REFRESH_MS)}`,
    ])
    expect(fetcher).toHaveBeenCalledWith(INPUT)
    expect(updates[1].patch).toEqual({ avatar_url: STORED, avatar_checked_at: iso(NOW) })
    // The write is guarded against an anonymisation that happened meanwhile.
    expect(updates[1].ops).toContainEqual(['is', 'anonymized_at', null])
  })

  it('drops the freshly stored copy when the contact was anonymised during the lookup', async () => {
    const CONTACT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const { db, removed } = fakeDb({ data: { id: CONTACT, avatar_url: null } }, null, [])
    const out = await refreshContactAvatar(
      db,
      { ...INPUT, contactId: CONTACT },
      async () => ({ kind: 'photo', url: STORED }),
      NOW,
    )
    expect(out).toBe('skipped')
    expect(removed).toEqual([['contact-avatars', [`account-acc-1/${CONTACT}`]]])
  })

  it('skips without calling the gateway when the claim finds nothing (fresh, claimed, anonymised)', async () => {
    const { db, updates } = fakeDb({ data: null })
    const fetcher = vi.fn()
    await expect(refreshContactAvatar(db, INPUT, fetcher, NOW)).resolves.toBe('skipped')
    expect(fetcher).not.toHaveBeenCalled()
    expect(updates).toHaveLength(1)
  })

  it('skips quietly on a pre-055 schema', async () => {
    const { db } = fakeDb({ data: null, error: { code: '42703', message: 'column does not exist' } })
    const fetcher = vi.fn()
    await expect(refreshContactAvatar(db, INPUT, fetcher, NOW)).resolves.toBe('skipped')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('privacy / no photo clears our stored copy', async () => {
    const { db, updates } = fakeDb({ data: { id: 'contact-1', avatar_url: STORED } })
    await expect(refreshContactAvatar(db, INPUT, async () => ({ kind: 'none' }), NOW)).resolves.toBe('none')
    expect(updates[1].patch).toEqual({ avatar_url: null, avatar_checked_at: iso(NOW) })
  })

  it('a throwing or throttled fetcher re-arms the retry and keeps the old photo', async () => {
    const { db, updates } = fakeDb({ data: { id: 'contact-1', avatar_url: STORED } })
    const boom: AvatarFetcher = async () => {
      throw new Error('socket closed')
    }
    await expect(refreshContactAvatar(db, INPUT, boom, NOW)).resolves.toBe('unavailable')
    expect(updates[1].patch).toEqual({ avatar_checked_at: iso(NOW - AVATAR_REFRESH_MS + AVATAR_RETRY_MS) })
    expect(updates[1].patch).not.toHaveProperty('avatar_url')
  })
})

describe('fetchContactAvatarViaGateway', () => {
  beforeEach(() => {
    process.env.WA_GATEWAY_URL = 'http://gateway.test:3201'
    process.env.WA_GATEWAY_SECRET = 'a-very-long-shared-secret'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const reply = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

  it('posts to /avatar with the phone and contact id', async () => {
    const fetchMock = reply(200, { url: STORED })
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      fetchContactAvatarViaGateway({ accountId: 'acc-1', contactId: 'c-1', phone: '5511988887777' }),
    ).resolves.toEqual({ kind: 'photo', url: STORED })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://gateway.test:3201/sessions/acc-1/avatar')
    expect(JSON.parse(String(init.body))).toEqual({ to: '5511988887777', contact_id: 'c-1' })
  })

  it('maps null / not_on_whatsapp to none and throttled / offline / down to unavailable', async () => {
    vi.stubGlobal('fetch', reply(200, { url: null }))
    await expect(fetchContactAvatarViaGateway({ accountId: 'a', contactId: 'c', phone: '1' })).resolves.toEqual({ kind: 'none' })
    vi.stubGlobal('fetch', reply(422, { error: 'not_on_whatsapp' }))
    await expect(fetchContactAvatarViaGateway({ accountId: 'a', contactId: 'c', phone: '1' })).resolves.toEqual({ kind: 'none' })
    // A phone the gateway cannot dial (bad length) will never have a photo.
    vi.stubGlobal('fetch', reply(400, { error: 'invalid_request' }))
    await expect(fetchContactAvatarViaGateway({ accountId: 'a', contactId: 'c', phone: '1' })).resolves.toEqual({ kind: 'none' })
    for (const [status, code] of [
      [429, 'throttled'],
      [409, 'not_connected'],
      [502, 'send_failed'],
      [503, 'internal'],
    ] as const) {
      vi.stubGlobal('fetch', reply(status, { error: code }))
      await expect(
        fetchContactAvatarViaGateway({ accountId: 'a', contactId: 'c', phone: '1' }),
      ).resolves.toMatchObject({ kind: 'unavailable' })
    }
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))))
    await expect(fetchContactAvatarViaGateway({ accountId: 'a', contactId: 'c', phone: '1' })).resolves.toMatchObject({
      kind: 'unavailable',
    })
  })
})

describe('stored photo removal', () => {
  const A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const B = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'

  function storage(error: { message: string } | null = null) {
    const removed: [string, string[]][] = []
    return {
      removed,
      admin: {
        storage: {
          from: (bucket: string) => ({
            remove: async (paths: string[]) => {
              removed.push([bucket, paths])
              return { data: [], error }
            },
          }),
        },
      } as never,
    }
  }

  it('removes account-scoped paths for valid ids only, never throws', async () => {
    const { admin, removed } = storage()
    await expect(removeContactAvatarObjects(admin, 'acc', [A, A, '../x', 'nope'])).resolves.toBe(1)
    expect(removed).toEqual([['contact-avatars', [`account-acc/${A}`]]])
    const failing = storage({ message: 'denied' })
    await expect(removeContactAvatarObjects(failing.admin, 'acc', [A])).resolves.toBe(0)
    await expect(removeContactAvatarObjects({}, 'acc', [A])).resolves.toBe(0)
  })

  it('purges only the ids the caller can no longer see (really deleted)', async () => {
    const { admin, removed } = storage()
    const ops: unknown[][] = []
    const userDb = {
      from: (table: string) => {
        expect(table).toBe('contacts')
        const b: Record<string, unknown> = {
          select: (...a: unknown[]) => (ops.push(['select', ...a]), b),
          in: (...a: unknown[]) => (ops.push(['in', ...a]), b),
          then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: B }], error: null }).then(res),
        }
        return b
      },
    } as never
    await expect(purgeDeletedContactAvatars(userDb, admin, 'acc', [A, B, 'x'])).resolves.toBe(1)
    expect(ops).toContainEqual(['in', 'id', [A, B]])
    expect(removed).toEqual([['contact-avatars', [`account-acc/${A}`]]])
  })

  it('does nothing when the lookup fails', async () => {
    const { admin, removed } = storage()
    const userDb = {
      from: () => {
        const b: Record<string, unknown> = {
          select: () => b,
          in: () => b,
          then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'x' } }).then(res),
        }
        return b
      },
    } as never
    await expect(purgeDeletedContactAvatars(userDb, admin, 'acc', [A])).resolves.toBe(0)
    expect(removed).toEqual([])
  })
})
