"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useLanguage } from "@/hooks/use-language";
import {
  DEFAULT_SCROLL_HOUR,
  MINUTES_PER_DAY,
  SNAP_MINUTES,
  eventsForDay,
  floorMinutes,
  formatTime,
  isAllDayLike,
  layoutTimedEvents,
  minutesOfDay,
  minutesToInstant,
  movedRange,
  snapMinutes,
  weekdayNames,
  type CalendarEvent,
  type GridDay,
} from "@/lib/calendar";
import { cn } from "@/lib/utils";

import { chipStyle, eventColor } from "./colors";
import { EventChip } from "./event-chip";
import { ProviderIcon } from "./provider-icon";

/** Pixels per hour on the time grid. */
const HOUR_PX = 56;
const DRAG_THRESHOLD_PX = 4;

export interface TimeGridViewProps {
  /** 7 days (week) or 1 (day). */
  days: GridDay[];
  events: CalendarEvent[];
  tz: string;
  now: Date;
  readOnly?: boolean;
  onOpenEvent: (event: CalendarEvent) => void;
  /** Click / drag on an empty slot → quick-create for `[starts_at, ends_at)`. */
  onCreateSlot: (slot: { starts_at: string; ends_at: string; all_day: boolean }, anchor: { x: number; y: number }) => void;
  onMoveEvent: (event: CalendarEvent, range: { starts_at: string; ends_at: string }) => void;
  onResizeEvent: (event: CalendarEvent, endsAt: string) => void;
}

type Drag =
  | { kind: "select"; dayIndex: number; anchorMin: number; curMin: number; moved: boolean; x: number; y: number }
  | {
      kind: "move";
      event: CalendarEvent;
      fromDay: number;
      offsetMin: number;
      length: number;
      dayIndex: number;
      startMin: number;
      moved: boolean;
      x: number;
      y: number;
    }
  | { kind: "resize"; event: CalendarEvent; dayIndex: number; startMin: number; endMin: number; moved: boolean; x: number; y: number };

/**
 * Week / day view: an all-day strip on top, then 24 hour rows (06:00
 * in view on open, scrollable to 00–24) with a "now" line and the
 * events positioned by time. Pointer events do everything: press and
 * drag on an empty slot selects a range (a plain click gives one
 * hour), dragging an event moves it (snapped to 30 min, across
 * columns), the bottom handle resizes, a click opens the drawer.
 */
