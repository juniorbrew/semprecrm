"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  listTaskMembers,
  listTaskStatuses,
  type TaskMember,
  type TaskStatus,
} from "@/lib/tasks";

/**
 * The account's task statuses (board columns). Loaded once per
 * account; `refresh` re-reads after the settings panel edits them.
 * Pass `enabled: false` when the parent already supplies the list.
 */
export function useTaskStatuses(opts: { enabled?: boolean } = {}) {
  const { enabled = true } = opts;
  const { accountId } = useAuth();
  const [statuses, setStatuses] = useState<TaskStatus[]>([]);
  const [loading, setLoading] = useState(enabled);

  const refresh = useCallback(async () => {
    if (!accountId) return;
    try {
      const rows = await listTaskStatuses(createClient(), accountId);
      setStatuses(rows);
    } catch (err) {
      console.error("[tasks] statuses:", err);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [refresh, enabled]);

  return { statuses, loading, refresh };
}

/** Account members for the assignee picker and avatar chips. */
export function useTaskMembers(opts: { enabled?: boolean } = {}) {
  const { enabled = true } = opts;
  const { accountId } = useAuth();
  const [members, setMembers] = useState<TaskMember[]>([]);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled || !accountId) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listTaskMembers(createClient(), accountId);
        if (!cancelled) setMembers(rows);
      } catch (err) {
        console.error("[tasks] members:", err);
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

/**
 * Re-run `onChange` (debounced) whenever the given tables change.
 * Realtime rows are RLS-filtered server-side, so no per-account
 * channel filter is needed.
 */
export function useTasksRealtime(
  onChange: () => void,
  opts: {
    enabled?: boolean;
    tables?: ("tasks" | "task_comments" | "task_statuses")[];
  } = {},
) {
  const { enabled = true, tables = ["tasks", "task_comments"] } = opts;
  const cbRef = useRef(onChange);
  useEffect(() => {
    cbRef.current = onChange;
  });
  const key = tables.join(",");

  useEffect(() => {
    if (!enabled) return;
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cbRef.current(), 300);
    };
    let channel = supabase.channel(
      `tasks-live-${key}-${Math.random().toString(36).slice(2)}`,
    );
    for (const table of key.split(",")) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        fire,
      );
    }
    channel.subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [enabled, key]);
}
