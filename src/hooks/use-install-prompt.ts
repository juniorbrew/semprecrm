'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

// "Install the app" state for the phone. Android/Chrome hands us a
// `beforeinstallprompt` event we can replay from our own button; iOS has
// no such event, so the UI shows the Share → "Adicionar à Tela de Início"
// steps instead. Server snapshots assume "installed / dismissed" so
// nothing flashes before hydration.

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type NavLike = { userAgent: string; maxTouchPoints?: number; standalone?: boolean };

/** iPhone, iPod or iPad — iPadOS reports itself as a Mac with touch. */
export function isIosDevice(nav: NavLike): boolean {
  if (/iPad|iPhone|iPod/.test(nav.userAgent)) return true;
  return /Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1;
}

/** Opened from the home-screen icon (any platform). */
export function isStandalone(win: Pick<Window, 'matchMedia'>, nav: NavLike): boolean {
  return win.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
}

const DISMISS_KEY = 'semprecrm:install-app-dismissed';
const DISMISS_EVENT = 'semprecrm:install-app-dismissed';

// Fallback when localStorage throws (private mode): hidden for this page view.
let dismissedThisPage = false;

function readDismissed(): boolean {
  if (dismissedThisPage) return true;
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function subscribeDismissed(cb: () => void) {
  window.addEventListener(DISMISS_EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(DISMISS_EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}

function subscribeDisplayMode(cb: () => void) {
  const mq = window.matchMedia('(display-mode: standalone)');
  mq.addEventListener('change', cb);
  window.addEventListener('appinstalled', cb);
  return () => {
    mq.removeEventListener('change', cb);
    window.removeEventListener('appinstalled', cb);
  };
}

const noopSubscribe = () => () => {};

export function useInstallPrompt() {
  const standalone = useSyncExternalStore(
    subscribeDisplayMode,
    () => isStandalone(window, navigator),
    () => true,
  );
  const ios = useSyncExternalStore(noopSubscribe, () => isIosDevice(navigator), () => false);
  const dismissed = useSyncExternalStore(subscribeDismissed, readDismissed, () => true);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault(); // keep it for our own button instead of Chrome's mini-bar
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferred(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null); // the event can be used only once
  }, [deferred]);

  const dismiss = useCallback(() => {
    dismissedThisPage = true;
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // private mode: dismissedThisPage covers it
    }
    window.dispatchEvent(new Event(DISMISS_EVENT));
  }, []);

  return { standalone, ios, dismissed, canInstall: deferred !== null, install, dismiss };
}
