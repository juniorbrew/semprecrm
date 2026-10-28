// GET /api/meta/messaging/connect/{instagram|messenger} — start the connect flow
// (Settings → WhatsApp → Instagram / Messenger → Conectar). See src/lib/meta-messaging/connect/handlers.ts.
import { NextResponse } from 'next/server'

import { handleConnect, isKind } from '@/lib/meta-messaging/connect/handlers'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params
  if (!isKind(kind)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return handleConnect(request, kind)
}
