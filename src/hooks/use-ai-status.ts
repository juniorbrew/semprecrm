"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";

/** Why AI is unavailable for the account (GET /api/ai/status). */
export type AiUnavailableReason = "module" | "disabled" | "no_key";

export interface AiStatus {
  available: boolean;
  reason: AiUnavailableReason | null;
}

const TTL_MS = 60_000;

// One cached answer per account, shared by every composer on the page,
// so switching conversations doesn't refetch. Settings → IA calls
// `invalidateAiStatus()` after a change so the inbox picks it up.
let cache: { accountId: string; at: number; value: AiStatus } | null = null;
let inflight: { accountId: string; promise: Promise<AiStatus> } | null = null;
const listeners = new Set<() => void>();

async function fetchStatus(accountId: string): Promise<AiStatus> {
  if (cache && cache.accountId === accountId && Date.now() - cache.at < TTL_MS) return cache.value;
  if (inflight && inflight.accountId === accountId) return inflight.promise;
  const promise = (async () => {
    try {
      const res = await fetch("/api/ai/status", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as Partial<AiStatus> | null;
      const value: AiStatus = res.ok && body
        ? { available: body.available === true, reason: (body.reason as AiUnavailableReason | null) ?? null }
        : { available: false, reason: "disabled" };
      cache = { accountId, at: Date.now(), value };
      return value;
    } catch {
      return { available: false, reason: "disabled" } as AiStatus;
    } finally {
      inflight = null;
    }
  })();
  inflight = { accountId, promise };
  return promise;
}

export function invalidateAiStatus(): void {
  cache = null;
  for (const l of listeners) l();
}

/** `null` while loading (the button stays disabled). */
export function useAiStatus(): AiStatus | null {
  const { accountId } = useAuth();
  const [state, setState] = useState<{ accountId: string; value: AiStatus } | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const l = () => setVersion((v) => v + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    void fetchStatus(accountId).then((value) => {
      if (alive) setState({ accountId, value });
    });
    return () => {
      alive = false;
    };
  }, [accountId, version]);

  return state && state.accountId === accountId ? state.value : null;
}
