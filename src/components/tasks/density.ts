"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";

/**
 * Row / card density for Tarefas, Agenda and Chat, per user on this
 * device (`sempre:<area>:density:<userId>`), like the inbox, contacts
 * and pipelines. Storage is best-effort: a blocked localStorage falls
 * back to "comfortable".
 */
export type Density = "comfortable" | "compact";
export type DensityArea = "tasks" | "agenda" | "chat";

export function densityKey(area: DensityArea, userId: string): string {
  return `sempre:${area}:density:${userId}`;
}

export function readDensity(area: DensityArea, userId: string): Density {
  try {
    return localStorage.getItem(densityKey(area, userId)) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

export function writeDensity(area: DensityArea, userId: string, density: Density): void {
  try {
    localStorage.setItem(densityKey(area, userId), density);
  } catch {
    // Persistence is best-effort.
  }
}

/** `[density, toggle]` for the signed-in user. Read after mount (no hydration mismatch). */
export function useDensity(area: DensityArea): [Density, () => void] {
  const userId = useAuth().user?.id;
  const [density, setDensity] = useState<Density>("comfortable");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (userId) setDensity(readDensity(area, userId));
  }, [area, userId]);
  const toggle = useCallback(() => {
    setDensity((d) => {
      const next: Density = d === "compact" ? "comfortable" : "compact";
      if (userId) writeDensity(area, userId, next);
      return next;
    });
  }, [area, userId]);
  return [density, toggle];
}
