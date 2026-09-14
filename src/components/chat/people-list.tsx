"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { useLanguage } from "@/hooks/use-language";
import { filterPeopleRows, memberDisplayName, type ChatPersonRow } from "@/lib/chat";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";

import { lastSeenLabel } from "./last-seen";

interface PeopleListProps {
  rows: ChatPersonRow[];
  loading: boolean;
  selectedUserId: string | null;
  isOnline: (userId: string) => boolean;
  /** Epoch ms, ticked by the parent so relative labels stay honest. */
  now: number;
  onSelect: (userId: string) => void;
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

/**
 * Left column of /chat: search + every member of the account (minus
 * me) with presence dot, last message preview, time and unread badge.
 * Rows come sorted from `buildPeopleRows`.
 */
export function PeopleList({
  rows,
  loading,
  selectedUserId,
  isOnline,
  now,
  onSelect,
}: PeopleListProps) {
  const { t, language } = useLanguage();
  const [query, setQuery] = useState("");
  const visible = useMemo(() => filterPeopleRows(rows, query), [rows, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search people")}
            aria-label={t("Search people")}
            className="h-9 pl-8"
          />
        </div>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto" aria-label={t("People")}>
        {loading ? (
          [1, 2, 3].map((i) => (
            <li key={i} className="flex items-center gap-3 px-3 py-3">
              <div className="size-10 animate-pulse rounded-full bg-muted" />
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
          visible.map((row) => {
            const name = memberDisplayName(row.member);
            const online = isOnline(row.member.user_id);
            const selected = row.member.user_id === selectedUserId;
            const status = online ? t("Online") : lastSeenLabel(row.member.last_seen_at, now, language, t);
            return (
              <li key={row.member.user_id}>
                <button
                  type="button"
                  onClick={() => onSelect(row.member.user_id)}
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-3 text-left transition-colors",
                    selected ? "bg-primary/10" : "hover:bg-muted/60",
                  )}
                >
                  <span className="relative shrink-0">
                    <Avatar className="size-10">
                      {row.member.avatar_url ? <AvatarImage src={row.member.avatar_url} alt={name} /> : null}
                      <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                        {name.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span
                      aria-label={online ? t("Online") : t("Offline")}
                      title={status}
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-card",
                        online ? "bg-emerald-500" : "bg-muted-foreground/50",
                      )}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span
                        className={cn(
                          "truncate text-sm text-foreground",
                          row.unread > 0 ? "font-semibold" : "font-medium",
                        )}
                      >
                        {name}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {rowTime(row.lastMessageAt, now, language)}
                      </span>
                    </span>
                    <span className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          "truncate text-xs",
                          row.unread > 0 ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {row.preview ?? status}
                      </span>
                      {row.unread > 0 ? (
                        <span
                          aria-label={`${row.unread} ${row.unread === 1 ? t("unread message") : t("unread messages")}`}
                          className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-primary-foreground"
                        >
                          {row.unread > 99 ? "99+" : row.unread}
                        </span>
                      ) : null}
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
