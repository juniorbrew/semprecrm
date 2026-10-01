"use client";

import { useCallback, useEffect, useState } from "react";

/** Pre-redesign key (one value for every user of the browser); still read as a fallback. */
const LEGACY_KEY = "wacrm:inbox:contact-panel-open";

export function contactPanelKey(userId: string): string {
  return `sempre:inbox:contact-panel-open:${userId}`;
}

/** Remembered visibility for this user; `true` when unknown or storage is blocked. */
export function readContactPanelOpen(userId: string | null | undefined): boolean {
  try {
    const stored =
      (userId ? window.localStorage.getItem(contactPanelKey(userId)) : null) ??
      window.localStorage.getItem(LEGACY_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

export function writeContactPanelOpen(userId: string | null | undefined, open: boolean): void {
  try {
    window.localStorage.setItem(userId ? contactPanelKey(userId) : LEGACY_KEY, String(open));
  } catch {
    /* remembering is a convenience only */
  }
}

/**
 * Contact panel shown/hidden, remembered per user. Starts `true` on the
 * server and reconciles after mount (reading storage in the initializer
 * would be a hydration mismatch).
 */
export function useContactPanelOpen(userId: string | null | undefined) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    setOpen(readContactPanelOpen(userId));
  }, [userId]);
  const toggle = useCallback(() => {
    setOpen((prev) => {
      writeContactPanelOpen(userId, !prev);
      return !prev;
    });
  }, [userId]);
  return [open, toggle] as const;
}
