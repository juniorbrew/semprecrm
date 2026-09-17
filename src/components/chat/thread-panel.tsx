"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { ArrowLeft, Crown, Loader2, LogOut, UserMinus, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useLanguage } from "@/hooks/use-language";
import { forgetSignedUrl } from "@/hooks/use-signed-url";
import { notifyPushEvent, reportChatThreadFocus } from "@/lib/push/client";
import {
  addGroupMembers,
  addReaction,
  canManageGroup,
  deleteChatMessage,
  editChatMessage,
  groupMessagesByDay,
  leaveGroup,
  listMessages,
  listReactions,
  listReceipts,
  markThreadDelivered,
  markThreadRead,
  memberDisplayName,
  mergeMessages,
  mergeReactions,
  removeGroupMember,
  removeReaction,
  removeReactionRow,
  sendChatMessage,
  toggleReactionRows,
  uploadChatAttachment,
} from "@/lib/chat";
import type { AccountRole } from "@/lib/auth/roles";
import type { ChatMember, ChatMessage, ChatMessageReaction, ChatMessageReceipt, ChatThread } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { ChatComposer, type PendingAttachment } from "./composer";
import { GroupMembersDialog } from "./group-members-dialog";
import { lastSeenLabel } from "./last-seen";
import { ChatMessageBubble } from "./message-bubble";
import { SystemLine } from "./system-line";

