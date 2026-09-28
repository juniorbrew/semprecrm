'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';

import { AddressFields, ContactFields } from '@/components/account/contact-fields';
import { FieldError } from '@/components/account/registration-fields';
import { NOTES_LABEL } from '@/components/contacts/notes-label';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { formatTaxId, isValidCnpj, normalizeTaxId } from '@/lib/br/documents';
import type { CompanyLookup, ContactErrors } from '@/lib/br/lookup';
import {
  applyCnpjLookup,
  companyDisplayName,
  companyErrorMessage,
  companyFieldErrorMessage,
  companyToForm,
  createCompany,
  emptyCompanyForm,
  findCompanyByCnpj,
  MAX_ACTIVITY_LEN,
  MAX_COMPANY_NAME_LEN,
  MAX_NOTES_LEN,
  updateCompany,
  validateCompanyForm,
  type Company,
  type CompanyField,
  type CompanyFieldErrors,
  type CompanyFormValues,
  type CompanySummary,
} from '@/lib/companies';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

type LookupStatus = 'idle' | 'loading' | 'found' | 'not_found' | 'error' | 'rate_limited' | 'timeout';

const ADDRESS_LABEL = { street: 'Street', complement: 'Complement', neighborhood: 'Neighbourhood', city: 'City' } as const;

/** The server may walk three CNPJ sources; past this the user types. */
const LOOKUP_TIMEOUT_MS = 20_000;

interface CompanyFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing company → edit; null → create. */
  company?: Company | null;
  onSaved: (company: Company) => void;
  /** "Open" on the duplicate-CNPJ warning. Hidden when not given. */
  onOpenExisting?: (companyId: string) => void;
  /** Label of that action — "Abrir empresa" by default. */
  openExistingLabel?: string;
}

/**
 * Create / edit a customer company. "Buscar dados" fills the form from
 * the CNPJ (BrasilAPI → CNPJ.ws → ReceitaWS via
 * /api/companies/lookup) and warns when the account already has that
 * CNPJ; typing a CEP fills street / bairro / cidade / UF and moves the
 * cursor to the number (AddressFields, shared with Settings → Empresa).
 */
