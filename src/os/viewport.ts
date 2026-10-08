// Phones' on-screen keyboards. Android (with interactive-widget=resizes-content) shrinks the page
// like a window resize; iOS lays the keyboard over the page and only shrinks the *visual*
// viewport, so anything pinned to the bottom (the boot console, terminal prompts, editors)
// ends up behind it. This publishes the visible area as CSS variables so full-screen layers fit
// above the keyboard, and flags when it is open.
//
//   --vvh  visible height     --vvt  how far the visible area is scrolled down

export function trackVisualViewport() {
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
