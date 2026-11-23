// The Agents page as an app of its own (public/agents.webmanifest) and its share target
// (pwa/sw.js receiveShare, src/apps/agentsPage/share.ts), against the real server on the built site
// (dist/, `pnpm build` first) with a scratch DATA_DIR and account:
//
// 1. Over HTTP: /agents links agents.webmanifest and its icons, / still links MvL OS's; both
//    manifests are valid JSON with the right type, every icon answers 200; a share POSTed straight
//    to the server (no service worker) is a 303 to /agents?share=missed and keeps nothing.
// 2. In headless Chromium (muted, isolated profile): both MvL OS and the Agents page are
//    installable with their own manifests; a share (title, text, link and a picture) submitted
//    through the service worker opens a new chat with the message box filled and the picture
//    attached, and nothing sent; the share is single-use; a share older than an hour is dropped;
//    signed out, the sign-in screen says a share waits, and signing in afterwards picks it up.
//
// pnpm check:agents-pwa (PORT overrides the server's port; SHOTS=<dir> keeps screenshots, never in the repo).
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const PORT = Number(process.env.PORT ?? 5266)
const SHOTS = process.env.SHOTS
const origin = `http://127.0.0.1:${PORT}`
if (!existsSync(join(ROOT, 'dist/sw.js'))) throw new Error('Run pnpm build first')
const data = mkdtempSync('/tmp/mvlos-agents-pwa-')
process.env.DATA_DIR = data
const { database, encrypt, sha256 } = await import(`${ROOT}/server/db.ts`)
const { launch, newPage, sleep } = await import(`${ROOT}/scripts/perf/cdp.ts`)
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let failed = 0
const check = (what: string, ok: boolean, extra?: unknown) => {
  console.log(ok ? 'PASS' : 'FAIL', what, ok || extra === undefined ? '' : JSON.stringify(extra))
  if (!ok) failed++
}

// A scratch account with a session.
const now = Date.now()
const sid = randomBytes(24).toString('hex')
const login = 'agents-pwa-check'
const db = database()
db.prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, login, encrypt('none'), now, now)
db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), 1, now, now + 86400_000)
// An Ollama key (never used: nothing is sent), so the composer shows rather than the setup screen.
db.prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?)').run(1, 'ollama', encrypt('none'), now)
const threads = () => (db.prepare('SELECT count(*) AS n FROM agent_threads WHERE user_id = 1').get() as { n: number }).n

const server = spawn(process.execPath, [join(ROOT, 'server/index.ts')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: data, NODE_ENV: 'test', GITHUB_CLIENT_ID: 'check', GITHUB_CLIENT_SECRET: 'check' }, stdio: ['ignore', 'ignore', 'pipe'] })
let serverErr = ''
server.stderr!.on('data', (d) => (serverErr += d))
const stop = () => {
  server.kill()
  rmSync(data, { recursive: true, force: true })
}
process.on('exit', stop)
for (let i = 0; i < 100; i++) {
  if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) break
  await sleep(100)
}

