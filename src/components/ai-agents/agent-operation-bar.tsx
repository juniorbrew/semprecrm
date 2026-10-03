"use client";

import { Loader2, Pause, Play, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useLanguage } from "@/hooks/use-language";
import { agentStatus, type AgentMode, type AgentWrite, type AiAgent } from "@/lib/ai/agents";
import { AgentStatusBadge } from "./agent-card";

/** What the agent does right now, in one line. English key. */
export function operationHelp(agent: Pick<AiAgent, "enabled" | "mode" | "paused_at">): string {
  if (!agent.enabled) return "This agent is turned off: it neither suggests nor replies.";
  if (agent.mode === "suggest") return "The agent writes suggestions in the inbox; an agent reviews them and sends.";
  if (agent.paused_at) return "Automatic replies are paused. The agent only suggests until you resume.";
  return "The agent replies to customers on its own, within the rules below.";
}

/** Top bar of /ai/agents/[id]: mode, pause/resume, on/off, delete. Each change saves at once. */
export function AgentOperationBar({
  agent,
  canEdit,
  busy,
  onPatch,
  onDelete,
}: {
  agent: AiAgent;
  canEdit: boolean;
  busy: boolean;
  onPatch: (patch: AgentWrite & { paused?: boolean }) => void;
  onDelete: () => void;
}) {
  const { t } = useLanguage();
  const paused = agent.mode === "auto" && !!agent.paused_at;

  return (
    <div className="space-y-2 border-y border-border py-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <AgentStatusBadge status={agentStatus(agent)} />
        <label className="flex items-center gap-2 text-sm text-foreground">
          <span className="text-muted-foreground">{t("Mode")}</span>
          <select
            value={agent.mode}
            disabled={!canEdit || busy}
            onChange={(e) => onPatch({ mode: e.target.value as AgentMode })}
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground"
          >
            <option value="suggest">{t("Suggestion (the agent reviews)")}</option>
            <option value="auto">{t("Automatic (replies on its own)")}</option>
          </select>
        </label>
        {agent.mode === "auto" ? (
          <Button size="sm" variant="ghost" disabled={!canEdit || busy} onClick={() => onPatch({ paused: !paused })}>
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            {paused ? t("Resume automatic") : t("Pause automatic")}
          </Button>
        ) : null}
        <label className="ml-auto flex items-center gap-2 text-sm text-foreground">
          {t("Turned on")}
          <Switch checked={agent.enabled} disabled={!canEdit || busy} onCheckedChange={(v) => onPatch({ enabled: v })} />
        </label>
        {busy ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={t("Saving…")} /> : null}
        {canEdit ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onDelete}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label={`${t("Delete")}: ${agent.name}`}
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{t(operationHelp(agent))}</p>
    </div>
  );
}
