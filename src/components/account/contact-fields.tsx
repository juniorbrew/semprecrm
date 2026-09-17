'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, AlertCircle } from 'lucide-react';

import { useLanguage } from '@/hooks/use-language';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  CEP_LENGTH,
  EMPTY_ADDRESS,
  formatCep,
  formatPhone,
  isValidCep,
  normalizeCep,
  UF_LIST,
  type AccountAddress,
  type ContactErrors,
} from '@/lib/br/lookup';
import { FieldError } from './registration-fields';
import { useCepLookup, type LookupStatus } from './use-lookup';

/**
 * Contact block shared by signup and Settings → Empresa: phone and
 * e-mail, then the address with CEP lookup. Typing a full CEP fetches
 * street / neighbourhood / city / UF from /api/lookup/cep and moves
 * focus to the number field; the user keeps every field editable.
 */

export interface ContactFormValues {
  phone: string;
  email: string;
  address: AccountAddress;
}

export const EMPTY_CONTACT: ContactFormValues = { phone: '', email: '', address: { ...EMPTY_ADDRESS } };

export function contactErrorMessage(field: keyof ContactErrors, code: 'invalid' | 'too_long'): string {
  if (code === 'too_long') return 'Use at most 120 characters';
  switch (field) {
    case 'phone':
      return 'Invalid phone number';
    case 'email':
      return 'Invalid e-mail';
    case 'cep':
      return 'Invalid CEP';
    case 'state':
      return 'Choose a state';
    default:
      return 'Invalid value';
  }
}

const UF_ITEMS = Object.fromEntries(UF_LIST.map((uf) => [uf, uf])) as Record<string, string>;

export function ContactFields({
  values,
  errors,
  onChange,
  disabled,
  inputClassName,
  emailLabel = 'Company e-mail',
}: {
  values: Pick<ContactFormValues, 'phone' | 'email'>;
  errors: ContactErrors;
  onChange: (patch: Partial<Pick<ContactFormValues, 'phone' | 'email'>>) => void;
  disabled?: boolean;
  inputClassName?: string;
  emailLabel?: string;
}) {
  const { t } = useLanguage();
  return (
    <div className="@container grid grid-cols-1 gap-4 @sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <Label htmlFor="contact-phone" className="text-muted-foreground">
          {t('Phone')}
        </Label>
        <Input
          id="contact-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          value={formatPhone(values.phone)}
          onChange={(e) => onChange({ phone: formatPhone(e.target.value) })}
          placeholder="(11) 99999-9999"
          maxLength={15}
          disabled={disabled}
          aria-invalid={!!errors.phone}
          className={inputClassName}
        />
        <FieldError message={errors.phone ? t(contactErrorMessage('phone', errors.phone)) : null} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="contact-email" className="text-muted-foreground">
          {t(emailLabel)}
        </Label>
        <Input
          id="contact-email"
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={(e) => onChange({ email: e.target.value })}
          placeholder="contato@empresa.com.br"
          maxLength={120}
          disabled={disabled}
          aria-invalid={!!errors.email}
          className={inputClassName}
        />
        <FieldError message={errors.email ? t(contactErrorMessage('email', errors.email)) : null} />
      </div>
    </div>
  );
}

function cepHint(status: LookupStatus): { text: string; tone: 'muted' | 'ok' | 'warn' } | null {
  switch (status) {
    case 'loading':
      return { text: 'Looking up the CEP…', tone: 'muted' };
    case 'found':
      return { text: 'Address found — add the number and check the rest', tone: 'ok' };
    case 'not_found':
      return { text: 'CEP not found — fill in the address by hand', tone: 'warn' };
    case 'error':
      return { text: 'Could not reach the CEP service — fill in the address by hand', tone: 'warn' };
    default:
      return null;
  }
}

