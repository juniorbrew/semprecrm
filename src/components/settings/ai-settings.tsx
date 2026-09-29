"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  BarChart3,
  Check,
  ExternalLink,
  KeyRound,
  Loader2,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { invalidateAiStatus } from "@/hooks/use-ai-status";
import { useLanguage } from "@/hooks/use-language";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  AI_DEFAULT_MODELS,
  AI_LIMITS,
  AI_PROVIDER_KEY_URLS,
  AI_PROVIDER_LABELS,
  AI_PROVIDERS,
  AI_SUGGESTED_MODELS,
  isValidModelId,
  modelMatchesProvider,
  parseBudgetInput,
  type AiProvider,
} from "@/lib/ai/providers";
import { cn } from "@/lib/utils";
import { AiKnowledge } from "./ai-knowledge";
import { SettingsChip } from "./settings-chip";
import { SettingsPanelHead } from "./settings-panel-head";

interface Credential {
  provider: AiProvider;
  last4: string;
  validated_at: string | null;
}

interface AiState {
  settings: {
    enabled: boolean;
    provider: AiProvider | null;
    model: string | null;
    instructions: string;
    monthly_budget_cents: number;
    suggest_history_messages: number;
    consent_provider: AiProvider | null;
    consented_at: string | null;
    consented_by_name: string | null;
  };
  credentials: Credential[];
  usage: {
    month: string;
    calls: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
  };
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `HTTP ${res.status}`;
}

