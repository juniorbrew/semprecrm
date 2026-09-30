"use client";

import { useEffect, useState } from "react";

import { useLanguage } from "@/hooks/use-language";
import { cn } from "@/lib/utils";
import { activeSlaTarget, slaCopy, slaLabel, slaLevel, type SlaFields, type SlaLevel } from "@/lib/support/sla";

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

/**
 * Conversation list row: the time left in muted text, amber once 80% of
 * the target is used, red once it is missed. Nothing when no policy applies.
 */
export function SlaRowLabel({ conversation, now }: { conversation: SlaFields; now: number }) {
  const { language } = useLanguage();
  const target = activeSlaTarget(conversation);
  if (!target) return null;
  const level = slaLevel(target, now);
  const copy = slaCopy(language);
  const title = level === "breached" ? copy.breached(target.kind) : level === "warning" ? copy.warning(target.kind) : target.kind === "first_response" ? copy.headerFirstResponse : copy.headerResolution;
  return (
    <span
      data-no-translate
      data-testid="sla-row"
      data-level={level}
      title={title}
      className={cn("inline-flex min-w-0 items-center gap-1 text-[11px] leading-4 tabular-nums", TEXT[level])}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT[level])} aria-hidden />
      <span className="truncate">{slaLabel(target, now, language)}</span>
    </span>
  );
}

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
