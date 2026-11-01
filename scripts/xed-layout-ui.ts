import { readFileSync } from 'node:fs'
// Drives Xed's side panels in the repository's muted Chromium harness against a caller-owned
// scratch Vite server: real mouse drags on the splitters (and their cancel), real keys, the
// Agents panel opened and closed, the window made narrower than the viewport, and the widths kept
// across a reload. `XED_TEST_PORT=5283 node scripts/xed-layout-ui.ts`
import { launch, newPage, sleep } from './perf/cdp.ts'
const port = Number(process.env.XED_TEST_PORT ?? 5276)
if (port < 5170 || port > 5299) throw new Error('Use a scratch dev server on port 5170–5299')
const browser = await launch(1500, 900)
const pass = (what: string) => console.log('PASS', what)
const fail = (what: string, detail: unknown) => { throw new Error(`FAIL ${what}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`) }
const expect = (ok: boolean, what: string, detail: unknown = '') => (ok ? pass(what) : fail(what, detail))
const KEY = 'mvlos.xed.layout.v1'
try {
  const page = await newPage(browser, 1500, 900, readFileSync(new URL('./xed-agent-fixture.js', import.meta.url), 'utf8'))
  // EventSource/image API requests must not hit the real unauthenticated scratch server.
  await page.send('Network.enable')
  await page.send('Network.setBlockedURLs', { urls: ['*/api/*'] })
  const load = async () => {
    await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/` })
    await page.waitFor(`document.readyState === 'complete' && !!document.querySelector('#root > *')`)
    await page.eval(`import('/src/os/powerState.ts').then(m => m.bootDone())`)
    await page.waitFor(`!document.querySelector('.boot')`)
    await page.waitFor(`!!document.querySelector('.desktop')`)
    await page.eval(`import('/src/os/account.ts').then(async m => { while (m.getAccount().status === 'loading') await new Promise(r => setTimeout(r, 50)) })`)
    await sleep(800)

  }
  await load()
  await page.eval(`localStorage.removeItem(${JSON.stringify(KEY)})`)
  const text = 'one\ntwo\nthree\nfour\n'
  await page.eval(`(async () => {
    const fs = await import('/src/terminal/fs.ts')
    await fs.writeFile('/tmp', '/tmp/layout.txt', ${JSON.stringify(text)}, false)
  })()`)
  const openXed = async () => {
    await page.eval(`window.dispatchEvent(new CustomEvent('mvlos:open', { detail: { app: 'zed', props: { path: '/tmp/layout.txt', root: '/tmp' } } }))`)
    await page.waitFor(`!!document.querySelector('.zed textarea.zed-input')`)
    await sleep(800)
    for (let i = 0; i < 20 && (await page.eval(`!!document.querySelector('.boot')`)); i++) await sleep(250)
  }
  await openXed()
  // The window's width is what Xed sees (the viewport stays 1500 wide); `w` is the width of Xed's
  // body, so the window's own border is made up for.
  const setWidth = async (w: number) => {
    const body = () => page.eval<number>(`document.querySelector('.zed-body').clientWidth`)
    const win = (px: number) => page.eval(`(() => { const win = document.querySelector('.zed').closest('.window'); win.style.width = '${px}px'; win.style.left = '10px' })()`)
    await win(w)
    await sleep(100)
    await win(w + (w - (await body())))
    await sleep(150)
  }
  const Z = <T = any>(js: string) => page.eval<T>(`(() => { const Z = document.querySelector('.zed'); ${js} })()`)
  const widthOf = (sel: string) => Z<number | null>(`const e = Z.querySelector(${JSON.stringify(sel)}); return e && !e.hidden ? Math.round(e.getBoundingClientRect().width) : null`)
  const stored = () => page.eval<any>(`JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}) ?? 'null')`)
  const pressed = (label: string) => Z<string | null>(`return Z.querySelector('[aria-label=${JSON.stringify(label)}]')?.getAttribute('aria-pressed') ?? null`)
  const MODS = { alt: 1, ctrl: 2, shift: 8 }
  const CODES: Record<string, number> = { ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, Enter: 13, Escape: 27, l: 76 }
  const key = async (k: string, mods = 0) => {
    for (const type of ['rawKeyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: CODES[k], modifiers: mods })
    await sleep(120)
  }
  const center = (sel: string) => Z<{ x: number; y: number }>(`const r = Z.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`)
  const mouse = (type: string, x: number, y: number, buttons = 0, clickCount = 0) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount })
  const LEFT = '.usplit.is-right', RIGHT = '.usplit.is-left'
  const cssVar = (name: string) => Z<string>(`return Z.querySelector('.zed-body').style.getPropertyValue(${JSON.stringify(name)})`)
  // Counts the writes of the layout preference, to prove a drag commits once.
  await page.eval(`window.layoutWrites = 0; const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === ${JSON.stringify(KEY)}) window.layoutWrites++; return set.call(this, k, v) }`)
  const writes = () => page.eval<number>('window.layoutWrites')

  // --- wide window: project panel only, Agents not mounted --------------------------------------
  await setWidth(1100)
  expect((await widthOf('.zed-panel')) === 220, 'wide: project panel is 220 wide by default', await widthOf('.zed-panel'))
  expect((await Z(`return !!Z.querySelector('.xed-agents')`)) === false, 'the Agents panel is not mounted until first opened')
  const sep = await Z<any>(`const s = Z.querySelector('${LEFT}'); return { role: s.getAttribute('role'), o: s.getAttribute('aria-orientation'), min: s.getAttribute('aria-valuemin'), max: s.getAttribute('aria-valuemax'), now: s.getAttribute('aria-valuenow'), tab: s.tabIndex, noTouch: s.hasAttribute('data-no-touch-menu'), label: s.getAttribute('aria-label'), w: Math.round(s.getBoundingClientRect().width) }`)
  expect(sep.role === 'separator' && sep.o === 'vertical' && sep.min === '160' && sep.max === '480' && sep.now === '220' && sep.tab === 0 && sep.noTouch && sep.w === 8, 'the splitter is an accessible vertical separator with numeric values, 8px, no touch menu', sep)

  // --- mouse drag: previews through a CSS variable, commits once -------------------------------
  let c = await center(LEFT)
  const before = await writes()
  await mouse('mouseMoved', c.x, c.y)
  await mouse('mousePressed', c.x, c.y, 1, 1)
  for (let dx = 10; dx <= 60; dx += 10) await mouse('mouseMoved', c.x + dx, c.y, 1)
  await sleep(100)
  expect((await cssVar('--xed-left')) === '280px' && (await widthOf('.zed-panel')) === 280, 'dragging 60px previews 280px live', await page.eval(`({at:document.elementFromPoint(${c.x},${c.y})?.outerHTML.slice(0,1500),active:document.activeElement?.outerHTML.slice(0,300),boot:!!document.querySelector('.boot')})`))
  expect((await Z(`return Z.querySelector('${LEFT}').getAttribute('aria-valuenow')`)) === '280', 'aria-valuenow follows the drag')
  expect((await writes()) === before && (await stored())?.left !== 280, 'nothing is saved while the pointer is down', await stored())
  await mouse('mouseReleased', c.x + 60, c.y, 0, 1)
  await sleep(100)
  expect((await writes()) === before + 1 && (await stored()).left === 280, 'letting go saves once', { writes: await writes(), stored: await stored() })

  // --- cancel: Escape, and a pointercancel ------------------------------------------------------
  c = await center(LEFT)
  await mouse('mousePressed', c.x, c.y, 1, 1)
  await mouse('mouseMoved', c.x + 80, c.y, 1)
  await sleep(100)
  expect((await widthOf('.zed-panel')) === 360, 'second drag previews 360', await widthOf('.zed-panel'))
  const w1 = await writes()
  await key('Escape')
  await mouse('mouseReleased', c.x + 80, c.y, 0, 1)
  await sleep(100)
  expect((await widthOf('.zed-panel')) === 280 && (await cssVar('--xed-left')) === '280px' && (await writes()) === w1 && (await stored()).left === 280, 'Escape mid-drag restores the width and saves nothing', { w: await widthOf('.zed-panel'), s: await stored() })
  c = await center(LEFT)
  await mouse('mousePressed', c.x, c.y, 1, 1)
  await mouse('mouseMoved', c.x - 70, c.y, 1)
  await sleep(100)
  await Z(`Z.querySelector('${LEFT}').dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })); return 1`)
  await sleep(100)
  expect((await widthOf('.zed-panel')) === 280 && (await writes()) === w1 && (await stored()).left === 280, 'a pointercancel restores the width and saves nothing', { w: await widthOf('.zed-panel') })
  await mouse('mouseReleased', c.x - 70, c.y, 0, 1)
  await mouse('mouseMoved', 5, 5)

  // --- keyboard ---------------------------------------------------------------------------------
  const focusSplit = (sel: string) => Z(`Z.querySelector('${sel}').focus(); return 1`)
  const leftW = () => widthOf('.zed-panel')
  await focusSplit(LEFT)
  await key('ArrowRight')
  expect((await leftW()) === 290 && (await stored()).left === 290, 'ArrowRight grows the left panel by 10', await leftW())
  await key('ArrowLeft', MODS.shift)
  expect((await leftW()) === 240, 'Shift+ArrowLeft shrinks it by 50', await leftW())
  await key('Home')
  expect((await leftW()) === 160, 'Home goes to the minimum', await leftW())
  await key('End')
  expect((await leftW()) === 480, 'End goes to the maximum', await leftW())
  await key('ArrowRight')
  expect((await leftW()) === 480, 'the maximum holds')
  await key('Enter')
  expect((await leftW()) === 220 && (await stored()).left === 220, 'Enter resets to 220', await leftW())
  await key('ArrowRight', MODS.shift)
  c = await center(LEFT)
  await mouse('mouseMoved', c.x, c.y)
  await mouse('mousePressed', c.x, c.y, 1, 1)
  await mouse('mouseReleased', c.x, c.y, 0, 1)
  await mouse('mousePressed', c.x, c.y, 1, 2)
  await mouse('mouseReleased', c.x, c.y, 0, 2)
  await sleep(150)
  expect((await leftW()) === 220, 'double click resets', await leftW())

  // --- Agents panel: first open mounts it, focuses the composer, keeps it after closing ---------
  await Z(`Z.querySelector('textarea.zed-input').focus(); return 1`)
  await page.eval(`(() => { const e = document.querySelector('textarea.zed-input'); e.setSelectionRange(4, 13) })()`)
  await key('l', MODS.ctrl)
  await page.waitFor(`!!document.querySelector('.zed .xed-agents')`)
  await sleep(150)
  expect((await widthOf('.xed-agents')) === 380 && (await pressed('Toggle Agents panel')) === 'true', 'Ctrl+L opens Agents at 380 and the status button is pressed', await widthOf('.xed-agents'))
  await page.waitFor(`!!document.querySelector('[data-xed-composer]')`)
  await sleep(300)
  expect(await Z(`return document.activeElement?.matches('[data-xed-composer]')`), 'Ctrl+L focuses the message box', await Z(`return { active:document.activeElement?.outerHTML, hidden: Z.querySelector('.xed-conversation')?.hidden, text:Z.querySelector('.xed-agents')?.innerText }`))
  const chip = await Z<string>(`return Z.querySelector('.agt-composer')?.textContent ?? ''`)
  expect(chip.includes('/tmp/layout.txt') && chip.includes('(2-3)'), 'Ctrl+L attaches the selected lines', chip)
  const room = await widthOf('.zed-main')
  expect((room ?? 0) >= 320 && (await stored()).showRight === true, 'the editor keeps at least 320 beside both panels', room)
  await page.eval(`(() => { const t = document.querySelector('[data-xed-composer]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'draft'); t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await key('Escape')
  expect(await Z(`return document.activeElement === Z.querySelector('textarea.zed-input')`), 'Escape in the message box returns to the editor')
  expect((await widthOf('.xed-agents')) === 380, 'docked Agents stays open after Escape')
  // Right splitter: dragging left grows it.
  c = await center(RIGHT)
  await mouse('mouseMoved', c.x, c.y)
  await mouse('mousePressed', c.x, c.y, 1, 1)
  await mouse('mouseMoved', c.x - 40, c.y, 1)
  await sleep(100)
  expect((await widthOf('.xed-agents')) === 420, 'dragging the right splitter left grows Agents', await widthOf('.xed-agents'))
  await mouse('mouseReleased', c.x - 40, c.y, 0, 1)
  await sleep(100)
  expect((await stored()).right === 420, 'its width is saved', await stored())
  await focusSplit(RIGHT)
  await key('ArrowLeft')
  expect((await widthOf('.xed-agents')) === 430, 'ArrowLeft grows the right panel', await widthOf('.xed-agents'))
  await key('Enter')
  expect((await widthOf('.xed-agents')) === 380, 'Enter resets the right panel')
  await Z(`Z.querySelector('[aria-label="Toggle Agents panel"]').click(); return 1`)
  await sleep(150)
  const hidden = await Z<any>(`const a = Z.querySelector('.xed-agents'); return a && { hidden: a.hidden, inert: a.inert, draft: a.querySelector('textarea').value, pressed: Z.querySelector('[aria-label="Toggle Agents panel"]').getAttribute('aria-pressed') }`)
  expect(hidden && hidden.hidden && hidden.inert && hidden.draft === 'draft' && hidden.pressed === 'false', 'closed Agents stays mounted, hidden and inert, with its draft', hidden)
  await Z(`Z.querySelector('[aria-label="Toggle Agents panel"]').click(); return 1`)
  await sleep(150)
  expect((await Z(`return Z.querySelector('.xed-agents textarea').value`)) === 'draft', 'reopened Agents has the same draft')

  // --- less room: the Agents panel shrinks first, then the project panel gives way -------------
  await setWidth(900) // 220 + 380 + 320 = 920 > 900
  expect((await widthOf('.xed-agents')) === 360 && (await leftW()) === 220, 'at 900 Agents shrinks to 360', { r: await widthOf('.xed-agents'), l: await leftW() })
  expect((await widthOf('.zed-main')) === 320, 'the editor keeps 320', await widthOf('.zed-main'))
  expect((await stored()).right === 380, 'shrinking by fit does not rewrite the preference', await stored())
  await setWidth(800) // 220 + 300 + 320 = 840 > 800: the project panel yields
  expect((await widthOf('.zed-panel')) === null && (await widthOf('.xed-agents')) === 380 && (await pressed('Toggle project panel')) === 'false', 'at 800 the project panel gives way and Agents keeps its width', { l: await leftW(), r: await widthOf('.xed-agents') })
  await Z(`Z.querySelector('[aria-label="Toggle project panel"]').click(); return 1`)
  await sleep(250)
  expect(await Z(`return !!Z.querySelector('.zed-panel.is-sheet') && !!Z.querySelector('.zed-scrim') && !Z.querySelector('${LEFT}')`), 'the project panel opens as a sheet with a scrim and no splitter')
  await Z(`Z.querySelector('.zed-scrim').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return 1`)
  await sleep(150)
  expect(await Z(`return !Z.querySelector('.zed-panel') && !Z.querySelector('.zed-scrim')`), 'the scrim closes the sheet')

  // --- a narrow window: both panels are sheets, one at a time -----------------------------------
  await setWidth(440)
  expect(await Z(`const a = Z.querySelector('.xed-agents'); return !!a && a.hidden && !Z.querySelector('.usplit')`), 'under 480 Agents is closed as a sheet and there is no splitter')
  await Z(`Z.querySelector('[aria-label="Toggle Agents panel"]').click(); return 1`)
  await sleep(250)
  const sheet = await Z<any>(`const a = Z.querySelector('.xed-agents'); return { sheet: a.classList.contains('is-sheet'), hidden: a.hidden, w: Math.round(a.getBoundingClientRect().width), body: Math.round(Z.querySelector('.zed-body').getBoundingClientRect().width), scrim: !!Z.querySelector('.zed-scrim'), split: !!Z.querySelector('.usplit') }`)
  expect(sheet.sheet && !sheet.hidden && sheet.w === Math.min(sheet.body, 420) && sheet.scrim && !sheet.split, 'narrow: Agents is a sheet of min(100%, 420px) over a scrim', sheet)
  await Z(`Z.querySelector('[aria-label="Toggle project panel"]').click(); return 1`)
  await sleep(250)
  const one = await Z<any>(`return { agents: Z.querySelector('.xed-agents').hidden, panel: !!Z.querySelector('.zed-panel.is-sheet') }`)
  expect(one.agents && one.panel, 'opening the project sheet closes the Agents sheet (one at a time)', one)
  await Z(`Z.querySelector('[aria-label="Toggle Agents panel"]').click(); return 1`)
  await sleep(250)
  expect(await Z(`return !Z.querySelector('.zed-panel') && !Z.querySelector('.xed-agents').hidden`), 'and the other way round')
  await Z(`document.querySelector('[data-xed-composer]').focus(); return 1`)
  await key('Escape')
  await sleep(150)
  expect(await Z(`return Z.querySelector('.xed-agents').hidden && document.activeElement === Z.querySelector('textarea.zed-input')`), 'Escape in the message box closes the sheet and returns to the editor')
  expect((await stored()).showRight === true, 'sheets do not change the docked preference', await stored())

  // Real phone viewport and touch input, not merely a narrow desktop window.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true })
  await setWidth(390)
  const touch = await center('[aria-label="Toggle Agents panel"]')
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] })
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(250)
  expect(await Z(`return !Z.querySelector('.xed-agents').hidden && Z.querySelector('.xed-agents').classList.contains('is-sheet')`), 'phone touch opens Agents sheet')
  expect((await widthOf('.xed-agents'))! <= 390, 'phone sheet fits the viewport')
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })

  // --- widths survive a reload; blocked storage still works -------------------------------------
  await setWidth(1100)
  await focusSplit(LEFT)
  await key('ArrowRight', MODS.shift)
  const saved = await stored()
  await load()
  await openXed()
  await setWidth(1100)
  expect((await leftW()) === saved.left && (await widthOf('.xed-agents')) === saved.right, 'after a reload the panels have their saved widths', { saved, l: await leftW() })
  await page.eval(`Storage.prototype.setItem = function () { throw new Error('blocked') }`)
  await focusSplit(LEFT)
  await key('ArrowRight')
  expect((await leftW()) === saved.left + 10, 'with storage blocked the layout still changes', await leftW())
  if (page.errors.length) throw new Error(page.errors.join('\n'))
  pass('no browser exceptions')
} finally { await browser.close() }
