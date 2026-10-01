import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// POST /api/whatsapp/templates/sync — clears a webhook stub.
//
// The template webhook creates a `needs_sync` stub for a template made
// directly in Meta (migration 053). Sync matches it on (account_id,
// name, language), writes the real components and must clear the mark
// so pickers and senders accept the template again.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  existing: { id: 'stub-1' } as Record<string, unknown> | null,
  writes: [] as { type: string; payload: Record<string, unknown> }[],
}))

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }))

// The WhatsApp token is read with the service role (migration 076).
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        single: async () => ({ data: { waba_id: 'waba-1', access_token: 'enc' }, error: null }),
      }
      return b
    },
  }),
}))

vi.mock('@/lib/auth/account', () => {
  function builder(table: string) {
    const ops = { type: 'select', payload: {} as Record<string, unknown> }
    const resolve = () => {
      if (table === 'whatsapp_config') {
        return { data: { waba_id: 'waba-1', access_token: 'enc' }, error: null }
      }
      if (ops.type !== 'select') {
        h.writes.push({ type: ops.type, payload: ops.payload })
        return { data: null, error: null }
      }
      return { data: h.existing, error: null }
    }
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      update: (p: Record<string, unknown>) => ((ops.type = 'update'), (ops.payload = p), b),
      insert: (p: Record<string, unknown>) => ((ops.type = 'insert'), (ops.payload = p), b),
      single: async () => resolve(),
      maybeSingle: async () => resolve(),
      then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(f, r),
    }
    return b
  }
  return {
    requireRole: async () => ({
      supabase: { from: (t: string) => builder(t) },
      accountId: 'acct-1',
      userId: 'user-1',
    }),
    toErrorResponse: () => null,
    ForbiddenError: class extends Error {},
    UnauthorizedError: class extends Error {},
  }
})

import { POST } from './route'

const META_TEMPLATE = {
  id: '555',
  name: 'created_in_meta',
  language: 'pt_BR',
  status: 'APPROVED',
  category: 'UTILITY',
  components: [{ type: 'BODY', text: 'Olá {{1}}' }],
}

beforeEach(() => {
  h.writes = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ data: [META_TEMPLATE] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('POST /api/whatsapp/templates/sync — webhook stubs', () => {
  it('fills the stub with the real body and clears needs_sync', async () => {
    h.existing = { id: 'stub-1' }
    const res = await POST()
    expect(res.status).toBe(200)
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0].type).toBe('update')
    expect(h.writes[0].payload).toMatchObject({
      body_text: 'Olá {{1}}',
      meta_template_id: '555',
      needs_sync: false,
    })
  })

  it('inserts new templates with needs_sync false', async () => {
    h.existing = null
    await POST()
    expect(h.writes[0]).toMatchObject({ type: 'insert', payload: { needs_sync: false } })
  })
})
