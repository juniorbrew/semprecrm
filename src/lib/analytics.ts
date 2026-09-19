// ============================================================
// Thin wrapper around window.gtag for the marketing site's
// conversion events. No-ops if GA4 isn't loaded (no env var set,
// script blocked, or called from the server) — callers never
// need to check first.
// ============================================================

type Gtag = (...args: unknown[]) => void;

export function trackEvent(name: string, params?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const gtag = (window as unknown as { gtag?: Gtag }).gtag;
  if (typeof gtag !== "function") return;
  gtag("event", name, params);
}
