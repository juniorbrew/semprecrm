"use client";

import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { useLanguage } from "@/hooks/use-language";
import { agentStatus, type AgentChannel, type AgentMode, type AgentStatus, type AiAgent } from "@/lib/ai/agents";
import { cn } from "@/lib/utils";

export interface TagOption {
  id: string;
  name: string;
  color: string;
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  active: "Active",
  paused: "Paused",
  disabled: "Disabled",
};

export const MODE_LABEL: Record<AgentMode, string> = {
  suggest: "Suggestion",
  auto: "Automatic",
};

export const CHANNEL_LABEL: Record<AgentChannel, string> = {
  official: "Official WhatsApp",
  qr: "WhatsApp QR",
};

/** Status as a dot + plain text, not a pill. */
export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  const { t } = useLanguage();
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          status === "active" ? "bg-emerald-500" : status === "paused" ? "bg-amber-500" : "bg-muted-foreground/50",
        )}
      />
      {t(STATUS_LABEL[status])}
    </span>
  );
}

export function AgentModeBadge({ mode }: { mode: AgentMode }) {
  const { t } = useLanguage();
  return <span>{t(MODE_LABEL[mode])}</span>;
}

/** One agent: a row of the /ai/agents list (name, quiet meta line, status, edit). */
export function AgentCard({
  agent,
  accountModel,
  tags,
}: {
  agent: AiAgent;
  accountModel: string | null;
  tags: TagOption[];
}) {
  const { t } = useLanguage();
  const model = agent.model ?? accountModel;
  const tagNames = agent.tag_ids.map((id) => tags.find((x) => x.id === id)?.name).filter(Boolean) as string[];

  const meta = [
    model ? (
      <span key="model" className="font-mono" data-no-translate>
        {model}
      </span>
    ) : null,
    agent.is_default ? t("Default") : null,
    t(MODE_LABEL[agent.mode]),
    ...agent.channels.map((c) => t(CHANNEL_LABEL[c])),
    ...tagNames.map((name) => (
      <span key={"tag-" + name} data-no-translate>
        #{name}
      </span>
    )),
  ].filter(Boolean);

  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:gap-6">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-medium text-foreground" data-no-translate>
          <Link href={`/ai/agents/${agent.id}`} className="underline-offset-2 hover:underline focus-visible:underline">
            {agent.name}
          </Link>
        </h2>
        <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground" data-no-translate={agent.description ? true : undefined}>
          {agent.description || t("No description.")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {meta.map((part, i) => (
            <span key={i}>
              {i > 0 ? " · " : null}
              {part}
            </span>
          ))}
        </p>
      </div>
      <div className="flex items-center justify-between gap-4 sm:justify-end">
        <AgentStatusBadge status={agentStatus(agent)} />
        <Link
          href={`/ai/agents/${agent.id}`}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          aria-label={`${t("Edit")}: ${agent.name}`}
        >
          {t("Edit")}
        </Link>
      </div>
    </li>
  );
}
