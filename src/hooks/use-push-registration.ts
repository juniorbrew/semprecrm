'use client';

import { useEffect, useRef } from 'react';

import { useAuth } from '@/hooks/use-auth';
import {
  getCurrentSubscription,
  getPermissionState,
  getPushSupport,
  registerServiceWorker,
  vapidPublicKey,
} from '@/lib/push/client';

/**
 * Keep this browser's push subscription alive across sessions.
 *
 * The service worker is registered from the dashboard shell ONLY when
 * the user already enabled notifications here (permission granted and a
 * subscription exists) — Settings → Notificações does the first
 * registration explicitly. Re-registering on load is what lets the
 * worker survive browser updates / eviction, and re-posting the
 * subscription heals a row the sender pruned after a transient 410.
 */
export function usePushRegistration(): void {
  const { user } = useAuth();
  const done = useRef(false);

  useEffect(() => {
    if (!user || done.current) return;
    if (!getPushSupport() || !vapidPublicKey()) return;
    if (getPermissionState() !== 'granted') return;
    done.current = true;

    let cancelled = false;
    (async () => {
      // Only when a subscription already exists — never subscribe
      // silently from the shell.
      const existing = await getCurrentSubscription();
      if (cancelled || !existing) return;
      await registerServiceWorker();
      fetch('/api/push/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: existing.toJSON(),
          user_agent: navigator.userAgent,
        }),
      }).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);
}
