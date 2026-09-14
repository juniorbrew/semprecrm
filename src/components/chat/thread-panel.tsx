"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useLanguage } from "@/hooks/use-language";
import { notifyPushEvent, reportChatThreadFocus } from "@/lib/push/client";
import {
  groupMessagesByDay,
  listMessages,
  markThreadDelivered,
  markThreadRead,
  memberDisplayName,
  mergeMessages,
  sendChatMessage,
} from "@/lib/chat";
import type { ChatMember, ChatMessage, ChatThread } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

import { ChatComposer } from "./composer";
import { lastSeenLabel } from "./last-seen";
import { ChatMessageBubble } from "./message-bubble";

interface ThreadPanelProps {
  thread: ChatThread;
  other: ChatMember;
  userId: string;
  accountId: string;
  online: boolean;
  /** Someone (the other person) is typing in this thread. */
  typing: boolean;
  now: number;
  onTyping: (threadId: string) => void;
  /** Mobile: go back to the people list. */
  onBack: () => void;
  /** Called after a send / receipt so the list can refresh previews + badges. */
  onActivity: () => void;
}

/** How close to the bottom (px) still counts as "following the tail". */
const NEAR_BOTTOM_PX = 80;

function dayLabel(iso: string, now: number, language: string, t: (s: string) => string): string {
  const d = new Date(iso);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === today.toDateString()) return t("Today");
  if (d.toDateString() === yesterday.toDateString()) return t("Yesterday");
  return new Intl.DateTimeFormat(language, { dateStyle: "long" }).format(d);
}

/**
 * Right side of /chat: header (name + presence / last seen / typing),
 * the paginated history with day separators, and the composer.
 *
 * Receipts (spec "Entrega e leitura"): every message from the other
 * side that reaches this client — first page, older pages, realtime
 * INSERT — is stamped `delivered_at`; while the tab is visible the
 * thread is also stamped `read_at` (+ my `last_read_at`). The thread
 * is reported to /api/push/seen so pushes for it are skipped.
 */
