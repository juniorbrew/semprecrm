"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Bot, FlaskConical, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/hooks/use-language";
import { createClient } from "@/lib/supabase/client";
import { AGENT_CHANNELS, AGENT_LIMITS, type AgentChannel, type AiAgent } from "@/lib/ai/agents";
import { AI_SUGGESTED_MODELS, type AiProvider } from "@/lib/ai/providers";
import { SettingsChip } from "./settings-chip";

interface TagOption {
  id: string;
  name: string;
  color: string;
}

type Draft = Pick<
  AiAgent,
  "name" | "instructions" | "tone" | "model" | "knowledge_enabled" | "is_default" | "enabled" | "channels" | "tag_ids"
> & { id: string | null };

const EMPTY: Draft = {
  id: null,
  name: "",
  instructions: "",
  tone: "",
  model: "",
  knowledge_enabled: true,
  is_default: false,
  enabled: true,
  channels: [],
  tag_ids: [],
};

const CHANNEL_LABEL: Record<AgentChannel, string> = {
  official: "Official WhatsApp number",
  qr: "WhatsApp QR number",
};

async function errorKey(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? "";
}

/**
 * Settings → Inteligência Artificial → Agentes (migration 064, admin+).
 * Named instruction profiles for "Sugerir resposta", linked to contact
 * tags and/or WhatsApp numbers, with one default. Rendered inside
 * AiSettings, which already gates on role and plan module.
 */
