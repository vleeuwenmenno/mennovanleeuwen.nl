import { useCallback, useEffect, useRef } from 'react'
import { synced } from '../../os/synced'
import { useWM, type WinState } from '../../os/wm'

// Helpers shared by the games: high scores (in this browser, and on the server when signed in,
// so they follow you between devices), keyboard input that only reaches the focused window, and
// swipe gestures for phones.

/** Scores where less is better: times and shot counts. Everything else, more is better. */
const LOWER_IS_BETTER = /^(minesweeper-|pool-solo-)/
const better = (key: string, a: number, b: number) => (LOWER_IS_BETTER.test(key) ? Math.min(a, b) : Math.max(a, b))

export const highScores = synced<Record<string, number>>('games:highscores', {}, {
  legacyKey: 'mvlos.highscores.v1',
  normalize: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {}),
  // Two devices set records since they last synced: keep the better of each.
  merge: (local, remote) => {
    const out = { ...remote }
    for (const [k, v] of Object.entries(local)) out[k] = k in out ? better(k, v, out[k]) : v
    return out
  },
})

/** High score for a game; `submit` keeps the best and reports whether it was beaten. */
export function useHighScore(game: string, lowerIsBetter = false) {
  const all = highScores.use()
  const best = all[game] ?? null
  const submit = useCallback((score: number) => {
    const prev = highScores.get()[game]
    if (!lowerIsBetter && score <= 0) return false
    const beaten = prev === undefined || (lowerIsBetter ? score < prev : score > prev)
    if (!beaten) return false
    highScores.set((s) => ({ ...s, [game]: score }))
    return true
  }, [game, lowerIsBetter])
  return { best, submit }
}

/** True while this window is the frontmost one. */
export function useIsFocused(win: WinState) {
  const wm = useWM()
  return wm.focusedPid === win.pid
}

/** Keyboard handler that only fires while this window is focused. It swallows the browser's own
 * use of game keys: arrow and space scrolling, and Firefox's find-as-you-type on letters (WASD). */
export function useGameKeys(win: WinState, handler: (e: KeyboardEvent) => void) {
  const focused = useIsFocused(win)
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey
      if (plain && (e.key.length === 1 || ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key))) e.preventDefault()
      ref.current(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused])
  return focused
}

export type Dir = 'up' | 'down' | 'left' | 'right'

export const keyToDir = (key: string): Dir | null =>
  ({ ArrowUp: 'up', w: 'up', W: 'up', ArrowDown: 'down', s: 'down', S: 'down', ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right' })[key] as Dir | null ?? null

/**
 * Pointer handlers that turn a swipe into a direction as soon as the finger has travelled far
 * enough, rather than on release. With `repeat`, carrying on in another direction without lifting
 * swipes again (steering in Snake and Pac-Man); otherwise one swipe per touch.
 */
export function swipeHandlers(onSwipe: (d: Dir) => void, repeat = true) {
  let start: { x: number; y: number } | null = null
  const end = () => {
    start = null
  }
  return {
    onPointerDown: (e: React.PointerEvent) => {
      start = { x: e.clientX, y: e.clientY }
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!start) return
      const dx = e.clientX - start.x
      const dy = e.clientY - start.y
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 22) return
      onSwipe(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up')
      start = repeat ? { x: e.clientX, y: e.clientY } : null
    },
    onPointerUp: end,
    onPointerCancel: end,
  }
}

/**
 * Touch buttons that act on finger-down instead of on click (no tap delay, no double-tap zoom)
 * and, with `repeat`, keep acting while held, like a key. Returns a maker for each button's props.
 */
export function usePress() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }, [])
  useEffect(() => stop, [stop])
  return useCallback(
    (fn: () => void, repeat = false) => ({
      onPointerDown: (e: React.PointerEvent) => {
        e.preventDefault()
        stop()
        fn()
        if (!repeat) return
        const again = (delay: number) => {
          timer.current = setTimeout(() => {
            fn()
            again(55)
          }, delay)
        }
        again(190)
      },
      onPointerUp: stop,
      onPointerLeave: stop,
      onPointerCancel: stop,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
      // Keyboard activation (Enter/Space on a focused button) still works.
      onClick: (e: React.MouseEvent) => {
        if (e.detail === 0) fn()
      },
    }),
    [stop],
  )
}

/** Reads a CSS custom property so canvas games follow the accent color. */
export const cssVar = (name: string, el: Element = document.documentElement) => getComputedStyle(el).getPropertyValue(name).trim()

/**
 * Keeps a canvas's pixels matched to its size on screen, so a game drawn at a fixed logical size
 * stays sharp when the window grows. Drawing code keeps working in `w` x `h`; the context is
 * scaled to fit. Resizing clears the canvas, so `redraw` repaints games that only draw on a tick.
 */
export function useSharpCanvas(ref: React.RefObject<HTMLCanvasElement | null>, w: number, h: number, redraw?: () => void) {
  const again = useRef(redraw)
  again.current = redraw
  useEffect(() => {
    const c = ref.current
    if (!c) return
    c.style.aspectRatio = `${w} / ${h}`
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const pw = Math.max(w, Math.round(c.clientWidth * dpr))
      const ph = Math.round((pw * h) / w)
      if (c.width === pw && c.height === ph) return
      c.width = pw
      c.height = ph
      c.getContext('2d')!.setTransform(pw / w, 0, 0, ph / h, 0, 0)
      again.current?.()
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(c)
    return () => ro.disconnect()
  }, [ref, w, h])
}
