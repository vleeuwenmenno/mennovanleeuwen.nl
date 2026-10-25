// End-to-end check that widgets and windows keep their stacking order (src/os/wm.tsx): a window in
// front of a widget is still in front after a reload, and so is a widget brought in front of a
// window; a widget arriving from another device goes behind the windows here instead of jumping
// in front; and none of that saves anything while nobody does anything. Real headless Chromium
// (sound muted) against a Vite dev server with a scratch DATA_DIR and a test account (no GitHub),
// signed out and signed in.
//
//   PORT=5294 node scripts/widget-stacking-e2e.ts
//
// Exits 1 on any failure.

import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5294)
const IDLE_MS = Number(process.env.IDLE_MS ?? 8000)
const data = mkdtempSync('/tmp/mvlos-widget-stacking-')
process.env.DATA_DIR = data
const { database, encrypt, sha256 } = await import(`${WT}/server/db.ts`)
const { launch, newPage, sleep } = await import(`${WT}/scripts/perf/cdp.ts`)

let failed = 0
const check = (what: string, ok: boolean, extra?: unknown) => {
  console.log(ok ? 'PASS' : 'FAIL', what, ok || extra === undefined ? '' : JSON.stringify(extra))
  if (!ok) failed++
}

const now = Date.now()
const sid = randomBytes(24).toString('hex')
const login = 'widget-stacking'
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, login, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), 1, now, now + 86400_000)
const sid2 = randomBytes(24).toString('hex')
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid2), 1, now, now + 86400_000)

const vite = spawn(`${WT}/node_modules/.bin/vite`, ['--port', String(PORT), '--strictPort'], {
  cwd: WT,
  env: { ...process.env, DATA_DIR: data, GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: 'nobody', MC_WATCH: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
// Stopped with the script, however it ends.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) process.on(sig, () => (vite.kill(), process.exit(1)))
let log = ''
vite.stdout.on('data', (d) => (log += d))
vite.stderr.on('data', (d) => (log += d))
const origin = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 150 && !log.includes('ready') && vite.exitCode === null; i++) await sleep(200)
if (!log.includes('ready') || vite.exitCode !== null) throw new Error(`vite did not start:\n${log}`)

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
const browsers: { close: () => Promise<void> }[] = []
async function browser(signedIn: string | null, w = 1400, h = 900): Promise<P> {
  const b = await launch(w, h)
  browsers.push(b)
  const page = await newPage(b, w, h, COUNT_PUTS)
  if (signedIn) for (const [name, value] of [['mvlos_sid', signedIn], ['mvlos_login', login], ['mvlos_uid', '1']]) await page.send('Network.setCookie', { name, value, url: origin })
  return page
}
async function load(page: P) {
  await page.send('Page.navigate', { url: origin + '/' })
  await page.waitFor(`document.querySelector('.desktop') && document.querySelectorAll('.window').length > 0 && !document.querySelector('[class^="boot"], [class*=" boot"]')`, 90_000)
  await page.waitFor(`!document.querySelector('.boot')`, 30_000)
  await sleep(2500)
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
const widgetCount = (page: P) => page.eval<number>(`document.querySelectorAll('.window[data-app="widget"]').length`)
async function addWidget(page: P, name: string) {
  const before = await widgetCount(page)
  const at = await bareSpot(page)
  await rightClick(page, at.x, at.y)
  await page.clickText('.ctx-item', 'New')
  await sleep(150)
  await page.clickText('.ctx-item', 'Widget')
  await sleep(150)
  await page.clickText('.ctx-item', name)
  await page.waitFor(`document.querySelectorAll('.window[data-app="widget"]').length > ${before}`, 10_000)
  await sleep(300)
}
/** The windows from back to front: data-app and title, with their z-index. */
const order = (page: P) =>
  page.eval<{ name: string; widget: boolean; z: number }[]>(`[...document.querySelectorAll('.window')]
    .map((e) => ({ name: e.getAttribute('data-app') + ':' + e.getAttribute('aria-label'), widget: e.getAttribute('data-app') === 'widget', z: Number(getComputedStyle(e).zIndex) || 0, shown: getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' }))
    .filter((w) => w.shown)
    .sort((a, b) => a.z - b.z)
    .map(({ name, widget, z }) => ({ name, widget, z }))`)
const names = (o: { name: string }[]) => o.map((w) => w.name).join(' < ')
/** A spot of the window's title bar (a widget: its grip), or else of the window, that no other window covers. */
async function spot(page: P, name: string) {
  const at = await page.eval<{ x: number; y: number } | null>(`(() => {
    const w = [...document.querySelectorAll('.window')].find((e) => e.getAttribute('data-app') + ':' + e.getAttribute('aria-label') === ${JSON.stringify(name)})
    const g = w && (w.querySelector('.titlebar') || w.querySelector('.note-grip'))
    if (!g) return null
    // The bar first; failing that, any uncovered part of the window.
    for (const r of [g.getBoundingClientRect(), w.getBoundingClientRect()])
      for (let x = r.x + 8; x < r.right - 4; x += 12) for (let y = r.y + 3; y < r.bottom - 2; y += 4) {
        const e = document.elementFromPoint(x, y)
        if (e && e.closest('.window') === w && !e.closest('button, input, select, a, textarea')) return { x, y }
      }
    return null
  })()`)
  if (!at) throw new Error(`no uncovered spot on ${name}`)
  return at
}
/** Clicks the window (a plain window: its title bar; a widget: its grip). */
async function press(page: P, name: string) {
  const at = await spot(page, name)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 })
  // Past the layout's save (debounced 400 ms).
  await sleep(1200)
}
const rectOf = (page: P, name: string) =>
  page.eval<{ x: number; y: number; w: number; h: number }>(`(() => {
    const w = [...document.querySelectorAll('.window')].find((e) => e.getAttribute('data-app') + ':' + e.getAttribute('aria-label') === ${JSON.stringify(name)})
    const r = w.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  })()`)
async function drag(page: P, name: string, dx: number, dy: number) {
  const g = await spot(page, name)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.x, y: g.y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 10; i++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.x + (dx * i) / 10, y: g.y + (dy * i) / 10, button: 'left', buttons: 1 })
    await sleep(20)
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x + dx, y: g.y + dy, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(1200)
}
/** Which of the two windows is drawn where they overlap. */
const onTop = (page: P, a: string, b: string) =>
  page.eval<string | null>(`(() => {
    const find = (n) => [...document.querySelectorAll('.window')].find((e) => e.getAttribute('data-app') + ':' + e.getAttribute('aria-label') === n)
    const [A, B] = [find(${JSON.stringify(a)}), find(${JSON.stringify(b)})]
    const r = A.getBoundingClientRect(), q = B.getBoundingClientRect()
    const x = (Math.max(r.left, q.left) + Math.min(r.right, q.right)) / 2, y = (Math.max(r.top, q.top) + Math.min(r.bottom, q.bottom)) / 2
    const w = document.elementFromPoint(x, y)?.closest('.window')
    const hit = document.elementFromPoint(x, y)
    return w === A ? ${JSON.stringify(a)} : w === B ? ${JSON.stringify(b)} : 'something else: ' + (hit ? hit.tagName + '.' + hit.className : 'nothing')
  })()`)
