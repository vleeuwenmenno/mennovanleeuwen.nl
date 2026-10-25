/** Local display geometry only. This module never reads or writes a store. */
type Rect = { x: number; y: number; w: number; h: number }
export type DesktopItem = Rect & { pid: number; drawnW?: number; drawnH?: number }
const GAP = 8
const LIMIT = 128
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
const contains = (a: Rect, b: Rect) => a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi))

/**
 * Place notes in stable input order in the nearest free rectangle. Their tape and resting slant
 * (up to 4.5 degrees, around the top centre) count too. Free rectangles can overlap each other,
 * but never an already placed item. Work is bounded: at most 128 rectangles and 128 items.
 * When no space fits, keep the fitted position and reserve it for the following items. Crowded
 * desks can still overlap; there is no retry loop, shrinking, hiding, or persistence here.
 */
export function arrangeDesktop(items: DesktopItem[], width: number, height: number, priority?: number): Map<number, Rect> {
  const nearby = arrange(items, width, height, priority, false)
  if (!nearby.missed) return nearby.result
  // A row in the middle can leave two strips too short to use. One bounded packing pass can
  // make room by moving earlier items too. Keep the nearby layout unless packing fits more.
  const packed = arrange(items, width, height, priority, true)
  return packed.missed < nearby.missed ? packed.result : nearby.result
}

function arrange(items: DesktopItem[], width: number, height: number, priority: number | undefined, compact: boolean) {
  let missed = 0
  let free: Rect[] = [{ x: GAP, y: 28 + GAP, w: Math.max(0, width - 2 * GAP), h: Math.max(0, height - 28 - 2 * GAP) }]
  const result = new Map<number, Rect>()
  const sorted = priority === undefined ? items : [...items].sort((a, b) => Number(b.pid === priority) - Number(a.pid === priority))
  for (const item of sorted.slice(0, LIMIT)) {
    const w = item.drawnW ?? item.w
    const h = item.drawnH ?? item.h
    const dx = Math.ceil(h * Math.sin(4.5 * Math.PI / 180)) + GAP / 2
    const dy = Math.max(14, Math.ceil(w / 2 * Math.sin(4.5 * Math.PI / 180))) + GAP / 2
    const outer = { x: item.x - dx, y: item.y - dy, w: w + 2 * dx, h: h + 2 * dy }
    // Keep oversized notes' top and grip reachable, even when their bottom cannot fit.
    outer.x = clamp(outer.x, GAP, width - GAP - outer.w)
    outer.y = clamp(outer.y, 28 + GAP, height - GAP - outer.h)
    let best = outer
    let distance = Infinity
    for (const space of free) {
      if (space.w < outer.w || space.h < outer.h) continue
      const pack = compact && item.pid !== priority
      const x = pack ? space.x : clamp(outer.x, space.x, space.x + space.w - outer.w)
      const y = pack ? space.y : clamp(outer.y, space.y, space.y + space.h - outer.h)
      const d = pack ? y * width + x : (x - outer.x) ** 2 + (y - outer.y) ** 2
      if (d < distance) { best = { ...outer, x, y }; distance = d }
    }
    if (distance === Infinity) missed++
    result.set(item.pid, { x: best.x + dx, y: best.y + dy, w: item.w, h: item.h })
    const split: Rect[] = []
    for (const space of free) {
      if (!intersects(space, best)) { split.push(space); continue }
      if (best.x > space.x) split.push({ ...space, w: best.x - space.x })
      if (best.y > space.y) split.push({ ...space, h: best.y - space.y })
      if (best.x + best.w < space.x + space.w) split.push({ ...space, x: best.x + best.w, w: space.x + space.w - best.x - best.w })
      if (best.y + best.h < space.y + space.h) split.push({ ...space, y: best.y + best.h, h: space.y + space.h - best.y - best.h })
    }
    // Remove contained duplicates; retaining the largest spaces bounds worst-case work.
    free = split.filter((r, i) => !split.some((other, j) => j !== i && contains(other, r) && (!contains(r, other) || j < i)))
      .sort((a, b) => b.w * b.h - a.w * a.h).slice(0, LIMIT)
  }
  return { result, missed }
}
