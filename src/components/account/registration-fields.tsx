'use client';

import { useEffect, useRef } from 'react';
import { AlertCircle, Building2, CheckCircle2, Loader2, User } from 'lucide-react';

import { useLanguage } from '@/hooks/use-language';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  CNPJ_LENGTH,
  CPF_LENGTH,
  formatTaxId,
  isValidCnpj,
  isValidCpf,
  normalizeTaxId,
  type PersonType,
  type RegistrationErrorCode,
  type RegistrationErrors,
  type RegistrationField,
} from '@/lib/br/documents';
import type { CompanyLookup } from '@/lib/br/lookup';
import { useCnpjLookup, type LookupStatus } from './use-lookup';

/**
 * Pessoa física / pessoa jurídica registration — the pieces shared by
 * the signup page and Settings → Empresa: the type toggle, the
 * document + legal / trade name inputs, and the error copy for the
 * codes `validateAccountRegistration` returns.
 *
 * Copy goes through `t()` with English keys (pt-BR in i18n-extra) so
 * both surfaces read the same in either language.
 */

export function registrationErrorMessage(
  field: RegistrationField,
  code: RegistrationErrorCode,
  personType: PersonType,
): string {
  const doc = personType === 'pj' ? 'CNPJ' : 'CPF';
  if (code === 'too_long') return 'Use at most 80 characters';
  switch (field) {
    case 'taxId':
      return code === 'required' ? `Enter the ${doc}` : `Invalid ${doc}`;
    case 'legalName':
      return 'Enter the legal name';
    case 'fullName':
      return 'Enter your full name';
    case 'tradeName':
      return 'Invalid trade name';
    default:
      return 'Choose pessoa física or pessoa jurídica';
  }
}

const OPTIONS: { value: PersonType; label: string; hint: string; icon: typeof User }[] = [
  { value: 'pf', label: 'Pessoa física', hint: 'Individual — signs up with a CPF', icon: User },
  { value: 'pj', label: 'Pessoa jurídica', hint: 'Company — signs up with a CNPJ', icon: Building2 },
];

