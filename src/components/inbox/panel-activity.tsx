"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Bot,
  Building2,
  CalendarDays,
  CheckCircle2,
  CheckSquare,
  DollarSign,
  Megaphone,
  MessageCircle,
  StickyNote,
  Tag as TagIcon,
  Trophy,
  XCircle,
  Loader2,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";
import { formatEventAge } from "@/lib/conversations/events";
import {
  describeActivity,
  fetchContactActivity,
  hasMorePages,
  type ActivityIcon,
  type ContactActivityRow,
} from "@/lib/inbox/contact-activity";
import { SectionHeader } from "./panel-section";

const ICONS: Record<ActivityIcon, typeof Activity> = {
  conversation: MessageCircle,
  deal: DollarSign,
  won: Trophy,
  lost: XCircle,
  task: CheckSquare,
  done: CheckCircle2,
  appointment: CalendarDays,
  note: StickyNote,
  company: Building2,
  tag: TagIcon,
  campaign: Megaphone,
  ai: Bot,
};

const COPY: Record<Language, { title: string; empty: string; more: string; failed: string; loading: string }> = {
  "pt-BR": {
    title: "Atividade",
    empty: "Nenhuma atividade ainda",
    more: "Ver mais",
    failed: "Não foi possível carregar a atividade",
    loading: "Carregando atividade",
  },
  "en-US": {
    title: "Activity",
    empty: "No activity yet",
    more: "Show more",
    failed: "Could not load the activity",
    loading: "Loading activity",
  },
};

interface Feed {
  contactId: string;
  rows: ContactActivityRow[];
  hasMore: boolean;
  error: boolean;
}

/** Compact chronological feed of everything that happened with the contact. */
export function PanelActivity({
  contactId,
  refreshKey = 0,
}: {
  contactId: string;
  /** Bump to refetch the first page (after a stage move, tag change…). */
  refreshKey?: number;
}) {
  const { language } = useLanguage();
  const copy = COPY[language] ?? COPY["pt-BR"];
  const [feed, setFeed] = useState<Feed | null>(null);
  const [paging, setPaging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchContactActivity(createClient(), contactId)
      .then((rows) => {
        if (!cancelled) setFeed({ contactId, rows, hasMore: hasMorePages(rows), error: false });
      })
      .catch((err) => {
        console.error("Failed to load contact activity:", err);
        if (!cancelled) setFeed({ contactId, rows: [], hasMore: false, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [contactId, refreshKey]);

  const current = feed?.contactId === contactId ? feed : null;

  const loadMore = useCallback(async () => {
    if (!current || paging) return;
    setPaging(true);
    try {
      const last = current.rows[current.rows.length - 1];
      const rows = await fetchContactActivity(createClient(), contactId, {
        before: last?.at ?? null,
        beforeId: last?.cursor ?? null,
      });
      setFeed({
        contactId,
        rows: [...current.rows, ...rows],
        hasMore: hasMorePages(rows),
        error: false,
      });
    } catch (err) {
      console.error("Failed to load more activity:", err);
    } finally {
      setPaging(false);
    }
  }, [current, paging, contactId]);

  const now = Date.now();

  return (
    <div>
      <SectionHeader label={copy.title} />
      <div className="mt-2 px-1">
        {!current ? (
          <div role="status" aria-label={copy.loading} className="space-y-1.5">
            <div className="h-6 animate-pulse rounded-md bg-muted/60" />
            <div className="h-6 animate-pulse rounded-md bg-muted/60" />
          </div>
        ) : current.error ? (
          <p className="text-xs text-muted-foreground">{copy.failed}</p>
        ) : current.rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{copy.empty}</p>
        ) : (
          <>
            <ol className="space-y-0.5">
              {current.rows.map((row) => {
                const view = describeActivity(row, language);
                if (!view) return null;
                const Icon = ICONS[view.icon];
                const body = (
                  <>
                    <Icon className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 break-words text-xs leading-4 text-foreground">{view.text}</span>
                    <time
                      dateTime={row.at}
                      title={new Date(row.at).toLocaleString(language)}
                      className="shrink-0 text-[10px] tabular-nums text-muted-foreground"
                    >
                      {formatEventAge(row.at, language, now)}
                    </time>
                  </>
                );
                const cls = "flex items-start gap-2 rounded-md px-1 py-1";
                return (
                  <li key={row.id}>
                    {view.href ? (
                      <Link href={view.href} className={`${cls} transition-colors hover:bg-muted`}>
                        {body}
                      </Link>
                    ) : (
                      <div className={cls}>{body}</div>
                    )}
                  </li>
                );
              })}
            </ol>
            {current.hasMore && (
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={paging}
                className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-primary underline-offset-2 hover:underline disabled:opacity-60"
              >
                {paging && <Loader2 className="h-3 w-3 animate-spin" />}
                {copy.more}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
