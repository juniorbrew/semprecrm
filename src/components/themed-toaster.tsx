"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Toaster } from "sonner";

import { useLanguage } from "@/hooks/use-language";
import { useTheme } from "@/hooks/use-theme";
import { DEFAULT_MODE } from "@/lib/themes";

// Returns false during SSR and the first hydration render, true after —
// the sanctioned (warning-free, no setState-in-effect) way to diverge
// server vs client. Lets us match the server-rendered default on first
// paint, then adopt the real mode.
const noopSubscribe = () => () => {};
function useIsClient() {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * Toaster wrapper that tracks the active light/dark mode.
 *
 * Lives inside <ThemeProvider> (see layout.tsx) so it can read the
 * current mode and hand it to sonner. Colors are driven off the same
 * CSS tokens as the rest of the app, so a toast looks at home in
 * either mode without a second palette to maintain.
 *
 * The theme is gated behind `useIsClient`: the server renders
 * DEFAULT_MODE, so first client paint must too, otherwise a light-mode
 * user hydrates with a different sonner `theme` attribute than the
 * server emitted and React logs a hydration mismatch.
 */
export function ThemedToaster() {
  const { mode } = useTheme();
  const { t, language } = useLanguage();
  const isClient = useIsClient();
  // Sonner's live region keeps whatever label it was born with, and the
  // first paint can race the language read; pin the label explicitly.
  useEffect(() => {
    const label = `${t("Notifications")} alt+T`;
    document
      .querySelectorAll("section[aria-live][aria-label]")
      .forEach((el) => el.setAttribute("aria-label", label));
  }, [t, language]);
  return (
    <Toaster
      // Sonner sets its container attributes once; remount on language change.
      key={language}
      theme={isClient ? mode : DEFAULT_MODE}
      position="top-right"
      // Sonner labels its live region "Notifications alt+T" by default;
      // screen readers read it on every page.
      containerAriaLabel={t("Notifications")}
      hotkey={["altKey", "KeyT"]}
      toastOptions={{
        style: {
          background: "var(--popover)",
          border: "1px solid var(--border)",
          color: "var(--popover-foreground)",
        },
      }}
    />
  );
}
