"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, WhatsAppChannel } from "@/types";
import type { Language } from "@/lib/i18n";
import { useAuth } from "@/hooks/use-auth";
import {
  companyDisplayName,
  listPrimaryCompanies,
  onContactCompaniesChanged,
} from "@/lib/companies";
import { useLanguage } from "@/hooks/use-language";
import {
  classifyConversation,
  formatWaitingAge,
  isRadarKey,
  matchesRadar,
  RADAR_KEYS,
  type RadarKey,
} from "@/lib/radar/classify";
import {
  buildQueue,
  formatQueuePosition,
  formatQueueWait,
  queueIndex,
  type QueueEntry,
} from "@/lib/radar/queue";
import {
  INBOX_TABS,
  LIVE_FILTERS,
  migrateTriage,
  tabConversations,
  tabForConversation,
  type InboxTab,
  type LiveFilter,
  type TriageState,
} from "@/lib/inbox/triage";
import {
  compareForTab,
  countsArgs,
  cursorFor,
  EMPTY_COUNTS,
  INBOX_PAGE_SIZE,
  INBOX_RESYNC_MAX,
  mergePage,
  pageArgs,
  parseCounts,
  showOwnerBadge,
  viewKey,
  type InboxCounts,
  type InboxListState,
  type InboxRow,
  type InboxView,
} from "@/lib/inbox/list-query";
import { buildSearchPattern, normalizeSearch } from "@/lib/inbox/search";
import { debounceWithMaxWait } from "@/lib/inbox/throttle";
import {
  INBOX_SHORTCUT_EVENT,
  stepIndex,
  type ShortcutAction,
} from "@/lib/inbox/shortcuts";
import { findConversationById } from "@/lib/conversations/find-by-contact";
import {
  Search,
  ChevronDown,
  Check,
  MessageCircle,
  Bot,
  MailOpen,
  Clock,
  UserX,
  Snowflake,
  Building2,
  RefreshCw,
  Keyboard,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ContactAvatar, avatarInitial } from "./contact-avatar";
import { FilterChips, FilterPopover, useInboxFacets } from "./conversation-filters";

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
  /**
   * Bumped by the parent (debounced) on every realtime message / conversation
   * event so the server-side tab badges and Radar chips refresh.
   */
  countsToken?: number;
  /**
   * Reports the active view + paging window so the parent can decide which
   * realtime rows belong in the loaded list (lib/inbox/list-query).
   */
  onListStateChange?: (state: InboxListState) => void;
  /** Opens the shortcut help (the "?" button in the header). */
  onShowShortcuts?: () => void;
}

/**
 * Remembers the agent's tab + live filter across reloads so someone
 * working "Minhas · Abertas" all day lands back there. Device-scoped,
 * like the contact-panel toggle on the page. Older `{ tab, status }`
 * blobs are migrated by `migrateTriage` (lib/inbox/triage).
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
    tabs: Record<InboxTab, string>;
    /** Narrows Minhas / Todas; never shows resolved or archived. */
    live: Record<LiveFilter, string>;
    rowStatus: Record<Exclude<ConversationStatus, "open">, string> & { archived: string };
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
    /** Why the live filter is disabled on Fila / Encerradas / Arquivadas / Radar. */
    liveFilterHint: string;
    queuePositionTitle: string;
    queueEmpty: string;
    queueEmptyHint: string;
    loadMore: string;
    loadError: string;
    retry: string;
    /** Empty state when filters (tags / channel / unread / radar) hide everything. */
    clearFilters: string;
    filteredEmpty: string;
    shortcuts: string;
    ownerTitle: (name: string) => string;
  }
