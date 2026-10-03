"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import {
  LossReasonInUseError,
  createLossReason,
  deleteLossReason,
  listLossReasons,
  reorderLossReasons,
  sortLossReasons,
  updateLossReason,
} from "@/lib/pipelines/loss-reasons";
import type { DealLossReason } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { DANGER_TEXT_BUTTON, SettingsGroup } from "./settings-group";

/**
 * Configurações → Negócios e moeda → "Motivos de perda": the account's
 * loss reasons. Rename inline (saved on blur), reorder with the arrows,
 * toggle active (inactive reasons stop appearing in the "Perdido"
 * dialog but keep their history), add, and delete when no deal uses
 * the reason. Admin+ only — RLS enforces it, the UI mirrors it.
 */
export function LossReasonsSettings() {
  const supabase = useMemo(() => createClient(), []);
  const { t } = useLanguage();
  const { accountId, canEditSettings, profileLoading } = useAuth();
  const readOnly = !canEditSettings;

  const [reasons, setReasons] = useState<DealLossReason[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [inUse, setInUse] = useState<{ id: string; count: number } | null>(null);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  async function reload() {
    if (!accountId) return;
    try {
      setReasons(await listLossReasons(supabase, accountId));
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to load loss reasons"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listLossReasons(supabase, accountId);
        if (!cancelled) setReasons(rows);
      } catch (err) {
        console.error(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, supabase]);

  const ordered = useMemo(() => sortLossReasons(reasons), [reasons]);

  async function patch(id: string, changes: Partial<Pick<DealLossReason, "name" | "is_active">>) {
    setReasons((prev) => prev.map((r) => (r.id === id ? { ...r, ...changes } : r)));
    setBusyId(id);
    try {
      await updateLossReason(supabase, id, changes);
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to save"));
      await reload();
    } finally {
      setBusyId(null);
    }
  }

  async function move(id: string, direction: -1 | 1) {
    const from = ordered.findIndex((r) => r.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ordered.length) return;
    const next = [...ordered];
    [next[from], next[to]] = [next[to], next[from]];
    const renumbered = next.map((r, i) => ({ ...r, position: i }));
    setReasons(renumbered);
    setBusyId(id);
    try {
      await reorderLossReasons(supabase, renumbered);
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to save"));
      await reload();
    } finally {
      setBusyId(null);
    }
  }

  async function handleAdd() {
    if (!accountId) return;
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    try {
      await createLossReason(supabase, accountId, reasons, name);
      setNewName("");
      await reload();
      toast.success(t("Loss reason created"));
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to create loss reason"));
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    setBusyId(id);
    try {
      await deleteLossReason(supabase, id);
      setConfirmDeleteId(null);
      await reload();
      toast.success(t("Loss reason deleted"));
    } catch (err) {
      if (err instanceof LossReasonInUseError) {
        setConfirmDeleteId(null);
        setInUse({ id, count: err.usageCount });
        return;
      }
      console.error(err);
      toast.error(t("Failed to delete loss reason"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <SettingsGroup
      title={t("Loss reasons")}
      description={t(
        "What your team picks when a deal is marked as lost. Names are saved when you leave the field; inactive reasons stay on old deals but are no longer offered.",
      )}
    >
        {loading || profileLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : (
          <>
            {ordered.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {t("No loss reasons yet. Add the first one below.")}
              </p>
            )}

            <div className="divide-y divide-border">
              {ordered.map((reason, index) => (
                <ReasonRow
                  key={reason.id}
                  reason={reason}
                  readOnly={readOnly}
                  busy={busyId === reason.id}
                  isFirst={index === 0}
                  isLast={index === ordered.length - 1}
                  confirming={confirmDeleteId === reason.id}
                  inUseCount={inUse?.id === reason.id ? inUse.count : null}
                  onRename={(name) => patch(reason.id, { name })}
                  onToggleActive={(is_active) => patch(reason.id, { is_active })}
                  onMoveUp={() => move(reason.id, -1)}
                  onMoveDown={() => move(reason.id, 1)}
                  onAskDelete={() => {
                    setInUse(null);
                    setConfirmDeleteId(reason.id);
                  }}
                  onCancelDelete={() => setConfirmDeleteId(null)}
                  onDelete={() => handleDelete(reason.id)}
                  onDismissInUse={() => setInUse(null)}
                  onDeactivate={() => {
                    setInUse(null);
                    void patch(reason.id, { is_active: false });
                  }}
                />
              ))}
            </div>

            {!readOnly && (
              <div className="grid gap-2 pt-2">
                <Label htmlFor="new-loss-reason">
                  {t("New loss reason")}
                </Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id="new-loss-reason"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={t("e.g. Budget cut, Timing")}
                    maxLength={80}
                    className="min-w-[160px] flex-1"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleAdd();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleAdd()}
                    disabled={adding || !newName.trim()}
                    className="shrink-0"
                  >
                    {adding ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                    {t("Add")}
                  </Button>
                </div>
              </div>
            )}

            {readOnly && (
              <p className="text-xs text-muted-foreground">
                {t("Only account admins can change loss reasons.")}
              </p>
            )}
          </>
        )}
    </SettingsGroup>
  );
}

function ReasonRow({
  reason,
  readOnly,
  busy,
  isFirst,
  isLast,
  confirming,
  inUseCount,
  onRename,
  onToggleActive,
  onMoveUp,
  onMoveDown,
  onAskDelete,
  onCancelDelete,
  onDelete,
  onDismissInUse,
  onDeactivate,
}: {
  reason: DealLossReason;
  readOnly: boolean;
  busy: boolean;
  isFirst: boolean;
  isLast: boolean;
  confirming: boolean;
  inUseCount: number | null;
  onRename: (name: string) => void;
  onToggleActive: (active: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
  onDismissInUse: () => void;
  onDeactivate: () => void;
}) {
  const { t } = useLanguage();
  const [name, setName] = useState(reason.name);

  // Mirror server renames (e.g. after a failed save reloads the list).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(reason.name);
  }, [reason.name]);

  return (
    <div
      className={cn(
        "py-2.5",
        !reason.is_active && "opacity-70",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-col">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={readOnly || isFirst || busy}
            aria-label={t("Move up")}
            title={t("Move up")}
            className="flex h-4 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default disabled:opacity-30 motion-reduce:transition-none"
          >
            <ArrowUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={readOnly || isLast || busy}
            aria-label={t("Move down")}
            title={t("Move down")}
            className="flex h-4 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default disabled:opacity-30 motion-reduce:transition-none"
          >
            <ArrowDown className="h-3 w-3" />
          </button>
        </div>

        <Input
          value={name}
          disabled={readOnly}
          maxLength={80}
          aria-label={t("Loss reason name")}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const trimmed = name.trim();
            if (!trimmed) {
              setName(reason.name);
              return;
            }
            if (trimmed !== reason.name) onRename(trimmed);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className={cn(
            "h-8 min-w-[140px] flex-1 text-sm",
            !reason.is_active && "line-through",
          )}
        />

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={reason.is_active}
            disabled={readOnly || busy}
            onCheckedChange={(checked) => onToggleActive(checked)}
            aria-label={reason.is_active ? t("Active") : t("Inactive")}
          />
          <span className="w-12">{reason.is_active ? t("Active") : t("Inactive")}</span>
        </label>

        {!readOnly && (
          <button
            type="button"
            onClick={onAskDelete}
            disabled={busy}
            title={t("Delete loss reason")}
            aria-label={t("Delete loss reason")}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-destructive focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {confirming && (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-foreground">
          <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
          <span className="flex-1">{t("Delete this loss reason?")}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancelDelete}
          >
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDelete}
            disabled={busy}
            className={DANGER_TEXT_BUTTON}
          >
            {t("Delete")}
          </Button>
        </div>
      )}

      {inUseCount !== null && (
        <div role="status" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-foreground">
          <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
          <span className="flex-1">
            {inUseCount === 1
              ? t("This reason is used by 1 deal and can't be deleted. Deactivate it instead to hide it from the list.")
              : `${t("This reason is used by")} ${inUseCount} ${t("deals and can't be deleted. Deactivate it instead to hide it from the list.")}`}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDismissInUse}
          >
            {t("Close")}
          </Button>
          {reason.is_active && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onDeactivate}
            >
              {t("Deactivate")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
