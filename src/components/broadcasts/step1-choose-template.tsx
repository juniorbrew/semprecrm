'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, FileText, ArrowRight, Search, Settings2 } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { templateLanguageLabel } from './template-language-label';
import { isStubTemplate } from '@/lib/whatsapp/template-row-guard';
import { cn } from '@/lib/utils';
import { StepFooter, StepHeader, optionRowClass } from './wizard-ui';

/** Show the search box once the grid is big enough to need it. */
const SEARCH_THRESHOLD = 4;

const TEMPLATES_SETTINGS_HREF = '/settings?tab=templates';

interface Step1Props {
  selectedTemplate: MessageTemplate | null;
  onSelect: (template: MessageTemplate) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step1ChooseTemplate({ selectedTemplate, onSelect, onNext, onBack }: Step1Props) {
  const { t, language } = useLanguage();
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    async function fetchTemplates() {
      try {
        const supabase = createClient();
        // Only APPROVED templates can be sent via Meta — anything else
        // would 400 at broadcast time. Hide them rather than letting
        // the user pick a template that will fail.
        const { data, error: fetchError } = await supabase
          .from('message_templates')
          .select('*')
          .eq('status', 'APPROVED')
          .order('created_at', { ascending: false });

        if (fetchError) throw fetchError;
        // Webhook stubs (migration 053) have no components yet — every
        // recipient would fail at Meta, so they are not offered.
        setTemplates((data ?? []).filter((tpl) => !isStubTemplate(tpl)));
      } catch (err) {
        // English key — translated where it is rendered.
        setError(err instanceof Error ? err.message : 'Failed to load templates');
      } finally {
        setLoading(false);
      }
    }

    fetchTemplates();
  }, []);

  const filteredTemplates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (tpl) =>
        tpl.name.toLowerCase().includes(q) ||
        tpl.body_text.toLowerCase().includes(q) ||
        tpl.category.toLowerCase().includes(q) ||
        t(tpl.category).toLowerCase().includes(q),
    );
  }, [templates, query, t]);

  if (loading) {
    return (
      <p role="status" className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t('Loading…')}
      </p>
    );
  }

  if (error) {
    return (
      <p role="alert" className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        {t(error)}
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <StepHeader
          title={t('Choose a template')}
          description={t('Select an approved message template for the broadcast.')}
        />
        {templates.length > 0 && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {templates.length} {t('approved templates')}
            </span>
            <Link
              href={TEMPLATES_SETTINGS_HREF}
              className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Settings2 className="size-3.5" aria-hidden="true" />
              {t('Manage templates')}
            </Link>
          </div>
        )}
      </div>

      {templates.length >= SEARCH_THRESHOLD && (
        <div className="relative max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search templates…')}
            aria-label={t('Search templates…')}
            className="h-8 pl-8 text-sm"
          />
        </div>
      )}

      {templates.length === 0 ? (
        <div className="border-y border-border py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {t('No templates available.')} {t('Only approved templates can be used in broadcasts.')}
          </p>
          <Button variant="outline" size="sm" className="mt-3" render={<Link href={TEMPLATES_SETTINGS_HREF} />}>
            <Settings2 />
            {t('Manage templates')}
          </Button>
        </div>
      ) : filteredTemplates.length === 0 ? (
        <p className="border-y border-border py-10 text-center text-sm text-muted-foreground">
          {t('No template matches your search.')}
        </p>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {filteredTemplates.map((template) => {
            const isSelected = selectedTemplate?.id === template.id;
            return (
              <li key={template.id}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onSelect(template)}
                  className={optionRowClass(isSelected)}
                >
                  <FileText
                    className={cn('mt-0.5 size-4 shrink-0', isSelected ? 'text-primary' : 'text-muted-foreground')}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{template.name}</span>
                      {/* Status is omitted on purpose — every template here is APPROVED. */}
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t(template.category)} · <span data-no-translate>{templateLanguageLabel(template.language, language)}</span>
                      </span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{template.body_text}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <StepFooter>
        <Button variant="ghost" onClick={onBack} className="text-muted-foreground hover:text-foreground">
          {t('Back')}
        </Button>
        <Button onClick={onNext} disabled={!selectedTemplate}>
          {t('Next')}
          <ArrowRight />
        </Button>
      </StepFooter>
    </div>
  );
}
