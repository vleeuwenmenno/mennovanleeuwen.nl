// Real cross-tab transaction exclusion, server metadata, identity replay and degraded storage.
// Synthetic accounts/data only; Chromium is muted by the repository CDP harness.
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Page } from './perf/cdp.ts'
const WT = process.env.WT ?? process.cwd(), PORT = Number(process.env.PORT ?? 5293)
const data = mkdtempSync('/tmp/mvlos-widget-review2-')
process.env.DATA_DIR = data
const { database, encrypt, sha256 } = await import(`${WT}/server/db.ts`)
const { launch, newPage, sleep } = await import(`${WT}/scripts/perf/cdp.ts`)
const now = Date.now(), sid = randomBytes(24).toString('hex'), login = 'widget-review2'
database().prepare('INSERT INTO users (id,github_id,login,github_token,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(1,1,login,encrypt('none'),now,now)
database().prepare('INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(sha256(sid),1,now,now+86400_000)
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
    if(path==='/api/state')return Promise.resolve(Response.json(window.__remote));
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
  const cookie=await newPage(b,1500,1000,'')
  for(const [name,value] of [['mvlos_sid',sid],['mvlos_login',login],['mvlos_uid','1']])await cookie.send('Network.setCookie',{name,value,url:origin})
  await cookie.close()
  // The exact review interleaving: C stops immediately before native setItem, holding the IDB
  // request event. A queues an operation; B consumes it and makes a newer edit while C is stopped.
  const A=await open(true),B=await open(),C=await open()
  try {
    await hydrate(B);await hydrate(C);await flush(B);await flush(C)
    const resume=await pause(C,'race-other'), before=await B.eval<number>('window.__writes.length')
    await set(A,'agenda',{days:1});await B.waitFor(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalConfigs.get().agenda?.days===1)`)
    await set(B,'agenda',{days:7})
    check('Paused native write excludes another tab consumption/save without Web Locks',await B.eval<number>('window.__writes.length')===before)
    await resume();await flush(B)
    const saved=await durable(B)
    check('After exclusion, durable data contains newer config and consumed receipt',saved.value.configs.agenda.value.days===7&&Object.keys(saved.value.consumed).length>0,saved)
    check('Unrelated concurrent writer survives serialized merge',saved.value.configs['race-other'].value.units==='f')
    await hydrate(A);await flush(A)
    check('Late hydration cannot replay consumed journal over days7',(await configs(A)).agenda.days===7)
    await reload(A)
    check('Reload cannot replay retained consumed journal',(await configs(A)).agenda.days===7)
    // A PUT acknowledgement is already in flight before C holds the gate again.
    await B.waitFor('window.__puts.length>0')
    const resumeAck=await pause(C,'ack-other'), ackBefore=await B.eval<number>('window.__writes.length')
    await B.eval(`window.__puts[0].release({updatedAt:100})`)
    await set(B,'ack-local',{units:'c'})
    await sleep(80)
    check('Server acknowledgement cannot write metadata outside transaction gate',await B.eval<number>('window.__writes.length')===ackBefore)
    await resumeAck();await flush(B)
    check('Acknowledgement merge retains local edit and prior consumption receipt',(await durable(B)).value.configs['ack-local'].value.units==='c'&&(await configs(B)).agenda.days===7)
    // A complete remote GET response and resulting storage-event adoption use the same boundary.
    const resumeRemote=await pause(C,'remote-other'), remoteBefore=await B.eval<number>('window.__writes.length')
    await B.eval(`window.__remote={'widgets:state:v2':{value:{schema:2,configs:{'remote-only':{at:1000,value:{days:3}}},placements:{places:{},removed:''},installations:{}},updatedAt:200}};window.__pullDone=false;void import('/src/os/synced.ts').then(m=>m.pullAll()).then(()=>window.__pullDone=true)`)
    await B.waitFor(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalConfigs.get()['remote-only']?.days===3)`)
    check('Remote adoption waits for gate before writing canonical metadata',await B.eval<number>('window.__writes.length')===remoteBefore)
    await resumeRemote();await B.waitFor('window.__pullDone');await flush(B);await flush(A)
    check('Remote and storage-event merges preserve newer local values and receipts',(await configs(A)).agenda.days===7&&(await configs(A))['remote-only'].days===3&&(await durable(B)).base>=200)
    // Two push timers can both wait on a blocked durable flush. Reacquiring the per-store
    // in-flight claim after that await must still admit exactly one HTTP write.
    const resumePush=await pause(C,'push-holder')
    await B.eval(`(async()=>{const s=await import('/src/os/synced.ts'),t=await import('/src/os/storageTransaction.ts');window.__serialized=s.synced('review2-serialized',{}, {serialize:t.storageTransaction,merge:(a,b)=>({...b,...a}),mergeTabs:true});window.__serialized.set({one:1})})()`)
    await sleep(900)
    await B.eval(`window.__serialized.set(v=>({...v,two:2}))`);await sleep(900)
    await resumePush();await B.eval(`window.__serialized.flush()`)
    await B.waitFor(`window.__puts.some(p=>p.path.endsWith('review2-serialized'))`);await sleep(100)
    const sends=await B.eval<any[]>(`window.__puts.filter(p=>p.path.endsWith('review2-serialized')).map(p=>p.body)`)
    check('Overlapping push timers after serialized flush keep one in-flight request',sends.length===1,sends)
    check('Serialized push sends the latest combined edits',sends[0]?.value.one===1&&sends[0]?.value.two===2,sends)
    check('Controlled three-tab race has no browser exceptions',[A,B,C].every(p=>!p.errors.length),[...A.errors,...B.errors,...C.errors])
  } finally {for(const p of [A,B,C]){await p.send('Debugger.resume').catch(()=>{});await p.close()}}

  const tombstone={ 'widgets:state:v2':{value:{schema:2,configs:{},placements:{places:{},removed:'remap-remove remap-move'},installations:{}},updatedAt:1} }
  const R=await open(true,tombstone)
  try {
    await R.eval(`import('/src/os/widgetPlaces.ts').then(m=>{m.placeWidgets(['remap-remove','remap-move'].map(id=>({id,kind:'status',x:50,y:60,w:300,h:260,vw:1500,vh:1000})));m.widgetPlaces.set(cur=>m.changeSet(cur,{'remap-move':{...cur.places['remap-move'],x:321,y:456,at:Date.now()}},['remap-remove']))})`)
    await hydrate(R);await flush(R)
    check('Queued add/remove does not resurrect a remapped identity',(await entries(R,'remap-remove')).length===0)
    const moved=await entries(R,'remap-move')
    check('Queued move addresses remapped original identity exactly once',moved.length===1&&moved[0].place.x===321&&moved[0].place.y===456,moved)
    const state=(await durable(R)).value, map=state.remaps[Object.keys(state.remaps)[0]]
    check('Durable writer mapping and remapped removal tombstone are stored together',!!map['remap-remove']&&state.placements.removed.split(' ').includes(map['remap-remove']))
    await reload(R)
    check('Reload retains moved identity and explicit removal',(await entries(R,'remap-remove')).length===0&&(await entries(R,'remap-move')).length===1&&(await entries(R,'remap-move'))[0].place.x===321)
    await R.eval(`import('/src/os/widgetPlaces.ts').then(m=>m.widgetPlaces.set(cur=>m.changeSet(cur,{},Object.entries(cur.places).filter(([,p])=>p.id==='remap-move').map(([key])=>key))))`)
    await flush(R);await reload(R)
    check('Later removal after remap/reload stays removed',(await entries(R,'remap-move')).length===0)
    check('Identity replay has no browser exceptions',!R.errors.length,R.errors)
  } finally {await R.close()}

  const D=await open(true,{},`localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets:state:v2',JSON.stringify({value:{schema:2,configs:{'move-seed':{at:7,value:{days:4}}},placements:{places:{},removed:''},installations:{}},base:4,dirty:true}));Object.defineProperty(window,'indexedDB',{value:{open(){throw new DOMException('Synthetic IDB denial','SecurityError')}},configurable:true});`)
  try {
    await set(D,'denied',{days:1});await hydrate(D)
    const error=await D.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalConfigs.flush().then(()=>'',e=>e.message))`)
    check('Unavailable transactional persistence refuses canonical writes',!!error&&(await durable(D))===null,error)
    check('IDB denial retains journal and usable optimistic widget data',await journalCount(D)>0&&(await configs(D)).denied.days===1)
    await D.eval(`import('/src/os/synced.ts').then(m=>{window.__ordinary=m.synced('review2-ordinary',0);window.__ordinary.set(7)})`)
    check('IDB denial preserves ordinary store synchronous persistence',await D.eval(`JSON.parse(localStorage.getItem('mvlos.u.1.sync.review2-ordinary')).value===7`))
  } finally {await D.close()}
  // Independent document with no IDB denial must recover the refused write from its journal.
  const recover=await open()
  try {
    await hydrate(recover);await flush(recover)
    check('Retained journal recovers after transactional storage becomes available',(await configs(recover)).denied.days===1)
    check('Deferred account transfer retains source envelope and merges pending edits',(await configs(recover))['move-seed'].days===4)
    await recover.eval(`localStorage.setItem('mvlos.sync.widgets:state:v2',JSON.stringify({value:{schema:2,configs:{'move-seed':{at:999,value:{days:99}}},placements:{places:{},removed:''},installations:{}},base:999,dirty:true}))`)
    await reload(recover)
    check('Completed account transfer never reimports a later old-client write',(await configs(recover))['move-seed'].days===4)
  }finally{await recover.close()}

  const Q=await open(true)
  try {
    await set(Q,'quota',{days:1});await Q.eval('window.__denyCanonical=true');await hydrate(Q)
    check('Refused localStorage write retains its journal',await journalCount(Q)>0&&(await durable(Q))===null)
    await Q.eval('window.__denyCanonical=false');await flush(Q)
    check('Transient storage denial retries without another edit',(await durable(Q)).value.configs.quota.value.days===1)
    check('Receipt cleanup follows successful persistence',await journalCount(Q)===0)
  } finally {await Q.close()}

  const blocked=await open(true,{},`Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Synthetic storage denial','SecurityError')}});`)
  try {
    await set(blocked,'memory',{days:3});await hydrate(blocked)
    check('Fully blocked localStorage keeps widget UI usable in memory',(await configs(blocked)).memory.days===3)
    const error=await blocked.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalConfigs.flush().then(()=>'',e=>e.message))`)
    check('Fully blocked localStorage reports refusal without a false durable success',!!error&&await blocked.eval('window.__writes.length===0'))
    check('Fully blocked storage has no unhandled browser exceptions',!blocked.errors.length,blocked.errors)
  } finally {await blocked.close()}

  const S=await open(true),T=await open()
  try {
    await hydrate(S);await hydrate(T);await flush(S);await flush(T)
    // No explicit freeze: changing the browser account is discovered by the queued write's
    // guard when its request event finally acquires the gate.
    for(const p of [S,T])await p.eval(`sessionStorage.setItem('review2-switch','1')`)
    await pause(S,'cookie-holder')
    await set(T,'old-account-forbidden',{days:2})
    await T.eval(`document.cookie='mvlos_uid=2;path=/'`)
    await S.send('Debugger.resume')
    await T.waitFor(`document.cookie.includes('mvlos_uid=2')&&!!window.__releaseMe&&!!document.querySelector('.desktop')`,90_000)
    await T.waitFor(`import('/src/os/accountSpace.ts').then(m=>m.TAB_UID==='2')`,90_000)
    check('Cookie account switch cancels queued old-account persistence',await T.eval(`!JSON.parse(localStorage.getItem(${JSON.stringify(key)})).value.configs['old-account-forbidden']`))
    check('Account switch never redirects old state into the new account space',await T.eval(`localStorage.getItem('mvlos.u.2.sync.widgets:state:v2')===null`))
  } finally {
    await S.send('Debugger.resume').catch(()=>{});await S.close();await T.close()
    const cookie=await newPage(b,1500,1000,'');await cookie.send('Network.setCookie',{name:'mvlos_uid',value:'1',url:origin});await cookie.close()
  }

  const L=await open(true),F=await open()
  try {
    await hydrate(L);await hydrate(F);await flush(L);await flush(F)
    const resume=await pause(L,'before-freeze')
    await set(F,'must-not-save',{days:1})
    await F.eval(`import('/src/os/accountSpace.ts').then(m=>m.freezeAccount(false))`)
    await resume()
    const error=await F.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalConfigs.flush().then(()=>'',e=>e.message))`)
    check('Revocation cancels queued persistence before any durable write',!!error&&!Object.hasOwn((await durable(L)).value.configs,'must-not-save'),error)
    // Logout cleanup is intentionally permitted after revocation, but follows every earlier
    // running writer. It cannot clear first and then let the paused writer recreate the envelope.
    const resumeCleanup=await pause(L,'before-cleanup')
    await F.eval(`window.__cleared=false;void import('/src/os/accountSpace.ts').then(m=>m.clearAccountSpace()).then(()=>window.__cleared=true)`)
    await sleep(80);check('Logout cleanup waits behind an already-running writer',!await F.eval('window.__cleared'))
    await resumeCleanup();await F.waitFor('window.__cleared')
    check('Logout cleanup cannot be undone by the earlier paused write',(await durable(F))===null&&await journalCount(F)===0)
    check('Degraded storage and revocation create no unhandled browser exceptions',!Q.errors.length&&!D.errors.length&&!F.errors.length&&!L.errors.length,[...Q.errors,...D.errors,...F.errors,...L.errors])
  } finally {for(const p of [L,F]){await p.send('Debugger.resume').catch(()=>{});await p.close()}}
} finally {await b.close();vite.kill('SIGTERM');rmSync(data,{recursive:true,force:true})}
console.log(`${passed} passed, ${failed} failed`)
if(failed)process.exitCode=1