/** A reload, the way a visitor does it (the page's own state, storage and cookies stay). */
const reload = load
const resetPuts = (p: P) => p.eval(`(window.__puts = {}, 0)`)
const puts = (p: P) => p.eval<Record<string, number>>(`window.__puts || {}`)
async function quiet(page: P, what: string) {
  await resetPuts(page)
  await sleep(IDLE_MS)
  const r = await puts(page)
  check(`${what}: no window layout or widget saves while idle`, !r['widgets:placed'] && !r['windows:desktop'], r)
}
const plain = (o: { widget: boolean; name: string }[]) => o.filter((w) => !w.widget && !/^(notes|keys):/.test(w.name))

/** The same steps signed out and signed in: a window over a widget, and a widget over a window. */
async function survivesReload(page: P, who: string) {
  await addWidget(page, 'Status')
  let o = await order(page)
  check(`${who}: a widget just added is in front`, o.at(-1)?.widget === true, names(o))
  const win = plain(o).at(-1)
  if (!win) throw new Error(`${who}: no plain window on the desktop`)
  // Half over the window's left edge, so both show.
  const [wr, sr] = [await rectOf(page, win.name), await rectOf(page, 'widget:Status')]
  await drag(page, 'widget:Status', wr.x - Math.round(sr.w / 2) - sr.x, wr.y + 60 - sr.y)
  await press(page, win.name)
  check(`${who}: the window is drawn over the widget`, (await onTop(page, win.name, 'widget:Status')) === win.name)
  const before = await order(page)
  check(`${who}: clicking the window brings it in front of the widget`, before.at(-1)?.name === win.name, names(before))
  await reload(page)
  let after = await order(page)
  check(`${who}: after a reload the window is still in front of the widget`, after.at(-1)?.name === win.name, names(after))
  const drawn = await onTop(page, win.name, 'widget:Status')
  check(`${who}: and drawn over it`, drawn === win.name, drawn)
  check(`${who}: after a reload the whole order is the same`, names(after) === names(before), { before: names(before), after: names(after) })
  await quiet(page, `${who} after a reload`)

  const widget = after.find((w) => w.widget && w.name.endsWith(':Status'))!
  await press(page, widget.name)
  o = await order(page)
  check(`${who}: clicking the widget brings it in front of the window`, o.at(-1)?.name === widget.name, names(o))
  await reload(page)
  after = await order(page)
  check(`${who}: after a reload the widget is still in front`, after.at(-1)?.name === widget.name && names(after) === names(o), { before: names(o), after: names(after) })
  check(`${who}: and drawn over the window`, (await onTop(page, win.name, 'widget:Status')) === 'widget:Status')
  // Back to the window in front, for what comes next.
  await press(page, win.name)
  return win.name
}

