// Phone home screens, pure layout: pages, migration of older places, drops. No browser needed.
// pnpm check:home-pages
import assert from 'node:assert/strict'
import { HOME_LEFT, HOME_TOP, ICON_H, ICON_W, overlaps } from '../src/os/homeLayout.ts'
import { MAX_PAGES, PAGE_DOCK, PAGE_STRIDE, arrangePages, cellOnPreviousPage, savedIconPage, dropCell, drawX, fitOnPage, fitPhoneWidget, fromContentX, iconPages, joinX, legacyWidgetPage, localX, mobileWidgetRect, pageCols, pageOfX, pageRows, takenCells } from '../src/os/homePages.ts'
import { mobileWidgetEnvelope } from '../src/os/widgetLayout.ts'
import { phoneOrder, type WidgetPlace, type WidgetSet } from '../src/widgets/platform/placementSet.ts'

const W = 390
const H = 800
const cols = pageCols(W)
const rows = pageRows(H)
const rect = (c: { page: number; col: number; row: number }) => ({ x: HOME_LEFT + (cols - 1 - c.col) * ICON_W, y: HOME_TOP + c.row * ICON_H, w: ICON_W, h: ICON_H })
const noOverlap = (cells: { page: number; col: number; row: number }[]) => cells.every((c, i) => cells.slice(0, i).every((o) => o.page !== c.page || !overlaps(rect(c), rect(o))))

// logical x: pages survive a resize
assert.equal(pageOfX(joinX(2, 30)), 2)
assert.equal(localX(joinX(2, 30)), 30)
assert.equal(drawX(joinX(2, 30), 390), 2 * 390 + 30)
assert.equal(drawX(joinX(2, 30), 844), 2 * 844 + 30, 'same logical x on a wider screen stays on page 2')
assert.equal(pageOfX(-50), 0)
assert.equal(pageOfX(PAGE_STRIDE * 50), MAX_PAGES - 1)
assert.equal(fromContentX(390 + 20, 280, 390, 3), joinX(1, 20))
assert.equal(fromContentX(390 - 200, 280, 390, 3), joinX(0, 390 - 280), 'an item mostly on page 0 stays there, pushed wholly onto it')
assert.equal(fromContentX(5000, 100, 390, 3), joinX(2, 390 - 100), 'never past the last page, wholly on it')

// icons: nothing lost, nothing overlapping, deterministic, older cells cut into pages by row
const ids = Array.from({ length: 40 }, (_, i) => `i${i}`)
const fresh = iconPages(ids, {}, W, H)
assert.equal(Object.keys(fresh).length, ids.length)
assert(noOverlap(Object.values(fresh)))
assert.deepEqual(fresh, iconPages(ids, {}, W, H), 'deterministic')
assert(Object.values(fresh).every((c) => c.row < rows && c.col < cols), 'cells on the page')
const tall = { a: { col: 0, row: rows + 1 }, b: { col: 1, row: 0 }, c: { col: 0, row: 2 * rows } }
const legacyOut = iconPages(['a', 'b', 'c'], tall, W, H)
assert.deepEqual(legacyOut.a, { page: 1, col: 0, row: 1 }, 'older overflow row moves to the next page, same column')
assert.deepEqual(legacyOut.b, { page: 0, col: 1, row: 0 })
assert.equal(legacyOut.c.page, 2)
const pinned = iconPages(['a', 'b'], { a: { col: 0, row: 0, page: 3 }, b: { col: 0, row: 0 } }, W, H)
assert.deepEqual(pinned.a, { page: 3, col: 0, row: 0 }, 'explicit page kept')
assert.deepEqual(pinned.b, { page: 0, col: 0, row: 0 })
// a taken cell never moves an icon that was there first; the later one goes to the nearest free cell
const clash = iconPages(['a', 'b'], { a: { col: 1, row: 1, page: 0 }, b: { col: 1, row: 1, page: 0 } }, W, H)
assert.deepEqual(clash.a, { page: 0, col: 1, row: 1 })
assert.notDeepEqual(clash.b, clash.a)
assert(noOverlap(Object.values(clash)))
// widgets reserve space; icons go around them
const blocker = { page: 0, rect: { x: HOME_LEFT, y: HOME_TOP, w: W - 2 * HOME_LEFT, h: 3 * ICON_H } }
const around = iconPages(['a', 'b'], { a: { col: 0, row: 0, page: 0 } }, W, H, [blocker])
assert(around.a.page === 0 ? around.a.row >= 3 : true)
assert(Object.values(around).every((c) => !overlaps(rect(c), blocker.rect) || c.page !== 0))
// a full page spills to the next; a single page of icons fits a rotated/narrow viewport too
const many = iconPages(Array.from({ length: cols * rows + 3 }, (_, i) => `m${i}`), {}, W, H)
assert.equal(Math.max(...Object.values(many).map((c) => c.page)), 1)
for (const [w, h] of [[320, 568], [360, 640], [719, 500], [180, 300]] as const) {
  const some = w < 200 ? ids.slice(0, MAX_PAGES) : ids
  const out = iconPages(some, {}, w, h)
  assert.equal(new Set(Object.values(out).map((c) => `${c.page},${c.col},${c.row}`)).size, some.length, `${w}x${h}`)
}
// resizing keeps the page of explicitly pinned icons
assert.equal(iconPages(['p'], { p: { col: 0, row: 0, page: 2 } }, 360, 640).p.page, 2)

