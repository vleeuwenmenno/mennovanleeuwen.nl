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
  // The tallest visible height seen at this width: the screen without a keyboard. Newer iOS and
  // Android with resizes-content shrink window.innerHeight together with the visual viewport, so
  // comparing those two alone never sees the keyboard; comparing against this does.
  let fullWidth = 0
  let fullHeight = 0
  const editing = () => {
    const el = document.activeElement as HTMLElement | null
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
  }
  const apply = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      // Pinch zoom also shrinks the visual viewport. Let the browser magnify the
      // existing layout instead of treating it as a keyboard and resizing windows.
      if (Math.abs(vv.scale - 1) > 0.01) return
      root.style.setProperty('--vvh', `${Math.round(vv.height)}px`)
      root.style.setProperty('--vvt', `${Math.round(vv.offsetTop)}px`)
      // Rotating or resizing the window starts over; the keyboard never changes the width.
      if (Math.round(vv.width) !== fullWidth) { fullWidth = Math.round(vv.width); fullHeight = 0 }
      fullHeight = Math.max(fullHeight, vv.height, editing() ? 0 : window.innerHeight)
      const open = window.innerHeight - vv.height > 120 || (editing() && fullHeight - vv.height > 120)
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
  // Focus leaving a field closes the keyboard without always resizing first.
  document.addEventListener('focusin', apply)
  document.addEventListener('focusout', apply)
  apply()
}
