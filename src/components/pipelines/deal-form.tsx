"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import { NOTES_LABEL } from "@/components/contacts/notes-label";
import { CURRENCIES } from "@/lib/currency";
import { AUDIT_ACTIONS } from "@/lib/audit";
import { recordAudit } from "@/lib/audit-client";
import type { Contact, Deal, PipelineStage, Profile } from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Trash2, DollarSign } from "lucide-react";
import { toast } from "sonner";

const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary";

interface DealFormBodyProps {
  /** Existing deal → edit; null/undefined → create. */
  deal?: Deal | null;
  pipelineId: string;
  stages: PipelineStage[];
  defaultStageId?: string;
  /** Preselected contact for a new deal (e.g. opened from the inbox panel). */
  defaultContactId?: string;
  /** Called after a successful save or delete so the board can refetch. */
  onSaved: () => void;
  /** Cancel/back. In the drawer this returns to the read view. */
  onCancel: () => void;
  /** Called after a successful delete (in addition to onSaved). */
  onDeleted?: () => void;
  /** Label of the cancel button — "Cancelar" by default. */
  cancelLabel?: string;
}

/**
 * The deal fields + footer, without a Sheet around them. Used by the
 * "new deal" sheet below and by the deal drawer's edit mode, so the
 * drawer can flip from read view to form without stacking sheets.
 */
export function DealFormBody({
  deal,
  pipelineId,
  stages,
  defaultStageId,
  defaultContactId,
  onSaved,
  onCancel,
  onDeleted,
  cancelLabel,
}: DealFormBodyProps) {
  const supabase = createClient();
  const { accountId, defaultCurrency } = useAuth();
  const { t, language } = useLanguage();

  const [title, setTitle] = useState(deal?.title ?? "");
  const [value, setValue] = useState(String(deal?.value ?? ""));
  const [currency, setCurrency] = useState(
    deal?.currency || defaultCurrency,
  );
  // contact_id is nullable when the contact has been deleted
  // (migration 004: ON DELETE SET NULL). "" means "no selection".
  const [contactId, setContactId] = useState(
    deal?.contact_id ?? defaultContactId ?? "",
  );
  const [stageId, setStageId] = useState(
    deal?.stage_id ?? (defaultStageId || stages[0]?.id || ""),
  );
  const [assignedTo, setAssignedTo] = useState(deal?.assigned_to ?? "");
  const [expectedCloseDate, setExpectedCloseDate] = useState(
    deal?.expected_close_date ?? "",
  );
  const [notes, setNotes] = useState(deal?.notes ?? "");

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The account's currency (or the deal's) goes first so a pt-BR
  // workspace is not greeted by "USD" at the top of a list where every
  // deal is BRL. Remaining currencies keep their catalogue order.
  const currencyOptions = useMemo(() => {
    const preferred = [deal?.currency, defaultCurrency].filter(
      (c, i, arr): c is string => !!c && arr.indexOf(c) === i,
    );
    const first = preferred
      .map((code) => CURRENCIES.find((c) => c.code === code))
      .filter((c): c is (typeof CURRENCIES)[number] => !!c);
    const rest = CURRENCIES.filter((c) => !preferred.includes(c.code));
    return [...first, ...rest];
  }, [deal?.currency, defaultCurrency]);

  // Load supporting data once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [c, p] = await Promise.all([
        supabase.from("contacts").select("*").order("name"),
        supabase.from("profiles").select("*").order("full_name"),
      ]);
      if (cancelled) return;
      setContacts((c.data ?? []) as Contact[]);
      setProfiles((p.data ?? []) as Profile[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  async function handleSave() {
    if (!title.trim() || !contactId || !stageId) {
      toast.error(t("Title, contact, and stage are required"));
      return;
    }
    setSaving(true);

    const payload = {
      title: title.trim(),
      value: parseFloat(value) || 0,
      currency,
      contact_id: contactId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      assigned_to: assignedTo || null,
      notes: notes.trim() || null,
      expected_close_date: expectedCloseDate || null,
    };

    if (deal) {
      const { error } = await supabase
        .from("deals")
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq("id", deal.id);
      if (error) {
        toast.error(t("Failed to save deal"));
        setSaving(false);
        return;
      }
    } else {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        toast.error(t("Not signed in"));
        setSaving(false);
        return;
      }
      if (!accountId) {
        toast.error(t("Your profile is not linked to an account."));
        setSaving(false);
        return;
      }
      const { error } = await supabase.from("deals").insert({
        ...payload,
        user_id: user.id,
        account_id: accountId,
        status: "open",
      });
      if (error) {
        toast.error(t("Failed to create deal"));
        setSaving(false);
        return;
      }
    }

    setSaving(false);
    toast.success(deal ? t("Deal updated") : t("Deal created"));
    onSaved();
  }

  async function handleDelete() {
    if (!deal) return;
    setDeleting(true);
    const { error } = await supabase.from("deals").delete().eq("id", deal.id);
    setDeleting(false);
    if (error) {
      toast.error(t("Failed to delete deal"));
      return;
    }
    void recordAudit({
      action: AUDIT_ACTIONS.DEAL_DELETED,
      entityType: "deal",
      entityId: deal.id,
      metadata: { name: deal.title, value: deal.value ?? null, contact_id: deal.contact_id },
    });
    toast.success(t("Deal deleted"));
    setConfirmDelete(false);
    onDeleted?.();
    onSaved();
  }

  const invalid = !title.trim() || !contactId || !stageId;

  return (
    <>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t("Title")}</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("Deal title")}
            className="border-border bg-muted text-foreground"
            autoFocus={!deal}
          />
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t("Contact")}</Label>
          <select
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
            className={SELECT_CLASS}
          >
            <option value="">{t("Select a contact")}</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || c.phone}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-[1fr_110px] gap-3">
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("Value")}</Label>
            <div className="relative">
              <DollarSign className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="number"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="0"
                className="border-border bg-muted pl-7 text-foreground"
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("Currency")}</Label>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className={SELECT_CLASS}
            >
              {currencyOptions.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground">
            {t("Expected close date")}
          </Label>
          <Input
            type="date"
            value={expectedCloseDate}
            onChange={(e) => setExpectedCloseDate(e.target.value)}
            className="border-border bg-muted text-foreground"
          />
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t("Stage")}</Label>
          <select
            value={stageId}
            onChange={(e) => setStageId(e.target.value)}
            className={SELECT_CLASS}
          >
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t("Assignee")}</Label>
          <select
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
            className={SELECT_CLASS}
          >
            <option value="">{t("No assignee")}</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name || p.email}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground" data-no-translate>
            {NOTES_LABEL[language]}
          </Label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("Add notes...")}
            className="min-h-[100px] border-border bg-muted text-foreground"
          />
        </div>
      </div>

      <div className="border-t border-border/50 bg-popover/80 p-4">
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={onCancel}
            className="flex-1 border-border bg-transparent text-muted-foreground hover:bg-muted"
          >
            {cancelLabel ?? t("Cancel")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || invalid}
            className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving
              ? t("Saving...")
              : deal
                ? t("Save changes")
                : t("Create deal")}
          </Button>
        </div>

        {deal &&
          (confirmDelete ? (
            <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
              <span className="text-red-600 dark:text-red-300">
                {t("Delete this deal?")}
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                  className="rounded px-2 py-1 text-muted-foreground hover:bg-muted"
                >
                  {t("Cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {deleting ? t("Deleting...") : t("Confirm")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="mt-3 flex w-full items-center justify-center gap-1 text-xs text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300"
            >
              <Trash2 className="h-3 w-3" />
              {t("Delete Deal")}
            </button>
          ))}
      </div>
    </>
  );
}

