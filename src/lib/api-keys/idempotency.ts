import { createHash, randomUUID } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'

import { isUniqueViolation } from '@/lib/contacts/dedupe'

/**
 * `Idempotency-Key` for POST /api/v1/messages, Stripe style.
 *
 *  - The claim row is INSERTED before anything is sent (primary key
 *    account_id + key), so two concurrent requests with one key can never both
 *    send: the loser gets 409 `idempotency_in_progress`.
 *  - Every claim carries a random `claim_id`. It is written on the message row the
 *    send creates (messages.api_request_id), so "did THIS claim send?" is answered by
 *    an exact match, never by guessing from the text. Releasing, taking over and
 *    saving act only on the claim they were given (compare-and-set on claim_id).
 *  - Same key + same body after completion: the stored response is replayed
 *    with `Idempotent-Replayed: true`. Same key + different body: 422.
 *  - A request that failed BEFORE the provider could have accepted anything
 *    (validation, plan gate, a documented pre-send rejection) releases the key, so
 *    the caller can fix it and retry with the same key. Every other outcome where
 *    the message may have left (a timeout, socket reset, 5xx, a failure while
 *    recording it) is stored, as `send_unknown` / `send_unconfirmed`, and replayed:
 *    the API never re-sends on an ambiguous outcome.
 *  - Crash recovery: a claim still `in_progress` after IDEMPOTENCY_LEASE_MS is
 *    resolved by the next retry through `recover`: its message found by claim_id ->
 *    the success is replayed; the send never began -> the claim is taken over by an
 *    atomic compare-and-delete (exactly one retry wins) and the request runs;
 *    otherwise `send_unknown` is stored. Never a blind re-send, never a dead 409.
 *  - A late result from the original request may replace a stored `send_unknown`
 *    (the truth), but never a stored success.
 *  - Rows are purged after 24h (api_purge(), run by the webhooks cron).
 */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key'
/**
 * Longer than the worst send path: QR pacing (~1.2-1.7 s per message, serialized per
 * account: 120 queued sends is ~3 min) plus the provider call (30 s timeout).
 */
export const IDEMPOTENCY_LEASE_MS = 10 * 60_000
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

/** What a stale claim recorded (see sendTextViaApi.onBeforeSend). */
export interface StaleClaim {
  claim_id: string | null
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
  newClaimId?: () => string
}

/** `run` receives this claim's id: it must travel with the message the send creates. */
export type IdempotentRun = (claimId: string) => Promise<IdempotentOutcome>

type Where = { account_id: string; key: string; claim_id: string | null }

export async function runIdempotent(
  db: SupabaseClient,
  input: { accountId: string; key: string; hash: string },
  run: IdempotentRun,
  deps: IdempotencyDeps = {},
  tookOver = false,
): Promise<IdempotentResult> {
  const now = deps.now ?? (() => new Date())
  const claimId = (deps.newClaimId ?? randomUUID)()
  const { error } = await db
    .from('api_idempotency_keys')
    .insert({ account_id: input.accountId, key: input.key, request_hash: input.hash, status: 'in_progress', claim_id: claimId })

  if (error) {
    if (!isUniqueViolation(error)) throw new Error(`idempotency claim failed: ${error.message}`)
    const { data: existing } = await db
      .from('api_idempotency_keys')
      .select('request_hash, status, response_status, response, created_at, claim_id, conversation_id, contact_id, channel')
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
    const stale: Where = { account_id: input.accountId, key: input.key, claim_id: (existing.claim_id as string | null) ?? null }
    const found: RecoverResult = deps.recover ? await deps.recover(existing as StaleClaim) : { kind: 'unknown' }
    if (found.kind === 'unsent' && !tookOver) {
      // The send never began. Take the claim over ATOMICALLY: of several concurrent retries
      // exactly one deletes the row and runs; the others see 409.
      if (!(await remove(db, stale))) {
        return conflict(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is being processed. Retry shortly.')
      }
      return runIdempotent(db, input, run, deps, true)
    }
    const resolved =
      found.kind === 'sent' ? { status: found.status, body: found.body } : { status: 502, body: SEND_UNKNOWN_BODY }
    await save(db, stale, resolved, deps, 'recovery')
    return { kind: 'replay', status: resolved.status, body: resolved.body }
  }

  const mine: Where = { account_id: input.accountId, key: input.key, claim_id: claimId }
  let outcome: IdempotentOutcome
  try {
    outcome = await run(claimId)
  } catch (err) {
    await remove(db, mine)
    throw err
  }
  if (!outcome.store) {
    await remove(db, mine)
    return { kind: 'fresh', status: outcome.status, body: outcome.body }
  }
  await save(db, mine, { status: outcome.status, body: outcome.body }, deps, 'original')
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
 * Stores the result of THIS claim (never of a newer one). Retried: the message has
 * already been sent and a lost update would leave the key in progress.
 *  - 'original': the request that did the work. May replace an in-progress row or a
 *    stored failure/unknown (>= 300), never a stored success.
 *  - 'recovery': a later retry resolving a stale claim. Only fills a row still in progress.
 */
async function save(
  db: SupabaseClient,
  where: Where,
  result: { status: number; body: unknown },
  deps: IdempotencyDeps,
  mode: 'original' | 'recovery',
) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let lastError = ''
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    let q = db
      .from('api_idempotency_keys')
      .update({ status: 'done', response_status: result.status, response: result.body })
      .eq('account_id', where.account_id)
      .eq('key', where.key)
    q = where.claim_id === null ? q.is('claim_id', null) : q.eq('claim_id', where.claim_id)
    q = mode === 'recovery' ? q.eq('status', 'in_progress') : q.or('status.eq.in_progress,response_status.gte.300')
    const { error } = await q
    if (!error) return
    lastError = error.message
    await sleep(100 * 2 ** attempt)
  }
  console.error('[api-v1] storing idempotent response failed:', lastError)
}

/** Compare-and-delete of an in-progress claim. True only when exactly this claim was removed. */
async function remove(db: SupabaseClient, where: Where): Promise<boolean> {
  let q = db
    .from('api_idempotency_keys')
    .delete()
    .eq('account_id', where.account_id)
    .eq('key', where.key)
    .eq('status', 'in_progress')
  q = where.claim_id === null ? q.is('claim_id', null) : q.eq('claim_id', where.claim_id)
  const { data, error } = await q.select('key')
  if (error) {
    console.error('[api-v1] releasing idempotency key failed:', error.message)
    return false
  }
  return (data?.length ?? 0) === 1
}
