"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { useLanguage } from "@/hooks/use-language";
import { formatMoney } from "@/lib/currency";
import {
  itemsTotal,
  lineTotal,
  toInputNumber,
  validateItemDraft,
  type ItemError,
} from "@/lib/products/calc";
import {
  addDealItem,
  listDealItems,
  listProducts,
  productsErrorMessage,
  removeDealItem,
  updateDealItem,
} from "@/lib/products/data";
import type { DealItem, ItemValues, Product } from "@/lib/products/types";
import { createClient } from "@/lib/supabase/client";

const HEADING =
  "mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";

/** Which field each error belongs to, and the plain-language message (English key for t()). */
const ERROR_FIELD: Record<ItemError, "name" | "price" | "quantity" | "discount"> = {
  name: "name",
  "name-max": "name",
  price: "price",
  "price-max": "price",
  quantity: "quantity",
  "quantity-max": "quantity",
  discount: "discount",
  "total-max": "price",
};
const ERROR_TEXT: Record<ItemError, string> = {
  name: "Type the name of the product or service",
  "name-max": "The name can have at most 120 characters",
  price: "Type a valid price, like 1.500,00",
  "price-max": "This price is too high",
  quantity: "Type a number of units above zero, like 2 or 1,5",
  "quantity-max": "The number of units is too high",
  discount: "Type a discount from 0 to 100",
  "total-max": "This line is worth more than a deal can hold",
};

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  children: (p: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => React.ReactNode;
}
function Field({ label, error, hint, children }: FieldProps) {
  const id = useId();
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children({ id, "aria-invalid": !!error, "aria-describedby": error ? errId : hint ? hintId : undefined })}
      {hint && !error && (
        <p id={hintId} className="text-[11px] text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

interface ItemFormProps {
  initial?: DealItem;
  /** Catalog to pick from (new lines only). */
  products?: Product[];
  currency: string;
  busy: boolean;
  submitLabel: string;
  onSubmit: (values: ItemValues, productId: string | null) => void | Promise<void>;
  onCancel: () => void;
}

function ItemForm({ initial, products, currency, busy, submitLabel, onSubmit, onCancel }: ItemFormProps) {
  const { t } = useLanguage();
  const [name, setName] = useState(initial?.name ?? "");
  const [price, setPrice] = useState(initial ? toInputNumber(initial.unit_price) : "");
  const [quantity, setQuantity] = useState(initial ? toInputNumber(initial.quantity) : "1");
  const [discount, setDiscount] = useState(initial && initial.discount_pct ? toInputNumber(initial.discount_pct) : "");
  const [productId, setProductId] = useState<string | null>(initial?.product_id ?? null);
  const [errors, setErrors] = useState<ItemError[]>([]);

  const draft = { name, unitPrice: price, quantity, discount };
  const parsed = validateItemDraft(draft);
  const preview = parsed.ok
    ? lineTotal(parsed.values.quantity, parsed.values.unit_price, parsed.values.discount_pct)
    : null;

  const matches = useMemo(() => {
    if (!products || productId) return [];
    const q = name.trim().toLowerCase();
    return products
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.code ?? "").toLowerCase().includes(q))
      .slice(0, 5);
  }, [products, name, productId]);

  const errorFor = (field: "name" | "price" | "quantity" | "discount") => {
    const e = errors.find((x) => ERROR_FIELD[x] === field);
    return e ? t(ERROR_TEXT[e]) : undefined;
  };

  function pick(p: Product) {
    setProductId(p.id);
    setName(p.name);
    setPrice(toInputNumber(p.unit_price));
    setErrors([]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const result = validateItemDraft(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    await onSubmit(result.values, productId);
  }

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-xl border border-border bg-card p-3" noValidate>
      <Field label={t("Product or service name")} error={errorFor("name")}>
        {(a) => (
          <Input
            {...a}
            value={name}
            maxLength={200}
            autoComplete="off"
            placeholder={products ? t("Search the catalog or type a name") : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setProductId(null);
            }}
          />
        )}
      </Field>
      {matches.length > 0 && (
        <ul aria-label={t("Catalog matches")} className="grid gap-1">
          {matches.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => pick(p)}
                className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <span className="min-w-0 truncate" data-no-translate>
                  {p.name}
                  {p.code ? <span className="ml-1 text-xs text-muted-foreground">({p.code})</span> : null}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatMoney(p.unit_price, currency)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-3 gap-2">
        <Field label={t("Price per unit")} error={errorFor("price")}>
          {(a) => <Input {...a} inputMode="decimal" value={price} placeholder="0,00" onChange={(e) => setPrice(e.target.value)} />}
        </Field>
        <Field label={t("Number of units")} error={errorFor("quantity")} hint={t("Use a comma for decimals, like 1,5")}>
          {(a) => <Input {...a} inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />}
        </Field>
        <Field label={t("Discount in percent")} error={errorFor("discount")}>
          {(a) => <Input {...a} inputMode="decimal" value={discount} placeholder="0" onChange={(e) => setDiscount(e.target.value)} />}
        </Field>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {preview !== null ? `${t("Line total")}: ${formatMoney(preview, currency)}` : ""}
        </p>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}

interface DealItemsSectionProps {
  dealId: string;
  currency: string;
  /** Called after any change so the deal (and its value, computed by the database) is read again. */
  onChanged: () => void | Promise<void>;
  /** Number of lines, once known (the header shows "calculated from the items"). */
  onCount?: (count: number) => void;
}

/**
 * "Produtos e serviços" of a deal: the lines (name, price, units, discount) and
 * their total. The deal value is the sum of the lines and is computed by the
 * database; this section only reads and edits the lines. Whoever can edit the
 * deal edits the lines; everyone else only reads.
 */
export function DealItemsSection({ dealId, currency, onChanged, onCount }: DealItemsSectionProps) {
  const { t } = useLanguage();
  const { accountId } = useAuth();
  const canEdit = useCan("send-messages");
  const supabase = useMemo(() => createClient(), []);
  const headingId = useId();

  const [items, setItems] = useState<DealItem[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [products, setProducts] = useState<Product[] | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows = await listDealItems(supabase, dealId);
      setItems(rows);
      setLoadFailed(false);
      onCount?.(rows.length);
    } catch {
      setLoadFailed(true);
    }
  }, [supabase, dealId, onCount]);

  // First read (state is set from the promise, not synchronously in the effect).
  useEffect(() => {
    let cancelled = false;
    listDealItems(supabase, dealId)
      .then((rows) => {
        if (cancelled) return;
        setItems(rows);
        onCount?.(rows.length);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, dealId, onCount]);

  async function openAdd() {
    setEditingId(null);
    setAdding(true);
    if (!products) {
      try {
        setProducts(await listProducts(supabase));
      } catch {
        setProducts([]);
      }
    }
  }

  /** Runs a write, then reads the lines and the deal again. true when it worked. */
  async function run(write: () => Promise<void>, done: string): Promise<boolean> {
    setBusy(true);
    try {
      try {
        await write();
      } catch (err) {
        toast.error(t(productsErrorMessage(err)));
        return false;
      }
      // The write is saved; a failed refresh only leaves the view stale until the next load.
      await Promise.all([load(), onChanged()]).catch(() => undefined);
      toast.success(t(done));
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function add(values: ItemValues, productId: string | null) {
    if (!accountId || !items) return;
    const ok = await run(
      () => addDealItem(supabase, accountId, dealId, values, { productId, position: items.length }),
      "Item added",
    );
    if (ok) setAdding(false);
  }

  async function save(item: DealItem, values: ItemValues) {
    const ok = await run(() => updateDealItem(supabase, item.id, values), "Item updated");
    if (ok) setEditingId(null);
  }

  async function remove(item: DealItem) {
    await run(() => removeDealItem(supabase, item.id), "Item removed");
  }

  const total = items ? itemsTotal(items).total : 0;

  return (
    <section aria-labelledby={headingId}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 id={headingId} className={HEADING + " mb-0"}>
          {t("Products and services")}
        </h3>
        {canEdit && !adding && items && (
          <Button type="button" size="xs" variant="ghost" onClick={() => void openAdd()} disabled={busy}>
            <Plus />
            {t("Add item")}
          </Button>
        )}
      </div>

      {loadFailed && (
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
          {t("Could not load the items.")}
          <Button type="button" size="xs" variant="outline" onClick={() => void load()}>
            {t("Try again")}
          </Button>
        </div>
      )}

      {!loadFailed && !items && (
        <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> {t("Loading items…")}
        </p>
      )}

      {items && items.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground">
          {canEdit
            ? t("No products or services in this deal yet. The deal value is typed by hand until you add one.")
            : t("No products or services in this deal.")}
        </p>
      )}

      {items && items.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {items.map((item) =>
            editingId === item.id ? (
              <li key={item.id} className="p-2">
                <ItemForm
                  initial={item}
                  currency={currency}
                  busy={busy}
                  submitLabel={t("Save item")}
                  onSubmit={(values) => save(item, values)}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            ) : (
              <li key={item.id} className="flex items-start gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium text-foreground" data-no-translate>{item.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {`${toInputNumber(item.quantity)} × ${formatMoney(item.unit_price, currency)}`}
                    {item.discount_pct > 0 ? ` − ${toInputNumber(item.discount_pct)}%` : ""}
                  </p>
                </div>
                <p className="shrink-0 text-sm font-semibold text-foreground">{formatMoney(item.line_total, currency)}</p>
                {canEdit && (
                  <div className="flex shrink-0">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`${t("Edit item")}: ${item.name}`}
                      title={t("Edit item")}
                      disabled={busy}
                      onClick={() => {
                        setAdding(false);
                        setEditingId(item.id);
                      }}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`${t("Remove item")}: ${item.name}`}
                      title={t("Remove item")}
                      disabled={busy}
                      onClick={() => void remove(item)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      )}

      {adding && (
        <div className={items && items.length > 0 ? "mt-2" : ""}>
          <ItemForm
            products={products ?? []}
            currency={currency}
            busy={busy}
            submitLabel={t("Add item")}
            onSubmit={add}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {items && items.length > 0 && (
        <div className="mt-2 flex items-center justify-between gap-2 px-1">
          <p className="text-xs text-muted-foreground">{t("The deal value is the sum of the items.")}</p>
          <p className="text-sm font-semibold text-foreground">
            <span className="mr-2 text-xs font-normal text-muted-foreground">{t("Items total")}</span>
            {formatMoney(total, currency)}
          </p>
        </div>
      )}
    </section>
  );
}
