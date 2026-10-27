// ============================================================
// Instagram / Messenger webhook events → inbox.
//
// One signed POST can carry events for several accounts. Each event is
// resolved to its account by the business id (`meta_messaging_channels`),
// then goes through the same pipeline as WhatsApp: `ingestInboundMessage`
// for the customer's messages, `ingestMessagingEcho` for the business's.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { ingestInboundMessage } from '@/lib/whatsapp/inbound'
import { findConnectionByExternalId, type MessagingConnection } from './connections'
import { ingestMessagingEcho } from './echo'
import { fetchMessagingProfile } from './graph'
import { copyMessagingMedia } from './media'
import type { MessagingAttachment, MessagingEvent } from './parse'

export interface ProcessSummary {
  processed: number
  duplicates: number
  echoes: number
  unknownRecipient: number
  failed: number
}

/** What an attachment becomes in the inbox. Stored text, so pt-BR like the rest of the conversation. */
const STORY_MENTION_TEXT = 'Mencionou você no story'
const UNAVAILABLE_TEXT = '[anexo indisponível]'
const MEDIA_TYPE: Record<string, 'image' | 'video' | 'audio' | 'document'> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  file: 'document',
}

interface Part {
  id: string
  type: string
  text: string | null
  mediaUrl: string | null
  mimeType: string | null
}

const join = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join('\n') || null

async function toPart(
  db: SupabaseClient,
  accountId: string,
  id: string,
  caption: string | null,
  att: MessagingAttachment | null,
): Promise<Part> {
  if (!att) return { id, type: 'text', text: caption, mediaUrl: null, mimeType: null }
  const mediaType = MEDIA_TYPE[att.type]
  if (mediaType) {
    const copied = att.url ? await copyMessagingMedia(db, accountId, att.url, id) : null
    if (copied) return { id, type: mediaType, text: caption, mediaUrl: copied.url, mimeType: copied.mimeType }
    return { id, type: 'text', text: join(caption, UNAVAILABLE_TEXT), mediaUrl: null, mimeType: null }
  }
  if (att.type === 'story_mention') {
    return { id, type: 'text', text: join(caption, STORY_MENTION_TEXT, att.url), mediaUrl: null, mimeType: null }
  }
  // location, shares, reels, fallback: the title and the link are all we can show.
  return { id, type: 'text', text: join(caption, att.title, att.url), mediaUrl: null, mimeType: null }
}

/** One part per attachment (text rides on the first); the id of the 2nd+ is `mid:n`. */
export async function toParts(db: SupabaseClient, accountId: string, e: MessagingEvent): Promise<Part[]> {
  if (e.attachments.length === 0) return [await toPart(db, accountId, e.mid, e.text, null)]
  return Promise.all(
    e.attachments.map((a, i) => toPart(db, accountId, i === 0 ? e.mid : `${e.mid}:${i}`, i === 0 ? e.text : null, a)),
  )
}

/** Cheap redelivery check BEFORE any media is downloaded (the pipelines dedupe again, authoritatively). */
async function alreadyStored(db: SupabaseClient, accountId: string, mid: string): Promise<boolean> {
  const { data } = await db
    .from('messages')
    .select('id, conversations!inner(account_id)')
    .eq('message_id', mid)
    .eq('conversations.account_id', accountId)
    .limit(1)
  return (data ?? []).length > 0
}

async function handleEvent(
  db: SupabaseClient,
  conn: MessagingConnection,
  e: MessagingEvent,
  summary: ProcessSummary,
): Promise<void> {
  if (await alreadyStored(db, conn.accountId, e.mid)) {
    summary.duplicates += 1
    return
  }
  const parts = await toParts(db, conn.accountId, e)

  if (e.echo) {
    for (const part of parts) {
      const r = await ingestMessagingEcho(db, {
        accountId: conn.accountId,
        kind: conn.kind,
        customerId: e.customerId,
        messageId: part.id,
        contentType: part.type,
        text: part.text,
        mediaUrl: part.mediaUrl,
        timestamp: e.timestamp,
        quotedMessageId: e.replyToMid,
      })
      if (!r.ok) summary.failed += 1
      else if (r.duplicate) summary.duplicates += 1
      else summary.echoes += 1
    }
    return
  }

  const getProfile = async () => {
    const profile = await fetchMessagingProfile(conn.kind, conn.token, e.customerId)
    if (!profile) return null
    const photo = profile.pictureUrl
      ? await copyMessagingMedia(db, conn.accountId, profile.pictureUrl, `avatar-${e.customerId}`)
      : null
    return { name: profile.name, avatarUrl: photo?.url ?? null }
  }
  for (const part of parts) {
    const r = await ingestInboundMessage(
      {
        accountId: conn.accountId,
        channel: conn.kind,
        from: e.customerId,
        messageId: part.id,
        type: part.type,
        text: part.text,
        mediaUrl: part.mediaUrl,
        mimeType: part.mimeType,
        quotedMessageId: e.replyToMid,
        timestamp: e.timestamp,
        getProfile,
      },
      db,
    )
    if (!r.ok) summary.failed += 1
    else if (r.reason === 'duplicate') summary.duplicates += 1
    else summary.processed += 1
  }
}

export async function processMessagingEvents(
  db: SupabaseClient,
  events: MessagingEvent[],
): Promise<ProcessSummary> {
  const summary: ProcessSummary = { processed: 0, duplicates: 0, echoes: 0, unknownRecipient: 0, failed: 0 }
  const connections = new Map<string, MessagingConnection | null>()
  for (const e of events) {
    const key = `${e.kind}:${e.businessId}`
    if (!connections.has(key)) connections.set(key, await findConnectionByExternalId(db, e.kind, e.businessId))
    const conn = connections.get(key)
    if (!conn) {
      summary.unknownRecipient += 1
      continue
    }
    try {
      await handleEvent(db, conn, e, summary)
    } catch (err) {
      summary.failed += 1
      console.error('[meta-messaging] event failed:', err instanceof Error ? err.message : err)
    }
  }
  return summary
}
