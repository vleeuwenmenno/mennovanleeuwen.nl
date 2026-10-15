import { useLayoutEffect, useRef, type RefObject } from 'react'

// Keeping the game's floating things inside the screen: tooltips, popovers, the action wheel, the
// docked and dragged panels, messages and hints. Each one is measured where it ended up and, if it
// would stick out past an edge, shifted back in with EDGE pixels to spare (pushed up when it would
// clip at the bottom, and so on). Things too big for the screen keep their top left corner on it.
//
// The shift is written straight onto the element (the CSS `translate` property, separate from any
// `transform` its stylesheet uses), never into React state: measuring and moving it is one step,
// and moving it again gives the same answer, so nothing measures, moves and re-measures in a loop.

/** Pixels kept free between a floating thing and the edge of the screen. */
export const EDGE = 8

export type Box = { left: number; top: number; right: number; bottom: number }
export type Rect = { x: number; y: number; w: number; h: number }

/**
 * The part of the screen a floating thing may use, in page (client) coordinates: the game's own
 * box (`root`, which is the browser window when the game runs on its own, or the OS window it sits
 * in) cut to what the browser shows, less `margin` on every side. `top` keeps that many pixels of
 * the root's top free besides (under the top bar).
 */
export function screenArea(root: Element | null, margin = EDGE, top = 0): Box {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  const vw = vv ? vv.width : window.innerWidth
  const vh = vv ? vv.height : window.innerHeight
  const vx = vv ? vv.offsetLeft : 0
  const vy = vv ? vv.offsetTop : 0
  const r = root?.getBoundingClientRect()
  const left = Math.max(vx, r ? r.left : vx)
  const right = Math.min(vx + vw, r ? r.right : vx + vw)
  const t = Math.max(vy, r ? r.top + top : vy)
  const bottom = Math.min(vy + vh, r ? r.bottom : vy + vh)
  return { left: left + margin, top: t + margin, right: right - margin, bottom: bottom - margin }
}

/** Where a box of `r`'s size goes so it lies inside `area`: as near as it can to where it is. One
 * bigger than the area keeps its top (or left) edge on it. */
export function clampToViewport(r: Rect, area: Box): { x: number; y: number } {
  const x = Math.max(area.left, Math.min(area.right - r.w, r.x))
  const y = Math.max(area.top, Math.min(area.bottom - r.h, r.y))
  return { x, y }
}

/**
 * Where a box of `r`'s size goes so it is on the screen (`raw`, the screen with no margin): left
 * where it is when all of it already is (flush with an edge too, as a docked sheet is), else moved
 * in with `margin` to spare; one too big for that gets as much margin as there is room for, and one
 * bigger than the screen keeps its top (or left) edge on it.
 */
export function nudgeInside(r: Rect, raw: Box, margin = EDGE): { x: number; y: number } {
  const fit = (pos: number, size: number, lo: number, hi: number) => {
    if (pos >= lo - 0.5 && pos + size <= hi + 0.5) return pos
    const m = Math.max(0, Math.min(margin, (hi - lo - size) / 2))
    return size > hi - lo ? lo : Math.max(lo + m, Math.min(hi - m - size, pos))
  }
  return { x: fit(r.x, r.w, raw.left, raw.right), y: fit(r.y, r.h, raw.top, raw.bottom) }
}

/**
 * Where a tooltip of `w` by `h` goes for an anchor (page coordinates): centred above it, `gap`
 * away, or below it when it doesn't fit above; when it fits neither, on the side with more room.
 * Then kept inside `area` (pushed up off the bottom, in from the sides).
 */
export function placeTip(anchor: Box, w: number, h: number, area: Box, gap = 8): { x: number; y: number; below: boolean } {
  const above = anchor.top - gap - h
  const under = anchor.bottom + gap
  const roomAbove = anchor.top - gap - area.top
  const roomBelow = area.bottom - anchor.bottom - gap
  const below = h > roomAbove && (h <= roomBelow || roomBelow > roomAbove)
  const cx = (anchor.left + anchor.right) / 2 - w / 2
  const p = clampToViewport({ x: cx, y: below ? under : above, w, h }, area)
  return { ...p, below }
}

