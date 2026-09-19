"use client";

import { useLanguage } from "@/hooks/use-language";
import { PLAN_STATUS_LABELS, type PlanStatus } from "@/lib/plans";
import { cn } from "@/lib/utils";

/**
 * Status label key. `trial` is the one status whose catalogue label
 * ("Trial") collides with the plan name, so "Plan: Trial · Status:
 * Trial" read as a glitch — the status side says "In trial" instead.
 */
export function planStatusLabelKey(status: PlanStatus): string {
  return status === "trial" ? "In trial" : PLAN_STATUS_LABELS[status];
}

const TONE: Record<PlanStatus, string> = {
  trial: "border-primary/40 bg-primary/10 text-primary",
  active: "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  past_due: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  canceled: "border-border bg-muted text-muted-foreground",
  suspended: "border-destructive/40 bg-destructive/10 text-destructive",
};

/**
 * Status pill for the platform tables. `blocked` adds a subtle
 * marker for a trial that has expired (status still says "trial"
 * but the customer is locked out).
 */
export function PlanStatusChip({
  status,
  blocked,
}: {
  status: PlanStatus;
  blocked?: boolean;
}) {
  const { t } = useLanguage();
  const expiredTrial = blocked && status === "trial";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        expiredTrial ? TONE.past_due : TONE[status],
      )}
    >
      {expiredTrial ? t("Trial expired") : t(planStatusLabelKey(status))}
    </span>
  );
}
