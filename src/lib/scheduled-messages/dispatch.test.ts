import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// Claim + dispatch of scheduled messages (migration 092). In-memory fake
// Supabase: `rpc('scheduled_messages_claim')` mimics the SQL (pending and
// due -> sending in one synchronous step, so a second caller sees nothing),
// the table builders support the eq/maybeSingle/update chains dispatch uses.
// The real engine senders and push are stubbed.
// ------------------------------------------------------------

vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: vi.fn() }))
vi.mock('@/lib/push/send', () => ({ isPushConfigured: () => false, sendPushToUsers: vi.fn() }))
const pauseSpy = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/flows/pause-on-agent', () => ({ pauseActiveFlowRuns: pauseSpy }))
vi.mock('@/lib/push/notify', () => ({ conversationUrl: (id: string) => `/inbox?c=${id}` }))

import type { SupabaseClient } from '@supabase/supabase-js'

import { DISPATCH_BATCH, runScheduledDispatch, type ScheduledRow } from './dispatch'

type R = Record<string, unknown>

const NOW = new Date('2026-10-20T12:00:00.000Z')
const HOUR = 3_600_000

function makeDb(seed: {
  scheduled?: R[]
  profiles?: R[]
  conversations?: R[]
  contacts?: R[]
  claimError?: { code?: string; message: string }
}) {
  const t = {
    scheduled_messages: seed.scheduled ?? [],
    profiles: seed.profiles ?? [{ user_id: 'u1', account_id: 'a1', account_role: 'agent' }],
    conversations: seed.conversations ?? [
      { id: 'c1', account_id: 'a1', status: 'open', channel: 'official', last_customer_message_at: new Date(NOW.getTime() - HOUR).toISOString() },
    ],
    contacts: seed.contacts ?? [{ id: 'k1', account_id: 'a1', anonymized_at: null }],
  } as Record<string, R[]>
  const rpcCalls: R[] = []

  function from(table: string) {
    const filters: ((r: R) => boolean)[] = []
    let patch: R | null = null
    const run = () => {
      const rows = t[table].filter((r) => filters.every((f) => f(r)))
      if (patch) rows.forEach((r) => Object.assign(r, patch))
      return rows
    }
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: R) => {
        patch = p
        return b
      },
      eq: (col: string, v: unknown) => {
        filters.push((r) => r[col] === v)
        return b
      },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: run(), error: null }),
    }
    return b
  }

  const db = {
    from,
    rpc: async (fn: string, args: R) => {
      rpcCalls.push({ fn, ...args })
      if (seed.claimError) return { data: null, error: seed.claimError }
      const limit = args.p_limit as number
      const id = args.p_id as string | null
      const confirm = args.p_confirm === true
      const now = new Date(args.p_now as string).getTime()
      const rows = t.scheduled_messages
        .filter((r) =>
          id
            ? r.id === id &&
              (r.status === 'pending' || (r.status === 'failed' && (confirm || r.error_code !== 'maybe_sent')))
            : r.status === 'pending' && new Date(r.scheduled_for as string).getTime() <= now,
        )
        .slice(0, limit)
      rows.forEach((r) => {
        r.error_code = null
        r.status = 'sending'
        r.attempts = ((r.attempts as number) ?? 0) + 1
      })
      return { data: rows.map((r) => ({ ...r })), error: null }
    },
  }
  return { db: db as unknown as SupabaseClient, t, rpcCalls }
}

const sched = (over: R = {}): R => ({
  id: 's1',
  account_id: 'a1',
  conversation_id: 'c1',
  contact_id: 'k1',
  created_by: 'u1',
  content_text: 'Olá! Seu pedido saiu.',
  scheduled_for: new Date(NOW.getTime() - 1000).toISOString(),
  status: 'pending',
  attempts: 0,
  ...over,
})

const okSend = () => vi.fn(async (row: ScheduledRow) => ({ whatsapp_message_id: `wamid.${row.id}` }))
const noOther = vi.fn(async () => null)

