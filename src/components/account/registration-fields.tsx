'use client';

import { Building2, User } from 'lucide-react';

import { useLanguage } from '@/hooks/use-language';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  CNPJ_LENGTH,
  CPF_LENGTH,
  formatTaxId,
  type PersonType,
  type RegistrationErrorCode,
  type RegistrationErrors,
  type RegistrationField,
} from '@/lib/br/documents';

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
}: {
  personType: PersonType;
  values: RegistrationFieldValues;
  errors: RegistrationErrors;
  onChange: (patch: Partial<RegistrationFieldValues>) => void;
  disabled?: boolean;
  inputClassName?: string;
  showTradeName?: boolean;
}) {
  const { t } = useLanguage();
  const isPj = personType === 'pj';
  const docLabel = isPj ? 'CNPJ' : 'CPF';
  const docMaxLen = isPj ? CNPJ_LENGTH + 4 : CPF_LENGTH + 3; // masked length

  const fieldError = (field: RegistrationField) =>
    errors[field] ? t(registrationErrorMessage(field, errors[field]!, personType)) : null;

  return (
    <>
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

      <div className="flex flex-col gap-2">
        <Label htmlFor="tax-id" className="text-muted-foreground">
          {docLabel}
        </Label>
        <Input
          id="tax-id"
          inputMode={isPj ? 'text' : 'numeric'}
          autoComplete="off"
          value={formatTaxId(personType, values.taxId)}
          onChange={(e) => onChange({ taxId: formatTaxId(personType, e.target.value) })}
          placeholder={isPj ? '00.000.000/0000-00' : '000.000.000-00'}
          maxLength={docMaxLen}
          disabled={disabled}
          aria-invalid={!!errors.taxId}
          className={inputClassName}
        />
        <FieldError message={fieldError('taxId')} />
      </div>
    </>
  );
}

export function FieldError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}
