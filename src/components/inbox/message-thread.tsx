"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { notifyPushEvent } from "@/lib/push/client";
import { useAuth, useEntitlements } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { TaskDrawer } from "@/components/tasks";
import { EventDrawer } from "@/components/calendar";
import type {
  WhatsAppChannel,
  Conversation,
  ContactNote,
  Message,
  MessageReaction,
  Contact,
  ConversationStatus,
  MessageTemplate,
  Profile,
} from "@/types";
import {
  MessageSquare,
  ChevronDown,
  UserPlus,
  Check,
  CheckCheck,
  RotateCcw,
  Clock,
  ArrowLeft,
  RefreshCw,
  PanelRightOpen,
  PanelRightClose,
  MoreVertical,
  CheckSquare,
  CalendarPlus,
  UserCheck,
  Archive,
  ArchiveRestore,
} from "lucide-react";
import { isToday, isYesterday, differenceInHours } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { conversationHeaderActions } from "@/lib/conversations/header-actions";
import { updateConversationAssignee } from "@/lib/conversations/assign";
import { ConversationReminder } from "./conversation-reminder";
import { MessageBubble } from "./message-bubble";
import { MessageActions } from "./message-actions";
import {
  MessageComposer,
  CHAT_MEDIA_BUCKET,
  type SendMediaPayload,
} from "./message-composer";
import { deleteAccountMedia } from "@/lib/storage/upload-media";
import { TemplatePicker } from "./template-picker";
import { buildReplyPreview } from "./reply-quote";
import { InternalNoteBubble } from "./internal-note-bubble";
import { SystemEventPill } from "./system-event-pill";
import { ContactAvatar } from "./contact-avatar";
import { useConversationEvents } from "@/hooks/use-conversation-events";
import {
  deriveBaselineEvents,
  eventFromRecord,
  isVisibleEvent,
} from "@/lib/conversations/events";
import {
  addContactNote,
  notifyContactNotesChanged,
  onContactNotesChanged,
} from "@/lib/conversations/notes";
import {
  buildThreadTimeline,
  groupTimelineByDay,
} from "@/lib/conversations/timeline";
import { toast } from "sonner";
import { renderTemplateBody } from "@/lib/whatsapp/template-body";

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

interface MessageThreadProps {
  conversation: Conversation | null;
  contact: Contact | null;
  messages: Message[];
  onMessagesLoaded: (messages: Message[]) => void;
  onNewMessage: (message: Message) => void;
  onUpdateMessage: (id: string, updates: Partial<Message>) => void;
  onStatusChange: (conversationId: string, status: ConversationStatus) => void;
  onAssignChange: (
    conversationId: string,
    assignedAgentId: string | null,
  ) => void;
  /**
   * Local patch after a header action the parent's handlers above do not
   * cover (archive / unarchive — `archived_at`, migration 056). Optional;
   * the realtime UPDATE brings the same row anyway.
   */
  onConversationPatch?: (conversationId: string, patch: Partial<Conversation>) => void;
  /**
   * On mobile, the thread is shown full-screen with the conversation list
   * hidden. This callback lets the page deselect the active conversation
   * and reveal the list again. Rendered as a back-arrow in the header on
   * mobile only.
   */
  onBack?: () => void;
  /**
   * Increment to force the messages + reactions fetch effects to refire.
   * Parent bumps this on realtime reconnect / tab visibility → visible
   * so the open thread catches up on any events sent while the WS was
   * disconnected or the tab was throttled. Optional so existing callers
   * keep working.
   */
  resyncToken?: number;
  /**
   * Fired by the manual-refresh button in the thread header. The parent
   * typically bumps the same `resyncToken` it controls — this gives the
   * user a way to force a refetch when they suspect realtime missed an
   * event (or they're impatient). Optional so existing callers keep
   * working; the button is only rendered when this is provided.
   */
  onRefresh?: () => void;
  /**
   * Desktop-only contact-panel toggle. The page owns the open/closed
   * state (it's the one that renders the sidebar), so the thread just
   * reflects it and asks the page to flip it. Both optional so existing
   * callers keep working; the toggle button only renders when
   * `onToggleContactPanel` is wired up.
   */
  contactPanelOpen?: boolean;
  onToggleContactPanel?: () => void;
}

function formatDateSeparator(dateStr: string, language: Language): string {
  const date = new Date(dateStr);
  // "Today"/"Yesterday" are dictionary keys — the DOM translator renders
  // them as "Hoje"/"Ontem" in pt-BR.
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  return new Intl.DateTimeFormat(language, { dateStyle: "long" }).format(date);
}

const STATUS_ORDER: ConversationStatus[] = ["open", "pending", "closed"];

const STATUS_COLOR: Record<ConversationStatus, string> = {
  open: "text-primary",
  pending: "text-amber-400",
  closed: "text-muted-foreground",
};

const STATUS_DOT: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};

/**
 * Header copy lives in a language-keyed table (like the list's triage
 * strip) rather than the DOM catalogue: the pt-BR forms are feminine
 * ("Aberta", "Resolvida" — a *conversa*) and must match the chips the
 * conversation list renders for the same status. Marked
 * `data-no-translate` so the DOM translator leaves them alone.
 */
const THREAD_STATUS_COPY: Record<
  Language,
  {
    labels: Record<ConversationStatus, string>;
    resolve: string;
    reopen: string;
    resolvedToast: string;
    reopenedToast: string;
    noteLabel: string;
    noteHint: string;
    noteDelete: string;
    noteAdded: string;
    noteFailed: string;
    noteDeleted: string;
    you: string;
    team: string;
    changeStatus: string;
    back: string;
    /** Channel chip + tooltip in the header (migration 026). */
    channelChip: Record<WhatsAppChannel, string>;
    channelTitle: Record<WhatsAppChannel, string>;
    /** Queue actions (Assumir / Transferir / Arquivar). */
    claim: string;
    claimTitle: string;
    claimedToast: string;
    claimTaken: (who: string) => string;
    someone: string;
    transferTitle: (assignee: string) => string;
    noAssignee: string;
    assignedUnknown: string;
    transferTo: string;
    archive: string;
    unarchive: string;
    archiveTitle: string;
    archiveBody: string;
    archiveOpenBody: string;
    archivedToast: string;
    unarchivedToast: string;
    archiveFailed: string;
    archivedLabel: string;
    cancel: string;
    readOnly: string;
  }
