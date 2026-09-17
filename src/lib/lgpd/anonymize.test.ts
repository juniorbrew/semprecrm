import { describe, expect, it } from 'vitest'

import {
  ANONYMIZED_NAME,
  AnonymizeError,
  REMOVED_CONTENT,
  anonymizeContact,
  extractChatMediaPath,
  generateAnonymousPhone,
} from './anonymize'

// ------------------------------------------------------------
// A tiny in-memory Supabase double: records every call as
// { table, op, payload, filters } and answers from `state`.
// ------------------------------------------------------------

interface Call {
  table: string
  op: 'select' | 'update' | 'delete'
  payload?: unknown
  filters: [string, string, unknown][]
}

function makeDb(state: {
  contact?: Record<string, unknown> | null
  conversations?: { id: string }[]
  media?: { media_url: string | null }[]
  messagesCount?: number
  notesCount?: number
  customCount?: number
  updateErrors?: ({ code?: string; message: string } | null)[]
}) {
  const calls: Call[] = []
  const removed: string[][] = []
  const updateErrors = [...(state.updateErrors ?? [])]

  function builder(table: string) {
    const call: Call = { table, op: 'select', filters: [] }
    calls.push(call)
    let selecting = false
    let terminal: 'maybeSingle' | null = null
    const b: Record<string, unknown> = {}
    const chain = () => b
    b.select = () => {
      selecting = true
      return b
    }
    b.update = (payload: unknown) => {
      call.op = 'update'
      call.payload = payload
      return b
    }
    b.delete = () => {
      call.op = 'delete'
      return b
    }
    for (const f of ['eq', 'in', 'not']) {
      b[f] = (col: string, ...rest: unknown[]) => {
        call.filters.push([f, col, rest])
        return b
      }
    }
    b.maybeSingle = () => {
      terminal = 'maybeSingle'
      return Promise.resolve(resolve())
    }
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onF, onR)
    b.order = chain
    b.limit = chain

    function resolve(): { data: unknown; error: unknown; count?: number } {
      if (table === 'contacts') {
        if (call.op === 'select' && terminal === 'maybeSingle') {
          return { data: state.contact ?? null, error: null }
        }
        if (call.op === 'update') {
          const err = updateErrors.length ? updateErrors.shift() : null
          return { data: null, error: err ?? null }
        }
      }
      if (table === 'conversations') {
        if (call.op === 'select') return { data: state.conversations ?? [], error: null }
        return { data: null, error: null }
      }
      if (table === 'messages') {
        if (call.op === 'select') return { data: state.media ?? [], error: null }
        if (call.op === 'update') {
          const n = state.messagesCount ?? 0
          return { data: Array.from({ length: n }, (_, i) => ({ id: `m${i}` })), error: null }
        }
      }
      if (table === 'contact_notes') {
        const n = state.notesCount ?? 0
        return { data: Array.from({ length: n }, (_, i) => ({ id: `n${i}` })), error: null }
      }
      if (table === 'contact_custom_values') {
        const n = state.customCount ?? 0
        return { data: Array.from({ length: n }, (_, i) => ({ id: `c${i}` })), error: null }
      }
      void selecting
      return { data: null, error: null }
    }
    return b
  }

  const db = {
    from: (table: string) => builder(table),
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          removed.push(paths)
          return { data: paths.map((name) => ({ name })), error: null }
        },
      }),
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, calls, removed }
}

const PUBLIC =
  'http://127.0.0.1:56021/storage/v1/object/public/chat-media/account-abc/1700000000-foto.jpg'