export function CompanyFormDialog({
  open,
  onOpenChange,
  company,
  onSaved,
  onOpenExisting,
  openExistingLabel,
}: CompanyFormDialogProps) {
  const { t } = useLanguage();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto border-border bg-popover text-popover-foreground sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {company ? t('Edit company') : t('New company')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('Type the CNPJ and click "Fetch data" to fill in the rest from the Receita Federal.')}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <CompanyFormBody
            key={company?.id ?? 'new'}
            company={company ?? null}
            onCancel={() => onOpenChange(false)}
            onSaved={(saved) => {
              onOpenChange(false);
              onSaved(saved);
            }}
            openExistingLabel={openExistingLabel}
            onOpenExisting={
              onOpenExisting
                ? (id) => {
                    onOpenChange(false);
                    onOpenExisting(id);
                  }
                : undefined
            }
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function lookupHint(
  status: LookupStatus,
  found: CompanyLookup | null,
): { text: string; suffix?: string; tone: 'muted' | 'ok' | 'warn' } | null {
  switch (status) {
    case 'loading':
      return { text: 'Looking up the CNPJ…', tone: 'muted' };
    case 'found':
      return found?.status && found.status !== 'ATIVA'
        ? { text: 'Data filled in — registration status:', suffix: found.status, tone: 'warn' }
        : { text: 'Data filled in — check before saving', tone: 'ok' };
    case 'not_found':
      return { text: 'CNPJ not found in the public sources — fill in by hand', tone: 'warn' };
    case 'rate_limited':
      return { text: 'Too many lookups — wait a minute and try again', tone: 'warn' };
    case 'error':
      return { text: 'Could not reach the CNPJ services — fill in by hand', tone: 'warn' };
    case 'timeout':
      return { text: 'The CNPJ lookup took too long — try again or fill in by hand', tone: 'warn' };
    default:
      return null;
  }
}

export function CompanyFormBody({
  company,
  onSaved,
  onCancel,
  onOpenExisting,
  openExistingLabel,
}: {
  company: Company | null;
  onSaved: (company: Company) => void;
  onCancel: () => void;
  onOpenExisting?: (companyId: string) => void;
  openExistingLabel?: string;
}) {
  const { t, language } = useLanguage();
  const { accountId, user } = useAuth();
  const [values, setValues] = useState<CompanyFormValues>(() => (company ? companyToForm(company) : emptyCompanyForm()));
  const [errors, setErrors] = useState<CompanyFieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [lookupStatus, setLookupStatus] = useState<LookupStatus>('idle');
  const [lookupFound, setLookupFound] = useState<CompanyLookup | null>(null);
  const [duplicate, setDuplicate] = useState<CompanySummary | null>(null);
  const lookupAbort = useRef<AbortController | null>(null);

  const cnpjDigits = normalizeTaxId(values.cnpj);
  const cnpjComplete = cnpjDigits.length === 14;
  const cnpjValid = cnpjComplete && isValidCnpj(cnpjDigits);

  // Duplicate check while typing: a complete, valid CNPJ is looked up
  // in the account (RLS-scoped) — the company being edited excluded.
  useEffect(() => {
    if (!cnpjValid) {
      setDuplicate(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      findCompanyByCnpj(createClient(), cnpjDigits, { accountId, excludeId: company?.id })
        .then((found) => {
          if (!cancelled) setDuplicate(found);
        })
        .catch(() => {
          /* the unique index still catches it on save */
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cnpjValid, cnpjDigits, accountId, company?.id]);

  useEffect(() => () => lookupAbort.current?.abort(), []);

  function set(patch: Partial<CompanyFormValues>) {
    setValues((v) => ({ ...v, ...patch }));
  }

  async function fetchData() {
    if (!cnpjValid) {
      setErrors((e) => ({ ...e, cnpj: 'invalid' }));
      return;
    }
    lookupAbort.current?.abort();
    const controller = new AbortController();
    lookupAbort.current = controller;
    setLookupStatus('loading');
    setLookupFound(null);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, LOOKUP_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/companies/lookup/${encodeURIComponent(cnpjDigits)}`, {
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; company?: CompanyLookup; existing?: CompanySummary | null }
        | null;
      if (controller.signal.aborted) {
        if (timedOut) setLookupStatus('timeout');
        return;
      }
      const existing = json?.existing ?? null;
      if (existing && existing.id !== company?.id) setDuplicate(existing);
      if (res.ok && json?.company) {
        setValues((v) => applyCnpjLookup(v, json.company!));
        setErrors({});
        setLookupFound(json.company);
        setLookupStatus('found');
      } else if (res.status === 404 || res.status === 422) {
        setLookupStatus('not_found');
      } else if (res.status === 429) {
        setLookupStatus('rate_limited');
      } else {
        setLookupStatus('error');
      }
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        if (timedOut) setLookupStatus('timeout');
        return;
      }
      setLookupStatus('error');
    } finally {
      clearTimeout(timeout);
    }
  }

  async function save() {
    const checked = validateCompanyForm(values);
    if (!checked.ok) {
      setErrors(checked.errors);
      toast.error(t('Check the highlighted fields'));
      return;
    }
    if (duplicate) {
      toast.error(t('A company with this CNPJ already exists'));
      return;
    }
    if (!accountId) {
      toast.error(t('Your profile is not linked to an account.'));
      return;
    }
    setSaving(true);
    try {
      const supabase = createClient();
      const saved = company
        ? await updateCompany(supabase, company.id, checked.value)
        : await createCompany(supabase, { accountId, userId: user?.id ?? null }, checked.value);
      toast.success(company ? t('Company updated') : t('Company created'));
      onSaved(saved);
    } catch (err) {
      toast.error(t(companyErrorMessage(err)));
      if (checked.value.cnpj) {
        // A duplicate that slipped past the debounce: show who it is.
        findCompanyByCnpj(createClient(), checked.value.cnpj, { accountId, excludeId: company?.id })
          .then(setDuplicate)
          .catch(() => {});
      }
    } finally {
      setSaving(false);
    }
  }

  const err = (field: CompanyField) => {
    const code = errors[field];
    return code ? t(companyFieldErrorMessage(field, code)) : null;
  };
  const hint = lookupHint(lookupStatus, lookupFound);
  const contactErrors = errors as ContactErrors;

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {/* CNPJ + lookup */}
      <div className="space-y-2">
        <Label htmlFor="company-cnpj" className="text-muted-foreground">
          CNPJ <span className="text-xs">— {t('optional')}</span>
        </Label>
        <div className="flex gap-2">
          <Input
            id="company-cnpj"
            value={values.cnpj}
            onChange={(e) => {
              set({ cnpj: formatTaxId('pj', e.target.value) });
              setLookupStatus('idle');
              if (errors.cnpj) {
                setErrors((prev) => {
                  const next = { ...prev };
                  delete next.cnpj;
                  return next;
                });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void fetchData();
              }
            }}
            placeholder="00.000.000/0000-00"
            maxLength={18}
            autoComplete="off"
            aria-invalid={!!errors.cnpj || (cnpjComplete && !cnpjValid)}
            className="border-border bg-muted font-mono text-foreground"
            autoFocus={!company}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => void fetchData()}
            disabled={!cnpjValid || lookupStatus === 'loading'}
            className="shrink-0 border-border"
          >
            {lookupStatus === 'loading' ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            {t('Fetch data')}
          </Button>
        </div>
        <FieldError message={err('cnpj') ?? (cnpjComplete && !cnpjValid ? t('Invalid CNPJ') : null)} />
        {hint ? (
          <p
            role="status"
            className={cn(
              'flex items-center gap-1.5 text-xs',
              hint.tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
              hint.tone === 'warn' && 'text-amber-600 dark:text-amber-400',
              hint.tone === 'muted' && 'text-muted-foreground',
            )}
          >
            {hint.tone === 'ok' ? <CheckCircle2 className="size-3.5" /> : null}
            {t(hint.text)}
            {hint.suffix ? <strong className="font-semibold">{hint.suffix}</strong> : null}
          </p>
        ) : null}
        {duplicate ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          >
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              {t('This CNPJ is already registered in this account:')}{' '}
              <strong className="font-semibold">{companyDisplayName(duplicate)}</strong>
            </span>
            {onOpenExisting ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => onOpenExisting(duplicate.id)}
                className="border-amber-500/40 bg-transparent"
              >
                {openExistingLabel ?? t('Open company')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Names */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="company-razao" className="text-muted-foreground">
            {t('Legal name')} <span className="text-red-400">*</span>
          </Label>
          <Input
            id="company-razao"
            value={values.razao_social}
            onChange={(e) => set({ razao_social: e.target.value })}
            maxLength={MAX_COMPANY_NAME_LEN}
            aria-invalid={!!errors.razao_social}
            className="border-border bg-muted text-foreground"
          />
          <FieldError message={err('razao_social')} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="company-fantasia" className="text-muted-foreground">
            {t('Trade name')} <span className="text-xs">— {t('optional')}</span>
          </Label>
          <Input
            id="company-fantasia"
            value={values.nome_fantasia}
            onChange={(e) => set({ nome_fantasia: e.target.value })}
            maxLength={MAX_COMPANY_NAME_LEN}
            aria-invalid={!!errors.nome_fantasia}
            className="border-border bg-muted text-foreground"
          />
          <FieldError message={err('nome_fantasia')} />
        </div>
      </div>

      <ContactFields
        values={values}
        errors={contactErrors}
        onChange={(patch) => set(patch)}
        inputClassName="border-border bg-muted text-foreground"
      />

      <div className="flex flex-col gap-2">
        <Label htmlFor="company-atividade" className="text-muted-foreground">
          {t('Main activity')}
          {values.cnae ? <span className="ml-1 font-mono text-xs">(CNAE {values.cnae})</span> : null}
        </Label>
        <Input
          id="company-atividade"
          value={values.atividade}
          onChange={(e) => set({ atividade: e.target.value })}
          maxLength={MAX_ACTIVITY_LEN}
          aria-invalid={!!errors.atividade}
          className="border-border bg-muted text-foreground"
        />
        <FieldError message={err('atividade')} />
      </div>

      <AddressFields
        address={values.address}
        errors={contactErrors}
        onChange={(address) => set({ address })}
        inputClassName="border-border bg-muted text-foreground"
      />
      {/* AddressFields only flags CEP and UF; say what else is wrong. */}
      <FieldError
        message={
          errors.number
            ? `${t('Number')}: ${t(companyFieldErrorMessage('number', errors.number))} (${t('max. 20 characters')})`
            : (['street', 'complement', 'neighborhood', 'city'] as const)
                .filter((f) => errors[f])
                .map((f) => `${t(ADDRESS_LABEL[f])}: ${t(companyFieldErrorMessage(f, errors[f]!))}`)
                .join(' · ') || null
        }
      />

      <div className="flex flex-col gap-2">
        <Label htmlFor="company-notes" className="text-muted-foreground" data-no-translate>
          {NOTES_LABEL[language]}
        </Label>
        <Textarea
          id="company-notes"
          value={values.notes}
          onChange={(e) => set({ notes: e.target.value })}
          maxLength={MAX_NOTES_LEN}
          className="min-h-[80px] border-border bg-muted text-foreground"
        />
        <FieldError message={err('notes')} />
      </div>

      <DialogFooter className="border-border bg-popover">
        <Button type="button" variant="outline" onClick={onCancel} className="border-border text-muted-foreground hover:bg-muted">
          {t('Cancel')}
        </Button>
        <Button type="submit" disabled={saving || !!duplicate} className="bg-primary text-primary-foreground hover:bg-primary/90">
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {company ? t('Save changes') : t('Create company')}
        </Button>
      </DialogFooter>
    </form>
  );
}
