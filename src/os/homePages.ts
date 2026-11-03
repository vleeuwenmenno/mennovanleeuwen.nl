import { HOME_GRID, HOME_LEFT, HOME_TOP, ICON_H, ICON_VISUAL_H, ICON_W, mobileHomeGeometry, overlaps, type HomeRect } from './homeLayout.ts'

/**
 * Phone home screens: fixed pages side by side, no vertical scrolling. A widget or note's window
 * coordinate `x` is logical: `page * PAGE_STRIDE + x on its page`. The stride is far wider than
 * any phone (the phone layout is only used below 720px), so a turned or resized screen keeps
 * every item on its page, and only the pixels (`page * width + x`) are worked out when drawing.
 */
export const PAGE_STRIDE = 1000
export const MAX_PAGES = 12
/** Fallback for the room kept free below a page for the page dots and the dock; the real one is measured (bottomReserve.ts). */
export const PAGE_DOCK = 122
let pageDockPx = PAGE_DOCK
/** Room kept free below a page: the dock, the page dots above it, and the phone's safe area, in page px. */
export const pageDock = () => pageDockPx
export function setPageDock(px: number) {
  pageDockPx = Number.isFinite(px) && px >= 0 ? Math.round(px) : PAGE_DOCK
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
export const clampPage = (page: number) => clamp(Math.floor(Number.isFinite(page) ? page : 0), 0, MAX_PAGES - 1)
export const pageOfX = (x: number) => clampPage(Math.floor(x / PAGE_STRIDE))
export const localX = (x: number) => x - pageOfX(x) * PAGE_STRIDE
export const joinX = (page: number, x: number) => clampPage(page) * PAGE_STRIDE + x
/** Where a logical x is drawn, in page pixels, on a screen `width` wide. */
export const drawX = (x: number, width: number) => pageOfX(x) * width + localX(x)
/** The logical x of content pixel `cx` for an item `w` wide: its page is the one most of it is on. */
export function fromContentX(cx: number, w: number, width: number, pages = MAX_PAGES) {
  const page = clamp(Math.floor((cx + w / 2) / width), 0, Math.min(MAX_PAGES, pages) - 1)
  // An item straddling the page edge sits on the page its middle is on: pushed wholly onto it.
  return joinX(page, clamp(cx - page * width, 0, Math.max(0, width - w)))
}

/** Usable height of one page. */
export const pageHeight = (height: number) => Math.max(1, height - HOME_TOP - pageDockPx)
/** Whole rows that fit: the last one only needs its icon, not the gap a cell keeps below it. */
export const pageRows = (height: number) => Math.max(1, Math.floor((pageHeight(height) + (ICON_H - ICON_VISUAL_H)) / ICON_H))
export const pageCols = (width: number) => Math.max(1, Math.floor((width - HOME_LEFT * 2) / ICON_W))

/**
 * The page a widget saved before pages existed falls on. The old home was one long column; cut at
 * the height of the screen it was saved on (so turning the phone or the address bar sliding away
 * moves nothing), and an item that would straddle a cut starts the next page.
 */
export function legacyWidgetPage(y: number, h: number, savedHeight: number): { page: number; y: number } {
  const usable = Math.max(240, pageHeight(savedHeight))
  const rel = Math.max(0, y - HOME_TOP)
  let page = Math.floor(rel / usable)
  let top = HOME_TOP + rel - page * usable
  if (page < MAX_PAGES - 1 && top + Math.min(h, usable) > HOME_TOP + usable + 1) {
    page += 1
    top = HOME_TOP
  }
  return { page: clampPage(page), y: top }
}

/**
 * What the old one-page home is cut by. Fixed, not the screen's own size: an untouched old place
 * must not change page because the phone turned or the address bar slid away.
 */
export const LEGACY_ROWS = 5
export const LEGACY_HEIGHT = 800

/** Geometry (logical x) of a phone widget from its saved place: explicit page, or the old column cut into pages. */
export function mobileWidgetRect(p: HomeRect & { homeGrid?: boolean; page?: number; vh?: number; vw?: number; phone?: boolean }, index: number, width: number, _height: number): HomeRect {
  const base = mobileHomeGeometry(p, index, width)
  // The place as it was put (at least the narrowest a widget is): fitting it to this screen is
  // what the display does (fitPhoneWidget), so a narrow phone never shrinks what is kept.
  const x = Math.max(HOME_LEFT, base.x)
  const put = { ...base, w: Math.max(180, p.w) }
  if (typeof p.page === 'number') return { ...put, x: joinX(p.page, x) }
  // Saved on a phone: cut at the height of that screen; from a big screen: at the fixed legacy height.
  const onPhone = p.phone ?? (p.vw ?? 0) < 720
  const legacy = legacyWidgetPage(base.y, base.h, onPhone && p.vh ? p.vh : LEGACY_HEIGHT)
  return { ...put, x: joinX(legacy.page, x), y: legacy.y }
}

/**
 * A phone widget as a screen `width` wide shows it: at most as wide as the page and kept on its
 * page, from the place it was put (`g`, logical x). Display only: asking again with the first
 * width gives the place back, and nothing here is saved.
 */
export function fitPhoneWidget(g: { x: number; w: number }, width: number): { x: number; w: number } {
  const wide = Math.max(1, Math.min(g.w, width - 2 * HOME_LEFT))
  return { w: wide, x: joinX(pageOfX(g.x), Math.max(HOME_LEFT, Math.min(localX(g.x), width - wide - HOME_LEFT))) }
}

/** The nearest free lattice cell wholly on a page, or none. Ties go to the earlier row, then column. */
export function fitOnPage(want: HomeRect, occupied: HomeRect[], width: number, height: number, stepX = HOME_GRID, stepY = HOME_GRID): HomeRect | undefined {
  const maxX = Math.max(HOME_LEFT, width - HOME_LEFT - want.w)
  const maxY = Math.max(HOME_TOP, height - pageDockPx - want.h)
  const clear = (r: HomeRect) => !occupied.some((o) => overlaps(r, o))
  let best: HomeRect | undefined
  let distance = Infinity
  for (let y = HOME_TOP; y <= maxY; y += stepY) {
    for (let x = HOME_LEFT; x <= maxX; x += stepX) {
      const r = { ...want, x, y }
      const d = (x - want.x) ** 2 + (y - want.y) ** 2
      if (d < distance && clear(r)) { best = r; distance = d }
    }
  }
  return best
}

export type PagedItem = HomeRect & { id: number }

/**
 * Phone widgets and notes, each kept wholly on one page (display only; what was asked for stays
 * saved). The priority item and then the rest, in order, take the free cell nearest the one they
 * asked for; one that does not fit its page goes to the next page that has room. Returns logical x.
 */
export function arrangePages(items: (PagedItem & { drawnW?: number; drawnH?: number; envelope: (i: PagedItem) => HomeRect })[], width: number, height: number, priority?: number): Map<number, HomeRect> {
  const result = new Map<number, HomeRect>()
  const taken: HomeRect[][] = Array.from({ length: MAX_PAGES }, () => [])
  const sorted = priority === undefined ? items : [...items].sort((a, b) => Number(b.id === priority) - Number(a.id === priority))
  for (const item of sorted) {
    const page0 = pageOfX(item.x)
    const local = { ...item, x: localX(item.x) }
    const outer = item.envelope(local)
    const dx = local.x - outer.x
    const dy = local.y - outer.y
    let placed: { page: number; r: HomeRect } | undefined
    for (let page = page0; page < MAX_PAGES && !placed; page++) {
      const want = page === page0 ? outer : { ...outer, x: HOME_LEFT, y: HOME_TOP }
      const r = fitOnPage(want, taken[page], width, height)
      if (r) placed = { page, r }
    }
    // Nothing has room (every page full): stay on the asked-for page, clamped inside it.
    placed ??= { page: page0, r: { ...outer, x: clamp(outer.x, HOME_LEFT, Math.max(HOME_LEFT, width - HOME_LEFT - outer.w)), y: clamp(outer.y, HOME_TOP, Math.max(HOME_TOP, height - pageDockPx - outer.h)) } }
    taken[placed.page].push(placed.r)
    result.set(item.id, { x: joinX(placed.page, placed.r.x + dx), y: placed.r.y + dy, w: item.w, h: item.h })
  }
  return result
}

// --- icons ---

export type PageCell = { page: number; col: number; row: number }

/** The page a saved icon cell is on: its own, or (older saves) the old tall home cut by LEGACY_ROWS. */
export const savedIconPage = (p: { row: number; page?: number }) => (typeof p.page === 'number' ? clampPage(p.page) : clampPage(Math.floor(Math.max(0, p.row) / LEGACY_ROWS)))
/** The same cell with its page moved down one (and pinned: an older cell's row becomes its row on that page). */
export const cellOnPreviousPage = <T extends { row: number; page?: number }>(p: T): T => ({ ...p, row: typeof p.page === 'number' ? p.row : Math.max(0, p.row) % LEGACY_ROWS, page: savedIconPage(p) - 1 })
type StoredCell = { col?: unknown; row?: unknown; page?: unknown }

/** Icon cells count columns from the right, as on the desktop. */
const cellRect = (c: PageCell, cols: number): HomeRect => ({ x: HOME_LEFT + (cols - 1 - c.col) * ICON_W, y: HOME_TOP + c.row * ICON_H, w: ICON_W, h: ICON_H })

/** `page`'s widget rectangles, in page pixels: what icons stay clear of. */
export type PageObstacle = { page: number; rect: HomeRect }

export function freeCell(want: PageCell, used: HomeRect[][], cols: number, rows: number, maxPage = MAX_PAGES - 1, reading = false): PageCell | undefined {
  for (let page = want.page; page <= maxPage; page++) {
    const first = page === want.page
    let best: PageCell | undefined
    let distance = Infinity
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      const c = { page, col, row }
      if (used[page]?.some((o) => overlaps(cellRect(c, cols), o))) continue
      // The wanted page: the cell nearest the wanted one (`reading`: the first free one, left to
      // right and top to bottom). Later pages: the first free cell.
      const d = first && !reading ? (col - want.col) ** 2 + (row - want.row) ** 2 : row * cols + (cols - 1 - col)
      if (d < distance) { best = c; distance = d }
    }
    if (best) return best
  }
  return undefined
}

