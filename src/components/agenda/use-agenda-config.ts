"use client";

import { useCallback, useEffect, useState } from "react";

import type { AgendaConfig } from "@/lib/agenda/types";

/** Fetch an /api/agenda/* endpoint; throws the API's pt-BR error message. */
export async function agendaFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(body.error ?? "Não foi possível concluir. Tente novamente.");
  return body;
}

/** Services, professionals, hours and rules of the account (GET /api/agenda/config). */
export function useAgendaConfig(enabled = true) {
  const [config, setConfig] = useState<AgendaConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);

  const reload = useCallback(async () => {
    try {
      setConfig(await agendaFetch<AgendaConfig>("/api/agenda/config"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [enabled, reload]);

  return { config, error, loading, reload };
}
