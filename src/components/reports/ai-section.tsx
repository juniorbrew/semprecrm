"use client";

import { useCallback } from "react";
import Link from "next/link";

import { useLanguage } from "@/hooks/use-language";
import { formatMoney } from "@/lib/currency";
import { aiIsEmpty, fetchAiReport } from "@/lib/indicators/reports";
import { createClient } from "@/lib/supabase/client";
import type { ReportPeriod } from "@/lib/support/reports";

import { useReportFetch } from "./use-report-fetch";

const HEADING = "text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground";

const FEATURE_LABEL: Record<string, string> = {
  auto_reply: "Automatic reply",
  suggest_reply: "Reply suggestion",
  deal_summary: "Deal summary",
  triage: "Conversation triage",
  memory_extract: "Customer memory",
  agent_test: "Agent test",
};

/** "IA": what the AI did in the period (ai_report(), migration 111). The cost is the company's own key, in dollars. */
export function AiSection({
  accountId,
  period,
  periodOk,
  timezone,
}: {
  accountId: string | null;
  period: ReportPeriod;
  periodOk: boolean;
  timezone: string;
}) {
  const { t, language } = useLanguage();
  const load = useCallback(
    () => fetchAiReport(createClient(), accountId ?? "", period, timezone),
    [accountId, period, timezone],
  );
  const { data, failed, loading, retry } = useReportFetch(!!accountId && periodOk, load);
  const usd = (cents: number) => formatMoney(cents / 100, "USD");
  const totalCents = data?.costByFeature?.reduce((sum, c) => sum + c.costCents, 0) ?? 0;

  return (
    <section className="space-y-3 border-t border-border pt-6" data-testid="reports-ai">
      <h2 className={HEADING}>{t("AI results")}</h2>
      <div aria-live="polite">
        {!periodOk ? null : failed ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {t("Could not load the AI results.")}{" "}
            <button type="button" onClick={retry} className="text-foreground underline underline-offset-2">
              {t("Try again")}
            </button>
          </p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">{t("Loading...")}</p>
        ) : aiIsEmpty(data) ? (
          <p className="text-sm text-muted-foreground" data-testid="ai-empty">
            {t("The AI is not turned on for this account.")}{" "}
            <Link href="/settings?tab=ai" className="text-foreground underline underline-offset-2">
              {t("Set up the AI in Settings")}
            </Link>
          </p>
        ) : (
          <div className={loading ? "space-y-4 opacity-60" : "space-y-4"} aria-busy={loading}>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4" data-testid="ai-numbers">
              <Stat label={t("Conversations handled by the AI")} value={data.attended.toLocaleString(language)} />
              <Stat
                label={t("Handed to a person")}
                value={data.handedOff.toLocaleString(language)}
                hint={
                  data.topReason ? (
                    <>
                      {t("Most common reason")}: <span data-no-translate>{data.topReason}</span>
                    </>
                  ) : null
                }
              />
              <Stat label={t("Resolved without a person")} value={data.resolvedWithoutPerson.toLocaleString(language)} />
              <Stat label={t("Messages sent by the AI")} value={data.messages.toLocaleString(language)} />
            </dl>
            {data.costByFeature && (
              <div data-testid="ai-cost" className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  {t("Cost in the period")}:{" "}
                  <span className="font-medium tabular-nums text-foreground" data-no-translate>
                    {usd(totalCents)}
                  </span>
                </p>
                {data.costByFeature.length > 0 && (
                  <ul className="space-y-1 text-xs">
                    {data.costByFeature.map((c) => (
                      <li key={c.feature} className="flex items-center justify-between gap-3 sm:max-w-sm">
                        <span>{FEATURE_LABEL[c.feature] ? t(FEATURE_LABEL[c.feature]) : c.feature}</span>
                        <span className="tabular-nums" data-no-translate>
                          {usd(c.costCents)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  {t("Paid to the AI provider with your own key, not to SempreCRM.")}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums text-foreground" data-no-translate>
        {value}
      </dd>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
