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
const sid2 = randomBytes(24).toString('hex')
database().prepare('INSERT INTO users (id,github_id,login,github_token,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(2,2,'widget-review6-b',encrypt('none'),now,now)
database().prepare('INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(sha256(sid2),2,now,now+86400_000)
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

  const toggle=await open(true),holder=await open()
  try {
    await hydrate(toggle);await hydrate(holder);await flush(toggle);await flush(holder)
    await set(toggle,'rapid',{units:'c'});await flush(toggle)
    const resume=await pause(holder,'toggle-holder')
    await toggle.eval(`(async()=>{const s=await import('/src/widgets/platform/canonicalState.ts');s.canonicalConfigs.set(v=>({...v,rapid:{units:'f'}}));s.canonicalConfigs.set(v=>({...v,rapid:{units:v.rapid.units==='f'?'c':'wrong'}}));s.canonicalConfigs.set(v=>{const n={...v};delete n.rapid;return n});s.canonicalConfigs.set(v=>({...v,rapid:{units:'c'}}))})()`)
    check('Functional updates see pending set and removal',(await configs(toggle)).rapid?.units==='c')
    await resume();await flush(toggle);await reload(toggle)
    check('Pending toggle and removal/re-add survive gate and reload',(await configs(toggle)).rapid?.units==='c')
  } finally {await holder.send('Debugger.resume').catch(()=>{});await toggle.close();await holder.close()}

  const quotaChain=await open(true)
  try {
    await hydrate(quotaChain);await flush(quotaChain);await quotaChain.eval('window.__denyCanonical=true')
    await set(quotaChain,'failed-first',{days:3})
    await quotaChain.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalConfigs.flush().catch(()=>{}))`)
    await set(quotaChain,'failed-second',{days:7})
    await quotaChain.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalConfigs.flush().catch(()=>{}))`)
    const sequences=await quotaChain.eval<number[]>(`Object.keys(localStorage).filter(k=>k.includes('widgets.pending:v2:')).flatMap(k=>Object.values(JSON.parse(localStorage.getItem(k)).operations).map(o=>o.sequence)).sort()`)
    check('Failed canonical writes retain complete journal prefix',sequences.join(',')==='1,2',sequences)
    await quotaChain.send('Page.navigate',{url:'about:blank'})
    const retry=await open()
    try { await hydrate(retry);await flush(retry);const value=await configs(retry);check('Failed writes recover both edits after navigation',value['failed-first']?.days===3&&value['failed-second']?.days===7,value) } finally {await retry.close()}
  } finally {await quotaChain.close()}

  // A ready writer must leave a durable journal before returning, even while another tab owns
  // the gate and the writer is immediately navigated away.
  const H=await open(true),N=await open()
  try {
    await hydrate(H);await hydrate(N);await flush(H);await flush(N)
    const resume=await pause(H,'navigation-holder')
    await set(N,'navigation',{days:7})
    check('Ready edit is journalled before its caller returns',await journalCount(N)>0)
    await N.send('Page.navigate',{url:'about:blank'})
    await resume()
    const reopened=await open()
    try { await hydrate(reopened);await flush(reopened);check('Navigation during blocked persistence recovers accepted edit',(await configs(reopened)).navigation?.days===7) }
    finally {await reopened.close()}
  } finally {await H.send('Debugger.resume').catch(()=>{});await H.close();await N.close()}

  const activation=await open(true,{},`window.__holdState=true;const rawSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.includes('widgets.pending:v2:'))throw new DOMException('Synthetic quota','QuotaExceededError');return rawSet.call(this,k,v)}`)
  try {
    await activation.eval('window.__releaseMe()');await activation.waitFor(`import('/src/os/account.ts').then(m=>!!m.getAccount().user)`)
    const error=await activation.eval(`(async()=>{const i=await import('/src/widgets/platform/installations.ts'),d=await import('/src/widgets/platform/defaults.ts');try{await i.activate('activation-test','status',{source:{kind:'system',path:'/usr/share/mvlos/widgets/status'},snapshot:await d.defaultBuild('status')},0);return ''}catch(e){return e.message}})()`)
    check('Activation rejects before hydration when journal storage is unavailable',!!error&&await journalCount(activation)===0&&(await durable(activation))===null,error)
  } finally {await activation.close()}
  const quotaActivation=await open(true)
  try {
    await hydrate(quotaActivation);await flush(quotaActivation)
    const error=await quotaActivation.eval(`(async()=>{const i=await import('/src/widgets/platform/installations.ts'),d=await import('/src/widgets/platform/defaults.ts');const snapshot=await d.defaultBuild('status');const raw=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.includes('widgets.pending:v2:'))throw new DOMException('Synthetic quota','QuotaExceededError');return raw.call(this,k,v)};try{await i.activate('activation-quota','status',{source:{kind:'system',path:'/usr/share/mvlos/widgets/status'},snapshot},0);return ''}catch(e){return e.message}})()`)
    check('Hydrated activation rejects when its journal write fails',error.includes('journal write refused')&&!(await quotaActivation.eval(`import('/src/widgets/platform/installations.ts').then(m=>m.installation('activation-quota'))`)),error)
  } finally {await quotaActivation.close()}

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

  // Mirror WM: keys are captured before another tab remaps the additions, and passed to an
  // updater only after that remap became durable.
  const G=await open(true,tombstone),M=await open(false,tombstone)
  try {
    await G.eval(`import('/src/os/widgetPlaces.ts').then(m=>{m.placeWidgets(['remap-remove','remap-move'].map(id=>({id,kind:'status',x:10,y:20,w:300,h:260,vw:1500,vh:1000})));window.__captured=Object.fromEntries(['remap-remove','remap-move'].map(id=>[id,m.entriesOf(m.widgetPlaces.get(),id)[0]]))})`)
    await hydrate(M);await flush(M)
    await G.eval(`import('/src/os/widgetPlaces.ts').then(m=>{const a=window.__captured;m.widgetPlaces.set(cur=>m.changeSet(cur,{[a['remap-move'].key]:{...a['remap-move'].place,x:321,y:456,at:Date.now()}},[a['remap-remove'].key]))})`)
    await hydrate(G);await flush(G);await reload(G)
    const moved=await entries(G,'remap-move')
    check('Captured WM keys resolve after another tab persists remaps',moved.length===1&&moved[0].place.x===321&&moved[0].place.y===456&&(await entries(G,'remap-remove')).length===0,moved)
  } finally {await G.close();await M.close()}

  const D=await open(true,{},`localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets:state:v2',JSON.stringify({value:{schema:2,configs:{'move-seed':{at:7,value:{days:4}}},placements:{places:{},removed:''},installations:{}},base:4,dirty:true}));Object.defineProperty(window,'indexedDB',{value:{open(){throw new DOMException('Synthetic IDB denial','SecurityError')}},configurable:true});`)
  try {
    await set(D,'denied',{days:1});await hydrate(D)
    const error=await D.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalConfigs.flush().then(()=>'',e=>e.message))`)
    check('Unavailable transactional persistence refuses canonical writes',!!error&&(await durable(D))===null,error)
    check('IDB denial retains journal and usable optimistic widget data',await journalCount(D)>0&&(await configs(D)).denied.days===1)
    check('Failed plain transfer retains ownership marker',await D.eval(`localStorage.getItem('mvlos.account')==='1'`))
    await D.eval(`import('/src/os/synced.ts').then(m=>{window.__ordinary=m.synced('review2-ordinary',0);window.__ordinary.set(7)})`)
    check('IDB denial preserves ordinary store synchronous persistence',await D.eval(`JSON.parse(localStorage.getItem('mvlos.u.1.sync.review2-ordinary')).value===7`))
  } finally {await D.close()}
  const guestCookie=await newPage(b,1500,1000,'');await guestCookie.send('Network.deleteCookies',{name:'mvlos_uid',url:origin});await guestCookie.close()
  const guest=await open()
  try { await sleep(300);check('Visitor cannot import retained account-owned plain envelope',await guest.eval(`localStorage.getItem('mvlos.visitor.sync.widgets:state:v2')===null&&localStorage.getItem('mvlos.account')==='1'`)) }
  finally {await guest.close()}
  const ownerCookie=await newPage(b,1500,1000,'');await ownerCookie.send('Network.setCookie',{name:'mvlos_uid',value:'1',url:origin});await ownerCookie.close()
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

  // Legacy tabs bypass the IDB gate. Stop the importing tab just after its copy, then let a
  // second tab replace the plain source before migration completes.
  const legacy=await newPage(b,1500,1000,'');await legacy.send('Page.navigate',{url:origin+'/package.json'})
  const legacySource=(owner:string,days:number)=>JSON.stringify({value:{schema:2,configs:{[owner]:{at:days,value:{days}}},placements:{places:{},removed:''},installations:{}},base:days,dirty:true})
  for(const retry of [false,true]) for(const foreignOwner of [false,true]) {
    const initial=legacySource('owner1',1),replacement=legacySource(foreignOwner?'owner2':'owner1',7),marker=foreignOwner?'2':'1'
    await legacy.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets:state:v2',${JSON.stringify(initial)})`)
    if(retry){const denied=await open(false,{},`Object.defineProperty(window,'indexedDB',{value:{open(){throw new DOMException('Synthetic IDB denial','SecurityError')}},configurable:true});`);await denied.close()}
    const mover=await newPage(b,1500,1000,inject(false,{},`const nativeSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){const result=nativeSet.call(this,k,v);if(k==='mvlos.u.1.sync.widgets:state:v2'&&!window.__migrationPaused){window.__migrationPaused=true;debugger}return result}`))
    try {
      await mover.send('Debugger.enable');const stopped=new Promise<void>(resolve=>onPause=resolve)
      await mover.send('Page.navigate',{url:origin});await Promise.race([stopped,sleep(15000).then(()=>{throw Error('migration copy did not pause')})])
      await legacy.eval(`localStorage.setItem('mvlos.account',${JSON.stringify(marker)});localStorage.setItem('mvlos.sync.widgets:state:v2',${JSON.stringify(replacement)})`)
      onPause=undefined;await mover.send('Debugger.resume');await mover.send('Debugger.disable');await mover.waitFor(`document.querySelector('.desktop')&&!document.querySelector('.boot')&&!!window.__releaseMe`,90000)
      await mover.eval(`import('/src/os/storageTransaction.ts').then(m=>m.storageTransaction(()=>{}))`)
      const result=await legacy.eval(`({source:localStorage.getItem('mvlos.sync.widgets:state:v2'),marker:localStorage.getItem('mvlos.account'),target:JSON.parse(localStorage.getItem(${JSON.stringify(key)})),done:localStorage.getItem('mvlos.u.1.widget-move:plain:done:v2')})`)
      check(`${retry?'Retry':'Initial'} migration retains ${foreignOwner?'foreign':'same'} owner replacement`,result.source===replacement&&result.marker===marker&&result.target?.value.configs.owner1.value.days===1&&result.done==='1',result)
      await hydrate(mover);await flush(mover);await reload(mover)
      check('Reload does not replay replacement into canonical state',(await configs(mover)).owner1?.days===1&&!(await configs(mover)).owner2)
      await mover.eval(`(async()=>{const a=await import('/src/os/accountSpace.ts');a.freezeAccount(false);await a.clearAccountSpace()})()`)
      const ownerGone=await legacy.eval(`localStorage.getItem('mvlos.u.1.moved')==='1'&&localStorage.getItem('mvlos.u.1.widget-move:plain:done:v2')==='1'&&localStorage.getItem('mvlos.sync.widgets:state:v2')===${JSON.stringify(replacement)}&&localStorage.getItem('mvlos.account')===${JSON.stringify(marker)}`)
      check('Logout retains cutover receipt, source and ownership',ownerGone)
      const change=await newPage(b,1500,1000,'');await change.send('Network.deleteCookies',{name:'mvlos_uid',url:origin});await change.close()
      const visitor=await open()
      try {await visitor.eval(`import('/src/os/storageTransaction.ts').then(m=>m.storageTransaction(()=>{}))`);check('Visitor cannot import retained account source',await visitor.eval(`localStorage.getItem('mvlos.visitor.sync.widgets:state:v2')===null`))} finally {await visitor.close()}
      const restore=await newPage(b,1500,1000,'');await restore.send('Network.setCookie',{name:'mvlos_uid',value:'1',url:origin});await restore.close()
      const returning=await open()
      try {await returning.eval(`import('/src/os/storageTransaction.ts').then(m=>m.storageTransaction(()=>{}))`);check('Sign-in after logout cannot reimport retained legacy source',await returning.eval(`localStorage.getItem(${JSON.stringify(key)})===null`))} finally {await returning.close()}
    } finally {onPause=undefined;await mover.send('Debugger.resume').catch(()=>{});await mover.close()}
  }
  await legacy.close()

  const stale=await open(true,{},`localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets:state:v2','owner-one');Object.defineProperty(window,'indexedDB',{value:{open(){throw new DOMException('Synthetic IDB denial','SecurityError')}},configurable:true});`)
  try {await stale.eval(`localStorage.setItem('mvlos.account','2');localStorage.setItem('mvlos.sync.widgets:state:v2',JSON.stringify('owner-two'))`)} finally {await stale.close()}
  const foreign=await open()
  try {
    await foreign.eval(`import('/src/os/storageTransaction.ts').then(m=>m.storageTransaction(()=>{}))`)
    const result=await foreign.eval(`({marker:localStorage.getItem('mvlos.account'),source:localStorage.getItem('mvlos.sync.widgets:state:v2'),target:localStorage.getItem('mvlos.u.1.sync.widgets:state:v2')})`)
    check('Stale migration intent preserves foreign owner and source',result.marker==='2'&&result.source===JSON.stringify('owner-two')&&result.target===null,result)
  } finally {await foreign.close()}
  const changed=await open(true,{},`localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets:state:v2','first-source');Object.defineProperty(window,'indexedDB',{value:{open(){throw new DOMException('Synthetic IDB denial','SecurityError')}},configurable:true});`)
  try {await changed.eval(`localStorage.setItem('mvlos.sync.widgets:state:v2',JSON.stringify('replacement-source'))`)} finally {await changed.close()}
  const changedRetry=await open()
  try {await changedRetry.eval(`import('/src/os/storageTransaction.ts').then(m=>m.storageTransaction(()=>{}))`);check('Changed source with same marker remains untouched',await changedRetry.eval(`localStorage.getItem('mvlos.account')==='1'&&JSON.parse(localStorage.getItem('mvlos.sync.widgets:state:v2'))==='replacement-source'&&localStorage.getItem('mvlos.u.1.sync.widgets:state:v2')===null`))} finally {await changedRetry.close()}
  const unbound=await open(true,{},`localStorage.setItem('mvlos.u.1.moved','1');localStorage.setItem('mvlos.u.1.widget-move:plain:v2','1');localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets:state:v2','unbound-source')`)
  try {await unbound.eval(`import('/src/os/storageTransaction.ts').then(m=>m.storageTransaction(()=>{}))`);check('Old unbound migration intent fails closed',await unbound.eval(`localStorage.getItem('mvlos.u.1.widget-move:plain:v2')==='1'&&localStorage.getItem('mvlos.sync.widgets:state:v2')==='unbound-source'&&localStorage.getItem('mvlos.account')==='1'`))} finally {await unbound.close()}
  const older=await open(true,{},`localStorage.setItem('mvlos.owner','legacy-owner');localStorage.setItem('mvlos.sync.widgets:state:v2',JSON.stringify('older-owned'))`)
  try {await older.waitFor(`JSON.parse(localStorage.getItem('mvlos.u.1.sync.widgets:state:v2'))==='older-owned'`);check('Older ownership marker and source survive bound transfer',await older.eval(`localStorage.getItem('mvlos.owner')==='legacy-owner'&&JSON.parse(localStorage.getItem('mvlos.sync.widgets:state:v2'))==='older-owned'`))} finally {await older.close()}
  const noUid=await newPage(b,1500,1000,'');await noUid.send('Network.deleteCookies',{name:'mvlos_uid',url:origin});await noUid.close()
  const guestMove=await open(true,{},`localStorage.setItem('mvlos.sync.widgets:state:v2',JSON.stringify('visitor-owned'))`)
  try {await guestMove.waitFor(`JSON.parse(localStorage.getItem('mvlos.visitor.sync.widgets:state:v2'))==='visitor-owned'`);check('Unowned legacy source is retained after visitor import',await guestMove.eval(`JSON.parse(localStorage.getItem('mvlos.sync.widgets:state:v2'))==='visitor-owned'`))} finally {await guestMove.close()}
  const restoreUid=await newPage(b,1500,1000,'');await restoreUid.send('Network.setCookie',{name:'mvlos_uid',value:'1',url:origin});await restoreUid.close()

  const auth=await newPage(b,1500,1000,'');await auth.send('Page.navigate',{url:origin+'/package.json'})
  const loginAs=async(id:number|null)=>{for(const name of ['mvlos_sid','mvlos_login','mvlos_uid'])await auth.send('Network.deleteCookies',{name,url:origin});if(id)for(const [name,value] of [['mvlos_sid',id===1?sid:sid2],['mvlos_login',id===1?login:'widget-review6-b'],['mvlos_uid',String(id)]])await auth.send('Network.setCookie',{name,value,url:origin})}
  const privateSource=JSON.stringify({value:{schema:2,configs:{private:{at:1,value:{days:9}}},placements:{places:{},removed:''},installations:{}},base:0,dirty:true})
  await loginAs(1);await auth.eval(`localStorage.clear();localStorage.setItem('mvlos.owner','legacy-owner');localStorage.setItem('mvlos.sync.widgets:state:v2',${JSON.stringify(privateSource)})`)
  const owner=await open()
  try {
    await owner.waitFor(`localStorage.getItem('mvlos.u.1.widget-move:plain:done:v2')==='1'&&import('/src/os/accountSpace.ts').then(m=>m.accountGuard())`)
    check('Older marker binds globally before account A copy',await owner.eval(`JSON.parse(localStorage.getItem('mvlos.legacy-owner-claim:v1')).owner==='1'&&JSON.parse(localStorage.getItem('mvlos.u.1.sync.widgets:state:v2')).value.configs.private.value.days===9`))
    await hydrate(owner);await flush(owner);check('Account A sees its imported older-owner data',(await configs(owner)).private?.days===9)
    await owner.eval(`(async()=>{const m=await import('/src/os/accountSpace.ts');m.freezeAccount(false);await m.clearAccountSpace()})()`)
  } finally {await owner.close()}
  await auth.eval(`localStorage.setItem('mvlos.sync.widgets',JSON.stringify({value:{private:{days:9}},base:0,dirty:true}))`)
  await loginAs(null);const noOwner=await open()
  try {await noOwner.eval(`import('/src/os/storageTransaction.ts').then(m=>m.storageTransaction(()=>{}))`);check('Visitor cannot adopt older-owner data',await noOwner.eval(`localStorage.getItem('mvlos.visitor.sync.widgets:state:v2')===null`))} finally {await noOwner.close()}
  await loginAs(2);const other=await open()
  try {
    await other.eval(`import('/src/os/storageTransaction.ts').then(m=>m.storageTransaction(()=>{}))`)
    await hydrate(other);await flush(other)
    check('Account B cannot import retained older-owner state',!(await configs(other)).private&&!await other.eval(`localStorage.getItem('mvlos.u.2.widget-move:plain:done:v2')||localStorage.getItem('mvlos.u.2.sync.widgets')`))
    await reload(other)
    check('Account B reload still cannot import older-owner state',!(await configs(other)).private)
  } finally {await other.close()}
  await loginAs(1)
  await auth.eval(`localStorage.clear();localStorage.setItem('mvlos.owner','legacy-concurrent');localStorage.setItem('mvlos.sync.widgets:state:v2',${JSON.stringify(privateSource)})`)
  const concurrent=await Promise.all([1,2].map(id=>newPage(b,1500,1000,inject(false,{},`Object.defineProperty(Document.prototype,'cookie',{configurable:true,get(){return 'mvlos_uid=${id}'},set(){}})`))))
  try {
    await Promise.all(concurrent.map(p=>p.send('Page.navigate',{url:origin})))
    await auth.waitFor(`!!localStorage.getItem('mvlos.legacy-owner-claim:v1')&&!!(localStorage.getItem('mvlos.u.1.sync.widgets:state:v2')||localStorage.getItem('mvlos.u.2.sync.widgets:state:v2'))`)
    await sleep(250)
    const result=await auth.eval(`({claim:JSON.parse(localStorage.getItem('mvlos.legacy-owner-claim:v1')),one:localStorage.getItem('mvlos.u.1.sync.widgets:state:v2'),two:localStorage.getItem('mvlos.u.2.sync.widgets:state:v2')})`)
    check('Concurrent first claims admit exactly one account',!!result.one!==!!result.two&&!!result[result.claim.owner==='1'?'one':'two'],result)
  } finally {for(const p of concurrent)await p.close()}
  await auth.eval(`localStorage.clear();localStorage.setItem('mvlos.owner','legacy-write-failure');localStorage.setItem('mvlos.sync.widgets:state:v2',${JSON.stringify(privateSource)})`)
  const claimDenied=await open(false,{},`const base=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='mvlos.legacy-owner-claim:v1')throw new DOMException('Synthetic quota','QuotaExceededError');return base.call(this,k,v)}`)
  try {
    await claimDenied.eval(`import('/src/os/storageTransaction.ts').then(m=>m.storageTransaction(()=>{}))`)
    check('Failed global claim refuses every legacy import',await claimDenied.eval(`!localStorage.getItem('mvlos.legacy-owner-claim:v1')&&!localStorage.getItem('mvlos.u.1.sync.widgets:state:v2')&&localStorage.getItem('mvlos.sync.widgets:state:v2')!==null`))
  } finally {await claimDenied.close()}
  const claimRetry=await open()
  try {await claimRetry.waitFor(`localStorage.getItem('mvlos.u.1.widget-move:plain:done:v2')==='1'`);check('Owner retries after failed global claim',await claimRetry.eval(`JSON.parse(localStorage.getItem('mvlos.legacy-owner-claim:v1')).owner==='1'`))} finally {await claimRetry.close()}
  await auth.eval(`localStorage.setItem('mvlos.account','2');localStorage.setItem('mvlos.sync.widgets:state:v2',${JSON.stringify(privateSource)})`)
  await loginAs(2);const explicit=await open()
  try {await explicit.waitFor(`localStorage.getItem('mvlos.u.2.widget-move:plain:done:v2')==='1'`);check('Explicit account marker takes precedence over older claim',await explicit.eval(`JSON.parse(localStorage.getItem('mvlos.u.2.sync.widgets:state:v2')).value.configs.private.value.days===9`))} finally {await explicit.close()}
  await loginAs(1)
  await auth.eval(`localStorage.clear();localStorage.setItem('mvlos.owner','legacy-copy-failure');localStorage.setItem('mvlos.sync.widgets:state:v2',${JSON.stringify(privateSource)})`)
  const copyDenied=await open(false,{},`const base=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='mvlos.u.1.sync.widgets:state:v2')throw new DOMException('Synthetic quota','QuotaExceededError');return base.call(this,k,v)}`)
  try {await copyDenied.eval(`import('/src/os/storageTransaction.ts').then(m=>m.storageTransaction(()=>{}))`);check('Failed copy retains global claim and source',await copyDenied.eval(`JSON.parse(localStorage.getItem('mvlos.legacy-owner-claim:v1')).owner==='1'&&!localStorage.getItem('mvlos.u.1.sync.widgets:state:v2')&&localStorage.getItem('mvlos.sync.widgets:state:v2')!==null`))} finally {await copyDenied.close()}
  await loginAs(2);const blockedOther=await open()
  try {await blockedOther.eval(`import('/src/os/storageTransaction.ts').then(m=>m.storageTransaction(()=>{}))`);check('Claim survives copy failure and excludes account B',await blockedOther.eval(`!localStorage.getItem('mvlos.u.2.sync.widgets:state:v2')`))} finally {await blockedOther.close()}
  await loginAs(1);const copyRetry=await open()
  try {await copyRetry.waitFor(`localStorage.getItem('mvlos.u.1.widget-move:plain:done:v2')==='1'`);check('Original owner recovers after copy failure',await copyRetry.eval(`JSON.parse(localStorage.getItem('mvlos.u.1.sync.widgets:state:v2')).value.configs.private.value.days===9`))} finally {await copyRetry.close()}
  await auth.eval(`localStorage.clear();localStorage.setItem('mvlos.owner','legacy-prior-receipt');localStorage.setItem('mvlos.u.1.widget-move:plain:done:v2','1');localStorage.setItem('mvlos.sync.widgets:state:v2',${JSON.stringify(privateSource)})`)
  await loginAs(2);const prior=await open()
  try {await prior.eval(`import('/src/os/storageTransaction.ts').then(m=>m.storageTransaction(()=>{}))`);check('Earlier account receipt blocks reassignment',await prior.eval(`!localStorage.getItem('mvlos.legacy-owner-claim:v1')&&!localStorage.getItem('mvlos.u.2.sync.widgets:state:v2')`))} finally {await prior.close()}
  await loginAs(1)
  await auth.close()

  const Q=await open(true)
  try {
    await set(Q,'quota',{days:1});await Q.eval('window.__denyCanonical=true');await hydrate(Q)
    check('Refused localStorage write retains its journal',await journalCount(Q)>0&&(await durable(Q))===null)
    await Q.eval('window.__denyCanonical=false');await flush(Q)
    check('Transient storage denial retries without another edit',(await durable(Q)).value.configs.quota.value.days===1)
    const remaining=await journalCount(Q)
    check('Receipt cleanup follows successful persistence',remaining===0,remaining)
  } finally {await Q.close()}

  const blocked=await open(true,{},`Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Synthetic storage denial','SecurityError')}});`)
  try {
    const admission=await blocked.eval(`import('/src/widgets/config.ts').then(m=>{try{m.setWidgetConfig('memory',{days:3});return ''}catch(e){return e.message}})`);await hydrate(blocked)
    check('Fully blocked localStorage rejects an edit before acknowledgement',admission.includes('journal write refused')&&!(await configs(blocked)).memory,admission)
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
    check('Revocation cancels frozen tab persistence',!!error,error)
    // Logout cleanup is intentionally permitted after revocation, but follows every earlier
    // running writer. It cannot clear first and then let the paused writer recreate the envelope.
    await pause(L,'before-cleanup')
    await F.eval(`window.__cleared=false;void import('/src/os/accountSpace.ts').then(m=>m.clearAccountSpace()).then(()=>window.__cleared=true)`)
    await sleep(80);check('Logout cleanup waits behind an already-running writer',!await F.eval('window.__cleared'))
    onPause=undefined;await L.send('Debugger.resume');await F.waitFor('window.__cleared')
    const afterCleanup={canonical:await durable(F),journals:await journalCount(F)}
    check('Logout cleanup cannot be undone by the earlier paused write',afterCleanup.canonical===null&&afterCleanup.journals===0,afterCleanup)
    check('Degraded storage and revocation create no unhandled browser exceptions',!Q.errors.length&&!D.errors.length&&!F.errors.length&&!L.errors.length,[...Q.errors,...D.errors,...F.errors,...L.errors])
  } finally {for(const p of [L,F]){await p.send('Debugger.resume').catch(()=>{});await p.close()}}
} finally {await b.close();vite.kill('SIGTERM');rmSync(data,{recursive:true,force:true})}
console.log(`${passed} passed, ${failed} failed`)
if(failed)process.exitCode=1
