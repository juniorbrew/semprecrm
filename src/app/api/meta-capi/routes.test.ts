import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  gate: 'ok' as 'ok' | 'forbidden' | 'readonly',
  gateWrites: [] as boolean[],
  calls: [] as { table: string; op: string; payload?: unknown; filters: Record<string, unknown> }[],
  results: {} as Record<string, unknown>,
  rpcs: [] as string[],
  sendOutcome: { ok: true, error: null, code: null, retryable: false } as Record<string, unknown>,
  sendArgs: [] as unknown[],
}))

const gateFn = (write: boolean) => {
  h.gateWrites.push(write)
  if (h.gate === 'forbidden') return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  if (h.gate === 'readonly' && write) return { response: NextResponse.json({ error: 'read only' }, { status: 402 }) }
  return { ctx: { accountId: 'acc-1', userId: 'user-1' } }
}

vi.mock('@/lib/meta-capi/guard', () => ({
  requireCapiAdmin: async () => gateFn(false),
  requireWritableCapiAdmin: async () => gateFn(true),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (s: string) => `enc(${s})`, decrypt: (s: string) => s.replace(/^enc\(|\)$/g, '') }))
vi.mock('@/lib/meta-capi/send', () => ({
  sendCapiEvents: async (a: unknown) => (h.sendArgs.push(a), h.sendOutcome),
}))
vi.mock('@/lib/meta-capi/process', () => ({ processCapiBatch: async () => ({ claimed: 2, sent: 2 }) }))
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: async (fn: string) => (h.rpcs.push(fn), { data: 3, error: null }),
    from: (table: string) => {
      const call = { table, op: 'select', payload: undefined as unknown, filters: {} as Record<string, unknown> }
      const q: Record<string, unknown> = {}
      const chain = (op?: string, payload?: unknown) => {
        if (op) {
          call.op = op
          call.payload = payload
        }
        return q
      }
      q.select = () => chain()
      q.update = (p: unknown) => chain('update', p)
      q.upsert = (p: unknown) => chain('upsert', p)
      q.order = () => q
      q.limit = () => q
      q.in = (k: string, v: unknown) => ((call.filters[k] = v), q)
      q.eq = (k: string, v: unknown) => ((call.filters[k] = v), q)
      const result = () => {
        h.calls.push(call)
        return h.results[`${table}.${call.op}`] ?? { data: null, error: null }
      }
      q.maybeSingle = async () => result()
      q.single = async () => result()
      q.then = (res: (v: unknown) => unknown) => res(result())
      return q
    },
  }),
}))

import { GET as cronGet } from './cron/route'
import { POST as retryPost } from './events/[id]/retry/route'
import { GET as settingsGet, PUT as settingsPut } from './settings/route'
import { POST as testPost } from './test/route'

const put = (body: unknown) => settingsPut(new Request('https://x.test/api/meta-capi/settings', { method: 'PUT', body: JSON.stringify(body) }))
const TOKEN = 'EAAB' + 'x'.repeat(40) + 'WXYZ'

beforeEach(() => {
  h.gate = 'ok'
  h.gateWrites = []
  h.calls = []
  h.results = {}
  h.rpcs = []
  h.sendArgs = []
  h.sendOutcome = { ok: true, error: null, code: null, retryable: false }
})

