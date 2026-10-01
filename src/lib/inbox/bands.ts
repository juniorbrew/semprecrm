// ============================================================
// Inbox list bands (Atendimento redesign, stage 2).
//
// The live tabs (Minhas / Todas) group their rows into four bands, in
// this order, derived on the client from columns every row already has:
//
//   now       an SLA target (migration 072) breached or due within 15 min
//   you       needs an agent: pending, nobody assigned, or the customer
//             wrote and was never answered (no first response yet)
//   ongoing   open, assigned and answered; the customer spoke last
//   customer  our side spoke last — waiting on the customer
//
// Inside a band: nearest SLA deadline first, then the most recent
// message. Pure — the list renders what this returns.
// ============================================================

import { activeSlaTarget, type SlaFields } from '@/lib/support/sla'
import type { Conversation } from '@/types'

export type InboxBand = 'now' | 'you' | 'ongoing' | 'customer'

export const INBOX_BANDS: InboxBand[] = ['now', 'you', 'ongoing', 'customer']

/** An SLA due within this window lands in "Agora". */
export const NOW_BAND_MS = 15 * 60_000

export type BandRow = SlaFields &
  Pick<Conversation, 'id' | 'assigned_agent_id' | 'last_agent_message_at' | 'last_message_at' | 'created_at'>

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

export function bandOf(c: BandRow, now: number): InboxBand {
  const target = activeSlaTarget(c)
  if (target && target.dueAt - now < NOW_BAND_MS) return 'now'
  if (c.status === 'pending' || !c.assigned_agent_id) return 'you'
  const customerAt = ms(c.last_customer_message_at)
  const agentAt = ms(c.last_agent_message_at)
  if (customerAt !== null && !c.first_response_at && (agentAt === null || customerAt > agentAt)) return 'you'
  if (agentAt !== null && (customerAt === null || agentAt >= customerAt)) return 'customer'
  return 'ongoing'
}

export interface BandGroup<T> {
  band: InboxBand
  rows: T[]
}

/** Non-empty bands in display order; rows sorted inside each band. */
export function groupIntoBands<T extends BandRow>(rows: readonly T[], now: number): BandGroup<T>[] {
  const buckets = new Map<InboxBand, { row: T; due: number; at: number }[]>()
  for (const row of rows) {
    const band = bandOf(row, now)
    const target = activeSlaTarget(row)
    const entry = {
      row,
      due: target ? target.dueAt : Number.POSITIVE_INFINITY,
      at: ms(row.last_message_at) ?? ms(row.created_at) ?? 0,
    }
    const bucket = buckets.get(band)
    if (bucket) bucket.push(entry)
    else buckets.set(band, [entry])
  }
  const out: BandGroup<T>[] = []
  for (const band of INBOX_BANDS) {
    const bucket = buckets.get(band)
    if (!bucket) continue
    bucket.sort((a, b) => a.due - b.due || b.at - a.at || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0))
    out.push({ band, rows: bucket.map((e) => e.row) })
  }
  return out
}
