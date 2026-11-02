// The arithmetic behind useSplitter, apart from React so scripts/xed-layout-check.ts can test it.

/** Pixels a plain arrow key moves the splitter, and with Shift. */
export const SPLIT_STEP = 10
export const SPLIT_STEP_BIG = 50

export const clampSplit = (v: number, min: number, max: number) => Math.round(Math.max(min, Math.min(Math.max(min, max), v)))

/**
 * `edge` is the edge of its panel the handle sits on: 'right' for a panel at the left of the
 * handle (dragging right grows it), 'left' for a panel at its right (dragging left grows it).
 */
export type SplitEdge = 'left' | 'right'

/** The width after the pointer moved `delta` UI pixels (right is positive) from `start`. */
export const splitDragValue = (start: number, delta: number, edge: SplitEdge, min: number, max: number) => clampSplit(start + (edge === 'right' ? delta : -delta), min, max)

/**
 * What a key does to the width: a new width, 'reset', or null for a key the splitter ignores.
 * Arrows move the handle that way (so the panel grows or shrinks by `edge`); Shift moves it further.
 */
export function splitKeyValue(key: string, shift: boolean, value: number, edge: SplitEdge, min: number, max: number): number | 'reset' | null {
  if (key === 'Enter') return 'reset'
  if (key === 'Home') return min
  if (key === 'End') return clampSplit(max, min, max)
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  const toward = (key === 'ArrowRight' ? 1 : -1) * (edge === 'right' ? 1 : -1)
  return clampSplit(value + toward * (shift ? SPLIT_STEP_BIG : SPLIT_STEP), min, max)
}
