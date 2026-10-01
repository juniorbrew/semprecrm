"use client";

import { useSyncExternalStore } from "react";
import type { InboxCounts } from "@/lib/inbox/list-query";
import type { InboxTab } from "@/lib/inbox/triage";
import type { RadarKey } from "@/lib/radar/classify";

/**
 * What the open inbox list shows (tab, Radar bucket, server counts), shared
 * with the sidebar's inbox shortcuts. The list publishes; nobody else
 * queries — the sidebar reuses the counts the list already fetched.
 * `null` while no inbox list is mounted.
 */
export interface InboxNavSummary {
  tab: InboxTab;
  radar: RadarKey | null;
  /** null until the first `inbox_counts` answer arrives. */
  counts: InboxCounts | null;
}

let current: InboxNavSummary | null = null;
const listeners = new Set<() => void>();

export function publishInboxNav(next: InboxNavSummary | null): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useInboxNav(): InboxNavSummary | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
