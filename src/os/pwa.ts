import { notify } from './notify'

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
    const offer = (worker: ServiceWorker) =>
      notify({
        title: 'MvL OS has an update',
        body: 'Click to restart into the new version',
        sticky: true,
        onClick: () => worker.postMessage('skip-waiting'),
      })
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
