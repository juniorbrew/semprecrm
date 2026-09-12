'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, FileText, ArrowRight, Search, Settings2 } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';

/**
 * Meta template categories are stored title-cased ('Marketing' /
 * 'Utility' / 'Authentication'); the label is looked up through the i18n
 * layer so the badge reads "Utilidade" / "Autenticação" in pt-BR.
 */
const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  Utility: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Authentication: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
};

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
  const { t } = useLanguage();
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
        setTemplates(data ?? []);
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
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{t(error)}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('Choose a template')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Select an approved message template for the broadcast.')}
          </p>
        </div>
        {templates.length > 0 && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {templates.length} {t('approved templates')}
            </span>
            <Link
              href={TEMPLATES_SETTINGS_HREF}
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t('Manage templates')}
            </Link>
          </div>
        )}
      </div>

      {templates.length >= SEARCH_THRESHOLD && (
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search templates…')}
            aria-label={t('Search templates…')}
            className="border-border bg-muted pl-9 text-foreground placeholder:text-muted-foreground"
          />
        </div>
      )}

      {templates.length === 0 ? (
        <div className="flex h-56 flex-col items-center justify-center rounded-xl border border-border bg-card/50 px-6 text-center">
          <FileText className="mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{t('No templates available.')}</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {t('Only approved templates can be used in broadcasts.')}{' '}
            {t('Create a template in Settings first.')}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4 border-border"
            render={<Link href={TEMPLATES_SETTINGS_HREF} />}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t('Manage templates')}
          </Button>
        </div>
      ) : filteredTemplates.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50">
          <p className="text-sm text-muted-foreground">{t('No template matches your search.')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredTemplates.map((template) => {
            const isSelected = selectedTemplate?.id === template.id;
            const catColor = categoryColors[template.category] ?? categoryColors.Utility;

            return (
              <button
                key={template.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelect(template)}
                className={`flex flex-col gap-3 rounded-xl border p-4 text-left transition-all ${
                  isSelected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'border-border bg-card/50 hover:border-primary/40 hover:bg-card'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-medium text-foreground">{template.name}</h3>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${catColor}`}
                  >
                    {t(template.category)}
                  </span>
                </div>
                <p className="line-clamp-3 text-xs text-muted-foreground">{template.body_text}</p>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>{template.language ?? 'en_US'}</span>
                  {/* Status is omitted on purpose — every template
                      shown here is already filtered to APPROVED,
                      so the chip carried no information. */}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="border-border text-muted-foreground">
          {t('Back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!selectedTemplate}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('Next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
