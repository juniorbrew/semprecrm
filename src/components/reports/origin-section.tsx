"use client";

import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";

import { OriginNameText } from "@/components/origins/origin-line";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/hooks/use-language";
import { formatCurrency } from "@/lib/currency";
import { channelLabel, type OriginChannel, type OriginReportRow } from "@/lib/lead-origins";
import {
  fetchOriginReport,
  originReportToCsv,
  REPORT_CHANNELS,
  rowOriginName,
  topSellingOrigins,
} from "@/lib/lead-origins/report";
import { createClient } from "@/lib/supabase/client";
import type { ReportPeriod } from "@/lib/support/reports";

const HEADING = "text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground";
const TH = "sticky top-0 z-10 bg-background pb-2 pr-4 font-normal";
const SELECT = "h-7 max-w-44 rounded-full border border-border bg-transparent px-3 text-xs text-foreground";

interface Pipeline {
  id: string;
  name: string;
}

/**
 * "Origem dos clientes": new customers, deals, won deals and value per origin (ad, campaign,
 * site, direct). The numbers come from origin_report() (migration 109); only the period of the
 * page and two filters (channel, pipeline) are chosen here. Nothing is summed in the browser.
 */
export function OriginSection({
  period,
  periodOk,
  timezone,
  currency,
  enabled = true,
}: {
  period: ReportPeriod;
  periodOk: boolean;
  timezone: string;
  currency: string;
  enabled?: boolean;
}) {
  const { t, language } = useLanguage();
  const [channel, setChannel] = useState<OriginChannel | "">("");
  const [pipelineId, setPipelineId] = useState("");
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [rows, setRows] = useState<OriginReportRow[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    createClient()
      .from("pipelines")
      .select("id, name")
      .order("name", { ascending: true })
      .then(({ data, error }) => {
        if (!cancelled && !error) setPipelines((data ?? []) as Pipeline[]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !periodOk) return;
    let cancelled = false;
    fetchOriginReport(createClient(), period, timezone, { channel: channel || null, pipelineId: pipelineId || null })
      .then((data) => {
        if (cancelled) return;
        setRows(data);
        setState("ready");
      })
      .catch((err) => {
        console.error("[reports] origin report failed:", err instanceof Error ? err.message : "error");
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, period, periodOk, timezone, channel, pipelineId, tick]);

  const top = useMemo(() => topSellingOrigins(rows ?? [], 10), [rows]);
  const maxWon = Math.max(0, ...top.map((r) => r.won_value));
  const money = (n: number) => formatCurrency(n, currency);

  function exportCsv() {
    if (!rows) return;
    const blob = new Blob([originReportToCsv(period, rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `origem-dos-clientes-${period.from}-${period.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function pick(next: () => void) {
    setState("loading");
    next();
  }

  return (
    <section className="space-y-3 border-t border-border pt-6" data-testid="reports-origin">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className={HEADING}>{t("Customer origins")}</h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            aria-label={t("Filter by origin channel")}
            value={channel}
            onChange={(e) => pick(() => setChannel(e.target.value as OriginChannel | ""))}
            className={SELECT}
            data-testid="origin-channel"
          >
            <option value="">{t("All channels")}</option>
            {REPORT_CHANNELS.map((c) => (
              <option key={c} value={c} data-no-translate>
                {channelLabel(c, language)}
              </option>
            ))}
          </select>
          <select
            aria-label={t("Filter by pipeline")}
            value={pipelineId}
            onChange={(e) => pick(() => setPipelineId(e.target.value))}
            className={SELECT}
            data-testid="origin-pipeline"
          >
            <option value="">{t("All pipelines")}</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id} data-no-translate>
                {p.name}
              </option>
            ))}
          </select>
          <Button variant="ghost" size="sm" onClick={exportCsv} disabled={!rows || rows.length === 0}>
            <Download aria-hidden />
            {t("Export CSV")}
          </Button>
        </div>
      </div>

      <div aria-live="polite">
        {!periodOk ? null : state === "error" ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {t("Could not load the customer origins.")}{" "}
            <button
              type="button"
              onClick={() => {
                setState("loading");
                setTick((n) => n + 1);
              }}
              className="text-foreground underline underline-offset-2"
            >
              {t("Try again")}
            </button>
          </p>
        ) : !rows ? (
          <p className="text-sm text-muted-foreground">{t("Loading...")}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="origin-empty">
            {t("No customers or deals in this period.")}
          </p>
        ) : (
          <div className={state === "loading" ? "space-y-6 opacity-60" : "space-y-6"}>
            {top.length > 0 && (
              <figure data-testid="origin-chart" className="space-y-1.5">
                <figcaption className="text-xs text-muted-foreground">{t("Origins that sold the most")}</figcaption>
                <ul className="space-y-1">
                  {top.map((r, i) => (
                    <li key={`${r.origin_type}|${r.channel}|${r.name}|${r.source}|${i}`} className="flex items-center gap-2 text-xs">
                      <span className="w-48 shrink-0 truncate sm:w-64">
                        <OriginNameText n={rowOriginName(r)} />
                      </span>
                      <span aria-hidden className="h-2 min-w-1 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-primary/70"
                          style={{ width: `${maxWon > 0 ? Math.max(3, Math.round((r.won_value / maxWon) * 100)) : 0}%` }}
                        />
                      </span>
                      <span className="w-24 shrink-0 text-right tabular-nums" data-no-translate>
                        {money(r.won_value)}
                      </span>
                    </li>
                  ))}
                </ul>
              </figure>
            )}
            <div className="max-h-[26rem] overflow-auto">
              <table className="w-full min-w-[44rem] text-sm" data-testid="origin-table">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th scope="col" className={TH}>{t("Customer origin")}</th>
                    <th scope="col" className={`${TH} text-right`}>{t("New customers")}</th>
                    <th scope="col" className={`${TH} text-right`}>{t("Deals created")}</th>
                    <th scope="col" className={`${TH} text-right`}>{t("Deals won")}</th>
                    <th scope="col" className={`${TH} text-right`}>{t("Won value")}</th>
                    <th scope="col" className={`${TH} text-right`}>{t("Conversion rate")}</th>
                    <th scope="col" className={`${TH} pr-0 text-right`}>{t("Average ticket")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border border-t border-border">
                  {rows.map((r, i) => (
                    <tr key={`${r.origin_type}|${r.channel}|${r.name}|${r.source}|${i}`}>
                      <th scope="row" className="max-w-72 py-2 pr-4 text-left font-normal text-foreground">
                        <OriginNameText n={rowOriginName(r)} />
                      </th>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.customers}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.deals_created}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.deals_won}</td>
                      <td className="py-2 pr-4 text-right tabular-nums" data-no-translate>
                        {money(r.won_value)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums" data-no-translate>
                        {r.deals_created > 0 ? `${r.conversion_pct.toLocaleString(language)}%` : "—"}
                      </td>
                      <td className="py-2 text-right tabular-nums" data-no-translate>
                        {r.deals_won > 0 ? money(r.avg_ticket) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
