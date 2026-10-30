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
  for(const mode of ['plain','older','visitor']) {
    const old=JSON.stringify({value:{'private-note':{text:'OLD-SOURCE'}},base:0,dirty:true});
    const newer=JSON.stringify({value:{'private-note':{text:'NEWER-ACCOUNT-EDIT'}},base:99,dirty:true});
    const target='mvlos.u.1.sync.widgets', source=mode==='visitor'?'mvlos.visitor.sync.widgets':'mvlos.sync.widgets';
    await control.eval(`localStorage.clear();${mode==='plain'?"localStorage.setItem('mvlos.account','1');":mode==='older'?"localStorage.setItem('mvlos.owner','synthetic-owner');":''}localStorage.setItem(${JSON.stringify(source)},${JSON.stringify(old)})`);
    const p=await newPage(b,1500,1000,inject(false,{},`const base=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){const out=base.call(this,k,v);if(k.startsWith('mvlos.u.1.widget-stage:v1:mvlos.sync.widgets:')&&!sessionStorage.getItem('r10-paused')){sessionStorage.setItem('r10-paused','1');debugger;}return out}`));
    try {
      await p.send('Debugger.enable');
      const paused=new Promise<void>(resolve=>onPause=resolve);
      await p.send('Page.navigate',{url:origin});
      await Promise.race([paused,sleep(10000).then(()=>{throw Error('no target pause')})]);
      const before=await control.eval(`({target:localStorage.getItem(${JSON.stringify(target)}),receipt:localStorage.getItem('mvlos.u.1.legacy-copy:v2:mvlos.sync.widgets')})`);
      await control.eval(`localStorage.setItem(${JSON.stringify(target)},${JSON.stringify(newer)})`);
      const written=await control.eval(`localStorage.getItem(${JSON.stringify(target)})`);
      onPause=undefined;await p.send('Debugger.resume');await p.send('Debugger.disable');
      await p.waitFor(`!!window.__releaseMe&&document.querySelector('.desktop')&&!document.querySelector('.boot')`,90000);
      await hydrate(p);await flush(p);
      const evidence=await p.eval(`(async()=>{const c=await import('/src/widgets/platform/canonicalState.ts');return {target:localStorage.getItem(${JSON.stringify(target)}),source:localStorage.getItem(${JSON.stringify(source)}),receipt:localStorage.getItem('mvlos.u.1.legacy-copy:v2:mvlos.sync.widgets'),ready:c.widgetsHydrated(),configs:c.canonicalConfigs.get(),canonical:localStorage.getItem('mvlos.u.1.sync.widgets:state:v2')}})()`);
      console.log('INTERLEAVING',mode,JSON.stringify({before,written,evidence}));
      check(mode+' preserves concurrently written target',evidence.target===newer&&evidence.configs['private-note']?.text==='NEWER-ACCOUNT-EDIT',evidence);
    } finally {onPause=undefined;await p.send('Debugger.resume').catch(()=>{});await p.close()}
  }
  const oldNote=JSON.stringify({value:[{id:'note1',text:'OLD',color:'yellow',tilt:0,created:1,updated:1}],base:0,dirty:true})
  const newNote=JSON.stringify({value:[{id:'note1',text:'NEW',color:'yellow',tilt:0,created:1,updated:99}],base:99,dirty:true})
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.notes',${JSON.stringify(oldNote)})`)
  const notes=await newPage(b,1500,1000,inject(false,{},`const base=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){const out=base.call(this,k,v);if(k.startsWith('mvlos.u.1.widget-stage:v1:mvlos.sync.notes:')&&!sessionStorage.getItem('note-paused')){sessionStorage.setItem('note-paused','1');debugger}return out}`))
  try {
    await notes.send('Debugger.enable');const paused=new Promise<void>(resolve=>onPause=resolve);await notes.send('Page.navigate',{url:origin});await Promise.race([paused,sleep(10000).then(()=>{throw Error('note staging did not pause')})])
    await control.eval(`localStorage.setItem('mvlos.u.1.sync.notes',${JSON.stringify(newNote)})`)
    onPause=undefined;await notes.send('Debugger.resume');await notes.send('Debugger.disable');await notes.waitFor(`!!window.__releaseMe&&document.querySelector('.desktop')&&!document.querySelector('.boot')`,90000);await hydrate(notes);await flush(notes)
    check('Staging preserves concurrently updated sticky-note content',await notes.eval(`localStorage.getItem('mvlos.u.1.sync.notes')===${JSON.stringify(newNote)}&&import('/src/data/notes.ts').then(m=>m.getNote('note1')?.text==='NEW')`))
  } finally {onPause=undefined;await notes.send('Debugger.resume').catch(()=>{});await notes.close()}
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets',JSON.stringify({value:{owned:{text:'ACCOUNT'}},base:0,dirty:true}));localStorage.setItem('mvlos.visitor.sync.widgets',JSON.stringify({value:{guest:{text:'VISITOR'}},base:0,dirty:true}))`)
  const precedence=await open()
  try {await hydrate(precedence);await flush(precedence);const value=await configs(precedence);check('Account-owned legacy source precedes visitor source',!!value.owned&&!value.guest,value)} finally {await precedence.close()}
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets',JSON.stringify({value:{note1:{tilt:2}},base:0,dirty:true}));localStorage.setItem('mvlos.sync.notes',${JSON.stringify(oldNote)});localStorage.setItem('mvlos.sync.windows:desktop',JSON.stringify({value:[{app:'widget',props:{id:'note1',kind:'sticky'},x:91,y:72,w:280,h:200}],base:0,dirty:true}))`)
  const stagedOnly=await open()
  try {
    await hydrate(stagedOnly);await flush(stagedOnly);await sleep(1300)
    const evidence=await stagedOnly.eval(`(async()=>({note:(await import('/src/data/notes.ts')).getNote('note1')?.text,places:(await import('/src/os/widgetPlaces.ts')).widgetPlaces.get(),targets:['mvlos.u.1.sync.widgets','mvlos.u.1.sync.notes','mvlos.u.1.sync.windows:desktop'].map(k=>localStorage.getItem(k))}))()`)
    check('Staged widget and note inputs do not materialize ordinary keys',evidence.note==='OLD'&&Object.values(evidence.places.places).some((p:any)=>p.id==='note1')&&evidence.targets.every((v:unknown)=>v===null),evidence)
    await stagedOnly.eval(`import('/src/os/accountSpace.ts').then(m=>m.clearAccountSpace())`)
    await reload(stagedOnly)
    check('Staged sticky-note content survives logout cleanup and account return',await stagedOnly.eval(`import('/src/data/notes.ts').then(m=>m.getNote('note1')?.text==='OLD')`))
  } finally {await stagedOnly.close()}
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets',JSON.stringify({value:{agenda:{days:1}},base:0,dirty:true}));localStorage.setItem('mvlos.sync.widgets:placed',JSON.stringify({value:{places:{agenda:{id:'agenda',kind:'agenda',x:10,y:20,w:300,h:260,vw:1500,vh:1000,at:9999999999999}},removed:''},base:0,dirty:true}))`)
  const accountRemote={widgets:{value:{agenda:{days:7}},updatedAt:20},'widgets:placed':{value:{places:{agenda:{id:'agenda',kind:'agenda',x:321,y:456,w:300,h:260,vw:1500,vh:1000,at:1}},removed:''},updatedAt:20}}
  const remote=await open(false,accountRemote)
  try {await hydrate(remote);await flush(remote);const value=await configs(remote),places=await entries(remote,'agenda');check('Server account values override staged legacy config and geometry',value.agenda?.days===7&&places.length===1&&places[0].place.x===321,{value,places})} finally {await remote.close()}
  const staged=JSON.stringify({value:{'private-note':{text:'STAGED'}},base:0,dirty:true}), latest=JSON.stringify({value:{'private-note':{text:'DURING-GATE'}},base:99,dirty:true})
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets',${JSON.stringify(staged)})`)
  const locker=await newPage(b,1500,1000,'');await locker.send('Page.navigate',{url:origin+'/package.json'})
  const pending=await newPage(b,1500,1000,inject())
  try {
    await locker.send('Debugger.enable');const paused=new Promise<void>(resolve=>onPause=resolve)
    const holding=locker.eval(`import('/src/os/storageTransaction.ts').then(m=>m.storageTransaction(()=>{debugger}))`);void holding.catch(()=>{})
    await Promise.race([paused,sleep(10000).then(()=>{throw Error('gate did not pause')})])
    await pending.send('Page.navigate',{url:origin});await pending.waitFor(`!!window.__releaseMe&&document.querySelector('.desktop')&&!document.querySelector('.boot')`,90000)
    await pending.eval('window.__releaseMe()');await pending.waitFor(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.widgetsHydrated())`)
    await control.eval(`localStorage.setItem('mvlos.u.1.sync.widgets',${JSON.stringify(latest)})`)
    onPause=undefined;await locker.send('Debugger.resume');await holding;await flush(pending)
    check('Canonical cutover re-reads account target after waiting for gate',(await configs(pending))['private-note']?.text==='DURING-GATE'&&await pending.eval(`localStorage.getItem('mvlos.u.1.sync.widgets')===${JSON.stringify(latest)}`))
  } finally {onPause=undefined;await locker.send('Debugger.resume').catch(()=>{});await locker.close();await pending.close()}
  // Receipt written, native target write fails. Normal OS startup may persist an empty layout.
  const layout=[{app:'widget',props:{id:'private-note',kind:'sticky'},x:91,y:72,w:280,h:200}];
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets',JSON.stringify({value:{'private-note':{text:'SAVED-NOTE'}},base:0,dirty:true}));localStorage.setItem('mvlos.sync.windows:desktop',JSON.stringify({value:${JSON.stringify(layout)},base:0,dirty:true}))`);
  const p=await open(false,{},`const base=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('mvlos.u.1.widget-stage:v1:mvlos.sync.windows%3Adesktop:')&&!sessionStorage.getItem('copy-failed')){sessionStorage.setItem('copy-failed','1');throw new DOMException('Synthetic staging failure','QuotaExceededError')}return base.call(this,k,v)}`);
  try {
    await p.eval('window.__releaseMe()');await sleep(1500);
    const inspect=()=>p.eval(`(async()=>{const c=await import('/src/widgets/platform/canonicalState.ts');return {ready:c.widgetsHydrated(),layout:localStorage.getItem('mvlos.u.1.sync.windows:desktop'),receipt:localStorage.getItem('mvlos.u.1.legacy-copy:v2:mvlos.sync.windows%3Adesktop'),places:c.canonicalPlacements.get(),configs:c.canonicalConfigs.get()}})()`);
    console.log('FAILED-COPY before reload',JSON.stringify(await inspect()));
    await reload(p);
    const after=await inspect(); console.log('FAILED-COPY after reload',JSON.stringify(after));
    check('Failed target copy keeps placement after retry',Object.values(after.places.places).some((x:any)=>x.id==='private-note'),after);
  } finally {await p.close()}
  const oldLayout=JSON.stringify({value:layout,base:0,dirty:true}), accidental=JSON.stringify({value:[],base:0,dirty:true})
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.windows:desktop',${JSON.stringify(oldLayout)});localStorage.setItem('mvlos.u.1.sync.windows:desktop',${JSON.stringify(accidental)});localStorage.setItem('mvlos.u.1.legacy-copy:v2:mvlos.sync.windows%3Adesktop',JSON.stringify({marker:'1',older:null,source:${JSON.stringify(oldLayout)}}))`)
  const ambiguous=await open()
  try {await ambiguous.eval('window.__releaseMe()');await sleep(400);check('Earlier prepared receipt with conflicting target blocks cutover',await ambiguous.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>!m.widgetsHydrated()&&localStorage.getItem('mvlos.sync.windows:desktop')===${JSON.stringify(oldLayout)}&&localStorage.getItem('mvlos.u.1.sync.windows:desktop')===${JSON.stringify(accidental)})`))} finally {await ambiguous.close()}
  await control.close();
} finally {await b.close();vite.kill('SIGTERM');rmSync(data,{recursive:true,force:true})}
console.log(`${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
