"use client";

import { useCallback, useMemo } from "react";

import { useLanguage } from "@/hooks/use-language";
import { formatCurrency } from "@/lib/currency";
import { formatSeconds } from "@/lib/dashboard/team-metrics";
import { fetchTeamReport, sortTeam, winRatePct } from "@/lib/indicators/reports";
import { createClient } from "@/lib/supabase/client";
import type { ReportPeriod } from "@/lib/support/reports";

import { useReportFetch } from "./use-report-fetch";

const HEADING = "text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground";
const TH = "sticky top-0 z-10 bg-background pb-2 pr-4 font-normal";

/** "Equipe": one row per member (team_report(), migration 111). Every member of the account sees the whole table. */
export function TeamSection({
  accountId,
  period,
  periodOk,
  timezone,
  currency,
  members,
}: {
  accountId: string | null;
  period: ReportPeriod;
  periodOk: boolean;
  timezone: string;
  currency: string;
  /** user_id -> name. */
  members: Map<string, string>;
}) {
  const { t, language } = useLanguage();
  const load = useCallback(
    () => fetchTeamReport(createClient(), accountId ?? "", period, timezone),
    [accountId, period, timezone],
  );
  const { data, failed, loading, retry } = useReportFetch(!!accountId && periodOk, load);
  const nameOf = useCallback((id: string) => members.get(id) ?? "?", [members]);
  const rows = useMemo(() => (data ? sortTeam(data, nameOf) : null), [data, nameOf]);

  return (
    <section className="space-y-3 border-t border-border pt-6" data-testid="reports-team-performance">
      <h2 className={HEADING}>{t("Team performance")}</h2>
      <div aria-live="polite">
        {!periodOk ? null : failed ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {t("Could not load the team performance.")}{" "}
            <button type="button" onClick={retry} className="text-foreground underline underline-offset-2">
              {t("Try again")}
            </button>
          </p>
        ) : !rows ? (
          <p className="text-sm text-muted-foreground">{t("Loading...")}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="team-empty">
            {t("No team members in this account.")}
          </p>
        ) : (
          <div className={loading ? "opacity-60" : undefined} aria-busy={loading}>
            <div className="max-h-[26rem] overflow-auto">
              <table className="w-full min-w-[56rem] text-sm" data-testid="team-table">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th scope="col" className={TH}>{t("Team member")}</th>
                    <th scope="col" className={`${TH} text-right`}>{t("Conversations handled")}</th>
                    <th scope="col" className={`${TH} text-right`}>{t("Conversations resolved")}</th>
                    <th scope="col" className={`${TH} text-right`}>{t("First response time")}</th>
                    <th scope="col" className={`${TH} text-right`}>{t("Tasks completed")}</th>
                    <th scope="col" className={`${TH} text-right`}>{t("Open conversations")}</th>
                    <th scope="col" className={`${TH} text-right`}>{t("Deals won")}</th>
                    <th scope="col" className={`${TH} text-right`}>{t("Value sold")}</th>
                    <th scope="col" className={`${TH} pr-0 text-right`}>{t("Win rate")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border border-t border-border">
                  {rows.map((r) => {
                    const rate = winRatePct(r.dealsWon, r.dealsLost);
                    return (
                      <tr key={r.userId}>
                        <th scope="row" className="max-w-56 truncate py-2 pr-4 text-left font-normal text-foreground" data-no-translate>
                          {nameOf(r.userId)}
                        </th>
                        <td className="py-2 pr-4 text-right tabular-nums">{r.handled}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{r.resolved}</td>
                        <td className="py-2 pr-4 text-right tabular-nums" data-no-translate>
                          {formatSeconds(r.firstResponseAvgSeconds)}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">{r.tasksCompleted}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{r.openAssigned}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{r.dealsWon}</td>
                        <td className="py-2 pr-4 text-right tabular-nums" data-no-translate>
                          {formatCurrency(r.wonValue, currency)}
                        </td>
                        <td className="py-2 text-right tabular-nums" data-no-translate>
                          {rate == null ? "—" : `${rate.toLocaleString(language)}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {t("Deals are counted for the person responsible for the deal, by the day it was won or lost. Open conversations are the ones open right now.")}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
