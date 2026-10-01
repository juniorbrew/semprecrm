import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MediaUrlNaoPermitida,
  accountMediaUrlForServer,
  isRelativeMediaUrl,
  mediaUrlForPublic,
  storageObjectPath,
  storageUrlForPublic,
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

describe('accountMediaUrlForServer / storageObjectPath (send-media validator)', () => {
  const ACC = 'acct-1'
  const OBJ = '/storage/v1/object/public/chat-media/account-acct-1/1-foto.jpg'

  // Same-origin proxy deployment (local Docker / VPS behind nginx).
  const PROXY = {
    NEXT_PUBLIC_SUPABASE_URL: '/supabase',
    SUPABASE_INTERNAL_URL: 'http://host.docker.internal:56021',
    NEXT_PUBLIC_SITE_URL: 'https://www.semprecrm.com.br',
  }
  // Absolute Supabase deployment.
  const ABS = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://api.semprecrm.com.br',
    SUPABASE_INTERNAL_URL: 'http://127.0.0.1:8000',
  }

  it('accepts a relative storage path and rewrites it to the internal route', () => {
    expect(accountMediaUrlForServer(`/supabase${OBJ}`, ACC, PROXY)).toBe(`http://host.docker.internal:56021${OBJ}`)
  })

  it('accepts the absolute public, internal and site-proxied forms of our own storage', () => {
    expect(accountMediaUrlForServer(`https://api.semprecrm.com.br${OBJ}`, ACC, ABS)).toBe(`http://127.0.0.1:8000${OBJ}`)
    expect(accountMediaUrlForServer(`http://127.0.0.1:8000${OBJ}`, ACC, ABS)).toBe(`http://127.0.0.1:8000${OBJ}`)
    expect(accountMediaUrlForServer(`https://www.semprecrm.com.br/supabase${OBJ}`, ACC, PROXY)).toBe(
      `http://host.docker.internal:56021${OBJ}`,
    )
    expect(
      accountMediaUrlForServer('/supabase/storage/v1/object/public/flow-media/account-acct-1/qr/1-a.pdf', ACC, PROXY),
    ).toBe('http://host.docker.internal:56021/storage/v1/object/public/flow-media/account-acct-1/qr/1-a.pdf')
  })

  it('without SUPABASE_INTERNAL_URL falls back to the absolute public URL, then the site proxy', () => {
    expect(accountMediaUrlForServer(`https://api.semprecrm.com.br${OBJ}`, ACC, { NEXT_PUBLIC_SUPABASE_URL: ABS.NEXT_PUBLIC_SUPABASE_URL })).toBe(
      `https://api.semprecrm.com.br${OBJ}`,
    )
    expect(
      accountMediaUrlForServer(`/supabase${OBJ}`, ACC, { NEXT_PUBLIC_SUPABASE_URL: '/supabase', NEXT_PUBLIC_SITE_URL: 'https://app.x' }),
    ).toBe(`https://app.x/supabase${OBJ}`)
  })

  it.each([
    ['empty', ''],
    ['non-string', 42],
    ['protocol-relative', '//etc/passwd'],
    ['dot path', './.env'],
    ['bare relative', 'data/creds.json'],
    ['absolute fs path', '/etc/passwd'],
    ['relative outside storage', '/supabase/rest/v1/contacts'],
    ['parent segments', '/supabase/storage/v1/object/public/chat-media/account-acct-1/../../../../rest/v1/x'],
    ['dot-dot to other account', '/supabase/storage/v1/object/public/chat-media/account-acct-1/../account-x/a.jpg'],
    ['encoded traversal', '/supabase/storage/v1/object/public/chat-media/account-acct-1/%2e%2e/%2E%2E/x'],
    ['encoded slash', '/supabase/storage/v1/object/public/chat-media/account-acct-1%2f..%2fx'],
    ['backslash', '/supabase/storage/v1/object/public/chat-media/account-acct-1\\..\\x'],
    ['double slash inside', '/supabase/storage/v1/object/public/chat-media//account-acct-1/x'],
    ['CRLF', `/supabase${OBJ}\r\nX: y`],
    ['query', `/supabase${OBJ}?x=1`],
    ['fragment', `/supabase${OBJ}#a`],
    ['file scheme', 'file:///etc/passwd'],
    ['data scheme', 'data:image/png;base64,AAAA'],
    ['ftp scheme', `ftp://api.semprecrm.com.br${OBJ}`],
    ['loopback', `http://127.0.0.1${OBJ}`],
    ['metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['foreign host', `https://evil.example${OBJ}`],
    ['userinfo host trick', `https://api.semprecrm.com.br@evil.example${OBJ}`],
    ['userinfo on our host', `https://user:pw@api.semprecrm.com.br${OBJ}`],
    ['port trick', `https://api.semprecrm.com.br:8443${OBJ}`],
    ['http on https origin', `http://api.semprecrm.com.br${OBJ}`],
    ['decimal IP', `http://2130706433${OBJ}`],
    ['hex IP', `http://0x7f000001${OBJ}`],
    ['IPv6 loopback', `http://[::1]${OBJ}`],
    ['IPv4-mapped IPv6', `http://[::ffff:127.0.0.1]:8000${OBJ}`],
    ['our host, not storage', 'https://api.semprecrm.com.br/rest/v1/contacts'],
    ['storage, not public object', 'https://api.semprecrm.com.br/storage/v1/object/sign/chat-media/account-acct-1/x'],
    ['other account folder', 'https://api.semprecrm.com.br/storage/v1/object/public/chat-media/account-acct-2/x.jpg'],
    ['bucket only', 'https://api.semprecrm.com.br/storage/v1/object/public/chat-media'],
    ['no account folder', 'https://api.semprecrm.com.br/storage/v1/object/public/chat-media/x.jpg'],
    ['other bucket', 'https://api.semprecrm.com.br/storage/v1/object/public/avatars/account-acct-1/x.jpg'],
  ])('refuses %s', (_name, url) => {
    expect(() => accountMediaUrlForServer(url, ACC, ABS)).toThrow(MediaUrlNaoPermitida)
    expect(() => accountMediaUrlForServer(url, ACC, PROXY)).toThrow(MediaUrlNaoPermitida)
  })

  it('carries a pt-BR message and a 400 status', () => {
    try {
      accountMediaUrlForServer('./.env', ACC, ABS)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(MediaUrlNaoPermitida)
      expect((err as MediaUrlNaoPermitida).status).toBe(400)
      expect((err as Error).message).toMatch(/não permitida/)
    }
  })

  it('storageObjectPath ignores bucket/account (template headers) but keeps the path rules', () => {
    expect(storageObjectPath('https://api.semprecrm.com.br/storage/v1/object/public/avatars/x.jpg', ABS)).toBe(
      '/storage/v1/object/public/avatars/x.jpg',
    )
    expect(() => storageObjectPath('/supabase/../rest/v1/x', PROXY)).toThrow(MediaUrlNaoPermitida)
  })

  // WHATWG trata `\` como `/` e resolve `..` DEPOIS de reconstruir a URL:
  // passaria pela checagem de segmentos e viraria traversal no Kong.
  it.each([
    ['object path', '/supabase/storage/v1/object/public/chat-media/x\\..\\..\\..\\api\\platform\\x'],
    ['folder segment', '/supabase/storage/v1/object/public/chat-media/account-acct-1\\..\\..\\..\\rest\\v1\\x/a.jpg'],
    ['after own folder', '/supabase/storage/v1/object/public/chat-media/account-acct-1/a\\..\\..\\..\\..\\rest\\v1\\x'],
    ['absolute URL', 'https://www.semprecrm.com.br/supabase/storage/v1/object/public/chat-media/account-acct-1/a\\..\\..\\x'],
  ])('refuses a backslash in the %s (storageObjectPath and the account check)', (_n, url) => {
    expect(() => storageObjectPath(url, PROXY)).toThrow(MediaUrlNaoPermitida)
    expect(() => accountMediaUrlForServer(url, ACC, PROXY)).toThrow(MediaUrlNaoPermitida)
  })

  it('storageUrlForPublic rebuilds the link Meta fetches from the validated path', () => {
    expect(storageUrlForPublic(OBJ, ABS)).toBe(`https://api.semprecrm.com.br${OBJ}`)
    expect(storageUrlForPublic(OBJ, PROXY)).toBe(`https://www.semprecrm.com.br/supabase${OBJ}`)
  })
})
