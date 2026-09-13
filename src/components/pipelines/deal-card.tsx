"use client";

import type { Deal, PipelineStage } from "@/types";
import { CalendarClock, Check, Clock, X } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { useLanguage } from "@/hooks/use-language";
import {
  closeDateInfo,
  longDateTime,
  relativeTime,
  type CloseDateTone,
} from "@/lib/pipelines/deal-dates";
import { cn } from "@/lib/utils";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
}

// Close-date urgency: overdue reads red, today amber, everything else
// stays quiet so the urgent card is the one that stands out.
const CLOSE_TONE_CLASS: Record<CloseDateTone, string> = {
  overdue:
    "bg-red-500/10 text-red-600 dark:text-red-400 font-semibold",
  today: "bg-amber-500/15 text-amber-700 dark:text-amber-400 font-semibold",
  soon: "bg-muted text-foreground",
  later: "text-muted-foreground",
};

function initials(name?: string, fallback?: string) {
  const source = (name || fallback || "?").trim();
  if (!source) return "?";
  return source.charAt(0).toUpperCase();
}

export function DealCard({ deal, stage, onEdit, isOverlay }: DealCardProps) {
  const { t, language } = useLanguage();
  const contactLabel =
    deal.contact?.name || deal.contact?.phone || t("No contact");
  const assigneeLabel = deal.assignee?.full_name || null;
  const isOpen = (deal.status ?? "open") === "open";
  const close =
    isOpen && deal.expected_close_date
      ? closeDateInfo(deal.expected_close_date, language)
      : null;
  const activityAt = deal.updated_at || deal.created_at;

  return (
    <button
      type="button"
      onClick={(e) => {
        // `onClick` still fires after a non-drag tap because the PointerSensor
        // requires 5px movement before it counts as a drag.
        if (isOverlay) return;
        e.stopPropagation();
        onEdit(deal);
      }}
      className={`group relative w-full cursor-pointer rounded-xl border border-border/50 bg-muted/70 pl-4 pr-3 py-3 text-left shadow-sm transition-all ${
        isOverlay
          ? "shadow-xl"
          : "hover:-translate-y-0.5 hover:border-border hover:bg-muted hover:shadow-lg"
      }`}
    >
      {/* 4px left accent bar using stage color */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-1 rounded-l-xl"
        style={{ backgroundColor: stage?.color ?? "#94a3b8" }}
      />

      <div className="flex items-start justify-between gap-2">
        <h4 className="flex-1 text-sm font-semibold leading-snug text-foreground break-words">
          {deal.title}
        </h4>
        {deal.status === "won" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
            <Check className="h-3 w-3" />
            {t("Won")}
          </span>
        )}
        {deal.status === "lost" && (
          <span
            title={
              deal.loss_reason?.name
                ? `${t("Loss reason")}: ${deal.loss_reason.name}`
                : undefined
            }
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400"
          >
            <X className="h-3 w-3" />
            {t("Lost")}
          </span>
        )}
      </div>

      {/* Why it was lost — one quiet line so the board explains itself. */}
      {deal.status === "lost" && deal.loss_reason?.name && (
        <p className="mt-1 truncate text-[11px] text-red-500/90 dark:text-red-400/90">
          {deal.loss_reason.name}
          {deal.lost_note?.trim() && (
            <span className="text-muted-foreground"> · {deal.lost_note.trim()}</span>
          )}
        </p>
      )}

      {/* Contact row */}
      <div className="mt-2 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
          {initials(deal.contact?.name, deal.contact?.phone)}
        </span>
        <span className="truncate text-xs text-muted-foreground">{contactLabel}</span>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-sm font-bold text-primary">
          {formatCurrency(deal.value, deal.currency)}
        </span>
        {close && (
          <span
            title={close.long}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]",
              CLOSE_TONE_CLASS[close.tone],
            )}
          >
            <CalendarClock className="h-3 w-3" />
            {close.short}
          </span>
        )}
      </div>

      {/* Working signal: last activity age + owner. Reads "há 2 d" so a
          stale card looks stale next to a fresh one. */}
      <div className="mt-2 flex items-center justify-between gap-2">
        {activityAt ? (
          <span
            title={longDateTime(activityAt, language)}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
          >
            <Clock className="h-3 w-3" />
            {relativeTime(activityAt, language)}
          </span>
        ) : (
          <span />
        )}
        {assigneeLabel && (
          <span
            title={assigneeLabel}
            aria-label={assigneeLabel}
            className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
          >
            {initials(assigneeLabel)}
          </span>
        )}
      </div>
    </button>
  );
}