// dropping: nearest free cell, never on another icon, nothing swapped
const placed = [{ page: 0, col: 0, row: 0 }, { page: 0, col: 1, row: 0 }]
const taken = takenCells(placed, W)
const drop = dropCell(joinX(0, rect({ page: 0, col: 0, row: 0 }).x), HOME_TOP, W, H, taken, 3)!
assert(!placed.some((c) => c.col === drop.col && c.row === drop.row && c.page === drop.page), 'drop lands on a free cell')
assert.equal(dropCell(joinX(1, rect({ page: 1, col: 0, row: 0 }).x), HOME_TOP, W, H, taken, 3)!.page, 1, 'dropped on page 1: page 1')
const fullPage = takenCells(Array.from({ length: cols * rows }, (_, i) => ({ page: 0, col: i % cols, row: Math.floor(i / cols) })), W)
assert.equal(dropCell(joinX(0, HOME_LEFT), HOME_TOP, W, H, fullPage, 1)!.page, 1, 'full page spills to the next')

// widgets: older places (the one tall column) are cut into pages by the height they were saved at
const savedH = 800
assert.deepEqual(legacyWidgetPage(HOME_TOP, 260, savedH), { page: 0, y: HOME_TOP })
assert.equal(legacyWidgetPage(HOME_TOP + 700, 260, savedH).page, 1)
const straddle = legacyWidgetPage(HOME_TOP + 500, 260, savedH)
assert.equal(straddle.page, 1, 'one that would cross the cut starts the next page')
assert.equal(straddle.y, HOME_TOP)
assert.deepEqual(legacyWidgetPage(HOME_TOP + 700, 260, savedH), legacyWidgetPage(HOME_TOP + 700, 260, savedH))
// the address bar sliding away (a few px of height) never moves a widget between pages
assert.equal(legacyWidgetPage(HOME_TOP + 700, 260, savedH).page, legacyWidgetPage(HOME_TOP + 700, 260, savedH).page)
const geom = mobileWidgetRect({ x: 1200, y: 800, w: 280, h: 260 }, 3, W, H)
assert.equal(pageOfX(geom.x), 1, 'a column-order widget past the first screen lands on page 1')
const explicit = mobileWidgetRect({ x: 54, y: 60, w: 280, h: 260, homeGrid: true, page: 2 }, 0, W, H)
assert.deepEqual(explicit, { x: joinX(2, 54), y: 60, w: 280, h: 260 })
const desktopSource = { x: 1200, y: 800, w: 280, h: 260 }
mobileWidgetRect(desktopSource, 1, W, H)
assert.deepEqual(desktopSource, { x: 1200, y: 800, w: 280, h: 260 }, 'does not mutate the desktop source')

