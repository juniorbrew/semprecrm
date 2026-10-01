"use client";

import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";
import type {
  ContactHistorySummary,
  PreviousConversationRow,
} from "@/lib/conversations/contact-history";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/types";
import { SectionHeader } from "./panel-section";

const COPY: Record<Language, {
  previous: string;
  noPrevious: string;
  history: string;
  conversations: string;
  csatAverage: string;
  since: string;
  status: Record<Conversation["status"], string>;
  rating: (n: number) => string;
  open: (title: string) => string;
}> = {
  "pt-BR": {
    previous: "Conversas anteriores",
    noPrevious: "Primeira conversa com este contato",
    history: "Histórico",
    conversations: "Conversas",
    csatAverage: "Satisfação média",
    since: "Cliente desde",
    status: { open: "Aberta", pending: "Pendente", closed: "Resolvida" },
    rating: (n) => `nota ${n}`,
    open: (title) => `Abrir conversa: ${title}`,
  },
  "en-US": {
    previous: "Previous conversations",
    noPrevious: "First conversation with this contact",
    history: "History",
    conversations: "Conversations",
    csatAverage: "Average satisfaction",
    since: "Customer since",
    status: { open: "Open", pending: "Pending", closed: "Resolved" },
    rating: (n) => `rated ${n}`,
    open: (title) => `Open conversation: ${title}`,
  },
};

const STATUS_DOT: Record<Conversation["status"], string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};

function dayMonth(iso: string, language: Language): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(language, { day: "2-digit", month: "2-digit" });
}

/** The contact's other conversations (newest first, capped by the caller). */
export function PanelPreviousConversations({
  rows,
  loaded,
  onOpen,
}: {
  rows: PreviousConversationRow[];
  loaded: boolean;
  onOpen?: (conversation: Conversation) => void;
}) {
  const { language } = useLanguage();
  const copy = COPY[language] ?? COPY["pt-BR"];
  return (
    <div data-testid="panel-previous">
      <SectionHeader label={copy.previous} />
      <div className="mt-1.5 px-1">
        {!loaded ? (
          <div className="h-8 animate-pulse rounded-md bg-muted/60" />
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{copy.noPrevious}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => {
              const title = row.title ?? "—";
              const meta = [
                dayMonth(row.at, language),
                copy.status[row.status],
                row.csat !== null ? copy.rating(row.csat) : null,
              ].filter(Boolean);
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => onOpen?.(row.conversation)}
                    disabled={!onOpen}
                    aria-label={copy.open(title)}
                    className="-mx-1 block w-[calc(100%+0.5rem)] rounded-md px-1 py-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span className="block truncate text-xs font-medium text-foreground">{title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[row.status])} aria-hidden />
                      <span className="truncate tabular-nums">{meta.join(" · ")}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Totals over the contact's conversations and survey answers. */
export function PanelHistory({ summary, loaded }: { summary: ContactHistorySummary; loaded: boolean }) {
  const { language } = useLanguage();
  const copy = COPY[language] ?? COPY["pt-BR"];
  const since = summary.since
    ? new Date(summary.since).toLocaleDateString(language, { month: "short", year: "numeric" })
    : "—";
  const avg =
    summary.csatAverage === null
      ? "—"
      : summary.csatAverage.toLocaleString(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return (
    <div data-testid="panel-history">
      <SectionHeader label={copy.history} />
      {!loaded ? (
        <div className="mx-1 mt-1.5 h-8 animate-pulse rounded-md bg-muted/60" />
      ) : (
        <dl className="mt-1.5 px-1 text-xs">
          {(
            [
              [copy.conversations, String(summary.count)],
              [copy.csatAverage, avg],
              [copy.since, since],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3 py-1">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="tabular-nums text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
