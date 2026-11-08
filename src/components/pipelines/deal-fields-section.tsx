'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Loader2, Pencil } from 'lucide-react';
import { toast } from 'sonner';

import { useAuth, useEntitlements } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useLanguage } from '@/hooks/use-language';
import { useReadOnly } from '@/hooks/use-read-only';
import {
  computeFieldRows,
  missingNames,
  parseFieldInput,
  valueToInput,
  type FieldRow,
} from '@/lib/deal-fields/compute';
import {
  dealFieldsErrorMessage,
  listDealFields,
  listDealFieldValues,
  listItemSums,
  setDealFieldValue,
} from '@/lib/deal-fields/data';
import { notifyDealFieldsChanged } from '@/lib/deal-fields/events';
import type { DealField, FieldValues } from '@/lib/deal-fields/types';
import { stageProbability } from '@/lib/pipelines/board';
import { createClient } from '@/lib/supabase/client';
import type { Deal, PipelineStage } from '@/types';

const HEADING = 'mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground';

/** Why a formula has no number, as a short hint under its name. */
function FormulaHint({ row, fields }: { row: FieldRow; fields: DealField[] }) {
  const { t } = useLanguage();
  const ev = row.eval;
  if (!ev || ev.value !== null) return null;
  if (ev.reason === 'deleted') return <>{t('Deleted field')}</>;
  if (ev.reason === 'div_zero') return <>{t('Cannot divide by zero')}</>;
  if (ev.reason === 'overflow') return <>{t('The number is too large')}</>;
  return (
    <>
      {t('Fill in')} <span data-no-translate>{missingNames(ev, fields).join(', ')}</span>
    </>
  );
}

function ValueEditor({
  field,
  current,
  onSave,
  onCancel,
}: {
  field: DealField;
  current: number | undefined;
  onSave: (value: number | null) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useLanguage();
  const id = useId();
  const [text, setText] = useState(valueToInput(current));
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);
  // Enter commits and unmounts the box, which fires a blur: only the first commit counts.
  const done = useRef(false);

  async function commit() {
    if (done.current) return;
    const parsed = parseFieldInput(text);
    if (!parsed.ok) {
      setBad(true);
      return;
    }
    done.current = true;
    if (parsed.value === (current ?? null)) {
      onCancel();
      return;
    }
    setBusy(true);
    const ok = await onSave(parsed.value);
    if (!ok) {
      done.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-1">
      <input
        id={id}
        autoFocus
        inputMode="decimal"
        value={text}
        disabled={busy}
        aria-label={field.name}
        aria-invalid={bad}
        aria-describedby={bad ? `${id}-err` : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setBad(false);
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            done.current = true;
            onCancel();
          }
        }}
        data-no-translate
        className="h-8 w-full rounded-md border border-input bg-background px-2 text-right text-sm tabular-nums text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 aria-invalid:border-destructive"
      />
      {bad && (
        <p id={`${id}-err`} role="alert" className="text-right text-xs text-destructive">
          {t('Type a valid number, like 12,5')}
        </p>
      )}
    </div>
  );
}

