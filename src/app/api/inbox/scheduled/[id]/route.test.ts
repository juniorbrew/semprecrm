import { beforeEach, describe, expect, it, vi } from 'vitest'

type R = Record<string, unknown>

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  ctx: { userId: 'u-agent', role: 'agent', accountId: 'a1' } as { userId: string; role: string; accountId: string },
  dispatch: vi.fn(async () => ({ claimed: 1, sent: 1, failed: 0 })),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => h.ctx,
  toErrorResponse: () => new Response(null, { status: 403 }),
}))
vi.mock('@/lib/scheduled-messages/dispatch', () => ({ runScheduledDispatch: h.dispatch }))
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const filters: ((r: R) => boolean)[] = []
      let op: 'select' | 'update' | 'delete' = 'select'
      let patch: R = {}
      const hit = () => h.rows.filter((r) => filters.every((f) => f(r)))
      const run = () => {
        const rows = hit()
        if (op === 'update') rows.forEach((r) => Object.assign(r, patch))
        if (op === 'delete') h.rows = h.rows.filter((r) => !rows.includes(r))
        return { data: rows.map((r) => ({ ...r })), error: null }
      }
      const b: Record<string, unknown> = {
        select: () => b,
        update: (p: R) => ((op = 'update'), (patch = p), b),
        delete: () => ((op = 'delete'), b),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
        maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
        then: (res: (v: unknown) => void) => res(run()),
      }
      return b
    },
  }),
}))

import { DELETE, PATCH } from './route'
import { POST as SEND } from './send/route'

const FUTURE = new Date(Date.now() + 5 * 86_400_000).toISOString()
const PAST = new Date(Date.now() - 3_600_000).toISOString()
const row = (over: R = {}): R => ({
  id: 's1',
  account_id: 'a1',
  conversation_id: 'c1',
  created_by: 'u-author',
  content_text: 'texto original',
  scheduled_for: FUTURE,
  status: 'pending',
  error_code: null,
  ...over,
})
const params = { params: Promise.resolve({ id: 's1' }) }
const json = (body: unknown) =>
  new Request('http://x/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  h.rows = [row()]
  h.ctx = { userId: 'u-agent', role: 'agent', accountId: 'a1' }
  h.dispatch.mockClear()
})

