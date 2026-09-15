"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import type { Factor, User } from "@supabase/supabase-js";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import {
  canEditSettings as canEditSettingsFor,
  canManageMembers as canManageMembersFor,
  canSendMessages as canSendMessagesFor,
  isAccountRole,
  type AccountRole,
} from "@/lib/auth/roles";
import {
  resolveEntitlements,
  type Entitlements,
  type PlanAccountFields,
} from "@/lib/plans";
import { parseAccountPreferences } from "@/lib/account-preferences";
import { parseBranding, type Branding } from "@/lib/branding";
import { hasVerifiedTotp } from "@/lib/auth/mfa";
import type { AccountPreferences, Availability } from "@/types";

interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  /**
   * Opted-in beta feature keys for this account. No current feature
   * reads this — Flows was the last user and went to soft-GA in PR
   * #134 — but the column survives for future beta gates.
   */
  beta_features: string[];
  account_id: string | null;
  account_role: AccountRole | null;
  /** "Disponível / Ausente" (migration 033). */
  availability: Availability;
  /** Raw `profiles.notification_prefs` jsonb (migration 036). */
  notification_prefs: Record<string, unknown> | null;
}

interface AccountSummary extends PlanAccountFields {
  id: string;
  name: string;
  /** Default deal currency (ISO-4217). NOT NULL DEFAULT 'USD' in the
   *  DB (migration 021); narrowed to DEFAULT_CURRENCY when absent. */
  default_currency: string;
  /** Plan fields (migration 025). Optional so forks on a pre-025
   *  schema still resolve — `resolveEntitlements` treats missing
   *  values as an unexpired trial. */
  plan?: string | null;
  plan_status?: string | null;
  plan_expires_at?: string | null;
  module_overrides?: Record<string, unknown> | null;
  limit_overrides?: Record<string, unknown> | null;
  /** Raw `accounts.preferences` jsonb (migration 030). Read the parsed
   *  `preferences` off the auth context instead of indexing this. */
  preferences?: Record<string, unknown> | null;
  /** Raw `accounts.branding` jsonb (migration 037). Read the parsed
   *  `branding` off the auth context instead of indexing this. */
  branding?: Record<string, unknown> | null;
}

