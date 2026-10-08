import { useCallback, useEffect, useRef, useState } from 'react'
import { useWM, type WinState } from '../../os/wm'

// Helpers shared by the games: per-browser high scores, keyboard input that only reaches the
// focused window, and swipe gestures for phones.

const KEY = 'mvlos.highscores.v1'

function readScores(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

/** High score for a game; `submit` keeps the best and reports whether it was beaten. */
export function useHighScore(game: string, lowerIsBetter = false) {
  const [best, setBest] = useState<number | null>(() => readScores()[game] ?? null)
  useEffect(() => setBest(readScores()[game] ?? null), [game])
  const submit = useCallback((score: number) => {
    const all = readScores()
    const prev = all[game]
    if (!lowerIsBetter && score <= 0) return false
    const beaten = prev === undefined || (lowerIsBetter ? score < prev : score > prev)
    if (!beaten) return false
    all[game] = score
    try {
      localStorage.setItem(KEY, JSON.stringify(all))
    } catch {
      /* best score just won't persist */
    }
    setBest(score)
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

/** Pointer handlers that turn a swipe into a direction. */
export function swipeHandlers(onSwipe: (d: Dir) => void) {
  let start: { x: number; y: number } | null = null
  return {
    onPointerDown: (e: React.PointerEvent) => {
      start = { x: e.clientX, y: e.clientY }
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (!start) return
      const dx = e.clientX - start.x
      const dy = e.clientY - start.y
      start = null
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return
      onSwipe(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up')
    },
  }
}

/** Reads a CSS custom property so canvas games follow the accent color. */
export const cssVar = (name: string, el: Element = document.documentElement) => getComputedStyle(el).getPropertyValue(name).trim()
