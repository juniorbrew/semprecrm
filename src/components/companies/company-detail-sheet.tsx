'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Briefcase, Building2, Loader2, Mail, MapPin, Pencil, Phone, Plus, Star, Trash2, Unlink } from 'lucide-react';
import { toast } from 'sonner';

import { NOTES_LABEL } from '@/components/contacts/notes-label';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useCan } from '@/hooks/use-can';
import { useLanguage } from '@/hooks/use-language';
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
import { companyInitials, companyMetaLine } from './company-list-row';
import { SearchPicker } from './search-picker';

/** Small muted uppercase section title — same as the inbox contact panel. */
const SECTION_TITLE = 'text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground';

const SHEET_COPY = {
  'pt-BR': { registration: 'Cadastro' },
  'en-US': { registration: 'Registration' },
} as const;

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

  const address = company ? companyAddressLine(company) : '';
  const copy = SHEET_COPY[language] ?? SHEET_COPY['pt-BR'];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full border-border bg-popover p-0 text-popover-foreground data-[side=right]:sm:max-w-[480px]"
      >
        {loading && !company ? (
          <div className="flex h-full items-center justify-center" role="status">
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
            <span className="sr-only">{t('Loading...')}</span>
          </div>
        ) : !company ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <SheetTitle className="sr-only">{t('Company')}</SheetTitle>
            <p className="text-sm text-muted-foreground">{missing ? t('Company not found') : t('Loading...')}</p>
          </div>
        ) : (
          <div className="flex h-full flex-col">
            {/* Identity + the one filled action */}
            <SheetHeader className="gap-3 p-4 pb-3">
              <div className="flex items-start gap-3 pr-8">
                <span
                  aria-hidden
                  className="flex size-10 shrink-0 items-center justify-center rounded-[calc(var(--radius)-2px)] bg-muted text-sm font-semibold text-muted-foreground"
                >
                  {companyInitials(companyDisplayName(company)) || <Building2 className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate text-base font-semibold leading-tight text-popover-foreground">
                    {companyDisplayName(company)}
                  </SheetTitle>
                  <SheetDescription className="sr-only">{t('Company details')}</SheetDescription>
                  {companyMetaLine(company) ? (
                    <p className="mt-0.5 truncate text-xs tabular-nums text-muted-foreground">
                      {companyMetaLine(company)}
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Button size="sm" onClick={() => onEdit(company)} disabled={!canEdit}>
                  <Pencil />
                  {t('Edit')}
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('Delete company')}
                  title={t('Delete company')}
                  onClick={() => onDelete(company)}
                  disabled={!canEdit}
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 />
                </Button>
              </div>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto">
              {/* Registration */}
              {company.email || company.phone || address || company.atividade || company.notes ? (
                <section className="space-y-2 border-t border-border px-4 py-4 text-sm">
                  <h3 className={SECTION_TITLE}>{copy.registration}</h3>
                  {company.email ? (
                    <a
                      href={`mailto:${company.email}`}
                      className="flex items-center gap-2 rounded-sm text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Mail className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate">{company.email}</span>
                    </a>
                  ) : null}
                  {company.phone ? (
                    <a
                      href={`tel:+55${company.phone}`}
                      className="flex items-center gap-2 rounded-sm tabular-nums text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Phone className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span>{formatPhone(company.phone)}</span>
                    </a>
                  ) : null}
                  {address ? (
                    <p className="flex items-start gap-2 text-foreground">
                      <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span>{address}</span>
                    </p>
                  ) : null}
                  {company.atividade ? (
                    <p className="flex items-start gap-2 text-foreground">
                      <Briefcase className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span>
                        {company.atividade}
                        {company.cnae ? (
                          <span className="ml-1 text-xs tabular-nums text-muted-foreground">· CNAE {company.cnae}</span>
                        ) : null}
                      </span>
                    </p>
                  ) : null}
                  {company.notes ? (
                    <div className="mt-1 border-l-2 border-amber-500/60 pl-3">
                      <p className="sr-only">{NOTES_LABEL[language]}</p>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{company.notes}</p>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {/* Contacts */}
              <section className="border-t border-border px-4 py-4">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <h3 className={SECTION_TITLE}>
                    {t('Contacts')}
                    {contacts.length > 0 ? <span className="ml-1.5 tabular-nums">{contacts.length}</span> : null}
                  </h3>
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => setLinking((v) => !v)}
                      aria-expanded={linking}
                      className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Plus className="size-3.5" aria-hidden />
                      {t('Link contact')}
                    </button>
                  ) : null}
                </div>
                {linking ? (
                  <div className="my-2">
                    <SearchPicker<CompanyContactLink['contact']>
                      search={(term) => searchContactsForCompany(createClient(), term)}
                      getKey={(c) => c.id}
                      excludeKeys={linkedIds}
                      renderItem={(c) => (
                        <span className="block min-w-0">
                          <span className="block truncate font-medium">{c.name || c.phone}</span>
                          <span className="block truncate text-[11px] tabular-nums text-muted-foreground">{c.phone}</span>
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
                  <p className="pt-1 text-xs text-muted-foreground">{t('No contacts linked to this company yet')}</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {contacts.map((l) => (
                      <li key={l.contact.id} className="group/link flex items-center gap-2 py-2">
                        <Link
                          href={`/contacts?contact=${l.contact.id}`}
                          className="min-w-0 flex-1 rounded-sm hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="block truncate text-sm font-medium">{l.contact.name || l.contact.phone}</span>
                          <span className="block truncate text-xs tabular-nums text-muted-foreground">
                            {l.contact.phone}
                          </span>
                        </Link>
                        {l.is_primary ? (
                          <span
                            className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
                            title={t("This is the contact's primary company")}
                          >
                            <Star className="size-3 text-primary" aria-hidden />
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
              <section className="border-t border-border px-4 py-4">
                <h3 className={cn(SECTION_TITLE, 'mb-1')}>
                  {t('Deals')}
                  {deals.length > 0 ? <span className="ml-1.5 tabular-nums">{deals.length}</span> : null}
                </h3>
                {deals.length === 0 ? (
                  <p className="pt-1 text-xs text-muted-foreground">{t('No deals linked to this company yet')}</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {deals.map((d) => (
                      <li key={d.id}>
                        <Link
                          href={`/pipelines?deal=${d.id}`}
                          className="-mx-2 block rounded-md px-2 py-2 transition-colors duration-150 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                        >
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-sm font-medium text-foreground">{d.title}</span>
                            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                              {formatCurrency(d.value, d.currency ?? undefined)}
                            </span>
                          </span>
                          <span className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                            {d.stage ? (
                              <span className="inline-flex min-w-0 items-center gap-1.5">
                                <span
                                  aria-hidden
                                  className="size-1.5 shrink-0 rounded-full"
                                  style={{ backgroundColor: d.stage.color }}
                                />
                                <span className="truncate">{d.stage.name}</span>
                              </span>
                            ) : null}
                            {d.status && d.status !== 'open' ? (
                              <span className="inline-flex items-center gap-1.5">
                                <span
                                  aria-hidden
                                  className={cn('size-1.5 rounded-full', d.status === 'won' ? 'bg-emerald-500' : 'bg-red-500')}
                                />
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
