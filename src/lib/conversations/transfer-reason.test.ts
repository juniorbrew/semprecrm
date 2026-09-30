import { describe, expect, it } from 'vitest'
import { eventFromRecord, formatConversationEvent } from './events'
import { MAX_TRANSFER_REASON, normalizeTransferReason, transferEventPayload } from './transfer-reason'
import type { ConversationEventRecord } from '@/types'

describe('normalizeTransferReason', () => {
  it('trims, collapses whitespace and drops empties', () => {
    expect(normalizeTransferReason('  cliente   quer\nproposta  ')).toBe('cliente quer proposta')
    expect(normalizeTransferReason('   ')).toBeNull()
    expect(normalizeTransferReason(undefined)).toBeNull()
    expect(normalizeTransferReason(42)).toBeNull()
  })

  it('caps at 200 code points without splitting an emoji', () => {
    const long = 'a'.repeat(300)
    expect(normalizeTransferReason(long)).toHaveLength(MAX_TRANSFER_REASON)
    const emojis = '😀'.repeat(250)
    const out = normalizeTransferReason(emojis)!
    expect(Array.from(out)).toHaveLength(MAX_TRANSFER_REASON)
    expect(out.endsWith('😀')).toBe(true)
  })
})

describe('transferEventPayload + pill', () => {
  it('stores the reason only when there is one', () => {
    expect(transferEventPayload({ assigneeUserId: 'u2', assigneeName: 'Bruno', selfAssigned: false })).toEqual({
      assignee_user_id: 'u2',
      assignee_name: 'Bruno',
      self_assigned: false,
    })
    expect(
      transferEventPayload({ assigneeUserId: 'u2', selfAssigned: false, reason: '  fatura vencida ' }).reason,
    ).toBe('fatura vencida')
  })

  it('renders "Transferida por X para Y — motivo"', () => {
    const row: ConversationEventRecord = {
      id: 'e',
      account_id: 'a',
      conversation_id: 'c',
      actor_user_id: 'u1',
      event_type: 'assigned',
      payload: transferEventPayload({ assigneeUserId: 'u2', assigneeName: 'Bruno', selfAssigned: false, reason: 'fatura vencida' }),
      created_at: '2026-09-12T10:00:00Z',
    }
    const ev = eventFromRecord(row, (id) => ({ u1: 'Ana', u2: 'Bruno' })[id])
    expect(formatConversationEvent(ev, 'pt-BR')).toBe('Transferida por Ana para Bruno — fatura vencida')
    expect(formatConversationEvent(ev, 'en-US')).toBe('Transferred by Ana to Bruno — fatura vencida')
    // Without a reason the old wording stays.
    const plain = eventFromRecord({ ...row, payload: { assignee_user_id: 'u2', self_assigned: false } }, (id) => ({ u1: 'Ana', u2: 'Bruno' })[id])
    expect(formatConversationEvent(plain, 'pt-BR')).toBe('Ana atribuiu para Bruno')
  })

  it('bounds a stored reason again on read (foreign writers)', () => {
    const row = {
      id: 'e', account_id: 'a', conversation_id: 'c', actor_user_id: 'u1', event_type: 'assigned',
      payload: { assignee_user_id: 'u2', reason: 'x'.repeat(900) }, created_at: '2026-09-12T10:00:00Z',
    } as ConversationEventRecord
    expect(eventFromRecord(row).reason).toHaveLength(MAX_TRANSFER_REASON)
  })
})
