"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import { cn } from "@/lib/utils";
import type { Availability } from "@/types";

/** Green (available) / grey (away) status dot shared by header and roster. */
export function AvailabilityDot({
  availability,
  className,
}: {
  availability: Availability | null | undefined;
  className?: string;
}) {
  const away = availability === "away";
  return (
    <span
      aria-hidden
      data-availability={away ? "away" : "available"}
      className={cn(
        "inline-block size-2.5 rounded-full ring-2 ring-background",
        away ? "bg-zinc-400 dark:bg-zinc-500" : "bg-emerald-500",
        className,
      )}
    />
  );
}

/**
 * "Disponível / Ausente" switch for the header user menu. Persists
 * `profiles.availability` (migration 033) on the caller's own row —
 * `profiles_update` RLS already allows it — then refreshes the auth
 * context so the dot updates everywhere. Away members are skipped by the
 * round-robin distribution.
 */
export function AvailabilityToggle() {
  const { t } = useLanguage();
  const { user, profile, refreshProfile } = useAuth();
  const [saving, setSaving] = useState(false);

  const current: Availability = profile?.availability === "away" ? "away" : "available";

  async function setAvailability(next: Availability) {
    if (!user || next === current || saving) return;
    setSaving(true);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("profiles")
        .update({ availability: next, availability_changed_at: new Date().toISOString() })
        .eq("user_id", user.id);
      if (error) throw error;
      await refreshProfile();
      toast.success(next === "away" ? t("You are now away") : t("You are now available"));
    } catch (err) {
      console.error("[availability] update failed:", err);
      toast.error(t("Failed to update availability"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={t("Availability")}
      className="flex items-center gap-1 rounded-md bg-muted/60 p-0.5"
    >
      {(["available", "away"] as Availability[]).map((value) => {
        const active = current === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={saving}
            onClick={(e) => {
              // Keep the dropdown open — this is a toggle, not a navigation.
              e.preventDefault();
              e.stopPropagation();
              void setAvailability(value);
            }}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {saving && active ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <AvailabilityDot availability={value} className="ring-0" />
            )}
            {value === "available" ? t("Available") : t("Away")}
          </button>
        );
      })}
    </div>
  );
}
