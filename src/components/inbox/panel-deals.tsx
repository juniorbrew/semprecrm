"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, DollarSign, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/currency";
import { moveDealToStage } from "@/lib/pipelines/move-deal";
import {
  validateDealFields,
  type DealFieldDraft,
  type DealFieldError,
  type DealFieldKey,
} from "@/lib/pipelines/deal-fields";
import type { Deal, PipelineStage } from "@/types";
import { SectionHeader } from "./panel-section";

/** Deals shown before "Ver todos". */
export const PANEL_DEAL_LIMIT = 3;

const COPY: Record<
  Language,
  {
    title: string;
    empty: string;
    stage: (deal: string) => string;
    open: string;
    fields: string;
    value: string;
    date: string;
    notes: string;
    save: string;
    saved: string;
    saveFailed: string;
    moved: (stage: string) => string;
    moveFailed: string;
    invalid: Record<DealFieldError, string>;
    showAll: (n: number) => string;
    showLess: string;
    skeleton: string;
  }
> = {
  "pt-BR": {
    title: "Negócios vinculados",
    empty: "Nenhum negócio vinculado",
    stage: (d) => `Etapa do negócio ${d}`,
    open: "Abrir no funil",
    fields: "Campos do negócio",
    value: "Valor",
    date: "Previsão de fechamento",
    notes: "Notas",
    save: "Salvar",
    saved: "Negócio atualizado",
    saveFailed: "Não foi possível salvar o negócio",
    moved: (s) => `Negócio movido para ${s}`,
    moveFailed: "Não foi possível mover o negócio",
    invalid: {
      value: "Valor inválido (ex.: 1.500,00)",
      "value-max": "Valor acima do máximo permitido (9.999.999.999,99)",
      date: "Data inválida",
      notes: "Notas longas demais (máx. 2000)",
    },
    showAll: (n) => `Ver todos (${n})`,
    showLess: "Ver menos",
    skeleton: "Carregando negócios",
  },
  "en-US": {
    title: "Linked deals",
    empty: "No linked deals",
    stage: (d) => `Stage of deal ${d}`,
    open: "Open in Pipelines",
    fields: "Deal fields",
    value: "Value",
    date: "Expected close date",
    notes: "Notes",
    save: "Save",
    saved: "Deal updated",
    saveFailed: "Could not save the deal",
    moved: (s) => `Deal moved to ${s}`,
    moveFailed: "Could not move the deal",
    invalid: {
      value: "Invalid value (e.g. 1,500.00)",
      "value-max": "Value above the maximum allowed (9,999,999,999.99)",
      date: "Invalid date",
      notes: "Notes too long (max 2000)",
    },
    showAll: (n) => `Show all (${n})`,
    showLess: "Show fewer",
    skeleton: "Loading deals",
  },
};

interface PanelDealsProps {
  deals: Deal[];
  /** Merge a change into one deal of the parent's list. */
  onPatch: (dealId: string, patch: Partial<Deal>) => void;
  /** After a stage move was saved and logged (refreshes the activity feed). */
  onMoved?: () => void;
  loaded: boolean;
  /** Agent+ only; viewers get read-only chips. */
  canWrite: boolean;
  conversationId: string | null;
  /** The "+" of the header (parent owns the deal sheet). */
  addAction?: React.ReactNode;
}

