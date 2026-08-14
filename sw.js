const CACHE_VERSION = 'mysubbies-v2';
const PRECACHE_URLS = [
  '/',
  '/mysubbies-website.html',
  '/mysubbies-booking.html',
  '/mysubbies-customer-portal.html',
  '/mysubbies-contractor-portal.html',
  '/mysubbies-contractor-signup.html',
  '/mysubbies-admin-portal.html',
  '/mysubbies-faq.html',
  '/mysubbies-terms.html',
  '/mysubbies-privacy-policy.html',
  '/mysubbies-contractor-agreement.html',
  '/mysubbies-blog.html',
  '/mysubbies-blog-decking-cost.html',
  '/mysubbies-blog-fencing-cost.html',
  '/manifest.json',
  '/manifest-contractor.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first, falling back to cache only when offline — this app changes
// often, so we never want a stale cached page to silently outlive a real fix
// (see CLAUDE.md's note on the earlier stale-cache bug in this project).
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        const resClone = res.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(req, resClone));
        return res;
      })
      .catch(() => caches.match(req).then(cached => cached || caches.match('/')))
  );
});
