// The phone home's two-hold gesture and its bottom edge, with real touch input.
//  - Hold an icon: it lifts (a buzz), and can be dragged. A lift never opens the menu.
//  - Let go without dragging, hold the same icon again within SECOND_HOLD_MS: its menu, exactly once,
//    with a second buzz. Moving, cancelling, a second finger, waiting too long or dragging all start over.
//  - Right-click and the keyboard's context menu still work; the lowest icon row sits right above the
//    page dots and dock, whatever the screen, dock, rotation or UI scale.
// Own scratch dev server and muted Chromium; no account, no production data.
// pnpm check:home-hold (PORT overrides the scratch dev-server port)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { launch, newPage, sleep } from './perf/cdp.ts'

const port = Number(process.env.PORT ?? 5285)
const data = mkdtempSync('/tmp/mvlos-home-hold-')
const vite = spawn('./node_modules/.bin/vite', ['--port', String(port), '--strictPort'], { env: { ...process.env, DATA_DIR: data, MC_WATCH: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
vite.stdout.on('data', (d) => (log += d))
vite.stderr.on('data', (d) => (log += d))
let browser: Awaited<ReturnType<typeof launch>> | undefined
const stop = async () => { await browser?.close(); vite.kill(); rmSync(data, { recursive: true, force: true }) }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void stop().finally(() => process.exit(1)))
let failed = 0
const check = (what: string, ok: boolean, extra?: unknown) => { console.log(ok ? 'PASS' : 'FAIL', what, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) failed++ }

// Visitor launchers, so there are enough icons to fill the pages; counters for the buzz and for menus opening.
const launchers = (n: number) => JSON.stringify({ value: Array.from({ length: n }, (_, i) => ({ id: `l${i}`, label: `Site ${i + 1}`, url: `https://example.com/${i}` })), base: 0, dirty: false })
const inject = (n: number) => `
  try { if (!localStorage.getItem('mvlos.visitor.sync.launchers')) localStorage.setItem('mvlos.visitor.sync.launchers', ${JSON.stringify(launchers(n))}) } catch {}
  window.__buzz = []
  Object.defineProperty(Navigator.prototype, 'vibrate', { configurable: true, value: (n) => { window.__buzz.push(n); return true } })
  window.__menus = 0
  new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches?.('.ctx-menu') || n.querySelector?.('.ctx-menu'))) window.__menus++ }).observe(document, { childList: true, subtree: true })
`

try {
  for (let i = 0; i < 150 && !log.includes('ready') && vite.exitCode === null; i++) await sleep(200)
  assert(log.includes('ready'), log)
  browser = await launch(390, 844)
  const origin = `http://127.0.0.1:${port}`

  const open = async (w = 390, h = 844, phone = true, n = 1) => {
    const p = await newPage(browser!, w, h, inject(n))
    await p.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true })
    await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    // Every page starts from nothing: windows, pages and placements are kept per origin in this browser.
    await p.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
    await p.send('Page.navigate', { url: origin })
    await p.waitFor(`document.querySelector('.topbar') && !document.querySelector('.boot') && (${phone} ? !!document.querySelector('.home-pages') : true) && !!document.querySelector('.desk-icon')`, 90_000)
    await sleep(1200)
    return p
  }
  type P = Awaited<ReturnType<typeof open>>
  const touch = async (p: P, type: string, points?: { x: number; y: number; id?: number }[]) => { await p.send('Input.dispatchTouchEvent', { type, touchPoints: (points ?? []).map((t, i) => ({ id: i + 1, ...t })) }); await sleep(30) }
  const at = (p: P, sel: string) => p.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  const menus = (p: P) => p.eval<number>(`window.__menus`)
  const menuOpen = (p: P) => p.eval<boolean>(`!!document.querySelector('.ctx-menu')`)
  const buzzes = (p: P) => p.eval<number>(`window.__buzz.length`)
  const arranging = (p: P) => p.eval<boolean>(`document.querySelector('.desk-scroll').classList.contains('is-arranging')`)
  const windows = (p: P) => p.eval<number>(`document.querySelectorAll('.window:not(.chrome-note)').length`)
  const iconBox = (p: P, label: string) => p.eval<{ x: number; y: number }>(`(() => { const e = [...document.querySelectorAll('.desk-icon')].find((i) => i.getAttribute('aria-label') === ${JSON.stringify(label)}); const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) } })()`)
  const centreOf = (p: P, label: string) => p.eval<{ x: number; y: number }>(`(() => { const e = [...document.querySelectorAll('.desk-icon')].find((i) => i.getAttribute('aria-label') === ${JSON.stringify(label)}); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  /** A touch anywhere else ends the wait for a second hold. */
  const unprime = async (p: P) => { await touch(p, 'touchStart', [{ x: 200, y: 14 }]); await touch(p, 'touchEnd'); await sleep(100) }
  const closeMenu = async (p: P) => { await touch(p, 'touchStart', [{ x: 200, y: 20 }]); await touch(p, 'touchEnd'); await sleep(150) }
  const hold = async (p: P, to: { x: number; y: number }, ms = 650) => { await touch(p, 'touchStart', [to]); await sleep(ms); await touch(p, 'touchEnd'); await sleep(250) }
  const state = async (p: P) => ({ menus: await menus(p), open: await menuOpen(p), buzz: await buzzes(p) })
  const SECOND_HOLD_MS = Number(await (async () => {
    // The interval is the module's own constant: read it, never copy it.
    const tmp = await open()
    const v = await tmp.eval<number>(`(async () => (await import('/src/os/ContextMenu.tsx')).SECOND_HOLD_MS)()`)
    await tmp.close()
    return v
  })())
  check('the second hold has a documented, reasonable interval (2 to 5 seconds)', SECOND_HOLD_MS >= 2000 && SECOND_HOLD_MS <= 5000, SECOND_HOLD_MS)

  // --- the two holds ---
  let p = await open()
  const LABEL = 'Site 1'
  let c = await centreOf(p, LABEL)
  const home = await iconBox(p, LABEL)
  const winBefore = await windows(p)

  await touch(p, 'touchStart', [c])
  await sleep(250)
  check('before the hold is up nothing has lifted', !(await arranging(p)) && (await buzzes(p)) === 0)
  await sleep(300)
  check('the first hold lifts the icon with one buzz', (await arranging(p)) && (await buzzes(p)) === 1, await state(p))
  await sleep(500)
  check('holding on (past a long press) opens no menu', (await menus(p)) === 0 && !(await menuOpen(p)))
  await touch(p, 'touchEnd')
  await sleep(500)
  let s = await state(p)
  check('letting go of a lift opens no menu, buzzes no more, opens nothing, moves nothing', s.menus === 0 && !s.open && s.buzz === 1 && (await windows(p)) === winBefore && JSON.stringify(await iconBox(p, LABEL)) === JSON.stringify(home), s)
  check('the lift is over once the finger is up', !(await arranging(p)))

  await hold(p, c, 650)
  s = await state(p)
  check('the second hold on the same icon opens exactly one menu', s.menus === 1 && s.open, s)
  check('it buzzes once more', s.buzz === 2, s)
  check('and the icon is not lifted or dragged for it', !(await arranging(p)) && JSON.stringify(await iconBox(p, LABEL)) === JSON.stringify(home))
  check('the menu has Move to page (the alternative to dragging)', await p.eval(`[...document.querySelectorAll('.ctx-menu button')].some((b) => b.textContent.includes('Move to page'))`))
  check('letting go after it did not open the app', (await windows(p)) === winBefore)
  await sleep(800)
  check('still exactly one menu a moment later (no second one from the browser)', (await menus(p)) === 1 && (await menuOpen(p)))
  await p.eval(`history.back()`)
  await sleep(400)
  check('Back closes the menu first', !(await menuOpen(p)))

  // --- a lift is not a drag, a drag never opens a menu ---
  await closeMenu(p)
  // The headline note and Games leave one free cell on page 1's lowest row: the one to the right.
  const to = { x: c.x + 100, y: c.y }
  await touch(p, 'touchStart', [c])
  await sleep(550)
  for (let i = 1; i <= 8; i++) await touch(p, 'touchMove', [{ x: c.x + ((to.x - c.x) * i) / 8, y: c.y + ((to.y - c.y) * i) / 8 }])
  await sleep(700)
  check('dragging the lifted icon (and holding still mid-drag) opens no menu', (await menus(p)) === 1 && !(await menuOpen(p)))
  await touch(p, 'touchEnd')
  await sleep(700)
  const dropped = await iconBox(p, LABEL)
  check('dropping it moves it and opens no menu', (dropped.x !== home.x || dropped.y !== home.y) && (await menus(p)) === 1 && !(await menuOpen(p)), { dropped, home })
  c = await centreOf(p, LABEL)
  await unprime(p)
  await hold(p, c, 650)
  s = await state(p)
  check('after a drag the next hold lifts again (a drop does not arm the menu)', s.menus === 1 && !s.open, s)

  // --- sequences that start over ---
  // 1) too slow
  await unprime(p)
  await hold(p, c, 650)
  await sleep(SECOND_HOLD_MS + 600)
  await touch(p, 'touchStart', [c])
  await sleep(600)
  const lateLifted = await arranging(p)
  await touch(p, 'touchEnd')
  await sleep(400)
  s = await state(p)
  check('a second hold after the interval is a first hold again: it lifts, no menu', lateLifted && s.menus === 1 && !s.open, { lateLifted, s })

  // 2) the finger moved before the second hold was up (a swipe)
  await unprime(p)
  await hold(p, c, 650)
  await touch(p, 'touchStart', [c])
  await touch(p, 'touchMove', [{ x: c.x + 8, y: c.y }])
  await touch(p, 'touchMove', [{ x: c.x + 24, y: c.y }])
  await sleep(600)
  await touch(p, 'touchEnd')
  await sleep(500)
  s = await state(p)
  check('moving during the second hold starts over: no menu', s.menus === 1 && !s.open, s)
  await touch(p, 'touchStart', [c])
  await sleep(600)
  const afterMove = await arranging(p)
  await touch(p, 'touchEnd')
  await sleep(400)
  s = await state(p)
  check('and the hold after it lifts again, still without a menu', afterMove && s.menus === 1, { afterMove, s })

  // 3) a touch elsewhere in between
  await unprime(p)
  await hold(p, c, 650)
  await touch(p, 'touchStart', [{ x: 200, y: 690 }])
  await sleep(100)
  await touch(p, 'touchEnd')
  await hold(p, c, 650)
  s = await state(p)
  check('a touch somewhere else in between starts over', s.menus === 1 && !s.open, s)

  // 4) another icon is a first hold of its own
  const other = await centreOf(p, 'Games')
  await unprime(p)
  await hold(p, c, 650)
  await hold(p, other, 650)
  s = await state(p)
  check('holding a different icon the second time is a first hold on that one: no menu', s.menus === 1 && !s.open, s)

  // 5) cancelled (the browser takes the finger)
  await unprime(p)
  await hold(p, c, 650)
  await touch(p, 'touchStart', [c])
  await sleep(200)
  await touch(p, 'touchCancel')
  await sleep(700)
  s = await state(p)
  check('a cancelled second hold opens nothing', s.menus === 1 && !s.open && !(await arranging(p)), s)

  // 6) a second finger
  await unprime(p)
  await hold(p, c, 650)
  await touch(p, 'touchStart', [c])
  await sleep(150)
  await touch(p, 'touchStart', [c, { x: c.x + 60, y: c.y - 200 }])
  await sleep(600)
  await touch(p, 'touchEnd')
  await sleep(500)
  s = await state(p)
  check('a second finger during the second hold opens nothing', s.menus === 1 && !s.open, s)

  // 7) tap still works: a tap on a folder opens it, and nothing else happens
  await unprime(p)
  const winTap = await windows(p)
  const games = await centreOf(p, 'Games')
  await touch(p, 'touchStart', [games])
  await sleep(80)
  await touch(p, 'touchEnd')
  await sleep(1200)
  check('a plain tap still opens the folder', (await windows(p)) === winTap + 1 && (await menus(p)) === 1, { windows: await windows(p), winTap })
  await p.close()

  // --- right click and keyboard ---
  p = await open()
  c = await centreOf(p, LABEL)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1 })
  await sleep(300)
  s = await state(p)
  check('right-click opens the icon menu once', s.menus === 1 && s.open, s)
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(200)
  check('Escape closes it', !(await menuOpen(p)))
  // The keyboard's context-menu key (or Shift+F10) sends a contextmenu event to the focused icon.
  check('the icons are reachable by keyboard', await p.eval(`(() => { const e = document.querySelector('.desk-icon'); e.focus(); return document.activeElement === e && e.tabIndex >= 0 && e.getAttribute('role') === 'button' })()`))
  await p.eval(`document.activeElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 }))`)
  await sleep(250)
  s = await state(p)
  check('the keyboard menu opens the same menu', s.menus === 2 && s.open && (await p.eval(`[...document.querySelectorAll('.ctx-menu button')].some((b) => b.textContent.includes('Move to page'))`)), s)
  check('mouse and keyboard menus buzz nothing', (await buzzes(p)) === 0)
  await p.close()

  // --- the bottom edge: the lowest row sits right above the dots and dock ---
  type Edge = { H: number; rows: number; lowest: number; dotsTop: number; dockTop: number; overlapsDots: number; overlapsDock: number; scrolls: boolean; pageW: number; icons: number; page: number }
  const edge = async (p: P, page: number): Promise<Edge> => {
    await p.eval(`document.querySelector('.desk-scroll').scrollTo({ left: ${page} * innerWidth, behavior: 'instant' })`)
    await sleep(500)
    return p.eval<Edge>(`(() => {
      const dots = document.querySelector('.home-dots').getBoundingClientRect()
      const dock = document.querySelector('.dock').getBoundingClientRect()
      const vis = [...document.querySelectorAll('.desk-icon, .window.chrome-note')].map((e) => ({ r: e.getBoundingClientRect(), icon: e.classList.contains('desk-icon') })).filter((x) => x.r.right > 1 && x.r.left < innerWidth - 1 && x.r.width > 0)
      const icons = vis.filter((x) => x.icon).map((x) => x.r)
      const hit = (r, o) => (r.left < o.right && r.right > o.left && r.top < o.bottom && r.bottom > o.top ? Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top) : 0)
      const tops = [...new Set(icons.map((r) => Math.round(r.top)))].sort((a, b) => a - b)
      const sc = document.querySelector('.desk-scroll')
      return { H: innerHeight, rows: tops.length, lowest: Math.max(0, ...vis.map((x) => x.r.bottom)), dotsTop: dots.top, dockTop: dock.top,
        overlapsDots: Math.max(0, ...vis.map((x) => hit(x.r, dots))), overlapsDock: Math.max(0, ...vis.map((x) => hit(x.r, dock))),
        scrolls: sc.scrollHeight > sc.clientHeight + 1, pageW: innerWidth, icons: icons.length, page: Math.round(sc.scrollLeft / innerWidth) }
    })()`)
  }
  const ICON_H = 120
  const ROW_GAP = 6
  const bottomChecks = async (name: string, p: P, scale = 1) => {
    // Page 2 has no note: only icons, filled from the top, a full page of them (70 launchers spill over).
    const e = await edge(p, 1)
    const where = `${name}: ${e.H}px high`
    check(`${where}: icons fill the page (${e.icons} of them in ${e.rows} rows)`, e.icons >= 4 && e.rows >= 1, e)
    check(`${where}: no icon touches the page dots or the dock`, e.overlapsDots === 0 && e.overlapsDock === 0, e)
    check(`${where}: the home does not scroll down`, !e.scrolls, e)
    // The lowest icon ends at or above the dots; one more row would not fit (nothing wasted but what is under one row).
    const slack = (e.dotsTop - ROW_GAP * scale) - e.lowest
    check(`${where}: the lowest row is the last that fits (${Math.round(slack)}px left, a row needs ${ICON_H * scale})`, slack >= -0.5 && slack < ICON_H * scale - 8 * scale + 0.5, { slack, e })
    return e
  }

  p = await open(390, 844, true, 70)
  const tall = await bottomChecks('phone', p)
  check('the dots sit right above the dock', Math.abs(tall.dockTop - 6 - (await p.eval<number>(`document.querySelector('.home-dots').getBoundingClientRect().bottom`))) <= 1.5, tall)
  // The page after that, without the headline note: the same.
  await p.close()
  for (const [w, h] of [[360, 640], [390, 700], [412, 915], [320, 568]] as const) {
    p = await open(w, h, true, 70)
    await bottomChecks(`${w}x${h}`, p)
    await p.close()
  }
  // Rotation: the phone turned sideways (still the phone layout, below 720px wide).
  p = await open(667, 375, true, 70)
  await bottomChecks('landscape 667x375', p)
  // And back: same page, nothing was saved by turning.
  const savedBefore = await p.eval<string>(`localStorage.getItem(Object.keys(localStorage).find((k) => k.endsWith('.sync.desktop')) ?? '') ?? ''`)
  await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(900)
  const back = await edge(p, 1)
  check('turned back: the page fits again and the rows come back', !back.scrolls && back.overlapsDots === 0 && back.rows >= tall.rows - 1, back)
  check('turning the phone saved nothing', (await p.eval<string>(`localStorage.getItem(Object.keys(localStorage).find((k) => k.endsWith('.sync.desktop')) ?? '') ?? ''`)) === savedBefore)

  // A bigger UI scale (page px get bigger; the same checks, in screen px).
  await p.eval(`(async () => (await import('/src/os/uiScale.ts')).uiScalePref.set(1.25))()`)
  await sleep(1200)
  await bottomChecks('UI scale 125%', p, 1.25)
  await p.eval(`(async () => (await import('/src/os/uiScale.ts')).uiScalePref.set(0.8))()`)
  await sleep(1200)
  await bottomChecks('UI scale 80%', p, 0.8)
  await p.eval(`(async () => (await import('/src/os/uiScale.ts')).uiScalePref.set(1))()`)
  await sleep(900)

  // Safe area: a phone with a home-indicator inset (the dock rides up by it; the dots and the icons with it).
  await p.eval(`document.documentElement.style.setProperty('--sab', '34px')`)
  await p.eval(`window.dispatchEvent(new Event('resize'))`)
  await sleep(900)
  await bottomChecks('safe area 34px', p)
  await p.eval(`document.documentElement.style.removeProperty('--sab')`)
  await p.eval(`window.dispatchEvent(new Event('resize'))`)
  await sleep(600)

  // A taller dock (a different size of dock) moves the dots up and the rows follow.
  await p.eval(`(() => { const d = document.querySelector('.dock'); d.style.paddingBottom = '30px'; window.dispatchEvent(new Event('resize')) })()`)
  await sleep(900)
  const bigDock = await bottomChecks('a 30px taller dock', p)
  check('a taller dock leaves no fewer than a row less than the normal one', bigDock.rows >= tall.rows - 1, { bigDock, tall })
  await p.close()

  // The desktop: icons use the room above the dock; it still scrolls when there are more than fit.
  p = await open(1280, 720, false)
  const desk = await p.eval<{ reserve: number; dockTop: number; lowestRowBottom: number; H: number }>(`(async () => {
    const m = await import('/src/os/homeLayout.ts')
    const dock = document.querySelector('.dock').getBoundingClientRect()
    return { reserve: m.deskBottomReserve(), dockTop: dock.top, lowestRowBottom: 0, H: innerHeight }
  })()`)
  check('desktop: the reserve at the bottom is the dock itself (measured), not a fixed 100px', desk.reserve > 0 && Math.abs(desk.reserve - (desk.H - desk.dockTop + 4)) <= 1.5, desk)
  await p.close()

  console.log(failed ? `FAILED ${failed}` : 'PASS home hold: two-hold menu, drag, reset sequences, right-click, keyboard, bottom edge')
} finally {
  await stop()
}
process.exit(failed ? 1 : 0)
