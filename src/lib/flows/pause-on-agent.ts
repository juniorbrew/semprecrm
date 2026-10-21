import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from './admin-client'

/**
 * Pause any active Flow run for this contact — an agent stepping in (a manual
 * send or a scheduled message going out under their name) is the strongest
 * "yield, human is here" signal. We pause (not end) to preserve diagnostic
 * state; the agent or the 24h timeout sweep resolves the run later. For
 * accounts with no active runs the UPDATE matches zero rows — cheap and
 * harmless. Best-effort: the message already landed, so a bookkeeping miss is
 * logged, never surfaced.
 */
export async function pauseActiveFlowRuns(
  accountId: string,
  contactId: string,
  db: SupabaseClient = supabaseAdmin(),
): Promise<void> {
  try {
    const { error: pauseErr } = await db
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('status', 'active')
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message)
    }
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err,
    )
  }
}
