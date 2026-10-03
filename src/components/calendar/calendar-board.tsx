"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { useLanguage } from "@/hooks/use-language";
import {
  CALENDAR_VIEWS,
  filterByScope,
  formatPeriodTitle,
  getEvent,
  gridFor,
  isCalendarView,
  listEventsInRange,
  moveEvent,
  resizeEvent,
  shiftAnchor,
  visibleRange,
  type CalendarEvent,
  type CalendarEventInput,
  type CalendarScope,
  type CalendarView,
  type GridDay,
} from "@/lib/calendar";
import { GatedButton } from "@/components/ui/gated-button";
import type { Language } from "@/lib/i18n";
import { useDensity } from "@/components/tasks/density";
import { DensityToggle } from "@/components/tasks/density-toggle";
import { cn } from "@/lib/utils";

import { EventDrawer } from "./event-drawer";
import { useCalendarMembers, useCalendarRealtime, useCalendarTimezone } from "./hooks";
import { MonthView } from "./month-view";
import { QuickCreate, type QuickCreateDraft } from "./quick-create";
import { TimeGridView } from "./time-grid-view";

const VIEW_STORAGE_KEY = "calendar:view";

const VIEW_LABELS: Record<CalendarView, string> = { month: "Month", week: "Week", day: "Day" };

const AGENDA_COPY: Record<Language, { title: string; compact: string; count: (n: number) => string }> = {
  "pt-BR": {
    title: "Agenda",
    compact: "Grade compacta",
    count: (n) => (n === 1 ? "1 compromisso" : `${n} compromissos`),
  },
  "en-US": {
    title: "Calendar",
    compact: "Compact grid",
    count: (n) => (n === 1 ? "1 appointment" : `${n} appointments`),
  },
};

function readStoredView(): CalendarView {
  if (typeof window === "undefined") return "week";
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (isCalendarView(raw)) return raw;
  } catch {}
  return "week";
}

/**
 * The /agenda page: header (today, ‹ ›, period title, Month | Week |
 * Day, Mine / Team / person, New appointment) over the month grid or
 * the week / day time grid. Owns the event list for the visible range
 * (realtime), the drawer, the quick-create popover and the optimistic
 * move / resize.
 */
