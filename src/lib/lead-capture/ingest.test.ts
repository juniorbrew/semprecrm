import { beforeEach, describe, expect, it } from 'vitest'

import { ingestLead, leadDealTitle, type IngestLeadSource } from './ingest'

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
    const filters: { kind: 'eq' | 'in' | 'like'; key: string; value: unknown }[] = []
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
        const suffix = String(f.value).replace(/^%/, '')
        return String(r[f.key] ?? '').endsWith(suffix)
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
          const created = list.map((p) => ({ id: nextId(table), ...p }))
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

  it('names the contact after the phone when the payload has no name', async () => {
    const res = await ingestLead(makeDb(), source({ pipeline_id: null, stage_id: null }), { phone: '+55 (11) 98888-7777' })
    expect(res.status).toBe('ok')
    expect(state.contacts[0]).toMatchObject({ phone: '5511988887777', name: '5511988887777' })
    expect(state.deals).toHaveLength(0)
    expect(res.dealId).toBeUndefined()
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
