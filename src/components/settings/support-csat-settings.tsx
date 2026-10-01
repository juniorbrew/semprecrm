"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import { createClient } from "@/lib/supabase/client";
import {
  CSAT_LIMITS,
  CSAT_MESSAGE_DEFAULTS,
  CSAT_RESOLUTIONS,
  csatCopy,
  parseCsatSettings,
  type CsatScale,
  type CsatSettings,
} from "@/lib/support/csat";
import { supportCopy } from "@/lib/support/model";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SettingsGroup } from "./settings-group";

const SELECT_CLASS =
  "h-8 rounded-md border border-border bg-transparent px-2 text-sm text-foreground disabled:opacity-60";

/**
 * Settings → Suporte → Pesquisa de satisfação (migration 074). One row per
 * account in `csat_settings` (RLS: members read, admins write; the UI mirrors
 * it). Switches and selects save at once, text and numbers when they lose
 * focus, like the rest of the page.
 */
export function CsatSettings({ readOnly }: { readOnly: boolean }) {
  const { language } = useLanguage();
  const copy = csatCopy(language);
  const resolutionNames = supportCopy(language).resolutions;
  const { accountId } = useAuth();
  const [settings, setSettings] = useState<CsatSettings | null>(null);
  const saved = useRef("");

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    createClient()
      .from("csat_settings")
      .select("*")
      .eq("account_id", accountId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.error(error);
        const loaded = parseCsatSettings(data);
        saved.current = JSON.stringify(loaded);
        setSettings(loaded);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  async function commit(next: CsatSettings) {
    if (!accountId) return;
    if (JSON.stringify(next) === saved.current) return;
    const { error } = await createClient()
      .from("csat_settings")
      .upsert({ account_id: accountId, ...next }, { onConflict: "account_id" });
    if (error) {
      console.error(error);
      toast.error(copy.saveFailed);
      return;
    }
    saved.current = JSON.stringify(next);
  }

  /** Change one or more fields; `save` writes right away (switch, select, checkbox). */
  function change(patch: Partial<CsatSettings>, save: boolean) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    if (save) void commit(next);
  }

  function changeScale(scale: CsatScale) {
    if (!settings) return;
    // The text still being the other scale's default: follow the scale.
    const untouched = settings.message_text === CSAT_MESSAGE_DEFAULTS[settings.scale];
    change({ scale, ...(untouched ? { message_text: CSAT_MESSAGE_DEFAULTS[scale] } : {}) }, true);
  }

  function toggleSkip(resolution: string, on: boolean) {
    if (!settings) return;
    const rest = settings.skip_resolutions.filter((r) => r !== resolution);
    change({ skip_resolutions: on ? [...rest, resolution] : rest }, true);
  }

  const disabled = readOnly || !settings;
  const number = (value: string, min: number, max: number, fallback: number) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };

  return (
    <SettingsGroup
      title={<span id="csat-enabled">{copy.title}</span>}
      description={copy.intro}
      action={
        <Switch
          checked={settings?.enabled ?? false}
          disabled={disabled}
          onCheckedChange={(v) => change({ enabled: Boolean(v) }, true)}
          aria-labelledby="csat-enabled"
        />
      }
    >
      {settings?.enabled && (
        <div className="max-w-2xl space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="csat-scale">{copy.scale}</Label>
            <select
              id="csat-scale"
              value={settings.scale}
              disabled={disabled}
              onChange={(e) => changeScale(e.target.value as CsatScale)}
              className={SELECT_CLASS}
            >
              {(["stars5", "thumbs"] as const).map((s) => (
                <option key={s} value={s}>
                  {copy.scaleOptions[s]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="csat-message">{copy.message}</Label>
            <Textarea
              id="csat-message"
              value={settings.message_text}
              disabled={disabled}
              maxLength={CSAT_LIMITS.message_text}
              rows={2}
              onChange={(e) => change({ message_text: e.target.value }, false)}
              onBlur={() => {
                // An emptied message goes back to the default of the scale.
                const text = settings.message_text.trim() || CSAT_MESSAGE_DEFAULTS[settings.scale];
                change({ message_text: text }, true);
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="csat-thanks">{copy.thanks}</Label>
            <Input
              id="csat-thanks"
              value={settings.thanks_text}
              disabled={disabled}
              maxLength={CSAT_LIMITS.thanks_text}
              className="h-8"
              onChange={(e) => change({ thanks_text: e.target.value }, false)}
              onBlur={() => void commit(settings)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          </div>

          <div className="flex items-center gap-2 text-sm">
            <Label htmlFor="csat-delay" className="font-normal">
              {copy.delay}
            </Label>
            <Input
              id="csat-delay"
              inputMode="numeric"
              value={String(settings.delay_minutes)}
              disabled={disabled}
              className="h-8 w-16 px-2 tabular-nums"
              onChange={(e) =>
                change(
                  { delay_minutes: number(e.target.value, CSAT_LIMITS.delay_minutes.min, CSAT_LIMITS.delay_minutes.max, settings.delay_minutes) },
                  false,
                )
              }
              onBlur={() => void commit(settings)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <span className="text-muted-foreground">{copy.minutes}</span>
          </div>

          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="csat-comment" className="font-normal">
              {copy.askComment}
            </Label>
            <Switch
              id="csat-comment"
              checked={settings.ask_comment}
              disabled={disabled}
              onCheckedChange={(v) => change({ ask_comment: Boolean(v) }, true)}
            />
          </div>

          <div className="flex items-center gap-2 text-sm">
            <Label htmlFor="csat-cooldown" className="font-normal">
              {copy.cooldown}
            </Label>
            <Input
              id="csat-cooldown"
              inputMode="numeric"
              value={String(settings.cooldown_days)}
              disabled={disabled}
              className="h-8 w-16 px-2 tabular-nums"
              onChange={(e) =>
                change(
                  { cooldown_days: number(e.target.value, CSAT_LIMITS.cooldown_days.min, CSAT_LIMITS.cooldown_days.max, settings.cooldown_days) },
                  false,
                )
              }
              onBlur={() => void commit(settings)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <span className="text-muted-foreground">{copy.days}</span>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm text-foreground">{copy.skip}</legend>
            {CSAT_RESOLUTIONS.map((r) => (
              <div key={r} className="flex items-center gap-2 text-sm">
                <Checkbox
                  id={`csat-skip-${r}`}
                  checked={settings.skip_resolutions.includes(r)}
                  disabled={disabled}
                  onCheckedChange={(v) => toggleSkip(r, Boolean(v))}
                />
                <Label htmlFor={`csat-skip-${r}`} className="font-normal">
                  {resolutionNames[r]}
                </Label>
              </div>
            ))}
          </fieldset>
        </div>
      )}
      {readOnly && <p className="text-xs text-muted-foreground">{copy.readOnly}</p>}
    </SettingsGroup>
  );
}