function FieldsList({ deal, stages }: { deal: Deal; stages: PipelineStage[] }) {
  const { t } = useLanguage();
  const { accountId, defaultCurrency } = useAuth();
  const canEditDeal = useCan('send-messages');
  const { readOnly } = useReadOnly();
  const canEdit = canEditDeal && !readOnly;

  const [loaded, setLoaded] = useState<{
    fields: DealField[];
    values: FieldValues;
    itemsSum: number;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // A read in flight must not overwrite a value saved after it started.
  const generation = useRef(0);

  // Read again when the deal changes: a changed item list moves value (and updated_at).
  useEffect(() => {
    let cancelled = false;
    const gen = ++generation.current;
    const db = createClient();
    Promise.all([listDealFields(db), listDealFieldValues(db, deal.id), listItemSums(db, [deal.id])])
      .then(([fields, values, sums]) => {
        if (cancelled || gen !== generation.current) return;
        setLoaded({ fields, values, itemsSum: sums[deal.id] ?? 0 });
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [deal.id, deal.value, deal.updated_at, deal.expected_close_date]);

  const stage = stages.find((s) => s.id === deal.stage_id);
  const sorted = useMemo(() => [...stages].sort((a, b) => a.position - b.position), [stages]);

  const rows = useMemo(() => {
    if (!loaded) return [];
    return computeFieldRows(
      loaded.fields,
      loaded.values,
      {
        value: Number(deal.value),
        chance: stage ? stageProbability(stage, sorted) : 0,
        itemsSum: loaded.itemsSum,
        expectedCloseDate: deal.expected_close_date,
      },
      deal.currency || defaultCurrency,
    );
  }, [loaded, deal.value, deal.currency, deal.expected_close_date, stage, sorted, defaultCurrency]);

  async function save(field: DealField, value: number | null): Promise<boolean> {
    if (!accountId) return false;
    try {
      await setDealFieldValue(createClient(), accountId, deal.id, field.id, value);
    } catch (err) {
      toast.error(t(dealFieldsErrorMessage(err)));
      return false;
    }
    generation.current++;
    setLoaded((prev) => {
      if (!prev) return prev;
      const values = { ...prev.values };
      if (value === null) delete values[field.id];
      else values[field.id] = value;
      return { ...prev, values };
    });
    setEditingId(null);
    notifyDealFieldsChanged();
    return true;
  }

  if (failed && !loaded) {
    return (
      <section>
        <h3 className={HEADING}>{t('Fields of this deal')}</h3>
        <p role="alert" className="text-sm text-destructive">
          {t('Could not load the fields.')}
        </p>
      </section>
    );
  }
  if (!loaded) {
    return (
      <section>
        <h3 className={HEADING}>{t('Fields of this deal')}</h3>
        <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> {t('Loading fields…')}
        </p>
      </section>
    );
  }
  // No fields defined: nothing to show (admins create them in Settings).
  if (loaded.fields.length === 0) return null;

  return (
    <section>
      <h3 className={HEADING}>{t('Fields of this deal')}</h3>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {rows.map((row) => {
          const f = row.field;
          const isFormula = f.kind === 'formula';
          const editing = editingId === f.id;
          return (
            <li key={f.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0 pt-1">
                <p className="truncate text-sm text-foreground" data-no-translate>
                  {f.name}
                </p>
                {isFormula && row.text === null && (
                  <p className="text-xs text-muted-foreground">
                    <FormulaHint row={row} fields={loaded.fields} />
                  </p>
                )}
              </div>
              <div className="min-w-[8rem] max-w-[60%] text-right">
                {editing ? (
                  <ValueEditor
                    field={f}
                    current={loaded.values[f.id]}
                    onSave={(v) => save(f, v)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : isFormula || !canEdit ? (
                  <span
                    className="inline-block pt-1 text-sm font-semibold tabular-nums text-foreground"
                    data-no-translate
                  >
                    {row.text ?? '—'}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditingId(f.id)}
                    aria-label={`${t('Edit value')}: ${f.name}`}
                    className="group inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-semibold tabular-nums text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    data-no-translate
                  >
                    {row.text ?? <span className="font-normal text-muted-foreground">—</span>}
                    <Pencil aria-hidden className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * "Campos" of the deal drawer (migration 107): the account's deal fields in the admin's order.
 * Number fields are edited in place by whoever can edit the deal (agent and above); formula
 * fields are computed here from the numbers and are read only. Hidden without the pipelines
 * module and when the account has no deal fields.
 */
export function DealFieldsSection({ deal, stages }: { deal: Deal; stages: PipelineStage[] }) {
  const { ready, modules } = useEntitlements();
  if (!ready || !modules.pipelines) return null;
  return <FieldsList deal={deal} stages={stages} />;
}
