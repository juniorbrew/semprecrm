import { describe, expect, it } from 'vitest'

import {
  ANONYMIZED_DEAL_TITLE,
  ANONYMIZED_EVENT_TITLE,
  ANONYMIZED_NAME,
  ANONYMIZED_TASK_TITLE,
  AnonymizeError,
  DeleteContactError,
  REMOVED_CONTENT,
  SCRUBBED_TABLES,
  anonymizeContact,
  deleteContact,
  extractChatMediaPath,
  generateAnonymousPhone,
} from './anonymize'
import { suppressionHash } from './suppression'
import { makeFakeDb } from './fake-db.test-helper'

const SECRET = 'a'.repeat(64)
const ACC = 'acc'
const C1 = 'c1'
const now = () => new Date('2026-09-13T12:00:00.000Z')
const NOW = '2026-09-13T12:00:00.000Z'

const PUBLIC =
  'http://127.0.0.1:56021/storage/v1/object/public/chat-media/account-abc/1700000000-foto.jpg'

type Row = Record<string, unknown>

/** One row in every table the scrub covers, all about contact c1. */
function seed(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    contacts: [
      {
        id: C1,
        account_id: ACC,
        name: 'Ana Souza',
        phone: '+55 11 91234-5678',
        email: 'ana@example.com',
        company: 'ACME',
        avatar_url: 'x',
        opted_out_at: null,
        anonymized_at: null,
        anonymization_completed_at: null,
      },
    ],
    conversations: [
      { id: 'conv1', account_id: ACC, contact_id: C1, last_message_text: 'oi, sou a Ana', subject: 'Ana quer boleto', sentiment: 'negative' },
    ],
    messages: [
      { id: 'm1', conversation_id: 'conv1', content_text: 'meu CPF é 123', media_url: PUBLIC, error_details: null },
      { id: 'm2', conversation_id: 'conv1', content_text: 'oi', media_url: 'https://lookaside.fbsbx.com/x', error_details: '+5511912345678 invalid' },
    ],
    conversation_events: [
      { id: 'e1', conversation_id: 'conv1', event_type: 'assigned', payload: { assignee_user_id: 'u2', assignee_name: 'Bruno', reason: 'cliente Ana quer boleto' } },
      { id: 'e2', conversation_id: 'conv1', event_type: 'assigned', payload: { assignee_user_id: 'u2' } },
      { id: 'e3', conversation_id: 'conv1', event_type: 'ai_handoff', payload: { reason: 'Ana irritada' } },
      { id: 'e4', conversation_id: 'conv1', event_type: 'deal_stage_changed', payload: { deal_title: 'Ana - 11 9123' } },
    ],
    contact_notes: [{ id: 'n1', account_id: ACC, contact_id: C1, note_text: 'Ana' }],
    contact_custom_values: [{ id: 'cv1', contact_id: C1, value: 'CPF' }],
    contact_companies: [{ contact_id: C1, company_id: 'co1', account_id: ACC }],
    ai_contact_memories: [{ id: 'mem1', account_id: ACC, contact_id: C1, fact: 'tem 2 filhos' }],
    ai_handoffs: [{ id: 'h1', account_id: ACC, contact_id: C1, last_customer_words: 'socorro' }],
    ai_reply_jobs: [{ id: 'j1', account_id: ACC, contact_id: C1 }],
    csat_responses: [{ id: 'cs1', account_id: ACC, contact_id: C1, score: 5, comment: 'Ana adorou' }],
    automation_event_queue: [{ id: 1, account_id: ACC, contact_id: C1, context: { message_text: 'oi' } }],
    deals: [{ id: 'd1', account_id: ACC, contact_id: C1, conversation_id: 'conv1', title: 'Ana Souza - 11912345678', notes: 'liga às 18h', lost_note: 'caro' }],
    tasks: [
      { id: 't1', account_id: ACC, contact_id: C1, conversation_id: null, title: 'Ligar para Ana', description: 'cpf 123' },
      { id: 't2', account_id: ACC, contact_id: null, conversation_id: 'conv1', title: 'Lembrar Ana', description: null },
    ],
    task_comments: [{ id: 'tc1', task_id: 't1', body: 'Ana pediu desconto' }],
    calendar_events: [{ id: 'ev1', account_id: ACC, contact_id: C1, conversation_id: null, title: 'Visita Ana', description: 'Rua X', location: 'Rua X, 10' }],
    flow_runs: [{ id: 'fr1', account_id: ACC, contact_id: C1, vars: { cpf: '123' } }],
    flow_run_events: [{ id: 'fre1', flow_run_id: 'fr1', payload: { text: '123' } }],
    lead_source_events: [{ id: 'l1', account_id: ACC, contact_id: C1, payload: { name: 'Ana' } }],
    broadcast_recipients: [{ id: 'br1', contact_id: C1, template_params: ['Ana'] }],
    automation_pending_executions: [{ id: 'ape1', account_id: ACC, contact_id: C1, status: 'pending', context: { message_text: 'oi' } }],
    automation_logs: [{ id: 'al1', account_id: ACC, contact_id: C1, error_message: 'falha para Ana' }],
    audit_log: [{ id: 'au1', account_id: ACC, entity_type: 'contact', entity_id: C1, metadata: { contact_name: 'Ana', phone: '+55', count: 1 } }],
    ...overrides,
  }
}

