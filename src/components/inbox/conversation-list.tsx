"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, WhatsAppChannel } from "@/types";
import type { Language } from "@/lib/i18n";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import {
  classifyConversation,
  countRadar,
  formatWaitingAge,
  isRadarKey,
  matchesRadar,
  RADAR_KEYS,
  type RadarKey,
} from "@/lib/radar/classify";
import {
  Search,
  ChevronDown,
  Check,
  MessageCircle,
  MailOpen,
  Clock,
  UserX,
  Snowflake,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

/** Queue view: what the agent is triaging. */
type TriageTab = "mine" | "unassigned" | "all";
/** Status filter applied before the queue tabs are counted. */
type StatusFilter = ConversationStatus | "all";

const TRIAGE_TABS: TriageTab[] = ["mine", "unassigned", "all"];
const STATUS_FILTERS: StatusFilter[] = ["open", "pending", "closed", "all"];

/**
 * Remembers the agent's queue (tab) + status choice across reloads so
 * someone working "Minhas · Abertas" all day lands back there. Device-
 * scoped, like the contact-panel toggle on the page.
 */
const TRIAGE_STORAGE_KEY = "wacrm:inbox:triage";

/**
 * Strip copy lives in a language-keyed table (driven by `useLanguage`)
 * instead of the DOM catalogue because the pt-BR forms are feminine
 * plurals ("Todas", "Não atribuídas") that would collide with the
 * existing singular catalogue keys ("All" → "Todos", "Unassigned" →
 * "Não atribuído"). The strip is marked `data-no-translate` so the
 * DOM translator leaves these alone.
 */
const STRIP_COPY: Record<
  Language,
  {
    title: string;
    tabs: Record<TriageTab, string>;
    status: Record<StatusFilter, string>;
    rowStatus: Record<Exclude<ConversationStatus, "open">, string>;
    unreadOnly: string;
    channel: string;
    /** Short channel chip shown on the row (migration 026). */
    channelChip: Record<WhatsAppChannel, string>;
    moreTags: (n: number) => string;
    /** Radar chips (spec §3) above the queue tabs. */
    radar: string;
    radarChips: Record<RadarKey, string>;
    radarClear: string;
    waitingTitle: string;
  }
> = {
  "pt-BR": {
    title: "Conversas",
    tabs: { mine: "Minhas", unassigned: "Não atribuídas", all: "Todas" },
    status: {
      open: "Abertas",
      pending: "Pendentes",
      closed: "Resolvidas",
      all: "Todas",
    },
    rowStatus: { pending: "Pendente", closed: "Resolvida" },
    unreadOnly: "Só não lidas",
    channel: "WhatsApp",
    channelChip: { official: "Oficial", qr: "QR" },
    moreTags: (n) => `+${n}`,
    radar: "Radar",
    radarChips: { waiting: "Aguardando", unassigned: "Sem responsável", cooling: "Esfriando" },
    radarClear: "Limpar filtro do radar",
    waitingTitle: "Cliente aguardando resposta além do SLA",
  },
  "en-US": {
    title: "Conversations",
    tabs: { mine: "Mine", unassigned: "Unassigned", all: "All" },
    status: {
      open: "Open",
      pending: "Pending",
      closed: "Resolved",
      all: "All",
    },
    rowStatus: { pending: "Pending", closed: "Resolved" },
    unreadOnly: "Unread only",
    channel: "WhatsApp",
    channelChip: { official: "Official", qr: "QR" },
    moreTags: (n) => `+${n}`,
    radar: "Radar",
    radarChips: { waiting: "Waiting", unassigned: "Unassigned", cooling: "Cooling" },
    radarClear: "Clear radar filter",
    waitingTitle: "Customer waiting past the SLA",
  },
};

const RADAR_ICON: Record<RadarKey, typeof Clock> = {
  waiting: Clock,
  unassigned: UserX,
  cooling: Snowflake,
};

/** Active-chip colours per bucket — same hues as the dashboard Radar card. */
const RADAR_ACTIVE: Record<RadarKey, string> = {
  waiting: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
  unassigned: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  cooling: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
};

const STATUS_DOT: Record<StatusFilter, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
  all: "bg-foreground/40",
};

