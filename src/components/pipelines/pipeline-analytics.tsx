"use client";

import { useMemo, useState } from "react";
import type { Deal, PipelineStage } from "@/types";
import { Info, ChevronDown } from "lucide-react";
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
import { pipelineStats } from "@/lib/pipelines/board";
import { cn } from "@/lib/utils";

interface PipelineAnalyticsProps {
  stages: PipelineStage[];
  deals: Deal[];
}

/**
 * The board's numbers as one flat strip under the header (no boxes):
 * count, value and weighted value first, then average and this month's
 * outcomes (green / red dot). Loss reasons follow under a hairline.
 */
export function PipelineAnalytics({ stages, deals }: PipelineAnalyticsProps) {
  const { defaultCurrency } = useAuth();
  const stats = useMemo(() => pipelineStats(deals, stages), [deals, stages]);

  return (
    <TooltipProvider>
      <div>
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <Metric
            label="Total Deals"
            value={String(stats.totalCount)}
            tooltip="Count of every deal in this pipeline that isn't marked as Lost. Won deals are still included."
          />
          <Metric
            label="Pipeline Value"
            value={formatCurrency(stats.totalValue, defaultCurrency)}
            tooltip="Sum of the dollar values of all deals in this pipeline, excluding deals marked as Lost."
            emphasis
          />
          <Metric
            label="Weighted Value"
            value={formatCurrency(stats.weightedValue, defaultCurrency)}
            tooltip="Expected revenue: each open deal's value × its stage probability. First stage ≈ 10%, stages progress up to 90%, Won = 100%. Lost deals are excluded."
          />
          <Metric
            label="Avg Deal Size"
            value={formatCurrency(stats.avgValue, defaultCurrency)}
            tooltip="Pipeline Value divided by Total Deals — the average value of a single non-lost deal."
          />
          <Metric
            dot="bg-emerald-500"
            label="Won This Month"
            value={String(stats.wonThisMonth)}
            tooltip="Deals marked as Won since the first day of the current month."
          />
          <Metric
            dot="bg-red-500"
            label="Lost This Month"
            value={String(stats.lostThisMonth)}
            tooltip="Deals marked as Lost since the first day of the current month."
          />
        </dl>
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
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 rounded-sm text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-red-500" />
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
            className="ml-auto inline-flex rounded-md bg-muted p-0.5 text-[11px]"
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
                    ? "bg-background font-semibold text-foreground shadow-xs"
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
                <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div
                    className="h-full rounded-full bg-red-500/70 transition-[width] duration-200 motion-reduce:transition-none"
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
  label,
  value,
  tooltip,
  dot,
  emphasis,
}: {
  label: string;
  value: string;
  tooltip: string;
  /** Status dot (won / lost) before the label. */
  dot?: string;
  /** The one number in primary. */
  emphasis?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {dot && <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />}
        <span>{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="How this metric is calculated"
                className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <Info className="size-3" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-left">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </dt>
      <dd
        className={cn(
          "mt-0.5 text-base font-semibold tabular-nums",
          emphasis ? "text-primary" : "text-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
