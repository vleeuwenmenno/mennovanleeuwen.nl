// Drives Xed's msh debugger in the repository's muted Chromium harness against a caller-owned
// scratch Vite server: real gutter clicks, real key events (F5, F9, F10, F11 …), real textarea
// input and pointer hovers, checking what the page shows and what the script really did.
import { launch, newPage, sleep } from './perf/cdp.ts'
const port = Number(process.env.XED_TEST_PORT ?? 5276)
if (port < 5170 || port > 5299) throw new Error('Use a scratch dev server on port 5170–5299')
const browser = await launch(1280, 800)
const pass = (what: string) => console.log('PASS', what)
const fail = (what: string, detail: unknown) => { throw new Error(`FAIL ${what}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`) }
const expect = (ok: boolean, what: string, detail: unknown = '') => (ok ? pass(what) : fail(what, detail))
const LINE = 20, PAD = 12
try {
  const page = await newPage(browser, 1280, 800, '')
  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
  await page.waitFor(`document.readyState === 'complete'`)
  const escape = async () => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(250)
  }
  for (let i = 0; i < 40 && !(await page.eval(`!!document.querySelector('.window')`)); i++) await escape()
  for (let i = 0; i < 40 && (await page.eval(`!!document.querySelector('.boot')`)); i++) await escape()
  const lib = 'greet() {\n  local who=$1\n  msg="hello $who"\n  echo "$msg"\n}'
  const main = '#!/bin/msh\nsource /tmp/xed-lib.msh\nname=world\ngreet "$name"\ncount=0\nfor i in 1 2 3; do\n  count=$((count + i))\ndone\necho "count=$count"'
  await page.eval(`(async () => {
    const fs = await import('/src/terminal/fs.ts')
    await fs.writeFile('/tmp', '/tmp/xed-lib.msh', ${JSON.stringify(lib)}, false)
    await fs.writeFile('/tmp', '/tmp/xed-main.msh', ${JSON.stringify(main)}, false)
    await fs.writeFile('/tmp', '/tmp/xed-loop.msh', 'while true; do n=1; done', false)
    await fs.writeFile('/tmp', '/tmp/xed-other.msh', 'echo other', false)
    window.xedDebug = await import('/src/terminal/msh/debug.ts')
    window.xedFs = fs
    window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'zed', props: { path: '/tmp/xed-main.msh', root: '/tmp' } } }))
  })()`)
  await page.waitFor(`!!document.querySelector('.zed .xed-dbg-bar')`)
  await page.eval(`document.querySelector('.zed').closest('.window').dataset.test = 'a'`)
  for (let i = 0; i < 20 && (await page.eval(`!!document.querySelector('.boot')`)); i++) await escape()

  // Everything below happens in window `tag` (data-test), so a second Xed window cannot be confused with it.
  const inWin = <T = any>(tag: string, js: string) => page.eval<T>(`(() => { const W = document.querySelector('.window[data-test="${tag}"]'); if (!W) throw new Error('no window ${tag}'); ${js} })()`)
  const A = <T = any>(js: string) => inWin<T>('a', js)
  const state = (tag = 'a') => inWin<string>(tag, `return W.querySelector('.xed-dbg-state .xed-dbg-long').textContent`)
  const waitState = (prefix: string, tag = 'a') => page.waitFor(`document.querySelector('.window[data-test="${tag}"] .xed-dbg-state .xed-dbg-long')?.textContent.startsWith(${JSON.stringify(prefix)})`, 15000)
  const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }
  const CODES: Record<string, number> = { F5: 116, F6: 117, F9: 120, F10: 121, F11: 122 }
  // Keys go through CDP like a real keyboard; `prevented` reports whether the page cancelled the default
  // (read after dispatch, from a capture listener on window so no handler can hide the event from it).
  const key = async (k: string, mods = 0) => {
    await page.eval(`window.xedKeyLog = []; window.xedKeyHook ||= (addEventListener('keydown', e => setTimeout(() => window.xedKeyLog.push({ key: e.key, prevented: e.defaultPrevented })), true), true)`)
    for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: CODES[k], modifiers: mods })
    await sleep(60)
    return page.eval<{ key: string; prevented: boolean }[]>('window.xedKeyLog')
  }
  const tab = (name: string, tag = 'a') => inWin(tag, `const t = [...W.querySelectorAll('.xed-dbg-tab')].find(e => e.textContent.startsWith(${JSON.stringify(name)})); if (!t) throw new Error('no tab ${name}'); t.click()`)
  const button = (label: string, tag = 'a') => inWin(tag, `const b = W.querySelector('[aria-label=${JSON.stringify(label)}]'); if (!b || b.disabled) throw new Error('Control unavailable: ${label}'); b.click()`)
  const activeFile = (tag = 'a') => inWin<string>(tag, `return (W.querySelector('.zed-tabs .zed-tab.is-active')?.textContent ?? '').replace(/[●×]/g, '').trim()`)
  const edit = (value: string, tag = 'a') => inWin(tag, `
    const e = W.querySelector('textarea.zed-input')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, ${JSON.stringify(value)})
    e.dispatchEvent(new Event('input', { bubbles: true }))`)
  const caretAt = (offset: number, end = offset, tag = 'a') => inWin(tag, `
    const e = W.querySelector('textarea.zed-input'); e.focus(); e.setSelectionRange(${offset}, ${end})
    e.dispatchEvent(new Event('select', { bubbles: true }))
    e.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))`)
  const gutterRow = (line: number, tag = 'a') => inWin<string>(tag, `return W.querySelector('.zed-gutter').children[${line - 1}].className`)
  /** A real click on a window's title bar (left of its buttons): the window manager focuses it. */
  const focusWin = async (tag: string) => {
    const t = await inWin<{ x: number; y: number }>(tag, `
      const r = W.querySelector('.titlebar').getBoundingClientRect(), y = r.y + r.height / 2
      for (let x = r.x + 8; x < r.right - 8; x += 12) { const e = document.elementFromPoint(x, y); if (e?.closest('.titlebar') && e.closest('.window') === W && !e.closest('button')) return { x, y } }
      throw new Error('title bar covered')`)
    await page.click(t.x, t.y)
    await page.waitFor(`document.querySelector('.window[data-test="${tag}"]').classList.contains('is-focused')`, 5000)
  }
  const points = () => page.eval<string[]>(`window.xedDebug.editorBreakpoints().map(b => b.path + ':' + b.line + (b.enabled ? '' : ' off'))`)

  // --- syntax diagnostics and highlighting (real textarea input) ------------------------------------
  const malformed = 'if true; then\n  echo "$value" | cat\nfi\nthen'
  await edit(malformed)
  await A(`W.querySelector('[aria-label="Toggle debug panel"]').click()`)
  await tab('Problems')
  await page.waitFor(`document.querySelector('.window[data-test="a"] .xed-diagnostic')?.textContent.includes('/tmp/xed-main.msh:4:1:')`)
  const lint = await A<string>(`return W.querySelector('.xed-diagnostic').textContent`)
  expect(lint.includes('syntax error') && lint.includes('[then]') && (await gutterRow(4)).includes('has-error'), 'textarea input updates the Problems list and marks the gutter line', lint)
  const highlighting = await A(`
    const pre = W.querySelector('.zed-hl:not(.zed-marks)')
    return { text: pre.textContent, keyword: [...pre.querySelectorAll('.md-bullet')].some(e => e.textContent === 'if'), quoted: [...pre.querySelectorAll('.md-code')].some(e => e.textContent === '"$value"'), pipe: [...pre.querySelectorAll('.md-punct')].some(e => e.textContent === '|') }`)
  expect(highlighting.text === malformed + '\n' && highlighting.keyword && highlighting.quoted && highlighting.pipe, 'real msh highlighting', highlighting)
  await edit(main)
  await page.waitFor(`!document.querySelector('.window[data-test="a"] .xed-diagnostic') && !document.querySelector('.window[data-test="a"] .zed-tab-x.is-dirty')`)

  // --- breakpoints: gutter click, list, F9, enable/disable, navigate, remove ------------------------
  const rowPoint = (line: number) => A<{ x: number; y: number }>(`const r = W.querySelector('.zed-gutter').children[${line - 1}].getBoundingClientRect(); return { x: r.x + 3, y: r.y + r.height / 2 }`)
  let at = await rowPoint(4)
  await page.click(at.x, at.y)
  await page.waitFor(`document.querySelector('.window[data-test="a"] .zed-gutter').children[3].classList.contains('has-bp')`)
  expect(JSON.stringify(await points()) === '["/tmp/xed-main.msh:4"]', 'a real gutter click sets a breakpoint with the canonical path', await points())
  await page.click(at.x, at.y)
  await page.waitFor(`!document.querySelector('.window[data-test="a"] .zed-gutter').children[3].classList.contains('has-bp')`)
  await page.click(at.x, at.y)
  await page.waitFor(`document.querySelector('.window[data-test="a"] .zed-gutter').children[3].classList.contains('has-bp')`)
  pass('a second gutter click removes it, a third sets it again')
  // F9 on the caret's line: a blank-of-commands line shows as such in the list.
  await caretAt(main.indexOf('done'))
  expect((await key('F9')).some(k => k.key === 'F9' && k.prevented), 'F9 is taken by Xed in an msh file')
  await page.waitFor(`document.querySelector('.window[data-test="a"] .zed-gutter').children[7].classList.contains('has-bp')`)
  await tab('Breakpoints')
  const list = await A<string>(`return W.querySelector('.xed-bps').textContent`)
  expect(list.includes('xed-main.msh:4') && list.includes('xed-main.msh:8') && list.includes('no command on this line') && (await gutterRow(8)).includes('is-dead'), 'Breakpoints list shows both; a line without a command is flagged in list and gutter', list)
  await A(`W.querySelector('[aria-label="Remove breakpoint xed-main.msh line 8"]').click()`)
  await A(`W.querySelector('[aria-label="Enable breakpoint xed-main.msh line 4"]').click()`)
  await page.waitFor(`window.xedDebug.editorBreakpoints().length === 1 && !window.xedDebug.editorBreakpoints()[0].enabled`)
  expect((await gutterRow(4)).includes('is-off'), 'list checkbox disables; the gutter dot turns hollow')
  await A(`W.querySelector('[aria-label="Enable breakpoint xed-main.msh line 4"]').click()`)
  await page.waitFor(`window.xedDebug.editorBreakpoints()[0].enabled`)
  pass('list remove and enable work through real checkbox/button clicks')

  // --- F5 with focus outside the textarea runs the saved script to the breakpoint -------------------
  await caretAt(4, 12) // a selection in this file must survive pausing in it, and stepping into another file and out
  await A(`W.querySelector('.zed').focus()`)
  expect(await page.eval(`document.activeElement === document.querySelector('.window[data-test="a"] .zed')`), 'focus is on the Xed window, not in the editor')
  const f5 = await key('F5')
  expect(f5.length === 1 && f5[0].prevented, 'F5 in a focused Xed window is prevented (no page reload)', f5)
  await waitState('Paused (breakpoint) · xed-main.msh:4')
  const paused = await A(`return { gutter: W.querySelector('.zed-gutter').children[3].className, hl: W.querySelector('.zed-pause-hl')?.style.top, sel: [W.querySelector('textarea.zed-input').selectionStart, W.querySelector('textarea.zed-input').selectionEnd], out: W.querySelector('.xed-dbg-output')?.textContent ?? '' }`)
  expect(paused.gutter.includes('is-paused') && paused.gutter.includes('has-bp') && paused.hl === `${PAD + 3 * LINE}px` && paused.out === '', 'paused line has its arrow and background, separate from the breakpoint dot; nothing printed yet', paused)
  expect(JSON.stringify(paused.sel) === '[4,12]', 'pausing in the open file keeps its selection', paused.sel)
  const runLabel = await A<string>(`return W.querySelector('.xed-dbg-btn.is-run').getAttribute('aria-label')`)
  expect(runLabel === 'Continue', 'Run button reads Continue while paused')

  // --- step into a function in another file: its tab opens and shows the pause ----------------------
  expect((await key('F11'))[0].prevented, 'F11 is taken by Xed while debugging')
  await waitState('Paused (step) · xed-lib.msh:2')
  expect((await activeFile()) === 'xed-lib.msh' && (await gutterRow(2)).includes('is-paused'), 'step into reveals the function in its own file', await activeFile())
  await tab('Call stack')
  const stack = await A<string[]>(`return [...W.querySelectorAll('.xed-stack li')].map(l => l.textContent)`)
  expect(stack.length === 3 && stack[0].startsWith('greet()') && stack[0].includes('xed-lib.msh:2') && stack[1].includes('xed-main.msh:4'), 'call stack: greet() in the lib, called from main line 4', stack)
  // Watches: added through the real form; a side-effect expression is refused.
  await tab('Watch')
  const addWatch = async (expr: string) => {
    await A(`const i = W.querySelector('[aria-label="Add watch expression"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(expr)}); i.dispatchEvent(new Event('input', { bubbles: true }))`)
    await A(`W.querySelector('.xed-watch-add button[type="submit"]').click()`)
    await sleep(80)
  }
  await addWatch('msg')
  await addWatch('$who has ${#who} letters')
  await addWatch('$(touch /tmp/xed-watch-ran)')
  const watchText = () => A<string[]>(`return [...W.querySelectorAll('.xed-watches li')].map(l => l.textContent)`)
  let watched = await watchText()
  expect(watched.length === 2 && watched[0].includes('msg is not set at this pause') && watched[1].includes(' = has 0 letters') === false, 'watches added; unset variable shown as such', watched)
  expect(!(await page.eval(`!!window.xedFs.lookup?.('/tmp/xed-watch-ran')`)) && (await A<string>(`return document.querySelector('.zed-status-msg').textContent`)).includes('Not watched'), 'a $(…) watch is refused and nothing runs')
  await key('F10')
  await waitState('Paused (step) · xed-lib.msh:3')
  watched = await watchText()
  expect(watched[1].includes('$who has ${#who} letters = world has 5 letters'), 'watch reads $who and ${#who} from the new pause', watched)
  await key('F10')
  await waitState('Paused (step) · xed-lib.msh:4')
  watched = await watchText()
  expect(watched[0].includes('msg = hello world'), 'step over updates watches', watched)
  // Hover over $msg on line 4 with a real pointer move.
  const hoverAt = await A<{ x: number; y: number }>(`
    const t = W.querySelector('textarea.zed-input'), r = t.getBoundingClientRect()
    const c = document.createElement('canvas').getContext('2d'); const s = getComputedStyle(t); c.font = s.fontSize + ' ' + s.fontFamily
    const w = c.measureText('0'.repeat(100)).width / 100
    return { x: r.x + (8 + 2) * w, y: r.y + ${PAD} + 3 * ${LINE} + ${LINE / 2} }`)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverAt.x, y: hoverAt.y })
  await page.waitFor(`document.querySelector('.window[data-test="a"] .xed-hover')?.textContent.startsWith('msg = hello world')`, 5000)
  pass('hovering $msg shows its value at this pause')
  // Keyboard/touch alternative: the caret on a variable shows it in the panel.
  await caretAt(lib.indexOf('$who') + 2)
  await page.waitFor(`document.querySelector('.window[data-test="a"] .xed-dbg-caret')?.textContent.includes('who = world')`, 5000)
  pass('caret on a variable inspects it in the panel (no pointer needed)')
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverAt.x, y: hoverAt.y })
  await page.waitFor(`!!document.querySelector('.window[data-test="a"] .xed-hover')`, 5000)
  // Step out: back in main after the rest of greet ran; the hover from the old pause is gone.
  expect((await key('F11', MODS.shift))[0].prevented, 'Shift+F11 is taken by Xed')
  await waitState('Paused (step) · xed-main.msh:5')
  expect((await activeFile()) === 'xed-main.msh' && !(await A(`return !!W.querySelector('.xed-hover')`)), 'step out returns to the caller in main; stale hover cleared', await activeFile())
  // Review 3: the caller's selection (set before the run) is back, and the editor kept the keyboard
  // focus it had in the function's file.
  await page.waitFor(`(() => { const t = document.querySelector('.window[data-test="a"] textarea.zed-input'); return t && t.selectionStart === 4 && t.selectionEnd === 12 && document.activeElement === t })()`, 5000)
  pass('stepping into another file and out restores the caller selection 4–12 and the editor focus')
  await tab('Output')
  expect((await A<string>(`return W.querySelector('.xed-dbg-output').textContent`)) === 'hello world\n', 'greet really ran during step out')
  await key('F10'); await waitState('Paused (step) · xed-main.msh:6')
  await key('F10'); await waitState('Paused (step) · xed-main.msh:7')
  await key('F10'); await waitState('Paused (step) · xed-main.msh:7')
  await tab('Variables')
  const vars = await A<string>(`return W.querySelector('.xed-vars').textContent`)
  expect(vars.includes('iglobal1 → 2') && vars.includes('countglobal0 → 1'), 'step over a loop body stops on it again for the next iteration with new values', vars)
  // F9 at line 9 while paused, then continue to it.
  await caretAt(main.indexOf('echo "count'))
  await key('F9')
  await page.waitFor(`window.xedDebug.editorBreakpoints().some(b => b.line === 9)`)
  await key('F5'); await waitState('Paused (breakpoint) · xed-main.msh:9')
  await key('F5'); await waitState('Completed · exit 0')
  await tab('Output')
  const done = await A(`return { out: W.querySelector('.xed-dbg-output').textContent, hl: !!W.querySelector('.zed-pause-hl'), arrow: !!W.querySelector('.zed-gutter .is-paused') }`)
  expect(done.out === 'hello world\ncount=6\n' && !done.hl && !done.arrow, 'continue completes with the right output and no live pause marker', done)
  await tab('Watch')
  watched = await watchText()
  expect(watched.every(w => w.includes('not paused')), 'watches drop their values once the session ends', watched)
  await tab('Variables')
  expect((await A<string>(`return W.querySelector('.xed-dbg-body').textContent`)).includes('has ended'), 'variables are cleared, not shown as live, after the end')

  // --- editing while paused: stale-source warning; unsaved text is saved before the next run --------
  await key('F5'); await waitState('Paused (breakpoint) · xed-main.msh:4')
  await edit('# added\n' + main)
  await page.waitFor(`!!document.querySelector('.window[data-test="a"] .xed-dbg-warn') && !!document.querySelector('.window[data-test="a"] .zed-pause-hl.is-stale')`)
  expect(JSON.stringify(await points()) === '["/tmp/xed-main.msh:5","/tmp/xed-main.msh:10"]', 'breakpoints move with an inserted line', await points())
  pass('editing the running file warns that the editor differs from the running source')
  const stopKey = await key('F5', MODS.shift)
  expect(stopKey[0].prevented, 'Shift+F5 is taken by Xed')
  await waitState('Stopped')
  expect(await A(`return W.querySelector('.xed-dbg-btn.is-run').textContent === 'Save & Run'`), 'the Run button says it saves an unsaved file first')
  await key('F5'); await waitState('Paused (breakpoint) · xed-main.msh:5')
  const saved = await page.eval<string>(`window.xedFs.lookup('/tmp/xed-main.msh').content()`)
  expect(saved.startsWith('# added\n') && !(await A(`return !!W.querySelector('.xed-dbg-warn')`)), 'F5 saved the file before running it: the run uses the new text, no warning', saved.slice(0, 20))
  await button('Stop'); await waitState('Stopped')

  // --- pause a running loop (F6) and stop it ---------------------------------------------------------
  await page.eval(`window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'zed', props: { path: '/tmp/xed-loop.msh', root: '/tmp', t: '1' } } }))`)
  await page.waitFor(`document.querySelector('.window[data-test="a"] .zed-tab.is-active')?.textContent.includes('xed-loop.msh')`)
  await A(`W.querySelector('.zed').focus()`)
  await key('F5'); await waitState('Running')
  await sleep(150)
  expect((await key('F6'))[0].prevented, 'F6 is taken by Xed')
  await waitState('Paused (paused) · xed-loop.msh:1')
  await key('F5', MODS.shift); await waitState('Stopped')
  pass('F6 pauses a running loop where it is; Shift+F5 stops it')

  // --- two Xed windows: keys go to the focused one only ----------------------------------------------
  await A(`W.querySelector('.zed-tab[title*="xed-main.msh"]').click()`)
  await A(`W.querySelector('.titlebar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 120 }))`)
  await page.clickText('.ctx-item', 'New window')
  await page.waitFor(`document.querySelectorAll('.zed').length === 2`)
  await page.eval(`[...document.querySelectorAll('.zed')].map(z => z.closest('.window')).find(w => !w.dataset.test).dataset.test = 'b'`)
  await page.eval(`window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'zed', props: { path: '/tmp/xed-other.msh', root: '/tmp', t: '2' } } }))`)
  await page.waitFor(`document.querySelector('.window[data-test="b"] .zed-tab.is-active')?.textContent.includes('xed-other.msh')`)
  await focusWin('b')
  await key('F5'); await waitState('Completed · exit 0', 'b')
  await inWin('b', `const b = W.querySelector('[aria-label="Toggle debug panel"]'); if (b.getAttribute('aria-pressed') !== 'true') b.click()`)
  await tab('Output', 'b')
  const bOut = await inWin<string>('b', `return W.querySelector('.xed-dbg-output')?.textContent`)
  expect(bOut === 'other\n' && (await state('a')) === 'Stopped', 'F5 in the focused second window runs its file; the first window is untouched', { bOut, a: await state('a') })
  await focusWin('a')
  expect(!(await page.eval(`document.querySelector('.window[data-test="b"]').classList.contains('is-focused')`)), 'a real click on the first window focuses it')
  await key('F5'); await waitState('Paused (breakpoint) · xed-main.msh:5')
  expect((await state('b')).startsWith('Completed'), 'back in the first window, F5 runs there and the second keeps its own state')
  await key('F5', MODS.shift); await waitState('Stopped')
  await inWin('b', `W.querySelector('[aria-label="Close"]').click()`)
  await page.waitFor(`document.querySelectorAll('.zed').length === 1`)

  // --- review 2: nano in Xed's own terminal panel does not swallow the debugger's F5 --------------------
  await A(`W.querySelector('.zed').focus()`)
  await key('F5'); await waitState('Paused (breakpoint) · xed-main.msh:5')
  await A(`W.querySelector('[aria-label="Toggle terminal panel"]').click()`)
  await page.waitFor(`!!document.querySelector('.window[data-test="a"] .zed-dock .t-input input, .window[data-test="a"] .zed-dock .t-input textarea')`)
  const termInput = `W.querySelector('.zed-dock .t-input input, .zed-dock .t-input textarea')`
  await A(`${termInput}.focus()`)
  await page.send('Input.insertText', { text: 'nano /tmp/xed-nano.txt' })
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) })
  await page.waitFor(`document.querySelector('.window[data-test="a"] .zed-dock')?.textContent.includes('Exit')`, 10000)
  const terminalFocused = await A(`return W.querySelector('.zed-dock').contains(document.activeElement)`)
  const inNano = await key('F5')
  await waitState('Paused (breakpoint) · xed-main.msh:10')
  const dock = await A<string>(`return W.querySelector('.zed-dock').textContent`)
  expect(terminalFocused && !!inNano.find(k => k.key === 'F5')?.prevented && !/file to insert/i.test(dock), 'with nano focused in the terminal panel, F5 continues the paused script instead of reaching nano', { terminalFocused, inNano, nano: /file to insert/i.test(dock) })
  // Other keys still reach nano: typing goes into its buffer, Ctrl+X asks to save.
  await page.send('Input.insertText', { text: 'q' })
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, modifiers: MODS.ctrl })
  await page.waitFor(`/save modified buffer/i.test(document.querySelector('.window[data-test="a"] .zed-dock').textContent)`, 5000)
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, ...(type === 'keyDown' ? { text: 'n' } : {}) })
  await page.waitFor(`!document.querySelector('.window[data-test="a"] .zed-dock').textContent.includes('Save modified')`, 5000)
  pass('non-debugger keys still go to nano in the terminal panel')
  await key('F5', MODS.shift); await waitState('Stopped')
  await A(`W.querySelector('[aria-label="Hide the terminal panel"]').click()`)

  // --- attach to a session started outside Xed ------------------------------------------------------
  const externalLaunch = () => page.eval(`(async () => {
    const fs = await import('/src/terminal/fs.ts')
    const { launchDebug } = await import('/src/terminal/msh/interp.ts')
    await fs.writeFile('/tmp', '/tmp/xed-external.msh', 'value=external\\necho "$value"\\nvalue=finished\\necho "$value"', false)
    window.xedExternalOutput = []; window.xedExternalFinished = false
    window.xedExternal = launchDebug('msh /tmp/xed-external.msh', {
      cwd: '/tmp', setCwd() {}, env: { HOME: '/home/menno', PWD: '/tmp' }, history: [], windows: [],
      openApp() {}, openNewApp() {}, closeWindow() {}, clear() {}, exit() {}, setAccent() { return true },
      print(s) { window.xedExternalOutput.push(s) }, live() {}, size: { cols: 80, rows: 24 }, onKey() {}, signal: new AbortController().signal,
    }, 'external executing script')
    window.xedExternal.done.then(results => { window.xedExternalFinished = true; window.xedExternalResults = results })
  })()`)
  const attach = (id: string) => A(`const e = W.querySelector('[aria-label="Debug session"]'); e.value = ${id}; e.dispatchEvent(new Event('change', { bubbles: true }))`)
  await externalLaunch()
  await page.waitFor(`window.xedExternal.session.current.state === 'paused'`)
  expect(!(await page.eval(`window.xedExternal.session.usesEditorBreakpoints`)), 'an external session ignores editor breakpoints until attached')
  await attach('window.xedExternal.session.id')
  await waitState('Paused (entry) · launch line')
  expect(await page.eval(`window.xedExternal.session.usesEditorBreakpoints`), 'attaching opts the session in to the editor breakpoints')
  await button('Step into'); await waitState('Paused (step) · xed-external.msh:1')
  expect((await activeFile()) === 'xed-external.msh', 'attached pause reveals its file')
  await button('Step over'); await waitState('Paused (step) · xed-external.msh:2')
  await tab('Variables')
  expect((await A<string>(`return W.querySelector('.xed-vars').textContent`)).includes('valueglobalexternal') && !(await page.eval(`window.xedExternalFinished || window.xedExternalOutput.length !== 0`)), 'attached session steps; its output stays with its owner')
  await button('Continue')
  await page.waitFor(`window.xedExternalFinished`)
  await waitState('Completed')
  const external = await page.eval(`({ output: window.xedExternalOutput.join('\\n'), state: window.xedExternal.session.current.state, ok: window.xedExternalResults[0].ok })`)
  expect(external.output === 'external\nfinished' && external.state === 'completed' && external.ok, 'attached external script completes with its own output', external)
  // Review 4: a hover shown for one session never shows its value after switching to another.
  await page.eval(`(async () => {
    const fs = await import('/src/terminal/fs.ts')
    const { launchDebug } = await import('/src/terminal/msh/interp.ts')
    await fs.writeFile('/tmp', '/tmp/xed-hover.msh', 'x=$1\\necho "$x"', false)
    const base = () => ({ cwd: '/tmp', setCwd() {}, env: { HOME: '/home/menno', PWD: '/tmp' }, history: [], windows: [], openApp() {}, openNewApp() {}, closeWindow() {}, clear() {}, exit() {}, setAccent() { return true }, print() {}, live() {}, size: { cols: 80, rows: 24 }, onKey() {}, signal: new AbortController().signal })
    // Separate environments: one terminal's environment refuses to run a script that is already running in it.
    window.xedHover = ['one', 'two'].map(v => { const r = launchDebug('msh /tmp/xed-hover.msh ' + v, base(), 'hover ' + v, { start: 'run' }); r.session.breakpoint('/tmp/xed-hover.msh', 2); return r })
  })()`)
  await page.waitFor(`window.xedHover.every(r => r.session.current.state === 'paused')`)
  await attach('window.xedHover[0].session.id')
  await waitState('Paused (breakpoint) · xed-hover.msh:2')
  await page.waitFor(`document.querySelector('.window[data-test="a"] .zed-tab.is-active')?.textContent.includes('xed-hover.msh')`)
  const xAt = await A<{ x: number; y: number }>(`
    const t = W.querySelector('textarea.zed-input'), r = t.getBoundingClientRect()
    const c = document.createElement('canvas').getContext('2d'); const s = getComputedStyle(t); c.font = s.fontSize + ' ' + s.fontFamily
    const w = c.measureText('0'.repeat(100)).width / 100
    return { x: r.x + 7.5 * w, y: r.y + ${PAD} + ${LINE} + ${LINE / 2} }`)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xAt.x, y: xAt.y })
  await page.waitFor(`document.querySelector('.window[data-test="a"] .xed-hover')?.textContent.startsWith('x = one')`, 5000)
  await attach('window.xedHover[1].session.id')
  await sleep(300)
  const afterSwitch = await A<string | null>(`return W.querySelector('.xed-hover')?.textContent ?? null`)
  expect(afterSwitch === null || !afterSwitch.includes('one'), 'switching the session picker without moving the pointer drops the old session\'s hover value', afterSwitch)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xAt.x + 1, y: xAt.y })
  await page.waitFor(`document.querySelector('.window[data-test="a"] .xed-hover')?.textContent.startsWith('x = two')`, 5000)
  pass('moving the pointer again shows the newly selected session\'s value')
  await page.eval(`window.xedHover.forEach(r => r.session.cancel())`)
  await attach("''")

  // Closing Xed cancels its own paused run and leaves an attached one paused.
  await externalLaunch()
  await page.waitFor(`window.xedExternal.session.current.state === 'paused'`)
  await A(`W.querySelector('.zed-tab[title*="xed-main.msh"]').click()`)
  await A(`W.querySelector('.zed').focus()`)
  await key('F5'); await waitState('Paused (breakpoint) · xed-main.msh:5')
  const ownId = await page.eval(`window.xedDebug.debugSessions().find(s => s.current.state === 'paused' && s.current.label === '/tmp/xed-main.msh').id`)
  await A(`W.querySelector('[aria-label="Close"]').click()`)
  await page.waitFor(`!document.querySelector('.zed')`)
  const lifetime = await page.eval(`[window.xedDebug.debugSessions().find(s => s.id === ${JSON.stringify(ownId)}).current.state, window.xedExternal.session.current.state]`)
  expect(JSON.stringify(lifetime) === '["cancelled","paused"]', 'closing Xed cancels its own pause and leaves the external session paused', lifetime)
  await page.eval('window.xedExternal.session.continue()')
  await page.waitFor('window.xedExternalFinished')
  pass('external session completes after Xed closed')

  // --- review 1: a run waiting for its save -------------------------------------------------------------
  // F5 on an unsaved file awaits the save before launching. Everything below happens in one task, so
  // the next step lands while that await is pending (with /tmp the save itself is quick; Seafile and
  // browser-kept files take longer, which only widens the same gap).
  const slow = '/tmp/xed-slow.msh'
  await page.eval(`window.xedFs.writeFile('/tmp', ${JSON.stringify(slow)}, 'while true; do n=1; sleep 0.2; done', false)`)
  const runsOf = () => page.eval<number>(`window.xedDebug.debugSessions().filter(s => s.current.label === ${JSON.stringify(slow)}).length`)
  const openSlow = async (tag: string, t: string) => {
    await page.eval(`window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'zed', props: { path: ${JSON.stringify(slow)}, root: '/tmp', t: '${t}' } } }))`)
    await page.waitFor(`!!document.querySelector('.zed .xed-dbg-bar')`)
    await page.eval(`document.querySelector('.zed').closest('.window').dataset.test = '${tag}'`)
    await page.waitFor(`document.querySelector('.window[data-test="${tag}"]').classList.contains('is-focused')`)
  }
  const f5Now = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true, cancelable: true }))`
  const statusOf = (tag: string) => inWin<string>(tag, `return W.querySelector('.zed-status-msg').textContent`)
  await openSlow('u', '10')
  const before = await runsOf()
  await edit('while true; do n=2; sleep 0.2; done', 'u')
  // F5 starts the save-and-run; the window closes (React unmounts it right after the click) before
  // the awaited save comes back.
  await inWin('u', `${f5Now}; W.querySelector('[aria-label="Close"]').click()`)
  await page.waitFor(`!document.querySelector('.zed')`)
  await sleep(800)
  const leaked = await page.eval<string[]>(`window.xedDebug.debugSessions().filter(s => s.current.label === ${JSON.stringify(slow)} && !s.done).map(s => s.id + ':' + s.current.state)`)
  expect((await runsOf()) === before && !leaked.length, 'a window closed while F5 waits for its save starts no run afterwards (nothing left running unowned)', { before, after: await runsOf(), leaked })
  await page.eval(`window.xedDebug.debugSessions().filter(s => s.current.label === ${JSON.stringify(slow)}).forEach(s => s.cancel())`)
  expect((await page.eval<string>(`window.xedFs.lookup(${JSON.stringify(slow)}).content()`)).includes('n=2'), 'the save itself still completed')
  await openSlow('v', '11')
  const base2 = await runsOf()
  await edit('while true; do n=3; sleep 0.2; done', 'v')
  await inWin('v', `${f5Now}; window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', shiftKey: true, bubbles: true, cancelable: true }))`)
  await sleep(600)
  expect((await runsOf()) === base2 && (await statusOf('v')).includes('cancelled'), 'Shift+F5 while the save is pending cancels the run', await statusOf('v'))
  await edit('while true; do n=4; sleep 0.2; done', 'v')
  await inWin('v', `${f5Now}
    const e = W.querySelector('textarea.zed-input')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, 'while true; do n=5; sleep 0.2; done')
    e.dispatchEvent(new Event('input', { bubbles: true }))`)
  await sleep(600)
  expect((await runsOf()) === base2 && (await statusOf('v')).includes('changed while it was being saved'), 'text typed while the save is pending is not run from the older saved copy', await statusOf('v'))
  await inWin('v', `${f5Now}; ${f5Now}`)
  await waitState('Running', 'v')
  await sleep(300)
  expect((await runsOf()) === base2 + 1, 'two F5 presses in the same event start exactly one run', { base2, after: await runsOf() })
  await page.eval(`document.querySelector('.window[data-test="v"] textarea.zed-input').focus()`)
  await key('F5', MODS.shift); await waitState('Stopped', 'v')
  await inWin('v', `${f5Now}; ${f5Now}`)
  await waitState('Running', 'v')
  await sleep(300)
  expect((await runsOf()) === base2 + 2, 'also with nothing to save (no await at all), two F5 presses start one run', { base2, after: await runsOf() })
  await key('F5', MODS.shift); await waitState('Stopped', 'v')
  await inWin('v', `W.querySelector('[aria-label="Close"]').click()`)
  await page.waitFor(`!document.querySelector('.zed')`)

  // --- multi-digit positional parameters: real Variables, Watch, caret and pointer paths ------------
  const args = ['first', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'tenth', ...Array.from({ length: 55 }, (_, i) => `extra${i + 11}`)]
  const positional = 'f() {\n  : "$10 ${10}"\n}\nf ' + args.join(' ')
  const positionalPath = '/tmp/xed-args.msh'
  await page.eval(`(async () => {
    await window.xedFs.writeFile('/tmp', ${JSON.stringify(positionalPath)}, ${JSON.stringify(positional)}, false)
    window.xedDebug.toggleBreakpoint(${JSON.stringify(positionalPath)}, 2)
    window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'zed', props: { path: ${JSON.stringify(positionalPath)}, root: '/tmp', t: '12' } } }))
  })()`)
  await page.waitFor(`document.querySelector('.zed-tab.is-active')?.textContent.includes('xed-args.msh')`)
  await page.eval(`document.querySelector('.zed').closest('.window').dataset.test = 'a'`)
  await focusWin('a')
  await A(`W.querySelector('.zed').focus()`)
  await key('F5'); await waitState('Paused (breakpoint) · xed-args.msh:2')
  await tab('Variables')
  const argRows = await A<{ name: string; value: string }[]>(`return [...W.querySelectorAll('.xed-vars tr')].filter(r => r.querySelector('.xed-var-tag')?.textContent === 'argument').map(r => ({ name: r.querySelector('.xed-var-name').textContent, value: r.querySelector('.xed-var-value').textContent }))`)
  expect(argRows.length === 64 && argRows[9].name === '${10}' && argRows[9].value === 'tenth' && argRows[63].name === '${64}' && argRows[63].value === 'extra64', 'Variables labels argument 10 as ${10}, shows tenth and keeps exactly 64 arguments', argRows)
  const omitted = await A<string>(`return W.querySelector('.xed-dbg-omitted')?.textContent`)
  expect(omitted.includes('65 arguments; the first 64 are kept.'), 'Variables reports the real count and snapshot limit', omitted)
  await A(`W.querySelector('[aria-label="Watch \${10}"]').click()`)
  await tab('Watch')
  watched = await watchText()
  expect(watched.length === 1 && watched[0].startsWith('${10} = tenth'), 'argument 10 row Watch adds ${10}, reading tenth rather than first0', watched)
  await addWatch('${65}')
  await addWatch('$10')
  await addWatch('$#')
  watched = await watchText()
  expect(watched[1].startsWith('${65}') && watched[1].includes('not captured (only the first 64 arguments are kept)') && !watched[1].includes('not set'), 'watching argument 65 reports uncaptured, not unset', watched)
  expect(watched[2].startsWith('$10 = first0') && watched[3].startsWith('$# = 65'), 'watch expansion preserves unbraced $10 and the real argument count', watched)
  const unbraced = positional.indexOf('$10'), braced = positional.indexOf('${10}')
  for (const [offset, expected] of [[unbraced, '$1 = first'], [unbraced + 1, '$1 = first'], [braced, '${10} = tenth']] as const) {
    await caretAt(offset)
    await page.waitFor(`document.querySelector('.window[data-test="a"] .xed-dbg-caret')?.textContent.includes(${JSON.stringify(expected)})`, 5000)
    pass(`caret at offset ${offset} inspects ${expected}`)
  }
  await caretAt(unbraced + 2)
  await page.waitFor(`!document.querySelector('.window[data-test="a"] .xed-dbg-caret')`, 5000)
  pass('caret on the literal 0 suffix of $10 has no variable')
  // Measure the current textarea font, then move the real pointer to each character on line 2.
  const hoverArg = async (offset: number, expected: string | null) => {
    const point = await A<{ x: number; y: number }>(`
      const t = W.querySelector('textarea.zed-input'), r = t.getBoundingClientRect()
      const c = document.createElement('canvas').getContext('2d'), s = getComputedStyle(t); c.font = s.fontSize + ' ' + s.fontFamily
      const w = c.measureText('0'.repeat(100)).width / 100
      return { x: r.x + (${offset - positional.indexOf('\n') - 1} + 0.3) * w, y: r.y + ${PAD} + ${LINE} + ${LINE / 2} }`)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await page.waitFor(expected === null ? `!document.querySelector('.window[data-test="a"] .xed-hover')` : `document.querySelector('.window[data-test="a"] .xed-hover')?.textContent.startsWith(${JSON.stringify(expected)})`, 5000)
  }
  await hoverArg(unbraced, '$1 = first')
  await hoverArg(unbraced + 1, '$1 = first')
  await hoverArg(unbraced + 2, null)
  await hoverArg(braced, '${10} = tenth')
  pass('pointer hover reads $1 in $10, ignores its literal 0 and reads ${10} as tenth')
  await key('F5', MODS.shift); await waitState('Stopped')
  await A(`W.querySelector('[aria-label="Close"]').click()`)
  await page.waitFor(`!document.querySelector('.zed')`)

  // --- named parameters and real recursive caller inspection ---------------------------------------
  const frameCode = 'value=global\nf(value) {\n  local attempt=1 blank=\n  if [ "$value" = outer ]; then f inner; fi\n  value=changed\n  unset attempt\n  echo "$value"\n}\nf outer\necho "$value"'
  await page.eval(`(async () => {
    await window.xedFs.writeFile('/tmp', '/tmp/xed-frames.msh', ${JSON.stringify(frameCode)}, false)
    window.xedDebug.toggleBreakpoint('/tmp/xed-frames.msh', 5)
    window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'zed', props: { path: '/tmp/xed-frames.msh', root: '/tmp' } } }))
  })()`)
  await page.waitFor(`document.querySelector('.zed-tab.is-active')?.textContent.includes('xed-frames.msh')`)
  await page.eval(`document.querySelector('.zed').closest('.window').dataset.test = 'a'`)
  await focusWin('a'); await A(`W.querySelector('.zed').focus()`)
  await key('F5'); await waitState('Paused (breakpoint) · xed-frames.msh:5')
  await tab('Variables')
  const frameVars = () => A<string>(`return W.querySelector('.xed-vars').textContent`)
  let fv = await frameVars()
  expect(fv.includes('Parameters') && fv.includes('valueparameterinner') && fv.includes('Locals') && fv.includes('blanklocal(empty)'), 'named parameter group, ordinary locals and empty strings are distinct', fv)
  await tab('Watch'); await addWatch('value')
  expect((await watchText())[0].includes('value = inner'), 'watch starts in executing frame')
  await tab('Call stack')
  await A(`W.querySelectorAll('.xed-stack button')[1].click()`)
  await tab('Variables'); fv = await frameVars()
  expect(fv.includes('valueparameterouter') && !fv.includes('valueparameterinner'), 'select recursive caller shows caller bindings, not relabelled inner values', fv)
  await tab('Watch')
  expect((await watchText())[0].includes('value = outer'), 'selected-frame watch matches caller bindings')
  await tab('Call stack'); await A(`W.querySelectorAll('.xed-stack button')[0].click()`)
  await key('F10'); await waitState('Paused (step) · xed-frames.msh:6')
  await tab('Variables'); fv = await frameVars()
  expect(fv.includes('inner → changed'), 'same-frame previous value is visible after stepping', fv)
  await key('F10'); await waitState('Paused (step) · xed-frames.msh:7')
  fv = await frameVars()
  expect(fv.includes('1 → (unset)') && fv.includes('blanklocal(empty)'), 'unset is distinct from empty and retains bounded previous value', fv)
  await key('F11', MODS.shift); await waitState('Paused (breakpoint) · xed-frames.msh:5')
  fv = await frameVars()
  expect(fv.includes('valueparameterouter') && !fv.includes('inner → outer'), 'step out restores caller without comparing recursive bindings', fv)
  await key('F5', MODS.shift); await waitState('Stopped')
  expect(!(await A(`return !!W.querySelector('.xed-vars')`)), 'stop clears frame inspection')
  await A(`W.querySelector('[aria-label="Close"]').click()`)
  await page.waitFor(`!document.querySelector('.zed')`)

  // --- a named function's subshell keeps its frame but owns the executing bindings -----------------
  const forkCode = 'x=outer\nf(parcel) (\n  x=inner\n  set -- child\n  echo "$parcel:$x:$1"\n)\nf "Space Potato"\necho "$x"'
  await page.eval(`(async () => {
    await window.xedFs.writeFile('/tmp', '/tmp/xed-fork.msh', ${JSON.stringify(forkCode)}, false)
    window.xedDebug.toggleBreakpoint('/tmp/xed-fork.msh', 5)
    window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'zed', props: { path: '/tmp/xed-fork.msh', root: '/tmp' } } }))
  })()`)
  await page.waitFor(`document.querySelector('.zed-tab.is-active')?.textContent.includes('xed-fork.msh')`)
  await page.eval(`document.querySelector('.zed').closest('.window').dataset.test = 'a'`)
  await focusWin('a'); await A(`W.querySelector('.zed').focus()`)
  await key('F5'); await waitState('Paused (breakpoint) · xed-fork.msh:5')
  await tab('Variables'); fv = await frameVars()
  expect(fv.includes('parcelparameterSpace Potato') && fv.includes('xglobalinner') && fv.includes('child'), 'named subshell Variables shows actual executing parameter, global and positional values', fv)
  await tab('Watch'); await addWatch('$parcel:$x:$1')
  expect((await watchText())[0].includes('Space Potato:inner:child'), 'subshell Watch agrees with executing shell')
  await tab('Call stack'); await A(`W.querySelectorAll('.xed-stack button')[1].click()`)
  await tab('Variables'); fv = await frameVars()
  expect(fv.includes('xglobalouter') && !fv.includes('xglobalinner'), 'selecting subshell function caller keeps true parent environment', fv)
  await tab('Call stack'); await A(`W.querySelectorAll('.xed-stack button')[0].click()`)
  await button('Step out'); await waitState('Paused (step) · xed-fork.msh:8')
  await tab('Variables'); fv = await frameVars()
  expect(fv.includes('xglobalouter') && !fv.includes('inner →') && !fv.includes('parcelparameter'), 'step out restores caller without comparing copied subshell values', fv)
  await button('Stop'); await waitState('Stopped')
  await A(`W.querySelector('[aria-label="Close"]').click()`)
  await page.waitFor(`!document.querySelector('.zed')`)

  // --- capture truncation is not an empty variable, even for a short original value -----------------
  await page.eval(`(async () => {
    await window.xedFs.writeFile('/tmp', '/tmp/xed-short-cut.msh', 'echo "$x"\\nunset p0\\necho "$x"\\nx=changed\\necho "$x"', false)
    window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'zed', props: { path: '/tmp/xed-short-cut.msh', root: '/tmp' } } }))
    const { launchDebug } = await import('/src/terminal/msh/interp.ts')
    const env = { empty: '' }
    for (let i = 0; i < 15; i++) env['p' + i] = 'a'.repeat(4096)
    const used = Object.entries(env).reduce((n, [name, value]) => n + name.length + value.length, 0)
    env.pad = 'a'.repeat(65535 - used - 'pad'.length)
    env.x = 'secret'; env.omitted = 'not captured'
    window.xedShortCut = launchDebug('msh /tmp/xed-short-cut.msh', {
      cwd: '/tmp', setCwd() {}, env, history: [], windows: [], openApp() {}, openNewApp() {}, closeWindow() {}, clear() {}, exit() {}, setAccent() {}, print() {}, live() {}, size: { cols: 80, rows: 24 }, onKey() {}, signal: new AbortController().signal,
    }, 'short capture', { start: { entry: '/tmp/xed-short-cut.msh' } })
  })()`)
  await page.waitFor(`document.querySelector('.zed-tab.is-active')?.textContent.includes('xed-short-cut.msh') && window.xedShortCut.session.current.state === 'paused'`)
  await page.eval(`document.querySelector('.zed').closest('.window').dataset.test = 'a'`)
  await focusWin('a')
  await A(`const b = W.querySelector('[aria-label="Toggle debug panel"]'); if (b.getAttribute('aria-pressed') !== 'true') b.click()`)
  await attach('window.xedShortCut.session.id')
  await tab('Variables')
  const shortCapture = await page.eval(`({ value: window.xedShortCut.session.current.variables.x, length: window.xedShortCut.session.current.cut.variables.x })`)
  expect(shortCapture.value === '' && shortCapture.length === 6, 'review P2: shared capture bound keeps zero of a six-character variable', shortCapture)
  const shortRow = await A<string>(`return [...W.querySelectorAll('.xed-vars tr')].find(r => r.querySelector('.xed-var-name')?.textContent === 'x').textContent`)
  expect(shortRow.includes('truncated') && shortRow.includes('6 characters') && shortRow.includes('0 kept') && !shortRow.includes('(empty)'), 'review P2: zero-kept short value is visibly truncated, never empty', shortRow)
  const emptyRow = await A<string>(`return [...W.querySelectorAll('.xed-vars tr')].find(r => r.querySelector('.xed-var-name')?.textContent === 'empty').textContent`)
  expect(emptyRow.includes('(empty)') && !emptyRow.includes('truncated'), 'review P2: a genuine empty string remains distinct', emptyRow)
  await tab('Watch'); await addWatch('x'); await addWatch('omitted')
  const cutWatches = await watchText()
  expect(cutWatches[0].includes('truncated') && !cutWatches[0].includes('(empty)') && cutWatches[1].includes('not captured') && !cutWatches[1].includes('not set'), 'review P2: Watch distinguishes truncation and uncaptured binding', cutWatches)
  await caretAt(7)
  const cutCaret = await A<string>(`return W.querySelector('.xed-dbg-caret').textContent`)
  expect(cutCaret.includes('truncated') && cutCaret.includes('0 characters kept') && !cutCaret.includes('(empty)'), 'runtime caret inspection distinguishes zero capture from empty', cutCaret)
  await button('Step over'); await waitState('Paused (step) · xed-short-cut.msh:2')
  await button('Step over'); await waitState('Paused (step) · xed-short-cut.msh:3')
  await tab('Variables')
  let completeRow = await A<string>(`return [...W.querySelectorAll('.xed-vars tr')].find(r => r.querySelector('.xed-var-name')?.textContent === 'x').textContent`)
  expect(completeRow.includes('secret') && !completeRow.includes('→'), 'complete value after truncated capture has no false previous empty value', completeRow)
  await button('Step over'); await waitState('Paused (step) · xed-short-cut.msh:4')
  await button('Step over'); await waitState('Paused (step) · xed-short-cut.msh:5')
  completeRow = await A<string>(`return [...W.querySelectorAll('.xed-vars tr')].find(r => r.querySelector('.xed-var-name')?.textContent === 'x').textContent`)
  expect(completeRow.includes('secret → changed'), 'complete snapshots still highlight a later real value change', completeRow)
  await button('Stop'); await page.eval('window.xedShortCut.done')
  await A(`W.querySelector('[aria-label="Close"]').click()`)
  await page.waitFor(`!document.querySelector('.zed')`)

  // --- parser-backed static origins, modified click, keyboard, completion and unsaved sources --------
  const intelMain = 'source /tmp/xed-symbol-lib.msh\nfuel=9\ndeliver(parcel,cost) {\n  local fuel=6\n  echo "$parcel $cost $fuel $1"\n}\ndeliver "Space Potato" 3\nfromlib hello\necho "$fuel"'
  const intelLib = 'fromlib(message) { echo "$message"; }'
  await page.eval(`(async () => {
    await window.xedFs.writeFile('/tmp', '/tmp/xed-symbol-main.msh', ${JSON.stringify(intelMain)}, false)
    await window.xedFs.writeFile('/tmp', '/tmp/xed-symbol-lib.msh', ${JSON.stringify(intelLib)}, false)
    window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'zed', props: { path: '/tmp/xed-symbol-main.msh', root: '/tmp' } } }))
  })()`)
  await page.waitFor(`document.querySelector('.zed-tab.is-active')?.textContent.includes('xed-symbol-main.msh')`)
  await page.eval(`document.querySelector('.zed').closest('.window').dataset.test = 'a'`)
  await focusWin('a')
  const intelReady = () => page.waitFor(`document.querySelector('.window[data-test="a"] .xed-symbol-summary')?.textContent.includes('Static:')`, 5000)
  await caretAt(intelMain.indexOf('$parcel') + 2); await intelReady()
  const summary = () => A<string>(`return W.querySelector('.xed-symbol-summary')?.textContent ?? ''`)
  expect((await summary()).includes('parameter') && (await summary()).includes('xed-symbol-main.msh:3'), 'static parameter origin uses shared named declaration')
  const paramHighlight = await A<string[]>(`return [...W.querySelectorAll('.zed-hl .md-code')].map(e => e.textContent)`)
  expect(paramHighlight.includes('parcel') && paramHighlight.includes('cost'), 'shared highlighting marks named parameter declarations')
  await caretAt(intelMain.indexOf('$fuel') + 2)
  expect((await summary()).includes('local') && (await summary()).includes(':4'), 'local static origin shadows global assignment')
  await caretAt(intelMain.lastIndexOf('$fuel') + 2)
  expect((await summary()).includes('global') && (await summary()).includes(':2'), 'global static origin outside function scope')
  await caretAt(intelMain.indexOf('$1') + 1)
  expect((await summary()).includes('positional argument'), 'static positional hint is distinct from parameter')
  const pointerTo = async (source: string, offset: number) => A<{ x: number; y: number }>(`
    const el = W.querySelector('textarea.zed-input'), rect = el.getBoundingClientRect()
    const source = ${JSON.stringify(source)}, before = source.slice(0, ${offset}), rows = before.split(String.fromCharCode(10))
    const canvas = document.createElement('canvas').getContext('2d'), style = getComputedStyle(el); canvas.font = style.fontSize + ' ' + style.fontFamily
    const cw = canvas.measureText('0'.repeat(100)).width / 100
    return { x: rect.x + (rows.at(-1).length + .3) * cw, y: rect.y + ${PAD} + (rows.length - 1) * ${LINE} + ${LINE / 2} }`)
  const callOffset = intelMain.indexOf('deliver "')
  await caretAt(callOffset)
  const defPoint = await pointerTo(intelMain, callOffset + 2)
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: defPoint.x, y: defPoint.y, button: 'left', clickCount: 1, modifiers: MODS.ctrl })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: defPoint.x, y: defPoint.y, button: 'left', clickCount: 1, modifiers: MODS.ctrl })
  await page.waitFor(`document.querySelector('.window[data-test="a"] textarea.zed-input')?.selectionStart === ${intelMain.indexOf('deliver(parcel')}`, 5000)
  pass('real Ctrl+Click navigates function reference to parsed declaration')
  await A(`W.querySelector('.xed-symbol-actions button:nth-child(2)').click()`)
  await page.waitFor(`document.querySelector('.window[data-test="a"] textarea.zed-input')?.selectionStart >= ${callOffset} && document.querySelector('.window[data-test="a"] textarea.zed-input')?.selectionStart <= ${callOffset + 7}`, 5000)
  pass('definition Back restores caller caret')
  await caretAt(intelMain.indexOf('fromlib hello'))
  await page.eval(`window.xedFs.writeFile('/tmp', '/tmp/xed-symbol-lib.msh', ${JSON.stringify('\n' + intelLib)}, false)`)
  await A(`W.querySelector('.xed-symbol-actions button').click()`)
  await page.waitFor(`document.querySelector('.zed-status-msg')?.textContent.includes('Source changed')`, 5000)
  expect((await activeFile()) === 'xed-symbol-main.msh', 'changed closed source does not navigate to stale location')
  await page.waitFor(`document.querySelector('.xed-symbol-summary')?.textContent.includes('xed-symbol-lib.msh:2')`, 5000)
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'g', code: 'KeyG', windowsVirtualKeyCode: 71, modifiers: MODS.alt })
  await page.waitFor(`document.querySelector('.zed-tab.is-active')?.textContent.includes('xed-symbol-lib.msh')`, 5000)
  expect((await A<number>(`return W.querySelector('textarea.zed-input').selectionStart`)) === 1, 'keyboard Go to Definition follows authorized literal source to another tab')
  await edit('\n\n' + intelLib)
  await A(`W.querySelector('.xed-symbol-actions button:nth-child(2)').click()`)
  await page.waitFor(`document.querySelector('.zed-tab.is-active')?.textContent.includes('xed-symbol-main.msh')`)
  await caretAt(intelMain.indexOf('fromlib hello')); await intelReady()
  await page.waitFor(`document.querySelector('.xed-symbol-summary')?.textContent.includes('xed-symbol-lib.msh:3')`, 5000)
  await A(`W.querySelector('.xed-symbol-actions button').click()`)
  await page.waitFor(`document.querySelector('.zed-tab.is-active')?.textContent.includes('xed-symbol-lib.msh') && document.querySelector('textarea.zed-input')?.selectionStart === 2`, 5000)
  pass('unsaved source buffer overrides disk and updates definition location')
  // Restore the source so window cleanup requires no discard dialog.
  await edit('\n' + intelLib)
  await A(`W.querySelector('.xed-symbol-actions button:nth-child(2)').click()`)
  await page.waitFor(`document.querySelector('.zed-tab.is-active')?.textContent.includes('xed-symbol-main.msh')`)
  await caretAt(intelMain.indexOf('$parcel') + 4)
  await intelReady()
  await A(`W.querySelector('.xed-symbol-actions button:nth-child(3)').click()`)
  const suggestions = () => A<string>(`return W.querySelector('.xed-completions')?.textContent ?? ''`)
  expect((await suggestions()).includes('parcel') && (await suggestions()).includes('parameter') && !(await suggestions()).includes('printf'), 'contextual parameter completion excludes command names')
  await A(`W.querySelector('.xed-completions button').click()`)
  expect((await A<string>(`return W.querySelector('textarea.zed-input').value`)) === intelMain, 'completion in the middle of a name replaces its suffix and preserves quoted expression')
  await caretAt(callOffset + 'deliver'.length); await intelReady()
  await A(`W.querySelector('.xed-symbol-actions button:nth-child(3)').click()`)
  await page.waitFor(`document.querySelector('.xed-completions')?.textContent.includes('deliver(parcel, cost)')`, 5000)
  pass('function completion shows named parameter signature')
  // Real Ctrl+Space edits and executes each resulting script through the editor's Run action.
  const completeAt = async (source: string, caret: number, name: string) => {
    await edit(source); await caretAt(caret)
    for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: MODS.ctrl })
    await page.waitFor(`[...document.querySelectorAll('.xed-completions button b')].some(b => b.textContent === ${JSON.stringify(name)})`, 5000)
    await A(`const choice = [...W.querySelectorAll('.xed-completions button')].find(b => b.querySelector('b')?.textContent === ${JSON.stringify(name)}); choice.click()`)
    return A<string>(`return W.querySelector('textarea.zed-input').value`)
  }
  const runCompleted = async (expected: string, label: string) => {
    const prior = await A<string>(`return W.querySelector('[aria-label="Debug session"]')?.value ?? ''`)
    await key('F5')
    await page.waitFor(`document.querySelector('.window[data-test="a"] [aria-label="Debug session"]')?.value !== ${JSON.stringify(prior)} && document.querySelector('.window[data-test="a"] .xed-dbg-state .xed-dbg-long')?.textContent.startsWith('Completed · exit 0')`, 10000)
    await tab('Output')
    const output = await A<string>(`return W.querySelector('.xed-dbg-output')?.textContent ?? ''`)
    expect(output === expected, label, output)
  }
  const completionCases: [string, string, number[]][] = [
    ['"del"', '"deliver"', [5, 3]], ["'del'", "'deliver'", [5, 3]],
    ['"delivery"', '"deliver"', [4]], ["'delivery'", "'deliver'", [4]],
    ['de\\l', "'deliver'", [4, 3]], ['de"l"', "'deliver'", [5]], ['del', 'deliver', [3, 2]],
  ]
  for (const [head, replacement, positions] of completionCases) for (const caret of positions) {
    const source = `deliver(p) { echo "$p"; }\n${head} "Space Potato" # untouched`
    const edited = await completeAt(source, source.indexOf('\n') + 1 + caret, 'deliver')
    await page.waitFor(`document.querySelector('.window[data-test="a"] textarea.zed-input')?.selectionStart === ${source.indexOf('\n') + 1 + replacement.length}`, 5000)
    expect(edited === `deliver(p) { echo "$p"; }\n${replacement} "Space Potato" # untouched`, `Ctrl+Space preserves literal command and surrounding arguments: ${head} at ${caret}`, edited)
    await runCompleted('Space Potato\n', `completed ${head} at ${caret} executes deliver with status 0`)
  }
  const aliasedCompletion = 'alias deliver="echo alias"\ndeliver(p) { echo "$p"; }\nde\\l hello'
  const aliasedEdited = await completeAt(aliasedCompletion, aliasedCompletion.lastIndexOf('de\\l') + 4, 'deliver')
  expect(aliasedEdited.endsWith("'deliver' hello"), 'escaped completion stays quoted to preserve alias suppression', aliasedEdited)
  await runCompleted('hello\n', 'escaped completion invokes the function even when the same name has an alias')
  for (const word of ['"$par"', '"${par}"']) {
    const source = `parcel=hello\necho ${word}`
    const edited = await completeAt(source, source.indexOf('par', source.indexOf('\n')) + 2, 'parcel')
    expect(edited === source.replace(word, word.replace('par', 'parcel')), 'Ctrl+Space keeps variable expansion syntax intact', edited)
    await runCompleted('hello\n', 'completed variable reference executes unchanged shell expansion')
  }
  for (const head of ['del${suffix}', 'del$(echo iver)']) {
    const source = `deliver(p) { :; }\n${head} hello`
    await edit(source); await caretAt(source.indexOf('\n') + 4)
    for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: MODS.ctrl })
    await page.waitFor(`document.querySelector('.xed-completions')?.textContent === 'No matching symbols'`, 5000)
    expect((await A<string>(`return W.querySelector('textarea.zed-input').value`)) === source, `dynamic command expression remains untouched: ${head}`)
  }
  // Symbols never runs a source/eval: the dynamic path is labelled, not followed.
  await edit('source "$dynamic"\neval "$unknown"\necho "$fuel"')
  await caretAt(37)
  await A(`const b = W.querySelector('.xed-symbol-actions button:nth-child(4)'); if (b.getAttribute('aria-expanded') !== 'true') b.click()`)
  await page.waitFor(`document.querySelector('.xed-symbol-details')?.textContent.includes('dynamic source')`, 5000)
  pass('dynamic source uncertainty is visible without evaluating it')
  await page.eval(`(async () => {
    await window.xedFs.writeFile('/tmp', '/tmp/xed-cwd-move.msh', '"cd" sub', false)
    await window.xedFs.writeFile('/tmp', '/tmp/xed-cwd-lib.msh', 'f() { echo wrong; }', false)
  })()`)
  const movedSources = 'source /tmp/xed-cwd-move.msh\nsource ./xed-cwd-lib.msh\nf'
  await edit(movedSources); await caretAt(movedSources.length - 1)
  await page.waitFor(`document.querySelector('.xed-symbol-details')?.textContent.includes('working directory')`, 5000)
  await A(`W.querySelector('.xed-symbol-actions button').click()`)
  expect((await activeFile()) === 'xed-symbol-main.msh' && !(await summary()).includes('xed-cwd-lib.msh'), 'Go to Definition never guesses old cwd after sourced quoted cd', await summary())
  const quotedRedefinition = `f() { echo old; }; "eval" 'f() { echo new; }'; f`
  await edit(quotedRedefinition); await caretAt(quotedRedefinition.length - 1)
  await page.waitFor(`document.querySelector('.xed-symbol-summary')?.textContent.includes('(candidate)')`, 5000)
  const uncertainPoint = await pointerTo(quotedRedefinition, quotedRedefinition.length - 1)
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: uncertainPoint.x, y: uncertainPoint.y, button: 'left', clickCount: 1, modifiers: MODS.ctrl })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: uncertainPoint.x, y: uncertainPoint.y, button: 'left', clickCount: 1, modifiers: MODS.ctrl })
  expect((await A<number>(`return W.querySelector('textarea.zed-input').selectionStart`)) === quotedRedefinition.length - 1 && (await A<boolean>(`return !!W.querySelector('.xed-definitions button')`)), 'modified click after quoted eval presents candidates without a false definitive jump')
  await edit(intelMain)
  await A(`W.querySelector('[aria-label="Close"]').click()`)
  await page.waitFor(`!document.querySelector('.zed')`)

  // --- phone: touch taps on the gutter and controls, fitting the width --------------------------------
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await page.eval(`window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'zed', props: { path: '/tmp/xed-main.msh', root: '/tmp', t: '3' } } }))`)
  await page.waitFor(`!!document.querySelector('.zed .xed-dbg-bar') && matchMedia('(pointer: coarse)').matches`)
  await page.eval(`document.querySelector('.zed').closest('.window').dataset.test = 'p'`)
  const P = <T = any>(js: string) => inWin<T>('p', js)
  await P(`const b = W.querySelector('[aria-label="Toggle debug panel"]'); if (b.getAttribute('aria-pressed') !== 'true') b.click()`)
  const tap = async (x: number, y: number) => {
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(120)
  }
  at = await P(`const r = W.querySelector('.zed-gutter').children[2].getBoundingClientRect(); return { x: r.x + 3, y: r.y + r.height / 2 }`)
  await tap(at.x, at.y)
  await page.waitFor(`window.xedDebug.editorBreakpoints().some(b => b.line === 3)`, 5000)
  pass('tapping the gutter on a touch screen sets a breakpoint')
  const fit = await P(`
    const z = W.querySelector('.zed'), bar = W.querySelector('.xed-dbg-bar'), panel = W.querySelector('.xed-dbg')
    const btn = W.querySelector('.xed-dbg-btn').getBoundingClientRect()
    return { bar: bar.getBoundingClientRect().right <= innerWidth + 1, zed: z.scrollWidth <= z.clientWidth + 1, panel: panel.scrollWidth <= panel.clientWidth + 1, btn: btn.height >= 35 && btn.width >= 35 }`)
  expect(fit.bar && fit.zed && fit.panel && fit.btn, 'phone: toolbar and panel fit the width with 36px touch targets', fit)
  const phoneState = await P(`const s = W.querySelector('.xed-dbg-state'), r = s.getBoundingClientRect(); return { shown: getComputedStyle(s).display !== 'none' && r.width > 20 && r.right <= innerWidth, text: s.querySelector('.xed-dbg-short').textContent }`)
  expect(phoneState.shown && phoneState.text === 'Idle', 'phone: a short session state stays visible in the toolbar', phoneState)
  at = await P(`const r = W.querySelector('[aria-label="Run"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`)
  await tap(at.x, at.y)
  await waitState('Paused (breakpoint) · xed-main.msh:3', 'p')
  await P(`W.querySelector('[aria-label="Stop"]').click()`)
  await waitState('Stopped', 'p')
  pass('tapping Run on a phone runs to the breakpoint; Stop stops')
  const phoneCall = await P<number>(`return W.querySelector('textarea.zed-input').value.indexOf('greet "$name"') + 2`)
  await caretAt(phoneCall, phoneCall, 'p')
  await page.waitFor(`document.querySelector('.window[data-test="p"] .xed-symbol-summary')?.textContent.includes('function')`, 5000)
  at = await P(`const r = W.querySelector('.xed-symbol-actions button').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`)
  await tap(at.x, at.y)
  if (await P(`return !!W.querySelector('.xed-definitions button')`)) {
    at = await P(`const r = W.querySelector('.xed-definitions button').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`)
    await tap(at.x, at.y)
  }
  await page.waitFor(`document.querySelector('.window[data-test="p"] .zed-tab.is-active')?.textContent.includes('xed-lib.msh')`, 5000)
  pass('touch Go to Definition and explicit candidate open sourced function without modifier keys')
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await P(`W.querySelector('[aria-label="Close"]').click()`)
  await page.waitFor(`!document.querySelector('.zed')`)
  await page.eval(`window.xedDebug.removeBreakpoints()`)
  if (page.errors.length) throw new Error(page.errors.join('\n'))
  pass('no browser exceptions')

  // --- outside Xed, F5 stays the browser's: not prevented (it reloads the page) -----------------------
  await page.eval(`window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'terminal' } }))`)
  await page.waitFor(`!!document.querySelector('.window.is-focused, .window') && !document.querySelector('.zed')`)
  await page.eval(`window.xedReloadMarker = 1`)
  const outside = await key('F5').catch(() => [] as { key: string; prevented: boolean }[])
  await sleep(1500)
  const reloaded = await page.eval(`window.xedReloadMarker !== 1`).catch(() => true)
  expect(reloaded || (outside.length === 1 && !outside[0].prevented), `F5 outside Xed is not taken: the browser default stays (${reloaded ? 'the page reloaded' : 'keydown not prevented; headless Chromium has no reload accelerator'})`, { reloaded, outside })
} finally { await browser.close() }
