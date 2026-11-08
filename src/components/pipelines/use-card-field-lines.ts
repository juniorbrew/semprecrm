'use client';

import { useEffect, useMemo, useState } from 'react';

import { useAuth, useEntitlements } from '@/hooks/use-auth';
import { cardFields, cardNeedsItems, computeFieldRows, fieldIdsForCard } from '@/lib/deal-fields/compute';
import { listDealFields, listItemSums, listValuesForDeals } from '@/lib/deal-fields/data';
import { onDealFieldsChanged } from '@/lib/deal-fields/events';
import type { DealField, FieldValues } from '@/lib/deal-fields/types';
import { stageProbability } from '@/lib/pipelines/board';
import { createClient } from '@/lib/supabase/client';
import type { Deal, PipelineStage } from '@/types';

export interface CardFieldLine {
  id: string;
  name: string;
  /** Formatted value, or '—' while it is empty. */
  text: string;
}

/**
 * The up-to-two deal fields an admin put on the card, per deal. Loads the field list once, then
 * the values of the deals on the board in one request per 100 deals (and the item sums only when a
 * card formula uses {Itens}). Nothing is fetched without the pipelines module or without a field
 * marked "show on the card". A failed read just leaves the cards as they were.
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
    key: string;
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

  const onCard = useMemo(() => cardFields(fields), [fields]);
  const needIds = useMemo(() => fieldIdsForCard(fields), [fields]);
  const needItems = useMemo(() => cardNeedsItems(fields), [fields]);
  // The deals the lines depend on: a deal that moved, changed value or date is read again.
  const dealKey = useMemo(
    () => deals.map((d) => `${d.id}:${d.value}:${d.expected_close_date ?? ''}:${d.stage_id}`).join('|'),
    [deals],
  );
  const loadKey = `${version}#${needIds.join(',')}#${needItems}#${dealKey}`;

  useEffect(() => {
    if (!enabled || onCard.length === 0 || deals.length === 0) return;
    let cancelled = false;
    const db = createClient();
    const ids = deals.map((d) => d.id);
    Promise.all([listValuesForDeals(db, ids, needIds), needItems ? listItemSums(db, ids) : Promise.resolve({})])
      .then(([values, sums]) => {
        if (!cancelled) setLoaded({ values, sums, key: loadKey });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // `deals` is covered by dealKey (the array identity changes on every refetch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, onCard.length, loadKey]);

  return useMemo(() => {
    const out = new Map<string, CardFieldLine[]>();
    if (!enabled || onCard.length === 0 || !loaded) return out;
    const stageById = new Map(sortedStages.map((s) => [s.id, s]));
    for (const deal of deals) {
      const stage = stageById.get(deal.stage_id);
      const rows = computeFieldRows(
        fields,
        loaded.values[deal.id] ?? {},
        {
          value: Number(deal.value),
          chance: stage ? stageProbability(stage, sortedStages) : 0,
          itemsSum: loaded.sums[deal.id] ?? 0,
          expectedCloseDate: deal.expected_close_date,
        },
        deal.currency || defaultCurrency,
        'card',
      );
      const shown = new Set(onCard.map((f) => f.id));
      out.set(
        deal.id,
        rows.filter((r) => shown.has(r.field.id)).map((r) => ({ id: r.field.id, name: r.field.name, text: r.text ?? '—' })),
      );
    }
    return out;
  }, [enabled, onCard, loaded, deals, fields, sortedStages, defaultCurrency]);
}
