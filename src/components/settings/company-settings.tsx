'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Building2, Check, Loader2 } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  FieldError,
  PersonTypeToggle,
  RegistrationFields,
  type RegistrationFieldValues,
} from '@/components/account/registration-fields';
import {
  formatTaxId,
  MAX_NAME_LEN,
  validateAccountDocument,
  type PersonType,
  type RegistrationErrors,
} from '@/lib/br/documents';
import { SettingsPanelHead } from './settings-panel-head';

/** Wire keys from PATCH /api/account → field names used by the shared inputs. */
const WIRE_TO_FIELD: Record<string, keyof RegistrationErrors> = {
  person_type: 'personType',
  tax_id: 'taxId',
  legal_name: 'legalName',
};

/**
 * Settings → Empresa: the account's registration — pessoa física
 * (CPF) or pessoa jurídica (CNPJ + razão social) — and the name shown
 * across the app. Admin+. Saves through PATCH /api/account (audited).
 */
export function CompanySettings() {
  const { t } = useLanguage();
  const { account, canManageMembers, profileLoading, refreshAccount } = useAuth();

  const [personType, setPersonType] = useState<PersonType>('pf');
  const [name, setName] = useState('');
  const [values, setValues] = useState<RegistrationFieldValues>({ taxId: '', legalName: '', tradeName: '' });
  const [errors, setErrors] = useState<RegistrationErrors>({});
  const [saving, setSaving] = useState(false);

  // Seed from the account row (and re-seed after a successful save).
  useEffect(() => {
    if (!account) return;
    const type: PersonType = account.person_type === 'pj' ? 'pj' : 'pf';
    setPersonType(type);
    setName(account.name);
    setValues({
      taxId: account.tax_id ? formatTaxId(type, account.tax_id) : '',
      legalName: account.legal_name ?? '',
      tradeName: '',
    });
    setErrors({});
  }, [account]);

  const trimmedName = name.trim();
  const nameError =
    trimmedName.length === 0
      ? t('Enter the account name')
      : trimmedName.length > MAX_NAME_LEN
        ? t('Use at most 80 characters')
        : null;

  const savedTaxId = account?.tax_id ? formatTaxId(personType, account.tax_id) : '';
  const dirty =
    !!account &&
    (personType !== (account.person_type ?? 'pf') ||
      trimmedName !== account.name ||
      formatTaxId(personType, values.taxId) !== savedTaxId ||
      (personType === 'pj' && values.legalName.trim() !== (account.legal_name ?? '')));

  async function save() {
    if (!account || nameError) return;
    const doc = validateAccountDocument({ personType, taxId: values.taxId, legalName: values.legalName });
    if (!doc.ok) {
      setErrors(doc.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const res = await fetch('/api/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          person_type: doc.value.personType,
          tax_id: doc.value.taxId,
          legal_name: doc.value.legalName ?? '',
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string; errors?: Record<string, string> }
          | null;
        if (payload?.errors) {
          const mapped: RegistrationErrors = {};
          for (const [wire, code] of Object.entries(payload.errors)) {
            const field = WIRE_TO_FIELD[wire];
            if (field) mapped[field] = code as RegistrationErrors[keyof RegistrationErrors];
          }
          setErrors(mapped);
          return;
        }
        throw new Error(payload?.error ?? `HTTP ${res.status}`);
      }
      await refreshAccount();
      toast.success(t('Company registration saved'));
    } catch (err) {
      console.error('[company] save failed:', err);
      toast.error(t('Could not save the company registration'));
    } finally {
      setSaving(false);
    }
  }

  const title = t('Company');
  const description = t(
    'Who this account belongs to: a person (CPF) or a company (CNPJ). Every member works inside this registration.',
  );

  if (profileLoading || !account) {
    return (
      <section className="max-w-4xl animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={title} />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/60" />
          ))}
        </div>
      </section>
    );
  }

  if (!canManageMembers) {
    return (
      <section className="max-w-4xl animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={title} description={description} />
        <Alert className="border-border bg-card">
          <AlertTitle className="mb-1 text-foreground">{t('Admins only')}</AlertTitle>
          <AlertDescription className="text-sm text-muted-foreground">
            {t('Only account admins can change the company registration.')}
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  const disabled = saving;

  return (
    <section className="max-w-4xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={title}
        description={description}
        action={
          <Button
            size="sm"
            disabled={disabled || !dirty || !!nameError}
            onClick={save}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            {t('Save')}
          </Button>
        }
      />

      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
          <Building2 className="size-4 text-muted-foreground" />
          {t('Account type')}
        </h3>
        <div className="max-w-md">
          <PersonTypeToggle
            value={personType}
            onChange={(next) => {
              setPersonType(next);
              setValues((prev) => ({ ...prev, taxId: '' }));
              setErrors({});
            }}
            disabled={disabled}
          />
        </div>

        <div className="mt-6 grid max-w-md gap-4">
          <RegistrationFields
            personType={personType}
            values={values}
            errors={errors}
            onChange={(patch) => setValues((prev) => ({ ...prev, ...patch }))}
            disabled={disabled}
            showTradeName={false}
          />

          <div className="flex flex-col gap-2">
            <Label htmlFor="account-name" className="text-muted-foreground">
              {personType === 'pj' ? t('Display name (nome fantasia)') : t('Account name')}
            </Label>
            <Input
              id="account-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_NAME_LEN}
              disabled={disabled}
              aria-invalid={!!nameError && name.length > 0}
            />
            <p className="text-xs text-muted-foreground">
              {t('Shown in the sidebar, invitations and reports for every member.')}
            </p>
            <FieldError message={name.length > 0 ? nameError : null} />
          </div>
        </div>
      </div>
    </section>
  );
}
