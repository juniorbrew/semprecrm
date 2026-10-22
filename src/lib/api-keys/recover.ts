import type { SupabaseClient } from '@supabase/supabase-js'

import type { RecoverResult, StaleClaim } from './idempotency'

/**
 * Resolves an idempotent send that never recorded its result (the process died, or the
 * result update was lost). The claim row says where the message would have been written
 * (conversation, set right before the provider call):
 *   - no conversation recorded  -> the send never began: safe to run again;
 *   - an API-origin message with this text in that conversation since the claim -> it
 *     went out: replay the success;
 *   - otherwise the outcome is genuinely unknown: the caller stores send_unknown.
 */
export async function recoverApiMessage(
  db: SupabaseClient,
  claim: StaleClaim,
  text: unknown,
): Promise<RecoverResult> {
  if (!claim.conversation_id) return { kind: 'unsent' }
  const { data, error } = await db
    .from('messages')
    .select('id, message_id, content_text')
    .eq('conversation_id', claim.conversation_id)
    .eq('origin', 'api')
    .eq('sender_type', 'bot')
    .gte('created_at', claim.created_at)
    .order('created_at', { ascending: true })
    .limit(20)
  if (error) return { kind: 'unknown' }
  const hit = (data ?? []).find((m) => m.content_text === text)
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
