// Runs the automatic triage off the response path. Called by the two
// inbound transports (Meta webhook, QR gateway) with the ingest result.

import { after } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runTriageQuietly } from './ai-triage'

export function scheduleTriageIfDue(
  result: { triageDue?: boolean; conversationId?: string },
  accountId: string,
): void {
  if (!result.triageDue || !result.conversationId) return
  const conversationId = result.conversationId
  const run = () => runTriageQuietly(supabaseAdmin(), { accountId, conversationId }).then(() => undefined)
  try {
    // Tracked by the framework (graceful stop waits for it) inside a request scope.
    after(run)
  } catch {
    void run()
  }
}
