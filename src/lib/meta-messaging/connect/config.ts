// ============================================================
// Connecting Instagram / Messenger (part B): the app keys, the scopes and the
// URLs of the two OAuth flows.
//
//   instagram → Instagram API with Instagram Login (INSTAGRAM_APP_ID / _SECRET)
//   messenger → Facebook Login for Pages          (META_APP_ID / META_APP_SECRET)
//
// Endpoints and scopes confirmed against Meta's developer docs on 2026-10-28
// (see docs/runbooks/meta-app-instagram-messenger.md for the links).
// ============================================================

import { oauthRedirectBase } from '@/lib/calendar/sync/config'
import type { MetaMessagingChannel } from '@/types'

import { GRAPH_VERSION } from '../graph'

type Env = Record<string, string | undefined>

export interface AppCredentials {
  appId: string
  appSecret: string
}

const clean = (v: string | undefined) => (v ?? '').trim()

/** The app keys for this channel, or null while the platform has not configured them. */
export function appCredentials(kind: MetaMessagingChannel, env: Env = process.env): AppCredentials | null {
  const appId = clean(kind === 'instagram' ? env.INSTAGRAM_APP_ID : env.META_APP_ID)
  const appSecret = clean(kind === 'instagram' ? env.INSTAGRAM_APP_SECRET : env.META_APP_SECRET)
  return appId && appSecret ? { appId, appSecret } : null
}

export const CALLBACK_PATH: Record<MetaMessagingChannel, string> = {
  instagram: '/api/meta/messaging/callback/instagram',
  messenger: '/api/meta/messaging/callback/messenger',
}

export const SCOPES: Record<MetaMessagingChannel, readonly string[]> = {
  instagram: ['instagram_business_basic', 'instagram_business_manage_messages'],
  messenger: ['pages_show_list', 'pages_messaging', 'pages_manage_metadata'],
}

/** Webhook fields subscribed on connect. */
export const SUBSCRIBED_FIELDS: Record<MetaMessagingChannel, string> = {
  // For Instagram, `messages` also carries the messages the account itself sends (echoes).
  instagram: 'messages',
  messenger: 'messages,message_echoes',
}

export function callbackUrl(kind: MetaMessagingChannel, requestUrl: string, env: Env = process.env): string {
  return `${oauthRedirectBase(requestUrl, env).replace(/\/+$/, '')}${CALLBACK_PATH[kind]}`
}

export function authorizeUrl(
  kind: MetaMessagingChannel,
  input: { creds: AppCredentials; redirectUri: string; state: string },
): string {
  const params = new URLSearchParams({
    client_id: input.creds.appId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: SCOPES[kind].join(','),
    state: input.state,
  })
  return kind === 'instagram'
    ? `https://www.instagram.com/oauth/authorize?${params}`
    : `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params}`
}

/** Where the OAuth routes send the browser back to (Settings → WhatsApp / channels). */
export const SETTINGS_RETURN_PATH = '/settings?tab=whatsapp'