try {
  // 1. Signed out: the layout and widgets are this browser's own.
  const V = await browser(null)
  await load(V)
  await survivesReload(V, 'signed out')

  // 2. Signed in.
  const A = await browser(sid)
  await load(A)
  const front = await survivesReload(A, 'signed in')
  await reload(A)
  const settled = await order(A)
  check('signed in: the window stays in front after another reload', settled.at(-1)?.name === front, names(settled))

  // 3. Another device (a desktop, same account) shows the same stacking: it follows the account
  // with the window layout.
  const B = await browser(sid2, 1280, 800)
  await load(B)
  check('another device shows the same stacking', names(await order(B)) === names(await order(A)), { A: names(await order(A)), B: names(await order(B)) })

  // 4. A widget put on the desktop elsewhere without a place in this layout (from a phone, whose
  // layout is its own): in A it goes behind A's windows, and A saves nothing for it.
  await B.eval(`import('/src/os/widgetPlaces.ts').then((m) => { m.widgetPlaces.set((cur) => m.changeSet(cur, { mcphone1: { id: 'mcphone1', kind: 'minecraft', x: 40, y: 300, w: 280, h: 220, vw: 390, vh: 800, at: Date.now() } })); return 0 })`)
  await sleep(2500)
  await resetPuts(A)
  const beforeRemote = await order(A)
  const pull = async (p: P) => {
    await sleep(21_000)
    await p.eval(`document.dispatchEvent(new Event('visibilitychange'))`)
    await sleep(3000)
  }
  await pull(A)
  const afterRemote = await order(A)
  const arrived = afterRemote.find((w) => w.name === 'widget:Minecraft server')
  check('the widget from elsewhere arrived', !!arrived, names(afterRemote))
  const lowestPlain = Math.min(...plain(afterRemote).map((w) => w.z))
  check('it went behind the windows here, not in front', !!arrived && arrived.z < lowestPlain, names(afterRemote))
  check('everything else kept its order', names(afterRemote.filter((w) => w !== arrived)) === names(beforeRemote), { before: names(beforeRemote), after: names(afterRemote) })
  check('the window is still in front', afterRemote.at(-1)?.name === front, names(afterRemote))
  const got = await puts(A)
  check('showing the arrival saved no widget places and no layout in A', !got['widgets:placed'] && !got['windows:desktop'], got)
  await quiet(A, 'A after the remote widget')

  // 5. A widget moved elsewhere, by its place in the set only (no layout from there: a phone's
  // column, or another device's move that doesn't change its stacking): in A it moves, and the
  // stacking stays.
  await B.eval(`import('/src/os/widgetPlaces.ts').then((m) => { m.widgetPlaces.set((cur) => { const [k, p] = Object.entries(cur.places).find(([, p]) => p.kind === 'status'); return m.changeSet(cur, { [k]: { ...p, x: p.x - 120, y: p.y + 60, at: m.nextAt(p) } }) }); return 0 })`)
  await sleep(2500)
  const at = async (p: P) => JSON.stringify(await rectOf(p, 'widget:Status'))
  const wasAt = await at(A)
  const beforeMove = await order(A)
  await resetPuts(A)
  await pull(A)
  const afterMove = await order(A)
  check('the move reached A', (await at(A)) !== wasAt, { wasAt })
  check('and A kept its stacking', names(afterMove) === names(beforeMove), { before: names(beforeMove), after: names(afterMove) })
  const moved = await puts(A)
  check('showing the move saved nothing in A', !moved['widgets:placed'] && !moved['windows:desktop'], moved)

  for (const p of [V, A, B]) if (p.errors.length) check('no page errors', false, p.errors.slice(0, 3))
} catch (e) {
  check('ran', false, String(e))
} finally {
  for (const b of browsers) await b.close().catch(() => {})
  vite.kill()
  rmSync(data, { recursive: true, force: true })
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
