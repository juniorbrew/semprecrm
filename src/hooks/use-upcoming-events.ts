"use client";

import { useEffect, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { listUpcomingEvents } from "@/lib/calendar";

/**
 * Number of my confirmed appointments (owner or attendee) starting in
 * the next two hours. Drives the badge on the sidebar's Agenda entry.
 *
 * Mirrors `useOverdueTasks`: its own realtime channel on the calendar
 * tables (RLS-filtered server-side), a debounced recount on every
 * change, plus a minute tick so the window slides as time passes.
 *
 * Pass `enabled: false` when the `calendar` module is off.
 */
export function useUpcomingEvents(enabled = true): number {
  const { user, accountId } = useAuth();
  const userId = user?.id ?? null;
  const [count, setCount] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || !userId) return;
    const supabase = createClient();
    let cancelled = false;

    const recount = async () => {
      try {
        const rows = await listUpcomingEvents(supabase, { accountId, userId });
        if (!cancelled) setCount(rows.length);
      } catch (err) {
        console.error("[calendar] upcoming count:", err);
      }
    };
    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void recount(), 300);
    };

    void recount();
    const tick = setInterval(() => void recount(), 60_000);

    const channel = supabase
      .channel(`calendar-upcoming-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "calendar_events" }, schedule)
      .on("postgres_changes", { event: "*", schema: "public", table: "calendar_event_attendees" }, schedule)
      .subscribe();

    const onVisible = () => {
      if (document.visibilityState === "visible") schedule();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    };
  }, [enabled, userId, accountId]);

  return enabled ? count : 0;
}
