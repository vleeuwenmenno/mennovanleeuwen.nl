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
const sid2 = randomBytes(24).toString('hex');
database().prepare('INSERT INTO users (id,github_id,login,github_token,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(2,2,'widget-review6-b',encrypt('none'),now,now);
database().prepare('INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(sha256(sid2),2,now,now+86400_000);
const vite = spawn(`${WT}/node_modules/.bin/vite`, ['--port',String(PORT),'--strictPort'], {
  cwd:WT, env:{...process.env,DATA_DIR:data,GITHUB_CLIENT_ID:'x',GITHUB_CLIENT_SECRET:'x',ADMIN_USERS:'nobody',MC_WATCH:'off'}, stdio:['ignore','pipe','pipe'],
})
for (const sig of ['SIGINT','SIGTERM','SIGHUP','SIGPIPE'] as const) process.on(sig,()=>{vite.kill();process.exit(1)})
let log = '', failed = 0, passed = 0
vite.stdout.on('data',d=>log+=d);vite.stderr.on('data',d=>log+=d)
const origin = `http://127.0.0.1:${PORT}`
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
const reload = async (p:Page)=>{
  const id=await p.eval<string>('window.__document');await p.send('Page.reload')
  await p.waitFor(`window.__document!==${JSON.stringify(id)}&&document.querySelector('.desktop')&&!document.querySelector('.boot')&&!!window.__releaseMe`,90_000)
  await hydrate(p);await flush(p)
}
let onPause: (()=>void)|undefined
b.on(m=>{if(m.method==='Debugger.paused')onPause?.()})

try {
  const control=await newPage(b,1500,1000,'');await control.send('Page.navigate',{url:origin+'/package.json'});
  const oldNote=JSON.stringify({value:[{id:'note1',text:'OLD',color:'yellow',tilt:0,created:1,updated:1}],base:0,dirty:true});
  const layout=JSON.stringify({value:[{app:'widget',props:{id:'note1',kind:'sticky'},x:91,y:72,w:280,h:200}],base:0,dirty:true});
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.sync.notes',${JSON.stringify(oldNote)});localStorage.setItem('mvlos.sync.windows:desktop',${JSON.stringify(layout)})`);
  const visitor=await open();await hydrate(visitor);await flush(visitor);
  await visitor.close();
  for(const [name,value]of [['mvlos_sid',sid],['mvlos_login',login],['mvlos_uid','1']])await control.send('Network.setCookie',{name,value,url:origin});
  const signed=await open();await hydrate(signed);await flush(signed);
  const transferred=await signed.eval(`(async()=>({notes:(await import('/src/data/notes.ts')).allNotes(),places:(await import('/src/os/widgetPlaces.ts')).widgetPlaces.get(),storage:{...localStorage}}))()`);
  check('Signing in preserves visitor staged sticky-note content',transferred.notes.some(n=>n.id==='note1'&&n.text==='OLD'));
  check('Signing in retains the staged sticky placement',Object.values(transferred.places.places).some((p:any)=>p.id==='note1'));
  await signed.close();
  await control.eval(`localStorage.removeItem('mvlos.u.1.notes:state:v1');localStorage.setItem('mvlos.u.1.sync.notes',JSON.stringify({value:[{id:'note1',text:'',color:'yellow',tilt:0,created:1,updated:Date.now(),purged:true}],base:100,dirty:false}))`);
  const tombstone=await open();await hydrate(tombstone);await flush(tombstone);
  check('Pre-cutover account note tombstone takes precedence over visitor stage',await tombstone.eval(`import('/src/data/notes.ts').then(m=>!m.getNote('note1')&&m.allNotes().some(n=>n.id==='note1'&&n.purged))`));
  await tombstone.close();
  // A prior startup wrote moved and the canonical transfer intent, but not its note dependency.
  // This fixture represents the earlier v2 cache, before the visitor's new note checkpoint.
  await control.eval(`for(const k of Object.keys(localStorage))if(k==='mvlos.visitor.notes:state:v1'||k.startsWith('mvlos.visitor.notes:pending:v1:'))localStorage.removeItem(k)`);
  const guestEnvelope=await control.eval(`localStorage.getItem('mvlos.visitor.sync.widgets:state:v2')`);
  await control.eval(`for(const k of Object.keys(localStorage))if(k.startsWith('mvlos.u.1.'))localStorage.removeItem(k);localStorage.setItem('mvlos.u.1.moved','1');localStorage.setItem('mvlos.u.1.widget-move:guest:v2',JSON.stringify({source:${JSON.stringify(guestEnvelope)},target:null}));localStorage.setItem('mvlos.visitor.widget-cache:v2:notes',JSON.stringify({value:[{id:'note1',text:'VISITOR-CACHE',color:'yellow',tilt:0,created:1,updated:2}],base:0,dirty:true}))`);
  const partialGuest=await open(false,{},`const dependencySet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('mvlos.u.1.widget-stage:v1:mvlos.sync.notes:')&&!sessionStorage.getItem('dependency-failed')){sessionStorage.setItem('dependency-failed','1');throw new DOMException('Synthetic dependency denial','QuotaExceededError')}return dependencySet.call(this,k,v)}`);
  await partialGuest.eval('window.__releaseMe()');await sleep(150);
  check('Failed visitor dependency retains intent and blocks cutover',await partialGuest.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>!m.widgetsHydrated()&&localStorage.getItem('mvlos.u.1.widget-move:guest:v2')!==null)`));
  await reload(partialGuest);
  check('Partial visitor transfer retries dependencies after moved flag',await partialGuest.eval(`import('/src/data/notes.ts').then(m=>m.getNote('note1')?.text==='VISITOR-CACHE'&&localStorage.getItem('mvlos.u.1.sync.notes')===null&&localStorage.getItem('mvlos.u.1.widget-move:guest:v2')===null)`));
  await partialGuest.close();

  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.notes',${JSON.stringify(oldNote)});localStorage.setItem('mvlos.sync.windows:desktop',${JSON.stringify(layout)})`);
  const remote={notes:{value:[{id:'note1',text:'NEW-REMOTE',color:'yellow',tilt:0,created:1,updated:99}],updatedAt:99}};
  const online=await open(false,remote);await hydrate(online);await flush(online);await sleep(200);
  check('Remote reconciliation writes separate cache, not ordinary target',await online.eval(`localStorage.getItem('mvlos.u.1.sync.notes')===null&&Object.keys(localStorage).some(k=>k.startsWith('mvlos.u.1.notes:state:v1'))`));
  await reload(online);
  check('Reload retains one bounded note cache checkpoint',await online.eval(`Object.keys(localStorage).filter(k=>k==='mvlos.u.1.notes:state:v1').length===1`));
  await online.close();
  const offline=await open(false,{},`window.__holdState=true`);await offline.eval('window.__releaseMe()');await sleep(200);
  const cached=await offline.eval(`(async()=>({notes:(await import('/src/data/notes.ts')).allNotes(),target:localStorage.getItem('mvlos.u.1.sync.notes')}))()`);
  check('Successful remote note hydration survives offline reload',cached.notes.some(n=>n.text==='NEW-REMOTE'));
  await offline.eval(`import('/src/data/notes.ts').then(m=>m.updateNote('note1',{text:'OFFLINE-EDIT'}))`);
  await offline.close();
  const edited=await open(false,{},`window.__holdState=true`);await edited.eval('window.__releaseMe()');await sleep(200);
  check('Offline edit survives another reload',await edited.eval(`import('/src/data/notes.ts').then(m=>m.getNote('note1')?.text==='OFFLINE-EDIT')`));
  await edited.close();
  const authoritative=JSON.stringify({value:[{id:'note1',text:'ACCOUNT-TARGET',color:'yellow',tilt:0,created:1,updated:199}],base:199,dirty:false});
  await control.eval(`localStorage.setItem('mvlos.u.1.sync.notes',${JSON.stringify(authoritative)})`);
  const target=await open(false,{},`window.__holdState=true`);await target.eval('window.__releaseMe()');await sleep(200);
  check('Post-cutover ordinary writes cannot shadow committed note edits',await target.eval(`import('/src/data/notes.ts').then(m=>m.getNote('note1')?.text==='OFFLINE-EDIT'&&localStorage.getItem('mvlos.u.1.sync.notes')===${JSON.stringify(authoritative)})`));
  await target.close();
  for(const [name,value]of [['mvlos_sid',sid2],['mvlos_login','widget-review6-b'],['mvlos_uid','2']])await control.send('Network.setCookie',{name,value,url:origin});
  const other=await open(false,{},`window.__holdState=true`);await other.eval('window.__releaseMe()');await sleep(200);
  check('Another account cannot read the first account note cache',await other.eval(`import('/src/data/notes.ts').then(m=>!m.getNote('note1'))`));
  await other.close();
  for(const [name,value]of [['mvlos_sid',sid],['mvlos_login',login],['mvlos_uid','1']])await control.send('Network.setCookie',{name,value,url:origin});
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.notes',${JSON.stringify(oldNote)})`);
  const failedCache=await open(false,remote,`const base=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('mvlos.u.1.notes:state:v1')&&!sessionStorage.getItem('cache-failed')){sessionStorage.setItem('cache-failed','1');throw new DOMException('Synthetic cache denial','QuotaExceededError')}return base.call(this,k,v)}`);
  await failedCache.eval('window.__releaseMe()');await failedCache.waitFor(`import('/src/os/synced.ts').then(m=>m.getSyncStatus().state==='error')`);
  check('Failed cache write does not claim hydration',await failedCache.eval(`import('/src/os/synced.ts').then(m=>m.getSyncedHydration()===null)`));
  await failedCache.eval(`import('/src/os/synced.ts').then(m=>m.pullAll())`);await failedCache.waitFor(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.widgetsHydrated())`);
  check('Retry persists remote note after transient cache failure',await failedCache.eval(`Object.keys(localStorage).some(k=>k.startsWith('mvlos.u.1.notes:state:v1'))&&import('/src/data/notes.ts').then(m=>m.getNote('note1')?.text==='NEW-REMOTE')`));
  await failedCache.close();
  await control.eval(`localStorage.setItem('mvlos.u.1.notes:state:v1',JSON.stringify({value:{},base:0,dirty:false}))`);
  const corrupt=await open();await corrupt.eval('window.__releaseMe()');await corrupt.waitFor(`import('/src/os/synced.ts').then(m=>m.getSyncStatus().state==='error')`);
  check('Unreadable note cache blocks hydration and retains source',await corrupt.eval(`import('/src/os/synced.ts').then(m=>m.getSyncedHydration()===null&&localStorage.getItem('mvlos.u.1.notes:state:v1')!==null)`));
  await corrupt.close();
  await control.eval(`localStorage.removeItem('mvlos.u.1.notes:state:v1');localStorage.removeItem('mvlos.u.1.widget-cache:v2:notes');localStorage.setItem('mvlos.u.1.sync.notes','')`);
  const emptyTarget=await open();await emptyTarget.eval('window.__releaseMe()');await emptyTarget.waitFor(`import('/src/os/synced.ts').then(m=>m.getSyncStatus().state==='error')`);
  check('Empty unreadable ordinary note envelope is not an absent store',await emptyTarget.eval(`import('/src/os/synced.ts').then(m=>m.getSyncedHydration()===null&&localStorage.getItem('mvlos.u.1.sync.notes')==='')`));
  await emptyTarget.close();
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.notes',${JSON.stringify(oldNote)})`);
  const deniedRead=await open(false,{},`const base=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k==='mvlos.u.1.sync.notes'&&!sessionStorage.getItem('note-read-failed')){sessionStorage.setItem('note-read-failed','1');throw new DOMException('Synthetic read denial','SecurityError')}return base.call(this,k)}`);
  await deniedRead.eval('window.__releaseMe()');await deniedRead.waitFor(`import('/src/os/synced.ts').then(m=>m.getSyncStatus().state==='error')`);
  check('Transient account note read denial blocks hydration',await deniedRead.eval(`import('/src/os/synced.ts').then(m=>m.getSyncedHydration()===null)`));
  await reload(deniedRead);
  check('Account note recovers after read denial on reload',await deniedRead.eval(`import('/src/data/notes.ts').then(m=>m.getNote('note1')?.text==='OLD')`));
  await deniedRead.close();
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.notes',${JSON.stringify(oldNote)})`);
  const noteA={id:'note-a',text:'TAB-A',color:'yellow',tilt:0,created:2,updated:100},noteB={id:'note-b',text:'TAB-B',color:'yellow',tilt:0,created:3,updated:100};
  const tabA=await open(false,{notes:{value:[noteA],updatedAt:100}},`const base=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('mvlos.u.1.notes:state:v1')&&!sessionStorage.getItem('cache-paused')){sessionStorage.setItem('cache-paused','1');debugger}return base.call(this,k,v)}`);
  const tabB=await open(false,{notes:{value:[noteB],updatedAt:100}});
  try {
    await tabA.send('Debugger.enable');const paused=new Promise<void>(resolve=>onPause=resolve);
    await tabA.eval('window.__releaseMe()');await Promise.race([paused,sleep(10000).then(()=>{throw Error('note cache write did not pause')})]);
    await tabB.eval('window.__releaseMe()');await sleep(150);
    check('Concurrent note hydration waits for the cache transaction',await tabB.eval(`import('/src/os/synced.ts').then(m=>m.getSyncedHydration()===null)`));
    onPause=undefined;await tabA.send('Debugger.resume');await tabA.send('Debugger.disable');await tabA.waitFor(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.widgetsHydrated())`);await flush(tabA);await tabB.waitFor(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.widgetsHydrated())`);await flush(tabB);
  } finally {onPause=undefined;await tabA.send('Debugger.resume').catch(()=>{});await tabA.close();await tabB.close()}
  const merged=await open(false,{},`window.__holdState=true`);await merged.eval('window.__releaseMe()');await sleep(200);
  const mergedNotes=await merged.eval(`import('/src/data/notes.ts').then(m=>m.allNotes())`);
  check('Concurrent note cache writes survive together offline',mergedNotes.some(n=>n.id==='note-a')&&mergedNotes.some(n=>n.id==='note-b'),mergedNotes);
  await merged.close();
  await control.eval(`localStorage.removeItem('mvlos.u.1.notes:state:v1');localStorage.setItem('mvlos.u.1.widget-cache:v2:notes',JSON.stringify({value:[${JSON.stringify(noteA)}],base:100,dirty:false}))`);
  const removed=await open(false,{notes:{value:[],updatedAt:200}});await hydrate(removed);await flush(removed);
  check('Clean obsolete cache cannot resurrect server-pruned notes',await removed.eval(`import('/src/data/notes.ts').then(m=>m.allNotes().length===0)`));
  await removed.close();
  const removedOffline=await open(false,{},`window.__holdState=true`);await removedOffline.eval('window.__releaseMe()');
  check('Server-pruned note absence persists offline',await removedOffline.eval(`import('/src/data/notes.ts').then(m=>m.allNotes().length===0)`));
  await removedOffline.close();
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.notes',${JSON.stringify(oldNote)})`);
  const delayed=await open(false,{},`window.__holdState=true;window.addEventListener('storage',e=>e.stopImmediatePropagation(),true);const read=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(window.__denyNoteCacheRead&&k==='mvlos.u.1.widget-cache:v2:notes')throw new DOMException('Synthetic read denial','SecurityError');return read.call(this,k)}`);
  await delayed.eval('window.__releaseMe()');
  await control.eval(`localStorage.setItem('mvlos.u.1.widget-cache:v2:notes',JSON.stringify({value:${JSON.stringify(remote.notes.value)},base:99,dirty:false}))`);
  await delayed.eval(`window.__denyNoteCacheRead=true;window.__editRejected=false;import('/src/data/notes.ts').then(m=>{try{m.createNote({text:'REJECTED'})}catch{window.__editRejected=true}})`);
  check('Actual edit cannot overwrite an unreadable reconciled cache',await delayed.eval(`window.__editRejected&&localStorage.getItem('mvlos.u.1.sync.notes')===null&&import('/src/data/notes.ts').then(m=>!m.allNotes().some(n=>n.text==='REJECTED'))`));
  await delayed.eval(`window.__denyNoteCacheRead=false;import('/src/data/notes.ts').then(m=>m.createNote({text:'LOCAL-EDIT'}))`);
  check('First real edit includes cache changes before their storage event',await delayed.eval(`import('/src/data/notes.ts').then(m=>m.getNote('note1')?.text==='NEW-REMOTE'&&m.allNotes().some(n=>n.text==='LOCAL-EDIT'))`));
  await delayed.close();


  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.owner','synthetic-owner');localStorage.setItem('mvlos.sync.widgets',JSON.stringify({value:{secret:{text:'ACCOUNT-A-PRIVATE'}},base:0,dirty:true}))`);
  const partial=await open(false,{},`const base=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='mvlos.u.1.moved')throw new DOMException('Synthetic moved write failure','QuotaExceededError');return base.call(this,k,v)}`);
  await partial.close();
  await control.eval(`localStorage.removeItem('mvlos.account');localStorage.setItem('mvlos.legacy-owner-claim:v1',JSON.stringify({owner:'2',marker:'synthetic-owner'}))`);
  for(const [name,value]of [['mvlos_sid',sid2],['mvlos_login','widget-review6-b'],['mvlos_uid','2']])await control.send('Network.setCookie',{name,value,url:origin});
  const accountB=await open();await accountB.eval('window.__releaseMe()');await sleep(500);
  const leaked=await accountB.eval(`(async()=>({configs:(await import('/src/widgets/platform/canonicalState.ts')).canonicalConfigs.get(),storage:{...localStorage}}))()`);
  check('Partial staged account ownership blocks a later older-owner claim',!leaked.configs.secret,leaked.configs);
  await accountB.close();
  await control.eval(`localStorage.removeItem('mvlos.legacy-owner-claim:v1')`);
  const noClaim=await open();await noClaim.eval('window.__releaseMe()');await sleep(150);
  check('Partial stage also blocks a new older-owner claim',!(await configs(noClaim)).secret&&await noClaim.eval(`localStorage.getItem('mvlos.legacy-owner-claim:v1')===null`));
  await noClaim.close();

  for(const [name,value]of [['mvlos_sid',sid],['mvlos_login',login],['mvlos_uid','1']])await control.send('Network.setCookie',{name,value,url:origin});
  const owner=await open();await hydrate(owner);await flush(owner);
  check('Original owner can recover the partially staged source',(await configs(owner)).secret?.text==='ACCOUNT-A-PRIVATE');
  await owner.close();
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.owner','synthetic-owner');localStorage.setItem('mvlos.sync.widgets',JSON.stringify({value:{secret:{text:'UNBOUND'}},base:0,dirty:true}));localStorage.setItem('mvlos.u.1.widget-stage:v1:mvlos.sync.widgets:old',JSON.stringify({key:'mvlos.sync.widgets',source:localStorage.getItem('mvlos.sync.widgets')}))`);
  for(const [name,value]of [['mvlos_sid',sid2],['mvlos_login','widget-review6-b'],['mvlos_uid','2']])await control.send('Network.setCookie',{name,value,url:origin});
  const unbound=await open();await unbound.eval('window.__releaseMe()');await sleep(400);
  check('Unbound earlier stage blocks cross-account adoption',await unbound.eval(`import('/src/os/accountSpace.ts').then(a=>a.widgetMigrationUnresolved()&&!localStorage.getItem('mvlos.legacy-owner-claim:v1'))`));
  await unbound.close();
  await control.eval(`localStorage.setItem('mvlos.account','1')`);
  for(const [name,value]of [['mvlos_sid',sid],['mvlos_login',login],['mvlos_uid','1']])await control.send('Network.setCookie',{name,value,url:origin});
  const recovery=await open();await hydrate(recovery);await flush(recovery);
  check('Explicit owner and matching original source recover an unbound stage',(await configs(recovery)).secret?.text==='UNBOUND');
  await recovery.close();
  await control.eval(`localStorage.removeItem('mvlos.account')`);
  for(const [name,value]of [['mvlos_sid',sid2],['mvlos_login','widget-review6-b'],['mvlos_uid','2']])await control.send('Network.setCookie',{name,value,url:origin});
  const afterRecovery=await open();await afterRecovery.eval('window.__releaseMe()');await sleep(400);
  check('Recovered ownership proof still excludes a different account',!(await configs(afterRecovery)).secret);
  await afterRecovery.close();await control.close();
} finally {await b.close();vite.kill('SIGTERM');rmSync(data,{recursive:true,force:true})}
console.log(`${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
