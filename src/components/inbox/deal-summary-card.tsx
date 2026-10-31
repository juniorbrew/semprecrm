"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { invalidateAiStatus, useAiStatus } from "@/hooks/use-ai-status";
import { useLanguage } from "@/hooks/use-language";
import { formatCurrency } from "@/lib/currency";

// "Resumir com IA" (spec 2026-10-31-resumo-ia-negocio): a short summary
// of the conversation plus proposed updates for the contact's open deal.
// The server validates the proposals before they get here and again on
// "Aplicar"; nothing changes until the agent clicks it.

export interface DealSummaryData {
  summary: { wants: string; status: string; next_step: string };
  deal: { id: string; title: string; value: number; currency: string | null; expected_close_date: string | null; stage_id: string; stage_name: string | null } | null;
  stages: { id: string; name: string }[];
  updates: {
    stage_id: string | null;
    value: number | null;
    expected_close_date: string | null;
    task: { title: string; due_date: string | null } | null;
    note: string;
  } | null;
}

export type SuggestionKey = "stage" | "value" | "date" | "task" | "note";
export type ApplyStatus = "applied" | "invalid" | "failed" | "too_long" | "not_in_plan";
export type ApplyResults = Partial<Record<"stageId" | "value" | "closeDate" | "task" | "note", ApplyStatus>>;

/** Which suggestions exist (and so get a pre-checked box). */
export function availableSuggestions(data: DealSummaryData): SuggestionKey[] {
  const u = data.updates;
  if (!data.deal || !u) return [];
  const keys: SuggestionKey[] = [];
  if (u.stage_id) keys.push("stage");
  if (u.value !== null) keys.push("value");
  if (u.expected_close_date) keys.push("date");
  if (u.task) keys.push("task");
  if (u.note) keys.push("note");
  return keys;
}

/** The apply request: ONLY the checked suggestions. */
export function buildApplyBody(data: DealSummaryData, checked: ReadonlySet<SuggestionKey>): Record<string, unknown> | null {
  const u = data.updates;
  if (!data.deal || !u) return null;
  const body: Record<string, unknown> = { deal_id: data.deal.id };
  if (checked.has("stage") && u.stage_id) body.stage_id = u.stage_id;
  if (checked.has("value") && u.value !== null) body.value = u.value;
  if (checked.has("date") && u.expected_close_date) body.expected_close_date = u.expected_close_date;
  if (checked.has("task") && u.task) body.task = u.task;
  if (checked.has("note") && u.note) body.note = u.note;
  return Object.keys(body).length > 1 ? body : null;
}

const RESULT_KEY: Record<SuggestionKey, keyof ApplyResults> = {
  stage: "stageId",
  value: "value",
  date: "closeDate",
  task: "task",
  note: "note",
};

