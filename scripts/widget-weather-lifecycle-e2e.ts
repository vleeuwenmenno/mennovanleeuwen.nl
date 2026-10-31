// Forecast lifecycle regressions: delayed hydration/replies, synthetic data, muted Chromium.
// pnpm check:widget-weather-lifecycle (PORT overrides the isolated dev server port).
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'

const WT = process.env.WT ?? process.cwd()
const PORT = Number(process.env.PORT ?? 5287)
const data = mkdtempSync('/tmp/mvlos-widget-weather-lifecycle-')
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

const b = await launch(1400, 1000)
const p = await newPage(b, 1400, 1000, `(()=>{
  const native=window.fetch;
  const me=new Promise(resolve=>window.__releaseMe=resolve);
  window.__forecasts=[];window.__meFailure=false;
  const meta=value=>JSON.stringify({value,base:0,dirty:true});
  localStorage.setItem('mvlos.u.1.sync.widgets:placed',meta({places:{'weather-lifecycle':{id:'weather-lifecycle',kind:'weather',x:400,y:100,w:290,h:300,vw:1400,vh:1000,at:1}},removed:''}));
  localStorage.setItem('mvlos.u.1.sync.widgets',meta({'weather-lifecycle':{place:{name:'Lifecycle city',lat:52,lon:5},units:'c'}}));
  window.fetch=async(url,options)=>{
    const path=String(url);
    if(path==='/api/me'){
      if(window.__meFailure)return Response.json({error:'Synthetic offline'},{status:503});
      const response=await native(url,options);await me;return response;
    }
    if(path.includes('api.open-meteo.com/v1/forecast'))return new Promise(resolve=>{
      const request={resolve,signal:options?.signal,aborted:false};
      options?.signal?.addEventListener('abort',()=>request.aborted=true,{once:true});
      window.__forecasts.push(request);
    });
    return native(url,options);
  };
  window.__forecast=(index,temp)=>window.__forecasts[index].resolve(Response.json({current:{temperature_2m:temp,weather_code:0,is_day:1},hourly:{time:[]},daily:{time:[]}}));
})()`)
const waitRequests = (count: number) => p.waitFor(`window.__forecasts.length>=${count}`, 15_000)
const forecastShown = (temp: number) => p.waitFor(`document.querySelector('.wp-package')?.textContent.includes('${temp}°')`, 15_000)
const refresh = () => p.eval(`[...document.querySelector('.wp-package').querySelectorAll('button')].find(b=>b.textContent==='Refresh').click()`)
try {
  for (const [name,value] of [['mvlos_sid',sid],['mvlos_login',login],['mvlos_uid','1']]) await p.send('Network.setCookie',{name,value,url:origin})
  await p.send('Page.navigate',{url:origin})
  await waitRequests(1)
  check('forecast starts while /api/me remains pending', await p.eval(`import('/src/os/account.ts').then(m=>m.getAccount().status==='loading')`))
  await p.eval(`window.__releaseMe()`)
  await p.waitFor(`import('/src/os/account.ts').then(m=>m.getAccount().status==='user')`)
  await waitRequests(2)
  check('account hydration aborts and restarts the old forecast lifecycle', await p.eval(`window.__forecasts[0].aborted && !window.__forecasts[1].aborted`))
  await p.eval(`window.__forecast(0,99)`)
  await sleep(100)
  check('late pre-hydration result is never published', await p.eval(`!document.querySelector('.wp-package')?.textContent.includes('99°')`))
  await p.eval(`window.__forecast(1,18)`)
  await forecastShown(18)
  await p.eval(`import('/src/os/account.ts').then(m=>m.loadAccount())`)
  await sleep(250)
  check('ordinary renders and same-identity account refresh do not fetch in a loop', await p.eval(`window.__forecasts.length===2`))
  await p.eval(`(async()=>{
    const sources=await import('/src/widgets/platform/sources.ts'),defaults=await import('/src/widgets/platform/defaults.ts'),i=await import('/src/widgets/platform/installations.ts');
    window.__source=await sources.cloneDefault('weather',sources.WIDGET_HOME+'/weather-lifecycle');
    const snapshot=await defaults.defaultBuild('weather');
    (await import('/src/data/weather.ts')).clearForecastCache();
    await i.activate('weather-lifecycle','weather',{source:window.__source,snapshot},0);i.allowRevision('weather-lifecycle',{source:window.__source,snapshot});
  })()`)
  await waitRequests(3)
  await p.eval(`(async()=>{
    const sources=await import('/src/widgets/platform/sources.ts'),p=await import('/src/widgets/platform/package.ts'),i=await import('/src/widgets/platform/installations.ts');
    const files=await sources.readSource(window.__source);files['README.md']+='\\nSynthetic lifecycle revision B.\\n';
    await (await import('/src/data/browserfs.ts')).writeBrowserFile(window.__source.path+'/README.md',files['README.md']);
    const snapshot=await p.buildPackage(files);
    await i.activate('weather-lifecycle','weather',{source:window.__source,snapshot},i.installation('weather-lifecycle').generation);i.allowRevision('weather-lifecycle',{source:window.__source,snapshot});
  })()`)
  await waitRequests(4)
  check('runtime revision change restarts the same place/units lifecycle', await p.eval(`window.__forecasts[2].aborted && !window.__forecasts[3].aborted`))
  await p.eval(`window.__forecast(2,88);window.__forecast(3,22)`)
  await forecastShown(22)
  check('old runtime result cannot replace the new revision forecast', await p.eval(`!document.querySelector('.wp-package').textContent.includes('88°')`))
  await refresh(); await waitRequests(5)
  await p.eval(`[...document.querySelector('.wp-package').querySelectorAll('button')].find(b=>b.textContent==='Pause access').click()`)
  await p.waitFor(`window.__forecasts[4].aborted`)
  await p.eval(`window.__forecast(4,77)`)
  check('grant revocation aborts the in-flight forecast', await p.eval(`document.querySelector('.wp-package').textContent.includes('Allow this revision') && !document.querySelector('.wp-package').textContent.includes('77°')`))
  await p.eval(`[...document.querySelector('.wp-package').querySelectorAll('button')].find(b=>b.textContent.includes('Allow this revision')).click()`)
  await waitRequests(6)
  await p.eval(`window.__forecast(5,24)`)
  await forecastShown(24)
  check('re-grant resumes refresh for the unchanged place', true)
  await refresh(); await waitRequests(7)
  await p.eval(`window.__meFailure=true;import('/src/os/account.ts').then(m=>m.loadAccount())`)
  await p.waitFor(`import('/src/os/account.ts').then(m=>m.getAccount().status==='off')`)
  await p.waitFor(`window.__forecasts[6].aborted`)
  await p.eval(`window.__forecast(6,66)`)
  check('account authority loss cancels stale forecast work', await p.eval(`!document.querySelector('.wp-package').textContent.includes('66°')`))
  await p.eval(`window.__meFailure=false;import('/src/os/account.ts').then(m=>m.loadAccount())`)
  await p.waitFor(`import('/src/os/account.ts').then(m=>m.getAccount().status==='user')`)
  await waitRequests(8)
  await p.eval(`window.__forecast(7,26)`)
  await forecastShown(26)
  await sleep(250)
  check('account recovery starts one fresh loop with no rerender storm', await p.eval(`window.__forecasts.length===8`))
  check('no browser exceptions during lifecycle transitions', !p.errors.length, p.errors)
} catch(error) {
  console.log('Diagnostic',await p.eval(`({status:document.querySelector('.wp-package')?.textContent,requests:window.__forecasts.map(f=>({aborted:f.aborted})),errors:window.__meFailure})`).catch(()=>null))
  throw error
} finally { await b.close();vite.kill('SIGTERM');rmSync(data,{recursive:true,force:true}) }
if(failed)process.exitCode=1