export function ThreadPanel({
  thread,
  other,
  userId,
  accountId,
  online,
  typing,
  now,
  onTyping,
  onBack,
  onActivity,
}: ThreadPanelProps) {
  const { t, language } = useLanguage();
  const supabase = useMemo(() => createClient(), []);
  const threadId = thread.id;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const cursorRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followTailRef = useRef(true);
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const onActivityRef = useRef(onActivity);
  useEffect(() => {
    onActivityRef.current = onActivity;
  });

  // ---- receipts ------------------------------------------------------
  const deliver = useCallback(() => {
    markThreadDelivered(supabase, threadId, userId)
      .then((ids) => {
        if (ids.length > 0) onActivityRef.current();
      })
      .catch((err) => console.error("[chat] deliver:", err));
  }, [supabase, threadId, userId]);

  const read = useCallback(() => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    markThreadRead(supabase, threadId, userId)
      .then((ids) => {
        if (ids.length > 0) {
          const stamp = new Date().toISOString();
          setMessages((prev) =>
            prev.map((m) =>
              ids.includes(m.id) ? { ...m, read_at: m.read_at ?? stamp, delivered_at: m.delivered_at ?? stamp } : m,
            ),
          );
          onActivityRef.current();
        }
      })
      .catch((err) => console.error("[chat] read:", err));
  }, [supabase, threadId, userId]);

  // ---- first page ----------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setLoading(true);
    setHasMore(false);
    cursorRef.current = null;
    followTailRef.current = true;
    (async () => {
      try {
        const page = await listMessages(supabase, threadId);
        if (cancelled) return;
        setMessages(page.messages);
        setHasMore(page.hasMore);
        cursorRef.current = page.nextCursor;
      } catch (err) {
        console.error(err);
        if (!cancelled) toast.error(t("Failed to load messages"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `t` is stable per language; re-running on a language flip would refetch for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, threadId]);

  // Opening the thread: pending rows become delivered, and read while visible.
  useEffect(() => {
    if (loading) return;
    deliver();
    read();
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loading, deliver, read]);

  // ---- realtime on this thread --------------------------------------
  useEffect(() => {
    const channel = supabase
      .channel(`chat-thread-${threadId}-${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages", filter: `thread_id=eq.${threadId}` },
        (payload) => {
          const row = payload.new as ChatMessage;
          setMessages((prev) => mergeMessages(prev, [row]));
          if (row.sender_id !== userId) {
            deliver();
            read();
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "chat_messages", filter: `thread_id=eq.${threadId}` },
        (payload) => {
          const row = payload.new as ChatMessage;
          setMessages((prev) => mergeMessages(prev, [row]));
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, threadId, userId, deliver, read]);

  // Realtime can lapse while the tab sleeps: on return, pull the newest
  // page again so nothing stays missing until the next event.
  useEffect(() => {
    const resync = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const page = await listMessages(supabase, threadId);
        setMessages((prev) => mergeMessages(prev, page.messages));
        deliver();
        read();
      } catch (err) {
        console.error("[chat] resync:", err);
      }
    };
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("focus", resync);
    return () => {
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("focus", resync);
    };
  }, [supabase, threadId, deliver, read]);

  // ---- "I'm looking at this thread" for the push trigger -------------
  useEffect(() => {
    const send = () => {
      reportChatThreadFocus(document.visibilityState === "visible" ? threadId : null);
    };
    send();
    const interval = window.setInterval(send, 30_000);
    document.addEventListener("visibilitychange", send);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", send);
      reportChatThreadFocus(null);
    };
  }, [threadId]);

  // ---- scrolling -----------------------------------------------------
  // Keep the view pinned to the newest message unless the user scrolled
  // up; when an older page is prepended, keep the visible messages still.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pendingScrollRestoreRef.current !== null) {
      const before = pendingScrollRestoreRef.current;
      pendingScrollRestoreRef.current = null;
      el.scrollTop = el.scrollHeight - before;
      return;
    }
    if (followTailRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  const loadOlder = useCallback(async () => {
    if (loadingMore || !hasMore || !cursorRef.current) return;
    const el = scrollRef.current;
    setLoadingMore(true);
    try {
      const page = await listMessages(supabase, threadId, { before: cursorRef.current });
      if (el) pendingScrollRestoreRef.current = el.scrollHeight - el.scrollTop;
      setMessages((prev) => mergeMessages(prev, page.messages));
      setHasMore(page.hasMore);
      cursorRef.current = page.nextCursor ?? cursorRef.current;
      deliver();
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to load messages"));
    } finally {
      setLoadingMore(false);
    }
  }, [supabase, threadId, hasMore, loadingMore, deliver, t]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    followTailRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (el.scrollTop < 40 && hasMore && !loadingMore) void loadOlder();
  };

  // ---- send ----------------------------------------------------------
  const handleSend = useCallback(
    async (body: string) => {
      try {
        const row = await sendChatMessage(supabase, { threadId, accountId, senderId: userId, body });
        followTailRef.current = true;
        setMessages((prev) => mergeMessages(prev, [row]));
        onActivityRef.current();
        notifyPushEvent({ kind: "chat_message", message_id: row.id });
      } catch (err) {
        console.error(err);
        toast.error(t("Failed to send the message"));
        throw err;
      }
    },
    [supabase, threadId, accountId, userId, t],
  );

  // ---- render --------------------------------------------------------
  const name = memberDisplayName(other);
  const groups = useMemo(() => groupMessagesByDay(messages), [messages]);
  const subtitle = typing
    ? t("typing…")
    : online
      ? t("Online")
      : lastSeenLabel(other.last_seen_at, now, language, t);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2 sm:px-4">
        <button
          type="button"
          onClick={onBack}
          aria-label={t("Back")}
          className="flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
        >
          <ArrowLeft className="size-5" />
        </button>
        <span className="relative shrink-0">
          <Avatar className="size-9">
            {other.avatar_url ? <AvatarImage src={other.avatar_url} alt={name} /> : null}
            <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
              {name.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span
            className={cn(
              "absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-background",
              online ? "bg-emerald-500" : "bg-muted-foreground/50",
            )}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{name}</p>
          <p
            className={cn("truncate text-xs", typing ? "text-primary" : online ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}
            aria-live="polite"
          >
            {subtitle}
          </p>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 sm:px-4"
        role="log"
        aria-label={t("Messages")}
      >
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {hasMore ? (
              <div className="flex justify-center py-2">
                <button
                  type="button"
                  onClick={() => void loadOlder()}
                  disabled={loadingMore}
                  className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
                >
                  {loadingMore ? <Loader2 className="size-3.5 animate-spin" /> : t("Load earlier messages")}
                </button>
              </div>
            ) : null}
            {messages.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {t("No messages yet. Say hi!")}
              </div>
            ) : null}
            {groups.map((group) => (
              <section key={group.day} aria-label={dayLabel(group.at, now, language, t)}>
                <div className="sticky top-0 z-10 flex justify-center py-2">
                  <span className="rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground shadow-sm">
                    {dayLabel(group.at, now, language, t)}
                  </span>
                </div>
                {group.messages.map((m, i) => (
                  <ChatMessageBubble
                    key={m.id}
                    message={m}
                    mine={m.sender_id === userId}
                    continued={i > 0 && group.messages[i - 1].sender_id === m.sender_id}
                  />
                ))}
              </section>
            ))}
            {typing ? (
              <div className="mt-2 flex justify-start">
                <div className="rounded-2xl rounded-bl-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  {name} {t("is typing…")}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      <ChatComposer threadId={threadId} onSend={handleSend} onTyping={() => onTyping(threadId)} />
    </div>
  );
}
