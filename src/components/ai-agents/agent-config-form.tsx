"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Loader2, ShieldCheck, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/hooks/use-language";
import {
  AGENT_CHANNELS,
  AGENT_LIMITS,
  parseAgentInput,
  type AgentWrite,
  type AiAgent,
} from "@/lib/ai/agents";
import { AI_PROVIDER_LABELS, AI_SUGGESTED_MODELS, type AiProvider } from "@/lib/ai/providers";
import { CHANNEL_LABEL, type TagOption } from "./agent-card";

/** Fields edited on the Configuração tab (mode / pause / enabled live in the operation bar). */
const FORM_FIELDS = [
  "name",
  "description",
  "model",
  "channels",
  "tag_ids",
  "is_default",
  "instructions",
  "tone",
  "knowledge_enabled",
  "business_hours",
  "ignore_groups",
  "split_messages",
  "max_chars_per_message",
  "handoff_enabled",
  "handoff_keywords",
  "handoff_message",
  "max_messages_per_turn",
  "max_auto_replies_per_day",
] as const;
type FormField = (typeof FORM_FIELDS)[number];
export type AgentDraft = Pick<AiAgent, FormField>;

export function draftFromAgent(a: AiAgent): AgentDraft {
  const d = {} as Record<FormField, unknown>;
  for (const f of FORM_FIELDS) d[f] = a[f];
  return structuredClone(d) as AgentDraft;
}

/** Field → English error key, using the same validator as the API. */
export function draftErrors(d: AgentDraft): Partial<Record<FormField, string>> {
  const out: Partial<Record<FormField, string>> = {};
  for (const f of FORM_FIELDS) {
    const r = parseAgentInput({ [f]: d[f] }, true);
    if (!r.ok) out[f] = r.error;
  }
  return out;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Confere antes de enviar" — fixed protections, shown read-only. */
export const SAFETY_CHECKS: { title: string; protects: string }[] = [
  {
    title: "Respects whoever asked to stop",
    protects: "A contact who opted out of messages never gets an automatic reply.",
  },
  {
    title: "Does not answer anonymized contacts",
    protects: "Contacts anonymized under the LGPD are never processed by the AI.",
  },
  {
    title: "Respects the official WhatsApp 24-hour window",
    protects: "Outside the window Meta only allows approved templates — the agent stays silent.",
  },
  {
    title: "Does not promise prices, deadlines or discounts outside the knowledge base",
    protects: "Commercial terms only come from what your team wrote down.",
  },
  {
    title: "Says it is a virtual assistant when asked",
    protects: "The customer is never led to believe they are talking to a person.",
  },
  {
    title: "Monthly spending limit",
    protects: "When the account's AI budget runs out, the agent stops calling the provider.",
  },
];

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const { t } = useLanguage();
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="text-foreground">{t(title)}</CardTitle>
        {description ? <CardDescription className="text-muted-foreground">{t(description)}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function FieldError({ id, error }: { id: string; error?: string }) {
  const { t } = useLanguage();
  if (!error) return null;
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {t(error)}
    </p>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  const { t } = useLanguage();
  return (
    <label className="flex items-start justify-between gap-3 text-sm text-foreground">
      <span>
        {t(label)}
        {hint ? <span className="mt-0.5 block text-xs text-muted-foreground">{t(hint)}</span> : null}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </label>
  );
}

function timeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? ["America/Sao_Paulo"];
  } catch {
    return ["America/Sao_Paulo"];
  }
}