/**
 * Where every icon goes on a phone's pages. Remembered cells with a page are kept (clamped onto the
 * page); older cells without one (the single scrolling home) are cut into pages by rows. A cell that
 * is taken, or that a widget covers, goes to the nearest free one, and a full page spills onto the
 * next. New icons take the first free cell. Never overlaps, never changes a free icon's cell.
 */
export function iconPages(ids: string[], stored: Record<string, StoredCell | undefined>, width: number, height: number, obstacles: PageObstacle[] = []): Record<string, PageCell> {
  const cols = pageCols(width)
  const rows = pageRows(height)
  const used: HomeRect[][] = Array.from({ length: MAX_PAGES }, () => [])
  for (const o of obstacles) used[clampPage(o.page)].push(o.rect)
  const out: Record<string, PageCell> = {}
  const place = (id: string, c: PageCell) => { out[id] = c; used[c.page].push(cellRect(c, cols)) }
  const finite = (s: StoredCell | undefined): s is { col: number; row: number; page?: unknown } => !!s && Number.isFinite(s.col) && Number.isFinite(s.row)
  const want = (s: { col: number; row: number; page?: unknown }): PageCell => {
    const col = clamp(Math.round(s.col), 0, cols - 1)
    const row = Math.max(0, Math.round(s.row))
    if (typeof s.page === 'number' && Number.isFinite(s.page)) return { page: clampPage(s.page), col, row: Math.min(row, rows - 1) }
    return { page: clampPage(Math.floor(row / LEGACY_ROWS)), col, row: Math.min(row % LEGACY_ROWS, rows - 1) }
  }
  const later: [string, PageCell][] = []
  // Cells that were chosen with pages first, then the old ones, so a new choice never loses to an old guess.
  for (const explicit of [true, false]) for (const id of ids) {
    const s = stored[id]
    if (!finite(s) || (typeof s.page === 'number') !== explicit) continue
    const c = want(s)
    if (used[c.page].some((o) => overlaps(cellRect(c, cols), o))) later.push([id, c])
    else place(id, c)
  }
  for (const [id, c] of later) {
    const free = freeCell(c, used, cols, rows)
    if (free) place(id, free)
    else place(id, c) // Every page is full: stack on its own cell rather than lose it.
  }
  for (const id of ids) {
    if (out[id]) continue
    const free = freeCell({ page: 0, col: cols - 1, row: 0 }, used, cols, rows, MAX_PAGES - 1, true)
    place(id, free ?? { page: MAX_PAGES - 1, col: cols - 1, row: 0 })
  }
  return out
}

