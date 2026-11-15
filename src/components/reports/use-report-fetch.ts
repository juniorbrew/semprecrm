"use client";

import { useEffect, useState } from "react";

/**
 * One report question and its answer. Pass a `load` memoised on what it depends on (period, account,
 * time zone): it runs again when it changes or on retry(). While the new answer is on its way the old
 * data stays (the caller dims it with `loading`); `failed` means the current question failed.
 */
export function useReportFetch<T>(enabled: boolean, load: () => Promise<T>) {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ load: () => Promise<T>; tick: number; data: T | null } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    load()
      .then((data) => !cancelled && setResult({ load, tick, data }))
      .catch((err) => {
        console.error("[reports] section failed:", err instanceof Error ? err.message : "error");
        if (!cancelled) setResult({ load, tick, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, load, tick]);

  const answered = result?.load === load && result.tick === tick;
  return {
    data: result?.data ?? null,
    failed: answered && result.data === null,
    loading: enabled && !answered,
    retry: () => setTick((n) => n + 1),
  };
}