// arranging widgets: each wholly on a page, no overlap, spill to later pages, none lost
const crowd = Array.from({ length: 14 }, (_, id) => ({ id, x: joinX(0, 40), y: 60, w: 280, h: 240, envelope: (i: { x: number; y: number; w: number; h: number }) => mobileWidgetEnvelope(i) }))
const arranged = arrangePages(crowd, W, H)
assert.equal(arranged.size, crowd.length)
const rects = [...arranged.values()]
assert(rects.every((r, i) => rects.slice(0, i).every((o) => pageOfX(o.x) !== pageOfX(r.x) || !overlaps({ ...r, x: localX(r.x) }, { ...o, x: localX(o.x) }))))
assert(rects.every((r) => localX(r.x) >= HOME_LEFT && localX(r.x) + r.w <= W && r.y + r.h <= H - PAGE_DOCK + 28), 'inside its page')
assert(rects.some((r) => pageOfX(r.x) > 0), 'overflow goes to later pages, not below the screen')
assert.deepEqual(arrangePages(crowd, W, H), arranged, 'deterministic')
const first = arrangePages(crowd, W, H, 5).get(5)!
assert.equal(pageOfX(first.x), 0, 'the item being arranged keeps its page')
assert(fitOnPage({ x: 0, y: 0, w: 5000, h: 5000 }, [], W, H), 'oversize content still gets a spot at the top')

console.log('PASS home pages: logical x, icon pages, migration, drops, widget arrangement')

// Review round 1: untouched old places must not move between pages when the screen height changes,
// and freezing them on the first edit (which replaces vh) must keep their pages.
for (const h of [600, 700, 800, 1000]) {
  assert.equal(iconPages(['a'], { a: { col: 0, row: 4 } }, W, h).a.page, 0, `old icon row 4 stays on page 0 at height ${h}`)
  assert.equal(iconPages(['a'], { a: { col: 0, row: 7 } }, W, h).a.page, 1, `old icon row 7 stays on page 1 at height ${h}`)
}
const oldWidgets = [
  { x: 14, y: 0, w: 280, h: 260, vw: 390, vh: 600, phone: true },
  { x: 14, y: 0, w: 280, h: 260, vw: 390, vh: 600, phone: true },
]
const before = oldWidgets.map((p, i) => pageOfX(mobileWidgetRect(p, i, 390, 1000).x))
assert.deepEqual(before, oldWidgets.map((p, i) => pageOfX(mobileWidgetRect(p, i, 390, 600).x)), 'projection does not depend on the current height')
// from a big screen, the old column is cut by the fixed legacy height, not the desktop's own
assert.equal(pageOfX(mobileWidgetRect({ x: 800, y: 600, w: 280, h: 260, vw: 1920, vh: 1080 }, 0, 390, 640).x), pageOfX(mobileWidgetRect({ x: 800, y: 600, w: 280, h: 260, vw: 1920, vh: 1080 }, 0, 390, 900).x))
console.log('PASS home pages: legacy placement is independent of the current screen height')

// Review round 2: an item whose middle is on the next page is pushed wholly onto it.
assert.equal(pageOfX(fromContentX(350, 100, 390, 3)), 1)
assert.ok(localX(fromContentX(350, 100, 390, 3)) >= 0)
assert.equal(pageOfX(fromContentX(390 - 60, 100, 390, 3)), 0, 'middle still on page 0')
assert.equal(localX(fromContentX(390 - 60, 100, 390, 3)), 290)
console.log('PASS home pages: straddling drops land on one page')

