import { describe, expect, it } from 'vitest'

import { callbackUrl, configuredProviders, oauthRedirectBase, providerCredentials } from './config'

describe('provider configuration (env)', () => {
  it('a provider is configured only with both id and secret', () => {
    expect(configuredProviders({})).toEqual({ google: false, microsoft: false })
    expect(configuredProviders({ GOOGLE_CLIENT_ID: 'x' })).toEqual({ google: false, microsoft: false })
    expect(configuredProviders({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: ' s ' })).toEqual({ google: true, microsoft: false })
    expect(configuredProviders({ MS_CLIENT_ID: 'x', MS_CLIENT_SECRET: 's' })).toEqual({ google: false, microsoft: true })
  })

  it('Microsoft tenant defaults to common', () => {
    expect(providerCredentials('microsoft', { MS_CLIENT_ID: 'a', MS_CLIENT_SECRET: 'b' })).toEqual({
      clientId: 'a',
      clientSecret: 'b',
      tenant: 'common',
    })
    expect(providerCredentials('microsoft', { MS_CLIENT_ID: 'a', MS_CLIENT_SECRET: 'b', MS_TENANT: 'tid' })?.tenant).toBe('tid')
    expect(providerCredentials('google', {})).toBeNull()
  })

  it('redirect base: NEXT_PUBLIC_SITE_URL, except localhost requests (Google refuses LAN IPs)', () => {
    const env = { NEXT_PUBLIC_SITE_URL: 'http://192.168.1.10:3101/' }
    expect(oauthRedirectBase('http://192.168.1.10:3101/api/integrations/google/connect', env)).toBe('http://192.168.1.10:3101')
    expect(oauthRedirectBase('http://localhost:3102/api/integrations/google/connect', env)).toBe('http://localhost:3102')
    expect(oauthRedirectBase('http://127.0.0.1:3101/x', env)).toBe('http://127.0.0.1:3101')
    expect(oauthRedirectBase('https://crm.example.com/x', {})).toBe('https://crm.example.com')
    expect(callbackUrl('google', 'https://crm.example.com/')).toBe('https://crm.example.com/api/integrations/google/callback')
    expect(callbackUrl('microsoft', 'http://localhost:3101')).toBe('http://localhost:3101/api/integrations/microsoft/callback')
  })
})
