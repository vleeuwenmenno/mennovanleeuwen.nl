import type { CSSProperties } from 'react'

// Dock points: where a floating window can be dropped to snap onto. While one is dragged the game
// shows a small anchor at each point it could go; let go near one and the window sits there
// exactly. The window's own default spot is always one of them (snapping there clears its entry
// in the layout, so it follows the default again), then the screen's corners and edge middles,
// below the top bar. A window on a dock point is stored as that point, not as pixels, so it stays
// there as the screen is resized.

/** A dock point: vertical (t top, m middle, b bottom) then horizontal (l left, c centre, r right). */
export type DockId = 'tl' | 'tc' | 'tr' | 'ml' | 'mr' | 'bl' | 'bc' | 'br'
export const DOCK_IDS: DockId[] = ['tl', 'tc', 'tr', 'ml', 'mr', 'bl', 'bc', 'br']
export const isDock = (v: unknown): v is DockId => typeof v === 'string' && DOCK_IDS.includes(v as DockId)

const NAMES: Record<DockId, string> = {
  tl: 'Top left', tc: 'Top centre', tr: 'Top right', ml: 'Left middle', mr: 'Right middle', bl: 'Bottom left', bc: 'Bottom centre', br: 'Bottom right',
}
export const dockName = (d: DockId | 'home') => (d === 'home' ? 'Default spot' : NAMES[d])

/** Pixels kept free at the sides and the bottom (as fit.ts keeps). */
export const DOCK_MARGIN = 8
/** Pixels kept free at the top: under the top bar. */
export const DOCK_TOP = 56
/** How near (in pixels) a dragged window's anchor point has to be to a dock point to snap to it. */
export const SNAP_MOUSE = 44
export const SNAP_TOUCH = 64

/** Where a window is meant to sit until moved: distances from the screen's edges, like CSS. */
export type At = { left?: number; right?: number; top?: number; bottom?: number }

const hOf = (d: DockId) => d[1] as 'l' | 'c' | 'r'
const vOf = (d: DockId) => d[0] as 't' | 'm' | 'b'

/** Whether a window on this point is centred on an axis, so its place needs its own size. */
export const dockCentred = (d: DockId) => hOf(d) === 'c' || vOf(d) === 'm'

/** Where a window of `w` by `h` has its top left corner on `d`, inside a screen of `rw` by `rh`. */
export function dockXY(d: DockId, w: number, h: number, rw: number, rh: number): { x: number; y: number } {
  const hh = hOf(d)
  const v = vOf(d)
  const x = hh === 'l' ? DOCK_MARGIN : hh === 'r' ? rw - DOCK_MARGIN - w : (rw - w) / 2
  const y = v === 't' ? DOCK_TOP : v === 'b' ? rh - DOCK_MARGIN - h : DOCK_TOP + (rh - DOCK_TOP - h) / 2
  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * The CSS for a window on `d`. The sides it hangs from are plain edge distances, so the window
 * stays put whatever it grows to; a centred axis needs the sizes (`fit`, measured by the window).
 */
export function dockStyle(d: DockId, fit: { w: number; h: number; rw: number; rh: number }): CSSProperties {
  const s: CSSProperties = {}
  const hh = hOf(d)
  const v = vOf(d)
  if (hh === 'l') s.left = DOCK_MARGIN
  else if (hh === 'r') s.right = DOCK_MARGIN
  else s.left = fit.rw ? dockXY(d, fit.w, fit.h, fit.rw, fit.rh).x : 0
  if (v === 't') s.top = DOCK_TOP
  else if (v === 'b') s.bottom = DOCK_MARGIN
  else s.top = fit.rh ? dockXY(d, fit.w, fit.h, fit.rw, fit.rh).y : DOCK_TOP
  return s
}

/** A place to drop: the window's top left corner there (`x`, `y`) and the point of the window that
 * is measured against the cursor's drag (`px`, `py`: a corner or an edge's middle on the screen). */
export type Cand = { id: DockId | 'home'; x: number; y: number; px: number; py: number }

/** The corner a default spot hangs from. */
const homeKind = (at: At) => ({ hh: (at.left !== undefined || at.right === undefined ? 'l' : 'r') as 'l' | 'r', hv: (at.top !== undefined || at.bottom === undefined ? 't' : 'b') as 't' | 'b' })

/** Which point of the window's box is its anchor: a corner or an edge's middle, by dock. */
function anchorPoint(x: number, y: number, w: number, h: number, hh: 'l' | 'c' | 'r', v: 't' | 'm' | 'b') {
  return { px: x + (hh === 'l' ? 0 : hh === 'c' ? w / 2 : w), py: y + (v === 't' ? 0 : v === 'm' ? h / 2 : h) }
}

/**
 * Every place the window of `w` by `h` can be dropped: first its default spot (`home`, where it
 * sits unmoved, measured; `at` says which corner it hangs from), then the dock points that aren't
 * on top of it.
 */
export function candidates(home: { x: number; y: number }, at: At, w: number, h: number, rw: number, rh: number): Cand[] {
  const { hh, hv } = homeKind(at)
  const out: Cand[] = [{ id: 'home', x: home.x, y: home.y, ...anchorPoint(home.x, home.y, w, h, hh, hv) }]
  for (const d of DOCK_IDS) {
    const { x, y } = dockXY(d, w, h, rw, rh)
    const a = anchorPoint(x, y, w, h, hOf(d), vOf(d))
    // The default spot already covers a dock point it is (nearly) the same as.
    if (hOf(d) === hh && vOf(d) === hv && Math.abs(x - home.x) <= 8 && Math.abs(y - home.y) <= 8) continue
    out.push({ id: d, x, y, ...a })
  }
  return out
}

/** The place whose anchor is nearest the dragged window's (its box at `x`, `y`), if within `reach`.
 * The default spot wins a tie, being first. */
export function nearest(cands: Cand[], x: number, y: number, w: number, h: number, at: At, reach: number): Cand | null {
  const { hh, hv } = homeKind(at)
  let best: Cand | null = null
  let bestD = Infinity
  for (const c of cands) {
    const hx = c.id === 'home' ? hh : hOf(c.id)
    const vx = c.id === 'home' ? hv : vOf(c.id)
    const a = anchorPoint(x, y, w, h, hx, vx)
    const dist = Math.hypot(a.px - c.px, a.py - c.py)
    if (dist <= reach && dist < bestD) (best = c), (bestD = dist)
  }
  return best
}
