import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import { recoverApiMessage } from './recover'

const claim = { created_at: '2026-10-01T12:00:00Z', conversation_id: 'conv1', contact_id: 'c1', channel: 'official' }

function dbWith(messages: { id: string; message_id: string; content_text: string }[], error: { message: string } | null = null) {
  const filters: Record<string, unknown> = {}
  const b: Record<string, unknown> = {
    eq: (c: string, v: unknown) => ((filters[c] = v), b),
    gte: (c: string, v: unknown) => ((filters[c] = v), b),
    order: () => b,
    limit: async () => ({ data: error ? null : messages, error }),
  }
  const db = { from: () => ({ select: () => b }) } as unknown as SupabaseClient
  return { db, filters }
}

describe('recoverApiMessage', () => {
  it('says "unsent" when no conversation was recorded (the send never began)', async () => {
    const { db } = dbWith([])
    expect(await recoverApiMessage(db, { ...claim, conversation_id: null }, 'oi')).toEqual({ kind: 'unsent' })
  })

  it('finds the API message with the same text and rebuilds the success response', async () => {
    const { db, filters } = dbWith([
      { id: 'm0', message_id: 'w0', content_text: 'outra' },
      { id: 'm1', message_id: 'w1', content_text: 'oi' },
    ])
    const r = await recoverApiMessage(db, claim, 'oi')
    expect(r).toEqual({
      kind: 'sent',
      status: 201,
      body: { object: 'message', message_id: 'm1', conversation_id: 'conv1', contact_id: 'c1', channel: 'official', whatsapp_message_id: 'w1' },
    })
    expect(filters).toMatchObject({ conversation_id: 'conv1', origin: 'api', sender_type: 'bot', created_at: claim.created_at })
  })

  it('is "unknown" when no matching message exists or the lookup fails', async () => {
    expect(await recoverApiMessage(dbWith([{ id: 'm0', message_id: 'w0', content_text: 'outra' }]).db, claim, 'oi')).toEqual({ kind: 'unknown' })
    expect(await recoverApiMessage(dbWith([], { message: 'down' }).db, claim, 'oi')).toEqual({ kind: 'unknown' })
  })
})
