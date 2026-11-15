"use client";

import { useEffect, useState } from "react";

import { OriginNameText } from "@/components/origins/origin-line";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/hooks/use-language";
import { formatMoney } from "@/lib/currency";
import { type OriginReportRow } from "@/lib/lead-origins";
import { rowOriginName } from "@/lib/lead-origins/report";
import { loadSpend, parseMoneyToCents, saveSpend, type SpendKey } from "@/lib/indicators/spend";
import { createClient } from "@/lib/supabase/client";

/**
 * "Informar gasto": the admin types how much was spent on one ad / campaign in one month (ad_spend,
 * migration 111). Mounted only while open (the parent keys it by row), so every opening starts clean.
 * Only admins reach it (the button is hidden for everyone else, and RLS refuses anyone else's write).
 */
export function SpendDialog({
  row,
  accountId,
  defaultMonth,
  currency,
  onClose,
  onSaved,
}: {
  row: OriginReportRow;
  accountId: string;
  /** "YYYY-MM": the month the page period ends in. */
  defaultMonth: string;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  const [month, setMonth] = useState(defaultMonth);
  const [text, setText] = useState<string | null>(null); // null = not edited: show what is saved
  const [saved, setSaved] = useState<{ month: string; cents: number | null; failed: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key: SpendKey = { origin_type: row.origin_type, channel: row.channel, name: row.name, source: row.source };
  const monthOk = /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
  const loading = monthOk && saved?.month !== month;

  useEffect(() => {
    if (!monthOk) return;
    let cancelled = false;
    loadSpend(createClient(), { origin_type: row.origin_type, channel: row.channel, name: row.name, source: row.source }, month)
      .then((cents) => !cancelled && setSaved({ month, cents, failed: false }))
      .catch(() => !cancelled && setSaved({ month, cents: null, failed: true }));
    return () => {
      cancelled = true;
    };
  }, [month, monthOk, row.origin_type, row.channel, row.name, row.source]);

  const current = saved?.month === month && saved.cents != null ? (saved.cents / 100).toFixed(2).replace(".", ",") : "";
  const shown = text ?? current;
  const cents = parseMoneyToCents(shown);

  async function submit() {
    if (cents == null || !monthOk) return;
    setSaving(true);
    setError(null);
    try {
      await saveSpend(createClient(), accountId, key, month, cents);
      onSaved();
      onClose();
    } catch (err) {
      console.error("[reports] save spend failed:", err instanceof Error ? err.message : "error");
      setError(t("Could not save the spend."));
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("Report ad spend")}</DialogTitle>
          <DialogDescription>
            {t("How much was spent on")} <OriginNameText n={rowOriginName(row)} />
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="spend-month">{t("Spend month")}</Label>
            <Input
              id="spend-month"
              type="month"
              value={month}
              onChange={(e) => {
                setMonth(e.target.value);
                setText(null);
              }}
              aria-invalid={!monthOk}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="spend-amount">{t("Amount spent")}</Label>
            <Input
              id="spend-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder={formatMoney(0, currency)}
              value={shown}
              disabled={loading}
              onChange={(e) => setText(e.target.value)}
              aria-invalid={shown !== "" && cents == null}
            />
            <p className="text-xs text-muted-foreground">
              {t("The period of the report uses the spend of every month it touches.")}
            </p>
          </div>
          {saved?.failed && saved.month === month && (
            <p role="alert" className="text-sm text-muted-foreground">
              {t("Could not load the saved spend.")}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter showCloseButton={false}>
            <DialogClose render={<Button type="button" variant="outline" />}>{t("Cancel")}</DialogClose>
            <Button type="submit" disabled={saving || loading || cents == null || !monthOk}>
              {t("Save spend")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
