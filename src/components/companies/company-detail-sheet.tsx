'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Briefcase,
  Building2,
  Link2,
  Loader2,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  Star,
  StickyNote,
  Trash2,
  Unlink,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';

import { NOTES_LABEL } from '@/components/contacts/notes-label';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useCan } from '@/hooks/use-can';
import { useLanguage } from '@/hooks/use-language';
import { formatTaxId } from '@/lib/br/documents';
import { formatCep, formatPhone } from '@/lib/br/lookup';
import {
  companyDisplayName,
  companyErrorMessage,
  getCompany,
  linkContactCompany,
  listCompanyContacts,
  listCompanyDeals,
  searchContactsForCompany,
  unlinkContactCompany,
  type Company,
  type CompanyContactLink,
  type CompanyDeal,
} from '@/lib/companies';
import { formatCurrency } from '@/lib/currency';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { SearchPicker } from './search-picker';

interface CompanyDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string | null;
  /** Bumped by the page after an edit so the sheet reloads. */
  reloadKey?: number;
  onEdit: (company: Company) => void;
  onDelete: (company: Company) => void;
  /** Links changed (the list shows a contact count). */
  onChanged?: () => void;
}

/** "Rua Garibaldi, 70 — Sala 2 · Centro · Porto Alegre/RS · 90000-000" */
export function companyAddressLine(c: Company): string {
  const street = [c.logradouro, c.numero].filter(Boolean).join(', ');
  const first = [street, c.complemento].filter(Boolean).join(' — ');
  const place = [c.cidade, c.uf].filter(Boolean).join('/');
  return [first, c.bairro, place, c.cep ? formatCep(c.cep) : null].filter(Boolean).join(' · ');
}

