// KLM Task Manager — sirf notification ke liye service worker (Harsh, 22 Oct 2026).
// Chrome / Edge par desktop aur mobile (Android) dono jagah notification yahi
// dikhata hai. Isme koi fetch handler NAHI hai — app ki koi request ya cache
// isse hokar nahi guzarti, sab pehle jaisa seedha server se aata hai.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Notification par click -> app ki khuli window aage lao aur bell panel kholo;
// koi window khuli na ho to /app khol do
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(c => new URL(c.url).pathname.startsWith('/app'));
    if (win) {
      await win.focus();
      win.postMessage({ type: 'open-notif-panel' });
      return;
    }
    await self.clients.openWindow('/app');
  })());
});
