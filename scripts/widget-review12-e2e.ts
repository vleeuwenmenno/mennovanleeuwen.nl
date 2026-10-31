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
  for(const [name,value]of [['mvlos_sid',sid],['mvlos_login',login],['mvlos_uid','1']])await control.send('Network.setCookie',{name,value,url:origin});
  const old={id:'note1',text:'OLD',color:'yellow',tilt:0,created:1,updated:1};
  const remote={notes:{value:[{...old,text:'NEW-REMOTE',updated:99}],updatedAt:99}};
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.notes',JSON.stringify({value:[${JSON.stringify(old)}],base:0,dirty:true}))`);
  const tabA=await open(false,remote,`const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='mvlos.u.1.notes:state:v1'&&!sessionStorage.getItem('probe-paused')){sessionStorage.setItem('probe-paused','1');debugger}return original.call(this,k,v)}`);
  const tabB=await open(false,{},`window.__holdState=true`);
  await tabB.eval('window.__releaseMe()');
  await tabA.send('Debugger.enable');const paused=new Promise<void>(resolve=>onPause=resolve);
  await tabA.eval('window.__releaseMe()');await Promise.race([paused,sleep(10000).then(()=>{throw Error('cache write did not pause')})]);
  await tabB.eval(`import('/src/data/notes.ts').then(m=>m.createNote({text:'LOCAL-EDIT'}))`);
  check('Edit is journalled before returning while checkpoint gate is held',await tabB.eval(`localStorage.getItem('mvlos.u.1.sync.notes')===null&&Object.keys(localStorage).some(k=>k.startsWith('mvlos.u.1.notes:pending:v1:'))`));
  onPause=undefined;await tabA.send('Debugger.resume');await tabA.send('Debugger.disable');
  await tabA.waitFor(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.widgetsHydrated())`);await flush(tabA);await sleep(150);
  check('Hydrated tab retains remote revision and admitted edit',await tabA.eval(`import('/src/data/notes.ts').then(m=>m.getNote('note1')?.text==='NEW-REMOTE'&&m.allNotes().some(n=>n.text==='LOCAL-EDIT'))`));
  await tabB.waitFor(`import('/src/data/notes.ts').then(m=>m.getNote('note1')?.text==='NEW-REMOTE'&&m.allNotes().some(n=>n.text==='LOCAL-EDIT'))`);
  check('Editing tab also retains the confirmed remote revision and its local edit',await tabB.eval(`import('/src/data/notes.ts').then(m=>m.getNote('note1')?.text==='NEW-REMOTE'&&m.allNotes().some(n=>n.text==='LOCAL-EDIT'))`));
  await tabA.close();await tabB.close();
  const offline=await open(false,{},`window.__holdState=true`);await offline.eval('window.__releaseMe()');await sleep(100);
  const result=await offline.eval(`import('/src/data/notes.ts').then(m=>m.allNotes())`);
  check('First ordinary edit during cache commit retains acknowledged remote text offline',result.some(n=>n.text==='NEW-REMOTE'),result);
  check('First ordinary edit retains new local note',result.some(n=>n.text==='LOCAL-EDIT'),result);
  await offline.close();

  // Existing clean cache receives a newer empty server snapshot while another tab keeps old memory.
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.u.1.moved','1');localStorage.setItem('mvlos.u.1.widget-cache:v2:notes',JSON.stringify({value:[${JSON.stringify(old)}],base:100,dirty:false}))`);
  const stale=await open(false,{},`window.__holdState=true;window.addEventListener('storage',e=>e.stopImmediatePropagation(),true)`);await stale.eval('window.__releaseMe()');
  const remover=await open(false,{notes:{value:[],updatedAt:200}});await hydrate(remover);await flush(remover);

  await stale.eval(`import('/src/data/notes.ts').then(m=>m.createNote({text:'UNRELATED-NEW'}))`);
  const resurrected=await stale.eval(`import('/src/data/notes.ts').then(m=>m.allNotes())`);
  check('First edit uses clean newer checkpoint without resurrecting removed unrelated note',!resurrected.some(n=>n.id==='note1'),resurrected);
  await stale.close();await remover.close();
  const reloaded=await open(false,{},`window.__holdState=true`);await reloaded.eval('window.__releaseMe()');
  const afterReload=await reloaded.eval(`import('/src/data/notes.ts').then(m=>m.allNotes())`);
  check('Pruned note stays absent after offline reload',!afterReload.some(n=>n.id==='note1'),afterReload);
  check('Rebased unrelated local edit survives offline reload',afterReload.some(n=>n.text==='UNRELATED-NEW'),afterReload);
  await reloaded.close();
  const seed=async(value:unknown[]=[],base=10)=>control.eval(`localStorage.clear();localStorage.setItem('mvlos.u.1.moved','1');localStorage.setItem('mvlos.u.1.widget-cache:v2:notes',JSON.stringify({value:${JSON.stringify(value)},base:${base},dirty:false}))`);
  const notes=(p:Page)=>p.eval<any[]>(`import('/src/data/notes.ts').then(m=>m.allNotes())`);
  const flushNotes=(p:Page)=>p.eval(`import('/src/data/notes.ts').then(m=>m.flushNotes())`);
  const pull=async(p:Page,value:unknown[],base:number)=>{await p.eval(`window.__remote={notes:{value:${JSON.stringify(value)},updatedAt:${base}}};import('/src/os/synced.ts').then(m=>m.pullAll())`)};
  const journalCount=(p:Page)=>p.eval<number>(`Object.keys(localStorage).filter(k=>k.startsWith('mvlos.u.1.notes:pending:v1:')).length`);

  await seed();
  const unsent=await open(false,{},`window.__holdState=true`);await unsent.eval('window.__releaseMe()');
  const unsentNote=await unsent.eval<any>(`import('/src/data/notes.ts').then(m=>m.createNote({text:'UNSENT-BEFORE-RELOAD'}))`);await flushNotes(unsent);await unsent.close();
  const resumed=await open();await hydrate(resumed);await resumed.waitFor(`window.__puts.some(p=>p.path==='/api/state/notes')`);
  check('Restart uploads a dirty checkpoint even when the server note key is absent',await resumed.eval(`window.__puts.some(p=>p.path==='/api/state/notes'&&p.body.value.some(n=>n.id===${JSON.stringify(unsentNote.id)}))`));
  await resumed.eval(`const p=window.__puts.find(p=>p.path==='/api/state/notes');p.release({value:p.body.value,updatedAt:200})`);
  await resumed.waitFor(`JSON.parse(localStorage.getItem('mvlos.u.1.notes:state:v1')).dirty===false`);
  check('Acknowledgement clears the recovered dirty checkpoint after upload',await resumed.eval(`JSON.parse(localStorage.getItem('mvlos.u.1.notes:state:v1')).value.some(n=>n.id===${JSON.stringify(unsentNote.id)})`));
  await resumed.close();

  await seed();
  // Two concurrent admissions may each observe the last free slot. Seed the resulting
  // durable records: the soft admission cap must never make accepted edits unreadable.
  await control.eval(`for(let i=0;i<257;i++)localStorage.setItem('mvlos.u.1.notes:pending:v1:initial:admitted-'+i,JSON.stringify({generation:null,changes:[{...${JSON.stringify(old)},id:'admitted-'+i,text:'ADMITTED-'+i}]}))`);
  const overLimit=await open(false,{},`window.__holdState=true;const original=Storage.prototype.removeItem;Storage.prototype.removeItem=function(k){if(k.startsWith('mvlos.u.1.notes:pending:v1:'))throw new DOMException('Synthetic journal cleanup denial','QuotaExceededError');return original.call(this,k)}`);await overLimit.eval('window.__releaseMe()');
  check('Concurrent admissions beyond the soft limit remain readable',(await notes(overLimit)).length===257);
  try{await flushNotes(overLimit)}catch{}
  check('Checkpoint retains receipts for every accepted record beyond the soft limit',await overLimit.eval(`JSON.parse(localStorage.getItem('mvlos.u.1.notes:state:v1')).consumed.length===257`));await overLimit.close();
  const drainLimit=await open(false,{},`window.__holdState=true`);await drainLimit.eval('window.__releaseMe()');await flushNotes(drainLimit);
  check('Reload drains an over-limit admitted batch without losing notes',(await notes(drainLimit)).length===257&&await journalCount(drainLimit)===0);await drainLimit.close();

  await seed([old],100);
  const dirty=await open(false,{},`window.__holdState=true;window.addEventListener('storage',e=>e.stopImmediatePropagation(),true)`);await dirty.eval('window.__releaseMe()');
  const local=await dirty.eval<any>(`import('/src/data/notes.ts').then(m=>m.createNote({text:'DIRTY-LOCAL'}))`);await flushNotes(dirty);
  const newer=await open(false,{notes:{value:[],updatedAt:200}});await hydrate(newer);await flushNotes(newer);
  check('New clean server baseline retains real dirty edits but drops untouched old rows',(await notes(newer)).some(n=>n.id===local.id)&&!(await notes(newer)).some(n=>n.id==='note1'));
  const future={...old,text:'FUTURE-REMOTE',updated:Date.now()+1e9,edited:Date.now()+1e9};
  await pull(newer,[future],300);
  await dirty.eval(`import('/src/data/notes.ts').then(m=>m.updateNote('note1',{text:'INTENDED-EDIT'}))`);await flushNotes(dirty);
  const rebased=(await notes(dirty)).find(n=>n.id==='note1');
  check('Stale tab rebases the actual edit and advances the current note revision',rebased?.text==='INTENDED-EDIT'&&rebased.edited>future.edited,rebased);
  await dirty.eval(`import('/src/data/notes.ts').then(m=>m.purgeNote('note1'))`);await flushNotes(dirty);await pull(newer,[future],400);
  check('A real purge remains final through a newer remote snapshot',(await notes(newer)).find(n=>n.id==='note1')?.purged===true);
  await dirty.close();await newer.close();

  await seed();
  const admission=await open(false,{notes:{value:[],updatedAt:10}},`const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(window.__denyJournal&&k.startsWith('mvlos.u.1.notes:pending:v1:'))throw new DOMException('Synthetic journal denial','QuotaExceededError');if(window.__denyCheckpoint&&k==='mvlos.u.1.notes:state:v1')throw new DOMException('Synthetic checkpoint denial','QuotaExceededError');return original.call(this,k,v)}`);await hydrate(admission);
  const rejected=await admission.eval(`(async()=>{window.__denyJournal=true;try{(await import('/src/data/notes.ts')).createNote({text:'NOT-ADMITTED'});return false}catch{return true}})()`);
  check('Journal denial rejects the edit before visibility or acknowledgement',rejected&&!(await notes(admission)).some(n=>n.text==='NOT-ADMITTED')&&await journalCount(admission)===0);
  await admission.eval(`window.__denyJournal=false;window.__denyCheckpoint=true;import('/src/data/notes.ts').then(m=>m.createNote({text:'DURABLE-PENDING'}))`);
  let checkpointFailed=false;try{await flushNotes(admission)}catch{checkpointFailed=true}
  check('Checkpoint denial leaves admitted changes in durable journals',checkpointFailed&&await journalCount(admission)>0);
  await admission.close();
  const recovered=await open(false,{},`window.__holdState=true`);await recovered.eval('window.__releaseMe()');
  check('Navigation after checkpoint denial recovers the admitted local edit',(await notes(recovered)).some(n=>n.text==='DURABLE-PENDING'));
  await flushNotes(recovered);check('Recovered checkpoint consumes pending records',await journalCount(recovered)===0);await recovered.close();

  await seed();
  const receipt=await open(false,{notes:{value:[],updatedAt:10}},`const remove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(k){if(window.__denyCleanup&&k.startsWith('mvlos.u.1.notes:pending:v1:'))throw new DOMException('Synthetic cleanup denial','SecurityError');return remove.call(this,k)}`);await hydrate(receipt);
  await receipt.eval(`window.__denyCleanup=true;import('/src/data/notes.ts').then(m=>m.createNote({text:'ACK-THEN-PRUNED'}))`);try{await flushNotes(receipt)}catch{}
  const sent=await notes(receipt);await pull(receipt,sent,20);await pull(receipt,[],30);
  check('Successful checkpoint retains receipts when journal deletion fails',await receipt.eval(`JSON.parse(localStorage.getItem('mvlos.u.1.notes:state:v1')).consumed.length>0`)&&await journalCount(receipt)>0);
  await receipt.close();
  const receiptsReload=await open(false,{},`window.__holdState=true`);await receiptsReload.eval('window.__releaseMe()');
  check('Retained consumed journal cannot resurrect acknowledged then pruned note',(await notes(receiptsReload)).length===0);
  await flushNotes(receiptsReload);check('Receipt cleanup retries after reload without replay',await journalCount(receiptsReload)===0);await receiptsReload.close();

  await seed();
  const ack=await open(false,{notes:{value:[],updatedAt:10}});await hydrate(ack);
  const changing=await ack.eval<any>(`import('/src/data/notes.ts').then(m=>m.createNote({text:'BEFORE-ACK'}))`);
  await ack.waitFor(`window.__puts.some(p=>p.path==='/api/state/notes')`);
  await ack.eval(`import('/src/data/notes.ts').then(m=>m.updateNote(${JSON.stringify(changing.id)},{text:'AFTER-ACK'}))`);
  await ack.eval(`const request=window.__puts.find(p=>p.path==='/api/state/notes');request.release({value:request.body.value,updatedAt:20})`);await sleep(150);await flushNotes(ack);
  check('An older acknowledgement cannot erase an admitted later edit',(await notes(ack)).find(n=>n.id===changing.id)?.text==='AFTER-ACK'&&await ack.eval(`JSON.parse(localStorage.getItem('mvlos.u.1.notes:state:v1')).dirty`));
  await ack.close();

  await seed();
  const late=await open(false,{notes:{value:[],updatedAt:10}},`const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(window.__pauseAdmission&&k.startsWith('mvlos.u.1.notes:pending:v1:')){window.__pauseAdmission=false;debugger}return original.call(this,k,v)}`);await hydrate(late);
  await late.send('Debugger.enable');const admissionPaused=new Promise<void>(resolve=>onPause=resolve);
  const lateEdit=late.eval(`window.__pauseAdmission=true;import('/src/data/notes.ts').then(m=>m.createNote({text:'REVOKED-PRIVATE'}))`);void lateEdit.catch(()=>{});
  await Promise.race([admissionPaused,sleep(10000).then(()=>{throw Error('journal admission did not pause')})]);
  await control.eval(`import('/src/os/accountSpace.ts').then(m=>m.clearAccountSpace())`);
  onPause=undefined;await late.send('Debugger.resume');await late.send('Debugger.disable');await lateEdit.catch(()=>{});await late.close();
  const afterLogout=await open(false,{},`window.__holdState=true`);await afterLogout.eval('window.__releaseMe()');
  check('A delayed write after logout cannot replay into the new account generation',!(await notes(afterLogout)).some(n=>n.text==='REVOKED-PRIVATE'));
  await afterLogout.close();

  await seed();
  const clearing=await open(false,{notes:{value:[],updatedAt:10}},`const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(window.__pauseCheckpoint&&k==='mvlos.u.1.notes:state:v1'){window.__pauseCheckpoint=false;debugger}return original.call(this,k,v)}`);await hydrate(clearing);
  await clearing.send('Debugger.enable');const checkpointPaused=new Promise<void>(resolve=>onPause=resolve);
  await clearing.eval(`window.__pauseCheckpoint=true;import('/src/data/notes.ts').then(m=>m.createNote({text:'CLEARED-CHECKPOINT'}))`);
  await Promise.race([checkpointPaused,sleep(10000).then(()=>{throw Error('checkpoint did not pause')})]);
  await control.eval(`window.__cleanupDone=false;void import('/src/os/accountSpace.ts').then(m=>m.clearAccountSpace()).then(()=>{window.__cleanupDone=true})`);
  await sleep(150);check('Logout cleanup waits behind an active note checkpoint writer',await control.eval(`!window.__cleanupDone`));
  onPause=undefined;await clearing.send('Debugger.resume');await clearing.send('Debugger.disable');await control.waitFor(`window.__cleanupDone`);
  check('Completed logout removes checkpoint and admitted journals',await control.eval(`localStorage.getItem('mvlos.u.1.notes:state:v1')===null&&Object.keys(localStorage).every(k=>!k.startsWith('mvlos.u.1.notes:pending:v1:'))`));
  await clearing.close();

  await seed([old],100);
  const consistent=await open(false,{notes:{value:[old],updatedAt:100}});await hydrate(consistent);await consistent.close();
  const malformed=await control.eval<string>(`const value=JSON.parse(localStorage.getItem('mvlos.u.1.notes:state:v1'));value.value=[];localStorage.setItem('mvlos.u.1.notes:state:v1',JSON.stringify(value));JSON.stringify(value)`);
  const inconsistent=await open();await inconsistent.eval('window.__releaseMe()');await inconsistent.waitFor(`import('/src/os/synced.ts').then(m=>m.getSyncStatus().state==='error')`);
  check('Inconsistent checkpoint fails closed without rewriting its evidence',await inconsistent.eval(`import('/src/os/synced.ts').then(m=>m.getSyncedHydration()===null&&localStorage.getItem('mvlos.u.1.notes:state:v1')===${JSON.stringify(malformed)})`));
  await inconsistent.close();

  await control.eval(`localStorage.clear()`);
  for(const name of ['mvlos_sid','mvlos_login','mvlos_uid'])await control.send('Network.deleteCookies',{name,url:origin});
  const guest=await open(false,{},`window.__denyCanonical=true;const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='mvlos.visitor.notes:state:v1')throw new DOMException('Synthetic visitor checkpoint denial','QuotaExceededError');return original.call(this,k,v)}`);await guest.eval('window.__releaseMe()');await sleep(150);
  const guestNote=await guest.eval<any>(`import('/src/data/notes.ts').then(m=>m.createNote({text:'VISITOR-JOURNAL-ONLY'}))`);try{await flushNotes(guest)}catch{}await guest.close();
  await control.eval(`for(const key of Object.keys(localStorage))if(key.startsWith('mvlos.visitor.sync.'))localStorage.removeItem(key);localStorage.setItem('mvlos.owner','foreign-owner');localStorage.setItem('mvlos.legacy-owner-claim:v1',JSON.stringify({owner:'2',marker:'foreign-owner'}))`);
  for(const [name,value]of [['mvlos_sid',sid],['mvlos_login',login],['mvlos_uid','1']])await control.send('Network.setCookie',{name,value,url:origin});
  const transferred=await open();await hydrate(transferred);
  check('Sign-in transfers admitted visitor note even without a visitor checkpoint or ordinary key',(await notes(transferred)).some(n=>n.id===guestNote.id&&n.text==='VISITOR-JOURNAL-ONLY'));
  check('Visitor journal transfer does not adopt foreign older-owner data',await transferred.eval(`JSON.parse(localStorage.getItem('mvlos.legacy-owner-claim:v1')).owner==='2'`));
  await transferred.close();

  await control.eval('localStorage.clear()');
  for(const name of ['mvlos_sid','mvlos_login','mvlos_uid'])await control.send('Network.deleteCookies',{name,url:origin});
  const currentGuest=await open();await currentGuest.eval('window.__releaseMe()');
  const currentNote=await currentGuest.eval<any>(`import('/src/data/notes.ts').then(m=>m.createNote({text:'CURRENT-VISITOR-CHECKPOINT'}))`);await flushNotes(currentGuest);await currentGuest.close();
  const obsoleteKey='mvlos.visitor.widget-stage:v1:mvlos.sync.notes:obsolete';
  await control.eval(`localStorage.setItem(${JSON.stringify(obsoleteKey)},JSON.stringify({key:'mvlos.sync.notes',source:'obsolete',origin:{owner:null,kind:'plain',marker:null,older:null}}))`);
  for(const [name,value]of [['mvlos_sid',sid],['mvlos_login',login],['mvlos_uid','1']])await control.send('Network.setCookie',{name,value,url:origin});
  const currentTransfer=await open(false,{},`const original=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k===${JSON.stringify(obsoleteKey)})throw new DOMException('Obsolete visitor input unreadable','SecurityError');return original.call(this,k)}`);await hydrate(currentTransfer);
  check('Visitor checkpoint authority does not depend on an obsolete unreadable stage',(await notes(currentTransfer)).some(n=>n.id===currentNote.id&&n.text==='CURRENT-VISITOR-CHECKPOINT'));
  check('Visitor checkpoint transfer retains obsolete stage evidence',await control.eval(`localStorage.getItem(${JSON.stringify(obsoleteKey)})!==null`));
  await currentTransfer.close();await control.close();
} finally {onPause=undefined;await b.close();vite.kill('SIGTERM');rmSync(data,{recursive:true,force:true})}
console.log(`${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