export function CompanyDetailSheet({
  open,
  onOpenChange,
  companyId,
  reloadKey = 0,
  onEdit,
  onDelete,
  onChanged,
}: CompanyDetailSheetProps) {
  const { t, language } = useLanguage();
  const canEdit = useCan('send-messages');

  const [company, setCompany] = useState<Company | null>(null);
  const [contacts, setContacts] = useState<CompanyContactLink[]>([]);
  const [deals, setDeals] = useState<CompanyDeal[]>([]);
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [busyContact, setBusyContact] = useState<string | null>(null);

  // The id the latest load is for — a slower answer for a company the
  // user already left is dropped.
  const latestId = useRef(companyId);

  const load = useCallback(async () => {
    if (!companyId) return;
    latestId.current = companyId;
    setLoading(true);
    const db = createClient();
    try {
      const [c, links, ds] = await Promise.all([
        getCompany(db, companyId),
        listCompanyContacts(db, companyId),
        listCompanyDeals(db, companyId),
      ]);
      if (latestId.current !== companyId) return;
      setCompany(c);
      setMissing(!c);
      setContacts(links);
      setDeals(ds);
    } catch (err) {
      if (latestId.current !== companyId) return;
      setMissing(true);
      toast.error(t(companyErrorMessage(err)));
    } finally {
      if (latestId.current === companyId) setLoading(false);
    }
  }, [companyId, t]);

  // A different company: drop the previous one first, so the header's
  // Edit / Delete can never act on it while the new one loads.
  const [shownId, setShownId] = useState(companyId);
  if (shownId !== companyId) {
    setShownId(companyId);
    setCompany(null);
    setContacts([]);
    setDeals([]);
    setMissing(false);
    setLinking(false);
  }

  useEffect(() => {
    if (!open || !companyId) return;
    void load();
  }, [open, companyId, reloadKey, load]);

  async function link(contactId: string) {
    if (!companyId) return;
    setBusyContact(contactId);
    try {
      await linkContactCompany(createClient(), contactId, companyId);
      toast.success(t('Contact linked'));
      setLinking(false);
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(t(companyErrorMessage(err)));
    } finally {
      setBusyContact(null);
    }
  }

  async function unlink(contactId: string) {
    if (!companyId) return;
    setBusyContact(contactId);
    try {
      await unlinkContactCompany(createClient(), contactId, companyId);
      toast.success(t('Contact unlinked'));
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(t(companyErrorMessage(err)));
    } finally {
      setBusyContact(null);
    }
  }

  const linkedIds = new Set(contacts.map((l) => l.contact.id));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full border-border bg-popover p-0 text-popover-foreground data-[side=right]:sm:max-w-[480px]"
      >
        {loading && !company ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : !company ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <SheetTitle className="sr-only">{t('Company')}</SheetTitle>
            <Building2 className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{missing ? t('Company not found') : t('Loading...')}</p>
          </div>
        ) : (
          <div className="flex h-full flex-col">
            <SheetHeader className="gap-3 border-b border-border/50 p-4 pb-3">
              <div className="flex items-start gap-3 pr-8">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Building2 className="size-6" />
                </span>
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate text-lg leading-tight text-popover-foreground">
                    {companyDisplayName(company)}
                  </SheetTitle>
                  <SheetDescription className="sr-only">{t('Company details')}</SheetDescription>
                  {company.nome_fantasia && company.nome_fantasia.trim() !== company.razao_social ? (
                    <p className="truncate text-xs text-muted-foreground">{company.razao_social}</p>
                  ) : null}
                  {company.cnpj ? (
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">CNPJ {formatTaxId('pj', company.cnpj)}</p>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onEdit(company)}
                  disabled={!canEdit}
                  className="flex-1 border-border text-foreground hover:bg-muted"
                >
                  <Pencil className="size-3.5" />
                  {t('Edit')}
                </Button>
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label={t('Delete company')}
                  title={t('Delete company')}
                  onClick={() => onDelete(company)}
                  disabled={!canEdit}
                  className="border-border text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </SheetHeader>

            <div className="flex-1 space-y-5 overflow-y-auto p-4">
              {/* Registration */}
              <section className="space-y-1.5 text-sm">
                {company.email ? (
                  <a href={`mailto:${company.email}`} className="flex items-center gap-2 text-foreground hover:text-primary">
                    <Mail className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{company.email}</span>
                  </a>
                ) : null}
                {company.phone ? (
                  <a href={`tel:+55${company.phone}`} className="flex items-center gap-2 text-foreground hover:text-primary">
                    <Phone className="size-3.5 shrink-0 text-muted-foreground" />
                    <span>{formatPhone(company.phone)}</span>
                  </a>
                ) : null}
                {companyAddressLine(company) ? (
                  <p className="flex items-start gap-2 text-foreground">
                    <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <span>{companyAddressLine(company)}</span>
                  </p>
                ) : null}
                {company.atividade ? (
                  <p className="flex items-start gap-2 text-foreground">
                    <Briefcase className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <span>
                      {company.atividade}
                      {company.cnae ? <span className="ml-1 font-mono text-xs text-muted-foreground">CNAE {company.cnae}</span> : null}
                    </span>
                  </p>
                ) : null}
                {company.notes ? (
                  <div className="mt-2 flex gap-2 rounded-xl border border-border bg-card p-3">
                    <StickyNote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label={NOTES_LABEL[language]} />
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{company.notes}</p>
                  </div>
                ) : null}
              </section>

              {/* Contacts */}
              <section>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <Users className="size-3.5" />
                    {t('Contacts')}
                    {contacts.length > 0 ? (
                      <span className="rounded-full bg-muted px-1.5 text-[10px] font-semibold tabular-nums">{contacts.length}</span>
                    ) : null}
                  </h3>
                  {canEdit ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => setLinking((v) => !v)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Plus />
                      {t('Link contact')}
                    </Button>
                  ) : null}
                </div>
                {linking ? (
                  <div className="mb-2">
                    <SearchPicker<CompanyContactLink['contact']>
                      search={(term) => searchContactsForCompany(createClient(), term)}
                      getKey={(c) => c.id}
                      excludeKeys={linkedIds}
                      renderItem={(c) => (
                        <span className="block min-w-0">
                          <span className="block truncate font-medium">{c.name || c.phone}</span>
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">{c.phone}</span>
                        </span>
                      )}
                      onPick={(c) => void link(c.id)}
                      onCancel={() => setLinking(false)}
                      placeholder={t('Search by name, phone, or email...')}
                      emptyLabel={t('No contacts found')}
                      ariaLabel={t('Search contacts')}
                    />
                  </div>
                ) : null}
                {contacts.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('No contacts linked to this company yet')}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {contacts.map((l) => (
                      <li key={l.contact.id} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                        <Link href={`/contacts?contact=${l.contact.id}`} className="min-w-0 flex-1 hover:text-primary">
                          <span className="block truncate text-sm font-medium">{l.contact.name || l.contact.phone}</span>
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">{l.contact.phone}</span>
                        </Link>
                        {l.is_primary ? (
                          <span
                            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary"
                            title={t("This is the contact's primary company")}
                          >
                            <Star className="size-2.5" />
                            {t('Primary')}
                          </span>
                        ) : null}
                        {canEdit ? (
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-label={t('Unlink contact')}
                            title={t('Unlink contact')}
                            disabled={busyContact === l.contact.id}
                            onClick={() => void unlink(l.contact.id)}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            {busyContact === l.contact.id ? <Loader2 className="animate-spin" /> : <Unlink />}
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Deals */}
              <section>
                <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <Link2 className="size-3.5" />
                  {t('Deals')}
                  {deals.length > 0 ? (
                    <span className="rounded-full bg-muted px-1.5 text-[10px] font-semibold tabular-nums">{deals.length}</span>
                  ) : null}
                </h3>
                {deals.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('No deals linked to this company yet')}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {deals.map((d) => (
                      <li key={d.id}>
                        <Link
                          href={`/pipelines?deal=${d.id}`}
                          className="block rounded-lg border border-border bg-card px-3 py-2 transition-colors hover:border-primary/40 hover:bg-muted/60"
                        >
                          <span className="flex items-start justify-between gap-2">
                            <span className="truncate text-sm font-medium text-foreground">{d.title}</span>
                            {d.stage ? (
                              <span
                                className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                                style={{ backgroundColor: `${d.stage.color}20`, color: d.stage.color }}
                              >
                                {d.stage.name}
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                            <span>{formatCurrency(d.value, d.currency ?? undefined)}</span>
                            {d.status && d.status !== 'open' ? (
                              <span className={cn(d.status === 'won' ? 'text-primary' : 'text-red-400')}>
                                {t(d.status === 'won' ? 'Won' : 'Lost')}
                              </span>
                            ) : null}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
