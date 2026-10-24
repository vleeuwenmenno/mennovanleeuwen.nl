// MvL OS service worker. Generated at build time: VERSION and PRECACHE are filled in by the
// Vite plugin in vite.config.ts, so every release ships a different worker and visitors are
// offered the update.
//
// - The app shell (index.html, the built JS/CSS, icons) is cached up front, so the OS boots
//   offline.
// - Pages: network first, the cached shell when offline.
// - Hashed /assets/: cache first (they never change under the same name). A release reuses the
//   ones already cached and downloads only those that changed.
// - Data snapshots (*.json) and Google Fonts: network first / stale-while-revalidate.
// - /api/*, Agents shared links (/s/*) and other sites: always the network, never cached (a link
//   that was revoked must stop showing, offline too).

const VERSION = '__VERSION__'
const PRECACHE = __PRECACHE__
const SHELL = `mvlos-shell-${VERSION}`
const RUNTIME = 'mvlos-runtime'
// The server sends Vary: Accept-Encoding with its compressed files. A cached body is already
// decoded, so the encoding a request would accept must not stop it from matching.
const MATCH = { ignoreVary: true }

// A hashed file (/assets/name-<hash>.js) never changes under its name, so one kept from an earlier
// release (its shell cache, or the runtime cache) is reused rather than downloaded again: a release
// only downloads what changed. Like cache.addAll, all or nothing: every file is in hand before any is
// stored, and a failure fails the install, so the release that is running stays as it was.
//
// A cache that already existed under this name is left as it is when the install fails. It can only
// come from an install of this same worker: VERSION covers the worker's code and the file list, and
// the browser doesn't install a byte-identical worker again. Either that install finished (and this
// one only rewrites the same files) or it failed (and never took over). Only an install that
// succeeds, after every file is stored, can lead to activation, so a half-filled shell is never used.
async function precache() {
  const existed = await caches.has(SHELL)
  const cache = await caches.open(SHELL)
  try {
    const got = await Promise.all(
      PRECACHE.map(async (url) => {
        if (url.startsWith('/assets/')) {
          const kept = await caches.match(url, MATCH)
          if (kept && kept.ok && kept.type === 'basic') return [url, kept]
        }
        const res = await fetch(url)
        if (!res.ok) throw new TypeError(`precache: ${url} answered ${res.status}`)
        return [url, res]
      }),
    )
    await Promise.all(got.map(([url, res]) => cache.put(url, res)))
  } catch (err) {
    // Half a shell is no use: the next attempt starts clean. Only one this install made itself.
    if (!existed) await caches.delete(SHELL)
    throw err
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache())
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
const ownPath = (p) => (typeof p === 'string' && p.startsWith('/icons/') ? p : undefined)

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
      // A brand logo (GitHub, Minecraft…) when the server names one (server/notifier.ts). Only
      // this site's own icons: the message comes from the server, but a path is all it needs.
      icon: ownPath(msg.icon) || '/icons/app-192.png',
      badge: ownPath(msg.badge) || '/icons/app-192.png',
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
      const to = typeof url === 'string' && url.startsWith('/') ? url : '/'
      if (tab) return tab.focus().then(() => tab.postMessage({ openUrl: to }))
      return self.clients.openWindow(to)
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
    const hit = (await caches.match(request, MATCH)) ?? (fallback && (await caches.match(fallback, MATCH)))
    if (hit) return hit
    throw err
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request, MATCH)
  if (hit) return hit
  const res = await fetch(request)
  if (res.ok) (await caches.open(RUNTIME)).put(request, res.clone())
  return res
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME)
  const hit = await cache.match(request, MATCH)
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
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/s/') || url.pathname === '/healthz') return
    if (request.mode === 'navigate') return event.respondWith(networkFirst(request, SHELL, '/'))
    if (url.pathname.startsWith('/assets/')) return event.respondWith(cacheFirst(request))
    if (url.pathname.endsWith('.json')) return event.respondWith(networkFirst(request, RUNTIME))
    return event.respondWith(staleWhileRevalidate(request))
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return event.respondWith(staleWhileRevalidate(request))
})
