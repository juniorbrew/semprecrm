'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { parseBroadcastCsv } from '@/lib/broadcast-csv';
import { CustomField, Tag } from '@/types';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  Users,
  Tags,
  Filter,
  Upload,
  FileText,
  Loader2,
  ArrowRight,
  ArrowLeft,
} from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { cn } from '@/lib/utils';
import { SECTION_TITLE, StepFooter, StepHeader, optionRowClass, pillClass } from './wizard-ui';

type AudienceType = 'all' | 'tags' | 'custom_field' | 'csv';
type CustomFieldOperator = 'is' | 'is_not' | 'contains';

interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

interface AudienceConfig {
  type: AudienceType;
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
}

interface Step2Props {
  audience: AudienceConfig;
  onUpdate: (audience: AudienceConfig) => void;
  onNext: () => void;
  onBack: () => void;
}

/** Labels and descriptions are English i18n keys — rendered through t(). */
const audienceOptions: {
  type: AudienceType;
  label: string;
  description: string;
  icon: typeof Users;
}[] = [
  {
    type: 'all',
    label: 'All Contacts',
    description: 'Send to every contact in your database',
    icon: Users,
  },
  {
    type: 'tags',
    label: 'Filter by Tags',
    description: 'Target contacts with specific tags',
    icon: Tags,
  },
  {
    type: 'custom_field',
    label: 'Custom Field',
    description: 'Filter by a custom field value',
    icon: Filter,
  },
  {
    type: 'csv',
    label: 'Import CSV',
    description: 'Import a list of phone numbers',
    icon: Upload,
  },
];

const OPERATOR_OPTIONS: { value: CustomFieldOperator; label: string }[] = [
  { value: 'is', label: 'is' },
  { value: 'is_not', label: 'is not' },
  { value: 'contains', label: 'contains' },
];

