'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader2, Pencil, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useLanguage } from '@/hooks/use-language';
import type { CompanySummary } from '@/lib/companies';
import { CompanyLine, CompanySearchPicker } from './company-pickers';

/**
 * A deal's company: the chosen company with "Change" / "Remove", or a
 * "Choose company" button. Used by the deal form (value held by the
 * form) and the deal view (value saved on change). `hint` explains
 * where a default came from ("contact's primary company").
 */
export function DealCompanyField({
  company,
  onChange,
  readOnly,
  busy,
  hint,
  linkToCompany,
}: {
  company: CompanySummary | null;
  onChange: (company: CompanySummary | null) => void;
  readOnly?: boolean;
  busy?: boolean;
  hint?: string | null;
  /** Make the name a link to /companies (view mode). */
  linkToCompany?: boolean;
}) {
  const { t } = useLanguage();
  const [picking, setPicking] = useState(false);

  if (picking) {
    return (
      <CompanySearchPicker
        excludeIds={company ? new Set([company.id]) : undefined}
        onPick={(c) => {
          setPicking(false);
          onChange(c);
        }}
        onCancel={() => setPicking(false)}
      />
    );
  }

  if (!company) {
    return readOnly ? (
      <p className="text-sm text-muted-foreground">{t('No company')}</p>
    ) : (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => setPicking(true)}
        className="border-border text-muted-foreground"
      >
        {busy ? <Loader2 className="animate-spin" /> : null}
        {t('Choose company')}
      </Button>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex items-start gap-2">
        {linkToCompany ? (
          <Link href={`/companies?company=${company.id}`} className="min-w-0 flex-1 text-sm text-foreground hover:text-primary">
            <CompanyLine company={company} />
          </Link>
        ) : (
          <span className="min-w-0 flex-1 text-sm text-foreground">
            <CompanyLine company={company} />
          </span>
        )}
        {!readOnly ? (
          <div className="flex shrink-0 items-center gap-0.5">
            {busy ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              disabled={busy}
              aria-label={t('Change company')}
              title={t('Change company')}
              onClick={() => setPicking(true)}
              className="text-muted-foreground hover:text-foreground"
            >
              <Pencil />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              disabled={busy}
              aria-label={t('Remove company')}
              title={t('Remove company')}
              onClick={() => onChange(null)}
              className="text-muted-foreground hover:text-destructive"
            >
              <X />
            </Button>
          </div>
        ) : null}
      </div>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