> = {
  "pt-BR": {
    labels: { open: "Aberta", pending: "Pendente", closed: "Resolvida" },
    resolve: "Resolver",
    reopen: "Reabrir",
    resolvedToast: "Conversa resolvida",
    reopenedToast: "Conversa reaberta",
    noteLabel: "Nota interna",
    noteHint: "Visível só para a equipe — o cliente não recebe esta nota",
    noteDelete: "Excluir nota",
    noteAdded: "Nota interna adicionada",
    noteFailed: "Não foi possível salvar a nota",
    noteDeleted: "Nota excluída",
    you: "Você",
    team: "Equipe",
    changeStatus: "Alterar status",
    back: "Voltar para as conversas",
    channelChip: { official: "Oficial", qr: "QR" },
    channelTitle: {
      official: "Canal: API oficial do WhatsApp",
      qr: "Canal: WhatsApp via QR code (sem janela de 24 h nem modelos)",
    },
    claim: "Assumir",
    claimTitle: "Assumir: atribuir esta conversa a você",
    claimedToast: "Conversa atribuída a você",
    claimTaken: (who) => `${who} assumiu esta conversa antes de você`,
    someone: "Outra pessoa",
    transferTitle: (assignee) => `Responsável: ${assignee} · Transferir`,
    noAssignee: "sem responsável",
    assignedUnknown: "atribuída",
    transferTo: "Transferir para",
    archive: "Arquivar",
    unarchive: "Desarquivar",
    archiveTitle: "Arquivar esta conversa?",
    archiveBody:
      "Ela sai das listas e fica em Arquivadas. Se o cliente escrever de novo, volta sozinha.",
    archiveOpenBody:
      "Arquivar também resolve o atendimento. Ela sai das listas e fica em Arquivadas; se o cliente escrever de novo, volta sozinha.",
    archivedToast: "Conversa arquivada",
    unarchivedToast: "Conversa desarquivada",
    archiveFailed: "Não foi possível arquivar a conversa",
    archivedLabel: "Arquivada",
    cancel: "Cancelar",
    readOnly: "Somente leitura — seu perfil não pode alterar conversas",
  },
  "en-US": {
    labels: { open: "Open", pending: "Pending", closed: "Resolved" },
    resolve: "Resolve",
    reopen: "Reopen",
    resolvedToast: "Conversation resolved",
    reopenedToast: "Conversation reopened",
    noteLabel: "Private note",
    noteHint: "Visible to your team only — the customer never gets this",
    noteDelete: "Delete note",
    noteAdded: "Private note added",
    noteFailed: "Could not save the note",
    noteDeleted: "Note deleted",
    you: "You",
    team: "Team",
    changeStatus: "Change status",
    back: "Back to conversations",
    channelChip: { official: "Official", qr: "QR" },
    channelTitle: {
      official: "Channel: official WhatsApp API",
      qr: "Channel: WhatsApp via QR code (no 24-hour window or templates)",
    },
    claim: "Take",
    claimTitle: "Take: assign this conversation to you",
    claimedToast: "Conversation assigned to you",
    claimTaken: (who) => `${who} took this conversation before you`,
    someone: "Someone else",
    transferTitle: (assignee) => `Owner: ${assignee} · Transfer`,
    noAssignee: "nobody",
    assignedUnknown: "assigned",
    transferTo: "Transfer to",
    archive: "Archive",
    unarchive: "Unarchive",
    archiveTitle: "Archive this conversation?",
    archiveBody:
      "It leaves the lists and goes to Archived. If the customer writes again, it comes back on its own.",
    archiveOpenBody:
      "Archiving also resolves it. It leaves the lists and goes to Archived; if the customer writes again, it comes back on its own.",
    archivedToast: "Conversation archived",
    unarchivedToast: "Conversation unarchived",
    archiveFailed: "Could not archive the conversation",
    archivedLabel: "Archived",
    cancel: "Cancel",
    readOnly: "Read-only — your role can't change conversations",
  },
};

/**
 * WhatsApp-style doodle background applied to the chat area (both the
 * active thread and the empty state). The SVG tile lives at
 * `/public/inbox-doodle.svg`; the slate-950 colour sits underneath so
 * the doodles read as a subtle pattern rather than a stark grid.
 *
 * Defined once at module scope so the two render paths can't drift —
 * if we ever switch the asset, both spots update together.
 */
const DOODLE_BG_CLASSES =
  "bg-background bg-[url('/inbox-doodle.svg')] bg-repeat";

