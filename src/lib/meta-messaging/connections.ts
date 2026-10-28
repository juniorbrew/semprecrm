import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'
import type { MetaMessagingChannel } from '@/types'

export interface MessagingConnection {
  id: string
  accountId: string
  kind: MetaMessagingChannel
  externalId: string
  status: string
  /** Decrypted access token — server only, never log or return it. */
  token: string
}

interface Row {
  id: string
  account_id: string
  kind: MetaMessagingChannel
  external_id: string
  status: string
  access_token: string
}

const COLUMNS = 'id, account_id, kind, external_id, status, access_token'

function toConnection(row: Row | null): MessagingConnection | null {
  if (!row || row.status === 'revoked') return null
  try {
    return {
      id: row.id,
      accountId: row.account_id,
      kind: row.kind,
      externalId: row.external_id,
      status: row.status,
      token: decrypt(row.access_token),
    }
  } catch {
    console.error('[meta-messaging] could not decrypt the token of connection', row.id)
    return null
  }
}

/** The account that owns a Page / Instagram account (webhook `recipient.id`). Service-role client. */
export async function findConnectionByExternalId(
  db: SupabaseClient,
  kind: MetaMessagingChannel,
  externalId: string,
): Promise<MessagingConnection | null> {
  const { data } = await db
    .from('meta_messaging_channels')
    .select(COLUMNS)
    .eq('kind', kind)
    .eq('external_id', externalId)
    .maybeSingle()
  return toConnection(data as Row | null)
}

/** The token was refused by Meta (code 190): the connection needs to be reconnected. Best effort. */
export async function markConnectionExpired(db: SupabaseClient, connectionId: string): Promise<void> {
  const { error } = await db
    .from('meta_messaging_channels')
    .update({ status: 'expired' })
    .eq('id', connectionId)
    .eq('status', 'active')
  if (error) console.error('[meta-messaging] could not flag the connection as expired:', error.code ?? 'unknown')
}

/** The account's own connection of this kind (manual send). Service-role client. */
export async function findConnectionForAccount(
  db: SupabaseClient,
  accountId: string,
  kind: MetaMessagingChannel,
): Promise<MessagingConnection | null> {
  const { data } = await db
    .from('meta_messaging_channels')
    .select(COLUMNS)
    .eq('account_id', accountId)
    .eq('kind', kind)
    .maybeSingle()
  return toConnection(data as Row | null)
}
