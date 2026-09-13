// ============================================================
// Deal loss reasons ("Motivo de perda", migration 031).
//
// Pure helpers first (aggregation for the analytics chart, ordering,
// delete guard), then the thin Supabase read/write side. Same client
// contract as src/lib/tasks: pass the client in, errors are thrown.
//
// RLS: viewer+ reads `deal_loss_reasons`, admin+ writes it; the
// deal-side columns ride the existing `deals` policies (agent+).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Language } from '@/lib/i18n';
import type { Deal, DealLossReason, DealStatus } from '@/types';

type Client = Pick<SupabaseClient, 'from'>;

export const NO_REASON_KEY = '__none__';

export interface LossReasonBucket {
  /** Reason id, or `NO_REASON_KEY` for lost deals without a reason. */
  key: string;
  reason: string;
  count: number;
  value: number;
}

/** "Sem motivo" / "No reason" — label of the null bucket. */
export function noReasonLabel(lang: Language): string {
  return lang === 'pt-BR' ? 'Sem motivo' : 'No reason';
}

/**
 * Lost deals grouped by reason → [{ reason, count, value }] sorted by
 * count desc (value desc as tiebreak). Deals whose reason was deleted
 * (id no longer in `reasons`) fall into the "no reason" bucket along
 * with the ones that never had one; non-lost deals are ignored.
 */
export function aggregateLossReasons(
  deals: readonly Deal[],
  reasons: readonly Pick<DealLossReason, 'id' | 'name'>[],
  lang: Language,
): LossReasonBucket[] {
  const byId = new Map(reasons.map((r) => [r.id, r.name]));
  const buckets = new Map<string, LossReasonBucket>();
  for (const deal of deals) {
    if (deal.status !== 'lost') continue;
    const id = deal.loss_reason_id ?? null;
    const name =
      (id ? byId.get(id) : undefined) ?? deal.loss_reason?.name ?? null;
    const key = id && name ? id : NO_REASON_KEY;
    const bucket = buckets.get(key) ?? {
      key,
      reason: name ?? noReasonLabel(lang),
      count: 0,
      value: 0,
    };
    bucket.count += 1;
    bucket.value += Number(deal.value || 0);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort(
    (a, b) => b.count - a.count || b.value - a.value || a.reason.localeCompare(b.reason),
  );
}

export function sortLossReasons<T extends Pick<DealLossReason, 'position' | 'name'>>(
  reasons: readonly T[],
): T[] {
  return [...reasons].sort(
    (a, b) => a.position - b.position || a.name.localeCompare(b.name),
  );
}

export function activeLossReasons(reasons: readonly DealLossReason[]): DealLossReason[] {
  return sortLossReasons(reasons.filter((r) => r.is_active));
}

/** Index in the ordered list where a new reason goes (end). */
export function nextLossReasonPosition(reasons: readonly Pick<DealLossReason, 'position'>[]): number {
  return reasons.reduce((max, r) => Math.max(max, r.position + 1), 0);
}

/** A reason can be deleted only when no deal references it. */
export function canDeleteLossReason(usageCount: number): boolean {
  return usageCount === 0;
}

/**
 * Column patch for a status change. Marking lost stores the reason and
 * note; reopening or winning clears both so a stale reason never
 * survives a second life of the deal.
 */
export function dealStatusPatch(
  status: DealStatus,
  lost?: { reasonId: string; note?: string | null },
): Pick<Deal, 'status' | 'loss_reason_id' | 'lost_note'> {
  if (status === 'lost') {
    const note = lost?.note?.trim();
    return {
      status,
      loss_reason_id: lost?.reasonId ?? null,
      lost_note: note ? note : null,
    };
  }
  return { status, loss_reason_id: null, lost_note: null };
}

// ------------------------------------------------------------
// Supabase side
// ------------------------------------------------------------

function fail(prefix: string, error: { message: string } | null): never {
  throw new Error(`${prefix}: ${error?.message ?? 'unknown error'}`);
}

export async function listLossReasons(
  db: Client,
  accountId: string,
): Promise<DealLossReason[]> {
  const { data, error } = await db
    .from('deal_loss_reasons')
    .select('*')
    .eq('account_id', accountId)
    .order('position', { ascending: true });
  if (error) fail('Failed to load loss reasons', error);
  return sortLossReasons((data ?? []) as DealLossReason[]);
}

export async function createLossReason(
  db: Client,
  accountId: string,
  existing: readonly Pick<DealLossReason, 'position'>[],
  name: string,
): Promise<DealLossReason> {
  const { data, error } = await db
    .from('deal_loss_reasons')
    .insert({
      account_id: accountId,
      name: name.trim(),
      position: nextLossReasonPosition(existing),
      is_active: true,
    })
    .select('*')
    .single();
  if (error || !data) fail('Failed to create loss reason', error);
  return data as DealLossReason;
}

export async function updateLossReason(
  db: Client,
  id: string,
  changes: Partial<Pick<DealLossReason, 'name' | 'is_active'>>,
): Promise<void> {
  const patch: Partial<Pick<DealLossReason, 'name' | 'is_active'>> = { ...changes };
  if (typeof patch.name === 'string') patch.name = patch.name.trim();
  const { error } = await db.from('deal_loss_reasons').update(patch).eq('id', id);
  if (error) fail('Failed to update loss reason', error);
}

/** Persist a full new order (positions 0..n-1) in one upsert. */
export async function reorderLossReasons(
  db: Client,
  ordered: readonly DealLossReason[],
): Promise<void> {
  if (ordered.length === 0) return;
  const rows = ordered.map((r, i) => ({
    id: r.id,
    account_id: r.account_id,
    name: r.name,
    is_active: r.is_active,
    position: i,
  }));
  const { error } = await db.from('deal_loss_reasons').upsert(rows, { onConflict: 'id' });
  if (error) fail('Failed to reorder loss reasons', error);
}

/** How many deals reference the reason (any status). */
export async function countDealsWithReason(db: Client, id: string): Promise<number> {
  const { count, error } = await db
    .from('deals')
    .select('id', { count: 'exact', head: true })
    .eq('loss_reason_id', id);
  if (error) fail('Failed to count deals', error);
  return count ?? 0;
}

export class LossReasonInUseError extends Error {
  constructor(public readonly usageCount: number) {
    super('Loss reason is referenced by deals');
    this.name = 'LossReasonInUseError';
  }
}

/** Delete a reason nobody uses; throws `LossReasonInUseError` otherwise. */
export async function deleteLossReason(db: Client, id: string): Promise<void> {
  const usage = await countDealsWithReason(db, id);
  if (!canDeleteLossReason(usage)) throw new LossReasonInUseError(usage);
  const { error } = await db.from('deal_loss_reasons').delete().eq('id', id);
  if (error) fail('Failed to delete loss reason', error);
}
