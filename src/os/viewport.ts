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
      // Pinch zoom also shrinks the visual viewport. Let the browser magnify the
      // existing layout instead of treating it as a keyboard and resizing windows.
      if (Math.abs(vv.scale - 1) > 0.01) return
      root.style.setProperty('--vvh', `${Math.round(vv.height)}px`)
      root.style.setProperty('--vvt', `${Math.round(vv.offsetTop)}px`)
      const open = window.innerHeight - vv.height > 120
      if (open !== root.classList.contains('keyboard-open')) {
        root.classList.toggle('keyboard-open', open)
        window.dispatchEvent(new Event('mvlos:keyboard'))
      }
      // Do not scroll the document here: iOS already reveals the focused control.
      // scrollIntoView on every viewport scroll can pan the whole shell and expose
      // an empty strip below it while the keyboard animates.
    })
  }
  vv.addEventListener('resize', apply)
  vv.addEventListener('scroll', apply)
  apply()
}
