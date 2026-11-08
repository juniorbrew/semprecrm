'use client';

import { useId, useRef } from 'react';

import { Textarea } from '@/components/ui/textarea';
import { useLanguage } from '@/hooks/use-language';
import { formatFieldNumber } from '@/lib/deal-fields/compute';
import { FORMULA_ERROR_TEXT, toFieldRefs } from '@/lib/deal-fields/draft';
import {
  BUILTIN_VARS,
  compileFormula,
  evaluate,
  FORMULA_MAX_CHARS,
  sampleVars,
} from '@/lib/deal-fields/formula';
import type { DealField, ResultFormat } from '@/lib/deal-fields/types';

/**
 * The formula box: a text area, buttons that insert the numbers of the deal and the other
 * fields (nobody has to type a name right), the error of the text as it is typed and a preview
 * with sample numbers. `fields` are the OTHER fields (a formula cannot use a formula).
 */
export function FormulaEditor({
  value,
  onChange,
  fields,
  resultFormat,
  currency,
  showErrors,
}: {
  value: string;
  onChange: (text: string) => void;
  fields: DealField[];
  resultFormat: ResultFormat;
  currency: string;
  /** Show an error for an empty box too (after the first save attempt). */
  showErrors: boolean;
}) {
  const { t } = useLanguage();
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const usable = fields.filter((f) => f.kind !== 'formula');

  function insert(name: string) {
    const el = ref.current;
    const token = `{${name}}`;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + token.length;
      el?.setSelectionRange(pos, pos);
    });
  }

  const compiled = value.trim() || showErrors ? compileFormula(value, toFieldRefs(fields)) : null;
  const error = compiled && !compiled.ok ? compiled.error : null;
  const preview =
    compiled && compiled.ok ? evaluate(compiled.ast, sampleVars(toFieldRefs(usable))) : null;

  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {t('Calculation formula')}
      </label>
      <Textarea
        id={id}
        ref={ref}
        rows={3}
        value={value}
        maxLength={FORMULA_MAX_CHARS + 50}
        spellCheck={false}
        placeholder="{Valor} − {Custo}"
        aria-invalid={!!error}
        aria-describedby={`${id}-help`}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono"
        data-no-translate
      />
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('Insert a field into the formula')}>
        {BUILTIN_VARS.map((b) => (
          <button
            key={b.ref}
            type="button"
            onClick={() => insert(b.name)}
            className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            data-no-translate
          >
            {b.name}
          </button>
        ))}
        {usable.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => insert(f.name)}
            className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            data-no-translate
          >
            {f.name}
          </button>
        ))}
      </div>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {t('You can use + − × ÷ and parentheses. A percentage counts as a fraction: 5% is 0,05.')}{' '}
        {`${value.length}/${FORMULA_MAX_CHARS}`}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {t(FORMULA_ERROR_TEXT[error.code])}
          {error.detail ? (
            <>
              {' '}
              <span data-no-translate>{`"${error.detail}"`}</span>
            </>
          ) : null}
        </p>
      )}
      {preview && (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {t('Preview with sample numbers')}:{' '}
          <span className="font-medium text-foreground" data-no-translate>
            {preview.value === null
              ? '—'
              : formatFieldNumber(preview.value, resultFormat, currency, 'drawer', true)}
          </span>
        </p>
      )}
    </div>
  );
}
