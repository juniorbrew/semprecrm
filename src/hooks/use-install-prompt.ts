'use client';

import { useCallback, useSyncExternalStore } from 'react';

import { INSTALL_PROMPT_EVENT, INSTALL_PROMPT_KEY } from '@/lib/pwa/install-prompt';

// "Install the app" state for the phone. Android/Chrome hands us a
// `beforeinstallprompt` event — parked on `window` by the root layout's
// boot script (lib/pwa/install-prompt.ts), since it fires before the
// dashboard mounts — which our own button replays. iOS has no such
// event, so the UI shows the Share → "Adicionar à Tela de Início" steps
// instead. Server snapshots assume "installed / dismissed" so nothing
// flashes before hydration.

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

declare global {
  interface Window {
    [INSTALL_PROMPT_KEY]?: BeforeInstallPromptEvent | null;
  }
}

type NavLike = { userAgent: string; maxTouchPoints?: number; standalone?: boolean };

/** iPhone, iPod or iPad — iPadOS reports itself as a Mac with touch. */
export function isIosDevice(nav: NavLike): boolean {
  if (/iPad|iPhone|iPod/.test(nav.userAgent)) return true;
  return /Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1;
}

/** Facebook/Instagram/WhatsApp-style in-app browsers: no Share → Home Screen there. */
export function isInAppBrowser(nav: NavLike): boolean {
  return /FBAN|FBAV|Instagram|WhatsApp|Line\//.test(nav.userAgent);
}

/** Opened from the home-screen icon (any platform). */
export function isStandalone(win: Pick<Window, 'matchMedia'>, nav: NavLike): boolean {
  return win.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
}

const DISMISS_KEY = 'semprecrm:install-app-dismissed';
const DISMISS_EVENT = 'semprecrm:install-app-dismissed';

// Fallback when localStorage throws (private mode): hidden for this page view.
let dismissedThisPage = false;

/** Test-only: forget an in-memory dismissal. */
export function resetInstallPromptForTests() {
  dismissedThisPage = false;
}

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

function subscribePrompt(cb: () => void) {
  window.addEventListener(INSTALL_PROMPT_EVENT, cb);
  return () => window.removeEventListener(INSTALL_PROMPT_EVENT, cb);
}

function setParkedPrompt(e: BeforeInstallPromptEvent | null) {
  window[INSTALL_PROMPT_KEY] = e;
  window.dispatchEvent(new Event(INSTALL_PROMPT_EVENT));
}

const noopSubscribe = () => () => {};

export function useInstallPrompt() {
  const standalone = useSyncExternalStore(
    subscribeDisplayMode,
    () => isStandalone(window, navigator),
    () => true,
  );
  const ios = useSyncExternalStore(noopSubscribe, () => isIosDevice(navigator), () => false);
  const inApp = useSyncExternalStore(noopSubscribe, () => isInAppBrowser(navigator), () => false);
  const dismissed = useSyncExternalStore(subscribeDismissed, readDismissed, () => true);
  const deferred = useSyncExternalStore(
    subscribePrompt,
    () => window[INSTALL_PROMPT_KEY] ?? null,
    () => null,
  );

  const install = useCallback(async () => {
    const e = window[INSTALL_PROMPT_KEY];
    if (!e) return;
    setParkedPrompt(null); // usable once: a double tap must not replay it
    try {
      await e.prompt();
      await e.userChoice;
    } catch (err) {
      console.error('[install] prompt failed:', err);
    }
  }, []);

  const dismiss = useCallback(() => {
    dismissedThisPage = true;
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // private mode: dismissedThisPage covers it
    }
    window.dispatchEvent(new Event(DISMISS_EVENT));
  }, []);

  return { standalone, ios, inApp, dismissed, canInstall: deferred !== null, install, dismiss };
}
