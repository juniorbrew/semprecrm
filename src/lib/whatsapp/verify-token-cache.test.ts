import { describe, expect, it, vi } from 'vitest'

import {
  createVerifyTokenMatcher,
  invalidateVerifyTokenCache,
  VERIFY_CACHE_MS,
  VERIFY_MISS_REFETCH_MS,
} from './verify-token-cache'

function setup(rows: { id: string; verify_token: string | null }[]) {
  let t = 1_000_000
  const load = vi.fn(async () => rows)
  const decrypt = vi.fn((v: string) => {
    if (v === 'broken') throw new Error('bad')
    return v.replace(/^enc:/, '')
  })
  const m = createVerifyTokenMatcher(load, decrypt, () => t)
  return { m, load, decrypt, advance: (ms: number) => (t += ms) }
}

describe('createVerifyTokenMatcher', () => {
  it('matches the right row and skips broken / empty ones', async () => {
    const { m } = setup([
      { id: 'a', verify_token: 'broken' },
      { id: 'b', verify_token: null },
      { id: 'c', verify_token: 'enc:secret' },
    ])
    expect(await m.find('secret')).toEqual({ id: 'c', raw: 'enc:secret' })
    expect(await m.find('nope')).toBeNull()
  })

  it('does not reload or decrypt per request inside the cache window', async () => {
    const { m, load, decrypt, advance } = setup([{ id: 'c', verify_token: 'enc:secret' }])
    await m.find('secret')
    for (let i = 0; i < 50; i++) await m.find(`wrong-${i}`)
    expect(load).toHaveBeenCalledTimes(1)
    expect(decrypt).toHaveBeenCalledTimes(1)
    // After the miss-refetch window a miss may reload once (new token saved).
    advance(VERIFY_MISS_REFETCH_MS)
    await m.find('wrong')
    expect(load).toHaveBeenCalledTimes(2)
    // Hits keep serving from cache until it expires.
    await m.find('secret')
    expect(load).toHaveBeenCalledTimes(2)
    advance(VERIFY_CACHE_MS)
    await m.find('secret')
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('returns undefined when the configs cannot be loaded', async () => {
    const m = createVerifyTokenMatcher(async () => null, (v) => v)
    expect(await m.find('x')).toBeUndefined()
  })

  it('reloads after invalidateVerifyTokenCache (config saved / removed)', async () => {
    const { m, load } = setup([{ id: 'c', verify_token: 'enc:secret' }])
    await m.find('secret')
    await m.find('secret')
    expect(load).toHaveBeenCalledTimes(1)
    invalidateVerifyTokenCache()
    await m.find('secret')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('dedupes concurrent refreshes into one load', async () => {
    const { m, load, decrypt } = setup([{ id: 'c', verify_token: 'enc:secret' }])
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => m.find(i % 2 ? 'secret' : 'nope')))
    expect(load).toHaveBeenCalledTimes(1)
    expect(decrypt).toHaveBeenCalledTimes(1)
    expect(results.filter(Boolean)).toHaveLength(5)
  })
})
