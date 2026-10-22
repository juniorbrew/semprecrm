import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'

import { WEBHOOK_API_VERSION, WEBHOOK_TEST_EVENT, eventPublicId } from './events'
import { loadAccountEntitlements } from '@/lib/plans-server'

import { MAX_DELIVERY_AGE_MS, planAfterFailure, shouldAutoDisable } from './retry'
import { buildSignatureHeader, SIGNATURE_HEADER } from './signing'
import { DestinoNaoPermitido, fetchSeguro } from './ssrf'

/** Row returned by the `webhook_claim_deliveries` RPC (migration 093). */
export interface ClaimedDelivery {
  delivery_id: string
  attempts: number
  delivery_created_at: string
  event_id: string
  event_type: string
  event_data: unknown
  event_created_at: string
  account_id: string
  endpoint_id: string
  url: string
  secret_enc: string
  previous_secret_enc: string | null
  previous_secret_expires_at: string | null
  failing_since: string | null
}

export interface SendResult {
  statusCode: number | null
  error: string | null
  snippet: string | null
  durationMs: number
}

export type SendFn = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<SendResult>

export const REQUEST_TIMEOUT_MS = 10_000
const SNIPPET_BYTES = 256

/**
 * Up to SNIPPET_BYTES of a text / JSON response, for the delivery log. Anything
 * else (HTML pages, binaries) is not kept: the log must not become a way to read
 * what an internal or third-party service answers.
 */
async function readSnippet(res: Response): Promise<string | null> {
  if (!res.body) return null
  if (!/^(application\/(.+\+)?json|text\/)/i.test(res.headers.get('content-type') ?? '')) {
    await res.body.cancel().catch(() => undefined)
    return null
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < SNIPPET_BYTES) {
      const { done, value } = await reader.read()
      if (done || !value) break
      chunks.push(value)
      size += value.length
    }
  } catch {
    // body errors do not change the HTTP outcome
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const text = Buffer.concat(chunks).subarray(0, SNIPPET_BYTES).toString('utf8')
  return text.length > 0 ? text : null
}

