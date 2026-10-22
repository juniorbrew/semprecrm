import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import { SendTargetNotRecorded, markSendTarget, recoverApiMessage } from './recover'

const claim = {
  claim_id: 'claim-A',
  created_at: '2026-10-01T12:00:00Z',
  conversation_id: 'conv1',
  contact_id: 'c1',
  channel: 'official',
}

type Msg = { id: string; message_id: string; conversation_id: string; api_request_id: string | null; content_text: string }

/** Messages table honouring eq filters, so what gets matched is observable. */
function dbWith(messages: Msg[], error: { message: string } | null = null) {
  const eqs: Record<string, unknown> = {}
  const b: Record<string, unknown> = {
    eq: (c: string, v: unknown) => ((eqs[c] = v), b),
    limit: async (n: number) => ({
      data: error ? null : messages.filter((m) => Object.entries(eqs).every(([k, v]) => (m as Record<string, unknown>)[k] === v)).slice(0, n),
      error,
    }),
  }
  const db = { from: () => ({ select: () => b }) } as unknown as SupabaseClient
  return { db, eqs }
}

describe('recoverApiMessage', () => {
  it('says "unsent" when no conversation was recorded (the send never began)', async () => {
    const { db } = dbWith([])
    expect(await recoverApiMessage(db, { ...claim, conversation_id: null })).toEqual({ kind: 'unsent' })
  })

  it('finds the message that carries THIS claim id and rebuilds the success response', async () => {
    const { db, eqs } = dbWith([{ id: 'm1', message_id: 'w1', conversation_id: 'conv1', api_request_id: 'claim-A', content_text: 'oi' }])
    expect(await recoverApiMessage(db, claim)).toEqual({
      kind: 'sent',
      status: 201,
      body: { object: 'message', message_id: 'm1', conversation_id: 'conv1', contact_id: 'c1', channel: 'official', whatsapp_message_id: 'w1' },
    })
    expect(eqs).toEqual({ conversation_id: 'conv1', api_request_id: 'claim-A' })
  })

  it('does NOT match the same text sent by a different request or key', async () => {
    const { db } = dbWith([
      { id: 'm2', message_id: 'w2', conversation_id: 'conv1', api_request_id: 'claim-B', content_text: 'oi' },
      { id: 'm3', message_id: 'w3', conversation_id: 'conv1', api_request_id: null, content_text: 'oi' },
    ])
    expect(await recoverApiMessage(db, claim)).toEqual({ kind: 'unknown' })
  })

  it('does not match a message with this claim id in another conversation', async () => {
    const { db } = dbWith([{ id: 'm1', message_id: 'w1', conversation_id: 'other', api_request_id: 'claim-A', content_text: 'oi' }])
    expect(await recoverApiMessage(db, claim)).toEqual({ kind: 'unknown' })
  })

  it('is "unknown" for a claim without an id (older rows) and when the lookup fails', async () => {
    expect(await recoverApiMessage(dbWith([]).db, { ...claim, claim_id: null })).toEqual({ kind: 'unknown' })
    expect(await recoverApiMessage(dbWith([], { message: 'down' }).db, claim)).toEqual({ kind: 'unknown' })
  })
})

describe('markSendTarget (fail closed)', () => {
  function updDb(result: { data?: unknown; error?: { message: string } | null }) {
    const eqs: Record<string, unknown> = {}
    const b: Record<string, unknown> = {
      eq: (c: string, v: unknown) => ((eqs[c] = v), b),
      select: async () => ({ data: null, error: null, ...result }),
    }
    return { db: { from: () => ({ update: () => b }) } as unknown as SupabaseClient, eqs }
  }
  const target = { accountId: 'acc', key: 'k1', claimId: 'claim-A' }
  const info = { conversationId: 'conv1', contactId: 'c1', channel: 'official' }

  it('writes only on this claim, still in progress', async () => {
    const { db, eqs } = updDb({ data: [{ key: 'k1' }] })
    await expect(markSendTarget(db, target, info)).resolves.toBeUndefined()
    expect(eqs).toEqual({ account_id: 'acc', key: 'k1', claim_id: 'claim-A', status: 'in_progress' })
  })

  it('throws when the write errors, so the send does not start', async () => {
    const { db } = updDb({ error: { message: 'db down' } })
    await expect(markSendTarget(db, target, info)).rejects.toBeInstanceOf(SendTargetNotRecorded)
  })

  it('throws when the claim is no longer ours (0 rows updated)', async () => {
    const { db } = updDb({ data: [] })
    await expect(markSendTarget(db, target, info)).rejects.toBeInstanceOf(SendTargetNotRecorded)
  })
})
