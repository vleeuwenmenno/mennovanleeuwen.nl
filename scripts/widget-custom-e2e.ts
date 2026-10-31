// Custom widget lifecycle: template -> build/preview -> activate as new instance -> desktop -> reload -> interact -> remove.
// Synthetic data, muted Chromium. pnpm check:widget-custom-ui (PORT overrides the isolated dev server port).
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5293)
const data = mkdtempSync('/tmp/mvlos-widget-custom-')
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

const b = await launch(1500, 1000)
const p = await newPage(b, 1500, 1000, '')
const button = async (label: string, scope = '.wp-workshop') => p.eval(`(() => {const b=[...document.querySelectorAll(${JSON.stringify(scope)}+' button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b || b.disabled)throw Error('Button unavailable: '+${JSON.stringify(label)});b.click()})()`)
const body = () => p.eval<string>(`document.querySelector('.widget-custom .wp-package')?.textContent ?? ''`)
const waitBody = (needle: string) => p.waitFor(`(document.querySelector('.widget-custom .wp-package')?.textContent ?? '').includes(${JSON.stringify(needle)})`, 20_000)
const boot = async () => {
  await p.send('Page.navigate', { url: origin })
  await p.waitFor(`!!document.querySelector('.desktop') && !document.querySelector('.boot')`, 90_000)
  await p.eval(`import('/src/data/browserfs.ts').then(m=>m.browserFilesReady())`)
}
const closeAll = (app: string) => p.eval(`document.querySelectorAll('[data-app="${app}"] .ctl-close').forEach(e=>e.click())`)
const instance = () => p.eval<string>(`import('/src/widgets/platform/installations.ts').then(m=>Object.values(m.installations.get()).find(i=>i.kind==='custom')?.instance ?? '')`)
try {
  for (const [name, value] of [['mvlos_sid', sid], ['mvlos_login', login], ['mvlos_uid', '1']]) await p.send('Network.setCookie', { name, value, url: origin })
  await boot()
  // Create: template folder -> build -> mock preview -> explicit opt-in -> new instance.
  await p.eval(`window.dispatchEvent(new CustomEvent('mvlos:open',{detail:{app:'widgetworkshop',props:{kind:'custom',t:String(Date.now())}}}))`)
  await p.waitFor(`document.querySelector('.wp-workshop')?.textContent.includes('new custom widget')`)
  check('no custom widget exists before creation', (await instance()) === '' && await p.eval(`!document.querySelector('.widget-custom')`))
  await button('New custom widget template')
  await p.waitFor(`import('/src/data/browserfs.ts').then(m=>m.readBrowserText('/.local/share/mvlos/widgets/daily-tally/src/main.js')).then(t=>t.includes('export function render'))`)
  check('template writes a working package folder', await p.eval(`import('/src/data/browserfs.ts').then(m=>Promise.all(['manifest.json','README.md','styles/tokens.json','src/main.js'].map(f=>m.readBrowserText('/.local/share/mvlos/widgets/daily-tally/'+f)))).then(a=>a.every(t=>t.length>0)&&JSON.parse(a[0]).capabilities[0]==='custom.state')`))
  await closeAll('zed')
  check('activation is impossible before a build', await p.eval(`[...document.querySelectorAll('.wp-workshop button')].find(b=>b.textContent==='Activate as new widget').disabled`))
  await button('Build & mock preview')
  await p.waitFor(`document.querySelector('.wp-preview')?.textContent.includes('Daily tally')`)
  check('mock preview renders through the shared renderer without placing anything', await p.eval(`!document.querySelector('.widget-custom')`))
  check('activation needs the explicit opt-in', await p.eval(`[...document.querySelectorAll('.wp-workshop button')].find(b=>b.textContent==='Activate as new widget').disabled`))
  await p.eval(`document.querySelector('.wp-workshop input[type="checkbox"]').click()`)
  await button('Activate as new widget')
  await waitBody('Daily tally')
  const id = await instance()
  check('new custom instance exists with its own id, placed and rendered by PackageHost', /^custom-[a-f0-9]{8}$/.test(id) && await p.eval(`document.querySelector('.widget-custom .wp-package').dataset.packageDigest.length===64`), id)
  check('window title is the package name', await p.eval(`document.querySelector('.widget-custom')?.textContent.includes('Daily tally')`))
  check('placement props are {kind:custom,id}', await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>Object.values(m.widgetPlaces.get().places).some(x=>x.kind==='custom'&&x.id===${JSON.stringify(id)}))`))
  check('builtins unchanged: kind list still closed to the seven built-ins', await p.eval(`import('/src/widgets/platform/package.ts').then(m=>m.WIDGET_KINDS.length===7)`))
  // Interact: state changes and is saved in the instance's own state.
  await button('+1', '.widget-custom .wp-package'); await waitBody('1 all time')
  await button('+1', '.widget-custom .wp-package'); await waitBody('2 all time')
  check('buttons change state', (await body()).includes('2'))
  check('state persisted bounded in widget config', await p.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>{const s=m.canonicalConfigs.get()[${JSON.stringify(id)}].state;return s.count===2&&s.total===2&&JSON.stringify(s).length<4096})`))
  await closeAll('widgetworkshop')
  await sleep(1500)
  // Reload: installation, placement and state come back; the revision needs a fresh grant.
  await boot()
  await p.waitFor(`!!document.querySelector('.widget-custom')`, 20_000)
  await p.waitFor(`(document.querySelector('.widget-custom .wp-package')?.textContent ?? '').includes('Allow this revision')`, 20_000)
  check('after reload the custom revision does not run until granted', !(await body()).includes('Daily tally') || (await body()).includes('Allow this revision'))
  await button('Allow this revision to access this widget\'s small saved state', '.widget-custom .wp-package')
  await waitBody('2 all time')
  check('custom widget survives reload with its state', true)
  await button('+1', '.widget-custom .wp-package'); await waitBody('3 all time')
  check('interaction after reload works and persists', await p.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalConfigs.get()[${JSON.stringify(id)}].state.total===3)`))
  // Discoverable: Add widget lists the installed instance.
  check('Add widget lists the installed custom widget and the way to create one', await p.eval(`import('/src/widgets/registry.tsx').then(m=>{const d=m.widgetDefs();return d.some(x=>x.instance===${JSON.stringify(id)}&&x.name==='Daily tally')&&d.some(x=>x.name==='New custom widget…')&&d.slice(0,6).map(x=>x.kind).join()==='sticky,weather,agenda,inbox,status,minecraft'})`))
  // Take it off the desktop (installation stays), then add it again from the desktop menu.
  await p.eval(`document.querySelector('.widget-custom .note-close').click()`)
  await p.waitFor(`!document.querySelector('.widget-custom')`)
  check('closing only removes the placement; the installation stays', (await instance()) === id)
  await p.eval(`document.querySelector('.desk').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:900,clientY:700,button:2}))`)
  const item = (label: string, exact = true) => { const test = exact ? `t===${JSON.stringify(label)}` : `t.includes(${JSON.stringify(label)})`; return `[...document.querySelectorAll('.ctx-item')].find(e=>{const t=e.querySelector('.ctx-label')?.textContent.trim()??'';return ${test}})` }
  await p.waitFor(`!!${item('New')}`, 5000)
  await p.eval(`${item('New')}.click()`)
  await p.waitFor(`!!${item('Widget')}`, 5000)
  await p.eval(`${item('Widget')}.click()`)
  await p.waitFor(`!!${item('Daily tally', false)}`, 5000)
  await p.eval(`${item('Daily tally', false)}.click()`)
  await waitBody('3 all time')
  check('Add widget from the desktop menu places the installed widget again, state intact', true)
  // An installation that is missing stays placed with an actionable message and is not deleted.
  await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>m.placeWidgets([{id:'custom-ghost',kind:'custom',x:700,y:100,w:290,h:200,vw:1500,vh:1000}]))`)
  await p.waitFor(`!!document.querySelector('[data-custom-unavailable]')`, 10_000)
  check('missing installation shows an actionable unavailable state', await p.eval(`document.querySelector('[data-custom-unavailable]').textContent.includes('not installed')&&[...document.querySelectorAll('[data-custom-unavailable] button')].some(b=>b.textContent==='Open Workshop')`))
  await sleep(500)
  check('unavailable custom placement is kept', await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>Object.values(m.widgetPlaces.get().places).some(x=>x.id==='custom-ghost'))`))
  // A phone shows the widgets whose manifest says phone:true (the template does), hides the rest (the unavailable ghost), and keeps every placement.
  const before = await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>JSON.stringify(m.widgetPlaces.get()))`)
  await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await sleep(400)
  check('mobile shows the phone:true custom widget, hides the ghost and keeps placements', await p.eval(`!!document.querySelector('.widget-custom:not(.is-away)') && !document.querySelector('.widget-custom [data-custom-unavailable]')`) && before === await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>JSON.stringify(m.widgetPlaces.get()))`))
  await p.send('Emulation.clearDeviceMetricsOverride')
  await p.waitFor(`!!document.querySelector('.widget-custom')`, 10_000)
  // Remove the installation from the Workshop (explicit, confirmed).
  await p.eval(`document.querySelector('.widget-custom [aria-label="Edit widget source"]').click()`)
  await p.waitFor(`!!document.querySelector('.wp-workshop')`)
  await button('Remove this widget')
  await p.waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent==='Remove widget')`, 5000)
  await p.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Remove widget').click()`)
  await p.waitFor(`!document.querySelector('.widget-custom .wp-package')?.dataset.packageDigest`, 10_000)
  await p.waitFor(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalInstallations.get()[${JSON.stringify(id)}]?.removed===true)`, 10_000)
  check('removal writes a tombstone and drops saved state', await p.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>!m.canonicalConfigs.get()[${JSON.stringify(id)}])`))
  check('removed widget leaves Add widget', await p.eval(`import('/src/widgets/registry.tsx').then(m=>!m.widgetDefs().some(x=>x.instance===${JSON.stringify(id)}))`))
  check('builtins stay non-removable', await p.eval(`import('/src/widgets/platform/installations.ts').then(m=>m.removeInstallation('anything',1).then(()=>false,e=>/custom/.test(e.message)))`))
  await closeAll('widgetworkshop')
  await sleep(1500)
  await boot()
  await sleep(1500)
  check('removed widget stays gone after reload', await p.eval(`import('/src/widgets/registry.tsx').then(m=>!m.widgetDefs().some(x=>x.instance===${JSON.stringify(id)}))`) && (await instance()) === '')
  check('no unhandled browser exceptions', !p.errors.length, p.errors)
} catch (error) {
  console.log('Browser errors', p.errors)
  console.log('Browser diagnostic', await p.eval(`({widgets:[...document.querySelectorAll('.widget')].map(e=>e.textContent),workshop:document.querySelector('.wp-workshop')?.textContent})`).catch(() => null))
  throw error
} finally {
  await b.close()
  vite.kill('SIGTERM')
  rmSync(data, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
