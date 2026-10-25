// End-to-end check that synced stores stay quiet while nobody does anything: no save loop between
// tabs or devices whose screens differ in size (src/os/synced.ts, src/os/widgetPlaces.ts and the
// widget windows in src/os/wm.tsx). Real headless Chromium against a Vite dev server with a
// scratch DATA_DIR and a test account (no GitHub), sound muted.
//
//   PORT=5289 node scripts/sync-loop-e2e.ts
//
// Scenarios, each counting the saves (PUT /api/state/...) every page sends while idle:
//   1. one browser, two tabs of different sizes (1600x900 and 1100x900), a sticky note and Notebook open;
//   2. a second browser (another device) at 1280x760 next to them;
//   3. one tab resized narrower and back (DevTools docking), with the others still open.
//
// Exits 1 on any failure.

import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5289)
/** Saves allowed per page over an idle stretch (a pull or a late first save can legitimately send one or two). */
const MAX_IDLE_PUTS = Number(process.env.MAX_IDLE_PUTS ?? 2)
const IDLE_MS = Number(process.env.IDLE_MS ?? 10_000)
const data = mkdtempSync('/tmp/mvlos-sync-loop-')
process.env.DATA_DIR = data
const { database, encrypt, sha256 } = await import(`${WT}/server/db.ts`)
const { launch, newPage, sleep } = await import(`${WT}/scripts/perf/cdp.ts`)

let failed = 0
const check = (what: string, ok: boolean, extra?: unknown) => {
  console.log(ok ? 'PASS' : 'FAIL', what, extra === undefined ? '' : JSON.stringify(extra))
  if (!ok) failed++
}

const now = Date.now()
const sid = randomBytes(24).toString('hex')
const login = 'sync-loop'
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, login, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), 1, now, now + 86400_000)

const vite = spawn(`${WT}/node_modules/.bin/vite`, ['--port', String(PORT), '--strictPort'], {
  cwd: WT,
  env: { ...process.env, DATA_DIR: data, GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: 'nobody', MC_WATCH: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
vite.stdout.on('data', (d) => (log += d))
vite.stderr.on('data', (d) => (log += d))
const origin = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 150 && !log.includes('ready'); i++) await sleep(200)
if (!log.includes('ready')) throw new Error(`vite did not start:\n${log}`)

// Every save a page sends, by key.
const COUNT_PUTS = `(() => {
  const real = window.fetch.bind(window)
  window.__puts = {}
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if ((init?.method ?? 'GET').toUpperCase() === 'PUT' && url.includes('/api/state/')) {
      const k = decodeURIComponent(url.split('/api/state/')[1])
      window.__puts[k] = (window.__puts[k] ?? 0) + 1
    }
    return real(input, init)
  }
})()`

type P = Awaited<ReturnType<typeof newPage>>
type B = Awaited<ReturnType<typeof launch>>
const browsers: B[] = []
async function browser(w: number, h: number): Promise<B> {
  const b = await launch(w, h)
  browsers.push(b)
  return b
}
async function tab(b: B, w: number, h: number): Promise<P> {
  const page = await newPage(b, w, h, COUNT_PUTS)
  for (const [name, value] of [['mvlos_sid', sid], ['mvlos_login', login], ['mvlos_uid', '1']]) await page.send('Network.setCookie', { name, value, url: origin })
  await page.send('Page.navigate', { url: origin + '/' })
  await page.waitFor(`document.querySelector('.desktop') && document.querySelectorAll('.window').length > 0 && !document.querySelector('[class^="boot"], [class*=" boot"]')`, 90_000)
  await sleep(2500)
  return page
}
async function rightClick(page: P, x: number, y: number) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 })
  await sleep(250)
}
async function bareSpot(page: P) {
  const at = await page.eval<{ x: number; y: number } | null>(`(() => {
    for (let y = 120; y < innerHeight - 140; y += 37) for (let x = innerWidth - 60; x > 60; x -= 41) {
      const e = document.elementFromPoint(x, y)
      if (e && e.closest('.desktop') && !e.closest('.window, .desk-icon, [class*=icon], button')) return { x, y }
    }
    return null
  })()`)
  if (!at) throw new Error('no bare desktop to right-click')
  return at
}
async function addSticky(page: P) {
  const before = await page.eval<number>(`document.querySelectorAll('.window[data-app="widget"]').length`)
  const at = await bareSpot(page)
  await rightClick(page, at.x, at.y)
  await page.clickText('.ctx-item', 'New')
  await sleep(150)
  await page.clickText('.ctx-item', 'Sticky note')
  await page.waitFor(`document.querySelectorAll('.window[data-app="widget"]').length > ${before}`, 10_000)
}
/** Drags the sticky by its grip, to near the right edge (so other screen sizes move it along). */
async function dragSticky(page: P, dx: number, dy: number) {
  const a = await page.eval<{ x: number; y: number }>(`(() => {
    const g = document.querySelector('.window[data-app="widget"] .note-grip').getBoundingClientRect()
    return { x: g.x + g.width / 2, y: g.y + g.height / 2 }
  })()`)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 10; i++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (dx * i) / 10, y: a.y + (dy * i) / 10, button: 'left', buttons: 1 })
    await sleep(20)
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x + dx, y: a.y + dy, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(300)
}
const resetPuts = (pages: P[]) => Promise.all(pages.map((p) => p.eval(`(window.__puts = {}, 0)`)))
const puts = (p: P) => p.eval<Record<string, number>>(`window.__puts`)
const total = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)
/** Idle for a while, then the saves each page sent. */
async function idle(pages: P[], names: string[], what: string) {
  await resetPuts(pages)
  await sleep(IDLE_MS)
  const all = await Promise.all(pages.map(puts))
  const byPage = Object.fromEntries(names.map((n, i) => [n, all[i]]))
  console.log(`  ${what}: saves in ${IDLE_MS / 1000} s idle`, JSON.stringify(byPage))
  check(`${what}: every page at most ${MAX_IDLE_PUTS} saves while idle`, all.every((r) => total(r) <= MAX_IDLE_PUTS), byPage)
  return all
}

