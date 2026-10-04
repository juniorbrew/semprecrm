"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CheckCircle2, Clock, Contrast, Hourglass, MessageSquare, Plus, Search, User, type LucideIcon } from "lucide-react";

import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useAuth, useEntitlements } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { useLanguage } from "@/hooks/use-language";
import { useTheme } from "@/hooks/use-theme";
import { OVERLAY_SELECTOR } from "@/hooks/use-inbox-shortcuts";
import { INBOX_SHORTCUTS, NAV_COPY, NAV_ITEMS, isNavActive, isNavItemVisible } from "@/components/layout/nav-config";
import { foldText, rankItems, readRecents, rememberRecent, stepOption, type RecentEntry } from "@/lib/command-palette";
import { inboxConversationHref } from "@/lib/conversations/find-by-contact";
import { pageArgs, type InboxView } from "@/lib/inbox/list-query";
import { buildSearchPattern, escapeLike, normalizeSearch } from "@/lib/inbox/search";
import { dispatchInboxShortcut, paletteKey } from "@/lib/inbox/shortcuts";
import { createClient } from "@/lib/supabase/client";
import type { Language } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type GroupId = "recent" | "actions" | "nav" | "conversations" | "contacts";

// Typing puts the records first (what a search is usually for).
const GROUP_ORDER: GroupId[] = ["recent", "actions", "nav"];
const SEARCH_GROUP_ORDER: GroupId[] = ["conversations", "contacts", "actions", "nav"];

/** Rows per search group. */
const GROUP_MAX = 6;
/** Shortest (folded) query that hits the database. */
const MIN_SEARCH = 2;
const SEARCH_DEBOUNCE_MS = 200;

export const PALETTE_COPY: Record<
  Language,
  {
    title: string;
    trigger: string;
    triggerAria: string;
    placeholder: string;
    groups: Record<GroupId, string>;
    newTask: string;
    resolve: string;
    snooze: string;
    theme: string;
    inbox: string;
    searching: string;
    failed: string;
    empty: (q: string) => string;
    count: (n: number) => string;
    keys: string;
    cancel: string;
  }
> = {
  "pt-BR": {
    title: "Buscar ou executar",
    trigger: "Buscar ou executar…",
    triggerAria: "Buscar ou executar um comando",
    placeholder: "Buscar conversas, contatos ou páginas…",
    groups: { recent: "Recentes", actions: "Ações", nav: "Ir para", conversations: "Conversas", contacts: "Contatos" },
    newTask: "Nova tarefa",
    resolve: "Resolver conversa atual",
    snooze: "Adiar conversa atual…",
    theme: "Alternar tema claro/escuro",
    inbox: "Caixa de entrada",
    searching: "Buscando…",
    failed: "Não foi possível buscar agora.",
    empty: (q) => `Nada encontrado para “${q}”.`,
    count: (n) => (n === 1 ? "1 resultado" : `${n} resultados`),
    keys: "↑↓ navegar · Enter abrir · Esc fechar",
    cancel: "Cancelar",
  },
  "en-US": {
    title: "Search or run",
    trigger: "Search or run…",
    triggerAria: "Search or run a command",
    placeholder: "Search conversations, contacts or pages…",
    groups: { recent: "Recent", actions: "Actions", nav: "Go to", conversations: "Conversations", contacts: "Contacts" },
    newTask: "New task",
    resolve: "Resolve current conversation",
    snooze: "Snooze current conversation…",
    theme: "Toggle light/dark theme",
    inbox: "Inbox",
    searching: "Searching…",
    failed: "Search is unavailable right now.",
    empty: (q) => `Nothing found for “${q}”.`,
    count: (n) => (n === 1 ? "1 result" : `${n} results`),
    keys: "↑↓ navigate · Enter open · Esc close",
    cancel: "Cancel",
  },
};

interface PaletteOption {
  key: string;
  group: GroupId;
  label: string;
  detail?: string;
  keywords?: string;
  icon: LucideIcon;
  /** Key caps shown at the end of the row. */
  shortcut?: string;
  href?: string;
  /** Remembered in Recentes when picked (pages are remembered on visit). */
  recent?: RecentEntry;
  run?: () => void;
}

// Open conversations of the whole account (Todas, live), the same RPC and
// search pattern as the inbox list: name, phone and company.
const SEARCH_VIEW: InboxView = {
  tab: "all",
  live: "live",
  unread: false,
  radar: null,
  search: "",
  tagIds: [],
  channel: null,
};