interface ThreadPanelProps {
  thread: ChatThread;
  /** Every member of the account (names / avatars for senders and receipts). */
  members: ChatMember[];
  /** The other person — direct threads only. */
  other: ChatMember | null;
  userId: string;
  accountId: string;
  accountRole: AccountRole | null;
  isOnline: (userId: string) => boolean;
  /** Ids of members typing in this thread (excluding me). */
  typingIds: string[];
  now: number;
  onTyping: (threadId: string) => void;
  /** Mobile: go back to the people list. */
  onBack: () => void;
  /** Called after a send / receipt / membership change so the list can refresh. */
  onActivity: () => void;
  /** I left the group or was removed — the parent deselects. */
  onLeft: () => void;
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
 * Right side of /chat: header (person + presence, or group + members),
 * the paginated history with day separators and system lines, and the
 * composer.
 *
 * Receipts (spec "Entrega e leitura"): every message from someone else
 * that reaches this client — first page, older pages, realtime INSERT
 * — is stamped delivered; while the tab is visible the thread is also
 * stamped read (+ my `last_read_at`). Direct threads use the columns
 * on the message, groups my receipt row (`chat_mark_*` RPCs). The
 * thread is reported to /api/push/seen so pushes for it are skipped.
 */
export function ThreadPanel({
  thread,
  members,
  other,
  userId,
  accountId,
  accountRole,
  isOnline,
  typingIds,
  now,
  onTyping,
  onBack,
  onActivity,
  onLeft,
}: ThreadPanelProps) {
  const { t, language } = useLanguage();
  const supabase = useMemo(() => createClient(), []);
  const threadId = thread.id;
  const isGroup = thread.kind === "group";
  const threadMembers = useMemo(() => thread.members ?? [], [thread.members]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [receipts, setReceipts] = useState<ChatMessageReceipt[]>([]);
  const [reactions, setReactions] = useState<ChatMessageReaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [busyMember, setBusyMember] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followTailRef = useRef(true);
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const onActivityRef = useRef(onActivity);
  const onLeftRef = useRef(onLeft);
  useEffect(() => {
    onActivityRef.current = onActivity;
    onLeftRef.current = onLeft;
  });

  const membersById = useMemo(() => new Map(members.map((m) => [m.user_id, m])), [members]);
  const nameOf = useCallback(
    (id: string) => {
      const m = membersById.get(id);
      return m ? memberDisplayName(m) : "…";
    },
    [membersById],
  );

  // ---- side data (receipts on my group messages, reactions on all) ----
  const loadSideData = useCallback(
    async (rows: readonly ChatMessage[]) => {
      const ids = rows.filter((m) => m.kind === "text").map((m) => m.id);
      const mine = rows.filter((m) => m.kind === "text" && m.sender_id === userId).map((m) => m.id);
      const [rx, rc] = await Promise.all([listReactions(supabase, ids), isGroup ? listReceipts(supabase, mine) : Promise.resolve([])]);
      setReactions((prev) => mergeReactions(prev, rx));
      if (rc.length > 0) setReceipts((prev) => mergeReceipts(prev, rc));
    },
    [supabase, userId, isGroup],
  );

  // ---- receipts ------------------------------------------------------
  const deliver = useCallback(() => {
    markThreadDelivered(supabase, threadId)
      .then((ids) => {
        if (ids.length > 0) onActivityRef.current();
      })
      .catch((err) => console.error("[chat] deliver:", err));
  }, [supabase, threadId]);

  const read = useCallback(() => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    markThreadRead(supabase, threadId)
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
  }, [supabase, threadId]);

  // ---- first page ----------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setReceipts([]);
    setReactions([]);
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
        void loadSideData(page.messages);
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
          if (row.sender_id !== userId && row.kind === "text") {
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
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "chat_message_receipts", filter: `thread_id=eq.${threadId}` },
        (payload) => {
          const row = payload.new as ChatMessageReceipt | null;
          if (row?.message_id) setReceipts((prev) => mergeReceipts(prev, [row]));
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_message_reactions", filter: `thread_id=eq.${threadId}` },
        (payload) => {
          const row = payload.new as ChatMessageReaction;
          setReactions((prev) => mergeReactions(prev, [row]));
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "chat_message_reactions", filter: `thread_id=eq.${threadId}` },
        (payload) => {
          const row = payload.old as Partial<ChatMessageReaction>;
          if (row.message_id && row.user_id && row.emoji) {
            setReactions((prev) => removeReaction(prev, row as Pick<ChatMessageReaction, "message_id" | "user_id" | "emoji">));
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "chat_thread_members", filter: `thread_id=eq.${threadId}` },
        (payload) => {
          const gone = payload.eventType === "DELETE" ? (payload.old as Partial<{ user_id: string }>) : null;
          if (gone?.user_id === userId) onLeftRef.current();
          onActivityRef.current();
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
        void loadSideData(page.messages);
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
  }, [supabase, threadId, deliver, read, loadSideData]);

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
      void loadSideData(page.messages);
      deliver();
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to load messages"));
    } finally {
      setLoadingMore(false);
    }
  }, [supabase, threadId, hasMore, loadingMore, deliver, loadSideData, t]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    followTailRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (el.scrollTop < 40 && hasMore && !loadingMore) void loadOlder();
  };

  // ---- send ----------------------------------------------------------
  const handleSend = useCallback(
    async (body: string, pending: PendingAttachment | null) => {
      try {
        const attachment = pending
          ? await uploadChatAttachment(supabase, {
              accountId,
              threadId,
              file: pending.file,
              width: pending.width,
              height: pending.height,
              duration: pending.duration,
            })
          : null;
        const row = await sendChatMessage(supabase, { threadId, accountId, senderId: userId, body, attachment });
        followTailRef.current = true;
        setMessages((prev) => mergeMessages(prev, [row]));
        onActivityRef.current();
        notifyPushEvent({ kind: "chat_message", message_id: row.id });
      } catch (err) {
        console.error(err);
        const reason = err instanceof Error ? err.message : "";
        toast.error(
          reason === "too_large"
            ? t("File is too large (max 25 MB).")
            : reason === "unsupported_type"
              ? t("File type not supported.")
              : reason.startsWith("Upload failed")
                ? t("Upload failed")
                : t("Failed to send the message"),
        );
        throw err;
      }
    },
    [supabase, threadId, accountId, userId, t],
  );

  // ---- reactions / edit / delete ------------------------------------
  const handleReact = useCallback(
    (message: ChatMessage, emoji: string) => {
      const { next, added } = toggleReactionRows(reactions, message.id, userId, emoji);
      setReactions(next);
      const op = added ? addReaction(supabase, message.id, userId, emoji) : removeReactionRow(supabase, message.id, userId, emoji);
      op.catch((err) => {
        console.error("[chat] react:", err);
        toast.error(t("Failed to react"));
        setReactions((prev) => (added ? removeReaction(prev, { message_id: message.id, user_id: userId, emoji }) : prev));
      });
    },
    [reactions, supabase, userId, t],
  );

  const handleEdit = useCallback(
    async (message: ChatMessage, body: string) => {
      try {
        const row = await editChatMessage(supabase, message.id, body);
        setMessages((prev) => mergeMessages(prev, [row]));
      } catch (err) {
        console.error(err);
        const msg = err instanceof Error ? err.message : "";
        toast.error(msg.includes("15 minutes") ? t("Messages can be edited for 15 minutes only") : t("Failed to edit the message"));
        throw err;
      }
    },
    [supabase, t],
  );

  const handleDelete = useCallback(
    async (message: ChatMessage) => {
      try {
        const row = await deleteChatMessage(message.id);
        if (message.attachment?.path) forgetSignedUrl(message.attachment.path);
        setMessages((prev) => mergeMessages(prev, [row]));
        onActivityRef.current();
      } catch (err) {
        console.error(err);
        toast.error(t("Failed to delete the message"));
      }
    },
    [t],
  );

  // ---- group management ---------------------------------------------
  const manage = isGroup && canManageGroup(thread, userId, accountRole);

  const handleAddMembers = useCallback(
    async ({ memberIds }: { title: string; memberIds: string[] }) => {
      try {
        await addGroupMembers(supabase, threadId, memberIds);
        toast.success(t("Members added"));
        onActivityRef.current();
      } catch (err) {
        console.error(err);
        toast.error(t("Failed to add members"));
        throw err;
      }
    },
    [supabase, threadId, t],
  );

  const handleRemoveMember = useCallback(
    async (memberId: string) => {
      setBusyMember(memberId);
      try {
        await removeGroupMember(supabase, threadId, memberId);
        toast.success(t("Member removed"));
        onActivityRef.current();
      } catch (err) {
        console.error(err);
        toast.error(t("Failed to remove the member"));
      } finally {
        setBusyMember(null);
      }
    },
    [supabase, threadId, t],
  );

  const handleLeave = useCallback(async () => {
    if (!window.confirm(t("Leave this group? You will stop receiving its messages."))) return;
    setBusyMember(userId);
    try {
      await leaveGroup(supabase, threadId);
      toast.success(t("You left the group"));
      onActivityRef.current();
      onLeftRef.current();
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to leave the group"));
    } finally {
      setBusyMember(null);
    }
  }, [supabase, threadId, userId, t]);

  // ---- render --------------------------------------------------------
  const groups = useMemo(() => groupMessagesByDay(messages), [messages]);
  const typingNames = typingIds.map(nameOf);
  const typing = typingNames.length > 0;
  const title = isGroup ? thread.title?.trim() || t("Group") : other ? memberDisplayName(other) : "";
  const online = !isGroup && other ? isOnline(other.user_id) : false;
  const subtitle = typing
    ? isGroup
      ? `${typingNames.join(", ")} ${typingNames.length === 1 ? t("is typing…") : t("are typing…")}`
      : t("typing…")
    : isGroup
      ? `${threadMembers.length} ${threadMembers.length === 1 ? t("member") : t("members")}`
      : online
        ? t("Online")
        : lastSeenLabel(other?.last_seen_at, now, language, t);

  const sortedMembers = useMemo(
    () =>
      [...threadMembers].sort((a, b) => {
        if (a.user_id === userId) return -1;
        if (b.user_id === userId) return 1;
        return nameOf(a.user_id).localeCompare(nameOf(b.user_id), undefined, { sensitivity: "base" });
      }),
    [threadMembers, userId, nameOf],
  );

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
        {isGroup ? (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Users className="size-4" />
          </span>
        ) : (
          <span className="relative shrink-0">
            <Avatar className="size-9">
              {other?.avatar_url ? <AvatarImage src={other.avatar_url} alt={title} /> : null}
              <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                {title.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span
              className={cn(
                "absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-background",
                online ? "bg-emerald-500" : "bg-muted-foreground/50",
              )}
            />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{title}</p>
          <p
            className={cn(
              "truncate text-xs",
              typing ? "text-primary" : online ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
            )}
            aria-live="polite"
          >
            {subtitle}
          </p>
        </div>

        {isGroup ? (
          <div className="flex shrink-0 items-center gap-1">
            <Popover open={membersOpen} onOpenChange={setMembersOpen}>
              <PopoverTrigger
                aria-label={t("Members")}
                title={t("Members")}
                className="flex h-9 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Users className="size-4" />
                <span className="tabular-nums">{threadMembers.length}</span>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 border-border bg-popover p-2">
                <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("Members")}</p>
                <ul className="max-h-72 overflow-y-auto">
                  {sortedMembers.map((m) => {
                    const member = membersById.get(m.user_id);
                    const name = m.user_id === userId ? t("You") : nameOf(m.user_id);
                    const memberOnline = isOnline(m.user_id);
                    const creator = thread.created_by === m.user_id;
                    return (
                      <li key={m.user_id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60">
                        <span className="relative shrink-0">
                          <Avatar className="size-7">
                            {member?.avatar_url ? <AvatarImage src={member.avatar_url} alt={name} /> : null}
                            <AvatarFallback className="bg-primary/10 text-[11px] font-medium text-primary">
                              {nameOf(m.user_id).charAt(0).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <span
                            className={cn(
                              "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-popover",
                              memberOnline ? "bg-emerald-500" : "bg-muted-foreground/50",
                            )}
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1 truncate text-sm text-foreground">
                            {name}
                            {creator ? <Crown className="size-3 text-amber-500" aria-label={t("Creator")} /> : null}
                          </span>
                        </span>
                        {manage && m.user_id !== userId ? (
                          <button
                            type="button"
                            onClick={() => void handleRemoveMember(m.user_id)}
                            disabled={busyMember !== null}
                            aria-label={`${t("Remove from group")}: ${name}`}
                            title={t("Remove from group")}
                            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                          >
                            {busyMember === m.user_id ? <Loader2 className="size-3.5 animate-spin" /> : <UserMinus className="size-3.5" />}
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-1 flex flex-col gap-0.5 border-t border-border pt-1">
                  {manage ? (
                    <button
                      type="button"
                      onClick={() => {
                        setMembersOpen(false);
                        setAddOpen(true);
                      }}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted"
                    >
                      <UserPlus className="size-4 text-primary" />
                      {t("Add members")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setMembersOpen(false);
                      void handleLeave();
                    }}
                    disabled={busyMember !== null}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  >
                    <LogOut className="size-4" />
                    {t("Leave group")}
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        ) : null}
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
                {group.messages.map((m, i) => {
                  if (m.kind === "system") return <SystemLine key={m.id} message={m} userId={userId} nameOf={nameOf} />;
                  const prev = group.messages[i - 1];
                  return (
                    <ChatMessageBubble
                      key={m.id}
                      message={m}
                      mine={m.sender_id === userId}
                      continued={!!prev && prev.kind === "text" && prev.sender_id === m.sender_id}
                      group={isGroup}
                      members={threadMembers}
                      receipts={receipts}
                      reactions={reactions}
                      userId={userId}
                      nameOf={nameOf}
                      now={now}
                      onReact={handleReact}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                    />
                  );
                })}
              </section>
            ))}
            {typing ? (
              <div className="mt-2 flex justify-start">
                <div className="rounded-2xl rounded-bl-md bg-muted px-3 py-2 text-xs text-muted-foreground">{subtitle}</div>
              </div>
            ) : null}
          </>
        )}
      </div>

      <ChatComposer threadId={threadId} onSend={handleSend} onTyping={() => onTyping(threadId)} />

      {isGroup ? (
        <GroupMembersDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          mode="add"
          members={members}
          userId={userId}
          excludeIds={threadMembers.map((m) => m.user_id)}
          isOnline={isOnline}
          onSubmit={handleAddMembers}
        />
      ) : null}
    </div>
  );
}

/** Merge receipt rows on (message, user). */
function mergeReceipts(existing: readonly ChatMessageReceipt[], incoming: readonly ChatMessageReceipt[]): ChatMessageReceipt[] {
  const key = (r: ChatMessageReceipt) => `${r.message_id}|${r.user_id}`;
  const byKey = new Map<string, ChatMessageReceipt>();
  for (const r of existing) byKey.set(key(r), r);
  for (const r of incoming) byKey.set(key(r), r);
  return [...byKey.values()];
}
