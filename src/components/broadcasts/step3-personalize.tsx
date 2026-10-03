'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Contact, CustomField, MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import {
  headerMediaUrlError,
  mediaHeaderTypeOf,
} from '@/lib/broadcast-header-media';
import { SECTION_TITLE, StepFooter, StepHeader } from './wizard-ui';

type VariableType = 'static' | 'field' | 'custom_field';

interface VariableMapping {
  type: VariableType;
  value: string;
}

interface Step3Props {
  template: MessageTemplate;
  variables: Record<string, VariableMapping>;
  onUpdate: (variables: Record<string, VariableMapping>) => void;
  /** Media URL for an IMAGE/VIDEO/DOCUMENT header, when the template has one. */
  headerMediaUrl: string;
  onHeaderMediaUrlChange: (url: string) => void;
  onNext: () => void;
  onBack: () => void;
}

/** Labels are English i18n keys — rendered through t(). */
const contactFields = [
  { value: 'name', label: 'Contact Name' },
  { value: 'phone', label: 'Phone Number' },
  { value: 'email', label: 'Email Address' },
  { value: 'company', label: 'Company' },
];

/** Badge label per media header type — English i18n keys. */
const MEDIA_HEADER_LABELS = {
  image: 'Image',
  video: 'Video',
  document: 'Document',
} as const;

