// Six real source packages, domain effects and canonical cutover: synthetic data, muted Chromium.
// pnpm check:widget-builtins-ui (PORT overrides the isolated dev server port).
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5291)
const data = mkdtempSync('/tmp/mvlos-widget-builtins-')
process.env.DATA_DIR = data
const { database, encrypt, sha256 } = await import(`${WT}/server/db.ts`)
const { launch, newPage, sleep } = await import(`${WT}/scripts/perf/cdp.ts`)

let failed = 0
const check = (what: string, ok: boolean, extra?: unknown) => {
  console.log(ok ? 'PASS' : 'FAIL', what, ok || extra === undefined ? '' : JSON.stringify(extra))
  if (!ok) failed++
}

const now = Date.now()
const sid = randomBytes(24).toString('hex')
const login = 'ui-scale-check'
database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, login, encrypt('none'), now, now)
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid), 1, now, now + 86400_000)
const sid2 = randomBytes(24).toString('hex')
database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sid2), 1, now, now + 86400_000)

const vite = spawn(`${WT}/node_modules/.bin/vite`, ['--port', String(PORT), '--strictPort'], {
  cwd: WT,
  env: { ...process.env, DATA_DIR: data, GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_USERS: 'nobody', MC_WATCH: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
// Stopped with the script, however it ends.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) process.on(sig, () => (vite.kill(), process.exit(1)))
let log = ''
vite.stdout.on('data', (d) => (log += d))
vite.stderr.on('data', (d) => (log += d))
const origin = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 150 && !log.includes('ready') && vite.exitCode === null; i++) await sleep(200)
if (!log.includes('ready') || vite.exitCode !== null) throw new Error(`vite did not start:\n${log}`)

const b = await launch(1800, 1200)
const inject = `(() => {
  const native=window.fetch.bind(window);window.__requests=[];window.__writes=[];window.__copied=[];window.__opens=[];window.__held=[];window.__hold=false;
  Object.defineProperty(navigator,'clipboard',{value:{writeText:text=>{window.__copied.push(text);return Promise.resolve()}}});
  window.addEventListener('mvlos:open',e=>window.__opens.push(e.detail));
  const today=new Date(),key=[today.getFullYear(),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0')].join('-');window.__day=key;
  window.__task={id:'local|repeat',uid:'repeat',ref:'opaque-provider-task',list:'local',title:'Recurring daily task',due:key,allDay:true,completed:false,priority:0,repeat:'FREQ=DAILY',notes:'Private task notes'};
  window.__event={id:'event',uid:'meeting-uid',calendarId:'work',calendar:'Work',color:'#abcdef',title:'Synthetic meeting',start:key+'T10:00:00',end:key+'T11:00:00',allDay:false,location:'Office',url:'https://calendar.example.invalid/event',meet:'https://meet.example.invalid/room',ref:'opaque-event-provider'};
  window.fetch=async(input,options)=>{
    const path=String(input);window.__requests.push(path);
    const respond=value=>{if(!window.__hold)return Promise.resolve(Response.json(value));return new Promise((resolve,reject)=>{window.__held.push(()=>resolve(Response.json(value)));options?.signal?.addEventListener('abort',()=>{window.__aborted=(window.__aborted||0)+1;reject(new DOMException('Aborted','AbortError'))},{once:true})})};
    if(path==='/api/me')return Response.json({authEnabled:true,user:{id:1,login:'ui-scale-check',githubScopes:[]},forges:[],googleEnabled:true,google:{email:'synthetic@example.invalid'},caldav:[],integrations:{updown:'settings'}});
    if(path==='/api/calendar/calendars')return Response.json({calendars:[{id:'work',name:'Work',color:'#abcdef',selected:true,primary:true,source:'Google'}],errors:[]});
    if(path.startsWith('/api/calendar/events'))return respond({events:[window.__event],errors:['A linked calendar unavailable']});
    if(path.startsWith('/api/tasks')){
      if(options?.method==='PATCH'){const payload=JSON.parse(options.body);window.__writes.push(payload);const date=new Date(window.__day+'T12:00:00');date.setDate(date.getDate()+1);window.__task={...window.__task,due:date.toISOString().slice(0,10)};return Response.json({task:window.__task,advanced:true})}
      return Response.json({lists:[{id:'local',name:'Tasks',color:'#abcdef',source:'On this site',local:true,writable:true}],tasks:[window.__task],errors:[]});
    }
    if(path.startsWith('/api/inbox')){const hit=(n,kind='pr')=>({title:'Pull request '+n,repo:'sample/project',number:n,kind,draft:n===1,state:'open',updatedAt:Date.now(),source:'github',sourceLabel:'GitHub',url:'https://code.example.invalid/'+n});return respond({review:Array.from({length:7},(_,i)=>hit(i+1)),mine:[{...hit(20),title:'Own pull request'}],assigned:[{...hit(30,'issue'),title:'Assigned issue'}],errors:[]})}
    if(path==='/api/updown')return respond(Array.from({length:14},(_,i)=>({token:'check'+i,name:'Service '+i,url:'https://service.example.invalid/'+i,enabled:true,down:i===0,downSince:new Date(Date.now()-120000).toISOString(),error:i===0?'HTTP 503':null,uptime:99.9,responseTime:42,sslValid:true,sslExpiresAt:new Date(Date.now()+2*86400000).toISOString()})));
    if(path==='/api/minecraft')return respond({online:true,motd:'Synthetic world',version:'1.21',settings:{software:'Paper',difficulty:'Hard'},latency:42,world:{day:12,clock:'14:20',phase:'day'},players:{online:14,max:20,list:Array.from({length:14},(_,i)=>'Player'+i)},playerInfo:{Player0:{dimension:'nether',level:30,health:20}},checkedAt:Date.now()});
    if(path.endsWith('/timeline'))return Response.json({items:[],next:null});
    if(path.startsWith('/api/repos/')){if(path.includes('/pulls/'))return Response.json({number:1,pull:true,title:'Pull request 1',state:'open',draft:true,body:'Synthetic body',url:'https://code.example.invalid/1',author:{login:'synthetic'},labels:[],assignees:[],requestedReviewers:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),comments:0,head:{ref:'feature',label:'sample:feature'},base:{ref:'main'},mergeable:true,merged:false});return Response.json({fullName:'sample/project',defaultBranch:'main',permissions:{pull:true}})}
    if(path==='/api/repos')return Response.json({repos:[],sources:[],errors:[],privateScope:false});
    if(path.includes('api.open-meteo.com'))return Response.json({current:{temperature_2m:18,weather_code:0,is_day:1},hourly:{time:[]},daily:{time:[]}});
    return native(input,options);
  };
})()`
const p=await newPage(b,1800,1200,inject)
const widget=(kind:string)=>`document.querySelector('.widget-${kind} .wp-package')`
const text=(kind:string)=>p.eval<string>(`${widget(kind)}?.textContent`)
const click=async(kind:string,label:string)=>{
  const found=`[...${widget(kind)}.querySelectorAll('button,a')].find(e=>e.textContent===${JSON.stringify(label)})`
  await p.waitFor(`(()=>{const e=${found};return e&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'})()`,20_000)
  return p.eval(`(${found}).click()`)
}
const waitText=(kind:string,label:string)=>p.waitFor(`${widget(kind)}?.textContent.includes(${JSON.stringify(label)})`,20_000)
const button=async(label:string)=>p.eval(`(()=>{const button=[...document.querySelectorAll('.wp-workshop button')].find(e=>e.textContent===${JSON.stringify(label)});if(!button)throw Error('missing workshop action');button.click()})()`)
try {
  for(const [name,value] of [['mvlos_sid',sid],['mvlos_login',login],['mvlos_uid','1']])await p.send('Network.setCookie',{name,value,url:origin})
  await p.send('Page.navigate',{url:origin})
  await p.waitFor(`!!document.querySelector('.desktop')&&!document.querySelector('.boot')`,90_000)
  await p.eval(`(async()=>{
    const n=await import('/src/data/notes.ts'),c=await import('/src/widgets/config.ts'),w=await import('/src/os/widgetPlaces.ts');
    n.createNote({id:'six-sticky',text:'- [ ] Source checklist'});
    n.createNote({id:'linked-note',text:'Meeting note',events:[{source:'google',uid:'meeting-uid',calendarId:'work',title:'Synthetic meeting',start:window.__event.start,end:window.__event.end,allDay:false,linked:Date.now()}]});
    c.setWidgetConfig('six-weather',{place:{name:'Selected city',lat:52,lon:5},units:'c'});
    w.placeWidgets(['sticky','weather','agenda','inbox','status','minecraft'].map((kind,i)=>({id:'six-'+kind,kind,x:30+(i%3)*430,y:70+Math.floor(i/3)*500,w:390,h:440,vw:1800,vh:1200})));
  })()`)
  for(const [kind,label] of [['sticky','Source checklist'],['weather','18°'],['agenda','Synthetic meeting'],['inbox','Pull request 1'],['status','Service 0'],['minecraft','Player0']]){
    await waitText(kind,label)
    check(kind+' real package loaded by shared worker',await p.eval(`${widget(kind)}.dataset.packageDigest.length===64`))
  }
  check('all six immutable source folders visible to Files/msh/Xed',await p.eval(`import('/src/terminal/vfs.ts').then(m=>['sticky','weather','agenda','inbox','status','minecraft'].every(k=>m.lookup('/usr/share/mvlos/widgets/'+k+'/src/main.js')?.content().includes('export function render')))`))
  check('Agenda retains recurring tasks, meeting link, linked-note mark and domain error',await p.eval(`${widget('agenda')}.textContent.includes('Recurring daily task') && !!${widget('agenda')}.querySelector('[role="checkbox"]') && ${widget('agenda')}.textContent.includes('📝') && ${widget('agenda')}.textContent.includes('🎥') && ${widget('agenda')}.textContent.includes('calendar unavailable')`))
  await click('agenda','📝');await p.waitFor(`window.__opens.some(e=>e.app==='notebook'&&e.props?.id==='linked-note')`)
  check('Agenda mark uses existing linked-note domain action',true)
  // Closing regular app windows keeps every widget and its placement.
  await p.eval(`document.querySelectorAll('[data-app="notebook"] .ctl-close').forEach(e=>e.click())`)
  await click('agenda','☐');await p.waitFor(`window.__writes.length===1`)
  await p.waitFor(`!${widget('agenda')}.textContent.includes('Recurring daily task')`)
  check('Agenda completion preserves recurrence via existing completeTask domain',await p.eval(`window.__writes[0].ref==='opaque-provider-task'&&window.__writes[0].task.completed===true&&typeof window.__writes[0].task.timeZone==='string'&&!window.__task.completed&&window.__task.due>window.__day`))
  check('Inbox first page preserves five-per-section, draft and assigned filters',await p.eval(`${widget('inbox')}.textContent.includes('Own pull request')&&${widget('inbox')}.textContent.includes('Assigned issue')&&${widget('inbox')}.textContent.includes('draft')&&!${widget('inbox')}.textContent.includes('Pull request 6')`))
  await click('inbox','Next results');await waitText('inbox','Pull request 7')
  await click('inbox','Previous results');await waitText('inbox','Pull request 1')
  await p.eval(`import('/src/widgets/config.ts').then(m=>m.setWidgetConfig('six-inbox',{hidden:['mine']}))`)
  await p.waitFor(`!${widget('inbox')}.textContent.includes('Own pull request')`)
  check('Inbox config filter changes projection and pages reach all records',true)
  await p.eval(`${widget('inbox')}.querySelector('a[title*="sample/project#1"]').click()`)
  await p.waitFor(`!!document.querySelector('[data-app="git"]')`)
  check('Inbox plain-click navigates through existing Git availability domain',true)
  check('Inbox modified-click destination is broker-bound original URL',await p.eval(`${widget('inbox')}.querySelector('a[title*="sample/project#1"]').href==='https://code.example.invalid/1'`))
  await p.eval(`document.querySelectorAll('[data-app="git"] .ctl-close').forEach(e=>e.click())`)
  check('Status retains outage, latency, uptime, SSL warning and bound destination',(await text('status')).includes('HTTP 503')&&(await text('status')).includes('42 ms')&&(await text('status')).includes('99.90%')&&(await text('status')).includes('certificate expires in')&&await p.eval(`${widget('status')}.querySelector('a.wp-link').href==='https://updown.io/checks/check0'`))
  await click('status','Next results');await waitText('status','Service 13');check('Status paging retains all checks',true)
  await p.eval(`${widget('minecraft')}.querySelector('summary').click()`)
  check('Minecraft heads expose touch details, world clock and vitals',await p.eval(`${widget('minecraft')}.querySelector('details').open&&${widget('minecraft')}.textContent.includes('Nether')&&${widget('minecraft')}.textContent.includes('Lv 30')&&${widget('minecraft')}.textContent.includes('Day 12 · 14:20')`))
  await click('minecraft','cloud.mvl.sh · Copy');await p.waitFor(`window.__copied.length===1`)
  check('Minecraft copy has only explicit fixed-address authority',await p.eval(`window.__copied[0]==='cloud.mvl.sh'`))
  await click('minecraft','Next results');await waitText('minecraft','Player13');check('Minecraft bounded heads retain all named players',true)
  await click('minecraft','Connect / server window');await p.waitFor(`!!document.querySelector('[data-app="mcserver"]')`)
  check('Minecraft explicit connect opens existing server app',true)
  await p.eval(`document.querySelectorAll('[data-app="mcserver"] .ctl-close').forEach(e=>e.click())`)
  // Real clone -> Xed native edit -> save -> build/mock -> explicit activation on each new kind.
  for(const kind of ['agenda','inbox','status','minecraft']){
    await click(kind,'Source');await p.waitFor(`document.querySelector('.wp-workshop')?.textContent.includes('Widget Workshop · ${kind}')`)
    await button('Rebuild default & preview');await p.waitFor(`!!document.querySelector('.wp-preview')`)
    check(kind+' default rebuild has substantive mock preview',await p.eval(`document.querySelector('.wp-preview').textContent.includes(${JSON.stringify(kind==='agenda'?'Sample meeting':kind==='inbox'?'Sample pull request':kind==='status'?'Sample service':'SamplePlayer')})`))
    await button('Clone & edit in Xed');await p.waitFor(`!!document.querySelector('[data-app="zed"]')`)
    await p.waitFor(`[...document.querySelectorAll('[data-app="zed"] textarea')].some(e=>e.value.includes('export function render'))`)
    await p.eval(`(()=>{const e=[...document.querySelectorAll('[data-app="zed"] textarea')].find(e=>e.value.includes('export function render'));e.focus();e.setSelectionRange(0,e.value.length)})()`)
    await p.send('Input.insertText',{text:`import {text} from '@mvlos/widget';export function render(input){return text('Edited ${kind} in Xed')}export function event(){return null}`})
    await p.send('Input.dispatchKeyEvent',{type:'keyDown',key:'s',code:'KeyS',windowsVirtualKeyCode:83,modifiers:2});await p.send('Input.dispatchKeyEvent',{type:'keyUp',key:'s',code:'KeyS',windowsVirtualKeyCode:83,modifiers:2})
    await p.waitFor(`import('/src/data/browserfs.ts').then(m=>m.readBrowserText('/.local/share/mvlos/widgets/${kind}/src/main.js')).then(t=>t.includes('Edited ${kind} in Xed'))`)
    check(kind+' source save preserves active revision',!(await text(kind)).includes('Edited '+kind))
    await button('Build & mock preview');await p.waitFor(`document.querySelector('.wp-preview')?.textContent.includes('Edited ${kind} in Xed')`)
    await p.eval(`document.querySelector('.wp-workshop input[type="checkbox"]').click()`);await button('Activate built revision');await waitText(kind,`Edited ${kind} in Xed`)
    check(kind+' source edit/build/mock/explicit activation changes real output',true)
    await p.eval(`import('/src/widgets/config.ts').then(m=>m.setWidgetConfig('six-${kind}',{tilt:2,proof:'newer config'}))`)
    await p.eval(`document.querySelector('.wp-workshop input[type="checkbox"]').click()`);await button('Recover previous revision')
    await p.waitFor(`!${widget(kind)}?.textContent.includes('Edited ${kind} in Xed')`)
    check(kind+' recovery keeps newer config',await p.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalConfigs.get()['six-${kind}'].proof==='newer config')`))
    await p.eval(`document.querySelector('[data-app="widgetworkshop"] .ctl-close').click();document.querySelectorAll('[data-app="zed"] .ctl-close').forEach(e=>e.click())`)
    await p.waitFor(`!document.querySelector('.wp-workshop')`)
  }
  // Explicit no-effect read-only manifest. The VM gets data but never action authority or provider refs.
  await p.eval(`(async()=>{const p=await import('/src/widgets/platform/package.ts'),i=await import('/src/widgets/platform/installations.ts'),d=await import('/src/widgets/platform/defaults.ts');const before=i.installation('six-agenda');const files={...before.active.snapshot.files};const manifest=JSON.parse(files['manifest.json']);manifest.capabilities=['agenda.read'];files['manifest.json']=JSON.stringify(manifest);const snapshot=await p.buildPackage(files),revision={source:before.active.source,snapshot};await i.activate('six-agenda','agenda',revision,before.generation);i.allowRevision('six-agenda',revision)})()`)
  await waitText('agenda','Synthetic meeting')
  check('Read-only Agenda retains display while denying all actions',await p.eval(`!${widget('agenda')}.querySelector('.wp-action,.wp-link')`))
  const noRaw=await p.eval(`(async()=>{const Original=Worker;window.__projected=[];window.Worker=class extends Original{postMessage(message,...args){if(message.input?.agenda||message.input?.inbox)window.__projected.push(JSON.stringify(message.input));return super.postMessage(message,...args)}};document.querySelectorAll('.wp-controls button').forEach(e=>{if(e.textContent==='Refresh')e.click()});await new Promise(r=>setTimeout(r,600));return window.__projected.length>0&&window.__projected.every(s=>!s.includes('opaque-provider')&&!s.includes('meet.example')&&!s.includes('code.example')&&!s.includes('opaque-event'))})()`)
  check('VM projection omits provider refs and outbound navigation URLs',noRaw)
  // Cancellation on shell hide is owned by the broker and aborts pending reads, too.
  await p.eval(`window.__hold=true;window.__aborted=0`)
  await click('inbox','Refresh');await p.waitFor(`window.__held.length>0`)
  await p.eval(`import('/src/os/deskPrefs.ts').then(m=>m.notesHidden.set(true))`)
  await p.waitFor(`window.__aborted>0`)
  check('Hidden shell aborts pending domain reads immediately',true)
  const before=await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>JSON.stringify(m.widgetPlaces.get()))`)
  await p.eval(`window.__hold=false;window.__held.splice(0).forEach(done=>done());import('/src/os/deskPrefs.ts').then(m=>m.notesHidden.set(false))`)
  await waitText('inbox','Pull request 1')
  await p.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(300)
  check('Mobile hiding preserves all six canonical placements',before===await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>JSON.stringify(m.widgetPlaces.get()))`))
  await p.send('Emulation.setDeviceMetricsOverride',{width:1800,height:1200,deviceScaleFactor:1,mobile:false});await waitText('status','Service 0')
  await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>m.widgetPlaces.set(all=>m.changeSet(all,{'future':{id:'future',kind:'future-widget',x:1,y:1,w:200,h:200,vw:1800,vh:1200,at:Date.now()}})))`)
  await sleep(200)
  check('Unavailable newer kind stays recoverable without tombstone',await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>!!m.widgetPlaces.get().places.future&&!m.widgetPlaces.get().removed.includes('future'))`))
  await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>{const p=m.widgetPlaces.get().places['six-status'];m.placeWidgets([{...p,kind:'future-status'}])})`)
  await p.waitFor(`!document.querySelector('.widget-status')`)
  check('Discovery loss of an existing widget is not removal authority',await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>!!m.widgetPlaces.get().places['six-status']&&!m.widgetPlaces.get().removed.includes('six-status'))`))
  await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>{const p=m.widgetPlaces.get().places['six-status'];m.placeWidgets([{...p,kind:'status'}])})`)
  await waitText('status','Service 0')
  check('Source kind discovery recovery restores the existing instance',true)
  const conflict=await p.eval(`(async()=>{const i=await import('/src/widgets/platform/installations.ts');const record=i.installation('six-status'),identity=i.installationIdentity(record);i.installations.set(all=>({...all,'six-status':{...record,generation:record.generation+1}}));const rejected=await i.recover('six-status',record.generation,identity).then(()=>false,()=>true);const newer=i.installation('six-status'),old=i.installationIdentity(newer);i.installations.set(all=>({...all,'six-status':{...newer,active:{...newer.active,source:{...newer.active.source,path:'/usr/share/mvlos/widgets/weather'}}}}));const tieRejected=await i.recover('six-status',newer.generation,old).then(()=>false,()=>true);i.installations.set(all=>({...all,'six-status':{...newer,generation:newer.generation+1}}));return rejected&&tieRejected})()`)
  check('Recovery rejects newer generations and conflicting equal-generation identities',conflict)
  await waitText('status','Service 0')
  await p.eval(`(async()=>{const sync=await import('/src/os/synced.ts');const legacy=sync.synced('widgets',{});legacy.set({'six-status':{tilt:99}});await sync.pullAll()})()`)
  check('Old-client config writes cannot replace canonical newer settings',await p.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalConfigs.get()['six-status'].proof==='newer config'&&m.canonicalConfigs.get()['six-status'].tilt===2)`))
  const staleHandle=await p.eval(`(async()=>{const i=await import('/src/widgets/platform/installations.ts');const old=i.installation('six-inbox'),link=document.querySelector('.widget-inbox a.wp-link');const count=window.__requests.filter(x=>x.startsWith('/api/repos/')).length;i.installations.set(all=>({...all,'six-inbox':{...old,active:{...old.active,source:{...old.active.source,path:'/usr/share/mvlos/widgets/weather'}}}}));link.click();const denied=window.__requests.filter(x=>x.startsWith('/api/repos/')).length===count;i.installations.set(all=>({...all,'six-inbox':{...old,generation:old.generation+1}}));return denied})()`)
  check('Equal-generation install replacement instantly denies the old rendered handle',staleHandle)
  await waitText('inbox','Pull request 1')
  // Invalid source identity cannot silently fall back to a built-in view, nor remove placement.
  await p.eval(`import('/src/widgets/platform/installations.ts').then(m=>m.installations.set(all=>({...all,'six-status':{...all['six-status'],generation:all['six-status'].generation+1,active:{...all['six-status'].active,source:{kind:'browser',account:1,storeUUID:crypto.randomUUID(),path:'/.local/share/mvlos/widgets/status'}}}})))`)
  await waitText('status','Allow this revision')
  check('Unavailable source has no privileged view fallback or inferred removal',!(await text('status')).includes('Service 0')&&await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>!!m.widgetPlaces.get().places['six-status']&&!m.widgetPlaces.get().removed.includes('six-status'))`))
  await p.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalInstallations.set(all=>({...all,'six-status':{schema:1,instance:'six-status',kind:'status',generation:all['six-status'].generation+1,active:'invalid imported metadata'}})))`)
  await waitText('status','Installed metadata unavailable')
  check('Malformed installation metadata cannot silently select a default',!(await text('status')).includes('Service 0'))
  await click('status','Source');await p.waitFor(`!!document.querySelector('.wp-workshop')`)
  await button('Rebuild default & preview');await p.waitFor(`document.querySelector('.wp-preview')?.textContent.includes('Sample service')`)
  await p.eval(`document.querySelector('.wp-workshop input[type="checkbox"]').click()`);await button('Activate built revision');await waitText('status','Service 0')
  check('Explicit verified activation repairs malformed metadata without config rollback',await p.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalConfigs.get()['six-status'].proof==='newer config')`))
  await p.eval(`document.querySelector('[data-app="widgetworkshop"] .ctl-close').click()`)
  await p.eval(`import('/src/widgets/platform/canonicalState.ts').then(m=>m.canonicalInstallations.set(all=>Object.fromEntries([...Array.from({length:33},(_,n)=>['future-'+n,{generation:1,future:true}]),...Object.entries(all)])))`)
  await waitText('status','Service 0')
  check('Unknown imported records cannot hide a later valid installation',await p.eval(`import('/src/widgets/platform/installations.ts').then(m=>!!m.installation('six-status'))`))
  check('Installation lookup never inherits object prototype entries',await p.eval(`import('/src/widgets/platform/installations.ts').then(m=>m.installation('constructor')===undefined&&m.installation('__proto__')===undefined)`))
  const capacity=await p.eval(`(async()=>{const i=await import('/src/widgets/platform/installations.ts');return i.activate('extra','status',i.installation('six-status').active,0).then(()=>'',e=>e.message)})()`)
  check('Preserved unknown records count toward explicit installation capacity',capacity.includes('Installation limit reached (12 records)'))

  // A real close, unlike hiding or discovery failure, records removal authority.
  await p.eval(`document.querySelector('.widget-minecraft .note-close').click()`);await sleep(200)
  check('Explicit widget close writes canonical placement tombstone',await p.eval(`import('/src/os/widgetPlaces.ts').then(m=>m.widgetPlaces.get().removed.includes('six-minecraft'))`))
  const frozen=await p.eval(`(async()=>{const link=document.querySelector('.widget-inbox a.wp-link');const before=window.__requests.filter(x=>x.startsWith('/api/repos/')).length;const source=await import('/src/os/accountSpace.ts');source.freezeAccount(false);link?.click();await new Promise(r=>setTimeout(r,50));return window.__requests.filter(x=>x.startsWith('/api/repos/')).length===before})()`)
  check('Logout denies previously rendered domain navigation handles',frozen)
  check('No unhandled browser exceptions',!p.errors.length,p.errors)
} catch(error) {
  console.log('Browser errors',p.errors)
  console.log('Browser state',await p.eval(`({widgets:[...document.querySelectorAll('.wp-package')].map(e=>e.textContent),workshop:document.querySelector('.wp-workshop')?.textContent,writes:window.__writes,opens:window.__opens,requests:window.__requests.slice(-20)})`).catch(()=>null));throw error
} finally {await b.close();vite.kill('SIGTERM');rmSync(data,{recursive:true,force:true})}
if(failed)process.exitCode=1
