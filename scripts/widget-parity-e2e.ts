// User parity and recovery: a Sticky keeps its calendar chips, and every way a widget installation
// can fail is a visible state with a button that works, no silent fallback, no deleted data and no
// false "activated" message. Synthetic data only; Chromium is muted by the repository CDP harness.
// pnpm check:widget-parity-ui (PORT overrides the isolated dev server port).
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5294)
const data = mkdtempSync('/tmp/mvlos-widget-parity-')
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

const vite = spawn(`${WT}/node_modules/.bin/vite`, ['--port', String(PORT), '--strictPort'], {
  cwd: WT,
  env: { ...process.env, DATA_DIR: data, GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: 'nobody', MC_WATCH: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) process.on(sig, () => (vite.kill(), process.exit(1)))
let log = ''
vite.stdout.on('data', (d) => (log += d))
vite.stderr.on('data', (d) => (log += d))
const origin = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 150 && !log.includes('ready') && vite.exitCode === null; i++) await sleep(200)
if (!log.includes('ready') || vite.exitCode !== null) throw new Error(`vite did not start:\n${log}`)

const b = await launch(1400, 1000)
const inject = (hold: boolean) => `(() => {
  ${hold ? "if(!sessionStorage.getItem('parity-reset')){localStorage.clear();sessionStorage.setItem('parity-reset','1')}" : ''}
  const native=window.fetch.bind(window);window.__opens=[];window.__holdState=${hold};
  window.addEventListener('mvlos:open',e=>window.__opens.push(e.detail));
  const today=new Date(),key=[today.getFullYear(),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0')].join('-');
  window.__event={id:'event',uid:'meeting-uid',calendarId:'work',calendar:'Work',color:'#abcdef',title:'Synthetic meeting',start:key+'T10:00:00',end:key+'T11:00:00',allDay:false,ref:'opaque-event-provider'};
  window.fetch=async(input,options)=>{
    const path=String(input);
    if(path==='/api/me')return Response.json({authEnabled:true,user:{id:1,login:'ui-scale-check',githubScopes:[]},forges:[],googleEnabled:true,google:{email:'synthetic@example.invalid'},caldav:[],integrations:{}});
    if(path==='/api/calendar/calendars')return Response.json({calendars:[{id:'work',name:'Work',color:'#abcdef',selected:true,primary:true,source:'Google'}],errors:[]});
    if(path.startsWith('/api/calendar/events'))return Response.json({events:[window.__event],errors:[]});
    if(path==='/api/calendar/find')return Response.json({event:window.__event,gone:false});
    if(path==='/api/state'&&window.__holdState)return new Promise((resolve,reject)=>{window.__releaseState=()=>{window.__holdState=false;native(input,options).then(resolve,reject)}});
    return native(input,options);
  };
  const set=Storage.prototype.setItem;
  Storage.prototype.setItem=function(k,v){
    if(window.__denyCanonical&&String(k).endsWith('sync.widgets:state:v2'))throw new DOMException('Synthetic quota','QuotaExceededError');
    return set.call(this,k,v);
  };
})()`

const login_ = async (p: Awaited<ReturnType<typeof newPage>>) => {
  for (const [name, value] of [['mvlos_sid', sid], ['mvlos_login', login], ['mvlos_uid', '1']]) await p.send('Network.setCookie', { name, value, url: origin })
  await p.send('Page.navigate', { url: origin })
  await p.waitFor(`!!document.querySelector('.desktop')&&!document.querySelector('.boot')`, 90_000)
}
const p = await newPage(b, 1400, 1000, inject(false))
const sticky = `document.querySelector('.widget-sticky .wp-package')`
const banner = (code: string, root = '.wp-workshop') => `document.querySelector('${root} [data-recovery="${code}"]')`
const bannerButtons = (code: string, root = '.wp-workshop') => p.eval<string[]>(`[...(${banner(code, root)}?.querySelectorAll('button')??[])].map(e=>e.textContent)`)
const waitBanner = (code: string, root = '.wp-workshop') => p.waitFor(`!!${banner(code, root)}`, 20_000)
const pressBanner = (code: string, label: string, root = '.wp-workshop') => p.eval(`(()=>{const b=[...${banner(code, root)}.querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(label)});if(!b)throw Error('missing banner action ${label}');b.click()})()`)
const button = (label: string) => p.eval(`(()=>{const b=[...document.querySelectorAll('.wp-workshop button')].find(e=>e.textContent===${JSON.stringify(label)}&&!e.closest('[data-recovery]'));if(!b)throw Error('missing workshop action ${label}');b.click()})()`)
const status = () => p.eval<string>(`[...document.querySelectorAll('.wp-workshop p[role="status"]')].map(e=>e.textContent).join(' | ')`)
const openWorkshop = async (id: string) => {
  await p.eval(`document.querySelectorAll('[data-app="widgetworkshop"] .ctl-close').forEach(e=>e.click())`)
  await p.waitFor(`!document.querySelector('.wp-workshop')`)
  await p.eval(`window.dispatchEvent(new CustomEvent('mvlos:open',{detail:{app:'widgetworkshop',props:{id:${JSON.stringify(id)},kind:'sticky',t:String(Date.now())}}}))`)
  await p.waitFor(`!!document.querySelector('.wp-workshop')`)
}
const waitActivated = () => p.waitFor(`[...document.querySelectorAll('.wp-workshop p[role="status"]')].some(e=>e.textContent.includes('Revision activated'))`, 20_000)
const optIn = () => p.eval(`(()=>{const c=document.querySelector('.wp-workshop input[type="checkbox"]');if(c&&!c.checked)c.click()})()`)
const rebuild = async () => { await button('Rebuild default & preview'); await p.waitFor(`!!document.querySelector('.wp-preview')`) }
const records = () => p.eval<any>(`import('/src/widgets/platform/canonicalState.ts').then(m=>JSON.parse(JSON.stringify(m.canonicalInstallations.get())))`)
const durable = () => p.eval<any>(`(()=>{const k=Object.keys(localStorage).find(k=>k.endsWith('sync.widgets:state:v2'));return k?JSON.parse(localStorage.getItem(k)).value?.installations??null:null})()`)
const note = () => p.eval<string>(`import('/src/data/notes.ts').then(m=>m.getNote('par-sticky')?.text)`)
const NOTE = '- [ ] Source checklist'
const stale = (extra: string) => `import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalInstallations.set(all=>{const r=all['par-sticky'];${extra}}))`

let q: Awaited<ReturnType<typeof newPage>> | undefined
try {
  await login_(p)
  await p.eval(`(async()=>{
    const n=await import('/src/data/notes.ts'),w=await import('/src/os/widgetPlaces.ts');
    n.createNote({id:'par-sticky',text:${JSON.stringify(NOTE)},events:[{source:'google',uid:'meeting-uid',calendarId:'work',title:'Synthetic meeting',start:window.__event.start,end:window.__event.end,allDay:false,linked:Date.now()}]});
    w.placeWidgets([{id:'par-sticky',kind:'sticky',x:40,y:80,w:300,h:340,vw:1400,vh:1000}]);
  })()`)
  await p.waitFor(`${sticky}?.textContent.includes('Source checklist')`, 30_000)

  // 1. Sticky calendar parity: host-drawn chip, opens the event, note and package untouched.
  await p.waitFor(`!!${sticky}?.querySelector('.nel-chip')`, 15_000)
  check('Sticky shows its linked calendar event as a chip next to the package output', await p.eval(`${sticky}.querySelector('.nel-chip-title').textContent==='Synthetic meeting'&&${sticky}.querySelector('.nel-chips').classList.contains('is-compact')&&${sticky}.textContent.includes('Source checklist')`))
  await p.eval(`${sticky}.querySelector('.nel-chip-open').click()`)
  await p.waitFor(`window.__opens.some(e=>e.app==='calendar'&&e.props?.event==='meeting-uid')`, 15_000)
  check('Clicking the chip opens the linked event in Calendar', true)
  check('Chip does not touch the note and the package gets no calendar authority', (await note()) === NOTE && await p.eval(`import('/src/widgets/platform/defaults.ts').then(m=>m.defaultBuild('sticky')).then(s=>s.manifest.capabilities.every(c=>c.startsWith('note.')))`))
  await p.eval(`document.querySelectorAll('[data-app="calendar"] .ctl-close').forEach(e=>e.click())`)

  // 2. Unavailable installation: banner, explicit repair, nothing deleted, no default in its place.
  await p.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalInstallations.set(all=>({...all,'par-sticky':{schema:1,instance:'par-sticky',kind:'sticky',generation:1,active:'invalid imported metadata'}})))`)
  await p.waitFor(`!!${banner('unavailable', '.widget-sticky')}`, 15_000)
  check('Unavailable installation shows Rebuild default / Open Source / Dismiss', JSON.stringify(await bannerButtons('unavailable', '.widget-sticky')) === JSON.stringify(['Rebuild default', 'Open Source', 'Dismiss']))
  check('Unavailable installation has no silent default fallback and keeps the note', !(await p.eval<string>(`${sticky}.textContent`)).includes('Source checklist') && (await note()) === NOTE)
  await pressBanner('unavailable', 'Rebuild default', '.widget-sticky')
  await p.waitFor(`!!document.querySelector('.wp-preview')`, 20_000)
  await sleep(300)
  check('Rebuild default previews only: record is still the invalid one, nothing claims activation', (await records())['par-sticky'].active === 'invalid imported metadata' && !(await status()).includes('activated'))
  check('Workshop shows the same unavailable state with its own repair action', JSON.stringify(await bannerButtons('unavailable')) === JSON.stringify(['Rebuild default']))
  await optIn(); await button('Activate built revision')
  await waitActivated()
  await p.waitFor(`${sticky}?.textContent.includes('Source checklist')&&!${banner('unavailable', '.widget-sticky')}`, 20_000)
  check('Explicit activation repairs the installation; banner gone, note intact', (await status()).includes('Revision activated') && (await note()) === NOTE && (await records())['par-sticky'].active.source?.kind === 'system', [await status(), await note(), (await records())['par-sticky']?.active?.source])
  await p.eval(`document.querySelectorAll('[data-app="widgetworkshop"] .ctl-close').forEach(e=>e.click())`)

  // 3. Activation conflict: another writer changed the installation after the preview.
  await openWorkshop('par-sticky'); await rebuild(); await optIn()
  await p.eval(stale(`return {...all,'par-sticky':{...r,generation:r.generation+1,active:{source:{kind:'browser',account:1,storeUUID:crypto.randomUUID(),path:'/.local/share/mvlos/widgets/sticky'},snapshot:{...r.active.snapshot,files:{...r.active.snapshot.files,'README.md':'tampered after build'}}}}}`))
  await button('Activate built revision'); await waitBanner('conflict')
  check('Activation conflict is a visible state with a reload action and no success message', JSON.stringify(await bannerButtons('conflict')) === JSON.stringify(['Reload installation state', 'Dismiss']) && !(await status()).includes('activated'))
  check('Conflict did not overwrite the other writer or delete the note', (await records())['par-sticky'].active.source.kind === 'browser' && (await note()) === NOTE)
  await p.waitFor(`!!${banner('package', '.widget-sticky')}`, 15_000)
  check('Widget shows an unverifiable source as a banner with Rebuild default / Open Source, not a fallback', JSON.stringify(await bannerButtons('package', '.widget-sticky')) === JSON.stringify(['Rebuild default', 'Open Source', 'Dismiss']) && !(await p.eval<string>(`${sticky}.textContent`)).includes('Source checklist'))
  await pressBanner('conflict', 'Reload installation state')
  await p.waitFor(`!${banner('conflict')}`)
  check('Reload installation state clears the conflict and leaves the decision to the user', (await status()).includes('reloaded') && !(await status()).includes('activated') && (await records())['par-sticky'].active.source.kind === 'browser')
  await optIn(); await button('Activate built revision')
  await waitActivated()
  await p.waitFor(`${sticky}?.textContent.includes('Source checklist')&&!${banner('package', '.widget-sticky')}`, 20_000)
  check('Activating again after the reload succeeds and the widget recovers', (await status()).includes('Revision activated') && (await records())['par-sticky'].active.source.kind === 'system' && !(await p.eval(`!!${banner('package', '.widget-sticky')}`)))

  // 4. Storage failure: the earlier saved revision stays on disk, the failure is not reported as success.
  await p.eval(stale(`return {...all,'par-sticky':{...r,generation:r.generation+1,active:{...r.active,source:{kind:'browser',account:1,storeUUID:crypto.randomUUID(),path:'/.local/share/mvlos/widgets/sticky'}}}}`))
  await p.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalInstallations.flush())`)
  await openWorkshop('par-sticky'); await rebuild(); await optIn()
  await p.eval(`window.__denyCanonical=true`)
  await button('Activate built revision'); await waitBanner('storage')
  check('Storage failure says it is not saved, offers Retry saving, and reports no activation', JSON.stringify(await bannerButtons('storage')) === JSON.stringify(['Retry saving', 'Dismiss']) && (await p.eval<string>(`${banner('storage')}.textContent`)).includes('Not saved') && !(await status()).includes('activated'))
  check('The earlier saved revision is still what is on disk', (await durable())?.['par-sticky']?.active?.source?.kind === 'browser' && (await note()) === NOTE, await durable())
  await pressBanner('storage', 'Retry saving'); await sleep(500)
  check('Retrying while storage still fails stays a storage banner', await p.eval(`!!${banner('storage')}`) && !(await status()).includes('Saved'))
  await p.eval(`window.__denyCanonical=false`)
  await pressBanner('storage', 'Retry saving'); await p.waitFor(`!${banner('storage')}`, 20_000)
  check('Retry saving after storage recovers stores the revision and then says so', (await status()).includes('Saved') && (await durable())?.['par-sticky']?.active?.source?.kind === 'system', await durable())

  // 5. Installation limit (12 records): explained, nothing changed.
  await p.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalInstallations.set(all=>({...all,...Object.fromEntries(Array.from({length:12},(_,n)=>['future-'+n,{generation:1,future:true}]))})))`)
  const before = Object.keys(await records()).length
  await openWorkshop('par-extra'); await rebuild(); await optIn(); await button('Activate built revision'); await waitBanner('limit')
  check('Installation limit is a visible state that changes nothing', (await p.eval<string>(`${banner('limit')}.textContent`)).includes('Installation limit reached') && Object.keys(await records()).length === before && !(await records())['par-extra'] && !(await status()).includes('activated'))
  await pressBanner('limit', 'Dismiss')
  check('Dismiss hides the limit banner', await p.eval(`!${banner('limit')}`))

  // 6. 480 KiB budget: same, for an existing installation (imported records already filled it).
  await p.eval(`(async()=>{const m=await import('/src/widgets/platform/canonicalState.ts');const bytes=m.canonicalInstallationBytes(m.canonicalInstallations.get());
    m.canonicalInstallations.set(all=>({...all,'future-big':{generation:1,blob:'x'.repeat(480*1024+2000-bytes)}}))})()`)
  await p.eval(stale(`return {...all,'par-sticky':{...r,generation:r.generation+1,active:{...r.active,source:{kind:'browser',account:1,storeUUID:crypto.randomUUID(),path:'/.local/share/mvlos/widgets/sticky'}}}}`))
  await openWorkshop('par-sticky'); await rebuild(); await optIn(); await button('Activate built revision'); await waitBanner('budget')
  check('480 KiB budget overflow is a visible state that changes nothing', (await p.eval<string>(`${banner('budget')}.textContent`)).includes('480 KiB') && (await records())['par-sticky'].active.source.kind === 'browser' && (await note()) === NOTE && !(await status()).includes('activated'))

  // 7. A sync or migration problem that holds widget data back: the user retries, nothing is chosen for them.
  await p.eval(`import('/src/os/synced.ts').then(m=>m.reportSyncFailure(new Error('Widget state is unreadable; original data retained')))`)
  await waitBanner('sync')
  check('Held-back widget data shows an error with Retry sync that says data was kept', JSON.stringify(await bannerButtons('sync')) === JSON.stringify(['Retry sync', 'Dismiss']) && (await p.eval<string>(`${banner('sync')}.textContent`)).includes('nothing was overwritten or deleted'))

  // 8. Phone-sized screen: every banner and its buttons fit the viewport.
  await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await sleep(400)
  check('Banners and buttons fit a phone-sized screen', await p.eval(`[...document.querySelectorAll('.wp-workshop [data-recovery],.wp-workshop [data-recovery] button')].every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})`))
  await p.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }); await sleep(300)
  if (await p.eval(`!!${banner('sync')}`)) await pressBanner('sync', 'Retry sync')
  await p.waitFor(`!${banner('sync')}`, 20_000)
  check('Retry sync clears the held-back state once sync succeeds', true)
  check('No state touched the note', (await note()) === NOTE)
  check('No unhandled browser exceptions', !p.errors.length, p.errors)
  await p.close()

  // 9. Not hydrated yet: activation refuses, then retries only once sync has finished.
  q = await newPage(b, 1400, 1000, inject(true))
  const qs = q
  for (const [name, value] of [['mvlos_sid', sid], ['mvlos_login', login], ['mvlos_uid', '1']]) await q.send('Network.setCookie', { name, value, url: origin })
  await q.send('Page.navigate', { url: origin })
  await q.waitFor(`!!document.querySelector('.desktop')&&!document.querySelector('.boot')`, 90_000)
  await q.eval(`window.dispatchEvent(new CustomEvent('mvlos:open',{detail:{app:'widgetworkshop',props:{id:'par-late',kind:'sticky',t:String(Date.now())}}}))`)
  await qs.waitFor(`!!document.querySelector('.wp-workshop')`)
  const click = (label: string) => q.eval(`(()=>{const b=[...document.querySelectorAll('.wp-workshop button')].find(e=>e.textContent===${JSON.stringify(label)}&&!e.closest('[data-recovery]'));b.click()})()`)
  await click('Rebuild default & preview'); await qs.waitFor(`!!document.querySelector('.wp-preview')`, 20_000)
  await q.eval(`document.querySelector('.wp-workshop input[type="checkbox"]').click()`)
  await click('Activate built revision')
  await qs.waitFor(`!!document.querySelector('.wp-workshop [data-recovery="unhydrated"]')`, 20_000)
  check('Unhydrated activation is refused with a Retry after sync action and no success message', await q.eval(`(()=>{const e=document.querySelector('[data-recovery="unhydrated"]');return [...e.querySelectorAll('button')].map(b=>b.textContent).join()==='Retry after sync,Dismiss'&&![...document.querySelectorAll('.wp-workshop p[role="status"]')].some(p=>p.textContent.includes('activated'))})()`))
  await q.eval(`document.querySelector('[data-recovery="unhydrated"] button').click()`)
  await sleep(500)
  check('Retry after sync stays an error while sync has not finished', await q.eval(`!!document.querySelector('[data-recovery="unhydrated"]')`))
  await q.eval(`window.__releaseState()`)
  await qs.waitFor(`!document.querySelector('[data-recovery="unhydrated"]')&&[...document.querySelectorAll('.wp-workshop p[role="status"]')].some(p=>p.textContent.includes('synced'))`, 20_000)
  check('Once sync finished the banner clears and asks for a fresh explicit activation', await q.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.widgetsHydrated()&&!m.canonicalInstallations.get()['par-late'])`))
  check('No unhandled browser exceptions while waiting for sync', !q.errors.length, q.errors)
} catch (error) {
  console.log('Browser errors', p.errors)
  if (q) console.log('Late page', q.errors, await q.eval(`({workshop:document.querySelector('.wp-workshop')?.textContent,hydrated:import('/src/widgets/platform/canonicalState.ts').then(m=>m.widgetsHydrated())})`).catch(() => null))
  console.log('Browser state', await p.eval(`({widgets:[...document.querySelectorAll('.wp-package')].map(e=>e.textContent),workshop:document.querySelector('.wp-workshop')?.textContent,opens:window.__opens})`).catch(() => null))
  throw error
} finally { await b.close(); vite.kill('SIGTERM'); rmSync(data, { recursive: true, force: true }) }
if (failed) process.exitCode = 1
