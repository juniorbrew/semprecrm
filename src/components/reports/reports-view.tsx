"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { useConversationCategories } from "@/hooks/use-conversation-categories";
import { useLanguage } from "@/hooks/use-language";
import { useTeams } from "@/hooks/use-teams";
import { createClient } from "@/lib/supabase/client";
import {
  DEFAULT_TIMEZONE,
  fetchSupportBacklog,
  fetchSupportReport,
  isValidPeriod,
  lastDays,
  reportsCopy,
  type BacklogRow,
  type ReportChannel,
  type ReportFilters,
  type ReportPeriod,
  type ReportRow,
} from "@/lib/support/reports";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { BacklogSection, GroupSection, OverviewSection, PrioritySection } from "./report-sections";

type Preset = 7 | 30 | 90 | "custom";

interface Data {
  all: ReportRow[];
  category: ReportRow[];
  team: ReportRow[];
  agent: ReportRow[];
  priority: ReportRow[];
  backlog: BacklogRow[];
}

const SELECT_CLASS =
  "h-8 rounded-md border border-border bg-transparent px-2 text-sm text-foreground disabled:opacity-60";

/**
 * /reports: period + filters on top, then plain tables. Every number comes
 * from the exact aggregate of migration 075 (no row limit); admin / owner only.
 */
