/** Shared desktop lattice. Overflow extends downwards; occupied cells are never reused. */
export const HOME_GRID = 20
export const ICON_W = 100
export const ICON_H = 120
export const HOME_LEFT = 14
export const HOME_TOP = 40
/** An icon is this tall; the rest of its cell (ICON_H) is only the gap to the row below, so the last row needs no gap. */
export const ICON_VISUAL_H = 112
/** Fallback for the room the dock takes at the bottom of the desktop; the real one is measured (bottomReserve.ts). */
export const DESK_BOTTOM = 100
let deskBottom = DESK_BOTTOM
/** The room kept free at the bottom of the desktop for the dock, in page px. */
export const deskBottomReserve = () => deskBottom
export function setDeskBottomReserve(px: number) {
  deskBottom = Number.isFinite(px) && px >= 0 ? Math.round(px) : DESK_BOTTOM
}
/** Whole rows of icons that fit in `height` above the reserve; the last one may use its own gap. */
export const deskRows = (height: number) => Math.max(1, Math.floor((height - HOME_TOP - deskBottom + (ICON_H - ICON_VISUAL_H)) / ICON_H))
export type HomeRect = { x: number; y: number; w: number; h: number }
export const overlaps = (a: HomeRect, b: HomeRect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/** Nearest free lattice origin on the current screen, or the first free row below it. */
export function freeHomeRect(want: HomeRect, occupied: HomeRect[], width: number, height: number, stepX = HOME_GRID, stepY = HOME_GRID, preserveOverflow = false): HomeRect {
  const cols = Math.max(1, Math.floor((width - HOME_LEFT * 2 - want.w) / stepX) + 1)
  const rows = Math.max(1, Math.floor((height - HOME_TOP - deskBottom - want.h) / stepY) + 1)
  const left = HOME_LEFT
  const clear = (r: HomeRect) => !occupied.some((o) => overlaps(r, o))
  const wantedRow = Math.max(0, Math.round((want.y - HOME_TOP) / stepY))
  const nearest = { ...want,
    x: left + Math.max(0, Math.min(cols - 1, Math.round((want.x - left) / stepX))) * stepX,
    y: HOME_TOP + (preserveOverflow ? wantedRow : Math.min(rows - 1, wantedRow)) * stepY }
  if (clear(nearest)) return nearest
  let best: HomeRect | undefined
  let distance = Infinity
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const r = { ...want, x: left + col * stepX, y: HOME_TOP + row * stepY }
    const d = (r.x - want.x) ** 2 + (r.y - want.y) ** 2
    if (d < distance && clear(r)) { best = r; distance = d }
  }
  if (best) return best
  // Below all existing rectangles is guaranteed free, even with oversized content.
  const bottom = Math.max(HOME_TOP, ...occupied.map((r) => r.y + r.h))
  const end = Math.max(rows, Math.ceil((bottom - HOME_TOP) / stepY))
  const overflowRows = [...new Set([rows, ...occupied.map((r) => Math.max(rows, Math.ceil((r.y + r.h - HOME_TOP) / stepY))), end + 1])].sort((a, b) => a - b)
  for (const row of overflowRows) for (let col = cols - 1; col >= 0; col--) {
    const r = { ...want, x: left + col * stepX, y: HOME_TOP + row * stepY }
    if (clear(r)) return r
  }
  return { ...want, x: left, y: HOME_TOP + (end + 1) * stepY }
}

export type HomeCell = { col: number; row: number }
export function iconLayout(ids: string[], stored: Record<string, HomeCell>, width: number, height: number, occupied: HomeRect[] = []): Record<string, HomeCell> {
  const cols = Math.max(1, Math.floor((width - HOME_LEFT * 2) / ICON_W))
  const rows = deskRows(height)
  const right = HOME_LEFT + (cols - 1) * ICON_W
  const out: Record<string, HomeCell> = {}
  const used = [...occupied]
  // Reserve valid remembered cells before filling gaps, including user-chosen overflow rows.
  for (const id of ids) {
    const p = stored[id]
    if (!p || !Number.isFinite(p.col) || !Number.isFinite(p.row)) continue
    const cell = { col: Math.max(0, Math.min(cols - 1, Math.round(p.col))), row: Math.max(0, Math.round(p.row)) }
    const r = { x: right - cell.col * ICON_W, y: HOME_TOP + cell.row * ICON_H, w: ICON_W, h: ICON_H }
    if (used.some((o) => overlaps(r, o))) continue
    out[id] = cell
    used.push(r)
  }
  for (const id of ids) {
    if (out[id]) continue
    const col = 0
    const row = 0
    // Preserve positions within the viewport; a narrowed desk reflows before using overflow.
    const r = freeHomeRect({ x: right - col * ICON_W, y: HOME_TOP + Math.min(row, rows - 1) * ICON_H, w: ICON_W, h: ICON_H }, used, HOME_LEFT * 2 + cols * ICON_W, height, ICON_W, ICON_H)
    out[id] = { col: Math.round((right - r.x) / ICON_W), row: Math.round((r.y - HOME_TOP) / ICON_H) }
    used.push(r)
  }
  return out
}

/** Old mobile column places have no grid marker. Preserve their sorted order, ignore desktop x/y. */
export function mobileHomeGeometry(p: HomeRect & { homeGrid?: boolean }, index: number, width: number): HomeRect {
  return { x: p.homeGrid ? p.x : HOME_LEFT, y: p.homeGrid ? p.y : HOME_TOP + index * 320,
    w: Math.min(Math.max(180, p.w), Math.max(1, width - 2 * HOME_LEFT)), h: p.h }
}
