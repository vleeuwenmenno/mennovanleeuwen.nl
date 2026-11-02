// "Trust always" for custom widgets in the real app: `pnpm check:widget-trust-ui` (PORT overrides the dev server port).
//
// Browser files (one browser, user 1):
//   - the Workshop offers "Trust this widget" only for an eligible build in ~/.local/share/mvlos/widgets/<package id>,
//     with the exact-bytes / edit asks / revocable / canonical-folder copy; a synthetic click cannot trust;
//   - activated with trust: after a reload it runs with no session grant (Revoke trust in the toolbar, no Pause access);
//   - Revoke trust is immediate and survives a reload; Trust always from the banner works after observing it;
//   - one source byte edit is a new digest with no authority; a folder outside the canonical path, `..` paths and an
//     agent's activation (browserHost, activate --new path) never trust;
//   - removal revokes, and a stale copy of the old envelope cannot bring the trust back;
//   - live source: a bind mount over the folder, an in-place edit and a deleted folder each stop the widget at once
//     with no access; the first two run again once undone, a deletion revokes for good (same bytes back, reload);
//     a second browser of the same account (no source there) never runs it;
//   - same-size write under a rolled-back clock stops it; another tab of the same browser editing the same IndexedDB
//     store (same length and timestamp) stops it after A re-reads IndexedDB, and the exact bytes back restore the
//     existing grant only; a missed announcement is caught when the evidence runs out; a stalled re-read gives no
//     access while unresolved and times out.
// Seafile home (mock Seafile behind the real server, user 2, two browsers = two devices):
//   - trusted on device A, it runs on device B without asking;
//   - entries Seafile reports as anything but a plain file or folder (inside the folder or on an ancestor) and a
//     bind mount on the canonical path are refused;
//   - A trusts, B revokes, a stale A syncs: no resurrection; A re-trusts while B (stale) revokes concurrently:
//     blocked; after observing both revocations A trusts again and both devices run it;
//   - a read-only home mount and a link entry appearing stop it (no revocation); the folder deleted in Seafile: B loading
//     then never runs and revokes, A stops, and putting the folder back plus a stale account copy does not restore it;
//   - a visibility change drops evidence; with the wall clock set back and Seafile unreachable it still runs out;
//   - a slow gate after A's click while B revokes (and A receives it): no grant; a new click trusts again.
// Synthetic data, muted Chromium, scratch DATA_DIR. Exits 1 on any failure.
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MY_LIBRARY, putFile, startMockSeafile } from './mock-seafile.ts'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5282)
const TEMPLATE = `${WT}/src/widgets/packages/custom-template`
const data = mkdtempSync('/tmp/mvlos-widget-trust-')
process.env.DATA_DIR = data
const { database, encrypt, sha256 } = await import(`${WT}/server/db.ts`)
const { launch, newPage, sleep } = await import(`${WT}/scripts/perf/cdp.ts`)
type Page = Awaited<ReturnType<typeof newPage>>

let failed = 0
const check = (what: string, ok: boolean, extra?: unknown) => {
  console.log(ok ? 'PASS' : 'FAIL', what, ok || extra === undefined ? '' : JSON.stringify(extra))
  if (!ok) failed++
}

const mock = await startMockSeafile()
const now = Date.now()
const session = (user: number) => {
  const sid = randomBytes(24).toString('hex')
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), user, now, now + 86400_000)
  return sid
}
for (const [id, login] of [[1, 'trust-files'], [2, 'trust-seafile']] as const) database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, login, encrypt('none'), now, now)
const sid1 = session(1), sidA = session(2), sidB = session(2)
// User 2: Seafile linked, home on its library (both devices read the same synced fstab).
database().prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (2, ?, ?, ?)').run('seafile', encrypt(JSON.stringify({ url: mock.base, username: 'check@example.com', token: 'mock-token', name: 'Check', version: '12.0.0' })), now)
const FSTAB = `seafile /mnt/seafile seafile defaults 0 0\nUUID=${MY_LIBRARY} /home/menno seafile defaults 0 0\n`
database().prepare('INSERT INTO state (user_id, key, value, updated_at) VALUES (2, ?, ?, ?)').run('fstab', JSON.stringify(FSTAB), now)

