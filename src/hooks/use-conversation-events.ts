"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  insertConversationEvent,
  upsertEventRecord,
  type ConversationEventDraft,
} from "@/lib/conversations/events";
import type { ConversationEventRecord } from "@/types";

/**
 * Server-backed system events for one conversation (assignment / status /
 * label / note changes) from `conversation_events`.
 *
 * - Fetches the log when the conversation (or `resyncToken`) changes.
 * - Subscribes to realtime INSERTs filtered by conversation, the same
 *   per-thread channel pattern the reactions use, so a teammate's
 *   "resolveu a conversa" lands in every open tab within a second.
 * - `logEvent` INSERTs a row as the current user (RLS requires
 *   `actor_user_id = auth.uid()`) and adds the returned row optimistically;
 *   the realtime echo is deduped by id.
 */
export function useConversationEvents(
  conversationId: string | null | undefined,
  resyncToken = 0,
) {
  const { user, profile, accountId } = useAuth();
  const [events, setEvents] = useState<ConversationEventRecord[]>([]);

  // Initial load + resync. Cleared when the thread changes so pills from
  // conversation A never flash inside conversation B.
  useEffect(() => {
    if (!conversationId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEvents([]);
      return;
    }
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("conversation_events")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });
      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch conversation events:", {
          message: error.message,
          details: error.details,
          code: error.code,
        });
        return;
      }
      setEvents((data as ConversationEventRecord[]) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, resyncToken]);

  // Realtime INSERTs (rows are immutable, so INSERT is the only change).
  useEffect(() => {
    if (!conversationId) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`conversation-events:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "conversation_events",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as ConversationEventRecord;
          setEvents((prev) => upsertEventRecord(prev, row));
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  const actorName = profile?.full_name || user?.email || undefined;

  const logEvent = useCallback(
    async (draft: ConversationEventDraft): Promise<ConversationEventRecord | null> => {
      if (!conversationId || !accountId) return null;
      const row = await insertConversationEvent(createClient(), {
        account_id: accountId,
        conversation_id: conversationId,
        actor_user_id: user?.id ?? null,
        event_type: draft.event_type,
        payload: { actor_name: actorName, ...draft.payload },
      });
      if (row) setEvents((prev) => upsertEventRecord(prev, row));
      return row;
    },
    [conversationId, accountId, user?.id, actorName],
  );

  return { events, logEvent };
}
