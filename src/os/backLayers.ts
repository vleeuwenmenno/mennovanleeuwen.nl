import { useEffect, useRef } from 'react'

// What the phone's Back (and the browser's) closes first. Anything that sits on top of the page
// (a menu, a dialog, Spotlight, the launcher, the notification list, the dock's More, the home
// editor) registers a layer while it is open; Back closes the newest layer before anything else
// happens (src/os/backButton.ts). Layers only ever close themselves: nothing here touches an
// app's own history.

type Layer = { id: number; close: () => void }
const layers: Layer[] = []
let next = 1

/** Registers a layer; the returned function removes it. */
export function pushBackLayer(close: () => void) {
  const layer = { id: next++, close }
  layers.push(layer)
  return () => {
    const at = layers.indexOf(layer)
    if (at >= 0) layers.splice(at, 1)
  }
}

/** Closes the newest layer. Whether there was one. */
export function closeTopLayer() {
  const top = layers[layers.length - 1]
  if (!top) return false
  top.close()
  return true
}

export const hasBackLayer = () => layers.length > 0

/** While `open`, Back calls `close`. */
export function useBackLayer(open: boolean, close: () => void) {
  const ref = useRef(close)
  ref.current = close
  useEffect(() => (open ? pushBackLayer(() => ref.current()) : undefined), [open])
}

// What Back does when nothing else wants it (on a phone: leave the app window, then go back to
// the first home screen). Returns whether it did something.
let fallback: (() => boolean) | null = null
export const setBackFallback = (fn: (() => boolean) | null) => void (fallback = fn)
export const runBackFallback = () => fallback?.() ?? false
