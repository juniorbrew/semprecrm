"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MessagesSquare } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import {
  buildChatRows,
  createGroup,
  getOrCreateDirectThread,
  listChatMembers,
  listMyThreads,
  loadUnreadByThread,
  otherMemberId,
  type ChatListRow,
} from "@/lib/chat";
import type { ChatMember, ChatThread } from "@/types";
import { useChatPresence } from "@/components/chat/presence-provider";
import { GroupMembersDialog } from "@/components/chat/group-members-dialog";
import { PeopleList } from "@/components/chat/people-list";
import { ThreadPanel } from "@/components/chat/thread-panel";

type Selection = { kind: "person"; userId: string } | { kind: "group"; threadId: string };

function selectionKey(s: Selection | null): string | null {
  if (!s) return null;
  return s.kind === "person" ? `p:${s.userId}` : `g:${s.threadId}`;
}

/**
 * /chat — internal team chat.
 *
 * Left: everyone in the account (minus me) and my groups, with
 * presence and unread. Right: the selected conversation. `?t=<thread
 * id>` deep-links a thread (push notifications land here). On narrow
 * screens the two columns alternate; the header's back arrow returns
 * to the list.
 */
export default function ChatPage() {
  const supabase = useMemo(() => createClient(), []);
  const { t } = useLanguage();
  const { user, accountId, accountRole } = useAuth();
  const userId = user?.id ?? null;
  const router = useRouter();
  const searchParams = useSearchParams();
  const presence = useChatPresence();

  const [members, setMembers] = useState<ChatMember[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [unread, setUnread] = useState<Map<string, number>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [opening, setOpening] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);

  // Minute tick so "last seen" / row times stay honest without refetching.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // ---- data ----------------------------------------------------------
  const loadLists = useCallback(async () => {
    if (!accountId || !userId) return;
    try {
      const [m, th, un] = await Promise.all([
        listChatMembers(supabase, accountId),
        listMyThreads(supabase),
        loadUnreadByThread(supabase),
      ]);
      setMembers(m);
      setThreads(th);
      setUnread(un);
    } catch (err) {
      console.error(err);
      toast.error(t("Failed to load the chat"));
    } finally {
      setLoading(false);
    }
  }, [supabase, accountId, userId, t]);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  // Debounced refresh on any chat change (RLS keeps the stream to my
  // threads). Also re-read members every minute for `last_seen_at`.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void loadLists(), 300);
  }, [loadLists]);

  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`chat-lists-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_messages" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_threads" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_thread_members" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_message_receipts" }, scheduleRefresh)
      .subscribe();
    const tick = setInterval(() => void loadLists(), 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") scheduleRefresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    };
  }, [supabase, userId, scheduleRefresh, loadLists]);

  const rows = useMemo(() => (userId ? buildChatRows(members, threads, unread, userId) : []), [members, threads, unread, userId]);

  // ---- selection -----------------------------------------------------
  // `?t=<thread>` (push deep link) selects that thread once the lists are in.
  const deepLinkThreadId = searchParams.get("t");
  const deepLinkHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!deepLinkThreadId || !userId || loading) return;
    if (deepLinkHandledRef.current === deepLinkThreadId) return;
    const thread = threads.find((th) => th.id === deepLinkThreadId);
    if (!thread) return;
    deepLinkHandledRef.current = deepLinkThreadId;
    if (thread.kind === "group") {
      setSelected({ kind: "group", threadId: thread.id });
    } else {
      const other = otherMemberId(thread, userId);
      if (other) setSelected({ kind: "person", userId: other });
    }
  }, [deepLinkThreadId, threads, userId, loading]);

  const selectRow = useCallback(
    async (row: ChatListRow) => {
      if (row.kind === "group") {
        setSelected({ kind: "group", threadId: row.row.thread.id });
        router.replace(`/chat?t=${row.row.thread.id}`);
        return;
      }
      const otherUserId = row.row.member.user_id;
      setSelected({ kind: "person", userId: otherUserId });
      if (row.row.thread) {
        router.replace(`/chat?t=${row.row.thread.id}`);
        return;
      }
      setOpening(true);
      try {
        const threadId = await getOrCreateDirectThread(supabase, otherUserId);
        router.replace(`/chat?t=${threadId}`);
        await loadLists();
      } catch (err) {
        console.error(err);
        toast.error(t("Could not open the conversation"));
        setSelected(null);
      } finally {
        setOpening(false);
      }
    },
    [supabase, router, loadLists, t],
  );

  const handleCreateGroup = useCallback(
    async ({ title, memberIds }: { title: string; memberIds: string[] }) => {
      try {
        const threadId = await createGroup(supabase, title, memberIds);
        toast.success(t("Group created"));
        await loadLists();
        setSelected({ kind: "group", threadId });
        router.replace(`/chat?t=${threadId}`);
      } catch (err) {
        console.error(err);
        toast.error(t("Failed to create the group"));
        throw err;
      }
    },
    [supabase, loadLists, router, t],
  );

  const back = useCallback(() => {
    setSelected(null);
    router.replace("/chat");
  }, [router]);

  // The selected row / thread, resolved from the current lists.
  const selectedKey = selectionKey(selected);
  const selectedRow = selectedKey ? rows.find((r) => r.key === selectedKey) ?? null : null;
  const activeThread: ChatThread | null =
    selectedRow?.kind === "group" ? selectedRow.row.thread : selectedRow?.kind === "person" ? selectedRow.row.thread : null;
  const activeOther = selectedRow?.kind === "person" ? selectedRow.row.member : null;

  // A group I left / was removed from disappears from the list — deselect.
  useEffect(() => {
    if (selected?.kind === "group" && !loading && !threads.some((th) => th.id === selected.threadId)) {
      setSelected(null);
      router.replace("/chat");
    }
  }, [selected, threads, loading, router]);

  const showThreadOnMobile = selected !== null;

  if (!userId || !accountId) {
    return (
      <div className="flex h-full min-h-[40vh] items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" role="status" aria-label={t("Loading...")} />
      </div>
    );
  }

  const typingIds = activeThread ? presence.typingIn(activeThread.id) : [];

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] overflow-hidden bg-background sm:-m-6">
      {/* People + groups column */}
      <aside
        className={cn(
          "h-full w-full shrink-0 border-r border-border bg-card lg:w-80",
          showThreadOnMobile ? "hidden lg:flex lg:flex-col" : "flex flex-col",
        )}
        aria-label={t("People")}
      >
        <PeopleList
          rows={rows}
          loading={loading}
          selectedKey={selectedKey}
          isOnline={presence.isOnline}
          now={now}
          onSelect={(row) => void selectRow(row)}
          onNewGroup={() => setNewGroupOpen(true)}
        />
      </aside>

      {/* Conversation */}
      <section
        className={cn("h-full min-w-0 flex-1", showThreadOnMobile ? "flex flex-col" : "hidden lg:flex lg:flex-col")}
        aria-label={t("Conversation")}
      >
        {activeThread ? (
          <ThreadPanel
            key={activeThread.id}
            thread={activeThread}
            members={members}
            other={activeOther}
            userId={userId}
            accountId={accountId}
            accountRole={accountRole}
            isOnline={presence.isOnline}
            typingIds={typingIds}
            now={now}
            onTyping={presence.sendTyping}
            onBack={back}
            onActivity={scheduleRefresh}
            onLeft={back}
          />
        ) : selected && opening ? (
          <div className="flex h-full items-center justify-center">
            <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" role="status" aria-label={t("Loading...")} />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <MessagesSquare className="size-7" />
            </div>
            <p className="text-base font-semibold text-foreground">{t("Internal chat")}</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {t("Pick a teammate or a group on the left to start a conversation. Messages stay inside your account.")}
            </p>
          </div>
        )}
      </section>

      <GroupMembersDialog
        open={newGroupOpen}
        onOpenChange={setNewGroupOpen}
        mode="create"
        members={members}
        userId={userId}
        isOnline={presence.isOnline}
        onSubmit={handleCreateGroup}
      />
    </div>
  );
}
