// Phone home screens with real touch input: fixed pages, swipe vs long press, dragging between
// pages, page dots, edit mode, the dock's app cap, Back, rotation, blocked storage and the desktop.
// Own scratch dev server and muted Chromium; no account, no production data.
// pnpm check:mobile-home (PORT overrides the scratch dev-server port; SHOTS=<dir> keeps screenshots, never commit them)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { launch, newPage, sleep } from './perf/cdp.ts'

const port = Number(process.env.PORT ?? 5284)
const SHOTS = process.env.SHOTS
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const data = mkdtempSync('/tmp/mvlos-mobile-home-')
const vite = spawn('./node_modules/.bin/vite', ['--port', String(port), '--strictPort'], { env: { ...process.env, DATA_DIR: data, MC_WATCH: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
vite.stdout.on('data', (d) => (log += d))
vite.stderr.on('data', (d) => (log += d))
let browser: Awaited<ReturnType<typeof launch>> | undefined
const stop = async () => { await browser?.close(); vite.kill(); rmSync(data, { recursive: true, force: true }) }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void stop().finally(() => process.exit(1)))
let failed = 0
const check = (what: string, ok: boolean, extra?: unknown) => { console.log(ok ? 'PASS' : 'FAIL', what, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) failed++ }
try {
  for (let i = 0; i < 150 && !log.includes('ready') && vite.exitCode === null; i++) await sleep(200)
  assert(log.includes('ready'), log)
  browser = await launch(390, 844)
  const origin = `http://127.0.0.1:${port}`

  const open = async (inject = '', w = 390, h = 844) => {
    const p = await newPage(browser!, w, h, inject)
    await p.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true })
    await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    return p
  }
  type P = Awaited<ReturnType<typeof open>>
  const load = async (p: P) => {
    await p.send('Page.navigate', { url: origin })
    await p.waitFor(`document.querySelector('.topbar') && !document.querySelector('.boot') && !!document.querySelector('.home-pages')`, 90_000)
    await sleep(900)
  }
  const touch = async (p: P, type: string, at?: { x: number; y: number }) => { await p.send('Input.dispatchTouchEvent', { type, touchPoints: at ? [{ ...at, id: 1 }] : [] }); await sleep(30) }
  const swipe = async (p: P, from: { x: number; y: number }, dx: number, steps = 8) => {
    await touch(p, 'touchStart', from)
    for (let i = 1; i <= steps; i++) await touch(p, 'touchMove', { x: from.x + (dx * i) / steps, y: from.y })
    await touch(p, 'touchEnd')
    await sleep(900)
  }
  const holdDrag = async (p: P, from: { x: number; y: number }, to: { x: number; y: number }, dwell = 0, hold = 520) => {
    await touch(p, 'touchStart', from)
    await sleep(hold)
    for (let i = 1; i <= 10; i++) await touch(p, 'touchMove', { x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10 })
    await sleep(dwell)
    await touch(p, 'touchEnd')
    await sleep(800)
  }
  const centre = (p: P, sel: string) => p.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  const pageNow = (p: P) => p.eval<number>(`Math.round(document.querySelector('.desk-scroll').scrollLeft / innerWidth)`)
  const dots = (p: P) => p.eval<{ count: number; current: number }>(`({ count: document.querySelectorAll('.home-dot').length, current: [...document.querySelectorAll('.home-dot')].findIndex((d) => d.hasAttribute('aria-current')) })`)
  const desk = (p: P) => p.eval<any>(`JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.endsWith('.sync.desktop')) ?? '') ?? 'null')?.value ?? null`)
  const shot = async (p: P, name: string) => { if (!SHOTS) return; const { data: png } = await p.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(png, 'base64')) }
  const click = (p: P, sel: string) => p.eval(`document.querySelector(${JSON.stringify(sel)}).click()`)
  const buttonByText = (p: P, scope: string, text: string) => p.eval(`[...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`)

  let p = await open()
  await load(p)

  // --- fixed pages, dots ---
  check('no vertical page scrolling', await p.eval(`(() => { const s = document.querySelector('.desk-scroll'); const c = getComputedStyle(s); return c.overflowY === 'hidden' && s.scrollHeight <= s.clientHeight + 1 })()`))
  check('the old Home / Icons labels are gone', await p.eval(`![...document.querySelectorAll('.home-pages button')].some((b) => ['Home', 'Icons'].includes(b.textContent.trim()))`))
  check('one page, one dot, marked current', JSON.stringify(await dots(p)) === '{"count":1,"current":0}')
  const dot = await p.eval<{ w: number; h: number; label: string }>(`(() => { const d = document.querySelector('.home-dot'); const r = d.getBoundingClientRect(); return { w: r.width, h: r.height, label: d.getAttribute('aria-label') } })()`)
  check('dot has an accessible name and a tap target of at least 28x40', dot.label === 'Page 1 of 1' && dot.w >= 28 && dot.h >= 40, dot)
  await touch(p, 'touchStart', { x: 195, y: 500 }); for (let i = 1; i <= 6; i++) await touch(p, 'touchMove', { x: 195, y: 500 - i * 60 }); await touch(p, 'touchEnd'); await sleep(300)
  check('a vertical swipe on the home screen moves nothing', await p.eval(`document.querySelector('.desk-scroll').scrollTop === 0`))

  // --- edit mode: add pages ---
  await click(p, '.home-edit')
  await sleep(150)
  check('edit mode shows Add page / Remove page / Done', await p.eval(`['Add page', 'Remove page', 'Done'].every((t) => [...document.querySelectorAll('.home-edit-bar button')].some((b) => b.textContent.trim() === t))`))
  check('the only page cannot be removed', await p.eval(`[...document.querySelectorAll('.home-edit-bar button')].find((b) => b.textContent.trim() === 'Remove page').disabled`))
  await buttonByText(p, '.home-edit-bar', 'Add page')
  await sleep(900)
  check('Add page makes page 2 and turns to it', JSON.stringify(await dots(p)) === '{"count":2,"current":1}' && (await pageNow(p)) === 1, await dots(p))
  check('the new page is empty, so it can be removed', await p.eval(`![...document.querySelectorAll('.home-edit-bar button')].find((b) => b.textContent.trim() === 'Remove page').disabled`))
  await buttonByText(p, '.home-edit-bar', 'Remove page')
  await sleep(700)
  check('an empty page is removed', (await dots(p)).count === 1 && (await desk(p))?.mobilePages === 1, await desk(p))
  await buttonByText(p, '.home-edit-bar', 'Add page')
  await sleep(900)
  await buttonByText(p, '.home-edit-bar', 'Done')
  await sleep(200)
  check('Done closes the editor', await p.eval(`!document.querySelector('.home-edit-bar')`))
  await click(p, '.home-dot')
  await sleep(700)
  check('tapping a dot goes to that page', (await pageNow(p)) === 0)
  await shot(p, 'two-pages')

  // --- swipe vs long press ---
  const stored0 = await desk(p)
  const icon0 = await centre(p, '.desk-icon')
  const leftBefore = await p.eval<string>(`document.querySelector('.desk-icon').style.left`)
  await swipe(p, icon0, -250)
  check('a quick swipe starting on an icon turns the page and does not drag it', (await pageNow(p)) === 1 && (await p.eval<string>(`document.querySelector('.desk-icon').style.left`)) === leftBefore)
  await swipe(p, { x: 100, y: 450 }, 260)
  check('a swipe back returns', (await pageNow(p)) === 0)
  check('swiping saved no change to the placements', JSON.stringify((await desk(p))?.mobilePositions) === JSON.stringify(stored0?.mobilePositions), (await desk(p))?.mobilePositions)

  // --- drag between pages: edge dwell ---
  const here = await centre(p, '.desk-icon')
  await holdDrag(p, here, { x: 384, y: here.y }, 900)
  check('holding at the edge while dragging turns the page, and the icon lands on it', (await pageNow(p)) === 1 && (await desk(p))?.mobilePositions?.games?.page === 1, { page: await pageNow(p), pos: (await desk(p))?.mobilePositions })
  check('the dot follows', (await dots(p)).current === 1)
  check('the page that now has an icon cannot be removed', await p.eval(`(() => { document.querySelector('.home-edit').click(); return true })()`) && (await sleep(150), await p.eval(`[...document.querySelectorAll('.home-edit-bar button')].find((b) => b.textContent.trim() === 'Remove page').disabled`)))
  await buttonByText(p, '.home-edit-bar', 'Done')
  await shot(p, 'icon-on-page-2')

  // --- the alternative: the icon's menu ---
  const onPage2 = await centre(p, '.desk-icon')
  await touch(p, 'touchStart', onPage2)
  await sleep(700)
  await touch(p, 'touchEnd')
  await sleep(300)
  check('holding without moving opens its menu (with Move to page)', await p.eval(`[...document.querySelectorAll('.ctx-menu button')].some((b) => b.textContent.includes('Move to page'))`))
  // Back closes that menu before anything else.
  await p.eval(`history.back()`)
  await sleep(400)
  check('Back closes the menu first', await p.eval(`!document.querySelector('.ctx-menu')`))
  check('and stays on the home screen', (await pageNow(p)) === 1)

  // --- persistence: reload keeps page, pages, placement ---
  const saved = (await desk(p))?.mobilePositions
  await load(p)
  check('reload keeps the number of pages and the icon page', (await dots(p)).count === 2 && JSON.stringify((await desk(p))?.mobilePositions) === JSON.stringify(saved) && (await p.eval<string>(`document.querySelector('.desk-icon').style.left`)).length > 0)
  check('mobile placement left the desktop layout alone', JSON.stringify((await desk(p))?.positions) === '{}')

  // --- widgets: hold the note's strip and drag to the next page ---
  await click(p, '.home-dot')
  await sleep(600)
  const grip = await centre(p, '[data-app="notes"] .note-grip')
  check('the headline note shows on page 1', (await pageNow(p)) === 0)
  await holdDrag(p, grip, { x: 384, y: grip.y }, 900)
  const noteX = await p.eval<number>(`parseFloat(document.querySelector('[data-app="notes"]').style.left)`)
  check('a note dragged to the edge lands on page 2', (await pageNow(p)) === 1 && noteX >= 390, { noteX, page: await pageNow(p) })
  const overlapping = await p.eval(`(() => { const a = [...document.querySelectorAll('.desk-icon, .window.chrome-note')].map((e) => e.getBoundingClientRect()).filter((r) => r.right > 0 && r.left < innerWidth); return a.some((r, i) => a.slice(0, i).some((o) => r.left < o.right && r.right > o.left && r.top < o.bottom && r.bottom > o.top)) })()`)
  check('nothing overlaps on the page', overlapping === false)
  check('every item is inside its page', await p.eval(`[...document.querySelectorAll('.desk-icon, .window.chrome-note')].every((e) => { const r = e.getBoundingClientRect(); const x = r.left + document.querySelector('.desk-scroll').scrollLeft; const page = Math.floor((x + r.width / 2) / innerWidth); return x >= page * innerWidth - 1 && x + r.width <= (page + 1) * innerWidth + 1 && r.bottom <= innerHeight })`))
  await shot(p, 'note-on-page-2')

  // --- rotation / resize: items stay on their pages ---
  const iconPageNow = () => p.eval<number>(`Math.floor((parseFloat(document.querySelector('.desk-icon').style.left) + 50) / innerWidth)`)
  const inPages = () => p.eval(`[...document.querySelectorAll('.desk-icon, .window.chrome-note')].every((e) => { const r = e.getBoundingClientRect(); const x = r.left + document.querySelector('.desk-scroll').scrollLeft; const page = Math.floor((x + r.width / 2) / innerWidth); return x >= page * innerWidth - 1 && x + r.width <= (page + 1) * innerWidth + 1 })`)
  const noOverlap = () => p.eval(`(() => { const sl = document.querySelector('.desk-scroll').scrollLeft; const a = [...document.querySelectorAll('.desk-icon, .window.chrome-note')].map((e) => { const r = e.getBoundingClientRect(); return { l: r.left + sl, r: r.right + sl, t: r.top, b: r.bottom } }); return !a.some((r, i) => a.slice(0, i).some((o) => r.l < o.r && r.r > o.l && r.t < o.b && r.b > o.t)) })()`)
  await p.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 780, deviceScaleFactor: 2, mobile: true })
  await sleep(700)
  check('a slightly smaller screen keeps the pages, nothing scrolls down, the icon stays on page 2', (await dots(p)).count >= 2 && (await p.eval(`document.querySelector('.desk-scroll').scrollHeight <= document.querySelector('.desk-scroll').clientHeight + 1`)) && (await iconPageNow()) === 1, { page: await iconPageNow() })
  await p.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true })
  await sleep(700)
  check('a small phone: everything is still inside a page and nothing overlaps', (await inPages()) && (await noOverlap()))
  await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(700)
  check('back to the first size: the icon is back on page 2 (nothing was saved by the resize)', (await iconPageNow()) === 1 && JSON.stringify((await desk(p))?.mobilePositions) === JSON.stringify(saved))

  // --- dock: cap the apps shown ---
  const dockApps = (page: P = p) => page.eval<{ items: number; more: boolean; overflowX: boolean; names: string[] }>(`(() => { const nav = document.querySelector('.dock'); const items = [...nav.querySelectorAll('.dock-item')].filter((i) => !i.closest('.dock-more') && !/All apps|Trash/.test(i.textContent)); return { names: items.map((i) => i.textContent.trim()), items: items.length, more: !!nav.querySelector('.dock-more'), overflowX: nav.scrollWidth > nav.clientWidth + 1 } })()`)
  const dockDefault = await dockApps()
  check('the phone dock is capped at 4 apps plus More by default (fewer when an open app adds a separator and the width runs out)', dockDefault.items >= 3 && dockDefault.items <= 4 && dockDefault.more && !dockDefault.overflowX, dockDefault)
  await p.eval(`(async () => { (await import('/src/os/dockPrefs.ts')).mobileDockApps.set(2) })()`)
  await sleep(500)
  const dockTwo = await dockApps()
  check('Settings value 2 shows 2 apps plus More', dockTwo.items === 2 && dockTwo.more && !dockTwo.overflowX, dockTwo)
  await p.eval(`(async () => { (await import('/src/os/dockPrefs.ts')).mobileDockApps.set(8) })()`)
  await sleep(500)
  const dockEight = await dockApps()
  check('a cap above what fits is clamped to the width, never overflowing', !dockEight.overflowX && dockEight.items <= 8, dockEight)
  // With the cap at 2 there is always something under More: it must open, list the rest, stay on screen, and Back closes it.
  await p.eval(`(async () => { (await import('/src/os/dockPrefs.ts')).mobileDockApps.set(2) })()`)
  await sleep(500)
  await click(p, '.dock-more .dock-item')
  await sleep(300)
  check('More opens and lists the rest, on screen', await p.eval(`(() => { const s = document.querySelector('.dock-stack'); if (!s || s.querySelectorAll('.dock-stack-item').length < 1) return false; const r = s.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight })()`))
  await p.eval(`history.back()`)
  await sleep(300)
  check('Back closes More', await p.eval(`!document.querySelector('.dock-stack')`))
  await p.eval(`(async () => { (await import('/src/os/dockPrefs.ts')).mobileDockApps.set(8) })()`)
  await sleep(500)
  await p.eval(`(async () => { (await import('/src/os/dockPrefs.ts')).mobileDockApps.set(4) })()`)

  // --- Back leaves an app window for the home screen ---
  await p.eval(`window.dispatchEvent(new CustomEvent('mvlos:open', { detail: 'files' }))`)
  await p.waitFor(`!!document.querySelector('[data-app="files"] .titlebar')`)
  await sleep(300)
  await p.eval(`history.back()`)
  await sleep(500)
  check('Back minimizes the focused app window and shows the home screen again', await p.eval(`document.querySelector('[data-app="files"]')?.classList.contains('is-min') ?? true`))
  check('and does not leave the site', await p.eval(`location.origin === ${JSON.stringify(origin)}`))
  check('no script errors', p.errors.length === 0, p.errors)
  await p.close()

  // --- phone widgets: width after a resize or a UI scale change, and the first-edit migration order ---
  const r = await open('(() => { window.__writes = 0; const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (/widgets:placed/.test(k)) window.__writes++; return set.call(this, k, v) } })()')
  await r.send('Page.navigate', { url: origin })
  await r.waitFor(`!!document.querySelector('.topbar') && !document.querySelector('.boot')`, 90_000)
  await sleep(1200)
  await r.eval(`(async () => {
    const { widgetPlaces } = await import('/src/os/widgetPlaces.ts')
    widgetPlaces.set(() => ({ places: { wide: { id: 'wide', kind: 'status', x: 14, y: 60, w: 362, h: 200, vw: 390, vh: 844, phone: true, homeGrid: true, page: 1, at: 50 } }, removed: '' }))
    ;(await import('/src/os/startup.ts')).setStartupPrefs({ windows: 'empty' })
  })()`)
  await r.send('Page.navigate', { url: origin })
  await r.waitFor(`!!document.querySelector('[data-app="widget"]') && !!document.querySelector('.home-pages')`, 90_000)
  await sleep(900)
  const geometry = () => r.eval<{ w: number; left: number; page: number }>(`(() => { const e = document.querySelector('[data-app="widget"]'); const l = parseFloat(e.style.getPropertyValue('--home-x')); return { w: e.getBoundingClientRect().width, left: l, page: Math.floor((l + 1) / innerWidth) } })()`)
  const savedSet = () => r.eval<string>(`(async () => JSON.stringify((await import('/src/os/widgetPlaces.ts')).screenWidgets(true)))()`)
  const geo0 = await geometry()
  const set0 = await savedSet()
  const writes0 = await r.eval<number>(`window.__writes`)
  check('a phone widget shows at the width it was put at, on its page', Math.abs(geo0.w - 362) < 1.5 && geo0.page === 1, geo0)
  await r.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true })
  await sleep(900)
  const geo320 = await geometry()
  check('narrower screen: the widget is shown at most as wide as the page, on the same page', geo320.w <= 320 - 28 + 1.5 && geo320.page === 1 && geo320.left >= 320 + 13 && geo320.left + geo320.w <= 640 - 13, geo320)
  check('narrower screen: the saved place is unchanged and nothing was written', (await savedSet()) === set0 && (await r.eval<number>(`window.__writes`)) === writes0)
  await r.eval(`(async () => (await import('/src/os/uiScale.ts')).uiScalePref.set(1.25))()`)
  await sleep(900)
  const geoScaled = await geometry()
  const pageW = await r.eval<number>(`(async () => (await import('/src/os/uiScale.ts')).viewW())()`)
  check('UI scale 125%: still at most as wide as the page, nothing saved', geoScaled.w / 1.25 <= pageW - 28 + 1.5 && (await savedSet()) === set0 && (await r.eval<number>(`window.__writes`)) === writes0, { geoScaled, pageW })
  await r.eval(`(async () => (await import('/src/os/uiScale.ts')).uiScalePref.set(1))()`)
  await r.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(900)
  const geoBack = await geometry()
  check('back at the first size the widget is as wide as it was put', Math.abs(geoBack.w - 362) < 1.5 && JSON.stringify(geoBack) === JSON.stringify(geo0), { geoBack, geo0 })
  // Loaded on a narrow phone first, then a wider one: the width it was put at comes back.
  await r.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true })
  await r.send('Page.navigate', { url: origin })
  await r.waitFor(`!!document.querySelector('[data-app="widget"]') && !!document.querySelector('.home-pages')`, 90_000)
  await sleep(900)
  const narrowFirst = await geometry()
  await r.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(900)
  const widerAfter = await geometry()
  check('first load on a narrow phone shows it narrower, and a wider screen brings the saved width back', narrowFirst.w <= 320 - 28 + 1.5 && Math.abs(widerAfter.w - 362) < 1.5 && (await savedSet()) === set0, { narrowFirst, widerAfter })
  // Taking an empty page away while the screen is narrow moves the page only: the saved width stays.
  await r.eval(`(async () => {
    const { widgetPlaces } = await import('/src/os/widgetPlaces.ts')
    // The same widget under two keys, and a kind this build does not know: both must move with the page.
    const put = (id, kind) => ({ id, kind, x: 14, y: 60, w: 362, h: 200, vw: 390, vh: 844, phone: true, homeGrid: true, page: 3, at: 80 })
    widgetPlaces.set(() => ({ places: { wide: put('wide', 'status'), 'wide~b': put('wide', 'status'), ghost: put('ghost', 'kind-this-build-does-not-know') }, removed: '' }))
    ;(await import('/src/os/desktopStore.ts')).updateDesktop((s) => ({ ...s, mobilePositions: {}, mobilePages: 4 }))
  })()`)
  await r.send('Page.navigate', { url: origin })
  await r.waitFor(`!!document.querySelector('[data-app="widget"]') && !!document.querySelector('.home-pages')`, 90_000)
  await sleep(900)
  await r.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true })
  await sleep(900)
  await click(r, '.home-edit')
  await sleep(200)
  await click(r, '.home-dot:nth-child(2)')
  await sleep(700)
  // Page 4 only holds the saved placements, one of a kind this build does not know: it is not empty.
  await click(r, '.home-dot:nth-child(4)')
  await sleep(700)
  check('a page held only by saved widgets (duplicate keys, an unknown kind) is not empty', await r.eval(`[...document.querySelectorAll('.home-edit-bar button')].find((x) => x.textContent.trim() === 'Remove page').disabled`))
  await click(r, '.home-dot:nth-child(2)')
  await sleep(700)
  await buttonByText(r, '.home-edit-bar', 'Remove page')
  await sleep(900)
  await r.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(900)
  const shifted = await r.eval<{ page: number; w: number; x: number }>(`(async () => { const p = Object.values((await import('/src/os/widgetPlaces.ts')).screenWidgets(true).places).find((q) => q.id === 'wide'); return { page: p.page, w: p.w, x: p.x } })()`)
  const allPages = await r.eval<number[]>(`(async () => Object.values((await import('/src/os/widgetPlaces.ts')).screenWidgets(true).places).map((q) => q.page))()`)
  check('removing an empty page on a narrow screen moves the widget down a page and keeps its saved width and place', shifted.page === 2 && shifted.w === 362 && shifted.x === 14 && allPages.length === 3 && allPages.every((n) => n === 2), { shifted, dots: await dots(r), ui: await r.eval(`(async () => JSON.stringify((await import('/src/os/homePager.ts')).homeUi.get()))()`) })
  // Occupancy follows the saved sets even when no window changes, and what is shown on a page.
  await r.eval(`(async () => {
    const { widgetPlaces, mobileWidgetPlaces } = await import('/src/os/widgetPlaces.ts')
    // The phone's own set, empty on purpose (a null one would merge back what was saved).
    mobileWidgetPlaces.set(() => ({ places: {}, removed: 'wide wide~b ghost' }))
    widgetPlaces.set(() => ({ places: {}, removed: 'wide wide~b ghost' }))
    ;(await import('/src/os/desktopStore.ts')).updateDesktop((s) => ({ ...s, mobilePositions: {}, mobilePages: 3 }))
  })()`)
  await r.send('Page.navigate', { url: origin })
  await r.waitFor(`!!document.querySelector('.home-pages')`, 90_000)
  await sleep(900)
  await click(r, '.home-edit')
  await sleep(200)
  await click(r, '.home-dot:nth-child(2)')
  await sleep(700)
  const removeDisabled = () => r.eval<boolean>(`[...document.querySelectorAll('.home-edit-bar button')].find((x) => x.textContent.trim() === 'Remove page').disabled`)
  check('an empty page can be removed', (await removeDisabled()) === false)
  await r.eval(`(async () => { const { mobileWidgetPlaces } = await import('/src/os/widgetPlaces.ts'); mobileWidgetPlaces.set((s) => ({ ...s, places: { ...s.places, late: { id: 'late', kind: 'kind-this-build-does-not-know', x: 14, y: 60, w: 300, h: 200, vw: 390, vh: 844, phone: true, homeGrid: true, page: 1, at: 300 } } })) })()`)
  await sleep(700)
  check('a widget of an unknown kind arriving on it (another tab) makes the page not empty, with no window changing', (await removeDisabled()) === true, { ui: await r.eval(`(async () => JSON.stringify((await import('/src/os/homePager.ts')).homeUi.get()) + JSON.stringify(Object.keys((await import('/src/os/widgetPlaces.ts')).screenWidgets(true).places)))()`) })
  await r.eval(`(async () => {
    const { widgetPlaces, mobileWidgetPlaces } = await import('/src/os/widgetPlaces.ts')
    const put = (id, y) => ({ id, kind: 'status', x: 14, y, w: 300, h: 200, vw: 390, vh: 844, phone: true, homeGrid: true, page: 1, at: 400 })
    mobileWidgetPlaces.set(() => ({ places: { a: put('a', 60), b: put('b', 120) }, removed: 'late ghost wide wide~b' }))
  })()`)
  await r.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true })
  await r.send('Page.navigate', { url: origin })
  await r.waitFor(`!!document.querySelector('.home-pages') && document.querySelectorAll('[data-app="widget"]').length === 2`, 90_000)
  await sleep(900)
  const widgetPageNow = await r.eval<number[]>(`[...document.querySelectorAll('[data-app="widget"]')].map((e) => Math.floor((parseFloat(e.style.getPropertyValue('--home-x')) + 1) / innerWidth)).sort()`)
  await click(r, '.home-edit')
  await sleep(200)
  await click(r, `.home-dot:nth-child(${(widgetPageNow[widgetPageNow.length - 1] ?? 1) + 1})`)
  await sleep(700)
  check('a widget pushed to a later page by a small screen holds that page: it cannot be removed', widgetPageNow[widgetPageNow.length - 1] >= 2 && (await removeDisabled()) === true, widgetPageNow)
  await r.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(700)
  // The first edit freezes old places by an order that does not depend on how the entries were added.
  const frozen = await r.eval<{ a: string; b: string }>(`(async () => {
    const { migrateMobileWidgets } = await import('/src/os/widgetPlaces.ts')
    const place = (id) => ({ id, kind: 'status', x: 14, y: 40, w: 280, h: 260, vw: 390, vh: 844, phone: true, at: 1 })
    const entries = [['a', place('a')], ['z~b', place('z')], ['z~a', place('z')], ['c', place('c')], ['d', place('d')]]
    const run = (list) => Object.fromEntries(Object.entries(migrateMobileWidgets({ places: Object.fromEntries(list), removed: '' }, 390, 844).places).map(([k, v]) => [k, [v.page, v.x, v.y]]))
    return { a: JSON.stringify(run(entries)), b: JSON.stringify(run([...entries].reverse())) }
  })()`)
  check('first-edit migration gives each key the same page and place whatever order the entries were added in', frozen.a === frozen.b && frozen.a.includes('z~a') && frozen.a.includes('"page"') === false, frozen)
  check('no script errors with phone widgets', r.errors.length === 0, r.errors)
  await r.close()

  // --- icons out of sight keep their place when an empty page before them is removed ---
  const h = await open()
  await h.send('Page.navigate', { url: origin })
  await h.waitFor(`!!document.querySelector('.topbar') && !document.querySelector('.boot')`, 90_000)
  await sleep(1200)
  await h.eval(`(async () => {
    const ds = await import('/src/os/desktopStore.ts')
    ds.updateDesktop((s) => ({ ...s, trashed: ['games'], mobilePositions: { games: { col: 0, row: 1, page: 3 } }, mobilePages: 4 }))
    // The pages of this browser profile are shared: the widget an earlier check put on page 2 goes.
    {
      const m = await import('/src/os/widgetPlaces.ts')
      m.widgetPlaces.set(() => ({ places: {}, removed: 'wide' }))
      m.mobileWidgetPlaces.set(() => ({ places: {}, removed: 'a b late ghost wide wide~b' }))
    }
    ;(await import('/src/os/startup.ts')).setStartupPrefs({ windows: 'empty' })
  })()`)
  await h.send('Page.navigate', { url: origin })
  await h.waitFor(`!!document.querySelector('.home-pages')`, 90_000)
  await sleep(900)
  // Moving a visible icon by its menu must not forget the trashed one's cell.
  await h.eval(`(async () => { (await import('/src/data/launchers.ts')).addLauncher({ label: 'Probe', url: 'https://example.org' }) })()`)
  await sleep(300)
  await h.send('Page.navigate', { url: origin })
  await h.waitFor(`!!document.querySelector('.desk-icon[aria-label="Probe"]')`, 90_000)
  await sleep(700)
  await h.eval(`document.querySelector('.desk-icon[aria-label="Probe"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 200 }))`)
  await sleep(200)
  await h.eval(`[...document.querySelectorAll('.ctx-menu button')].find((b) => b.textContent.includes('Move to page')).click()`)
  await sleep(200)
  await h.eval(`[...document.querySelectorAll('.ctx-menu button')].find((b) => b.textContent.trim() === 'Page 3').click()`)
  await sleep(900)
  const afterMove = (await desk(h))?.mobilePositions
  check('moving an icon by its menu keeps the trashed icon\'s saved cell', afterMove?.games?.page === 3 && afterMove?.['launcher:' + 'x'] === undefined && Object.values<any>(afterMove).some((c) => c.page === 2), afterMove)
  await click(h, '.home-edit')
  await sleep(200)
  await click(h, '.home-dot:nth-child(2)')
  await sleep(700)
  check('a page that only holds a trashed icon is not empty, an empty one is', await h.eval(`(() => { const b = [...document.querySelectorAll('.home-edit-bar button')].find((x) => x.textContent.trim() === 'Remove page'); return !b.disabled })()`))
  await click(h, '.home-dot:nth-child(4)')
  await sleep(700)
  check('the page holding the trashed icon cannot be removed', await h.eval(`[...document.querySelectorAll('.home-edit-bar button')].find((x) => x.textContent.trim() === 'Remove page').disabled`))
  await click(h, '.home-dot:nth-child(2)')
  await sleep(700)
  await buttonByText(h, '.home-edit-bar', 'Remove page')
  await sleep(700)
  const afterRemoval = (await desk(h))?.mobilePositions?.games
  check('removing an empty page before it moves the trashed icon down with the pages', afterRemoval?.page === 2 && (await dots(h)).count === 3, { afterRemoval, dots: await dots(h) })
  check('... and the visible icon with them', Object.entries<any>((await desk(h))?.mobilePositions ?? {}).some(([id, c]) => id !== 'games' && c.page === 1), (await desk(h))?.mobilePositions)
  check('no script errors with hidden icons', h.errors.length === 0, h.errors)
  await h.close()

  // --- storage blocked: everything keeps working in memory ---
  const blocked = `(() => { const bad = () => { throw new DOMException('blocked', 'SecurityError') }; Storage.prototype.setItem = bad; Storage.prototype.getItem = () => null; Storage.prototype.removeItem = bad })()`
  const q = await open(blocked)
  await load(q)
  const fresh = await dockApps(q)
  check('a fresh phone dock at 390px shows 4 apps plus More', fresh.items === 4 && fresh.more && !fresh.overflowX, fresh)
  await click(q, '.home-edit')
  await buttonByText(q, '.home-edit-bar', 'Add page')
  await sleep(900)
  check('with storage blocked, pages can still be added and shown', (await dots(q)).count === 2 && (await pageNow(q)) === 1, await dots(q))
  check('no script errors with storage blocked', q.errors.length === 0, q.errors)
  await q.close()

  // --- the desktop is untouched ---
  const d = await open('', 1280, 800)
  await d.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await d.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await d.send('Page.navigate', { url: origin })
  await d.waitFor(`!!document.querySelector('.desktop') && !document.querySelector('.boot')`, 90_000)
  await sleep(1200)
  check('desktop: no phone pager, vertical scroll as before', await d.eval(`!document.querySelector('.home-pages') && getComputedStyle(document.querySelector('.desk-scroll')).overflowY !== 'visible' && document.querySelector('.desk-scroll').style.getPropertyValue('--home-pages') === ''`))
  check('desktop: icons are positioned from the right as before', await d.eval(`[...document.querySelectorAll('.desk-icon')].every((e) => parseFloat(e.style.left) < innerWidth)`))
  await d.close()
  if (failed) throw new Error(`${failed} check(s) failed`)
  console.log('PASS mobile home: pages, gestures, dots, edit mode, dock cap, Back, resize, blocked storage, desktop')
} finally {
  await stop()
}
