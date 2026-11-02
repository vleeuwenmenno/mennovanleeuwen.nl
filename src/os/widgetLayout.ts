import { freeHomeRect, type HomeRect } from './homeLayout.ts'
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
    const r = freeHomeRect(outer, occupied, width, height, 20, 20, mobile || item.pid === priority)
    occupied.push(r)
    result.set(item.pid, { x: r.x + dx, y: r.y + dy, w: item.w, h: item.h })
  }
  return result
}

/** Fit one widget without consulting its neighbours or changing its saved preference.
 * Content growth does not move the grip; the body scrolls at the viewport edge.
 */
export function fitWidget(g: { x: number; y: number; w: number; h: number }, width: number, height: number) {
  const sin = Math.sin(4.5 * Math.PI / 180)
  const bar = 28, gap = 8, grip = 30
  // About the top-centre pivot, the entire grip's vertical envelope for either supported
  // tilt sign is [-w/2*sin, w/2*sin + grip]. Constrain width first so BOTH ends can fit.
  // A short viewport may need less than the usual minimum width; this is display-only.
  const widthForHeight = (height - bar - 2 * gap - grip) / sin
  const w = Math.max(1, Math.min(Math.max(160, g.w), width - 48, widthForHeight))
  const rise = w / 2 * sin
  const maxY = height - gap - grip - rise
  const minY = bar + gap + rise
  // Keep the familiar top/content margins when possible, never at the expense of controls.
  const top = Math.min(Math.max(48, minY), maxY)
  const bottom = Math.max(top, Math.min(height - 140, maxY))
  // Horizontal expansion of the grip is at most grip*sin (<3px), within the 24px gutters.
  return { ...g, w, x: Math.max(24, Math.min(g.x, width - w - 24)),
    y: Math.max(top, Math.min(g.y, bottom)) }
}
