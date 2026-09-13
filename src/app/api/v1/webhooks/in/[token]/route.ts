// ============================================================
// /api/v1/webhooks/in/[token] — public lead-capture endpoint.
//
//   POST — receive a lead (JSON, form-urlencoded or multipart) for
//          the source identified by `token`.
//   GET  — { ok: true, source: <name> } so the customer can paste the
//          URL in a browser and see it resolves before wiring a form.
//
// No session: the token in the path is the credential, so everything
// runs through the service-role client. Steps (spec §2):
//
//   rate limit (60/min per token) → source by token, active (404) →
//   `lead_capture` module on the account (403) → parse body (400) →
//   ingestLead (400 invalid phone / 500) → automations:
//   new_contact_created when the contact is new, and always
//   lead_captured with vars { source_id, source_name }.
// ============================================================

import { NextResponse } from 'next/server'

import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { ingestLead, parseLeadBody, type IngestLeadSource } from '@/lib/lead-capture'
import { isLeadSourceToken } from '@/lib/lead-capture/token'
import { accountHasModule } from '@/lib/plans-server'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 60/min per token — a form on a busy landing page, not a firehose. */
const LEAD_WEBHOOK_LIMIT = { limit: 60, windowMs: 60_000 }

type RouteContext = { params: Promise<{ token: string }> }

type SourceRow = IngestLeadSource & { is_active: boolean }

/**
 * Resolve the source for a token. Malformed tokens short-circuit to
 * "not found" without a query, and inactive sources look identical to
 * missing ones so a paused form can't tell it exists.
 */
async function findActiveSource(token: string): Promise<SourceRow | null> {
  if (!isLeadSourceToken(token)) return null
  const { data, error } = await supabaseAdmin()
    .from('lead_sources')
    .select(
      'id, account_id, name, is_active, pipeline_id, stage_id, tag_ids, assignee_user_id, field_map, received_count',
    )
    .eq('token', token)
    .maybeSingle()
  if (error) {
    console.error('[lead-webhook] source lookup failed:', error.message)
    return null
  }
  if (!data || !(data as SourceRow).is_active) return null
  return data as SourceRow
}

const notFound = () => NextResponse.json({ ok: false, error: 'Source not found' }, { status: 404 })

export async function GET(_request: Request, { params }: RouteContext) {
  const { token } = await params
  const limit = checkRateLimit(`lead-webhook:${token}`, LEAD_WEBHOOK_LIMIT)
  if (!limit.success) return rateLimitResponse(limit)

  const source = await findActiveSource(token)
  if (!source) return notFound()
  return NextResponse.json({ ok: true, source: source.name })
}

export async function POST(request: Request, { params }: RouteContext) {
  const { token } = await params
  const limit = checkRateLimit(`lead-webhook:${token}`, LEAD_WEBHOOK_LIMIT)
  if (!limit.success) return rateLimitResponse(limit)

  const source = await findActiveSource(token)
  if (!source) return notFound()

  const db = supabaseAdmin()
  if (!(await accountHasModule(db, source.account_id, 'lead_capture'))) {
    return NextResponse.json(
      { ok: false, error: 'Lead capture is not included in this account plan', code: 'module_not_included' },
      { status: 403 },
    )
  }

  const payload = await parseLeadBody(request)
  if (!payload) {
    return NextResponse.json(
      { ok: false, error: 'Body must be a JSON object, form-urlencoded or multipart form' },
      { status: 400 },
    )
  }

  const result = await ingestLead(db, source, payload)

  if (result.status === 'error') {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.httpStatus })
  }

  // Automations are fire-and-forget from the caller's point of view but
  // we await them here: serverless hosts may freeze the process the
  // moment the response is sent. The engine never throws.
  const contactId = result.contactId ?? null
  if (result.contactCreated) {
    await runAutomationsForTrigger({
      accountId: source.account_id,
      triggerType: 'new_contact_created',
      contactId,
      context: { vars: { source_id: source.id, source_name: source.name } },
    })
  }
  await runAutomationsForTrigger({
    accountId: source.account_id,
    triggerType: 'lead_captured',
    contactId,
    context: {
      vars: {
        source_id: source.id,
        source_name: source.name,
        deal_id: result.dealId ?? null,
        duplicate: result.duplicate,
      },
    },
  })

  return NextResponse.json({
    ok: true,
    contact_id: result.contactId ?? null,
    deal_id: result.dealId ?? null,
    duplicate: result.duplicate,
  })
}
