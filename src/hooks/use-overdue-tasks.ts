"use client";

import { useEffect, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { countOpenTasks, listTaskStatuses } from "@/lib/tasks";

/**
 * Number of the signed-in user's open tasks whose due date has
 * passed. Drives the red badge on the sidebar's Tarefas entry.
 *
 * Counter-parts `useTotalUnread`: its own realtime channel (tasks +
 * task_statuses, RLS-filtered server-side) and a debounced recount
 * on every change — head-only counts are cheap and this avoids
 * mirroring the due/status logic client-side.
 *
 * Pass `enabled: false` when the Tasks module is off for the account.
 */
export function useOverdueTasks(enabled = true): number {
  const { user, accountId } = useAuth();
  const userId = user?.id ?? null;
  const [count, setCount] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || !userId || !accountId) return;
    const supabase = createClient();
    let cancelled = false;

    const recount = async () => {
      try {
        const statuses = await listTaskStatuses(supabase, accountId);
        const { overdue } = await countOpenTasks(supabase, statuses, {
          accountId,
          assigneeUserId: userId,
        });
        if (!cancelled) setCount(overdue);
      } catch (err) {
        console.error("[tasks] overdue count:", err);
      }
    };
    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void recount(), 300);
    };

    void recount();

    // Unique topic per mount: `supabase.channel()` hands back an existing
    // channel with the same name, and under React's dev double-mount
    // that is the one being torn down — its re-subscribe never lands.
    const channel = supabase
      .channel(`overdue-tasks-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, schedule)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "task_statuses" },
        schedule,
      )
      .subscribe();

    // A task that becomes overdue while the app sits open should light
    // the badge without any DB change — recount every minute.
    const tick = setInterval(() => void recount(), 60_000);

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      clearInterval(tick);
      supabase.removeChannel(channel);
    };
  }, [enabled, userId, accountId]);

  return enabled ? count : 0;
}