describe('extractChatMediaPath', () => {
  it('extracts the object path from a public URL', () => {
    expect(extractChatMediaPath(PUBLIC)).toBe('account-abc/1700000000-foto.jpg')
  })
  it('strips query strings and decodes percent-escapes', () => {
    expect(
      extractChatMediaPath('https://x.supabase.co/storage/v1/object/sign/chat-media/account-1/a%20b.pdf?token=zzz'),
    ).toBe('account-1/a b.pdf')
  })
  it('extracts the path from an origin-relative URL (same-origin proxy)', () => {
    expect(extractChatMediaPath('/supabase/storage/v1/object/public/chat-media/account-abc/1-foto.jpg')).toBe(
      'account-abc/1-foto.jpg',
    )
  })
  it('ignores foreign URLs and other buckets', () => {
    expect(extractChatMediaPath('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1')).toBeNull()
    expect(extractChatMediaPath('https://x.supabase.co/storage/v1/object/public/flow-media/account-1/x.png')).toBeNull()
    expect(extractChatMediaPath(null)).toBeNull()
    expect(extractChatMediaPath('')).toBeNull()
  })
})

describe('generateAnonymousPhone', () => {
  it('uses the anon- prefix with 8 hex chars by default', () => {
    expect(generateAnonymousPhone()).toMatch(/^anon-[0-9a-f]{8}$/)
  })
  it('accepts an injected generator', () => {
    expect(generateAnonymousPhone(() => 'deadbeef')).toBe('anon-deadbeef')
  })
})