> = {
  "pt-BR": {
    title: "Conversas",
    tabs: {
      queue: "Fila",
      mine: "Minhas",
      all: "Todas",
      closed: "Encerradas",
      archived: "Arquivadas",
    },
    live: { live: "Abertas e pendentes", open: "Abertas", pending: "Pendentes" },
    rowStatus: { pending: "Pendente", closed: "Resolvida", archived: "Arquivada" },
    unreadOnly: "Só não lidas",
    channel: "WhatsApp",
    channelChip: { official: "Oficial", qr: "QR" },
    moreTags: (n) => `+${n}`,
    radar: "Radar",
    radarChips: { waiting: "Aguardando", unassigned: "Sem responsável", cooling: "Esfriando" },
    radarClear: "Limpar filtro do radar",
    waitingTitle: "Cliente aguardando resposta além do SLA",
    liveFilterHint: "O filtro vale só para Minhas e Todas",
    queuePositionTitle: "Posição na fila (maior espera primeiro)",
    queueEmpty: "Ninguém na fila",
    queueEmptyHint: "Conversas abertas sem responsável aparecem aqui, a mais antiga primeiro.",
    loadMore: "Carregar mais",
    loadError: "Não foi possível carregar as conversas.",
    retry: "Tentar de novo",
    clearFilters: "Limpar filtros",
    filteredEmpty: "Nenhuma conversa com esses filtros",
    shortcuts: "Atalhos do teclado (?)",
    ownerTitle: (name) => `Responsável: ${name}`,
  },
  "en-US": {
    title: "Conversations",
    tabs: {
      queue: "Queue",
      mine: "Mine",
      all: "All",
      closed: "Closed",
      archived: "Archived",
    },
    live: { live: "Open and pending", open: "Open", pending: "Pending" },
    rowStatus: { pending: "Pending", closed: "Resolved", archived: "Archived" },
    unreadOnly: "Unread only",
    channel: "WhatsApp",
    channelChip: { official: "Official", qr: "QR" },
    moreTags: (n) => `+${n}`,
    radar: "Radar",
    radarChips: { waiting: "Waiting", unassigned: "Unassigned", cooling: "Cooling" },
    radarClear: "Clear radar filter",
    waitingTitle: "Customer waiting past the SLA",
    liveFilterHint: "This filter only applies to Mine and All",
    queuePositionTitle: "Position in the queue (longest wait first)",
    queueEmpty: "Nobody in the queue",
    queueEmptyHint: "Open conversations with no owner show up here, oldest first.",
    loadMore: "Load more",
    loadError: "Could not load conversations.",
    retry: "Try again",
    clearFilters: "Clear filters",
    filteredEmpty: "No conversations match these filters",
    shortcuts: "Keyboard shortcuts (?)",
    ownerTitle: (name) => `Owner: ${name}`,
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

const LIVE_DOT: Record<LiveFilter, string> = {
  live: "bg-foreground/40",
  open: "bg-primary",
  pending: "bg-amber-500",
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

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  countsToken = 0,
  onListStateChange,
  onShowShortcuts,
}: ConversationListProps) {
  const { user, preferences, accountId } = useAuth();
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
  // The server query follows the box 300 ms after the last keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(normalizeSearch(search)), 300);
    return () => clearTimeout(id);
  }, [search]);
  const [tab, setTab] = useState<InboxTab>("all");
  const [liveFilter, setLiveFilter] = useState<LiveFilter>("live");
  const [unreadOnly, setUnreadOnly] = useState(false);
  // Contact-tag and WhatsApp-channel filters (migration 068), persisted with
  // the tab / live filter.
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [channelFilter, setChannelFilter] = useState<WhatsAppChannel | null>(null);
  const { tags: facetTags, hasBothChannels } = useInboxFacets(accountId);
  // A saved channel filter is meaningless (and invisible) without both channels.
  const channel = hasBothChannels ? channelFilter : null;
  // View key of the last page that finished loading; `loading` is derived.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  // Same, without the search text: a search that is still settling keeps the
  // current rows on screen (dimmed) instead of swapping them for a spinner.
  const [loadedBaseKey, setLoadedBaseKey] = useState<string | null>(null);
  // View whose first page failed to load (shows an error state with retry).
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  // Edge of the loaded window (last row the server returned) + whether more
  // pages exist. The next-page cursor is derived from `boundary`.
  const [paging, setPaging] = useState<{ hasMore: boolean; boundary: InboxRow | null }>({
    hasMore: false,
    boundary: null,
  });
  const [counts, setCounts] = useState<InboxCounts>(EMPTY_COUNTS);
  const [tagsByContact, setTagsByContact] = useState<Map<string, RowTag[]>>(
    () => new Map()
  );
  // Primary company name per contact (migration 054), shown under the
  // contact name. Refetched when the panel links / unlinks a company.
  const [companyByContact, setCompanyByContact] = useState<Map<string, string>>(
    () => new Map()
  );
  const [companiesVersion, setCompaniesVersion] = useState(0);
  useEffect(
    () => onContactCompaniesChanged(() => setCompaniesVersion((v) => v + 1)),
    []
  );

  // The persisted queue view (and the tab a ?c= deep link to a resolved /
  // archived conversation lives in) is restored once, before the first page
  // is fetched — so the list opens on the right tab in one paint, and the
  // server-rendered defaults never disagree with the client (reading
  // localStorage in the initializer would be a hydration mismatch). Later
  // refetches must not yank the agent off the tab they picked.
  const [ready, setReady] = useState(false);
  const deepLinkId = searchParams.get("c");
  const deepLinkIdRef = useRef(deepLinkId);
  useEffect(() => {
    deepLinkIdRef.current = deepLinkId;
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = localStorage.getItem(TRIAGE_STORAGE_KEY);
        if (raw) {
          const stored = migrateTriage(JSON.parse(raw));
          setTab(stored.tab);
          setLiveFilter(stored.live);
          setTagIds(stored.tagIds);
          setChannelFilter(stored.channel);
        }
      } catch {
        // localStorage can throw in private-browsing / sandboxed contexts.
      }
      const linkedId = deepLinkIdRef.current;
      if (linkedId) {
        const linked = await findConversationById(createClient(), linkedId);
        if (cancelled) return;
        const linkedTab = linked ? tabForConversation(linked) : null;
        if (linkedTab) setTab(linkedTab);
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistTriage = useCallback((next: TriageState) => {
    try {
      localStorage.setItem(TRIAGE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Persistence is best-effort.
    }
  }, []);

  const handleTabChange = useCallback(
    (next: InboxTab) => {
      setTab(next);
      persistTriage({ tab: next, live: liveFilter, tagIds, channel: channelFilter });
    },
    [persistTriage, liveFilter, tagIds, channelFilter]
  );

  const handleLiveChange = useCallback(
    (next: LiveFilter) => {
      setLiveFilter(next);
      persistTriage({ tab, live: next, tagIds, channel: channelFilter });
    },
    [persistTriage, tab, tagIds, channelFilter]
  );

  const handleTagsChange = useCallback(
    (next: string[]) => {
      setTagIds(next);
      persistTriage({ tab, live: liveFilter, tagIds: next, channel: channelFilter });
    },
    [persistTriage, tab, liveFilter, channelFilter]
  );

  const handleChannelChange = useCallback(
    (next: WhatsAppChannel | null) => {
      setChannelFilter(next);
      persistTriage({ tab, live: liveFilter, tagIds, channel: next });
    },
    [persistTriage, tab, liveFilter, tagIds]
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

  // Radar buckets replace the live filter (the bucket fixes the status).
  const effectiveLive: LiveFilter = radar ? "live" : liveFilter;
  const view = useMemo<InboxView>(
    () => ({
      tab,
      live: effectiveLive,
      unread: unreadOnly,
      radar,
      search: debouncedSearch,
      tagIds,
      channel,
    }),
    [tab, effectiveLive, unreadOnly, radar, debouncedSearch, tagIds, channel],
  );
  const key = viewKey(view);
  const baseKey = viewKey({ ...view, search: "" });
  const loadFailed = errorKey === key;
  const loading = loadedKey !== key && !loadFailed;
  // Only the search text changed: keep showing the rows we have.
  const softLoading = loading && loadedBaseKey === baseKey;
  const slaMinutes = preferences.inbox_sla_minutes;
  const coolingHours = preferences.cooling_hours;

  const conversationsRef = useRef(conversations);
  const loadedCountRef = useRef(0);
  const loadedKeyRef = useRef<string | null>(null);
  // Bumped whenever a first-page fetch starts: a "Carregar mais" answer that
  // was in flight across it is stale (its cursor predates the refreshed
  // window) and is discarded.
  const generationRef = useRef(0);
  const keyRef = useRef(key);
  useEffect(() => {
    conversationsRef.current = conversations;
    keyRef.current = key;
  });

  // First page of the current view (and background refreshes of it). The
  // server applies the tab / live / unread / Radar / search filters and the
  // order (Fila: longest wait first) — see migration 067. A resync of the
  // same view refetches as many rows as are loaded, so it never collapses
  // pages the agent already scrolled through.
  useEffect(() => {
    if (!ready || !accountId) return;
    const supabase = createClient();
    let cancelled = false;
    const isResync = loadedKeyRef.current === key;
    generationRef.current += 1;
    const limit = isResync
      ? Math.min(Math.max(loadedCountRef.current, INBOX_PAGE_SIZE), INBOX_RESYNC_MAX)
      : INBOX_PAGE_SIZE;

    (async () => {
      setErrorKey(null);
      // One extra row tells whether another page exists.
      const { data, error } = await supabase
        .rpc(
          "inbox_conversation_page",
          pageArgs(view, {
            accountId,
            prefs: { inbox_sla_minutes: slaMinutes, cooling_hours: coolingHours },
            pattern: buildSearchPattern(view.search),
            limit: limit + 1,
          }),
        )
        .select("*, contact:contacts(*)");

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        // A failed background refresh keeps the rows already shown; a view
        // that never loaded shows an error state (with retry), not stale rows.
        if (!isResync) setErrorKey(key);
        return;
      }

      const rows = (data ?? []) as Conversation[];
      const hasMore = rows.length > limit;
      const page = (hasMore ? rows.slice(0, limit) : rows).sort(compareForTab(view.tab));
      loadedCountRef.current = page.length;
      setPaging({ hasMore, boundary: page[page.length - 1] ?? null });
      onConversationsLoadedRef.current(page);
      loadedKeyRef.current = key;
      setLoadedKey(key);
      setLoadedBaseKey(baseKey);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [ready, accountId, key, baseKey, view, resyncToken, retryTick, slaMinutes, coolingHours]);

  const loadMore = useCallback(async () => {
    const boundary = paging.boundary;
    if (loadingMore || !paging.hasMore || !boundary || !accountId) return;
    setLoadingMore(true);
    const startKey = keyRef.current;
    const startGeneration = generationRef.current;
    try {
      const { data, error } = await createClient()
        .rpc(
          "inbox_conversation_page",
          pageArgs(view, {
            accountId,
            prefs: { inbox_sla_minutes: slaMinutes, cooling_hours: coolingHours },
            pattern: buildSearchPattern(view.search),
            cursor: cursorFor(view.tab, boundary),
            limit: INBOX_PAGE_SIZE + 1,
          }),
        )
        .select("*, contact:contacts(*)");
      // The view changed, or a resync refreshed the window, while the page
      // was in flight: drop it.
      if (keyRef.current !== startKey || generationRef.current !== startGeneration) return;
      if (error) {
        console.error("Failed to load more conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        return;
      }
      const rows = (data ?? []) as Conversation[];
      const hasMore = rows.length > INBOX_PAGE_SIZE;
      const page = (hasMore ? rows.slice(0, INBOX_PAGE_SIZE) : rows).sort(
        compareForTab(view.tab),
      );
      loadedCountRef.current += page.length;
      setPaging({ hasMore, boundary: page[page.length - 1] ?? boundary });
      onConversationsLoadedRef.current(mergePage(conversationsRef.current, page));
    } finally {
      setLoadingMore(false);
    }
  }, [paging, loadingMore, accountId, view, slaMinutes, coolingHours]);

  // Tell the parent which view / window is on screen (realtime merge rules).
  useEffect(() => {
    onListStateChange?.({
      view,
      hasMore: paging.hasMore,
      boundary: paging.boundary,
      ready: !loading,
    });
  }, [view, paging, loading, onListStateChange]);

  // Tab badges + Radar chips: counted on the server over the same filters.
  // A filter change / resync refetches at once; realtime events (the parent
  // bumps `countsToken`) are debounced with a 2 s max wait, so a busy inbox
  // still refreshes the badges instead of resetting the timer forever.
  const countsSeqRef = useRef(0);
  const fetchCounts = useCallback(async () => {
    if (!accountId) return;
    const seq = ++countsSeqRef.current;
    const { data, error } = await createClient().rpc(
      "inbox_counts",
      countsArgs(
        { live: effectiveLive, unread: unreadOnly, radar, tagIds, channel },
        { accountId, prefs: { inbox_sla_minutes: slaMinutes, cooling_hours: coolingHours } },
      ),
    );
    if (seq !== countsSeqRef.current) return;
    if (error) {
      console.error("Failed to fetch inbox counts:", error.message);
      return;
    }
    setCounts(parseCounts(Array.isArray(data) ? data[0] : data));
  }, [accountId, effectiveLive, unreadOnly, radar, tagIds, channel, slaMinutes, coolingHours]);
  const fetchCountsRef = useRef(fetchCounts);
  useEffect(() => {
    fetchCountsRef.current = fetchCounts;
  });
  useEffect(() => {
    if (!ready) return;
    void fetchCounts();
  }, [ready, fetchCounts, resyncToken]);
  const countsDebounce = useMemo(
    () => debounceWithMaxWait(() => void fetchCountsRef.current(), 300, 2000),
    [],
  );
  const lastCountsTokenRef = useRef(countsToken);
  useEffect(() => {
    if (lastCountsTokenRef.current === countsToken) return;
    lastCountsTokenRef.current = countsToken;
    countsDebounce.call();
  }, [countsToken, countsDebounce]);
  useEffect(() => () => countsDebounce.cancel(), [countsDebounce]);

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

  useEffect(() => {
    if (!contactIdsKey) return;
    const ids = contactIdsKey.split(",");
    let cancelled = false;
    listPrimaryCompanies(createClient(), ids)
      .then((map) => {
        if (cancelled) return;
        const next = new Map<string, string>();
        for (const [contactId, company] of map) {
          next.set(contactId, companyDisplayName(company));
        }
        setCompanyByContact(next);
      })
      .catch((err) => {
        // A plan / schema without companies just shows no company line.
        console.error("Failed to fetch primary companies:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [contactIdsKey, resyncToken, companiesVersion]);

  // Radar + unread narrow everything; each tab then takes its slice
  // (lib/inbox/triage) and the badges are counted from the same slices.
  // The live filter narrows Minhas / Todas only; the Fila's definition
  // (Radar `unassigned`) already fixes status = open.
  const basePool = useMemo(() => {
    let result = conversations;
    if (radar) {
      // A radar bucket replaces the live filter: the bucket definition
      // already fixes the status (never closed; "unassigned" is open
      // only), and this keeps the list in step with the chip / dashboard
      // counts when someone deep-links from the card.
      result = result.filter((c) => matchesRadar(c, radar, preferences, now));
    }
    if (unreadOnly) {
      result = result.filter((c) => c.unread_count > 0);
    }
    if (channel) {
      // Realtime patches keep rows in the list; the server already filtered.
      result = result.filter((c) => (c.channel ?? "official") === channel);
    }
    return result;
  }, [conversations, unreadOnly, radar, channel, preferences, now]);

  const liveFilterDisabled = !!radar || (tab !== "mine" && tab !== "all");

  // The queue, longest wait first, with 1-based positions.
  const queue = useMemo(
    () => buildQueue(basePool, preferences, now),
    [basePool, preferences, now],
  );
  const queueById = useMemo(() => queueIndex(queue), [queue]);

  // Search: the server answers once the box settles; while the debounce is
  // pending the loaded rows are narrowed locally so typing feels instant.
  // (A settled server search must not be re-filtered here: it also matches
  // company names, which the rows do not carry.)
  const searchPending = normalizeSearch(search) !== debouncedSearch;
  const filtered = useMemo(() => {
    let result: Conversation[] =
      tab === "queue"
        ? queue.map((e) => e.conversation)
        : tabConversations(basePool, tab, { live: effectiveLive, userId }).sort(
            compareForTab(tab),
          );

    if ((searchPending || softLoading) && search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [basePool, queue, tab, effectiveLive, userId, search, searchPending, softLoading]);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  // Keyboard cursor (j / k). It follows the open conversation until the agent
  // moves it; Enter / o opens the highlighted row. Reset by any selection.
  const [cursorOverride, setCursorOverride] = useState<string | null>(null);
  const cursorId =
    cursorOverride && filtered.some((c) => c.id === cursorOverride)
      ? cursorOverride
      : activeConversationId;

  const handleSelect = useCallback(
    (conv: Conversation) => {
      setCursorOverride(null);
      onSelect(conv);
    },
    [onSelect]
  );

  // Shortcuts dispatched by useInboxShortcuts (lib/inbox/shortcuts).
  const shortcutRef = useRef({ filtered, cursorId, hasMore: paging.hasMore, handleSelect, loadMore });
  useEffect(() => {
    shortcutRef.current = { filtered, cursorId, hasMore: paging.hasMore, handleSelect, loadMore };
  });
  useEffect(() => {
    const onShortcut = (e: Event) => {
      const action = (e as CustomEvent<ShortcutAction>).detail;
      const st = shortcutRef.current;
      if (action === "next" || action === "prev") {
        const at = st.filtered.findIndex((c) => c.id === st.cursorId);
        const idx = stepIndex(at, action === "next" ? 1 : -1, st.filtered.length);
        const row = st.filtered[idx];
        if (!row) return;
        setCursorOverride(row.id);
        // Near the end of the loaded window: fetch the next page.
        if (st.hasMore && idx >= st.filtered.length - 3) void st.loadMore();
        requestAnimationFrame(() =>
          document
            .querySelector(`[data-conv-id="${row.id}"]`)
            ?.scrollIntoView({ block: "nearest" }),
        );
      } else if (action === "open") {
        const row = st.filtered.find((c) => c.id === st.cursorId);
        if (row) st.handleSelect(row);
      }
    };
    window.addEventListener(INBOX_SHORTCUT_EVENT, onShortcut);
    return () => window.removeEventListener(INBOX_SHORTCUT_EVENT, onShortcut);
  }, []);

  // Team members, for the owner badge on rows (RLS scopes them to the account).
  const [owners, setOwners] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    createClient()
      .from("profiles")
      .select("user_id, full_name")
      .eq("account_id", accountId)
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        setOwners(
          new Map(
            (data as { user_id: string; full_name: string | null }[]).map((p) => [
              p.user_id,
              p.full_name || "?",
            ]),
          ),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);
  const showOwner = useMemo(() => showOwnerBadge(tab, filtered), [tab, filtered]);

  const anyFilter = unreadOnly || !!radar || tagIds.length > 0 || !!channel;
  const clearFilters = useCallback(() => {
    setUnreadOnly(false);
    if (radar) setRadar(null);
    handleTagsChange([]);
    handleChannelChange(null);
  }, [radar, setRadar, handleTagsChange, handleChannelChange]);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden border-r border-border bg-card lg:w-80">
      {/* Triage strip: title + live filter, search, tabs */}
      <div className="border-b border-border">
        <div
          className="flex items-center justify-between gap-2 px-3 pt-3"
          data-no-translate
        >
          <h2 className="text-sm font-semibold text-foreground">{copy.title}</h2>
          <div className="flex items-center gap-1">
            {/* Live filter — narrows Minhas / Todas to open or pending */}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={copy.live[effectiveLive]}
                disabled={liveFilterDisabled}
                title={liveFilterDisabled ? copy.liveFilterHint : undefined}
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-muted/60 pl-2 pr-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span
                  className={cn("h-1.5 w-1.5 rounded-full", LIVE_DOT[effectiveLive])}
                />
                {copy.live[effectiveLive]}
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44 border-border bg-popover">
                {LIVE_FILTERS.map((value) => (
                  <DropdownMenuItem
                    key={value}
                    onClick={() => handleLiveChange(value)}
                    className={cn(
                      "gap-2 text-sm",
                      liveFilter === value ? "text-primary" : "text-popover-foreground"
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", LIVE_DOT[value])} />
                    <span className="flex-1">{copy.live[value]}</span>
                    {liveFilter === value && <Check className="h-3 w-3" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <FilterPopover
              tags={facetTags}
              hasBothChannels={hasBothChannels}
              tagIds={tagIds}
              channel={channel}
              onTagsChange={handleTagsChange}
              onChannelChange={handleChannelChange}
            />

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

            {onShowShortcuts && (
              <button
                type="button"
                onClick={onShowShortcuts}
                aria-label={copy.shortcuts}
                title={copy.shortcuts}
                data-testid="shortcuts-button"
                className="hidden h-7 w-7 items-center justify-center rounded-full border border-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:inline-flex"
              >
                <Keyboard className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="px-3 pt-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={handleSearchChange}
              data-inbox-search
              placeholder="Search conversations..."
              className="h-8 border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
            />
          </div>
        </div>

        <FilterChips
          tags={facetTags}
          tagIds={tagIds}
          channel={channel}
          onTagsChange={handleTagsChange}
          onChannelChange={handleChannelChange}
        />

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
            const count = counts.radar[key];
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
          {INBOX_TABS.map((value) => {
            const active = tab === value;
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => handleTabChange(value)}
                className={cn(
                  "-mb-px flex shrink-0 grow items-center justify-center gap-1 border-b-2 px-1.5 py-2 text-xs font-medium whitespace-nowrap transition-colors",
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
                  {counts.tabs[value]}
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
        {loadFailed ? (
          <div className="px-4 py-12 text-center" data-no-translate role="alert">
            <p className="text-sm text-muted-foreground">{copy.loadError}</p>
            <button
              type="button"
              onClick={() => setRetryTick((n) => n + 1)}
              className="mt-3 inline-flex h-8 items-center gap-2 rounded-full border border-border bg-muted/60 px-4 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <RefreshCw className="h-3 w-3" aria-hidden />
              {copy.retry}
            </button>
          </div>
        ) : loading && !(softLoading && filtered.length > 0) ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          tab === "queue" && !search.trim() ? (
            <div className="px-4 py-12 text-center" data-no-translate>
              <p className="text-sm text-muted-foreground">{copy.queueEmpty}</p>
              <p className="mt-1 text-xs text-muted-foreground/80">{copy.queueEmptyHint}</p>
            </div>
          ) : anyFilter ? (
            <div className="px-4 py-12 text-center" data-no-translate>
              <p className="text-sm text-muted-foreground">{copy.filteredEmpty}</p>
              <button
                type="button"
                onClick={clearFilters}
                data-testid="clear-filters"
                className="mt-3 inline-flex h-8 items-center gap-2 rounded-full border border-border bg-muted/60 px-4 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                {copy.clearFilters}
              </button>
            </div>
          ) : (
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground">No conversations found</p>
              <p className="mt-1 text-xs text-muted-foreground/80">
                Try another tab or filter.
              </p>
            </div>
          )
        ) : (
          <div
            className={cn("flex flex-col transition-opacity", softLoading && "opacity-50")}
            aria-busy={softLoading}
          >
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                isCursor={conv.id === cursorId && conv.id !== activeConversationId}
                ownerName={
                  showOwner && conv.assigned_agent_id
                    ? (owners.get(conv.assigned_agent_id) ?? null)
                    : null
                }
                ownerTitle={copy.ownerTitle}
                onSelect={handleSelect}
                age={formatAge(conv.last_message_at, language, now)}
                tags={tagsByContact.get(conv.contact_id) ?? EMPTY_TAGS}
                companyName={companyByContact.get(conv.contact_id) ?? null}
                rowStatus={copy.rowStatus}
                channelLabel={copy.channel}
                channelChip={copy.channelChip}
                moreTags={copy.moreTags}
                waitingLabel={waitingLabelFor(conv, preferences, now, language)}
                waitingTitle={copy.waitingTitle}
                queue={
                  tab === "queue"
                    ? queueBadgeFor(
                        queueById.get(conv.id),
                        preferences,
                        now,
                        language,
                        copy.queuePositionTitle,
                        // A search narrows the loaded rows, so their rank
                        // among the results is not their place in the Fila.
                        !debouncedSearch,
                      )
                    : null
                }
              />
            ))}
            {paging.hasMore && (
              <div className="flex justify-center px-3 py-3" data-no-translate>
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="inline-flex h-8 items-center gap-2 rounded-full border border-border bg-muted/60 px-4 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-60"
                >
                  {loadingMore && (
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  )}
                  {copy.loadMore}
                </button>
              </div>
            )}
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

interface QueueBadge {
  position: string;
  positionTitle: string;
  /** "Aguardando há 2 dias" — null when we spoke last. */
  wait: string | null;
  /** Past the account's SLA (`inbox_sla_minutes`) — red instead of amber. */
  overdue: boolean;
}

function queueBadgeFor(
  entry: QueueEntry | undefined,
  preferences: { inbox_sla_minutes: number },
  now: number,
  language: Language,
  positionTitle: string,
  showPosition = true,
): QueueBadge | null {
  if (!entry) return null;
  const since = entry.waitingSince;
  return {
    position: showPosition ? formatQueuePosition(entry.position, language) : "",
    positionTitle,
    wait: since ? formatQueueWait(since, now, language) : null,
    overdue:
      !!since && now - since.getTime() > Math.max(0, preferences.inbox_sla_minutes) * 60_000,
  };
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  /** Keyboard cursor (j / k) is here. */
  isCursor: boolean;
  /** Assigned agent's name when the owner badge is shown for this row. */
  ownerName: string | null;
  ownerTitle: (name: string) => string;
  onSelect: (conversation: Conversation) => void;
  age: string;
  tags: RowTag[];
  /** Primary company (nome fantasia, else razão social), if any. */
  companyName: string | null;
  rowStatus: Record<Exclude<ConversationStatus, "open">, string> & { archived: string };
  channelLabel: string;
  channelChip: Record<WhatsAppChannel, string>;
  moreTags: (n: number) => string;
  /** Set when the customer is waiting past the SLA ("há 12 min"). */
  waitingLabel: string | null;
  waitingTitle: string;
  /** Fila tab only: position + wait. */
  queue: QueueBadge | null;
}

function ConversationItem({
  conversation,
  isActive,
  isCursor,
  ownerName,
  ownerTitle,
  onSelect,
  age,
  tags,
  companyName,
  rowStatus,
  channelLabel,
  channelChip,
  moreTags,
  waitingLabel,
  waitingTitle,
  queue,
}: ConversationItemProps) {
  const channel: WhatsAppChannel = conversation.channel === "qr" ? "qr" : "official";
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || "Unknown contact";
  const isUnread = conversation.unread_count > 0;
  const status = conversation.status;
  const { language } = useLanguage();
  // "IA" badge: the AI has answered here and is not paused (migration 066).
  const pausedUntil = conversation.ai_paused_until;
  // Mount-time clock: a timed pause that expires while the row is shown
  // only shows the badge again on the next render cycle — good enough.
  const [mountedAt] = useState(Date.now);
  const aiHandling =
    !!conversation.ai_last_reply_at &&
    status !== "closed" &&
    !(pausedUntil === "infinity" || (pausedUntil && Date.parse(pausedUntil) > mountedAt));

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const visibleTags = tags.slice(0, MAX_ROW_TAGS);
  const hiddenTagCount = tags.length - visibleTags.length;

  return (
    <button
      onClick={handleClick}
      aria-current={isActive ? "true" : undefined}
      data-conv-id={conversation.id}
      className={cn(
        "flex w-full min-w-0 items-start gap-2.5 border-b border-border/60 px-3 py-2 text-left transition-colors hover:bg-muted/50",
        isActive && "bg-muted/70 shadow-[inset_2px_0_0_var(--color-primary)]",
        isCursor && "bg-muted/50 ring-1 ring-inset ring-primary/40"
      )}
    >
      {/* Avatar + channel badge */}
      <div className="relative shrink-0">
        <ContactAvatar
          src={contact?.avatar_url}
          name={displayName}
          className="h-9 w-9 text-sm"
        />
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
          {aiHandling && (
            <span
              data-no-translate
              data-testid="ai-handling-badge"
              title={language === "pt-BR" ? "A IA está respondendo esta conversa" : "The AI is answering this conversation"}
              className="inline-flex shrink-0 items-center gap-0.5 rounded bg-violet-500/15 px-1 text-[9px] font-semibold uppercase leading-[14px] tracking-wide text-violet-600 dark:text-violet-400"
            >
              <Bot className="h-2.5 w-2.5" aria-hidden />
              {language === "pt-BR" ? "IA" : "AI"}
            </span>
          )}
          <span className="flex-1" />
          {ownerName && (
            <span
              data-no-translate
              data-testid="owner-badge"
              title={ownerTitle(ownerName)}
              aria-label={ownerTitle(ownerName)}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-semibold leading-none text-primary"
            >
              {avatarInitial(ownerName)}
            </span>
          )}
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
        {companyName && (
          <p
            data-no-translate
            title={companyName}
            className="flex min-w-0 items-center gap-1 text-[11px] leading-4 text-muted-foreground"
          >
            <Building2 className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{companyName}</span>
          </p>
        )}
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
            {waitingLabel && !queue && (
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
                {conversation.archived_at ? rowStatus.archived : rowStatus[status]}
              </span>
            )}
            {isUnread && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold tabular-nums text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
          </div>
        </div>
        {queue && (
          <div data-no-translate className="mt-1 flex min-w-0 items-center gap-1.5">
            {queue.position && (
              <span
                title={queue.positionTitle}
                aria-label={queue.positionTitle}
                className="inline-flex h-4 min-w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 px-1.5 text-[10px] font-bold tabular-nums leading-none text-primary"
              >
                {queue.position}
              </span>
            )}
            {queue.wait && (
              <span
                title={queue.overdue ? waitingTitle : undefined}
                className={cn(
                  "inline-flex min-w-0 items-center gap-0.5 truncate text-[11px] font-medium leading-4",
                  queue.overdue
                    ? "text-red-600 dark:text-red-400"
                    : "text-amber-600 dark:text-amber-400",
                )}
              >
                <Clock className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{queue.wait}</span>
              </span>
            )}
          </div>
        )}
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
