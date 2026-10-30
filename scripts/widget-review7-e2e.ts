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
  const loginAs=async(id:number|null)=>{
    for (const name of ['mvlos_sid','mvlos_login','mvlos_uid']) await control.send('Network.deleteCookies',{name,url:origin});
    if(id)for(const [name,value]of [['mvlos_sid',id===1?sid:sid2],['mvlos_login',id===1?login:'widget-review6-b'],['mvlos_uid',String(id)]])await control.send('Network.setCookie',{name,value,url:origin});
  };
  const source=JSON.stringify({value:{schema:2,configs:{'private-note':{at:1,value:{text:'SYNTHETIC-LEGACY-NOTE'}}},placements:{places:{},removed:''},installations:{}},base:0,dirty:true});
  const seed=async(marker='legacy-owner',extra='')=>control.eval(`localStorage.clear();localStorage.setItem('mvlos.owner',${JSON.stringify(marker)});localStorage.setItem('mvlos.sync.widgets:state:v2',${JSON.stringify(source)});${extra}`);

  await loginAs(1);
  await seed('legacy-prior-no-envelope', `localStorage.removeItem('mvlos.sync.widgets:state:v2');localStorage.setItem('mvlos.sync.widgets',JSON.stringify({value:{private:{text:'ACCOUNT-A-OLD-CONFIG'}},base:0,dirty:true}))`);
  const {stripTypeScriptTypes}=await import('node:module');
  const priorSource=readFileSync(`${WT}/scripts/fixtures/account-space-d7.ts`,'utf8').replace("from './storageTransaction'",`from '${origin}/src/os/storageTransaction.ts'`);
  const priorJS=stripTypeScriptTypes(priorSource);
  await control.eval(`import(${JSON.stringify('data:text/javascript;base64,'+Buffer.from(priorJS).toString('base64'))}).then(m=>{window.__prior=m})`);
  await control.eval(`window.__prior.waitAccountSpace?.();`);
  check('Prior version copied A ordinary legacy config',await control.eval(`JSON.parse(localStorage.getItem('mvlos.u.1.sync.widgets')).value.private.text==='ACCOUNT-A-OLD-CONFIG'`));
  await control.eval(`(async()=>{window.__prior.freezeAccount(false);await window.__prior.clearAccountSpace()})()`);
  // Old source-writing tab replaces the plain key after that import (it does not
  // participate in new account namespaces or the IDB gate).
  await control.eval(`localStorage.setItem('mvlos.sync.widgets',JSON.stringify({value:{private:{text:'ACCOUNT-A-OLD-CONFIG'}},base:0,dirty:true}))`);
  await loginAs(2);
  const p=await open();await p.eval('window.__releaseMe()');await sleep(300)
  check('Prior ordinary migration blocks cross-account reclamation',await p.eval(`!localStorage.getItem('mvlos.u.2.sync.widgets')&&import('/src/os/accountSpace.ts').then(m=>m.widgetMigrationUnresolved())`))
  const old=await p.eval<string>('window.__document');await p.send('Page.reload');await p.waitFor(`window.__document!==${JSON.stringify(old)}&&!!window.__releaseMe`);await p.eval('window.__releaseMe()');await sleep(200)
  check('B reload retains ambiguous source without importing it',await p.eval(`!localStorage.getItem('mvlos.u.2.sync.widgets')&&!localStorage.getItem('mvlos.u.2.sync.widgets:state:v2')`))
  await p.close()
  await loginAs(1);await seed('owner-A')
  const racer=await newPage(b,1500,1000,inject(false,{},`const base=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){const out=base.call(this,k,v);if(k==='mvlos.legacy-owner-claim:v1')debugger;return out}`))
  try {
    await racer.send('Debugger.enable');const paused=new Promise<void>(resolve=>onPause=resolve)
    await racer.send('Page.navigate',{url:origin});await Promise.race([paused,sleep(15000).then(()=>{throw Error('Claim did not pause')})])
    const foreign=JSON.stringify({value:{foreign:{text:'OWNER-B-PRIVATE'}},base:0,dirty:true})
    await control.eval(`localStorage.setItem('mvlos.owner','owner-B');localStorage.setItem('mvlos.sync.widgets',${JSON.stringify(foreign)});localStorage.setItem('mvlos.history','OWNER-B-PRIVATE-HISTORY')`)
    onPause=undefined;await racer.send('Debugger.resume');await racer.send('Debugger.disable');await racer.waitFor('!!window.__releaseMe');await racer.eval('window.__releaseMe()');await sleep(300)
    const evidence=await racer.eval(`({marker:localStorage.getItem('mvlos.owner'),adopted:localStorage.getItem('mvlos.u.1.sync.widgets'),history:localStorage.getItem('mvlos.u.1.history'),source:localStorage.getItem('mvlos.sync.widgets'),sourceHistory:localStorage.getItem('mvlos.history')})`)
    check('Changed ownership cannot import or delete foreign ordinary sources',!evidence.adopted&&!evidence.history&&evidence.source===foreign&&evidence.sourceHistory==='OWNER-B-PRIVATE-HISTORY'&&evidence.marker==='owner-B',evidence)
  } finally {onPause=undefined;await racer.send('Debugger.resume').catch(()=>{});await racer.close()}
  await seed('legacy-copy-failure')
  const interrupted=await open(false,{},`const base=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='mvlos.u.1.sync.widgets:state:v2'&&!sessionStorage.getItem('copy-failed')){sessionStorage.setItem('copy-failed','1');throw new DOMException('One failed copy','QuotaExceededError')}return base.call(this,k,v)}`)
  try {
    await interrupted.eval('window.__releaseMe()');await sleep(300)
    const blocked=await interrupted.eval(`(async()=>({ready:(await import('/src/widgets/platform/canonicalState.ts')).widgetsHydrated(),canonical:localStorage.getItem('mvlos.u.1.sync.widgets:state:v2'),plan:localStorage.getItem('mvlos.u.1.widget-move:plain:v2')}))()`)
    check('Failed copy blocks empty canonical cutover',!blocked.ready&&!blocked.canonical&&!!blocked.plan,blocked)
    await reload(interrupted)
    check('Reload retries and recovers failed legacy copy',!!(await configs(interrupted))['private-note'],await durable(interrupted))
  } finally {await interrupted.close()}
  await seed('legacy-target-conflict',`localStorage.setItem('mvlos.u.1.sync.widgets:state:v2',JSON.stringify({value:{schema:2,configs:{existing:{at:2,value:{days:4}}},placements:{places:{},removed:''},installations:{}},base:0,dirty:true}))`)
  const conflict=await open()
  try {
    await conflict.eval('window.__releaseMe()');await sleep(300)
    const evidence=await conflict.eval(`({target:JSON.parse(localStorage.getItem('mvlos.u.1.sync.widgets:state:v2')),plan:localStorage.getItem('mvlos.u.1.widget-move:plain:v2'),done:localStorage.getItem('mvlos.u.1.widget-move:plain:done:v2')})`)
    check('Different existing target cannot mark migration complete',!!evidence.plan&&!evidence.done&&evidence.target.value.configs.existing.value.days===4,evidence)
  } finally {await conflict.close()}
  await control.close();
} finally {await b.close();vite.kill('SIGTERM');rmSync(data,{recursive:true,force:true})}
console.log(`${passed} passed, ${failed} failed`);
if(failed)process.exitCode=1;