function brDate(day: string | null): string {
  if (!day) return "—";
  const [y, m, d] = day.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

interface ResultProps {
  data: DealSummaryData;
  checked: ReadonlySet<SuggestionKey>;
  onToggle: (key: SuggestionKey) => void;
  onApply: () => void;
  onClose: () => void;
  applying: boolean;
  /** Set after "Aplicar": one status per item. */
  results: ApplyResults | null;
}

/** Presentational part (no hooks besides the language) — rendered in tests. */
export function DealSummaryResult({ data, checked, onToggle, onApply, onClose, applying, results }: ResultProps) {
  const { t } = useLanguage();
  const keys = availableSuggestions(data);
  const deal = data.deal;
  const u = data.updates;
  const stageName = (id: string | null) => data.stages.find((s) => s.id === id)?.name ?? "—";
  const currency = deal?.currency ?? undefined;

  const statusText = (key: SuggestionKey): string | null => {
    const s = results?.[RESULT_KEY[key]];
    if (!s) return null;
    return {
      applied: t("Applied to the deal"),
      invalid: t("Invalid, not applied"),
      failed: t("Could not apply"),
      too_long: t("Does not fit in the deal notes"),
      not_in_plan: t("Not included in your plan"),
    }[s];
  };

  const rows: { key: SuggestionKey; label: string; text: string }[] = [];
  if (u && deal) {
    if (u.stage_id) rows.push({ key: "stage", label: t("Deal stage"), text: `${deal.stage_name ?? "—"} → ${stageName(u.stage_id)}` });
    if (u.value !== null)
      rows.push({ key: "value", label: t("Deal value"), text: `${formatCurrency(deal.value, currency)} → ${formatCurrency(u.value, currency)}` });
    if (u.expected_close_date)
      rows.push({
        key: "date",
        label: t("Expected close date"),
        text: `${brDate(deal.expected_close_date)} → ${brDate(u.expected_close_date)}`,
      });
    if (u.task)
      rows.push({
        key: "task",
        label: t("Next-step task"),
        text: u.task.due_date ? `${u.task.title} (${brDate(u.task.due_date)})` : u.task.title,
      });
    if (u.note) rows.push({ key: "note", label: t("Save this summary as a note on the deal"), text: "" });
  }
  const done = results !== null;

  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs" data-testid="deal-summary-result">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">{t("AI summary")}</span>
        <button type="button" onClick={onClose} className="text-[11px] text-muted-foreground hover:text-foreground">
          {t("Close summary")}
        </button>
      </div>
      <dl className="mt-1.5 space-y-1.5 text-foreground">
        <div>
          <dt className="text-[10px] font-medium text-muted-foreground">{t("What the customer wants")}</dt>
          <dd>{data.summary.wants || "—"}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-medium text-muted-foreground">{t("Where it stands")}</dt>
          <dd>{data.summary.status || "—"}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-medium text-muted-foreground">{t("Suggested next step")}</dt>
          <dd>{data.summary.next_step || "—"}</dd>
        </div>
      </dl>

      {!deal ? (
        <p className="mt-2 text-[11px] text-muted-foreground">{t("This contact has no open deal, so only the summary is shown.")}</p>
      ) : (
        <div className="mt-2 border-t border-border pt-2">
          <p className="text-[10px] font-medium text-muted-foreground">
            {t("Update the deal")} “{deal.title}”
          </p>
          {rows.length === 0 ? (
            <p className="mt-1 text-[11px] text-muted-foreground">{t("No updates to suggest.")}</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {rows.map((r) => {
                const status = statusText(r.key);
                return (
                  <li key={r.key}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={checked.has(r.key)}
                        disabled={done || applying}
                        onChange={() => onToggle(r.key)}
                        className="mt-0.5 h-3.5 w-3.5 shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{r.label}</span>
                        {r.text && <span className="block break-words text-muted-foreground">{r.text}</span>}
                        {status && (
                          <span role="status" className="block text-[10px] font-medium text-primary">
                            {status}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {rows.length > 0 && !done && (
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">{t("Nothing changes until you click Apply.")}</span>
              <button
                type="button"
                onClick={onApply}
                disabled={applying || checked.size === 0 || keys.length === 0}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
              >
                {applying && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                {applying ? t("Applying…") : t("Apply selected")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface CardProps {
  conversationId: string | null;
  /** Agent+ (same gate as sending messages). */
  canWrite: boolean;
  /** After at least one item was applied: refresh deals + activity. */
  onApplied: () => void;
}

export function DealSummaryCard({ conversationId, canWrite, onApplied }: CardProps) {
  const { t } = useLanguage();
  const aiStatus = useAiStatus();
  const [state, setState] = useState<{ conversationId: string; data: DealSummaryData } | null>(null);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState<Set<SuggestionKey>>(new Set());
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<ApplyResults | null>(null);

  // Another conversation = another summary.
  useEffect(() => {
    setState(null);
    setResults(null);
  }, [conversationId]);

  if (!canWrite || !conversationId || !aiStatus?.available) return null;
  const data = state?.conversationId === conversationId ? state.data : null;

  async function summarize() {
    if (loading || !conversationId) return;
    setLoading(true);
    setResults(null);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/ai/deal-summary`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as (Partial<DealSummaryData> & { error?: string; code?: string }) | null;
      if (!res.ok || !body?.summary) {
        if (body?.code === "not_enabled" || body?.code === "no_key" || body?.code === "module_not_included") invalidateAiStatus();
        toast.error(
          res.status === 429
            ? t("Too many requests. Wait a minute and try again.")
            : body?.error
              ? t(body.error)
              : t("Could not summarize the conversation. Try again."),
        );
        return;
      }
      const next = body as DealSummaryData;
      setChecked(new Set(availableSuggestions(next)));
      setState({ conversationId, data: next });
    } catch {
      toast.error(t("Could not summarize the conversation. Try again."));
    } finally {
      setLoading(false);
    }
  }

  async function apply() {
    if (!data || applying) return;
    const body = buildApplyBody(data, checked);
    if (!body) return;
    setApplying(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/ai/deal-summary/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = (await res.json().catch(() => null)) as { results?: ApplyResults; error?: string } | null;
      if (!res.ok || !out?.results) {
        toast.error(out?.error ? t(out.error) : t("Could not apply the changes. Try again."));
        return;
      }
      setResults(out.results);
      if (Object.values(out.results).some((s) => s === "applied")) {
        toast.success(t("Deal updated"));
        onApplied();
      }
    } catch {
      toast.error(t("Could not apply the changes. Try again."));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="mt-2 px-1">
      {data ? (
        <DealSummaryResult
          data={data}
          checked={checked}
          onToggle={(k) =>
            setChecked((prev) => {
              const next = new Set(prev);
              if (next.has(k)) next.delete(k);
              else next.add(k);
              return next;
            })
          }
          onApply={() => void apply()}
          onClose={() => {
            setState(null);
            setResults(null);
          }}
          applying={applying}
          results={results}
        />
      ) : (
        <button
          type="button"
          onClick={() => void summarize()}
          disabled={loading}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline disabled:opacity-60"
        >
          {loading && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
          {loading ? t("Summarizing…") : t("Summarize with AI")}
        </button>
      )}
    </div>
  );
}
