// Package authoring and native editor regression: synthetic data, muted Chromium.
// pnpm check:widget-layout (PORT overrides the isolated dev server port).
import { isDeepStrictEqual } from 'node:util'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5285)
const data = mkdtempSync('/tmp/mvlos-widget-packages-')
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

const b = await launch(1400, 1000)
const p = await newPage(b, 1400, 1000, '')
const button = async (text: string) => p.eval(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b || b.disabled)throw Error('Button unavailable: '+${JSON.stringify(text)});b.click()})()`)
try {
  for (const [name, value] of [['mvlos_sid', sid], ['mvlos_login', login], ['mvlos_uid', '1']]) await p.send('Network.setCookie', { name, value, url: origin })
  await p.send('Page.navigate', { url: origin })
  await p.waitFor(`!!document.querySelector('.desktop') && !document.querySelector('.boot')`, 90_000)
  await p.eval(`(async()=>{await import('/src/data/browserfs.ts').then(m=>m.browserFilesReady());const n=await import('/src/data/notes.ts');const note=n.createNote({text:'- [ ] original'});window.__note=note.id;window.dispatchEvent(new CustomEvent('mvlos:open',{detail:{app:'widget',props:{kind:'sticky',id:note.id}}}))})()`)
  await p.waitFor(`!!document.querySelector('.wp-editor') && document.querySelector('[data-package-digest]')?.dataset.packageDigest.length===64`)
  check('default Sticky loaded from package in worker', await p.eval(`document.querySelector('.wp-editor').value==='- [ ] original' && document.querySelector('[data-package-digest]').dataset.packageDigest.length===64`))
  check('system source tree visible in VFS', await p.eval(`import('/src/terminal/vfs.ts').then(m=>m.lookup('/usr/share/mvlos/widgets/sticky/src/main.js').content().includes('export function render'))`))
  // Real native input events: fast insertion, selection replacement, Enter continuation and undo.
  await p.eval(`(()=>{const e=document.querySelector('.wp-editor');e.focus();e.setSelectionRange(e.value.length,e.value.length)})()`)
  await p.send('Input.insertText', { text: ' fast' })
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await p.send('Input.insertText', { text: 'next' })
  await sleep(500)
  check('fast input and list continuation preserved', await p.eval(`document.querySelector('.wp-editor').value===${JSON.stringify('- [ ] original fast\n- [ ] next')}`))
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 })
  check('native undo remains available after render refresh', await p.eval(`!document.querySelector('.wp-editor').value.endsWith('next')`))
  await p.eval(`(()=>{const e=document.querySelector('.wp-editor');e.focus();e.setSelectionRange(6,14)})()`)
  await p.send('Input.insertText', { text: 'replaced' })
  check('selection replacement preserves native caret', await p.eval(`document.querySelector('.wp-editor').selectionStart===14`))
  await p.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 })
  await p.send('Input.insertText', { text: '日本' })
  await sleep(300)
  check('IME committed without descriptor rollback', await p.eval(`document.querySelector('.wp-editor').value.includes('日本')`))
  await p.eval(`document.querySelector('.wp-editor').blur()`)
  await sleep(500)
  await p.eval(`document.querySelector('.wp-button').click()`)
  await sleep(500)
  check('package checklist event writes bound note', await p.eval(`import('/src/data/notes.ts').then(m=>m.getNote(window.__note).text.startsWith('- [x]'))`))
  await button('Source')
  await p.waitFor(`!!document.querySelector('.wp-workshop')`)
  await button('Clone & edit in Xed')
  await p.waitFor(`!!document.querySelector('[data-app="zed"]')`)
  check('clone opened real writable source in Xed', await p.eval(`import('/src/data/browserfs.ts').then(m=>m.readBrowserText('/.local/share/mvlos/widgets/sticky/src/main.js')).then(t=>t.includes('export function render'))`))
  // Edit through Xed's own text editor, save with its UI shortcut.
  await p.eval(`(()=>{const e=[...document.querySelector('[data-app="zed"]').querySelectorAll('textarea')].find(e=>e.value.includes('export function render'));if(!e)throw Error('Xed source textarea missing');e.focus();e.setSelectionRange(0,e.value.length)})()`)
  const edited = "import { column,text,editor,button } from '@mvlos/widget';export function render(input){return column(text('Edited in Xed'),editor(),button('Delayed change','replace'))}export function event(input){return {type:'note.replace',text:'stale result',expectedRevision:input.note.revision}}"
  await p.send('Input.insertText', { text: edited })
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 })
  await p.waitFor(`import('/src/data/browserfs.ts').then(m=>m.readBrowserText('/.local/share/mvlos/widgets/sticky/src/main.js')).then(t=>t.includes('Edited in Xed'))`)
  check('source save does not activate revision', await p.eval(`!document.querySelector('.wp-package').textContent.includes('Edited in Xed')`))
  await button('Build & mock preview')
  await p.waitFor(`document.querySelector('.wp-preview')?.textContent.includes('Edited in Xed')`)
  check('edited source visibly changes same-loader mock preview', true)
  await p.eval(`document.querySelector('.wp-workshop input[type="checkbox"]').click()`)
  await button('Activate built revision')
  await p.waitFor(`document.querySelector('.wp-package')?.textContent.includes('Edited in Xed')`)
  check('explicit activation changes desktop behavior', true)
  // Create a second immutable snapshot, then recover the first. No config or note rollback.
  await button('Rebuild default & preview')
  await p.waitFor(`document.querySelector('.wp-preview')?.textContent.includes('Try a checklist')`)
  await p.eval(`document.querySelector('.wp-workshop input[type="checkbox"]').click()`)
  await button('Activate built revision')
  await p.waitFor(`!document.querySelector('.wp-package')?.textContent.includes('Edited in Xed')`)
  await p.eval(`document.querySelector('.wp-workshop input[type="checkbox"]').click()`)
  await button('Recover previous revision')
  await p.waitFor(`document.querySelector('.wp-package')?.textContent.includes('Edited in Xed')`)
  check('previous immutable revision recovery works', true)
  await p.eval(`(async()=>{const notes=await import('/src/data/notes.ts');[...document.querySelectorAll('.wp-package button')].find(b=>b.textContent==='Delayed change').click();notes.updateNote(window.__note,{text:'newer user input'})})()`)
  await sleep(500)
  check('stale package transformation cannot replace newer native text', await p.eval(`import('/src/data/notes.ts').then(m=>m.getNote(window.__note).text==='newer user input')`))
  await button('Pause access')
  await p.waitFor(`document.querySelector('.wp-package')?.textContent.includes('Allow this revision')`)
  check('explicit grant revocation removes package editor', await p.eval(`!document.querySelector('.wp-package textarea')`))
  await p.eval(`(()=>{const native=window.fetch;window.__weatherRequests=[];window.fetch=(url,options)=>{const path=String(url);if(path.includes('geocoding-api.open-meteo.com')){window.__weatherRequests.push(path);return Promise.resolve(Response.json({results:[{name:'Sample city',latitude:52,longitude:5}]}))}if(path.includes('api.open-meteo.com/v1/forecast')){window.__weatherRequests.push(path);return Promise.resolve(Response.json({current:{temperature_2m:18,weather_code:0,is_day:1},hourly:{time:[]},daily:{time:[]}}))}return native(url,options)};})()`)
  await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>m.placeWidgets([{id:'weather-proof',kind:'weather',x:700,y:100,w:290,h:300,vw:1400,vh:1000}]))`)
  await p.waitFor(`!!document.querySelector('[aria-label="Choose weather place"]')`,5000)
  await button('Choose place')
  await p.eval(`document.querySelector('[aria-label="Search a city"]').focus()`)
  await p.send('Input.insertText', { text: 'Sample city' })
  await button('Search places')
  await p.waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent==='Sample city')`)
  await button('Sample city')
  await p.waitFor(`[...document.querySelectorAll('.wp-package')].some(e=>e.textContent.includes('18°'))`)
  check('Weather package renders selected-place forecast', true)
  check('only trusted picker query and selected coordinates leave host', await p.eval(`window.__weatherRequests.length===2 && window.__weatherRequests[0].includes('name=Sample%20city') && window.__weatherRequests[1].includes('latitude=52&longitude=5')`))
  const before = await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>JSON.stringify(m.widgetPlaces.get()))`)
  await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await sleep(300)
  check('mobile hide preserves placements', before === await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>JSON.stringify(m.widgetPlaces.get()))`))
  const hidden = await p.eval(`(async()=>{const original=window.Worker;window.__mobileStarts=0;window.Worker=class extends original{constructor(...args){super(...args);window.__mobileStarts++}};(await import('/src/widgets/config.ts')).setWidgetConfig('weather-proof',{units:'f'});await new Promise(r=>setTimeout(r,350));return window.__mobileStarts})()`)
  check('mobile widgets perform no new VM work', hidden === 0)
  const logout = await p.eval<boolean[]>(`(async()=>{const i=await import('/src/widgets/platform/installations.ts');const revision=i.installation(window.__note).active;i.allowRevision(window.__note,revision);const before=i.hasGrant(window.__note,revision);(await import('/src/os/accountSpace.ts')).freezeAccount(false);return [before,i.hasGrant(window.__note,revision)]})()`)
  check('logout blocks previously granted revision authority', logout[0] && !logout[1])
  check('no unhandled browser exceptions', !p.errors.length, p.errors)
} catch (error) {
  console.log('Browser errors',p.errors);
  console.log('Browser diagnostic', await p.eval(`({widgets:[...document.querySelectorAll('.wp-package')].map(e=>e.textContent),requests:window.__weatherRequests,errors:window.__mobileStarts})`).catch(()=>null));
  throw error
} finally {
  await b.close()
  vite.kill('SIGTERM')
  rmSync(data, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
