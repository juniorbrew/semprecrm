'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Building2, Loader2, Plus, Star, Unlink } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useLanguage } from '@/hooks/use-language';
import {
  companyErrorMessage,
  linkContactCompany,
  listContactCompanies,
  setPrimaryCompany,
  unlinkContactCompany,
  type ContactCompanyLink,
} from '@/lib/companies';
import { createClient } from '@/lib/supabase/client';
import { CompanyFormDialog } from './company-form-dialog';
import { CompanyLine, CompanySearchPicker } from './company-pickers';

/**
 * Contact detail → "Empresas": the contact's companies, primary first.
 * Agent+ links an existing company (or creates one and links it),
 * marks another one as primary, or unlinks. The primary bookkeeping
 * (first link is primary, one primary per contact, promotion when the
 * primary is removed) happens in the database (migration 054).
 */
export function ContactCompanies({
  contactId,
  readOnly,
  onChanged,
}: {
  contactId: string;
  readOnly?: boolean;
  onChanged?: () => void;
}) {
  const { t } = useLanguage();
  const [links, setLinks] = useState<ContactCompanyLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLinks(await listContactCompanies(createClient(), contactId));
    } catch (err) {
      toast.error(t(companyErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, [contactId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(companyId: string, action: () => Promise<void>, success: string) {
    setBusy(companyId);
    try {
      await action();
      toast.success(t(success));
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(t(companyErrorMessage(err)));
    } finally {
      setBusy(null);
    }
  }

  const link = (companyId: string) =>
    run(companyId, async () => {
      await linkContactCompany(createClient(), contactId, companyId);
      setPicking(false);
    }, 'Company linked');

  const linkedIds = new Set(links.map((l) => l.company.id));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t('Companies of this contact')}
        </p>
        {!readOnly ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => setPicking((v) => !v)}
            className="text-muted-foreground hover:text-foreground"
          >
            <Plus />
            {t('Link company')}
          </Button>
        ) : null}
      </div>

      {picking ? (
        <CompanySearchPicker
          excludeIds={linkedIds}
          onPick={(c) => void link(c.id)}
          onCancel={() => setPicking(false)}
          footer={
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-primary hover:bg-muted"
            >
              <Plus className="size-3.5" />
              {t('Create a new company')}
            </button>
          }
        />
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : links.length === 0 ? (
        <div className="flex flex-col items-center gap-1 py-6 text-center">
          <Building2 className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('No companies linked yet')}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {links.map((l) => (
            <li key={l.company.id} className="rounded-lg border border-border bg-muted/50 p-3">
              <div className="flex items-start gap-2">
                <Link href={`/companies?company=${l.company.id}`} className="min-w-0 flex-1 text-sm text-foreground hover:text-primary">
                  <CompanyLine company={l.company} />
                </Link>
                {l.is_primary ? (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                    <Star className="size-2.5 fill-current" />
                    {t('Primary')}
                  </span>
                ) : null}
              </div>
              {!readOnly ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {!l.is_primary ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={busy === l.company.id}
                      onClick={() =>
                        void run(
                          l.company.id,
                          () => setPrimaryCompany(createClient(), contactId, l.company.id),
                          'Primary company updated',
                        )
                      }
                      className="border-border"
                    >
                      <Star />
                      {t('Mark as primary')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busy === l.company.id}
                    onClick={() =>
                      void run(
                        l.company.id,
                        () => unlinkContactCompany(createClient(), contactId, l.company.id),
                        'Company unlinked',
                      )
                    }
                    className="text-muted-foreground hover:text-destructive"
                  >
                    {busy === l.company.id ? <Loader2 className="animate-spin" /> : <Unlink />}
                    {t('Unlink')}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <CompanyFormDialog
        open={creating}
        onOpenChange={setCreating}
        onSaved={(company) => void link(company.id)}
        // The CNPJ already exists: link that company instead of leaving
        // the user stuck in front of the duplicate warning.
        onOpenExisting={(id) => {
          if (linkedIds.has(id)) {
            toast.info(t('This contact is already linked to this company'));
            setPicking(false);
            return;
          }
          void link(id);
        }}
        openExistingLabel={t('Link this company')}
      />
    </div>
  );
}