const SAMPLE_CONTACT: Contact = {
  id: 'sample',
  user_id: '',
  account_id: '',
  name: 'Maria Silva',
  phone: '+55 11 99999-0000',
  email: 'maria@exemplo.com.br',
  company: 'Empresa Exemplo',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export function Step3Personalize({
  template,
  variables,
  onUpdate,
  headerMediaUrl,
  onHeaderMediaUrlChange,
  onNext,
  onBack,
}: Step3Props) {
  const { t } = useLanguage();
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingFields, setLoadingFields] = useState(true);
  const [firstContact, setFirstContact] = useState<Contact | null>(null);
  const [firstContactCustomValues, setFirstContactCustomValues] = useState<
    Map<string, string>
  >(new Map());
  const [loadingPreview, setLoadingPreview] = useState(true);

  // Load user's custom fields + a representative contact for the
  // live preview. Fall back to sample data if no contacts exist yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [fieldsRes, contactRes] = await Promise.all([
        supabase.from('custom_fields').select('*').order('field_name'),
        supabase
          .from('contacts')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      setCustomFields(fieldsRes.data ?? []);
      setLoadingFields(false);

      const contact = contactRes.data ?? null;
      setFirstContact(contact);

      if (contact) {
        const { data: customVals } = await supabase
          .from('contact_custom_values')
          .select('custom_field_id, value')
          .eq('contact_id', contact.id);
        if (!cancelled) {
          const map = new Map<string, string>();
          for (const row of customVals ?? []) {
            map.set(row.custom_field_id, row.value ?? '');
          }
          setFirstContactCustomValues(map);
        }
      }
      setLoadingPreview(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const placeholders = useMemo(() => {
    const matches = template.body_text.match(/\{\{(\d+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches)].sort();
  }, [template.body_text]);

  // Templates with an IMAGE/VIDEO/DOCUMENT header need a media URL at
  // send time — Meta requires the media component on every delivery and
  // rejects the broadcast without it (wacrm #298). Hidden for text headers.
  const mediaHeaderType = mediaHeaderTypeOf(template);

  // Seed the field with the template's stored sample URL the first time
  // we land on a media-header template, so the common "reuse the
  // approved media" case needs no typing. Only seeds when empty to avoid
  // clobbering a URL the user already edited.
  useEffect(() => {
    if (mediaHeaderType && !headerMediaUrl && template.header_media_url) {
      onHeaderMediaUrlChange(template.header_media_url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaHeaderType, template.header_media_url]);

  const headerMediaError = useMemo(
    () => headerMediaUrlError(mediaHeaderType, headerMediaUrl),
    [mediaHeaderType, headerMediaUrl],
  );

  /**
   * A placeholder is "unmapped" if the user hasn't picked either a
   * static value or a field/custom-field source. Blocks Next until
   * every placeholder has something — otherwise the broadcast would
   * ship with empty strings and confuse recipients.
   */
  const unmappedKeys = useMemo(() => {
    const missing: string[] = [];
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      if (!mapping || !mapping.value?.trim()) {
        missing.push(placeholder);
      }
    }
    return missing;
  }, [placeholders, variables]);

  function updateVariable(key: string, patch: Partial<VariableMapping>) {
    const current = variables[key] ?? { type: 'static' as VariableType, value: '' };
    onUpdate({
      ...variables,
      [key]: { ...current, ...patch },
    });
  }

  /**
   * Substitute placeholders using the first real contact where
   * possible. Placeholders keyed by "{{N}}" map to variable key "N".
   */
  const previewText = useMemo(() => {
    const contact = firstContact ?? SAMPLE_CONTACT;
    const customValues = firstContact
      ? firstContactCustomValues
      : new Map<string, string>();

    let text = template.body_text;
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      let replacement = placeholder;

      if (mapping) {
        if (mapping.type === 'static' && mapping.value) {
          replacement = mapping.value;
        } else if (mapping.type === 'field' && mapping.value) {
          const fieldMap: Record<string, string | undefined> = {
            name: contact.name,
            phone: contact.phone,
            email: contact.email,
            company: contact.company,
          };
          replacement = fieldMap[mapping.value] ?? placeholder;
        } else if (mapping.type === 'custom_field' && mapping.value) {
          replacement = customValues.get(mapping.value) || placeholder;
        }
      }
      text = text.replaceAll(placeholder, replacement);
    }
    return text;
  }, [
    template.body_text,
    variables,
    placeholders,
    firstContact,
    firstContactCustomValues,
  ]);

  const previewLabel = firstContact
    ? firstContact.name || firstContact.phone
    : t('sample data');

  return (
    <div className="space-y-6">
      <StepHeader
        title={t('Personalize Message')}
        description={t('Map template variables to contact fields, custom fields, or static values.')}
      />

      {mediaHeaderType && (
        <section className="space-y-2">
          <h3 className={SECTION_TITLE}>
            {t('Header media')} · {t(MEDIA_HEADER_LABELS[mediaHeaderType])}
          </h3>
          <label htmlFor="broadcast-header-media-url" className="block text-xs font-medium text-muted-foreground">
            {t('Media URL')}
          </label>
          <Input
            id="broadcast-header-media-url"
            type="url"
            value={headerMediaUrl}
            onChange={(e) => onHeaderMediaUrlChange(e.target.value)}
            aria-invalid={headerMediaError !== null}
            aria-describedby={headerMediaError ? 'broadcast-header-media-error' : 'broadcast-header-media-hint'}
            placeholder={`https://example.com/header.${
              mediaHeaderType === 'image'
                ? 'jpg'
                : mediaHeaderType === 'video'
                  ? 'mp4'
                  : 'pdf'
            }`}
          />
          <p id="broadcast-header-media-hint" className="text-xs text-muted-foreground">
            {t('Public URL of the media sent as the message header. Used for every recipient in this broadcast.')}
          </p>
          {mediaHeaderType === 'image' &&
            headerMediaError === null &&
            headerMediaUrl.trim() && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={headerMediaUrl.trim()}
                alt={t('Header preview')}
                className="max-h-40 rounded-md border border-border object-contain"
              />
            )}
          {headerMediaError && (
            <p id="broadcast-header-media-error" role="alert" className="text-xs text-amber-700 dark:text-amber-300">
              {headerMediaError === 'missing'
                ? t('A media URL is required to send this template.')
                : t('Enter a valid http(s) URL.')}
            </p>
          )}
        </section>
      )}

      {placeholders.length === 0 && !mediaHeaderType ? (
        <p className="border-y border-border py-6 text-center text-sm text-muted-foreground">
          {t('This template has no variables to personalize.')}
        </p>
      ) : placeholders.length === 0 ? null : (
        <ul className="divide-y divide-border border-y border-border">
          {placeholders.map((placeholder) => {
            const key = placeholder.replace(/^\{\{|\}\}$/g, '');
            const mapping = variables[key] ?? { type: 'static', value: '' };
            const typeId = `broadcast-var-${key}-type`;
            const valueId = `broadcast-var-${key}-value`;

            return (
              <li
                key={placeholder}
                className="grid grid-cols-1 items-end gap-3 py-3 sm:grid-cols-[4rem_minmax(0,1fr)_minmax(0,1fr)]"
              >
                <span className="self-center font-mono text-xs font-medium text-muted-foreground">{placeholder}</span>

                <div className="space-y-1">
                  <label id={typeId} className="block text-xs text-muted-foreground">
                    {t('Mapping type')}
                  </label>
                  <Select
                    value={mapping.type}
                    items={{
                      static: t('Static Value'),
                      field: t('Contact Field'),
                      custom_field: t('Custom Field'),
                    }}
                    onValueChange={(val) =>
                      updateVariable(key, {
                        type: val as VariableType,
                        value: '',
                      })
                    }
                  >
                    <SelectTrigger aria-labelledby={typeId} className="h-8 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-border bg-popover">
                      <SelectItem value="static">{t('Static Value')}</SelectItem>
                      <SelectItem value="field">{t('Contact Field')}</SelectItem>
                      <SelectItem value="custom_field">
                        {t('Custom Field')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <label id={valueId} htmlFor={mapping.type === 'static' ? `${valueId}-input` : undefined} className="block text-xs text-muted-foreground">
                    {mapping.type === 'static' ? t('Value') : t('Field')}
                  </label>
                  {mapping.type === 'static' ? (
                    <Input
                      id={`${valueId}-input`}
                      value={mapping.value}
                      onChange={(e) =>
                        updateVariable(key, { value: e.target.value })
                      }
                      placeholder={t('Enter value...')}
                      className="h-8"
                    />
                  ) : mapping.type === 'field' ? (
                    <Select
                      // null (not undefined) keeps the Select controlled before a pick.
                      value={mapping.value || null}
                      items={Object.fromEntries(contactFields.map((f) => [f.value, t(f.label)]))}
                      onValueChange={(val) =>
                        updateVariable(key, { value: val || '' })
                      }
                    >
                      <SelectTrigger aria-labelledby={valueId} className="h-8 w-full">
                        <SelectValue placeholder={t('Select field…')} />
                      </SelectTrigger>
                      <SelectContent className="border-border bg-popover">
                        {contactFields.map((field) => (
                          <SelectItem key={field.value} value={field.value}>
                            {t(field.label)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Select
                      value={mapping.value || null}
                      items={Object.fromEntries(customFields.map((f) => [f.id, f.field_name]))}
                      onValueChange={(val) =>
                        updateVariable(key, { value: val || '' })
                      }
                    >
                      <SelectTrigger aria-labelledby={valueId} className="h-8 w-full">
                        <SelectValue
                          placeholder={
                            loadingFields
                              ? t('Loading…')
                              : customFields.length === 0
                                ? t('No custom fields')
                                : t('Select custom field…')
                          }
                        />
                      </SelectTrigger>
                      <SelectContent className="border-border bg-popover">
                        {customFields.map((f) => (
                          <SelectItem key={f.id} value={f.id}>
                            {f.field_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Live preview — an outgoing bubble like the inbox (brand fill),
          on a plain muted surface. */}
      <section className="space-y-2">
        <h3 className={SECTION_TITLE}>
          {t('Live Preview')} <span className="normal-case tracking-normal">· {previewLabel}</span>
          {loadingPreview && <Loader2 className="ml-1.5 inline size-3 animate-spin" aria-hidden />}
        </h3>
        <div className="rounded-[var(--radius)] bg-muted/50 p-3" aria-live="polite">
          <div className="ml-auto max-w-[85%] rounded-[calc(var(--radius)+2px)] rounded-br-[4px] bg-primary px-3 py-2 text-primary-foreground">
            <p className="whitespace-pre-wrap text-sm">{previewText}</p>
          </div>
        </div>
      </section>

      {unmappedKeys.length > 0 && (
        <p role="status" className="border-l-2 border-amber-500/70 pl-3 text-xs text-muted-foreground">
          {t('Map every placeholder before continuing — still missing')}{' '}
          <span className="font-mono font-semibold text-foreground">{unmappedKeys.join(', ')}</span>
          {t('. Otherwise those placeholders will ship to Meta as empty strings.')}
        </p>
      )}

      <StepFooter>
        <Button variant="ghost" onClick={onBack} className="text-muted-foreground hover:text-foreground">
          <ArrowLeft />
          {t('Back')}
        </Button>
        <Button onClick={onNext} disabled={unmappedKeys.length > 0 || headerMediaError !== null}>
          {t('Next')}
          <ArrowRight />
        </Button>
      </StepFooter>
    </div>
  );
}
