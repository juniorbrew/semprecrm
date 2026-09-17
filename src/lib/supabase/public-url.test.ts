import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRelativeSupabaseUrl, resolveSupabasePublicUrl } from './public-url'

describe('isRelativeSupabaseUrl', () => {
  it('is true only for a leading-slash path', () => {
    expect(isRelativeSupabaseUrl('/supabase')).toBe(true)
    expect(isRelativeSupabaseUrl('http://127.0.0.1:56021')).toBe(false)
    expect(isRelativeSupabaseUrl(undefined)).toBe(false)
    expect(isRelativeSupabaseUrl('')).toBe(false)
  })
})

describe('resolveSupabasePublicUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns an absolute URL unchanged', () => {
    expect(resolveSupabasePublicUrl('https://xyz.supabase.co')).toBe('https://xyz.supabase.co')
    expect(resolveSupabasePublicUrl('http://192.168.1.10:56021/')).toBe('http://192.168.1.10:56021/')
  })

  it('prefixes a relative path with the browser origin (trailing slashes trimmed)', () => {
    vi.stubGlobal('window', { location: { origin: 'http://192.168.1.10:3101' } })
    expect(resolveSupabasePublicUrl('/supabase')).toBe('http://192.168.1.10:3101/supabase')
    expect(resolveSupabasePublicUrl('/supabase//')).toBe('http://192.168.1.10:3101/supabase')
  })

  it('returns a harmless placeholder for a relative path outside the browser (SSR/prerender)', () => {
    expect(resolveSupabasePublicUrl('/supabase')).toBe('http://ssr-placeholder.invalid/supabase')
  })
})
