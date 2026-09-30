"use client";

import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";

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
      <div className="flex flex-col items-start gap-4 py-10">
        <p className="text-sm text-muted-foreground">{t("No AI agents yet")}</p>
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
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Search agents…")}
            aria-label={t("Search agents")}
            className="pl-8"
          />
        </div>
        <select
          aria-label={t("Status")}
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground"
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
        <p className="py-10 text-sm text-muted-foreground">
          {t("No agents match the filters.")}
        </p>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {shown.map((a) => (
            <AgentCard key={a.id} agent={a} accountModel={accountModel} tags={tags} />
          ))}
        </ul>
      )}
    </div>
  );
}