/** Cents → "1.000,50" (pt-BR) / "1,000.50" (en) for the budget field. */
function centsToInput(cents: number, language: string = "pt-BR"): string {
  return new Intl.NumberFormat(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

/**
 * Settings → Inteligência Artificial. Admin+ and plan module `ai`.
 * The account brings its own OpenAI/Anthropic key (saved encrypted,
 * never shown again beyond the last 4 characters); the admin picks the
 * model, writes the assistant's instructions, sets a monthly budget and
 * must accept the LGPD notice (conversation text goes to the provider)
 * before turning "Sugerir resposta" on.
 */
export function AiSettings() {
  const { t, language } = useLanguage();
  const { canManageMembers, profileLoading, entitlements } = useAuth();
  const moduleOn = entitlements.modules.ai;

  const [state, setState] = useState<AiState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  // Form
  const [provider, setProvider] = useState<AiProvider>("openai");
  const [model, setModel] = useState("");
  const [instructions, setInstructions] = useState("");
  const [budget, setBudget] = useState(centsToInput(AI_LIMITS.budgetDefaultCents, language));
  const [history, setHistory] = useState(String(AI_LIMITS.historyDefault));
  const [consent, setConsent] = useState(false);
  const [enabled, setEnabled] = useState(false);

  // Key
  const [keyDraft, setKeyDraft] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [keyBusy, setKeyBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  const seed = useCallback((s: AiState) => {
    setState(s);
    // Open on a provider that has a key: the saved one if it has a key,
    // otherwise the first provider with a key (e.g. settings saved on the
    // OpenAI tab while the key was saved for Anthropic). Otherwise
    // "Ativar" stays blocked by a tab with no key.
    const withKey = new Set(s.credentials.map((c) => c.provider));
    const saved = s.settings.provider;
    const p = saved && withKey.has(saved) ? saved : s.credentials[0]?.provider ?? saved ?? "openai";
    setProvider(p);
    setModel(p === saved && s.settings.model ? s.settings.model : AI_DEFAULT_MODELS[p]);
    setInstructions(s.settings.instructions ?? "");
    setBudget(centsToInput(s.settings.monthly_budget_cents, language));
    setHistory(String(s.settings.suggest_history_messages));
    setConsent(!!s.settings.consented_at && s.settings.consent_provider === p);
    setEnabled(s.settings.enabled);
  }, [language]);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch("/api/ai/settings", { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      seed((await res.json()) as AiState);
    } catch (err) {
      console.error("[ai-settings] load failed:", err);
      setLoadError(true);
    }
  }, [seed]);

  useEffect(() => {
    if (!profileLoading && canManageMembers && moduleOn) void load();
  }, [profileLoading, canManageMembers, moduleOn, load]);

  const credential = state?.credentials.find((c) => c.provider === provider) ?? null;
  const savedConsentValid =
    !!state?.settings.consented_at && state.settings.consent_provider === provider;

  // Switching provider in the form: the consent (per provider) and the
  // default model follow the choice.
  function chooseProvider(p: AiProvider) {
    if (p === provider) return;
    setProvider(p);
    setModel(state?.settings.provider === p && state.settings.model ? state.settings.model : AI_DEFAULT_MODELS[p]);
    setConsent(!!state?.settings.consented_at && state.settings.consent_provider === p);
    setKeyDraft("");
    setReplacingKey(false);
    setAvailableModels([]);
  }

  const budgetCents = parseBudgetInput(budget);
  const historyNum = Number(history);
  const historyValid =
    Number.isInteger(historyNum) && historyNum >= AI_LIMITS.historyMin && historyNum <= AI_LIMITS.historyMax;
  const modelValid = isValidModelId(model.trim()) && modelMatchesProvider(provider, model.trim());
  const instructionsValid = instructions.length <= AI_LIMITS.instructionsMaxChars;

  const missing: string[] = [];
  if (!credential) missing.push(t("save an API key"));
  if (!modelValid) missing.push(t("choose a model"));
  if (!consent) missing.push(t("accept the data-processing notice"));
  const canEnable = missing.length === 0;

  const dirty = useMemo(() => {
    if (!state) return false;
    const s = state.settings;
    return (
      provider !== (s.provider ?? "openai") ||
      model.trim() !== (s.model ?? AI_DEFAULT_MODELS[s.provider ?? "openai"]) ||
      instructions !== (s.instructions ?? "") ||
      budgetCents !== s.monthly_budget_cents ||
      historyNum !== s.suggest_history_messages ||
      consent !== savedConsentValid ||
      enabled !== s.enabled
    );
  }, [state, provider, model, instructions, budgetCents, historyNum, consent, savedConsentValid, enabled]);

  const formValid = modelValid && historyValid && instructionsValid && budgetCents !== null;

  async function save() {
    if (!state || !formValid || budgetCents === null) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        provider,
        model: model.trim(),
        instructions,
        monthly_budget_cents: budgetCents,
        suggest_history_messages: historyNum,
        enabled: enabled && canEnable,
      };
      if (consent && !savedConsentValid) body.accept_consent = true;
      if (!consent && state.settings.consented_at) body.accept_consent = false;
      const res = await fetch("/api/ai/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res));
      seed((await res.json()) as AiState);
      invalidateAiStatus();
      toast.success(t("AI settings saved"));
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : "Failed to save the AI settings"));
    } finally {
      setSaving(false);
    }
  }

  async function saveKey() {
    if (!keyDraft.trim()) return;
    setKeyBusy("save");
    try {
      const res = await fetch("/api/ai/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, api_key: keyDraft.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as { models?: string[] };
      setAvailableModels(body.models ?? []);
      setKeyDraft("");
      setReplacingKey(false);
      toast.success(t("API key validated and saved"));
      await load();
      invalidateAiStatus();
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : "Could not save the API key"));
    } finally {
      setKeyBusy(null);
    }
  }

  async function testKey() {
    setKeyBusy("test");
    try {
      const res = await fetch("/api/ai/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as { models?: string[] };
      setAvailableModels(body.models ?? []);
      toast.success(t("The API key works"));
      await load();
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : "Could not test the API key"));
    } finally {
      setKeyBusy(null);
    }
  }

  async function removeKey() {
    if (!window.confirm(t("Remove the saved API key? AI suggestions stop working until a new key is saved."))) return;
    setKeyBusy("remove");
    try {
      const res = await fetch(`/api/ai/credentials?provider=${provider}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res));
      toast.success(t("API key removed"));
      setAvailableModels([]);
      await load();
      invalidateAiStatus();
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : "Could not remove the API key"));
    } finally {
      setKeyBusy(null);
    }
  }

  const money = useMemo(
    () => new Intl.NumberFormat(language, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    [language],
  );
  const num = useMemo(() => new Intl.NumberFormat(language), [language]);
  const dateTime = useMemo(
    () => new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }),
    [language],
  );

  const title = t("Artificial Intelligence");
  const description = t(
    "Reply suggestions in the inbox, written by the AI provider you choose with your own API key. Nothing is sent to the customer without an agent reviewing it.",
  );

  if (profileLoading) {
    return (
      <section className="max-w-4xl animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={title} />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/60" />
          ))}
        </div>
      </section>
    );
  }

  if (!canManageMembers || !moduleOn) {
    return (
      <section className="max-w-4xl animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={title} description={description} />
        <Alert className="border-border bg-card">
          <AlertTitle className="mb-1 text-foreground">
            {!moduleOn ? t("Not included in your plan") : t("Admins only")}
          </AlertTitle>
          <AlertDescription className="text-sm text-muted-foreground">
            {!moduleOn
              ? t("The AI assistant is not included in your plan.")
              : t("Only account admins can change the AI settings.")}
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  if (loadError || !state) {
    return (
      <section className="max-w-4xl animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={title} description={description} />
        {loadError ? (
          <Alert className="border-border bg-card">
            <AlertTitle className="mb-1 text-foreground">{t("Could not load the AI settings")}</AlertTitle>
            <AlertDescription className="text-sm text-muted-foreground">
              <Button size="sm" variant="outline" onClick={() => void load()}>
                {t("Try again")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/60" />
            ))}
          </div>
        )}
      </section>
    );
  }

  const modelOptions = Array.from(
    new Set([...AI_SUGGESTED_MODELS[provider], ...availableModels.filter((m) => !/embed|whisper|tts|dall-e|image|audio|moderation|realtime|transcribe/i.test(m))]),
  );
  const usage = state.usage;
  const budgetForBar = state.settings.monthly_budget_cents;
  const usedPct = budgetForBar > 0 ? Math.min(100, (usage.costCents / budgetForBar) * 100) : 100;

  return (
    <section className="max-w-4xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={title}
        description={description}
        action={
          <Button
            size="sm"
            disabled={saving || !dirty || !formValid}
            onClick={() => void save()}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Check className="mr-1.5 size-4" />}
            {t("Save")}
          </Button>
        }
      />

      <div className="grid gap-4">
        {/* Status + switch */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Sparkles className="size-4 text-primary" />
              {t("Suggest replies in the inbox")}
              {state.settings.enabled ? (
                <SettingsChip variant="ok">{t("On")}</SettingsChip>
              ) : (
                <SettingsChip variant="muted">{t("Off")}</SettingsChip>
              )}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t(
                "Agents get a “Suggest reply” button in the composer. The suggestion fills the text box; the agent edits and sends it as usual.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-3">
              <Switch
                id="ai-enabled"
                checked={enabled && canEnable}
                disabled={!canEnable}
                onCheckedChange={(v) => setEnabled(v)}
                aria-describedby="ai-enabled-hint"
              />
              <Label htmlFor="ai-enabled" className="text-foreground">
                {t("Enable AI suggestions for this account")}
              </Label>
            </div>
            <p id="ai-enabled-hint" className="text-xs text-muted-foreground">
              {canEnable
                ? t("Remember to save after changing it.")
                : `${t("To enable:")} ${missing.join(" · ")}.`}
            </p>
          </CardContent>
        </Card>

        {/* Provider + key */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <KeyRound className="size-4 text-primary" />
              {t("Provider and API key")}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t(
                "Use your own key: usage is billed by the provider to your account there. The key is stored encrypted and is never shown again — only its last 4 characters.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div role="radiogroup" aria-label={t("AI provider")} className="inline-flex rounded-lg bg-muted p-0.5">
              {AI_PROVIDERS.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={provider === p}
                  onClick={() => chooseProvider(p)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors",
                    provider === p ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {AI_PROVIDER_LABELS[p]}
                  {state.credentials.some((c) => c.provider === p) ? (
                    <Check className="size-3.5 text-emerald-500" aria-label={t("key saved")} />
                  ) : null}
                </button>
              ))}
            </div>

            {credential && !replacingKey ? (
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-card px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <div className="font-mono text-foreground" data-no-translate>
                    •••• •••• {credential.last4}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {credential.validated_at
                      ? `${t("Validated on")} ${dateTime.format(new Date(credential.validated_at))}`
                      : t("Not validated yet")}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={keyBusy !== null} onClick={() => void testKey()}>
                    {keyBusy === "test" ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                    {t("Test key")}
                  </Button>
                  <Button size="sm" variant="outline" disabled={keyBusy !== null} onClick={() => setReplacingKey(true)}>
                    {t("Replace")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={keyBusy !== null}
                    onClick={() => void removeKey()}
                    className="text-destructive hover:text-destructive"
                  >
                    {keyBusy === "remove" ? (
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="mr-1.5 size-3.5" />
                    )}
                    {t("Remove")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="ai-key" className="text-foreground">
                  {t("API key")} ({AI_PROVIDER_LABELS[provider]})
                </Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="ai-key"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={keyDraft}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"}
                    className="bg-card font-mono text-foreground"
                    data-no-translate
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="h-9"
                      disabled={!keyDraft.trim() || keyBusy !== null}
                      onClick={() => void saveKey()}
                    >
                      {keyBusy === "save" ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                      {t("Validate and save")}
                    </Button>
                    {replacingKey ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-9"
                        onClick={() => {
                          setReplacingKey(false);
                          setKeyDraft("");
                        }}
                      >
                        {t("Cancel")}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <a
                  href={AI_PROVIDER_KEY_URLS[provider]}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  {t("Get a key from the provider")}
                  <ExternalLink className="size-3" />
                </a>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Model + assistant */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Sparkles className="size-4 text-primary" />
              {t("Model and assistant")}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t(
                "A small, fast model is enough for reply suggestions and costs a fraction of a cent per suggestion.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ai-model" className="text-foreground">
                {t("Model")}
              </Label>
              <Input
                id="ai-model"
                list="ai-model-options"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                aria-invalid={!modelValid || undefined}
                spellCheck={false}
                className="bg-card font-mono text-foreground"
                data-no-translate
              />
              <datalist id="ai-model-options">
                {modelOptions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <p className="text-xs text-muted-foreground">
                {t("Suggested:")} <span data-no-translate>{AI_DEFAULT_MODELS[provider]}</span>.{" "}
                {t("You can type any other model id your key has access to.")}
              </p>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ai-budget" className="text-foreground">
                  {t("Monthly budget (US$)")}
                </Label>
                <Input
                  id="ai-budget"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  aria-invalid={budgetCents === null || undefined}
                  className="bg-card text-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ai-history" className="text-foreground">
                  {t("Messages of context")}
                </Label>
                <Input
                  id="ai-history"
                  type="number"
                  inputMode="numeric"
                  min={AI_LIMITS.historyMin}
                  max={AI_LIMITS.historyMax}
                  value={history}
                  onChange={(e) => setHistory(e.target.value)}
                  aria-invalid={!historyValid || undefined}
                  className="bg-card text-foreground"
                />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                {t("Suggestions stop when this month's estimated spend reaches the budget (São Paulo calendar month).")}
              </p>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="ai-instructions" className="text-foreground">
                {t("Instructions for the assistant")}
              </Label>
              <Textarea
                id="ai-instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={6}
                maxLength={AI_LIMITS.instructionsMaxChars}
                aria-invalid={!instructionsValid || undefined}
                placeholder={t(
                  "E.g.: Friendly and short tone. We are a bakery in Campinas, open Mon–Sat 7am–7pm. Delivery only in the city. Never quote prices — say an agent will confirm.",
                )}
                className="bg-card text-foreground"
              />
              <p className="text-xs text-muted-foreground">
                {t("Tone, what the company does, what the assistant may and may not say.")}{" "}
                <span data-no-translate>
                  {instructions.length}/{AI_LIMITS.instructionsMaxChars}
                </span>
              </p>
            </div>
          </CardContent>
        </Card>

        {/* LGPD */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <ShieldCheck className="size-4 text-primary" />
              {t("Data processing (LGPD)")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t(
                "When an agent asks for a suggestion, the latest messages of that conversation, the contact's name, your company name and the instructions above are sent to the chosen provider, which may process them outside Brazil (international data transfer, LGPD art. 33). The CRM does not store the suggestion text — only usage counters (tokens and cost). Make sure your privacy notice covers this use and that you have a legal basis for it.",
              )}
            </p>
            <label className="flex items-start gap-2.5 text-sm text-foreground">
              <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} className="mt-0.5" />
              <span>
                {t("I have read the notice and authorise sending conversation data to")}{" "}
                <strong>{AI_PROVIDER_LABELS[provider]}</strong>.
              </span>
            </label>
            {savedConsentValid && state.settings.consented_at ? (
              <p className="text-xs text-muted-foreground">
                {t("Accepted by")} {state.settings.consented_by_name ?? t("an admin")} ·{" "}
                {dateTime.format(new Date(state.settings.consented_at))}
              </p>
            ) : null}
          </CardContent>
        </Card>

        {/* Usage */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <BarChart3 className="size-4 text-primary" />
              {t("Usage this month")} <span className="font-normal text-muted-foreground" data-no-translate>({usage.month})</span>
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t("Estimated from the provider's list prices; the provider's invoice is the source of truth.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: t("Suggestions"), value: num.format(usage.calls) },
                { label: t("Errors"), value: num.format(usage.errors) },
                { label: t("Tokens (in / out)"), value: `${num.format(usage.inputTokens)} / ${num.format(usage.outputTokens)}` },
                { label: t("Estimated cost"), value: money.format(usage.costCents / 100) },
              ].map((item) => (
                <div key={item.label} className="rounded-lg border border-border bg-card px-3 py-2">
                  <dt className="text-xs text-muted-foreground">{item.label}</dt>
                  <dd className="mt-0.5 text-sm font-semibold text-foreground" data-no-translate>
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>
            <div>
              <div
                className="h-2 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label={t("Budget used")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(usedPct)}
              >
                <div
                  className={cn("h-full rounded-full", usedPct >= 100 ? "bg-destructive" : usedPct >= 80 ? "bg-amber-500" : "bg-primary")}
                  style={{ width: `${usedPct}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {money.format(usage.costCents / 100)} {t("of")} {money.format(budgetForBar / 100)}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Knowledge base (migration 063) */}
        <AiKnowledge />
      </div>
    </section>
  );
}
