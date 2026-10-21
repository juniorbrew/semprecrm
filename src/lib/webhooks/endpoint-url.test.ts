import { describe, expect, it } from 'vitest'

import { validateEndpointUrl } from './endpoint-url'

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }]
const privateResolver = async () => [{ address: '10.0.0.8', family: 4 }]

describe('validateEndpointUrl', () => {
  it('accepts a public https URL', async () => {
    expect(await validateEndpointUrl('https://hooks.example.com/in?x=1', publicResolver)).toEqual({
      ok: true,
      url: 'https://hooks.example.com/in?x=1',
    })
  })

  it.each(['http://hooks.example.com/in', 'ftp://x.com', 'javascript:alert(1)'])('rejects the scheme of %s', async (u) => {
    const r = await validateEndpointUrl(u, publicResolver)
    expect(r.ok).toBe(false)
  })

  it('rejects credentials in the URL', async () => {
    expect(await validateEndpointUrl('https://u:p@hooks.example.com/', publicResolver)).toMatchObject({ ok: false })
  })

  it.each(['https://127.0.0.1/x', 'https://169.254.169.254/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/'])(
    'rejects internal literal %s',
    async (u) => {
      expect(await validateEndpointUrl(u, publicResolver)).toMatchObject({ ok: false })
    },
  )

  it('rejects a hostname that resolves to a private address', async () => {
    expect(await validateEndpointUrl('https://evil.example.com/', privateResolver)).toMatchObject({ ok: false })
  })

  it('rejects junk and non-strings', async () => {
    for (const v of [undefined, null, 5, '', 'not a url', 'https://' + 'a'.repeat(2100)]) {
      expect(await validateEndpointUrl(v, publicResolver)).toMatchObject({ ok: false })
    }
  })
})
