// Widget layout regressions. Muted, isolated Chromium profiles and synthetic scratch account.
// pnpm check:widget-layout (PORT overrides the isolated dev server port).
import { isDeepStrictEqual } from 'node:util'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5288)
const data = mkdtempSync('/tmp/mvlos-widget-layout-')
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
const login = 'ui-scale-check'
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
const pages: P[] = []
async function browser(signedIn: string | null, w = 1400, h = 900): Promise<P> {
  const b = await launch(w, h)
  browsers.push(b)
  const page = await newPage(b, w, h, COUNT_PUTS)
  if (signedIn) for (const [name, value] of [['mvlos_sid', signedIn], ['mvlos_login', login], ['mvlos_uid', '1']]) await page.send('Network.setCookie', { name, value, url: origin })
  pages.push(page)
  return page
}
async function load(page: P) {
  await page.send('Page.navigate', { url: origin + '/' })
  await page.waitFor(`!!document.querySelector('.desktop') && !document.querySelector('[class^="boot"], [class*=" boot"]')`, 90_000)
  await page.waitFor(`!document.querySelector('.boot')`, 30_000)
  await sleep(2500)
}
const api = async (key: string, value?: unknown) => {
  const state = await fetch(origin + '/api/state', { headers: { Cookie: `mvlos_sid=${sid2}`, 'X-MvL-Account': '1' } }).then(async r => { if (!r.ok) throw new Error('state read: ' + r.status); return r.json() })
  if (key === 'widgets:placed' && state['widgets:state:v2']?.value?.schema === 2) {
    const envelope = state['widgets:state:v2'].value
    if (value === undefined) return envelope.placements
    key = 'widgets:state:v2'; value = { ...envelope, placements: value }
  }
  if (value === undefined) return state[key]?.value
  const response = await fetch(origin + '/api/state/' + key, { method: 'PUT', headers: { Cookie: `mvlos_sid=${sid2}`, Origin: origin, 'Content-Type': 'application/json', 'X-MvL-Account': '1' }, body: JSON.stringify({ value, base: state[key]?.updatedAt ?? 0 }) })
  if (!response.ok) throw new Error(`seed ${key}: ${response.status} ${await response.text()}`)
}
const widgets = (p: P) => p.eval<{ pid: number; x: number; y: number; w: number; h: number }[]>(`[...document.querySelectorAll('.window[data-app="widget"]')].map(e => { const r = e.getBoundingClientRect(); return { pid: Number(e.dataset.pid), x: r.x, y: r.y, w: r.width, h: r.height } })`)
async function resize(p: P, width: number, height: number) {
  await p.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(600)
}
async function scale(p: P, value: number) {
  await p.eval(`import('/src/os/uiScale.ts').then(m => m.uiScalePref.set(${value}))`)
  await sleep(600)
}
async function instrument(p: P) {
  await p.eval(`(async () => {
    window.__saves = { widgets: 0, windows: 0 }
    for (const [name, store] of [['widgets', (await import('/src/os/widgetPlaces.ts')).widgetPlaces], ['windows', (await import('/src/os/wm.tsx')).layoutStore()]]) {
      const original = store.set
      store.set = (...args) => { window.__saves[name]++; return original(...args) }
    }
    window.__puts = {}
  })()`)
}
async function quiet(p: P, label: string) {
  await sleep(1500)
  const r = await p.eval<{ saves: { widgets: number; windows: number }; puts: Record<string, number> }>(`({ saves: window.__saves, puts: window.__puts })`)
  check(label + ': zero store saves and sync PUTs', r.saves.widgets === 0 && r.saves.windows === 0 && !r.puts['widgets:state:v2'] && !r.puts['windows:desktop'], r)
}
async function drag(p: P, pid: number, dx: number, dy: number, edge = false) {
  const at = await p.eval<{ x: number; y: number }>(`(() => {
    const e = document.querySelector('[data-pid="${pid}"] ${edge ? '.rz-e' : '.note-grip'}')
    const r = e.getBoundingClientRect()
    const hit = (x, y) => { const target = document.elementFromPoint(x, y); return target === e || e.contains(target) }
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    if (hit(x, y)) return { x, y }
    // A rotated or short-screen handle can have its midpoint outside the viewport.
    // Use an actual exposed point of the handle, never a programmatic drag event.
    for (let y = Math.max(1, r.top + 1); y < Math.min(innerHeight - 1, r.bottom); y += 2)
      for (let x = Math.max(1, r.left + 1); x < Math.min(innerWidth - 1, r.right); x += 2)
        if (hit(x, y)) return { x, y }
    throw new Error('no exposed drag handle')
  })()`)
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 8; i++) {
    await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + dx * i / 8, y: at.y + dy * i / 8, button: 'left', buttons: 1 })
    await sleep(30)
  }
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x + dx, y: at.y + dy, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(1600)
}
try {
  if (!process.env.WIDGET_WIDE_ONLY) {
    const seeded = { places: {
      a: { id: 'a', kind: 'sticky', x: 120, y: 120, w: 280, h: 180, vw: 1200, vh: 800, phone: false, at: now },
      b: { id: 'b', kind: 'sticky', x: 600, y: 120, w: 280, h: 180, vw: 1200, vh: 800, phone: false, at: now },
    }, removed: '' }
    const notes = ['a', 'b'].map(id => ({ id, text: 'Synthetic widget ' + id + '\n' + 'Content line\n'.repeat(5), color: 'yellow', tilt: 0, created: now, updated: now }))
    await api('windows:desktop', []); await api('notes', notes); await api('widgets:placed', seeded)
    const phonePage = await browser(sid, 390, 844)
    await load(phonePage)
    // Stickies say phone:true, so a phone shows them (full width, in the column); widgets that do not say so stay unmounted (widget-clock-e2e).
    check('cold mobile load mounts the phone-compatible widgets in the column', (await widgets(phonePage)).length === 2 && (await widgets(phonePage)).every(w => w.x >= 0 && w.x + w.w <= 390))
    await resize(phonePage, 1200, 800)
    check('mobile-first session restores desktop widgets', (await widgets(phonePage)).length === 2)
    check('mobile-first session preserves placements', isDeepStrictEqual(await api('widgets:placed'), seeded))
    const A = await browser(sid, 1200, 800)
    await load(A)
    const rects = () => A.eval(`[...document.querySelectorAll('[data-app="widget"]')].map(e => ({x: parseFloat(e.style.left), y: parseFloat(e.style.top), w: parseFloat(e.style.width), z: +e.style.zIndex, pid: +e.dataset.pid}))`)
    const before = await rects()
    check('intentional duplicate kind retains both instances', before.length === 2)
    await drag(A, before[1].pid, -450, 30)
    const moved = await rects()
    check('drag permits overlap without moving neighbour', moved[0].x === before[0].x && moved[0].y === before[0].y && moved[1].x === 150 && moved[1].y === 150 && moved[1].z > moved[0].z, moved)
    await drag(A, moved[1].pid, 100, 0, true)
    const resized = await rects()
    check('resize keeps origin and neighbour fixed', resized[1].x === moved[1].x && resized[1].y === moved[1].y && resized[1].w === 380 && resized[0].x === before[0].x && resized[0].y === before[0].y, resized)
    await drag(A, resized[1].pid, -180, 0, true)
    check('widget can resize below app-window minimum without jumping', (await rects())[1].w === 200 && (await rects())[1].x === resized[1].x)
    await drag(A, resized[1].pid, 180, 0, true)
    const saved = await api('widgets:placed')
    await instrument(A)
    await resize(A, 740, 500); await scale(A, 1.5)
    await quiet(A, 'shrink and zoom')
    await scale(A, 1); await resize(A, 1200, 800)
    check('grow restores preferred geometry', isDeepStrictEqual(await rects(), resized))
    await resize(A, 390, 844)
    check('mobile shows the phone-compatible stickies within the column', (await widgets(A)).length === 2 && (await widgets(A)).every(w => w.x >= 0 && w.x + w.w <= 390))
    await quiet(A, 'mobile')
    await resize(A, 1200, 800)
    check('desktop restores same instances and geometry', isDeepStrictEqual(await rects(), resized), await rects())
    check('mobile never changes saved desktop geometry', isDeepStrictEqual(saved, await api('widgets:placed')))
    // Content growth should scroll in place, including content taller than the whole viewport.
    await api('notes', notes.map(n => ({...n, text: n.text + 'More content\n'.repeat(100), updated: now + 1000, edited: now + 1000})))
    await A.eval(`import('/src/os/synced.ts').then(m => m.pullAll())`)
    await sleep(800)
    check('content growth leaves every origin fixed', isDeepStrictEqual(await rects(), resized))
    check('long content remains scrollable', await A.eval(`[...document.querySelectorAll('.widget .window-body')].every(e => e.scrollHeight > e.clientHeight && e.getBoundingClientRect().bottom < innerHeight)`))
    await quiet(A, 'content growth')
    // Native touch cancellation releases capture and dragging state on nonmobile touch devices.
    await A.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 1})
    const pt = await A.eval(`(() => {const r=document.querySelectorAll('.widget .note-grip')[1].getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+10}})()`)
    await A.send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[pt]})
    await A.send('Input.dispatchTouchEvent', {type:'touchMove', touchPoints:[{x:pt.x+20,y:pt.y+20}]})
    await A.send('Input.dispatchTouchEvent', {type:'touchCancel', touchPoints:[]})
    await sleep(500)
    check('touch cancellation clears dragging state', await A.eval(`!document.body.classList.contains('is-dragging') && !document.body.classList.contains('is-resizing')`))
    const afterTouch = await rects()
    check('touch moves only active widget', afterTouch[0].x === resized[0].x && afterTouch[0].y === resized[0].y && afterTouch[1].x > resized[1].x)
    await A.eval(`document.querySelectorAll('.ws[data-ws]')[1].click()`)
    await sleep(300)
    check('widgets retain geometry across workspaces', isDeepStrictEqual(await rects(), afterTouch))
    const off = structuredClone(saved); off.places.a.x = 9000; off.places.a.y = -9000; off.places.a.at += 10000
    await api('widgets:placed', off)
    await A.eval(`import('/src/os/synced.ts').then(m => m.pullAll())`)
    await sleep(600)
    const recovered = await rects()
    check('offscreen saved grip recovered independently', recovered[0].x + recovered[0].w <= 1200 && recovered[0].y >= 48 && recovered[1].x === afterTouch[1].x, recovered)
    check('recovery leaves saved preference intact', (await api('widgets:placed')).places.a.x === 9000)
  }
  // A very wide rotated grip used to cross the top bar even though its unrotated y was 48.
  for (const b of browsers.splice(0)) await b.close()
  const W = await browser(sid, 1600, 900)
  await api('windows:desktop', [])
  await load(W)
  await W.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await scale(W, 1); await resize(W, 1600, 900)
  const wide = { places: { wide: { id: 'wide', kind: 'sticky', x: 24, y: 48, w: 1552, h: 180, vw: 1600, vh: 900, phone: false, at: now + 20000 } }, removed: '' }
  const wideNote = { id: 'wide', text: 'Synthetic wide card', color: 'yellow', tilt: -4.5, created: now, updated: now + 20000, edited: now + 20000 }
  const earlier = await api('widgets:placed')
  wide.removed = [earlier?.removed, ...Object.keys(earlier?.places ?? {})].filter(Boolean).join(' ')
  await api('widgets:placed', wide)
  for (const tilt of [-4.5, 4.5]) {
    await api('notes', [{ ...wideNote, tilt, updated: now + 30000 + tilt }])
    await load(W)
    const reachable = async (label: string) => {
      // Bring the tested widget forward and dismiss unrelated startup notices before hit testing.
      await W.eval(`(() => {
        document.querySelector('.widget-sticky').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        document.querySelectorAll('.notice-close').forEach(e => e.click())
      })()`)
      await sleep(400)
      const result = await W.eval(`(() => {
        const widget = document.querySelector('.widget-sticky'), button = widget.querySelector('.note-close')
        const r = button.getBoundingClientRect(), top = document.querySelector('.topbar').getBoundingClientRect().bottom
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        const grip = widget.querySelector('.note-grip').getBoundingClientRect()
        return { tilt: widget.style.getPropertyValue('--widget-tilt'), hitClass: hit?.className, top, y: r.y, bottom: r.bottom, right: r.right, x: r.x, hit: hit === button || button.contains(hit), gripTop: grip.top, gripBottom: grip.bottom, gripLeft: grip.left, gripRight: grip.right, viewportWidth: innerWidth, viewportHeight: innerHeight,
          ok: r.y >= top && r.bottom <= innerHeight && r.x >= 0 && r.right <= innerWidth && (hit === button || button.contains(hit)) }
      })()`)
      check('wide tilt ' + tilt + ': ' + label + ' close reachable', result.ok && result.tilt === `${tilt}deg` && result.gripTop >= result.top && result.gripBottom <= result.viewportHeight && result.gripLeft >= 0 && result.gripRight <= result.viewportWidth, result)
    }
    await reachable('load')
    const baseline = await api('widgets:placed')
    await resize(W, 1000, 650); await reachable('viewport shrink')
    await scale(W, 1.5); await reachable('150% scale')
    await load(W); await reachable('scaled reload')
    await scale(W, 1); await resize(W, 1600, 900); await reachable('grow')
    check('wide tilt ' + tilt + ': fitting preserves preferred geometry', isDeepStrictEqual(await api('widgets:placed'), baseline))
    // Start smaller near the top, then grow the east edge: it needs fresh rotation clearance.
    const narrow = structuredClone(wide); narrow.places.wide.w = 300; narrow.places.wide.at = Math.max(Date.now(), (await api('widgets:placed')).places.wide.at) + 1000
    await api('widgets:placed', narrow); await load(W)
    await reachable('narrow before resize')
    check('wide test starts resize at 300 px', await W.eval(`parseFloat(document.querySelector('.widget-sticky').style.width)`) === 300)
    const pid = (await widgets(W))[0].pid
    await drag(W, pid, 900, 0, true)
    await reachable('east resize')
    await load(W); await reachable('resized reload')
    // Full rotated grip and close control must fit at every edge, not just the top.
    for (const [vw, vh, uiScale] of [[3840, 2160, 1], [3840, 2160, 2], [3840, 200, 1], [3840, 200, 2]]) {
      await scale(W, uiScale); await resize(W, vw, vh)
      for (const [edge, x, y] of [['top-left', -500, -500], ['top-right', 5000, -500], ['bottom-left', 24, vh / uiScale - 140], ['bottom-right', 5000, 5000]] as const) {
        const at = Math.max(Date.now(), (await api('widgets:placed')).places.wide.at) + 1000
        const edgeSet = { ...wide, places: { wide: { ...wide.places.wide, x, y, w: 3792, vw: vw / uiScale, vh: vh / uiScale, at } } }
        await api('widgets:placed', edgeSet); await load(W)
        await reachable(`${vw}x${vh} scale ${uiScale} ${edge}`)
        check('edge fitting preserves preferred geometry', isDeepStrictEqual((await api('widgets:placed')).places.wide, edgeSet.places.wide))
      }
      // Widen from the bottom edge, exercising the same constraints during pointer resize.
      const at = Math.max(Date.now(), (await api('widgets:placed')).places.wide.at) + 1000
      const edgeSet = { ...wide, places: { wide: { ...wide.places.wide, x: 24, y: vh / uiScale - 140, w: 200, vw: vw / uiScale, vh: vh / uiScale, at } } }
      await api('widgets:placed', edgeSet); await load(W)
      await reachable('bottom before widening')
      await drag(W, (await widgets(W))[0].pid, 3000, 0, true)
      await reachable('bottom after widening')
      await load(W); await reachable('bottom widened reload')
    }
    await scale(W, 1); await resize(W, 1600, 900)
    wide.places.wide.at = Math.max(Date.now(), (await api('widgets:placed')).places.wide.at) + 1000
    await api('widgets:placed', wide)
  }
} catch (error) {
  failed++; console.error(error)
  console.log('Layout failure state',await pages.at(-1)?.eval(`(async()=>({places:(await import('/src/os/widgetPlaces.ts')).widgetPlaces.get(),notes:(await import('/src/data/notes.ts')).allNotes(),hidden:(await import('/src/os/deskPrefs.ts')).notesHidden.get(),body:document.body.textContent.slice(-1500)}))()`).catch(()=>null))
} finally {
  for (const b of browsers) await b.close()
  vite.kill()
  rmSync(data, { recursive: true, force: true })
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
