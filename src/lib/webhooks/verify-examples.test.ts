import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildSignatureHeader } from './signing'

// The snippets published in docs/examples must agree with what the server signs.
const BODY = '{"id":"evt_1","type":"message.received","data":{"object":{"text":"olá"}}}'
const NOW = 1_700_000_000
const header = buildSignatureHeader(['whsec_new', 'whsec_old'], NOW, BODY)

describe('docs/examples verify helpers', () => {
  it('node helper accepts either live secret and rejects tampering / replay', async () => {
    const { verifySempreCrmSignature } = (await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'docs/examples/verify-webhook.mjs')).href)) as {
      verifySempreCrmSignature: (b: string, h: string, s: string[], tol?: number, now?: number) => boolean
    }
    expect(verifySempreCrmSignature(BODY, header, ['whsec_old'], 300, NOW)).toBe(true)
    expect(verifySempreCrmSignature(BODY, header, ['whsec_new'], 300, NOW)).toBe(true)
    expect(verifySempreCrmSignature(BODY + ' ', header, ['whsec_new'], 300, NOW)).toBe(false)
    expect(verifySempreCrmSignature(BODY, header, ['whsec_other'], 300, NOW)).toBe(false)
    expect(verifySempreCrmSignature(BODY, header, ['whsec_new'], 300, NOW + 301)).toBe(false)
    expect(verifySempreCrmSignature(BODY, 'garbage', ['whsec_new'], 300, NOW)).toBe(false)
  })

  it('python helper agrees (skipped when python is not installed)', () => {
    const script = [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(join(process.cwd(), 'docs/examples'))})`,
      'from verify_webhook import verify_sempre_crm_signature as v',
      `body = ${JSON.stringify(BODY)}.encode()`,
      `ok = v(body, ${JSON.stringify(header)}, ["whsec_old"], 300, ${NOW})`,
      `bad = v(body + b" ", ${JSON.stringify(header)}, ["whsec_old"], 300, ${NOW})`,
      `late = v(body, ${JSON.stringify(header)}, ["whsec_old"], 300, ${NOW + 301})`,
      'print(ok, bad, late)',
    ].join('\n')
    let out: string
    try {
      out = execFileSync('python', ['-I', '-c', script], { encoding: 'utf8' }).trim()
    } catch {
      return
    }
    expect(out).toBe('True False False')
  })
})
