"use client";

import { Ban } from "lucide-react";

import { useLanguage } from "@/hooks/use-language";
import { formatTime, type CalendarEvent } from "@/lib/calendar";
import { cn } from "@/lib/utils";

import { chipStyle, eventColor } from "./colors";

/**
 * One-line event chip for the month grid, the all-day strip and the
 * "Agenda" side sections: coloured left border, time (unless all-day)
 * and the title. Pointer handling belongs to the parent (the grids
 * attach drag behaviour through `data-event-id`).
 */
export function EventChip({
  event,
  tz,
  showTime = true,
  className,
  onClick,
  ...rest
}: {
  event: CalendarEvent;
  tz: string;
  showTime?: boolean;
  className?: string;
  onClick?: () => void;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "onClick" | "className">) {
  const { language } = useLanguage();
  const cancelled = event.status === "cancelled";
  const color = eventColor(event);
  return (
    <div
      role="button"
      tabIndex={0}
      data-event-id={event.id}
      title={event.title}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      style={chipStyle(color, cancelled)}
      className={cn(
        "flex min-w-0 cursor-pointer select-none items-center gap-1 rounded-md border-l-[3px] px-1.5 py-0.5 text-[11px] leading-4 outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        cancelled && "text-muted-foreground line-through",
        className,
      )}
      {...rest}
    >
      {cancelled && <Ban className="h-3 w-3 shrink-0" />}
      {showTime && !event.all_day && (
        <span className="shrink-0 tabular-nums opacity-80">{formatTime(event.starts_at, language, tz)}</span>
      )}
      <span className="min-w-0 flex-1 truncate font-medium">{event.title}</span>
    </div>
  );
}
