// End-to-end check for synced desktop widgets (src/os/widgetPlaces.ts), in real headless Chromium
// against a Vite dev server with a scratch DATA_DIR and a test account (no GitHub).
//
//   PORT=5264 node scripts/widgets-sync-e2e.ts
//
// Each "browser" is its own Chromium with its own profile (fresh localStorage), sound muted.

import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5264)
const data = mkdtempSync('/tmp/mvlos-widgets-e2e-')
process.env.DATA_DIR = data
const { database, encrypt, sha256 } = await import(`${WT}/server/db.ts`)
const { launch, newPage, sleep } = await import(`${WT}/scripts/perf/cdp.ts`)

let failed = 0
const check = (what: string, ok: boolean, extra?: unknown) => {
  console.log(ok ? 'PASS' : 'FAIL', what, ok || extra === undefined ? '' : JSON.stringify(extra))
  if (!ok) failed++
}

// --- accounts ---------------------------------------------------------------------------------
const now = Date.now()
const users: { id: number; login: string; sid: string; apiSid: string }[] = []
for (const [id, login] of [
  [1, 'widgets-check'],
  [2, 'widgets-migrate'],
] as const) {
  const sid = randomBytes(24).toString('hex')
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, login, encrypt('none'), now, now)
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), id, now, now + 86400_000)
  // A session of its own for this script's checks, so a browser signing out doesn't end it.
  const apiSid = randomBytes(24).toString('hex')
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(apiSid), id, now, now + 86400_000)
  users.push({ id, login, sid, apiSid })
}
const [U1, U2] = users

