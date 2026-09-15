"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { useEntitlements } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import type { Module } from "@/lib/plans";

/**
 * Where a visitor lands when the module they asked for is off.
 * `/dashboard` for everything except the dashboard module itself —
 * redirecting a disabled dashboard to `/dashboard` would loop, so
 * that one goes to the (always-on) inbox.
 */
export function moduleFallbackHref(module: Module): string {
  return module === "dashboard" ? "/inbox" : "/dashboard";
}

/**
 * useRequireModule — client-side page guard.
 *
 * Returns `true` once the account's entitlements are known AND the
 * module is on. While the profile is still loading it returns
 * `false` (render a spinner, not the page). When the module is off
 * it toasts "Module not included in your plan" and replaces the
 * route with the fallback.
 *
 * Every module page is a client component, so this hook (via the
 * `<ModuleGuard>` in each module's `layout.tsx`) is the page-level
 * guard the spec calls for. The API routes and engines re-check
 * server-side — this is UX, not security.
 */
export function useRequireModule(module: Module): boolean {
  const { ready, modules } = useEntitlements();
  const router = useRouter();
  const { t } = useLanguage();
  const allowed = modules[module];
  // One toast per denial — React 19 StrictMode double-invokes
  // effects in dev, and a re-render during the redirect would
  // otherwise stack duplicates.
  const firedRef = useRef(false);

  useEffect(() => {
    if (!ready || allowed) {
      firedRef.current = false;
      return;
    }
    if (firedRef.current) return;
    firedRef.current = true;
    toast.error(t("Module not included in your plan"));
    router.replace(moduleFallbackHref(module));
  }, [ready, allowed, module, router, t]);

  return ready && allowed;
}

/**
 * Wraps a module's route subtree. Drop one in the module's
 * `layout.tsx` so every nested page (`/broadcasts/new`,
 * `/automations/[id]`, …) is covered without touching feature code.
 */
export function ModuleGuard({
  module,
  children,
}: {
  module: Module;
  children: ReactNode;
}) {
  const ok = useRequireModule(module);
  if (!ok) {
    return (
      <div className="flex h-full min-h-[40vh] items-center justify-center">
        <div
          className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"
          role="status"
          aria-label="Loading"
        />
      </div>
    );
  }
  return <>{children}</>;
}
