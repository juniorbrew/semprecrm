import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  hasModule: true,
  modulesAsked: [] as string[],
  sendError: null as Error | null,
  sends: 0,
  lastArgs: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/plans-server', () => ({
  accountHasModule: async (_db: unknown, _acc: string, module: string) => (h.modulesAsked.push(module), h.hasModule),
}))
vi.mock('@/lib/automations/meta-send', () => ({
  engineSendText: async (args: Record<string, unknown>) => {
    h.lastArgs = args
    h.sends++
    if (h.sendError) throw h.sendError
    return { whatsapp_message_id: 'wamid.1' }
  },
}))
vi.mock('@/lib/whatsapp/inbound', () => ({
  findOrCreateContact: async () => ({ contact: { id: 'c1', opted_out_at: null }, wasCreated: false }),
  listContactConversations: async () => [],
  pickActiveConversation: () => null,
  findOrCreateConversation: async () => ({ conversation: { id: 'conv1' }, created: false, previous: null }),
}))

import { MetaApiError } from '@/lib/whatsapp/meta-api'
import { GatewayNotConfiguredError, GatewayRequestError, GatewayUnreachableError } from '@/lib/whatsapp/qr-gateway'

import { ApiSendError, classifySendFailure, sendTextViaApi } from './send-message'

const db = {
  from: (table: string) => ({
    select: () => {
      const b: Record<string, unknown> = {
        eq: () => b,
        maybeSingle: async () => ({
          data: table === 'accounts' ? { owner_user_id: 'u1' } : table === 'whatsapp_config' ? { id: 'cfg' } : { id: 'm1' },
          error: null,
        }),
      }
      return b
    },
  }),
} as unknown as SupabaseClient

const input = { accountId: 'a1', to: '5511999990000', text: 'oi' }

async function failure(promise: Promise<unknown>): Promise<ApiSendError> {
  try {
    await promise
  } catch (e) {
    return e as ApiSendError
  }
  throw new Error('expected a failure')
}

describe('sendTextViaApi plan and failure handling', () => {
  beforeEach(() => {
    h.hasModule = true
    h.modulesAsked = []
    h.sendError = null
    h.sends = 0
  })

  it('checks the channel module (official when the account has the Meta config) and sends', async () => {
    const r = await sendTextViaApi(db, input)
    expect(h.modulesAsked).toEqual(['channel_official'])
    expect(r).toMatchObject({ conversation_id: 'conv1', whatsapp_message_id: 'wamid.1', channel: 'official' })
  })

  it('asks for channel_qr when the QR channel is requested', async () => {
    await sendTextViaApi(db, { ...input, channel: 'qr' })
    expect(h.modulesAsked).toEqual(['channel_qr'])
  })

  it('403 module_not_included (also what a blocked account looks like) and nothing is sent', async () => {
    h.hasModule = false
    const err = await failure(sendTextViaApi(db, input))
    expect(err).toMatchObject({ status: 403, code: 'module_not_included', maybeSent: false })
    expect(h.sends).toBe(0)
  })

  it('a Meta 4xx is a confirmed refusal: retryable, not marked as possibly sent', async () => {
    h.sendError = new MetaApiError('(#131030) recipient not allowed', { httpStatus: 400 })
    expect(await failure(sendTextViaApi(db, input))).toMatchObject({ status: 502, code: 'send_failed', maybeSent: false })
  })

  it('any other failure after the send started is "unknown" and flagged as possibly sent', async () => {
    h.sendError = new Error('fetch failed')
    expect(await failure(sendTextViaApi(db, input))).toMatchObject({ status: 502, code: 'send_unknown', maybeSent: true })
  })

  it('returns message_id null (not "") when the row cannot be read back after the send', async () => {
    const noRow = {
      from: (table: string) => ({
        select: () => {
          const b: Record<string, unknown> = {
            eq: () => b,
            maybeSingle: async () => ({ data: table === 'accounts' ? { owner_user_id: 'u1' } : table === 'whatsapp_config' ? { id: 'cfg' } : null, error: null }),
          }
          return b
        },
      }),
    } as unknown as SupabaseClient
    const r = await sendTextViaApi(noRow, input)
    expect(r.message_id).toBeNull()
    expect(r.whatsapp_message_id).toBe('wamid.1')
  })

  it('hands the idempotency claim id to the engine so it lands on the message row', async () => {
    await sendTextViaApi(db, { ...input, claimId: 'claim-A' })
    expect(h.lastArgs).toMatchObject({ origin: 'api', apiRequestId: 'claim-A' })
  })

  it('tells the caller where the message will land, right before the provider call', async () => {
    const seen: unknown[] = []
    await sendTextViaApi(db, { ...input, onBeforeSend: async (i) => void seen.push([i, h.sends]) })
    expect(seen).toEqual([[{ conversationId: 'conv1', contactId: 'c1', channel: 'official' }, 0]])
  })

  it('does not record anything when the plan gate refuses (nothing can have been sent)', async () => {
    h.hasModule = false
    const seen: unknown[] = []
    await failure(sendTextViaApi(db, { ...input, onBeforeSend: async (i) => void seen.push(i) }))
    expect(seen).toEqual([])
  })

  it('"sent but DB insert failed" is marked as possibly sent so an idempotent retry is not re-sent', async () => {
    h.sendError = new Error('sent to Meta but DB insert failed: x')
    expect(await failure(sendTextViaApi(db, input))).toMatchObject({ status: 502, code: 'send_unconfirmed', maybeSent: true })
  })
})

