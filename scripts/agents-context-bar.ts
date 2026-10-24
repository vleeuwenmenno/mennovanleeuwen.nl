// Browser regression against a running scratch Vite server. All API fetches are mocked, no writes.
// The context ring sits in the thread's top bar (not the composer), opens and closes the panel
// reliably, and the bar fits on a phone.
// DATA_DIR=<scratch> vite --port 5290 --strictPort
// pnpm check:agents-context-bar http://127.0.0.1:5290
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { launch, newPage, sleep } from './perf/cdp.ts'
const url = new URL(process.argv[2] ?? 'http://127.0.0.1:5290')
if (url.hostname !== '127.0.0.1' || Number(url.port) < 5170 || Number(url.port) > 5299) throw new Error('Use a scratch Vite server on 127.0.0.1:5170–5299')
const inject = `
document.cookie='mvlos_uid=1; path=/';document.cookie='mvlos_login=fixture; path=/';
window.EventSource=class extends EventTarget { close() {} };
const rawFetch=window.fetch.bind(window);
const thread={id:'t1',title:'A thread with a rather long title to prove the bar copes with it',mode:'quick',model:'fixture',archived:false,createdAt:1,updatedAt:2,running:false,titling:false,contextTokens:30000,tools:[],projectId:null,pinned:false,todos:[],quick:true,workdir:{repo:'r',path:'/p',label:'~/Projects/a-long-folder-name'},permission:'default',queue:[],interrupted:null,titleSource:'user',aliases:[],checkingTitle:false};
const messages=[{id:1,role:'user',content:'Hello',createdAt:1},{id:2,role:'assistant',content:'Hi there',createdAt:2}];
const context={model:'fixture',contextLength:131072,measured:30000,estimate:30500,parts:[['System prompt',2400],['Tool definitions',3800],['Messages',22000],['Summary of earlier messages',2300]].map(([label,tokens])=>({label,tokens})),compaction:null,autoCompact:80};
window.fetch=async(input, init)=>{
 const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
 if(!path.startsWith('/api/'))return rawFetch(input,init);
 const json=(value)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
 if(path==='/api/me')return json({authEnabled:true,user:{id:1,login:'fixture',admin:false,githubScopes:[]},forges:[],integrations:{ollama:'settings'}});
 if(path==='/api/agents/models')return json([{name:'fixture',vision:true,contextLength:131072}]);
 if(path==='/api/agents/threads')return json([thread]);
 if(path==='/api/agents/threads/t1')return json({thread,messages,pending:[]});
 if(path==='/api/agents/threads/t1/context')return json(context);
 if(path==='/api/prefs')return json({});
 return json([]);
};
`
const sizes: [number, number][] = (process.argv[3] ?? '1280x800,900x700,390x800,375x667').split(',').map((s) => s.split('x').map(Number) as [number, number])
for (const [width, height] of sizes) {
  const browser = await launch(width, height)
  try {
    const page = await newPage(browser, width, height, inject)
    const touch = width < 720
    if (touch) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await page.send('Page.navigate', { url: url.href })
    await page.waitFor("document.readyState === 'complete'")
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.waitFor("!!document.querySelector('.desktop')")
    await page.waitFor("import('/src/os/account.ts').then(m=>m.getAccount().status === 'user')")
    await page.eval("window.dispatchEvent(new CustomEvent('mvlos:open',{detail:{app:'agents'}}))")
    await page.waitFor("!!document.querySelector('.agt-item')")
    await page.eval("document.querySelector('.agt-item').click()")
    await page.waitFor("!!document.querySelector('.agt-toolbar .agt-ring')")
    const tag = `${width}px`
    // The ring is in the top bar, not in the composer next to Send.
    assert.equal(await page.eval("!!document.querySelector('.agt-composer .agt-ring')"), false, `${tag}: no ring by the composer`)
    assert.equal(await page.eval("!document.querySelector('.agt-ring').disabled"), true, `${tag}: ring enabled`)
    // The top bar does not overflow, and everything in it is on screen.
    const fits = await page.eval(`(() => {
      const bar = document.querySelector('.agt-toolbar'); const box = bar.getBoundingClientRect();
      const bad = [...bar.querySelectorAll('button, .agt-chip, .agt-title')].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.left < box.left - 1 || r.right > box.right + 1) }).map((el) => el.className)
      return { scroll: bar.scrollWidth - bar.clientWidth, bad }
    })()`)
    assert.ok(fits.scroll <= 1 && !fits.bad.length, `${tag}: top bar overflows ${JSON.stringify(fits)}`)
    const click = async (sel: string) => {
      const r = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
      if (touch) {
        await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r[0], y: r[1] }] })
        await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      } else await page.click(r[0], r[1])
      await sleep(80)
    }
    const panel = () => page.eval("!!document.querySelector('.agt-ctx-panel')")
    if (process.env.SHOT) writeFileSync(`/tmp/shot-${width}.png`, Buffer.from((await page.send('Page.captureScreenshot', {})).data, 'base64'))
    // Repeated toggles by the ring itself.
    for (let i = 0; i < 3; i++) {
      await click('.agt-ring')
      await page.waitFor("!!document.querySelector('.agt-ctx-bar')")
      assert.equal(await page.eval("document.querySelector('.agt-ring').getAttribute('aria-expanded')"), 'true', `${tag}: open ${i}`)
      await click('.agt-ring')
      assert.equal(await panel(), false, `${tag}: ring closes ${i}`)
    }
    // The panel fits the screen and keeps the close button within reach.
    await click('.agt-ring')
    await page.waitFor("!!document.querySelector('.agt-ctx-bar')")
    const fit = await page.eval(`(() => { const r = document.querySelector('.agt-ctx-panel').getBoundingClientRect(); const c = document.querySelector('.agt-ctx-close').getBoundingClientRect(); const s = document.querySelector('.agt-scroll').getBoundingClientRect(); return { right: r.right, panel: r.height, closeIn: c.top >= r.top && c.bottom <= r.bottom + 1 && c.right <= innerWidth, scroll: s.height, sx: document.querySelector('.agt-ctx-panel').scrollWidth - document.querySelector('.agt-ctx-panel').clientWidth } })()`)
    assert.ok(fit.right <= width && fit.panel <= height * 0.45 && fit.closeIn && fit.sx <= 1, `${tag}: panel fit ${JSON.stringify(fit)}`)
    assert.ok(fit.scroll >= 100, `${tag}: conversation keeps room ${fit.scroll}`)
    if (process.env.SHOT) writeFileSync(`/tmp/shot-open-${width}.png`, Buffer.from((await page.send('Page.captureScreenshot', {})).data, 'base64'))
    // The close button.
    await click('.agt-ctx-close')
    assert.equal(await panel(), false, `${tag}: close button`)
    // Escape.
    await click('.agt-ring')
    await page.waitFor("!!document.querySelector('.agt-ctx-bar')")
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(80)
    assert.equal(await panel(), false, `${tag}: Escape`)
    // Keyboard: focus the ring, Enter opens, Enter closes.
    await page.eval("document.querySelector('.agt-ring').focus()")
    for (const open of [true, false]) {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await sleep(80)
      assert.equal(await panel(), open, `${tag}: keyboard ${open}`)
    }
    // Touch: a tap outside closes it, but not on a desktop with a mouse.
    await click('.agt-ring')
    await page.waitFor("!!document.querySelector('.agt-ctx-bar')")
    await click('.agt-composer textarea')
    assert.equal(await panel(), !touch, `${tag}: outside tap ${touch ? 'closes' : 'leaves it open'}`)
    // Send and the other composer controls are still there, without the ring.
    assert.equal(await page.eval("!!document.querySelector('.agt-send') && !!document.querySelector('.agt-model-pill') && !!document.querySelector('button[aria-label=\"Attach files\"]')"), true, `${tag}: composer controls`)
    assert.deepEqual(page.errors, [], `${tag}: page errors`)
    await page.close()
    console.log(`${tag}: ring in the top bar, bar fits, panel opens and closes by ring, close button, Esc, keyboard${touch ? ', outside tap' : ''}`)
  } finally { await browser.close() }
}
