/**
 * Clean up a broadcast row the wizard created but could not start
 * (POST /start failed: 409, 5xx or network). Without this an empty
 * campaign would sit in "Enviando" forever.
 *
 * - No recipient rows yet → delete it (nothing to keep).
 * - Otherwise (or if the delete is refused) → mark it 'failed', but
 *   only while nobody holds its delivery lock: a pass that does hold it
 *   owns the campaign's status.
 *
 * Client-safe; the wizard calls it with the browser (RLS) client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function abandonUnstartedBroadcast(
  db: SupabaseClient,
  broadcastId: string,
): Promise<'deleted' | 'failed'> {
  const { count } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);

  if (!count) {
    const { error } = await db.from('broadcasts').delete().eq('id', broadcastId);
    if (!error) return 'deleted';
  }

  await db
    .from('broadcasts')
    .update({ status: 'failed', updated_at: new Date().toISOString() })
    .eq('id', broadcastId)
    .is('delivery_locked_at', null);
  return 'failed';
}
