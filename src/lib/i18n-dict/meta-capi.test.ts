import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { translateLiteral } from '@/lib/i18n'

import { DICT_META_CAPI } from './meta-capi'

const SRC = readFileSync(join(process.cwd(), 'src/components/settings/meta-capi-card.tsx'), 'utf8')

const usedKeys = (): string[] => {
  const keys = new Set<string>()
  for (const m of SRC.matchAll(/\bt\(\s*(['"])((?:\.|(?!\1).)*)\1\s*[,)]/g)) keys.add(m[2])
  return [...keys]
}
const words = (s: string) => s.trim().split(/\s+/).length

describe('meta-capi dictionary', () => {
  it('translates every string the card renders', () => {
    for (const key of usedKeys()) expect(translateLiteral(key, 'pt-BR'), key).not.toBe(key)
  })
  it('multi-word keys and values (the pt -> en pass cannot leak)', () => {
    for (const [en, pt] of Object.entries(DICT_META_CAPI)) {
      expect(words(en), en).toBeGreaterThan(1)
      expect(words(pt), pt).toBeGreaterThan(1)
    }
  })
  it('every entry is used, and user data stays out of the translator', () => {
    // STATUS_LABEL values are passed to t() through a lookup, so a quoted literal counts too.
    for (const key of Object.keys(DICT_META_CAPI)) expect(SRC.includes(`'${key}'`), key).toBe(true)
    expect(SRC).toContain('data-no-translate')
  })
})
