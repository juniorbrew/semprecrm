// ============================================================
// The pipeline board's deal query.
//
// The company embed (migration 054) is the newest part of the select;
// if it fails — a database that has not run 054 yet, or PostgREST's
// schema cache not reloaded after it — the board must not go blank.
// The query is retried without the embed and the failure is reported
// so the caller can tell the user something is off.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Deal } from '@/types';

const BASE_SELECT =
  '*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*), loss_reason:deal_loss_reasons(id, name)';
export const DEAL_BOARD_SELECT = `${BASE_SELECT}, company:companies(id, razao_social, nome_fantasia, cnpj, cidade, uf)`;
export const DEAL_BOARD_SELECT_FALLBACK = BASE_SELECT;

export interface LoadDealsResult {
  deals: Deal[];
  /** Something failed: 'degraded' = loaded without companies, 'failed' = nothing loaded. */
  problem: 'degraded' | 'failed' | null;
}

export async function loadPipelineDeals(
  db: Pick<SupabaseClient, 'from'>,
  pipelineId: string,
): Promise<LoadDealsResult> {
  const query = (select: string) =>
    db.from('deals').select(select).eq('pipeline_id', pipelineId).order('created_at', { ascending: false });

  const first = await query(DEAL_BOARD_SELECT);
  if (!first.error) return { deals: (first.data ?? []) as unknown as Deal[], problem: null };
  console.error('[pipelines] deal query with company failed, retrying without it:', first.error);

  const second = await query(DEAL_BOARD_SELECT_FALLBACK);
  if (!second.error) return { deals: (second.data ?? []) as unknown as Deal[], problem: 'degraded' };
  console.error('[pipelines] deal query failed:', second.error);
  return { deals: [], problem: 'failed' };
}