/** The only place a webhook leaves the server: always through the SSRF guard. */
export const sendWebhookRequest: SendFn = async (url, body, headers) => {
  const started = Date.now()
  // Re-checked on every send (the URL was validated at save time, but rows can predate a rule).
  let target: URL | null = null
  try {
    target = new URL(url)
  } catch {
    // handled below
  }
  if (!target || target.protocol !== 'https:' || target.port !== '') {
    return { statusCode: null, error: 'Destination not allowed (https on port 443 only)', snippet: null, durationMs: 0 }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    // maxRedirects 0: a 3xx is a failed delivery (like Stripe), never followed. A redirect
    // could otherwise lead to http, another port or the server itself.
    const res = await fetchSeguro(url, { method: 'POST', headers, body, signal: controller.signal }, 0)
    const snippet = await readSnippet(res)
    return { statusCode: res.status, error: null, snippet, durationMs: Date.now() - started }
  } catch (err) {
    let error: string
    if (err instanceof DestinoNaoPermitido) error = 'Destination not allowed (private or unresolvable address)'
    else if (controller.signal.aborted) error = `Timeout after ${REQUEST_TIMEOUT_MS / 1000}s`
    else error = (err instanceof Error ? err.message : String(err)).slice(0, 300)
    return { statusCode: null, error, snippet: null, durationMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/** The JSON a receiver gets. Same `id` on every retry, resend and endpoint (dedupe key). */
export function buildEventBody(row: Pick<ClaimedDelivery, 'event_id' | 'event_type' | 'event_data' | 'event_created_at' | 'account_id'>): string {
  return JSON.stringify({
    id: eventPublicId(row.event_id),
    object: 'event',
    api_version: WEBHOOK_API_VERSION,
    type: row.event_type,
    created: Math.floor(new Date(row.event_created_at).getTime() / 1000),
    account_id: row.account_id,
    data: { object: row.event_data },
  })
}

export interface DispatchDeps {
  db: SupabaseClient
  now?: () => Date
  rand?: () => number
  send?: SendFn
  decryptSecret?: (stored: string) => string
  /** False for blocked / suspended accounts (runDispatch fills in a cached plan check). */
  accountActive?: (accountId: string) => Promise<boolean>
}

export type DeliveryOutcome = 'delivered' | 'retrying' | 'failed' | 'held'
const HOLD_MS = 3600_000

/** Attempts one claimed delivery and records the outcome. */
export async function deliverClaimed(deps: DispatchDeps, row: ClaimedDelivery): Promise<DeliveryOutcome> {
  const now = deps.now ?? (() => new Date())
  const send = deps.send ?? sendWebhookRequest
  const dec = deps.decryptSecret ?? decrypt
  const { db } = deps

  const startedAt = now()
  const attemptNo = row.attempts + 1

  // Blocked / suspended accounts (paywall, kill switch) send nothing: hold the delivery
  // and look again in an hour; once it is older than the retry horizon it fails.
  if (deps.accountActive && !(await deps.accountActive(row.account_id))) {
    const tooOld = startedAt.getTime() - new Date(row.delivery_created_at).getTime() > MAX_DELIVERY_AGE_MS
    await db
      .from('webhook_deliveries')
      .update(
        tooOld
          ? { status: 'failed', claimed_until: null, last_error: 'Account blocked' }
          : { claimed_until: null, next_attempt_at: new Date(startedAt.getTime() + HOLD_MS).toISOString() },
      )
      .eq('id', row.delivery_id)
    return 'held'
  }

  const secrets = [dec(row.secret_enc)]
  if (
    row.previous_secret_enc &&
    row.previous_secret_expires_at &&
    new Date(row.previous_secret_expires_at).getTime() > startedAt.getTime()
  ) {
    secrets.push(dec(row.previous_secret_enc))
  }

  const body = buildEventBody(row)
  const timestamp = Math.floor(startedAt.getTime() / 1000)
  const result = await send(row.url, body, {
    'content-type': 'application/json',
    [SIGNATURE_HEADER]: buildSignatureHeader(secrets, timestamp, body),
    'SempreCRM-Event-Id': eventPublicId(row.event_id),
    'SempreCRM-Delivery-Id': row.delivery_id,
    'SempreCRM-Attempt': String(attemptNo),
  })

  const finishedAt = now()
  const ok = result.statusCode !== null && result.statusCode >= 200 && result.statusCode < 300
  const error = ok ? null : (result.error ?? `HTTP ${result.statusCode}`)

  // At-least-once window: the receiver has already processed this POST, but the
  // attempt row and the delivery update below are separate statements. A crash (or a
  // DB error) between the request and the delivery update leaves the row leased and
  // `pending` with the old attempt count; when the lease expires it is sent again with
  // the SAME event id. Receivers must dedupe on `id` (documented in docs/api-webhooks.md).
  await db.from('webhook_delivery_attempts').insert({
    delivery_id: row.delivery_id,
    account_id: row.account_id,
    attempt_no: attemptNo,
    started_at: startedAt.toISOString(),
    duration_ms: result.durationMs,
    status_code: result.statusCode,
    error,
    response_snippet: result.snippet,
  })

  const base = {
    attempts: attemptNo,
    claimed_until: null,
    last_attempt_at: finishedAt.toISOString(),
    last_status_code: result.statusCode,
    last_error: error,
  }
  const isTest = row.event_type === WEBHOOK_TEST_EVENT

  if (ok) {
    await db
      .from('webhook_deliveries')
      .update({ ...base, status: 'delivered', delivered_at: finishedAt.toISOString() })
      .eq('id', row.delivery_id)
    if (row.failing_since && !isTest) {
      await db.from('webhook_endpoints').update({ failing_since: null }).eq('id', row.endpoint_id)
    }
    return 'delivered'
  }

  const plan = planAfterFailure({
    attemptsDone: attemptNo,
    deliveryCreatedAt: new Date(row.delivery_created_at),
    now: finishedAt,
    eventType: row.event_type,
    endpointFailingMs: row.failing_since ? finishedAt.getTime() - new Date(row.failing_since).getTime() : 0,
    rand: deps.rand,
  })
  await db
    .from('webhook_deliveries')
    .update(
      plan.status === 'pending'
        ? { ...base, status: 'pending', next_attempt_at: plan.nextAttemptAt.toISOString() }
        : { ...base, status: 'failed' },
    )
    .eq('id', row.delivery_id)

  if (!isTest) {
    const failingSince = row.failing_since ? new Date(row.failing_since) : finishedAt
    if (shouldAutoDisable(failingSince, finishedAt)) {
      await db
        .from('webhook_endpoints')
        .update({ enabled: false, disabled_reason: 'auto_failures', failing_since: failingSince.toISOString() })
        .eq('id', row.endpoint_id)
    } else if (!row.failing_since) {
      await db.from('webhook_endpoints').update({ failing_since: failingSince.toISOString() }).eq('id', row.endpoint_id)
    }
  }
  return plan.status === 'pending' ? 'retrying' : 'failed'
}

export interface DispatchSummary {
  claimed: number
  delivered: number
  retrying: number
  failed: number
  held: number
  errors: number
}

/**
 * One cron pass: claim a batch (leased in the database, FOR UPDATE SKIP
 * LOCKED), deliver it with bounded concurrency, repeat while there is time
 * and the last batch was full. `deliveryId` delivers exactly that row now
 * (test event / resend feedback).
 */
export async function runDispatch(
  deps: DispatchDeps,
  opts: { batchSize?: number; concurrency?: number; budgetMs?: number; deliveryId?: string } = {},
): Promise<DispatchSummary> {
  const batchSize = opts.batchSize ?? 40
  const concurrency = opts.concurrency ?? 10
  const now = deps.now ?? (() => new Date())
  const deadline = now().getTime() + (opts.budgetMs ?? 40_000)
  const summary: DispatchSummary = { claimed: 0, delivered: 0, retrying: 0, failed: 0, held: 0, errors: 0 }

  // One plan lookup per account per pass. Unreadable plan = fail closed (hold).
  const planCache = new Map<string, Promise<boolean>>()
  const accountActive =
    deps.accountActive ??
    ((accountId: string) => {
      let hit = planCache.get(accountId)
      if (!hit) {
        hit = loadAccountEntitlements(deps.db, accountId).then((ent) => !!ent && !ent.blocked)
        planCache.set(accountId, hit)
      }
      return hit
    })
  deps = { ...deps, accountActive }

  for (;;) {
    const { data, error } = await deps.db.rpc('webhook_claim_deliveries', {
      p_limit: batchSize,
      p_lease_seconds: 120,
      p_delivery_id: opts.deliveryId ?? null,
      p_per_account: 10,
    })
    if (error) throw new Error(`claim failed: ${error.message}`)
    const rows = (data ?? []) as ClaimedDelivery[]
    summary.claimed += rows.length

    for (let i = 0; i < rows.length; i += concurrency) {
      await Promise.all(
        rows.slice(i, i + concurrency).map(async (row) => {
          try {
            summary[await deliverClaimed(deps, row)] += 1
          } catch (err) {
            // The lease expires and the row comes back due.
            summary.errors += 1
            console.error('[webhooks] delivery crashed:', err instanceof Error ? err.message : err)
          }
        }),
      )
    }
    // Rows capped per account can leave a batch short while work remains: keep going until
    // nothing is claimable (failed / held rows are rescheduled into the future, so this ends).
    if (opts.deliveryId || rows.length === 0 || now().getTime() >= deadline) break
  }
  return summary
}

/** Creates an event + one delivery for a single endpoint (test events, resend). */
export async function queueDelivery(
  db: SupabaseClient,
  input: { accountId: string; endpointId: string; eventId?: string; eventType: string; data?: unknown; resendOf?: string },
): Promise<string> {
  let eventId = input.eventId
  if (!eventId) {
    const { data, error } = await db
      .from('webhook_events')
      .insert({ account_id: input.accountId, type: input.eventType, data: input.data ?? {} })
      .select('id')
      .single()
    if (error || !data) throw new Error(`event insert failed: ${error?.message}`)
    eventId = data.id as string
  }
  const { data, error } = await db
    .from('webhook_deliveries')
    .insert({
      event_id: eventId,
      endpoint_id: input.endpointId,
      account_id: input.accountId,
      resend_of: input.resendOf ?? null,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`delivery insert failed: ${error?.message}`)
  return data.id as string
}
