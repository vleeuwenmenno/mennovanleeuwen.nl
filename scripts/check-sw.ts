// The service worker and how the server sends the built files (pwa/sw.js, the mvlos-sw and
// mvlos-precompress plugins in vite.config.ts, server/index.ts):
//
// 1. dist/sw.js precaches /, the main script and CSS and the games (Gladiator, Empires At War),
//    but not pdf.js.
// 2. The real server (node server/index.ts, scratch DATA_DIR) sends Brotli or gzip copies by
//    Accept-Encoding q values, the raw file without one and for Range requests, with the right headers.
// 3. In headless Chromium, through a proxy that counts the bytes the server sends: a cold first
//    load and the worker installing, then with the server gone: the desktop boots and a game opens.
//    A game whose code is missing from the caches shows its error in its window (no white page),
//    and opens once back online.
//
// Uses dist/ when it is there (run `pnpm build` first for a fresh one), builds otherwise.
// SW_CHECK_PORT (default 5283) is the server's port; the proxy uses the next one.
// SW_CHECK_FROM=<dir>[:<dir>...] (each with server/, src/ and a built dist/) also checks the
// upgrade from each: a visitor on that build gets this one. The new worker must take over,
// reuse the precached files that didn't change, download only those that did, and the desktop
// and a game must still open offline afterwards.
// SW_CHECK_MEASURE=1 only measures a cold first load (for comparing with an older build, from
// SW_CHECK_ROOT: a checkout with server/ and a built dist/).
import assert from 'node:assert/strict'
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { launch, newPage, sleep, type Page } from './perf/cdp.ts'

const ROOT = process.env.SW_CHECK_ROOT ?? join(import.meta.dirname, '..')
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.SW_CHECK_PORT || 5283)
const PROXY = PORT + 1
const MEASURE = process.env.SW_CHECK_MEASURE === '1'

if (!existsSync(join(DIST, 'sw.js'))) execSync('pnpm build', { cwd: ROOT, stdio: 'inherit' })

// Never leave the server running, even when the check itself crashes.
process.on('exit', () => server?.kill())

let failed = 0
const pass = (what: string) => console.log(`PASS ${what}`)
function check(what: string, f: () => void) {
  try {
    f()
    pass(what)
  } catch (e) {
    failed++
    console.error(`FAIL ${what}: ${(e as Error).message}`)
  }
}

// ---- 1. The precache list ----
const sw = readFileSync(join(DIST, 'sw.js'), 'utf8')
const html = readFileSync(join(DIST, 'index.html'), 'utf8')
const entry = /<script[^>]+src="([^"]+)"/.exec(html)?.[1]
const css = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/.exec(html)?.[1]
const GAME = /\/assets\/(EmpiresAtWar|Gladiator)-[^/]*\.(js|css)$/
let precache: string[] = []
if (!MEASURE) {
  precache = JSON.parse(/const PRECACHE = (\[.*?\])\n/.exec(sw)?.[1] ?? '[]')
  check('precache has /, the main script and the main CSS', () => {
    assert.ok(entry && css, 'index.html names its script and CSS')
    for (const f of ['/', entry!, css!]) assert.ok(precache.includes(f), `${f} missing`)
  })
  check('precache has both games (script and CSS) and every file it lists is built', () => {
    // Both games, script and CSS each.
    assert.ok(precache.filter((f) => GAME.test(f)).length >= 4, `game files: ${precache.filter((f) => GAME.test(f)).join(', ') || 'none'}`)
    for (const f of precache.filter((f) => f.startsWith('/assets/'))) assert.ok(existsSync(join(DIST, f)), `${f} listed but not built`)
  })
  check('precache leaves out pdf.js', () => assert.deepEqual(precache.filter((f) => /\/pdf[-.]/.test(f)), []))
}

// ---- 2. The server ----
const data = mkdtempSync(join(tmpdir(), 'mvlos-sw-check-'))
let server: ChildProcess | undefined
let proxy: ReturnType<typeof createServer> | undefined
const sockets = new Set<Socket>()
let sent = 0
/** The paths asked for through the proxy. */
const asked: string[] = []

