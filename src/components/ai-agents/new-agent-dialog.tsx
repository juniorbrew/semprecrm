"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/hooks/use-language";
import { AGENT_PRESETS, agentPreset, type AgentPresetId } from "@/lib/ai/agent-presets";
import { AGENT_LIMITS, parseAgentInput, type AgentWrite } from "@/lib/ai/agents";
import { cn } from "@/lib/utils";

/**
 * "Novo agente": pick a starting template, adjust the name (and the
 * instructions for "Em branco"), create. The rest is edited on the
 * agent page it lands on.
 */
export function NewAgentDialog({
  open,
  onOpenChange,
  onCreate,
  makeDefault,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves when created (the caller navigates); rejects with an English error key. */
  onCreate: (body: AgentWrite) => Promise<void>;
  makeDefault: boolean;
}) {
  const { t } = useLanguage();
  const [presetId, setPresetId] = useState<AgentPresetId>("sales");
  const [name, setName] = useState(agentPreset("sales").name);
  const [instructions, setInstructions] = useState(agentPreset("sales").instructions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pick(id: AgentPresetId) {
    const p = agentPreset(id);
    setPresetId(id);
    setName(p.name);
    setInstructions(p.instructions);
    setError(null);
  }

  async function create() {
    const p = agentPreset(presetId);
    const parsed = parseAgentInput(
      { name, instructions, description: p.description, tone: p.tone, is_default: makeDefault },
      false,
    );
    if (!parsed.ok) return setError(parsed.error);
    setSaving(true);
    setError(null);
    try {
      await onCreate(parsed.write);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Could not save the agent");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (!saving ? onOpenChange(v) : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("New agent")}</DialogTitle>
          <DialogDescription>{t("Choose a starting point. Everything can be adjusted afterwards.")}</DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label={t("Starting template")} className="grid gap-2 sm:grid-cols-2">
          {AGENT_PRESETS.map((p) => {
            const selected = p.id === presetId;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => pick(p.id)}
                className={cn(
                  "rounded-lg border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                  selected ? "border-primary bg-primary-soft" : "border-border hover:bg-muted/50",
                )}
              >
                <span>
                  <span className="block text-sm font-medium text-foreground">{t(p.label)}</span>
                  <span className="block text-xs text-muted-foreground">{t(p.summary)}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-agent-name">
              {t("Name")}
            </Label>
            <Input
              id="new-agent-name"
              value={name}
              maxLength={AGENT_LIMITS.nameMaxChars}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("E.g.: Sales")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-agent-instructions">
              {t("Instructions")}
            </Label>
            <Textarea
              id="new-agent-instructions"
              value={instructions}
              rows={8}
              maxLength={AGENT_LIMITS.instructionsMaxChars}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={t("Describe what the agent does, how it talks and what it must never do.")}
              className="max-h-[40vh]"
              data-no-translate
            />
            <p className="text-xs text-muted-foreground" data-no-translate>
              {instructions.length}/{AGENT_LIMITS.instructionsMaxChars}
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {t(error)}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button disabled={saving} onClick={() => void create()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("Create agent")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
