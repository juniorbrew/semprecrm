// Optional short note that goes with a transfer ("Transferir") — stored in
// the `assigned` event payload (`reason`) and echoed in the push sent to the
// new assignee. One normaliser shared by the UI, the event payload and the
// push route so all three agree on what is kept.

export const MAX_TRANSFER_REASON = 200

/** Trim, collapse whitespace, cap by code points; null when nothing is left. */
export function normalizeTransferReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = Array.from(raw.replace(/\s+/g, ' ').trim())
    .slice(0, MAX_TRANSFER_REASON)
    .join('')
    .trim()
  return text || null
}

/** `payload` of the `assigned` event logged by a transfer. */
export function transferEventPayload(params: {
  assigneeUserId: string
  assigneeName?: string | null
  selfAssigned: boolean
  reason?: unknown
}): {
  assignee_user_id: string
  assignee_name?: string
  self_assigned: boolean
  reason?: string
} {
  const reason = normalizeTransferReason(params.reason)
  return {
    assignee_user_id: params.assigneeUserId,
    assignee_name: params.assigneeName ?? undefined,
    self_assigned: params.selfAssigned,
    ...(reason ? { reason } : {}),
  }
}