describe('runScheduledDispatch', () => {
  let notify: ReturnType<typeof vi.fn<(row: ScheduledRow, reason: string) => Promise<void>>>
  beforeEach(() => {
    notify = vi.fn<(row: ScheduledRow, reason: string) => Promise<void>>(async () => {})
  })

  it('sends a due message as its author and marks it sent', async () => {
    const { db, t } = makeDb({ scheduled: [sched()] })
    const send = okSend()
    const out = await runScheduledDispatch(db, { now: NOW, send, notifyFailure: notify, findOtherActive: noOther })
    expect(out).toEqual({ claimed: 1, sent: 1, failed: 0 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toMatchObject({ created_by: 'u1', content_text: 'Olá! Seu pedido saiu.' })
    expect(t.scheduled_messages[0]).toMatchObject({ status: 'sent', wa_message_id: 'wamid.s1', sent_at: NOW.toISOString() })
    expect(notify).not.toHaveBeenCalled()
  })

  it('pauses the contact\'s active flow runs after a scheduled agent message goes out, and only then', async () => {
    const { db } = makeDb({ scheduled: [sched()] })
    await runScheduledDispatch(db, { now: NOW, send: okSend(), findOtherActive: noOther })
    expect(pauseSpy).toHaveBeenCalledTimes(1)
    expect(pauseSpy).toHaveBeenCalledWith('a1', 'k1', db)

    pauseSpy.mockClear()
    const blocked = makeDb({ scheduled: [sched()], contacts: [{ id: 'k1', account_id: 'a1', anonymized_at: 'x' }] })
    await runScheduledDispatch(blocked.db, { now: NOW, send: okSend(), notifyFailure: notify, findOtherActive: noOther })
    expect(pauseSpy).not.toHaveBeenCalled()
  })

  it('leaves future messages alone', async () => {
    const { db, t } = makeDb({ scheduled: [sched({ scheduled_for: new Date(NOW.getTime() + HOUR).toISOString() })] })
    const send = okSend()
    const out = await runScheduledDispatch(db, { now: NOW, send })
    expect(out.claimed).toBe(0)
    expect(send).not.toHaveBeenCalled()
    expect(t.scheduled_messages[0].status).toBe('pending')
  })

  it('overlapping ticks never send the same message twice', async () => {
    const { db } = makeDb({ scheduled: [sched()] })
    const send = okSend()
    const [a, b] = await Promise.all([
      runScheduledDispatch(db, { now: NOW, send, findOtherActive: noOther }),
      runScheduledDispatch(db, { now: NOW, send, findOtherActive: noOther }),
    ])
    expect(send).toHaveBeenCalledTimes(1)
    expect(a.claimed + b.claimed).toBe(1)
  })

  it('"enviar agora" while the cron already took the row sends nothing', async () => {
    const { db } = makeDb({ scheduled: [sched({ status: 'sending' })] })
    const send = okSend()
    expect((await runScheduledDispatch(db, { now: NOW, id: 's1', send })).claimed).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('a maybe_sent row is claimed only with confirm, and the claim clears the marker', async () => {
    const { db, t } = makeDb({ scheduled: [sched({ status: 'failed', error_code: 'maybe_sent' })] })
    const send = okSend()
    expect((await runScheduledDispatch(db, { now: NOW, id: 's1', send, findOtherActive: noOther })).claimed).toBe(0)
    expect(send).not.toHaveBeenCalled()
    const out = await runScheduledDispatch(db, { now: NOW, id: 's1', confirm: true, send, findOtherActive: noOther })
    expect(out.sent).toBe(1)
    expect(t.scheduled_messages[0]).toMatchObject({ status: 'sent', error_code: null })
  })

  it('confirm has no effect on the cron claim (no id)', async () => {
    const { db, rpcCalls } = makeDb({ scheduled: [] })
    await runScheduledDispatch(db, { now: NOW, confirm: true })
    expect(rpcCalls[0]).toMatchObject({ p_confirm: false })
  })

  it('"enviar agora" sends a pending row before its time, and retry re-sends a failed one', async () => {
    const future = new Date(NOW.getTime() + 5 * HOUR).toISOString()
    const { db, t } = makeDb({ scheduled: [sched({ scheduled_for: future }), sched({ id: 's2', status: 'failed' })] })
    const send = okSend()
    const now = await runScheduledDispatch(db, { now: NOW, id: 's1', send, findOtherActive: noOther })
    const retry = await runScheduledDispatch(db, { now: NOW, id: 's2', send, findOtherActive: noOther })
    expect(now.sent + retry.sent).toBe(2)
    expect(t.scheduled_messages.map((r) => r.status)).toEqual(['sent', 'sent'])
  })

  it('a failed send is recorded with the reason and the author is told; it is not retried by the next tick', async () => {
    const { db, t } = makeDb({ scheduled: [sched()] })
    const send = vi.fn(async () => {
      throw new Error('Gateway fora do ar')
    })
    const out = await runScheduledDispatch(db, { now: NOW, send, notifyFailure: notify, findOtherActive: noOther })
    expect(out).toEqual({ claimed: 1, sent: 0, failed: 1 })
    expect(t.scheduled_messages[0]).toMatchObject({ status: 'failed', error_code: 'send_failed' })
    expect(String(t.scheduled_messages[0].error_text)).toContain('Gateway fora do ar')
    expect(notify).toHaveBeenCalledTimes(1)
    expect((await runScheduledDispatch(db, { now: NOW, send, notifyFailure: notify })).claimed).toBe(0)
  })

  it('a failed outcome write is retried; if it never lands the send still counts and nothing is re-sent', async () => {
    const { db, t } = makeDb({ scheduled: [sched()] })
    let failures = 2
    const real = db.from.bind(db)
    ;(db as unknown as { from: unknown }).from = (table: string) => {
      const b = real(table) as unknown as Record<string, (...a: unknown[]) => unknown>
      if (table !== 'scheduled_messages') return b
      const update = b.update
      b.update = (p: unknown) => {
        const q = update(p) as Record<string, unknown>
        if ((p as R).status === 'sent' && failures > 0) {
          failures--
          return { eq: () => ({ eq: async () => ({ error: { message: 'db down' } }) }) }
        }
        return q
      }
      return b
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const send = okSend()
    const out = await runScheduledDispatch(db, { now: NOW, send, findOtherActive: noOther })
    expect(out.sent).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(t.scheduled_messages[0].status).toBe('sent') // third try landed

    // Never lands: the row stays `sending` (the SQL sweep parks it as maybe_sent), and no tick re-claims it.
    const stuck = makeDb({ scheduled: [sched()] })
    const realStuck = stuck.db.from.bind(stuck.db)
    ;(stuck.db as unknown as { from: unknown }).from = (table: string) => {
      const b = realStuck(table) as unknown as Record<string, (...a: unknown[]) => unknown>
      if (table === 'scheduled_messages') {
        b.update = () => ({ eq: () => ({ eq: async () => ({ error: { message: 'db down' } }) }) })
      }
      return b
    }
    const send2 = okSend()
    await runScheduledDispatch(stuck.db, { now: NOW, send: send2, findOtherActive: noOther })
    await runScheduledDispatch(stuck.db, { now: NOW, send: send2, findOtherActive: noOther })
    expect(send2).toHaveBeenCalledTimes(1)
    expect(stuck.t.scheduled_messages[0].status).toBe('sending')
    spy.mockRestore()
  })

  it('a push failure never turns into a dispatch failure', async () => {
    const { db } = makeDb({ scheduled: [sched()] })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await runScheduledDispatch(db, {
      now: NOW,
      send: vi.fn(async () => {
        throw new Error('x')
      }),
      notifyFailure: async () => {
        throw new Error('push down')
      },
      findOtherActive: noOther,
    })
    expect(out.failed).toBe(1)
    spy.mockRestore()
  })

  it('a DB error AFTER the provider accepted it counts as sent (never re-sent)', async () => {
    const { db, t } = makeDb({ scheduled: [sched()] })
    const send = vi.fn(async () => {
      throw new Error('sent to Meta but DB insert failed: boom')
    })
    const out = await runScheduledDispatch(db, { now: NOW, send, notifyFailure: notify, findOtherActive: noOther })
    expect(out.sent).toBe(1)
    expect(t.scheduled_messages[0]).toMatchObject({ status: 'sent', error_code: 'not_saved' })
  })

  describe('send-time checks (no send is attempted)', () => {
    async function failsWith(seed: Parameters<typeof makeDb>[0], code: string, extra: Partial<Parameters<typeof runScheduledDispatch>[1]> = {}) {
      const { db, t } = makeDb({ scheduled: [sched()], ...seed })
      const send = okSend()
      const out = await runScheduledDispatch(db, { now: NOW, send, notifyFailure: notify, findOtherActive: noOther, ...extra })
      expect(out.failed).toBe(1)
      expect(send).not.toHaveBeenCalled()
      expect(t.scheduled_messages[0]).toMatchObject({ status: 'failed', error_code: code })
      expect(notify).toHaveBeenCalledTimes(1)
      return String(t.scheduled_messages[0].error_text)
    }

    it('official channel outside the 24 h window explains it in pt-BR', async () => {
      const old = new Date(NOW.getTime() - 25 * HOUR).toISOString()
      const msg = await failsWith(
        { conversations: [{ id: 'c1', account_id: 'a1', status: 'open', channel: 'official', last_customer_message_at: old }] },
        'window_closed',
      )
      expect(msg).toContain('24 h')
    })

    it('official channel where the customer never wrote also fails', async () => {
      await failsWith(
        { conversations: [{ id: 'c1', account_id: 'a1', status: 'open', channel: 'official', last_customer_message_at: null }] },
        'window_closed',
      )
    })

    it('the QR channel has no 24 h window', async () => {
      const { db } = makeDb({
        scheduled: [sched()],
        conversations: [{ id: 'c1', account_id: 'a1', status: 'open', channel: 'qr', last_customer_message_at: null }],
      })
      const send = okSend()
      expect((await runScheduledDispatch(db, { now: NOW, send, findOtherActive: noOther })).sent).toBe(1)
    })

    it('an anonymised (LGPD) contact never receives it', async () => {
      await failsWith({ contacts: [{ id: 'k1', account_id: 'a1', anonymized_at: '2026-10-19T00:00:00Z' }] }, 'contact_anonymized')
    })

    it('a closed conversation whose customer has a newer one fails', async () => {
      await failsWith(
        { conversations: [{ id: 'c1', account_id: 'a1', status: 'closed', channel: 'qr', last_customer_message_at: null }] },
        'newer_conversation',
        { findOtherActive: vi.fn(async () => ({ id: 'c2' }) as never) },
      )
    })

    it('a closed conversation with no newer one still sends', async () => {
      const { db } = makeDb({
        scheduled: [sched()],
        conversations: [{ id: 'c1', account_id: 'a1', status: 'closed', channel: 'qr', last_customer_message_at: null }],
      })
      const send = okSend()
      expect((await runScheduledDispatch(db, { now: NOW, send, findOtherActive: noOther })).sent).toBe(1)
    })

    it('an author who became a viewer (or left) cannot send through the queue', async () => {
      await failsWith({ profiles: [{ user_id: 'u1', account_id: 'a1', account_role: 'viewer' }] }, 'author_not_allowed')
      const { db } = makeDb({ scheduled: [sched()], profiles: [] })
      const send = okSend()
      expect((await runScheduledDispatch(db, { now: NOW, send, findOtherActive: noOther })).failed).toBe(1)
      expect(send).not.toHaveBeenCalled()
    })

    it('a deleted conversation fails cleanly', async () => {
      await failsWith({ conversations: [] }, 'conversation_gone')
    })
  })

  it('claims in batches and stops when a batch comes back short', async () => {
    const rows = Array.from({ length: DISPATCH_BATCH + 3 }, (_, i) => sched({ id: `s${i}` }))
    const { db, rpcCalls } = makeDb({ scheduled: rows })
    const out = await runScheduledDispatch(db, { now: NOW, send: okSend(), findOtherActive: noOther })
    expect(out.sent).toBe(DISPATCH_BATCH + 3)
    expect(rpcCalls).toHaveLength(2)
  })

  it('treats a missing function (migration not applied) as nothing to do, and surfaces other errors', async () => {
    const missing = makeDb({ claimError: { code: 'PGRST202', message: 'Could not find the function' } })
    expect(await runScheduledDispatch(missing.db, { now: NOW })).toEqual({ claimed: 0, sent: 0, failed: 0 })
    const broken = makeDb({ claimError: { message: 'connection reset' } })
    await expect(runScheduledDispatch(broken.db, { now: NOW })).rejects.toThrow('claim failed')
  })
})
