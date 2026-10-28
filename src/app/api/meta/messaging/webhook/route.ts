// read-only: allowed (inbound: Meta Instagram/Messenger webhook)
import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { parseMessagingWebhook } from '@/lib/meta-messaging/parse'
import { verifyMessagingSignature } from '@/lib/meta-messaging/signature'
import { processMessagingEvents } from '@/lib/meta-messaging/webhook'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/request-ip'
import { supabaseServerUrl } from '@/lib/supabase/url'

// One webhook for Instagram Direct and Messenger (same `entry[].messaging[]`
// envelope). Subscribe it in the Meta app with META_MESSAGING_VERIFY_TOKEN.

let _adminClient: SupabaseClient | null = null
function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(supabaseServerUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY!)
  }
  return _adminClient
}

const sameSecret = (a: string, b: string) => {
  const x = crypto.createHash('sha256').update(a).digest()
  const y = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(x, y)
}

// GET - Meta's subscription handshake
export async function GET(request: Request) {
  const limit = checkRateLimit(`meta-msg-verify:${getClientIp(request)}`, RATE_LIMITS.webhookVerify)
  if (!limit.success) return rateLimitResponse(limit)

  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const challenge = searchParams.get('hub.challenge')
  const token = searchParams.get('hub.verify_token')
  if (mode !== 'subscribe' || !challenge || !token || challenge.length > 256 || token.length > 512) {
    return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 })
  }
  const expected = process.env.META_MESSAGING_VERIFY_TOKEN
  if (!expected || !sameSecret(token, expected)) {
    return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
  }
  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
}

// Meta's payloads are a few KB; anything near this is not Meta.
const MAX_BODY_BYTES = 1024 * 1024

// POST - events (HMAC-signed with the app secret)
export async function POST(request: Request) {
  // Refuse before buffering the body (the signature needs the whole thing).
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }
  // The exact bytes Meta signed: read the raw body before any JSON parsing.
  const rawBody = await request.text()
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }
  if (!verifyMessagingSignature(rawBody, request.headers.get('x-hub-signature-256'))) {
    console.warn('[meta-messaging] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const events = parseMessagingWebhook(body)
  if (events.length > 0) {
    // Inline, so a transient failure can be answered with a 5xx and Meta redelivers
    // (every part is deduped by its message id, so a replay is safe). Triage and the
    // AI auto-reply are intentionally off for these channels until part C.
    try {
      const summary = await processMessagingEvents(supabaseAdmin(), events)
      if (summary.failed > 0 || summary.unknownRecipient > 0 || summary.skipped > 0) {
        console.warn('[meta-messaging] webhook processed with problems:', JSON.stringify(summary))
      }
      if (summary.failed > 0) {
        return NextResponse.json({ error: 'Temporary failure, retry' }, { status: 500 })
      }
    } catch (err) {
      console.error('[meta-messaging] error processing webhook:', err instanceof Error ? err.name : 'error')
      return NextResponse.json({ error: 'Temporary failure, retry' }, { status: 500 })
    }
  }
  // Unknown recipients and ignored event types are acknowledged: retrying cannot help.
  return NextResponse.json({ status: 'received' }, { status: 200 })
}
