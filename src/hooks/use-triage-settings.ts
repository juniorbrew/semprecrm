"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";

export interface TriageSettings {
  /** AI is on for the account. */
  aiEnabled: boolean;
  /** The admin turned triage on (migration 071). Only effective with `aiEnabled`. */
  triageEnabled: boolean;
  loaded: boolean;
}

const CHANGED = "semprecrm:triage-settings-changed";

export function notifyTriageSettingsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGED));
}

/** `ai_settings.enabled` + `triage_enabled` (members can read the row through RLS). */
export function useTriageSettings(): TriageSettings & { refresh: () => void } {
  const { accountId } = useAuth();
  const [state, setState] = useState<TriageSettings>({ aiEnabled: false, triageEnabled: false, loaded: false });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    window.addEventListener(CHANGED, refresh);
    return () => window.removeEventListener(CHANGED, refresh);
  }, [refresh]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    createClient()
      .from("ai_settings")
      .select("enabled, triage_enabled")
      .eq("account_id", accountId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.error("Failed to load triage settings:", error.message);
        const row = data as { enabled?: boolean; triage_enabled?: boolean } | null;
        setState({ aiEnabled: !!row?.enabled, triageEnabled: !!row?.triage_enabled, loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, tick]);

  return { ...state, refresh };
}
