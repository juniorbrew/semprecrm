// ============================================================
// Instagram / Messenger webhook events → inbox.
//
// One signed POST can carry events for several accounts. Each event is
// resolved to its account by the business id (`meta_messaging_channels`),
// then goes through the same pipeline as WhatsApp: `ingestInboundMessage`
// for the customer's messages, `ingestMessagingEcho` for the business's.
//
// Like the other transports, the AI auto-reply job is queued by the ingest (the route kicks
// the drain) and the AI triage is scheduled here for the customer's 1st / 3rd message.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { scheduleTriageIfDue } from '@/lib/support/triage-trigger'
import { ingestInboundMessage } from '@/lib/whatsapp/inbound'
import { accountHasModule } from '@/lib/plans-server'
import { findConnectionByExternalId, markConnectionExpired, type MessagingConnection } from './connections'
import { messagingModule } from './channels'
import { ingestMessagingEcho } from './echo'
import { fetchMessagingProfile } from './graph'
import { copyMessagingMedia, storeMessagingAvatar } from './media'
import type { MessagingAttachment, MessagingEvent } from './parse'

export interface ProcessSummary {
  processed: number
  duplicates: number
  echoes: number
  unknownRecipient: number
  /** Events of accounts whose plan lacks the channel module. */
  moduleOff: number
  /** An AI auto-reply job was queued: the route kicks the drain. */
  aiReplyQueued: boolean
  /** Permanent problems (nothing to retry). */
  skipped: number
  /** Transient failures: the route answers 5xx so Meta redelivers. */
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

interface PartSpec {
  id: string
  caption: string | null
  att: MessagingAttachment | null
}

/** One part per attachment (text rides on the first); the id of the 2nd+ is `mid:n`. */
export function partSpecs(e: MessagingEvent): PartSpec[] {
  if (e.attachments.length === 0) return [{ id: e.mid, caption: e.text, att: null }]
  return e.attachments.map((att, i) => ({ id: i === 0 ? e.mid : `${e.mid}:${i}`, caption: i === 0 ? e.text : null, att }))
}

/** Cheap redelivery check BEFORE any media is downloaded (the pipelines dedupe again, authoritatively). */
async function alreadyStored(db: SupabaseClient, accountId: string, id: string): Promise<boolean> {
  const { data } = await db
    .from('messages')
    .select('id, conversations!inner(account_id)')
    .eq('message_id', id)
    .eq('conversations.account_id', accountId)
    .limit(1)
  return (data ?? []).length > 0
}

// Not transient: retrying cannot fix an account without an owner.
const PERMANENT = new Set(['account_owner_not_found'])

async function handleEvent(
  db: SupabaseClient,
  conn: MessagingConnection,
  e: MessagingEvent,
  summary: ProcessSummary,
): Promise<void> {
  const getProfile = async () => {
    const profile = await fetchMessagingProfile(conn.kind, conn.token, e.customerId, () => void markConnectionExpired(db, conn.id))
    return profile ? { name: profile.name, pictureUrl: profile.pictureUrl } : null
  }
  const storeAvatar = (contactId: string, pictureUrl: string) =>
    storeMessagingAvatar(db, conn.accountId, contactId, pictureUrl)

  // Each part (mid, mid:1, …) is deduped on its own, so a redelivery after a partial failure
  // stores only what is missing.
  for (const spec of partSpecs(e)) {
    if (await alreadyStored(db, conn.accountId, spec.id)) {
      summary.duplicates += 1
      continue
    }
    const part = await toPart(db, conn.accountId, spec.id, spec.caption, spec.att)

    if (e.echo) {
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
      continue
    }

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
        storeAvatar,
      },
      db,
    )
    if (r.ok && r.reason === 'duplicate') summary.duplicates += 1
    else if (r.ok) {
      summary.processed += 1
      if (r.aiReplyQueued) summary.aiReplyQueued = true
      // AI triage on the customer's 1st / 3rd message (opt-in, never blocks).
      scheduleTriageIfDue(r, conn.accountId)
    }
    else if (r.reason && PERMANENT.has(r.reason)) summary.skipped += 1
    else summary.failed += 1
  }
}

async function moduleOn(db: SupabaseClient, conn: MessagingConnection, cache: Map<string, boolean>): Promise<boolean> {
  const mod = messagingModule(conn.kind)
  const key = `${conn.accountId}:${mod}`
  if (!cache.has(key)) {
    // Inbound keeps working in read-only mode; only the plan decides.
    cache.set(key, await accountHasModule(db, conn.accountId, mod, { allowReadOnly: true }))
  }
  return cache.get(key) as boolean
}

export async function processMessagingEvents(
  db: SupabaseClient,
  events: MessagingEvent[],
): Promise<ProcessSummary> {
  const summary: ProcessSummary = { processed: 0, duplicates: 0, echoes: 0, unknownRecipient: 0, moduleOff: 0, aiReplyQueued: false, skipped: 0, failed: 0 }
  const connections = new Map<string, MessagingConnection | null>()
  const moduleCache = new Map<string, boolean>()
  for (const e of events) {
    const key = `${e.kind}:${e.businessId}`
    if (!connections.has(key)) connections.set(key, await findConnectionByExternalId(db, e.kind, e.businessId))
    const conn = connections.get(key)
    // The channel's module (plan): an account without it gets nothing stored, and Meta an ack.
    if (conn && !(await moduleOn(db, conn, moduleCache))) {
      summary.moduleOff += 1
      continue
    }
    if (!conn) {
      summary.unknownRecipient += 1
      continue
    }
    try {
      await handleEvent(db, conn, e, summary)
    } catch (err) {
      summary.failed += 1
      console.error('[meta-messaging] event failed:', err instanceof Error ? err.name : 'error')
    }
  }
  return summary
}
