import { beforeEach, describe, expect, it, vi } from 'vitest'

// Suppression list (migration 077): nothing suppressed unless a test says so.
vi.mock('@/lib/lgpd/suppression', () => ({ findSuppressedPhones: vi.fn(async () => new Set<string>()) }))

import { findSuppressedPhones } from '@/lib/lgpd/suppression'
import { ingestLead, leadDealTitle, type IngestLeadSource } from './ingest'
import { buildLeadFromAnswers, defaultBotConfig, eventAnswerLines, validateAnswers, validateBotConfig } from '@/lib/site-bot'

// ------------------------------------------------------------
// ingestLead — the DB half of the webhook. The Supabase admin client
// is a hand-rolled in-memory mock supporting the handful of PostgREST
// calls the ingest (and `findExistingContact`) issue.
// ------------------------------------------------------------

type Row = Record<string, unknown>

const state = {
  accounts: [] as Row[],
  contacts: [] as Row[],
  custom_fields: [] as Row[],
  contact_custom_values: [] as Row[],
  tags: [] as Row[],
  contact_tags: [] as Row[],
  deals: [] as Row[],
  profiles: [] as Row[],
  lead_sources: [] as Row[],
  lead_source_events: [] as Row[],
  /** Force the next contacts insert to fail with this error. */
  contactInsertError: null as { code?: string; message: string } | null,
}

type Table = keyof Omit<typeof state, 'contactInsertError'>

let idSeq = 0
const nextId = (prefix: string) => `${prefix}-${++idSeq}`

function makeDb() {
  function builder(table: Table) {
    const filters: { kind: 'eq' | 'in' | 'like' | 'gte'; key: string; value: unknown }[] = []
    const ops = {
      type: 'select' as 'select' | 'insert' | 'update' | 'upsert' | 'delete',
      payload: undefined as Row | Row[] | undefined,
      upsertOpts: undefined as { onConflict?: string; ignoreDuplicates?: boolean } | undefined,
      limit: undefined as number | undefined,
    }
    const matches = (r: Row) =>
      filters.every((f) => {
        if (f.kind === 'eq') return r[f.key] === f.value
        if (f.kind === 'in') return (f.value as unknown[]).includes(r[f.key])
        if (f.kind === 'gte') return String(r[f.key] ?? '') >= String(f.value)
        const suffix = String(f.value).replace(/^%/, '')
        // contacts.phone_normalized is a generated column (digits of phone).
        const v = f.key === 'phone_normalized' && r.phone_normalized === undefined
          ? String(r.phone ?? '').replace(/\D/g, '')
          : String(r[f.key] ?? '')
        return v.endsWith(suffix)
      })
    const rows = () => state[table].filter(matches)

    function resolve(): { data: unknown; error: null | { code?: string; message: string } } {
      switch (ops.type) {
        case 'insert': {
          if (table === 'contacts' && state.contactInsertError) {
            const err = state.contactInsertError
            state.contactInsertError = null
            return { data: null, error: err }
          }
          const list = Array.isArray(ops.payload) ? ops.payload : [ops.payload!]
          const created = list.map((p) => ({ id: nextId(table), ...(table === 'lead_source_events' ? { created_at: new Date().toISOString() } : {}), ...p }))
          state[table].push(...created)
          return { data: Array.isArray(ops.payload) ? created : created[0], error: null }
        }
        case 'update': {
          for (const r of rows()) Object.assign(r, ops.payload)
          const r = rows()
          return { data: r.length === 1 ? r[0] : r, error: null }
        }
        case 'upsert': {
          const list = Array.isArray(ops.payload) ? ops.payload : [ops.payload!]
          const keys = (ops.upsertOpts?.onConflict ?? 'id').split(',')
          for (const p of list) {
            const existing = state[table].find((r) => keys.every((k) => r[k] === p[k]))
            if (existing) {
              if (!ops.upsertOpts?.ignoreDuplicates) Object.assign(existing, p)
            } else {
              state[table].push({ id: nextId(table), ...p })
            }
          }
          return { data: null, error: null }
        }
        case 'delete': {
          const keep = state[table].filter((r) => !matches(r))
          state[table].length = 0
          state[table].push(...keep)
          return { data: null, error: null }
        }
        default: {
          let r = rows()
          if (ops.limit !== undefined) r = r.slice(0, ops.limit)
          return { data: r, error: null }
        }
      }
    }
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: Row | Row[]) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: Row) => ((ops.type = 'update'), (ops.payload = p), b),
      upsert: (p: Row | Row[], o?: typeof ops.upsertOpts) => (
        (ops.type = 'upsert'), (ops.payload = p), (ops.upsertOpts = o), b
      ),
      delete: () => ((ops.type = 'delete'), b),
      eq: (key: string, value: unknown) => (filters.push({ kind: 'eq', key, value }), b),
      in: (key: string, value: unknown[]) => (filters.push({ kind: 'in', key, value }), b),
      gte: (key: string, value: unknown) => (filters.push({ kind: 'gte', key, value }), b),
      like: (key: string, value: string) => (filters.push({ kind: 'like', key, value }), b),
      order: () => b,
      limit: (n: number) => ((ops.limit = n), b),
      maybeSingle: () => {
        const r = resolve()
        const d = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data
        return Promise.resolve({ data: d, error: r.error })
      },
      single: () => {
        const r = resolve()
        const d = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data
        return Promise.resolve({ data: d, error: r.error ?? (d ? null : { message: 'no rows' }) })
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onF, onR),
    }
    return b
  }
  return { from: (table: string) => builder(table as Table) } as unknown as import('@supabase/supabase-js').SupabaseClient
}

