import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  hasModule: true,
  modulesAsked: [] as string[],
  sendError: null as Error | null,
  sends: 0,
}))

vi.mock('@/lib/plans-server', () => ({
  accountHasModule: async (_db: unknown, _acc: string, module: string) => (h.modulesAsked.push(module), h.hasModule),
}))
vi.mock('@/lib/automations/meta-send', () => ({
  engineSendText: async () => {
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

import { ApiSendError, sendTextViaApi } from './send-message'

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

  it('a provider refusal is retryable: not marked as possibly sent', async () => {
    h.sendError = new Error('Meta rejected the message')
    expect(await failure(sendTextViaApi(db, input))).toMatchObject({ status: 502, code: 'send_failed', maybeSent: false })
  })

  it('"sent but DB insert failed" is marked as possibly sent so an idempotent retry is not re-sent', async () => {
    h.sendError = new Error('sent to Meta but DB insert failed: x')
    expect(await failure(sendTextViaApi(db, input))).toMatchObject({ status: 502, code: 'send_unconfirmed', maybeSent: true })
  })
})
