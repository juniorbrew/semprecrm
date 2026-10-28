// ============================================================
// Graph API calls for Instagram Direct and Messenger.
//
//   instagram → graph.instagram.com  (Instagram API with Instagram login)
//   messenger → graph.facebook.com   (Page access token)
//
// Both take the same Send API body; the token travels in the
// Authorization header, never in the URL (it would end up in logs).
// ============================================================

import type { MetaMessagingChannel } from '@/types'

const GRAPH_VERSION = 'v21.0'
const GRAPH_BASE: Record<MetaMessagingChannel, string> = {
  instagram: `https://graph.instagram.com/${GRAPH_VERSION}`,
  messenger: `https://graph.facebook.com/${GRAPH_VERSION}`,
}
const TIMEOUT_MS = 15_000

export type MessagingMediaKind = 'image' | 'video' | 'audio' | 'file'

export class MessagingApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
    readonly subcode: number | null,
  ) {
    super(message)
    this.name = 'MessagingApiError'
  }

  /** Meta refused because the customer's 24 h window is closed. */
  get outsideWindow(): boolean {
    return this.subcode === 2534022 || this.subcode === 2018278
  }

  /** The token is invalid, expired or revoked (OAuthException 190). */
  get tokenInvalid(): boolean {
    return this.code === 190
  }

  /** Missing permission / capability (a plain code 10, or 200). */
  get permissionDenied(): boolean {
    return !this.outsideWindow && (this.code === 10 || this.code === 200)
  }
}

async function graphFetch(url: string, token: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string; code?: number; error_subcode?: number }
  } | null
  if (!res.ok || body?.error) {
    const e = body?.error
    // Meta's own message can quote ids of the customer: keep only status/code/subcode.
    throw new MessagingApiError(
      `Meta Graph API error (status ${res.status}, code ${e?.code ?? 'n/a'}, subcode ${e?.error_subcode ?? 'n/a'})`,
      res.status,
      e?.code ?? null,
      e?.error_subcode ?? null,
    )
  }
  return body
}

export interface MessagingSendTarget {
  kind: MetaMessagingChannel
  /** The connection's `external_id` (Page id / Instagram professional account id). */
  businessId: string
  /** Decrypted access token. */
  token: string
  /** The customer's IGSID / PSID. */
  recipientId: string
}

export type MessagingPayload = { text: string } | { mediaKind: MessagingMediaKind; url: string }

/** Send one message; returns Meta's message id. Throws MessagingApiError. */
export async function sendMessagingMessage(
  target: MessagingSendTarget,
  payload: MessagingPayload,
): Promise<{ messageId: string }> {
  const message =
    'text' in payload
      ? { text: payload.text }
      : { attachment: { type: payload.mediaKind, payload: { url: payload.url, is_reusable: false } } }
  const res = (await graphFetch(
    `${GRAPH_BASE[target.kind]}/${encodeURIComponent(target.businessId)}/messages`,
    target.token,
    {
      method: 'POST',
      body: JSON.stringify({
        recipient: { id: target.recipientId },
        // Only the 24 h reply window exists here (no message tags in part A).
        messaging_type: 'RESPONSE',
        message,
      }),
    },
  )) as { message_id?: string }
  if (!res.message_id) throw new MessagingApiError('Meta did not return a message id', 502, null, null)
  return { messageId: res.message_id }
}

export interface MessagingProfile {
  name: string | null
  pictureUrl: string | null
}

/** Name and photo of the customer. Never throws: a failure just means no profile. */
export async function fetchMessagingProfile(
  kind: MetaMessagingChannel,
  token: string,
  customerId: string,
): Promise<MessagingProfile | null> {
  try {
    const fields = kind === 'instagram' ? 'name,username,profile_pic' : 'first_name,last_name,name,profile_pic'
    const p = (await graphFetch(
      `${GRAPH_BASE[kind]}/${encodeURIComponent(customerId)}?fields=${fields}`,
      token,
    )) as Record<string, unknown>
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
    const full = [s(p.first_name), s(p.last_name)].filter(Boolean).join(' ')
    return {
      name: s(p.name) ?? (full || null) ?? (s(p.username) ? `@${s(p.username)}` : null),
      pictureUrl: s(p.profile_pic),
    }
  } catch (err) {
    console.warn(
      '[meta-messaging] profile lookup failed:',
      err instanceof MessagingApiError ? `code ${err.code}/${err.subcode}` : 'network',
    )
    return null
  }
}
