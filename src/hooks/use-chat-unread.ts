"use client";

import { useEffect, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { countUnreadMessages, markAllDelivered } from "@/lib/chat";

/**
 * Number of internal-chat messages addressed to the signed-in user
 * with no read receipt (direct: `read_at`; group: my receipt row — see
 * `chat_unread_counts()` in migration 039). Drives the badge on the
 * sidebar's Chat entry.
 *
 * Mirrors `useOverdueTasks`: its own realtime channel on the chat
 * tables (RLS-filtered server-side) and a debounced recount on every
 * change. It is also the "I'm online" hook for delivery receipts: on
 * mount and on every INSERT from someone else it stamps `delivered_at`
 * on the pending rows, so a sender sees ✓✓ as soon as this client is
 * up — whether or not /chat is open.
 *
 * Pass `enabled: false` when the `internal_chat` module is off.
 */
export function useChatUnread(enabled = true): number {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [count, setCount] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || !userId) return;
    const supabase = createClient();
    let cancelled = false;

    const recount = async () => {
      try {
        const n = await countUnreadMessages(supabase);
        if (!cancelled) setCount(n);
      } catch (err) {
        console.error("[chat] unread count:", err);
      }
    };
    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void recount(), 300);
    };
    const deliverPending = () => {
      markAllDelivered(supabase).catch((err) => {
        console.error("[chat] mark delivered:", err);
      });
    };

    void recount();
    deliverPending();

    // Unique topic per mount (see useOverdueTasks for why).
    const channel = supabase
      .channel(`chat-unread-${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        (payload) => {
          const row = payload.new as { sender_id?: string } | null;
          if (row?.sender_id && row.sender_id !== userId) deliverPending();
          schedule();
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "chat_messages" },
        schedule,
      )
      // Group threads: my read receipts (and membership changes) move the count.
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_message_receipts" }, schedule)
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_thread_members" }, schedule)
      .subscribe();

    // Realtime can drop while a laptop sleeps — resync when the tab comes
    // back so the badge and the delivery receipts stay honest.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        deliverPending();
        schedule();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    };
  }, [enabled, userId]);

  return enabled ? count : 0;
}