export function Step2SelectAudience({
  audience,
  onUpdate,
  onNext,
  onBack,
}: Step2Props) {
  const { t, language } = useLanguage();
  const [tags, setTags] = useState<Tag[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [estimatedCount, setEstimatedCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);
  /** Contacts dropped from the estimate because they opted out (migration 030). */
  const [excludedOptedOut, setExcludedOptedOut] = useState(0);
  // The picked file's name, shown back to the user. The parsed rows
  // themselves live on `audience.csvContacts` (owned by the wizard) so
  // they survive stepping forward and back.
  const [pickedCsvName, setPickedCsvName] = useState<string | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const csvCount = audience.csvContacts?.length ?? 0;
  // Only meaningful while the rows it produced are still in play —
  // picking another audience type wipes `csvContacts`.
  const csvFileName = csvCount > 0 ? pickedCsvName : null;

  // Tags are used both by the primary "Filter by Tags" audience type
  // AND by the exclude-list below — so always load once on mount.
  useEffect(() => {
    async function fetchTags() {
      setLoadingTags(true);
      try {
        const supabase = createClient();
        const { data } = await supabase.from('tags').select('*').order('name');
        setTags(data ?? []);
      } finally {
        setLoadingTags(false);
      }
    }
    fetchTags();
  }, []);

  // Lazy-load custom fields only when that audience type is active.
  useEffect(() => {
    if (audience.type !== 'custom_field') return;
    async function fetchFields() {
      setLoadingFields(true);
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from('custom_fields')
          .select('*')
          .order('field_name');
        setCustomFields(data ?? []);
      } finally {
        setLoadingFields(false);
      }
    }
    fetchFields();
  }, [audience.type]);

  const fetchEstimatedCount = useCallback(async () => {
    setLoadingCount(true);
    try {
      const supabase = createClient();

      // Base query — produces the superset before exclude is applied.
      let baseIds: Set<string> | null = null; // null means "all contacts"
      setExcludedOptedOut(0);

      if (audience.type === 'all') {
        // Handled below — full-table count adjusted by excludes.
      } else if (
        audience.type === 'tags' &&
        audience.tagIds &&
        audience.tagIds.length > 0
      ) {
        const { data } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.tagIds);
        baseIds = new Set((data ?? []).map((r) => r.contact_id));
      } else if (
        audience.type === 'custom_field' &&
        audience.customField?.fieldId &&
        audience.customField.value
      ) {
        const { fieldId, operator, value } = audience.customField;
        let q = supabase
          .from('contact_custom_values')
          .select('contact_id')
          .eq('custom_field_id', fieldId);
        if (operator === 'is') q = q.eq('value', value);
        else if (operator === 'is_not') q = q.neq('value', value);
        else q = q.ilike('value', `%${value}%`);
        const { data } = await q;
        baseIds = new Set((data ?? []).map((r) => r.contact_id));
      } else if (
        audience.type === 'csv' &&
        audience.csvContacts &&
        audience.csvContacts.length > 0
      ) {
        setEstimatedCount(audience.csvContacts.length);
        return;
      } else {
        // Partially-configured audience — wait for the user to finish.
        setEstimatedCount(null);
        return;
      }

      // Apply exclude tags
      let excludeSet: Set<string> | null = null;
      if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
        const { data: excludeRows } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.excludeTagIds);
        excludeSet = new Set((excludeRows ?? []).map((r) => r.contact_id));
      }

      // Opted-out contacts never receive broadcasts (migration 030) —
      // drop them from the estimate and tell the user how many.
      const { data: optedOutRows } = await supabase
        .from('contacts')
        .select('id')
        .not('opted_out_at', 'is', null);
      const optedOutIds = new Set((optedOutRows ?? []).map((r) => r.id as string));

      if (baseIds) {
        const afterTags = [...baseIds].filter((id) => !excludeSet?.has(id));
        const effective = afterTags.filter((id) => !optedOutIds.has(id));
        setExcludedOptedOut(afterTags.length - effective.length);
        setEstimatedCount(effective.length);
      } else {
        // "All contacts" — fetch the total, then subtract exclude set if any.
        const { count } = await supabase
          .from('contacts')
          .select('*', { count: 'exact', head: true });
        const total = count ?? 0;
        // Opted-out contacts that are also tag-excluded must not be
        // subtracted twice.
        const optedOutNotTagExcluded = [...optedOutIds].filter((id) => !excludeSet?.has(id)).length;
        setExcludedOptedOut(optedOutNotTagExcluded);
        const afterTags = excludeSet ? Math.max(0, total - excludeSet.size) : total;
        setEstimatedCount(Math.max(0, afterTags - optedOutNotTagExcluded));
      }
    } finally {
      setLoadingCount(false);
    }
  }, [
    audience.type,
    audience.tagIds,
    audience.customField,
    audience.csvContacts,
    audience.excludeTagIds,
  ]);

  useEffect(() => {
    fetchEstimatedCount();
  }, [fetchEstimatedCount]);

  /**
   * "Importar CSV" had no picker at all (wacrm #512): selecting it
   * rendered nothing, `csvContacts` stayed undefined and Next stayed
   * disabled forever.
   */
  async function handleCsvChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    const result = parseBroadcastCsv(await selected.text());

    if (!result.ok) {
      toast.error(
        result.error === 'missing_phone_column'
          ? t('The CSV needs a "phone" column header.')
          : t('No valid phone numbers found in the CSV.'),
      );
      // Clear the input so re-picking the same corrected file still
      // fires `change` (the browser suppresses it for an identical value).
      e.target.value = '';
      setPickedCsvName(null);
      onUpdate({ ...audience, csvContacts: undefined });
      return;
    }

    setPickedCsvName(selected.name);
    onUpdate({ ...audience, csvContacts: result.contacts });
    if (result.invalid > 0) {
      toast.warning(
        `${t('Rows without a valid phone were ignored')}: ${result.invalid}`,
      );
    }
  }

  function toggleTag(tagId: string) {
    const current = audience.tagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, tagIds: updated });
  }

  function toggleExcludeTag(tagId: string) {
    const current = audience.excludeTagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, excludeTagIds: updated });
  }

  function updateCustomField(patch: Partial<CustomFieldFilter>) {
    const prev = audience.customField ?? {
      fieldId: '',
      operator: 'is' as CustomFieldOperator,
      value: '',
    };
    onUpdate({ ...audience, customField: { ...prev, ...patch } });
  }

  const isValid =
    audience.type === 'all' ||
    (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) ||
    (audience.type === 'custom_field' &&
      !!audience.customField?.fieldId &&
      audience.customField.value.length > 0) ||
    (audience.type === 'csv' &&
      audience.csvContacts &&
      audience.csvContacts.length > 0);

  const tagPill = (tag: Tag, on: boolean, tone: 'primary' | 'danger', toggle: () => void) => (
    <button key={tag.id} type="button" aria-pressed={on} onClick={toggle} className={pillClass(on, tone)}>
      <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
      {tag.name}
    </button>
  );
  const selectClass =
    'h-8 rounded-md border border-input bg-transparent px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

  return (
    <div className="space-y-6">
      <StepHeader title={t('Select Audience')} description={t('Choose who will receive this broadcast.')} />

      <ul className="divide-y divide-border border-y border-border">
        {audienceOptions.map((option) => {
          const isSelected = audience.type === option.type;
          const Icon = option.icon;
          return (
            <li key={option.type}>
              <button
                type="button"
                aria-pressed={isSelected}
                onClick={() =>
                  onUpdate({
                    ...audience,
                    type: option.type,
                    // Wipe shape fields from other types to avoid stale
                    // config leaking across selections.
                    tagIds: option.type === 'tags' ? audience.tagIds : undefined,
                    customField:
                      option.type === 'custom_field'
                        ? audience.customField
                        : undefined,
                    csvContacts:
                      option.type === 'csv' ? audience.csvContacts : undefined,
                  })
                }
                className={optionRowClass(isSelected)}
              >
                <Icon
                  className={cn('mt-0.5 size-4 shrink-0', isSelected ? 'text-primary' : 'text-muted-foreground')}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{t(option.label)}</span>
                  <span className="block text-xs text-muted-foreground">{t(option.description)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {audience.type === 'tags' && (
        <section className="space-y-2">
          <h3 className={SECTION_TITLE}>{t('Select Tags')}</h3>
          {loadingTags ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={t('Loading…')} />
          ) : tags.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('No tags found. Create tags in Settings.')}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) =>
                tagPill(tag, !!audience.tagIds?.includes(tag.id), 'primary', () => toggleTag(tag.id)),
              )}
            </div>
          )}
        </section>
      )}

      {audience.type === 'custom_field' && (
        <section className="space-y-2">
          <h3 className={SECTION_TITLE}>{t('Custom Field Filter')}</h3>
          {loadingFields ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={t('Loading…')} />
          ) : customFields.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('No custom fields defined. Create one in Settings → Custom fields.')}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)]">
              <select
                aria-label={t('Field')}
                value={audience.customField?.fieldId ?? ''}
                onChange={(e) => updateCustomField({ fieldId: e.target.value })}
                className={selectClass}
              >
                <option value="">{t('Select field…')}</option>
                {customFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.field_name}
                  </option>
                ))}
              </select>
              <select
                aria-label={t('Operator')}
                value={audience.customField?.operator ?? 'is'}
                onChange={(e) =>
                  updateCustomField({
                    operator: e.target.value as CustomFieldOperator,
                  })
                }
                className={selectClass}
              >
                {OPERATOR_OPTIONS.map((op) => (
                  <option key={op.value} value={op.value}>
                    {t(op.label)}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={audience.customField?.value ?? ''}
                onChange={(e) => updateCustomField({ value: e.target.value })}
                placeholder={t('Value')}
                aria-label={t('Value')}
                className={cn(selectClass, 'placeholder:text-muted-foreground')}
              />
            </div>
          )}
        </section>
      )}

      {audience.type === 'csv' && (
        <section className="space-y-2">
          <h3 className={SECTION_TITLE}>{t('Upload CSV')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('A "phone" column is required (with country code, e.g. +55 11 99999-0000); "name" is optional.')}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={() => csvInputRef.current?.click()}>
              {csvFileName ? <FileText /> : <Upload />}
              {t('Choose a CSV file')}
            </Button>
            {csvFileName && (
              <span className="min-w-0 truncate text-sm text-foreground" data-no-translate>
                {csvFileName}
              </span>
            )}
            {csvCount > 0 && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {t('Contacts found in the file')}: {csvCount}
              </span>
            )}
          </div>

          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleCsvChange}
            className="hidden"
            aria-label={t('Choose a CSV file')}
          />
        </section>
      )}

      {/* Exclude list — applies regardless of audience type */}
      <section className="space-y-2 border-t border-border pt-4">
        <h3 className={SECTION_TITLE}>
          {t('Exclude contacts with these tags')}{' '}
          <span className="normal-case tracking-normal">{t('(optional)')}</span>
        </h3>
        {tags.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('No tags available.')}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) =>
              tagPill(tag, !!audience.excludeTagIds?.includes(tag.id), 'danger', () => toggleExcludeTag(tag.id)),
            )}
          </div>
        )}
      </section>

      {/* Audience summary — one quiet line */}
      <section className="space-y-1 border-t border-border pt-4" aria-live="polite">
        <h3 className={SECTION_TITLE}>{t('Audience Summary')}</h3>
        {loadingCount ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {t('Calculating…')}
          </p>
        ) : estimatedCount !== null ? (
          <p className="text-sm text-muted-foreground">
            <span className="text-base font-semibold tabular-nums text-foreground">
              {estimatedCount.toLocaleString(language)}
            </span>{' '}
            {t('estimated recipients')}
            {excludedOptedOut > 0 && (
              <span className="text-xs">
                {' '}
                · {excludedOptedOut}{' '}
                {t(excludedOptedOut === 1 ? 'opted-out contact excluded' : 'opted-out contacts excluded')}
              </span>
            )}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t('Select an audience type to see the estimate.')}</p>
        )}
      </section>

      <StepFooter>
        <Button variant="ghost" onClick={onBack} className="text-muted-foreground hover:text-foreground">
          <ArrowLeft />
          {t('Back')}
        </Button>
        <Button onClick={onNext} disabled={!isValid}>
          {t('Next')}
          <ArrowRight />
        </Button>
      </StepFooter>
    </div>
  );
}