interface FoundContact {
  id: string;
  name: string | null;
  phone: string | null;
  company: string | null;
}

interface SearchResults {
  term: string;
  failed: boolean;
  conversations: { id: string; contact: FoundContact | null }[];
  contacts: FoundContact[];
}

/** Conversations + contacts matching `term`, through the user's client (RLS). */
async function searchRecords(
  db: SupabaseClient,
  opts: { accountId: string; prefs: { inbox_sla_minutes: number; cooling_hours: number }; term: string; signal: AbortSignal },
): Promise<Omit<SearchResults, "term">> {
  // Contacts go through a PostgREST `or=` filter: strip its syntax
  // characters (and the `*` wildcard alias) instead of quoting.
  const plain = opts.term.replace(/[,()"\\*]/g, " ").trim();
  const like = `%${escapeLike(plain)}%`;
  const digits = plain.replace(/\D/g, "");
  const contactFilters = [`name.ilike.${like}`, `phone.ilike.${like}`, `company.ilike.${like}`];
  if (digits.length >= 3) contactFilters.push(`phone_normalized.ilike.%${digits}%`);

  const [conv, contacts] = await Promise.all([
    db
      .rpc(
        "inbox_conversation_page",
        pageArgs(SEARCH_VIEW, {
          accountId: opts.accountId,
          prefs: opts.prefs,
          pattern: buildSearchPattern(opts.term),
          limit: GROUP_MAX,
        }),
      )
      .select("id, contact:contacts(id, name, phone, company)")
      .abortSignal(opts.signal),
    plain
      ? db
          .from("contacts")
          .select("id, name, phone, company")
          .eq("account_id", opts.accountId)
          .or(contactFilters.join(","))
          .order("name")
          .limit(GROUP_MAX)
          .abortSignal(opts.signal)
      : Promise.resolve({ data: [], error: null }),
  ]);
  return {
    failed: !!(conv.error || contacts.error),
    conversations: ((conv.data ?? []) as unknown as SearchResults["conversations"]).slice(0, GROUP_MAX),
    contacts: ((contacts.data ?? []) as FoundContact[]).slice(0, GROUP_MAX),
  };
}

const contactLabel = (c: FoundContact | null) => c?.name?.trim() || c?.phone || "—";
const contactDetail = (c: FoundContact | null) => [c?.company, c?.name ? c?.phone : null].filter(Boolean).join(" · ");

/**
 * App-wide command palette (Ctrl/Cmd+K and the header's search field): a
 * dialog with a combobox over grouped options — Recentes (empty query),
 * Ações, Ir para (the sidebar's own gated list) and, while typing,
 * Conversas / Contatos from the database.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, accountId, accountRole, preferences } = useAuth();
  const { ready: entitlementsReady, modules } = useEntitlements();
  const canWrite = useCan("send-messages");
  const { toggleMode } = useTheme();
  const { language } = useLanguage();
  const copy = PALETTE_COPY[language] ?? PALETTE_COPY["pt-BR"];
  const navCopy = NAV_COPY[language] ?? NAV_COPY["pt-BR"];
  const userId = user?.id ?? null;

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [results, setResults] = useState<SearchResults | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();

  const setOpen = useCallback(
    (next: boolean) => {
      if (!next) {
        setQuery("");
        setActiveIndex(0);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  // Ctrl/Cmd+K anywhere in the app (also from a field); never over another dialog.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = paletteKey(e, {
        paletteOpen: openRef.current,
        overlayOpen: !!document.querySelector(OVERLAY_SELECTOR),
      });
      if (!action) return;
      e.preventDefault();
      setOpen(!openRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setOpen]);

  // Recentes: every sidebar destination the user lands on.
  useEffect(() => {
    const item = NAV_ITEMS.filter((i) => isNavActive(pathname, i.href)).sort((a, b) => b.href.length - a.href.length)[0];
    if (item) rememberRecent(userId, { kind: "page", href: item.href, label: item.label });
  }, [pathname, userId]);

  // ---- Database search (debounced, stale requests aborted) ----
  const term = normalizeSearch(query);
  const searchable = open && !!accountId && foldText(term).length >= MIN_SEARCH;
  const slaMinutes = preferences.inbox_sla_minutes;
  const coolingHours = preferences.cooling_hours;
  useEffect(() => {
    if (!searchable || !accountId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchRecords(createClient(), {
        accountId,
        prefs: { inbox_sla_minutes: slaMinutes, cooling_hours: coolingHours },
        term,
        signal: controller.signal,
      })
        .then((found) => {
          if (!controller.signal.aborted) setResults({ term, ...found });
        })
        .catch(() => {
          if (!controller.signal.aborted) setResults({ term, failed: true, conversations: [], contacts: [] });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchable, accountId, term, slaMinutes, coolingHours]);
  const current = searchable && results?.term === term ? results : null;
  const searching = searchable && !current;

  // "Resolver conversa atual": the inbox page marks itself when the open
  // conversation can be resolved by this user (same rules as "e").
  const canResolveCurrent = useMemo(
    () => open && pathname === "/inbox" && typeof document !== "undefined" && !!document.querySelector("[data-inbox-resolvable]"),
    [open, pathname],
  );
  // "Adiar conversa atual…": same mechanism, the header's snooze rule (079).
  const canSnoozeCurrent = useMemo(
    () => open && pathname === "/inbox" && typeof document !== "undefined" && !!document.querySelector("[data-inbox-snoozable]"),
    [open, pathname],
  );
  const recents = useMemo(() => (open ? readRecents(userId) : []), [open, userId]);

  const options = useMemo<PaletteOption[]>(() => {
    const gate = { entitlementsReady, modules, accountRole };
    const actions: PaletteOption[] = [];
    if (canResolveCurrent) {
      actions.push({
        key: "action:resolve",
        group: "actions",
        label: copy.resolve,
        icon: CheckCircle2,
        shortcut: "E",
        run: () => dispatchInboxShortcut("resolve"),
      });
    }
    if (canSnoozeCurrent) {
      actions.push({
        key: "action:snooze",
        group: "actions",
        label: copy.snooze,
        keywords: "adiar snooze soneca depois",
        icon: Hourglass,
        shortcut: "H",
        // After the palette's own close settles, so its focus return does
        // not dismiss the popover it opens.
        run: () => window.setTimeout(() => dispatchInboxShortcut("snooze"), 0),
      });
    }
    const tasksItem = NAV_ITEMS.find((i) => i.href === "/tasks");
    if (canWrite && tasksItem && isNavItemVisible(tasksItem, gate)) {
      actions.push({ key: "action:task", group: "actions", label: copy.newTask, icon: Plus, href: "/tasks?task=new" });
    }
    actions.push({ key: "action:theme", group: "actions", label: copy.theme, keywords: "tema dark light modo escuro claro", icon: Contrast, run: toggleMode });

    const nav: PaletteOption[] = [];
    for (const item of NAV_ITEMS) {
      if (!isNavItemVisible(item, gate)) continue;
      nav.push({ key: `nav:${item.href}`, group: "nav", label: item.label, keywords: item.href, icon: item.icon, href: item.href });
      if (item.href === "/inbox") {
        for (const s of INBOX_SHORTCUTS) {
          nav.push({
            key: `nav:${s.href}`,
            group: "nav",
            label: navCopy.shortcuts[s.id],
            detail: item.label,
            keywords: item.label,
            icon: item.icon,
            href: s.href,
          });
        }
      }
    }

    const ranked = [...rankItems(actions, query), ...rankItems(nav, query)];
    if (!term) {
      const recent: PaletteOption[] = recents.map((r) => ({
        key: `recent:${r.href}`,
        group: "recent",
        label: r.label,
        icon: r.kind === "conversation" ? MessageSquare : r.kind === "contact" ? User : Clock,
        href: r.href,
        recent: r,
      }));
      return [...recent, ...ranked];
    }
    const found: PaletteOption[] = [];
    for (const c of current?.conversations ?? []) {
      const label = contactLabel(c.contact);
      const href = inboxConversationHref(c.id);
      found.push({
        key: `conv:${c.id}`,
        group: "conversations",
        label,
        detail: contactDetail(c.contact),
        icon: MessageSquare,
        href,
        recent: { kind: "conversation", href, label },
      });
    }
    for (const c of current?.contacts ?? []) {
      const label = contactLabel(c);
      const href = `/contacts?contact=${encodeURIComponent(c.id)}`;
      found.push({
        key: `contact:${c.id}`,
        group: "contacts",
        label,
        detail: contactDetail(c),
        icon: User,
        href,
        recent: { kind: "contact", href, label },
      });
    }
    return [...found, ...ranked];
  }, [entitlementsReady, modules, accountRole, canResolveCurrent, canSnoozeCurrent, canWrite, copy, navCopy, toggleMode, query, term, recents, current]);

  const active = options.length ? Math.min(activeIndex, options.length - 1) : -1;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  useEffect(() => {
    if (active < 0) return;
    document.getElementById(`${baseId}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, baseId]);

  const choose = useCallback(
    (option: PaletteOption) => {
      setOpen(false);
      if (option.recent) rememberRecent(userId, option.recent);
      if (option.run) option.run();
      else if (option.href) router.push(option.href);
    },
    [router, setOpen, userId],
  );

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(stepOption(active, e.key === "ArrowDown" ? 1 : -1, options.length));
    } else if (e.key === "Enter") {
      const option = options[active];
      if (option) {
        e.preventDefault();
        choose(option);
      }
    }
  };

  const status = searching
    ? copy.searching
    : current?.failed
      ? copy.failed
      : term && options.length === 0
        ? copy.empty(term)
        : term
          ? copy.count(options.length)
          : "";

  const listboxId = `${baseId}-list`;
  let index = -1;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        initialFocus={inputRef}
        data-command-palette
        className={cn(
          // Phone: a full-width sheet from the top; sm+: a centred panel high on the page.
          "top-0 left-0 w-full max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none rounded-b-xl p-0",
          "sm:top-[12vh] sm:left-1/2 sm:max-w-xl sm:-translate-x-1/2 sm:rounded-xl",
          // Reduced motion: no zoom / fade (stacked variants beat data-open:animate-in).
          "motion-reduce:data-open:animate-none motion-reduce:data-closed:animate-none",
        )}
      >
        <DialogTitle className="sr-only">{copy.title}</DialogTitle>
        {/* Copy comes from PALETTE_COPY; only the sidebar's own labels (Ir para)
            go through the DOM translator, like the sidebar. */}
        <div data-no-translate className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            aria-label={copy.title}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder={copy.placeholder}
            autoComplete="off"
            spellCheck={false}
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <DialogClose className="h-8 shrink-0 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:hidden">
            {copy.cancel}
          </DialogClose>
        </div>

        <div
          id={listboxId}
          role="listbox"
          aria-label={copy.title}
          className="max-h-[70dvh] overflow-y-auto overscroll-contain py-1.5 sm:max-h-[min(60vh,26rem)]"
        >
          {(term ? SEARCH_GROUP_ORDER : GROUP_ORDER).map((group) => {
            const rows = options.filter((o) => o.group === group);
            if (!rows.length) return null;
            const headingId = `${baseId}-${group}`;
            return (
              <div key={group} role="group" aria-labelledby={headingId} className="py-1">
                <div id={headingId} data-no-translate className="px-4 pt-1.5 pb-1 text-[10.5px] font-medium tracking-[0.07em] text-muted-foreground uppercase">
                  {copy.groups[group]}
                </div>
                {rows.map((option) => {
                  index += 1;
                  const i = index;
                  const Icon = option.icon;
                  const selected = i === active;
                  return (
                    <div
                      key={option.key}
                      id={optionId(i)}
                      role="option"
                      aria-selected={selected}
                      data-palette-option={option.key}
                      onMouseMove={() => {
                        if (!selected) setActiveIndex(i);
                      }}
                      // Keep focus in the input (combobox pattern).
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(option)}
                      className={cn(
                        "mx-1.5 flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-sm text-foreground",
                        selected && "bg-primary/10 shadow-[inset_2px_0_0_var(--primary)]",
                      )}
                    >
                      <Icon className={cn("size-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate" data-no-translate={option.group === "nav" ? undefined : true}>
                        {option.label}
                        {option.detail ? <span className="text-muted-foreground"> · {option.detail}</span> : null}
                      </span>
                      {option.shortcut ? (
                        <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-sans text-[11px] font-medium text-foreground">
                          {option.shortcut}
                        </kbd>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div data-no-translate className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <span role="status" aria-live="polite" className="truncate">
            {status}
          </span>
          <span className="hidden shrink-0 sm:inline">{copy.keys}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
