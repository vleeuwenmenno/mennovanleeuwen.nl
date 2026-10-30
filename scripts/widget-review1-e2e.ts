// Six real source packages, domain effects and canonical cutover: synthetic data, muted Chromium.
// pnpm check:widget-builtins-ui (PORT overrides the isolated dev server port).
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5292)
const data = mkdtempSync('/tmp/mvlos-widget-review1-')
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
const p = await newPage(b, 1500, 1000, `(() => {
  const native = fetch.bind(window); window.__taskReads=[]; window.__caldavOn=true;
  const today=new Date(),day=[today.getFullYear(),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0')].join('-');
  window.fetch=(input,options)=>{
    const path=String(input);
    if(path==='/api/me')return Promise.resolve(Response.json({authEnabled:true,user:{id:1,login:'ui-scale-check',name:null,avatar:null,admin:false,githubScopes:[]},forges:[],googleEnabled:true,google:{email:'synthetic@example.invalid'},caldav:window.__caldavOn?[{id:1,username:'synthetic',url:'https://calendar.example.invalid',label:'Synthetic'}]:[],integrations:{updown:'settings'}}));
    if(path==='/api/calendar/calendars')return Promise.resolve(Response.json({calendars:[{id:'work',name:'Work',color:'#abcdef',selected:true,primary:true,source:'Google'}],errors:[]}));
    if(path.startsWith('/api/calendar/events'))return Promise.resolve(Response.json({events:[],errors:[]}));
    if(path.startsWith('/api/tasks'))return new Promise(resolve=>{
      const read={signal:options?.signal,release:title=>resolve(Response.json({lists:[{id:'local',name:'Tasks',color:'#abcdef',source:'On this site',local:true,writable:true}],tasks:[{id:'local|held',uid:'held',ref:'opaque',list:'local',title,due:day,allDay:true,completed:false,priority:0}],errors:[]}))};window.__taskReads.push(read);
      // Deliberately ignore abort at the transport: the domain must still refuse late adoption.
    });
    if(path==='/api/updown')return Promise.resolve(Response.json([{token:'check0',name:'Service 0',url:'https://service.example.invalid',enabled:true,down:false,downSince:null,error:null,uptime:99.9,responseTime:42,sslValid:true,sslExpiresAt:null}]));
    return native(input,options);
  };
})()`)
const task = () => p.eval<string | null>(`import('/src/data/tasks.ts').then(m=>m.currentTask('local|held')?.title??null)`)
const latest = () => p.eval<number>(`window.__taskReads.length-1`)
const release = (index: number, title: string) => p.eval(`window.__taskReads[${index}].release(${JSON.stringify(title)})`)
const hide = (hidden: boolean) => p.eval(`import('/src/os/deskPrefs.ts').then(m=>m.notesHidden.set(${hidden}))`)
const open = (app: string) => p.eval(`window.dispatchEvent(new CustomEvent('mvlos:open',{detail:{app:${JSON.stringify(app)},props:{t:String(Date.now())}}}))`)
const refresh = async () => {
  const count=await p.eval<number>(`window.__taskReads.length`)
  await p.eval(`import('/src/data/tasks.ts').then(m=>{void m.reloadTasks(true)})`)
  await p.waitFor(`window.__taskReads.length>${count}`)
  return latest()
}
const forkButton = (starts: string) => p.eval(`[...document.querySelector('.widget-agenda .wp-package').querySelectorAll('button')].find(e=>e.textContent.startsWith(${JSON.stringify(starts)})).click()`)
try {
  for(const [name,value] of [['mvlos_sid',sid],['mvlos_login',login],['mvlos_uid','1']])await p.send('Network.setCookie',{name,value,url:origin})
  // Two real pages share storage while /api/me is held independently. This exercises the
  // journal keys, atomic receipt/data save, late hydration and reload through the actual shell.
  const gate = `(() => {window.__journalDocument=crypto.randomUUID();const native=fetch.bind(window);window.fetch=(input,options)=>String(input)==='/api/me'?new Promise((resolve,reject)=>{window.__releaseMe=()=>native(input,options).then(resolve,reject)}):native(input,options)})()`
  const A=await newPage(b,1500,1000,gate),B=await newPage(b,1500,1000,gate)
  try {
    await A.send('Page.navigate',{url:origin});await A.waitFor(`document.querySelector('.desktop')&&!document.querySelector('.boot')&&!!window.__releaseMe`,90_000)
    await A.eval(`(async()=>{(await import('/src/widgets/config.ts')).setWidgetConfig('journal-agenda',{days:1});const w=await import('/src/os/widgetPlaces.ts');w.widgetPlaces.set(all=>w.changeSet(all,{'journal-place':{id:'journal-place',kind:'status',x:100,y:100,w:300,h:260,vw:1500,vh:1000,at:Date.now()}}))})()`)
    await B.send('Page.navigate',{url:origin});await B.waitFor(`document.querySelector('.desktop')&&!document.querySelector('.boot')&&!!window.__releaseMe`,90_000)
    await A.eval(`window.__releaseMe()`);await A.waitFor(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.widgetsHydrated())`)
    await A.eval(`(async()=>{(await import('/src/widgets/config.ts')).setWidgetConfig('journal-agenda',{days:7});const w=await import('/src/os/widgetPlaces.ts');w.widgetPlaces.set(all=>w.changeSet(all,{},['journal-place']))})()`)
    await A.waitFor(`JSON.parse(localStorage.getItem('mvlos.u.1.sync.widgets:state:v2')).dirty===false`)
    await B.eval(`import('/src/widgets/config.ts').then(m=>m.setWidgetConfig('journal-agenda',{units:'f'}))`)
    await B.eval(`window.__releaseMe()`);await B.waitFor(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.widgetsHydrated())`)
    check('Real late-hydrating tab preserves the later edit and its own unique patch',await B.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalConfigs.get()['journal-agenda'].days===7&&m.canonicalConfigs.get()['journal-agenda'].units==='f')`))
    check('Real late-hydrating tab cannot resurrect a consumed, removed addition',await B.eval(`import('/src/os/widgetPlaces.ts').then(m=>m.entriesOf(m.widgetPlaces.get(),'journal-place').length===0)`))
    const previousDocument=await B.eval<string>(`window.__journalDocument`)
    await B.send('Page.reload');await B.waitFor(`window.__journalDocument!==${JSON.stringify(previousDocument)}&&document.querySelector('.desktop')&&!document.querySelector('.boot')&&typeof window.__releaseMe==='function'`,90_000)
    await B.eval(`window.__releaseMe()`);await B.waitFor(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.widgetsHydrated())`)
    check('Real reload retains operation receipts and cannot replay stale journals',await B.eval(`(async()=>{const c=await import('/src/widgets/platform/canonicalState.ts'),w=await import('/src/os/widgetPlaces.ts');return c.canonicalConfigs.get()['journal-agenda'].days===7&&c.canonicalConfigs.get()['journal-agenda'].units==='f'&&w.entriesOf(w.widgetPlaces.get(),'journal-place').length===0})()`))
    check('Two-tab journal probe has no browser exceptions',!A.errors.length&&!B.errors.length,[...A.errors,...B.errors])
  } finally {await A.close();await B.close()}
  await p.send('Page.navigate',{url:origin})
  await p.waitFor(`document.querySelector('.desktop')&&!document.querySelector('.boot')`,90_000)
  await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>m.placeWidgets([{id:'review-agenda',kind:'agenda',x:30,y:80,w:350,h:400,vw:1500,vh:1000},{id:'review-status',kind:'status',x:700,y:80,w:320,h:300,vw:1500,vh:1000}]))`)
  await p.waitFor(`window.__taskReads.some(r=>r.signal&&!r.signal.aborted)`)
  const initial=await latest()
  check('Agenda has one live shared task read with an AbortSignal',await p.eval(`window.__taskReads.filter(r=>!r.signal.aborted).length===1`))
  await hide(true);await p.waitFor(`window.__taskReads[${initial}].signal.aborted`)
  for(let i=0;i<=initial;i++)await release(i,'Hidden late reply')
  await sleep(80)
  check('Hiding sole Agenda aborts task read and denies late cache adoption',await task()===null)
  await hide(false);await p.waitFor(`window.__taskReads.length>${initial+1}`)
  await open('tasks');await p.waitFor(`!!document.querySelector('[data-app="tasks"]')`);await sleep(100)
  const shared=await latest(),count=shared+1
  await hide(true);await sleep(100)
  check('Tasks app retains shared read while Agenda hides',await p.eval(`!window.__taskReads[${shared}].signal.aborted&&window.__taskReads.length===${count}`))
  await release(shared,'Live Tasks reply');await p.waitFor(`import('/src/data/tasks.ts').then(m=>m.currentTask('local|held')?.title==='Live Tasks reply')`)
  check('A live app consumer may adopt the retained task result',true)
  await p.eval(`document.querySelector('[data-app="tasks"] .ctl-close').click()`);await p.waitFor(`!document.querySelector('[data-app="tasks"]')`)
  await hide(false);await p.waitFor(`!!document.querySelector('.widget-agenda .wp-package')`);await sleep(100)
  const beforeCalendar=await refresh()
  await open('calendar');await p.waitFor(`!!document.querySelector('[data-app="calendar"]')`);await sleep(100)
  const calendarRead=await latest()
  check('Calendar joins the existing task read',calendarRead===beforeCalendar)
  await hide(true);await sleep(100)
  check('Calendar retains read when all widgets hide',await p.eval(`!window.__taskReads[${calendarRead}].signal.aborted`))
  await p.eval(`document.querySelector('[data-app="calendar"] .ctl-close').click()`);await p.waitFor(`!document.querySelector('[data-app="calendar"]')&&window.__taskReads[${calendarRead}].signal.aborted`)
  await release(calendarRead,'Last consumer closed');await sleep(80)
  check('Closing last app consumer aborts read and keeps prior cache',await task()==='Live Tasks reply')
  await hide(false)
  await p.eval(`(async()=>{const s=await import('/src/widgets/platform/sources.ts'),p=await import('/src/widgets/platform/package.ts'),i=await import('/src/widgets/platform/installations.ts');const path=s.WIDGET_HOME+'/agenda';await s.cloneDefault('agenda',path);const source=await s.sourceIdentity(path),snapshot=await p.buildPackage(await s.readSource(source)),revision={source,snapshot};await i.activate('review-agenda','agenda',revision,0);i.allowRevision('review-agenda',revision)})()`)
  await p.waitFor(`[...document.querySelectorAll('.widget-agenda button')].some(e=>e.textContent==='Pause access')`)
  await sleep(100)
  // A newly mounted owner may already refresh stale data. Reuse that read rather than queueing one.
  let revoked=await latest()
  if(await p.eval(`window.__taskReads[${revoked}].signal.aborted`))revoked=await refresh()
  await forkButton('Pause access');await p.waitFor(`window.__taskReads[${revoked}].signal.aborted`)
  await release(revoked,'Revoked fork late reply');await sleep(80)
  check('Package grant revocation cancels sole task lease and rejects late reply',await task()==='Live Tasks reply')
  await forkButton('Allow this revision');await p.waitFor(`[...document.querySelectorAll('.widget-agenda button')].some(e=>e.textContent==='Pause access')`);await sleep(100)
  let disconnected=await latest()
  if(await p.eval(`window.__taskReads[${disconnected}].signal.aborted`))disconnected=await refresh()
  await p.eval(`window.__caldavOn=false;import('/src/os/account.ts').then(m=>m.loadAccount())`)
  await p.waitFor(`window.__taskReads[${disconnected}].signal.aborted&&window.__taskReads.length>${disconnected+1}`)
  await release(disconnected,'Disconnected provider late reply');await sleep(80)
  check('Task account authority change aborts and clears old cache before a fresh read',await task()===null)
  const fresh=await latest();await release(fresh,'New authority reply')
  await p.waitFor(`import('/src/data/tasks.ts').then(m=>m.currentTask('local|held')?.title==='New authority reply')`)
  check('New account authority starts one eligible fresh task read',true)
  // The reviewer persisted a malformed record before reloading. This must survive normalization.
  await p.eval(`(async()=>{const a=await import('/src/os/accountSpace.ts');const key='mvlos.sync.widgets:state:v2',meta=JSON.parse(a.accountStorage.get(key));meta.value.installations['review-status']={schema:1,instance:'review-status',kind:'status',active:{}};meta.dirty=true;a.accountStorage.set(key,JSON.stringify(meta))})()`)
  await p.send('Page.reload');await p.waitFor(`document.querySelector('.desktop')&&!document.querySelector('.boot')`,90_000)
  await p.waitFor(`document.querySelector('.widget-status .wp-package')?.textContent.includes('Installed metadata unavailable')`)
  check('Missing-generation installation survives reload as unavailable, never default',await p.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>Object.hasOwn(m.canonicalInstallations.get(),'review-status')&&!document.querySelector('.widget-status .wp-package').textContent.includes('Service 0'))`))
  await p.eval(`[...document.querySelector('.widget-status .wp-package').querySelectorAll('button')].find(e=>e.textContent==='Source').click()`)
  await p.waitFor(`!!document.querySelector('.wp-workshop')`)
  const workshop=(label:string)=>p.eval(`[...document.querySelector('.wp-workshop').querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(label)}).click()`)
  await workshop('Rebuild default & preview');await p.waitFor(`document.querySelector('.wp-preview')?.textContent.includes('Sample service')`)
  await p.eval(`document.querySelector('.wp-workshop input[type="checkbox"]').click()`);await workshop('Activate built revision')
  await p.waitFor(`document.querySelector('.widget-status .wp-package')?.textContent.includes('Service 0')`)
  check('Explicit rebuilt activation repairs missing-generation installation',true)
  await p.eval(`document.querySelector('[data-app="widgetworkshop"] .ctl-close').click()`)
  await forkButton('Allow this revision');await p.waitFor(`window.__taskReads.length>0`)
  const logout=await latest()
  await p.eval(`import('/src/os/accountSpace.ts').then(m=>m.freezeAccount(false))`);await p.waitFor(`window.__taskReads[${logout}].signal.aborted`)
  await release(logout,'Logged out late reply');await sleep(80)
  check('Logout cancels shared task read and rejects stale private cache adoption',await task()===null)
  check('No unhandled browser exceptions',!p.errors.length,p.errors)
} catch(error) {
  console.log('Browser errors',p.errors)
  console.log('Review diagnostic',await p.eval(`({reads:window.__taskReads.map(r=>({signal:!!r.signal,aborted:r.signal?.aborted})),widgets:[...document.querySelectorAll('.wp-package')].map(e=>e.textContent)})`).catch(()=>null));throw error
} finally {await b.close();vite.kill('SIGTERM');rmSync(data,{recursive:true,force:true})}
if(failed)process.exitCode=1