const ACCT = 'acct-1'
const OWNER = 'owner-1'

function source(over: Partial<IngestLeadSource> = {}): IngestLeadSource {
  return {
    id: 'src-1',
    account_id: ACCT,
    name: 'Landing Inverno',
    pipeline_id: 'pipe-1',
    stage_id: 'stage-1',
    tag_ids: [],
    assignee_user_id: null,
    field_map: {},
    received_count: 4,
    ...over,
  }
}

beforeEach(() => {
  idSeq = 0
  for (const k of Object.keys(state) as (keyof typeof state)[]) {
    if (Array.isArray(state[k])) (state[k] as Row[]).length = 0
  }
  state.contactInsertError = null
  state.accounts.push({ id: ACCT, owner_user_id: OWNER, default_currency: 'BRL' })
  state.lead_sources.push({ id: 'src-1', account_id: ACCT, received_count: 4, last_received_at: null })
  state.tags.push({ id: 'tag-1', account_id: ACCT }, { id: 'tag-foreign', account_id: 'acct-2' })
  state.custom_fields.push({ id: 'cf-1', account_id: ACCT }, { id: 'cf-foreign', account_id: 'acct-2' })
  state.profiles.push({ id: 'prof-9', user_id: 'user-9', account_id: ACCT })
})

describe('ingestLead — new lead', () => {
  it('creates contact + deal, applies tags/custom fields, logs ok, bumps counters', async () => {
    const db = makeDb()
    const res = await ingestLead(
      db,
      source({ tag_ids: ['tag-1', 'tag-foreign'], assignee_user_id: 'user-9', field_map: { custom: { 'cf-1': 'origem', 'cf-foreign': 'origem' } } }),
      { nome: 'Teste Lead', telefone: '5511988887777', email: 't@x.com', origem: 'Google' },
    )

    expect(res.status).toBe('ok')
    expect(res.httpStatus).toBe(200)
    expect(res.duplicate).toBe(false)
    expect(res.contactCreated).toBe(true)

    expect(state.contacts).toHaveLength(1)
    expect(state.contacts[0]).toMatchObject({
      account_id: ACCT,
      user_id: OWNER,
      phone: '5511988887777',
      name: 'Teste Lead',
      email: 't@x.com',
    })
    expect(res.contactId).toBe(state.contacts[0].id)

    expect(state.deals).toHaveLength(1)
    expect(state.deals[0]).toMatchObject({
      account_id: ACCT,
      pipeline_id: 'pipe-1',
      stage_id: 'stage-1',
      contact_id: res.contactId,
      title: 'Teste Lead · Landing Inverno',
      currency: 'BRL',
      status: 'open',
      assigned_to: 'prof-9',
    })
    expect(res.dealId).toBe(state.deals[0].id)

    // Only the account's own tag / custom field are written.
    expect(state.contact_tags).toEqual([expect.objectContaining({ contact_id: res.contactId, tag_id: 'tag-1' })])
    expect(state.contact_custom_values).toEqual([
      expect.objectContaining({ contact_id: res.contactId, custom_field_id: 'cf-1', value: 'Google' }),
    ])

    expect(state.lead_source_events).toHaveLength(1)
    expect(state.lead_source_events[0]).toMatchObject({
      account_id: ACCT,
      source_id: 'src-1',
      status: 'ok',
      error: null,
      contact_id: res.contactId,
      deal_id: res.dealId,
      payload: { nome: 'Teste Lead', telefone: '5511988887777', email: 't@x.com', origem: 'Google' },
    })
    expect(state.lead_sources[0].received_count).toBe(5)
    expect(state.lead_sources[0].last_received_at).toEqual(expect.any(String))
  })

  it('writes the deal notes only when the caller passes them (site bot)', async () => {
    await ingestLead(makeDb(), source(), { phone: '5511988887777' })
    expect(state.deals[0]).not.toHaveProperty('notes')
    state.contacts.length = 0
    state.deals.length = 0
    await ingestLead(makeDb(), source(), { phone: '5511988887777' }, { dealNotes: 'Respostas do robo - Cor?: Azul' })
    expect(state.deals[0].notes).toBe('Respostas do robo - Cor?: Azul')
  })

  it('names the contact after the phone when the payload has no name', async () => {
    const res = await ingestLead(makeDb(), source({ pipeline_id: null, stage_id: null }), { phone: '+55 (11) 98888-7777' })
    expect(res.status).toBe('ok')
    expect(state.contacts[0]).toMatchObject({ phone: '5511988887777', name: '5511988887777' })
    expect(state.deals).toHaveLength(0)
    expect(res.dealId).toBeUndefined()
  })

  it('creates a suppressed number (opted out, then anonymised) already opted out', async () => {
    vi.mocked(findSuppressedPhones).mockResolvedValueOnce(new Set(['5511988887777']))
    const res = await ingestLead(makeDb(), source({ pipeline_id: null, stage_id: null }), { phone: '5511988887777' })
    expect(res.status).toBe('ok')
    expect(state.contacts[0].opted_out_at).toEqual(expect.any(String))
  })

  it('still creates the lead when the suppression lookup fails (fail-open)', async () => {
    vi.mocked(findSuppressedPhones).mockRejectedValueOnce(new Error('down'))
    const res = await ingestLead(makeDb(), source({ pipeline_id: null, stage_id: null }), { phone: '5511988887777' })
    expect(res.status).toBe('ok')
    expect(state.contacts[0].opted_out_at).toBeUndefined()
  })

  it('re-resolves the contact when the unique index rejects a racing insert', async () => {
    state.contactInsertError = { code: '23505', message: 'duplicate key' }
    const db = makeDb()
    // The "other request" that won the race:
    const p = ingestLead(db, source(), { telefone: '5511900000000' })
    // findExistingContact runs first (finds nothing), insert fails 23505,
    // then the re-lookup must find the row the racer inserted:
    state.contacts.push({ id: 'contact-raced', account_id: ACCT, phone: '5511900000000', name: 'Racer' })
    const res = await p
    expect(res.status).toBe('duplicate')
    expect(res.contactId).toBe('contact-raced')
  })
})

