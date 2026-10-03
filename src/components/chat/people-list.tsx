"use client";

import { useMemo, useState } from "react";
import { Search, Users, UsersRound } from "lucide-react";

import { cn } from "@/lib/utils";
import { useLanguage } from "@/hooks/use-language";
import { filterChatRows, memberDisplayName, type ChatListRow } from "@/lib/chat";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";

import { lastSeenLabel } from "./last-seen";

/** Selected row: soft brand tint + 3 px accent, as in the inbox list. */
const ROW =
  "flex w-full items-center gap-3 px-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none";
const ROW_SELECTED = "bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]";

interface PeopleListProps {
  rows: ChatListRow[];
  loading: boolean;
  /** `p:<user id>` or `g:<thread id>` (see buildChatRows). */
  selectedKey: string | null;
  isOnline: (userId: string) => boolean;
  /** Epoch ms, ticked by the parent so relative labels stay honest. */
  now: number;
  onSelect: (row: ChatListRow) => void;
  onNewGroup: () => void;
  /** Compact rows: smaller avatar, tighter padding. */
  compact?: boolean;
}

/** Short clock / date for the row's right edge. */
function rowTime(iso: string | null, now: number, language: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(d);
  const days = (now - d.getTime()) / 86_400_000;
  if (days < 7) return new Intl.DateTimeFormat(language, { weekday: "short" }).format(d);
  return new Intl.DateTimeFormat(language, { day: "2-digit", month: "2-digit" }).format(d);
}

function UnreadBadge({ n, t }: { n: number; t: (s: string) => string }) {
  if (n <= 0) return null;
  return (
    <span
      aria-label={`${n} ${n === 1 ? t("unread message") : t("unread messages")}`}
      className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 py-px text-[11px] font-bold tabular-nums text-primary-foreground"
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

/**
 * Left column of /chat: search, "New group", and every member of the
 * account (minus me) plus my groups — presence dot or group icon, last
 * message preview, time and unread badge. Rows come sorted from
 * `buildChatRows`.
 */
export function PeopleList({ rows, loading, selectedKey, isOnline, now, onSelect, onNewGroup, compact }: PeopleListProps) {
  const { t, language } = useLanguage();
  const [query, setQuery] = useState("");
  const visible = useMemo(() => filterChatRows(rows, query), [rows, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border p-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search people and groups")}
            aria-label={t("Search people and groups")}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={onNewGroup}
          aria-label={t("New group")}
          title={t("New group")}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <UsersRound className="size-4" />
        </button>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto" aria-label={t("People")}>
        {loading ? (
          [1, 2, 3].map((i) => (
            <li key={i} className="flex items-center gap-3 px-3 py-3">
              <div className="size-10 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
              </div>
            </li>
          ))
        ) : visible.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-muted-foreground">
            {rows.length === 0 ? t("No other members in your account yet.") : t("No one matches your search.")}
          </li>
        ) : (
          visible.map((item) => {
            const selected = item.key === selectedKey;
            if (item.kind === "group") {
              const { row } = item;
              const count = `${row.memberCount} ${row.memberCount === 1 ? t("member") : t("members")}`;
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    onClick={() => onSelect(item)}
                    aria-current={selected ? "true" : undefined}
                    className={cn(ROW, compact ? "py-2" : "py-2.5", selected ? ROW_SELECTED : "hover:bg-muted/60")}
                  >
                    <span
                      className={cn(
                        "flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
                        compact ? "size-8" : "size-10",
                      )}
                    >
                      <Users className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className={cn("truncate text-sm text-foreground", row.unread > 0 ? "font-semibold" : "font-medium")}>
                          {row.title}
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {rowTime(row.lastMessageAt, now, language)}
                        </span>
                      </span>
                      <span className="flex items-center justify-between gap-2">
                        <span className={cn("truncate text-xs", row.unread > 0 ? "text-foreground" : "text-muted-foreground")}>
                          {row.preview ?? count}
                        </span>
                        <UnreadBadge n={row.unread} t={t} />
                      </span>
                    </span>
                  </button>
                </li>
              );
            }
            const { row } = item;
            const name = memberDisplayName(row.member);
            const online = isOnline(row.member.user_id);
            const status = online ? t("Online") : lastSeenLabel(row.member.last_seen_at, now, language, t);
            return (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => onSelect(item)}
                  aria-current={selected ? "true" : undefined}
                  className={cn(ROW, compact ? "py-2" : "py-2.5", selected ? ROW_SELECTED : "hover:bg-muted/60")}
                >
                  <span className="relative shrink-0">
                    <Avatar className={compact ? "size-8" : "size-10"}>
                      {row.member.avatar_url ? <AvatarImage src={row.member.avatar_url} alt={name} /> : null}
                      <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                        {name.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span
                      aria-label={online ? t("Online") : t("Offline")}
                      title={status}
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card",
                        online ? "bg-emerald-500" : "bg-muted-foreground/50",
                      )}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={cn("truncate text-sm text-foreground", row.unread > 0 ? "font-semibold" : "font-medium")}>
                        {name}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {rowTime(row.lastMessageAt, now, language)}
                      </span>
                    </span>
                    <span className="flex items-center justify-between gap-2">
                      <span className={cn("truncate text-xs", row.unread > 0 ? "text-foreground" : "text-muted-foreground")}>
                        {row.preview ?? status}
                      </span>
                      <UnreadBadge n={row.unread} t={t} />
                    </span>
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
