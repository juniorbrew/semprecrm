"use client";

import type { Ref } from "react";
import type { Deal, DealStatus, PipelineStage } from "@/types";
import { Check, PanelRightOpen, X } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";
import {
  closeDateInfo,
  longDateTime,
  relativeTime,
  type CloseDateTone,
} from "@/lib/pipelines/deal-dates";
import { cn } from "@/lib/utils";

const COPY: Record<
  Language,
  {
    open: string;
    won: string;
    lost: string;
    noContact: string;
    lossReason: string;
    toolbar: (deal: string) => string;
    openAria: (deal: string) => string;
    wonAria: (deal: string) => string;
    lostAria: (deal: string) => string;
  }
> = {
  "pt-BR": {
    open: "Abrir",
    won: "Ganho",
    lost: "Perdido",
    noContact: "Sem contato",
    lossReason: "Motivo da perda",
    toolbar: (d) => `Ações do negócio ${d}`,
    openAria: (d) => `Abrir negócio ${d}`,
    wonAria: (d) => `Marcar ${d} como ganho`,
    lostAria: (d) => `Marcar ${d} como perdido`,
  },
  "en-US": {
    open: "Open",
    won: "Won",
    lost: "Lost",
    noContact: "No contact",
    lossReason: "Loss reason",
    toolbar: (d) => `Actions for deal ${d}`,
    openAria: (d) => `Open deal ${d}`,
    wonAria: (d) => `Mark ${d} as won`,
    lostAria: (d) => `Mark ${d} as lost`,
  },
};

// Close-date urgency as dot + text: overdue red, today amber, the rest
// quiet text so the urgent card is the one that stands out.
const CLOSE_TONE: Record<CloseDateTone, { text: string; dot?: string }> = {
  overdue: { text: "font-medium text-red-600 dark:text-red-400", dot: "bg-red-500" },
  today: { text: "font-medium text-amber-700 dark:text-amber-400", dot: "bg-amber-500" },
  soon: { text: "text-foreground/80" },
  later: { text: "text-muted-foreground" },
};

const QUICK_BUTTON =
  "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";

function initials(name?: string, fallback?: string) {
  const source = (name || fallback || "?").trim();
  return source ? source.charAt(0).toUpperCase() : "?";
}

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  /** Quick won / lost; omitted when the viewer cannot change deals. */
  onStatus?: (deal: Deal, status: DealStatus) => void;
  isOverlay?: boolean;
  compact?: boolean;
  /** Drag handle wiring (dnd-kit listeners + attributes) for the main button. */
  handleRef?: Ref<HTMLButtonElement>;
  handleProps?: Record<string, unknown>;
}

