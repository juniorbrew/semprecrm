// ============================================================
// LGPD anonymisation (migration 035) — pure orchestration over an
// injected Supabase client so the sequence is unit-testable.
//
// Irreversible. What it does, in order:
//   1. Collects the contact's conversations; scrubs every message
//      (content_text → "[conteúdo removido]", media_url → null) and
//      removes the `chat-media` objects those URLs pointed at.
//   2. Deletes contact_notes and contact_custom_values.
//   3. contacts: name → "Contato anonimizado", phone → `anon-<8 hex>`
//      (random so the per-account uniqueness on `phone_normalized`
//      holds), email / company / avatar_url → null, opted_out_at and
//      anonymized_at = now(). Done LAST so a crash mid-way leaves the
//      contact visibly not anonymised and the operator retries.
// Conversations, deals and tasks keep their rows and their link to
// the contact (statistics / history) — nothing personal lives there.
//
// Callers (POST /api/contacts/[id]/anonymize) pass the service-role
// client: the storage delete and the messages update cross RLS
// boundaries a member session cannot.
// ============================================================

import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export const ANONYMIZED_NAME = 'Contato anonimizado'
export const REMOVED_CONTENT = '[conteúdo removido]'
export const CHAT_MEDIA_BUCKET = 'chat-media'

export function generateAnonymousPhone(
  randomHex: () => string = () => randomBytes(4).toString('hex'),
): string {
  return `anon-${randomHex()}`
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * Object path inside the `chat-media` bucket for a URL produced by
 * Supabase Storage (`…/storage/v1/object/public/chat-media/<path>`, or
 * the sign / authenticated variants), or `null` when the URL is not
 * ours (Meta CDN links, other buckets).
 */
export function extractChatMediaPath(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null
  const m = url.match(
    new RegExp(`/object/(?:public|sign|authenticated)/${CHAT_MEDIA_BUCKET}/([^?#]+)`),
  )
  if (!m || !m[1]) return null
  return safeDecode(m[1])
}

export interface AnonymizeResult {
  contactId: string
  anonymizedAt: string
  conversations: number
  messagesScrubbed: number
  mediaDeleted: number
  notesDeleted: number
  customValuesDeleted: number
  /** Non-fatal problems (storage delete refused, …). */
  warnings: string[]
}

export class AnonymizeError extends Error {
  readonly code: 'not_found' | 'already_anonymized' | 'db_error'
  constructor(code: AnonymizeError['code'], message: string) {
    super(message)
    this.name = 'AnonymizeError'
    this.code = code
  }
}

export interface AnonymizeOptions {
  now?: () => Date
  randomHex?: () => string
}

/**
 * Anonymise `contactId` inside `accountId`. Throws `AnonymizeError` for
 * a missing / already-anonymised contact or a hard DB failure on the
 * contact row itself; everything else is best-effort and reported in
 * `warnings`.
 */
export async function anonymizeContact(
  admin: SupabaseClient,
  accountId: string,
  contactId: string,
  opts: AnonymizeOptions = {},
): Promise<AnonymizeResult> {
  const now = (opts.now ?? (() => new Date()))().toISOString()
  const warnings: string[] = []

  const { data: contact, error: contactErr } = await admin
    .from('contacts')
    .select('id, account_id, anonymized_at')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (contactErr) throw new AnonymizeError('db_error', contactErr.message)
  if (!contact) throw new AnonymizeError('not_found', 'Contact not found')
  if ((contact as { anonymized_at?: string | null }).anonymized_at) {
    throw new AnonymizeError('already_anonymized', 'Contact is already anonymized')
  }

  // 1. Conversations → messages (collect media first, then scrub).
  const { data: convRows, error: convErr } = await admin
    .from('conversations')
    .select('id')
    .eq('contact_id', contactId)
  if (convErr) warnings.push(`conversations: ${convErr.message}`)
  const conversationIds = (convRows ?? []).map((r) => (r as { id: string }).id)

  let messagesScrubbed = 0
  let mediaDeleted = 0
  if (conversationIds.length > 0) {
    const { data: mediaRows, error: mediaErr } = await admin
      .from('messages')
      .select('media_url')
      .in('conversation_id', conversationIds)
      .not('media_url', 'is', null)
    if (mediaErr) warnings.push(`messages media lookup: ${mediaErr.message}`)
    const paths = Array.from(
      new Set(
        (mediaRows ?? [])
          .map((r) => extractChatMediaPath((r as { media_url: string | null }).media_url))
          .filter((p): p is string => !!p),
      ),
    )
    if (paths.length > 0) {
      const { data: removed, error: rmErr } = await admin.storage
        .from(CHAT_MEDIA_BUCKET)
        .remove(paths)
      if (rmErr) warnings.push(`storage remove: ${rmErr.message}`)
      else mediaDeleted = Array.isArray(removed) ? removed.length : paths.length
    }

    const { data: scrubbed, error: scrubErr } = await admin
      .from('messages')
      .update({ content_text: REMOVED_CONTENT, media_url: null })
      .in('conversation_id', conversationIds)
      .select('id')
    if (scrubErr) warnings.push(`messages scrub: ${scrubErr.message}`)
    else messagesScrubbed = scrubbed?.length ?? 0

    // The conversation list preview also carries the last body.
    const { error: convUpdErr } = await admin
      .from('conversations')
      .update({ last_message_text: REMOVED_CONTENT })
      .in('id', conversationIds)
      .not('last_message_text', 'is', null)
    if (convUpdErr) warnings.push(`conversations preview: ${convUpdErr.message}`)
  }

  // 2. Notes + custom field values.
  let notesDeleted = 0
  {
    const { data, error } = await admin
      .from('contact_notes')
      .delete()
      .eq('contact_id', contactId)
      .select('id')
    if (error) warnings.push(`notes: ${error.message}`)
    else notesDeleted = data?.length ?? 0
  }

  let customValuesDeleted = 0
  {
    const { data, error } = await admin
      .from('contact_custom_values')
      .delete()
      .eq('contact_id', contactId)
      .select('id')
    if (error) warnings.push(`custom values: ${error.message}`)
    else customValuesDeleted = data?.length ?? 0
  }

  // 3. The contact row itself — last on purpose (see header). The
  //    per-account UNIQUE on `phone_normalized` (digits of `phone`)
  //    could in theory collide on the digit projection of the random
  //    hex, so a 23505 gets a fresh value and a retry.
  let updErr: { code?: string; message: string } | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await admin
      .from('contacts')
      .update({
        name: ANONYMIZED_NAME,
        phone: generateAnonymousPhone(opts.randomHex),
        email: null,
        company: null,
        avatar_url: null,
        opted_out_at: now,
        anonymized_at: now,
        updated_at: now,
      })
      .eq('id', contactId)
      .eq('account_id', accountId)
    updErr = res.error
    if (!updErr || updErr.code !== '23505') break
  }
  if (updErr) throw new AnonymizeError('db_error', updErr.message)

  return {
    contactId,
    anonymizedAt: now,
    conversations: conversationIds.length,
    messagesScrubbed,
    mediaDeleted,
    notesDeleted,
    customValuesDeleted,
    warnings,
  }
}