export function TimeGridView({ days, events, tz, now, readOnly, onOpenEvent, onCreateSlot, onMoveEvent, onResizeEvent }: TimeGridViewProps) {
  const { t, language } = useLanguage();
  const names = weekdayNames(language);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  // Scroll to 06:00 when the view opens.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = DEFAULT_SCROLL_HOUR * HOUR_PX;
  }, []);

  const nowMin = minutesOfDay(now, tz);
  const todayIndex = days.findIndex((d) => d.isToday);

  const perDay = useMemo(
    () =>
      days.map((day) => {
        const list = eventsForDay(events, day);
        const allDay = list.filter((e) => isAllDayLike(e));
        const timed = list.filter((e) => !isAllDayLike(e));
        return { allDay, timed: layoutTimedEvents(timed, day) };
      }),
    [days, events],
  );

  // ---- pointer geometry ------------------------------------------
  function locate(clientX: number, clientY: number): { dayIndex: number; minutes: number } | null {
    const body = bodyRef.current;
    if (!body) return null;
    const rect = body.getBoundingClientRect();
    const colWidth = rect.width / days.length;
    const dayIndex = Math.min(days.length - 1, Math.max(0, Math.floor((clientX - rect.left) / colWidth)));
    const minutes = ((clientY - rect.top) / HOUR_PX) * 60;
    return { dayIndex, minutes };
  }

  function commit(next: Drag) {
    dragRef.current = next;
    setDrag(next);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || readOnly) return;
    const target = e.target as HTMLElement;
    const chip = target.closest<HTMLElement>("[data-event-id]");
    const loc = locate(e.clientX, e.clientY);
    if (!loc) return;
    e.preventDefault();
    if (chip) {
      const id = chip.dataset.eventId;
      const ev = events.find((x) => x.id === id);
      if (!ev) return;
      const dayIndex = Number(chip.dataset.dayIndex ?? loc.dayIndex);
      const day = days[dayIndex];
      const startMin = Math.max(0, (new Date(ev.starts_at).getTime() - day.start.getTime()) / 60_000);
      const endMin = Math.min(MINUTES_PER_DAY, (new Date(ev.ends_at).getTime() - day.start.getTime()) / 60_000);
      if (target.closest("[data-resize]")) {
        commit({ kind: "resize", event: ev, dayIndex, startMin, endMin, moved: false, x: e.clientX, y: e.clientY });
      } else {
        commit({
          kind: "move",
          event: ev,
          fromDay: dayIndex,
          offsetMin: loc.minutes - startMin,
          length: endMin - startMin,
          dayIndex,
          startMin,
          moved: false,
          x: e.clientX,
          y: e.clientY,
        });
      }
      return;
    }
    const m = floorMinutes(loc.minutes);
    commit({ kind: "select", dayIndex: loc.dayIndex, anchorMin: m, curMin: m + SNAP_MINUTES, moved: false, x: e.clientX, y: e.clientY });
  }

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const loc = locate(e.clientX, e.clientY);
      if (!loc) return;
      const moved = d.moved || Math.hypot(e.clientX - d.x, e.clientY - d.y) >= DRAG_THRESHOLD_PX;
      if (!moved) return;
      if (d.kind === "select") {
        const m = snapMinutes(loc.minutes);
        commit({ ...d, moved: true, dayIndex: d.dayIndex, curMin: m });
      } else if (d.kind === "move") {
        const startMin = Math.min(MINUTES_PER_DAY - d.length, Math.max(0, snapMinutes(loc.minutes - d.offsetMin)));
        commit({ ...d, moved: true, dayIndex: loc.dayIndex, startMin });
      } else {
        const endMin = Math.max(d.startMin + SNAP_MINUTES, snapMinutes(loc.minutes));
        commit({ ...d, moved: true, endMin });
      }
    };
    const finish = (e: PointerEvent, cancelled: boolean) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setDrag(null);
      if (cancelled) return;
      if (d.kind === "select") {
        const day = days[d.dayIndex];
        const a = Math.min(d.anchorMin, d.curMin);
        const b = Math.max(d.anchorMin, d.curMin);
        const startMin = d.moved ? a : d.anchorMin;
        const endMin = d.moved ? Math.max(b, a + SNAP_MINUTES) : Math.min(MINUTES_PER_DAY, d.anchorMin + 60);
        onCreateSlot(
          {
            starts_at: minutesToInstant(day, startMin, tz).toISOString(),
            ends_at: minutesToInstant(day, endMin, tz).toISOString(),
            all_day: false,
          },
          { x: e.clientX, y: e.clientY },
        );
        return;
      }
      if (!d.moved) {
        onOpenEvent(d.event);
        return;
      }
      if (d.kind === "move") {
        const day = days[d.dayIndex];
        const newStart = minutesToInstant(day, d.startMin, tz);
        if (newStart.toISOString() === d.event.starts_at) return;
        onMoveEvent(d.event, movedRange(d.event, newStart, tz));
      } else {
        const day = days[d.dayIndex];
        const newEnd = minutesToInstant(day, d.endMin, tz);
        if (newEnd.toISOString() === d.event.ends_at) return;
        onResizeEvent(d.event, newEnd.toISOString());
      }
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
    // `locate` reads refs only; days / callbacks are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, tz, onCreateSlot, onMoveEvent, onOpenEvent, onResizeEvent]);

  const hours = Array.from({ length: 24 }, (_, h) => h);
  const gutter = "w-12 shrink-0";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      {/* Day headers */}
      <div className="flex shrink-0 border-b border-border">
        <div className={gutter} />
        {days.map((day) => (
          <div key={day.key} className="flex flex-1 flex-col items-center py-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{names[day.weekday]}</span>
            <span
              className={cn(
                "mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-full text-sm tabular-nums",
                day.isToday ? "bg-primary font-semibold text-primary-foreground" : "text-foreground",
              )}
            >
              {day.dayOfMonth}
            </span>
          </div>
        ))}
      </div>

      {/* All-day strip */}
      <div className="flex shrink-0 border-b border-border bg-muted/20">
        <div className={cn(gutter, "flex items-start justify-end pr-1 pt-1 text-[10px] text-muted-foreground")}>{t("All day")}</div>
        {days.map((day, i) => (
          <div key={day.key} className={cn("flex min-h-7 flex-1 flex-col gap-0.5 p-0.5", i > 0 && "border-l border-border/60")}>
            {perDay[i].allDay.map((ev) => (
              <EventChip key={ev.id} event={ev} tz={tz} showTime={false} onClick={() => onOpenEvent(ev)} />
            ))}
          </div>
        ))}
      </div>

      {/* Time grid */}
      <div ref={scrollRef} className="relative flex-1 overflow-y-auto">
        <div className="flex" style={{ height: 24 * HOUR_PX }}>
          {/* Hour gutter */}
          <div className={cn(gutter, "relative")}>
            {hours.map((h) => (
              <div key={h} className="absolute right-1.5 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground" style={{ top: h * HOUR_PX }}>
                {h > 0 ? `${String(h).padStart(2, "0")}:00` : ""}
              </div>
            ))}
          </div>
          {/* Columns */}
          <div
            ref={bodyRef}
            onPointerDown={onPointerDown}
            className={cn("relative flex flex-1 select-none", !readOnly && "cursor-crosshair")}
            style={{ touchAction: readOnly ? undefined : "pan-y" }}
          >
            {/* Hour lines */}
            {hours.map((h) => (
              <div key={h} className="pointer-events-none absolute inset-x-0 border-t border-border/60" style={{ top: h * HOUR_PX }}>
                <div className="border-t border-dashed border-border/40" style={{ marginTop: HOUR_PX / 2 }} />
              </div>
            ))}
            {days.map((day, i) => {
              const laidOut = perDay[i].timed;
              return (
                <div key={day.key} data-day-index={i} className={cn("relative flex-1", i > 0 && "border-l border-border/60", day.isToday && "bg-primary/[0.03]")}>
                  {laidOut.map((p) => {
                    const isDragged = drag && drag.kind !== "select" && drag.event.id === p.event.id;
                    let startMin = p.startMin;
                    let endMin = p.endMin;
                    let col = p.col;
                    let cols = p.cols;
                    let hidden = false;
                    if (isDragged && drag.kind === "move") {
                      if (drag.dayIndex !== i) hidden = true;
                      startMin = drag.startMin;
                      endMin = drag.startMin + drag.length;
                      col = 0;
                      cols = 1;
                    } else if (isDragged && drag.kind === "resize") {
                      endMin = drag.endMin;
                    }
                    if (hidden) return null;
                    const color = eventColor(p.event);
                    const cancelled = p.event.status === "cancelled";
                    const short = endMin - startMin <= SNAP_MINUTES;
                    return (
                      <div
                        key={p.event.id}
                        data-event-id={p.event.id}
                        data-day-index={i}
                        role="button"
                        tabIndex={0}
                        title={p.event.title}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onOpenEvent(p.event);
                          }
                        }}
                        style={{
                          ...chipStyle(color, cancelled),
                          top: (startMin / 60) * HOUR_PX,
                          height: Math.max(18, ((endMin - startMin) / 60) * HOUR_PX - 2),
                          left: `calc(${(col / cols) * 100}% + 2px)`,
                          width: `calc(${100 / cols}% - 4px)`,
                          touchAction: "none",
                        }}
                        className={cn(
                          "absolute z-10 flex cursor-grab flex-col overflow-hidden rounded-md border-l-[3px] px-1.5 py-0.5 text-[11px] leading-4 outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                          cancelled && "line-through opacity-70",
                          isDragged && "z-20 cursor-grabbing opacity-80 shadow-lg ring-1 ring-primary/40",
                          readOnly && "cursor-pointer",
                        )}
                      >
                        <span className={cn("flex items-center gap-1 font-medium")}>
                          {short && (
                            <span className="shrink-0 tabular-nums opacity-80">
                              {formatTime(minutesToInstant(day, startMin, tz), language, tz)}
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate">{p.event.title}</span>
                          {p.event.source !== "internal" && (
                            <ProviderIcon provider={p.event.source} className="h-2.5 w-2.5 opacity-80" />
                          )}
                        </span>
                        {!short && (
                          <span className="truncate tabular-nums opacity-80">
                            {formatTime(minutesToInstant(day, startMin, tz), language, tz)} – {formatTime(minutesToInstant(day, endMin, tz), language, tz)}
                            {p.event.location ? ` · ${p.event.location}` : ""}
                          </span>
                        )}
                        {!readOnly && !cancelled && (
                          <span
                            data-resize
                            aria-hidden
                            className="absolute inset-x-0 bottom-0 h-2 cursor-s-resize"
                          />
                        )}
                      </div>
                    );
                  })}
                  {/* Ghost of an event dragged in from another column */}
                  {drag && drag.kind === "move" && drag.moved && drag.dayIndex === i && drag.fromDay !== i && (
                    <div
                      className="pointer-events-none absolute z-20 rounded-md border-l-[3px] px-1.5 py-0.5 text-[11px] opacity-80 shadow-lg ring-1 ring-primary/40"
                      style={{
                        ...chipStyle(eventColor(drag.event)),
                        top: (drag.startMin / 60) * HOUR_PX,
                        height: Math.max(18, (drag.length / 60) * HOUR_PX - 2),
                        left: 2,
                        right: 2,
                      }}
                    >
                      <span className="truncate font-medium">{drag.event.title}</span>
                    </div>
                  )}
                  {/* Selection while drag-creating */}
                  {drag && drag.kind === "select" && drag.dayIndex === i && (
                    <div
                      className="pointer-events-none absolute inset-x-0.5 z-20 rounded-md border border-primary/50 bg-primary/15 px-1.5 py-0.5 text-[11px] text-primary"
                      style={{
                        top: (Math.min(drag.anchorMin, drag.curMin) / 60) * HOUR_PX,
                        height: Math.max(SNAP_MINUTES / 60, Math.abs(drag.curMin - drag.anchorMin) / 60) * HOUR_PX,
                      }}
                    >
                      {formatTime(minutesToInstant(day, Math.min(drag.anchorMin, drag.curMin), tz), language, tz)} –{" "}
                      {formatTime(minutesToInstant(day, Math.max(drag.anchorMin, drag.curMin, drag.anchorMin + SNAP_MINUTES), tz), language, tz)}
                    </div>
                  )}
                  {/* Now line */}
                  {todayIndex === i && (
                    <div className="pointer-events-none absolute inset-x-0 z-30 border-t-2 border-red-500" style={{ top: (nowMin / 60) * HOUR_PX }}>
                      <span className="absolute -left-1 -top-[5px] h-2 w-2 rounded-full bg-red-500" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
