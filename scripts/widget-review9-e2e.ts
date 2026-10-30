// Real cross-tab transaction exclusion, server metadata, identity replay and degraded storage.
// Synthetic accounts/data only; Chromium is muted by the repository CDP harness.
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { Page } from './perf/cdp.ts'
const WT = process.env.WT ?? process.cwd(), PORT = Number(process.env.PORT ?? 5293)
const data = mkdtempSync('/tmp/mvlos-widget-review2-')
process.env.DATA_DIR = data
const { database, encrypt, sha256 } = await import(`${WT}/server/db.ts`)
const { launch, newPage, sleep } = await import(`${WT}/scripts/perf/cdp.ts`)
const now = Date.now(), sid = randomBytes(24).toString('hex'), login = 'widget-review2'
database().prepare('INSERT INTO users (id,github_id,login,github_token,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(1,1,login,encrypt('none'),now,now)
database().prepare('INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(sha256(sid),1,now,now+86400_000)
const sid2 = randomBytes(24).toString('hex');
database().prepare('INSERT INTO users (id,github_id,login,github_token,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(2,2,'widget-review6-b',encrypt('none'),now,now);
database().prepare('INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(sha256(sid2),2,now,now+86400_000);
const vite = spawn(`${WT}/node_modules/.bin/vite`, ['--port',String(PORT),'--strictPort'], {
  cwd:WT, env:{...process.env,DATA_DIR:data,GITHUB_CLIENT_ID:'x',GITHUB_CLIENT_SECRET:'x',ADMIN_USERS:'nobody',MC_WATCH:'off'}, stdio:['ignore','pipe','pipe'],
})
for (const sig of ['SIGINT','SIGTERM','SIGHUP','SIGPIPE'] as const) process.on(sig,()=>{vite.kill();process.exit(1)})
let log = '', failed = 0, passed = 0
vite.stdout.on('data',d=>log+=d);vite.stderr.on('data',d=>log+=d)
const origin = `http://127.0.0.1:${PORT}`, key = 'mvlos.u.1.sync.widgets:state:v2'
for(let i=0;i<150&&!log.includes('ready')&&vite.exitCode===null;i++)await sleep(200)
if(!log.includes('ready')||vite.exitCode!==null){vite.kill();throw Error(log)}
const b = await launch(1500,1000)
const check = (what:string,ok:boolean,detail?:unknown)=>{console.log(ok?'PASS':'FAIL',what,ok?'':JSON.stringify(detail));ok?passed++:failed++}
const inject = (reset=false, remote:unknown={}, extra='')=>`(()=>{
  ${reset?"if(!sessionStorage.getItem('review2-reset')){localStorage.clear();sessionStorage.setItem('review2-reset','1')}":''}
  window.__document=crypto.randomUUID();window.__remote=${JSON.stringify(remote)};window.__writes=[];window.__puts=[];
  // All tabs use the same IDB protocol even when Web Locks is absent.
  Object.defineProperty(navigator,'locks',{value:undefined,configurable:true});
  ${extra}
  const native=fetch.bind(window);window.fetch=(input,options)=>{
    const path=String(input);
    if(path==='/api/me')return new Promise((resolve,reject)=>{window.__releaseMe=()=>native(input,options).then(resolve,reject)});
    if(path==='/api/state')return window.__holdState?new Promise(()=>{}):Promise.resolve(Response.json(window.__remote));
    if(path.startsWith('/api/state/'))return new Promise(resolve=>window.__puts.push({path,body:JSON.parse(options.body),release:reply=>resolve(Response.json(reply))}));
    if(path.startsWith('/api/')&&sessionStorage.getItem('review2-switch'))return Promise.resolve(Response.json({}));
    return native(input,options);
  };
  const set=Storage.prototype.setItem;
  Storage.prototype.setItem=function(k,v){
    if(k.endsWith('sync.widgets:state:v2')){
      if(window.__denyCanonical)throw new DOMException('Synthetic quota','QuotaExceededError');
      if(window.__pauseWrite){window.__pauseWrite=false;debugger;}
      const answer=set.call(this,k,v);window.__writes.push(JSON.parse(v));return answer;
    }
    return set.call(this,k,v);
  };
})()`
const open = async (reset=false,remote:unknown={},extra='')=>{
  const p=await newPage(b,1500,1000,inject(reset,remote,extra))
  await p.send('Page.navigate',{url:origin});await p.waitFor(`document.querySelector('.desktop')&&!document.querySelector('.boot')&&!!window.__releaseMe`,90_000)
  return p
}
const hydrate = async (p:Page)=>{await p.eval('window.__releaseMe()');await p.waitFor(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.widgetsHydrated())`)}
const flush = (p:Page)=>p.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalConfigs.flush())`)
const configs = (p:Page)=>p.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalConfigs.get())`)
const set = (p:Page,id:string,value:unknown)=>p.eval(`import('/src/widgets/config.ts').then(m=>m.setWidgetConfig(${JSON.stringify(id)},${JSON.stringify(value)}))`)
const durable = (p:Page)=>p.eval(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))`)
const reload = async (p:Page)=>{
  const id=await p.eval<string>('window.__document');await p.send('Page.reload')
  await p.waitFor(`window.__document!==${JSON.stringify(id)}&&document.querySelector('.desktop')&&!document.querySelector('.boot')&&!!window.__releaseMe`,90_000)
  await hydrate(p);await flush(p)
}
let onPause: (()=>void)|undefined
b.on(m=>{if(m.method==='Debugger.paused')onPause?.()})
const pause = async (p:Page,id:string)=>{
  await p.send('Debugger.enable')
  const paused=new Promise<void>(resolve=>onPause=resolve)
  await p.eval('window.__pauseWrite=true')
  const edit=set(p,id,{units:'f'});void edit.catch(()=>{})
  await Promise.race([paused,sleep(4000).then(()=>{throw Error('native canonical write did not pause')})])
  return async()=>{onPause=undefined;await p.send('Debugger.resume');await edit;await flush(p)}
}
const journalCount = (p:Page)=>p.eval<number>(`Object.keys(localStorage).filter(k=>k.startsWith('mvlos.u.1.widgets.pending:v2:')).length`)
const entries = (p:Page,id:string)=>p.eval<any[]>(`import('/src/os/widgetPlaces.ts').then(m=>m.entriesOf(m.widgetPlaces.get(),${JSON.stringify(id)}))`)

try {
  const control=await newPage(b,1500,1000,'');
  await control.send('Page.navigate',{url:origin+'/package.json'});
  for (const [name,value]of [['mvlos_sid',sid],['mvlos_login',login],['mvlos_uid','1']]) await control.send('Network.setCookie',{name,value,url:origin});
  const source=JSON.stringify({value:{schema:2,configs:{'private-note':{at:1,value:{text:'SYNTHETIC-SAVED-NOTE'}}},placements:{places:{},removed:''},installations:{}},base:0,dirty:true});
  const observe=(p:Page)=>p.eval(`(async()=>{const m=await import('/src/widgets/platform/canonicalState.ts');const a=await import('/src/os/accountSpace.ts');return {ready:m.widgetsHydrated(),unresolved:a.widgetMigrationUnresolved(),configs:m.canonicalConfigs.get(),target:localStorage.getItem('mvlos.u.1.sync.widgets:state:v2'),plainPlan:localStorage.getItem('mvlos.u.1.widget-move:plain:v2'),guestPlan:localStorage.getItem('mvlos.u.1.widget-move:guest:v2'),done:localStorage.getItem('mvlos.u.1.widget-move:plain:done:v2'),moved:localStorage.getItem('mvlos.u.1.moved'),ordinary:localStorage.getItem('mvlos.u.1.sync.widgets')}})()`);
  const release=async(p:Page)=>{await p.eval('window.__releaseMe()');await p.waitFor(`import('/src/os/account.ts').then(m=>!!m.getAccount().user)`);await sleep(500)};
  const restart=async(p:Page)=>{const id=await p.eval('window.__document');await p.send('Page.reload');await p.waitFor(`window.__document!==${JSON.stringify(id)}&&!!window.__releaseMe`);await release(p)};

  const layout = [{app:'widget',props:{id:'private-note',kind:'sticky'},x:91,y:72,w:280,h:200}];
  for (const scenario of ['partial-remote-layout', 'partial-local-layout']) {
    await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets',JSON.stringify({value:{'private-note':{text:'SYNTHETIC-SAVED-NOTE'}},base:0,dirty:true}));localStorage.setItem('mvlos.sync.windows:desktop',JSON.stringify({value:${JSON.stringify(layout)},base:0,dirty:true}))`);
    const p=await open(false,scenario==='partial-remote-layout'?{'windows:desktop':{value:layout,updatedAt:99}}:{},`const base=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='mvlos.u.1.moved'&&!sessionStorage.getItem('one-failure')){sessionStorage.setItem('one-failure','1');throw new DOMException('One synthetic storage failure','QuotaExceededError')}return base.call(this,k,v)}`);
    try {
      await release(p);
      if (scenario==='partial-local-layout') await p.eval(`import('/src/os/wm.tsx').then(m=>m.layoutStore().set([]))`);
      let evidence={...await observe(p),layout:await p.eval(`localStorage.getItem('mvlos.u.1.sync.windows:desktop')`)};
      console.log(scenario,'first',JSON.stringify(evidence));
      check(scenario+' blocks partial cutover',!evidence.ready&&evidence.unresolved,evidence);
      await restart(p); evidence={...await observe(p),layout:await p.eval(`localStorage.getItem('mvlos.u.1.sync.windows:desktop')`)};
      console.log(scenario,'reload',JSON.stringify(evidence));
      check(scenario+' reload completes migration',evidence.ready&&!evidence.unresolved,evidence);
      check(scenario+' preserves imported note',evidence.configs['private-note']?.text==='SYNTHETIC-SAVED-NOTE',evidence)
      const layoutAfter=JSON.parse(evidence.layout)
      check(scenario+' preserves newer account layout',scenario==='partial-local-layout'?layoutAfter.value.length===0:layoutAfter.base===99,layoutAfter)
    } finally {await p.close()}
  }
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets',JSON.stringify({value:{'private-note':{text:'SYNTHETIC-SAVED-NOTE'}},base:0,dirty:true}));localStorage.setItem('mvlos.sync.windows:desktop',JSON.stringify({value:${JSON.stringify(layout)},base:0,dirty:true}));localStorage.setItem('mvlos.u.1.sync.windows:desktop',JSON.stringify({value:${JSON.stringify(layout)},base:99,dirty:false}))`)
  const priorPartial=await open()
  try {
    await release(priorPartial);const value=await observe(priorPartial)
    const preserved=await priorPartial.eval(`JSON.parse(localStorage.getItem('mvlos.u.1.sync.windows:desktop'))`)
    check('Earlier partial copy with matching value and newer metadata recovers',value.ready&&value.configs['private-note']?.text==='SYNTHETIC-SAVED-NOTE'&&preserved.base===99,value)
  } finally {await priorPartial.close()}
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.owner','other-owner');localStorage.setItem('mvlos.legacy-owner-claim:v1',JSON.stringify({owner:'2',marker:'other-owner'}));localStorage.setItem('mvlos.visitor.sync.widgets',JSON.stringify({value:{'private-note':{text:'SYNTHETIC-SAVED-NOTE'}},base:0,dirty:true}));localStorage.setItem('mvlos.visitor.sync.windows:desktop',JSON.stringify({value:${JSON.stringify(layout)},base:0,dirty:true}))`)
  const visitor=await open(false,{},`const raw=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='mvlos.u.1.sync.windows:desktop'){window.__layoutWrites=window.__layoutWrites||[];window.__layoutWrites.push({v,stack:new Error().stack})}return raw.call(this,k,v)}`)
  try {
    await release(visitor);let value=await observe(visitor)
    check('Foreign older claim retains ordinary visitor note',value.configs['private-note']?.text==='SYNTHETIC-SAVED-NOTE',value)
    const layoutEvidence=await visitor.eval(`(async()=>({places:(await import('/src/os/widgetPlaces.ts')).widgetPlaces.get(),legacy:localStorage.getItem('mvlos.u.1.sync.windows:desktop'),canonical:localStorage.getItem('mvlos.u.1.sync.widgets:state:v2'),writes:window.__layoutWrites}))()`)
    check('Foreign older claim retains ordinary visitor layout',Object.values(layoutEvidence.places.places).some((p:any)=>p.id==='private-note'),layoutEvidence)
    await restart(visitor);value=await observe(visitor)
    check('Visitor note survives reload with foreign older claim',value.configs['private-note']?.text==='SYNTHETIC-SAVED-NOTE',value)
  } finally {await visitor.close()}
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.u.1.moved','1');localStorage.setItem('mvlos.u.1.sync.widgets',JSON.stringify({value:{'private-note':{text:'SYNTHETIC-SAVED-NOTE'}},base:0,dirty:true}))`)
  const readFailure=await open(false,{},`const base=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k==='mvlos.u.1.sync.widgets'&&!sessionStorage.getItem('one-failure')){sessionStorage.setItem('one-failure','1');throw new DOMException('One synthetic read failure','SecurityError')}return base.call(this,k)}`)
  try {
    await release(readFailure);let value=await observe(readFailure)
    check('Scoped read failure cannot cause empty cutover',!value.ready||value.configs['private-note']?.text==='SYNTHETIC-SAVED-NOTE',value)
    await restart(readFailure);value=await observe(readFailure)
    check('Scoped legacy source recovers after read failure',value.configs['private-note']?.text==='SYNTHETIC-SAVED-NOTE',value)
  } finally {await readFailure.close()}
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.u.1.moved','1');localStorage.setItem('mvlos.u.1.sync.widgets',JSON.stringify({value:{'private-note':{text:'SYNTHETIC-SAVED-NOTE'}},base:0,dirty:true}))`)
  const duringHydration=await open(false,{},`const base=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k==='mvlos.u.1.sync.widgets'&&window.__failHydrationRead){window.__failHydrationRead=false;sessionStorage.setItem('hydration-failed','1');throw new DOMException('One hydration read failure','SecurityError')}return base.call(this,k)}`)
  try {
    await duringHydration.eval(`window.__failHydrationRead=true;window.__releaseMe()`)
    await duringHydration.waitFor(`sessionStorage.getItem('hydration-failed')==='1'&&import('/src/widgets/platform/canonicalState.ts').then(m=>m.widgetsHydrated())`,10000)
    const value=await observe(duringHydration)
    check('Hydration retries transient scoped read without empty cutover',value.configs['private-note']?.text==='SYNTHETIC-SAVED-NOTE',value)
  } finally {await duringHydration.close()}
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.u.1.moved','1');localStorage.setItem('mvlos.u.1.sync.widgets',JSON.stringify({value:{'private-note':{text:'SYNTHETIC-SAVED-NOTE'}},base:0,dirty:true}))`)
  const guardRead=await open(false,{},`const base=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k==='mvlos.u.1.widget-move:guest:v2'&&window.__failGuardRead){window.__failGuardRead=false;sessionStorage.setItem('guard-read-failed','1');throw new DOMException('One guard read failure','SecurityError')}return base.call(this,k)}`)
  try {
    await guardRead.eval(`window.__failGuardRead=true;window.__releaseMe()`)
    await guardRead.waitFor(`sessionStorage.getItem('guard-read-failed')==='1'&&import('/src/widgets/platform/canonicalState.ts').then(m=>m.widgetsHydrated())`,10000)
    const value=await observe(guardRead)
    check('Hydration retries an unavailable migration-state read',value.configs['private-note']?.text==='SYNTHETIC-SAVED-NOTE',value)
  } finally {await guardRead.close()}
  const journal=JSON.stringify({operations:{'prior-writer:1':{writer:'prior-writer',sequence:1,at:42,delta:{configs:{'journal-note':{at:42,patch:{text:'PENDING'},unset:[]}},placements:{places:{},removed:''},added:[],installations:{}}}}})
  for(const failure of ['read','enumerate']) {
    await control.eval(`localStorage.clear();localStorage.setItem('mvlos.u.1.moved','1');localStorage.setItem('mvlos.u.1.widgets.pending:v2:prior-writer',${JSON.stringify(journal)})`)
    const injected=failure==='read'?`const base=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k==='mvlos.u.1.widgets.pending:v2:prior-writer'&&!sessionStorage.getItem('one-failure')){sessionStorage.setItem('one-failure','1');throw new DOMException('One synthetic read failure','SecurityError')}return base.call(this,k)}`:`const base=Storage.prototype.key;Storage.prototype.key=function(i){if(this===localStorage&&!sessionStorage.getItem('one-failure')){sessionStorage.setItem('one-failure','1');throw new DOMException('One synthetic enumeration failure','SecurityError')}return base.call(this,i)}`
    const page=await open(false,{},injected)
    try {
      await release(page);let value=await observe(page)
      check('Journal '+failure+' failure never admits empty cutover',!value.ready||value.configs['journal-note']?.text==='PENDING',value)
      await restart(page);value=await observe(page)
      check('Journal '+failure+' recovers its pending edit',value.configs['journal-note']?.text==='PENDING',value)
    } finally {await page.close()}
  }
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.u.1.moved','1');localStorage.setItem('mvlos.u.1.sync.widgets:state:v2',JSON.stringify({value:{schema:2,configs:{},placements:{places:{},removed:''},installations:{}},base:0,dirty:true}));localStorage.setItem('mvlos.u.1.widgets.pending:v2:prior-writer',${JSON.stringify(journal)})`)
  const existingJournal=await open(false,{},`const base=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k==='mvlos.u.1.widgets.pending:v2:prior-writer'&&!sessionStorage.getItem('one-failure')){sessionStorage.setItem('one-failure','1');throw new DOMException('One synthetic journal read failure','SecurityError')}return base.call(this,k)}`)
  try {
    const before=await observe(existingJournal)
    check('Existing canonical state is not declared ready after journal read failure',!before.ready,before)
    await release(existingJournal);await existingJournal.waitFor(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.widgetsHydrated())`,10000)
    const value=await observe(existingJournal)
    check('Existing canonical state recovers the unread journal',value.configs['journal-note']?.text==='PENDING',value)
  } finally {await existingJournal.close()}
  for(const method of ['getItem','setItem']) {
    await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets',JSON.stringify({value:{'private-note':{text:'SYNTHETIC-SAVED-NOTE'}},base:0,dirty:true}))`)
    const page=await open(false,{},`const base=Storage.prototype[${JSON.stringify(method)}];Storage.prototype[${JSON.stringify(method)}]=function(k,...args){if(k==='mvlos.u.1.legacy-copy:v2:mvlos.sync.widgets'&&!sessionStorage.getItem('one-failure')){sessionStorage.setItem('one-failure','1');throw new DOMException('One synthetic provenance failure','SecurityError')}return base.call(this,k,...args)}`)
    try {
      await release(page);let value=await observe(page)
      check('Provenance '+method+' failure prevents empty cutover',!value.ready&&value.unresolved,value)
      await restart(page);value=await observe(page)
      check('Provenance '+method+' retries without losing source',value.configs['private-note']?.text==='SYNTHETIC-SAVED-NOTE',value)
    } finally {await page.close()}
  }
  await control.close();
} finally {await b.close();vite.kill('SIGTERM');rmSync(data,{recursive:true,force:true})}
console.log(`${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