describe('authorship rule (scheduled messages go out under the author)', () => {
  it('another agent cannot edit, cancel or send someone else\'s message', async () => {
    expect((await PATCH(json({ content_text: 'golpe' }), params)).status).toBe(403)
    expect((await DELETE(new Request('http://x'), params)).status).toBe(403)
    expect((await SEND(json({}), params)).status).toBe(403)
    expect(h.rows[0].content_text).toBe('texto original')
    expect(h.rows).toHaveLength(1)
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('the author can edit their own message', async () => {
    h.ctx = { userId: 'u-author', role: 'agent', accountId: 'a1' }
    const res = await PATCH(json({ content_text: 'novo texto' }), params)
    expect(res.status).toBe(200)
    expect(h.rows[0]).toMatchObject({ content_text: 'novo texto', created_by: 'u-author' })
  })

  it('an admin editing the text becomes the author (the sent message is credited to who wrote it)', async () => {
    h.ctx = { userId: 'u-admin', role: 'admin', accountId: 'a1' }
    expect((await PATCH(json({ content_text: 'texto do admin' }), params)).status).toBe(200)
    expect(h.rows[0]).toMatchObject({ content_text: 'texto do admin', created_by: 'u-admin' })
  })

  it('an admin changing only the time keeps the original author', async () => {
    h.ctx = { userId: 'u-admin', role: 'admin', accountId: 'a1' }
    expect((await PATCH(json({ scheduled_for: FUTURE }), params)).status).toBe(200)
    expect(h.rows[0].created_by).toBe('u-author')
  })

  it('an admin can cancel and send now', async () => {
    h.ctx = { userId: 'u-admin', role: 'admin', accountId: 'a1' }
    expect((await SEND(json({}), params)).status).toBe(200)
    expect(h.dispatch).toHaveBeenCalledTimes(1)
    const res = await DELETE(new Request('http://x'), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ content_text: 'texto original' })
  })

  it('rows of another account are invisible (404)', async () => {
    h.rows = [row({ account_id: 'other' })]
    h.ctx = { userId: 'u-admin', role: 'admin', accountId: 'a1' }
    expect((await PATCH(json({ content_text: 'x' }), params)).status).toBe(404)
  })
})

describe('re-queuing a failed row', () => {
  beforeEach(() => {
    h.ctx = { userId: 'u-author', role: 'agent', accountId: 'a1' }
  })

  it('a text-only edit of a row whose time has passed requires a new future time', async () => {
    h.rows = [row({ status: 'failed', scheduled_for: PAST })]
    const res = await PATCH(json({ content_text: 'corrigido' }), params)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('needs_new_time')
    expect(h.rows[0].status).toBe('failed')
  })

  it('with a new future time it goes back to pending', async () => {
    h.rows = [row({ status: 'failed', scheduled_for: PAST, error_text: 'x', error_code: 'send_failed' })]
    const res = await PATCH(json({ content_text: 'corrigido', scheduled_for: FUTURE }), params)
    expect(res.status).toBe(200)
    expect(h.rows[0]).toMatchObject({ status: 'pending', error_code: null, error_text: null })
  })

  it('a past new time is rejected', async () => {
    h.rows = [row({ status: 'failed', scheduled_for: PAST })]
    expect((await PATCH(json({ scheduled_for: PAST }), params)).status).toBe(400)
  })

  it('a row being sent or already sent cannot be edited or cancelled', async () => {
    for (const status of ['sending', 'sent']) {
      h.rows = [row({ status })]
      expect((await PATCH(json({ content_text: 'x' }), params)).status).toBe(409)
      expect((await DELETE(new Request('http://x'), params)).status).toBe(409)
    }
  })
})

describe('a stuck `sending` row (swept by the claim) cannot be re-sent without confirmation', () => {
  it('POST /send without confirm: the claim parks it as maybe_sent, nothing is sent, 409 confirm_required', async () => {
    h.ctx = { userId: 'u-author', role: 'agent', accountId: 'a1' }
    h.rows = [row({ status: 'sending', error_code: null })]
    // The SQL claim sweeps the stale row to failed/maybe_sent and (fixed) does NOT claim it again.
    h.dispatch.mockImplementationOnce(async () => {
      Object.assign(h.rows[0], { status: 'failed', error_code: 'maybe_sent' })
      return { claimed: 0, sent: 0, failed: 0 }
    })
    const res = await SEND(json({}), params)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('confirm_required')
    expect(h.rows[0]).toMatchObject({ status: 'failed', error_code: 'maybe_sent' })
  })

  it('with confirm the guard is lifted before the claim', async () => {
    h.ctx = { userId: 'u-author', role: 'agent', accountId: 'a1' }
    h.rows = [row({ status: 'failed', error_code: 'maybe_sent' })]
    h.dispatch.mockImplementationOnce(async () => {
      expect(h.rows[0].error_code).toBeNull() // the claim would skip a maybe_sent row
      return { claimed: 1, sent: 1, failed: 0 }
    })
    expect((await SEND(json({ confirm: true }), params)).status).toBe(200)
  })
})

describe('maybe_sent rows need an explicit confirmation', () => {
  beforeEach(() => {
    h.ctx = { userId: 'u-author', role: 'agent', accountId: 'a1' }
    h.rows = [row({ status: 'failed', error_code: 'maybe_sent', scheduled_for: PAST })]
  })

  it('retry without confirm is refused and nothing is dispatched', async () => {
    const res = await SEND(json({}), params)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('confirm_required')
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('retry with confirm dispatches', async () => {
    expect((await SEND(json({ confirm: true }), params)).status).toBe(200)
    expect(h.dispatch).toHaveBeenCalledTimes(1)
  })

  it('editing it (re-queue) also needs confirm', async () => {
    expect((await PATCH(json({ scheduled_for: FUTURE }), params)).status).toBe(409)
    expect((await PATCH(json({ scheduled_for: FUTURE, confirm: true }), params)).status).toBe(200)
  })
})
