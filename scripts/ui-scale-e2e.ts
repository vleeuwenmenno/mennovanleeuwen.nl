// Full-app scale and local widget-layout regressions. Muted, isolated Chromium profiles and scratch account.
// pnpm check:ui-scale (PORT overrides the isolated dev server port).
import { isDeepStrictEqual } from 'node:util'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5287)
const data = mkdtempSync('/tmp/mvlos-ui-scale-')
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
  if (value === undefined) return state[key]?.value
  const response = await fetch(origin + '/api/state/' + key, { method: 'PUT', headers: { Cookie: `mvlos_sid=${sid2}`, Origin: origin, 'Content-Type': 'application/json', 'X-MvL-Account': '1' }, body: JSON.stringify({ value, base: state[key]?.updatedAt ?? 0 }) })
  if (!response.ok) throw new Error(`seed ${key}: ${response.status} ${await response.text()}`)
}
const places = Object.fromEntries([100, 850, 1550].map((x, i) => [`scale${i}`, { id: `scale${i}`, kind: 'status', x, y: 140, w: 240, h: 180, vw: 1920, vh: 1080, phone: false, at: now }]))
const set = { places, removed: '' }
const widgets = (p: P) => p.eval<{ pid: number; x: number; y: number; w: number; h: number }[]>(`[...document.querySelectorAll('.window[data-app="widget"]')].map(e => { const r = e.getBoundingClientRect(); return { pid: Number(e.dataset.pid), x: r.x, y: r.y, w: r.width, h: r.height } })`)
const intersects = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
const nonoverlap = (items: Awaited<ReturnType<typeof widgets>>) => items.every((a, i) => items.every((b, j) => i === j || !intersects(a, b)))
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
  check(label + ': zero store saves and sync PUTs', r.saves.widgets === 0 && r.saves.windows === 0 && !r.puts['widgets:placed'] && !r.puts['windows:desktop'], r)
}
const clearCounts = (p: P) => p.eval(`(window.__saves = { widgets: 0, windows: 0 }, window.__puts = {}, 0)`)
async function drag(p: P, pid: number, dx: number, dy: number, edge = false) {
  const at = await p.eval<{ x: number; y: number }>(`(() => { const e = document.querySelector('[data-pid="${pid}"] ${edge ? '.rz-e' : '.note-grip'}'); const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; if (document.elementFromPoint(x, y)?.closest('.window') !== e.closest('.window')) throw new Error('drag grip covered'); return { x, y } })()`)
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
  await api('windows:desktop', [])
  await api('widgets:placed', set)
  const A = await browser(sid, 1920, 1080)
  const B = await browser(sid, 1920, 1080)
  await load(A); await load(B)
  await A.waitFor(`document.querySelectorAll('[data-app="widget"]').length === 3`)
  await B.waitFor(`document.querySelectorAll('[data-app="widget"]').length === 3`)
  await instrument(A); await instrument(B)
  const big = await widgets(B)
  check('large screen has separated widgets', nonoverlap(big), big)
  await resize(A, 900, 700)
  const small = await widgets(A)
  check('small screen retains all instances', small.length === 3, small)
  await quiet(A, 'viewport resize')
  await resize(A, 1280, 800)
  await scale(A, 2)
  check('200% remains a desktop', await A.eval(`!matchMedia('(max-width: 719px)').matches && document.querySelector('.workspaces') !== null`))
  const high = await widgets(A)
  check('high scale keeps widget grips and boxes on screen', high.every(r => r.x >= 0 && r.y >= 0 && r.x + r.w <= 1281 && r.y + r.h <= 801), high)
  check('high scale retains all instances', high.length === 3, high)
  await quiet(A, 'scale change')
  check('other device display unchanged', JSON.stringify(await widgets(B)) === JSON.stringify(big))
  await quiet(B, 'other device')
  check('canonical synced placement unchanged by fitting', JSON.stringify(await api('widgets:placed')) === JSON.stringify(set))
  await scale(A, 1); await resize(A, 1920, 1080)
  check('large screen layout restored exactly', JSON.stringify(await widgets(A)) === JSON.stringify(big), await widgets(A))

  // A remote move deliberately collides with a neighbour; showing it must not write back.
  const remote = structuredClone(set)
  remote.places.scale1.x = 130
  remote.places.scale1.at += 100
  await api('widgets:placed', remote)
  await A.eval(`import('/src/os/synced.ts').then(m => m.pullAll())`)
  await sleep(1000)
  check('remote overlap preserved', !nonoverlap(await widgets(A)))
  await quiet(A, 'remote update')
  await resize(A, 1280, 800); await scale(A, 2)
  const beforeDrag = await api('widgets:placed')
  const target = (await widgets(A))[2]
  await drag(A, target.pid, 24, 36)
  const afterDrag = await api('widgets:placed')
  const changed = Object.keys(afterDrag.places).filter(k => !isDeepStrictEqual(afterDrag.places[k], beforeDrag.places[k]))
  check('manual drag saves only the moved widget', changed.length === 1 && changed[0] === 'scale2', changed)
  check('high-scale desktop persists explicit screen class', afterDrag.places.scale2.phone === false && afterDrag.places.scale2.vw === 640, afterDrag.places.scale2)
  // Restoration of canonical high-scale geometry must not write fitted coordinates.
  await sleep(500)
  const moved = await widgets(A)
  await load(A)
  check('high-scale saved position survives reload', JSON.stringify({ ...(await widgets(A))[2], pid: 0 }) === JSON.stringify({ ...moved[2], pid: 0 }), { before: moved, after: await widgets(A) })
  await instrument(A); await quiet(A, 'high-scale reload')
  const fit = await A.eval(`import('/src/os/wm.tsx').then(m => ({ desktop: m.fitNote({ x: 100, y: 450, w: 240, h: 180 }, 640, 400, false), phone: m.fitNote({ x: 100, y: 450, w: 240, h: 180 }, 640, 400, true) }))`)
  check('note fitting uses actual phone state', fit.desktop.y + fit.desktop.h <= 400 && fit.phone.y === 450, fit)
  const classes = await A.eval(`import('/src/os/widgetPlaces.ts').then(m => {
    const p = { id: 'x', kind: 'status', x: 0, y: 0, w: 240, h: 180, vw: 640, vh: 400, at: 0 }
    return [m.placedOnPhone(p), m.placedOnPhone({ ...p, phone: false }), m.wins({ ...p, phone: false }, { ...p, vw: 700, phone: true }), m.normalizeSet({ places: { x: { ...p, phone: false } }, removed: '' }).places.x.phone]
  })`)
  check('legacy classification and desktop merge preference retained', JSON.stringify(classes) === '[true,false,true,false]', classes)

  // A real sticky's measured content is taller than its saved box; resizing persists only it.
  await scale(A, 1); await resize(A, 1920, 1080)
  const note = { id: 'scale-note', text: '# Tall note\n' + 'Line of test content.\n'.repeat(14), color: 'yellow', tilt: 4.5, created: now, updated: now }
  await api('notes', [note])
  const withNote = await api('widgets:placed')
  withNote.places['scale-note'] = { id: 'scale-note', kind: 'sticky', x: 1100, y: 140, w: 260, h: 100, vw: 1920, vh: 1080, phone: false, at: now + 200 }
  await api('widgets:placed', withNote)
  await A.eval(`import('/src/os/synced.ts').then(m => m.pullAll())`)
  await A.waitFor(`!!document.querySelector('.window.widget-sticky')`)
  await sleep(1000)
  check('tall slanted note displays its content', await A.eval(`document.querySelector('.window.widget-sticky').offsetHeight > 200`), await widgets(A))
  await quiet(A, 'remote note content and widget addition')
  const stickyPid = await A.eval<number>(`Number(document.querySelector('.window.widget-sticky').dataset.pid)`)
  const beforeResize = await api('widgets:placed')
  await drag(A, stickyPid, 40, 0, true)
  const afterResize = await api('widgets:placed')
  const resized = Object.keys(afterResize.places).filter(k => !isDeepStrictEqual(afterResize.places[k], beforeResize.places[k]))
  check('explicit resize saves only resized widget and its new width', resized.length === 1 && resized[0] === 'scale-note' && afterResize.places['scale-note'].w > beforeResize.places['scale-note'].w, resized)
  await clearCounts(A)
  await api('notes', [{ ...note, text: note.text + 'More text.\n'.repeat(8), updated: now + 500, edited: now + 500 }])
  await A.eval(`import('/src/os/synced.ts').then(m => m.pullAll())`)
  await quiet(A, 'remote content growth and refitting')
  await scale(A, 2)

  // Mobile hides widgets without modifying their stored desktop placements.
  await resize(A, 390, 844)
  const phone = await widgets(A)
  await sleep(500)
  check('phone hides every widget', phone.length === 0 && (await widgets(A)).length === 0)
  await quiet(A, 'phone resize and preference')

  // Actual React overlays, populated enough to reach their CSS viewport limits.
  await A.eval(`(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const { ModelPicker } = await import('/src/apps/AgentsModelPicker.tsx')
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    window.__overlay = root
    root.render(React.createElement(ModelPicker, { models: Array.from({ length: 40 }, (_, i) => ({ name: 'qwen-test-' + i, thinking: false, vision: false, contextLength: 32768 })), value: '', onPick() {}, onClose() {}, anchor: null }))
  })()`)
  await sleep(800)
  await A.waitFor(`!!document.querySelector('.amp.is-sheet')`, 5000)
  await sleep(400)
  const sheet = await A.eval(`['.amp.is-sheet', '.amp-search', '.amp-close'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return { selector: s, x: r.x, y: r.y, right: r.right, bottom: r.bottom } })`)
  check('model sheet search and close fit at 390×844, 200%', sheet.every(r => r.x >= -1 && r.y >= 0 && r.right <= 391 && r.bottom <= 845), sheet)
  await A.eval(`window.__overlay.unmount()`)
  await A.eval(`(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const { AgentsMaskEditor } = await import('/src/apps/AgentsMaskEditor.tsx')
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    window.__overlay = root
    root.render(React.createElement(AgentsMaskEditor, { sourceUrl: '/icons/app-192.png', sourceName: 'Test image', width: 192, height: 192, onApply() {}, onCancel() {} }))
  })()`)
  await A.waitFor(`!!document.querySelector('.agt-mask')`)
  await sleep(500)
  const mask = await A.eval(`(() => { const e = document.querySelector('.agt-mask'); const r = e.getBoundingClientRect(); e.scrollTop = e.scrollHeight; return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, scroll: e.scrollHeight > e.clientHeight, footer: e.querySelector('footer').getBoundingClientRect().bottom } })()`)
  check('mask dialog bounded, footer scrollable into view at 200%', mask.x >= 0 && mask.y >= 0 && mask.right <= 391 && mask.bottom <= 845 && mask.footer <= 845, mask)
  await A.eval(`window.__overlay.unmount()`)

  // Real Agents sidebar, with only the integration flag/models mocked; no provider request.
  await scale(A, 1.5); await resize(A, 1920, 1080)
  await A.eval(`(async () => {
    (await import('/src/os/account.ts')).getAccount().integrations.ollama = true
    const fetch = window.fetch
    window.fetch = (url, init) => String(url).includes('/api/agents/models') ? Promise.resolve(new Response('[]', { headers: { 'Content-Type': 'application/json' } })) : fetch(url, init)
    window.dispatchEvent(new CustomEvent('mvlos:open', { detail: 'agents' }))
  })()`)
  await A.waitFor(`!!document.querySelector('[data-app="agents"] .ctl-max')`)
  await A.clickText('[data-app="agents"] .ctl-max')
  await A.waitFor(`!!document.querySelector('.agt-resize')`)
  await sleep(600)
  const side = await A.eval(`(() => { const e = document.querySelector('.agt-resize'); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 30, width: Number(e.getAttribute('aria-valuenow')) } })()`)
  await A.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: side.x, y: side.y })
  await A.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: side.x, y: side.y, button: 'left', buttons: 1, clickCount: 1 })
  await A.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: side.x + 30, y: side.y, button: 'left', buttons: 1 })
  await A.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: side.x + 30, y: side.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(300)
  const width = await A.eval(`Number(document.querySelector('.agt-resize').getAttribute('aria-valuenow'))`)
  check('sidebar drag converts 30 screen pixels to 20 page pixels at 150%', Math.abs(width - side.width - 20) <= 5, { before: side.width, after: width })

  const C = await browser(null)
  await C.send('Page.addScriptToEvaluateOnNewDocument', { source: `delete Element.prototype.currentCSSZoom` })
  await load(C)
  const unsupported = await C.eval(`import('/src/os/uiScale.ts').then(m => { const e = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true, cancelable: true }); window.dispatchEvent(e); return { supported: m.uiScaleSupported(), prevented: e.defaultPrevented } })`)
  check('unsupported engine keeps native zoom shortcuts', !unsupported.supported && !unsupported.prevented, unsupported)

} catch (error) {
  failed++
  console.error(error)
  for (const p of pages) console.error(p.errors)
} finally {
  for (const b of browsers) await b.close()
  vite.kill()
  await sleep(300)
  database().close()
  rmSync(data, { recursive: true, force: true })
}
console.log(failed ? `FAILED: ${failed}` : 'All scale and local widget-layout checks passed')
process.exitCode = failed ? 1 : 0
