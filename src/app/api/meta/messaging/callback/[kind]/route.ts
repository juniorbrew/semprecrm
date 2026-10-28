// GET /api/meta/messaging/callback/{instagram|messenger} — Meta redirects here with `code` + `state`.
// This URL goes in the Meta app's "Valid OAuth redirect URIs" (docs/runbooks/meta-app-instagram-messenger.md).
import { NextResponse } from 'next/server'

import { handleCallback, isKind } from '@/lib/meta-messaging/connect/handlers'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params
  if (!isKind(kind)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return handleCallback(request, kind)
}
