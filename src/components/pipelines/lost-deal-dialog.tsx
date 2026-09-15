"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, X } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import { activeLossReasons, listLossReasons } from "@/lib/pipelines/loss-reasons";
import type { Deal, DealLossReason } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60";

export interface LostDealInput {
  reasonId: string;
  note: string;
}

interface LostDealDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal: Deal | null;
  /** Persist status + reason + note. Resolve to close; throw/reject to keep open. */
  onConfirm: (input: LostDealInput) => Promise<void>;
}

/**
 * "Marcar como perdido" — asks for the loss reason (required, from the
 * account's active reasons) and an optional note before the deal is
 * marked lost. The caller saves everything in one update.
 */
export function LostDealDialog({ open, onOpenChange, deal, onConfirm }: LostDealDialogProps) {
  const { t } = useLanguage();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <X className="h-4 w-4 text-red-500" />
            {t("Mark as lost")}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {deal ? (
              <>
                <span className="font-medium text-foreground">{deal.title}</span>
                {" · "}
                {t("Pick why this deal was lost. The reason feeds the pipeline analytics.")}
              </>
            ) : (
              t("Pick why this deal was lost. The reason feeds the pipeline analytics.")
            )}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open so the fields reset on every open. */}
        {open && (
          <LostDealForm onCancel={() => onOpenChange(false)} onConfirm={onConfirm} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function LostDealForm({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: (input: LostDealInput) => Promise<void>;
}) {
  const { t } = useLanguage();
  const { accountId, canEditSettings } = useAuth();
  const [reasons, setReasons] = useState<DealLossReason[] | null>(null);
  const [reasonId, setReasonId] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listLossReasons(createClient(), accountId);
        if (!cancelled) setReasons(activeLossReasons(rows));
      } catch (err) {
        console.error(err);
        if (!cancelled) setReasons([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const loading = reasons === null;
  const empty = reasons !== null && reasons.length === 0;
  const invalid = !reasonId || saving || loading;

  async function handleSubmit() {
    if (invalid) return;
    setSaving(true);
    try {
      await onConfirm({ reasonId, note });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="lost-deal-reason" className="text-muted-foreground">
          {t("Loss reason")} <span className="text-red-500">*</span>
        </Label>
        <select
          id="lost-deal-reason"
          value={reasonId}
          onChange={(e) => setReasonId(e.target.value)}
          disabled={loading || empty}
          required
          autoFocus
          className={SELECT_CLASS}
        >
          <option value="">
            {loading ? t("Loading...") : empty ? t("No active loss reasons") : t("Select a reason")}
          </option>
          {(reasons ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        {empty && (
          <p className="text-xs text-muted-foreground">
            {canEditSettings ? (
              <>
                {t("Add reasons in")}{" "}
                <Link href="/settings?tab=deals" className="underline underline-offset-2 hover:text-foreground">
                  {t("Settings › Deals and currency")}
                </Link>
                .
              </>
            ) : (
              t("Ask an account admin to add loss reasons in Settings.")
            )}
          </p>
        )}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="lost-deal-note" className="text-muted-foreground">
          {t("Note (optional)")}
        </Label>
        <Textarea
          id="lost-deal-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("What happened? Anything useful for next time.")}
          maxLength={1000}
          className="min-h-[80px] border-border bg-muted text-foreground"
        />
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
          className="border-border bg-transparent text-muted-foreground hover:bg-muted"
        >
          {t("Cancel")}
        </Button>
        <Button
          type="submit"
          disabled={invalid}
          className="bg-red-600 text-white hover:bg-red-700"
        >
          {saving ? <Loader2 className="animate-spin" /> : <X />}
          {t("Mark as lost")}
        </Button>
      </DialogFooter>
    </form>
  );
}
