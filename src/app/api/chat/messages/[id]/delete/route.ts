// ============================================================
// POST /api/chat/messages/[id]/delete — internal chat, phase 2.
//
// Soft-deletes one of the caller's own messages: `deleted_at` is set
// through the caller's RLS-scoped client (the BEFORE UPDATE trigger
// empties the body and clears the attachment column), then the
// attachment object — if any — is removed from the private
// `chat-internal` bucket with the service role. Members have no
// DELETE policy on that bucket, so the removal has to happen here,
// after the ownership check.
//
// Response: { ok: true, message } (the updated row) — the client
// merges it into its list; realtime carries it to everyone else.
// ============================================================

import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { asChatAttachment, CHAT_INTERNAL_BUCKET } from '@/lib/chat/attachments'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getCurrentAccount()
    const limit = checkRateLimit(`chat:delete:${ctx.userId}`, RATE_LIMITS.react)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "'id' must be a uuid" }, { status: 400 })
    }

    // RLS: only threads I belong to are visible at all.
    const { data: message, error } = await ctx.supabase
      .from('chat_messages')
      .select('id, sender_id, kind, deleted_at, attachment')
      .eq('id', id)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!message) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    if (message.sender_id !== ctx.userId) {
      return NextResponse.json({ error: 'Only the sender can delete a message' }, { status: 403 })
    }
    if (message.kind !== 'text') {
      return NextResponse.json({ error: 'System messages cannot be deleted' }, { status: 400 })
    }

    const attachment = asChatAttachment(message.attachment)

    if (!message.deleted_at) {
      const { error: updateError } = await ctx.supabase
        .from('chat_messages')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
      if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    if (attachment?.path) {
      // Best effort: the row is already marked deleted; a stale object is
      // unreachable (no message points to it) and logged for follow-up.
      const { error: removeError } = await supabaseAdmin().storage.from(CHAT_INTERNAL_BUCKET).remove([attachment.path])
      if (removeError) console.error('[chat] attachment removal failed:', attachment.path, removeError.message)
    }

    const { data: updated, error: reloadError } = await ctx.supabase
      .from('chat_messages')
      .select('*')
      .eq('id', id)
      .single()
    if (reloadError) return NextResponse.json({ error: reloadError.message }, { status: 500 })
    return NextResponse.json({ ok: true, message: updated })
  } catch (err) {
    return toErrorResponse(err)
  }
}
