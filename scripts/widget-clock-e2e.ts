// Clock widget and phone-compatible widgets: a transparent bare clock that scales with its width and ticks, and a
// phone layout that shows only the widgets whose active manifest says phone:true. Muted Chromium, synthetic data.
// pnpm check:widget-clock-ui (PORT overrides the isolated dev server port). Screenshots go to /tmp.
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5294)
const data = mkdtempSync('/tmp/mvlos-widget-clock-')
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
const shot = async (name: string) => { const r = await p.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`/tmp/${name}.png`, Buffer.from(r.data, 'base64')) }
const boot = async () => {
  await p.send('Page.navigate', { url: origin })
  await p.waitFor(`!!document.querySelector('.desktop') && !document.querySelector('.boot')`, 90_000)
  await p.eval(`import('/src/data/browserfs.ts').then(m=>m.browserFilesReady())`)
}
const clockText = () => p.eval<string>(`document.querySelector('.widget-clock .wp-size-face')?.textContent ?? ''`)
const fontSize = () => p.eval<number>(`parseFloat(getComputedStyle(document.querySelector('.widget-clock .wp-size-face')).fontSize)`)
const item = (label: string, exact = true) => { const test = exact ? `t===${JSON.stringify(label)}` : `t.includes(${JSON.stringify(label)})`; return `[...document.querySelectorAll('.ctx-item')].find(e=>{const t=e.querySelector('.ctx-label')?.textContent.trim()??'';return ${test}})` }
const mouse = (type: string, x: number, y: number) => p.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
const config = (id: string, patch: object) => p.eval(`import('/src/widgets/config.ts').then(m=>m.setWidgetConfig(${JSON.stringify(id)},${JSON.stringify(patch)}))`)
const clockId = () => p.eval<string>(`import('/src/os/widgetPlaces.ts').then(m=>Object.values(m.widgetPlaces.get().places).find(x=>x.kind==='clock')?.id ?? '')`)
try {
  for (const [name, value] of [['mvlos_sid', sid], ['mvlos_login', login], ['mvlos_uid', '1']]) await p.send('Network.setCookie', { name, value, url: origin })
  await boot()
  // ---- Desktop: add the Clock from the desktop menu.
  await p.eval(`document.querySelector('.desk').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:500,clientY:300,button:2}))`)
  await p.waitFor(`!!${item('New')}`, 5000)
  await p.eval(`${item('New')}.click()`)
  await p.waitFor(`!!${item('Widget')}`, 5000)
  await p.eval(`${item('Widget')}.click()`)
  await p.waitFor(`!!${item('Clock', false)}`, 5000)
  await p.eval(`${item('Clock', false)}.click()`)
  await p.waitFor(`/^\\d{1,2}:\\d\\d/.test(document.querySelector('.widget-clock .wp-size-face')?.textContent ?? '')`, 20_000)
  check('Add widget lists the Clock and places it, rendered by the shared package host', await p.eval(`document.querySelector('.widget-clock .wp-package').dataset.packageDigest.length===64`))
  check('the clock shows time and a headline date', /^\d{1,2}:\d\d/.test(await clockText()) && await p.eval(`document.querySelector('.widget-clock .wp-size-subface')?.textContent.length>6`))
  const id = await clockId()
  check('the clock is a placed widget with a plain id', id.length > 0)
  const look = await p.eval<Record<string, string>>(`(() => {const w=getComputedStyle(document.querySelector('.widget-clock')),pk=getComputedStyle(document.querySelector('.widget-clock .wp-package')),tape=document.querySelector('.widget-clock .note-tape');return {bg:w.backgroundColor,img:w.backgroundImage,shadow:w.boxShadow,border:w.borderTopWidth,pkbg:pk.backgroundColor,pkimg:pk.backgroundImage,tape:getComputedStyle(tape).display,text:pk.textShadow,bare:String(document.querySelector('.widget-clock').classList.contains('widget-bare'))}})()`)
  check('transparent: no background, border, shadow or tape', ['rgba(0, 0, 0, 0)', 'transparent'].includes(look.bg) && look.img === 'none' && look.shadow === 'none' && look.border === '0px' && ['rgba(0, 0, 0, 0)', 'transparent'].includes(look.pkbg) && look.pkimg === 'none' && look.tape === 'none' && look.bare === 'true', look)
  check('a soft text shadow keeps it legible over the wallpaper', look.text !== 'none' && look.text !== '')
  await p.eval(`document.querySelectorAll('[data-app="terminal"] .ctl-close').forEach(e=>e.click())`)
  await mouse('mouseMoved', 20, 600)
  await sleep(600)
  await shot('clock-desktop')
  // ---- Resize: the time scales with the width (container query units).
  const small = await fontSize()
  const widthBefore = await p.eval<number>(`document.querySelector('.widget-clock').getBoundingClientRect().width`)
  const grip = await p.eval<{ x: number; y: number }>(`(()=>{const r=document.querySelector('.widget-clock .rz-e').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+Math.min(r.height/2,40)}})()`)
  await mouse('mouseMoved', grip.x, grip.y); await mouse('mousePressed', grip.x, grip.y)
  for (let i = 1; i <= 8; i++) await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x + i * 25, y: grip.y, button: 'left', buttons: 1 })
  await mouse('mouseReleased', grip.x + 200, grip.y)
  await sleep(500)
  const widthAfter = await p.eval<number>(`document.querySelector('.widget-clock').getBoundingClientRect().width`)
  const big = await fontSize()
  check('resizing the widget changes the time size in proportion', widthAfter > widthBefore + 100 && big > small * 1.25 && Math.abs(big / small - widthAfter / widthBefore) < 0.25, { small, big, widthBefore, widthAfter })
  const fit = await p.eval<{ text: number; box: number }>(`(()=>{const t=document.querySelector('.widget-clock .wp-size-face').getBoundingClientRect(),w=document.querySelector('.widget-clock .wp-package').getBoundingClientRect();return {text:t.width,box:w.width}})()`)
  check('the time stays inside the widget', fit.text <= fit.box + 1, fit)
  // ---- Ticking: seconds on, the text changes by itself; hours follow the setting.
  await config(id, { seconds: true, hours: '24' })
  await p.waitFor(`/^\\d\\d:\\d\\d:\\d\\d$/.test(document.querySelector('.widget-clock .wp-size-face')?.textContent ?? '')`, 10_000)
  const first = await clockText()
  await p.waitFor(`document.querySelector('.widget-clock .wp-size-face')?.textContent!==${JSON.stringify(first)}`, 6000)
  check('with seconds it ticks by itself', (await clockText()) !== first, first)
  check('the seconds make the text longer, so it gets smaller to fit', (await fontSize()) < big)
  await config(id, { seconds: false, hours: '12' })
  await p.waitFor(`/(AM|PM|am|pm)$/.test(document.querySelector('.widget-clock .wp-size-face')?.textContent ?? '')`, 10_000)
  check('12-hour setting shows AM/PM', /^\d{1,2}:\d\d [AP]M$/i.test(await clockText()), await clockText())
  await config(id, { seconds: true, hours: '24', show: 'none' })
  await p.waitFor(`!document.querySelector('.widget-clock .wp-size-subface')`, 10_000)
  check('the date can be switched off', true)
  // ---- No timer while hidden: the put-away setting stops the ticking.
  await p.eval(`import('/src/os/deskPrefs.ts').then(m=>m.notesHidden.set(true))`)
  await sleep(300)
  const frozen = await clockText()
  await sleep(2600)
  check('hidden widgets do not tick', (await clockText()) === frozen, frozen)
  await p.eval(`import('/src/os/deskPrefs.ts').then(m=>m.notesHidden.set(false))`)
  await p.waitFor(`document.querySelector('.widget-clock .wp-size-face')?.textContent!==${JSON.stringify(frozen)}`, 8000)
  check('and tick again once shown', true)
  await config(id, { seconds: false, hours: '24', show: 'full' })

  // ---- Phone-compatible widgets: a fork of the clock that says phone:false, a template custom widget with phone:true, and one without the field.
  await p.eval(`(async()=>{
    const p=await import('/src/widgets/platform/package.ts'),d=await import('/src/widgets/platform/defaults.ts'),i=await import('/src/widgets/platform/installations.ts'),s=await import('/src/widgets/platform/sources.ts'),w=await import('/src/widgets/platform/Host.tsx');
    const fork=d.defaultFiles('clock');fork['manifest.json']=JSON.stringify({...JSON.parse(fork['manifest.json']),id:'clock-nophone',name:'Clock (desktop only)',phone:false});
    const forkRev={source:{kind:'system',path:'/usr/share/mvlos/widgets/clock'},snapshot:await p.buildPackage(fork)};
    await i.activate('clock-fork','clock',forkRev,0);
    for(const [instance,phone] of [['custom-yes0001',true],['custom-no00001',undefined]]){
      const source=await s.cloneTemplate(s.WIDGET_HOME+'/'+instance);const files=d.defaultFiles('custom-template');const m=JSON.parse(files['manifest.json']);m.id=instance;m.name=phone?'Template phone':'Template no phone';if(phone===undefined)delete m.phone;files['manifest.json']=JSON.stringify(m);
      const rev={source,snapshot:await p.buildPackage(files)};await i.activate(instance,'custom',rev,0);i.allowRevision(instance,rev);
    }
    const o=await import('/src/os/widgetPlaces.ts');
    for(const [kind,id] of [['clock','clock-fork'],['custom','custom-yes0001'],['custom','custom-no00001'],['weather','weather-phone']])window.dispatchEvent(new CustomEvent('mvlos:open-widget',{detail:{kind,id}}));
  })()`)
  await p.waitFor(`document.querySelectorAll('.window.widget').length>=5`, 20_000)
  await sleep(1500)
  check('on the desktop every widget shows, including the phone:false fork and the custom widget without the flag', await p.eval(`['.widget-clock','.widget-custom','.widget-weather'].every(s=>!!document.querySelector(s)) && document.querySelectorAll('.window.widget:not(.is-away)').length===5`))
  await sleep(500)
  await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1400, deviceScaleFactor: 1, mobile: true })
  await p.send('Emulation.setTouchEmulationEnabled', { enabled: true })
  await boot()
  await p.waitFor(`document.querySelectorAll('.window.widget').length>=1`, 20_000)
  await sleep(2500)
  const shown = await p.eval<string[]>(`[...document.querySelectorAll('.window.widget')].map(e=>e.dataset.pid&&e.getAttribute('aria-label'))`)
  check('on a phone only phone-compatible widgets show: Clock, Template phone and Weather', JSON.stringify([...shown].sort()) === JSON.stringify(['Clock', 'Template phone', 'Weather']), shown)
  check('the phone:false fork and the widget without the flag stay hidden (nothing runs for them)', await p.eval(`!document.querySelector('.window.widget[aria-label="Clock (desktop only)"]') && !document.querySelector('.window.widget[aria-label="Template no phone"]')`))
  check('the clock takes the full width of the phone column and fits', await p.eval(`(()=>{const w=document.querySelector('.widget-clock').getBoundingClientRect(),t=document.querySelector('.widget-clock .wp-size-face').getBoundingClientRect();return w.width>=390-48&&w.left>=0&&w.right<=390&&t.right<=390&&t.left>=0})()`))
  check('the stacked widgets do not overflow sideways', await p.eval(`document.documentElement.scrollWidth<=390 && [...document.querySelectorAll('.window.widget')].every(e=>e.getBoundingClientRect().right<=392)`))
  check('the phone clock still ticks and renders (same package host)', /^\d{1,2}:\d\d/.test(await clockText()))
  await shot('clock-phone')
  const addPhone = await p.eval<string[]>(`import('/src/widgets/registry.tsx').then(m=>m.addWidgetItems({}).map(i=>i.label??''))`)
  check('Add widget on a phone says so and lists only phone-compatible widgets', addPhone[0] === 'Only widgets that work on a phone' && addPhone.some(l => l.includes('Clock')) && addPhone.some(l => l.includes('Weather')) && addPhone.some(l => l.includes('Sticky')) && addPhone.some(l => l.includes('Template phone')) && !addPhone.some(l => l.includes('Template no phone') || l.includes('New custom')), addPhone)
  // The put-away toggle still hides them on a phone.
  await p.eval(`import('/src/os/deskPrefs.ts').then(m=>m.notesHidden.set(true))`)
  await sleep(500)
  check('the notes-hidden setting hides the phone widgets too', await p.eval(`[...document.querySelectorAll('.window.widget')].every(e=>getComputedStyle(e).display==='none')`))
  await p.eval(`import('/src/os/deskPrefs.ts').then(m=>m.notesHidden.set(false))`)
  // Back to a big screen: everything is listed again.
  await p.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await p.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false })
  await boot()
  const addDesk = await p.eval<string[]>(`import('/src/widgets/registry.tsx').then(m=>m.addWidgetItems({}).map(i=>i.label??''))`)
  check('Add widget on a big screen lists everything', addDesk.some(l => l.includes('Template no phone')) && addDesk.some(l => l.includes('New custom')) && !addDesk.includes('Only widgets that work on a phone'), addDesk)
  check('no unhandled browser exceptions', !p.errors.length, p.errors)
} catch (error) {
  console.log('Browser errors', p.errors)
  throw error
} finally {
  await b.close()
  vite.kill('SIGTERM')
  rmSync(data, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
