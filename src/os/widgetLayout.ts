import { freeHomeRect, overlaps, type HomeRect } from './homeLayout.ts'
export type DesktopItem = HomeRect & { pid: number; drawnW?: number; drawnH?: number }

/** Tape and resting slant count as occupied space for icons as well as neighbouring widgets. */
export function widgetEnvelope(item: HomeRect, drawnW = item.w, drawnH = item.h): HomeRect {
  const dx = Math.ceil(drawnH * Math.sin(4.5 * Math.PI / 180)) + 4
  const dy = Math.max(14, Math.ceil(drawnW / 2 * Math.sin(4.5 * Math.PI / 180))) + 4
  return { x: item.x - dx, y: item.y - dy, w: drawnW + 2 * dx, h: drawnH + 2 * dy }
}

/** Mobile cards stay upright; keep their tape above and a gap to the next cell. */
export function mobileWidgetEnvelope(item: HomeRect, drawnW = item.w, drawnH = item.h): HomeRect {
  return { x: item.x, y: item.y - 20, w: Math.max(item.w, drawnW) + 8, h: Math.max(item.h, drawnH) + 28 }
}

/** Display projection only: retain user intent, reserve slanted corners, overflow below the desk. */
export function arrangeDesktop(items: DesktopItem[], width: number, height: number, priority?: number, mobile = false): Map<number, HomeRect> {
  const result = new Map<number, HomeRect>()
  const occupied: HomeRect[] = []
  const sorted = priority === undefined ? items : [...items].sort((a, b) => Number(b.pid === priority) - Number(a.pid === priority))
  for (const item of sorted) {
    const outer = mobile ? mobileWidgetEnvelope(item, item.drawnW, item.drawnH) : widgetEnvelope(item, item.drawnW, item.drawnH)
    const dx = item.x - outer.x
    const dy = item.y - outer.y
    // Desktop: a widget with nothing in its way is drawn exactly where it is (resizing a browser
    // must not move a centred one by the lattice's few pixels); only one that collides looks for a
    // free lattice cell nearby.
    const exact = !mobile && !occupied.some((o) => overlaps(outer, o))
    const r = exact ? outer : freeHomeRect(outer, occupied, width, height, 20, 20, mobile || item.pid === priority)
    occupied.push(r)
    result.set(item.pid, { x: r.x + dx, y: r.y + dy, w: item.w, h: item.h })
  }
  return result
}

/** The screen (in page pixels, see uiScale.ts) a widget's saved place was put on. */
export type Screen = { vw: number; vh: number }

/**
 * Where a desktop widget may go on a screen: its width (made smaller when the screen is) and the
 * range its top-left corner can travel. About the top-centre pivot, the entire grip's vertical
 * envelope for either supported tilt sign is [-w/2*sin, w/2*sin + grip], so width is constrained
 * first so BOTH ends can fit. A short viewport may need less than the usual minimum width; this is
 * display-only. The range can be empty or negative (a screen too small for the widget): then the
 * top-left corner of the range is used.
 */
export function widgetBounds(g: { w: number }, width: number, height: number) {
  const sin = Math.sin(4.5 * Math.PI / 180)
  const bar = 28, gap = 8, grip = 30
  const widthForHeight = (height - bar - 2 * gap - grip) / sin
  const w = Math.max(1, Math.min(Math.max(160, g.w), width - 48, widthForHeight))
  const rise = w / 2 * sin
  const maxY = height - gap - grip - rise
  const minY = bar + gap + rise
  // Keep the familiar top/content margins when possible, never at the expense of controls.
  const top = Math.min(Math.max(48, minY), maxY)
  const bottom = Math.max(top, Math.min(height - 140, maxY))
  // Horizontal expansion of the grip is at most grip*sin (<3px), within the 24px gutters.
  return { w, minX: 24, maxX: width - w - 24, minY: top, maxY: bottom }
}

/** Fit one widget without consulting its neighbours or changing its saved preference.
 * Content growth does not move the grip; the body scrolls at the viewport edge.
 */
export function fitWidget(g: { x: number; y: number; w: number; h: number }, width: number, height: number) {
  const b = widgetBounds(g, width, height)
  return { ...g, w: b.w, x: Math.max(b.minX, Math.min(g.x, b.maxX)), y: Math.max(b.minY, Math.min(g.y, b.maxY)) }
}

/**
 * A widget as a screen of another size shows it. Its place is kept as it was put (`g`, on the
 * screen `from`); what is drawn is that place's share of the room the widget can travel on this
 * screen, so a widget in the middle stays in the middle and one at an edge stays at that edge,
 * whatever its size. Nothing here is saved: asking again for the first screen gives the place
 * back exactly, however many sizes it went through. Without a known first screen (older saves),
 * or one that left no room to travel, the place is used as it is and only kept on the screen.
 */
export function projectWidget(g: { x: number; y: number; w: number; h: number }, from: Screen | null | undefined, width: number, height: number) {
  if (!from || !(from.vw > 0) || !(from.vh > 0) || (from.vw === width && from.vh === height)) return fitWidget(g, width, height)
  const a = widgetBounds(g, from.vw, from.vh)
  const b = widgetBounds(g, width, height)
  const along = (v: number, lo0: number, hi0: number, lo1: number, hi1: number) => {
    // A place outside the travel range (or from a screen with none) has no share to carry over.
    if (!(hi0 - lo0 > 1) || v < lo0 - 1 || v > hi0 + 1) return v
    const t = Math.max(0, Math.min(1, (v - lo0) / (hi0 - lo0)))
    return Math.round(hi1 > lo1 ? lo1 + t * (hi1 - lo1) : lo1)
  }
  return fitWidget({ ...g, x: along(g.x, a.minX, a.maxX, b.minX, b.maxX), y: along(g.y, a.minY, a.maxY, b.minY, b.maxY) }, width, height)
}