export function DealCard({
  deal,
  stage,
  onEdit,
  onStatus,
  isOverlay,
  compact,
  handleRef,
  handleProps,
}: DealCardProps) {
  const { language } = useLanguage();
  const copy = COPY[language] ?? COPY["pt-BR"];
  const status: DealStatus = deal.status ?? "open";
  const isOpen = status === "open";
  const contactLabel = deal.contact?.name || deal.contact?.phone || copy.noContact;
  const companyLabel = deal.company?.nome_fantasia || deal.company?.razao_social || null;
  const assigneeLabel = deal.assignee?.full_name || null;
  const close =
    isOpen && deal.expected_close_date
      ? closeDateInfo(deal.expected_close_date, language)
      : null;
  const activityAt = deal.updated_at || deal.created_at;
  const value = formatCurrency(deal.value, deal.currency);
  const lossReason = status === "lost" ? deal.loss_reason?.name ?? null : null;

  const ariaLabel = [
    deal.title,
    value,
    stage?.name,
    status === "won" ? copy.won : status === "lost" ? copy.lost : null,
    close?.short,
    contactLabel,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      data-testid="deal-card"
      className={cn(
        "group/card relative rounded-[calc(var(--radius)-2px)] border bg-card transition-[border-color,box-shadow] duration-150 motion-reduce:transition-none",
        isOverlay
          ? "border-primary/50 shadow-lg ring-2 ring-primary/30"
          : "border-border hover:border-primary/30 focus-within:border-primary/40",
      )}
    >
      {/* Thin stage accent, only when the stage has a colour. */}
      {stage?.color && (
        <span
          aria-hidden
          className="absolute inset-y-2 left-0 w-[3px] rounded-r-full"
          style={{ backgroundColor: stage.color }}
        />
      )}

      <button
        ref={handleRef}
        {...handleProps}
        type="button"
        aria-label={ariaLabel}
        onClick={(e) => {
          // A tap still clicks: the PointerSensor needs 5px of movement
          // before it counts as a drag.
          if (isOverlay) return;
          e.stopPropagation();
          onEdit(deal);
        }}
        className={cn(
          "block w-full cursor-pointer touch-none rounded-[inherit] pl-3.5 pr-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          compact ? "py-2" : "py-2.5",
        )}
      >
        <span
          className={cn(
            "block text-sm font-medium leading-snug text-foreground break-words",
            compact ? "line-clamp-1" : "line-clamp-2",
          )}
        >
          {deal.title}
        </span>

        {!compact && (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {contactLabel}
            {companyLabel && ` · ${companyLabel}`}
          </span>
        )}

        {status !== "open" && (
          <span
            title={lossReason ? `${copy.lossReason}: ${lossReason}` : undefined}
            className={cn(
              "mt-1 flex items-center gap-1.5 truncate text-[11px] font-medium",
              status === "won"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                status === "won" ? "bg-emerald-500" : "bg-red-500",
              )}
            />
            {status === "won" ? copy.won : copy.lost}
            {!compact && lossReason && (
              <span className="truncate font-normal text-muted-foreground">
                · {lossReason}
                {deal.lost_note?.trim() && ` · ${deal.lost_note.trim()}`}
              </span>
            )}
          </span>
        )}

        <span className={cn("flex items-center gap-2", compact ? "mt-1" : "mt-2")}>
          <span className="text-sm font-semibold tabular-nums text-foreground">{value}</span>
          {close && (
            <span
              title={close.long}
              className={cn(
                "inline-flex shrink-0 items-center gap-1 text-[11px]",
                CLOSE_TONE[close.tone].text,
              )}
            >
              {CLOSE_TONE[close.tone].dot && (
                <span aria-hidden className={cn("size-1.5 rounded-full", CLOSE_TONE[close.tone].dot)} />
              )}
              {close.short}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {!compact && activityAt && (
              <span
                title={longDateTime(activityAt, language)}
                className="text-[11px] text-muted-foreground"
              >
                {relativeTime(activityAt, language)}
              </span>
            )}
            {assigneeLabel && (
              <span
                title={assigneeLabel}
                className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
              >
                {initials(assigneeLabel)}
              </span>
            )}
          </span>
        </span>
      </button>

      {/* Quick actions: on hover, and whenever focus is inside the card. */}
      {!isOverlay && (
        <div
          role="toolbar"
          aria-label={copy.toolbar(deal.title)}
          data-testid="deal-quick-actions"
          className="absolute right-1.5 top-1.5 hidden gap-0.5 rounded-md border border-border bg-popover p-0.5 shadow-sm group-focus-within/card:flex group-hover/card:flex"
        >
          <button
            type="button"
            onClick={() => onEdit(deal)}
            aria-label={copy.openAria(deal.title)}
            title={copy.open}
            className={QUICK_BUTTON}
          >
            <PanelRightOpen className="size-3.5" aria-hidden />
          </button>
          {isOpen && onStatus && (
            <>
              <button
                type="button"
                onClick={() => onStatus(deal, "won")}
                aria-label={copy.wonAria(deal.title)}
                title={copy.won}
                data-action="won"
                className={cn(QUICK_BUTTON, "hover:text-emerald-600 dark:hover:text-emerald-400")}
              >
                <Check className="size-3.5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => onStatus(deal, "lost")}
                aria-label={copy.lostAria(deal.title)}
                title={copy.lost}
                data-action="lost"
                className={cn(QUICK_BUTTON, "hover:text-red-600 dark:hover:text-red-400")}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