describe('extractChatMediaPath', () => {
  it('extracts the object path from a public URL', () => {
    expect(extractChatMediaPath(PUBLIC)).toBe('account-abc/1700000000-foto.jpg')
  })
  it('strips query strings and decodes percent-escapes', () => {
    expect(
      extractChatMediaPath(
        'https://x.supabase.co/storage/v1/object/sign/chat-media/account-1/a%20b.pdf?token=zzz',
      ),
    ).toBe('account-1/a b.pdf')
  })
  it('extracts the path from an origin-relative URL (same-origin proxy)', () => {
    expect(
      extractChatMediaPath('/supabase/storage/v1/object/public/chat-media/account-abc/1-foto.jpg'),
    ).toBe('account-abc/1-foto.jpg')
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
  const now = () => new Date('2026-09-13T12:00:00.000Z')

  it('throws not_found when the contact is not in the account', async () => {
    const { db } = makeDb({ contact: null })
    await expect(anonymizeContact(db, 'acc', 'c1', { now })).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('refuses to anonymise twice', async () => {
    const { db } = makeDb({ contact: { id: 'c1', account_id: 'acc', anonymized_at: '2026-01-01' } })
    await expect(anonymizeContact(db, 'acc', 'c1', { now })).rejects.toBeInstanceOf(AnonymizeError)
  })

  it('scrubs messages, deletes media/notes/custom values and rewrites the contact', async () => {
    const { db, calls, removed } = makeDb({
      contact: { id: 'c1', account_id: 'acc', anonymized_at: null },
      conversations: [{ id: 'conv1' }, { id: 'conv2' }],
      media: [
        { media_url: PUBLIC },
        { media_url: PUBLIC }, // duplicate → removed once
        { media_url: 'https://lookaside.fbsbx.com/x' }, // foreign → ignored
      ],
      messagesCount: 5,
      notesCount: 2,
      customCount: 3,
    })

    const res = await anonymizeContact(db, 'acc', 'c1', { now, randomHex: () => 'deadbeef' })

    expect(res).toMatchObject({
      contactId: 'c1',
      anonymizedAt: '2026-09-13T12:00:00.000Z',
      conversations: 2,
      messagesScrubbed: 5,
      mediaDeleted: 1,
      notesDeleted: 2,
      customValuesDeleted: 3,
      warnings: [],
    })
    expect(removed).toEqual([['account-abc/1700000000-foto.jpg']])

    const msgUpdate = calls.find((c) => c.table === 'messages' && c.op === 'update')!
    expect(msgUpdate.payload).toEqual({ content_text: REMOVED_CONTENT, media_url: null })
    expect(msgUpdate.filters).toContainEqual(['in', 'conversation_id', [['conv1', 'conv2']]])

    const convUpdate = calls.find((c) => c.table === 'conversations' && c.op === 'update')!
    expect(convUpdate.payload).toEqual({ last_message_text: REMOVED_CONTENT })

    expect(calls.some((c) => c.table === 'contact_notes' && c.op === 'delete')).toBe(true)
    expect(calls.some((c) => c.table === 'contact_custom_values' && c.op === 'delete')).toBe(true)

    const contactUpdate = calls.find((c) => c.table === 'contacts' && c.op === 'update')!
    expect(contactUpdate.payload).toEqual({
      name: ANONYMIZED_NAME,
      phone: 'anon-deadbeef',
      email: null,
      company: null,
      avatar_url: null,
      opted_out_at: '2026-09-13T12:00:00.000Z',
      anonymized_at: '2026-09-13T12:00:00.000Z',
      updated_at: '2026-09-13T12:00:00.000Z',
    })
    expect(contactUpdate.filters).toContainEqual(['eq', 'account_id', ['acc']])

    // Contact row is rewritten last.
    const lastCall = calls[calls.length - 1]
    expect(lastCall.table).toBe('contacts')
    expect(lastCall.op).toBe('update')

    // Deals / tasks are never touched.
    expect(calls.some((c) => c.table === 'deals' || c.table === 'tasks')).toBe(false)
  })

  it('works for a contact without conversations', async () => {
    const { db, removed } = makeDb({
      contact: { id: 'c1', account_id: 'acc', anonymized_at: null },
      conversations: [],
    })
    const res = await anonymizeContact(db, 'acc', 'c1', { now })
    expect(res.conversations).toBe(0)
    expect(res.messagesScrubbed).toBe(0)
    expect(removed).toEqual([])
  })

  it('retries the phone on a unique violation and gives up on other errors', async () => {
    let n = 0
    const { db, calls } = makeDb({
      contact: { id: 'c1', account_id: 'acc', anonymized_at: null },
      updateErrors: [{ code: '23505', message: 'dup' }, null],
    })
    const res = await anonymizeContact(db, 'acc', 'c1', {
      now,
      randomHex: () => `0000000${n++}`,
    })
    expect(res.contactId).toBe('c1')
    const updates = calls.filter((c) => c.table === 'contacts' && c.op === 'update')
    expect(updates).toHaveLength(2)

    const failing = makeDb({
      contact: { id: 'c1', account_id: 'acc', anonymized_at: null },
      updateErrors: [{ code: '42501', message: 'denied' }],
    })
    await expect(anonymizeContact(failing.db, 'acc', 'c1', { now })).rejects.toMatchObject({
      code: 'db_error',
    })
  })
})