// ---- 1. Over HTTP ----
const page = async (path: string) => (await fetch(origin + path)).text()
const agentsHtml = await page('/agents')
const osHtml = await page('/')
check('/agents links agents.webmanifest', agentsHtml.includes('href="/agents.webmanifest"') && !agentsHtml.includes('/manifest.webmanifest'))
check('/agents/<thread> links agents.webmanifest', (await page('/agents/settings/models')).includes('href="/agents.webmanifest"'))
check('/agents has the Agents home-screen name and icon', agentsHtml.includes('apple-mobile-web-app-title" content="Agents"') && agentsHtml.includes('/icons/agents-apple-touch-icon.png'))
check('/ links manifest.webmanifest', osHtml.includes('href="/manifest.webmanifest"') && !osHtml.includes('agents.webmanifest'))
check('/cv and /play still link MvL OS', (await page('/cv')).includes('href="/manifest.webmanifest"') && (await page('/play')).includes('href="/manifest.webmanifest"'))
const icons: string[] = []
for (const m of ['/manifest.webmanifest', '/agents.webmanifest']) {
  const res = await fetch(origin + m)
  let json: any = null
  try {
    json = await res.json()
  } catch {}
  check(`${m}: 200, application/manifest+json, valid JSON`, res.status === 200 && res.headers.get('content-type') === 'application/manifest+json' && !!json, { status: res.status, type: res.headers.get('content-type') })
  for (const i of [...(json?.icons ?? []), ...(json?.shortcuts ?? []).flatMap((s: any) => s.icons ?? [])]) icons.push(i.src)
}
const agentsManifest = JSON.parse(readFileSync(join(ROOT, 'dist/agents.webmanifest'), 'utf8'))
check('agents manifest: id, start_url, scope, share_target', agentsManifest.id === '/agents' && agentsManifest.start_url === '/agents' && agentsManifest.scope === '/agents' && agentsManifest.share_target?.action === '/agents/share' && agentsManifest.share_target.method === 'POST')
const iconStatus = await Promise.all([...new Set([...icons, '/icons/agents-apple-touch-icon.png'])].map(async (src) => [src, (await fetch(origin + src)).status] as const))
check('every icon answers 200', iconStatus.every(([, s]) => s === 200), iconStatus)
{
  const form = new FormData()
  form.set('text', 'straight to the server')
  form.set('files', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'x.png')
  const res = await fetch(`${origin}/agents/share`, { method: 'POST', body: form, redirect: 'manual', headers: { Cookie: `mvlos_sid=${sid}` } })
  check('share POST to the server: 303 to /agents?share=missed, nothing kept', res.status === 303 && res.headers.get('location') === '/agents?share=missed' && threads() === 0, { status: res.status, location: res.headers.get('location') })
}

// ---- 2. In Chromium ----
const PNG = readFileSync(join(ROOT, 'public/icons/agents-192.png')).toString('base64')
const b = await launch(412, 860)
type Opened = Awaited<ReturnType<typeof newPage>>
const shot = async (p: Opened, name: string) => {
  if (!SHOTS) return
  const { data: png } = await p.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(png, 'base64'))
}
const goto = async (p: Opened, path: string) => {
  await p.send('Page.navigate', { url: origin + path })
  await sleep(300)
  await p.waitFor('document.readyState === "complete"', 30_000)
}
const signIn = async (p: Opened) => {
  for (const [name, value] of [['mvlos_sid', sid], ['mvlos_login', login], ['mvlos_uid', '1']]) await p.send('Network.setCookie', { name, value, url: origin })
}
// A share as the share sheet sends one: a multipart POST navigation to /agents/share, taken by the worker.
const share = (p: Opened, withFile = true) =>
  p.eval(`(() => {
    const f = document.createElement('form')
    f.method = 'POST'; f.action = '/agents/share'; f.enctype = 'multipart/form-data'
    for (const [k, v] of [['title', 'A shared page'], ['text', 'Look at this, what do you think?'], ['url', 'https://example.org/article']]) {
      const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.append(i)
    }
    if (${withFile}) {
      const bytes = Uint8Array.from(atob(${JSON.stringify(PNG)}), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'shared-picture.png', { type: 'image/png' }))
      const i = document.createElement('input'); i.type = 'file'; i.name = 'files'; i.files = dt.files; f.append(i)
    }
    document.body.append(f); f.submit(); return true
  })()`)
const composer = `document.querySelector('.agp-root textarea:not([aria-label])')?.value ?? document.querySelector('.agp-root form textarea')?.value`
let lastPage: Opened | null = null
const MUTE = `try { localStorage.setItem('mvlos.sound', 'off') } catch {}`

