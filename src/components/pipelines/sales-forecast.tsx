"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, TrendingUp } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";
import { formatCurrency, formatMoney } from "@/lib/currency";
import { safeTimezone } from "@/lib/calendar/range";
import { currentMonth } from "@/lib/sales-goals/pace";
import { buildForecastColumns, dealsOfColumn } from "@/lib/sales-forecast/columns";
import { fetchSalesForecast, loadForecastDeals, loadForecastStages } from "@/lib/sales-forecast/data";
import type { ForecastColumn, ForecastRow, SellerFilter } from "@/lib/sales-forecast/types";
import type { Deal, Pipeline, PipelineStage } from "@/types";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DealDrawer } from "./deal-drawer";

const MONTHS = 3;
const NO_DATE = "nodate";
const SELECT_CLASS =
  "h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

// Short labels live here (not in the global pt-BR dictionary): the DOM
// translator matches exact text nodes app-wide, so one-word keys such as
// "Won" or "Value" would leak into every other screen.
const COPY: Record<Language, Record<string, string>> = {
  "pt-BR": {
    pipeline: "Funil", allPipelines: "Todos os funis", salesperson: "Vendedor", allSellers: "Todos os vendedores",
    noSeller: "Sem responsável", noDate: "Sem data", thisMonth: "Este mês", won: "Ganho", expected: "Previsto",
    bestCase: "Melhor caso", openDeals: "Negócios abertos", pastOne: "negócio com data vencida",
    pastMany: "negócios com data vencida", inOther: "em outra moeda", dealsIn: "Negócios de", retry: "Tentar novamente",
    colDeal: "Negócio", colStage: "Etapa", colChance: "Chance", colValue: "Valor", colWeighted: "Valor ponderado",
    colDate: "Data", dealOne: "negócio", dealMany: "negócios", inWord: "em", datePassed: "data vencida", wonTag: "ganho", otherCurrency: "outra moeda",
  },
  "en-US": {
    pipeline: "Pipeline", allPipelines: "All pipelines", salesperson: "Salesperson", allSellers: "All salespeople",
    noSeller: "No salesperson", noDate: "No date", thisMonth: "This month", won: "Won", expected: "Expected",
    bestCase: "Best case", openDeals: "Open deals", pastOne: "deal past its date",
    pastMany: "deals past their date", inOther: "in another currency", dealsIn: "Deals in", retry: "Try again",
    colDeal: "Deal", colStage: "Stage", colChance: "Chance", colValue: "Value", colWeighted: "Weighted value",
    colDate: "Date", dealOne: "deal", dealMany: "deals", inWord: "in", datePassed: "date passed", wonTag: "won", otherCurrency: "other currency",
  },
};

interface Seller {
  id: string;
  name: string;
}

interface SalesForecastProps {
  /** Pipeline the board is showing; "this pipeline" in the scope filter. */
  pipeline: Pipeline;
}

/**
 * "Previsão" — the month by month forecast from sales_forecast() (migration
 * 106): current month and the next two plus the deals without a date, by
 * seller. Clicking a column lists the deals behind its numbers; each opens the
 * deal drawer. Money is in the account currency only.
 */
