import type { SupabaseClient } from '@supabase/supabase-js'

import type { RecoverResult, StaleClaim } from './idempotency'

/**
 * Resolves an idempotent send that never recorded its result (the process died, or the
 * result update was lost). The claim says where the message would have been written
 * (conversation, recorded right before the provider call) and carries a random
 * `claim_id` that the send stores on the message row (messages.api_request_id):
 *   - no conversation recorded  -> the send never began: safe to run again;
 *   - a message carrying THIS claim_id -> it went out: replay the success. Matching is
 *     by that id only, never by text or time: another request (or key) that sent the same
 *     words to the same contact is not mistaken for this one;
 *   - otherwise (including claims without an id) the outcome is genuinely unknown: the
 *     caller stores send_unknown.
 */
export async function recoverApiMessage(db: SupabaseClient, claim: StaleClaim): Promise<RecoverResult> {
  if (!claim.conversation_id) return { kind: 'unsent' }
  if (!claim.claim_id) return { kind: 'unknown' }
  const { data, error } = await db
    .from('messages')
    .select('id, message_id')
    .eq('conversation_id', claim.conversation_id)
    .eq('api_request_id', claim.claim_id)
    .limit(1)
  if (error) return { kind: 'unknown' }
  const hit = data?.[0]
  if (!hit) return { kind: 'unknown' }
  return {
    kind: 'sent',
    status: 201,
    body: {
      object: 'message',
      message_id: hit.id,
      conversation_id: claim.conversation_id,
      contact_id: claim.contact_id,
      channel: claim.channel,
      whatsapp_message_id: hit.message_id,
    },
  }
}

/**
 * Records where an idempotent message is about to be sent, on THIS claim. Fails closed:
 * if the write errors or the claim is no longer ours (taken over after a long stall) the
 * send must not start, otherwise a later recovery would see "never began" for a message
 * that went out and send it again. The caller turns the error into a retryable 503.
 */
export class SendTargetNotRecorded extends Error {
  constructor() {
    super('could not record the send target')
    this.name = 'SendTargetNotRecorded'
  }
}

export async function markSendTarget(
  db: SupabaseClient,
  claim: { accountId: string; key: string; claimId: string },
  info: { conversationId: string; contactId: string; channel: string },
): Promise<void> {
  const { data, error } = await db
    .from('api_idempotency_keys')
    .update({ conversation_id: info.conversationId, contact_id: info.contactId, channel: info.channel })
    .eq('account_id', claim.accountId)
    .eq('key', claim.key)
    .eq('claim_id', claim.claimId)
    .eq('status', 'in_progress')
    .select('key')
  if (error || (data?.length ?? 0) !== 1) {
    if (error) console.error('[api-v1] recording the send target failed:', error.message)
    throw new SendTargetNotRecorded()
  }
}
