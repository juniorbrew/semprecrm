// ============================================================
// Server-side convenience over `logAudit`: resolves the shared
// service-role client lazily and swallows *every* failure, including
// a missing SUPABASE_SERVICE_ROLE_KEY (unit tests, misconfigured
// forks). Routes call `audit({...})` after their mutation and never
// have to think about the trail failing.
//
// `auditStrict` is for actions the trail is part of (LGPD export /
// anonymisation, contact delete): it throws AuditWriteError when the
// row did not land, so the route can refuse or report it loudly.
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { logAudit, type AuditEntry } from '@/lib/audit'

export async function audit(entry: AuditEntry): Promise<boolean> {
  try {
    return await logAudit(supabaseAdmin(), entry)
  } catch (err) {
    console.error('[audit] service-role client unavailable:', err)
    return false
  }
}

export class AuditWriteError extends Error {
  constructor(action: string) {
    super(`audit write failed for ${action}`)
    this.name = 'AuditWriteError'
  }
}

/** Like `audit`, but throws AuditWriteError when the row was not written. */
export async function auditStrict(entry: AuditEntry): Promise<void> {
  if (!(await audit(entry))) throw new AuditWriteError(entry.action)
}