/** The nearest free cell to a dropped point (`x` in logical page space, `y` in page pixels). */
export function dropCell(x: number, y: number, width: number, height: number, taken: HomeRect[][], pages: number): PageCell | undefined {
  const cols = pageCols(width)
  const rows = pageRows(height)
  const px = localX(x)
  const want = {
    page: clamp(pageOfX(x), 0, Math.max(0, pages - 1)),
    col: clamp(Math.round((HOME_LEFT + (cols - 1) * ICON_W - px) / ICON_W), 0, cols - 1),
    row: clamp(Math.round((y - HOME_TOP) / ICON_H), 0, rows - 1),
  }
  return freeCell(want, taken, cols, rows, Math.min(MAX_PAGES, Math.max(pages, want.page + 1)) - 1) ?? freeCell(want, taken, cols, rows)
}

/** Rectangles of the icons already placed, by page, for `dropCell`. */
export function takenCells(cells: PageCell[], width: number, obstacles: PageObstacle[] = []): HomeRect[][] {
  const cols = pageCols(width)
  const used: HomeRect[][] = Array.from({ length: MAX_PAGES }, () => [])
  for (const o of obstacles) used[clampPage(o.page)].push(o.rect)
  for (const c of cells) used[clampPage(c.page)].push(cellRect(c, cols))
  return used
}

/** The icon's top-left in logical page space: its page and pixels on it. */
export const cellOrigin = (c: PageCell, width: number) => {
  const r = cellRect(c, pageCols(width))
  return { x: joinX(c.page, r.x), y: r.y }
}
