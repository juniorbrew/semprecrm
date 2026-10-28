import type { SupabaseClient } from '@supabase/supabase-js'

import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import type { MetaMessagingChannel } from '@/types'

/** The Page / Instagram account already belongs to another account of this app. */
export class OwnedByAnotherAccountError extends Error {
  constructor() {
    super('This Instagram / Facebook account is already connected to another SempreCRM account')
    this.name = 'OwnedByAnotherAccountError'
  }
}

export interface ConnectionInput {
  accountId: string
  kind: MetaMessagingChannel
  externalId: string
  name: string | null
  pictureUrl: string | null
  /** Plain token: encrypted here. */
  token: string
  expiresAt: Date | null
}

export interface Incumbent {
  id: string
  accountId: string
  status: string
  /** Decrypted token ('' when unreadable). */
  token: string
}

/**
 * The OTHER account that currently holds (kind, external_id), if any. Checked before anything is
 * subscribed at Meta, so a refused connection leaves no trace there.
 */
export async function findIncumbent(
  db: SupabaseClient,
  accountId: string,
  kind: MetaMessagingChannel,
  externalId: string,
): Promise<Incumbent | null> {
  const { data, error } = await db
    .from('meta_messaging_channels')
    .select('id, account_id, status, access_token')
    .eq('kind', kind)
    .eq('external_id', externalId)
    .maybeSingle()
  if (error) throw new Error(`connection lookup failed: ${error.code ?? 'unknown'}`)
  if (!data || data.account_id === accountId) return null
  let token = ''
  try {
    token = decrypt(data.access_token as string)
  } catch {
    // unreadable: counts as a dead token
  }
  return { id: data.id as string, accountId: data.account_id as string, status: data.status as string, token }
}

/** One connection per kind per account: connecting again (or another Page) replaces it. */
export async function saveConnection(db: SupabaseClient, input: ConnectionInput): Promise<void> {
  const row = {
    account_id: input.accountId,
    kind: input.kind,
    external_id: input.externalId,
    name: input.name,
    picture_url: input.pictureUrl,
    access_token: encrypt(input.token),
    token_expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
    status: 'active',
    connected_at: new Date().toISOString(),
  }
  const { error } = await db.from('meta_messaging_channels').upsert(row, { onConflict: 'account_id,kind' })
  if (error) {
    // Lost a race for the same external id with another account (UNIQUE kind, external_id).
    if (isUniqueViolation(error)) throw new OwnedByAnotherAccountError()
    throw new Error(`could not save the connection: ${error.code ?? 'unknown'}`)
  }
}

export interface StoredConnection {
  id: string
  externalId: string
  token: string
}

export async function loadOwnConnection(
  db: SupabaseClient,
  accountId: string,
  kind: MetaMessagingChannel,
): Promise<StoredConnection | null> {
  const { data } = await db
    .from('meta_messaging_channels')
    .select('id, external_id, access_token')
    .eq('account_id', accountId)
    .eq('kind', kind)
    .maybeSingle()
  if (!data) return null
  let token = ''
  try {
    token = decrypt(data.access_token as string)
  } catch {
    // An unreadable token cannot be unsubscribed; the row can still be removed.
  }
  return { id: data.id as string, externalId: data.external_id as string, token }
}

export async function deleteConnection(db: SupabaseClient, id: string, accountId: string): Promise<void> {
  const { error } = await db.from('meta_messaging_channels').delete().eq('id', id).eq('account_id', accountId)
  if (error) throw new Error(`could not remove the connection: ${error.code ?? 'unknown'}`)
}
