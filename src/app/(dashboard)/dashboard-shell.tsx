"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AuthProvider, useAuth, useEntitlements } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { BlockedScreen } from "@/components/plans/blocked-screen";
import { MfaRequiredNotice } from "@/components/settings/mfa-card";
import { isMfaEnrollAllowedPath, MFA_ENROLL_PATH, mustEnrollMfa } from "@/lib/auth/mfa";
import { useBranding } from "@/hooks/use-branding";
import { useLanguage } from "@/hooks/use-language";
import { usePushRegistration } from "@/hooks/use-push-registration";
import { ChatPresenceProvider } from "@/components/chat/presence-provider";
import { brandingCssVars } from "@/lib/branding";
import { getPageTitle } from "@/components/layout/header";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const {
    user,
    loading,
    profileLoading,
    accountRole,
    preferences,
    mfaReady,
    hasVerifiedMfa,
  } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { ready: entitlementsReady, blocked, modules } = useEntitlements();

  // White-label (spec round 2 §6): the account's primary colour
  // overrides the theme's --primary / --ring on the shell root only
  // when the module is on; light/dark mode and the rest of the accent
  // theme keep working underneath.
  const branding = useBranding();
  const { language } = useLanguage();
  const brandStyle = useMemo(
    () => brandingCssVars(branding.enabled ? branding.primary_color : null) as CSSProperties,
    [branding.enabled, branding.primary_color],
  );
  // `document.title` = "<página> · <app_name>". Next re-renders the
  // metadata <title> after hydration / navigation, so watch it and
  // re-apply instead of setting it once and losing the race.
  useEffect(() => {
    const desired = `${getPageTitle(pathname, language)} · ${branding.app_name}`;
    const apply = () => {
      if (document.title !== desired) document.title = desired;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [pathname, branding.app_name, language]);

  // Push (spec round 2 §5): re-register /sw.js only for browsers that
  // already hold a subscription — Settings → Notificações does the opt-in.
  usePushRegistration();

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  // MFA required for admins (round 2 spec, section 7): once the owner
  // turns the toggle on, an owner/admin without a verified factor is
  // parked on Settings → Login e segurança until they enroll. Both
  // inputs (preferences, factor list) come from the AuthProvider, so
  // this is a pure client-side check — no extra round trip.
  const mfaEnrollPending =
    !profileLoading &&
    mfaReady &&
    mustEnrollMfa({
      role: accountRole,
      requireMfaAdmins: preferences.require_mfa_admins,
      hasVerifiedFactor: hasVerifiedMfa,
    });
  useEffect(() => {
    if (mfaEnrollPending && !isMfaEnrollAllowedPath(pathname)) {
      router.replace(MFA_ENROLL_PATH);
    }
  }, [mfaEnrollPending, pathname, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Carregando...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  // Plan block (migration 025): past_due / canceled / suspended, or an
  // expired trial. Replaces the whole shell so nothing in the app is
  // reachable — except /settings, where the owner reviews the plan,
  // and sign-out (a button on the blocked screen itself).
  if (entitlementsReady && blocked && !pathname.startsWith("/settings")) {
    return <BlockedScreen reason={blocked.reason} />;
  }

  return (
    // Internal chat (migration 038): the account presence channel + the
    // last_seen heartbeat live for the whole shell, but only once the
    // entitlements settled with the module on — accounts without it
    // open no channel.
    <ChatPresenceProvider enabled={entitlementsReady && modules.internal_chat}>
      <div className="flex h-screen overflow-hidden bg-background" style={brandStyle}>
        <Sidebar open={sidebarOpen} onClose={closeSidebar} />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Header onOpenSidebar={() => setSidebarOpen(true)} />
          <MfaRequiredNotice compact />
          {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
          <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
        </div>
      </div>
    </ChatPresenceProvider>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
