"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  listCalendarMembers,
  listLinkedEvents,
  safeTimezone,
  type CalendarEvent,
  type CalendarMember,
  type EventLinkFilter,
} from "@/lib/calendar";

/** The account timezone every calendar surface formats in. */
export function useCalendarTimezone(): string {
  const { preferences } = useAuth();
  return safeTimezone(preferences.business_hours.timezone);
}

/** Account members for the owner select, attendee chips and the colour palette. */
export function useCalendarMembers(opts: { enabled?: boolean } = {}) {
  const { enabled = true } = opts;
  const { accountId } = useAuth();
  const [members, setMembers] = useState<CalendarMember[]>([]);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled || !accountId) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listCalendarMembers(createClient(), accountId);
        if (!cancelled) setMembers(rows);
      } catch (err) {
        console.error("[calendar] members:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, enabled]);

  return { members, loading };
}

export function memberName(members: readonly CalendarMember[], userId: string | null | undefined): string {
  if (!userId) return "";
  const m = members.find((x) => x.user_id === userId);
  return m ? m.full_name?.trim() || m.email : "";
}

/**
 * Re-run `onChange` (debounced) whenever an event or an attendee row
 * changes. Realtime rows are RLS-filtered server-side, so no
 * per-account channel filter is needed.
 */
export function useCalendarRealtime(onChange: () => void, opts: { enabled?: boolean } = {}) {
  const { enabled = true } = opts;
  const cbRef = useRef(onChange);
  useEffect(() => {
    cbRef.current = onChange;
  });

  useEffect(() => {
    if (!enabled) return;
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cbRef.current(), 300);
    };
    const channel = supabase
      .channel(`calendar-live-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "calendar_events" }, fire)
      .on("postgres_changes", { event: "*", schema: "public", table: "calendar_event_attendees" }, fire)
      .subscribe();
    const onVisible = () => {
      if (document.visibilityState === "visible") fire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    };
  }, [enabled]);
}

// ------------------------------------------------------------
// useLinkedEvents — upcoming events of one record, kept live.
// Shared by the inbox panel, the contact page, the deal drawer and
// the task drawer so every "Agenda" section behaves the same way.
// ------------------------------------------------------------

export interface UseLinkedEventsOptions extends EventLinkFilter {
  enabled?: boolean;
  /** Default 3 — the sections show "the next three". */
  limit?: number;
}

export interface LinkedEventsState {
  events: CalendarEvent[];
  loading: boolean;
  refresh: () => Promise<void>;
  /** Merge a row the drawer / quick-add just wrote (drops cancelled ones). */
  patch: (event: CalendarEvent) => void;
  remove: (eventId: string) => void;
}

export function useLinkedEvents(opts: UseLinkedEventsOptions): LinkedEventsState {
  const { enabled = true, limit = 3, contactId, conversationId, dealId, taskId, chatThreadId } = opts;
  const active = enabled && !!(contactId || conversationId || dealId || taskId || chatThreadId);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(active);

  const refresh = useCallback(async () => {
    if (!active) return;
    try {
      const rows = await listLinkedEvents(createClient(), {
        contactId,
        conversationId,
        dealId,
        taskId,
        chatThreadId,
        limit,
      });
      setEvents(rows);
    } catch (err) {
      console.error("[calendar] linked list:", err);
    } finally {
      setLoading(false);
    }
  }, [active, contactId, conversationId, dealId, taskId, chatThreadId, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useCalendarRealtime(() => void refresh(), { enabled: active });

  const patch = useCallback(
    (event: CalendarEvent) => {
      setEvents((prev) => {
        const next = prev.filter((x) => x.id !== event.id);
        if (event.status !== "confirmed" || new Date(event.ends_at).getTime() <= Date.now()) return next;
        return [...next, event]
          .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
          .slice(0, limit);
      });
    },
    [limit],
  );

  const remove = useCallback((eventId: string) => {
    setEvents((prev) => prev.filter((x) => x.id !== eventId));
  }, []);

  return useMemo(() => ({ events, loading, refresh, patch, remove }), [events, loading, refresh, patch, remove]);
}