/** Columns the auth provider selects off `accounts`. */
const ACCOUNT_SELECT =
  "id, name, default_currency, plan, plan_status, plan_expires_at, module_overrides, limit_overrides, preferences, branding";

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  /**
   * Session-level loading. Flips to false as soon as we know whether
   * a user is signed in, *without* waiting for the profile row. Use
   * this for chrome (sidebar / header) that can render with just the
   * user object.
   */
  loading: boolean;
  /**
   * Profile-row loading. Stays true until `fetchProfile` settles
   * (success, missing row, or error). Code that branches on
   * `profile.beta_features` MUST gate on this — otherwise it sees the
   * `{ loading: false, profile: null }` window during initial load
   * and may take the "not opted in" branch incorrectly.
   */
  profileLoading: boolean;
  signOut: () => Promise<void>;
  /** Re-fetch the current user's profile row — call after a save from
   *  the settings form so header/sidebar reflect the change without a
   *  full page reload. */
  refreshProfile: () => Promise<void>;

  // ----------------------------------------------------------
  // Account-scoped context (added by the account-sharing series)
  //
  // All of these are nullable until `profileLoading` is false.
  // After the profile resolves they're guaranteed to be set,
  // because migration 017 made `account_id` / `account_role`
  // NOT NULL on `profiles`.
  // ----------------------------------------------------------

  /** Account id the current user belongs to. Null while loading. */
  accountId: string | null;
  /** Role within that account. Null while loading. */
  accountRole: AccountRole | null;
  /** Lightweight account meta — id + name + default_currency. Null while loading. */
  account: AccountSummary | null;
  /** Account default deal currency. Falls back to DEFAULT_CURRENCY
   *  while loading or when no account is resolved, so callers can use
   *  it unconditionally. */
  defaultCurrency: string;
  /** True if `accountRole === 'owner'`. */
  isOwner: boolean;
  /** True if `accountRole === 'admin'` (does NOT include owner — use canManageMembers for "admin or above"). */
  isAdmin: boolean;
  /** True if `accountRole === 'agent'`. */
  isAgent: boolean;
  /** True if `accountRole === 'viewer'`. */
  isViewer: boolean;
  /** True if the caller can manage members (admin+). */
  canManageMembers: boolean;
  /** True if the caller can edit account-wide settings (admin+). */
  canEditSettings: boolean;
  /** True if the caller can send messages and edit operational data (agent+). */
  canSendMessages: boolean;

  // ----------------------------------------------------------
  // Plans / platform (migration 025)
  // ----------------------------------------------------------

  /** Resolved plan entitlements for the current account. While the
   *  profile is loading this is the permissive trial default — gate
   *  on `profileLoading` before hiding anything. */
  entitlements: Entitlements;
  /** True when the caller's user id is listed in `platform_admins`.
   *  Drives the "Platform" menu item only; /platform re-checks
   *  server-side. */
  isPlatformAdmin: boolean;

  // ----------------------------------------------------------
  // Account preferences (migration 030)
  // ----------------------------------------------------------

  /** Parsed `accounts.preferences` with defaults filled in (SLA, cooling
   *  hours, opt-out words). Defaults while loading. */
  preferences: AccountPreferences;
  /** Re-read the account row after Settings → Atendimento saves. */
  refreshAccount: () => Promise<void>;

  // ----------------------------------------------------------
  // White-label branding (migration 037)
  // ----------------------------------------------------------

  /** Parsed `accounts.branding` with SempreCRM defaults. Callers gate
   *  on `entitlements.modules.white_label` before applying it. */
  branding: Branding;

  // ----------------------------------------------------------
  // MFA (round 2 spec, section 7)
  // ----------------------------------------------------------

  /** Raw `auth.mfa.listFactors().all` for the signed-in user. `null`
   *  until the first load settles — gate on `mfaReady`. */
  mfaFactors: Factor[] | null;
  /** False until the factor list has been read once. */
  mfaReady: boolean;
  /** True when at least one TOTP factor is verified. */
  hasVerifiedMfa: boolean;
  /** Re-read the factor list after enroll / unenroll in Settings. */
  refreshMfa: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * AuthProvider — wrap this around the dashboard layout.
 * Makes ONE getSession() call for the whole tree instead of one per
 * component, avoiding internal lock contention in the Supabase client.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  // Tracked separately from `loading`. The session settles fast (one
  // local cookie read); the profile fetch crosses the network and
  // settles later. Callers that gate on `profile.*` need to know which
  // window they're in — see the type doc above.
  const [profileLoading, setProfileLoading] = useState(true);
  // MFA factor list — read once per session and after enroll/unenroll.
  const [mfaFactors, setMfaFactors] = useState<Factor[] | null>(null);

  const fetchMfaFactors = useCallback(async () => {
    const supabase = createClient();
    try {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) {
        console.error("[AuthProvider] listFactors error:", error.message);
        setMfaFactors([]);
        return;
      }
      setMfaFactors(data?.all ?? []);
    } catch (err) {
      console.error("[AuthProvider] listFactors threw:", err);
      setMfaFactors([]);
    }
  }, []);

  // Shared across init, auth-state-change listener, and the exposed
  // refreshProfile() callback. Reads the current session's user id and
  // pulls the matching profile row along with its account summary.
  const fetchProfile = useCallback(async (userId: string) => {
    const supabase = createClient();
    setProfileLoading(true);
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select(
          // `account:accounts!inner(id, name)` — explicit join on the
          // single FK profiles.account_id → accounts.id. `!inner` so a
          // missing account collapses to null rather than a half-
          // populated row (shouldn't happen post-017 NOT NULL, but
          // belt-and-braces against forks running older schemas).
          `id, full_name, email, avatar_url, role, beta_features, account_id, account_role, availability, notification_prefs, account:accounts!inner(${ACCOUNT_SELECT})`,
        )
        .eq("user_id", userId)
        .maybeSingle();

      // Platform-admin flag. `platform_admins` is RLS-restricted to
      // the caller's own row, so this is a cheap "is it me" probe.
      // A failure (e.g. a fork without migration 025) reads as
      // "not an admin".
      const adminProbe = supabase
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle()
        .then(
          ({ data: adminRow }) => !!adminRow,
          () => false,
        );

      if (error) {
        console.error("[AuthProvider] fetchProfile error:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        return;
      }

      if (data) {
        // Supabase's typed client surfaces an embedded `!inner` row
        // as either an object or a single-element array depending on
        // the schema's inferred cardinality — normalise to the object
        // form before reading.
        const accountRaw = Array.isArray(data.account)
          ? data.account[0] ?? null
          : (data.account as
              | (Partial<AccountSummary> & {
                  id: string;
                  name: string;
                  default_currency: string | null;
                })
              | null);
        // Narrow default_currency defensively: forks running pre-021
        // schemas won't have the column, so a missing/null value reads
        // as the safe USD fallback rather than crashing the picker.
        const accountRow: AccountSummary | null = accountRaw
          ? {
              id: accountRaw.id,
              name: accountRaw.name,
              default_currency: accountRaw.default_currency ?? DEFAULT_CURRENCY,
              plan: accountRaw.plan ?? null,
              plan_status: accountRaw.plan_status ?? null,
              plan_expires_at: accountRaw.plan_expires_at ?? null,
              module_overrides: accountRaw.module_overrides ?? null,
              limit_overrides: accountRaw.limit_overrides ?? null,
              preferences: accountRaw.preferences ?? null,
              branding: accountRaw.branding ?? null,
            }
          : null;

        // Narrow the DB enum into our AccountRole union. The DB
        // constraint should make this unconditional, but a future
        // migration that broadens the enum without updating TS would
        // otherwise crash here — fall back to null and let UI gates
        // treat the caller as least-privileged.
        const accountRole = isAccountRole(data.account_role)
          ? data.account_role
          : null;

        setProfile({
          id: data.id,
          full_name: data.full_name,
          email: data.email,
          avatar_url: data.avatar_url,
          role: data.role,
          // `beta_features` is `NOT NULL DEFAULT ARRAY[]` in the DB, but
          // narrow defensively in case the column hasn't been migrated yet
          // (older deployments running 011 lazily) — `null` reads as no
          // opt-ins, which is the safe default for any future beta gate.
          beta_features: data.beta_features ?? [],
          account_id: data.account_id ?? null,
          account_role: accountRole,
          // Migration 033 — older schemas have no column; read as available.
          availability: data.availability === "away" ? "away" : "available",
          notification_prefs: data.notification_prefs ?? null,
        });
        setAccount(accountRow);
      }
      setIsPlatformAdmin(await adminProbe);
    } catch (err) {
      console.error("[AuthProvider] fetchProfile threw:", err);
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;

    const safetyTimer = setTimeout(() => {
      if (mounted) {
        console.warn("[AuthProvider] getSession() timed out after 3s");
        setLoading(false);
        setProfileLoading(false);
      }
    }, 3000);

    const init = async () => {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();

        if (error) console.error("[AuthProvider] getSession error:", error.message);

        if (!mounted) return;
        const currentUser = session?.user ?? null;
        setUser(currentUser);

        if (currentUser) {
          // Don't block session loading on profile fetch — chrome
          // (header, sidebar) can render from the user object alone,
          // profile enriches async. Callers that need to branch on
          // profile data gate on `profileLoading` instead.
          fetchProfile(currentUser.id);
          fetchMfaFactors();
        } else {
          // No user → no profile to load. Flip profileLoading off so
          // pages that gate on it don't wait forever on the logged-out
          // path (the route guard or redirect should fire instead).
          setProfileLoading(false);
        }
      } catch (err) {
        console.error("[AuthProvider] init threw:", err);
      } finally {
        if (mounted) setLoading(false);
        clearTimeout(safetyTimer);
      }
    };

    init();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      const currentUser = session?.user ?? null;
      setUser(currentUser);

      if (currentUser) {
        fetchProfile(currentUser.id);
        // Only the events that can change the factor list re-read it
        // (TOKEN_REFRESHED fires hourly and would be wasted calls).
        if (event === "SIGNED_IN" || event === "MFA_CHALLENGE_VERIFIED" || event === "USER_UPDATED") {
          fetchMfaFactors();
        }
      } else {
        setProfile(null);
        setAccount(null);
        setIsPlatformAdmin(false);
        setProfileLoading(false);
        setMfaFactors(null);
      }

      setLoading(false);
    });

    return () => {
      mounted = false;
      clearTimeout(safetyTimer);
      subscription.unsubscribe();
    };
  }, [fetchProfile, fetchMfaFactors]);

  const signOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setAccount(null);
    setIsPlatformAdmin(false);
    window.location.href = "/login";
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!user?.id) return;
    await fetchProfile(user.id);
  }, [user?.id, fetchProfile]);

  // Derive the role booleans once per profile change rather than on
  // every consumer render. Cheap regardless, but the memo also gives
  // each derived value a stable identity for React.memo / useEffect
  // dependencies downstream.
  const derived = useMemo(() => {
    const role = profile?.account_role ?? null;
    return {
      accountRole: role,
      accountId: profile?.account_id ?? null,
      isOwner: role === "owner",
      isAdmin: role === "admin",
      isAgent: role === "agent",
      isViewer: role === "viewer",
      canManageMembers: role ? canManageMembersFor(role) : false,
      canEditSettings: role ? canEditSettingsFor(role) : false,
      canSendMessages: role ? canSendMessagesFor(role) : false,
    };
  }, [profile?.account_role, profile?.account_id]);

  // Entitlements are derived from the account row. Memoised on the
  // row identity so every consumer of `useEntitlements()` sees a
  // stable object between renders.
  const entitlements = useMemo(() => resolveEntitlements(account), [account]);

  // Preferences follow the same rule — parsed once per account row so
  // the radar / opt-out consumers get a stable object.
  const preferences = useMemo(
    () => parseAccountPreferences(account?.preferences),
    [account],
  );

  // Cheaper than refreshProfile when only the account row changed
  // (Settings → Atendimento): one select, no profile / admin probe.
  const refreshAccount = useCallback(async () => {
    if (!account?.id) return;
    const supabase = createClient();
    const { data, error } = await supabase
      .from("accounts")
      .select(ACCOUNT_SELECT)
      .eq("id", account.id)
      .maybeSingle();
    if (error || !data) return;
    const row = data as unknown as Partial<AccountSummary> & { id: string; name: string };
    setAccount((prev) =>
      prev
        ? {
            ...prev,
            name: row.name ?? prev.name,
            default_currency: row.default_currency ?? prev.default_currency,
            plan: row.plan ?? prev.plan,
            plan_status: row.plan_status ?? prev.plan_status,
            plan_expires_at: row.plan_expires_at ?? prev.plan_expires_at,
            module_overrides: row.module_overrides ?? prev.module_overrides,
            limit_overrides: row.limit_overrides ?? prev.limit_overrides,
            preferences: row.preferences ?? null,
            branding: row.branding ?? null,
          }
        : prev,
    );
  }, [account?.id]);

  // Branding follows the same rule as preferences — parsed once per
  // account row so the shell / sidebar get a stable object.
  const branding = useMemo(() => parseBranding(account?.branding), [account]);

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileLoading,
        signOut,
        refreshProfile,
        account,
        defaultCurrency: account?.default_currency ?? DEFAULT_CURRENCY,
        entitlements,
        isPlatformAdmin,
        preferences,
        refreshAccount,
        branding,
        mfaFactors,
        mfaReady: mfaFactors !== null,
        hasVerifiedMfa: hasVerifiedTotp(mfaFactors),
        refreshMfa: fetchMfaFactors,
        ...derived,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * useAuth — read the shared auth state from context.
 * Must be used inside an <AuthProvider>.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider (shouldn't
    // happen in normal flow, but don't crash the page). Account state
    // collapses to least-privileged null — every `canX` boolean is
    // false so UI gates fail closed.
    return {
      user: null,
      profile: null,
      loading: false,
      profileLoading: false,
      signOut: async () => {
        window.location.href = "/login";
      },
      refreshProfile: async () => {},
      account: null,
      defaultCurrency: DEFAULT_CURRENCY,
      accountId: null,
      accountRole: null,
      isOwner: false,
      isAdmin: false,
      isAgent: false,
      isViewer: false,
      canManageMembers: false,
      canEditSettings: false,
      canSendMessages: false,
      entitlements: resolveEntitlements(null),
      isPlatformAdmin: false,
      preferences: parseAccountPreferences(null),
      refreshAccount: async () => {},
      branding: parseBranding(null),
      mfaFactors: null,
      mfaReady: false,
      hasVerifiedMfa: false,
      refreshMfa: async () => {},
    };
  }
  return ctx;
}

/**
 * useEntitlements — the resolved plan for the current account
 * (modules on/off, limits, blocked state). Sourced from the account
 * row the AuthProvider already loaded; no extra round trip.
 *
 * `ready` is false until the profile fetch settles. Gate any
 * hide/redirect on it — before that the value is the permissive
 * trial default and would otherwise flash the wrong UI.
 */
export function useEntitlements(): Entitlements & { ready: boolean } {
  const { entitlements, profileLoading, account } = useAuth();
  return { ...entitlements, ready: !profileLoading && account !== null };
}
