"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { ChevronRight, Loader2, Minus, Package, Plus } from "lucide-react";
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
import { parsePtBrAmount } from "@/lib/sales-goals/pace";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

const HEADING =
  "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";

/** One bordered box holding an input plus a prefix, suffix or stepper buttons. */
const GROUP =
  "flex h-9 items-center overflow-hidden rounded-lg border border-input bg-transparent transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 has-[[aria-invalid=true]]:border-destructive has-[[aria-invalid=true]]:ring-3 has-[[aria-invalid=true]]:ring-destructive/20 dark:bg-input/30";
const GROUP_INPUT =
  "h-full rounded-none border-0 bg-transparent px-2 tabular-nums focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent";
const STEP =
  "flex h-full w-9 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40";

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

/** "R$" for BRL, "US$" for USD… the symbol the price box shows before the number. */
function currencySymbol(currency: string): string {
  try {
    return (
      new Intl.NumberFormat("pt-BR", { style: "currency", currency })
        .formatToParts(0)
        .find((p) => p.type === "currency")?.value ?? currency
    );
  } catch {
    return currency;
  }
}

/** The units after one press of − or + (never below 1; "1,5" + 1 = "2,5"). */
function stepUnits(text: string, delta: 1 | -1): string {
  const n = parsePtBrAmount(text) ?? 0;
  return toInputNumber(Math.max(1, Math.round((n + delta) * 100) / 100));
}

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
    <div className="grid content-start gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children({ id, "aria-invalid": !!error, "aria-describedby": error ? errId : hint ? hintId : undefined })}
      {hint && !error && (
        <p id={hintId} className="text-[11px] leading-snug text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} role="alert" className="text-xs leading-snug text-destructive">
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
  /** Editing an existing line: removing it lives here, one step away from a stray click. */
  onRemove?: () => void;
}

function ItemForm({ initial, products, currency, busy, submitLabel, onSubmit, onCancel, onRemove }: ItemFormProps) {
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
  const units = parsePtBrAmount(quantity);

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
    <form
      onSubmit={submit}
      noValidate
      className={cn("grid gap-3 p-3", initial ? "bg-muted/30" : "rounded-xl border border-border bg-card")}
    >
      <Field label={t("Product or service name")} error={errorFor("name")}>
        {(a) => (
          <Input
            {...a}
            className="h-9"
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
        <ul
          aria-label={t("Catalog matches")}
          className="-mt-1 divide-y divide-border overflow-hidden rounded-lg border border-border"
        >
          {matches.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => pick(p)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
              >
                <span className="min-w-0" data-no-translate>
                  <span className="block truncate text-sm text-foreground">{p.name}</span>
                  {p.code ? <span className="block truncate text-[11px] text-muted-foreground">{p.code}</span> : null}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatMoney(p.unit_price, currency)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-x-3 gap-y-3">
        <Field label={t("Price per unit")} error={errorFor("price")}>
          {(a) => (
            <div className={GROUP}>
              <span aria-hidden className="pl-3 text-sm text-muted-foreground">
                {currencySymbol(currency)}
              </span>
              <Input
                {...a}
                className={GROUP_INPUT}
                inputMode="decimal"
                value={price}
                placeholder="0,00"
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>
          )}
        </Field>
        <Field label={t("Number of units")} error={errorFor("quantity")} hint={t("Use a comma for decimals, like 1,5")}>
          {(a) => (
            <div className={GROUP}>
              <button
                type="button"
                className={STEP}
                aria-label={t("One unit less")}
                disabled={units === null || units <= 1}
                onClick={() => setQuantity((q) => stepUnits(q, -1))}
              >
                <Minus className="size-3.5" />
              </button>
              <Input
                {...a}
                className={cn(GROUP_INPUT, "text-center")}
                inputMode="decimal"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
              <button
                type="button"
                className={STEP}
                aria-label={t("One unit more")}
                onClick={() => setQuantity((q) => stepUnits(q, 1))}
              >
                <Plus className="size-3.5" />
              </button>
            </div>
          )}
        </Field>
        <Field label={t("Discount in percent")} error={errorFor("discount")}>
          {(a) => (
            <div className={GROUP}>
              <Input
                {...a}
                className={cn(GROUP_INPUT, "pl-3")}
                inputMode="decimal"
                value={discount}
                placeholder="0"
                onChange={(e) => setDiscount(e.target.value)}
              />
              <span aria-hidden className="pr-3 text-sm text-muted-foreground">
                %
              </span>
            </div>
          )}
        </Field>
        <div className="grid content-start gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t("Line total")}</span>
          <p className="flex h-9 items-center text-base font-semibold tabular-nums text-foreground" aria-live="polite">
            {preview !== null ? formatMoney(preview, currency) : "—"}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 pt-1">
        {onRemove && initial && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="-ml-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
            aria-label={`${t("Remove item")}: ${initial.name}`}
            disabled={busy}
            onClick={onRemove}
          >
            {t("Remove item")}
          </Button>
        )}
        <div className="ml-auto flex gap-2">
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

/** Name, units × price (and the discount) on the left; what the line is worth on the right. */
function ItemRow({ item, currency }: { item: DealItem; currency: string }) {
  const gross = item.discount_pct > 0 ? lineTotal(item.quantity, item.unit_price, 0) : null;
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-medium text-foreground" data-no-translate>
          {item.name}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
          {`${toInputNumber(item.quantity)} × ${formatMoney(item.unit_price, currency)}`}
          {item.discount_pct > 0 && (
            <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-semibold text-primary">
              {`− ${toInputNumber(item.discount_pct)}%`}
            </span>
          )}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-sm font-semibold tabular-nums text-foreground">
          {formatMoney(item.line_total, currency)}
        </span>
        {gross !== null && (
          <span className="block text-[11px] tabular-nums text-muted-foreground line-through">
            {formatMoney(gross, currency)}
          </span>
        )}
      </span>
    </>
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
 * deal edits the lines (tap a line to edit or remove it); everyone else only reads.
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
    const ok = await run(() => removeDealItem(supabase, item.id), "Item removed");
    if (ok) setEditingId(null);
  }

  const total = items ? itemsTotal(items).total : 0;

  return (
    <section aria-labelledby={headingId}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 id={headingId} className={cn(HEADING, "flex items-center gap-2")}>
          {t("Products and services")}
          {items && items.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 text-[10px] font-semibold tabular-nums">{items.length}</span>
          )}
        </h3>
        {canEdit && !adding && items && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-primary hover:text-primary"
            onClick={() => void openAdd()}
            disabled={busy}
          >
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
        <div className="flex items-start gap-3 rounded-xl border border-dashed border-border p-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Package className="size-4" />
          </span>
          <p className="text-sm leading-snug text-muted-foreground">
            {canEdit
              ? t("No products or services in this deal yet. The deal value is typed by hand until you add one.")
              : t("No products or services in this deal.")}
          </p>
        </div>
      )}

      {items && items.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <li key={item.id}>
                {editingId === item.id ? (
                  <ItemForm
                    initial={item}
                    currency={currency}
                    busy={busy}
                    submitLabel={t("Save item")}
                    onSubmit={(values) => save(item, values)}
                    onCancel={() => setEditingId(null)}
                    onRemove={() => void remove(item)}
                  />
                ) : canEdit ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setAdding(false);
                      setEditingId(item.id);
                    }}
                    className="group flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:opacity-60"
                  >
                    <span className="sr-only">{t("Edit item")}: </span>
                    <ItemRow item={item} currency={currency} />
                    <ChevronRight
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
                    />
                  </button>
                ) : (
                  <div className="flex items-start gap-3 px-3 py-2.5">
                    <ItemRow item={item} currency={currency} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="flex items-baseline justify-between gap-3 border-t border-border bg-muted/30 px-3 py-2.5">
            <span className="text-sm text-muted-foreground">{t("Items total")}</span>
            <span className="text-base font-semibold tabular-nums text-foreground">{formatMoney(total, currency)}</span>
          </div>
        </div>
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
    </section>
  );
}
