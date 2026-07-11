/**
 * Fase 22.4 — service worker for the /x-agent panel's desktop Web Push
 * notifications. The push itself carries no payload (see push.ts's header
 * comment on why): this worker just wakes up, fetches the pending-replies
 * list same-origin (the Cloudflare Access session cookie travels with a
 * same-origin fetch from an active service worker), and builds the
 * notification from real data. If the Access session has expired, the fetch
 * comes back non-200 and a generic notification is shown instead — clicking
 * it still opens the panel, where the normal Access login takes over.
 */
export const X_PUSH_SW_JS = `
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let title = 'ToolSnap X Agent';
    let body = 'New reply candidate — open the panel.';
    try {
      const res = await fetch('/x-agent/api/replies/pending');
      if (res.ok) {
        const data = await res.json();
        const pending = data.pending || [];
        if (pending.length > 0) {
          const first = pending[0];
          title = pending.length === 1 ? 'New reply candidate' : pending.length + ' reply candidates waiting';
          body = '@' + (first.author_handle || '?') + ' (score ' + (first.score || '?') + '): ' + (first.draft_reply || '').slice(0, 120);
        } else {
          return; // nothing pending anymore (already actioned from Telegram) — skip the notification
        }
      }
    } catch (e) {
      // Access session likely expired — fall through to the generic notification below.
    }
    await self.registration.showNotification(title, {
      body,
      icon: '/img/favicon-32.png',
      tag: 'x-agent-reply',
      renotify: true,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/x-agent'));
});
`;
