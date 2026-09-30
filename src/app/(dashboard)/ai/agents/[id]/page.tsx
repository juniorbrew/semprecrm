"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { type TagOption } from "@/components/ai-agents/agent-card";
import { AgentConfigForm } from "@/components/ai-agents/agent-config-form";
import { AgentOperationBar } from "@/components/ai-agents/agent-operation-bar";
import { AgentRecentReplies } from "@/components/ai-agents/agent-recent-replies";
import { AgentTestPanel } from "@/components/ai-agents/agent-test-panel";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCan } from "@/hooks/use-can";
import { useLanguage } from "@/hooks/use-language";
import { agentsApi } from "@/lib/ai/agents-client";
import type { AgentWrite, AiAgent } from "@/lib/ai/agents";
import type { AiProvider } from "@/lib/ai/providers";
import { createClient } from "@/lib/supabase/client";

interface DetailResponse {
  agent: AiAgent;
  provider: AiProvider | null;
  account_model: string | null;
  knowledge_items: number | null;
}

const TAB_CLASS = "px-3 text-sm";

/** One AI agent: operation bar + Configuração | Teste. */
export default function AiAgentPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const canEdit = useCan("edit-settings");
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tags, setTags] = useState<TagOption[]>([]);
  const [busy, setBusy] = useState(false);
  // Remounts the form after a save so its draft starts from the saved agent.
  const [formKey, setFormKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setData(await agentsApi<DetailResponse>(`/api/ai/agents/${id}`));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the AI agents");
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    void load();
    void createClient()
      .from("tags")
      .select("id, name, color")
      .order("name")
      .then(({ data: rows }) => setTags((rows ?? []) as TagOption[]));
  }, [id, load]);

  async function patch(body: AgentWrite & { paused?: boolean }) {
    const { agent } = await agentsApi<{ agent: AiAgent }>(`/api/ai/agents/${id}`, { method: "PATCH", body });
    setData((d) => (d ? { ...d, agent } : d));
    return agent;
  }

  async function quickPatch(body: AgentWrite & { paused?: boolean }) {
    setBusy(true);
    try {
      await patch(body);
      toast.success(t("Agent saved"));
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : "Could not save the agent"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!data || !window.confirm(t("Delete this AI agent?"))) return;
    setBusy(true);
    try {
      await agentsApi(`/api/ai/agents/${id}`, { method: "DELETE" });
      toast.success(t("Agent deleted"));
      router.push("/ai/agents");
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : "Could not delete the agent"));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/ai/agents" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          {t("AI agents")}
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-foreground" data-no-translate>
          {data?.agent.name ?? " "}
        </h1>
        {data?.agent.description ? (
          <p className="mt-1 text-sm text-muted-foreground" data-no-translate>
            {data.agent.description}
          </p>
        ) : null}
      </div>

      {loadError ? (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {t(loadError)}
          <Button size="sm" variant="outline" onClick={() => void load()}>
            {t("Try again")}
          </Button>
        </div>
      ) : !data ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <AgentOperationBar
            agent={data.agent}
            canEdit={canEdit}
            busy={busy}
            onPatch={(b) => void quickPatch(b)}
            onDelete={() => void remove()}
          />
          {data.agent.mode === "auto" ? <AgentRecentReplies agentId={data.agent.id} /> : null}
          <Tabs defaultValue="config">
            <TabsList variant="line">
              <TabsTrigger value="config" className={TAB_CLASS}>
                {t("Configuration")}
              </TabsTrigger>
              <TabsTrigger value="test" className={TAB_CLASS}>
                {t("Test")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="config" className="pt-6">
              <AgentConfigForm
                key={formKey}
                agent={data.agent}
                provider={data.provider}
                accountModel={data.account_model}
                knowledgeItems={data.knowledge_items}
                tags={tags}
                canEdit={canEdit}
                onSave={async (body) => {
                  await patch(body);
                  setFormKey((k) => k + 1);
                  toast.success(t("Agent saved"));
                }}
              />
            </TabsContent>
            <TabsContent value="test" className="pt-6">
              <AgentTestPanel agentId={data.agent.id} canTest={canEdit} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
