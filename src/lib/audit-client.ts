// ============================================================
// Browser-side helper for `POST /api/audit` — records a client-
// originated action (contact / deal delete done straight through
// Supabase). Fire-and-forget: never throws, never blocks the UI.
// ============================================================

import type { AuditAction, AuditEntityType } from '@/lib/audit'

export interface RecordAuditInput {
  action: AuditAction
  entityType: AuditEntityType
  entityId?: string | null
  metadata?: Record<string, unknown>
}

export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    const res = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      keepalive: true,
    })
    if (!res.ok) {
      console.warn('[audit] client record refused:', res.status, input.action)
    }
  } catch (err) {
    console.warn('[audit] client record failed:', err)
  }
}
