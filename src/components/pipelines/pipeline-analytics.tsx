"use client";

import { useMemo, useState } from "react";
import type { Deal, PipelineStage } from "@/types";
import {
  DollarSign,
  TrendingUp,
  Target,
  BarChart3,
  Trophy,
  XCircle,
  Info,
  ChevronDown,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import { formatCurrency } from "@/lib/currency";
import { aggregateLossReasons } from "@/lib/pipelines/loss-reasons";
import { cn } from "@/lib/utils";

interface PipelineAnalyticsProps {
  stages: PipelineStage[];
  deals: Deal[];
}

/**
 * Weighted pipeline value: value × per-stage probability.
 * First stage ≈ 10%, stages interpolate up to 90% before the final stage,
 * final stage (Won) = 100%. Lost deals excluded.
 */
function computeStageProbability(
  stage: PipelineStage,
  sortedStages: PipelineStage[],
): number {
  const n = sortedStages.length;
  if (n <= 1) return 1;
  const index = sortedStages.findIndex((s) => s.id === stage.id);
  if (index < 0) return 0;
  if (index === n - 1) return 1;
  const slots = n - 1;
  if (slots <= 1) return 0.1;
  const t = index / (slots - 1);
  return 0.1 + t * (0.9 - 0.1);
}

export function PipelineAnalytics({ stages, deals }: PipelineAnalyticsProps) {
  const { defaultCurrency } = useAuth();
  const sortedStages = useMemo(
    () => [...stages].sort((a, b) => a.position - b.position),
    [stages],
  );

  const stats = useMemo(() => {
    const active = deals.filter((d) => d.status !== "lost");
    const openDeals = active.filter((d) => d.status !== "won");

    const totalCount = active.length;
    const totalValue = active.reduce((sum, d) => sum + Number(d.value || 0), 0);
    const avgValue = totalCount > 0 ? totalValue / totalCount : 0;

    const stageById = new Map(sortedStages.map((s) => [s.id, s]));
    const weightedValue = openDeals.reduce((sum, d) => {
      const stage = stageById.get(d.stage_id);
      if (!stage) return sum;
      const prob = computeStageProbability(stage, sortedStages);
      return sum + Number(d.value || 0) * prob;
    }, 0);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonth = (d: Deal) => {
      const ts = d.updated_at ?? d.created_at;
      return ts ? new Date(ts) >= monthStart : false;
    };
    const wonThisMonth = deals.filter(
      (d) => d.status === "won" && thisMonth(d),
    ).length;
    const lostThisMonth = deals.filter(
      (d) => d.status === "lost" && thisMonth(d),
    ).length;

    return {
      totalCount,
      totalValue,
      avgValue,
      weightedValue,
      wonThisMonth,
      lostThisMonth,
    };
  }, [deals, sortedStages]);

  return (
    <TooltipProvider>
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-card/60 p-4 sm:grid-cols-3 xl:grid-cols-6">
        <Metric
          icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
          label="Total Deals"
          value={String(stats.totalCount)}
          tooltip="Count of every deal in this pipeline that isn't marked as Lost. Won deals are still included."
        />
        <Metric
          icon={<DollarSign className="h-4 w-4 text-primary" />}
          label="Pipeline Value"
          value={formatCurrency(stats.totalValue, defaultCurrency)}
          tooltip="Sum of the dollar values of all deals in this pipeline, excluding deals marked as Lost."
        />
        <Metric
          icon={<Target className="h-4 w-4 text-blue-400" />}
          label="Avg Deal Size"
          value={formatCurrency(stats.avgValue, defaultCurrency)}
          tooltip="Pipeline Value divided by Total Deals — the average value of a single non-lost deal."
        />
        <Metric
          icon={<TrendingUp className="h-4 w-4 text-purple-400" />}
          label="Weighted Value"
          value={formatCurrency(stats.weightedValue, defaultCurrency)}
          tooltip="Expected revenue: each open deal's value × its stage probability. First stage ≈ 10%, stages progress up to 90%, Won = 100%. Lost deals are excluded."
        />
        <Metric
          icon={<Trophy className="h-4 w-4 text-primary" />}
          label="Won This Month"
          value={String(stats.wonThisMonth)}
          tooltip="Deals marked as Won since the first day of the current month."
        />
        <Metric
          icon={<XCircle className="h-4 w-4 text-red-400" />}
          label="Lost This Month"
          value={String(stats.lostThisMonth)}
          tooltip="Deals marked as Lost since the first day of the current month."
        />
        <LossReasonsBlock deals={deals} currency={defaultCurrency} />
      </div>
    </TooltipProvider>
  );
}

type LossMetric = "count" | "value";

/**
 * "Motivos de perda" — every lost deal of the displayed pipeline grouped
 * by reason, as horizontal bars. The bar length follows the selected
 * metric (count or value); both numbers are always printed so the two
 * readings never need a second click. Hidden while nothing is lost.
 */
function LossReasonsBlock({ deals, currency }: { deals: Deal[]; currency: string }) {
  const { t, language } = useLanguage();
  const [metric, setMetric] = useState<LossMetric>("count");
  const [collapsed, setCollapsed] = useState(false);

  // Reasons ride the join on each deal (`loss_reason`), so no extra
  // query: the aggregation falls back to that name per deal.
  const buckets = useMemo(
    () => aggregateLossReasons(deals, [], language),
    [deals, language],
  );
  if (buckets.length === 0) return null;

  const totalCount = buckets.reduce((sum, b) => sum + b.count, 0);
  const totalValue = buckets.reduce((sum, b) => sum + b.value, 0);
  const max = Math.max(...buckets.map((b) => (metric === "count" ? b.count : b.value)), 0);

  return (
    <div className="col-span-2 rounded-lg bg-muted/50 p-3 sm:col-span-3 xl:col-span-6">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <XCircle className="h-4 w-4 text-red-400" />
          <span>{t("Loss reasons")}</span>
          <ChevronDown
            className={cn("h-3 w-3 transition-transform", collapsed && "-rotate-90")}
          />
        </button>
        <span className="text-[11px] text-muted-foreground">
          {totalCount} {totalCount === 1 ? t("lost deal") : t("lost deals")}
          <span className="mx-1">·</span>
          {formatCurrency(totalValue, currency)}
        </span>
        {!collapsed && (
          <div
            role="radiogroup"
            aria-label={t("Bar length")}
            className="ml-auto inline-flex rounded-md border border-border bg-card p-0.5 text-[11px]"
          >
            {(["count", "value"] as LossMetric[]).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={metric === m}
                onClick={() => setMetric(m)}
                className={cn(
                  "rounded px-2 py-0.5 transition-colors",
                  metric === m
                    ? "bg-muted font-semibold text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m === "count" ? t("Count") : t("Value")}
              </button>
            ))}
          </div>
        )}
      </div>

      {!collapsed && (
        <ul className="mt-3 space-y-2">
          {buckets.map((b) => {
            const measure = metric === "count" ? b.count : b.value;
            const pct = max > 0 ? Math.max(2, Math.round((measure / max) * 100)) : 0;
            const share = totalCount > 0 ? Math.round((b.count / totalCount) * 100) : 0;
            return (
              <li key={b.key} className="grid grid-cols-[minmax(0,160px)_1fr_auto] items-center gap-3 text-xs">
                <span className="truncate font-medium text-foreground" title={b.reason}>
                  {b.reason}
                </span>
                <div className="h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div
                    className="h-full rounded-full bg-red-500/70 transition-[width] duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="whitespace-nowrap tabular-nums text-muted-foreground">
                  <span className="font-semibold text-foreground">{b.count}</span>
                  <span className="ml-1 text-[10px]">({share}%)</span>
                  <span className="mx-1">·</span>
                  {formatCurrency(b.value, currency)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  tooltip,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tooltip: string;
}) {
  return (
    <div className="rounded-lg bg-muted/50 p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        <span>{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="How this metric is calculated"
                className="ml-auto text-muted-foreground hover:text-foreground focus:outline-none"
              />
            }
          >
            <Info className="h-3 w-3" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-left">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      <p className="mt-1 text-base font-semibold text-foreground">{value}</p>
    </div>
  );
}
