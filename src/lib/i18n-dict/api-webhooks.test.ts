import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { translateLiteral } from '../i18n'

const FILES = [
  'src/components/settings/api-keys-group.tsx',
  'src/components/settings/webhook-endpoints-group.tsx',
  'src/components/settings/api-webhooks-settings.tsx',
]

describe('API e Webhooks dictionary', () => {
  it('translates every string the settings panel renders through t()', () => {
    const missing: string[] = []
    for (const file of FILES) {
      const src = readFileSync(join(process.cwd(), file), 'utf8')
      for (const m of src.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
        const key = m[2].replace(/\\'/g, "'")
        if (translateLiteral(key, 'pt-BR') === key) missing.push(key)
      }
    }
    expect(missing).toEqual([])
  })

  it('translates the server error strings and the event catalog', () => {
    for (const key of [
      'The URL must use https',
      'This address is not reachable from the internet',
      'Pick at least one event',
      'A customer message arrived',
      'Send WhatsApp messages',
    ]) {
      expect(translateLiteral(key, 'pt-BR')).not.toBe(key)
    }
  })
})