describe('classifySendFailure', () => {
  const cases: [string, unknown, number, string, boolean][] = [
    ['gateway not configured', new GatewayNotConfiguredError(), 422, 'channel_not_configured', false],
    ['Meta not configured', new Error('WhatsApp not configured for this account'), 422, 'channel_not_configured', false],
    ['gateway not_connected', new GatewayRequestError('x', 409, 'not_connected'), 422, 'channel_not_connected', false],
    ['gateway throttled (anti-ban queue full, refused before sending)', new GatewayRequestError('x', 429, 'throttled'), 429, 'send_queue_full', false],
    ['gateway not_on_whatsapp', new GatewayRequestError('x', 422, 'not_on_whatsapp'), 422, 'not_on_whatsapp', false],
    ['gateway invalid_request', new GatewayRequestError('x', 400, 'invalid_request'), 422, 'send_rejected', false],
    ['gateway rejects our secret (401)', new GatewayUnreachableError('x', 401), 502, 'send_failed', false],
    ['Meta 4xx', new MetaApiError('bad', { httpStatus: 400 }), 502, 'send_failed', false],
    ['contact lookup failure before sending', new Error('contact not found for this account'), 500, 'internal_error', false],
    // ambiguous: the provider may have taken the message
    ['gateway send_failed', new GatewayRequestError('x', 502, 'send_failed'), 502, 'send_unknown', true],
    ['gateway timeout', new GatewayUnreachableError('tempo esgotado'), 502, 'send_unknown', true],
    ['gateway 5xx', new GatewayUnreachableError('boom', 503), 502, 'send_unknown', true],
    ['Meta 401', new MetaApiError('token', { httpStatus: 401 }), 502, 'send_failed', false],
    ['Meta 404', new MetaApiError('nf', { httpStatus: 404 }), 502, 'send_failed', false],
    ['Meta 422', new MetaApiError('un', { httpStatus: 422 }), 502, 'send_failed', false],
    ['Meta 408 (timeout from a proxy)', new MetaApiError('to', { httpStatus: 408 }), 502, 'send_unknown', true],
    ['Meta 429', new MetaApiError('slow down', { httpStatus: 429 }), 502, 'send_unknown', true],
    ['Meta 409', new MetaApiError('conflict', { httpStatus: 409 }), 502, 'send_unknown', true],
    ['Meta 5xx', new MetaApiError('oops', { httpStatus: 500 }), 502, 'send_unknown', true],
    ['socket reset', new TypeError('fetch failed'), 502, 'send_unknown', true],
    ['unreadable 2xx body', new TypeError("Cannot read properties of undefined (reading '0')"), 502, 'send_unknown', true],
    ['sent but not recorded', new Error('sent via gateway but DB insert failed: x'), 502, 'send_unconfirmed', true],
    ['non-error throw', 'weird', 502, 'send_unknown', true],
  ]
  it.each(cases)('%s', (_name, err, status, code, maybeSent) => {
    const e = classifySendFailure(err)
    expect(e).toBeInstanceOf(ApiSendError)
    expect([e.status, e.code, e.maybeSent]).toEqual([status, code, maybeSent])
  })
})
