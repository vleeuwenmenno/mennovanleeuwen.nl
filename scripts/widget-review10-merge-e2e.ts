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
  const control=await newPage(b,1500,1000,'');await control.send('Page.navigate',{url:origin+'/package.json'});
  for (const [name,value]of [['mvlos_sid',sid],['mvlos_login',login],['mvlos_uid','1']]) await control.send('Network.setCookie',{name,value,url:origin});
  const initial={value:{schema:2,configs:{'saved-a':{at:1,value:{text:'BASE'}}},placements:{places:{},removed:''},installations:{}},base:12,dirty:false};
  await control.eval(`localStorage.clear();localStorage.setItem('mvlos.u.1.moved','1');localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(JSON.stringify(initial))})`);
  const p=await open(false,{},`window.addEventListener('storage',e=>{if(window.__delayEvents)e.stopImmediatePropagation()},true);const base=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(k===${JSON.stringify(key)}&&window.__armMergeRead){const stack=new Error().stack;if(stack.includes('beforeRead')){window.__strictRead=base.call(this,k);window.__afterStrict=true;return window.__strictRead;}if(window.__afterStrict&&stack.includes('saveNow')){window.__armMergeRead=false;window.__thrownStack=stack;throw new DOMException('Synthetic merge read failure','SecurityError')}}return base.call(this,k)}`);
  try {
    await hydrate(p);await flush(p);await p.eval('window.__delayEvents=true');
    const other=await open();
    await hydrate(other);await set(other,'saved-b',{text:'NEWER-DURABLE-EDIT'});await flush(other);
    await other.close();await sleep(500);
    console.log('OTHER-TAB committed',await control.eval(`localStorage.getItem(${JSON.stringify(key)})`));
    await p.eval('window.__armMergeRead=true');const error=await p.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalConfigs.flush().then(()=>'',e=>e.message))`);
    const evidence=await p.eval(`({strict:JSON.parse(window.__strictRead),failure:window.__thrownStack,target:JSON.parse(localStorage.getItem(${JSON.stringify(key)}))})`);
    console.log('SECOND-READ',JSON.stringify(evidence));
    check('Unreadable merge read cannot overwrite newer durable data',!!error&&!!evidence.target.value.configs['saved-b'],{error,evidence});
  } finally {await p.close()}
  await control.close();
} finally {await b.close();vite.kill('SIGTERM');rmSync(data,{recursive:true,force:true})}
console.log(`${passed} passed, ${failed} failed`);if(failed)process.exitCode=1;
