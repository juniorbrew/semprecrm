import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// The 094 RLS block does not apply to the service-role client. A mutating
// API route that writes with supabaseAdmin() must therefore refuse read-only
// and blocked accounts itself (requireWritable / requireModule), or say on its
// first lines why it is exempt:  // read-only: allowed (<reason>)
// A new route that forgets both fails here.

const root = join(process.cwd(), 'src/app/api')

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return routes(p)
    return name === 'route.ts' ? [p] : []
  })
}

const MUTATING = /^export (?:async )?function (?:POST|PATCH|PUT|DELETE)\b|^export const (?:POST|PATCH|PUT|DELETE)\b/m
const ADMIN_CLIENT = /supabaseAdmin\b|createAdminClient|admin-client/
const GUARDED = /requireWritable|requireModule/
const EXEMPT = /^\/\/ read-only: allowed \(.+\)/m

const writers = routes(root)
  .map((file) => ({ file: file.slice(root.length + 1).replaceAll('\\', '/'), text: readFileSync(file, 'utf8') }))
  .filter(({ text }) => MUTATING.test(text) && ADMIN_CLIENT.test(text))

describe('service-role API routes refuse read-only accounts or are explicitly exempt', () => {
  it('finds the mutating admin-client routes', () => {
    expect(writers.length).toBeGreaterThan(40)
  })

  it.each(writers.map((w) => [w.file, w.text] as const))('%s', (_file, text) => {
    expect(GUARDED.test(text) || EXEMPT.test(text)).toBe(true)
  })

  it('every exemption is a header comment with a reason, and guarded routes need none', () => {
    for (const { file, text } of writers) {
      if (!EXEMPT.test(text)) continue
      expect(text.split('\n').slice(0, 3).join('\n'), file).toMatch(EXEMPT)
    }
  })

  it('keeps owner-decided exemptions explicit: API keys and webhook endpoints are settings', () => {
    const exempt = writers.filter((w) => EXEMPT.test(w.text)).map((w) => w.file)
    expect(exempt).toEqual(
      expect.arrayContaining([
        'api-keys/route.ts',
        'webhooks/endpoints/route.ts',
        'webhooks/endpoints/[id]/route.ts',
      ]),
    )
  })
})
