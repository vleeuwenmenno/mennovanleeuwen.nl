// Browser regression against a running scratch Vite server. All API fetches are mocked, no writes.
// DATA_DIR=<scratch> vite --port 5294 --strictPort
// pnpm check:agents-photo-picker http://127.0.0.1:5294
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { launch, newPage } from './perf/cdp.ts'
const url = new URL(process.argv[2] ?? 'http://127.0.0.1:5294')
if (url.hostname !== '127.0.0.1' || Number(url.port) < 5170 || Number(url.port) > 5299) throw new Error('Use a scratch Vite server on 127.0.0.1:5170–5299')
const png = readFileSync(new URL('./fixtures/agent-image-sources/source.png', import.meta.url)).toString('base64')
const inject = `
document.cookie='mvlos_uid=1; path=/';document.cookie='mvlos_login=fixture; path=/';
window.__photosMode='delayed';
window.EventSource=class extends EventTarget { close() {} };
const imageSource=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
Object.defineProperty(HTMLImageElement.prototype,'src',{...imageSource,set(value){imageSource.set.call(this,String(value).startsWith('/api/')?'data:image/png;base64,${png}':value)}});
const setAttribute=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(name,value){
 if(this instanceof HTMLImageElement && name==='src' && String(value).startsWith('/api/'))value='data:image/png;base64,${png}';
 return setAttribute.call(this,name,value);
};
const rawFetch=window.fetch.bind(window);
window.fetch=async(input, init)=>{
 const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
 if(!path.startsWith('/api/'))return rawFetch(input,init);
 const json=(value)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
 if(path==='/api/me')return json({authEnabled:true,user:{id:1,login:'fixture',admin:false,githubScopes:[]},forges:[],integrations:{ollama:'settings'}});
 if(path==='/api/agents/models')return json([{name:'fixture',vision:true}]);
 if(path==='/api/photos/status')return json(window.__photosMode==='disconnected'?{seafile:null,immich:null}:{seafile:null,immich:{name:'Fixture'}});
 if(path.endsWith('/albums'))return json([{id:'album',name:'Fixture album',count:1}]);
 if(path.endsWith('/buckets'))return json(window.__photosMode==='empty'?[]:[{key:'2026-10',month:'2026-10',count:1}]);
 if(path.endsWith('/bucket'))return json([['photo',Date.UTC(2026,9,1),0,1.5,null,'v1']]);
 if(path.endsWith('/info'))return json({id:'photo',name:'Original.png',kind:'image'});
 if(path.endsWith('/original')){
   if(window.__photosMode==='delayed')await new Promise(resolve=>window.__finishPhoto=resolve);
   if(init.signal.aborted)throw new DOMException('Aborted','AbortError');
   if(window.__photosMode==='error')return new Response('',{status:502});
   return new Response(Uint8Array.from(atob('${png}'),c=>c.charCodeAt(0)),{headers:{'Content-Type':'image/png'}});
 }
 if(path==='/api/prefs')return json({});
 return json([]);
};
`
const browser = await launch(1280, 800)
try {
  const page = await newPage(browser, 1280, 800, inject)
  const wait = page.waitFor
  page.waitFor = async (expression) => {
    try { await wait(expression, 15_000) }
    catch (error) { console.error(await page.eval("({text:document.body.innerText.slice(-3000),errors:window.__incoming?.length})")); throw error }
  }
  await page.send('Page.navigate', { url: url.href })
  await page.waitFor("document.readyState === 'complete'")
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await page.waitFor("!!document.querySelector('.desktop')")
  await page.waitFor("import('/src/os/account.ts').then(m=>m.getAccount().status === 'user')")
  await page.eval("window.dispatchEvent(new CustomEvent('mvlos:open',{detail:{app:'agents'}}))")
  await page.waitFor("!!document.querySelector('button[aria-label=\"New thread\"]')")
  await page.eval("document.querySelector('button[aria-label=\"New thread\"]')?.click()")
  await page.waitFor("!!document.querySelector('.agt-composer textarea')")
  await page.eval(`(() => {
    const input=document.querySelector('.agt-composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Preserved draft');
    input.dispatchEvent(new Event('input',{bubbles:true}));
    const files=new DataTransfer();
    for(let i=0;i<10;i++) {
      const file=new File(['incoming'], 'Incoming '+i+'.txt',{type:'text/plain'});
      file.text=()=>new Promise(resolve=>(window.__incoming??=[]).push(()=>resolve('incoming')));
      files.items.add(file);
    }
    const picker=document.querySelector('.agt-composer input[type=file]');
    picker.files=files.files;picker.dispatchEvent(new Event('change',{bubbles:true}));
  })()`)
  const open = async () => {
    await page.eval("document.querySelector('button[aria-label=\"Attach files\"]').click()")
    await page.waitFor("[...document.querySelectorAll('.ctx-item')].some(b=>b.textContent.includes('From Photos'))")
    await page.eval("[...document.querySelectorAll('.ctx-item')].find(b=>b.textContent.includes('From Photos')).click()")
  }
  await open()
  await page.waitFor("!!document.querySelector('.photo-picker-photo')")
  await page.eval("document.querySelector('.photo-picker-photo').click()")
  await page.eval("[...document.querySelectorAll('.image-dialog-foot button')].find(b=>b.textContent.startsWith('Attach')).click()")
  await page.waitFor('!!window.__finishPhoto')
  await page.eval('window.__incoming.forEach(f=>f())')
  await page.waitFor("document.querySelectorAll('.agt-composer .agt-files li').length === 10 && !document.querySelector('.agt-composer .agt-files').textContent.includes('Reading')")
  await page.eval('window.__finishPhoto()')
  await page.waitFor("!!document.querySelector('.image-dialog [role=alert]')?.textContent.includes('At most 10')")
  assert.equal(await page.eval("document.querySelector('.agt-composer textarea').value"), 'Preserved draft')
  assert.equal(await page.eval("import('/src/data/agentDrafts.ts').then(m=>m.getDraft('new').files.length)"), 10)
  await page.eval("[...document.querySelectorAll('.image-dialog-foot button')].find(b=>b.textContent==='Cancel').click()")
  await page.waitFor("!document.querySelector('.image-dialog')")
  // Remove one existing attachment, then test cancellation while the original is in flight.
  await page.eval("document.querySelector('.agt-composer .agt-files button').click();window.__finishPhoto=null")
  await open()
  await page.waitFor("!!document.querySelector('.photo-picker-photo')")
  await page.eval("document.querySelector('.photo-picker-photo').click()")
  await page.eval("[...document.querySelectorAll('.image-dialog-foot button')].find(b=>b.textContent.startsWith('Attach')).click()")
  await page.waitFor('!!window.__finishPhoto')
  await page.eval("[...document.querySelectorAll('.image-dialog-foot button')].find(b=>b.textContent==='Cancel').click();window.__finishPhoto()")
  await page.waitFor("!document.querySelector('.image-dialog')")
  assert.equal(await page.eval("document.querySelectorAll('.agt-composer .agt-files li').length"), 9)
  await page.eval("window.__photosMode='normal'")
  await open()
  await page.waitFor("!!document.querySelector('.photo-picker-photo')")
  await page.eval("document.querySelector('.photo-picker-photo').click()")
  await page.eval("[...document.querySelectorAll('.image-dialog-foot button')].find(b=>b.textContent.startsWith('Attach')).click()")
  await page.waitFor("!document.querySelector('.image-dialog')")
  assert.equal(await page.eval("import('/src/data/agentDrafts.ts').then(m=>m.getDraft('new').files.length)"), 10)
  assert.equal(await page.eval("document.querySelector('.agt-composer').textContent.includes('Original.png')"), true)
  assert.equal(await page.eval("document.querySelector('.agt-composer textarea').value"), 'Preserved draft')
  const photo = await page.eval("import('/src/data/agentDrafts.ts').then(m=>m.getDraft('new').files.find(f=>f.name==='Original.png'))")
  assert.equal(photo.kind, 'image')
  assert.equal(photo.mime, 'image/png')
  assert.equal(photo.data, png)
  assert.deepEqual(page.errors, [])
  console.log('Photos picker: concurrent import budget, unchanged draft, cancellation and successful normal attachment passed')
} finally { await browser.close() }
