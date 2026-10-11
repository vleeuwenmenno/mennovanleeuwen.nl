import { notify } from './notify'

/** A new release installed and waiting (src/os/alerts.ts shows it in Settings and the notification center). */
let waiting: ServiceWorker | null = null
const updateListeners = new Set<() => void>()
export const pendingUpdate = () => waiting
export const subscribeUpdate = (l: () => void) => {
  updateListeners.add(l)
  return () => updateListeners.delete(l)
}
/** Restarts into the waiting release. */
export const restartIntoUpdate = () => waiting?.postMessage('skip-waiting')

/**
 * A real restart (Reboot, or starting again after Shut down): reloads the page, first asking for a
 * new release so the restart comes up on it. A release found (or already waiting) takes over and
 * the page reloads when it does (the controllerchange listener below); otherwise it reloads as it is.
 */
export async function reloadIntoLatest() {
  const reload = () => location.reload()
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) {
      // Not forever: a slow network must not leave the machine stuck at the reboot screen.
      await Promise.race([reg.update().catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
      const next = reg.waiting ?? (await installed(reg))
      if (next && navigator.serviceWorker.controller) {
        next.postMessage('skip-waiting')
        setTimeout(reload, 4000)
        return
      }
    }
  } catch {
    /* no service worker here (development, private mode): a plain reload */
  }
  reload()
}

/** A release still installing after the update check, once it is ready (or null if it isn't soon). */
function installed(reg: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  const worker = reg.installing
  if (!worker) return Promise.resolve(null)
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 5000)
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') clearTimeout(t), resolve(worker)
      else if (worker.state === 'redundant') clearTimeout(t), resolve(null)
    })
  })
}

// Installable app and offline boot (see pwa/sw.js). Production builds only: in development the
// worker would cache files Vite is still changing.

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  window.addEventListener('load', async () => {
    let reg: ServiceWorkerRegistration
    try {
      reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    } catch {
      return // private mode, or blocked: the site works the same without it
    }
    // A new release installed in the background: offer to switch, rather than swapping under the visitor.
    const offer = (worker: ServiceWorker) => {
      waiting = worker
      updateListeners.forEach((l) => l())
      notify({
        title: 'MvL OS has an update',
        body: 'Click to restart into the new version',
        sticky: true,
        // Restarts into the worker waiting now: stale after a reload, so not kept.
        source: 'system.update',
        transient: true,
        onClick: () => worker.postMessage('skip-waiting'),
      })
    }
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting)
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker)
      })
    })
    let reloading = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return
      reloading = true
      location.reload()
    })
    // Long-open tabs (installed apps stay open for days) still hear about releases.
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000)
  })
}
