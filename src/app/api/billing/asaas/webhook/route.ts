// ============================================================
// POST /api/billing/asaas/webhook — Asaas payment events
// (docs/superpowers/specs/2026-10-12-billing-asaas-design.md).
//
// Trust: the `asaas-access-token` header must equal ASAAS_WEBHOOK_TOKEN
// (constant time). Even then the body is only a hint: before activating
// an account the payment is re-read from the Asaas API, so a forged or
// replayed body cannot grant a plan.
//
// Delivery is at-least-once: each event id is stored once and an event
// already processed answers 200 without doing anything. A transient
// failure answers 500 so Asaas retries; one that would fail the same way
// on every retry is stored and answered 200, because Asaas pauses the
// whole queue (every tenant) after repeated failures.
// ============================================================

import { timingSafeEqual } from 'node:crypto'

import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { AsaasError, getPayment, type AsaasPayment } from '@/lib/billing/asaas'
import { eventEffect, isBillingCycle, PAID_STATUSES, periodEnd } from '@/lib/billing/rules'

export const dynamic = 'force-dynamic'

type WebhookBody = {
  id?: unknown
  event?: unknown
  payment?: { id?: unknown; subscription?: unknown } | null
}

/** Fails the same way on every retry: store it, do not block the queue. */
class PermanentError extends Error {}

function isPermanent(err: unknown): boolean {
  if (err instanceof PermanentError) return true
  return err instanceof AsaasError && [400, 404, 422].includes(err.status)
}

function tokenMatches(received: string | null, expected: string): boolean {
  if (!received) return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  const expected = process.env.ASAAS_WEBHOOK_TOKEN
  if (!expected) return NextResponse.json({ error: 'not configured' }, { status: 503 })
  if (!tokenMatches(request.headers.get('asaas-access-token'), expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as WebhookBody | null
  const eventId = typeof body?.id === 'string' ? body.id : null
  const event = typeof body?.event === 'string' ? body.event : null
  if (!body || !eventId || !event) return NextResponse.json({ error: 'bad payload' }, { status: 400 })

  const db = supabaseAdmin()
  const { error: insErr } = await db
    .from('billing_webhook_events')
    .insert({ event_id: eventId, event, payload: redact(body) })
  if (insErr) {
    if (insErr.code !== '23505') {
      console.error('[billing/webhook] store failed:', insErr.message)
      return NextResponse.json({ error: 'store failed' }, { status: 500 })
    }
    const { data: seen } = await db
      .from('billing_webhook_events')
      .select('processed_at')
      .eq('event_id', eventId)
      .maybeSingle()
    if (seen?.processed_at) return NextResponse.json({ ok: true, duplicate: true })
    // Stored before but failed: process again.
  }

  try {
    await processEvent(db, event, body.payment ?? null)
    await db.from('billing_webhook_events').update({ processed_at: new Date().toISOString(), error: null }).eq('event_id', eventId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const permanent = isPermanent(err)
    console.error(`[billing/webhook] ${permanent ? 'event dropped' : 'processing failed'}:`, message)
    await db
      .from('billing_webhook_events')
      .update({ error: message.slice(0, 500), ...(permanent ? { processed_at: new Date().toISOString() } : {}) })
      .eq('event_id', eventId)
    return permanent ? NextResponse.json({ ok: false }) : NextResponse.json({ error: 'processing failed' }, { status: 500 })
  }
}

async function processEvent(
  db: ReturnType<typeof supabaseAdmin>,
  event: string,
  hint: WebhookBody['payment'],
): Promise<void> {
  const paymentId = typeof hint?.id === 'string' ? hint.id : null
  const subscriptionId = typeof hint?.subscription === 'string' ? hint.subscription : null
  if (!paymentId || !subscriptionId) return // not a subscription charge: nothing of ours
  const effect = eventEffect(event)
  if (effect === 'record') return // the API is read only when the account may change

  const { data: billing, error } = await db
    .from('account_billing')
    .select('account_id, cycle')
    .eq('asaas_subscription_id', subscriptionId)
    .maybeSingle()
  if (error) throw new Error(`billing read failed: ${error.message}`)
  if (!billing) return // a subscription we do not know (old, deleted or other system)

  // The source of truth is the API, never the body.
  const payment = await getPayment(paymentId)
  if (payment.subscription !== subscriptionId) throw new PermanentError('payment does not belong to the subscription')
  await savePayment(db, billing.account_id, subscriptionId, payment)

  if (effect === 'activate') {
    if (!PAID_STATUSES.has(payment.status)) return // event says paid, API does not (yet)
    if (!isBillingCycle(billing.cycle)) throw new PermanentError(`unknown cycle ${billing.cycle}`)
    const { error: rpcErr } = await db.rpc('billing_activate', {
      p_account_id: billing.account_id,
      p_subscription_id: subscriptionId,
      p_period_end: periodEnd(payment.dueDate, billing.cycle).toISOString(),
    })
    if (rpcErr) throw new Error(`activate failed: ${rpcErr.message}`)
  } else if (effect === 'past_due') {
    if (PAID_STATUSES.has(payment.status)) return // stale event: already paid again
    const { error: rpcErr } = await db.rpc('billing_mark_past_due', {
      p_account_id: billing.account_id,
      p_subscription_id: subscriptionId,
    })
    if (rpcErr) throw new Error(`past_due failed: ${rpcErr.message}`)
  }
}

async function savePayment(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  subscriptionId: string,
  p: AsaasPayment,
): Promise<void> {
  const paidOn = p.confirmedDate ?? p.paymentDate ?? null
  const { error } = await db.from('billing_payments').upsert({
    asaas_payment_id: p.id,
    account_id: accountId,
    asaas_subscription_id: subscriptionId,
    status: p.status,
    billing_type: p.billingType ?? null,
    value_cents: Math.round(p.value * 100),
    due_date: p.dueDate,
    invoice_url: p.invoiceUrl ?? null,
    paid_at: paidOn,
  }, { onConflict: 'asaas_payment_id' })
  if (error) throw new Error(`payment save failed: ${error.message}`)
}

/** The stored copy keeps no card data (Asaas sends a card token on card payments). */
function redact(body: WebhookBody): WebhookBody {
  if (!body.payment || typeof body.payment !== 'object') return body
  const payment = { ...(body.payment as Record<string, unknown>) }
  delete payment.creditCard
  return { ...body, payment }
}
