import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// DELETE /api/contacts (admin+) and the strict audit of the LGPD export.
// Session context and the service-role client are an in-memory fake.
// ------------------------------------------------------------

type Row = Record<string, unknown>

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  tables: {} as Record<string, Row[]>,
  auditFails: false,
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

vi.mock('@/lib/automations/admin-client', async () => {
  const { makeFakeDb } = await import('@/lib/lgpd/fake-db.test-helper')
  return {
    supabaseAdmin: () =>
      makeFakeDb(h.tables, { fail: (t) => (t === 'audit_log' && h.auditFails ? { message: 'down' } : null) }).db,
  }
})

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  const { hasMinRole } = await import('@/lib/auth/roles')
  const { makeFakeDb } = await import('@/lib/lgpd/fake-db.test-helper')
  const ctx = () => ({
    supabase: makeFakeDb(h.tables).db,
    userId: 'user-a',
    accountId: 'acc-a',
    role: h.role,
    account: { id: 'acc-a', name: 'Padaria Sol' },
  })
  return {
    ...actual,
    getCurrentAccount: vi.fn(async () => ctx()),
    requireRole: vi.fn(async (min: 'admin') => {
      if (!hasMinRole(h.role as 'admin', min)) throw new actual.ForbiddenError('Insufficient role')
      return ctx()
    }),
  }
})

import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { DELETE } from './route'
import { GET as EXPORT } from './[id]/export/route'

const C1 = '11111111-1111-4111-8111-111111111111'
const C2 = '22222222-2222-4222-8222-222222222222'
const MEDIA = 'https://x/storage/v1/object/public/chat-media/account-acc-a/f.jpg'

function del(ids: unknown) {
  return DELETE(new Request('http://x/api/contacts', { method: 'DELETE', body: JSON.stringify({ ids }) }))
}

beforeEach(() => {
  __resetRateLimitForTests()
  h.role = 'admin'
  h.auditFails = false
  h.tables = {
    contacts: [
      { id: C1, account_id: 'acc-a', name: 'Ana', phone: '5511912345678' },
      { id: C2, account_id: 'acc-b', name: 'Outra conta', phone: '5511900000000' },
    ],
    conversations: [{ id: 'conv1', account_id: 'acc-a', contact_id: C1 }],
    messages: [{ id: 'm1', conversation_id: 'conv1', content_text: 'oi', media_url: MEDIA }],
    deals: [{ id: 'd1', account_id: 'acc-a', contact_id: C1, conversation_id: 'conv1', title: 'Ana - 11912345678' }],
    audit_log: [],
  }
})

describe('DELETE /api/contacts', () => {
  it('refuses agents with a pt-BR message', async () => {
    h.role = 'agent'
    const res = await del([C1])
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body).toMatchObject({ code: 'admin_required' })
    expect(body.error).toMatch(/Somente administradores/)
    expect(h.tables.contacts).toHaveLength(2)
  })

  it('deletes the contact after scrubbing, and writes an audit row without the name', async () => {
    const res = await del([C1])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: [C1], failed: [] })
    expect(h.tables.contacts.map((c) => c.id)).toEqual([C2])
    expect(h.tables.deals[0]).toMatchObject({ title: 'Negócio anonimizado', conversation_id: null })
    expect(h.tables.audit_log).toHaveLength(1)
    expect(h.tables.audit_log[0]).toMatchObject({ action: 'contact.deleted', entity_id: C1 })
    expect(JSON.stringify(h.tables.audit_log[0])).not.toMatch(/Ana|5511/)
  })

  it('never touches another account’s contact', async () => {
    const res = await del([C2])
    expect(res.status).toBe(500)
    expect((await res.json()).failed).toEqual([{ id: C2, code: 'not_found', error: 'Contato não encontrado.' }])
    expect(h.tables.contacts).toHaveLength(2)
  })

  it('validates the id list', async () => {
    expect((await del([])).status).toBe(400)
    expect((await del(['nope'])).status).toBe(400)
    expect((await del(Array.from({ length: 51 }, () => C1))).status).toBe(400)
  })
})

describe('GET /api/contacts/:id/export — strict audit', () => {
  const call = () => EXPORT(new Request('http://x'), { params: Promise.resolve({ id: C1 }) })

  it('exports and audits', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(h.tables.audit_log[0]).toMatchObject({ action: 'contact.exported', entity_id: C1 })
  })

  it('refuses to export when the audit row cannot be written', async () => {
    h.auditFails = true
    const res = await call()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ code: 'audit_failed' })
  })
})
