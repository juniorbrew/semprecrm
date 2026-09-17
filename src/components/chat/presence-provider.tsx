"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  applyTyping,
  nextTypingExpiry,
  onlineIdsFromState,
  presenceChannelName,
  pruneTyping,
  touchLastSeen,
  TYPING_THROTTLE_MS,
  typingUsersIn,
  type PresenceMeta,
  type TypingMap,
  type TypingPayload,
} from "@/lib/chat";

/** Heartbeat interval for `profiles.last_seen_at` (spec: 30 s). */
export const LAST_SEEN_HEARTBEAT_MS = 30_000;

interface ChatPresenceValue {
  /** True while the account presence channel is joined. */
  connected: boolean;
  /** User ids currently tracked on the account presence channel. */
  onlineIds: ReadonlySet<string>;
  isOnline: (userId: string) => boolean;
  /** Other users typing in `threadId` right now. */
  typingIn: (threadId: string) => string[];
  /** Broadcast "I'm typing in this thread" (throttled). */
  sendTyping: (threadId: string) => void;
}

const EMPTY: ChatPresenceValue = {
  connected: false,
  onlineIds: new Set(),
  isOnline: () => false,
  typingIn: () => [],
  sendTyping: () => {},
};

const ChatPresenceContext = createContext<ChatPresenceValue>(EMPTY);

/**
 * Account presence (spec "Presença"): joins `presence:account:<id>`
 * with the user id as tracking key, tracks `{ user_id, at }` on join
 * (the channel drops it when the tab closes), relays `typing`
 * broadcasts with a 3 s expiry and keeps the `last_seen_at` heartbeat
 * going every 30 s while the tab is visible.
 *
 * Mounted once in the dashboard shell; `enabled` is the
 * `internal_chat` module flag so accounts without the module open no
 * channel at all.
 */
export function ChatPresenceProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const { user, accountId } = useAuth();
  const userId = user?.id ?? null;

  const [connected, setConnected] = useState(false);
  const [onlineIds, setOnlineIds] = useState<ReadonlySet<string>>(() => new Set());
  const [typing, setTyping] = useState<TypingMap>(() => new Map());
  const channelRef = useRef<RealtimeChannel | null>(null);
  const lastTypingSentRef = useRef<{ threadId: string; at: number } | null>(null);

  // Presence + typing channel.
  useEffect(() => {
    if (!enabled || !userId || !accountId) return;
    const supabase = createClient();
    const channel = supabase.channel(presenceChannelName(accountId), {
      config: { presence: { key: userId } },
    });
    channelRef.current = channel;

    const syncOnline = () => {
      const state = channel.presenceState() as Record<string, Partial<PresenceMeta>[]>;
      setOnlineIds(onlineIdsFromState(state));
    };

    channel
      .on("presence", { event: "sync" }, syncOnline)
      .on("presence", { event: "join" }, syncOnline)
      .on("presence", { event: "leave" }, syncOnline)
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        const p = payload as Partial<TypingPayload> | undefined;
        if (!p || typeof p.thread_id !== "string" || typeof p.user_id !== "string") return;
        if (p.user_id === userId) return;
        setTyping((prev) => applyTyping(prev, { thread_id: p.thread_id!, user_id: p.user_id! }));
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          setConnected(true);
          const meta: PresenceMeta = { user_id: userId, at: new Date().toISOString() };
          await channel.track(meta);
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setConnected(false);
        }
      });

    return () => {
      channelRef.current = null;
      setConnected(false);
      setOnlineIds(new Set());
      setTyping(new Map());
      supabase.removeChannel(channel);
    };
  }, [enabled, userId, accountId]);

  // Expire typing entries: schedule one prune at the earliest expiry.
  useEffect(() => {
    const next = nextTypingExpiry(typing);
    if (next === null) return;
    const delay = Math.max(0, next - Date.now());
    const id = setTimeout(() => setTyping((prev) => pruneTyping(prev)), delay + 10);
    return () => clearTimeout(id);
  }, [typing]);

  // last_seen_at heartbeat — only while the tab is visible.
  useEffect(() => {
    if (!enabled || !userId) return;
    const supabase = createClient();
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      touchLastSeen(supabase, userId).catch((err) => {
        console.error("[chat] last_seen heartbeat:", err);
      });
    };
    beat();
    const interval = window.setInterval(beat, LAST_SEEN_HEARTBEAT_MS);
    document.addEventListener("visibilitychange", beat);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", beat);
    };
  }, [enabled, userId]);

  const sendTyping = useCallback(
    (threadId: string) => {
      const channel = channelRef.current;
      if (!channel || !userId) return;
      const now = Date.now();
      const last = lastTypingSentRef.current;
      if (last && last.threadId === threadId && now - last.at < TYPING_THROTTLE_MS) return;
      lastTypingSentRef.current = { threadId, at: now };
      const payload: TypingPayload = { thread_id: threadId, user_id: userId };
      void channel.send({ type: "broadcast", event: "typing", payload });
    },
    [userId],
  );

  const value = useMemo<ChatPresenceValue>(
    () => ({
      connected,
      onlineIds,
      isOnline: (id) => onlineIds.has(id),
      typingIn: (threadId) => typingUsersIn(typing, threadId, userId),
      sendTyping,
    }),
    [connected, onlineIds, typing, userId, sendTyping],
  );

  return <ChatPresenceContext.Provider value={value}>{children}</ChatPresenceContext.Provider>;
}

/** Online ids + typing state for the current account. Safe outside the provider (empty). */
export function useChatPresence(): ChatPresenceValue {
  return useContext(ChatPresenceContext);
}