export function AiAgents({ provider }: { provider: AiProvider | null }) {
  const { t } = useLanguage();
  const supabase = useMemo(() => createClient(), []);
  const [agents, setAgents] = useState<AiAgent[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [tags, setTags] = useState<TagOption[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [testAgent, setTestAgent] = useState("");
  const [testMessage, setTestMessage] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch("/api/ai/agents", { cache: "no-store" });
      if (!res.ok) throw new Error(await errorKey(res));
      setAgents(((await res.json()) as { agents: AiAgent[] }).agents);
    } catch (err) {
      console.error("[ai-agents] load failed:", err);
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    void supabase
      .from("tags")
      .select("id, name, color")
      .order("name")
      .then(({ data }) => setTags((data ?? []) as TagOption[]));
  }, [load, supabase]);

  const tagName = (id: string) => tags.find((x) => x.id === id)?.name;
  const fail = (key: string, fallback: string) => toast.error(key ? t(key) : t(fallback));

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const { id, ...fields } = draft;
      const res = await fetch(id ? `/api/ai/agents/${id}` : "/api/ai/agents", {
        method: id ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...fields, tone: fields.tone?.trim() || null, model: fields.model?.trim() || null }),
      });
      if (!res.ok) return fail(await errorKey(res), "Could not save the agent");
      toast.success(t("Agent saved"));
      setDraft(null);
      await load();
    } catch {
      fail("", "Could not save the agent");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(agent: AiAgent, enabled: boolean) {
    setBusyId(agent.id);
    try {
      const res = await fetch(`/api/ai/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) return fail(await errorKey(res), "Could not save the agent");
      setAgents((prev) => prev?.map((a) => (a.id === agent.id ? { ...a, enabled } : a)) ?? prev);
    } catch {
      fail("", "Could not save the agent");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(agent: AiAgent) {
    if (!window.confirm(t("Delete this AI agent?"))) return;
    setBusyId(agent.id);
    try {
      const res = await fetch(`/api/ai/agents/${agent.id}`, { method: "DELETE" });
      if (!res.ok) return fail(await errorKey(res), "Could not delete the agent");
      setAgents((prev) => prev?.filter((a) => a.id !== agent.id) ?? prev);
      if (testAgent === agent.id) setTestAgent("");
    } catch {
      fail("", "Could not delete the agent");
    } finally {
      setBusyId(null);
    }
  }

  async function runTest() {
    const agentId = testAgent || agents?.[0]?.id;
    if (!agentId || !testMessage.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/ai/agents/${agentId}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: testMessage }),
      });
      if (!res.ok) {
        return res.status === 429
          ? toast.error(t("Too many requests. Wait a minute and try again."))
          : fail(await errorKey(res), "Could not generate the suggestion. Try again.");
      }
      setTestResult(((await res.json()) as { text: string }).text);
    } catch {
      fail("", "Could not generate the suggestion. Try again.");
    } finally {
      setTesting(false);
    }
  }

  const draftValid =
    !!draft &&
    draft.name.trim().length > 0 &&
    draft.name.trim().length <= AGENT_LIMITS.nameMaxChars &&
    draft.instructions.trim().length > 0 &&
    draft.instructions.length <= AGENT_LIMITS.instructionsMaxChars;

  const toggleIn = <T,>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Bot className="size-4 text-primary" />
          {t("AI agents")}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t(
            "Different instructions per team or number. The account instructions above always apply; the agent's instructions are added after them. The suggestion uses the agent linked to one of the contact's tags; otherwise the one linked to the conversation's WhatsApp number; otherwise the default agent.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <Button size="sm" variant="outline" onClick={() => setDraft({ ...EMPTY, is_default: !agents?.length })}>
          <Plus className="mr-1.5 size-3.5" />
          {t("New agent")}
        </Button>

        {loadError ? (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground">
            {t("Could not load the AI agents")}
            <Button size="sm" variant="outline" onClick={() => void load()}>
              {t("Try again")}
            </Button>
          </div>
        ) : agents === null ? (
          <div className="h-12 animate-pulse rounded-lg bg-muted/60" />
        ) : agents.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            {t("No agents yet — suggestions use the instructions above.")}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {agents.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground" data-no-translate>
                    {a.name}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {a.is_default ? <SettingsChip variant="admin">{t("Default")}</SettingsChip> : null}
                    {!a.knowledge_enabled ? <SettingsChip variant="muted">{t("Without knowledge base")}</SettingsChip> : null}
                    {a.model ? (
                      <SettingsChip variant="muted">
                        <span data-no-translate>{a.model}</span>
                      </SettingsChip>
                    ) : null}
                    {a.channels.map((c) => (
                      <SettingsChip key={c} variant="muted">
                        {t(CHANNEL_LABEL[c])}
                      </SettingsChip>
                    ))}
                    {a.tag_ids.map((id) =>
                      tagName(id) ? (
                        <SettingsChip key={id} variant="muted">
                          <span data-no-translate>#{tagName(id)}</span>
                        </SettingsChip>
                      ) : null,
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Switch
                    checked={a.enabled}
                    disabled={busyId === a.id}
                    onCheckedChange={(v) => void toggle(a, v)}
                    aria-label={`${t("Turned on")}: ${a.name}`}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === a.id}
                    onClick={() => setDraft({ ...a, tone: a.tone ?? "", model: a.model ?? "" })}
                    aria-label={`${t("Edit")}: ${a.name}`}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === a.id}
                    onClick={() => void remove(a)}
                    aria-label={`${t("Delete")}: ${a.name}`}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Test an agent — a real, budgeted call. */}
        {agents && agents.length > 0 ? (
          <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
            <Label htmlFor="agent-test-message" className="flex items-center gap-1.5 text-foreground">
              <FlaskConical className="size-3.5" />
              {t("Test an agent")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("Sends this message to the AI provider as if a customer wrote it and shows the suggestion. It is a real call and counts toward the monthly budget.")}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                aria-label={t("Agent")}
                value={testAgent || agents[0].id}
                onChange={(e) => setTestAgent(e.target.value)}
                className="h-9 rounded-md border border-input bg-card px-2 text-sm text-foreground"
                data-no-translate
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <Input
                id="agent-test-message"
                value={testMessage}
                maxLength={AGENT_LIMITS.testMessageMaxChars}
                onChange={(e) => setTestMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runTest();
                }}
                placeholder={t("E.g.: Do you deliver on Sundays?")}
                className="bg-card text-foreground"
              />
              <Button size="sm" className="h-9" disabled={testing || !testMessage.trim()} onClick={() => void runTest()}>
                {testing ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                {t("Test")}
              </Button>
            </div>
            {testResult !== null ? (
              <div className="rounded-md border border-border bg-card px-3 py-2">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("Suggestion (test)")}
                </div>
                <p className="mt-1 whitespace-pre-line text-sm text-foreground" data-no-translate>
                  {testResult}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>

      <Dialog open={draft !== null} onOpenChange={(open) => (!open && !saving ? setDraft(null) : undefined)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{draft?.id ? t("Edit agent") : t("New agent")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("Uses the account's provider, API key and budget.")}
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="agent-name" className="text-foreground">
                  {t("Name")}
                </Label>
                <Input
                  id="agent-name"
                  value={draft.name}
                  maxLength={AGENT_LIMITS.nameMaxChars}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={t("E.g.: Sales")}
                  className="bg-card text-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="agent-instructions" className="text-foreground">
                  {t("Instructions for the assistant")}
                </Label>
                <Textarea
                  id="agent-instructions"
                  value={draft.instructions}
                  rows={7}
                  maxLength={AGENT_LIMITS.instructionsMaxChars}
                  onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                  className="max-h-[40vh] bg-card text-foreground"
                />
                <p className="text-xs text-muted-foreground" data-no-translate>
                  {draft.instructions.length}/{AGENT_LIMITS.instructionsMaxChars}
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="agent-tone" className="text-foreground">
                    {t("Tone (optional)")}
                  </Label>
                  <Input
                    id="agent-tone"
                    value={draft.tone ?? ""}
                    maxLength={AGENT_LIMITS.toneMaxChars}
                    onChange={(e) => setDraft({ ...draft, tone: e.target.value })}
                    placeholder={t("E.g.: friendly and short")}
                    className="bg-card text-foreground"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="agent-model" className="text-foreground">
                    {t("Model (optional)")}
                  </Label>
                  <Input
                    id="agent-model"
                    list="agent-model-options"
                    value={draft.model ?? ""}
                    onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                    placeholder={t("Account model")}
                    spellCheck={false}
                    className="bg-card font-mono text-foreground"
                  />
                  <datalist id="agent-model-options">
                    {(provider ? AI_SUGGESTED_MODELS[provider] : []).map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </div>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-foreground">{t("Use this agent for")}</legend>
                {AGENT_CHANNELS.map((c) => (
                  <label key={c} className="flex items-center gap-2 text-sm text-foreground">
                    <Checkbox
                      checked={draft.channels.includes(c)}
                      onCheckedChange={(v) => setDraft({ ...draft, channels: toggleIn(draft.channels, c, v === true) })}
                    />
                    {t(CHANNEL_LABEL[c])}
                  </label>
                ))}
                {tags.length > 0 ? (
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">{t("Contacts with these tags (takes priority over the number):")}</p>
                    <div className="flex max-h-32 flex-wrap gap-x-4 gap-y-1.5 overflow-y-auto">
                      {tags.map((tag) => (
                        <label key={tag.id} className="flex items-center gap-1.5 text-sm text-foreground" data-no-translate>
                          <Checkbox
                            checked={draft.tag_ids.includes(tag.id)}
                            onCheckedChange={(v) =>
                              setDraft({ ...draft, tag_ids: toggleIn(draft.tag_ids, tag.id, v === true) })
                            }
                          />
                          <span className="size-2 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden />
                          {tag.name}
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
              </fieldset>

              <div className="space-y-3">
                <label className="flex items-center justify-between gap-3 text-sm text-foreground">
                  {t("Default agent (when no tag or number matches)")}
                  <Switch checked={draft.is_default} onCheckedChange={(v) => setDraft({ ...draft, is_default: v })} />
                </label>
                <label className="flex items-center justify-between gap-3 text-sm text-foreground">
                  {t("Use the knowledge base")}
                  <Switch
                    checked={draft.knowledge_enabled}
                    onCheckedChange={(v) => setDraft({ ...draft, knowledge_enabled: v })}
                  />
                </label>
                <label className="flex items-center justify-between gap-3 text-sm text-foreground">
                  {t("Turned on")}
                  <Switch checked={draft.enabled} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })} />
                </label>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setDraft(null)}>
              {t("Cancel")}
            </Button>
            <Button disabled={saving || !draftValid} onClick={() => void save()}>
              {saving ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              {t("Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
