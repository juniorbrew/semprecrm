// ============================================================
// `wa_qr_sessions` mirror + error mapping for the /api/channels/qr
// routes. Kept out of the route files so the three session-auth
// routes (connect / status / logout) and the gateway status-event
// route share one writer.
// ============================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import type { WaQrSession, WaQrSessionStatus } from '@/types'
import { toErrorResponse } from '@/lib/auth/account'
import {
  GatewayNotConfiguredError,
  GatewayRequestError,
  GatewayUnreachableError,
  type GatewaySessionState,
} from './qr-gateway'

export interface QrSessionPatch {
  status: WaQrSessionStatus
  phone_number?: string | null
  display_name?: string | null
  last_error?: string | null
  connected_at?: string | null
}

/**
 * Upsert the account's row. `connected_at` is stamped on the
 * transition into `connected` and cleared on `disconnected`; other
 * statuses leave it as-is unless the caller passes one explicitly.
 */
export async function upsertQrSession(
  db: SupabaseClient,
  accountId: string,
  patch: QrSessionPatch,
): Promise<WaQrSession | null> {
  const row: Record<string, unknown> = {
    account_id: accountId,
    status: patch.status,
    updated_at: new Date().toISOString(),
  }
  if (patch.phone_number !== undefined) row.phone_number = patch.phone_number
  if (patch.display_name !== undefined) row.display_name = patch.display_name
  if (patch.last_error !== undefined) row.last_error = patch.last_error
  if (patch.connected_at !== undefined) {
    row.connected_at = patch.connected_at
  } else if (patch.status === 'connected') {
    row.connected_at = new Date().toISOString()
  } else if (patch.status === 'disconnected') {
    row.connected_at = null
  }
  if (patch.status === 'connected' && patch.last_error === undefined) {
    row.last_error = null
  }

  const { data, error } = await db
    .from('wa_qr_sessions')
    .upsert(row, { onConflict: 'account_id' })
    .select()
    .maybeSingle()

  if (error) {
    console.error('[channels/qr] wa_qr_sessions upsert failed:', error.message)
    return null
  }
  return (data as WaQrSession | null) ?? null
}

export async function readQrSession(
  db: SupabaseClient,
  accountId: string,
): Promise<WaQrSession | null> {
  const { data, error } = await db
    .from('wa_qr_sessions')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    console.error('[channels/qr] wa_qr_sessions read failed:', error.message)
    return null
  }
  return (data as WaQrSession | null) ?? null
}

/** Mirror a gateway state payload into the DB row. */
export function patchFromGatewayState(state: GatewaySessionState): QrSessionPatch {
  return {
    status: state.status,
    phone_number: state.phone ?? null,
    display_name: state.name ?? null,
    last_error: state.error ?? null,
    ...(state.connected_at ? { connected_at: state.connected_at } : {}),
  }
}

/**
 * Map gateway + auth errors to responses. Gateway problems are 503
 * with a stable `code` so the settings panel can render the right
 * explanation ("Gateway não configurado" vs "fora do ar").
 */
export function qrErrorResponse(err: unknown, session?: WaQrSession | null): NextResponse {
  if (err instanceof GatewayNotConfiguredError || err instanceof GatewayUnreachableError) {
    return NextResponse.json(
      { error: err.message, code: err.code, session: session ?? null },
      { status: 503 },
    )
  }
  if (err instanceof GatewayRequestError) {
    return NextResponse.json(
      { error: err.message, code: err.code, session: session ?? null },
      { status: err.status >= 400 && err.status < 500 ? err.status : 502 },
    )
  }
  return toErrorResponse(err)
}