describe('anonymizeContact', () => {
  it('throws not_found when the contact is not in the account', async () => {
    const { db } = makeFakeDb(seed({ contacts: [] }))
    await expect(anonymizeContact(db, ACC, C1, { now })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses a contact whose anonymisation completed', async () => {
    const tables = seed()
    Object.assign(tables.contacts[0], { anonymized_at: '2026-01-01', anonymization_completed_at: '2026-01-01' })
    const { db } = makeFakeDb(tables)
    await expect(anonymizeContact(db, ACC, C1, { now })).rejects.toBeInstanceOf(AnonymizeError)
  })

  it('marks the contact FIRST, then scrubs every covered table and completes', async () => {
    const { db, tables, writes, removed } = makeFakeDb(seed())
    const res = await anonymizeContact(db, ACC, C1, { now, randomHex: () => 'deadbeef', secret: SECRET })

    expect(res).toMatchObject({ contactId: C1, completed: true, resumed: false, warnings: [], conversations: 1, messagesScrubbed: 2, mediaDeleted: 1 })
    // The very first write is the contact marker.
    expect(writes[0]).toMatchObject({ table: 'contacts', op: 'update' })
    expect(tables.contacts[0]).toMatchObject({
      name: ANONYMIZED_NAME,
      phone: 'anon-deadbeef',
      email: null,
      company: null,
      avatar_url: null,
      opted_out_at: NOW,
      anonymized_at: NOW,
      anonymization_completed_at: NOW,
    })
    // Chat media first, then the stored WhatsApp profile photo (migration 055).
    expect(removed).toEqual([
      { bucket: 'chat-media', paths: ['account-abc/1700000000-foto.jpg'] },
      { bucket: 'contact-avatars', paths: ['account-acc/c1'] },
    ])
    expect(tables.messages.map((m) => [m.content_text, m.media_url, m.error_details])).toEqual([
      [REMOVED_CONTENT, null, null],
      [REMOVED_CONTENT, null, null],
    ])
    expect(tables.conversations[0]).toMatchObject({ last_message_text: REMOVED_CONTENT, subject: null, sentiment: null })
    const ev = Object.fromEntries(tables.conversation_events.map((e) => [e.id, e.payload]))
    expect(ev).toEqual({
      e1: { assignee_user_id: 'u2', assignee_name: 'Bruno' },
      e2: { assignee_user_id: 'u2' },
      e3: {},
      e4: {},
    })
    for (const tbl of ['contact_notes', 'contact_custom_values', 'contact_companies', 'ai_contact_memories', 'ai_handoffs', 'ai_reply_jobs']) {
      expect(tables[tbl], tbl).toHaveLength(0)
    }
    expect(tables.csat_responses[0]).toMatchObject({ score: 5, comment: null })
    expect(tables.automation_event_queue[0].context).toEqual({})
    expect(tables.deals[0]).toMatchObject({ title: ANONYMIZED_DEAL_TITLE, notes: null, lost_note: null, contact_id: C1 })
    expect(tables.tasks.map((x) => [x.title, x.description])).toEqual([
      [ANONYMIZED_TASK_TITLE, null],
      [ANONYMIZED_TASK_TITLE, null],
    ])
    expect(tables.task_comments[0].body).toBe(REMOVED_CONTENT)
    expect(tables.calendar_events[0]).toMatchObject({ title: ANONYMIZED_EVENT_TITLE, description: null, location: null })
    expect(tables.flow_runs[0].vars).toEqual({})
    expect(tables.flow_run_events[0].payload).toEqual({})
    expect(tables.lead_source_events[0].payload).toEqual({})
    expect(tables.broadcast_recipients[0].template_params).toBeNull()
    expect(tables.automation_pending_executions[0]).toMatchObject({ status: 'cancelled', context: {} })
    expect(tables.automation_logs[0].error_message).toBeNull()
    expect(tables.audit_log[0].metadata).toEqual({ count: 1 })
    // Not opted out before → nothing on the suppression list.
    expect(tables.contact_suppressions ?? []).toHaveLength(0)
  })

  it('covers every table in SCRUBBED_TABLES (coverage)', async () => {
    const { db, writes } = makeFakeDb(seed())
    await anonymizeContact(db, ACC, C1, { now, secret: SECRET })
    const touched = new Set(writes.filter((w) => w.rows > 0).map((w) => w.table))
    for (const table of Object.keys(SCRUBBED_TABLES)) {
      expect(touched.has(table), `${table} not scrubbed`).toBe(true)
    }
  })

  it('pages through large histories: ≤200 ids per in(), never more than max_rows per read', async () => {
    const conversations = Array.from({ length: 450 }, (_, i) => ({ id: `conv${String(i).padStart(4, '0')}`, account_id: ACC, contact_id: C1, last_message_text: 'x' }))
    const messages = Array.from({ length: 2600 }, (_, i) => ({
      id: `m${String(i).padStart(5, '0')}`,
      conversation_id: conversations[i % 450].id,
      content_text: `msg ${i}`,
      media_url: i % 10 === 0 ? `${PUBLIC.replace('foto', `f${i}`)}` : null,
    }))
    const { db, tables, reads, removed } = makeFakeDb(seed({ conversations, messages }))
    const res = await anonymizeContact(db, ACC, C1, { now, secret: SECRET })
    expect(res.completed).toBe(true)
    expect(res.conversations).toBe(450)
    expect(tables.messages.every((m) => m.content_text === REMOVED_CONTENT && m.media_url === null)).toBe(true)
    expect(removed.filter((r) => r.bucket === 'chat-media').flatMap((r) => r.paths)).toHaveLength(260)
    expect(Math.max(...reads.flatMap((r) => r.inSizes))).toBeLessThanOrEqual(200)
  })

  it('keeps media_url when the object removal fails, reports it, and a re-run resumes', async () => {
    let storageDown = true
    const { db, tables } = makeFakeDb(seed(), {
      failStorage: (bucket) => (storageDown && bucket === 'chat-media' ? { message: 'storage unavailable' } : null),
    })
    const first = await anonymizeContact(db, ACC, C1, { now, secret: SECRET })
    expect(first.completed).toBe(false)
    expect(first.warnings.join(' ')).toMatch(/chat-media remove/)
    // Marked (no in-flight writer can re-populate it) but not completed.
    expect(tables.contacts[0]).toMatchObject({ name: ANONYMIZED_NAME, anonymized_at: NOW, anonymization_completed_at: null })
    expect(tables.messages[0]).toMatchObject({ content_text: REMOVED_CONTENT, media_url: PUBLIC })

    storageDown = false
    const second = await anonymizeContact(db, ACC, C1, { now, secret: SECRET })
    expect(second).toMatchObject({ completed: true, resumed: true, warnings: [] })
    expect(tables.messages[0].media_url).toBeNull()
    expect(tables.contacts[0].anonymization_completed_at).toBe(NOW)
    await expect(anonymizeContact(db, ACC, C1, { now, secret: SECRET })).rejects.toMatchObject({ code: 'already_anonymized' })
  })

  it('a failing table leaves the anonymisation incomplete (not silently done)', async () => {
    const { db, tables } = makeFakeDb(seed(), { fail: (table, op) => (table === 'deals' && op === 'update' ? { message: 'boom' } : null) })
    const res = await anonymizeContact(db, ACC, C1, { now, secret: SECRET })
    expect(res.completed).toBe(false)
    expect(res.warnings).toEqual(['deals scrub: boom'])
    expect(tables.contacts[0].anonymization_completed_at).toBeNull()
    // Every other step still ran.
    expect(tables.tasks[0].title).toBe(ANONYMIZED_TASK_TITLE)
  })

  it('keeps an opt-out across the anonymisation through the suppression list (hash only)', async () => {
    const tables = seed()
    tables.contacts[0].opted_out_at = '2026-01-01T00:00:00.000Z'
    const { db } = makeFakeDb(tables)
    await anonymizeContact(db, ACC, C1, { now, secret: SECRET })
    expect(tables.contact_suppressions).toEqual([
      { account_id: ACC, phone_hash: suppressionHash(ACC, '+55 11 91234-5678', SECRET) },
    ])
    expect(JSON.stringify(tables.contact_suppressions)).not.toMatch(/1234/)
    // The original opt-out date is kept.
    expect(tables.contacts[0].opted_out_at).toBe('2026-01-01T00:00:00.000Z')
  })

  it('does not mark the contact when the suppression cannot be written', async () => {
    const tables = seed()
    tables.contacts[0].opted_out_at = '2026-01-01T00:00:00.000Z'
    const { db } = makeFakeDb(tables, { fail: (t) => (t === 'contact_suppressions' ? { message: 'down' } : null) })
    await expect(anonymizeContact(db, ACC, C1, { now, secret: SECRET })).rejects.toMatchObject({ code: 'db_error' })
    expect(tables.contacts[0].anonymized_at).toBeNull()
  })

  it('retries the phone on a unique violation and gives up on other errors', async () => {
    let n = 0
    let calls = 0
    const { db, tables } = makeFakeDb(seed(), {
      fail: (t, op) => (t === 'contacts' && op === 'update' && calls++ === 0 ? { code: '23505', message: 'dup' } : null),
    })
    await anonymizeContact(db, ACC, C1, { now, randomHex: () => `0000000${n++}`, secret: SECRET })
    expect(tables.contacts[0].phone).toBe('anon-00000001')

    const failing = makeFakeDb(seed(), { fail: (t, op) => (t === 'contacts' && op === 'update' ? { code: '42501', message: 'denied' } : null) })
    await expect(anonymizeContact(failing.db, ACC, C1, { now, secret: SECRET })).rejects.toMatchObject({ code: 'db_error' })
  })
})

describe('deleteContact', () => {
  it('removes media, scrubs the SET NULL tables, detaches deals and deletes the row', async () => {
    const { db, tables, removed } = makeFakeDb(seed())
    const report = await deleteContact(db, ACC, C1)
    expect(report.warnings).toEqual([])
    expect(removed.map((r) => r.bucket)).toEqual(['chat-media', 'contact-avatars'])
    expect(tables.contacts).toHaveLength(0)
    expect(tables.deals[0]).toMatchObject({ title: ANONYMIZED_DEAL_TITLE, conversation_id: null })
    expect(tables.tasks[0].title).toBe(ANONYMIZED_TASK_TITLE)
    expect(tables.calendar_events[0].title).toBe(ANONYMIZED_EVENT_TITLE)
    expect(tables.flow_runs[0].vars).toEqual({})
    expect(tables.lead_source_events[0].payload).toEqual({})
    expect(tables.broadcast_recipients[0].template_params).toBeNull()
    expect(tables.automation_logs[0].error_message).toBeNull()
    expect(tables.audit_log[0].metadata).toEqual({ count: 1 })
  })

  it('refuses to delete when a media object could not be removed', async () => {
    const { db, tables } = makeFakeDb(seed(), { failStorage: (b) => (b === 'chat-media' ? { message: 'down' } : null) })
    await expect(deleteContact(db, ACC, C1)).rejects.toBeInstanceOf(DeleteContactError)
    expect(tables.contacts).toHaveLength(1)
    expect(tables.messages[0].media_url).toBe(PUBLIC)
  })

  it('404s a contact outside the account', async () => {
    const { db } = makeFakeDb(seed())
    await expect(deleteContact(db, 'other', C1)).rejects.toMatchObject({ code: 'not_found' })
  })
})