/** The Configuração tab: titled cards in two columns, one Save. */
export function AgentConfigForm({
  agent,
  provider,
  accountModel,
  knowledgeItems,
  tags,
  canEdit,
  onSave,
}: {
  agent: AiAgent;
  provider: AiProvider | null;
  accountModel: string | null;
  knowledgeItems: number | null;
  tags: TagOption[];
  canEdit: boolean;
  /** Rejects with an English error key. */
  onSave: (patch: AgentWrite) => Promise<void>;
}) {
  const { t } = useLanguage();
  const [draft, setDraft] = useState<AgentDraft>(() => draftFromAgent(agent));
  const [keyword, setKeyword] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const errors = useMemo(() => draftErrors(draft), [draft]);
  const shownErrors = tried ? errors : {};
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(draftFromAgent(agent)), [draft, agent]);
  const zones = useMemo(timeZones, []);
  const ro = !canEdit;

  const set = <K extends FormField>(k: K, v: AgentDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setHours = (patch: Partial<AgentDraft["business_hours"]>) =>
    setDraft((d) => ({ ...d, business_hours: { ...d.business_hours, ...patch } }));
  const toggleIn = <T,>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
  const err = (f: FormField) => shownErrors[f];
  const describedBy = (f: FormField) => (err(f) ? `agent-${f}-error` : undefined);

  function addKeyword() {
    const k = keyword.replace(/\s+/g, " ").trim();
    if (!k) return;
    if (!draft.handoff_keywords.some((x) => x.toLowerCase() === k.toLowerCase())) {
      set("handoff_keywords", [...draft.handoff_keywords, k]);
    }
    setKeyword("");
  }

  async function save() {
    setTried(true);
    setSaveError(null);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    try {
      await onSave({ ...draft, model: draft.model?.trim() || null });
      setTried(false);
    } catch (e) {
      setSaveError(e instanceof Error && e.message ? e.message : "Could not save the agent");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="space-y-4"
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Section title="Who this agent is">
            <div className="space-y-2">
              <Label htmlFor="agent-name" className="text-foreground">
                {t("Name")}
              </Label>
              <Input
                id="agent-name"
                value={draft.name}
                maxLength={AGENT_LIMITS.nameMaxChars}
                onChange={(e) => set("name", e.target.value)}
                readOnly={ro}
                aria-invalid={!!err("name")}
                aria-describedby={describedBy("name")}
                className="bg-card text-foreground"
                data-no-translate
              />
              <FieldError id="agent-name-error" error={err("name")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-description" className="text-foreground">
                {t("Description")}
              </Label>
              <Textarea
                id="agent-description"
                value={draft.description ?? ""}
                rows={2}
                onChange={(e) => set("description", e.target.value)}
                readOnly={ro}
                aria-invalid={!!err("description")}
                aria-describedby={describedBy("description")}
                placeholder={t("What this agent does, in one sentence.")}
                className="bg-card text-foreground"
                data-no-translate
              />
              <FieldError id="agent-description-error" error={err("description")} />
            </div>
          </Section>

          <Section title="The intelligence it uses">
            <div className="space-y-1 text-sm">
              <span className="text-muted-foreground">{t("Provider of the account")}: </span>
              <span className="font-medium text-foreground" data-no-translate>
                {provider ? AI_PROVIDER_LABELS[provider] : "—"}
              </span>
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-model" className="text-foreground">
                {t("Model")}
              </Label>
              <Input
                id="agent-model"
                list="agent-model-options"
                value={draft.model ?? ""}
                onChange={(e) => set("model", e.target.value)}
                readOnly={ro}
                placeholder={accountModel ?? t("Account model")}
                spellCheck={false}
                aria-invalid={!!err("model")}
                aria-describedby={describedBy("model")}
                className="bg-card font-mono text-foreground"
              />
              <datalist id="agent-model-options">
                {(provider ? AI_SUGGESTED_MODELS[provider] : []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <p className="text-xs text-muted-foreground">{t("Leave blank to use the account's model.")}</p>
              <FieldError id="agent-model-error" error={err("model")} />
            </div>
          </Section>

          <Section title="Where it works" description="The agent linked to a contact's tag wins over the one linked to the number.">
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium text-foreground">{t("Channels")}</legend>
              {AGENT_CHANNELS.map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm text-foreground">
                  <Checkbox
                    checked={draft.channels.includes(c)}
                    disabled={ro}
                    onCheckedChange={(v) => set("channels", toggleIn(draft.channels, c, v === true))}
                  />
                  {t(CHANNEL_LABEL[c])}
                </label>
              ))}
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium text-foreground">{t("Contact tags")}</legend>
              {tags.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("No tags created yet.")}</p>
              ) : (
                <div className="flex max-h-36 flex-wrap gap-x-4 gap-y-1.5 overflow-y-auto">
                  {tags.map((tag) => (
                    <label key={tag.id} className="flex items-center gap-1.5 text-sm text-foreground" data-no-translate>
                      <Checkbox
                        checked={draft.tag_ids.includes(tag.id)}
                        disabled={ro}
                        onCheckedChange={(v) => set("tag_ids", toggleIn(draft.tag_ids, tag.id, v === true))}
                      />
                      <span className="size-2 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden />
                      {tag.name}
                    </label>
                  ))}
                </div>
              )}
              <FieldError id="agent-tag_ids-error" error={err("tag_ids")} />
            </fieldset>
            <SwitchRow
              label="Account default"
              hint="Answers when no tag or number matches another agent."
              checked={draft.is_default}
              onChange={(v) => set("is_default", v)}
              disabled={ro}
            />
          </Section>

          <Section title="What it consults">
            <SwitchRow
              label="Use the knowledge base"
              checked={draft.knowledge_enabled}
              onChange={(v) => set("knowledge_enabled", v)}
              disabled={ro}
            />
            <p className="text-xs text-muted-foreground">
              {knowledgeItems !== null ? (
                <>
                  <span data-no-translate>{knowledgeItems}</span> {t("active items in the knowledge base.")}{" "}
                </>
              ) : null}
              <Link href="/settings?tab=ai" className="font-medium text-primary hover:underline">
                {t("Manage knowledge base")}
              </Link>
            </p>
          </Section>

          <Section title="Response style">
            <SwitchRow
              label="Reply in several short messages"
              checked={draft.split_messages}
              onChange={(v) => set("split_messages", v)}
              disabled={ro}
            />
            <div className="space-y-2">
              <Label htmlFor="agent-max-chars" className="text-foreground">
                {t("Maximum size per message")}
              </Label>
              <Input
                id="agent-max-chars"
                type="number"
                min={AGENT_LIMITS.minCharsPerMessage}
                max={AGENT_LIMITS.maxCharsPerMessage}
                step={10}
                value={Number.isNaN(draft.max_chars_per_message) ? "" : draft.max_chars_per_message}
                onChange={(e) => set("max_chars_per_message", e.target.valueAsNumber)}
                readOnly={ro}
                aria-invalid={!!err("max_chars_per_message")}
                aria-describedby={describedBy("max_chars_per_message")}
                className="w-32 bg-card text-foreground"
              />
              <p className="text-xs text-muted-foreground">{t("Characters, from 80 to 1000.")}</p>
              <FieldError id="agent-max_chars_per_message-error" error={err("max_chars_per_message")} />
            </div>
          </Section>
        </div>

        <div className="space-y-4">
          <Section title="Its instructions">
            <div className="space-y-2">
              <Label htmlFor="agent-instructions" className="text-foreground">
                {t("Instructions")}
              </Label>
              <Textarea
                id="agent-instructions"
                value={draft.instructions}
                rows={12}
                maxLength={AGENT_LIMITS.instructionsMaxChars}
                onChange={(e) => set("instructions", e.target.value)}
                readOnly={ro}
                aria-invalid={!!err("instructions")}
                aria-describedby={describedBy("instructions")}
                className="max-h-[60vh] bg-card text-foreground"
                data-no-translate
              />
              <p className="flex justify-between gap-2 text-xs text-muted-foreground">
                <span>{t("The account's general instructions (Settings → AI) always apply first.")}</span>
                <span data-no-translate className="shrink-0 tabular-nums">
                  {draft.instructions.length}/{AGENT_LIMITS.instructionsMaxChars}
                </span>
              </p>
              <FieldError id="agent-instructions-error" error={err("instructions")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-tone" className="text-foreground">
                {t("Tone of voice")}
              </Label>
              <Input
                id="agent-tone"
                value={draft.tone ?? ""}
                maxLength={AGENT_LIMITS.toneMaxChars}
                onChange={(e) => set("tone", e.target.value)}
                readOnly={ro}
                placeholder={t("E.g.: friendly and short")}
                aria-invalid={!!err("tone")}
                aria-describedby={describedBy("tone")}
                className="bg-card text-foreground"
                data-no-translate
              />
              <FieldError id="agent-tone-error" error={err("tone")} />
            </div>
          </Section>

          <Section title="When it steps in" description="Applies to automatic mode.">
            <SwitchRow
              label="Only within business hours"
              checked={draft.business_hours.enabled}
              onChange={(v) => setHours({ enabled: v })}
              disabled={ro}
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2 sm:col-span-3">
                <Label htmlFor="agent-timezone" className="text-foreground">
                  {t("Time zone")}
                </Label>
                <Input
                  id="agent-timezone"
                  list="agent-timezones"
                  value={draft.business_hours.timezone}
                  onChange={(e) => setHours({ timezone: e.target.value })}
                  readOnly={ro}
                  spellCheck={false}
                  className="bg-card text-foreground"
                  data-no-translate
                />
                <datalist id="agent-timezones">
                  {zones.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
              </div>
              <div className="space-y-2">
                <Label htmlFor="agent-start" className="text-foreground">
                  {t("Start")}
                </Label>
                <Input
                  id="agent-start"
                  type="time"
                  value={draft.business_hours.start}
                  onChange={(e) => setHours({ start: e.target.value })}
                  readOnly={ro}
                  className="bg-card text-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="agent-end" className="text-foreground">
                  {t("End")}
                </Label>
                <Input
                  id="agent-end"
                  type="time"
                  value={draft.business_hours.end}
                  onChange={(e) => setHours({ end: e.target.value })}
                  readOnly={ro}
                  className="bg-card text-foreground"
                />
              </div>
            </div>
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-foreground">{t("Days of the week")}</legend>
              <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                {DAYS.map((d, i) => (
                  <label key={d} className="flex items-center gap-1.5 text-sm text-foreground">
                    <Checkbox
                      checked={draft.business_hours.days.includes(i)}
                      disabled={ro}
                      onCheckedChange={(v) =>
                        setHours({ days: toggleIn(draft.business_hours.days, i, v === true).sort((x, y) => x - y) })
                      }
                    />
                    {t(d)}
                  </label>
                ))}
              </div>
            </fieldset>
            <FieldError id="agent-business_hours-error" error={err("business_hours")} />
            <SwitchRow
              label="Do not reply in groups"
              checked={draft.ignore_groups}
              onChange={(v) => set("ignore_groups", v)}
              disabled={ro}
            />
          </Section>

          <Section title="Hand over to a person">
            <SwitchRow
              label="Let the agent call a person when it does not know"
              checked={draft.handoff_enabled}
              onChange={(v) => set("handoff_enabled", v)}
              disabled={ro}
            />
            <div className="space-y-2">
              <Label htmlFor="agent-keyword" className="text-foreground">
                {t("Words that call a person right away")}
              </Label>
              <div className="flex flex-wrap gap-1.5" data-no-translate>
                {draft.handoff_keywords.map((k) => (
                  <span
                    key={k}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-foreground"
                  >
                    {k}
                    {!ro ? (
                      <button
                        type="button"
                        onClick={() => set("handoff_keywords", draft.handoff_keywords.filter((x) => x !== k))}
                        aria-label={`${t("Remove")}: ${k}`}
                        className="rounded-full text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3" />
                      </button>
                    ) : null}
                  </span>
                ))}
              </div>
              {!ro ? (
                <div className="flex gap-2">
                  <Input
                    id="agent-keyword"
                    value={keyword}
                    maxLength={AGENT_LIMITS.handoffKeywordMaxChars}
                    onChange={(e) => setKeyword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        addKeyword();
                      }
                    }}
                    placeholder={t("Type and press Enter")}
                    className="bg-card text-foreground"
                  />
                  <Button type="button" variant="outline" onClick={addKeyword}>
                    {t("Add")}
                  </Button>
                </div>
              ) : null}
              <FieldError id="agent-handoff_keywords-error" error={err("handoff_keywords")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-handoff-message" className="text-foreground">
                {t("Message to the customer on hand-over")}
              </Label>
              <Textarea
                id="agent-handoff-message"
                value={draft.handoff_message ?? ""}
                rows={2}
                onChange={(e) => set("handoff_message", e.target.value)}
                readOnly={ro}
                aria-invalid={!!err("handoff_message")}
                aria-describedby={describedBy("handoff_message")}
                className="bg-card text-foreground"
                data-no-translate
              />
              <FieldError id="agent-handoff_message-error" error={err("handoff_message")} />
            </div>
          </Section>

          <Section title="Safety brakes">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="agent-max-messages" className="text-foreground">
                  {t("Max messages per automatic reply")}
                </Label>
                <Input
                  id="agent-max-messages"
                  type="number"
                  min={1}
                  max={AGENT_LIMITS.maxMessagesPerTurn}
                  value={Number.isNaN(draft.max_messages_per_turn) ? "" : draft.max_messages_per_turn}
                  onChange={(e) => set("max_messages_per_turn", e.target.valueAsNumber)}
                  readOnly={ro}
                  aria-invalid={!!err("max_messages_per_turn")}
                  aria-describedby={describedBy("max_messages_per_turn")}
                  className="w-24 bg-card text-foreground"
                />
                <FieldError id="agent-max_messages_per_turn-error" error={err("max_messages_per_turn")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="agent-max-replies" className="text-foreground">
                  {t("Automatic replies per conversation per day")}
                </Label>
                <Input
                  id="agent-max-replies"
                  type="number"
                  min={1}
                  max={AGENT_LIMITS.maxAutoRepliesPerDay}
                  value={Number.isNaN(draft.max_auto_replies_per_day) ? "" : draft.max_auto_replies_per_day}
                  onChange={(e) => set("max_auto_replies_per_day", e.target.valueAsNumber)}
                  readOnly={ro}
                  aria-invalid={!!err("max_auto_replies_per_day")}
                  aria-describedby={describedBy("max_auto_replies_per_day")}
                  className="w-24 bg-card text-foreground"
                />
                <FieldError id="agent-max_auto_replies_per_day-error" error={err("max_auto_replies_per_day")} />
              </div>
            </div>
          </Section>

          <Section title="Checks before sending" description="Always on for every automatic reply.">
            <ol className="space-y-3">
              {SAFETY_CHECKS.map((c, i) => (
                <li key={c.title} className="flex gap-3">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary">
                    {i + 1}
                  </span>
                  <div className="text-sm">
                    <p className="font-medium text-foreground">{t(c.title)}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("What it protects")}: {t(c.protects)}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                      <ShieldCheck className="size-3" />
                      {t("This cannot be turned off.")}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Section>
        </div>
      </div>

      {canEdit ? (
        <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-background/95 px-1 py-3 backdrop-blur">
          {tried && Object.keys(errors).length > 0 ? (
            <p role="alert" className="mr-auto text-sm text-destructive">
              {t("Fix the highlighted fields before saving.")}
            </p>
          ) : saveError ? (
            <p role="alert" className="mr-auto text-sm text-destructive">
              {t(saveError)}
            </p>
          ) : dirty ? (
            <p className="mr-auto text-sm text-muted-foreground">{t("Unsaved changes")}</p>
          ) : null}
          <Button type="button" variant="outline" disabled={saving || !dirty} onClick={() => setDraft(draftFromAgent(agent))}>
            {t("Discard")}
          </Button>
          <Button type="submit" disabled={saving || !dirty}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("Save")}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
