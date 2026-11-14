// Larder service worker: instant opening, offline support and expiry reminders.
const CACHE = 'larder-v3';
const FILES = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });

// Open from the saved copy straight away, and fetch any update in the background for next time.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // never touch Gemini or reminder-server calls
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, {ignoreSearch: true});
    const update = fetch(req.url, {cache: 'no-cache'}).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; });
    if (hit) { e.waitUntil(update.catch(() => {})); return hit; }
    try { return await update; } catch (err) { return (await cache.match('./index.html')) || Response.error(); }
  })());
});

// ---- expiry reminders ----
// The reminder server sends an empty ping. What needs using up is worked out here, on the phone,
// from a copy of the kitchen the app keeps in IndexedDB. No food names ever leave the phone.
function readKitchen() {
  return new Promise(resolve => {
    try {
      const rq = indexedDB.open('larder', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
      rq.onerror = () => resolve(null);
      rq.onsuccess = () => {
        try {
          const db = rq.result, g = db.transaction('kv').objectStore('kv').get('notify');
          g.onsuccess = () => { resolve(g.result || null); db.close(); };
          g.onerror = () => { resolve(null); db.close(); };
        } catch (err) { resolve(null); }
      };
    } catch (err) { resolve(null); }
  });
}
function whenText(d) { return d < 0 ? 'past its date' : d === 0 ? 'today' : d === 1 ? 'tomorrow' : d + ' days'; }
async function showDue() {
  const k = await readKitchen();
  let title = 'Larder', body = 'Open Larder to see what needs using up.', count = 0;
  if (k && Array.isArray(k.items)) {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const due = k.items.map(it => { const p = String(it.exp).split('-').map(Number); return {n: it.n, d: Math.round((new Date(p[0], p[1] - 1, p[2]) - t) / 864e5)}; })
      .filter(x => x.d <= (k.warn || 2) && x.d >= -1).sort((a, b) => a.d - b.d);
    count = due.length;
    if (due.length === 1) { title = 'Use up your ' + due[0].n.toLowerCase(); body = due[0].d < 0 ? 'It is past its date.' : 'Best used ' + (due[0].d > 1 ? 'within ' + due[0].d + ' days' : whenText(due[0].d)) + '.'; }
    else if (due.length) { title = due.length + ' things to use up'; body = due.slice(0, 6).map(x => x.n + ' (' + whenText(x.d) + ')').join(', ') + (due.length > 6 ? ' and ' + (due.length - 6) + ' more' : ''); }
    else { title = 'Kitchen check'; body = 'Nothing needs using up right now.'; }
  }
  try { if (self.navigator.setAppBadge) { if (count) await self.navigator.setAppBadge(count); else await self.navigator.clearAppBadge(); } } catch (err) {}
  return self.registration.showNotification(title, {body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'larder-due'});
}
self.addEventListener('push', e => { e.waitUntil(showDue()); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