export function MessageThread({
  conversation,
  contact,
  messages,
  onMessagesLoaded,
  onNewMessage,
  onUpdateMessage,
  onStatusChange,
  onAssignChange,
  onConversationPatch,
  onBack,
  resyncToken = 0,
  onRefresh,
  contactPanelOpen,
  onToggleContactPanel,
}: MessageThreadProps) {
  const { user, profile, accountId, accountRole } = useAuth();
  const { language, t } = useLanguage();
  const statusCopy = THREAD_STATUS_COPY[language] ?? THREAD_STATUS_COPY["pt-BR"];
  const [loading, setLoading] = useState(false);
  // "Criar tarefa" in the header's overflow menu — opens the shared task
  // drawer in create mode, prefilled with this contact + conversation.
  const { ready: entitlementsReady, modules } = useEntitlements();
  const tasksEnabled = !entitlementsReady || modules.tasks;
  const canWriteHere = useCan("send-messages");
  const canCreateTask = canWriteHere && tasksEnabled;
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  // "Agendar" in the same menu — opens the calendar drawer prefilled
  // with this contact + conversation (calendar module, agent+).
  const calendarEnabled = !entitlementsReady || modules.calendar;
  const canSchedule = canWriteHere && calendarEnabled;
  const [eventDrawerOpen, setEventDrawerOpen] = useState(false);
  // Team-only notes for this contact, interleaved in the stream as amber
  // bubbles. Stored in `contact_notes` (account-scoped, shared with the
  // whole team via RLS) — they never go anywhere near the WhatsApp API.
  const [notes, setNotes] = useState<ContactNote[]>([]);
  // Who-did-what log (assign / status / label / note), server-backed and
  // realtime — see lib/conversations/events + hooks/use-conversation-events.
  const { events: eventRecords, logEvent } = useConversationEvents(
    conversation?.id,
    resyncToken,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [reactions, setReactions] = useState<MessageReaction[]>([]);
  // Purely visual spin state for the manual-refresh button. The actual
  // refetch is fire-and-forget through `onRefresh` (which bumps the
  // parent's resyncToken); the 700ms spin is just feedback so the click
  // doesn't feel like a no-op. Cleared via the timer ref on unmount.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);
  const handleRefreshClick = useCallback(() => {
    if (isRefreshing || !onRefresh) return;
    setIsRefreshing(true);
    onRefresh();
    refreshTimerRef.current = setTimeout(() => {
      setIsRefreshing(false);
      refreshTimerRef.current = null;
    }, 700);
  }, [isRefreshing, onRefresh]);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);

  // Profiles are bounded by RLS to rows the current user is allowed to
  // see — today that's just the current user, but the dropdown keeps the
  // shape ready for shared-team workspaces without a refactor.
  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from("profiles")
      .select("*")
      .order("full_name")
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Failed to fetch profiles:", error);
          return;
        }
        setProfiles((data as Profile[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 24-hour session timer
  const sessionInfo = useMemo(() => {
    if (!messages.length) return { expired: false, remaining: "", short: "" };

    // Find last customer message
    const lastCustomerMsg = [...messages]
      .reverse()
      .find((m) => m.sender_type === "customer");

    if (!lastCustomerMsg)
      return {
        expired: true,
        remaining: "No customer messages",
        short: "Expired",
      };

    const hoursSince = differenceInHours(new Date(), new Date(lastCustomerMsg.created_at));
    const expired = hoursSince >= 24;

    if (expired) {
      return { expired: true, remaining: "Expired", short: "Expired" };
    }

    const hoursLeft = 24 - hoursSince;
    // `short` is what the header badge shows ("17h"); `remaining` is the
    // full sentence ("17h remaining") used as its tooltip, so the phone
    // line next to it doesn't get squeezed at 1440.
    const short =
      hoursLeft >= 1
        ? `${Math.floor(hoursLeft)}h`
        : `${Math.floor(hoursLeft * 60)}m`;

    return { expired, remaining: `${short} remaining`, short };
  }, [messages]);

  // Store latest callback in a ref so fetchMessages doesn't need to
  // depend on `onMessagesLoaded` — otherwise parent re-renders cause
  // fetchMessages to change → useEffect re-fires → refetch → realtime
  // UPDATE on conversations.unread_count → parent re-renders → LOOP.
  // The ref is written inside an effect so the mutation doesn't happen
  // during render (React 19 refs rule); consumers only read `.current`
  // inside the async fetch completion, which runs after the render.
  const onMessagesLoadedRef = useRef(onMessagesLoaded);
  useEffect(() => {
    onMessagesLoadedRef.current = onMessagesLoaded;
  });

  const conversationId = conversation?.id;
  const hasUnread = (conversation?.unread_count ?? 0) > 0;

  // Fetch messages whenever the selected conversation changes. Kept
  // separate from the unread-reset effect so that incoming messages
  // arriving while the thread is open don't trigger a full refetch —
  // they only flip hasUnread, which only the reset effect listens to.
  // A resync of the same conversation refetches silently — the spinner
  // is only for opening a thread, not for background catch-ups.
  const loadedConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!conversationId) return;

    const supabase = createClient();
    let cancelled = false;
    const isResync = loadedConversationIdRef.current === conversationId;
    loadedConversationIdRef.current = conversationId;

    (async () => {
      if (!isResync) setLoading(true);

      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (cancelled) return;

      if (error) {
        console.error("Failed to fetch messages:", error);
      } else {
        onMessagesLoadedRef.current(data ?? []);
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus —
    // realtime is best-effort and any message events sent while the WS
    // was disconnected or throttled are otherwise lost.
  }, [conversationId, resyncToken]);

  // Reactions fetch — pulls the current state from the DB. Kept separate
  // from the channel subscription below so a `resyncToken` bump just
  // refetches the rows without also tearing down and rebuilding the
  // realtime channel.
  useEffect(() => {
    if (!conversationId) {
      setReactions([]);
      return;
    }
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("message_reactions")
        .select("*")
        .eq("conversation_id", conversationId);
      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch reactions:", error);
        return;
      }
      setReactions((data as MessageReaction[]) ?? []);
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId, resyncToken]);

  // Notes fetch — keyed on the contact (notes are per-contact, so they
  // also surface in a later conversation with the same person). Refires
  // on resyncToken like the other fetches; `contact_notes` isn't in the
  // realtime publication, so teammates' notes land on the next resync.
  const contactId = contact?.id;
  useEffect(() => {
    if (!contactId) {
      setNotes([]);
      return;
    }
    const supabase = createClient();
    let cancelled = false;
    const load = async () => {
      const { data, error } = await supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: true });
      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch notes:", error);
        return;
      }
      setNotes((data as ContactNote[]) ?? []);
    };
    void load();
    // The contact panel can add/remove notes too — stay in sync.
    const unsubscribe = onContactNotesChanged(contactId, () => void load());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [contactId, resyncToken]);

  // Reactions realtime subscription per conversation. Subscribing here
  // (not at the page level) keeps the channel scoped to the visible
  // conversation and avoids cross-conversation chatter on a busy inbox.
  useEffect(() => {
    if (!conversationId) return;
    const supabase = createClient();

    const channel = supabase
      .channel(`reactions:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          setReactions((prev) => {
            if (prev.some((r) => r.id === row.id)) return prev;
            // Swap any matching optimistic temp row for the real one so
            // the pill doesn't double up after a successful POST.
            const tempIdx = prev.findIndex(
              (r) =>
                r.id.startsWith("temp-") &&
                r.message_id === row.message_id &&
                r.actor_type === row.actor_type &&
                r.actor_id === row.actor_id,
            );
            if (tempIdx >= 0) {
              const copy = prev.slice();
              copy[tempIdx] = row;
              return copy;
            }
            return [...prev, row];
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          setReactions((prev) => prev.map((r) => (r.id === row.id ? row : r)));
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const old = payload.old as Partial<MessageReaction>;
          if (!old?.id) return;
          setReactions((prev) => prev.filter((r) => r.id !== old.id));
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  // Clear any in-progress reply draft when the active conversation changes —
  // a quote pulled from conversation A shouldn't bleed into conversation B.
  useEffect(() => {
    setReplyTo(null);
  }, [conversationId]);

  // Reset the server-side unread_count to 0 whenever an unread count
  // surfaces on the active conversation — covers both (a) opening a
  // conversation that had unread messages and (b) new messages arriving
  // while the user is already viewing the thread (webhook server-bumps
  // unread_count to N+1; the realtime UPDATE propagates it into the
  // client, which re-runs this effect and flips it back to 0).
  //
  // Guarding on hasUnread prevents the eq-update loop: once unread_count
  // is 0 the condition is false, so no further UPDATE is issued.
  useEffect(() => {
    if (!conversationId || !hasUnread) return;
    const supabase = createClient();
    supabase
      .from("conversations")
      .update({ unread_count: 0 })
      .eq("id", conversationId)
      .then(({ error }) => {
        if (error) console.error("Failed to reset unread_count:", error);
      });
  }, [conversationId, hasUnread]);

  // Read receipts (blue ✓✓ on the customer's phone, migration 049): while
  // the thread is open and the tab visible, confirm the customer's new
  // messages as read on WhatsApp. The server only sends what is newer
  // than the last confirmation, so re-firing is cheap. Debounced so a
  // burst of incoming messages is one call.
  const lastCustomerMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].sender_type === "customer") return messages[i].id;
    }
    return null;
  }, [messages]);
  useEffect(() => {
    if (!conversationId || !lastCustomerMessageId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void fetch(`/api/conversations/${conversationId}/read`, { method: "POST" }).catch(() => {});
      }, 800);
    };
    send();
    document.addEventListener("visibilitychange", send);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", send);
    };
  }, [conversationId, lastCustomerMessageId]);

  // Auto-scroll to bottom on new messages, notes or event pills. Keyed
  // on what the timeline contains rather than array identity, so a
  // background resync that refetches the same rows keeps the agent's
  // scroll position while they read history.
  const lastScrollSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    const signature = [
      conversationId,
      messages.length,
      messages[messages.length - 1]?.id,
      notes.length,
      eventRecords.length,
    ].join("|");
    if (signature === lastScrollSignatureRef.current) return;
    lastScrollSignatureRef.current = signature;
    if (scrollRef.current) {
      const el = scrollRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [conversationId, messages, notes, eventRecords]);

  const handleSend = useCallback(
    async (text: string, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;

      // Optimistic update — shows the message immediately with "sending" status
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "text",
        content_text: text,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "text",
            content_text: text,
            reply_to_message_id: replyToId,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error("Failed to send message:", reason);
          toast.error(`Failed to send: ${reason}`);
          // Mark the optimistic bubble as failed so the user sees what happened
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        // Success — the realtime INSERT event will replace the temp bubble
        // with the real DB row. If realtime hasn't arrived yet, at least
        // flip status to 'sent' so the UI stops showing "sending".
        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send message:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Failed to send: ${reason}`);
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage]
  );

  const handleSendMedia = useCallback(
    async (payload: SendMediaPayload) => {
      if (!conversation) return;

      // Documents show their filename in our own bubble (and to the
      // recipient as the Meta caption when no caption was typed); other
      // kinds use the caption as-is. Audio carries no caption.
      const contentText =
        payload.kind === "document"
          ? payload.caption || payload.filename || "Document"
          : payload.caption;

      const tempId = `temp-${Date.now()}`;
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: payload.kind,
        content_text: contentText,
        media_url: payload.mediaUrl,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: payload.replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: payload.kind,
            media_url: payload.mediaUrl,
            content_text: contentText,
            filename: payload.filename,
            reply_to_message_id: payload.replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error("Failed to send media:", reason);
          toast.error(`Failed to send: ${reason}`);
          onUpdateMessage(tempId, { status: "failed" });
          // The upload never reached the recipient — GC the orphaned
          // object rather than leaving it in the public bucket forever.
          void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(() => {});
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send media:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Failed to send: ${reason}`);
        onUpdateMessage(tempId, { status: "failed" });
        void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(() => {});
      }
    },
    [conversation, onNewMessage, onUpdateMessage],
  );

  /** True when the status is now `status` (unchanged counts as success). */
  const handleStatusChange = useCallback(
    async (status: ConversationStatus): Promise<boolean> => {
      if (!conversation) return false;

      if (conversation.status === status) return true;

      const supabase = createClient();
      const { error } = await supabase
        .from("conversations")
        .update({ status })
        .eq("id", conversation.id);

      if (error) {
        console.error("Failed to update status:", error);
        toast.error(t("Failed to update status"));
        return false;
      }

      onStatusChange(conversation.id, status);
      // Leaving "closed" unarchives it in the DB (migration 056 trigger);
      // mirror that locally so the row leaves the Arquivadas view at once.
      if (status !== "closed" && conversation.archived_at) {
        onConversationPatch?.(conversation.id, { archived_at: null });
      }
      void logEvent({
        event_type: "status_changed",
        payload: { status, previous_status: conversation.status },
      });
      return true;
    },
    [conversation, onStatusChange, onConversationPatch, logEvent, t]
  );

  // Resolve ⇄ Reopen from the header's primary button. Pending counts
  // as "still open" for this toggle, so the button always resolves
  // unless the thread is already closed.
  const handleResolveToggle = useCallback(async () => {
    if (!conversation) return;
    const next: ConversationStatus =
      conversation.status === "closed" ? "open" : "closed";
    if (!(await handleStatusChange(next))) return;
    toast.success(
      next === "closed" ? statusCopy.resolvedToast : statusCopy.reopenedToast
    );
  }, [conversation, handleStatusChange, statusCopy]);

  // ---- Internal notes ----------------------------------------------

  const handleSendNote = useCallback(
    async (text: string) => {
      if (!contact || !accountId || !user?.id) {
        toast.error(statusCopy.noteFailed);
        return;
      }
      try {
        // Shared with the contact panel's inline note (lib/conversations/
        // notes): insert + cross-component notify + `note_added` audit
        // event, so both entry points behave identically.
        const note = await addContactNote(createClient(), {
          contactId: contact.id,
          accountId,
          userId: user.id,
          text,
          conversationId: conversation?.id ?? null,
          actorName: profile?.full_name || user.email || undefined,
        });
        setNotes((prev) => [...prev, note]);
        toast.success(statusCopy.noteAdded);
      } catch (error) {
        console.error("Failed to add note:", error);
        toast.error(statusCopy.noteFailed);
      }
    },
    [contact, accountId, user, profile?.full_name, conversation?.id, statusCopy],
  );

  const handleDeleteNote = useCallback(
    async (noteId: string) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("contact_notes")
        .delete()
        .eq("id", noteId);
      if (error) {
        console.error("Failed to delete note:", error);
        toast.error(statusCopy.noteFailed);
        return;
      }
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      if (contact) notifyContactNotesChanged(contact.id);
      toast.success(statusCopy.noteDeleted);
    },
    [statusCopy, contact],
  );

  const handleOpenTemplates = useCallback(() => {
    setTemplateModalOpen(true);
  }, []);

  const handleSendTemplate = useCallback(
    async (
      template: MessageTemplate,
      values: {
        body: string[];
        headerText?: string;
        buttonParams?: Record<number, string>;
      },
    ) => {
      if (!conversation) return;

      const renderedBody = renderTemplateBody(template.body_text, values.body);
      const tempId = `temp-${Date.now()}`;

      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "template",
        content_text: renderedBody,
        template_name: template.name,
        status: "sending",
        created_at: new Date().toISOString(),
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "template",
            template_name: template.name,
            template_language: template.language,
            // Structured params drive the new send-builder path
            // (header media + URL button substitution). Body values
            // are mirrored under both shapes so the route can fall
            // back if the template row isn't found locally.
            template_message_params: {
              body: values.body,
              headerText: values.headerText,
              buttonParams: values.buttonParams,
            },
            template_params: values.body,
            content_text: renderedBody,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error("Failed to send template:", reason);
          toast.error(`Failed to send template: ${reason}`);
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send template:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Failed to send template: ${reason}`);
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage],
  );

  // Build a quick id → Message map so reply quotes can be rendered without
  // an extra fetch — the thread already holds the full conversation.
  const messagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  // Bucket reactions by their target message_id for O(1) per-bubble lookup.
  const reactionsByMessageId = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const r of reactions) {
      const bucket = map.get(r.message_id);
      if (bucket) bucket.push(r);
      else map.set(r.message_id, [r]);
    }
    return map;
  }, [reactions]);

  const contactDisplayName = contact?.name || contact?.phone || t("Customer");

  // Author label for a quoted message: "You" when we sent the parent,
  // contact name when the customer sent it.
  const authorLabelFor = useCallback(
    (m: Message): string => {
      const isAgentMsg =
        m.sender_type === "agent" || m.sender_type === "bot";
      return isAgentMsg ? "You" : contactDisplayName;
    },
    [contactDisplayName],
  );

  const handleStartReply = useCallback(
    (msg: Message) => {
      setReplyTo({
        id: msg.id,
        authorLabel: authorLabelFor(msg),
        preview: buildReplyPreview(msg),
      });
    },
    [authorLabelFor],
  );

  // Single reaction-set primitive. emoji === "" removes; otherwise adds/swaps.
  // The "toggle" semantic (pill click) is computed at the call site where the
  // current reactions for the bubble are already in scope — keeps this
  // function dependency-free w.r.t. the reaction list.
  const postReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!user?.id || !conversation) {
        console.warn("[reactions] missing user or conversation");
        return;
      }
      if (messageId.startsWith("temp-")) {
        toast.error("Wait for the message to finish sending");
        return;
      }

      const convId = conversation.id;
      const userId = user.id;
      let snapshot: MessageReaction[] = [];

      // Functional updater — captures the freshest reactions list, never a
      // stale closure. Snapshot stored for rollback on POST failure.
      setReactions((prev) => {
        snapshot = prev;
        const own = prev.find(
          (r) =>
            r.message_id === messageId &&
            r.actor_type === "agent" &&
            r.actor_id === userId,
        );
        if (emoji === "") return own ? prev.filter((r) => r !== own) : prev;
        if (own) return prev.map((r) => (r === own ? { ...own, emoji } : r));
        return [
          ...prev,
          {
            id: `temp-${Date.now()}`,
            message_id: messageId,
            conversation_id: convId,
            actor_type: "agent",
            actor_id: userId,
            emoji,
            created_at: new Date().toISOString(),
          },
        ];
      });

      try {
        const res = await fetch("/api/whatsapp/react", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message_id: messageId, emoji }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || `HTTP ${res.status}`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(`Reaction failed: ${reason}`);
        setReactions(snapshot);
      }
    },
    [conversation, user?.id],
  );

  /**
   * Assign / transfer / unassign. With `expectCurrent`, the update only
   * applies while the conversation still has the assignee this tab last
   * saw (compare-and-set) — "Assumir" must not silently steal a thread a
   * teammate took a second earlier. Returns what happened so callers
   * only celebrate a real change.
   */
  const handleAssignChange = useCallback(
    async (
      agentId: string | null,
      opts: { expectCurrent?: boolean } = {},
    ): Promise<"ok" | "failed" | "conflict"> => {
      if (!conversation) return "failed";

      const result = await updateConversationAssignee(createClient(), {
        conversationId: conversation.id,
        agentId,
        ...(opts.expectCurrent
          ? { expectCurrent: conversation.assigned_agent_id ?? null }
          : {}),
      });

      if (result.status === "failed") {
        console.error("Failed to update assignment:", result.error);
        toast.error(t("Failed to update assignment"));
        return "failed";
      }
      if (result.status === "conflict") {
        // Someone else changed it first: show who has it now.
        onAssignChange(conversation.id, result.assignee);
        const who =
          (result.assignee &&
            profiles.find((p) => p.user_id === result.assignee)?.full_name) ||
          statusCopy.someone;
        toast.info(statusCopy.claimTaken(who));
        return "conflict";
      }

      onAssignChange(conversation.id, agentId);
      if (agentId && agentId !== user?.id) {
        // Push (spec round 2 §5d): the server notifies the new assignee.
        notifyPushEvent({ kind: "conversation_assigned", conversation_id: conversation.id });
      }
      if (agentId) {
        const assignee = profiles.find((p) => p.user_id === agentId);
        void logEvent({
          event_type: "assigned",
          payload: {
            assignee_user_id: agentId,
            assignee_name: assignee?.full_name ?? undefined,
            self_assigned: agentId === user?.id,
          },
        });
      } else {
        void logEvent({ event_type: "unassigned", payload: {} });
      }
      return "ok";
    },
    [conversation, onAssignChange, profiles, logEvent, user?.id, t, statusCopy],
  );

  // "Assumir": the assign dropdown's shortcut for "me".
  const handleClaim = useCallback(async () => {
    if (!user?.id) return;
    const outcome = await handleAssignChange(user.id, { expectCurrent: true });
    if (outcome === "ok") toast.success(statusCopy.claimedToast);
  }, [handleAssignChange, user?.id, statusCopy]);

  // Arquivar = resolve + `archived_at` (migration 056); Desarquivar only
  // clears `archived_at` (the thread stays resolved). The DB trigger
  // unarchives by itself when the customer writes again or it reopens.
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const handleArchive = useCallback(
    async (archive: boolean) => {
      if (!conversation) return;
      setArchiveBusy(true);
      const patch: Partial<Conversation> = archive
        ? { status: "closed", archived_at: new Date().toISOString() }
        : { archived_at: null };
      const { error } = await createClient()
        .from("conversations")
        .update(patch)
        .eq("id", conversation.id);
      setArchiveBusy(false);
      setArchiveConfirmOpen(false);
      if (error) {
        console.error("Failed to archive conversation:", error);
        toast.error(statusCopy.archiveFailed);
        return;
      }
      if (archive && conversation.status !== "closed") {
        onStatusChange(conversation.id, "closed");
        void logEvent({
          event_type: "status_changed",
          payload: { status: "closed", previous_status: conversation.status },
        });
      }
      onConversationPatch?.(conversation.id, { archived_at: patch.archived_at ?? null });
      toast.success(archive ? statusCopy.archivedToast : statusCopy.unarchivedToast);
    },
    [conversation, onStatusChange, onConversationPatch, logEvent, statusCopy],
  );

  // Name lookup shared by the baseline pills and note headers.
  const nameForUser = useCallback(
    (userId: string | undefined): string | undefined => {
      if (!userId) return undefined;
      if (userId === user?.id) return statusCopy.you;
      return profiles.find((p) => p.user_id === userId)?.full_name || undefined;
    },
    [profiles, user?.id, statusCopy.you],
  );

  // Messages + notes + events in one stream, bucketed by day. Baseline
  // pills describe the row's *current* assignee / status for threads
  // that predate the events table, so an old thread still says who owns
  // it. Live profile names win over the snapshot stored in the row.
  const timelineGroups = useMemo(() => {
    if (!conversation) return [];
    const profileName = (id: string) =>
      profiles.find((p) => p.user_id === id)?.full_name || undefined;
    const logged = eventRecords.map((r) => eventFromRecord(r, profileName));
    const baseline = deriveBaselineEvents(conversation, logged, profileName);
    const visible = [...logged, ...baseline].filter(isVisibleEvent);
    return groupTimelineByDay(buildThreadTimeline(messages, notes, visible));
  }, [conversation, messages, notes, eventRecords, profiles]);
  const timelineNow = Date.now();

  // Empty state — same WhatsApp-style doodle background as the active
  // thread below, so swapping between empty/selected doesn't change the
  // pattern under the user's eye.
  if (!conversation || !contact) {
    return (
      <div className={cn("flex flex-1 flex-col items-center justify-center", DOODLE_BG_CLASSES)}>
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <MessageSquare className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="mt-4 text-sm font-medium text-muted-foreground">
          Select a conversation
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose a conversation from the left to start messaging
        </p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const status = conversation.status;
  // Transport this thread lives on. The 24 h window and templates are
  // Cloud API concepts, so both are hidden for QR conversations.
  const channel: WhatsAppChannel = conversation.channel === "qr" ? "qr" : "official";
  const isOfficial = channel === "official";
  const isResolved = status === "closed";
  const assignedAgentId = conversation.assigned_agent_id ?? null;
  const currentAssignee = profiles.find((p) => p.user_id === assignedAgentId);
  const assignLabel = assignedAgentId
    ? (currentAssignee?.full_name ?? "Assigned")
    : "Assign";
  const isArchived = !!conversation.archived_at;
  // Tooltip copy is language-keyed; the visible chip label above goes
  // through the DOM catalogue ("Assign" / "Assigned").
  const assigneeForTitle = assignedAgentId
    ? (currentAssignee?.full_name ?? statusCopy.assignedUnknown)
    : statusCopy.noAssignee;
  // Assumir / Transferir / Lembrar / Resolver / Arquivar — agent+ act,
  // viewers see them disabled (lib/conversations/header-actions).
  const actions = conversationHeaderActions({
    role: accountRole,
    userId: user?.id,
    conversation,
    tasksEnabled,
  });

  return (
    // `min-w-0` is load-bearing: the page already puts min-w-0 on the
    // thread's flex *wrapper* (issue #165), but this root keeps the
    // default `min-width: auto`, so a single wide message (long unbroken
    // URL/word) expands the whole thread past its flex share and the chat
    // paints on top of the contact sidebar at lg+ — outgoing bubbles get
    // clipped and the hover toolbar overlaps the Tags panel. Letting the
    // root shrink lets the bubbles' break-words / max-w caps apply.
    // Issue #257.
    // `@container` lets the header size its button labels by the thread's
    // own width (not the viewport): with the contact panel open at 1280
    // the thread is ~440 px and the labels must yield to the name/phone.
    <div className={cn("@container flex min-w-0 flex-1 flex-col", DOODLE_BG_CLASSES)}>
      {/* Header — solid card surface sits on top of the doodle so the
          name/avatar/dropdowns stay legible. One filled control only
          (Resolver / Reabrir, a split button whose chevron opens the full
          status picker); assignee, refresh and the panel toggle are
          ghost buttons so the primary action is unmistakable. */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          {/* Back-to-list button — mobile only. Hidden on lg+ where the
              conversation list is always visible next to the thread. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={statusCopy.back}
              title={statusCopy.back}
              className="-ml-1 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <ContactAvatar
            key={contact.id}
            src={contact.avatar_url}
            name={displayName}
            className="h-9 w-9 text-sm"
          />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold leading-5 text-foreground">
              {displayName}
            </h2>
            <div className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
              {/* Phone truncates on phones; the status + window badges
                  are the parts that must stay visible. */}
              <p
                data-no-translate
                className="min-w-0 truncate tabular-nums"
                title={contact.phone}
              >
                {contact.phone}
              </p>
              {/* Status — read-only badge; changed via the split button. */}
              <span
                data-no-translate
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 text-[10px] font-medium leading-4",
                  STATUS_COLOR[status]
                )}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[status])} />
                {isArchived ? statusCopy.archivedLabel : statusCopy.labels[status]}
              </span>
              {/* Channel chip — QR vs official (migration 026). */}
              <span
                data-no-translate
                title={statusCopy.channelTitle[channel]}
                className={cn(
                  "inline-flex shrink-0 items-center rounded px-1 text-[9px] font-semibold uppercase leading-4 tracking-wide",
                  channel === "qr"
                    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {statusCopy.channelChip[channel]}
              </span>
              {/* 24 h session window — official channel only, and only
                  when the thread is >= 32rem wide; the composer banner
                  explains an expired window. */}
              {isOfficial && (
                <Badge
                  variant="outline"
                  title={sessionInfo.remaining}
                  aria-label={sessionInfo.remaining}
                  className={cn(
                    "hidden h-4 shrink-0 gap-1 border-border px-1.5 py-0 text-[10px] tabular-nums @lg:inline-flex",
                    sessionInfo.expired ? "text-red-400" : "text-primary"
                  )}
                >
                  <Clock className="h-3 w-3" />
                  {sessionInfo.short}
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* Assumir — outline, one click to own the thread. Hidden when it
              is already mine or resolved; disabled for viewers. */}
          {actions.claim.visible && (
            <button
              type="button"
              data-no-translate
              onClick={() => void handleClaim()}
              disabled={!actions.claim.enabled}
              aria-label={actions.canWrite ? statusCopy.claimTitle : statusCopy.readOnly}
              title={actions.canWrite ? statusCopy.claimTitle : statusCopy.readOnly}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <UserCheck className="h-3.5 w-3.5" />
              <span className="hidden @lg:inline">{statusCopy.claim}</span>
            </button>
          )}
          {/* Assignee / Transferir — ghost chip. Name shows once the thread
              is >= 36rem wide; below that the icon + tooltip carry it. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={!actions.transfer.enabled}
              aria-label={actions.canWrite ? statusCopy.transferTitle(assigneeForTitle) : statusCopy.readOnly}
              title={actions.canWrite ? statusCopy.transferTitle(assigneeForTitle) : statusCopy.readOnly}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
                assignedAgentId ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {assignedAgentId ? (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                  {(currentAssignee?.full_name ?? "?").charAt(0).toUpperCase()}
                </span>
              ) : (
                <UserPlus className="h-3.5 w-3.5" />
              )}
              <span className="hidden max-w-28 truncate @xl:inline">{assignLabel}</span>
              <ChevronDown className="hidden h-3 w-3 text-muted-foreground @xl:inline" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              <DropdownMenuGroup>
                <DropdownMenuLabel>{statusCopy.transferTo}</DropdownMenuLabel>
              </DropdownMenuGroup>
              {profiles.length === 0 ? (
                <DropdownMenuItem disabled className="text-sm text-muted-foreground">
                  No teammates available
                </DropdownMenuItem>
              ) : (
                profiles.map((p) => {
                  const isSelected = p.user_id === assignedAgentId;
                  return (
                    <DropdownMenuItem
                      key={p.id}
                      onClick={() => handleAssignChange(p.user_id)}
                      className={cn(
                        "text-sm",
                        isSelected ? "text-primary" : "text-popover-foreground"
                      )}
                    >
                      <span className="flex-1">
                        {p.full_name}
                        {p.user_id === user?.id && (
                          <span className="text-muted-foreground"> (me)</span>
                        )}
                      </span>
                      {isSelected && <Check className="ml-2 h-3 w-3" />}
                    </DropdownMenuItem>
                  );
                })
              )}
              {assignedAgentId && (
                <>
                  <DropdownMenuSeparator className="bg-border" />
                  <DropdownMenuItem
                    onClick={() => handleAssignChange(null)}
                    className="text-sm text-muted-foreground"
                  >
                    Unassign
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Resolve / Reopen split button — THE queue action. Main part
              flips open ⇄ resolved; the chevron opens the full lifecycle
              picker (open / pending / resolved). Copy comes from
              THREAD_STATUS_COPY so it matches the list chips. */}
          <div
            data-no-translate
            className={cn(
              "ml-1 inline-flex h-8 items-stretch overflow-hidden rounded-md text-xs font-medium",
              isResolved
                ? "border border-border bg-card text-foreground"
                : "bg-primary text-primary-foreground shadow-sm"
            )}
          >
            <button
              type="button"
              onClick={handleResolveToggle}
              disabled={!actions.close.enabled}
              aria-label={isResolved ? statusCopy.reopen : statusCopy.resolve}
              title={
                !actions.canWrite
                  ? statusCopy.readOnly
                  : isResolved
                    ? statusCopy.reopen
                    : statusCopy.resolve
              }
              className={cn(
                "inline-flex items-center gap-1.5 pl-2.5 pr-2 transition-colors disabled:cursor-not-allowed disabled:opacity-60 @md:pr-2.5",
                isResolved ? "hover:bg-muted" : "hover:bg-primary/90"
              )}
            >
              {isResolved ? (
                <RotateCcw className="h-3.5 w-3.5" />
              ) : (
                <CheckCheck className="h-3.5 w-3.5" />
              )}
              <span className="hidden @md:inline">
                {isResolved ? statusCopy.reopen : statusCopy.resolve}
              </span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={!actions.close.enabled}
                aria-label={statusCopy.changeStatus}
                title={actions.canWrite ? statusCopy.changeStatus : statusCopy.readOnly}
                className={cn(
                  "inline-flex w-6 items-center justify-center border-l transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  isResolved
                    ? "border-border hover:bg-muted"
                    : "border-primary-foreground/20 hover:bg-primary/90"
                )}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                data-no-translate
                className="min-w-36 border-border bg-popover"
              >
                {STATUS_ORDER.map((value) => (
                  <DropdownMenuItem
                    key={value}
                    onClick={() => handleStatusChange(value)}
                    className={cn(
                      "gap-2 text-sm",
                      status === value ? "text-primary" : "text-popover-foreground"
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[value])} />
                    <span className="flex-1">{statusCopy.labels[value]}</span>
                    {status === value && <Check className="h-3 w-3" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Lembrar — reminder task at a chosen time (Tasks module). */}
          {actions.remind.visible && (
            <ConversationReminder
              key={conversation.id}
              conversationId={conversation.id}
              contactId={contact.id}
              contactName={displayName}
              disabled={!actions.remind.enabled}
            />
          )}

          {/* Utilities — ghost icon buttons, visually a step below the
              actions. Hidden on phones where the header is at its
              tightest. */}
          <span className="mx-1 hidden h-5 w-px bg-border @md:block" aria-hidden="true" />
          {onRefresh && (
            <button
              type="button"
              onClick={handleRefreshClick}
              disabled={isRefreshing}
              aria-label="Refresh conversation"
              title="Refresh"
              className="hidden h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60 @md:inline-flex"
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")}
              />
            </button>
          )}
          {/* Overflow — "Criar tarefa" (Tasks module) and "Agendar"
              (Calendar module), agent+, then Arquivar / Desarquivar
              (disabled for viewers). */}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("More actions")}
              title={t("More actions")}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
            >
              <MoreVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="min-w-44 border-border bg-popover"
            >
              {canCreateTask && (
                <DropdownMenuItem
                  onClick={() => setTaskDrawerOpen(true)}
                  className="gap-2 text-sm text-popover-foreground"
                >
                  <CheckSquare className="h-4 w-4" />
                  {t("Create task")}
                </DropdownMenuItem>
              )}
              {canSchedule && (
                <DropdownMenuItem
                  onClick={() => setEventDrawerOpen(true)}
                  className="gap-2 text-sm text-popover-foreground"
                >
                  <CalendarPlus className="h-4 w-4" />
                  {t("Schedule appointment")}
                </DropdownMenuItem>
              )}
              {(canCreateTask || canSchedule) && (
                <DropdownMenuSeparator className="bg-border" />
              )}
              {actions.archive.visible && (
                <DropdownMenuItem
                  disabled={!actions.archive.enabled || archiveBusy}
                  onClick={() => setArchiveConfirmOpen(true)}
                  className="gap-2 text-sm text-popover-foreground"
                  data-no-translate
                >
                  <Archive className="h-4 w-4" />
                  {statusCopy.archive}
                </DropdownMenuItem>
              )}
              {actions.unarchive.visible && (
                <DropdownMenuItem
                  disabled={!actions.unarchive.enabled || archiveBusy}
                  onClick={() => void handleArchive(false)}
                  className="gap-2 text-sm text-popover-foreground"
                  data-no-translate
                >
                  <ArchiveRestore className="h-4 w-4" />
                  {statusCopy.unarchive}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Contact-panel toggle — desktop only (the panel is xl-only,
              issue #258). */}
          {onToggleContactPanel && (
            <button
              type="button"
              onClick={onToggleContactPanel}
              aria-label={
                contactPanelOpen ? "Hide contact panel" : "Show contact panel"
              }
              aria-pressed={contactPanelOpen}
              title={contactPanelOpen ? "Hide contact" : "Show contact"}
              className={cn(
                "hidden h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground xl:inline-flex",
                contactPanelOpen ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {contactPanelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      </div>

      <Dialog open={archiveConfirmOpen} onOpenChange={setArchiveConfirmOpen}>
        <DialogContent data-no-translate>
          <DialogHeader>
            <DialogTitle>{statusCopy.archiveTitle}</DialogTitle>
            <DialogDescription>
              {isResolved ? statusCopy.archiveBody : statusCopy.archiveOpenBody}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiveConfirmOpen(false)}>
              {statusCopy.cancel}
            </Button>
            <Button disabled={archiveBusy} onClick={() => void handleArchive(true)}>
              <Archive />
              {statusCopy.archive}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {canCreateTask && (
        <TaskDrawer
          open={taskDrawerOpen}
          onOpenChange={setTaskDrawerOpen}
          task={null}
          defaults={{
            contact_id: contact.id,
            conversation_id: conversation.id,
            title: `${t("Service")}: ${displayName}`,
          }}
        />
      )}
      {canSchedule && (
        <EventDrawer
          open={eventDrawerOpen}
          onOpenChange={setEventDrawerOpen}
          event={null}
          defaults={{
            contact_id: contact.id,
            conversation_id: conversation.id,
            title: `${t("Service")}: ${displayName}`,
          }}
        />
      )}

      {/* Messages Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : timelineGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">No messages yet</p>
            <p className="text-xs text-muted-foreground">
              {isOfficial
                ? "Send a template to start the conversation"
                : "Send a message to start the conversation"}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {timelineGroups.map((group) => (
              <div key={group.date}>
                {/* Date separator */}
                <div className="mb-4 flex items-center justify-center">
                  <span className="rounded-full bg-muted px-3 py-1 text-[10px] font-medium text-muted-foreground">
                    {formatDateSeparator(group.date, language)}
                  </span>
                </div>
                {/* Messages, notes and system pills, interleaved */}
                <div className="space-y-2">
                  {group.items.map((item) => {
                    if (item.kind === "event") {
                      return (
                        <SystemEventPill
                          key={item.id}
                          event={item.event}
                          language={language}
                          now={timelineNow}
                        />
                      );
                    }
                    if (item.kind === "note") {
                      const note = item.note;
                      const mine = note.user_id === user?.id;
                      return (
                        <InternalNoteBubble
                          key={item.id}
                          note={note}
                          authorName={nameForUser(note.user_id) ?? statusCopy.team}
                          label={statusCopy.noteLabel}
                          hint={statusCopy.noteHint}
                          deleteLabel={statusCopy.noteDelete}
                          onDelete={mine ? () => void handleDeleteNote(note.id) : undefined}
                        />
                      );
                    }
                    const msg = item.message;
                    const parent = msg.reply_to_message_id
                      ? messagesById.get(msg.reply_to_message_id)
                      : null;
                    const reply = parent
                      ? {
                          authorLabel: authorLabelFor(parent),
                          preview: buildReplyPreview(parent),
                        }
                      : null;
                    const msgReactions = reactionsByMessageId.get(msg.id);
                    // Toggle is computed at the call site — `msgReactions`
                    // and `user?.id` are already in scope, no extra hook.
                    const handlePillToggle = (emoji: string) => {
                      const own = msgReactions?.find(
                        (r) =>
                          r.actor_type === "agent" &&
                          r.actor_id === user?.id,
                      );
                      const next = own?.emoji === emoji ? "" : emoji;
                      void postReaction(msg.id, next);
                    };
                    return (
                      <MessageActions
                        key={item.id}
                        message={msg}
                        onReply={() => handleStartReply(msg)}
                        onReact={(emoji) => {
                          if (emoji) void postReaction(msg.id, emoji);
                        }}
                      >
                        <MessageBubble
                          message={msg}
                          reply={reply}
                          reactions={msgReactions}
                          currentUserId={user?.id}
                          onToggleReaction={handlePillToggle}
                        />
                      </MessageActions>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Composer */}
      <MessageComposer
        conversationId={conversation.id}
        sessionExpired={isOfficial && sessionInfo.expired}
        templatesEnabled={isOfficial}
        contactName={contact?.name ?? conversation.contact?.name ?? null}
        onSend={handleSend}
        onSendMedia={handleSendMedia}
        onOpenTemplates={handleOpenTemplates}
        onSendNote={handleSendNote}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        contactAnonymized={!!contact?.anonymized_at}
      />

      <TemplatePicker
        open={templateModalOpen}
        onOpenChange={setTemplateModalOpen}
        onSelect={handleSendTemplate}
      />
    </div>
  );
}
