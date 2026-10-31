// Real cross-tab transaction exclusion, server metadata, identity replay and degraded storage.
// Synthetic accounts/data only; Chromium is muted by the repository CDP harness.
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Page } from './perf/cdp.ts'
const WT = process.env.WT ?? process.cwd(), PORT = Number(process.env.PORT ?? 5293)
const data = mkdtempSync('/tmp/mvlos-widget-review14-')
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
  const stateKey='mvlos.u.1.notes:state:v1', fenceKey='mvlos.u.1.notes:inputs-consumed:v1';
  const original={id:'note1',text:'ORIGINAL',color:'yellow',tilt:0,created:1,updated:1,edited:1};
  const other={...original,id:'note2',text:'UNRELATED-EDIT',created:2};
  const notes=(p:Page)=>p.eval<any[]>(`import('/src/data/notes.ts').then(m=>m.allNotes())`);
  const state=(p:Page)=>p.eval<any>(`JSON.parse(localStorage.getItem('${stateKey}'))`);
  const fence=(p:Page)=>p.eval<any>(`JSON.parse(localStorage.getItem('${fenceKey}'))`);
  const flushNotes=(p:Page)=>p.eval(`import('/src/data/notes.ts').then(m=>m.flushNotes())`);
  const closeAccount=(p:Page)=>p.eval(`import('/src/os/accountSpace.ts').then(m=>m.clearAccountSpace())`);
  const pull=(p:Page,value:unknown[],base:number)=>p.eval(`window.__remote={notes:{value:${JSON.stringify(value)},updatedAt:${base}}};import('/src/os/synced.ts').then(m=>m.pullAll())`);
  const seed=(value:unknown[],migration=true)=>control.eval(`localStorage.clear();${migration?"localStorage.setItem('mvlos.account','1')":"localStorage.setItem('mvlos.u.1.moved','1')"};localStorage.setItem('${migration?'mvlos.sync.notes':'mvlos.u.1.sync.notes'}',JSON.stringify({value:${JSON.stringify(value)},base:${migration?0:50},dirty:${migration}}))`);
  const offline=async()=>{const p=await open(false,{},'window.__holdState=true');await p.eval('window.__releaseMe()');await flushNotes(p);return p};
  // Drain any earlier in-flight request with the current server conflict before inspecting
  // the next upload. This avoids depending on the timing of the ordinary push debounce.
  const uploadAt=async(p:Page,base:number)=>{
    for(let attempt=0;attempt<8;attempt++) {
      await p.waitFor(`window.__puts.some(p=>p.path==='/api/state/notes'&&!p.responded)`,15000);
      const sent=await p.eval<any>(`(()=>{const index=window.__puts.findIndex(p=>p.path==='/api/state/notes'&&!p.responded);return {index,...window.__puts[index].body}})()`);
      if(sent.base===base)return sent;
      await p.eval(`const p=window.__puts[${sent.index}];p.responded=true;p.release({...window.__remote.notes,conflict:true})`);
    }
    throw Error('Upload did not use current server baseline');
  };
  const acknowledge=async(p:Page,index:number,base:number)=>{
    await p.eval(`const p=window.__puts[${index}];p.responded=true;p.release({value:p.body.value,updatedAt:${base}})`);
    await p.waitFor(`(()=>{const s=JSON.parse(localStorage.getItem('${stateKey}'));return s.base===${base}&&!s.dirty})()`);
  };
  const noLive=(value:any[])=>!value.some(n=>n.id==='note1'&&!n.purged);

  // A pending edit can be newer than a purge without a clock skew (made after an unseen
  // purge), or have a future clock. Cover actual local edits as well as imported pending notes.
  for(const migration of [false,true])for(const future of [false,true]) {
    const label=`${migration?'Imported':'Local'} ${future?'future':'normal'} clock`;
    const now=Date.now(),editTime=now+(future?365*864e5:0);
    const live={...original,text:'PENDING-LIVE-TEXT',updated:editTime,edited:editTime};
    const purged={...original,text:'',updated:now-1000,edited:now-1000,deleted:now-1000,purged:true};
    const remoteOnly={...purged,id:'clean-remote-tombstone',created:3};
    let tab:Page;
    if(migration) {
      await seed([live,other]);tab=await open(false,{notes:{value:[purged,remoteOnly],updatedAt:100}});await hydrate(tab);
    } else {
      await seed([original],false);tab=await open(false,{notes:{value:[original],updatedAt:50}});await hydrate(tab);
      await tab.eval(`(async()=>{const m=await import('/src/data/notes.ts');const clock=Date.now;Date.now=()=>${editTime};try{m.updateNote('note1',{text:'PENDING-LIVE-TEXT'})}finally{Date.now=clock}m.createNote({text:'UNRELATED-EDIT'});await m.flushNotes()})()`);
      await pull(tab,[purged,remoteOnly],100);
    }
    await flushNotes(tab);
    const before=await state(tab);
    check(label+': observed purge transforms the pending revision itself',before.value.some((n:any)=>n.id==='note1'&&n.purged)&&before.edits.some((n:any)=>n.id==='note1'&&n.purged)&&noLive(before.edits),before);
    check(label+': unrelated edits remain pending without promoting clean tombstones',before.edits.some((n:any)=>n.text==='UNRELATED-EDIT'&&!n.purged)&&!before.edits.some((n:any)=>n.id===remoteOnly.id));
    await pull(tab,[],200);await flushNotes(tab);
    check(label+': baseline pruning cannot reveal a live pending component',noLive((await state(tab)).value)&&noLive((await state(tab)).edits));await tab.close();
    const reloaded=await offline();
    check(label+': terminal state and unrelated edit survive offline reload',noLive(await notes(reloaded))&&(await notes(reloaded)).some(n=>n.text==='UNRELATED-EDIT'&&!n.purged));await reloaded.close();
    const online=await open(false,{notes:{value:[],updatedAt:200}});await hydrate(online);
    const sent=await uploadAt(online,200);
    check(label+': upload body cannot resurrect the purged note',noLive(sent.value)&&sent.value.some((n:any)=>n.text==='UNRELATED-EDIT'&&!n.purged),sent.value);
    await acknowledge(online,sent.index,300);await pull(online,[],400);await flushNotes(online);
    const cleared=await state(online);
    check(label+': acknowledged revisions prune without accumulating tombstone history',cleared.edits.length===0&&cleared.value.length===0&&cleared.migration.length===0&&(await fence(online)).pending.length===0,cleared);
    await online.close();
  }

  // A fully dominated local revision is already acknowledged by the server tombstone. Do not
  // invent a new dirty tombstone or retain all historical terminal IDs to prevent resurrection.
  await seed([original]);
  const newerPurge={...original,text:'',updated:100,edited:100,deleted:100,purged:true};
  const dominated=await open(false,{notes:{value:[newerPurge],updatedAt:100}});await hydrate(dominated);
  check('Dominating server tombstone discharges the represented local revision',(await state(dominated)).edits.length===0&&!(await state(dominated)).dirty);
  await pull(dominated,[],200);await flushNotes(dominated);
  check('Clean terminal history is pruned with its newer empty baseline',(await state(dominated)).value.length===0&&(await fence(dominated)).pending.length===0);await dominated.close();

  // Existing checkpoints from before this fix may still contain raw live components beneath
  // a correctly purged value. Reading and reconciling them must repair the component safely.
  const priorTime=Date.now(),oldLive={...original,text:'PRE-R14-LIVE',updated:priorTime+864e5,edited:priorTime+864e5};
  const oldPurge={...original,text:'',updated:priorTime,edited:priorTime,deleted:priorTime,purged:true};
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.u.1.moved','1');localStorage.setItem('${stateKey}',JSON.stringify({schema:1,generation:null,value:[${JSON.stringify({...oldPurge,updated:oldLive.updated})}],base:100,dirty:true,server:[${JSON.stringify(oldPurge)}],edits:[${JSON.stringify(oldLive)}],consumed:[]}))`);
  const upgraded=await open(false,{notes:{value:[],updatedAt:200}});await hydrate(upgraded);
  check('Earlier checkpoint repairs its live pending component before baseline pruning',noLive((await state(upgraded)).edits)&&(await state(upgraded)).edits.some((n:any)=>n.id==='note1'&&n.purged));
  check('Earlier checkpoint also uploads only the terminal revision',noLive((await uploadAt(upgraded,200)).value));await upgraded.close();

  const event={source:'google',calendarId:'fixture',uid:'fixture-uid',title:'Fixture',start:'2026-10-30T10:00:00Z',end:'2026-10-30T11:00:00Z',allDay:false,linked:1000};
  for(const kind of ['links','trash','restore','purge']) {
    let imported:any={...original,text:'OLD-IMPORT-TEXT',updated:10,edited:10};
    let remote:any={...original,text:'CONFIRMED-REMOTE-TEXT',updated:20,edited:20};
    if(kind==='links')imported={...imported,events:[event],eventsAt:1000};
    if(kind==='trash')imported={...imported,updated:40,deleted:40};
    if(kind==='restore'){imported={...imported,updated:40,restored:40};remote={...remote,updated:30,deleted:30}}
    if(kind==='purge'){imported={...imported,updated:Date.now()+864e5,edited:Date.now()+864e5};remote={...remote,text:'',updated:Date.now(),deleted:Date.now(),purged:true}}
    await seed([imported,other]);
    const tab=await open(false,{notes:{value:[remote],updatedAt:100}});await hydrate(tab);await flushNotes(tab);
    const expected=(await state(tab)).value.find((n:any)=>n.id==='note1');
    check(kind+': merged note has confirmed text and intended domain state',kind==='purge'?expected.purged&&expected.text==='':expected.text==='CONFIRMED-REMOTE-TEXT'&&(kind==='links'?expected.events?.[0]?.uid===event.uid:kind==='trash'?expected.deleted===40:expected.restored===40&&expected.deleted===undefined),expected);
    check(kind+': migration continuation equals the complete current revision',isDeepStrictEqual((await fence(tab)).pending.find((n:any)=>n.id==='note1'),expected));
    await closeAccount(tab);await tab.close();
    const back=await offline();
    check(kind+': logout and offline reload preserve the merged revision',isDeepStrictEqual((await notes(back)).find(n=>n.id==='note1'),expected)&&(await notes(back)).some(n=>n.text==='UNRELATED-EDIT'));await back.close();
    const online=await open(false,{notes:{value:[],updatedAt:200}});await hydrate(online);const sent=await uploadAt(online,200);
    check(kind+': restored migration uploads its merged revision',isDeepStrictEqual(sent.value.find((n:any)=>n.id==='note1'),expected),sent.value);
    await acknowledge(online,sent.index,300);await pull(online,[],400);await flushNotes(online);await closeAccount(online);await online.close();
    const final=await offline();
    check(kind+': acknowledged and pruned continuation does not reimport after another logout',(await notes(final)).length===0&&(await fence(final)).pending.length===0);await final.close();
  }
  await control.close();
} finally {onPause=undefined;await b.close();vite.kill('SIGTERM');rmSync(data,{recursive:true,force:true})}
console.log(`${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
