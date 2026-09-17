// ============================================================
// Browser side of push notifications (spec round 2 §5).
//
//   getPushSupport()      — can this browser do Web Push at all?
//   getPermissionState()  — 'default' | 'granted' | 'denied' | 'unsupported'
//   registerServiceWorker() — /sw.js at the origin root (idempotent)
//   subscribePush()       — permission → PushManager.subscribe → POST
//                           /api/push/subscriptions
//   unsubscribePush()     — DELETE the row, then unsubscribe locally
//   getCurrentSubscription() — the browser's active subscription, if any
//   reportConversationFocus() — POST /api/push/seen (the "I'm looking at
//                           this conversation" hint the sender honours)
//   reportChatThreadFocus() — same for an internal chat thread
//   notifyPushEvent()     — POST /api/push/notify (client-raised kinds)
//
// Everything is a no-op outside the browser or without the VAPID public
// key, so callers can invoke these unconditionally.
// ============================================================

export const SW_PATH = '/sw.js';

export type PushPermission = NotificationPermission | 'unsupported';

export function getPushSupport(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function vapidPublicKey(): string | null {
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  return key && key.trim().length > 0 ? key.trim() : null;
}

export function getPermissionState(): PushPermission {
  if (!getPushSupport()) return 'unsupported';
  return Notification.permission;
}

/** Base64url (VAPID key) → Uint8Array for `applicationServerKey`. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!getPushSupport()) return null;
  try {
    const existing = await navigator.serviceWorker.getRegistration('/');
    if (existing) return existing;
    return await navigator.serviceWorker.register(SW_PATH, { scope: '/' });
  } catch (err) {
    console.error('[push] service worker registration failed:', err);
    return null;
  }
}

export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!getPushSupport()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    if (!reg) return null;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

export interface SubscribeResult {
  ok: boolean;
  /** 'denied' when the user refused the permission prompt. */
  reason?: 'unsupported' | 'no_vapid_key' | 'denied' | 'subscribe_failed' | 'save_failed';
  subscription?: PushSubscription;
}

/**
 * Ask for permission (when needed), subscribe this browser and store the
 * subscription for the signed-in user.
 */
export async function subscribePush(): Promise<SubscribeResult> {
  if (!getPushSupport()) return { ok: false, reason: 'unsupported' };
  const key = vapidPublicKey();
  if (!key) return { ok: false, reason: 'no_vapid_key' };

  const permission =
    Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  const reg = await registerServiceWorker();
  if (!reg) return { ok: false, reason: 'subscribe_failed' };
  // The worker may still be installing on the very first call.
  await navigator.serviceWorker.ready;

  let subscription: PushSubscription | null = null;
  try {
    subscription =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      }));
  } catch (err) {
    console.error('[push] subscribe failed:', err);
    return { ok: false, reason: 'subscribe_failed' };
  }

  const res = await fetch('/api/push/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      user_agent: navigator.userAgent,
    }),
  }).catch(() => null);
  if (!res || !res.ok) return { ok: false, reason: 'save_failed', subscription };
  return { ok: true, subscription };
}

/** Remove this browser's subscription (server row + local). */
export async function unsubscribePush(): Promise<boolean> {
  const sub = await getCurrentSubscription();
  if (!sub) return true;
  await fetch('/api/push/subscriptions', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => null);
  try {
    return await sub.unsubscribe();
  } catch {
    return false;
  }
}

/**
 * Tell the server this user is looking at `conversationId` right now so
 * inbound-message pushes for it are skipped (60 s TTL server-side; the
 * inbox calls this on focus and again every 30 s while the tab is
 * visible). Fire-and-forget.
 */
export function reportConversationFocus(conversationId: string | null): void {
  if (typeof window === 'undefined') return;
  const body = JSON.stringify({ conversation_id: conversationId });
  try {
    fetch('/api/push/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

/**
 * Internal chat counterpart of `reportConversationFocus`: the thread the
 * user has open and visible, so `chat_message` pushes for it are skipped.
 * Tracked separately from the inbox focus (see src/lib/push/focus.ts).
 */
export function reportChatThreadFocus(threadId: string | null): void {
  if (typeof window === 'undefined') return;
  const body = JSON.stringify({ chat_thread_id: threadId });
  try {
    fetch('/api/push/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

/**
 * Raise a client-originated push trigger (task / conversation assigned,
 * internal chat message).
 * The server resolves the recipient from the row and skips the caller,
 * so this can be called on every assignment change. Fire-and-forget.
 */
export function notifyPushEvent(
  event:
    | { kind: 'task_assigned'; task_id: string }
    | { kind: 'conversation_assigned'; conversation_id: string }
    | { kind: 'chat_message'; message_id: string },
): void {
  if (typeof window === 'undefined') return;
  fetch('/api/push/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
    keepalive: true,
  }).catch(() => undefined);
}
