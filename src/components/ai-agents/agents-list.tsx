"use client";

import { useMemo, useState } from "react";
import { Bot, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/hooks/use-language";
import { agentStatus, type AgentStatus, type AiAgent } from "@/lib/ai/agents";
import { AgentCard, STATUS_LABEL, type TagOption } from "./agent-card";

type StatusFilter = AgentStatus | "all";

/** Search + status filter + card grid (or the empty state) of /ai/agents. */
export function AgentsList({
  agents,
  accountModel,
  tags,
  canEdit,
  onNew,
}: {
  agents: AiAgent[];
  accountModel: string | null;
  tags: TagOption[];
  canEdit: boolean;
  onNew: () => void;
}) {
  const { t } = useLanguage();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return agents.filter(
      (a) =>
        (status === "all" || agentStatus(a) === status) &&
        (!q || a.name.toLowerCase().includes(q) || (a.description ?? "").toLowerCase().includes(q)),
    );
  }, [agents, search, status]);

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-14 text-center">
        <div className="flex size-11 items-center justify-center rounded-xl bg-primary-soft text-primary">
          <Bot className="size-5" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">{t("No AI agents yet")}</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {t("Create an agent from a ready template (sales, support or general service) and adjust it to your business.")}
          </p>
        </div>
        {canEdit ? (
          <Button onClick={onNew}>
            <Plus className="size-4" />
            {t("Create first agent")}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Search agents…")}
            aria-label={t("Search agents")}
            className="border-border bg-card pl-8 text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <select
          aria-label={t("Status")}
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          className="h-8 rounded-lg border border-input bg-card px-2 text-sm text-foreground"
        >
          <option value="all">{t("All statuses")}</option>
          {(Object.keys(STATUS_LABEL) as AgentStatus[]).map((s) => (
            <option key={s} value={s}>
              {t(STATUS_LABEL[s])}
            </option>
          ))}
        </select>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          {t("No agents match the filters.")}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((a) => (
            <AgentCard key={a.id} agent={a} accountModel={accountModel} tags={tags} />
          ))}
        </div>
      )}
    </div>
  );
}
