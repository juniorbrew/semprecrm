"use client";

import Link from "next/link";
import { Bot, Pencil } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { SettingsChip } from "@/components/settings/settings-chip";
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

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  const { t } = useLanguage();
  return (
    <SettingsChip variant={status === "active" ? "ok" : status === "paused" ? "warn" : "muted"}>
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          status === "active" ? "bg-emerald-500" : status === "paused" ? "bg-amber-500" : "bg-muted-foreground",
        )}
      />
      {t(STATUS_LABEL[status])}
    </SettingsChip>
  );
}

export function AgentModeBadge({ mode }: { mode: AgentMode }) {
  const { t } = useLanguage();
  return <SettingsChip variant={mode === "auto" ? "admin" : "muted"}>{t(MODE_LABEL[mode])}</SettingsChip>;
}

/** One agent in the /ai/agents grid. */
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

  return (
    <article className="flex flex-col rounded-xl border border-border bg-card p-4 shadow-xs transition-colors hover:border-primary/40">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
          <Bot className="size-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground" data-no-translate>
            <Link href={`/ai/agents/${agent.id}`} className="hover:text-primary hover:underline underline-offset-2">
              {agent.name}
            </Link>
          </h2>
          <p className="truncate font-mono text-[11px] text-muted-foreground" data-no-translate>
            {model ?? "—"}
          </p>
        </div>
        <AgentStatusBadge status={agentStatus(agent)} />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {agent.is_default ? <SettingsChip variant="admin">{t("Default")}</SettingsChip> : null}
        <AgentModeBadge mode={agent.mode} />
      </div>

      <p className="mt-3 line-clamp-2 min-h-10 text-sm text-muted-foreground" data-no-translate={agent.description ? true : undefined}>
        {agent.description || t("No description.")}
      </p>

      {agent.channels.length > 0 || tagNames.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {agent.channels.map((c) => (
            <SettingsChip key={c} variant="muted">
              {t(CHANNEL_LABEL[c])}
            </SettingsChip>
          ))}
          {tagNames.map((name) => (
            <SettingsChip key={name} variant="muted">
              <span data-no-translate>#{name}</span>
            </SettingsChip>
          ))}
        </div>
      ) : null}

      <div className="mt-auto flex justify-end pt-4">
        <Link
          href={`/ai/agents/${agent.id}`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
          aria-label={`${t("Edit")}: ${agent.name}`}
        >
          <Pencil className="size-3.5" />
          {t("Edit")}
        </Link>
      </div>
    </article>
  );
}
