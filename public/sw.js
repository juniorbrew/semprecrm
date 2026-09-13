/* SempreCRM service worker — browser push (spec round 2 §5).
 *
 * Served from the origin root so its scope covers the whole app. It does
 * two things only: shows the notification carried by a push message and,
 * on click, focuses an already-open tab (navigating it to the target URL)
 * or opens a new one. No caching, no offline behaviour.
 *
 * Payload (JSON, built by src/lib/push/send.ts):
 *   { title, body, icon?, tag?, data: { url } }
 */

self.addEventListener('install', () => {
  // Activate immediately so the first subscription works without a reload.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'SempreCRM';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon',
    badge: payload.badge || undefined,
    tag: payload.tag || undefined,
    renotify: !!payload.tag,
    data: { url: (payload.data && payload.data.url) || '/inbox' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(
    (event.notification.data && event.notification.data.url) || '/inbox',
    self.location.origin,
  ).href;

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        // Prefer a tab already on this origin: focus it and steer it to the
        // conversation / task the notification points at.
        for (const client of clients) {
          if ('focus' in client) {
            return client.focus().then((focused) => {
              if (focused && 'navigate' in focused && focused.url !== target) {
                return focused.navigate(target).catch(() => undefined);
              }
              return undefined;
            });
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
        return undefined;
      }),
  );
});
