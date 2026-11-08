'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useLanguage } from '@/hooks/use-language';
import { useReadOnly } from '@/hooks/use-read-only';
import { formulasUsing } from '@/lib/deal-fields/compute';
import {
  createDealField,
  dealFieldsErrorMessage,
  deleteDealField,
  listDealFields,
  reorderDealFields,
  updateDealField,
} from '@/lib/deal-fields/data';
import {
  NAME_ERROR_TEXT,
  validateFieldDraft,
  type DraftErrors,
  type FieldDraft,
} from '@/lib/deal-fields/draft';
import { toDisplay } from '@/lib/deal-fields/formula';
import {
  FIELD_NAME_MAX,
  MAX_CARD_FIELDS,
  MAX_DEAL_FIELDS,
  type DealField,
  type FieldKind,
  type ResultFormat,
} from '@/lib/deal-fields/types';
import { createClient } from '@/lib/supabase/client';

import { FormulaEditor } from './formula-editor';
import { SettingsChip } from './settings-chip';

const KIND_LABEL: Record<FieldKind, string> = {
  number: 'Number field',
  currency: 'Money field',
  percent: 'Percentage field',
  formula: 'Formula field',
};
const FORMAT_LABEL: Record<ResultFormat, string> = {
  number: 'Show as a number',
  currency: 'Show as money',
  percent: 'Show as a percentage',
};

const SELECT_CLASS =
  'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30';

