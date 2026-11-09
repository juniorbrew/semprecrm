'use client';

import { useEffect, useMemo, useState } from 'react';

import { useAuth, useEntitlements } from '@/hooks/use-auth';
import { cardPlan, computeCardLines, type CardLine } from '@/lib/deal-fields/compute';
import { listDealFields, listItemSums, listValuesForDeals } from '@/lib/deal-fields/data';
import { onDealFieldsChanged } from '@/lib/deal-fields/events';
import type { DealField, FieldValues } from '@/lib/deal-fields/types';
import { stageProbability } from '@/lib/pipelines/board';
import { createClient } from '@/lib/supabase/client';
import type { Deal, PipelineStage } from '@/types';

export type CardFieldLine = CardLine;

/**
 * The up-to-two deal fields an admin put on the card, per deal. Loads the field list once, then
 * the values of the deals on the board (and the item sums only when a card formula uses {Itens}).
 * The reads are keyed on WHICH deals are on the board, not on the deals array: a drag, an edit of
 * the title or a move recomputes from what is cached and does not touch the network. Only a new
 * or removed deal, an edited value (event) or, for {Itens}, a changed deal value reads again.
 * A deal with no number to show gets no line at all. Nothing is fetched without the pipelines
 * module or without a field marked "show on the card". A failed read leaves the cards as they were.
 */
export function useCardFieldLines(deals: Deal[], sortedStages: PipelineStage[]): Map<string, CardFieldLine[]> {
  const { ready, modules } = useEntitlements();
  const { defaultCurrency } = useAuth();
  const enabled = ready && modules.pipelines;

  const [fields, setFields] = useState<DealField[]>([]);
  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState<{
    values: Record<string, FieldValues>;
    sums: Record<string, number>;
    /** When it was read: the day count of {Dias para fechar} is worked out against this. */
    at: number;
  } | null>(null);

  // A field edited elsewhere (settings, drawer) shows up on the next read.
  useEffect(() => onDealFieldsChanged(() => setVersion((v) => v + 1)), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    listDealFields(createClient())
      .then((rows) => {
        if (!cancelled) setFields(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, version]);

  const plan = useMemo(() => cardPlan(fields), [fields]);
  const fieldKey = plan.fieldIds.join(',');
  const needItems = plan.needsItems;
  const hasCardFields = plan.shown.length > 0;

  // Stable signature of the deals on the board (sorted ids); with {Itens} also their values,
  // because items move deals.value and the cached sums would go stale.
  const dealKey = useMemo(() => {
    const parts = deals.map((d) => (needItems ? `${d.id}:${d.value}` : d.id));
    return parts.sort().join('|');
  }, [deals, needItems]);

  useEffect(() => {
    if (!enabled || !hasCardFields || dealKey === '') return;
    let cancelled = false;
    const db = createClient();
    const ids = dealKey.split('|').map((p) => p.split(':')[0]);
    const fieldIds = fieldKey ? fieldKey.split(',') : [];
    Promise.all([listValuesForDeals(db, ids, fieldIds), needItems ? listItemSums(db, ids) : Promise.resolve({})])
      .then(([values, sums]) => {
        if (!cancelled) setLoaded({ values, sums, at: Date.now() });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, hasCardFields, fieldKey, needItems, dealKey, version]);

  return useMemo(() => {
    const out = new Map<string, CardFieldLine[]>();
    if (!enabled || !hasCardFields || !loaded) return out;
    const stageById = new Map(sortedStages.map((s) => [s.id, s]));
    for (const deal of deals) {
      const stage = stageById.get(deal.stage_id);
      const lines = computeCardLines(
        plan,
        loaded.values[deal.id] ?? {},
        {
          value: Number(deal.value),
          chance: stage ? stageProbability(stage, sortedStages) : 0,
          itemsSum: loaded.sums[deal.id] ?? 0,
          expectedCloseDate: deal.expected_close_date,
        },
        deal.currency || defaultCurrency,
        loaded.at,
      );
      if (lines.length > 0) out.set(deal.id, lines);
    }
    return out;
  }, [enabled, hasCardFields, plan, loaded, deals, sortedStages, defaultCurrency]);
}