describe('ingestLead — existing contact (dedupe)', () => {
  beforeEach(() => {
    state.contacts.push({
      id: 'contact-1',
      account_id: ACCT,
      phone: '5511988887777',
      name: 'Ana',
      email: null,
      company: '',
    })
  })

  it('fills only the empty fields, logs duplicate, creates the deal', async () => {
    const res = await ingestLead(makeDb(), source(), {
      name: 'Ana Renamed',
      phone: '5511988887777',
      email: 'ana@x.com',
      company: 'ACME',
    })
    expect(res.status).toBe('duplicate')
    expect(res.httpStatus).toBe(200)
    expect(res.duplicate).toBe(true)
    expect(res.contactCreated).toBe(false)
    expect(res.contactId).toBe('contact-1')
    expect(state.contacts[0]).toMatchObject({ name: 'Ana', email: 'ana@x.com', company: 'ACME' })
    expect(state.deals).toHaveLength(1)
    expect(state.deals[0].title).toBe('Ana · Landing Inverno')
    expect(state.lead_source_events[0]).toMatchObject({ status: 'duplicate', contact_id: 'contact-1' })
  })

  it('replaces an existing custom value by default (webhook) but keeps it with keepExistingCustomValues', async () => {
    const src = source({ field_map: { custom: { 'cf-1': 'plan' } } })
    state.contact_custom_values.push({ contact_id: 'contact-1', custom_field_id: 'cf-1', value: 'Ouro' })
    await ingestLead(makeDb(), src, { phone: '5511988887777', plan: 'Bronze' })
    expect(state.contact_custom_values[0].value).toBe('Bronze')
    state.contact_custom_values[0].value = 'Ouro'
    await ingestLead(makeDb(), src, { phone: '5511988887777', plan: 'Bronze' }, { keepExistingCustomValues: true })
    expect(state.contact_custom_values).toHaveLength(1)
    expect(state.contact_custom_values[0].value).toBe('Ouro')
  })

  it('still writes a custom value the contact does not have yet when keeping existing ones', async () => {
    const src = source({ field_map: { custom: { 'cf-1': 'plan' } } })
    await ingestLead(makeDb(), src, { phone: '5511988887777', plan: 'Bronze' }, { keepExistingCustomValues: true })
    expect(state.contact_custom_values).toHaveLength(1)
    expect(state.contact_custom_values[0].value).toBe('Bronze')
  })

  it('flags a repeat from the same source inside the window, and only then', async () => {
    const opts = { checkRecentRepeat: 24 }
    const first = await ingestLead(makeDb(), source(), { phone: '5511988887777' }, opts)
    expect(first.recentRepeat).toBe(false)
    const second = await ingestLead(makeDb(), source(), { phone: '5511988887777' }, opts)
    expect(second.recentRepeat).toBe(true)
    state.lead_source_events.forEach((e) => (e.created_at = new Date(Date.now() - 25 * 3_600_000).toISOString()))
    const third = await ingestLead(makeDb(), source(), { phone: '5511988887777' }, opts)
    expect(third.recentRepeat).toBe(false)
    const plain = await ingestLead(makeDb(), source(), { phone: '5511988887777' })
    expect(plain).not.toHaveProperty('recentRepeat')
  })

  it('skips the deal when the contact already has an open one in the same pipeline', async () => {
    state.deals.push({ id: 'deal-open', account_id: ACCT, contact_id: 'contact-1', pipeline_id: 'pipe-1', status: 'open' })
    const res = await ingestLead(makeDb(), source(), { phone: '5511988887777' })
    expect(res.status).toBe('duplicate')
    expect(state.deals).toHaveLength(1)
    expect(res.dealId).toBeUndefined()
  })

  it('still creates a deal when the open one is in another pipeline or closed', async () => {
    state.deals.push(
      { id: 'deal-other', account_id: ACCT, contact_id: 'contact-1', pipeline_id: 'pipe-2', status: 'open' },
      { id: 'deal-won', account_id: ACCT, contact_id: 'contact-1', pipeline_id: 'pipe-1', status: 'won' },
    )
    const res = await ingestLead(makeDb(), source(), { phone: '5511988887777' })
    expect(state.deals).toHaveLength(3)
    expect(res.dealId).toBe(state.deals[2].id)
  })
})

