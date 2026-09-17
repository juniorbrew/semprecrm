"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useLanguage } from "@/hooks/use-language";
import {
  eventsForDay,
  isAllDayLike,
  minutesOfDay,
  minutesToInstant,
  movedRange,
  weekdayNames,
  type CalendarEvent,
  type GridDay,
} from "@/lib/calendar";
import { cn } from "@/lib/utils";

import { EventChip } from "./event-chip";

/** Chips per cell before the "+N" overflow. */
const MAX_PER_DAY = 3;
const DRAG_THRESHOLD_PX = 5;

export interface MonthViewProps {
  days: GridDay[];
  events: CalendarEvent[];
  tz: string;
  readOnly?: boolean;
  onOpenEvent: (event: CalendarEvent) => void;
  /** Click on the empty part of a day → quick-create at that position. */
  onCreateAt: (day: GridDay, anchor: { x: number; y: number }) => void;
  /** Drop onto another day (same time of day). */
  onMoveEvent: (event: CalendarEvent, range: { starts_at: string; ends_at: string }) => void;
  /** "+N" → show that day. */
  onShowDay: (day: GridDay) => void;
}

interface DragState {
  event: CalendarEvent;
  fromKey: string;
  startX: number;
  startY: number;
  moved: boolean;
  overKey: string | null;
}

/**
 * 6 × 7 grid; each cell lists up to three chips (all-day first) and a
 * "+N" link to the day view. Chips drag to another day with pointer
 * events; a plain click opens the drawer; a click on the empty part of
 * a cell opens the quick-create.
 */
export function MonthView({ days, events, tz, readOnly, onOpenEvent, onCreateAt, onMoveEvent, onShowDay }: MonthViewProps) {
  const { t, language } = useLanguage();
  const names = weekdayNames(language);
  const dragRef = useRef<DragState | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const keyAt = useCallback((x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-day-key]");
    return el?.dataset.dayKey ?? null;
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD_PX) return;
        d.moved = true;
        setDraggingId(d.event.id);
      }
      const key = keyAt(e.clientX, e.clientY);
      d.overKey = key;
      setOverKey(key);
    };
    const finish = (e: PointerEvent, cancelled: boolean) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setOverKey(null);
      setDraggingId(null);
      if (cancelled) return;
      if (!d.moved) {
        onOpenEvent(d.event);
        return;
      }
      const key = d.overKey ?? keyAt(e.clientX, e.clientY);
      const target = key ? days.find((x) => x.key === key) : null;
      if (!target || target.key === d.fromKey) return;
      const minutes = d.event.all_day ? 0 : minutesOfDay(new Date(d.event.starts_at), tz);
      const newStart = minutesToInstant(target, minutes, tz);
      onMoveEvent(d.event, movedRange(d.event, newStart, tz));
    };
    const onUp = (e: PointerEvent) => finish(e, false);
    const onCancel = (e: PointerEvent) => finish(e, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [days, keyAt, onMoveEvent, onOpenEvent, tz]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="grid shrink-0 grid-cols-7 border-b border-border">
        {names.map((n) => (
          <div key={n} className="px-2 py-1.5 text-center text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {n}
          </div>
        ))}
      </div>
      <div className="grid flex-1 grid-cols-7 grid-rows-6 overflow-y-auto">
        {days.map((day, i) => {
          const list = eventsForDay(events, day).sort(
            (a, b) => Number(isAllDayLike(b)) - Number(isAllDayLike(a)) || new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
          );
          const visible = list.slice(0, MAX_PER_DAY);
          const hidden = list.length - visible.length;
          return (
            <div
              key={day.key}
              data-day-key={day.key}
              onClick={(e) => {
                if (readOnly) return;
                if ((e.target as HTMLElement).closest("[data-event-id],[data-more]")) return;
                onCreateAt(day, { x: e.clientX, y: e.clientY });
              }}
              className={cn(
                "flex min-h-[88px] flex-col gap-0.5 border-b border-border/60 p-1 transition-colors",
                i % 7 !== 6 && "border-r",
                !day.inMonth && "bg-muted/30 text-muted-foreground",
                !readOnly && "cursor-pointer hover:bg-muted/40",
                overKey === day.key && draggingId && "bg-primary/10 ring-1 ring-inset ring-primary/40",
              )}
            >
              <div className="flex items-center justify-between px-0.5">
                <span
                  className={cn(
                    "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs tabular-nums",
                    day.isToday ? "bg-primary font-semibold text-primary-foreground" : day.inMonth ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {day.dayOfMonth}
                </span>
              </div>
              {visible.map((ev) => (
                <EventChip
                  key={ev.id}
                  event={ev}
                  tz={tz}
                  className={cn("touch-none", draggingId === ev.id && "opacity-40")}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (readOnly) {
                      onOpenEvent(ev);
                      return;
                    }
                    dragRef.current = { event: ev, fromKey: day.key, startX: e.clientX, startY: e.clientY, moved: false, overKey: null };
                  }}
                  onClick={undefined}
                />
              ))}
              {hidden > 0 && (
                <button
                  type="button"
                  data-more
                  onClick={(e) => {
                    e.stopPropagation();
                    onShowDay(day);
                  }}
                  className="self-start rounded px-1 text-[11px] font-medium text-primary hover:underline"
                >
                  +{hidden} {t("more")}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
