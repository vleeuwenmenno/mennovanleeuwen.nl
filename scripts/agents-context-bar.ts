// Browser regression against a running scratch Vite server. All API fetches are mocked, no writes.
// The context ring sits in the thread's top bar (not the composer), opens and closes the panel
// reliably (also while a reply is being written, and while it loads or fails), the top bar adapts
// to the width of its pane and the panel's title stays reachable. Its Stats tab (and the thread
// menu's Thread stats) shows the thread's stats for nerds, fits the pane and opens a turn's calls.
// DATA_DIR=<scratch> vite --port 5290 --strictPort
// pnpm check:agents-context-bar http://127.0.0.1:5290 [1280x800,390x800,...]
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { launch, newPage, sleep } from './perf/cdp.ts'
const url = new URL(process.argv[2] ?? 'http://127.0.0.1:5290')
if (url.hostname !== '127.0.0.1' || Number(url.port) < 5170 || Number(url.port) > 5299) throw new Error('Use a scratch Vite server on 127.0.0.1:5170–5299')
// "worst": every chip on, a long folder, a project crumb and a thread running (a reply being written).
const inject = (worst: boolean) => `
document.cookie='mvlos_uid=1; path=/';document.cookie='mvlos_login=fixture; path=/';
{
 // The dev server clears the sign-in cookie of a visitor: keep the fake account's id readable.
 const d=Object.getOwnPropertyDescriptor(Document.prototype,'cookie');
 Object.defineProperty(document,'cookie',{configurable:true,get(){const c=d.get.call(document);return /mvlos_uid=/.test(c)?c:(c?c+'; ':'')+'mvlos_uid=1'},set(v){if(!/^mvlos_uid=/.test(v))d.set.call(document,v)}});
}
window.__ctxMode='ok';
// The OS's timed notices float over the top bar: keep them out of the taps.
document.addEventListener('DOMContentLoaded',()=>{const st=document.createElement('style');st.textContent='.notices{display:none!important}';document.head.append(st)});
const rawFetch=window.fetch.bind(window);
const enc=new TextEncoder();
const worst=${worst};
const thread={id:'t1',title:'A thread with a rather long title to prove the bar copes with it',mode:'quick',model:'fixture',archived:false,createdAt:1,updatedAt:2,running:worst,titling:false,contextTokens:30000,tools:[],projectId:worst?1:null,pinned:false,todos:[],quick:true,workdir:{repo:'r',path:'/p',label:worst?'~/Projects/a-very-long-folder-name/with/sub/folders':'~/Projects/x'},permission:'default',queue:[],interrupted:null,titleSource:'user',aliases:[],checkingTitle:false,mailReadsAlways:worst};
const messages=[{id:1,role:'user',content:'Hello',createdAt:1},{id:2,role:'assistant',content:'Hi there. '.repeat(40),createdAt:2}];
const parts=[['System prompt',2400],['Tool definitions',3800],['Messages',22000],['Summary of earlier messages',2300],['Skills',900],['Memory',700],['Work folder notes',650],['Attachments',400]].map(([label,tokens])=>({label,tokens}));
const context={model:'fixture',contextLength:131072,measured:30000,estimate:30500,parts,compaction:null,autoCompact:80};
const stats={model:'fixture',turns:[{id:1,at:1,text:'Hello, a first question that is long enough to be cut short on a phone screen',calls:[{kind:'reply',stats:{provider:'chatgpt',model:'chatgpt/gpt-5.5',input:10000,cached:9000,output:400,reasoning:150,ttft:800,gen:4000,ms:65000}},{kind:'reply',stats:null}],tools:[{name:'web_search',ms:1200},{name:'write_file',ms:30000,waited:28000}]},{id:3,at:3,text:'/compact',calls:[{kind:'compact',stats:{provider:'ollama',model:'fixture',input:20000,output:900,ttft:1500,gen:9000,promptEval:2000,load:40,ms:11000}}],tools:[]}]};
window.fetch=async(input, init)=>{
 const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
 if(!path.startsWith('/api/'))return rawFetch(input,init);
 const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
 if(path==='/api/me')return json({authEnabled:true,user:{id:1,login:'fixture',admin:false,githubScopes:[]},forges:[],integrations:{ollama:'settings'}});
 if(path==='/api/agents/models')return json([{name:'fixture',vision:true,contextLength:131072}]);
 if(path==='/api/agents/projects')return json([{id:1,name:'Research notes project',sort:0,createdAt:1}]);
 if(path==='/api/agents/threads')return json([thread]);
 if(path==='/api/agents/threads/t1')return json({thread,messages,pending:[]});
 if(path==='/api/agents/threads/t1/follow'){
  const stream=new ReadableStream({start(c){ if(worst) c.enqueue(enc.encode(JSON.stringify({type:'snapshot',thread,messages,pending:[],live:{content:'Working on it…',thinking:''}})+'\\n')); else c.close() }});
  return new Response(stream,{headers:{'Content-Type':'application/x-ndjson'}});
 }
 if(path==='/api/agents/threads/t1/context'){
  if(window.__ctxMode==='error')return json({error:'fixture error'},500);
  if(window.__ctxMode==='slow')await new Promise(()=>{});
  return json(context);
 }
 if(path==='/api/agents/threads/t1/stats')return json(stats);
 if(path==='/api/prefs')return json({});
 return json([]);
};
`
const sizes: [number, number][] = (process.argv[3] ?? '1280x800,1000x700,900x700,730x600,700x600,390x800,375x667').split(',').map((s) => s.split('x').map(Number) as [number, number])
for (const [width, height] of sizes) for (const worst of [false, true]) {
  const browser = await launch(width, height)
  try {
    const page = await newPage(browser, width, height, inject(worst))
    const touch = width < 720
    if (touch) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await page.send('Page.navigate', { url: url.href })
    await page.waitFor("document.readyState === 'complete'")
    await page.waitFor("!!document.querySelector('.desktop')")
    // Skip the boot screen (it covers the desktop for a moment): a key press.
    await page.waitFor("!!document.querySelector('.boot')", 5000).catch(() => {})
    for (let i = 0; i < 40 && (await page.eval("!!document.querySelector('.boot')")); i++) {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await sleep(300)
    }
    await page.waitFor("import('/src/os/account.ts').then(m=>m.getAccount().status === 'user')")
    // THEME=light (or dark) runs it in that theme.
    if (process.env.THEME) await page.eval(`import('/src/os/theme.ts').then((m) => m.setMode(${JSON.stringify(process.env.THEME)}))`)
    for (let i = 0; i < 20 && !(await page.eval("!!document.querySelector('.agt-item')")); i++) {
      if (!(await page.eval("!!document.querySelector('.agt')"))) await page.eval("window.dispatchEvent(new CustomEvent('mvlos:open',{detail:{app:'agents'}}))")
      await sleep(400)
    }
    await page.waitFor("!!document.querySelector('.agt-item')")
    await page.eval("document.querySelector('.agt-item:not(.agt-studio-link)').click()")
    await page.waitFor("!!document.querySelector('.agt-toolbar .agt-ring')")
    const tag = `${width}px${worst ? ' answering, every chip' : ''}`
    if (worst) await page.waitFor("!!document.querySelector('.agt-send.is-stop')")
    assert.equal(await page.eval("!!document.querySelector('.agt-composer .agt-ring')"), false, `${tag}: no ring by the composer`)
    assert.equal(await page.eval("document.querySelector('.agt-ring').disabled"), false, `${tag}: ring enabled`)
    // The top bar does not overflow, everything in it is on screen, and the title keeps room.
    const fits = await page.eval(`(() => {
      const bar = document.querySelector('.agt-toolbar'); const box = bar.getBoundingClientRect();
      const bad = [...bar.querySelectorAll('button, .agt-chip, .agt-title, .agt-crumb')].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.left < box.left - 1 || r.right > box.right + 1) }).map((el) => el.className)
      const boxes = [...bar.querySelectorAll('.agt-back, .agt-crumb, .agt-title, .agt-chip, .agt-ring, .agt-more')].map((el) => el.getBoundingClientRect()).filter((r) => r.width)
      let overlap = 0
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlap++ }
      return { scroll: bar.scrollWidth - bar.clientWidth, bad, overlap, title: document.querySelector('.agt-title').getBoundingClientRect().width }
    })()`)
    assert.ok(fits.scroll <= 1 && !fits.bad.length && !fits.overlap, `${tag}: top bar overflows or overlaps ${JSON.stringify(fits)}`)
    assert.ok(fits.title >= 120, `${tag}: title keeps room ${fits.title}`)
    const click = async (sel: string) => {
      const r = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
      if (touch) {
        await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r[0], y: r[1] }] })
        await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      } else await page.click(r[0], r[1])
      await sleep(80)
    }
    const key = async (k: string, code: number) => {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: code, ...(k === 'Enter' ? { text: '\r' } : {}) })
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code })
      await sleep(80)
    }
    const panel = () => page.eval("!!document.querySelector('.agt-ctx-panel')")
    if (process.env.SHOT) writeFileSync(`/tmp/shot-${width}${worst ? 'w' : ''}.png`, Buffer.from((await page.send('Page.captureScreenshot', {})).data, 'base64'))
    // Repeated toggles by the ring itself, the panel named by the ring.
    for (let i = 0; i < 3; i++) {
      await click('.agt-ring')
      await page.waitFor("!!document.querySelector('.agt-ctx-bar')")
      assert.equal(await page.eval("document.querySelector('.agt-ring').getAttribute('aria-expanded')"), 'true', `${tag}: open ${i}`)
      assert.equal(await page.eval("document.querySelector('.agt-ring').getAttribute('aria-controls') === document.querySelector('.agt-ctx-panel').id"), true, `${tag}: aria-controls`)
      await click('.agt-ring')
      assert.equal(await panel(), false, `${tag}: ring closes ${i}`)
    }
    // The panel fits the screen; its title and close button stay put when it scrolls.
    await click('.agt-ring')
    await page.waitFor("!!document.querySelector('.agt-ctx-bar')")
    const fit = await page.eval(`(() => { const p = document.querySelector('.agt-ctx-panel'); const r = p.getBoundingClientRect(); const s = document.querySelector('.agt-scroll').getBoundingClientRect(); p.scrollTop = 9999; const c = document.querySelector('.agt-ctx-close').getBoundingClientRect(); const after = p.getBoundingClientRect(); const out = { right: r.right, panel: r.height, scroll: s.height, sx: p.scrollWidth - p.clientWidth, scrollable: p.scrollHeight > p.clientHeight, closeIn: c.top >= after.top - 1 && c.bottom <= after.bottom + 1 && c.right <= innerWidth }; p.scrollTop = 0; return out })()`)
    assert.ok(fit.right <= width && fit.panel <= height * 0.45 && fit.closeIn && fit.sx <= 1, `${tag}: panel fit ${JSON.stringify(fit)}`)
    assert.ok(fit.scroll >= 40, `${tag}: conversation keeps room ${fit.scroll}`)
    if (process.env.SHOT) writeFileSync(`/tmp/shot-open-${width}${worst ? 'w' : ''}.png`, Buffer.from((await page.send('Page.captureScreenshot', {})).data, 'base64'))
    // The close button.
    await click('.agt-ctx-close')
    assert.equal(await panel(), false, `${tag}: close button`)
    // Escape.
    await click('.agt-ring')
    await page.waitFor("!!document.querySelector('.agt-ctx-bar')")
    await key('Escape', 27)
    assert.equal(await panel(), false, `${tag}: Escape`)
    // Keyboard: focus the ring, Enter opens, Enter closes.
    await page.eval("document.querySelector('.agt-ring').focus()")
    for (const open of [true, false]) {
      await key('Enter', 13)
      assert.equal(await panel(), open, `${tag}: keyboard ${open}`)
    }
    // Loading and failing: still closable by the close button, a tap outside (touch) and Escape.
    for (const mode of ['slow', 'error']) {
      await page.eval(`window.__ctxMode='${mode}'`)
      await click('.agt-ring')
      await page.waitFor(mode === 'slow' ? "document.querySelector('.agt-ctx-panel')?.textContent.includes('Adding it up')" : "document.querySelector('.agt-ctx-panel')?.textContent.includes('fixture error')")
      assert.equal(await page.eval("!!document.querySelector('.agt-ctx-close')"), true, `${tag}: ${mode} close button`)
      await click(mode === 'slow' ? '.agt-ctx-close' : '.agt-ring')
      assert.equal(await panel(), false, `${tag}: ${mode} closes`)
    }
    await page.eval("window.__ctxMode='ok'")
    // Touch: a tap outside closes it, but not on a desktop with a mouse.
    await click('.agt-ring')
    await page.waitFor("!!document.querySelector('.agt-ctx-bar')")
    await click('.agt-composer textarea')
    assert.equal(await panel(), !touch, `${tag}: outside tap ${touch ? 'closes' : 'leaves it open'}`)
    // The Stats tab: the summary in monospace, every turn, no sideways scroll; a turn opens to its calls.
    if (await panel()) await click('.agt-ctx-close')
    await click('.agt-ring')
    await page.waitFor("!!document.querySelector('.agt-ctx-bar')")
    await click('.agt-ctx-tabs button:nth-child(2)')
    await page.waitFor("!!document.querySelector('.agt-stats-sum')")
    const st = await page.eval(`(() => { const p = document.querySelector('.agt-ctx-panel'); const t = p.textContent; const r = p.getBoundingClientRect(); return { sx: p.scrollWidth - p.clientWidth, right: r.right, cache: t.includes('90% of 10k input'), time: t.includes('LLM 1m16s') && t.includes('Tool 31s'), old: t.includes('1 from before stats'), turns: p.querySelectorAll('.agt-stats-turns > li').length, mono: getComputedStyle(p.querySelector('.agt-stats-sum dd')).fontFamily, selected: p.querySelector('[role=tab][aria-selected=true]').textContent } })()`)
    assert.ok(st.sx <= 1 && st.right <= width && st.cache && st.time && st.old && st.turns === 2 && /mono/i.test(st.mono) && st.selected === 'Stats', `${tag}: stats tab ${JSON.stringify(st)}`)
    await page.eval("document.querySelector('.agt-stats-turns summary').scrollIntoView({ block: 'center' })")
    await click('.agt-stats-turns summary')
    await page.waitFor("document.querySelector('.agt-stats-turns details')?.open")
    const calls = await page.eval(`(() => { const p = document.querySelector('.agt-ctx-panel'); const d = document.querySelector('.agt-stats-turns details'); return { text: d.textContent, sx: p.scrollWidth - p.clientWidth } })()`)
    assert.ok(calls.text.includes('90% cached') && calls.text.includes('150 reasoning') && calls.text.includes('—') && calls.text.includes('waiting for you') && calls.sx <= 1, `${tag}: a turn's calls ${JSON.stringify(calls)}`)
    if (process.env.SHOT) writeFileSync(`/tmp/shot-stats-${width}${worst ? 'w' : ''}.png`, Buffer.from((await page.send('Page.captureScreenshot', {})).data, 'base64'))
    await click('.agt-ctx-tabs button:nth-child(1)')
    await page.waitFor("!!document.querySelector('.agt-ctx-bar')")
    await click('.agt-ctx-close')
    // The thread menu's Thread stats opens the panel on its Stats tab.
    await click('.agt-more')
    await page.waitFor("[...document.querySelectorAll('.ctx-menu .ctx-item')].some((b) => b.textContent.startsWith('Thread stats'))")
    await page.eval("[...document.querySelectorAll('.ctx-menu .ctx-item')].find((b) => b.textContent.startsWith('Thread stats')).click()")
    await page.waitFor("!!document.querySelector('.agt-stats-sum')")
    await click('.agt-ctx-close')
    assert.equal(await panel(), false, `${tag}: stats close`)
    // Send / Stop and the other composer controls are still there, without the ring.
    assert.equal(await page.eval("!!document.querySelector('.agt-send') && !!document.querySelector('.agt-model-pill') && !!document.querySelector('button[aria-label=\"Attach files\"]')"), true, `${tag}: composer controls`)
    assert.deepEqual(page.errors, [], `${tag}: page errors`)
    await page.close()
    console.log(`${tag}: ring in the top bar, bar fits (title ${Math.round(fits.title)}px), toggle, close button, Esc, keyboard, loading, error${touch ? ', outside tap' : ''}, stats tab and Thread stats`)
  } catch (e) {
    console.error(`FAILED at ${width}px${worst ? ' worst' : ''}`)
    throw e
  } finally { await browser.close() }
}