/** How far an element is shifted now (the `translate` this file put on it). */
function shiftOf(el: HTMLElement) {
  const m = /^(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?$/.exec(el.style.translate.trim())
  return m ? { x: Number(m[1]), y: Number(m[2] ?? 0) } : { x: 0, y: 0 }
}

/** The box `el` covers on the page, with its children when `deep` (ones placed outside it, such as
 * the action wheel's buttons round its middle). */
export function coverOf(el: HTMLElement, deep: boolean): Rect | null {
  const r = el.getBoundingClientRect()
  let left = r.left
  let top = r.top
  let right = r.right
  let bottom = r.bottom
  if (deep)
    for (const c of el.querySelectorAll<HTMLElement>('*')) {
      const b = c.getBoundingClientRect()
      if (!b.width && !b.height) continue
      left = Math.min(left, b.left)
      top = Math.min(top, b.top)
      right = Math.max(right, b.right)
      bottom = Math.max(bottom, b.bottom)
    }
  if (right - left <= 0 && bottom - top <= 0) return null
  return { x: left, y: top, w: right - left, h: bottom - top }
}

export type KeepOptions = {
  /** Pixels to keep free from the edges (EDGE). */
  margin?: number
  /** Pixels of the game's top to keep free besides, or a function that measures them (under the
   * top bar, say). */
  top?: number | ((root: Element | null) => number)
  /** The element whose box is the screen for this one (the game's root); its offset parent when
   * left out. */
  root?: () => Element | null
}

/**
 * Shifts `el` so all of it is inside the screen (see screenArea and nudgeInside: something that
 * would stick out is moved in with a margin to spare), or back to where it belongs once it fits
 * there again. Answers whether it moved it.
 */
export function keepInside(el: HTMLElement, o: KeepOptions = {}): boolean {
  const was = shiftOf(el)
  const cover = coverOf(el, false)
  if (!cover) return false
  const root = o.root ? o.root() : el.offsetParent ?? el.parentElement
  const top = typeof o.top === 'function' ? o.top(root) : (o.top ?? 0)
  const raw = screenArea(root, 0, top)
  // Where it would be with no shift, and where that has to go.
  const home = { x: cover.x - was.x, y: cover.y - was.y, w: cover.w, h: cover.h }
  const to = nudgeInside(home, raw, o.margin ?? EDGE)
  const sx = Math.round(to.x - home.x)
  const sy = Math.round(to.y - home.y)
  if (sx === Math.round(was.x) && sy === Math.round(was.y)) return false
  el.style.translate = sx || sy ? `${sx}px ${sy}px` : ''
  return true
}

/** How far down the game's top bar reaches inside `root` (0 without one): floating panels keep
 * below it. */
export function topBarInset(root: Element | null): number {
  const bar = root?.querySelector(':scope > .ew-top')
  if (!root || !bar) return 0
  const b = bar.getBoundingClientRect()
  return b.height > 0 ? Math.max(0, b.bottom - root.getBoundingClientRect().top) : 0
}

/**
 * Keeps the element `ref` points at inside the screen: after every render, whenever it changes
 * size (its content grew), and whenever the window is resized. See keepInside.
 */
export function useKeepInside(ref: RefObject<HTMLElement | null>, o: KeepOptions = {}) {
  // The options of the latest render, for the resize callbacks set up once.
  const opts = useRef(o)
  opts.current = o
  useLayoutEffect(() => {
    if (ref.current) keepInside(ref.current, o)
  })
  const el = ref.current
  useLayoutEffect(() => {
    const target = ref.current
    if (!target) return
    const again = () => {
      if (ref.current) keepInside(ref.current, opts.current)
    }
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(again) : null
    ro?.observe(target)
    window.addEventListener('resize', again)
    window.visualViewport?.addEventListener('resize', again)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', again)
      window.visualViewport?.removeEventListener('resize', again)
    }
    // Once per element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el])
}