export function ReportsView() {
  const { language } = useLanguage();
  const copy = reportsCopy(language);
  const { accountId, preferences, profileLoading } = useAuth();
  const allowed = useCan("view-reports");
  const timezone = preferences.business_hours?.timezone ?? DEFAULT_TIMEZONE;

  const [preset, setPreset] = useState<Preset>(30);
  const [custom, setCustom] = useState<ReportPeriod>(() => lastDays(30, DEFAULT_TIMEZONE));
  const [filters, setFilters] = useState<ReportFilters>({});
  const [data, setData] = useState<Data | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [tick, setTick] = useState(0);

  const { active: teams, byId: teamById } = useTeams();
  const { active: categories, byId: categoryById } = useConversationCategories();
  const [members, setMembers] = useState<Map<string, string>>(() => new Map());

  const period: ReportPeriod = useMemo(
    () => (preset === "custom" ? custom : lastDays(preset, timezone)),
    [preset, custom, timezone],
  );
  const periodOk = isValidPeriod(period);

  useEffect(() => {
    if (!accountId || !allowed) return;
    let cancelled = false;
    createClient()
      .from("profiles")
      .select("user_id, full_name")
      .eq("account_id", accountId)
      .then(({ data: rows, error }) => {
        if (cancelled || error || !rows) return;
        setMembers(new Map((rows as { user_id: string; full_name: string | null }[]).map((p) => [p.user_id, p.full_name || "?"])));
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, allowed]);

  useEffect(() => {
    if (!accountId || !allowed || !periodOk) return;
    let cancelled = false;
    const db = createClient();
    Promise.all([
      fetchSupportReport(db, accountId, period, "all", filters),
      fetchSupportReport(db, accountId, period, "category", filters),
      fetchSupportReport(db, accountId, period, "team", filters),
      fetchSupportReport(db, accountId, period, "agent", filters),
      fetchSupportReport(db, accountId, period, "priority", filters),
      fetchSupportBacklog(db, accountId, filters),
    ])
      .then(([all, category, team, agent, priority, backlog]) => {
        if (cancelled) return;
        setData({ all, category, team, agent, priority, backlog });
        setState("ready");
      })
      .catch((err) => {
        console.error("[reports] load failed:", err);
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, allowed, period, periodOk, filters, tick]);

  const setFilter = useCallback((patch: Partial<ReportFilters>) => {
    setState("loading");
    setFilters((f) => ({ ...f, ...patch }));
  }, []);

  const exportHref = useMemo(() => {
    const q = new URLSearchParams({ from: period.from, to: period.to });
    for (const [k, v] of Object.entries(filters)) if (v) q.set(k, String(v));
    return `/api/reports/export?${q.toString()}`;
  }, [period, filters]);

  const categoryLabel = (key: string | null) => (key ? (categoryById.get(key)?.name ?? "?") : copy.none);
  const teamLabel = (key: string | null) => (key ? (teamById.get(key)?.name ?? "?") : copy.none);
  const agentLabel = (key: string | null) => (key ? (members.get(key) ?? "?") : copy.none);

  if (profileLoading) return null;
  if (!allowed) {
    return (
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">{copy.forbidden}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-4 sm:p-6" data-no-translate>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{copy.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{copy.intro}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!periodOk}
          render={<a href={exportHref} download />}
          nativeButton={false}
        >
          {copy.export}
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="space-y-1.5">
          <span id="reports-period" className="text-xs text-muted-foreground">
            {copy.period}
          </span>
          <div role="group" aria-labelledby="reports-period" className="flex items-center gap-1">
            {([7, 30, 90, "custom"] as const).map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={preset === p}
                onClick={() => {
                  if (p === "custom" && preset !== "custom") setCustom(period);
                  setState("loading");
                  setPreset(p);
                }}
                className={cn(
                  "h-8 rounded-md px-2.5 text-sm transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  preset === p ? "bg-secondary font-medium text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {p === "custom" ? copy.custom : copy.days(p)}
              </button>
            ))}
          </div>
        </div>

        {preset === "custom" && (
          <div className="flex items-end gap-2">
            {(["from", "to"] as const).map((k) => (
              <div key={k} className="space-y-1.5">
                <Label htmlFor={`reports-${k}`} className="text-xs font-normal text-muted-foreground">
                  {copy[k]}
                </Label>
                <Input
                  id={`reports-${k}`}
                  type="date"
                  value={custom[k]}
                  aria-invalid={!periodOk}
                  onChange={(e) => {
                    setState("loading");
                    setCustom((c) => ({ ...c, [k]: e.target.value }));
                  }}
                  className="h-8 w-36"
                />
              </div>
            ))}
          </div>
        )}

        <FilterSelect label={copy.team} value={filters.team_id} all={copy.all} onChange={(v) => setFilter({ team_id: v })}>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label={copy.category} value={filters.category_id} all={copy.all} onChange={(v) => setFilter({ category_id: v })}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label={copy.agent} value={filters.agent_id} all={copy.all} onChange={(v) => setFilter({ agent_id: v })}>
          {[...members.entries()].map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          label={copy.channel}
          value={filters.channel}
          all={copy.all}
          onChange={(v) => setFilter({ channel: (v as ReportChannel | null) ?? null })}
        >
          {(["official", "qr"] as const).map((c) => (
            <option key={c} value={c}>
              {copy.channels[c]}
            </option>
          ))}
        </FilterSelect>
      </div>

      <div aria-live="polite" className="space-y-8">
        {!periodOk ? (
          <p role="alert" className="text-sm text-destructive">
            {copy.error}
          </p>
        ) : state === "error" ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {copy.error}{" "}
            <button
              type="button"
              onClick={() => {
                setState("loading");
                setTick((n) => n + 1);
              }}
              className="text-foreground underline underline-offset-2"
            >
              {copy.retry}
            </button>
          </p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">{copy.loading}</p>
        ) : (
          <div className={cn("space-y-8 transition-opacity", state === "loading" && "opacity-60")}>
            <OverviewSection row={data.all[0]} copy={copy} language={language} />
            <GroupSection title={copy.byCategory} rows={data.category} labelFor={categoryLabel} copy={copy} language={language} testId="reports-category" />
            <GroupSection title={copy.byTeam} rows={data.team} labelFor={teamLabel} copy={copy} language={language} testId="reports-team" />
            <GroupSection title={copy.byAgent} rows={data.agent} labelFor={agentLabel} copy={copy} language={language} testId="reports-agent" />
            <PrioritySection rows={data.priority} copy={copy} />
            <BacklogSection rows={data.backlog} copy={copy} />
          </div>
        )}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  all,
  onChange,
  children,
}: {
  label: string;
  value: string | null | undefined;
  all: string;
  onChange: (value: string | null) => void;
  children: React.ReactNode;
}) {
  const id = `reports-filter-${label}`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      <select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className={SELECT_CLASS}>
        <option value="">{all}</option>
        {children}
      </select>
    </div>
  );
}
