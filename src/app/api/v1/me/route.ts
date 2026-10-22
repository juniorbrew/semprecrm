import { NextResponse } from 'next/server'

import { authenticateApiKey, respondLogged } from '@/lib/api-keys/auth'

export const dynamic = 'force-dynamic'

/** Cheap auth check: 200 + the key's account and permissions, or 401. */
export async function GET(request: Request) {
  const auth = await authenticateApiKey(request, null)
  if (!auth.ok) return auth.response
  return respondLogged(
    auth.ctx,
    request,
    NextResponse.json({
      account_id: auth.ctx.accountId,
      api_key_id: auth.ctx.keyId,
      scopes: auth.ctx.scopes,
    }),
  )
}