export function PersonTypeToggle({
  value,
  onChange,
  disabled,
}: {
  value: PersonType;
  onChange: (next: PersonType) => void;
  disabled?: boolean;
}) {
  const { t } = useLanguage();
  return (
    <div role="radiogroup" aria-label={t('Account type')} className="grid grid-cols-2 gap-3">
      {OPTIONS.map(({ value: v, label, hint, icon: Icon }) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(v)}
            className={cn(
              'flex items-start gap-3 rounded-xl border p-3 text-left transition-colors disabled:opacity-50',
              active
                ? 'border-primary bg-primary/10'
                : 'border-border bg-muted/40 hover:border-primary/50',
            )}
          >
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-lg',
                active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
              )}
            >
              <Icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground">{t(label)}</span>
              <span className="block text-xs text-muted-foreground">{t(hint)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export interface RegistrationFieldValues {
  taxId: string;
  legalName: string;
  tradeName: string;
}

export function RegistrationFields({
  personType,
  values,
  errors,
  onChange,
  disabled,
  inputClassName,
  /** Signup shows the trade name (it becomes the account name); Settings edits the account name separately. */
  showTradeName = true,
  /** Called with the Receita Federal record once a valid CNPJ is looked up (address, phone, e-mail…). */
  onCompany,
}: {
  personType: PersonType;
  values: RegistrationFieldValues;
  errors: RegistrationErrors;
  onChange: (patch: Partial<RegistrationFieldValues>) => void;
  disabled?: boolean;
  inputClassName?: string;
  showTradeName?: boolean;
  onCompany?: (company: CompanyLookup) => void;
}) {
  const { t } = useLanguage();
  const isPj = personType === 'pj';
  const { state: cnpjState, lookup, reset } = useCnpjLookup();
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const onCompanyRef = useRef(onCompany);
  onCompanyRef.current = onCompany;
  // The document the field mounted with (Settings loads a saved CNPJ):
  // never look that one up — it would overwrite hand-edited data.
  const initialTaxIdRef = useRef(normalizeTaxId(values.taxId));

  // Look the CNPJ up as soon as it is complete and its check digits pass;
  // razão social / nome fantasia come from the Receita and stay editable.
  const cnpjDigits = isPj ? normalizeTaxId(values.taxId) : '';
  useEffect(() => {
    if (
      !isPj ||
      cnpjDigits.length !== CNPJ_LENGTH ||
      !isValidCnpj(cnpjDigits) ||
      cnpjDigits === initialTaxIdRef.current
    ) {
      reset();
      return;
    }
    if (cnpjState.key === cnpjDigits && cnpjState.status !== 'idle') return;
    void lookup(cnpjDigits).then((company) => {
      if (!company) return;
      // A new CNPJ is a new company: everything the Receita defines is
      // replaced, including clearing a fantasia it does not have.
      onChange({ legalName: company.legalName, tradeName: company.tradeName });
      onCompanyRef.current?.(company);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPj, cnpjDigits]);

  const hint = isPj && cnpjState.key === cnpjDigits ? cnpjHint(cnpjState.status, cnpjState.data) : null;

  // Live check-digit feedback once the document is complete, before submit.
  const docDigits = normalizeTaxId(values.taxId);
  const docComplete = docDigits.length === (isPj ? CNPJ_LENGTH : CPF_LENGTH);
  const liveInvalid = docComplete && !(isPj ? isValidCnpj(docDigits) : isValidCpf(docDigits));
  const docLabel = isPj ? 'CNPJ' : 'CPF';
  const docMaxLen = isPj ? CNPJ_LENGTH + 4 : CPF_LENGTH + 3; // masked length

  const fieldError = (field: RegistrationField) =>
    errors[field] ? t(registrationErrorMessage(field, errors[field]!, personType)) : null;

  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="tax-id" className="text-muted-foreground">
          {docLabel}
        </Label>
        <div className="relative">
          <Input
            id="tax-id"
            inputMode={isPj ? 'text' : 'numeric'}
            autoComplete="off"
            value={formatTaxId(personType, values.taxId)}
            onChange={(e) => onChange({ taxId: formatTaxId(personType, e.target.value) })}
            placeholder={isPj ? '00.000.000/0000-00' : '000.000.000-00'}
            maxLength={docMaxLen}
            disabled={disabled}
            aria-invalid={!!errors.taxId || liveInvalid}
            aria-busy={hint?.tone === 'muted'}
            className={cn(inputClassName, isPj && 'pr-8')}
          />
          {isPj ? (
            <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center">
              {hint?.tone === 'muted' ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
              {hint?.tone === 'ok' ? <CheckCircle2 className="size-4 text-emerald-500" /> : null}
              {hint?.tone === 'warn' ? <AlertCircle className="size-4 text-amber-500" /> : null}
            </span>
          ) : null}
        </div>
        <FieldError
          message={fieldError('taxId') ?? (liveInvalid ? t(registrationErrorMessage('taxId', 'invalid', personType)) : null)}
        />
        {hint && !errors.taxId && !liveInvalid ? (
          <p
            role="status"
            className={cn(
              'text-xs',
              hint.tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
              hint.tone === 'warn' && 'text-amber-600 dark:text-amber-400',
              hint.tone === 'muted' && 'text-muted-foreground',
            )}
          >
            {t(hint.text)}
          </p>
        ) : null}
      </div>

      {isPj ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="legal-name" className="text-muted-foreground">
            {t('Legal name (razão social)')}
          </Label>
          <Input
            id="legal-name"
            value={values.legalName}
            onChange={(e) => onChange({ legalName: e.target.value })}
            placeholder="Padaria Sol Ltda"
            autoComplete="organization"
            maxLength={80}
            disabled={disabled}
            aria-invalid={!!errors.legalName}
            className={inputClassName}
          />
          <FieldError message={fieldError('legalName')} />
        </div>
      ) : null}

      {isPj && showTradeName ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="trade-name" className="text-muted-foreground">
            {t('Trade name (nome fantasia)')}{' '}
            <span className="text-xs">— {t('optional')}</span>
          </Label>
          <Input
            id="trade-name"
            value={values.tradeName}
            onChange={(e) => onChange({ tradeName: e.target.value })}
            placeholder="Padaria do Sol"
            maxLength={80}
            disabled={disabled}
            aria-invalid={!!errors.tradeName}
            className={inputClassName}
          />
          <FieldError message={fieldError('tradeName')} />
        </div>
      ) : null}

    </>
  );
}

function cnpjHint(
  status: LookupStatus,
  company: CompanyLookup | null,
): { text: string; tone: 'muted' | 'ok' | 'warn' } | null {
  switch (status) {
    case 'loading':
      return { text: 'Looking the CNPJ up at the Receita Federal…', tone: 'muted' };
    case 'found':
      return company && company.status && company.status !== 'ATIVA'
        ? { text: 'Company found, but its registration is not active at the Receita Federal — check the data', tone: 'warn' }
        : { text: 'Company data filled in from the Receita Federal — check it before continuing', tone: 'ok' };
    case 'not_found':
      return { text: 'CNPJ not found at the Receita Federal — fill in the company data by hand', tone: 'warn' };
    case 'error':
      return { text: 'Could not reach the Receita Federal — fill in the company data by hand', tone: 'warn' };
    default:
      return null;
  }
}

export function FieldError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}