export function CalendarBoard() {
  const supabase = useMemo(() => createClient(), []);
  const { t, language } = useLanguage();
  const copy = AGENDA_COPY[language] ?? AGENDA_COPY["pt-BR"];
  const [density, toggleDensity] = useDensity("agenda");
  const compact = density === "compact";
  const { accountId, user } = useAuth();
  const canWrite = useCan("send-messages");
  const tz = useCalendarTimezone();
  const searchParams = useSearchParams();
  const { members } = useCalendarMembers();
  const me = user?.id ?? null;

  const [view, setView] = useState<CalendarView>(readStoredView);
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [scope, setScope] = useState<CalendarScope>("mine");
  const [now, setNow] = useState<Date>(() => new Date());
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerEvent, setDrawerEvent] = useState<CalendarEvent | null>(null);
  const [drawerDefaults, setDrawerDefaults] = useState<Partial<CalendarEventInput> | undefined>(undefined);
  const [quick, setQuick] = useState<{ draft: QuickCreateDraft; anchor: { x: number; y: number } } | null>(null);

  // Tick every minute for the "now" line and the today highlight.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const changeView = useCallback((next: CalendarView) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {}
  }, []);

  const days = useMemo(() => gridFor(view, anchor, tz, now), [view, anchor, tz, now]);
  const range = useMemo(() => visibleRange(view, anchor, tz), [view, anchor, tz]);

  const load = useCallback(async () => {
    try {
      // Cancelled rows stay visible (struck through) so they can be restored.
      const rows = await listEventsInRange(supabase, { accountId, from: range.from, to: range.to, includeCancelled: true });
      setEvents(rows);
    } catch (err) {
      console.error("[calendar] load:", err);
      toast.error(t("Failed to load appointments"));
      setEvents([]);
    }
  }, [supabase, accountId, range.from, range.to, t]);

  // `load` only sets state after its awaited fetch, never synchronously.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useCalendarRealtime(() => void load());

  // Phase 2: on open, pull the user's Google / Outlook changes when the
  // last sync is older than 2 min (the route decides; cheap otherwise).
  // Realtime on `calendar_events` repaints whatever the sync writes.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/integrations/calendar/sync/me?ifStale=1", { method: "POST" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { connections?: number } | null) => {
        if (!cancelled && body && body.connections) void load();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Once per mount — `load` is stable for the initial range.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleEvents = useMemo(() => filterByScope(events ?? [], scope, me), [events, scope, me]);

  // `?event=<id>` (push click, "Agenda" sections): jump to it and open the drawer.
  const deepLinkId = searchParams.get("event");
  const deepLinkApplied = useRef<string | null>(null);
  useEffect(() => {
    if (!deepLinkId || deepLinkApplied.current === deepLinkId) return;
    let cancelled = false;
    getEvent(supabase, deepLinkId)
      .then((ev) => {
        // Marked only once applied: StrictMode's first (cancelled) run
        // must not swallow the deep link.
        if (cancelled || !ev) return;
        deepLinkApplied.current = deepLinkId;
        setAnchor(new Date(ev.starts_at));
        setScope("team");
        setDrawerEvent(ev);
        setDrawerDefaults(undefined);
        setDrawerOpen(true);
      })
      .catch((err) => console.error("[calendar] deep link:", err));
    return () => {
      cancelled = true;
    };
  }, [deepLinkId, supabase]);

  // ---- handlers ---------------------------------------------------
  const openEvent = useCallback((ev: CalendarEvent) => {
    setDrawerEvent(ev);
    setDrawerDefaults(undefined);
    setDrawerOpen(true);
  }, []);

  const openCreate = useCallback((defaults?: Partial<CalendarEventInput>) => {
    setDrawerEvent(null);
    setDrawerDefaults({ owner_user_id: typeof scope === "object" ? scope.userId : undefined, ...defaults });
    setDrawerOpen(true);
  }, [scope]);

  const upsertLocal = useCallback((ev: CalendarEvent) => {
    setEvents((prev) => {
      const list = prev ?? [];
      const next = list.filter((x) => x.id !== ev.id);
      return [...next, ev].sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
    });
  }, []);

  const handleMove = useCallback(
    async (ev: CalendarEvent, newRange: { starts_at: string; ends_at: string }) => {
      upsertLocal({ ...ev, ...newRange });
      try {
        const saved = await moveEvent(supabase, ev, newRange);
        upsertLocal(saved);
      } catch (err) {
        console.error("[calendar] move:", err);
        toast.error(t("Failed to move appointment"));
        void load();
      }
    },
    [supabase, upsertLocal, load, t],
  );

  const handleResize = useCallback(
    async (ev: CalendarEvent, endsAt: string) => {
      upsertLocal({ ...ev, ends_at: endsAt });
      try {
        const saved = await resizeEvent(supabase, ev, endsAt);
        upsertLocal(saved);
      } catch (err) {
        console.error("[calendar] resize:", err);
        toast.error(t("Failed to move appointment"));
        void load();
      }
    },
    [supabase, upsertLocal, load, t],
  );

  const handleCreateSlot = useCallback((draft: QuickCreateDraft, at: { x: number; y: number }) => {
    setQuick({ draft, anchor: at });
  }, []);

  const handleCreateAtDay = useCallback(
    (day: GridDay, at: { x: number; y: number }) => {
      // Month grid: a one-hour slot at 09:00 of that day, adjustable in the popover.
      const start = new Date(day.start.getTime() + 9 * 3_600_000);
      setQuick({
        draft: { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3_600_000).toISOString(), all_day: false },
        anchor: at,
      });
    },
    [],
  );

  const showDay = useCallback(
    (day: GridDay) => {
      setAnchor(day.start);
      changeView("day");
    },
    [changeView],
  );

  const scopeValue = scope === "mine" ? "mine" : scope === "team" ? "team" : scope.userId;
  const title = formatPeriodTitle(view, anchor, language, tz);
  const loading = events === null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header: title + neutral count, density, one filled action. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{copy.title}</h1>
        {!loading && (
          <span
            className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-bold tabular-nums text-muted-foreground"
            title={copy.count(visibleEvents.length)}
            aria-label={copy.count(visibleEvents.length)}
          >
            {visibleEvents.length}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <DensityToggle density={density} onToggle={toggleDensity} label={copy.compact} />
          <GatedButton
            canAct={canWrite}
            gateReason="create appointments"
            onClick={() => openCreate()}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 size-4" />
            {t("New appointment")}
          </GatedButton>
        </div>
      </div>

      {/* Toolbar: today, ‹ ›, period, view segments, whose. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setAnchor(new Date())}
          className="h-8 rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          {t("Today")}
        </button>
        <div className="flex items-center">
          <button
            type="button"
            aria-label={t("Previous")}
            title={t("Previous")}
            onClick={() => setAnchor((a) => shiftAnchor(view, a, -1, tz))}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            aria-label={t("Next")}
            title={t("Next")}
            onClick={() => setAnchor((a) => shiftAnchor(view, a, 1, tz))}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
        <h2 className="min-w-0 truncate text-base font-semibold text-foreground" data-testid="period-title" aria-live="polite">
          {title}
        </h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label={t("View")} className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
            {CALENDAR_VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => changeView(v)}
                className={cn(
                  "h-7 rounded-[calc(var(--radius)-4px)] px-2.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  view === v ? "bg-background text-primary shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(VIEW_LABELS[v])}
              </button>
            ))}
          </div>
          <select
            value={scopeValue}
            aria-label={t("Whose appointments")}
            onChange={(e) => {
              const v = e.target.value;
              setScope(v === "mine" ? "mine" : v === "team" ? "team" : { userId: v });
            }}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none transition-colors duration-150 hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none"
          >
            <option value="mine">{t("Mine")}</option>
            <option value="team">{t("Team")}</option>
            {members
              .filter((m) => m.user_id !== me)
              .map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.full_name?.trim() || m.email}
                </option>
              ))}
          </select>
        </div>
      </div>

      {/* Grid */}
      <div className="min-h-[520px] flex-1">
        {view === "month" ? (
          <MonthView
            days={days}
            events={visibleEvents}
            tz={tz}
            compact={compact}
            readOnly={!canWrite}
            onOpenEvent={openEvent}
            onCreateAt={handleCreateAtDay}
            onMoveEvent={(ev, r) => void handleMove(ev, r)}
            onShowDay={showDay}
          />
        ) : (
          <TimeGridView
            key={view}
            days={days}
            events={visibleEvents}
            tz={tz}
            now={now}
            compact={compact}
            readOnly={!canWrite}
            onOpenEvent={openEvent}
            onCreateSlot={handleCreateSlot}
            onMoveEvent={(ev, r) => void handleMove(ev, r)}
            onResizeEvent={(ev, end) => void handleResize(ev, end)}
          />
        )}
      </div>

      {quick && (
        <QuickCreate
          draft={quick.draft}
          anchor={quick.anchor}
          withContact
          defaults={typeof scope === "object" ? { owner_user_id: scope.userId } : undefined}
          onCreated={upsertLocal}
          onMoreOptions={(draft) => openCreate(draft)}
          onCancel={() => setQuick(null)}
        />
      )}

      <EventDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        event={drawerEvent}
        defaults={drawerDefaults}
        members={members}
        onCreated={upsertLocal}
        onUpdated={upsertLocal}
        onDeleted={(id) => setEvents((prev) => (prev ? prev.filter((x) => x.id !== id) : prev))}
      />
    </div>
  );
}