describe('settings route', () => {
  it('non-admins are refused, for reading and writing', async () => {
    h.gate = 'forbidden'
    expect((await settingsGet()).status).toBe(403)
    expect((await put({ enabled: false })).status).toBe(403)
    expect(h.calls).toEqual([])
  })

  it('a read-only account can look but not save', async () => {
    h.gate = 'readonly'
    h.results['meta_capi_settings.select'] = { data: null, error: null }
    h.results['meta_capi_events.select'] = { data: [], error: null }
    expect((await settingsGet()).status).toBe(200)
    expect((await put({ send_lead: false })).status).toBe(402)
    expect(h.gateWrites).toEqual([false, true])
  })

  it('GET never selects token_enc and joins the deal title', async () => {
    h.results['meta_capi_settings.select'] = { data: { dataset_id: '123456', token_last4: 'WXYZ', enabled: true }, error: null }
    h.results['meta_capi_events.select'] = { data: [{ id: 'e1', deal_id: 'd1', event_name: 'lead', status: 'sent' }], error: null }
    h.results['deals.select'] = { data: [{ id: 'd1', title: 'Sofá' }], error: null }
    const body = await (await settingsGet()).json()
    expect(body.events[0]).toMatchObject({ id: 'e1', deal_title: 'Sofá' })
    expect(JSON.stringify(body)).not.toContain('token_enc')
    expect(h.calls.every((c) => c.filters.account_id === 'acc-1')).toBe(true)
  })

  it('saving encrypts the token, stores last4, clears the pause, and never echoes the token', async () => {
    h.results['meta_capi_settings.select'] = { data: null, error: null }
    h.results['meta_capi_settings.upsert'] = { data: { dataset_id: '123456', token_last4: 'WXYZ', paused_reason: null }, error: null }
    const res = await put({ dataset_id: '123456', token: TOKEN, enabled: true })
    expect(res.status).toBe(200)
    const upsert = h.calls.find((c) => c.op === 'upsert')!
    expect(upsert.payload).toMatchObject({
      account_id: 'acc-1',
      updated_by: 'user-1',
      dataset_id: '123456',
      token_enc: `enc(${TOKEN})`,
      token_last4: 'WXYZ',
      paused_reason: null,
      enabled: true,
    })
    expect(JSON.stringify(await res.json())).not.toContain(TOKEN)
  })

  it('refuses to enable without dataset and key, and bad input', async () => {
    h.results['meta_capi_settings.select'] = { data: null, error: null }
    expect((await put({ enabled: true })).status).toBe(400)
    expect((await put({ dataset_id: 'abc' })).status).toBe(400)
    expect((await put({ token: 'short' })).status).toBe(400)
    expect((await put({ test_event_code: 'a b' })).status).toBe(400)
    expect(h.calls.some((c) => c.op === 'upsert')).toBe(false)
  })

  it('saving the SAME dataset does not clear a pause; a new key or a different dataset does', async () => {
    h.results['meta_capi_settings.select'] = { data: { dataset_id: '123456', token_last4: 'WXYZ' }, error: null }
    h.results['meta_capi_settings.upsert'] = { data: {}, error: null }
    await put({ dataset_id: '123456', test_event_code: 'T1' })
    expect(h.calls.find((c) => c.op === 'upsert')!.payload).not.toHaveProperty('paused_reason')
    h.calls = []
    await put({ dataset_id: '654321' })
    expect(h.calls.find((c) => c.op === 'upsert')!.payload).toMatchObject({ paused_reason: null })
    h.calls = []
    await put({ token: TOKEN })
    expect(h.calls.find((c) => c.op === 'upsert')!.payload).toMatchObject({ paused_reason: null })
  })

  it('toggling without a new key keeps the stored key (no token fields written)', async () => {
    h.results['meta_capi_settings.select'] = { data: { dataset_id: '123456', token_last4: 'WXYZ' }, error: null }
    h.results['meta_capi_settings.upsert'] = { data: { enabled: false }, error: null }
    expect((await put({ send_lead: false })).status).toBe(200)
    const payload = h.calls.find((c) => c.op === 'upsert')!.payload as Record<string, unknown>
    expect(payload).not.toHaveProperty('token_enc')
    expect(payload).not.toHaveProperty('paused_reason')
  })
})

describe('test route', () => {
  it('needs saved settings and a test code, and sends only the synthetic event', async () => {
    h.results['meta_capi_settings.select'] = { data: { dataset_id: '123456', token_enc: 'enc(T)', test_event_code: null }, error: null }
    expect((await testPost()).status).toBe(400)
    expect(h.sendArgs).toHaveLength(0)
    h.results['meta_capi_settings.select'] = { data: { dataset_id: '123456', token_enc: 'enc(T)', test_event_code: 'TEST1' }, error: null }
    const res = await testPost()
    expect((await res.json()).ok).toBe(true)
    const arg = h.sendArgs[0] as { token: string; datasetId: string; body: { test_event_code: string; data: { event_id: string }[] } }
    expect(arg).toMatchObject({ token: 'T', datasetId: '123456' })
    expect(arg.body.test_event_code).toBe('TEST1')
    expect(arg.body.data[0].event_id).toMatch(/^sempre-test-/)
  })

  it('shows the Meta answer in plain Portuguese on failure; non-admin refused', async () => {
    h.results['meta_capi_settings.select'] = { data: { dataset_id: '123456', token_enc: 'enc(T)', test_event_code: 'TEST1' }, error: null }
    h.sendOutcome = { ok: false, error: 'A chave de acesso é inválida ou venceu.', code: 190, retryable: false }
    expect(await (await testPost()).json()).toEqual({ ok: false, message: 'A chave de acesso é inválida ou venceu.' })
    h.gate = 'forbidden'
    expect((await testPost()).status).toBe(403)
  })
})

describe('retry route', () => {
  const call = (id: string) => retryPost(new Request('https://x.test'), { params: Promise.resolve({ id }) })
  const ID = '11111111-1111-4111-8111-111111111111'

  it('re-queues only a failed event of the caller account', async () => {
    h.results['meta_capi_events.update'] = { data: [{ id: ID }], error: null }
    expect((await call(ID)).status).toBe(200)
    const u = h.calls.find((c) => c.op === 'update')!
    expect(u.filters).toMatchObject({ id: ID, account_id: 'acc-1', status: 'failed' })
    expect(u.payload).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('404 when nothing matched, 400 on a bad id, 403 for non-admins', async () => {
    h.results['meta_capi_events.update'] = { data: [], error: null }
    expect((await call(ID)).status).toBe(404)
    expect((await call('nope')).status).toBe(400)
    h.gate = 'forbidden'
    expect((await call(ID)).status).toBe(403)
  })
})

describe('cron route', () => {
  beforeEach(() => {
    process.env.AUTOMATION_CRON_SECRET = 's3cret'
  })
  const req = (secret: string) => new Request('https://x.test/api/meta-capi/cron', { headers: { 'x-cron-secret': secret } })

  it('rejects a wrong secret and does nothing', async () => {
    expect((await cronGet(req('nope'))).status).toBe(401)
    expect(h.rpcs).toEqual([])
  })

  it('processes and purges with the right secret', async () => {
    const res = await cronGet(req('s3cret'))
    expect(await res.json()).toMatchObject({ claimed: 2, sent: 2, purged: 3 })
    expect(h.rpcs).toEqual(['meta_capi_purge'])
  })
})
