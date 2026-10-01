import { describe, expect, it } from 'vitest'

import nextConfig from '../next.config'

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
})
