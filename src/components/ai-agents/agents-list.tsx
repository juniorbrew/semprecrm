"use client";

import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/hooks/use-language";
import { agentStatus, type AgentStatus, type AiAgent } from "@/lib/ai/agents";
import { cn } from "@/lib/utils";
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
          <Button variant="ghost" size="sm" onClick={onNew} className="-ml-2.5 text-primary hover:text-primary">
            <Plus className="size-4" />
            {t("Create first agent")}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 max-w-xs flex-1 basis-56">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Search agents…")}
            aria-label={t("Search agents")}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <div role="group" aria-label={t("Status")} className="flex flex-wrap items-center gap-1.5">
          {(["all", ...Object.keys(STATUS_LABEL)] as StatusFilter[]).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
              className={cn(
                "inline-flex h-7 items-center rounded-full px-3 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                status === s
                  ? "bg-primary/15 text-primary"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {s === "all" ? t("All statuses") : t(STATUS_LABEL[s])}
            </button>
          ))}
        </div>
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