try {
  // 1. One browser, two tabs of different widths, a sticky moved near the right edge, Notebook open.
  const b1 = await browser(1600, 900)
  const A = await tab(b1, 1600, 900)
  await addSticky(A)
  await sleep(500)
  await dragSticky(A, 500, 0)
  await sleep(2000)
  const B = await tab(b1, 1100, 900)
  await sleep(2000)
  await idle([A, B], ['A 1600', 'B 1100'], 'two tabs, different widths')

  // 2. Another device next to them.
  const b2 = await browser(1280, 760)
  const C = await tab(b2, 1280, 760)
  await sleep(2000)
  await idle([A, B, C], ['A 1600', 'B 1100', 'C 1280 (device)'], 'two tabs and a device')

  // 3. A tab made narrower (DevTools docked) and back.
  await A.send('Emulation.setDeviceMetricsOverride', { width: 1150, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(1500)
  await idle([A, B, C], ['A 1150', 'B 1100', 'C 1280 (device)'], 'a tab made narrower')
  await A.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(1500)
  await idle([A, B, C], ['A 1600', 'B 1100', 'C 1280 (device)'], 'that tab back to its width')

  // 4. Still a real move syncs: the drag in B reaches A and C.
  await resetPuts([A, B, C])
  await dragSticky(B, -200, 100)
  await sleep(2500)
  const moved = await B.eval<Record<string, number>>(`window.__puts`)
  check('a real move in B is saved', (moved['widgets:placed'] ?? 0) >= 1, moved)
  const placeIn = (p: P) => p.eval<string>(`import('/src/os/widgetPlaces.ts').then((m) => JSON.stringify(Object.values(m.widgetPlaces.get().places).map((e) => [e.x, e.y, e.at])))`)
  const [inA, inB] = [await placeIn(A), await placeIn(B)]
  check('and A (the other tab) has the same place', inA === inB, { inA, inB })
  await sleep(3000)
  await idle([A, B, C], ['A 1600', 'B 1100', 'C 1280 (device)'], 'after a real move')

  // 5. A change on a device with a single tab: saved once, then quiet.
  await resetPuts([C])
  await dragSticky(C, -100, 50)
  await sleep(3000)
  const one = await puts(C)
  check('a real move on the single-tab device is saved', (one['widgets:placed'] ?? 0) >= 1, one)
  await idle([C], ['C 1280 (device)'], 'single tab after a real move')

  for (const p of [A, B, C]) if (p.errors.length) check('no page errors', false, p.errors.slice(0, 3))
} catch (e) {
  check('ran', false, String(e))
} finally {
  for (const b of browsers) await b.close().catch(() => {})
  vite.kill()
  rmSync(data, { recursive: true, force: true })
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
