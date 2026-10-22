import { createHash } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import { isUniqueViolation } from '@/lib/contacts/dedupe'

/**
 * `Idempotency-Key` for POST /api/v1/messages, Stripe style.
 *
 *  - The claim row is INSERTED before anything is sent (primary key
 *    account_id + key), so two concurrent requests with one key can never both
 *    send: the loser gets 409 `idempotency_in_progress`.
 *  - Same key + same body after completion: the stored response is replayed
 *    with `Idempotent-Replayed: true`. Same key + different body: 422.
 *  - A request that failed BEFORE any message could have left (validation,
 *    contact/conversation errors, a provider refusal) releases the key, so the
 *    caller can fix it and retry with the same key. Only outcomes where the
 *    message may have been sent are stored, 2xx included.
 *  - A crash between the send and the stored result leaves the row
 *    `in_progress` until it is purged (24h): retries get 409 instead of a
 *    possible double send. That is the deliberate, safe side of the trade-off.
 *  - Rows are purged after 24h (api_purge(), run by the webhooks cron).
 */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key'
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/

export function parseIdempotencyKey(header: string | null): { key: string | null } | { error: string } {
  if (header === null) return { key: null }
  const key = header.trim()
  if (!KEY_PATTERN.test(key)) {
    return { error: 'The Idempotency-Key header must be 1 to 255 printable ASCII characters.' }
  }
  return { key }
}

/** Stable hash of the fields that define "the same request". */
export function requestHash(parts: Record<string, unknown>): string {
  const canonical = JSON.stringify(Object.keys(parts).sort().map((k) => [k, parts[k] ?? null]))
  return createHash('sha256').update(canonical).digest('hex')
}

export interface IdempotentOutcome {
  status: number
  body: unknown
  /** True when the message may have left: the result is stored for replays. */
  store: boolean
}

export type IdempotentResult =
  | { kind: 'fresh'; status: number; body: unknown }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'conflict'; status: 409 | 422; code: 'idempotency_in_progress' | 'idempotency_key_reused'; message: string }

export async function runIdempotent(
  db: SupabaseClient,
  input: { accountId: string; key: string; hash: string },
  run: () => Promise<IdempotentOutcome>,
): Promise<IdempotentResult> {
  const where = { account_id: input.accountId, key: input.key }
  const { error } = await db
    .from('api_idempotency_keys')
    .insert({ ...where, request_hash: input.hash, status: 'in_progress' })

  if (error) {
    if (!isUniqueViolation(error)) throw new Error(`idempotency claim failed: ${error.message}`)
    const { data: existing } = await db
      .from('api_idempotency_keys')
      .select('request_hash, status, response_status, response')
      .eq('account_id', input.accountId)
      .eq('key', input.key)
      .maybeSingle()
    // Released between our insert and this read: ask the caller to retry.
    if (!existing) {
      return conflict(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is being processed. Retry shortly.')
    }
    if (existing.request_hash !== input.hash) {
      return conflict(422, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request body.')
    }
    if (existing.status === 'done') {
      return { kind: 'replay', status: existing.response_status as number, body: existing.response }
    }
    return conflict(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still being processed. Retry shortly.')
  }

  let outcome: IdempotentOutcome
  try {
    outcome = await run()
  } catch (err) {
    await release(db, where)
    throw err
  }
  if (!outcome.store) {
    await release(db, where)
    return { kind: 'fresh', status: outcome.status, body: outcome.body }
  }
  const { error: saveError } = await db
    .from('api_idempotency_keys')
    .update({ status: 'done', response_status: outcome.status, response: outcome.body })
    .eq('account_id', input.accountId)
    .eq('key', input.key)
  if (saveError) console.error('[api-v1] storing idempotent response failed:', saveError.message)
  return { kind: 'fresh', status: outcome.status, body: outcome.body }
}

function conflict(
  status: 409 | 422,
  code: 'idempotency_in_progress' | 'idempotency_key_reused',
  message: string,
): IdempotentResult {
  return { kind: 'conflict', status, code, message }
}

async function release(db: SupabaseClient, where: { account_id: string; key: string }) {
  const { error } = await db
    .from('api_idempotency_keys')
    .delete()
    .eq('account_id', where.account_id)
    .eq('key', where.key)
    .eq('status', 'in_progress')
  if (error) console.error('[api-v1] releasing idempotency key failed:', error.message)
}
