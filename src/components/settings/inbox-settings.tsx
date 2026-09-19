"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Ban, Loader2, Snowflake, Timer, X } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import {
  normalizeOptOutKeyword,
  PREFERENCE_LIMITS,
} from "@/lib/account-preferences";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { BusinessHours } from "@/types";
import { SettingsPanelHead } from "./settings-panel-head";
import {
  AutoAssignCard,
  BusinessHoursEditor,
  OutOfHoursCard,
  businessHoursValid,
} from "./business-hours-editor";

/**
 * Settings → Atendimento (spec §3 / §5): the account's inbox SLA, the
 * "cooling" threshold and the opt-out stop words. All three live in
 * `accounts.preferences` (jsonb, migration 030); `accounts_update` RLS
 * (017) already limits writes to admin+, so everyone else sees the
 * values read-only.
 */
export function InboxSettings() {
  const { t } = useLanguage();
  const { account, preferences, canEditSettings, profileLoading, refreshAccount } =
    useAuth();

  const [sla, setSla] = useState(String(preferences.inbox_sla_minutes));
  const [cooling, setCooling] = useState(String(preferences.cooling_hours));
  const [keywords, setKeywords] = useState<string[]>(preferences.opt_out_keywords);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [saving, setSaving] = useState(false);
  // Availability (spec round 2 §2)
  const [businessHours, setBusinessHours] = useState<BusinessHours>(preferences.business_hours);
  const [oohEnabled, setOohEnabled] = useState(preferences.out_of_hours_enabled);
  const [oohMessage, setOohMessage] = useState(preferences.out_of_hours_message);
  const [autoAssign, setAutoAssign] = useState(preferences.auto_assign_enabled);

  // Re-seed the form when the account row (re)loads — e.g. after another
  // admin saved, or on first render before the profile resolved.
  useEffect(() => {
    setSla(String(preferences.inbox_sla_minutes));
    setCooling(String(preferences.cooling_hours));
    setKeywords(preferences.opt_out_keywords);
    setBusinessHours(preferences.business_hours);
    setOohEnabled(preferences.out_of_hours_enabled);
    setOohMessage(preferences.out_of_hours_message);
    setAutoAssign(preferences.auto_assign_enabled);
  }, [preferences]);

  const slaNum = Number(sla);
  const coolingNum = Number(cooling);
  const slaValid =
    Number.isFinite(slaNum) &&
    slaNum >= PREFERENCE_LIMITS.inbox_sla_minutes.min &&
    slaNum <= PREFERENCE_LIMITS.inbox_sla_minutes.max;
  const coolingValid =
    Number.isFinite(coolingNum) &&
    coolingNum >= PREFERENCE_LIMITS.cooling_hours.min &&
    coolingNum <= PREFERENCE_LIMITS.cooling_hours.max;

  const hoursValid = businessHoursValid(businessHours);
  const oohValid = !oohEnabled || oohMessage.trim().length > 0;

  const dirty = useMemo(
    () =>
      slaNum !== preferences.inbox_sla_minutes ||
      coolingNum !== preferences.cooling_hours ||
      keywords.join(" ") !== preferences.opt_out_keywords.join(" ") ||
      JSON.stringify(businessHours) !== JSON.stringify(preferences.business_hours) ||
      oohEnabled !== preferences.out_of_hours_enabled ||
      oohMessage !== preferences.out_of_hours_message ||
      autoAssign !== preferences.auto_assign_enabled,
    [slaNum, coolingNum, keywords, businessHours, oohEnabled, oohMessage, autoAssign, preferences],
  );

  const disabled = profileLoading || !canEditSettings;

  function addKeyword(raw: string) {
    const k = normalizeOptOutKeyword(raw);
    if (!k) return;
    if (keywords.includes(k)) {
      setKeywordDraft("");
      return;
    }
    if (keywords.length >= PREFERENCE_LIMITS.opt_out_keywords_max) {
      toast.error(t("Keyword limit reached"));
      return;
    }
    setKeywords((prev) => [...prev, k]);
    setKeywordDraft("");
  }

  function onKeywordKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      if (keywordDraft.trim()) {
        e.preventDefault();
        addKeyword(keywordDraft);
      }
    } else if (e.key === "Backspace" && !keywordDraft && keywords.length > 0) {
      setKeywords((prev) => prev.slice(0, -1));
    }
  }

  async function save() {
    if (!account?.id || !slaValid || !coolingValid || !hoursValid || !oohValid) return;
    setSaving(true);
    try {
      // Saved through the API so the change is audited
      // (`preferences.updated`); the route merges over the live row so
      // keys owned by other features survive.
      const res = await fetch("/api/account/preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inbox_sla_minutes: slaNum,
          cooling_hours: coolingNum,
          opt_out_keywords: keywordDraft.trim()
            ? [...keywords, normalizeOptOutKeyword(keywordDraft) ?? ""].filter(Boolean)
            : keywords,
          business_hours: businessHours,
          out_of_hours_enabled: oohEnabled,
          out_of_hours_message: oohMessage,
          auto_assign_enabled: autoAssign,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setKeywordDraft("");
      await refreshAccount();
      toast.success(t("Service settings saved"));
    } catch (err) {
      console.error("[inbox-settings] save failed:", err);
      toast.error(t("Failed to save service settings"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("Service")}
        description={t(
          "Response-time limits behind the Radar, business hours, automatic distribution and the words a customer can send to stop receiving messages.",
        )}
      />

      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Timer className="size-4 text-primary" />
              {t("Response times")}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t(
                "Waiting means the customer has gone unanswered for longer than the SLA; cooling means the customer has not replied to you for the given hours.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="inbox-sla" className="text-foreground">
                {t("Reply SLA (minutes)")}
              </Label>
              <Input
                id="inbox-sla"
                type="number"
                inputMode="numeric"
                min={PREFERENCE_LIMITS.inbox_sla_minutes.min}
                max={PREFERENCE_LIMITS.inbox_sla_minutes.max}
                value={sla}
                onChange={(e) => setSla(e.target.value)}
                disabled={disabled}
                aria-invalid={!slaValid || undefined}
                className="bg-card text-foreground"
              />
              <p className="text-xs text-muted-foreground">
                {slaValid
                  ? t("Customers waiting longer than this appear under “Waiting”.")
                  : `${t("Enter a value between")} ${PREFERENCE_LIMITS.inbox_sla_minutes.min} ${t("and")} ${PREFERENCE_LIMITS.inbox_sla_minutes.max}.`}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="inbox-cooling" className="flex items-center gap-1.5 text-foreground">
                <Snowflake className="size-3.5 text-sky-500" />
                {t("Cooling after (hours)")}
              </Label>
              <Input
                id="inbox-cooling"
                type="number"
                inputMode="numeric"
                min={PREFERENCE_LIMITS.cooling_hours.min}
                max={PREFERENCE_LIMITS.cooling_hours.max}
                value={cooling}
                onChange={(e) => setCooling(e.target.value)}
                disabled={disabled}
                aria-invalid={!coolingValid || undefined}
                className="bg-card text-foreground"
              />
              <p className="text-xs text-muted-foreground">
                {coolingValid
                  ? t("Silence after your last message for this long marks the conversation as cooling.")
                  : `${t("Enter a value between")} ${PREFERENCE_LIMITS.cooling_hours.min} ${t("and")} ${PREFERENCE_LIMITS.cooling_hours.max}.`}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Ban className="size-4 text-primary" />
              {t("Opt-out words")}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t(
                "When a customer sends exactly one of these words (accents and punctuation ignored), the contact is marked as opted out: automations stop messaging them and broadcasts skip them. An admin can reactivate the contact from the inbox panel.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div
              className={cn(
                "flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1.5",
                disabled && "opacity-70",
              )}
              onClick={() => document.getElementById("opt-out-keyword-input")?.focus()}
            >
              {keywords.map((k) => (
                <span
                  key={k}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
                >
                  {k}
                  {!disabled && (
                    <button
                      type="button"
                      aria-label={`${t("Remove")} ${k}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setKeywords((prev) => prev.filter((x) => x !== k));
                      }}
                      className="rounded-full text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </span>
              ))}
              <input
                id="opt-out-keyword-input"
                value={keywordDraft}
                onChange={(e) => setKeywordDraft(e.target.value)}
                onKeyDown={onKeywordKeyDown}
                onBlur={() => keywordDraft.trim() && addKeyword(keywordDraft)}
                disabled={disabled}
                placeholder={keywords.length === 0 ? t("Type a word and press Enter") : ""}
                aria-label={t("Add opt-out word")}
                className="min-w-24 flex-1 bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {keywords.length === 0
                ? t("No words — opt-out by message is off for this account.")
                : t("Press Enter or comma to add a word; Backspace removes the last one.")}
            </p>
          </CardContent>
        </Card>

        <BusinessHoursEditor value={businessHours} onChange={setBusinessHours} disabled={disabled} />

        <OutOfHoursCard
          enabled={oohEnabled}
          message={oohMessage}
          onEnabledChange={setOohEnabled}
          onMessageChange={setOohMessage}
          disabled={disabled}
        />

        <AutoAssignCard enabled={autoAssign} onEnabledChange={setAutoAssign} disabled={disabled} />

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {!canEditSettings && !profileLoading
              ? t("Only admins can change service settings.")
              : null}
          </p>
          <Button
            onClick={save}
            disabled={
              disabled ||
              saving ||
              !slaValid ||
              !coolingValid ||
              !hoursValid ||
              !oohValid ||
              (!dirty && !keywordDraft.trim())
            }
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t("Save changes")}
          </Button>
        </div>
      </div>
    </section>
  );
}