describe('ingestLead — errors', () => {
  it('400 phone_missing when no phone key resolves', async () => {
    const res = await ingestLead(makeDb(), source(), { nome: 'Sem fone' })
    expect(res).toMatchObject({ status: 'error', httpStatus: 400, error: 'phone_missing' })
    expect(state.contacts).toHaveLength(0)
    expect(state.lead_source_events[0]).toMatchObject({ status: 'error', error: 'phone_missing', contact_id: null })
    expect(state.lead_sources[0].received_count).toBe(5)
  })

  it('a Brazilian number typed without the country code is stored with 55', async () => {
    const res = await ingestLead(makeDb(), source(), { telefone: '(11) 98888-7777' })
    expect(res.error).toBeUndefined()
    expect(state.contacts.at(-1)?.phone).toBe('5511988887777')
  })

  it('400 phone_invalid for a too-short or zero-led number', async () => {
    expect((await ingestLead(makeDb(), source(), { telefone: '123' })).error).toBe('phone_invalid')
    expect((await ingestLead(makeDb(), source(), { telefone: '0123456789' })).error).toBe('phone_invalid')
    expect((await ingestLead(makeDb(), source(), { telefone: 'abc' })).error).toBe('phone_missing')
    expect(state.lead_source_events).toHaveLength(3)
    expect(state.lead_source_events.every((e) => e.status === 'error')).toBe(true)
  })

  it('500 when the account row has no owner', async () => {
    state.accounts.length = 0
    const res = await ingestLead(makeDb(), source(), { phone: '5511988887777' })
    expect(res).toMatchObject({ status: 'error', httpStatus: 500, error: 'account_owner_not_found' })
  })

  it('500 when the contact insert fails for a non-unique reason', async () => {
    state.contactInsertError = { code: '42501', message: 'permission denied' }
    const res = await ingestLead(makeDb(), source(), { phone: '5511988887777' })
    expect(res.status).toBe('error')
    expect(res.httpStatus).toBe(500)
    expect(res.error).toContain('contact_insert_failed')
  })
})

