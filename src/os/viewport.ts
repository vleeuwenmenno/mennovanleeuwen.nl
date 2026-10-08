// Phones' on-screen keyboards. Android (with interactive-widget=resizes-content) shrinks the page
// like a window resize; iOS lays the keyboard over the page and only shrinks the *visual*
// viewport, so anything pinned to the bottom (the boot console, terminal prompts, editors)
// ends up behind it. This publishes the visible area as CSS variables so full-screen layers fit
// above the keyboard, and flags when it is open.
//
//   --vvh  visible height     --vvt  how far the visible area is scrolled down

/** True in an app installed to the iOS home screen (Safari sets navigator.standalone there only). */
export const iosStandalone = () => (navigator as Navigator & { standalone?: boolean }).standalone === true

/**
 * Installed iOS apps report a page height about one status bar short of the screen, which leaves
 * a band under the dock. There, size the desktop from the screen itself (--app-h).
 */
function trackAppHeight() {
  if (!iosStandalone()) return
  const root = document.documentElement
  const apply = () => {
    const landscape = window.innerWidth > window.innerHeight
    const h = landscape ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height)
    root.style.setProperty('--app-h', `${h}px`)
  }
  window.addEventListener('resize', apply)
  window.addEventListener('orientationchange', apply)
  apply()
}

export function trackVisualViewport() {
  trackAppHeight()
  const vv = window.visualViewport
  if (!vv) return
  const root = document.documentElement
  let raf = 0
  const apply = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      root.style.setProperty('--vvh', `${Math.round(vv.height)}px`)
      root.style.setProperty('--vvt', `${Math.round(vv.offsetTop)}px`)
      const open = window.innerHeight - vv.height > 120
      if (open !== root.classList.contains('keyboard-open')) {
        root.classList.toggle('keyboard-open', open)
        window.dispatchEvent(new Event('mvlos:keyboard'))
      }
      // Keep whatever is being typed into in view once the layout has caught up.
      if (open) (document.activeElement as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' })
    })
  }
  vv.addEventListener('resize', apply)
  vv.addEventListener('scroll', apply)
  apply()
}
