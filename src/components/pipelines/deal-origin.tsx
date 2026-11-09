"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { OriginText, useContactOrigins } from "@/components/origins/origin-line";
import { Button } from "@/components/ui/button";
import { useCan } from "@/hooks/use-can";
import { useLanguage } from "@/hooks/use-language";
import { createClient } from "@/lib/supabase/client";
import { LEAD_ORIGIN_COLUMNS, originLabel, type LeadOrigin } from "@/lib/lead-origins";
import type { Deal } from "@/types";

type DealOriginFields = Pick<Deal, "id" | "contact_id" | "origin_id" | "origin_set_by" | "origin_set_at">;

/**
 * "Origem" of a deal, at the top of the drawer body. Everyone reads it; admin and owner can
 * change it by hand (the database refuses anyone else and stamps who changed it and when).
 */
export function DealOrigin({ deal, onChanged }: { deal: DealOriginFields; onChanged?: () => void | Promise<void> }) {
  const { t, language } = useLanguage();
  const canChange = useCan("edit-settings");
  const { origins, loading } = useContactOrigins(deal.contact_id);
  // The deal's origin may be a touch of another contact (set by hand): fetch it when it is not in the list.
  const [extra, setExtra] = useState<LeadOrigin | null>(null);
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState("");
  const [saving, setSaving] = useState(false);
  const [setter, setSetter] = useState<string | null>(null);

  const listed = origins.find((o) => o.id === deal.origin_id) ?? null;
  useEffect(() => {
    if (!deal.origin_id || loading || listed) return;
    let cancelled = false;
    createClient()
      .from("lead_origins")
      .select(LEAD_ORIGIN_COLUMNS)
      .eq("id", deal.origin_id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setExtra((data as unknown as LeadOrigin | null) ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [deal.origin_id, loading, listed]);

  // Who changed it by hand (name of a member of this account), best effort.
  useEffect(() => {
    if (!deal.origin_set_by) return;
    let cancelled = false;
    createClient()
      .from("profiles")
      .select("full_name")
      .eq("user_id", deal.origin_set_by)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setSetter(((data as { full_name: string | null } | null)?.full_name ?? "").trim() || null);
      });
    return () => {
      cancelled = true;
    };
  }, [deal.origin_set_by]);

  const current = listed ?? (deal.origin_id ? extra : null);
  const choices = useMemo(() => {
    const list = [...origins];
    if (current && !list.some((o) => o.id === current.id)) list.push(current);
    return list;
  }, [origins, current]);

  async function save() {
    const next = choice || null;
    if (next === (deal.origin_id ?? null)) return setEditing(false);
    setSaving(true);
    const { error } = await createClient().from("deals").update({ origin_id: next }).eq("id", deal.id);
    setSaving(false);
    if (error) {
      toast.error(t("Could not change the origin."));
      return;
    }
    toast.success(t("Origin changed."));
    setEditing(false);
    await onChanged?.();
  }

  const when = deal.origin_set_at
    ? new Intl.DateTimeFormat(language, { day: "numeric", month: "short" }).format(new Date(deal.origin_set_at))
    : null;

  return (
    <section data-testid="deal-origin">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("Deal origin")}</h3>
      <div className="space-y-1 rounded-xl border border-border bg-card p-3 text-sm">
        {loading ? (
          <p className="text-xs text-muted-foreground">{t("Loading...")}</p>
        ) : editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="deal-origin-select" className="sr-only">
              {t("Deal origin")}
            </label>
            <select
              id="deal-origin-select"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="h-8 min-w-0 max-w-full flex-1 rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value="">{t("Direct or not identified")}</option>
              {choices.map((o) => (
                <option key={o.id} value={o.id} data-no-translate>
                  {originLabel(o)}
                </option>
              ))}
            </select>
            <Button type="button" size="xs" onClick={save} disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              {t("Save")}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              {t("Cancel")}
            </Button>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 text-sm text-foreground">
              <OriginText origin={current} />
            </p>
            {canChange && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => {
                  setChoice(deal.origin_id ?? "");
                  setEditing(true);
                }}
              >
                {t("Change origin")}
              </Button>
            )}
          </div>
        )}
        {!editing && when && (
          <p className="text-[11px] text-muted-foreground">
            {t("Changed by hand")}
            {setter ? <span data-no-translate>{` · ${setter}`}</span> : null}
            <span data-no-translate>{` · ${when}`}</span>
          </p>
        )}
      </div>
    </section>
  );
}
