// MvL OS service worker. Generated at build time: VERSION and PRECACHE are filled in by the
// Vite plugin in vite.config.ts, so every release ships a different worker and visitors are
// offered the update.
//
// - The app shell (index.html, the built JS/CSS, icons) is cached up front, so the OS boots
//   offline.
// - Pages: network first, the cached shell when offline.
// - Hashed /assets/: cache first (they never change under the same name).
// - Data snapshots (*.json) and Google Fonts: network first / stale-while-revalidate.
// - /api/* and other sites: always the network, never cached.

const VERSION = '__VERSION__'
const PRECACHE = __PRECACHE__
const SHELL = `mvlos-shell-${VERSION}`
const RUNTIME = 'mvlos-runtime'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mvlos-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

// The page asks the waiting worker to take over when the visitor accepts the update.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting()
})

async function networkFirst(request, cacheName, fallback) {
  try {
    const res = await fetch(request)
    if (res.ok) (await caches.open(cacheName)).put(request, res.clone())
    return res
  } catch (err) {
    const hit = (await caches.match(request)) ?? (fallback && (await caches.match(fallback)))
    if (hit) return hit
    throw err
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request)
  if (hit) return hit
  const res = await fetch(request)
  if (res.ok) (await caches.open(RUNTIME)).put(request, res.clone())
  return res
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME)
  const hit = await cache.match(request)
  const fresh = fetch(request)
    .then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(request, res.clone())
      return res
    })
    .catch(() => hit)
  return hit ?? fresh
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return
    if (request.mode === 'navigate') return event.respondWith(networkFirst(request, SHELL, '/'))
    if (url.pathname.startsWith('/assets/')) return event.respondWith(cacheFirst(request))
    if (url.pathname.endsWith('.json')) return event.respondWith(networkFirst(request, RUNTIME))
    return event.respondWith(staleWhileRevalidate(request))
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return event.respondWith(staleWhileRevalidate(request))
})
