import { useEffect, useRef } from 'react'

// The mouse's Back and Forward buttons, and the browser's own Back (its button, Alt+Left, a swipe):
// they go back in the focused window (Files a folder, Preview a picture, Archive up a folder)
// instead of off the site. The browser's Back is caught with one extra history entry, put there
// after the first click or key press (browsers skip entries added without one).

type Handler = { back?: () => void; forward?: () => void }

const handlers = new Map<number, React.RefObject<Handler>>()
let focused: number | null = null
let ignorePopUntil = 0

export const setBackFocus = (pid: number | null) => void (focused = pid)

function go(dir: 'back' | 'forward') {
  if (focused === null) return
  handlers.get(focused)?.current?.[dir]?.()
}

/** What Back and Forward do while this window is focused. */
export function useBackButton(pid: number, handler: Handler) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    handlers.set(pid, ref)
    return () => void handlers.delete(pid)
  }, [pid])
}

/**
 * Installed on an iPhone's home screen: there the browser's Back is a swipe in from the left edge,
 * which iOS animates as leaving the page (sliding the whole OS away) before the guard can catch
 * it, and it starts easily while dragging something near the edge. Without the extra entry there
 * is nothing to go back to, so the swipe does nothing. The mouse buttons still work.
 */
const iosHomeScreen = () => (navigator as Navigator & { standalone?: boolean }).standalone === true

let started = false
export function initBackButton() {
  if (started) return
  started = true
  const isSide = (e: MouseEvent) => e.button === 3 || e.button === 4
  window.addEventListener('mousedown', (e) => isSide(e) && e.preventDefault(), true)
  window.addEventListener(
    'mouseup',
    (e) => {
      if (!isSide(e)) return
      e.preventDefault()
      // Some browsers navigate anyway: the guard below then catches it, without going twice.
      ignorePopUntil = Date.now() + 600
      go(e.button === 3 ? 'back' : 'forward')
    },
    true,
  )
  const guard = () => {
    if (!(history.state as { mvlosGuard?: boolean } | null)?.mvlosGuard) history.pushState({ ...(history.state ?? {}), mvlosGuard: true }, '')
  }
  const arm = () => {
    if (!iosHomeScreen()) guard()
    window.removeEventListener('pointerdown', arm, true)
    window.removeEventListener('keydown', arm, true)
  }
  window.addEventListener('pointerdown', arm, true)
  window.addEventListener('keydown', arm, true)
  window.addEventListener('popstate', () => {
    if (!iosHomeScreen()) guard()
    if (Date.now() > ignorePopUntil) go('back')
  })
}