interface DealFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal?: Deal | null;
  pipelineId: string;
  stages: PipelineStage[];
  defaultStageId?: string;
  defaultContactId?: string;
  onSaved: () => void;
}

/**
 * Standalone sheet used for creating deals (top-bar "Adicionar negócio"
 * and the per-column "+"). Editing an existing deal goes through the
 * DealDrawer, which shows the read view first.
 */
export function DealForm({
  open,
  onOpenChange,
  deal,
  pipelineId,
  stages,
  defaultStageId,
  defaultContactId,
  onSaved,
}: DealFormProps) {
  const { t } = useLanguage();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full border-border bg-popover p-0 text-popover-foreground data-[side=right]:sm:max-w-[480px]"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">
              {deal ? t("Edit deal") : t("New Deal")}
            </SheetTitle>
          </SheetHeader>
          {/* Keyed on open/deal so the fields reset each time the sheet
              opens instead of syncing props into state in an effect. */}
          {open && (
            <DealFormBody
              key={deal?.id ?? `new-${defaultStageId ?? ""}-${defaultContactId ?? ""}`}
              deal={deal}
              pipelineId={pipelineId}
              stages={stages}
              defaultStageId={defaultStageId}
              defaultContactId={defaultContactId}
              onSaved={() => {
                onOpenChange(false);
                onSaved();
              }}
              onCancel={() => onOpenChange(false)}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