export function AddressFields({
  address,
  errors,
  onChange,
  disabled,
  inputClassName,
}: {
  address: AccountAddress;
  errors: ContactErrors;
  onChange: (next: AccountAddress) => void;
  disabled?: boolean;
  inputClassName?: string;
}) {
  const { t } = useLanguage();
  const { state: cepState, lookup, reset } = useCepLookup();
  const numberRef = useRef<HTMLInputElement>(null);
  // Latest address for the async fill, without re-creating the effect.
  const addressRef = useRef(address);
  addressRef.current = address;
  // The CEP the field mounted with (Settings loads a saved address) is
  // never looked up — it would overwrite hand-edited street/city.
  const initialCepRef = useRef(normalizeCep(address.cep));
  // The CEP that produced the current street/city — from our own lookup
  // or from an address that arrived whole (CNPJ). A different 8-digit
  // CEP always triggers a fresh lookup, even over a filled address.
  const filledFromCepRef = useRef(normalizeCep(address.cep));
  const prevAddressRef = useRef(address);
  const streetRef = useRef<HTMLInputElement>(null);
  const [incomplete, setIncomplete] = useState(false);

  const cepDigits = normalizeCep(address.cep);

  // An update that changes the CEP *and* the street/city in one go came
  // from outside (CNPJ lookup, reset) — treat it as already filled.
  const prev = prevAddressRef.current;
  if (prev !== address) {
    const cepChanged = normalizeCep(prev.cep) !== cepDigits;
    const bodyChanged =
      prev.street !== address.street ||
      prev.city !== address.city ||
      prev.neighborhood !== address.neighborhood ||
      prev.state !== address.state;
    if (cepChanged && bodyChanged) filledFromCepRef.current = cepDigits;
    prevAddressRef.current = address;
  }

  // Fire the lookup once per complete, plausible CEP; anything shorter
  // resets so a stale "found" never lingers under a half-typed value.
  useEffect(() => {
    if (cepDigits.length === CEP_LENGTH) setIncomplete(false);
    if (cepDigits.length !== CEP_LENGTH || !isValidCep(cepDigits) || cepDigits === initialCepRef.current) {
      reset();
      return;
    }
    if (cepState.key === cepDigits && cepState.status !== 'idle') return;
    // Same CEP that produced the current address — nothing to fetch.
    if (cepDigits === filledFromCepRef.current) return;
    void lookup(cepDigits).then((found) => {
      if (!found) {
        // Not found / unreachable: hand the user the street field.
        if (normalizeCep(addressRef.current.cep) === cepDigits) setTimeout(() => streetRef.current?.focus(), 0);
        return;
      }
      if (normalizeCep(addressRef.current.cep) !== cepDigits) return; // user moved on
      filledFromCepRef.current = cepDigits;
      // Replace what the CEP defines; keep número / complemento.
      onChange({
        ...addressRef.current,
        cep: cepDigits,
        street: found.street,
        neighborhood: found.neighborhood,
        city: found.city,
        state: found.state,
      });
      setTimeout(() => numberRef.current?.focus(), 0);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cepDigits]);

  const hint = cepState.key === cepDigits ? cepHint(cepState.status) : null;
  const set = (patch: Partial<AccountAddress>) => onChange({ ...address, ...patch });

  return (
    <div className="@container grid grid-cols-2 gap-4 @md:grid-cols-6">
      <div className="flex flex-col gap-2 @md:col-span-2">
        <Label htmlFor="address-cep" className="text-muted-foreground">
          CEP
        </Label>
        <div className="relative">
          <Input
            id="address-cep"
            inputMode="numeric"
            autoComplete="postal-code"
            value={formatCep(address.cep)}
            onChange={(e) => set({ cep: normalizeCep(e.target.value) })}
            placeholder="00000-000"
            maxLength={9}
            disabled={disabled}
            onBlur={() => setIncomplete(cepDigits.length > 0 && cepDigits.length < CEP_LENGTH)}
            aria-invalid={!!errors.cep || incomplete}
            aria-busy={cepState.status === 'loading' && cepState.key === cepDigits}
            className={cn(inputClassName, 'pr-8')}
          />
          <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center">
            {hint?.tone === 'muted' ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
            {hint?.tone === 'ok' ? <CheckCircle2 className="size-4 text-emerald-500" /> : null}
            {hint?.tone === 'warn' ? <AlertCircle className="size-4 text-amber-500" /> : null}
          </span>
        </div>
        <FieldError
          message={
            errors.cep ? t(contactErrorMessage('cep', errors.cep)) : incomplete ? t('Incomplete CEP — 8 digits') : null
          }
        />
      </div>

      <div className="col-span-2 flex flex-col gap-2 @md:col-span-4">
        <Label htmlFor="address-street" className="text-muted-foreground">
          {t('Street')}
        </Label>
        <Input
          id="address-street"
          ref={streetRef}
          autoComplete="address-line1"
          value={address.street}
          onChange={(e) => set({ street: e.target.value })}
          placeholder="Rua, avenida, praça…"
          maxLength={120}
          disabled={disabled}
          aria-invalid={!!errors.street}
          className={inputClassName}
        />
      </div>

      {hint && !errors.cep && !incomplete ? (
        <p
          role="status"
          className={cn(
            'col-span-2 -mt-2 text-xs @md:col-span-6',
            hint.tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
            hint.tone === 'warn' && 'text-amber-600 dark:text-amber-400',
            hint.tone === 'muted' && 'text-muted-foreground',
          )}
        >
          {t(hint.text)}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 @md:col-span-2">
        <Label htmlFor="address-number" className="text-muted-foreground">
          {t('Number')}
        </Label>
        <Input
          id="address-number"
          ref={numberRef}
          inputMode="numeric"
          value={address.number}
          onChange={(e) => set({ number: e.target.value })}
          placeholder="123"
          maxLength={20}
          disabled={disabled}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-2 @md:col-span-4">
        <Label htmlFor="address-complement" className="text-muted-foreground">
          {t('Complement')}
          <span className="ml-1 text-xs whitespace-nowrap">— {t('optional')}</span>
        </Label>
        <Input
          id="address-complement"
          autoComplete="address-line2"
          value={address.complement}
          onChange={(e) => set({ complement: e.target.value })}
          placeholder="Sala, andar, bloco…"
          maxLength={120}
          disabled={disabled}
          className={inputClassName}
        />
      </div>

      <div className="col-span-2 flex flex-col gap-2 @md:col-span-2">
        <Label htmlFor="address-neighborhood" className="text-muted-foreground">
          {t('Neighbourhood')}
        </Label>
        <Input
          id="address-neighborhood"
          value={address.neighborhood}
          onChange={(e) => set({ neighborhood: e.target.value })}
          maxLength={120}
          disabled={disabled}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-2 @md:col-span-3">
        <Label htmlFor="address-city" className="text-muted-foreground">
          {t('City')}
        </Label>
        <Input
          id="address-city"
          autoComplete="address-level2"
          value={address.city}
          onChange={(e) => set({ city: e.target.value })}
          maxLength={120}
          disabled={disabled}
          className={inputClassName}
        />
      </div>

      <div className="flex flex-col gap-2 @md:col-span-1">
        <Label htmlFor="address-state" className="text-muted-foreground">
          UF
        </Label>
        <Select
          value={address.state || null}
          items={UF_ITEMS}
          onValueChange={(val) => set({ state: (val as string | null) ?? '' })}
          disabled={disabled}
        >
          <SelectTrigger
            id="address-state"
            aria-invalid={!!errors.state}
            className={cn('w-full', inputClassName ?? 'border-border bg-muted text-foreground')}
          >
            <SelectValue placeholder="UF" />
          </SelectTrigger>
          <SelectContent className="border-border bg-popover">
            {UF_LIST.map((uf) => (
              <SelectItem key={uf} value={uf}>
                {uf}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError message={errors.state ? t(contactErrorMessage('state', errors.state)) : null} />
      </div>
    </div>
  );
}
