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

// Web Push from the server (server/webpush.ts): an Agents answer or question while MvL OS is
// closed or in the background. Every push shows a notification: iOS stops delivering to apps that
// don't, and Chrome shows a generic one of its own instead.
self.addEventListener('push', (event) => {
  let msg = {}
  try {
    msg = event.data ? event.data.json() : {}
  } catch {
    msg = { title: 'MvL OS', body: event.data?.text() }
  }
  event.waitUntil(
    self.registration.showNotification(msg.title || 'MvL OS', {
      body: msg.body || '',
      tag: msg.tag,
      icon: '/icons/app-192.png',
      badge: '/icons/app-192.png',
      data: { thread: msg.thread, url: msg.url },
    }),
  )
})

// The browser replaced the subscription (it expired, or keys rotated): subscribe again and tell
// the server, with the same server key.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const { publicKey } = await fetch('/api/push/key', { credentials: 'same-origin' }).then((r) => r.json())
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
      await fetch('/api/push/subscription', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }) })
    })().catch(() => {}),
  )
})

// A notification clicked: an Agents thread (src/os/agentWatch.ts, or a push) goes to the open tab,
// which opens it, or a new window on it; anything else opens its address, or just MvL OS.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { thread, url } = event.notification.data || {}
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const tab = list.find((c) => new URL(c.url).origin === self.location.origin)
      if (typeof thread === 'string') {
        if (tab) return tab.focus().then(() => tab.postMessage({ openThread: thread }))
        return self.clients.openWindow(`/?open=agents&thread=${encodeURIComponent(thread)}`)
      }
      if (tab) return tab.focus()
      return self.clients.openWindow(typeof url === 'string' && url.startsWith('/') ? url : '/')
    }),
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
