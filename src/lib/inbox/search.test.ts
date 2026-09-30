import { describe, expect, it } from 'vitest'

import { buildSearchPattern, escapeLike, MAX_SEARCH_LENGTH, normalizeSearch } from './search'

describe('inbox search pattern', () => {
  it('wraps the term in % and trims / collapses whitespace', () => {
    expect(buildSearchPattern('  ana   souza ')).toBe('%ana souza%')
  })

  it('returns null for an empty query', () => {
    expect(buildSearchPattern('')).toBeNull()
    expect(buildSearchPattern('   \n\t ')).toBeNull()
  })

  it('escapes the LIKE wildcards and the escape character', () => {
    expect(escapeLike('100%')).toBe('100\\%')
    expect(escapeLike('a_b')).toBe('a\\_b')
    expect(escapeLike('c:\\dir')).toBe('c:\\\\dir')
    expect(buildSearchPattern('50%_off')).toBe('%50\\%\\_off%')
  })

  it('leaves PostgREST-special characters alone (the term travels as an RPC parameter)', () => {
    const term = 'a,b(c).d:e"f\'g*'
    expect(buildSearchPattern(term)).toBe(`%${term}%`)
  })

  it('caps the length', () => {
    expect(normalizeSearch('x'.repeat(500))).toHaveLength(MAX_SEARCH_LENGTH)
  })

  it('keeps accents and phone punctuation', () => {
    expect(buildSearchPattern('João +55 (11) 9')).toBe('%João +55 (11) 9%')
  })
})
