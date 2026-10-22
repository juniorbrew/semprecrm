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
 *  - A request that failed BEFORE the provider could have accepted anything
 *    (validation, plan gate, a documented pre-send rejection) releases the key, so
 *    the caller can fix it and retry with the same key. Every other outcome where
 *    the message may have left (a timeout, socket reset, 5xx, a failure while
 *    recording it) is stored, as `send_unknown` / `send_unconfirmed`, and replayed:
 *    the API never re-sends on an ambiguous outcome.
 *  - Crash recovery: a claim still `in_progress` after IDEMPOTENCY_LEASE_MS is
 *    resolved by the next retry through `recover` (it looks for the message the
 *    crashed request would have written): found -> the success is replayed; the send
 *    never began -> the claim is taken over and the request runs; otherwise
 *    `send_unknown` is stored. Never a blind re-send, never a dead 409 for 24h.
 *  - Rows are purged after 24h (api_purge(), run by the webhooks cron).
 */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key'
export const IDEMPOTENCY_LEASE_MS = 3 * 60_000
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/
const SAVE_ATTEMPTS = 3

export const SEND_UNKNOWN_BODY = {
  error: {
    code: 'send_unknown',
    message: 'The outcome is unknown: the message may have been delivered. Check the conversation before sending it again.',
  },
}

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

/** What a stale claim recorded before the send started (see sendTextViaApi.onBeforeSend). */
export interface StaleClaim {
  created_at: string
  conversation_id: string | null
  contact_id: string | null
  channel: string | null
}

export type RecoverResult =
  | { kind: 'sent'; status: number; body: unknown }
  | { kind: 'unsent' }
  | { kind: 'unknown' }

export interface IdempotencyDeps {
  now?: () => Date
  recover?: (claim: StaleClaim) => Promise<RecoverResult>
  sleep?: (ms: number) => Promise<void>
}

export async function runIdempotent(
  db: SupabaseClient,
  input: { accountId: string; key: string; hash: string },
  run: () => Promise<IdempotentOutcome>,
  deps: IdempotencyDeps = {},
  tookOver = false,
): Promise<IdempotentResult> {
  const now = deps.now ?? (() => new Date())
  const where = { account_id: input.accountId, key: input.key }
  const { error } = await db
    .from('api_idempotency_keys')
    .insert({ ...where, request_hash: input.hash, status: 'in_progress' })

  if (error) {
    if (!isUniqueViolation(error)) throw new Error(`idempotency claim failed: ${error.message}`)
    const { data: existing } = await db
      .from('api_idempotency_keys')
      .select('request_hash, status, response_status, response, created_at, conversation_id, contact_id, channel')
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
    const age = now().getTime() - new Date(existing.created_at as string).getTime()
    if (age < IDEMPOTENCY_LEASE_MS) {
      return conflict(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still being processed. Retry shortly.')
    }

    // The original request is gone (or stuck): resolve it instead of blocking for 24h.
    const found: RecoverResult = deps.recover ? await deps.recover(existing as StaleClaim) : { kind: 'unknown' }
    if (found.kind === 'unsent' && !tookOver) {
      // The send never began: free the claim (compare-and-delete) and run as a fresh request.
      await release(db, where)
      return runIdempotent(db, input, run, deps, true)
    }
    const resolved =
      found.kind === 'sent' ? { status: found.status, body: found.body } : { status: 502, body: SEND_UNKNOWN_BODY }
    await save(db, where, resolved, deps, 'in_progress')
    return { kind: 'replay', status: resolved.status, body: resolved.body }
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
  await save(db, where, { status: outcome.status, body: outcome.body }, deps)
  return { kind: 'fresh', status: outcome.status, body: outcome.body }
}

function conflict(
  status: 409 | 422,
  code: 'idempotency_in_progress' | 'idempotency_key_reused',
  message: string,
): IdempotentResult {
  return { kind: 'conflict', status, code, message }
}

/**
 * Stores the result. Retried: the message has already been sent, and a lost update would
 * leave the key in progress. `onlyIfStatus` makes a recovery write lose to a late success.
 */
async function save(
  db: SupabaseClient,
  where: { account_id: string; key: string },
  result: { status: number; body: unknown },
  deps: IdempotencyDeps,
  onlyIfStatus?: 'in_progress',
) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let lastError = ''
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    let q = db
      .from('api_idempotency_keys')
      .update({ status: 'done', response_status: result.status, response: result.body })
      .eq('account_id', where.account_id)
      .eq('key', where.key)
    if (onlyIfStatus) q = q.eq('status', onlyIfStatus)
    const { error } = await q
    if (!error) return
    lastError = error.message
    await sleep(100 * 2 ** attempt)
  }
  console.error('[api-v1] storing idempotent response failed:', lastError)
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
