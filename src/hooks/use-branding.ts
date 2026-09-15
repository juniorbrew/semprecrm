'use client';

import { useMemo } from 'react';

import { useAuth, useEntitlements } from '@/hooks/use-auth';
import { DEFAULT_BRANDING, type Branding } from '@/lib/branding';

/**
 * The branding the shell should actually render: the account's own
 * values when the `white_label` module is on, the SempreCRM defaults
 * otherwise (a downgraded plan falls back without losing the saved
 * values). While entitlements are still loading the defaults are used
 * so nothing flashes a colour that then disappears.
 */
export function useBranding(): Branding & { enabled: boolean } {
  const { branding } = useAuth();
  const { ready, modules } = useEntitlements();
  const enabled = ready && modules.white_label;
  return useMemo(
    () => (enabled ? { ...branding, enabled } : { ...DEFAULT_BRANDING, enabled }),
    [branding, enabled],
  );
}
