import { freeHomeRect, type HomeRect } from './homeLayout.ts'
export type DesktopItem = HomeRect & { pid: number; drawnW?: number; drawnH?: number }

/** Tape and resting slant count as occupied space for icons as well as neighbouring widgets. */
export function widgetEnvelope(item: HomeRect, drawnW = item.w, drawnH = item.h): HomeRect {
  const dx = Math.ceil(drawnH * Math.sin(4.5 * Math.PI / 180)) + 4
  const dy = Math.max(14, Math.ceil(drawnW / 2 * Math.sin(4.5 * Math.PI / 180))) + 4
  return { x: item.x - dx, y: item.y - dy, w: drawnW + 2 * dx, h: drawnH + 2 * dy }
}

/** Display projection only: retain user intent, reserve slanted corners, overflow below the desk. */
export function arrangeDesktop(items: DesktopItem[], width: number, height: number, priority?: number): Map<number, HomeRect> {
  const result = new Map<number, HomeRect>()
  const occupied: HomeRect[] = []
  const sorted = priority === undefined ? items : [...items].sort((a, b) => Number(b.pid === priority) - Number(a.pid === priority))
  for (const item of sorted) {
    const outer = widgetEnvelope(item, item.drawnW, item.drawnH)
    const dx = item.x - outer.x
    const dy = item.y - outer.y
    const r = freeHomeRect(outer, occupied, width, height)
    occupied.push(r)
    result.set(item.pid, { x: r.x + dx, y: r.y + dy, w: item.w, h: item.h })
  }
  return result
}
