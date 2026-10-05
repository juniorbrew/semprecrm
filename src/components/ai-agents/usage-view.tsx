"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { SETTINGS_HEADING } from "@/components/settings/settings-group";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import type { UsageBreakdown, UsageBucket } from "@/lib/ai/usage-breakdown";
import { cn } from "@/lib/utils";

interface UsageResponse extends UsageBreakdown {
  month: string;
  truncated: boolean;
}

interface SettingsResponse {
  settings: { monthly_budget_cents: number };
  usage: { calls: number; errors: number; inputTokens: number; outputTokens: number; costCents: number };
}

const FEATURE_LABELS: Record<string, string> = {
  auto_reply: "Resposta automática",
  suggest_reply: "Sugestão de resposta",
  memory_extract: "Memória do contato",
  agent_test: "Teste de agente",
};

/** Share of the highest value, for the bars (never below 2% so a non-zero day shows). */
export function barPct(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.max(2, Math.round((value / max) * 100));
}

function Table({
  title,
  rows,
  label,
  money,
  num,
}: {
  title: string;
  rows: UsageBucket[];
  label: (key: string) => string;
  money: Intl.NumberFormat;
  num: Intl.NumberFormat;
}) {
  const { t } = useLanguage();
  return (
    <section className="space-y-1 border-t border-border pt-4">
      <h2 className={SETTINGS_HEADING}>{title}</h2>
      {rows.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t("Sem uso neste mês.")}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="sr-only">
            <tr>
              <th>{title}</th>
              <th>{t("Chamadas")}</th>
              <th>{t("Custo estimado")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="py-2 pr-3 text-foreground" data-no-translate>
                  {label(r.key)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground" data-no-translate>
                  {num.format(r.calls)}
                  {r.errors > 0 ? ` · ${num.format(r.errors)} ${t("com erro")}` : ""}
                </td>
                <td className="py-2 text-right tabular-nums text-foreground" data-no-translate>
                  {money.format(r.costCents / 100)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Detail of this month's AI spend (admin+). Totals and budget come from /api/ai/settings. */
export function UsageView() {
  const { t, language } = useLanguage();
  const { canManageMembers, profileLoading } = useAuth();
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [totals, setTotals] = useState<SettingsResponse | null>(null);
  const [failed, setFailed] = useState(false);

  const money = useMemo(
    () => new Intl.NumberFormat(language, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    [language],
  );
  const num = useMemo(() => new Intl.NumberFormat(language), [language]);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [u, s] = await Promise.all([
        fetch("/api/ai/usage", { cache: "no-store" }),
        fetch("/api/ai/settings", { cache: "no-store" }),
      ]);
      if (!u.ok || !s.ok) throw new Error("load failed");
      setUsage((await u.json()) as UsageResponse);
      setTotals((await s.json()) as SettingsResponse);
    } catch (err) {
      console.error("[ai-usage] load failed:", err);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!profileLoading && canManageMembers) void load();
  }, [profileLoading, canManageMembers, load]);

  if (!profileLoading && !canManageMembers) {
    return <p className="p-6 text-sm text-muted-foreground">{t("Só administradores veem o consumo da IA.")}</p>;
  }
  if (failed) {
    return (
      <p role="alert" className="p-6 text-sm text-destructive">
        {t("Não foi possível carregar o consumo.")}{" "}
        <button type="button" className="underline" onClick={() => void load()}>
          {t("Tentar de novo")}
        </button>
      </p>
    );
  }
  if (!usage || !totals) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden /> {t("Carregando")}
      </div>
    );
  }

  const budget = totals.settings.monthly_budget_cents;
  const spent = totals.usage.costCents;
  const usedPct = budget > 0 ? Math.min(100, (spent / budget) * 100) : spent > 0 ? 100 : 0;
  const maxDay = Math.max(0, ...usage.byDay.map((d) => d.costCents));

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-6 sm:px-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-base font-semibold text-foreground">
            {t("Uso e orçamento")}{" "}
            <span className="font-normal text-muted-foreground" data-no-translate>
              ({usage.month})
            </span>
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("Estimado pelos preços de tabela do provedor; a fatura dele é a referência.")}
          </p>
        </div>
        <Link href="/settings?tab=ai" className="shrink-0 text-sm text-primary underline-offset-4 hover:underline">
          {t("Ajustar orçamento")}
        </Link>
      </header>

      <section className="space-y-3">
        <p className="text-sm text-foreground" data-no-translate>
          <span className="font-medium tabular-nums">{money.format(spent / 100)}</span>{" "}
          <span className="text-muted-foreground">
            {t("de")} {money.format(budget / 100)}
          </span>
        </p>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={t("Orçamento usado")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(usedPct)}
        >
          <div
            className={cn("h-full rounded-full", usedPct >= 100 ? "bg-destructive" : usedPct >= 80 ? "bg-amber-500" : "bg-primary")}
            style={{ width: `${usedPct}%` }}
          />
        </div>
        <p className="text-sm text-muted-foreground" data-no-translate>
          {num.format(totals.usage.calls)} {t("chamadas")} · {num.format(totals.usage.errors)} {t("com erro")} ·{" "}
          {num.format(totals.usage.inputTokens)} / {num.format(totals.usage.outputTokens)} {t("tokens (entrada / saída)")}
        </p>
      </section>

      <section className="space-y-2 border-t border-border pt-4">
        <h2 className={SETTINGS_HEADING}>{t("Por dia")}</h2>
        {usage.byDay.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">{t("Sem uso neste mês.")}</p>
        ) : (
          <ul className="space-y-1">
            {usage.byDay.map((d) => (
              <li key={d.key} className="flex items-center gap-3 text-sm" data-no-translate>
                <span className="w-20 shrink-0 tabular-nums text-muted-foreground">
                  {d.key.slice(8)}/{d.key.slice(5, 7)}
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full bg-primary" style={{ width: `${barPct(d.costCents, maxDay)}%` }} />
                </span>
                <span className="w-20 shrink-0 text-right tabular-nums text-foreground">{money.format(d.costCents / 100)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Table title={t("Por função")} rows={usage.byFeature} label={(k) => t(FEATURE_LABELS[k] ?? k)} money={money} num={num} />
      <Table title={t("Por modelo")} rows={usage.byModel} label={(k) => k} money={money} num={num} />

      {usage.truncated ? (
        <p className="text-sm text-muted-foreground">{t("Mostrando só as primeiras 20.000 chamadas do mês.")}</p>
      ) : null}
    </div>
  );
}