export function SalesForecast({ pipeline }: SalesForecastProps) {
  const { t, language } = useLanguage();
  const copy = COPY[language] ?? COPY["pt-BR"];
  const { accountId, defaultCurrency, preferences } = useAuth();
  const timezone = safeTimezone(preferences.business_hours?.timezone);
  const currency = defaultCurrency || "BRL";
  const current = currentMonth(timezone);

  const [scope, setScope] = useState<"current" | "all">("current");
  const pipelineId = scope === "all" ? null : pipeline.id;
  const [seller, setSeller] = useState<string>("all");
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // The deal the drawer shows: kept as a snapshot so a change (stage, status) never unmounts it mid-edit.
  const [drawerSnapshot, setDrawerSnapshot] = useState<Deal | null>(null);

  // Stale-while-revalidate: rows stay on screen while a change is re-read (`tick`).
  // They are dropped (skeleton) only when the scope / month they were loaded for changes.
  const scopeKey = `${accountId}|${pipelineId ?? "all"}|${current}`;
  const [data, setData] = useState<{ scopeKey: string; tick: number; rows: ForecastRow[]; failed: boolean } | null>(null);
  const rows = data?.scopeKey === scopeKey ? data.rows : null;
  const failed = data?.scopeKey === scopeKey && data.failed;

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    createClient()
      .from("profiles")
      .select("id, full_name")
      .eq("account_id", accountId)
      .then(({ data: list, error }) => {
        if (cancelled || error || !list) return;
        setSellers(
          (list as { id: string; full_name: string | null }[])
            .map((p) => ({ id: p.id, name: p.full_name || "" }))
            .sort((a, b) => a.name.localeCompare(b.name, language)),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, language]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    fetchSalesForecast(createClient(), accountId, pipelineId, current, MONTHS)
      .then((r) => {
        if (!cancelled) setData({ scopeKey, tick, rows: r, failed: false });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[pipelines] sales forecast failed:", err);
        // A failed refresh keeps what is on screen; only a first load shows the error.
        setData((prev) => (prev?.scopeKey === scopeKey && !prev.failed ? { ...prev, tick } : { scopeKey, tick, rows: [], failed: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, pipelineId, current, scopeKey, tick]);

  // The deals behind the clicked column only (paged), read when it is opened and re-read after a change.
  const dealsScope = `${scopeKey}|${selected}`;
  const [dealData, setDealData] = useState<{ scope: string; deals: Deal[]; stages: PipelineStage[]; failed: boolean } | null>(null);
  const dealsReady = dealData?.scope === dealsScope ? dealData : null;
  useEffect(() => {
    if (!accountId || selected === null) return;
    let cancelled = false;
    const db = createClient();
    const month = selected === NO_DATE ? null : selected;
    (async () => {
      try {
        const [deals, stages] = await Promise.all([
          loadForecastDeals(db, accountId, pipelineId, { month, currentMonth: current, timezone }),
          loadForecastStages(db, accountId, pipelineId),
        ]);
        if (!cancelled) setDealData({ scope: dealsScope, deals, stages, failed: false });
      } catch (err) {
        if (cancelled) return;
        console.error("[pipelines] forecast deals failed:", err);
        setDealData((prev) => (prev?.scope === dealsScope && !prev.failed ? prev : { scope: dealsScope, deals: [], stages: [], failed: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, pipelineId, current, timezone, dealsScope, selected, tick]);

  const filter = useMemo<SellerFilter>(() => (seller === "all" ? "all" : seller === "none" ? "none" : { id: seller }), [seller]);
  const columns = useMemo(() => buildForecastColumns(rows ?? [], current, MONTHS, filter), [rows, current, filter]);
  const hasAnything = columns.some((c) => c.openCount > 0 || c.won > 0 || c.otherCurrencyCount > 0);

  const monthLabel = useCallback(
    (month: string) => {
      const [y, m] = month.split("-").map(Number);
      const s = new Intl.DateTimeFormat(language, { month: "long", year: "numeric", timeZone: "UTC" }).format(Date.UTC(y, m - 1, 1));
      return s.charAt(0).toUpperCase() + s.slice(1);
    },
    [language],
  );
  const columnId = (c: ForecastColumn) => c.month ?? NO_DATE;
  const selectedColumn = columns.find((c) => columnId(c) === selected) ?? null;

  const listed = useMemo(() => {
    if (!dealsReady || !selectedColumn) return [];
    return dealsOfColumn(dealsReady.deals, dealsReady.stages, selectedColumn.month, { currentMonth: current, timezone, currency, seller: filter });
  }, [dealsReady, selectedColumn, current, timezone, currency, filter]);

  const drawerDeal = drawerSnapshot ? dealsReady?.deals.find((d) => d.id === drawerSnapshot.id) ?? drawerSnapshot : null;
  const drawerStages = drawerDeal ? (dealsReady?.stages ?? []).filter((s) => s.pipeline_id === drawerDeal.pipeline_id) : [];
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const moveDeal = useCallback(
    async (dealId: string, stageId: string) => {
      const { error } = await createClient()
        .from("deals")
        .update({ stage_id: stageId, updated_at: new Date().toISOString() })
        .eq("id", dealId);
      if (error) toast.error(t("Failed to move deal"));
      reload();
    },
    [reload, t],
  );

  const chancePct = useMemo(() => new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 0 }), [language]);
  const money = (n: number) => formatCurrency(n, currency);
  const dateLabel = (d: { date: string | null; deal: Deal }) => {
    if (!d.date) return "—";
    if (d.deal.status === "won") {
      return new Intl.DateTimeFormat(language, { dateStyle: "short", timeZone: timezone }).format(new Date(d.date));
    }
    const [y, m, day] = d.date.slice(0, 10).split("-");
    return language === "pt-BR" ? `${day}/${m}/${y}` : `${m}/${day}/${y}`;
  };

  const loading = rows === null;
  const headingId = "sales-forecast-heading";

  return (
    <section aria-labelledby={headingId} className="space-y-4" data-no-translate>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <TrendingUp className="size-4 text-primary" aria-hidden />
            {t("Sales forecast")}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("Won so far plus open deals weighted by the chance of their stage, by expected close month.")}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <label htmlFor="forecast-scope" className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {copy.pipeline}
            </label>
            <select
              id="forecast-scope"
              className={SELECT_CLASS}
              value={scope}
              onChange={(e) => {
                setScope(e.target.value as "current" | "all");
                setSelected(null);
                setDrawerSnapshot(null);
              }}
            >
              <option value="current">{pipeline.name}</option>
              <option value="all">{copy.allPipelines}</option>
            </select>
          </div>
          <div className="grid gap-1">
            <label htmlFor="forecast-seller" className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {copy.salesperson}
            </label>
            <select id="forecast-seller" className={SELECT_CLASS} value={seller} onChange={(e) => setSeller(e.target.value)}>
              <option value="all">{copy.allSellers}</option>
              <option value="none">{copy.noSeller}</option>
              {sellers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || t("Unnamed salesperson")}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true" role="status" aria-label={t("Loading the forecast…")}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-3 rounded-xl border border-border bg-card p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-7 w-32" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
            </div>
          ))}
        </div>
      ) : failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
          <span>{t("Could not load the forecast.")}</span>
          <Button size="sm" variant="outline" onClick={reload}>
            {copy.retry}
          </Button>
        </div>
      ) : !hasAnything ? (
        <EmptyState
          icon={TrendingUp}
          title={t("Nothing to forecast yet")}
          hint={t("Open deals with an expected close date and deals won this month show up here.")}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {columns.map((c) => {
            const id = columnId(c);
            const isSelected = selected === id;
            const title = c.month ? monthLabel(c.month) : copy.noDate;
            const other = c.otherCurrencyCount;
            return (
              <li key={id}>
                <div
                  className={cn(
                    "relative flex h-full flex-col rounded-xl border bg-card p-4 transition-colors motion-reduce:transition-none",
                    isSelected ? "border-primary" : "border-border hover:border-primary/50",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    {/* The button holds text only; its ::after stretches over the whole card. */}
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      aria-controls="forecast-deals"
                      onClick={() => {
                        setSelected(isSelected ? null : id);
                        setDrawerSnapshot(null);
                      }}
                      className="rounded text-[11px] font-semibold uppercase tracking-wide text-muted-foreground after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
                    >
                      {title}
                    </button>
                    {c.month === current && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">{copy.thisMonth}</span>}
                  </div>
                  {c.month ? (
                    <>
                      <span className="mt-2 text-2xl font-semibold tabular-nums text-foreground">{money(c.forecast)}</span>
                      <span className="text-xs text-muted-foreground">{t("Month forecast")}</span>
                    </>
                  ) : (
                    <>
                      <span className="mt-2 text-2xl font-semibold tabular-nums text-foreground">{money(c.bestCase)}</span>
                      <span className="text-xs text-muted-foreground">{t("Open value without a date")}</span>
                    </>
                  )}
                  <dl className="mt-3 space-y-1 text-xs tabular-nums">
                    {c.month && <Line label={copy.won} value={money(c.won)} />}
                    <Line label={copy.expected} value={money(c.expected)} />
                    {c.month && <Line label={copy.bestCase} value={money(c.bestCase)} />}
                    <Line label={copy.openDeals} value={String(c.openCount)} />
                  </dl>
                  {c.overdueCount > 0 && (
                    <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                      <CalendarClock className="size-3.5" aria-hidden />
                      {c.overdueCount} {c.overdueCount === 1 ? copy.pastOne : copy.pastMany} · {money(c.overdueValue)}
                    </span>
                  )}
                  {other > 0 && (
                    <span className="mt-1 text-xs text-muted-foreground">
                      {other} {copy.inOther}
                    </span>
                  )}
                  {!c.month && <span className="mt-2 text-xs text-muted-foreground">{t("Fill in the expected close date so these deals enter the forecast.")}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div id="forecast-deals">
        {selectedColumn && (
          <div className="rounded-xl border border-border bg-card">
            <h3 className="border-b border-border px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {copy.dealsIn} {selectedColumn.month ? monthLabel(selectedColumn.month) : copy.noDate}
            </h3>
            {!dealsReady ? (
              <div className="space-y-2 p-4" role="status" aria-busy="true" aria-label={t("Loading deals…")}>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-11/12" />
              </div>
            ) : dealsReady.failed ? (
              <p role="alert" className="p-4 text-sm text-muted-foreground">
                {t("Could not load the deals.")}
              </p>
            ) : listed.length === 0 ? (
              <p role="status" className="p-4 text-sm text-muted-foreground">{t("No deals in this column.")}</p>
            ) : (
              <>
              <p role="status" className="px-4 pt-3 text-xs text-muted-foreground">
                {listed.length} {listed.length === 1 ? copy.dealOne : copy.dealMany} {copy.inWord} {selectedColumn.month ? monthLabel(selectedColumn.month) : copy.noDate}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-left text-xs">
                  <caption className="sr-only">{t("Deals behind the forecast numbers")}</caption>
                  <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-4 py-2 font-medium">{copy.colDeal}</th>
                      <th scope="col" className="px-2 py-2 font-medium">{copy.colStage}</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">{copy.colChance}</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">{copy.colValue}</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">{copy.colWeighted}</th>
                      <th scope="col" className="px-4 py-2 font-medium">{copy.colDate}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/70">
                    {listed.map((d) => (
                      <tr key={d.deal.id}>
                        <td className="max-w-64 px-4 py-2">
                          <button
                            type="button"
                            onClick={() => setDrawerSnapshot(d.deal)}
                            className="max-w-full truncate rounded text-left font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {d.deal.title}
                          </button>
                          {d.overdue && <span className="ml-2 text-amber-700 dark:text-amber-400">{copy.datePassed}</span>}
                          {d.deal.status === "won" && <span className="ml-2 text-emerald-700 dark:text-emerald-400">{copy.wonTag}</span>}
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">{d.stageName}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{d.deal.status === "won" ? chancePct.format(1) : chancePct.format(d.chance / 100)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {d.otherCurrency ? <span className="text-muted-foreground">{copy.otherCurrency}</span> : formatMoney(Number(d.deal.value || 0), currency)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{d.otherCurrency ? "—" : formatMoney(d.weighted, currency)}</td>
                        <td className="px-4 py-2 tabular-nums text-muted-foreground">{dateLabel(d)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </div>
        )}
      </div>

      <DealDrawer
        open={!!drawerDeal}
        onOpenChange={(next) => {
          if (!next) setDrawerSnapshot(null);
        }}
        deal={drawerDeal}
        pipelineId={drawerDeal?.pipeline_id ?? pipeline.id}
        stages={drawerStages}
        onChanged={reload}
        onDealMoved={moveDeal}
      />
    </section>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}
