// Package authoring and native editor regression: synthetic data, muted Chromium.
// pnpm check:widget-layout (PORT overrides the isolated dev server port).
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5286)
const data = mkdtempSync('/tmp/mvlos-widget-review-')
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

const b = await launch(1600, 1000)
const p = await newPage(b, 1600, 1000, `(() => {
  const Original = window.Worker;
  window.__workers = { starts: 0, active: 0, peak: 0, events: 0, held: [], hold: false, inputs: [] };
  window.Worker = class extends Original {
    constructor(...args) { super(...args); this.done=false; const s=window.__workers; s.starts++; s.active++; s.peak=Math.max(s.peak,s.active) }
    postMessage(message,...args) { this.event=message.event; const s=window.__workers; if(message.event)s.events++; s.inputs.push(new TextEncoder().encode(JSON.stringify(message.input)).length); return super.postMessage(message,...args) }
    set onmessage(callback) { super.onmessage=event=>{if(window.__workers.hold && this.event)window.__workers.held.push(()=>callback(event));else callback(event)} }
    terminate() { if(!this.done){this.done=true;window.__workers.active--} return super.terminate() }
  };
})()`)
const click = async (selector: string) => p.eval(`document.querySelector(${JSON.stringify(selector)}).click()`)
const waitQuiet = () => p.waitFor(`window.__workers.active===0`, 15_000)
const setNote = (text: string) => p.eval(`import('/src/data/notes.ts').then(m=>m.updateNote('review-0',{text:${JSON.stringify(text)}}))`)
const noteText = () => p.eval<string>(`import('/src/data/notes.ts').then(m=>m.getNote('review-0').text)`)
try {
  for (const [name, value] of [['mvlos_sid', sid], ['mvlos_login', login], ['mvlos_uid', '1']]) await p.send('Network.setCookie', { name, value, url: origin })
  await p.send('Page.navigate', { url: origin })
  await p.waitFor(`!!document.querySelector('.desktop') && !document.querySelector('.boot')`, 90_000)
  await p.eval(`(async()=>{const n=await import('/src/data/notes.ts'),w=await import('/src/os/widgetPlaces.ts');for(let i=0;i<10;i++)n.createNote({id:'review-'+i,text:'- [ ] A'+i+'\\n- [ ] B'+i});w.placeWidgets(Array.from({length:10},(_,i)=>({id:'review-'+i,kind:'sticky',x:30+i*32,y:60,w:260,h:240,vw:1600,vh:1000})))})()`)
  await p.waitFor(`document.querySelectorAll('.wp-package .wp-button').length===20`, 20_000)
  await waitQuiet()
  check('R2 ten simultaneous stickies all load without retry or saturation errors', await p.eval(`document.querySelectorAll('.wp-editor').length===10 && window.__workers.peak<=8 && !document.body.textContent.includes('runtime busy')`))
  // Hide nine fixtures via canonical removals, leaving one stable note/widget for the remaining interactions.
  await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>m.widgetPlaces.set(all=>m.changeSet(all,{},Object.keys(all.places).filter(k=>all.places[k].id!=='review-0'))))`)
  await p.eval(`import('/src/os/synced.ts').then(m=>m.pullAll())`)
  // Existing local placements do not emit remote notifications; keeping the other widgets is harmless.
  await setNote('- [ ] A\n- [ ] B')
  await p.waitFor(`[...document.querySelectorAll('.wp-button')].some(b=>b.textContent==='☐ A')`)
  const starts = await p.eval<number>(`window.__workers.events`)
  await p.eval(`(async()=>{const n=await import('/src/data/notes.ts');const old=[...document.querySelectorAll('.wp-button')].find(b=>b.textContent==='☐ A');n.updateNote('review-0',{text:'- [ ] X\\n- [ ] A\\n- [ ] B'});old.click()})()`)
  await sleep(350)
  check('R1 stale visible A cannot toggle prepended X before React refresh', (await noteText()) === '- [ ] X\n- [ ] A\n- [ ] B' && await p.eval(`window.__workers.events===${starts}`))
  await p.waitFor(`[...document.querySelectorAll('.wp-button')].some(b=>b.textContent==='☐ X' && !b.disabled)`)
  await p.eval(`document.querySelector('.wp-package .wp-button').click()`)
  await p.waitFor(`import('/src/data/notes.ts').then(m=>m.getNote('review-0').text.startsWith('- [x] X'))`)
  check('R1 fresh descriptor event targets the displayed item', true)
  const large = Array.from({ length: 300 }, (_, i) => `- [ ] Item ${i}`).join('\n')
  await setNote(large)
  await p.waitFor(`[...document.querySelectorAll('.wp-button')].some(b=>b.textContent==='☐ Item 0' && !b.disabled)`)
  const seen = new Set<string>()
  for (let page = 0; page < 5; page++) {
    const values = await p.eval<string[]>(`[...document.querySelector('.wp-package').querySelectorAll('.wp-button')].map(b=>b.textContent)`)
    values.forEach(value => seen.add(value))
    check(`R3 page ${page + 1} keeps editor and bounded task buttons`, values.length <= 64 && await p.eval(`!!document.querySelector('.wp-package .wp-editor')`))
    if (page < 4) {
      await p.eval(`[...document.querySelector('.wp-package').querySelectorAll('button')].find(b=>b.textContent==='Next items').click()`)
      await p.waitFor(`document.querySelector('.wp-package .wp-button')?.textContent==='☐ Item ${(page + 1) * 64}' && !document.querySelector('.wp-package .wp-button').disabled`)
    }
  }
  check('R3 all 300 items reachable across bounded pages', seen.size === 300)
  await p.eval(`[...document.querySelector('.wp-package').querySelectorAll('button')].find(b=>b.textContent==='Previous items').click()`)
  await p.waitFor(`document.querySelector('.wp-package .wp-button')?.textContent==='☐ Item 192' && !document.querySelector('.wp-package .wp-button').disabled`)
  await click('.wp-package .wp-button')
  await p.waitFor(`import('/src/data/notes.ts').then(m=>m.getNote('review-0').text.includes('- [x] Item 192'))`)
  check('R3 later-page edits apply absolute note offsets', true)
  // Return to the beginning while replacing the note with a larger multibyte legacy note.
  for (let i = 0; i < 3; i++) await p.eval(`[...document.querySelector('.wp-package').querySelectorAll('button')].find(b=>b.textContent==='Previous items').click()`)
  const unicode = '- [ ] Unicode\n' + '界'.repeat(11000)
  await setNote(unicode)
  await p.waitFor(`document.querySelector('.wp-package .wp-button')?.textContent==='☐ Unicode' && !document.querySelector('.wp-package .wp-button').disabled`)
  await click('.wp-package .wp-button')
  await p.waitFor(`import('/src/data/notes.ts').then(m=>m.getNote('review-0').text.startsWith('- [x] Unicode'))`)
  check('R4 33 KiB multibyte note checkbox edits without full replacement', (await noteText()) === unicode.replace('[ ]', '[x]'))
  const legacy = '- [ ] Legacy\n' + '😀'.repeat(100000)
  await setNote(legacy)
  await p.waitFor(`document.querySelector('.wp-package .wp-editor')?.value.length===${legacy.length} && document.querySelector('.wp-package .wp-button')?.textContent==='☐ Legacy' && !document.querySelector('.wp-package .wp-button').disabled`)
  await p.eval(`(()=>{const e=document.querySelector('.wp-package textarea');e.focus();e.setSelectionRange(0,0)})()`)
  await p.send('Input.insertText', { text: 'Edited\n' })
  check('R4 oversized legacy note remains natively editable without truncation', (await noteText()) === 'Edited\n' + legacy)
  check('R4 every VM input remains bounded despite large native note', await p.eval(`window.__workers.inputs.every(n=>n<65536)`))
  await setNote('- [ ] Hidden action')
  await p.waitFor(`document.querySelector('.wp-package .wp-button')?.textContent==='☐ Hidden action' && !document.querySelector('.wp-package .wp-button').disabled`)
  const beforeHiddenClick = await p.eval<number>(`window.__workers.events`)
  await p.eval(`(async()=>{const p=await import('/src/os/deskPrefs.ts');p.notesHidden.set(true);document.querySelector('.wp-package .wp-button').click()})()`)
  await sleep(150)
  check('R5 hidden preference denies same-turn clicks before React commit', await p.eval(`window.__workers.events===${beforeHiddenClick}`))
  await p.eval(`import('/src/os/deskPrefs.ts').then(m=>m.notesHidden.set(false))`)
  await p.waitFor(`document.querySelector('.wp-package .wp-button') && !document.querySelector('.wp-package .wp-button').disabled`)
  await p.eval(`window.__workers.hold=true;document.querySelector('.wp-package .wp-button').click()`)
  await p.waitFor(`window.__workers.held.length>0`)
  await p.eval(`import('/src/os/deskPrefs.ts').then(m=>m.notesHidden.set(true))`)
  await waitQuiet()
  const hiddenStarts = await p.eval<number>(`window.__workers.starts`)
  await p.eval(`window.__workers.held.splice(0).forEach(deliver=>deliver())`)
  await setNote('- [ ] Hidden action\nHidden update')
  await sleep(250)
  check('R5 notesHidden cancels active work and denies pending mutation', (await noteText()).includes('[ ] Hidden action') && await p.eval(`window.__workers.starts===${hiddenStarts}`))
  await p.eval(`window.__workers.hold=false;import('/src/os/deskPrefs.ts').then(m=>m.notesHidden.set(false))`)
  await p.waitFor(`document.querySelector('.wp-package .wp-button') && !document.querySelector('.wp-package .wp-button').disabled`)
  // A real maximized shell window covers widgets. The package remains mounted but does no work.
  await p.eval(`window.dispatchEvent(new CustomEvent('mvlos:open',{detail:{app:'terminal'}}))`)
  await p.waitFor(`!!document.querySelector('[data-app="terminal"]')`)
  await p.eval(`window.__workers.hold=true;document.querySelector('.wp-package .wp-button').click()`)
  await p.waitFor(`window.__workers.held.length>0`)
  await p.eval(`document.querySelector('[data-app="terminal"] .win-max')?.click()`)
  // Maximize through the titlebar's own double-click behavior when no explicit button exists.
  await p.eval(`(()=>{const w=document.querySelector('[data-app="terminal"]');if(!w.classList.contains('is-max'))w.querySelector('.titlebar').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))})()`)
  await p.waitFor(`!!document.querySelector('.desk-scroll.is-covered')`, 5000)
  await waitQuiet()
  const coveredStarts = await p.eval<number>(`window.__workers.starts`)
  await p.eval(`window.__workers.held.splice(0).forEach(deliver=>deliver());window.__workers.hold=false`)
  check('R5 coverage rejects a held package mutation', (await noteText()).includes('[ ] Hidden action'))
  await setNote('- [ ] Covered update')
  await sleep(250)
  check('R5 maximized coverage suppresses mounted widget updates', await p.eval(`window.__workers.starts===${coveredStarts}`))
  await p.eval(`document.querySelector('[data-app="terminal"] .titlebar').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
  await p.waitFor(`!document.querySelector('.desk-scroll.is-covered')`)
  await p.waitFor(`document.querySelector('.wp-package .wp-button')?.textContent==='☐ Covered update' && !document.querySelector('.wp-package .wp-button').disabled`)
  check('R5 uncover resumes the latest revision only', true)
  await waitQuiet()
  const failures = await p.eval<boolean>(`(async()=>{const r=await import('/src/widgets/platform/runtime.ts'),d=await import('/src/widgets/platform/defaults.ts');const snapshot=await d.defaultBuild('sticky'),Original=window.Worker;let first,second;try{window.Worker=class{constructor(){throw Error('constructor denied')}};first=await r.execute(snapshot,{note:{text:'fixture',revision:'1'}}).then(()=>false,e=>e.code==='execution');window.Worker=class extends Original{postMessage(){throw Error('postMessage failed')}};second=await r.execute(snapshot,{note:{text:'fixture',revision:'1'}}).then(()=>false,e=>e.code==='execution')}finally{window.Worker=Original}await r.execute(snapshot,{note:{text:'fixture',revision:'1'}});return first&&second&&window.__workers.active===0})()`)
  check('R2 worker construction/postMessage failures release scheduler and worker slots', failures)
  await p.eval(`(async()=>{const p=await import('/src/widgets/platform/package.ts'),d=await import('/src/widgets/platform/defaults.ts'),i=await import('/src/widgets/platform/installations.ts'),s=await import('/src/widgets/platform/sources.ts');const root=s.WIDGET_HOME+'/review-error';const source=await s.cloneDefault('sticky',root);const files=d.defaultFiles('sticky');files['src/main.js']="export function render(){return {type:'column',children:Array(257).fill({type:'text',text:'Too many'})}}";const snapshot=await p.buildPackage(files);await i.activate('review-0','sticky',{source,snapshot},0);i.allowRevision('review-0',{source,snapshot})})()`)
  await p.waitFor(`document.querySelector('.wp-package')?.textContent.includes('Descriptor limit')`)
  await p.eval(`(()=>{const e=document.querySelector('.wp-package textarea');e.focus();e.setSelectionRange(0,0)})()`)
  await p.send('Input.insertText',{text:'Still editable\n'})
  check('R3 descriptor failure leaves full native editor usable', (await noteText()).startsWith('Still editable'))
  await p.eval(`import('/src/widgets/platform/installations.ts').then(i=>i.recover('review-0',i.installation('review-0').generation))`)
  await p.waitFor(`!!document.querySelector('.wp-package .wp-button') && !document.querySelector('.wp-package .wp-button').disabled`)
  // Weather uses a trusted geolocation fixture and captures all outbound state bodies.
  await p.eval(`(()=>{const native=window.fetch;window.__puts=[];window.__configPuts=[];window.fetch=(url,options)=>{const path=String(url);if(path.includes('/api/state/')&&options?.body){window.__puts.push(String(options.body));if(decodeURIComponent(path).endsWith('/api/state/widgets:state:v2'))window.__configPuts.push(String(options.body))}if(path.includes('bigdatacloud'))return Promise.resolve(Response.json({city:'Local place'}));if(path.includes('api.open-meteo'))return Promise.resolve(Response.json({current:{temperature_2m:18,weather_code:0,is_day:1},hourly:{time:[]},daily:{time:[]}}));return native(url,options)};Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition:success=>success({coords:{latitude:12.34,longitude:56.78}})}})})()`)
  await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>m.placeWidgets([{id:'weather-review',kind:'weather',x:900,y:200,w:290,h:300,vw:1600,vh:1000}]))`)
  await p.waitFor(`!!document.querySelector('[aria-label="Choose weather place"]')`)
  await click('[aria-label="Choose weather place"]')
  await p.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Use my location').click()`)
  await p.waitFor(`[...document.querySelectorAll('.wp-package')].some(e=>e.textContent.includes('Local place')&&e.textContent.includes('18°'))`)
  await sleep(1200)
  check('R6 my location stays browser-local with only place:null in synced config', await p.eval(`import('/src/widgets/config.ts').then(m=>m.getWidgetConfig('weather-review',{place:'missing'}).place===null && window.__configPuts.some(body=>JSON.parse(body).value.configs?.['weather-review']?.value?.place===null) && window.__puts.every(body=>!body.includes('12.34')&&!body.includes('56.78')))`))
  await p.eval(`window.__pendingLocation=null;Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition:success=>window.__pendingLocation=success}});document.querySelector('[aria-label="Choose weather place"]').click()` )
  await p.waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent==='Use my location')`)
  await p.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Use my location').click()`)
  await p.waitFor(`!!window.__pendingLocation`)
  check('R2 invalid input rejects without consuming worker slots', await p.eval(`(async()=>{const runtime=await import('/src/widgets/platform/runtime.ts'),defaults=await import('/src/widgets/platform/defaults.ts');const snapshot=await defaults.defaultBuild('sticky');const count=window.__workers.starts;const code=await runtime.execute(snapshot,{note:{text:'x'.repeat(70000),revision:'bad'}}).then(()=>null,e=>e.code);return code==='input'&&window.__workers.starts===count})()`))
  const accountSwitch = await p.eval<boolean>(`(async()=>{const a=await import('/src/os/accountSpace.ts');a.freezeAccount(false);window.__pendingLocation({coords:{latitude:66.66,longitude:77.77}});await new Promise(r=>setTimeout(r,30));return !localStorage.getItem('mvlos.weather.here').includes('66.66') && window.__workers.active===0})()`)
  check('R6 account freeze cancels pending location before local or synced writes', accountSwitch)
  check('no browser exceptions in review regressions', !p.errors.length, p.errors)
} catch (error) {
  console.log('Browser errors', p.errors)
  console.log('Diagnostic', await p.eval(`({body:document.body.textContent.slice(-2000),workers:window.__workers})`).catch(() => null))
  throw error
} finally { await b.close(); vite.kill('SIGTERM'); rmSync(data, { recursive: true, force: true }) }
if (failed) process.exitCode = 1
