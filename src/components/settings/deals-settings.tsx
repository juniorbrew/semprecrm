"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import { CURRENCIES } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LossReasonsSettings } from "./loss-reasons-settings";
import { SettingsGroup } from "./settings-group";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Deals settings — account-wide default currency.
 *
 * One currency per account (issue #218): the chosen code seeds new
 * deals and formats every aggregated total. Existing deals keep their
 * own saved currency. Writes go straight to `accounts.default_currency`;
 * the `accounts_update` RLS policy (017) already restricts that to
 * admins+, so non-admins see a disabled, read-only control.
 */
export function DealsSettings() {
  const supabase = createClient();
  const { t } = useLanguage();
  const {
    accountId,
    defaultCurrency,
    canEditSettings,
    profileLoading,
    refreshProfile,
  } = useAuth();

  const [selected, setSelected] = useState(defaultCurrency);
  const [saving, setSaving] = useState(false);

  // Keep the select in sync once the profile (and its account default)
  // resolves, and after a save round-trips through refreshProfile.
  useEffect(() => {
    setSelected(defaultCurrency);
  }, [defaultCurrency]);

  const dirty = selected !== defaultCurrency;

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    const { error } = await supabase
      .from("accounts")
      .update({ default_currency: selected })
      .eq("id", accountId);
    if (error) {
      toast.error("Failed to save default currency");
      setSaving(false);
      return;
    }
    // Pull the new value back into the auth context so the deal form
    // and every total pick it up without a full reload.
    await refreshProfile();
    setSaving(false);
    toast.success("Default currency updated");
  }

  return (
    <section className="max-w-2xl">
      <SettingsPanelHead
        title="Negócios e moeda"
        description="The currency used for new deals and for pipeline and dashboard totals, and the reasons a deal can be marked as lost."
      />
      <div className="space-y-8">
        <SettingsGroup
          title="Default currency"
          description="New deals default to this currency, and pipeline and dashboard totals are shown in it. Existing deals keep the currency they were saved with."
        >
            <div className="grid gap-2 sm:max-w-xs">
              <Label htmlFor="deals-default-currency">{t("Currency")}</Label>
              <select
                id="deals-default-currency"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                disabled={!canEditSettings || profileLoading}
                className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} — {c.label}
                  </option>
                ))}
              </select>
              {!canEditSettings && (
                <p className="text-xs text-muted-foreground">
                  Only account admins can change the default currency.
                </p>
              )}
            </div>

            {canEditSettings && (
              <div className="flex pt-2">
                <Button onClick={handleSave} disabled={saving || !dirty}>
                  {saving ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Salvar"
                  )}
                </Button>
              </div>
            )}
        </SettingsGroup>

        <LossReasonsSettings />
      </div>
    </section>
  );
}
