"use client";

import { useEffect, useState } from "react";

import { useLanguage } from "@/hooks/use-language";
import type { Language } from "@/lib/i18n";
import { activeSlaTarget, slaCopy, slaLabel, slaLevel, type SlaLevel } from "@/lib/support/sla";
import { slaRemainingFraction } from "@/lib/support/sla-progress";
import { PRIORITY_DOT, supportCopy } from "@/lib/support/model";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/types";
import { SectionHeader } from "./panel-section";

const COPY: Record<Language, {
  title: string;
  state: string;
  priority: string;
  owner: string;
  team: string;
  nobody: string;
  you: string;
  status: Record<Conversation["status"], string>;
  left: string;
}> = {
  "pt-BR": {
    title: "Situação",
    state: "Estado",
    priority: "Prioridade",
    owner: "Responsável",
    team: "Equipe",
    nobody: "Sem responsável",
    you: "Você",
    status: { open: "Aberta", pending: "Pendente", closed: "Resolvida" },
    left: "restantes",
  },
  "en-US": {
    title: "Status",
    state: "State",
    priority: "Priority",
    owner: "Owner",
    team: "Team",
    nobody: "Nobody",
    you: "You",
    status: { open: "Open", pending: "Pending", closed: "Resolved" },
    left: "left",
  },
};

const STATUS_DOT: Record<Conversation["status"], string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};

const SLA_BAR: Record<SlaLevel, string> = {
  ok: "bg-primary",
  warning: "bg-amber-500",
  breached: "bg-red-500",
};
const SLA_TEXT: Record<SlaLevel, string> = {
  ok: "text-muted-foreground",
  warning: "text-amber-600 dark:text-amber-400",
  breached: "text-red-600 dark:text-red-400",
};

/** Re-renders every 30 s so the time left stays honest (same cadence as the header). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right text-foreground">{children}</dd>
    </div>
  );
}

/**
 * "Situação" of the open conversation: state, priority, owner, team and
 * the SLA with a progress bar — all read from the conversation row the
 * inbox already holds (no query here).
 */
export function PanelSituation({
  conversation,
  ownerName,
  teamName,
  currentUserId,
}: {
  conversation: Conversation;
  /** Owner's display name, when known. */
  ownerName?: string | null;
  teamName?: string | null;
  currentUserId?: string;
}) {
  const { language } = useLanguage();
  const copy = COPY[language] ?? COPY["pt-BR"];
  const support = supportCopy(language);
  const sla = slaCopy(language);
  const now = useNow();
  const target = activeSlaTarget(conversation);
  const level = target ? slaLevel(target, now) : null;
  const fraction = target ? slaRemainingFraction(target, now) : null;
  const priority = conversation.priority ?? "normal";
  const owner = conversation.assigned_agent_id
    ? conversation.assigned_agent_id === currentUserId
      ? copy.you
      : (ownerName ?? "—")
    : copy.nobody;

  return (
    <div data-testid="panel-situation">
      <SectionHeader label={copy.title} />
      <dl className="mt-1.5 px-1">
        <Row label={copy.state}>
          <span className="inline-flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", STATUS_DOT[conversation.status])} aria-hidden />
            {copy.status[conversation.status]}
          </span>
        </Row>
        <Row label={copy.priority}>
          <span className="inline-flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", PRIORITY_DOT[priority])} aria-hidden />
            {support.priorities[priority]}
          </span>
        </Row>
        <Row label={copy.owner}>{owner}</Row>
        {teamName && <Row label={copy.team}>{teamName}</Row>}
      </dl>
      {target && level && (
        <div className="mt-2 px-1" data-testid="panel-sla" data-level={level}>
          <p className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">
              {target.kind === "first_response" ? sla.headerFirstResponse : sla.headerResolution}
            </span>
            <span className={cn("tabular-nums", SLA_TEXT[level], level !== "ok" && "font-medium")}>
              {slaLabel(target, now, language)}
              {level !== "breached" && ` ${copy.left}`}
            </span>
          </p>
          {fraction !== null && (
            <div
              role="progressbar"
              aria-label={target.kind === "first_response" ? sla.headerFirstResponse : sla.headerResolution}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fraction * 100)}
              className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cn("h-full rounded-full transition-[width] duration-700 motion-reduce:transition-none", SLA_BAR[level])}
                style={{ width: `${Math.round(fraction * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
