'use client';

import { useEffect, useId, useState } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useEntitlements } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { valueToInput } from '@/lib/deal-fields/compute';
import { listDealFields, listDealFieldValues } from '@/lib/deal-fields/data';
import type { DealField, FieldValues } from '@/lib/deal-fields/types';
import { createClient } from '@/lib/supabase/client';

const SUFFIX = { number: '', currency: '', percent: '%' } as const;

/**
 * The number fields of the deal for the edit form: the field list and, for an existing deal,
 * its values. Formulas are not typed, so they are left out. `ready` stays false until both are
 * read, so the form does not compare against an empty "before". Nothing is read without the
 * pipelines module.
 */
export function useDealFormFields(dealId: string | undefined): {
  fields: DealField[];
  values: FieldValues;
  ready: boolean;
} {
  const { ready: entitlementsReady, modules } = useEntitlements();
  const enabled = entitlementsReady && modules.pipelines;
  const [state, setState] = useState<{ fields: DealField[]; values: FieldValues; ready: boolean }>({
    fields: [],
    values: {},
    ready: false,
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const db = createClient();
    Promise.all([listDealFields(db), dealId ? listDealFieldValues(db, dealId) : Promise.resolve({} as FieldValues)])
      .then(([fields, values]) => {
        if (!cancelled) setState({ fields: fields.filter((f) => f.kind !== 'formula'), values, ready: true });
      })
      .catch(() => {
        // The deal can still be saved without them.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, dealId]);

  return state;
}

/** One text box per number field, in the admin's order. Empty means "no value". */
export function DealFieldInputs({
  fields,
  texts,
  invalid,
  onChange,
}: {
  fields: DealField[];
  texts: Record<string, string>;
  invalid: string[];
  onChange: (fieldId: string, text: string) => void;
}) {
  const { t } = useLanguage();
  const base = useId();
  if (fields.length === 0) return null;
  return (
    <div className="grid gap-3" role="group" aria-label={t('Deal fields')}>
      {fields.map((f) => {
        const id = `${base}-${f.id}`;
        const bad = invalid.includes(f.id);
        const suffix = SUFFIX[f.kind as keyof typeof SUFFIX];
        return (
          <div key={f.id} className="grid gap-2">
            <Label htmlFor={id} className="text-muted-foreground" data-no-translate>
              {f.name}
            </Label>
            <div className="relative">
              <Input
                id={id}
                inputMode="decimal"
                value={texts[f.id] ?? ''}
                aria-invalid={bad}
                aria-describedby={bad ? `${id}-err` : undefined}
                onChange={(e) => onChange(f.id, e.target.value)}
                placeholder="0"
                className={suffix ? 'border-border bg-muted pr-8 text-foreground' : 'border-border bg-muted text-foreground'}
                data-no-translate
              />
              {suffix && (
                <span aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  {suffix}
                </span>
              )}
            </div>
            {bad && (
              <p id={`${id}-err`} role="alert" className="text-xs text-destructive">
                {t('Type a valid number, like 12,5')}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Starting text of every box, from the values the deal has. */
export function initialTexts(fields: DealField[], values: FieldValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) out[f.id] = valueToInput(values[f.id]);
  return out;
}