const vite = spawn(`${WT}/node_modules/.bin/vite`, ['--port', String(PORT), '--strictPort'], {
  cwd: WT,
  env: { ...process.env, DATA_DIR: data, GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_GITHUB_IDS: '1,2', MC_WATCH: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const browsers: { close: () => Promise<void> }[] = []
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) process.on(sig, () => (vite.kill(), void mock.close(), process.exit(1)))
let log = ''
vite.stdout.on('data', (d) => (log += d))
vite.stderr.on('data', (d) => (log += d))
const origin = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 150 && !log.includes('ready') && vite.exitCode === null; i++) await sleep(200)
if (!log.includes('ready') || vite.exitCode !== null) throw new Error(`vite did not start:\n${log}`)

let browser1: Awaited<ReturnType<typeof launch>>
async function device(sid: string, login: string, uid: number): Promise<Page> {
  const b = await launch(1500, 1000)
  browsers.push(b)
  if (uid === 1 && !browser1) browser1 = b
  const p = await newPage(b, 1500, 1000, '')
  await p.send('Network.enable')
  for (const [name, value] of [['mvlos_sid', sid], ['mvlos_login', login], ['mvlos_uid', String(uid)]]) await p.send('Network.setCookie', { name, value, url: origin })
  return p
}
const boot = async (p: Page) => {
  await p.send('Page.bringToFront')
  await p.send('Page.navigate', { url: origin })
  try { await p.waitFor(`!!document.querySelector('.desktop') && !document.querySelector('.boot')`, 90_000) } catch (e) { throw new Error(`${(e as Error).message}\n  page: ${await p.eval(`location.href+' '+document.body?.innerText.slice(0,600)`).catch(() => '?')}\n  errors: ${p.errors.join(" | ")}\n  vite: ${log.slice(-1500)}`) }
  await p.eval(`import('/src/data/browserfs.ts').then(m=>m.browserFilesReady())`)
  await p.waitFor(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.widgetsHydrated())`, 30_000)
}
const M = {
  inst: `await import('/src/widgets/platform/installations.ts')`,
  src: `await import('/src/widgets/platform/sources.ts')`,
  state: `await import('/src/widgets/platform/canonicalState.ts')`,
}
const run = <T>(p: Page, body: string) => p.eval<T>(`(async()=>{const i=${M.inst},s=${M.src},c=${M.state};${body}})()`)
const pkg = '.widget-custom .wp-package'
const body = (p: Page) => p.eval<string>(`document.querySelector('${pkg}')?.textContent ?? ''`)
const tools = (p: Page) => p.eval<string[]>(`[...document.querySelectorAll('${pkg} .wp-tool')].map(b=>b.textContent.trim())`)
const runs = async (p: Page) => { try { await p.waitFor(`(()=>{const t=document.querySelector('${pkg}')?.textContent??'';return t.includes('all time')&&!t.includes('Allow this revision')})()`, 30_000) } catch (e) { throw new Error(`${(e as Error).message}\n  widget: ${await body(p)}\n  status: ${await p.eval(`(async()=>{const i=${M.inst};const r=Object.values(i.installations.get()).find(x=>x.kind==='custom');return r?JSON.stringify(i.trustStatus(r.instance,r.active)):'none'})()`).catch(() => '?')}`) } }
const asks = (p: Page) => p.waitFor(`(document.querySelector('${pkg}')?.textContent??'').includes('Allow this revision')`, 20_000)
const closeAll = (p: Page, app: string) => p.eval(`document.querySelectorAll('[data-app="${app}"] .ctl-close').forEach(e=>e.click())`)
const workshop = async (p: Page, props: Record<string, string>) => {
  await closeAll(p, 'widgetworkshop'); await sleep(200)
  await p.eval(`window.dispatchEvent(new CustomEvent('mvlos:open',{detail:{app:'widgetworkshop',props:${JSON.stringify({ kind: 'custom', ...props })}}}))`)
  await p.waitFor(`!!document.querySelector('.wp-workshop')`)
}
const wsButton = (p: Page, label: string) => p.eval(`(()=>{const b=[...document.querySelectorAll('.wp-workshop button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('Button unavailable: '+${JSON.stringify(label)});b.click()})()`)
const status = (p: Page) => p.eval<string>(`document.querySelector('.wp-workshop [role="status"]')?.textContent ?? ''`)
const trustOption = (p: Page) => p.eval<{ text: string; disabled: boolean } | null>(`(()=>{const l=document.querySelector('[data-trust-option]');return l?{text:l.textContent,disabled:l.querySelector('input').disabled}:null})()`)
const settled = (p: Page) => p.waitFor(`(()=>{const l=document.querySelector('[data-trust-option]');return !!l&&!l.textContent.includes('Checking')})()`, 30_000)
async function template(p: Page, path?: string) {
  await workshop(p, { t: String(Date.now()), ...(path ? { path } : {}) })
  await wsButton(p, 'New custom widget template')
  try { await p.waitFor(`(document.querySelector('.wp-workshop [role="status"]')?.textContent??'').includes('Template written')`, 30_000) } catch (e) { throw new Error(`${(e as Error).message}\n  workshop: ${await p.eval(`document.querySelector('.wp-workshop')?.textContent`)}`) }
  await closeAll(p, 'zed')
  await wsButton(p, 'Build & mock preview')
  await p.waitFor(`document.querySelector('.wp-preview')?.textContent.includes('Daily tally')`, 30_000)
  await settled(p)
}
/** Opt-in, optionally tick trust with a real click, then a real click on the activation button. */
async function activateFromWorkshop(p: Page, label: string, trust: boolean) {
  await p.eval(`document.querySelector('.wp-workshop input[type="checkbox"]').click()`)
  if (trust) { await realClick(p, '[data-trust-option] input'); await p.waitFor(`document.querySelector('[data-trust-option] input').checked`) }
  await realClick(p, '.wp-workshop button', label)
  try { await p.waitFor(`/activated/.test(document.querySelector('.wp-workshop [role="status"]')?.textContent ?? '')`, 30_000) } catch (e) { throw new Error(`${(e as Error).message}\n  workshop: ${await p.eval(`document.querySelector('.wp-workshop')?.textContent`)}`) }
}
/** A real (browser-trusted) click: scrolled into view first, so the pointer lands on the element itself. */
async function realClick(p: Page, sel: string, text?: string) {
  await p.eval(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'});if(!e)throw Error('nothing to click: ${sel}');e.scrollIntoView({block:'center'})})()`)
  await sleep(100)
  const hit = await p.eval<boolean>(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'});const r=e.getBoundingClientRect();const top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return e===top||e.contains(top)})()`)
  if (!hit) throw new Error(`covered: ${sel} ${text ?? ''}`)
  await p.clickText(sel, text)
}
const instanceOf = (p: Page) => run<string>(p, `return Object.values(i.installations.get()).find(x=>x.kind==='custom')?.instance ?? ''`)
/** Trusted with live evidence on this device (a recorded grant alone does not count). */
const trusted = (p: Page, id: string) => run<boolean>(p, `return i.trustStatus(${JSON.stringify(id)}, i.installation(${JSON.stringify(id)})?.active ?? null).state==='trusted'`)
const recorded = (p: Page, id: string) => run<boolean>(p, `return !!i.persistentTrust(${JSON.stringify(id)}, i.installation(${JSON.stringify(id)})?.active ?? null)`)
const retains = (p: Page, id: string) => run<boolean>(p, `return i.retainsTrust(${JSON.stringify(id)})`)
const revocations = (p: Page, id: string) => run<number>(p, `return Object.values(c.canonicalTrust.get().revoked).filter(r=>r.instance===${JSON.stringify(id)}).length`)
/** Asks, with nothing running and no Allow once behind it. */
const noAccess = async (p: Page, id: string) => !(await trusted(p, id)) && !(await sessionGrant(p, id)) && !(await run<boolean>(p, `const r=i.installation(${JSON.stringify(id)})?.active;return !!r&&i.hasAccess(${JSON.stringify(id)},r)`))
const sessionGrant = (p: Page, id: string) => run<boolean>(p, `const r=i.installation(${JSON.stringify(id)})?.active;return !!r&&i.hasGrant(${JSON.stringify(id)},r)`)
const toolClick = (p: Page, label: string) => p.eval(`(()=>{const b=[...document.querySelectorAll('${pkg} .wp-tool')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('no tool '+${JSON.stringify(label)});b.click()})()`)
const serverTrust = async (sid: string) => {
  const s = await fetch(`${origin}/api/state`, { headers: { Cookie: `mvlos_sid=${sid}`, 'X-MvL-Account': '2' } }).then((r) => r.json())
  return s['widgets:state:v2']?.value as { schema: number; trust?: { grants: Record<string, unknown>; revoked: Record<string, unknown> } }
}
const flush = (p: Page) => run(p, `await c.canonicalTrust.flush?.();await (await import('/src/os/synced.ts')).pullAll()`)
const pull = (p: Page) => p.eval(`import('/src/os/synced.ts').then(m=>m.pullAll())`)

try {
  // ============================== browser files, user 1 ==============================
  const p = await device(sid1, 'trust-files', 1)
  await boot(p)
  await template(p)
  const offer = await trustOption(p)
  check('an eligible build offers "Trust this widget, so it runs without asking"', !!offer && !offer.disabled && offer.text.includes('Trust this widget, so it runs without asking'), offer)
  check('the trust copy says exact bytes, edits ask, revocable and the canonical folder', !!offer && /exact bytes \(digest [0-9a-f]{16}…\)/.test(offer.text) && offer.text.includes('Any edit asks again') && offer.text.includes('Revoke trust') && offer.text.includes('~/.local/share/mvlos/widgets/daily-tally'), offer?.text)
  await activateFromWorkshop(p, 'Activate as new widget', true)
  const id = await instanceOf(p)
  check('activation with the box ticked trusts the new widget', /Trusted/.test(await status(p)) && await trusted(p, id), await status(p))
  const grant = await run<{ package: string; digest: string; source: { kind: string; path: string }; at: number; installation: string }>(p, `return Object.values(c.canonicalTrust.get().grants)[0]`)
  const active = await run<{ digest: string }>(p, `return i.installation(${JSON.stringify(id)}).active.snapshot`)
  check('the grant pins package id, source identity, digest, installation and time', grant.package === 'daily-tally' && grant.digest === active.digest && grant.source.kind === 'browser' && grant.source.path === '/.local/share/mvlos/widgets/daily-tally' && grant.at > 0 && grant.installation.length > 0, grant)
  await closeAll(p, 'widgetworkshop')
  await sleep(1200)
  await boot(p)
  await runs(p)
  check('after a reload the trusted widget runs with no session grant', !(await sessionGrant(p, id)) && await trusted(p, id))
  let t = await tools(p)
  check('toolbar: Revoke trust, no Pause access (nothing to pause in this session)', t.includes('Revoke trust') && !t.includes('Pause access'), t)
  await p.eval(`[...document.querySelectorAll('${pkg} button')].find(b=>b.textContent.trim()==='+1').click()`)
  await p.waitFor(`(document.querySelector('${pkg}')?.textContent??'').includes('1 all time')`, 10_000)
  check('a trusted widget\'s actions work', true)

  // Revoke trust: immediate, persistent, and Trust always is offered again from the banner.
  await toolClick(p, 'Revoke trust')
  await asks(p)
  check('Revoke trust stops the widget immediately', !(await trusted(p, id)) && !(await sessionGrant(p, id)))
  await p.waitFor(`!!document.querySelector('${pkg} .wp-trust')`, 20_000)
  check('the banner offers Allow once and Trust always for an eligible widget', await p.eval(`!!document.querySelector('${pkg} .wp-allow')&&document.querySelector('${pkg} .wp-trust').textContent==='Trust always'`))
  await sleep(1200)
  await boot(p)
  await asks(p)
  check('after a reload the revoked widget asks again; no trust', !(await trusted(p, id)) && await run<boolean>(p, `return Object.keys(c.canonicalTrust.get().revoked).length===1&&Object.keys(c.canonicalTrust.get().grants).length===0`))
  // Only a genuine click: a script's click and a synthetic event both fail.
  await p.waitFor(`!!document.querySelector('${pkg} .wp-trust')`, 20_000)
  await p.eval(`document.querySelector('${pkg} .wp-trust').click()`)
  await sleep(800)
  check('a script click on Trust always does not trust', !(await trusted(p, id)) && (await body(p)).includes('Trust needs your own click'), await body(p))
  check('trustInstallation refuses a synthetic event', await run<boolean>(p, `const r=i.installation(${JSON.stringify(id)}).active;return i.trustInstallation(${JSON.stringify(id)},r,new MouseEvent('click')).then(()=>false,e=>/own click/.test(e.message))`))
  await realClick(p, `${pkg} .wp-trust`)
  await runs(p)
  check('Trust always (a real click) after observing the revocation trusts it again', await trusted(p, id) && !(await sessionGrant(p, id)))
  await sleep(1200)
  await boot(p)
  await runs(p)
  check('... and it survives a reload', await trusted(p, id))

  // Live source on this device: a recorded grant runs the widget only while its folder is there, unchanged.
  const base = '/.local/share/mvlos/widgets/daily-tally'
  const HOME1 = await p.eval<string>(`import('/src/terminal/vfs.ts').then(m=>m.HOME)`)
  const revokedBefore = await revocations(p, id)
  await run(p, `const m=await import('/src/data/mounts.ts');const e=m.mountEntry({source:'/tmp',target:${JSON.stringify(HOME1 + base)},type:'none',options:['bind'],dump:'0',pass:'0'});if(e)throw Error(e)`)
  await asks(p)
  check('remounted: a bind mount over the trusted folder stops it at once, with no access at all', await noAccess(p, id) && await recorded(p, id) && await p.eval(`(document.querySelector('${pkg} [data-trust-refused]')?.textContent??'').includes('bind mount')`))
  await run(p, `const m=await import('/src/data/mounts.ts');const e=m.unmount(${JSON.stringify(HOME1 + base)});if(e)throw Error(e)`)
  await runs(p)
  check('unmounted: the same trusted bytes run again without a gesture (a mount is not a revocation)', await trusted(p, id) && await revocations(p, id) === revokedBefore)
  const files = await run<Record<string, string>>(p, `const b=await import('/src/data/browserfs.ts');const out={};const walk=async d=>{for(const e of b.listBrowser(d)){if(e.dir)await walk(e.path);else out[e.path]=await b.readBrowserText(e.path)}};await walk(${JSON.stringify(base)});return out`)
  const mainFile = `${base}/src/main.js`
  await run(p, `const b=await import('/src/data/browserfs.ts');await b.writeBrowserFile(${JSON.stringify(mainFile)},${JSON.stringify(files[mainFile] + '// edited')})`)
  await asks(p)
  check('edited in place: the trusted widget stops at once (the folder no longer matches), no access', await noAccess(p, id))
  await run(p, `const b=await import('/src/data/browserfs.ts');await b.writeBrowserFile(${JSON.stringify(mainFile)},${JSON.stringify(files[mainFile])})`)
  await runs(p)
  check('the exact trusted bytes back: it runs again', await trusted(p, id))
  // A same-size write with the clock set back to the old mtime: size and time are unchanged, the mutation number is not.
  const sameSize = files[mainFile].replace(/render/, 'rendeR')
  await run(p, `const b=await import('/src/data/browserfs.ts');const e=b.realBrowserEntry(${JSON.stringify(mainFile)});const real=Date.now;Date.now=()=>e.mtime;try{await b.writeBrowserFile(${JSON.stringify(mainFile)},${JSON.stringify(sameSize)})}finally{Date.now=real};const n=b.realBrowserEntry(${JSON.stringify(mainFile)});if(n.size!==e.size||n.mtime!==e.mtime)throw Error('fixture: size or mtime changed')`)
  await asks(p)
  check('a same-size write under a rolled-back clock (same size and mtime) still stops it', await noAccess(p, id))
  await run(p, `const b=await import('/src/data/browserfs.ts');await b.writeBrowserFile(${JSON.stringify(mainFile)},${JSON.stringify(files[mainFile])})`)
  await runs(p)
  // Another tab (B) of this browser writes the same IndexedDB store. Tab A's memory does not follow it, so A
  // must read the folder again from IndexedDB: the edit has the same length and the same timestamp.
  const other = await newPage(browser1, 1500, 1000, '')
  await boot(other)
  await runs(other)
  await p.send('Page.bringToFront') // a background tab runs no widget at all; A is the one under test
  const sneaky = (silent: boolean) => `const b=await import('/src/data/browserfs.ts');window.__post??=BroadcastChannel.prototype.postMessage;BroadcastChannel.prototype.postMessage=${silent ? '()=>{}' : 'window.__post'};const e=b.realBrowserEntry(${JSON.stringify(mainFile)});const real=Date.now;Date.now=()=>e.mtime;try{await b.writeBrowserFile(${JSON.stringify(mainFile)},${JSON.stringify(sameSize)})}finally{Date.now=real}`
  const restore = `const b=await import('/src/data/browserfs.ts');if(window.__post)BroadcastChannel.prototype.postMessage=window.__post;await b.writeBrowserFile(${JSON.stringify(mainFile)},${JSON.stringify(files[mainFile])})`
  await run(other, sneaky(false))
  await asks(p)
  check('tab B edits the same file (same length and timestamp): tab A re-reads IndexedDB and stops, no access', await noAccess(p, id) && await retains(p, id))
  await run(other, restore)
  await runs(p)
  check('tab B puts the exact bytes back: tab A re-reads and runs again, with the existing grant (no new grant made)', await trusted(p, id) && await run<number>(p, `return Object.keys(c.canonicalTrust.get().grants).length`) === 1)
  // A missed announcement: tab B cannot tell tab A. A's evidence runs out within 20 s and is re-checked from IndexedDB.
  await run(other, sneaky(true))
  await sleep(1500)
  const t0 = Date.now()
  await p.waitFor(`(async()=>{const i=${M.inst};return i.trustStatus(${JSON.stringify(id)},i.installation(${JSON.stringify(id)}).active).state!=='trusted'})()`, 30_000)
  check(`missed announcement: tab A stops once its evidence runs out and IndexedDB is read again (${Math.round((Date.now() - t0) / 1000)} s)`, await noAccess(p, id))
  await run(other, restore)
  await boot(p)
  await runs(p)
  // A stalled re-read: tab A's IndexedDB reads hang. It fails closed meanwhile, and the check times out.
  await p.eval(`window.__getAll=IDBObjectStore.prototype.getAll;IDBObjectStore.prototype.getAll=function(){return {}}`)
  await run(other, sneaky(false))
  await sleep(1500)
  check('a re-read that stalls: no access while it is unresolved', await noAccess(p, id) && await p.eval(`!!document.querySelector('${pkg} [data-trust-checking]')`))
  await p.waitFor(`(document.querySelector('${pkg}')?.textContent??'').includes('took too long')`, 30_000)
  check('... the stalled check times out and still gives no access', await noAccess(p, id))
  await p.eval(`IDBObjectStore.prototype.getAll=window.__getAll`)
  await run(other, restore)
  await other.close()
  await runs(p)
  check('reads work again and the exact bytes are back: it runs again with the same grant', await trusted(p, id))
  await run(p, `const b=await import('/src/data/browserfs.ts');await b.removeBrowser(${JSON.stringify(base)})`)
  await asks(p)
  await p.waitFor(`(async()=>{const i=${M.inst};return !i.retainsTrust(${JSON.stringify(id)})})()`, 20_000)
  check('source deleted: no access, and the trust is revoked for good (a revocation, not just a refusal)', await noAccess(p, id) && await revocations(p, id) === revokedBefore + 1)
  await run(p, `const b=await import('/src/data/browserfs.ts');const files=${JSON.stringify(files)};for(const [f,t] of Object.entries(files)){await b.mkdirBrowser(f.slice(0,f.lastIndexOf('/')),true);await b.writeBrowserFile(f,t)}`)
  await sleep(800)
  check('the same bytes put back do not bring trust back', await noAccess(p, id) && !(await retains(p, id)))
  await sleep(1200)
  await boot(p)
  await asks(p)
  check('... not after a reload either', await noAccess(p, id))
  await p.waitFor(`!!document.querySelector('${pkg} .wp-trust')`, 20_000)
  await realClick(p, `${pkg} .wp-trust`)
  await runs(p)
  check('trusting again needs a new click, and works once every revocation was seen', await trusted(p, id))

  // A second device of the same account: the browser-files source is not there, so it never runs without asking.
  const p2 = await device(session(1), 'trust-files', 1)
  await boot(p2)
  await p2.waitFor(`!!document.querySelector('${pkg}')`, 30_000)
  await asks(p2)
  await sleep(1500)
  check('second device without the source: the synced grant gives no access there', await noAccess(p2, id) && !(await p2.eval(`!!document.querySelector('${pkg} .wp-trust')`)))

  // One source byte edit: a new digest with no authority.
  await run(p, `const b=await import('/src/data/browserfs.ts');const f='/.local/share/mvlos/widgets/daily-tally/src/main.js';await b.writeBrowserFile(f,(await b.readBrowserText(f))+' ')`)
  await workshop(p, { id, t: String(Date.now()) })
  await wsButton(p, 'Build & mock preview')
  await p.waitFor(`document.querySelector('.wp-preview')?.textContent.includes('Daily tally')`, 30_000)
  await settled(p)
  const edited = await run<string>(p, `return document.querySelector('.wp-workshop').textContent.match(/Built ([0-9a-f]{64})/)[1]`)
  check('one source byte edit builds a new digest', edited !== active.digest)
  await activateFromWorkshop(p, 'Activate built revision', false)
  check('the edited revision has no persistent authority (it runs only on this session\'s Allow)', !(await trusted(p, id)) && !(await recorded(p, id)) && await sessionGrant(p, id))
  t = await tools(p)
  check('toolbar after the edit: Pause access, and Revoke trust for the earlier revision\'s decision', t.includes('Pause access') && t.includes('Revoke trust'), t)
  await closeAll(p, 'widgetworkshop')
  await sleep(1200)
  await boot(p)
  await asks(p)
  check('after a reload the edited revision asks again', !(await trusted(p, id)))

  // Outside the canonical folder: offered disabled with the reason. Traversal never resolves to trust.
  await template(p, `${await p.eval<string>(`import('/src/terminal/vfs.ts').then(m=>m.HOME)`)}/dev/daily-tally`)
  const dev = await trustOption(p)
  check('a build from ~/dev is refused: disabled with the reason', !!dev && dev.disabled && dev.text.includes('Not available: This widget was not built from ~/.local/share/mvlos/widgets/daily-tally'), dev)
  const traversal = await run<{ a: boolean; b: boolean; c: boolean; d: string }>(p, `
    const rev=i.installation(${JSON.stringify(id)}).active
    const a=(await i.trustBuildEligibility({...rev,source:{...rev.source,path:'/.local/share/mvlos/widgets/../evil'}})).ok
    const b=(await i.trustBuildEligibility({...rev,source:{...rev.source,path:'/.local/share/mvlos/widgets/daily-tally/..'}})).ok
    const cc=await s.sourceIdentity(s.WIDGET_HOME+'/daily-tally/..').then(()=>true,()=>false)
    const d=await s.sourceIdentity(s.WIDGET_HOME+'/../evil').then(()=>'resolved',e=>e.message)
    return {a,b,c:cc,d}`)
  check('traversal home/../evil and home/id/.. are refused', !traversal.a && !traversal.b && !traversal.c && /canonical/.test(traversal.d), traversal)
  await workshop(p, { path: `${await p.eval<string>(`import('/src/widgets/platform/sources.ts').then(m=>m.WIDGET_HOME)`)}/../evil`, t: String(Date.now()) })
  await wsButton(p, 'Build & mock preview')
  await p.waitFor(`/canonical/.test(document.querySelector('.wp-workshop')?.textContent ?? '')`, 20_000)
  check('the Workshop refuses to build a traversal path, so nothing can be trusted from it', !(await p.eval(`!!document.querySelector('[data-trust-option]')`)))

  // Agents: the real browser host never trusts, and activate refuses a trust option.
  const agent = await run<{ keys: string[]; trusted: boolean; refused: boolean }>(p, `
    const {browserHost}=await import('/src/widgets/platform/agentHost.ts')
    const rev=i.installation(${JSON.stringify(id)}).active
    await browserHost.activate('custom-agent01','custom',rev,0,i.installationVersion('custom-agent01').identity,{trust:false})
    const refused=await i.activate('custom-agent02','custom',rev,0,undefined,{trust:true}).then(()=>false,e=>/cannot grant trust/.test(e.message))
    return {keys:Object.keys(browserHost),trusted:!!i.persistentTrust('custom-agent01',i.installation('custom-agent01').active),refused}`)
  check('an agent activation (browserHost) installs without trust; the host has no trust operation', !agent.trusted && !agent.keys.some((k) => /trust/i.test(k)), agent)
  check('activate refuses anything but trust: false', agent.refused)

  // Removal revokes, and a stale copy of the envelope cannot bring trust back.
  await closeAll(p, 'widgetworkshop')
  await realClick(p, `${pkg} .wp-trust`)
  await runs(p)
  const stale = await run<unknown>(p, `return c.canonicalTrust.get()`)
  const staleInstall = await run<unknown>(p, `return c.canonicalInstallations.get()[${JSON.stringify(id)}]`)
  await run(p, `const v=i.installationVersion(${JSON.stringify(id)});await i.removeInstallation(${JSON.stringify(id)},v.generation,v.identity)`)
  const removal = await run<{ trusted: boolean; resurrected: boolean; revoked: number }>(p, `
    const model=await import('/src/widgets/platform/canonicalModel.ts'),tm=await import('/src/widgets/platform/trust.ts')
    const staleTrust=${JSON.stringify(stale)},staleInstall=${JSON.stringify(staleInstall)}
    const now={schema:3,configs:{},placements:{places:{},removed:''},installations:c.canonicalInstallations.get(),trust:c.canonicalTrust.get()}
    const merged=model.mergeWidgetStates(now,{schema:3,configs:{},placements:{places:{},removed:''},installations:{${JSON.stringify(id)}:staleInstall},trust:staleTrust})
    const grant=Object.values(staleTrust.grants)[0]
    return {trusted:!!i.persistentTrust(${JSON.stringify(id)},staleInstall.active),resurrected:merged.installations[${JSON.stringify(id)}].removed!==true||tm.grantLive(merged.trust,grant),revoked:Object.values(c.canonicalTrust.get().revoked).filter(r=>r.instance===${JSON.stringify(id)}).length}`)
  check('removal revokes trust; a stale envelope with the old record and grant cannot resurrect it', !removal.trusted && !removal.resurrected && removal.revoked >= 2, removal)

  // ============================== Seafile home, user 2, two devices ==============================
  const A = await device(sidA, 'trust-seafile', 2)
  await boot(A)
  check('device A: home is the Seafile library', await A.eval(`Promise.all([import('/src/data/mounts.ts'),import('/src/terminal/vfs.ts')]).then(([m,v])=>m.whereIs(v.HOME).kind==='sf')`))
  // The mock's update link only replaces existing files (as the template writer uses it), so the folder starts
  // with the template's own bytes; the Workshop then finds every byte already in place.
  for (const file of readdirSync(TEMPLATE, { recursive: true, withFileTypes: true })) if (file.isFile()) {
    const rel = join(file.parentPath, file.name).slice(TEMPLATE.length)
    putFile(mock.repos.get(MY_LIBRARY)!, `/.local/share/mvlos/widgets/daily-tally${rel}`, readFileSync(join(file.parentPath, file.name)))
  }
  await template(A)
  const sfOffer = await trustOption(A)
  check('device A: a build in the Seafile home canonical folder is eligible', !!sfOffer && !sfOffer.disabled, sfOffer)
  await activateFromWorkshop(A, 'Activate as new widget', true)
  const sid = await instanceOf(A)
  check('device A: activated and trusted', await trusted(A, sid))
  await closeAll(A, 'widgetworkshop')
  await flush(A)

  const B = await device(sidB, 'trust-seafile', 2)
  await boot(B)
  await B.waitFor(`!!document.querySelector('${pkg}')`, 30_000)
  await runs(B)
  check('device B (same account): the trusted widget runs without asking and without a session grant', await trusted(B, sid) && !(await sessionGrant(B, sid)))

  // Storage semantics: only plain files and folders, as Seafile reports them.
  const lib = mock.repos.get(MY_LIBRARY)!
  const folder = '/.local/share/mvlos/widgets/daily-tally'
  const gate = (pg: Page) => run<{ ok: boolean; reason?: string }>(pg, `return i.trustEligibility(${JSON.stringify(sid)}, i.installation(${JSON.stringify(sid)}).active)`)
  check('device A: the installed widget passes the gate as is', (await gate(A)).ok, await gate(A))
  lib.files.set(`${folder}/assets/note.txt`, { dir: false, data: Buffer.from('x'), mtime: Math.floor(Date.now() / 1000), type: 'symlink' })
  let g = await gate(A)
  check('an entry Seafile reports as a link inside the folder is refused', !g.ok && /not a plain Seafile file or folder/.test(g.reason ?? ''), g)
  lib.files.delete(`${folder}/assets/note.txt`)
  const local = lib.files.get('/.local')!
  lib.files.set('/.local', { ...local, type: 'symlink' })
  g = await gate(A)
  check('a canonical-looking path through an ancestor Seafile reports as a link is refused', !g.ok && /\/\.local is not a plain Seafile folder/.test(g.reason ?? ''), g)
  lib.files.set('/.local', local)
  g = await gate(A)
  check('device A: the gate passes again once the entries are plain', g.ok, g)
  const bind = await A.eval<{ ok: boolean; reason?: string }>(`(async()=>{const m=await import('/src/data/mounts.ts'),v=await import('/src/terminal/vfs.ts'),i=${M.inst};const target=v.HOME+'/.local/share/mvlos/widgets/daily-tally';const err=m.mountEntry({source:'/mnt/seafile/My Library/.local/share/mvlos/widgets/daily-tally',target,type:'none',options:['bind'],dump:'0',pass:'0'});if(err)return {ok:true,reason:err};const r=await i.trustEligibility(${JSON.stringify(sid)},i.installation(${JSON.stringify(sid)}).active);m.unmount(target);return r})()`)
  check('a bind mount on the canonical path is refused', !bind.ok && /bind mount/.test(bind.reason ?? ''), bind)

  // A trusts (done), B revokes, a stale A with its own edits syncs: no resurrection.
  await A.send('Network.setBlockedURLs', { urls: ['*/api/state*'] })
  await toolClick(B, 'Revoke trust')
  await asks(B)
  await flush(B)
  check('server: B\'s revocation arrived', Object.keys((await serverTrust(sidB)).trust?.revoked ?? {}).length === 1)
  check('device A (stale, offline from sync) still holds the old grant', await trusted(A, sid))
  await A.eval(`import('/src/widgets/config.ts').then(m=>m.setWidgetConfig(${JSON.stringify(sid)},{tilt:3}))`)
  await A.send('Network.setBlockedURLs', { urls: [] })
  await pull(A); await sleep(500); await pull(A)
  try { await asks(A) } catch (e) { throw new Error(`${(e as Error).message}\n  A: ${await run<string>(A, `return JSON.stringify({trust:c.canonicalTrust.get(),sync:(await import('/src/os/synced.ts')).getSyncStatus()})`)}`) }
  const after = await serverTrust(sidA)
  check('stale A syncs: the widget stops on A, the server keeps the revocation and no live grant', !(await trusted(A, sid)) && Object.keys(after.trust?.grants ?? {}).length === 0 && Object.keys(after.trust?.revoked ?? {}).length === 1, after.trust)

  // Concurrent: A trusts again (seeing r1); B, stale since before that, revokes again. Blocked everywhere.
  await A.waitFor(`!!document.querySelector('${pkg} .wp-trust')`, 20_000)
  await realClick(A, `${pkg} .wp-trust`)
  await runs(A)
  await flush(A)
  await pull(B)
  await runs(B)
  check('A re-trusted after observing B\'s revocation: both devices run it', await trusted(A, sid) && await trusted(B, sid))
  await B.send('Network.setBlockedURLs', { urls: ['*/api/state*'] })
  await toolClick(A, 'Revoke trust'); await asks(A); await flush(A)
  await A.waitFor(`!!document.querySelector('${pkg} .wp-trust')`, 20_000)
  await realClick(A, `${pkg} .wp-trust`); await runs(A); await flush(A)
  check('A revoked and trusted again; B has seen neither', await trusted(A, sid) && await trusted(B, sid))
  await toolClick(B, 'Revoke trust') // B's revocation is concurrent with A's newest grant
  await asks(B)
  await B.send('Network.setBlockedURLs', { urls: [] })
  await flush(B); await pull(A); await sleep(500); await pull(A)
  await asks(A)
  check('a concurrent revocation A never saw blocks A\'s newer grant on both devices', !(await trusted(A, sid)) && !(await trusted(B, sid)))
  await A.waitFor(`!!document.querySelector('${pkg} .wp-trust')`, 20_000)
  await realClick(A, `${pkg} .wp-trust`); await runs(A); await flush(A)
  await pull(B); await runs(B)
  check('after observing every revocation, A trusts again and both devices run it', await trusted(A, sid) && await trusted(B, sid))

  // Live source on Seafile: read-only, an unknown entry type, then deletion (seen by a device at load).
  const homeLine = /^(UUID=\S+\s+\S+\s+seafile\s+)defaults/m
  await run(A, `const m=await import('/src/data/mounts.ts');m.setFstab(m.getFstab().replace(${homeLine.toString()},'$1ro'))`)
  await asks(A)
  check('read-only home mount: the trusted widget stops at once, no access, no revocation', await noAccess(A, sid) && await retains(A, sid) && await A.eval(`(document.querySelector('${pkg} [data-trust-refused]')?.textContent??'').includes('read-only')`))
  await run(A, `const m=await import('/src/data/mounts.ts');m.setFstab(m.getFstab().replace(/^(UUID=\\S+\\s+\\S+\\s+seafile\\s+)ro/m,'$1defaults'))`)
  await runs(A)
  check('writable again: it runs again', await trusted(A, sid))
  lib.files.set(`${folder}/assets/note.txt`, { dir: false, data: Buffer.from('x'), mtime: Math.floor(Date.now() / 1000), type: 'symlink' })
  await run(A, `const sf=await import('/src/data/seafile.ts');sf.refreshDirs(sf.sfPath(${JSON.stringify(MY_LIBRARY)},${JSON.stringify(folder)}))`)
  await asks(A)
  check('an entry Seafile reports as a link appears: no access until it is gone, no revocation', await noAccess(A, sid) && await retains(A, sid))
  lib.files.delete(`${folder}/assets/note.txt`)
  await run(A, `const sf=await import('/src/data/seafile.ts');sf.refreshDirs(sf.sfPath(${JSON.stringify(MY_LIBRARY)},${JSON.stringify(folder)}))`)
  await runs(A)
  check('the link gone: it runs again', await trusted(A, sid))
  const staleTrust = await run<unknown>(A, `return c.canonicalTrust.get()`)
  const saved = [...lib.files].filter(([k]) => k === folder || k.startsWith(`${folder}/`))
  for (const [k] of saved) lib.files.delete(k)
  await sleep(1200)
  await boot(B)
  await B.waitFor(`!!document.querySelector('${pkg}')`, 30_000)
  await asks(B)
  await B.waitFor(`(async()=>{const i=${M.inst};return !i.retainsTrust(${JSON.stringify(sid)})})()`, 30_000)
  check('second device loads with the source deleted: never runs, and revokes the trust for good', await noAccess(B, sid))
  await flush(B)
  await A.waitFor(`(async()=>{const i=${M.inst};return i.trustStatus(${JSON.stringify(sid)},i.installation(${JSON.stringify(sid)}).active).state!=='trusted'})()`, 30_000)
  await asks(A)
  check('device A stops once its own check (at most 20 s) or the synced revocation reaches it', await noAccess(A, sid))
  for (const [k, v] of saved) lib.files.set(k, v)
  await pull(A); await pull(B)
  await run(A, `const sf=await import('/src/data/seafile.ts');sf.refreshDirs(sf.sfPath(${JSON.stringify(MY_LIBRARY)},'/'))`)
  await sleep(1500)
  const undo = await run<{ live: boolean; retained: boolean }>(A, `const tm=await import('/src/widgets/platform/trust.ts');const merged=tm.mergeTrust(c.canonicalTrust.get(),tm.normalizeTrust(${JSON.stringify(staleTrust)}));return {live:Object.values(merged.grants).some(g=>g.instance===${JSON.stringify(sid)}),retained:i.retainsTrust(${JSON.stringify(sid)})}`)
  check('the folder put back, and a stale copy of the account state merged in: trust stays revoked', !undo.live && !undo.retained && await noAccess(A, sid) && await noAccess(B, sid), undo)

  // Evidence time is monotonic and a hidden tab drops it: the wall clock set back an hour, Seafile unreachable.
  await A.waitFor(`!!document.querySelector('${pkg} .wp-trust')`, 30_000)
  await realClick(A, `${pkg} .wp-trust`); await runs(A); await flush(A)
  check('a visibility change drops Seafile evidence: it checks again before running', await A.eval(`(async()=>{const i=${M.inst};const r=i.installation(${JSON.stringify(sid)}).active;const before=i.trustStatus(${JSON.stringify(sid)},r).state;document.dispatchEvent(new Event('visibilitychange'));return before==='trusted'&&i.trustStatus(${JSON.stringify(sid)},r).state==='checking'&&!i.hasAccess(${JSON.stringify(sid)},r)})()`))
  await runs(A)
  await A.send('Network.setBlockedURLs', { urls: ['*/api/seafile/*'] })
  await A.eval(`(()=>{const real=Date.now;window.__realNow=real;Date.now=()=>real()-3600_000})()`)
  await A.waitFor(`(async()=>{const i=${M.inst};return i.trustStatus(${JSON.stringify(sid)},i.installation(${JSON.stringify(sid)}).active).state!=='trusted'})()`, 30_000)
  check('with the clock set back and Seafile unreachable, the evidence still runs out (within 20 s): no access', await noAccess(A, sid))
  await A.eval(`Date.now=window.__realNow`)
  await A.send('Network.setBlockedURLs', { urls: [] })
  await runs(A)

  // The causal race: A clicks Trust always, its gate is slow; B revokes meanwhile and A receives that before
  // the check ends. The revocation was not seen at the click, so no grant is made.
  await toolClick(A, 'Revoke trust'); await asks(A); await flush(A)
  await A.waitFor(`!!document.querySelector('${pkg} .wp-trust')`, 20_000)
  const revBefore = await revocations(A, sid)
  mock.control.listDelay = 2500
  await realClick(A, `${pkg} .wp-trust`)
  await sleep(300)
  await pull(B)
  await run(B, `await i.revokeTrust(${JSON.stringify(sid)})`)
  await flush(B)
  await pull(A)
  check('A received B\'s revocation while its check was still running', await revocations(A, sid) === revBefore + 1)
  mock.control.listDelay = 0
  await A.waitFor(`(document.querySelector('${pkg}')?.textContent??'').includes('revoked on another device while this was being checked')`, 30_000)
  check('the delayed check made no grant: the revocation arrived after the click', await noAccess(A, sid) && !(await recorded(A, sid)) && !(await retains(A, sid)))
  await realClick(A, `${pkg} .wp-trust`)
  await runs(A)
  check('a new click after seeing it trusts it again', await trusted(A, sid))

  const errors = [...p.errors, ...p2.errors, ...A.errors, ...B.errors].filter((e) => !/ResizeObserver|Failed to fetch|NetworkError|net::ERR/.test(e))
  check('no page errors', errors.length === 0, errors)
} catch (error) {
  failed++
  console.log('FAIL', (error as Error).stack ?? error)
} finally {
  for (const b of browsers) await b.close().catch(() => {})
  vite.kill()
  await mock.close()
  rmSync(data, { recursive: true, force: true })
}
console.log(failed ? `${failed} failed` : 'all checks passed')
process.exit(failed ? 1 : 0)
