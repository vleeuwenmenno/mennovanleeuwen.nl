// Browser regression against a running scratch Vite server: a failed web read's card in Agents.
// All API fetches are mocked; any write (a message sent, an approval answered) fails the check.
// DATA_DIR=<scratch> vite --port 5290 --strictPort
// pnpm check:agents-web-recovery-ui http://127.0.0.1:5290 [1280x800,390x800]
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { launch, newPage, sleep } from './perf/cdp.ts'
const url = new URL(process.argv[2] ?? 'http://127.0.0.1:5290')
if (url.hostname !== '127.0.0.1' || Number(url.port) < 5170 || Number(url.port) > 5299) throw new Error('Use a scratch Vite server on 127.0.0.1:5170–5299')
const inject = `
document.cookie='mvlos_uid=1; path=/';document.cookie='mvlos_login=fixture; path=/';
{
 const d=Object.getOwnPropertyDescriptor(Document.prototype,'cookie');
 Object.defineProperty(document,'cookie',{configurable:true,get(){const c=d.get.call(document);return /mvlos_uid=/.test(c)?c:(c?c+'; ':'')+'mvlos_uid=1'},set(v){if(!/^mvlos_uid=/.test(v))d.set.call(document,v)}});
}
document.addEventListener('DOMContentLoaded',()=>{const st=document.createElement('style');st.textContent='.notices{display:none!important}';document.head.append(st)});
window.__writes=[];window.__errs=[];addEventListener('unhandledrejection',(e)=>window.__errs.push(String(e.reason?.stack)));addEventListener('error',(e)=>window.__errs.push(String(e.error?.stack)));
const rawFetch=window.fetch.bind(window);
const LONG='https://www.example.com/articles/'+'very-long-path-segment/'.repeat(8)+'page.html?ref=1';
const mk=(id,title)=>({id,title,mode:'quick',model:'fixture',archived:false,createdAt:1,updatedAt:2,running:false,titling:false,contextTokens:1000,tools:[],projectId:null,pinned:false,todos:[],quick:true,workdir:null,permission:'default',queue:[],interrupted:null,titleSource:'user',aliases:[],checkingTitle:false,mailReadsAlways:false});
const t1=mk('t1','Reading'),t2=mk('t2','Other');t2.queue=[{id:'q1',text:'queued message',attachments:[],createdAt:1,editing:false}];
const call=(u)=>({name:'web_fetch',arguments:{url:u}});
const tool=(id,e)=>({id,role:'tool',toolName:'web_fetch',content:JSON.stringify({error:e}),createdAt:2});
const messages=[
 {id:1,role:'user',content:'Read it',createdAt:1},
 {id:2,role:'assistant',content:'',toolCalls:[call(LONG),call('https://b.example/denied'),call('javascript:alert(1)'),call('https://c.example/ok')],createdAt:2},
 tool(3,'Page not found (404): the address may be wrong or the page has moved.'),
 tool(4,'The user declined this. Ask what they want instead.'),
 tool(5,'Couldn\\'t read the page (blocked): try another source.'),
 {id:6,role:'tool',toolName:'web_fetch',content:JSON.stringify({title:'Fine',content:'text',links:[]}),createdAt:2},
 {id:7,role:'assistant',content:'Could not read it.',createdAt:3},
];
window.fetch=async(input, init)=>{
 const u=new URL(typeof input==='string'?input:input.url,location.href);const path=u.pathname;
 if(!path.startsWith('/api/'))return rawFetch(input,init);
 const method=(init&&init.method)||(typeof input!=='string'&&input.method)||'GET';
 if(method!=='GET'&&path!=='/api/agents/threads/t2/queue/q1'&&path!=='/api/prefs'&&!path.endsWith('/follow'))window.__writes.push(method+' '+path);
 const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
 if(method==='PATCH'&&path==='/api/agents/threads/t2/queue/q1')return json({thread:t2,item:{id:'q1',text:'queued message',attachments:[]}});
 if(path==='/api/me')return json({authEnabled:true,user:{id:1,login:'fixture',admin:false,githubScopes:[]},forges:[],integrations:{ollama:'settings'}});
 if(path==='/api/agents/models')return json([{name:'fixture',vision:true,contextLength:131072}]);
 if(path==='/api/agents/projects')return json([]);
 if(path==='/api/agents/threads')return json([t1,t2]);
 if(path==='/api/agents/threads/t1')return json({thread:t1,messages,pending:[]});
 if(path==='/api/agents/threads/t2')return json({thread:t2,messages,pending:[]});
 if(path.endsWith('/follow'))return new Response(new ReadableStream({start(c){c.close()}}),{headers:{'Content-Type':'application/x-ndjson'}});
 if(path==='/api/agents/tasks')return json({tasks:[],enabled:true});
 if(path==='/api/prefs')return json({});
 return json([]);
};
`
// SHOT_DIR=<folder outside the repo> saves screenshots of the card and the dialog.
const shot = async (page: { send: (m: string, p: object) => Promise<{ data: string }> }, name: string) => {
  const dir = process.env.SHOT_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/${name}.png`, Buffer.from((await page.send('Page.captureScreenshot', {})).data, 'base64'))
}
const sizes: [number, number][] = (process.argv[3] ?? '1280x800,390x800').split(',').map((s) => s.split('x').map(Number) as [number, number])
for (const [width, height] of sizes) {
  const browser = await launch(width, height)
  try {
    const page = await newPage(browser, width, height, inject)
    const touch = width < 720
    if (touch) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await page.send('Page.navigate', { url: url.href })
    await page.waitFor("document.readyState === 'complete'")
    await page.waitFor("!!document.querySelector('.desktop')")
    for (let i = 0; i < 40 && (await page.eval("!!document.querySelector('.boot')")); i++) {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await sleep(300)
    }
    await page.waitFor("import('/src/os/account.ts').then(m=>m.getAccount().status === 'user')")
    // Ten attachments waiting in thread t2's box, to try the full-box case there later.
    await page.eval(`import('/src/data/agentDrafts.ts').then((m)=>m.setDraft('t2','',Array.from({length:10},(_, i)=>({name:'f'+i+'.txt',source:'Pasted',kind:'text',mime:'text/plain',size:1,text:'x'}))))`)
    for (let i = 0; i < 20 && !(await page.eval("!!document.querySelector('.agt-item')")); i++) {
      if (!(await page.eval("!!document.querySelector('.agt')"))) await page.eval("window.dispatchEvent(new CustomEvent('mvlos:open',{detail:{app:'agents'}}))")
      await sleep(400)
    }
    const openThread = async (title: string) => {
      await page.eval(`[...document.querySelectorAll('.agt-item')].find((e) => e.textContent.includes(${JSON.stringify(title)})).click()`)
      await page.waitFor(`document.querySelector('.agt-title')?.textContent.includes(${JSON.stringify(title)})`)
    }
    await openThread('Reading')
    await page.waitFor("document.querySelectorAll('.agt-tool').length >= 4")
    const tag = `${width}px`
    const cards = await page.eval(`(() => [...document.querySelectorAll('.agt-tool')].map((c) => ({ label: c.querySelector('.agt-tool-label').textContent, title: c.querySelector('.agt-tool-label').title, text: c.querySelector('summary').textContent, recover: !!c.querySelector('.agt-recover'), open: c.open })))()`)
    assert.ok(cards[0].recover && cards[0].open && cards[0].text.includes('Reader couldn’t retrieve this page'), `${tag}: failed read card ${JSON.stringify(cards[0])}`)
    assert.ok(cards[0].label.endsWith('…') && cards[0].title.startsWith('https://www.example.com/articles/'), `${tag}: label cut with an ellipsis, tooltip whole`)
    assert.ok(!cards[1].recover && cards[1].text.includes('The user declined this'), `${tag}: a declined read keeps its own message`)
    assert.ok(cards[2].recover, `${tag}: unsafe address still a failed read`)
    assert.ok(!cards[3].recover, `${tag}: a good read has no recovery`)
    // The whole address, a safe link, and no sideways scroll.
    const first = await page.eval(`(() => { const c = document.querySelector('.agt-recover'); const a = c.querySelector('.agt-recover-url a'); const open = [...c.querySelectorAll('.agt-recover-actions a')][0]; const sc = document.querySelector('.agt-scroll'); return { text: a.textContent, href: a.getAttribute('href'), target: open.target, rel: open.rel, openHref: open.getAttribute('href'), raw: c.querySelector('.agt-recover-raw pre').textContent, sx: sc.scrollWidth - sc.clientWidth, over: c.getBoundingClientRect().right - sc.getBoundingClientRect().right } })()`)
    assert.ok(first.text.includes('page.html?ref=1') && first.href === first.text && first.openHref === first.text, `${tag}: full address ${first.text}`)
    assert.ok(first.target === '_blank' && first.rel.includes('noopener') && first.rel.includes('noreferrer'), `${tag}: opens in a new tab safely`)
    assert.ok(first.raw.includes('Page not found (404)') && first.sx <= 1 && first.over <= 1, `${tag}: raw error kept, fits ${JSON.stringify(first)}`)
    const unsafe = await page.eval(`(() => { const c = document.querySelectorAll('.agt-recover')[1]; return { links: c.querySelectorAll('a').length, disabled: [...c.querySelectorAll('button')].some((b) => b.textContent === 'Open page' && b.disabled) } })()`)
    assert.ok(unsafe.links === 0 && unsafe.disabled, `${tag}: javascript: never opens ${JSON.stringify(unsafe)}`)
    await page.eval("document.querySelector('.agt-recover').scrollIntoView({ block: 'center' })")
    await shot(page, `card-${width}`)
    // Paste a short page over a typed draft: after it, with the address, not sent.
    const pasteButton = "document.querySelector('.agt-recover-actions button')"
    const type = async (text: string) => (await page.eval("document.querySelector('.dlg textarea').focus()"), await page.send('Input.insertText', { text }))
    await page.eval("(() => { const t = document.querySelector('.agt-composer textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'my question'); t.dispatchEvent(new Event('input', { bubbles: true })) })()")
    await page.eval(`${pasteButton}.click()`)
    await page.waitFor("!!document.querySelector('.dlg textarea')")
    await page.waitFor("document.activeElement === document.querySelector('.dlg textarea')", 3000).catch(() => {})
    assert.equal(await page.eval("document.activeElement === document.querySelector('.dlg textarea')"), true, `${tag}: dialog textarea focused`)
    await type('The page says hello.')
    await shot(page, `dialog-${width}`)
    await page.eval("[...document.querySelectorAll('.dlg .btn')].find((b) => b.textContent === 'Add to message').click()")
    await page.waitFor("!document.querySelector('.dlg')")
    const box = await page.eval("document.querySelector('.agt-composer textarea').value")
    assert.ok(box.startsWith('my question\n\n') && box.includes('The page says hello.') && box.includes('page.html?ref=1'), `${tag}: draft kept, page added: ${box}`)
    // Long text becomes a file; the box keeps what it had.
    await page.eval(`${pasteButton}.click()`)
    await page.waitFor("!!document.querySelector('.dlg textarea')")
    await type('long '.repeat(1500))
    await page.eval("[...document.querySelectorAll('.dlg .btn')].find((b) => b.textContent === 'Add to message').click()")
    await page.waitFor("!document.querySelector('.dlg')")
    const withFile = await page.eval("({ files: document.querySelector('.agt-composer').textContent, box: document.querySelector('.agt-composer textarea').value })")
    assert.ok(withFile.files.includes('Page text.txt') && withFile.box.includes('my question') && withFile.box.includes('(attached as a file)') && withFile.box.length < 1000, `${tag}: long text attached ${JSON.stringify(withFile).slice(0, 300)}`)
    // Cancel adds nothing.
    await page.eval(`${pasteButton}.click()`)
    await page.waitFor("!!document.querySelector('.dlg textarea')")
    await type('never added')
    await page.eval("[...document.querySelectorAll('.dlg .btn')].find((b) => b.textContent === 'Cancel').click()")
    await page.waitFor("!document.querySelector('.dlg')")
    assert.ok(!(await page.eval("document.querySelector('.agt-composer textarea').value")).includes('never added'), `${tag}: cancel adds nothing`)
    // A stale dialog: the thread changes under it, nothing lands in the other one.
    await page.eval(`${pasteButton}.click()`)
    await page.waitFor("!!document.querySelector('.dlg textarea')")
    await type('stale text')
    await page.eval("document.querySelector('.agt-item.is-selected, .agt-item[aria-current]')?.blur()")
    await page.eval(`[...document.querySelectorAll('.agt-item')].find((e) => e.textContent.includes('Other')).click()`)
    await page.eval("[...document.querySelectorAll('.dlg .btn')].find((b) => b.textContent === 'Add to message').click()")
    await page.waitFor("[...document.querySelectorAll('.dlg')].some((d) => d.textContent.includes('Page text not added')) || !document.querySelector('.dlg')", 5000).catch(() => {})
    await page.eval("[...document.querySelectorAll('.dlg .btn')].forEach((b) => b.click())")
    await page.waitFor("document.querySelector('.agt-title')?.textContent.includes('Other')")
    assert.ok(!(await page.eval("document.querySelector('.agt-composer textarea').value")).includes('stale text'), `${tag}: nothing lands in the other thread`)
    // Enter in the dialog is a new line, not Add: nothing is staged until the button.
    await page.eval(`${pasteButton}.click()`)
    await page.waitFor("!!document.querySelector('.dlg textarea')")
    const before = await page.eval("document.querySelector('.agt-composer textarea').value")
    await type('line one')
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await page.send('Input.insertText', { text: 'line two' })
    assert.equal(await page.eval("document.querySelector('.dlg textarea').value"), 'line one\nline two', `${tag}: Enter is a new line`)
    assert.equal(await page.eval("document.querySelector('.agt-composer textarea').value"), before, `${tag}: Enter stages nothing`)
    await page.eval("[...document.querySelectorAll('.dlg .btn')].find((b) => b.textContent === 'Cancel').click()")
    await page.waitFor("!document.querySelector('.dlg')")
    // Full box (ten attachments): a long page cannot become an eleventh; the text stays in the dialog with the reason; Ctrl+Enter adds a short one.
    await page.waitFor("document.querySelectorAll('.agt-recover').length >= 1")
    await page.eval(`${pasteButton}.click()`)
    await page.waitFor("!!document.querySelector('.dlg textarea')")
    await type('long '.repeat(1500))
    await page.eval("[...document.querySelectorAll('.dlg .btn')].find((b) => b.textContent === 'Add to message').click()")
    await page.waitFor("!!document.querySelector('.dlg .dlg-problem')")
    assert.ok((await page.eval("document.querySelector('.dlg textarea').value")).length >= 7000 && (await page.eval("document.querySelector('.dlg-problem').textContent")).includes('10 already'), `${tag}: full box keeps the text and says why`)
    await page.eval("document.querySelector('.dlg textarea').focus(); document.querySelector('.dlg textarea').select()")
    await page.send('Input.insertText', { text: 'short page' })
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 })
    await page.waitFor("!document.querySelector('.dlg')")
    assert.ok((await page.eval("document.querySelector('.agt-composer textarea').value")).includes('short page'), `${tag}: Ctrl+Enter adds it`)
    // A queued message being edited: the paste button is disabled and opens nothing.
    await page.eval("[...document.querySelectorAll('.agt-queue button')].find((b) => b.textContent.trim() === 'Edit').click()")
    await page.waitFor("document.querySelector('.agt-composer textarea').value === 'queued message'", 4000).catch(async () => { throw new Error('queue edit: ' + JSON.stringify(await page.eval("({ q: document.querySelector('.agt-queue')?.textContent, v: document.querySelector('.agt-composer textarea').value, e: document.querySelector('.agt-error')?.textContent, w: window.__writes })"))) })
    const blocked = await page.eval(`(() => { const b = ${pasteButton}; b.click(); return { disabled: b.disabled, title: b.title, dialog: !!document.querySelector('.dlg') } })()`)
    assert.ok(blocked.disabled && blocked.title.includes('queued message') && !blocked.dialog, `${tag}: disabled while editing a queued message ${JSON.stringify(blocked)}`)
    assert.deepEqual(await page.eval('window.__writes'), [], `${tag}: nothing was sent or answered`)
    assert.deepEqual(page.errors, [], `${tag}: page errors ${JSON.stringify(await page.eval('window.__errs'))}`)
    await page.close()
    console.log(`${tag}: failed read card, full address, safe open link, paste (draft kept, long as file, cancel, stale thread), nothing sent${touch ? ', touch' : ''}`)
  } catch (e) {
    console.error(`FAILED at ${width}px`)
    throw e
  } finally {
    await browser.close()
  }
}