interface RowTag {
  name: string;
  color: string;
}

/**
 * Compact, language-aware age for list rows: "agora", "5 min", "2 h",
 * "3 d", "2 sem", then a short date. Always in the UI language so the
 * list never mixes "about 1 hour" with "1 dia" (round-0 critic gap).
 */
function formatAge(
  iso: string | undefined,
  language: Language,
  now: number
): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const pt = language === "pt-BR";
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 60) return pt ? "agora" : "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return pt ? `${min} min` : `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return pt ? `${h} h` : `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return pt ? `${d} d` : `${d}d`;
  if (d < 30) {
    const w = Math.floor(d / 7);
    return pt ? `${w} sem` : `${w}w`;
  }
  return new Date(iso).toLocaleDateString(language, {
    day: "2-digit",
    month: "2-digit",
  });
}

function isTriageTab(v: unknown): v is TriageTab {
  return TRIAGE_TABS.includes(v as TriageTab);
}
function isStatusFilter(v: unknown): v is StatusFilter {
  return STATUS_FILTERS.includes(v as StatusFilter);
}

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const { user, preferences } = useAuth();
  const { language } = useLanguage();
  const copy = STRIP_COPY[language] ?? STRIP_COPY["pt-BR"];
  const userId = user?.id ?? null;

  // Radar filter lives in the URL (?radar=waiting|unassigned|cooling) so
  // the dashboard card can deep-link into it and a reload keeps it.
  const router = useRouter();
  const searchParams = useSearchParams();
  const radarParam = searchParams.get("radar");
  const radar: RadarKey | null = isRadarKey(radarParam) ? radarParam : null;
  const setRadar = useCallback(
    (next: RadarKey | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next) params.set("radar", next);
      else params.delete("radar");
      const qs = params.toString();
      router.replace(qs ? `/inbox?${qs}` : "/inbox", { scroll: false });
    },
    [router, searchParams],
  );

  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<TriageTab>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tagsByContact, setTagsByContact] = useState<Map<string, RowTag[]>>(
    () => new Map()
  );

  // The persisted queue view is restored inside the fetch effect below,
  // right before the first batch of conversations lands — so tabs and
  // rows appear in one paint, and the server-rendered defaults never
  // disagree with the client (reading localStorage in the initializer
  // would be a hydration mismatch). Once only, hence the ref.
  const triageRestoredRef = useRef(false);
  const restorePersistedTriage = useCallback(() => {
    if (triageRestoredRef.current) return;
    triageRestoredRef.current = true;
    try {
      const raw = localStorage.getItem(TRIAGE_STORAGE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw) as { tab?: unknown; status?: unknown };
      if (isTriageTab(stored.tab)) setTab(stored.tab);
      if (isStatusFilter(stored.status)) setStatusFilter(stored.status);
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
  }, []);

  const persistTriage = useCallback((next: { tab: TriageTab; status: StatusFilter }) => {
    try {
      localStorage.setItem(TRIAGE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Persistence is best-effort.
    }
  }, []);

  const handleTabChange = useCallback(
    (next: TriageTab) => {
      setTab(next);
      persistTriage({ tab: next, status: statusFilter });
    },
    [persistTriage, statusFilter]
  );

  const handleStatusChange = useCallback(
    (next: StatusFilter) => {
      setStatusFilter(next);
      persistTriage({ tab, status: next });
    },
    [persistTriage, tab]
  );

  // Ticks once a minute so the relative ages in the rows stay honest
  // without a refetch. Rows only render client-side (after the fetch),
  // so the initial Date.now() never reaches SSR markup.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("*, contact:contacts(*)")
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      restorePersistedTriage();
      onConversationsLoadedRef.current(data ?? []);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken, restorePersistedTriage]);

  // Label chips on rows: one batched contact_tags fetch for every contact
  // in the list. Keyed on the sorted id set so realtime preview / unread
  // patches (which don't change membership) never refire it.
  const contactIdsKey = useMemo(
    () =>
      Array.from(
        new Set(conversations.map((c) => c.contact_id).filter(Boolean))
      )
        .sort()
        .join(","),
    [conversations]
  );

  useEffect(() => {
    if (!contactIdsKey) return;
    const ids = contactIdsKey.split(",");
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("contact_tags")
        .select("contact_id, tags(name, color)")
        .in("contact_id", ids);
      if (cancelled || error || !data) return;

      const next = new Map<string, RowTag[]>();
      for (const row of data as unknown as {
        contact_id: string;
        tags: RowTag | RowTag[] | null;
      }[]) {
        if (!row.tags) continue;
        const list = Array.isArray(row.tags) ? row.tags : [row.tags];
        const bucket = next.get(row.contact_id) ?? [];
        for (const tag of list) {
          if (tag?.name) bucket.push({ name: tag.name, color: tag.color });
        }
        next.set(row.contact_id, bucket);
      }
      setTagsByContact(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [contactIdsKey, resyncToken]);

  // Status (+ unread) narrow the pool; the queue tabs are counted from
  // that pool so the badges answer "how many open ones are mine /
  // unassigned / total" — exactly what a team lead scans for.
  const pool = useMemo(() => {
    let result = conversations;
    if (radar) {
      // A radar bucket replaces the status chip: the bucket definition
      // already fixes the status (never closed; "unassigned" is open
      // only), and this keeps the list in step with the chip / dashboard
      // counts when someone deep-links from the card.
      result = result.filter((c) => matchesRadar(c, radar, preferences, now));
    } else if (statusFilter !== "all") {
      result = result.filter((c) => c.status === statusFilter);
    }
    if (unreadOnly) {
      result = result.filter((c) => c.unread_count > 0);
    }
    return result;
  }, [conversations, statusFilter, unreadOnly, radar, preferences, now]);

  // Radar counts are taken over every conversation the list knows — the
  // same population the dashboard card counts — regardless of the
  // status / unread / queue filters, so both surfaces show identical
  // numbers.
  const radarCounts = useMemo(
    () => countRadar(conversations, preferences, now),
    [conversations, preferences, now],
  );

  const counts = useMemo<Record<TriageTab, number>>(() => {
    let mine = 0;
    let unassigned = 0;
    for (const c of pool) {
      if (!c.assigned_agent_id) unassigned += 1;
      else if (userId && c.assigned_agent_id === userId) mine += 1;
    }
    return { mine, unassigned, all: pool.length };
  }, [pool, userId]);

  const filtered = useMemo(() => {
    let result = pool;

    if (tab === "mine") {
      result = result.filter(
        (c) => !!userId && c.assigned_agent_id === userId
      );
    } else if (tab === "unassigned") {
      result = result.filter((c) => !c.assigned_agent_id);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [pool, tab, userId, search]);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden border-r border-border bg-card lg:w-80">
      {/* Triage strip: title + status chip, search, queue tabs */}
      <div className="border-b border-border">
        <div
          className="flex items-center justify-between gap-2 px-3 pt-3"
          data-no-translate
        >
          <h2 className="text-sm font-semibold text-foreground">{copy.title}</h2>
          <div className="flex items-center gap-1">
            {/* Status chip — which lifecycle bucket the queue shows */}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={copy.status[statusFilter]}
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-muted/60 pl-2 pr-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                <span
                  className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[statusFilter])}
                />
                {copy.status[statusFilter]}
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-36 border-border bg-popover">
                {STATUS_FILTERS.map((value) => (
                  <DropdownMenuItem
                    key={value}
                    onClick={() => handleStatusChange(value)}
                    className={cn(
                      "gap-2 text-sm",
                      statusFilter === value ? "text-primary" : "text-popover-foreground"
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[value])} />
                    <span className="flex-1">{copy.status[value]}</span>
                    {statusFilter === value && <Check className="h-3 w-3" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Unread-only toggle */}
            <button
              type="button"
              onClick={() => setUnreadOnly((v) => !v)}
              aria-pressed={unreadOnly}
              aria-label={copy.unreadOnly}
              title={copy.unreadOnly}
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors",
                unreadOnly
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <MailOpen className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="px-3 pt-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={handleSearchChange}
              placeholder="Search conversations..."
              className="h-8 border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
            />
          </div>
        </div>

        {/* Radar chips (spec §3): waiting past SLA · open without owner ·
            cooling after our last message. Bound to ?radar=; clicking the
            active chip clears it. */}
        <div
          role="group"
          aria-label={copy.radar}
          className="mt-2 flex items-center gap-1.5 overflow-x-auto px-3 [scrollbar-width:none]"
          data-no-translate
        >
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {copy.radar}
          </span>
          {RADAR_KEYS.map((key) => {
            const active = radar === key;
            const count = radarCounts[key];
            const Icon = RADAR_ICON[key];
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                title={active ? copy.radarClear : copy.radarChips[key]}
                onClick={() => setRadar(active ? null : key)}
                className={cn(
                  "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium whitespace-nowrap transition-colors",
                  active
                    ? RADAR_ACTIVE[key]
                    : count > 0
                      ? "border-border bg-muted/60 text-foreground hover:bg-muted"
                      : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="h-3 w-3" aria-hidden />
                {copy.radarChips[key]}
                <span
                  className={cn(
                    "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums leading-none",
                    active ? "bg-background/70" : "bg-background/60 text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Queue tabs with live counts */}
        <div
          role="tablist"
          className="mt-1 flex items-stretch overflow-x-auto px-3 [scrollbar-width:none]"
          data-no-translate
        >
          {TRIAGE_TABS.map((value) => {
            const active = tab === value;
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => handleTabChange(value)}
                className={cn(
                  "-mb-px flex flex-1 items-center justify-center gap-1.5 border-b-2 px-1 py-2 text-xs font-medium whitespace-nowrap transition-colors",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {copy.tabs[value]}
                <span
                  className={cn(
                    "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums leading-none",
                    active
                      ? "bg-primary/15 text-primary"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {counts[value]}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">No conversations found</p>
            <p className="mt-1 text-xs text-muted-foreground/80">
              Try another queue tab or status filter.
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                age={formatAge(conv.last_message_at, language, now)}
                tags={tagsByContact.get(conv.contact_id) ?? EMPTY_TAGS}
                rowStatus={copy.rowStatus}
                channelLabel={copy.channel}
                channelChip={copy.channelChip}
                moreTags={copy.moreTags}
                waitingLabel={waitingLabelFor(conv, preferences, now, language)}
                waitingTitle={copy.waitingTitle}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

const EMPTY_TAGS: RowTag[] = [];
const MAX_ROW_TAGS = 2;

/** "há 12 min" when the customer is waiting past the SLA, else null. */
function waitingLabelFor(
  conv: Conversation,
  preferences: { inbox_sla_minutes: number; cooling_hours: number },
  now: number,
  language: Language,
): string | null {
  const c = classifyConversation(conv, preferences, now);
  if (!c.waiting || !c.waitingSince) return null;
  return formatWaitingAge(c.waitingSince, now, language);
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  age: string;
  tags: RowTag[];
  rowStatus: Record<Exclude<ConversationStatus, "open">, string>;
  channelLabel: string;
  channelChip: Record<WhatsAppChannel, string>;
  moreTags: (n: number) => string;
  /** Set when the customer is waiting past the SLA ("há 12 min"). */
  waitingLabel: string | null;
  waitingTitle: string;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  age,
  tags,
  rowStatus,
  channelLabel,
  channelChip,
  moreTags,
  waitingLabel,
  waitingTitle,
}: ConversationItemProps) {
  const channel: WhatsAppChannel = conversation.channel === "qr" ? "qr" : "official";
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || "Unknown contact";
  const initials = displayName.charAt(0).toUpperCase();
  const isUnread = conversation.unread_count > 0;
  const status = conversation.status;

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const visibleTags = tags.slice(0, MAX_ROW_TAGS);
  const hiddenTagCount = tags.length - visibleTags.length;

  return (
    <button
      onClick={handleClick}
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "flex w-full min-w-0 items-start gap-2.5 border-b border-border/60 px-3 py-2 text-left transition-colors hover:bg-muted/50",
        isActive && "bg-muted/70 shadow-[inset_2px_0_0_var(--color-primary)]"
      )}
    >
      {/* Avatar + channel badge */}
      <div className="relative shrink-0">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
          {contact?.avatar_url ? (
            <img
              src={contact.avatar_url}
              alt={displayName}
              className="h-9 w-9 rounded-full object-cover"
            />
          ) : (
            initials
          )}
        </div>
        <span
          data-no-translate
          title={`${channelLabel} · ${channelChip[channel]}`}
          className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white ring-2 ring-card"
        >
          <MessageCircle className="h-2.5 w-2.5" />
        </span>
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "truncate text-sm leading-[18px] text-foreground",
              isUnread ? "font-semibold" : "font-medium"
            )}
          >
            {displayName}
          </span>
          {/* Channel chip (QR / Oficial) — the avatar badge says
              "WhatsApp"; this says which transport, now that there are
              two (migration 026). Tiny so the age keeps its room. */}
          <span
            data-no-translate
            className={cn(
              "shrink-0 rounded px-1 text-[9px] font-semibold uppercase leading-[14px] tracking-wide",
              channel === "qr"
                ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                : "bg-muted text-muted-foreground",
            )}
          >
            {channelChip[channel]}
          </span>
          <span className="flex-1" />
          <span
            data-no-translate
            className={cn(
              "shrink-0 text-[11px] leading-[18px] tabular-nums",
              isUnread ? "font-medium text-primary" : "text-muted-foreground"
            )}
          >
            {age}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p
            className={cn(
              "truncate text-xs leading-4",
              isUnread ? "font-medium text-foreground" : "text-muted-foreground"
            )}
          >
            {conversation.last_message_text || "No messages yet"}
          </p>
          <div data-no-translate className="flex shrink-0 items-center gap-1.5">
            {waitingLabel && (
              <span
                title={waitingTitle}
                className="inline-flex items-center gap-0.5 rounded-full bg-red-500/10 px-1.5 py-px text-[10px] font-semibold leading-4 text-red-600 dark:text-red-400"
              >
                <Clock className="h-3 w-3" aria-hidden />
                {waitingLabel}
              </span>
            )}
            {status !== "open" && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-px text-[10px] font-medium leading-4",
                  status === "pending"
                    ? "bg-amber-500/15 text-amber-500"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {rowStatus[status]}
              </span>
            )}
            {isUnread && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold tabular-nums text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
          </div>
        </div>
        {tags.length > 0 && (
          <div data-no-translate className="mt-1 flex items-center gap-1 overflow-hidden">
            {visibleTags.map((tag) => (
              <span
                key={tag.name}
                className="inline-flex max-w-32 items-center gap-1 rounded-full px-1.5 text-[10px] font-medium leading-[14px]"
                style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: tag.color }}
                />
                <span className="truncate">{tag.name}</span>
              </span>
            ))}
            {hiddenTagCount > 0 && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium leading-[14px] text-muted-foreground">
                {moreTags(hiddenTagCount)}
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
