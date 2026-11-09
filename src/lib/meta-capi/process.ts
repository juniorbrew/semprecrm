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
}

export interface ProcessSummary {
  claimed: number
  sent: number
  retrying: number
  failed: number
  cancelled: number
  paused: number
}

export async function processCapiBatch(deps: ProcessDeps, limit = 50): Promise<ProcessSummary> {
  const now = deps.now ?? (() => new Date())
  const dec = deps.decryptToken ?? decrypt
  const send = deps.send ?? sendCapiEvents
  const { db } = deps
  const summary: ProcessSummary = { claimed: 0, sent: 0, retrying: 0, failed: 0, cancelled: 0, paused: 0 }

  const { data, error } = await db.rpc('meta_capi_claim', { p_limit: limit, p_lease_seconds: 120 })
  if (error) throw new Error(`meta_capi_claim failed: ${error.code ?? 'unknown'}`)
  const rows = (data ?? []) as ClaimedEvent[]
  summary.claimed = rows.length
  const pausedAccounts = new Set<string>()

  const finish = (id: string, patch: Record<string, unknown>) =>
    db.from('meta_capi_events').update({ ...patch, claimed_until: null }).eq('id', id).eq('status', 'pending')

  for (const row of rows) {
    if (pausedAccounts.has(row.account_id)) {
      await finish(row.id, {}) // lease released; the account is paused, the row waits
      continue
    }
    const built = buildCapiEvent(row)
    if (!built.ok) {
      await finish(row.id, { status: 'cancelled', last_error: built.reason })
      summary.cancelled += 1
      continue
    }
    if (now().getTime() - new Date(row.occurred_at).getTime() > MAX_EVENT_AGE_MS) {
      await finish(row.id, { status: 'failed', last_error: 'O evento tem mais de 7 dias e a Meta não aceita mais.' })
      summary.failed += 1
      continue
    }
    let outcome: SendOutcome
    try {
      outcome = await send({
        datasetId: row.dataset_id,
        token: dec(row.token_enc),
        body: buildRequestBody([built.event], row.test_event_code),
        fetchImpl: deps.fetchImpl,
      })
    } catch {
      outcome = { ok: false, error: 'Não foi possível ler a chave de acesso. Cole-a de novo.', code: null, retryable: false }
    }
    const attempts = row.attempts + 1
    if (outcome.ok) {
      await finish(row.id, { status: 'sent', attempts, sent_at: now().toISOString(), last_error: null })
      summary.sent += 1
      continue
    }
    if (outcome.code === 190) {
      pausedAccounts.add(row.account_id)
      summary.paused += 1
      await db
        .from('meta_capi_settings')
        .update({ paused_reason: 'invalid_token' })
        .eq('account_id', row.account_id)
        .is('paused_reason', null)
      await finish(row.id, { attempts, last_error: outcome.error })
      continue
    }
    const next = outcome.retryable ? nextAttemptAt(attempts, now()) : null
    if (next) {
      await finish(row.id, { attempts, last_error: outcome.error, next_attempt_at: next.toISOString() })
      summary.retrying += 1
    } else {
      await finish(row.id, { status: 'failed', attempts, last_error: outcome.error })
      summary.failed += 1
    }
  }
  return summary
}
