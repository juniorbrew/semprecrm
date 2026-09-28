'use client';

import { Building2 } from 'lucide-react';

import { useLanguage } from '@/hooks/use-language';
import { formatTaxId } from '@/lib/br/documents';
import {
  companyDisplayName,
  companyPlace,
  searchCompanies,
  type CompanySummary,
} from '@/lib/companies';
import { createClient } from '@/lib/supabase/client';
import { SearchPicker } from './search-picker';

/** One company as a list row: name, then CNPJ · city/UF. */
export function CompanyLine({ company, className }: { company: CompanySummary; className?: string }) {
  const meta = [company.cnpj ? formatTaxId('pj', company.cnpj) : null, companyPlace(company) || null]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className={className ?? 'flex min-w-0 items-start gap-2'}>
      <Building2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0">
        <span className="block truncate font-medium">{companyDisplayName(company)}</span>
        {company.nome_fantasia && company.nome_fantasia.trim() !== company.razao_social ? (
          <span className="block truncate text-[11px] text-muted-foreground">{company.razao_social}</span>
        ) : null}
        {meta ? <span className="block truncate font-mono text-[11px] text-muted-foreground">{meta}</span> : null}
      </span>
    </span>
  );
}

export function CompanySearchPicker({
  onPick,
  onCancel,
  excludeIds,
  footer,
}: {
  onPick: (company: CompanySummary) => void;
  onCancel?: () => void;
  excludeIds?: ReadonlySet<string>;
  footer?: React.ReactNode;
}) {
  const { t } = useLanguage();
  return (
    <SearchPicker<CompanySummary>
      search={(term) => searchCompanies(createClient(), term)}
      getKey={(c) => c.id}
      renderItem={(c) => <CompanyLine company={c} />}
      onPick={onPick}
      onCancel={onCancel}
      excludeKeys={excludeIds}
      placeholder={t('Search by name or CNPJ…')}
      emptyLabel={t('No companies found')}
      ariaLabel={t('Search companies')}
      footer={footer}
    />
  );
}
