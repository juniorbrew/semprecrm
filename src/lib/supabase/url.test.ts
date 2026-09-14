import { describe, expect, it } from 'vitest'
import { supabaseServerUrl } from './url'

describe('supabaseServerUrl', () => {
  it('prefers SUPABASE_INTERNAL_URL and trims trailing slashes', () => {
    expect(
      supabaseServerUrl({
        SUPABASE_INTERNAL_URL: 'http://host.docker.internal:56021/',
        NEXT_PUBLIC_SUPABASE_URL: 'http://192.168.1.10:56021',
      }),
    ).toBe('http://host.docker.internal:56021')
  })

  it('falls back to an absolute NEXT_PUBLIC_SUPABASE_URL', () => {
    expect(supabaseServerUrl({ NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:56021' })).toBe(
      'http://127.0.0.1:56021',
    )
    expect(
      supabaseServerUrl({ SUPABASE_INTERNAL_URL: '  ', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:56021' }),
    ).toBe('http://127.0.0.1:56021')
  })

  it('throws when NEXT_PUBLIC_SUPABASE_URL is relative and SUPABASE_INTERNAL_URL is unset', () => {
    expect(() => supabaseServerUrl({ NEXT_PUBLIC_SUPABASE_URL: '/supabase' })).toThrow(
      /SUPABASE_INTERNAL_URL/,
    )
  })
})
