'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { Archive, ArchiveRestore, Loader2, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';

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
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useLanguage } from '@/hooks/use-language';
import { useReadOnly } from '@/hooks/use-read-only';
import { formatMoney } from '@/lib/currency';
import {
  PRODUCT_CODE_MAX,
  PRODUCT_DESCRIPTION_MAX,
  PRODUCT_NAME_MAX,
  toInputNumber,
  validateProductDraft,
  type ProductError,
} from '@/lib/products/calc';
import {
  createProduct,
  listProducts,
  productsErrorMessage,
  setProductArchived,
  updateProduct,
} from '@/lib/products/data';
import type { Product } from '@/lib/products/types';
import { createClient } from '@/lib/supabase/client';

import { SettingsChip } from './settings-chip';
import { SettingsGroup } from './settings-group';
import { SettingsPanelHead } from './settings-panel-head';

const ERROR_FIELD: Record<ProductError, 'name' | 'code' | 'price' | 'description'> = {
  name: 'name',
  'name-max': 'name',
  'code-max': 'code',
  price: 'price',
  'price-max': 'price',
  'description-max': 'description',
};
const ERROR_TEXT: Record<ProductError, string> = {
  name: 'Type the name of the product or service',
  'name-max': 'The name can have at most 80 characters',
  'code-max': 'The code can have at most 40 characters',
  price: 'Type a valid price, like 1.500,00',
  'price-max': 'This price is too high',
  'description-max': 'The description can have at most 300 characters',
};

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: (p: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': error ? `${id}-err` : undefined })}
      {error && (
        <p id={`${id}-err`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function ProductDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: Product | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLanguage();
  const { accountId } = useAuth();
  const [name, setName] = useState(initial?.name ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [price, setPrice] = useState(initial ? toInputNumber(initial.unit_price) : '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [errors, setErrors] = useState<ProductError[]>([]);
  const [busy, setBusy] = useState(false);

  const errorFor = (f: 'name' | 'code' | 'price' | 'description') => {
    const e = errors.find((x) => ERROR_FIELD[x] === f);
    return e ? t(ERROR_TEXT[e]) : undefined;
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const result = validateProductDraft({ name, code, unitPrice: price, description });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    if (!accountId) return;
    setErrors([]);
    setBusy(true);
    try {
      const db = createClient();
      if (initial) await updateProduct(db, initial.id, result.values);
      else await createProduct(db, accountId, result.values);
      toast.success(t(initial ? 'Product updated' : 'Product created'));
      await onSaved();
    } catch (err) {
      toast.error(t(productsErrorMessage(err)));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? t('Edit product or service') : t('New product or service')}</DialogTitle>
          <DialogDescription>
            {t('The price is copied into each deal when you add it, so changing it later does not alter old deals.')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3" noValidate>
          <Field label={t('Product or service name')} error={errorFor('name')}>
            {(a) => <Input {...a} value={name} maxLength={PRODUCT_NAME_MAX + 20} onChange={(e) => setName(e.target.value)} autoFocus />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('Price per unit')} error={errorFor('price')}>
              {(a) => <Input {...a} inputMode="decimal" value={price} placeholder="0,00" onChange={(e) => setPrice(e.target.value)} />}
            </Field>
            <Field label={t('Product code (optional)')} error={errorFor('code')}>
              {(a) => <Input {...a} value={code} maxLength={PRODUCT_CODE_MAX + 20} onChange={(e) => setCode(e.target.value)} />}
            </Field>
          </div>
          <Field label={t('Short description (optional)')} error={errorFor('description')}>
            {(a) => (
              <Textarea
                {...a}
                rows={3}
                value={description}
                maxLength={PRODUCT_DESCRIPTION_MAX + 50}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              {t('Save product')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProductRow({
  product,
  canEdit,
  currency,
  onEdit,
  onToggleArchive,
}: {
  product: Product;
  canEdit: boolean;
  currency: string;
  onEdit: () => void;
  onToggleArchive: () => void;
}) {
  const { t } = useLanguage();
  const archived = !!product.archived_at;
  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground" data-no-translate>
          {product.name}
          {product.code ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">({product.code})</span> : null}
        </p>
        {product.description && (
          <p className="truncate text-xs text-muted-foreground" data-no-translate>
            {product.description}
          </p>
        )}
      </div>
      <p className="shrink-0 text-sm text-foreground">{formatMoney(product.unit_price, currency)}</p>
      {archived && <SettingsChip>{t('Archived')}</SettingsChip>}
      {canEdit && (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${t('Edit product or service')}: ${product.name}`}
            onClick={onEdit}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${archived ? t('Restore product') : t('Archive product')}: ${product.name}`}
            onClick={onToggleArchive}
          >
            {archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
          </Button>
        </>
      )}
    </li>
  );
}

/**
 * Settings -> Produtos: the catalog of products and services (migration 104).
 * Every member reads it; only owners and admins create, edit and archive.
 * Archived products leave the picker in the deal but stay in the old deals.
 */
export function ProductsSettings() {
  const { t } = useLanguage();
  const { defaultCurrency } = useAuth();
  const canEditSettings = useCan('edit-settings');
  const { readOnly } = useReadOnly();
  const canEdit = canEditSettings && !readOnly;

  const [products, setProducts] = useState<Product[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<{ product: Product | null } | null>(null);

  const load = useCallback(async () => {
    try {
      setProducts(await listProducts(createClient(), { includeArchived: true }));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  // First read (state is set from the promise, not synchronously in the effect).
  useEffect(() => {
    let cancelled = false;
    listProducts(createClient(), { includeArchived: true })
      .then((rows) => {
        if (!cancelled) setProducts(rows);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleArchive(p: Product) {
    try {
      await setProductArchived(createClient(), p.id, !p.archived_at);
      toast.success(t(p.archived_at ? 'Product restored' : 'Product archived'));
      await load();
    } catch (err) {
      toast.error(t(productsErrorMessage(err)));
    }
  }

  const active = (products ?? []).filter((p) => !p.archived_at);
  const archived = (products ?? []).filter((p) => p.archived_at);

  return (
    <section className="max-w-2xl">
      <SettingsPanelHead
        title={t('Products and services')}
        description={t('What you sell. Add these to a deal and its value is calculated for you.')}
        action={
          canEdit ? (
            <Button size="sm" onClick={() => setDialog({ product: null })}>
              <Plus className="size-3.5" /> {t('New product or service')}
            </Button>
          ) : undefined
        }
      />
      {!canEdit && (
        <p className="mb-4 text-sm text-muted-foreground">
          {t('Only owners and admins can change the catalog.')}
        </p>
      )}

      {failed && (
        <div role="alert" className="grid gap-2 text-sm">
          <p className="text-destructive">{t('Could not load the products.')}</p>
          <div>
            <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
              {t('Try again')}
            </Button>
          </div>
        </div>
      )}
      {!failed && !products && (
        <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t('Loading products…')}
        </p>
      )}

      {products && (
        <div className="space-y-8">
          <SettingsGroup title={t('Active products')}>
            {active.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-center">
                <p className="text-sm font-medium text-foreground">{t('No products or services yet')}</p>
                <p className="mx-auto mt-1 max-w-[46ch] text-sm text-muted-foreground">
                  {canEdit
                    ? t('Register what you sell once, then pick it inside any deal.')
                    : t('An owner or admin can register what you sell.')}
                </p>
                {canEdit && (
                  <Button size="sm" className="mt-3" onClick={() => setDialog({ product: null })}>
                    <Plus className="size-3.5" /> {t('Add your first product')}
                  </Button>
                )}
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {active.map((p) => (
                  <ProductRow
                    key={p.id}
                    product={p}
                    canEdit={canEdit}
                    currency={defaultCurrency}
                    onEdit={() => setDialog({ product: p })}
                    onToggleArchive={() => void toggleArchive(p)}
                  />
                ))}
              </ul>
            )}
          </SettingsGroup>

          {archived.length > 0 && (
            <SettingsGroup
              title={t('Archived products')}
              description={t('They no longer appear when adding to a deal. Old deals keep them.')}
            >
              <ul className="divide-y divide-border">
                {archived.map((p) => (
                  <ProductRow
                    key={p.id}
                    product={p}
                    canEdit={canEdit}
                    currency={defaultCurrency}
                    onEdit={() => setDialog({ product: p })}
                    onToggleArchive={() => void toggleArchive(p)}
                  />
                ))}
              </ul>
            </SettingsGroup>
          )}
        </div>
      )}

      {dialog && (
        <ProductDialog
          key={dialog.product?.id ?? 'new'}
          initial={dialog.product}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            setDialog(null);
            await load();
          }}
        />
      )}
    </section>
  );
}