describe('leadDealTitle', () => {
  it('uses the name, else the phone', () => {
    expect(leadDealTitle('Ana', '5511', 'Site')).toBe('Ana · Site')
    expect(leadDealTitle('  ', '5511', 'Site')).toBe('5511 · Site')
    expect(leadDealTitle(null, '5511', 'Site')).toBe('5511 · Site')
  })
})

// ------------------------------------------------------------
// Site bot -> real mapper + real ingest (R8): the answers a visitor gives end up
// in the same contact / custom field / deal / event rows a webhook would write.
// ------------------------------------------------------------
describe('site bot answers through the real ingest', () => {
  const CF = '11111111-1111-4111-8111-111111111111'
  const config = (() => {
    const r = validateBotConfig({
      ...defaultBotConfig(),
      questions: [
        ...defaultBotConfig().questions,
        { id: 'mail', text: 'E-mail?', type: 'email', required: false },
        { id: 'plano', text: 'Qual plano?', type: 'choice', options: ['Ouro', 'Prata'], required: false, target: 'custom', customFieldId: CF },
        { id: 'obs', text: 'Alguma observação?', type: 'text', required: false },
      ],
    })
    if (!r.ok) throw new Error(r.errors.join('; '))
    return r.config
  })()

  function lead(answers: Record<string, string>) {
    const checked = validateAnswers(config, answers)
    if (!checked.ok) throw new Error(checked.error)
    return buildLeadFromAnswers(config, checked.answers, { at: '2026-11-09T12:00:00.000Z', text: config.lgpd.text, linkUrl: '' })
  }

  const run = (built: ReturnType<typeof lead>, options = {}) =>
    ingestLead(makeDb(), source({ field_map: built.fieldMap }), built.payload, { dealNotes: built.dealNotes, keepExistingCustomValues: true, ...options })

  const ANSWERS = { nome: 'Ana Souza', whatsapp: '(11) 98765-4321', mail: 'ana@exemplo.com', plano: 'Prata', obs: 'Quero visitar a loja' }

  beforeEach(() => {
    state.custom_fields.push({ id: CF, account_id: ACCT })
  })

  it('creates the contact, the custom value, the deal with the Q&A note, and an event holding the answers', async () => {
    const built = lead(ANSWERS)
    const res = await run(built)
    expect(res.status).toBe('ok')
    expect(state.contacts[0]).toMatchObject({ name: 'Ana Souza', phone: '5511987654321', email: 'ana@exemplo.com' })
    expect(state.contact_custom_values).toEqual([expect.objectContaining({ custom_field_id: CF, value: 'Prata' })])
    expect(state.deals[0]).toMatchObject({ pipeline_id: 'pipe-1', stage_id: 'stage-1', title: 'Ana Souza · Landing Inverno' })
    expect(state.deals[0].notes).toBe('Respostas do robô do site\nE-mail?: ana@exemplo.com\nQual plano?: Prata\nAlguma observação?: Quero visitar a loja')
    const payload = state.lead_source_events[0].payload as Record<string, unknown>
    expect(payload).toMatchObject({ name: 'Ana Souza', a_plano: 'Prata', a_obs: 'Quero visitar a loja' })
    expect(payload._consent).toEqual({ at: '2026-11-09T12:00:00.000Z', text: config.lgpd.text, link: '' })
    expect(eventAnswerLines(config, payload)).toContain('Alguma observação?: Quero visitar a loja')
  })

  it('a repeated contact keeps its data and its custom value, creates no second deal, and the answers stay in the event', async () => {
    state.contacts.push({ id: 'contact-1', account_id: ACCT, phone: '5511987654321', name: 'Ana', email: 'antigo@x.com', company: '' })
    state.contact_custom_values.push({ contact_id: 'contact-1', custom_field_id: CF, value: 'Ouro' })
    state.deals.push({ id: 'deal-open', account_id: ACCT, contact_id: 'contact-1', pipeline_id: 'pipe-1', status: 'open', title: 'Antigo' })
    const res = await run(lead(ANSWERS))
    expect(res.status).toBe('duplicate')
    expect(state.contacts).toHaveLength(1)
    expect(state.contacts[0]).toMatchObject({ name: 'Ana', email: 'antigo@x.com' })
    expect(state.contact_custom_values).toHaveLength(1)
    expect(state.contact_custom_values[0].value).toBe('Ouro')
    expect(state.deals).toHaveLength(1)
    expect(state.deals[0]).not.toHaveProperty('notes')
    // the Q&A is not lost: the events view reads it from the payload
    const payload = state.lead_source_events[0].payload as Record<string, unknown>
    expect(eventAnswerLines(config, payload)).toEqual([
      'Qual é o seu nome?: Ana Souza',
      'Qual é o seu WhatsApp (com DDD)?: 5511987654321',
      'E-mail?: ana@exemplo.com',
      'Qual plano?: Prata',
      'Alguma observação?: Quero visitar a loja',
    ])
  })

  it('flags a second visit from the same contact inside 24 hours', async () => {
    const first = await run(lead(ANSWERS), { checkRecentRepeat: 24 })
    expect(first.recentRepeat).toBeUndefined()
    const second = await run(lead(ANSWERS), { checkRecentRepeat: 24 })
    expect(second).toMatchObject({ duplicate: true, recentRepeat: true })
  })

  it('does not write a custom value for an id the bot config does not own', async () => {
    state.custom_fields.length = 0
    state.custom_fields.push({ id: 'someone-elses', account_id: 'acct-2' })
    await run(lead(ANSWERS))
    expect(state.contact_custom_values).toHaveLength(0)
  })
})