// Round 3: the order the first phone edit freezes widgets by is the order the display projects them in,
// whatever order the entries were added in, also for the same widget under two keys.
const place = (id: string, extra: Partial<WidgetPlace> = {}): WidgetPlace => ({ id, kind: 'status', x: 14, y: 40, w: 280, h: 200, vw: 390, vh: 844, at: 1, ...extra })
const entries: [string, WidgetPlace][] = [['a', place('a')], ['z~b', place('z')], ['z~a', place('z')], ['m', place('m', { stack: 0 })], ['b', place('b', { stack: 1 })]]
const orderOf = (list: [string, WidgetPlace][]) => phoneOrder({ places: Object.fromEntries(list), removed: '' } as WidgetSet).map(([k]) => k).join()
const expected = orderOf(entries)
assert.equal(expected, 'm,b,a,z~a,z~b', 'hand-ordered first, then by id, equal ids by key')
const permutations = (xs: [string, WidgetPlace][]): [string, WidgetPlace][][] => xs.length < 2 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]))
for (const p of permutations(entries)) assert.equal(orderOf(p), expected, 'insertion order never changes the order')
console.log('PASS home pages: widget order is independent of insertion order')

// Round 3: phone widget width after a resize or a UI scale change; the saved place is untouched and grows back.
const saved = { x: joinX(2, 14), y: 80, w: 362, h: 240 }
const snapshot2 = { ...saved }
for (const width of [390, 360, 320, 290, 240]) {
  const f = fitPhoneWidget(saved, width)
  assert.ok(f.w <= Math.max(1, width - 2 * HOME_LEFT), `at ${width} it is at most page wide`)
  assert.equal(pageOfX(f.x), 2, 'stays on its page')
  assert.ok(localX(f.x) >= HOME_LEFT && localX(f.x) + f.w <= Math.max(width - HOME_LEFT, HOME_LEFT + f.w), `inside the page at ${width}`)
}
assert.equal(fitPhoneWidget(saved, 390).w, 362, 'fits at the screen it was put on')
assert.equal(fitPhoneWidget(saved, 320).w, 292)
assert.deepEqual(fitPhoneWidget(saved, 390), fitPhoneWidget(saved, 390), 'deterministic')
assert.equal(fitPhoneWidget(saved, 480).w, 362, 'a wider screen never makes it wider than it was put')
assert.deepEqual(saved, snapshot2, 'the saved place is not changed by fitting')
// UI scale 125% makes the page 312 css px wide on a 390 px screen: the same as a narrower screen
assert.equal(fitPhoneWidget(saved, 312).w, 284)
assert.equal(fitPhoneWidget({ x: joinX(0, 300), w: 100 }, 320).x, joinX(0, 320 - 100 - HOME_LEFT), 'a widget that no longer fits sideways moves in, to the page margin')
console.log('PASS home pages: phone widget width fits the page and restores')

// Round 4: the width and place a widget was put at are kept as they are; only the display fits them to the screen.
for (const width of [390, 360, 320, 290]) {
  const r = mobileWidgetRect({ x: 14, y: 60, w: 362, h: 200, homeGrid: true, page: 1, vh: 844, vw: 390, phone: true }, 0, width, 800)
  assert.equal(r.w, 362, `saved width kept when hydrated at ${width}`)
  assert.equal(localX(r.x), 14)
  assert.equal(pageOfX(r.x), 1)
}
assert.equal(fitPhoneWidget(mobileWidgetRect({ x: 14, y: 60, w: 362, h: 200, homeGrid: true, page: 1 }, 0, 320, 800), 390).w, 362, 'narrow first load, then wider: as it was put')
// Icons out of sight move with a removed page: cells with and without a page.
assert.equal(savedIconPage({ row: 3 }), 0)
assert.equal(savedIconPage({ row: 7 }), 1)
assert.equal(savedIconPage({ row: 1, page: 3 }), 3)
assert.deepEqual(cellOnPreviousPage({ col: 1, row: 7 }), { col: 1, row: 2, page: 0 })
assert.deepEqual(cellOnPreviousPage({ col: 1, row: 1, page: 3 }), { col: 1, row: 1, page: 2 })
console.log('PASS home pages: saved widget width is kept; out-of-sight icons shift with a removed page')