export function PanelDeals({ deals, onPatch, onMoved, loaded, canWrite, conversationId, addAction }: PanelDealsProps) {
  const { language } = useLanguage();
  const copy = COPY[language] ?? COPY["pt-BR"];
  const [showAll, setShowAll] = useState(false);
  const [stagesByPipeline, setStagesByPipeline] = useState<Record<string, PipelineStage[]>>({});

  // Stages of every pipeline the listed deals live in (one query).
  const pipelineKey = useMemo(
    () => Array.from(new Set(deals.map((d) => d.pipeline_id))).sort().join(","),
    [deals],
  );
  useEffect(() => {
    if (!pipelineKey) return;
    let cancelled = false;
    createClient()
      .from("pipeline_stages")
      .select("*")
      .in("pipeline_id", pipelineKey.split(","))
      .order("position")
      .then(({ data }) => {
        if (cancelled || !data) return;
        const map: Record<string, PipelineStage[]> = {};
        for (const s of data as PipelineStage[]) (map[s.pipeline_id] ??= []).push(s);
        setStagesByPipeline(map);
      });
    return () => {
      cancelled = true;
    };
  }, [pipelineKey]);

  const visible = showAll ? deals : deals.slice(0, PANEL_DEAL_LIMIT);

  return (
    <div>
      <SectionHeader icon={DollarSign} label={copy.title} count={deals.length} action={addAction} />
      <div className="mt-2 space-y-2 px-1">
        {!loaded ? (
          <div role="status" aria-label={copy.skeleton} className="h-14 animate-pulse rounded-lg bg-muted/60" />
        ) : deals.length === 0 ? (
          <p className="text-xs text-muted-foreground">{copy.empty}</p>
        ) : (
          <>
            {visible.map((deal) => (
              <DealRow
                key={deal.id}
                deal={deal}
                stages={stagesByPipeline[deal.pipeline_id]}
                canWrite={canWrite}
                conversationId={conversationId}
                onPatch={onPatch}
                onMoved={onMoved}
              />
            ))}
            {deals.length > PANEL_DEAL_LIMIT && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="text-[11px] font-medium text-primary underline-offset-2 hover:underline"
              >
                {showAll ? copy.showLess : copy.showAll(deals.length)}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DealRow({
  deal,
  stages,
  canWrite,
  conversationId,
  onPatch,
  onMoved,
}: {
  deal: Deal;
  stages: PipelineStage[] | undefined;
  canWrite: boolean;
  conversationId: string | null;
  onPatch: (dealId: string, patch: Partial<Deal>) => void;
  onMoved?: () => void;
}) {
  const { user, profile, accountId, defaultCurrency } = useAuth();
  const { language } = useLanguage();
  const copy = COPY[language] ?? COPY["pt-BR"];
  const [moving, setMoving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const editable = canWrite && !!stages && stages.length > 1;

  async function handleMove(toStageId: string) {
    if (!stages || moving || toStageId === deal.stage_id) return;
    const previous = { stage_id: deal.stage_id, stage: deal.stage };
    const target = stages.find((s) => s.id === toStageId);
    if (!target) return;
    setMoving(true);
    onPatch(deal.id, { stage_id: target.id, stage: target });
    try {
      await moveDealToStage(createClient(), {
        deal,
        toStageId,
        stages,
        accountId,
        conversationId,
        actorId: user?.id ?? null,
        actorName: profile?.full_name || user?.email || undefined,
      });
      toast.success(copy.moved(target.name));
      onMoved?.();
    } catch (err) {
      console.error("Failed to move deal:", err);
      onPatch(deal.id, previous);
      toast.error(copy.moveFailed);
    } finally {
      setMoving(false);
    }
  }

  const color = deal.stage?.color ?? "#64748b";

  return (
    <div className="rounded-lg bg-muted px-3 py-2">
      <div className="flex items-center gap-1 text-sm font-medium text-foreground">
        <span className="min-w-0 flex-1 truncate">{deal.title}</span>
        <Link
          href={`/pipelines?deal=${encodeURIComponent(deal.id)}`}
          title={copy.open}
          aria-label={copy.open}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="tabular-nums">{formatCurrency(deal.value, deal.currency ?? defaultCurrency)}</span>
        {editable ? (
          <span className="relative inline-flex items-center">
            <select
              value={deal.stage_id}
              disabled={moving}
              aria-label={copy.stage(deal.title)}
              onChange={(e) => void handleMove(e.target.value)}
              className="max-w-32 cursor-pointer appearance-none truncate rounded-full py-0.5 pl-2 pr-5 text-[10px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              style={{ backgroundColor: `${color}20`, color }}
            >
              {stages.map((s) => (
                <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                  {s.name}
                </option>
              ))}
            </select>
            {moving ? (
              <Loader2 className="pointer-events-none absolute right-1 h-3 w-3 animate-spin" style={{ color }} />
            ) : (
              <ChevronDown className="pointer-events-none absolute right-1 h-3 w-3" style={{ color }} aria-hidden />
            )}
          </span>
        ) : (
          deal.stage && (
            <span
              className="truncate rounded-full px-1.5 py-0.5 text-[10px]"
              style={{ backgroundColor: `${color}20`, color }}
            >
              {deal.stage.name}
            </span>
          )
        )}
      </div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={cn("h-3 w-3 transition-transform", !expanded && "-rotate-90")} aria-hidden />
        {copy.fields}
      </button>
      {expanded && (
        <DealFields
          // Remount (resync the draft) whenever the saved values change underneath.
          key={`${deal.value}|${deal.expected_close_date ?? ""}|${deal.notes ?? ""}`}
          deal={deal}
          canWrite={canWrite}
          onPatch={onPatch}
        />
      )}
    </div>
  );
}

function DealFields({
  deal,
  canWrite,
  onPatch,
}: {
  deal: Deal;
  canWrite: boolean;
  onPatch: (dealId: string, patch: Partial<Deal>) => void;
}) {
  const { language } = useLanguage();
  const copy = COPY[language] ?? COPY["pt-BR"];
  const initial = {
    value: String(deal.value ?? 0).replace(".", ","),
    expected_close_date: deal.expected_close_date?.slice(0, 10) ?? "",
    notes: deal.notes ?? "",
  };
  const [draft, setDraft] = useState<DealFieldDraft>(initial);
  const [errors, setErrors] = useState<DealFieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const dirty: Record<DealFieldKey, boolean> = {
    value: draft.value !== initial.value,
    expected_close_date: draft.expected_close_date !== initial.expected_close_date,
    notes: draft.notes !== initial.notes,
  };
  const anyDirty = dirty.value || dirty.expected_close_date || dirty.notes;
  const edit = (key: DealFieldKey, v: string) => setDraft((d) => ({ ...d, [key]: v }));

  async function save() {
    const result = validateDealFields(draft, dirty);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    if (Object.keys(result.patch).length === 0) return;
    setSaving(true);
    try {
      const { data, error } = await createClient()
        .from("deals")
        .update({ ...result.patch, updated_at: new Date().toISOString() })
        .eq("id", deal.id)
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) throw new Error("deal update not persisted");
      const local: Partial<Deal> = {};
      if ("value" in result.patch) local.value = result.patch.value as number;
      if ("expected_close_date" in result.patch) local.expected_close_date = result.patch.expected_close_date ?? undefined;
      if ("notes" in result.patch) local.notes = result.patch.notes ?? undefined;
      onPatch(deal.id, local);
      toast.success(copy.saved);
    } catch (err) {
      console.error("Failed to save deal fields:", err);
      toast.error(copy.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  const input =
    "mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-60";
  const err = (...keys: DealFieldError[]) => {
    const hit = keys.find((k) => errors.includes(k));
    return hit ? (
      <span role="alert" className="mt-0.5 block text-[10px] text-red-600 dark:text-red-400">
        {copy.invalid[hit]}
      </span>
    ) : null;
  };

  return (
    <form
      className="mt-2 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="block text-[10px] font-medium text-muted-foreground">
        {copy.value}
        <input
          value={draft.value}
          onChange={(e) => edit("value", e.target.value)}
          inputMode="decimal"
          disabled={!canWrite || saving}
          aria-invalid={errors.includes("value") || errors.includes("value-max")}
          className={input}
        />
        {err("value", "value-max")}
      </label>
      <label className="block text-[10px] font-medium text-muted-foreground">
        {copy.date}
        <input
          type="date"
          value={draft.expected_close_date}
          onChange={(e) => edit("expected_close_date", e.target.value)}
          disabled={!canWrite || saving}
          aria-invalid={errors.includes("date")}
          className={input}
        />
        {err("date")}
      </label>
      <label className="block text-[10px] font-medium text-muted-foreground">
        {copy.notes}
        <textarea
          value={draft.notes}
          onChange={(e) => edit("notes", e.target.value)}
          rows={2}
          disabled={!canWrite || saving}
          aria-invalid={errors.includes("notes")}
          className={cn(input, "resize-none")}
        />
        {err("notes")}
      </label>
      {canWrite && (
        <button
          type="submit"
          disabled={saving || !anyDirty}
          className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : copy.save}
        </button>
      )}
    </form>
  );
}
