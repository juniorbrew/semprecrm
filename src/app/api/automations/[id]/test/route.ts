import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { simulateAutomation } from '@/lib/automations/engine'
import type { Automation } from '@/types'

/**
 * POST /api/automations/:id/test — "test with a contact" (dry run).
 *
 * Body: `{ contact_id, message_text? }`. Walks the saved automation for
 * that contact: conditions are evaluated for real (read-only), actions
 * are described, nothing is sent, tagged, logged or claimed. Also says
 * whether a real event would run it right now (frequency guard).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = (await request.json().catch(() => null)) as
    | { contact_id?: unknown; message_text?: unknown }
    | null
  const contactId = typeof body?.contact_id === 'string' ? body.contact_id : ''
  if (!contactId) return NextResponse.json({ error: 'contact_id is required' }, { status: 400 })
  const messageText = typeof body?.message_text === 'string' ? body.message_text.slice(0, 2000) : undefined

  const admin = supabaseAdmin()
  const { data: automation } = await admin
    .from('automations')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // The contact's conversation, so message-scoped conditions and "once
  // per attendance" see what a real inbound event would.
  const { data: conversation } = await admin
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  try {
    const result = await simulateAutomation({
      automation: automation as Automation,
      contactId,
      context: {
        message_text: messageText,
        conversation_id: (conversation as { id?: string } | null)?.id,
      },
    })
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = /not found/.test(msg) ? 404 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
