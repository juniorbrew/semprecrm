import { describe, expect, it } from 'vitest'

import nextConfig from '../next.config'
import { config as middlewareConfig } from './middleware'

describe('next.config security', () => {
  it('does not advertise x-powered-by', () => {
    expect(nextConfig.poweredByHeader).toBe(false)
  })

  it('auth / cookie-setting pages are private, no-store and win over the public CDN rule', async () => {
    const rules = await nextConfig.headers!()
    const cacheRules = rules
      .map((r, i) => ({ i, source: r.source, value: r.headers.find((h) => h.key === 'Cache-Control')?.value }))
      .filter((r) => r.value)
    const publicRule = cacheRules.find((r) => r.value!.startsWith('public'))!
    for (const p of ['auth', 'login', 'signup', 'join', 'platform', 'mfa', 'reset-password', 'forgot-password']) {
      const rule = cacheRules.find((r) => r.source === `/${p}/:path*`)
      expect(rule?.value).toBe('private, no-store')
      expect(rule!.i).toBeGreaterThan(publicRule.i)
    }
  })

  it('keeps CSP report-only', async () => {
    const rules = await nextConfig.headers!()
    const keys = rules.flatMap((r) => r.headers.map((h) => h.key))
    expect(keys).toContain('Content-Security-Policy-Report-Only')
    expect(keys).not.toContain('Content-Security-Policy')
  })

  it('serves /robo.js to any site with a 1 hour cache, after the public CDN rule', async () => {
    const rules = await nextConfig.headers!()
    const robo = rules.findIndex((r) => r.source === '/robo.js')
    const publicRule = rules.findIndex((r) => r.headers.some((h) => h.key === 'Cache-Control' && h.value.startsWith('public, max-age=0')))
    expect(robo).toBeGreaterThan(publicRule)
    const h = Object.fromEntries(rules[robo].headers.map((x) => [x.key, x.value]))
    expect(h['Cache-Control']).toBe('public, max-age=3600')
    expect(h['Access-Control-Allow-Origin']).toBe('*')
    // The wildcard must stay on that one file.
    const withCors = rules.filter((r) => r.headers.some((x) => x.key === 'Access-Control-Allow-Origin'))
    expect(withCors.map((r) => r.source)).toEqual(['/robo.js'])
  })

  it('keeps /robo.js out of the session middleware', () => {
    const re = new RegExp(`^${middlewareConfig.matcher[0]}$`)
    expect(re.test('/robo.js')).toBe(false)
    expect(re.test('/dashboard')).toBe(true)
  })
})
