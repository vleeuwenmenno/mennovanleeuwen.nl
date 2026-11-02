// Mocked server events, real Conversation and confined msh executor. No model calls.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { launch, newPage, sleep } from './perf/cdp.ts'
const port = Number(process.env.XED_TEST_PORT ?? 5276)
if (port < 5170 || port > 5299) throw new Error('Use a scratch dev server on port 5170–5299')
const browser = await launch(1500, 900)
try {
  const page = await newPage(browser, 1500, 900, readFileSync(new URL('./xed-agent-fixture.js', import.meta.url), 'utf8'))
  await page.send('Network.enable')
  await page.send('Network.setBlockedURLs', { urls: ['*/api/*'] })
  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
  await page.waitFor(`!!document.querySelector('.desktop')`)
  await page.waitFor(`!document.querySelector('.boot')`)
  await page.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await page.send('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  console.log('PASS desktop booted')
  await page.eval(`(async () => {
    const b = await import('/src/data/browserfs.ts'); for(let i=0;i<100 && b.browserFilesState() !== 'ready';i++) await new Promise(r => setTimeout(r, 50)); if(b.browserFilesState() !== 'ready') throw new Error('browser state: '+b.browserFilesState());
    const fs = window.xedFs = await import('/src/terminal/fs.ts');
    const {HOME} = await import('/src/terminal/vfs.ts'); window.project = HOME + '/Projects/xed-test';
    await fs.makeDir(HOME, window.project, true);
    await fs.writeFile(window.project, 'test.txt', 'original', false);
    window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'zed', props: { path: window.project + '/test.txt', root: window.project } } }));
  })()`)
  console.log('PASS project files created')
  await page.waitFor(`!!document.querySelector('.zed-input')`)
  await sleep(700)
  await page.eval(`document.querySelector('.zed').closest('.window').style.width = '1200px'; document.querySelector('[aria-label="Toggle Agents panel"]').click()`)
  await page.waitFor(`!!document.querySelector('[data-xed-composer]')`)
  console.log('PASS real pane mounted')
  const setText = async (selector: string, value: string) => {
    await page.eval(`(() => { const t = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${JSON.stringify(value)}); t.dispatchEvent(new Event('input', {bubbles:true})) })()`)
    await sleep(50)
  }
  const send = async (command: string, hidden = false) => {
    const before = await page.eval<number>('window.__xedFixture.results.length')
    await setText('.xed-conversation:not([hidden]) [data-xed-composer]', command)
    await page.eval(`document.querySelector('.xed-conversation:not([hidden]) form').requestSubmit()`)
    if (hidden) await page.eval(`document.querySelector('[aria-label="Close Agents panel"]').click()`)
    await page.waitFor(`window.__xedFixture.results.length > ${before}`, 10000).catch(async e => { throw new Error(e.message + JSON.stringify(await page.eval(`({fixture:window.__xedFixture, text:document.querySelector('.xed-agents')?.innerText})`))) })
    await sleep(150)
    return page.eval<any>('window.__xedFixture.results.at(-1)')
  }
  const savedBeforeAttachment = await page.eval<string>(`window.xedFs.readFileText(window.project + '/test.txt').then(r => r.text)`)
  for (const contents of ['unsaved file contents', '']) {
    await setText('.zed-input', contents)
    await page.eval(`(() => { const editor = document.querySelector('.zed-input'); editor.focus(); editor.setSelectionRange(0, 0) })()`)
    for (const type of ['rawKeyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76, modifiers: 2 })
    await page.waitFor(`document.activeElement?.matches('[data-xed-composer]')`)
    await send('pwd')
    const attached = await page.eval<any>(`window.__xedFixture.sent.at(-1).attachments.find(f => f.name === window.project + '/test.txt')`)
    assert.equal(attached?.text, contents, 'Ctrl+L must attach the current buffer, not saved disk bytes')
    assert.equal(await page.eval(`window.xedFs.readFileText(window.project + '/test.txt').then(r => r.text)`), savedBeforeAttachment)
  }
  await setText('.zed-input', savedBeforeAttachment)
  console.log('PASS Ctrl+L without selection attaches unsaved contents, including an empty buffer')
  let r = await send('echo changed > test.txt')
  assert.equal(r.status, 0, JSON.stringify(r))
  await page.waitFor(`document.querySelector('.zed-input').value === 'changed\\n'`)
  console.log('PASS ordinary thread, mocked claim/result roundtrip, browser write, clean editor refresh')
  await setText('.zed-input', 'my unsaved edits')
  r = await send('echo external > test.txt')
  assert.equal(r.status, 0)
  await page.waitFor(`!!document.querySelector('.xed-external')`)
  assert.equal(await page.eval(`document.querySelector('.zed-input').value`), 'my unsaved edits')
  await page.eval(`document.querySelector('.xed-external button').click()`)
  assert.equal(await page.eval(`document.querySelector('.zed-input').value`), 'external\n')
  console.log('PASS dirty editor preserved, external change banner, explicit Reload')
  r = await send('echo escaped > ../escape.txt')
  assert.notEqual(r.status, 0)
  assert.match(r.output, /outside/)
  await page.eval(`window.__xedFixture.grant.write = false`)
  r = await send('echo denied > test.txt')
  assert.notEqual(r.status, 0)
  assert.equal(await page.eval(`window.xedFs.readFileText(window.project + '/test.txt').then(r => r.text)`), 'external\n')
  await page.eval(`window.__xedFixture.grant.write = true`)
  console.log('PASS outside-root writes denied; read-only server grant preserved')
  r = await send('rm test.txt')
  assert.equal(r.status, 0, JSON.stringify(r))
  await page.waitFor(`document.querySelector('.xed-external')?.textContent.includes('deleted')`)
  assert.equal(await page.eval(`document.querySelector('.zed-input').value`), 'external\n')
  console.log('PASS deleted file retains editor contents and explicit deletion state')
  r = await send('sleep 1; echo hidden > test.txt', true)
  assert.equal(r.status, 0, JSON.stringify(r))
  assert.equal(await page.eval(`document.querySelector('.xed-agents').hidden`), true)
  assert.equal(await page.eval(`window.xedFs.readFileText(window.project + '/test.txt').then(r => r.text)`), 'hidden\n')
  console.log('PASS hidden pane retains executor through delayed write')
  await page.eval(`document.querySelector('[aria-label="Toggle Agents panel"]').click()`)
  const first = await page.eval<string>('window.__xedFixture.sent[0].id')
  await page.eval(`document.querySelector('.xed-agents [aria-label="New thread"]').click()`)
  await page.waitFor(`document.querySelectorAll('.xed-conversation').length === 2`)
  assert.equal(await page.eval('document.querySelectorAll(".xed-conversation:not([hidden])").length'), 1)
  r = await send('pwd')
  assert.notEqual(r.id, first)
  assert.equal(r.output.trim(), await page.eval('window.project'))
  // Mount an embedded Terminal after Agents: its same-PID guard must compose, not replace.
  await page.eval(`document.querySelector('[aria-label="Toggle terminal panel"]').click()`)
  await page.waitFor(`!!document.querySelector('.zed-dock-term .terminal')`)
  const priorCount = await page.eval<number>('window.__xedFixture.sent.length')
  const inflight = send('sleep 2; pwd')
  await page.waitFor(`window.__xedFixture.sent.length > ${priorCount}`)
  await sleep(100)
  await page.eval(`document.querySelector('.zed').closest('.window').querySelector('.ctl-close').click()`)
  await page.waitFor(`document.body.textContent.includes('still answering')`)
  await page.eval(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Cancel').click()`)
  assert.equal(await page.eval(`!!document.querySelector('.zed')`), true, 'cancel keeps Xed and its executor mounted')
  await page.eval(`document.querySelector('.zed [aria-label^="Close terminal "]').click()`)
  await page.waitFor(`!document.querySelector('.zed-dock-term')`)
  await page.eval(`document.querySelector('.zed').closest('.window').querySelector('.ctl-close').click()`)
  await page.waitFor(`document.body.textContent.includes('still answering')`)
  await page.eval(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Cancel').click()`)
  assert.equal(await page.eval(`!!document.querySelector('.zed')`), true, 'terminal cleanup cannot remove Agents close guard')
  console.log('PASS terminal mount and unmount preserve Agents close guard; both cancellations keep Xed open')
  await page.eval(`document.querySelector('.xed-agents [aria-label="New thread"]').click()`)
  await page.waitFor(`document.querySelectorAll('.xed-conversation').length === 3`)
  const completed = await inflight
  assert.equal(completed.id, r.id)
  assert.equal(completed.output.trim(), await page.eval('window.project'))
  console.log('PASS window close asks about active executor; switching threads preserves its original folder')
  await page.eval(`document.querySelector('[aria-label="Open in Agents"]').click()`)
  await page.waitFor(`!!document.querySelector('.agt')`)
  console.log('PASS thread switching retains old pane; Open in Agents opens ordinary conversation')
  const guarded = await page.eval<any>(`(async () => {
    const {runInFolder} = await import('/src/terminal/agents/exec.ts');
    const {browserStoreIdentity} = await import('/src/data/browserfs.ts');
    const identity = browserStoreIdentity(), ctl = new AbortController();
    const req = {name:'terminal', arguments:{command:'sleep 1; echo late > test.txt'}, folder:{path:window.project,label:window.project,browser:identity},fallbackDir:window.project,grant:window.__xedFixture.grant,signal:ctl.signal};
    const task = runInFolder(req); setTimeout(() => ctl.abort(), 50); const cancelled = await task;
    await new Promise(r => setTimeout(r, 1100));
    const content = (await window.xedFs.readFileText(window.project + '/test.txt')).text;
    const stale = await runInFolder({...req,arguments:{command:'cat test.txt'},folder:{...req.folder,browser:{...identity,storeUUID:'replaced'}},signal:new AbortController().signal});
    return {cancelled,content,stale};
  })()`)
  assert.notEqual(guarded.cancelled.status, 0)
  assert.equal(guarded.content, 'hidden\n')
  assert.notEqual(guarded.stale.status, 0)
  console.log('PASS cancelled executor cannot write later; stale browser store identity denied')
  assert.deepEqual(page.errors, [])
} finally { await browser.close() }
