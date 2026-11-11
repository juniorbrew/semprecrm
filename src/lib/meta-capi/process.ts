// One cron pass: claim due events, build, send, record the outcome. Server only; the Supabase client is the
// service-role one (the tables have no write grant for user roles).
import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'

import { buildCapiEvent, buildRequestBody, type ClaimedEvent } from './payload'
import { sendCapiEvents, type FetchLike, type SendOutcome } from './send'

export const MAX_ATTEMPTS = 5
/** Wait after the 1st..4th failed attempt (the 5th ends in "failed"). */
export const BACKOFF_MINUTES = [1, 5, 30, 120]
/** Meta rejects a whole request when an event is older than 7 days. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 3600_000
/** Rows per pass: 15 sends at up to 10 s each fit in the lease (the loop also stops on a time budget). */
export const DEFAULT_LIMIT = 15
export const LEASE_SECONDS = 120
/** Stop starting new sends this long before the lease ends. */
export const LEASE_SAFETY_MS = 30_000

export function nextAttemptAt(failedAttempts: number, now: Date): Date | null {
  if (failedAttempts >= MAX_ATTEMPTS) return null
  return new Date(now.getTime() + BACKOFF_MINUTES[Math.min(failedAttempts, BACKOFF_MINUTES.length) - 1] * 60_000)
}

export interface ProcessDeps {
  db: SupabaseClient
  now?: () => Date
  decryptToken?: (stored: string) => string
  send?: typeof sendCapiEvents
  fetchImpl?: FetchLike
  leaseSeconds?: number
}

export interface ProcessSummary {
  claimed: number
  sent: number
  retrying: number
  failed: number
  cancelled: number
  paused: number
  /** Rows left for the next pass because the time budget ran out. */
  released: number
  /** Status updates that errored or matched no row (lease lost). */
  errors: number
}

export async function processCapiBatch(deps: ProcessDeps, limit = DEFAULT_LIMIT): Promise<ProcessSummary> {
  const now = deps.now ?? (() => new Date())
  const dec = deps.decryptToken ?? decrypt
  const send = deps.send ?? sendCapiEvents
  const leaseSeconds = deps.leaseSeconds ?? LEASE_SECONDS
  const { db } = deps
  const summary: ProcessSummary = { claimed: 0, sent: 0, retrying: 0, failed: 0, cancelled: 0, paused: 0, released: 0, errors: 0 }
  const started = now().getTime()

  const { data, error } = await db.rpc('meta_capi_claim', { p_limit: limit, p_lease_seconds: leaseSeconds })
  if (error) throw new Error(`meta_capi_claim failed: ${error.code ?? 'unknown'}`)
  const rows = (data ?? []) as ClaimedEvent[]
  summary.claimed = rows.length
  const pausedAccounts = new Set<string>()

  // Every update of a claimed row must still match THIS run's lease, so a stale run (whose lease expired and
  // was claimed again) never overwrites a newer one. Logs carry the event id and the error code only.
  const finish = async (row: ClaimedEvent, patch: Record<string, unknown>): Promise<void> => {
    const { data: updated, error: err } = await db
      .from('meta_capi_events')
      .update({ ...patch, claimed_until: null })
      .eq('id', row.id)
      .eq('status', 'pending')
      .eq('claimed_until', row.lease_until)
      .select('id')
    if (err) {
      summary.errors += 1
      console.error(`[meta-capi] update failed for event ${row.id}: ${err.code ?? 'unknown'}`)
    } else if (!updated || updated.length === 0) {
      summary.errors += 1
      console.error(`[meta-capi] lease lost for event ${row.id}`)
    }
  }

  const budgetEnd = started + leaseSeconds * 1000 - LEASE_SAFETY_MS
  for (const row of rows) {
    if (pausedAccounts.has(row.account_id) || now().getTime() >= budgetEnd) {
      if (!pausedAccounts.has(row.account_id)) summary.released += 1
      await finish(row, {}) // lease released: the row waits for the next pass (or for a new key)
      continue
    }
    const built = buildCapiEvent(row)
    if (!built.ok) {
      await finish(row, { status: built.outcome === 'cancel' ? 'cancelled' : 'failed', last_error: built.reason })
      summary[built.outcome === 'cancel' ? 'cancelled' : 'failed'] += 1
      continue
    }
    if (now().getTime() - new Date(row.occurred_at).getTime() > MAX_EVENT_AGE_MS) {
      await finish(row, { status: 'failed', last_error: 'O evento tem mais de 7 dias e a Meta não aceita mais.' })
      summary.failed += 1
      continue
    }
    let outcome: SendOutcome
    try {
      outcome = await send({
        datasetId: row.dataset_id,
        token: dec(row.token_enc),
        // Real events never carry the test code: it lives in the settings for the test button only.
        body: buildRequestBody([built.event]),
        fetchImpl: deps.fetchImpl,
      })
    } catch {
      outcome = { ok: false, error: 'Não foi possível ler a chave de acesso. Cole-a de novo.', code: null, retryable: false }
    }
    const attempts = row.attempts + 1
    if (outcome.ok) {
      await finish(row, { status: 'sent', attempts, sent_at: now().toISOString(), last_error: null })
      summary.sent += 1
      continue
    }
    if (outcome.code === 190) {
      pausedAccounts.add(row.account_id)
      summary.paused += 1
      // Only the token this run used: a fresh token saved mid-tick must not be paused.
      const { error: pauseError } = await db
        .from('meta_capi_settings')
        .update({ paused_reason: 'invalid_token' })
        .eq('account_id', row.account_id)
        .eq('token_enc', row.token_enc)
        .is('paused_reason', null)
      if (pauseError) {
        summary.errors += 1
        console.error(`[meta-capi] pause failed for account ${row.account_id}: ${pauseError.code ?? 'unknown'}`)
      }
      await finish(row, { attempts, last_error: outcome.error })
      continue
    }
    const next = outcome.retryable ? nextAttemptAt(attempts, now()) : null
    if (next) {
      await finish(row, { attempts, last_error: outcome.error, next_attempt_at: next.toISOString() })
      summary.retrying += 1
    } else {
      await finish(row, { status: 'failed', attempts, last_error: outcome.error })
      summary.failed += 1
    }
  }
  return summary
}
