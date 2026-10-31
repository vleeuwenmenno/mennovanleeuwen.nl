// Real cross-tab transaction exclusion, server metadata, identity replay and degraded storage.
// Synthetic accounts/data only; Chromium is muted by the repository CDP harness.
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Page } from './perf/cdp.ts'
const WT = process.env.WT ?? process.cwd(), PORT = Number(process.env.PORT ?? 5293)
const data = mkdtempSync('/tmp/mvlos-widget-review13-')
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
  for(const [name,value]of [['mvlos_sid',sid],['mvlos_login',login],['mvlos_uid','1']])await control.send('Network.setCookie',{name,value,url:origin});
  const old={id:'note1',text:'SAVED-NOTE',color:'yellow',tilt:0,created:1,updated:1};
  const stateKey='mvlos.u.1.notes:state:v1', fenceKey='mvlos.u.1.notes:inputs-consumed:v1';
  const seed=()=>control.eval(`localStorage.clear();localStorage.setItem('mvlos.u.1.moved','1');localStorage.setItem('mvlos.u.1.sync.notes',JSON.stringify({value:[${JSON.stringify(old)}],base:100,dirty:false}))`);
  const notes=(p:Page)=>p.eval<any[]>(`import('/src/data/notes.ts').then(m=>m.allNotes())`);
  const flushNotes=(p:Page)=>p.eval(`import('/src/data/notes.ts').then(m=>m.flushNotes())`);
  const checkpoint=(p:Page)=>p.eval<any>(`JSON.parse(localStorage.getItem(${JSON.stringify(stateKey)}))`);
  const pull=(p:Page,value:unknown[],base:number)=>p.eval(`window.__remote={notes:{value:${JSON.stringify(value)},updatedAt:${base}}};import('/src/os/synced.ts').then(m=>m.pullAll())`);
  const closeAccount=(p:Page)=>p.eval(`import('/src/os/accountSpace.ts').then(m=>m.clearAccountSpace())`);
  const denyCheckpoint=`window.__holdState=true;const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(window.__denyCheckpoint&&k==='${stateKey}')throw new Error('Synthetic checkpoint denial');return original.call(this,k,v)}`;

  // Acknowledged admission predates B's edit, but A moves it from journal to checkpoint
  // between B's checkpoint read and journal enumeration. Both clock directions must work.
  for(const future of [false,true]) {
    await seed();
    const writer=await open(false,{},denyCheckpoint);await writer.eval('window.__releaseMe()');await flushNotes(writer);
    const reader=await open(false,{},`window.__holdState=true;window.addEventListener('storage',e=>e.stopImmediatePropagation(),true);const original=Storage.prototype.getItem;Storage.prototype.getItem=function(k){const value=original.call(this,k);if(k==='${stateKey}'&&window.__pauseSnapshot){window.__pauseSnapshot=false;debugger}return value}`);await reader.eval('window.__releaseMe()');
    await writer.eval(`(async()=>{const n=await import('/src/data/notes.ts');window.__denyCheckpoint=true;const real=Date.now;Date.now=()=>${Date.now()+(future?365*864e5:0)};try{n.updateNote('note1',{text:'ADMITTED-NEW-TEXT'})}finally{Date.now=real}})()`);try{await flushNotes(writer)}catch{}
    const admitted=(await notes(writer))[0];
    await reader.send('Debugger.enable');const paused=new Promise<void>(resolve=>onPause=resolve);
    const changing=reader.eval(`window.__pauseSnapshot=true;import('/src/data/notes.ts').then(m=>m.updateNote('note1',{color:'pink'}))`);void changing.catch(()=>{});
    await Promise.race([paused,sleep(10000).then(()=>{throw Error('snapshot did not pause')})]);
    await writer.eval('window.__denyCheckpoint=false');await flushNotes(writer);
    onPause=undefined;await reader.send('Debugger.resume');await reader.send('Debugger.disable');await changing;await flushNotes(reader);
    const result=(await notes(reader))[0];
    check(`${future?'Future':'Normal'} clock: torn read retries before applying an unrelated edit`,result.text==='ADMITTED-NEW-TEXT'&&result.color==='pink'&&result.edited>admitted.edited,result);
    await reader.close();await writer.close();
    const offline=await open(false,{},`window.__holdState=true`);await offline.eval('window.__releaseMe()');
    check(`${future?'Future':'Normal'} clock: both intended changes survive offline reload`,(await notes(offline)).some(n=>n.text==='ADMITTED-NEW-TEXT'&&n.color==='pink'));
    await offline.close();
  }

  // A disappearing enumerated record is normal only when a checkpoint/receipt proves cleanup.
  await seed();
  const writer=await open(false,{},denyCheckpoint);await writer.eval('window.__releaseMe()');await flushNotes(writer);
  await writer.eval(`window.__denyCheckpoint=true;import('/src/data/notes.ts').then(m=>m.createNote({text:'ACCEPTED-BEFORE-READER'}))`);try{await flushNotes(writer)}catch{}
  const reader=await newPage(b,1500,1000,inject(false,{notes:{value:[old],updatedAt:100}},`const original=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k.startsWith('mvlos.u.1.notes:pending:v1:')&&!window.__pausedRead){window.__pausedRead=true;debugger}return original.call(this,k)}`));
  await reader.send('Debugger.enable');const paused=new Promise<void>(resolve=>onPause=resolve);await reader.send('Page.navigate',{url:origin});
  await Promise.race([paused,sleep(15000).then(()=>{throw Error('journal read did not pause')})]);
  await writer.eval('window.__denyCheckpoint=false');await flushNotes(writer);
  onPause=undefined;await reader.send('Debugger.resume');await reader.send('Debugger.disable');await reader.waitFor(`!!window.__releaseMe&&document.querySelector('.desktop')&&!document.querySelector('.boot')`,90000);await hydrate(reader);
  check('Startup cleanup race recovers accepted data without reload',(await notes(reader)).some(n=>n.text==='ACCEPTED-BEFORE-READER'));
  await reader.eval(`import('/src/data/notes.ts').then(m=>m.createNote({text:'EDIT-AFTER-RETRY'}))`);await flushNotes(reader);
  check('Startup cleanup race does not latch a permanent read error',(await notes(reader)).some(n=>n.text==='EDIT-AFTER-RETRY'));
  await reader.close();await writer.close();

  // Repeated observed revisions exhaust the bounded snapshot retry, but remain retryable.
  await seed();
  const busy=await open(false,{},`window.__holdState=true;const original=Storage.prototype.getItem;Storage.prototype.getItem=function(k){const raw=original.call(this,k);if(k==='${stateKey}'&&window.__moving&&raw){const value=JSON.parse(raw);value.revision=crypto.randomUUID();return JSON.stringify(value)}return raw}`);await busy.eval('window.__releaseMe()');await flushNotes(busy);
  const busyResult=await busy.eval(`window.__moving=true;import('/src/data/notes.ts').then(m=>{try{m.updateNote('note1',{color:'pink'});return 'accepted'}catch(e){return e.message}})`);
  check('Unstable snapshot rejects admission after bounded retries',String(busyResult).includes('kept changing')&&(await checkpoint(control)).value[0].color==='yellow',busyResult);
  await busy.eval(`window.__moving=false;import('/src/data/notes.ts').then(m=>m.updateNote('note1',{color:'pink'}))`);await flushNotes(busy);
  check('An explicit retry succeeds when snapshot contention ends',(await notes(busy))[0].color==='pink');await busy.close();

  // A purge must remain protocol evidence when more than 90 days pass, in both durable forms.
  for(const journalOnly of [false,true]) {
    await seed();
    const expiring=await open(false,{},denyCheckpoint);await expiring.eval('window.__releaseMe()');await flushNotes(expiring);
    await expiring.eval(`(async()=>{const n=await import('/src/data/notes.ts');window.__denyCheckpoint=${journalOnly};const real=Date.now;Date.now=()=>${Date.now()-91*864e5};try{n.purgeNote('note1');try{await n.flushNotes()}catch{}}finally{Date.now=real}})()`);await expiring.close();
    const expired=await open(false,{notes:{value:[],updatedAt:200}});await hydrate(expired);
    check(`${journalOnly?'Journal':'Checkpoint'} purge remains pending deletion evidence after 91 days`,await expired.eval(`import('/src/data/notes.ts').then(m=>!m.getNote('note1')&&m.allNotes().some(n=>n.id==='note1'&&n.purged))`));
    await expired.eval(`import('/src/data/notes.ts').then(m=>m.createNote({text:'EDIT-AFTER-AGING'}))`);await flushNotes(expired);
    check(`${journalOnly?'Journal':'Checkpoint'} aging permits hydration and subsequent edits`,(await notes(expired)).some(n=>n.text==='EDIT-AFTER-AGING'));
    const aged=await notes(expired);await pull(expired,aged,300);await pull(expired,aged.filter(n=>!n.purged),400);await expired.close();
    const pruned=await open(false,{},`window.__holdState=true`);await pruned.eval('window.__releaseMe()');
    check(`${journalOnly?'Journal':'Checkpoint'} acknowledged purge can be pruned without resurrection`,!(await notes(pruned)).some(n=>n.id==='note1')&&(await notes(pruned)).some(n=>n.text==='EDIT-AFTER-AGING'));
    await pruned.close();
  }

  const seedLegacy=()=>control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.notes',JSON.stringify({value:[${JSON.stringify(old)}],base:0,dirty:true}))`);
  const purgeAndPrune=async(p:Page)=>{await p.eval(`import('/src/data/notes.ts').then(m=>m.purgeNote('note1'))`);await flushNotes(p);await pull(p,await notes(p),200);await pull(p,[],300)};
  await seedLegacy();
  const legacy=await open(false,{notes:{value:[old],updatedAt:100}});await hydrate(legacy);await purgeAndPrune(legacy);
  const retained=await control.eval(`Object.fromEntries(Object.entries(localStorage).filter(([key])=>key==='mvlos.sync.notes'||key.startsWith('mvlos.u.1.widget-stage:v1:mvlos.sync.notes:')))`);
  await closeAccount(legacy);await legacy.close();
  const post=await open(false,{notes:{value:[],updatedAt:300}});await hydrate(post);
  check('Acknowledged and pruned migrated note stays absent after logout',!(await notes(post)).some(n=>n.id==='note1'));
  check('Consumed-input fence survives logout with exact account ownership',await post.eval(`const f=JSON.parse(localStorage.getItem('${fenceKey}'));f.space==='mvlos.u.1.'&&f.pending.length===0`));
  check('Input fencing retains all original migration source bytes',JSON.stringify(await control.eval(`Object.fromEntries(Object.entries(localStorage).filter(([key])=>key==='mvlos.sync.notes'||key.startsWith('mvlos.u.1.widget-stage:v1:mvlos.sync.notes:')))`))===JSON.stringify(retained));await post.close();

  // A partial acknowledgement cannot discard a different unacknowledged migrated note.
  await seedLegacy();await control.eval(`const m=JSON.parse(localStorage.getItem('mvlos.sync.notes'));m.value.push({...m.value[0],id:'note2',text:'UNACKNOWLEDGED-IMPORT'});localStorage.setItem('mvlos.sync.notes',JSON.stringify(m))`);
  const mixed=await open(false,{notes:{value:[old],updatedAt:100}});await hydrate(mixed);
  await mixed.eval(`import('/src/data/notes.ts').then(m=>m.purgeNote('note1'))`);await flushNotes(mixed);
  await pull(mixed,(await notes(mixed)).filter(n=>n.id==='note1'),200);await pull(mixed,[],300);await closeAccount(mixed);await mixed.close();
  const mixedBack=await open(false,{notes:{value:[],updatedAt:300}});await hydrate(mixedBack);
  check('Partial migration keeps only unacknowledged imports across logout',!(await notes(mixedBack)).some(n=>n.id==='note1')&&(await notes(mixedBack)).some(n=>n.id==='note2'&&n.text==='UNACKNOWLEDGED-IMPORT'));
  await mixedBack.close();

  // No checkpoint, no consumption fence: the original authorized transfer can retry.
  await seedLegacy();
  const uncommitted=await open(false,{},denyCheckpoint.replace('window.__holdState=true;','window.__holdState=true;window.__denyCheckpoint=true;'));await uncommitted.eval('window.__releaseMe()');try{await flushNotes(uncommitted)}catch{}
  check('A failed first checkpoint cannot mark migration inputs consumed',await control.eval(`localStorage.getItem('${fenceKey}')===null&&localStorage.getItem('${stateKey}')===null`));
  await closeAccount(uncommitted);await uncommitted.close();
  const retried=await open();await hydrate(retried);check('Unconsumed failed migration retries after logout',(await notes(retried)).some(n=>n.id==='note1'&&n.text==='SAVED-NOTE'));await retried.close();

  // Logout may advance revocation and then fail to write the fence. The retained checkpoint
  // proves consumption in the next generation, even before another writer repairs the fence.
  await seedLegacy();
  const denied=await open(false,{notes:{value:[old],updatedAt:100}},`const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(window.__denyFence&&k==='${fenceKey}')throw new Error('Synthetic fence denial');return original.call(this,k,v)}`);await hydrate(denied);await purgeAndPrune(denied);
  await denied.eval(`localStorage.removeItem('${fenceKey}');window.__denyFence=true`);let rejected=false;try{await closeAccount(denied)}catch{rejected=true}
  check('Failed logout fence retains the revoked checkpoint as consumption proof',rejected&&await control.eval(`localStorage.getItem('${stateKey}')!==null&&localStorage.getItem('${fenceKey}')===null`));await denied.close();
  const afterDenied=await open(false,{notes:{value:[],updatedAt:300}});await hydrate(afterDenied);
  check('Revoked checkpoint proof prevents reimport after a failed fence write',!(await notes(afterDenied)).some(n=>n.id==='note1'));
  check('Later persistence repairs the account-bound input fence',await control.eval(`JSON.parse(localStorage.getItem('${fenceKey}')).space==='mvlos.u.1.'`));await afterDenied.close();

  await seedLegacy();await control.eval(`localStorage.setItem('${fenceKey}',JSON.stringify({schema:1,space:'mvlos.u.2.',generation:null,checkpoint:null,pending:[]}))`);
  const foreign=await open();await foreign.eval('window.__releaseMe()');await foreign.waitFor(`import('/src/os/synced.ts').then(m=>m.getSyncStatus().state==='error')`);
  check('A foreign input fence cannot authorize or erase this account migration',await foreign.eval(`import('/src/os/synced.ts').then(m=>m.getSyncedHydration()===null&&JSON.parse(localStorage.getItem('${fenceKey}')).space==='mvlos.u.2.')`));await foreign.close();
  await control.close();
} finally {onPause=undefined;await b.close();vite.kill('SIGTERM');rmSync(data,{recursive:true,force:true})}
console.log(`${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