try {
  const p = await newPage(b, 412, 860, MUTE)
  lastPage = p
  await p.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 2, mobile: true })
  await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

  // MvL OS installable.
  await goto(p, '/')
  await p.eval('navigator.serviceWorker.ready.then(() => true)')
  const osInstall = await p.send('Page.getInstallabilityErrors')
  const osManifest = await p.send('Page.getAppManifest')
  check('MvL OS installable', osInstall.installabilityErrors.length === 0 && osManifest.url.endsWith('/manifest.webmanifest') && osManifest.errors.length === 0, { osInstall, errors: osManifest.errors })

  // Agents installable, signed out: the sign-in screen.
  await goto(p, '/agents')
  await p.eval('navigator.serviceWorker.ready.then(() => true)')
  await p.waitFor(`!!navigator.serviceWorker.controller`, 15_000)
  const agInstall = await p.send('Page.getInstallabilityErrors')
  const agManifest = await p.send('Page.getAppManifest')
  check('Agents installable with its own manifest', agInstall.installabilityErrors.length === 0 && agManifest.url.endsWith('/agents.webmanifest') && agManifest.errors.length === 0, { agInstall, errors: agManifest.errors, url: agManifest.url })
  const appId = await p.send('Page.getAppId')
  check('Agents app id is /agents, not MvL OS', appId.appId === `${origin}/agents`, appId)

  // Signed out: share through the worker, the sign-in screen says it waits.
  await share(p)
  await p.waitFor(`location.search === '?share=1' && !!document.querySelector('.agp-signin-share')`, 20_000)
  check('signed out: the sign-in screen says the share waits', true)
  await shot(p, 'signed-out-share')

  // Signing in picks it up: a new chat, filled, the picture attached, nothing sent.
  await signIn(p)
  await goto(p, '/agents?auth=ok')
  await p.waitFor(`(${composer} ?? '').includes('example.org')`, 20_000)
  const text = await p.eval<string>(composer)
  check('composer filled with title, text and link (each once)', text === 'A shared page\n\nLook at this, what do you think?\n\nhttps://example.org/article', text)
  await p.waitFor(`[...document.querySelectorAll('.agp-root img')].some((i) => i.src.startsWith('data:image/png'))`, 10_000)
  check('the shared picture is attached', true)
  check('address is /agents', (await p.eval<string>('location.pathname + location.search')) === '/agents')
  await sleep(1500)
  check('nothing was sent', threads() === 0, threads())
  check('share cache dropped (single use)', !(await p.eval<boolean>(`caches.has('mvlos-share')`)))
  await shot(p, 'shared-composer')

  // Signed in from the start: a share opens straight into the composer, after the unsent draft.
  await goto(p, '/agents/tasks')
  await share(p, false)
  await p.waitFor(`location.pathname === '/agents' && (${composer} ?? '').split('example.org').length > 2`, 20_000)
  check('signed in: a share from another place opens a new chat, added to the waiting draft', true)

  // Expired: a share older than an hour is dropped, not used.
  await p.eval(`(async () => {
    const c = await caches.open('mvlos-share')
    await c.put('/__share/meta', new Response(JSON.stringify({ at: Date.now() - 2 * 3600_000, title: '', text: 'EXPIRED-SHARE', url: '', files: [], left: [] })))
  })()`)
  await goto(p, '/agents')
  await p.waitFor(`!!document.querySelector('.agp-root textarea')`, 20_000)
  await sleep(500)
  check('an expired share is dropped', !(await p.eval<string>(composer)).includes('EXPIRED-SHARE') && !(await p.eval<boolean>(`caches.has('mvlos-share')`)))

  // The server's fallback message.
  await goto(p, '/agents?share=missed')
  await p.waitFor(`document.body.innerText.includes('The share did not arrive')`, 10_000)
  check('?share=missed says the share did not arrive', true)
  await shot(p, 'share-missed')
  check('no page errors', p.errors.length === 0, p.errors)
} catch (e) {
  failed++
  console.error('FAIL', (e as Error).message)
  if (lastPage) {
    await shot(lastPage, 'failure')
    console.error('at', await lastPage.eval('location.href + " | " + document.body.innerText.slice(0, 400)').catch(() => '?'), lastPage.errors)
  }
} finally {
  await b.close()
}
if (serverErr.trim()) console.log('server stderr:', serverErr.trim().slice(-800))
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
