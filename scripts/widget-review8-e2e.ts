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
  const cases = [
    ['guest-copy','guest','setItem','mvlos.u.1.sync.widgets:state:v2'],
    ['guest-intent','guest','setItem','mvlos.u.1.widget-move:guest:v2'],
    ['guest-source-read','guest','getItem','mvlos.visitor.sync.widgets:state:v2'],
    ['guest-intent-cleanup','guest','removeItem','mvlos.u.1.widget-move:guest:v2'],
    ['explicit-intent','plain','setItem','mvlos.u.1.widget-move:plain:v2'],
    ['explicit-source-read','plain','getItem','mvlos.sync.widgets:state:v2'],
    ['explicit-marker-read','plain','getItem','mvlos.account'],
    ['explicit-copy','plain','setItem','mvlos.u.1.sync.widgets:state:v2'],
    ['explicit-receipt','plain','setItem','mvlos.u.1.widget-move:plain:done:v2'],
    ['explicit-intent-cleanup','plain','removeItem','mvlos.u.1.widget-move:plain:v2'],
    ['explicit-ordinary','ordinary','setItem','mvlos.u.1.widget-stage:v1:mvlos.sync.widgets:*'],
    ['explicit-ordinary-read','ordinary','getItem','mvlos.sync.widgets'],
    ['explicit-moved','ordinary','setItem','mvlos.u.1.moved'],
  ] as const
  for(const [scenario,kind,method,failKey] of cases) {
    await control.eval(`localStorage.clear();${kind==='guest'?`localStorage.setItem('mvlos.visitor.sync.widgets:state:v2',${JSON.stringify(source)})`:kind==='plain'?`localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets:state:v2',${JSON.stringify(source)})`:`localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets',JSON.stringify({value:{'private-note':{text:'SYNTHETIC-SAVED-NOTE'}},base:0,dirty:true}))`}`);
    const p=await open(false,{},`const base=Storage.prototype[${JSON.stringify(method)}],expected=${JSON.stringify(failKey)};Storage.prototype[${JSON.stringify(method)}]=function(k,...args){if((expected.endsWith('*')?k.startsWith(expected.slice(0,-1)):k===expected)&&!sessionStorage.getItem('one-failure')){sessionStorage.setItem('one-failure','1');throw new DOMException('One synthetic storage failure','QuotaExceededError')}return base.call(this,k,...args)}`);
    try {
      await release(p);let evidence=await observe(p);console.log(scenario,'first',JSON.stringify(evidence));
      check(scenario+' blocks cutover until saved data is available',(!evidence.ready&&evidence.unresolved)||(evidence.ready&&!!evidence.configs['private-note']),evidence);
      await restart(p);evidence=await observe(p);console.log(scenario,'reload',JSON.stringify(evidence));
      check(scenario+' recovers saved note on reload',!!evidence.configs['private-note'],evidence);
    } finally {await p.close()}
  }
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.visitor.sync.widgets:state:v2',${JSON.stringify(source)});localStorage.setItem('mvlos.u.1.sync.widgets:state:v2',JSON.stringify({value:{schema:2,configs:{existing:{at:1,value:{days:4}}},placements:{places:{},removed:''},installations:{}},base:0,dirty:true}))`)
  const existing=await open()
  try {await release(existing);const value=await observe(existing);check('Visitor migration preserves a preexisting account target',value.ready&&value.configs.existing?.days===4&&!value.configs['private-note']&&!value.guestPlan,value)} finally {await existing.close()}
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.visitor.sync.widgets:state:v2',${JSON.stringify(source)});localStorage.setItem('mvlos.u.1.moved','1');localStorage.setItem('mvlos.u.1.widget-move:guest:v2','1')`)
  const oldIntent=await open()
  try {await release(oldIntent);const value=await observe(oldIntent);check('Older visitor intent recovers when no account target existed',value.ready&&!!value.configs['private-note']&&!value.guestPlan,value)} finally {await oldIntent.close()}
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.visitor.sync.widgets:state:v2',${JSON.stringify(source)});localStorage.setItem('mvlos.u.1.moved','1');localStorage.setItem('mvlos.u.1.widget-move:guest:v2','1');localStorage.setItem('mvlos.u.1.sync.widgets:state:v2',JSON.stringify({value:{schema:2,configs:{},placements:{places:{},removed:''},installations:{}},base:0,dirty:true}))`)
  const ambiguous=await open()
  try {await release(ambiguous);const value=await observe(ambiguous);check('Older visitor intent with existing target stays unresolved',!value.ready&&value.unresolved&&value.guestPlan==='1'&&!!value.target,value)} finally {await ambiguous.close()}
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.owner','other-owner');localStorage.setItem('mvlos.legacy-owner-claim:v1',JSON.stringify({owner:'2',marker:'other-owner'}));localStorage.setItem('mvlos.visitor.sync.widgets:state:v2',${JSON.stringify(source)})`)
  const foreign=await open(false,{},`const base=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='mvlos.u.1.sync.widgets:state:v2'&&!sessionStorage.getItem('one-failure')){sessionStorage.setItem('one-failure','1');throw new DOMException('One synthetic failed write','QuotaExceededError')}return base.call(this,k,v)}`)
  try {await release(foreign);let value=await observe(foreign);check('Foreign older-owner claim does not discard pending visitor transfer',!value.ready&&value.unresolved&&!!value.guestPlan,value);await restart(foreign);value=await observe(foreign);check('Visitor retry remains available alongside foreign older-owner claim',value.ready&&!!value.configs['private-note'],value)} finally {await foreign.close()}
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.account','1');localStorage.setItem('mvlos.sync.widgets',JSON.stringify({value:{old:{days:1}},base:0,dirty:true}));localStorage.setItem('mvlos.u.1.sync.widgets',JSON.stringify({value:{existing:{days:4}},base:0,dirty:true}))`)
  const ordinaryConflict=await open()
  try {await release(ordinaryConflict);const value=await observe(ordinaryConflict);check('Existing ordinary account target remains authoritative',value.ready&&value.configs.existing?.days===4&&!value.configs.old,value)} finally {await ordinaryConflict.close()}
  await control.close();
} finally {await b.close();vite.kill('SIGTERM');rmSync(data,{recursive:true,force:true})}
console.log(`${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
