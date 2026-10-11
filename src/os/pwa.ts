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
