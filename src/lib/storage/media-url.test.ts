import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isRelativeMediaUrl,
  mediaUrlForPublic,
  mediaUrlForServer,
  toStoredMediaUrl,
} from './media-url'

const PATH = '/supabase/storage/v1/object/public/chat-media/account-1/1-foto.jpg'

describe('isRelativeMediaUrl', () => {
  it('accepts a leading-slash path only', () => {
    expect(isRelativeMediaUrl(PATH)).toBe(true)
    expect(isRelativeMediaUrl('//cdn.example.com/a.png')).toBe(false)
    expect(isRelativeMediaUrl('https://cdn.example.com/a.png')).toBe(false)
    expect(isRelativeMediaUrl(null)).toBe(false)
    expect(isRelativeMediaUrl('')).toBe(false)
  })
})

describe('toStoredMediaUrl', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('strips the page origin from a same-origin public URL', () => {
    vi.stubGlobal('window', { location: { origin: 'http://192.168.1.10:3101' } })
    expect(toStoredMediaUrl(`http://192.168.1.10:3101${PATH}`)).toBe(PATH)
  })

  it('accepts an explicit origin (trailing slash tolerated)', () => {
    expect(toStoredMediaUrl(`http://localhost:3101${PATH}`, 'http://localhost:3101/')).toBe(PATH)
  })

  it('leaves URLs on another host untouched', () => {
    vi.stubGlobal('window', { location: { origin: 'http://192.168.1.10:3101' } })
    const abs = `http://192.168.1.10:56021${PATH.replace('/supabase', '')}`
    expect(toStoredMediaUrl(abs)).toBe(abs)
    expect(toStoredMediaUrl('https://lookaside.fbsbx.com/x?mid=1')).toBe(
      'https://lookaside.fbsbx.com/x?mid=1',
    )
  })

  it('does not confuse a host that merely starts with the origin', () => {
    expect(toStoredMediaUrl('http://localhost:31010/x.png', 'http://localhost:3101')).toBe(
      'http://localhost:31010/x.png',
    )
  })

  it('is a no-op outside the browser', () => {
    expect(toStoredMediaUrl(`http://localhost:3101${PATH}`)).toBe(`http://localhost:3101${PATH}`)
  })
})

describe('mediaUrlForServer', () => {
  it('swaps the public /supabase prefix for SUPABASE_INTERNAL_URL', () => {
    expect(
      mediaUrlForServer(PATH, {
        NEXT_PUBLIC_SUPABASE_URL: '/supabase',
        SUPABASE_INTERNAL_URL: 'http://host.docker.internal:56021/',
        NEXT_PUBLIC_SITE_URL: 'http://192.168.1.10:3101',
      }),
    ).toBe(
      'http://host.docker.internal:56021/storage/v1/object/public/chat-media/account-1/1-foto.jpg',
    )
  })

  it('falls back to NEXT_PUBLIC_SITE_URL (through the proxy) without an internal URL', () => {
    expect(
      mediaUrlForServer(PATH, {
        NEXT_PUBLIC_SUPABASE_URL: '/supabase',
        NEXT_PUBLIC_SITE_URL: 'http://192.168.1.10:3101/',
      }),
    ).toBe(`http://192.168.1.10:3101${PATH}`)
  })

  it('uses NEXT_PUBLIC_SITE_URL for relative paths outside the Supabase prefix', () => {
    expect(
      mediaUrlForServer('/icon.png', {
        NEXT_PUBLIC_SUPABASE_URL: '/supabase',
        SUPABASE_INTERNAL_URL: 'http://kong:8000',
        NEXT_PUBLIC_SITE_URL: 'https://crm.example.com',
      }),
    ).toBe('https://crm.example.com/icon.png')
  })

  it('does not treat /supabasex as the /supabase prefix', () => {
    expect(
      mediaUrlForServer('/supabasex/a.png', {
        NEXT_PUBLIC_SUPABASE_URL: '/supabase',
        SUPABASE_INTERNAL_URL: 'http://kong:8000',
        NEXT_PUBLIC_SITE_URL: 'https://crm.example.com',
      }),
    ).toBe('https://crm.example.com/supabasex/a.png')
  })

  it('leaves absolute URLs and empty strings unchanged', () => {
    const env = { NEXT_PUBLIC_SUPABASE_URL: '/supabase', SUPABASE_INTERNAL_URL: 'http://kong:8000' }
    expect(mediaUrlForServer('https://x.supabase.co/storage/v1/a.png', env)).toBe(
      'https://x.supabase.co/storage/v1/a.png',
    )
    expect(mediaUrlForServer('', env)).toBe('')
  })

  it('throws when nothing can absolutise a relative URL', () => {
    expect(() =>
      mediaUrlForServer(PATH, { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:56021' }),
    ).toThrow(/SUPABASE_INTERNAL_URL|NEXT_PUBLIC_SITE_URL/)
  })
})

describe('mediaUrlForPublic', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('prefixes NEXT_PUBLIC_SITE_URL', () => {
    expect(mediaUrlForPublic(PATH, { NEXT_PUBLIC_SITE_URL: 'https://crm.example.com/' })).toBe(
      `https://crm.example.com${PATH}`,
    )
  })

  it('leaves absolute URLs unchanged', () => {
    expect(
      mediaUrlForPublic('https://cdn.example.com/a.png', {
        NEXT_PUBLIC_SITE_URL: 'https://crm.example.com',
      }),
    ).toBe('https://cdn.example.com/a.png')
  })

  it('uses the browser origin when NEXT_PUBLIC_SITE_URL is unset', () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3101' } })
    expect(mediaUrlForPublic(PATH, {})).toBe(`http://localhost:3101${PATH}`)
  })

  it('returns the path unchanged when no base is known', () => {
    expect(mediaUrlForPublic(PATH, {})).toBe(PATH)
  })
})
