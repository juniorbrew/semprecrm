"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { type TagOption } from "@/components/ai-agents/agent-card";
import { AgentsList } from "@/components/ai-agents/agents-list";
import { NewAgentDialog } from "@/components/ai-agents/new-agent-dialog";
import { GatedButton } from "@/components/ui/gated-button";
import { Button } from "@/components/ui/button";
import { useCan } from "@/hooks/use-can";
import { useLanguage } from "@/hooks/use-language";
import { agentsApi } from "@/lib/ai/agents-client";
import type { AgentWrite, AiAgent } from "@/lib/ai/agents";
import { createClient } from "@/lib/supabase/client";

interface ListResponse {
  agents: AiAgent[];
  account_model: string | null;
}

/**
 * Agentes de IA — the account's AI agents (migrations 064/065). Agent+
 * views; admin+ creates and edits (API + RLS). Module `ai` (layout).
 */
export default function AiAgentsPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const canEdit = useCan("edit-settings");
  const [data, setData] = useState<ListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tags, setTags] = useState<TagOption[]>([]);
  const [newOpen, setNewOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await agentsApi<ListResponse>("/api/ai/agents"));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the AI agents");
    }
  }, []);

  useEffect(() => {
    // load() only sets state after its fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    void createClient()
      .from("tags")
      .select("id, name, color")
      .order("name")
      .then(({ data: rows }) => setTags((rows ?? []) as TagOption[]));
  }, [load]);

  async function create(body: AgentWrite) {
    const { agent } = await agentsApi<{ agent: AiAgent }>("/api/ai/agents", { method: "POST", body });
    toast.success(t("Agent created"));
    setNewOpen(false);
    router.push(`/ai/agents/${agent.id}`);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("AI agents")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Assistants that suggest or send replies on WhatsApp, each with its own instructions, channels and limits.")}
          </p>
        </div>
        <GatedButton
          canAct={canEdit}
          gateReason="create AI agents"
          onClick={() => setNewOpen(true)}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="size-4" />
          {t("New agent")}
        </GatedButton>
      </div>

      {loadError ? (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {t(loadError)}
          <Button size="sm" variant="outline" onClick={() => void load()}>
            {t("Try again")}
          </Button>
        </div>
      ) : data === null ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <AgentsList
          agents={data.agents}
          accountModel={data.account_model}
          tags={tags}
          canEdit={canEdit}
          onNew={() => setNewOpen(true)}
        />
      )}

      {newOpen ? (
        <NewAgentDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          onCreate={create}
          makeDefault={!!data && data.agents.length === 0}
        />
      ) : null}
    </div>
  );
}