type Got = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Got> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (d: Buffer) => parts.push(d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }))
    })
    r.on('error', reject)
    r.end()
  })
}

async function stopServer() {
  if (!server || server.exitCode !== null) return
  const gone = new Promise((r) => server!.once('exit', r))
  server.kill()
  await gone
}

async function startServer(root = ROOT) {
  // Something else answering on the port would be checked instead of this build.
  if (await get('/healthz').then(() => true, () => false)) throw new Error(`port ${PORT} is already in use (SW_CHECK_PORT picks another)`)
  server = spawn(process.execPath, [join(root, 'server/index.ts')], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: data, NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  server.stderr!.on('data', (d) => (err += d))
  for (let i = 0; i < 100; i++) {
    const ok = await get('/healthz').then((r) => r.status === 200, () => false)
    if (ok) return
    await sleep(100)
  }
  throw new Error(`server did not start:\n${err.slice(-2000)}`)
}

/** A TCP proxy in front of the server that counts every byte it sends back: the real transfer,
 * the worker's own downloads included. Closing it is the network going away. */
function startProxy() {
  proxy = createServer((client) => {
    sockets.add(client)
    const up = createConnection(PORT, '127.0.0.1')
    sockets.add(up)
    up.on('data', (d: Buffer) => (sent += d.length))
    client.on('data', (d: Buffer) => {
      for (const m of d.toString('latin1').matchAll(/^(?:GET|HEAD) (\S+) HTTP/gm)) asked.push(decodeURI(m[1]))
    })
    client.pipe(up).pipe(client)
    const end = () => (client.destroy(), up.destroy(), sockets.delete(client), sockets.delete(up))
    client.on('error', end).on('close', end)
    up.on('error', end).on('close', end)
  })
  return new Promise<void>((r, j) => proxy!.once('error', j).listen(PROXY, '127.0.0.1', r))
}
function stopProxy() {
  for (const s of sockets) s.destroy()
  return new Promise<void>((r) => proxy!.close(() => r()))
}

async function serverChecks() {
  const raw = readFileSync(join(DIST, entry!))
  const br = await get(entry!, { 'Accept-Encoding': 'br, gzip' })
  check('br for "br, gzip", same type, length and cache headers', () => {
    assert.equal(br.status, 200)
    assert.equal(br.headers['content-encoding'], 'br')
    assert.match(String(br.headers['content-type']), /^text\/javascript/)
    assert.equal(Number(br.headers['content-length']), br.body.length)
    assert.ok(br.body.length < raw.length / 2, 'compressed')
    assert.ok(brotliDecompressSync(br.body).equals(raw), 'decompresses to the file')
    assert.equal(br.headers['vary'], 'Accept-Encoding')
    assert.equal(br.headers['cache-control'], 'public, max-age=31536000, immutable')
    assert.equal(br.headers['x-content-type-options'], 'nosniff')
  })
  const gz = await get(entry!, { 'Accept-Encoding': 'gzip' })
  check('gzip for "gzip"', () => {
    assert.equal(gz.headers['content-encoding'], 'gzip')
    assert.ok(gunzipSync(gz.body).equals(raw))
    assert.equal(gz.headers['vary'], 'Accept-Encoding')
  })
  const pick = async (accept: string) => (await get(entry!, { 'Accept-Encoding': accept }, 'HEAD')).headers['content-encoding'] ?? 'raw'
  const cases: [string, string][] = [
    ['br;q=0, gzip;q=0.5', 'gzip'],
    ['gzip;q=1, br;q=0.1', 'gzip'],
    ['br;q=0.5, gzip;q=0.5', 'br'],
    ['gzip, br', 'br'],
    ['*', 'br'],
    ['*;q=0.2, gzip;q=0.8', 'gzip'],
    ['deflate', 'raw'],
    ['identity;q=0', 'raw'],
    ['gzip;q=0, br;q=0', 'raw'],
  ]
  for (const [accept, want] of cases) {
    const got = await pick(accept)
    check(`Accept-Encoding "${accept}": ${want}`, () => assert.equal(got, want))
  }
  const none = await get(entry!)
  check('raw without Accept-Encoding', () => {
    assert.equal(none.headers['content-encoding'], undefined)
    assert.ok(none.body.equals(raw))
    assert.equal(none.headers['vary'], 'Accept-Encoding')
  })
  const range = await get(entry!, { 'Accept-Encoding': 'br, gzip', Range: 'bytes=0-99' })
  check('raw for a Range request', () => {
    assert.equal(range.headers['content-encoding'], undefined)
    assert.ok(range.body.equals(raw))
  })
  const head = await get(entry!, { 'Accept-Encoding': 'br' }, 'HEAD')
  check('HEAD: compressed headers, no body', () => {
    assert.equal(head.headers['content-encoding'], 'br')
    assert.equal(Number(head.headers['content-length']), br.body.length)
    assert.equal(head.body.length, 0)
  })
  const page = await get('/', { 'Accept-Encoding': 'br, gzip' })
  check('/ is the page, compressed, no-cache', () => {
    assert.equal(page.headers['content-encoding'], 'br')
    assert.match(String(page.headers['content-type']), /^text\/html/)
    assert.ok(brotliDecompressSync(page.body).equals(readFileSync(join(DIST, 'index.html'))))
    assert.equal(page.headers['cache-control'], 'no-cache')
  })
  const worker = await get('/sw.js', { 'Accept-Encoding': 'gzip, deflate, br' })
  check('/sw.js compressed, no-cache', () => {
    assert.equal(worker.headers['content-encoding'], 'br')
    assert.ok(brotliDecompressSync(worker.body).equals(readFileSync(join(DIST, 'sw.js'))))
    assert.equal(worker.headers['cache-control'], 'no-cache')
  })
  const play = await get('/play/empires', { 'Accept-Encoding': 'gzip' })
  const playRaw = await get('/play/empires')
  check('/play/<game> page: its own title, compressed or not', () => {
    assert.equal(play.headers['content-encoding'], 'gzip')
    assert.ok(gunzipSync(play.body).equals(playRaw.body))
    assert.match(playRaw.body.toString(), /<title>Empires At War · MvL OS<\/title>/)
    assert.equal(Number(play.headers['content-length']), play.body.length)
    assert.equal(play.headers['vary'], 'Accept-Encoding')
  })
  const json = await get('/recents.json', { 'Accept-Encoding': 'br' })
  check('json: br, 5 minute cache', () => {
    assert.equal(json.headers['content-encoding'], 'br')
    assert.match(String(json.headers['content-type']), /^application\/json/)
    assert.equal(json.headers['cache-control'], 'public, max-age=300')
  })
  const png = await get('/icons/app-192.png', { 'Accept-Encoding': 'br, gzip' })
  check('png: as it is, no Vary', () => {
    assert.equal(png.headers['content-encoding'], undefined)
    assert.equal(png.headers['vary'], undefined)
    assert.ok(png.body.equals(readFileSync(join(DIST, 'icons/app-192.png'))))
  })
}

// ---- 3. The browser ----
const cached = (page: Page) =>
  page.eval<Record<string, string[]>>(`(async () => {
    const out = {}
    for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map((r) => decodeURI(new URL(r.url).pathname))
    return out
  })()`)

async function boot(page: Page) {
  await page.waitFor(`document.readyState === 'complete'`)
  // The boot screen skips with Esc.
  for (let i = 0; i < 60; i++) {
    if (await page.eval(`!!document.querySelector('.topbar') && !document.querySelector('.boot')`)) return
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(150)
  }
  await page.waitFor(`!!document.querySelector('.topbar') && !document.querySelector('.boot')`)
}

/** Until the counter stops moving: the worker's downloads go on after the page has loaded. */
async function settle() {
  let last = -1
  for (let i = 0; i < 60 && sent !== last; i++) {
    last = sent
    await sleep(500)
  }
}

async function browserChecks() {
  const origin = `http://127.0.0.1:${PROXY}`
  const browser = await launch(1280, 800)
  try {
    const page = await newPage(browser, 1280, 800, '')
    // What the page itself downloaded, as Chromium counts it (encoded bytes, without the worker's
    // own install downloads, which the proxy's count has).
    let pageBytes = 0
    browser.on((m) => m.method === 'Network.loadingFinished' && (pageBytes += Number((m.params as { encodedDataLength?: number }).encodedDataLength ?? 0)))
    await page.send('Network.enable')
    sent = 0
    await page.send('Page.navigate', { url: `${origin}/` })
    await boot(page)
    await page.waitFor(`(async () => (await caches.keys()).some((k) => k.startsWith('mvlos-shell-')) && !!(await navigator.serviceWorker.getRegistration())?.active)()`, 30_000)
    await settle()
    const cold = sent
    console.log(`cold first load, worker installed: ${(cold / 1024).toFixed(0)} KB sent by the server; the page's own requests (CDP encodedDataLength): ${(pageBytes / 1024).toFixed(0)} KB`)
    if (MEASURE) return
    check('desktop boots online without errors', () => assert.deepEqual(page.errors, []))

    const first = await cached(page)
    const shell = Object.keys(first).find((k) => k.startsWith('mvlos-shell-'))
    check('the worker installed with the whole precache, games included', () => {
      assert.ok(shell)
      for (const f of precache) assert.ok(first[shell!].includes(f), `${f} missing`)
    })

    // Offline: the page's network off, and the server gone. Gladiator was never opened online.
    await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
    await stopProxy()
    page.errors.length = 0
    await page.send('Page.navigate', { url: `${origin}/` })
    await boot(page)
    check('offline: the desktop boots', () => assert.ok(true))
    await page.send('Page.navigate', { url: `${origin}/play/gladiator` })
    await page.waitFor(`!!document.querySelector('.games-play [class*="gl-"]')`, 30_000)
    check('offline: Gladiator opens from the precache', () => assert.ok(true))

    // A game whose code isn't in the caches (cleared, or not saved yet) fails in its own window.
    await page.eval(`(async () => {
      for (const k of await caches.keys()) {
        const c = await caches.open(k)
        for (const r of await c.keys()) if (/EmpiresAtWar-/.test(r.url)) await c.delete(r)
      }
    })()`)
    // The install's downloads also sit in the browser's HTTP cache (immutable for a year).
    await page.send('Network.clearBrowserCache')
    await page.send('Page.navigate', { url: `${origin}/play/empires` })
    await page.waitFor(`!!document.querySelector('.games-play [role="alert"]')`, 30_000)
    const msg = await page.eval<string>(`document.querySelector('.games-play [role="alert"]').innerText`)
    check('offline: Empires At War, its code missing, says it can\'t load (no white page)', () => {
      assert.match(msg, /Empires At War couldn't load/)
      assert.match(msg, /offline/)
      assert.ok(msg.includes('Try again'))
    })

    // Back online: Try again (or, when the browser remembers the failed load, the Reload it then
    // offers) gets the game.
    await startProxy()
    await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await page.waitFor(`navigator.onLine`, 10_000)
    await page.clickText('.games-play [role="alert"] button', 'Try again')
    const recovered = `(async () => (await caches.open('mvlos-runtime').then((c) => c.keys())).some((r) => /EmpiresAtWar-[^/]*\\.js$/.test(r.url)) && !document.querySelector('.games-play [role="alert"]'))()`
    try {
      await page.waitFor(recovered, 20_000)
    } catch {
      const text = await page.eval<string>(`document.querySelector('.games-play [role="alert"]')?.innerText ?? ''`)
      console.log(`after Try again online: ${text.replace(/\s+/g, ' ').slice(0, 120)}`)
      await page.clickText('.games-play [role="alert"] button', 'Reload')
      await page.waitFor(recovered, 60_000)
    }
    check('back online, the game that could not load opens', () => assert.ok(true))
  } finally {
    await browser.close()
  }
}

async function upgradeCheck(from: string) {
  const origin = `http://127.0.0.1:${PROXY}`
  const oldSw = readFileSync(join(from, 'dist/sw.js'), 'utf8')
  const oldPrecache: string[] = JSON.parse(/const PRECACHE = (\[.*?\])\n/.exec(oldSw)?.[1] ?? '[]')
  await stopServer()
  await startServer(from)
  const browser = await launch(1280, 800)
  try {
    const page = await newPage(browser, 1280, 800, '')
    await page.send('Page.navigate', { url: `${origin}/` })
    await boot(page)
    await page.waitFor(`(async () => (await caches.keys()).some((k) => k.startsWith('mvlos-shell-')) && !!(await navigator.serviceWorker.getRegistration())?.active && !!navigator.serviceWorker.controller)()`, 30_000)
    await settle()
    const before = await cached(page)
    const oldShell = Object.keys(before).find((k) => k.startsWith('mvlos-shell-'))

    // The release: the new build behind the same address.
    await stopServer()
    await startServer()
    sent = 0
    asked.length = 0
    await page.eval(`navigator.serviceWorker.getRegistration().then((r) => r.update())`)
    await page.waitFor(`navigator.serviceWorker.getRegistration().then((r) => !!r.waiting)`, 60_000)
    const fetchedOnInstall = asked.filter((p) => p.startsWith('/assets/'))
    const installBytes = sent
    // As the update notification does.
    await page.eval(`navigator.serviceWorker.getRegistration().then((r) => r.waiting.postMessage('skip-waiting'))`)
    await page.waitFor(`(async () => { const k = await caches.keys(); return !k.includes(${JSON.stringify(oldShell)}) && k.some((x) => x.startsWith('mvlos-shell-')) })()`, 30_000)
    // The page reloads itself on the new worker (src/os/pwa.ts); then the desktop on it.
    await sleep(1000)
    await page.send('Page.navigate', { url: `${origin}/` })
    await boot(page)
    const after = await cached(page)
    const unchanged = precache.filter((f) => f.startsWith('/assets/') && oldPrecache.includes(f))
    const changed = precache.filter((f) => f.startsWith('/assets/') && !oldPrecache.includes(f))
    console.log(`upgrade: ${changed.length} precached files changed, ${unchanged.length} kept; the new worker's install downloaded ${(installBytes / 1024).toFixed(0)} KB`)
    check('upgrade: the new worker took over with the whole precache', () => {
      const shell = Object.keys(after).find((k) => k.startsWith('mvlos-shell-'))
      assert.ok(shell && shell !== oldShell)
      // Pages visited are kept there too (network first, the shell's cache): those may be extra.
      for (const f of precache) assert.ok(after[shell!].includes(f), `${f} missing`)
      assert.equal(Object.keys(after).filter((k) => k.startsWith('mvlos-shell-')).length, 1, 'old shell deleted')
    })
    check('upgrade: unchanged hashed files are reused, not downloaded again', () => {
      const again = fetchedOnInstall.filter((f) => unchanged.includes(f))
      assert.deepEqual(again, [])
      for (const f of changed) assert.ok(fetchedOnInstall.includes(f), `${f} not fetched`)
    })
    // Offline after the release: the desktop boots and a game opens, from the new shell.
    await page.send('Network.enable')
    await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
    await stopProxy()
    let booted = true
    await page.send('Page.navigate', { url: `${origin}/` })
    await boot(page).catch(() => (booted = false))
    check('upgrade, then offline: the desktop boots', () => assert.ok(booted))
    await page.send('Page.navigate', { url: `${origin}/play/gladiator` })
    let opened = true
    await page.waitFor(`!!document.querySelector('.games-play [class*="gl-"]')`, 30_000).catch(() => (opened = false))
    check('upgrade, then offline: Gladiator opens', () => assert.ok(opened))
  } finally {
    await browser.close()
  }
}

try {
  await startServer()
  if (!MEASURE) await serverChecks()
  await startProxy()
  await browserChecks()
  // One or more older builds, separated by ':'; each upgrade in a fresh browser.
  for (const from of MEASURE ? [] : (process.env.SW_CHECK_FROM ?? '').split(':').filter(Boolean)) {
    console.log(`-- upgrade from ${from}`)
    if (!proxy?.listening) await startProxy()
    await upgradeCheck(from)
  }
} catch (e) {
  failed++
  console.error('FAIL', e)
} finally {
  if (proxy?.listening) await stopProxy()
  await stopServer()
  rmSync(data, { recursive: true, force: true })
}
if (failed) {
  console.error(`${failed} failed`)
  process.exit(1)
}
console.log('all passed')
