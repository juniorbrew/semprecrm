// read-only: allowed (public API: authenticateApiKey already refuses read-only and blocked accounts)
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { apiError, authenticateApiKey, respondLogged } from '@/lib/api-keys/auth'
import {
  IDEMPOTENCY_HEADER,
  parseIdempotencyKey,
  requestHash,
  runIdempotent,
  type IdempotentOutcome,
} from '@/lib/api-keys/idempotency'
import { SendTargetNotRecorded, markSendTarget, recoverApiMessage } from '@/lib/api-keys/recover'
import { ApiSendError, sendTextViaApi } from '@/lib/api-keys/send-message'
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'

export const dynamic = 'force-dynamic'

/**
 * POST /api/v1/messages  { to, text, channel? }
 * Sends a WhatsApp text through the account's channel (official or QR).
 * Needs the `messages:send` permission. Send an `Idempotency-Key` header so a
 * retry after a timeout can never message the customer twice.
 */
export async function POST(request: Request) {
  const auth = await authenticateApiKey(request, 'messages:send')
  if (!auth.ok) return auth.response
  const { ctx } = auth
  const done = (res: NextResponse) => respondLogged(ctx, request, res)

  const idem = parseIdempotencyKey(request.headers.get(IDEMPOTENCY_HEADER))
  if ('error' in idem) return done(apiError(400, 'invalid_idempotency_key', idem.error))

  let body: Record<string, unknown>
  try {
    const parsed = await request.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return done(apiError(400, 'invalid_json', 'The body must be a JSON object.'))
  }

  const db = supabaseAdmin()
  const run = async (claimId?: string): Promise<IdempotentOutcome> => {
    try {
      const sent = await sendTextViaApi(db, {
        accountId: ctx.accountId,
        to: body.to,
        text: body.text,
        channel: body.channel,
        claimId,
        // Remember where the message will land so a later retry can resolve a crashed send.
        // Fails closed: no record, no send (a retryable 503, the key is released).
        onBeforeSend:
          idem.key && claimId
            ? async (info) => {
                try {
                  await markSendTarget(db, { accountId: ctx.accountId, key: idem.key as string, claimId }, info)
                } catch (err) {
                  if (err instanceof SendTargetNotRecorded) {
                    throw new ApiSendError(503, 'temporarily_unavailable', 'Could not start the send safely. Nothing was sent; retry shortly.')
                  }
                  throw err
                }
              }
            : undefined,
      })
      return { status: 201, body: { object: 'message', ...sent }, store: true }
    } catch (err) {
      if (err instanceof ApiSendError) {
        return { status: err.status, body: { error: { code: err.code, message: err.message } }, store: err.maybeSent }
      }
      throw err
    }
  }

  try {
    if (!idem.key) {
      const out = await run(undefined)
      return done(NextResponse.json(out.body, { status: out.status }))
    }
    const result = await runIdempotent(
      db,
      {
        accountId: ctx.accountId,
        key: idem.key,
        hash: requestHash({
          // A phone is normalised; an Instagram / Messenger id is hashed as given (digits, not a phone).
          to: typeof body.to === 'string' && body.channel !== 'instagram' && body.channel !== 'messenger' ? sanitizePhoneForMeta(body.to) : body.to,
          text: body.text,
          channel: body.channel ?? null,
        }),
      },
      run,
      { recover: (claim) => recoverApiMessage(db, claim) },
    )
    if (result.kind === 'conflict') return done(apiError(result.status, result.code, result.message))
    return done(
      NextResponse.json(result.body, {
        status: result.status,
        headers: result.kind === 'replay' ? { 'Idempotent-Replayed': 'true' } : undefined,
      }),
    )
  } catch (err) {
    console.error('[api-v1] POST /messages failed:', err instanceof Error ? err.message : err)
    return done(apiError(500, 'internal_error', 'Unexpected error.'))
  }
}
