"use client";

import { memo, useCallback, useEffect, useState } from "react";

import { useLanguage } from "@/hooks/use-language";
import { useListClock } from "@/lib/inbox/list-clock";
import { cn } from "@/lib/utils";
import {
  activeSlaTarget,
  slaCopy,
  slaFractionLeft,
  slaLabel,
  slaLevel,
  slaTone,
  type SlaFields,
  type SlaKind,
  type SlaLevel,
  type SlaTone,
} from "@/lib/support/sla";

const TEXT: Record<SlaLevel, string> = {
  ok: "text-muted-foreground",
  warning: "text-amber-600 dark:text-amber-400",
  breached: "text-red-600 dark:text-red-400",
};
const DOT: Record<SlaLevel, string> = {
  ok: "bg-zinc-400",
  warning: "bg-amber-500",
  breached: "bg-red-500",
};

/** Clock that re-renders every 30 s, so the remaining time stays honest. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const PILL: Record<SlaTone, string> = {
  ok: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  critical: "bg-red-500/15 text-red-600 dark:text-red-400",
};
const BAR: Record<SlaTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-red-500",
};

/** The active target as primitives, so the memoised row pieces compare cheaply. */
export interface SlaTargetProps {
  kind: SlaKind;
  dueAt: number;
  warnAt: number | null;
}

/**
 * Conversation list row: "SLA 12min" / "estourado há 5min" as a tinted
 * pill — green, amber under 40% left, red under 15% or past due. Ticks on
 * the list's shared clock; re-renders only when its text or tone changes.
 */
export const SlaPill = memo(function SlaPill({ kind, dueAt, warnAt }: SlaTargetProps) {
  const { language } = useLanguage();
  const derive = useCallback(
    (now: number) => {
      const target = { kind, dueAt, warnAt };
      return `${slaTone(target, now)}|${slaLevel(target, now)}|${slaLabel(target, now, language)}`;
    },
    [kind, dueAt, warnAt, language],
  );
  const [tone, level, label] = useListClock(derive).split("|") as [SlaTone, SlaLevel, string];
  const copy = slaCopy(language);
  const title =
    level === "breached"
      ? copy.breached(kind)
      : level === "warning"
        ? copy.warning(kind)
        : kind === "first_response"
          ? copy.headerFirstResponse
          : copy.headerResolution;
  return (
    <span
      data-no-translate
      data-testid="sla-row"
      data-level={level}
      data-tone={tone}
      title={title}
      className={cn(
        "inline-flex min-w-0 shrink-0 items-center rounded-full px-2 text-[11px] font-semibold leading-4 tabular-nums whitespace-nowrap",
        PILL[tone],
      )}
    >
      {level === "breached" ? label : `SLA ${label}`}
    </span>
  );
});

/** Thin line at the bottom of the row: the share of the SLA still left. */
export const SlaProgressLine = memo(function SlaProgressLine({ kind, dueAt, warnAt }: SlaTargetProps) {
  const derive = useCallback(
    (now: number) => {
      const target = { kind, dueAt, warnAt };
      const left = slaFractionLeft(target, now);
      return left === null ? "" : `${slaTone(target, now)}|${Math.round(left * 100)}`;
    },
    [kind, dueAt, warnAt],
  );
  const value = useListClock(derive);
  if (!value) return null;
  const [tone, pct] = value.split("|") as [SlaTone, string];
  return (
    <span
      aria-hidden
      data-testid="sla-progress"
      data-tone={tone}
      className="pointer-events-none absolute inset-x-3.5 bottom-0 h-0.5 overflow-hidden rounded-full bg-border"
    >
      <span className={cn("block h-full transition-[width] duration-200", BAR[tone])} style={{ width: `${pct}%` }} />
    </span>
  );
});

/** Thread header: "Prazo de resposta · 1h 20min", same colouring as the row. */
export function SlaLine({ conversation }: { conversation: SlaFields }) {
  const { language } = useLanguage();
  const now = useNow();
  const target = activeSlaTarget(conversation);
  if (!target) return null;
  const level = slaLevel(target, now);
  const copy = slaCopy(language);
  return (
    <span
      data-no-translate
      data-testid="sla-line"
      data-level={level}
      className="inline-flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground"
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT[level])} aria-hidden />
      <span className="truncate">{target.kind === "first_response" ? copy.headerFirstResponse : copy.headerResolution}</span>
      <span aria-hidden>·</span>
      <span className={cn("truncate tabular-nums", TEXT[level], level !== "ok" && "font-medium")}>
        {slaLabel(target, now, language)}
      </span>
    </span>
  );
}