// --- dev server ---------------------------------------------------------------------------------
const vite = spawn(`${WT}/node_modules/.bin/vite`, ['--port', String(PORT), '--strictPort'], {
  cwd: WT,
  env: { ...process.env, DATA_DIR: data, GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_GITHUB_IDS: '999999', MC_WATCH: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
vite.stdout.on('data', (d) => (log += d))
vite.stderr.on('data', (d) => (log += d))
const origin = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 150 && !log.includes('ready'); i++) await sleep(200)
if (!log.includes('ready')) throw new Error(`vite did not start:\n${log}`)

const api = (u: typeof U1, p: string, init: { method?: string; json?: unknown } = {}) =>
  fetch(origin + p, { method: init.method ?? 'GET', headers: { Cookie: `mvlos_sid=${u.apiSid}`, Origin: origin, 'Content-Type': 'application/json', 'X-MvL-Account': String(u.id) }, body: init.json === undefined ? undefined : JSON.stringify(init.json) }).then((r) => r.json())
const serverWidgets = async (u = U1) => {
  return ((await api(u, '/api/state'))['widgets:state:v2']?.value?.placements?.places ?? {}) as Record<string, { id: string; kind: string; x: number; y: number }>
}

// --- browsers -----------------------------------------------------------------------------------
const browsers: { close: () => Promise<void> }[] = []
type P = Awaited<ReturnType<typeof newPage>>
async function browser(user: typeof U1 | null, w = 1400, h = 900): Promise<P> {
  const b = await launch(w, h)
  browsers.push(b)
  const page = await newPage(b, w, h, '')
  if (user) for (const [name, value] of [['mvlos_sid', user.sid], ['mvlos_login', user.login], ['mvlos_uid', String(user.id)]]) await page.send('Network.setCookie', { name, value, url: origin })
  return page
}
async function load(page: P) {
  await page.send('Page.navigate', { url: origin + '/' })
  await page.waitFor(`document.querySelector('.desktop') && document.querySelectorAll('.window').length > 0 && !document.querySelector('[class^="boot"], [class*=" boot"]')`, 90_000)
  // Sign-in answered and the first pull done.
  await sleep(2500)
}
/** Widgets on screen: their ids (from the browser's copy of the set) and titles. */
const shown = (page: P) =>
  page.eval<{ ids: string[]; titles: string[]; rects: { x: number; y: number }[] }>(`(() => {
    const els = [...document.querySelectorAll('.window[data-app="widget"]')]
    let set = {}
    try { set = JSON.parse(localStorage.getItem(((document.cookie.match(/mvlos_uid=(\\d+)/) || [])[1] ? 'mvlos.u.' + document.cookie.match(/mvlos_uid=(\\d+)/)[1] + '.' : 'mvlos.visitor.') + 'sync.widgets:state:v2') || '{}').value.placements.places || {} } catch {}
    return { ids: Object.values(set).map((p) => p.id).sort(), titles: els.map((e) => e.getAttribute('aria-label')).sort(), rects: els.map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) } }) }
  })()`)
const count = async (page: P) => (await page.eval<number>(`document.querySelectorAll('.window[data-app="widget"]').length`))

async function rightClick(page: P, x: number, y: number) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 })
  await sleep(250)
}
/** A spot of bare desktop to right-click. */
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
async function addWidget(page: P, name: string) {
  const before = await count(page)
  const at = await bareSpot(page)
  await rightClick(page, at.x, at.y)
  if (process.env.DEBUG) console.log('menu at', at, await page.eval(`[...document.querySelectorAll('.ctx-item')].map(e => e.textContent).join('|') + ' @ ' + document.elementFromPoint(${at.x}, ${at.y})?.className`))
  await page.clickText('.ctx-item', 'New')
  await sleep(150)
  await page.clickText('.ctx-item', 'Widget')
  await sleep(150)
  await page.clickText('.ctx-item', name)
  await page.waitFor(`document.querySelectorAll('.window[data-app="widget"]').length > ${before}`, 10_000)
}
async function widgetGrip(page: P, title: string) {
  const at = await page.eval<{ x: number; y: number } | null>(`(() => {
    const w = [...document.querySelectorAll('.window[data-app="widget"]')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(title)})
    const g = w && w.querySelector('.note-grip')
    if (!g) return null
    const r = g.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (!at) throw new Error(`no widget ${title}`)
  return at
}
async function drag(page: P, title: string, dx: number, dy: number) {
  const a = await widgetGrip(page, title)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 10; i++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (dx * i) / 10, y: a.y + (dy * i) / 10, button: 'left', buttons: 1 })
    await sleep(20)
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x + dx, y: a.y + dy, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(300)
}
async function removeWidget(page: P, title: string) {
  const a = await widgetGrip(page, title)
  await rightClick(page, a.x, a.y)
  await page.clickText('.ctx-item.is-danger')
  await sleep(300)
}
/** Coming back to the tab: the pull that runs then (only 20 s after the last one). */
async function refocus(page: P) {
  await sleep(21_000)
  await page.eval(`document.dispatchEvent(new Event('visibilitychange'))`)
  await sleep(2500)
}
const pushed = () => sleep(2000) // synced() saves 800 ms after a change

try {
  if (!process.env.REGRESSIONS_ONLY) {
    // 1. Migration from a layout saved by the old release (widgets in windows:desktop).
    await api(U1, '/api/state/windows:desktop', {
      method: 'PUT',
      json: {
        value: [
          { app: 'terminal', x: 400, y: 120, w: 700, h: 450, minimized: false, maximized: false, ws: 1, props: {} },
          { app: 'widget', x: 1000, y: 100, w: 280, h: 220, minimized: false, maximized: false, props: { kind: 'status', id: 'oldstat1' } },
        ],
        base: 0,
      },
    })
    const A = await browser(U1)
    await load(A)
    let s = await shown(A)
    check('A (fresh browser) shows the widget from the old-style server layout', s.titles.includes('Status') && s.ids.includes('oldstat1'), s)
    await pushed()
    check('the old layout widget moved into the synced set on the server', 'oldstat1' in (await serverWidgets()))
    const layoutApps = ((await api(U1, '/api/state'))['windows:desktop']?.value ?? []).map((w: { app: string }) => w.app)
    check("a fresh browser didn't replace the account's window layout with its opening windows", layoutApps.includes('terminal') && !layoutApps.includes('notes'), layoutApps)

    // 2. Add widgets in A; a fresh browser B shows them.
    await addWidget(A, 'Minecraft server')
    await addWidget(A, 'Code inbox')
    await pushed()
    const afterA = await serverWidgets()
    check('A: two added widgets reached the server', Object.keys(afterA).length === 3, afterA)
    const B = await browser(U1, 1280, 760)
    await load(B)
    s = await shown(B)
    check('B (fresh, smaller screen) shows the same three widgets with the same ids', s.ids.join() === Object.keys(afterA).sort().join() && s.titles.length === 3, s)
    check('B: every widget is on screen', s.rects.every((r) => r.x >= 0 && r.x < 1280 && r.y >= 0 && r.y < 760), s.rects)

    // 3. Move and remove in B; A gets it on refocus.
    // Bring the Minecraft widget to the front (a press on it focuses it; a click would open its window), then drag it.
    const free = 'Minecraft server'
    await B.eval(`[...document.querySelectorAll('.window[data-app="widget"]')].find((e) => e.getAttribute('aria-label') === 'Minecraft server').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
    await sleep(300)
    const KIND: Record<string, string> = { 'Minecraft server': 'minecraft', Status: 'status', 'Code inbox': 'inbox' }
    const posBefore = Object.values(afterA).find((p) => p.kind === KIND[free])!
    await drag(B, free, -200, 120)
    await removeWidget(B, 'Code inbox')
    await pushed()
    const afterB = await serverWidgets()
    const mc = Object.values(afterB).find((p) => p.kind === KIND[free] && (p.x !== posBefore.x || p.y !== posBefore.y))
    check('B: the move reached the server', !!mc && (mc.x !== posBefore.x || mc.y !== posBefore.y), { posBefore, mc })
    check('B: the removal reached the server', !Object.values(afterB).some((p) => p.kind === 'inbox'), afterB)
    await refocus(A)
    s = await shown(A)
    check('A after refocus: the removed widget is gone', !s.titles.includes('Code inbox') && s.titles.length === 2, s)
    const aMoved = await A.eval<{ x: number; y: number } | null>(`(() => { const v = JSON.parse(localStorage.getItem(((document.cookie.match(/mvlos_uid=(\\d+)/) || [])[1] ? 'mvlos.u.' + document.cookie.match(/mvlos_uid=(\\d+)/)[1] + '.' : 'mvlos.visitor.') + 'sync.widgets:state:v2')).value.placements.places; const p = v[${JSON.stringify(mc?.id ?? '')}]; return p ? { x: p.x, y: p.y } : null })()`)
    check('A after refocus: the moved widget has its new place', !!mc && aMoved?.x === mc.x && aMoved?.y === mc.y, { aMoved, mc })
    // 4. Refresh A: the removed widget stays removed.
    await load(A)
    s = await shown(A)
    check('A after refresh: still removed', !s.titles.includes('Code inbox') && s.titles.length === 2, s)

    // 5. Concurrent adds: both survive.
    await refocus(B)
    await Promise.all([addWidget(A, 'Agenda'), addWidget(B, 'Status')])
    await pushed()
    await sleep(1500)
    const both = await serverWidgets()
    const kinds = Object.values(both).map((p) => p.kind).sort()
    check('concurrent adds in A and B both on the server', kinds.filter((k) => k === 'agenda').length === 1 && kinds.filter((k) => k === 'status').length === 2, kinds)
    await load(A)
    await load(B)
    const sa = await shown(A)
    const sb = await shown(B)
    check('A and B show the same four widgets after a refresh', sa.titles.length === 4 && sa.titles.join() === sb.titles.join(), { sa: sa.titles, sb: sb.titles })

    // 6. A phone hides widgets without deleting their placements.
    const C = await browser(U1, 390, 800)
    await load(C)
    const sc = await shown(C)
    check('phone: hides all widgets', sc.titles.length === 0, sc.titles)
    check('phone: no page errors', C.errors.length === 0, C.errors)

    // 6b. Two tabs of one browser: signing out in tab 1 must not let tab 2 write account 1's state.
    {
      const b = await launch(1400, 900)
      browsers.push(b)
      const p1 = await newPage(b, 1400, 900, '')
      for (const [name, value] of [['mvlos_sid', U1.sid], ['mvlos_login', U1.login], ['mvlos_uid', String(U1.id)]]) await p1.send('Network.setCookie', { name, value, url: origin })
      await load(p1)
      const p2 = await newPage(b, 1400, 900, '')
      await load(p2)
      // Whose space each synced value is in (src/os/accountSpace.ts).
      const ownersIn = (p: P) => p.eval<string[]>(`Object.keys(localStorage).filter((k) => /^mvlos\\.(u\\.\\d+|visitor)\\.sync\\./.test(k)).map((k) => k.startsWith('mvlos.visitor.') ? 'visitor' : 'u:' + k.split('.')[2])`)
      check('two tabs: both signed in, state in the account’s space', (await ownersIn(p2)).includes('u:1'))
      const serverBefore = Object.keys(await serverWidgets()).length
      // Tab 1 signs out (the account's state is cleared from the browser, the page starts again).
      await p1.eval(`import('/src/os/account.ts').then((m) => { m.signOut(); return true })`)
      // Once the browser no longer holds account 1, tab 2 adds a widget (if it is still there to
      // click: it may already be starting again).
      await p2.waitFor(`!document.cookie.includes('mvlos_uid')`, 20_000).catch(() => {})
      await addWidget(p2, 'Status').catch(() => {})
      await sleep(3000)
      const owners = await ownersIn(p1)
      check('two tabs: after signing out in tab 1, no state of account 1 is left in the browser', !owners.includes('u:1'), owners)
      check("two tabs: tab 2's widget did not reach account 1", Object.keys(await serverWidgets()).length === serverBefore)
      await p2.waitFor(`document.querySelector('.desktop') && !document.querySelector('[class^="boot"], [class*=" boot"]')`, 90_000)
      await sleep(2500)
      check('two tabs: tab 2 started again as a visitor, without the account’s widgets', (await count(p2)) <= 1)
      check('two tabs: no page errors', p1.errors.length === 0 && p2.errors.length === 0, [...p1.errors, ...p2.errors])
    }

    // 7. Signed out: per browser, nothing reaches the account.
    const D = await browser(null)
    await load(D)
    const accountBefore = Object.keys(await serverWidgets()).length
    check('visitor: sees none of the account’s widgets', (await count(D)) === 0)
    await addWidget(D, 'Status')
    await pushed()
    const afterD = await serverWidgets()
    check("visitor: the widget stays in this browser, not the account's", Object.keys(afterD).length === accountBefore)
    await load(D)
    check('visitor: the widget is still there after a refresh (this browser)', (await count(D)) === 1)

    // 8. Local migration: a browser that kept widgets in its own synced layout (old release).
    const E = await browser(U2)
    await E.send('Page.navigate', { url: origin + '/api/me' })
    await sleep(500)
    await E.eval(`localStorage.setItem('mvlos.account', '2'); localStorage.setItem('mvlos.sync.windows:desktop', JSON.stringify({ value: [{ app: 'widget', x: 300, y: 200, w: 280, h: 220, minimized: false, maximized: false, props: { kind: 'status', id: 'localst1' } }], base: 0, dirty: true }))`)
    await load(E)
    check('local migration: the widget from this browser’s old layout shows', (await shown(E)).ids.includes('localst1'))
    await pushed()
    check('local migration: and reached the account', 'localst1' in (await serverWidgets(U2)))

    for (const [n, p] of [['A', A], ['B', B], ['D', D], ['E', E]] as const) check(`${n}: no page errors`, p.errors.length === 0, p.errors)
  }
  const D = await browser(null)
  await load(D)
  // A sticky entry can arrive well before its note. It must remain in the synced set,
  // hide its whole frame, and reappear when the independently synced note arrives.
  await D.eval(`import('/src/os/widgetPlaces.ts').then(m => m.placeWidgets([{ id: 'delayed-note', kind: 'sticky', x: 500, y: 200, w: 260, h: 240, vw: 1400, vh: 900 }]))`)
  await sleep(2200) // Longer than the removed 1.5 s auto-close timer.
  const delayedState = () => D.eval(`import('/src/os/widgetPlaces.ts').then(m => ({ present: !!m.widgetPlaces.get().places['delayed-note'], removed: m.widgetPlaces.get().removed }))`)
  check('delayed note: missing contents do not remove the widget', (await delayedState()).present)
  check('delayed note: no visible empty frame', await D.eval(`![...document.querySelectorAll('.window[data-app="widget"]')].some(e => e.getAttribute('aria-label') === 'Sticky note' && e.getBoundingClientRect().width > 0)`))
  const deliverNote = async (extra: Record<string, unknown> = {}) => {
    const note = { id: 'delayed-note', text: 'Arrived after widget', color: 'yellow', tilt: 0, created: Date.now(), updated: Date.now(), edited: Date.now(), ...extra }
    await D.eval(`(() => {
      const key = 'mvlos.visitor.sync.notes'
      const value = JSON.stringify({ value: [${JSON.stringify(note)}], base: 0, dirty: true })
      localStorage.setItem(key, value)
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }))
    })()`)
  }
  await deliverNote()
  await sleep(500)
  await D.waitFor(`!!document.querySelector('.sticky-text') && document.querySelector('.sticky-text').value === 'Arrived after widget'`, 10000)
  check('delayed note: arriving contents reveal the sticky', await D.eval(`document.querySelector('.sticky-text').closest('.window').getBoundingClientRect().width > 0`))
  await deliverNote({ purged: true })
  await sleep(300)
  check('delayed note: a known purge removes the widget entry', !(await delayedState()).present && (await delayedState()).removed.includes('delayed-note'))

  // Legacy coordinates belong to an unknown original viewport: never scale or use a
  // phone-created widget's default position when displaying them on a desktop.
  await D.eval(`import('/src/os/widgetPlaces.ts').then(m => m.placeWidgets([{ id: 'unknown-screen', kind: 'status', x: 700, y: 250, w: 280, h: 220, vw: 390, vh: 800, screenUnknown: true }]))`)
  await sleep(300)
  check('migration: unknown-screen position is displayed as stored', await D.eval(`[...document.querySelectorAll('.window[data-app="widget"]')].some(e => Math.abs(parseFloat(e.style.left) - 700) < 2 && Math.abs(parseFloat(e.style.top) - 250) < 2)`))


} catch (e) {
  failed++
  console.log('FAIL (threw)', (e as Error).message)
} finally {
  for (const b of browsers) await b.close()
  vite.kill()
  await sleep(300)
  rmSync(data, { recursive: true, force: true })
}
console.log(failed ? `FAILED: ${failed}` : 'all passed')
process.exit(failed ? 1 : 0)