function FieldDialog({
  initial,
  fields,
  onClose,
  onSaved,
}: {
  initial: DealField | null;
  fields: DealField[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLanguage();
  const { accountId, defaultCurrency } = useAuth();
  const nameId = useId();
  const kindId = useId();
  const formatId = useId();
  const [draft, setDraft] = useState<FieldDraft>(() => ({
    name: initial?.name ?? '',
    kind: initial?.kind ?? 'number',
    formulaText:
      initial?.kind === 'formula' ? toDisplay(initial.expression ?? '', fields) : '',
    resultFormat: initial?.result_format ?? 'number',
    showOnCard: initial?.show_on_card ?? false,
  }));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);

  const others = fields.filter((f) => f.id !== initial?.id);
  const cardFull = others.filter((f) => f.show_on_card).length >= MAX_CARD_FIELDS;
  const isFormula = draft.kind === 'formula';
  // A field never becomes a formula (or stops being one) after it is created.
  const kindOptions: FieldKind[] = initial
    ? initial.kind === 'formula'
      ? ['formula']
      : ['number', 'currency', 'percent']
    : ['number', 'currency', 'percent', 'formula'];

  const set = (patch: Partial<FieldDraft>) => setDraft((d) => ({ ...d, ...patch }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    const result = validateFieldDraft(draft, fields, initial);
    if (!result.ok) {
      setErrors(result.errors);
      if (result.errors.limit) toast.error(t('An account can have at most 50 deal fields'));
      return;
    }
    if (!accountId) return;
    setErrors({});
    setBusy(true);
    try {
      const db = createClient();
      if (initial) {
        await updateDealField(db, initial.id, {
          name: result.input.name,
          // the kind only moves between number kinds; formulas keep theirs
          ...(initial.kind === 'formula' ? {} : { kind: result.input.kind }),
          ...(initial.kind === 'formula'
            ? { expression: result.input.expression, result_format: result.input.result_format }
            : {}),
          show_on_card: result.input.show_on_card,
        });
      } else {
        const next = fields.reduce((m, f) => Math.max(m, f.position), -1) + 1;
        await createDealField(db, accountId, result.input, next);
      }
      toast.success(t(initial ? 'Field updated' : 'Field created'));
      await onSaved();
    } catch (err) {
      toast.error(t(dealFieldsErrorMessage(err)));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? t('Edit deal field') : t('New deal field')}</DialogTitle>
          <DialogDescription>
            {t('Numbers each deal carries, like cost or freight. A formula field calculates from them.')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3" noValidate>
          <div className="grid gap-1.5">
            <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground">
              {t('Field name')}
            </label>
            <Input
              id={nameId}
              value={draft.name}
              maxLength={FIELD_NAME_MAX + 20}
              autoFocus
              aria-invalid={!!errors.name}
              onChange={(e) => set({ name: e.target.value })}
              data-no-translate
            />
            {errors.name && (
              <p role="alert" className="text-xs text-destructive">
                {t(NAME_ERROR_TEXT[errors.name])}
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <label htmlFor={kindId} className="text-xs font-medium text-muted-foreground">
              {t('Field type')}
            </label>
            <select
              id={kindId}
              className={SELECT_CLASS}
              value={draft.kind}
              disabled={kindOptions.length === 1}
              onChange={(e) => set({ kind: e.target.value as FieldKind })}
            >
              {kindOptions.map((k) => (
                <option key={k} value={k}>
                  {t(KIND_LABEL[k])}
                </option>
              ))}
            </select>
          </div>

          {isFormula && (
            <>
              <FormulaEditor
                value={draft.formulaText}
                onChange={(formulaText) => set({ formulaText })}
                fields={others}
                resultFormat={draft.resultFormat}
                currency={defaultCurrency}
                showErrors={attempted}
              />
              <div className="grid gap-1.5">
                <label htmlFor={formatId} className="text-xs font-medium text-muted-foreground">
                  {t('Result format')}
                </label>
                <select
                  id={formatId}
                  className={SELECT_CLASS}
                  value={draft.resultFormat}
                  onChange={(e) => set({ resultFormat: e.target.value as ResultFormat })}
                >
                  {(Object.keys(FORMAT_LABEL) as ResultFormat[]).map((f) => (
                    <option key={f} value={f}>
                      {t(FORMAT_LABEL[f])}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          <div className="grid gap-1">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={draft.showOnCard}
                disabled={cardFull && !draft.showOnCard}
                onChange={(e) => set({ showOnCard: e.target.checked })}
              />
              {t('Show on the pipeline card')}
            </label>
            {(cardFull && !draft.showOnCard) || errors.card ? (
              <p className="text-xs text-muted-foreground">
                {t('At most 2 fields can show on the card')}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              {t('Save field')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  field,
  fields,
  onClose,
  onDeleted,
}: {
  field: DealField;
  fields: DealField[];
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const broken = formulasUsing(fields, field.id);

  async function confirm() {
    setBusy(true);
    try {
      await deleteDealField(createClient(), field.id);
      toast.success(t('Field deleted'));
      await onDeleted();
    } catch (err) {
      toast.error(t(dealFieldsErrorMessage(err)));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('Delete field')} <span data-no-translate>{`"${field.name}"`}</span>?
          </DialogTitle>
          <DialogDescription>
            {t('This also removes the value of this field on every deal. This cannot be undone.')}
          </DialogDescription>
        </DialogHeader>
        {broken.length > 0 && (
          <div role="alert" className="grid gap-1.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="font-medium text-foreground">
              {t('These formulas use this field and will stop working until you edit them:')}
            </p>
            <ul className="list-disc pl-5 text-foreground" data-no-translate>
              {broken.map((f) => (
                <li key={f.id}>{f.name}</li>
              ))}
            </ul>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button type="button" variant="destructive" onClick={() => void confirm()} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {t('Delete field')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Settings -> Campos personalizados -> Negócio: the deal fields of the account (migration 107).
 * Every member reads them; only owners and admins create, rename, reorder and delete.
 */
export function DealFieldsSettings() {
  const { t } = useLanguage();
  const canEditSettings = useCan('edit-settings');
  const { readOnly } = useReadOnly();
  const canEdit = canEditSettings && !readOnly;

  const [fields, setFields] = useState<DealField[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<{ field: DealField | null } | null>(null);
  const [deleting, setDeleting] = useState<DealField | null>(null);
  const [moving, setMoving] = useState(false);

  const load = useCallback(async () => {
    try {
      setFields(await listDealFields(createClient()));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  // First read (state is set from the promise, not synchronously in the effect).
  useEffect(() => {
    let cancelled = false;
    listDealFields(createClient())
      .then((rows) => {
        if (!cancelled) setFields(rows);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function move(index: number, delta: -1 | 1) {
    if (!fields || moving) return;
    const target = index + delta;
    if (target < 0 || target >= fields.length) return;
    const ids = fields.map((f) => f.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setMoving(true);
    try {
      await reorderDealFields(createClient(), fields, ids);
    } catch (err) {
      toast.error(t(dealFieldsErrorMessage(err)));
    } finally {
      // The writes are separate requests: whatever happened, show what the database really holds.
      await load();
      setMoving(false);
    }
  }

  const atLimit = (fields?.length ?? 0) >= MAX_DEAL_FIELDS;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t('Numbers each deal carries, like cost or freight. A formula field calculates from them.')}
        </p>
        {canEdit && (
          <Button size="sm" className="shrink-0" disabled={atLimit} onClick={() => setEditing({ field: null })}>
            <Plus className="size-3.5" /> {t('New deal field')}
          </Button>
        )}
      </div>
      {atLimit && (
        <p className="text-xs text-muted-foreground">{t('An account can have at most 50 deal fields')}</p>
      )}

      {failed && (
        <div role="alert" className="grid gap-2 text-sm">
          <p className="text-destructive">{t('Could not load the fields.')}</p>
          <div>
            <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
              {t('Try again')}
            </Button>
          </div>
        </div>
      )}
      {!failed && !fields && (
        <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t('Loading fields…')}
        </p>
      )}

      {fields && fields.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-6 text-center">
          <p className="text-sm font-medium text-foreground">{t('No deal fields yet')}</p>
          <p className="mx-auto mt-1 max-w-[46ch] text-sm text-muted-foreground">
            {canEdit
              ? t('Create a number field, like cost, then a formula field, like margin.')
              : t('An owner or admin can create deal fields.')}
          </p>
        </div>
      )}

      {fields && fields.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {fields.map((f, i) => (
            <li key={f.id} className="flex items-center gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-foreground">
                  <span className="truncate" data-no-translate>
                    {f.name}
                  </span>
                  <SettingsChip>{t(KIND_LABEL[f.kind])}</SettingsChip>
                  {f.show_on_card && <SettingsChip>{t('On the card')}</SettingsChip>}
                </p>
                {f.kind === 'formula' && (
                  <p className="truncate font-mono text-xs text-muted-foreground" data-no-translate>
                    {toDisplay(f.expression ?? '', fields)}
                  </p>
                )}
              </div>
              {canEdit && (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={i === 0 || moving}
                    aria-label={`${t('Move up')}: ${f.name}`}
                    onClick={() => void move(i, -1)}
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={i === fields.length - 1 || moving}
                    aria-label={`${t('Move down')}: ${f.name}`}
                    onClick={() => void move(i, 1)}
                  >
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${t('Edit deal field')}: ${f.name}`}
                    onClick={() => setEditing({ field: f })}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${t('Delete field')}: ${f.name}`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleting(f)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && fields && (
        <FieldDialog
          key={editing.field?.id ?? 'new'}
          initial={editing.field}
          fields={fields}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
      {deleting && fields && (
        <DeleteDialog
          field={deleting}
          fields={fields}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            setDeleting(null);
            await load();
          }}
        />
      )}
    </div>
  );
}
