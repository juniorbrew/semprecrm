// ============================================================
// Server-side convenience over `logAudit`: resolves the shared
// service-role client lazily and swallows *every* failure, including
// a missing SUPABASE_SERVICE_ROLE_KEY (unit tests, misconfigured
// forks). Routes call `audit({...})` after their mutation and never
// have to think about the trail failing.
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
