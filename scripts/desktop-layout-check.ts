// Targeted home layout regression. Own scratch server and muted Chromium; no production data.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { iconLayout, overlaps, homeSwipe, ICON_W, ICON_H, HOME_TOP } from '../src/os/homeLayout.ts'
import { arrangeDesktop } from '../src/os/widgetLayout.ts'
import { launch, newPage, sleep } from './perf/cdp.ts'

const icons = Array.from({ length: 90 }, (_, i) => `file-${i}`)
for (const [width, height] of [[1400, 900], [390, 600], [180, 300]]) {
  const obstacles = [{ x: 14, y: 40, w: 200, h: 200 }]
  const layout = iconLayout(icons, {}, width, height, obstacles)
  assert.equal(new Set(Object.values(layout).map((p) => `${p.col},${p.row}`)).size, icons.length)
  const cols = Math.max(1, Math.floor((width - 28) / ICON_W))
  const rects = Object.values(layout).map((p) => ({ x: 14 + (cols - 1 - p.col) * ICON_W, y: HOME_TOP + p.row * ICON_H, w: ICON_W, h: ICON_H }))
  assert(rects.every((r, i) => ![...obstacles, ...rects.slice(0, i)].some((o) => overlaps(r, o))))
  assert.deepEqual(layout, iconLayout(icons, {}, width, height, obstacles))
}
const items = Array.from({ length: 24 }, (_, pid) => ({ pid, x: 100, y: 100, w: 240, h: 200 }))
const crowded = [...arrangeDesktop(items, 390, 500).values()]
assert.equal(crowded.length, 24)
assert(crowded.every((r, i) => !crowded.slice(0, i).some((o) => overlaps(r, o))))
assert(crowded.some((r) => r.y > 500))
assert.equal(homeSwipe(-100, 20, 300), 'icons')
assert.equal(homeSwipe(100, 20, 300), 'widgets')
assert.equal(homeSwipe(20, 100, 300), null)
assert.equal(homeSwipe(-100, 0, 900), null)
console.log('PASS pure placement: crowded/narrow, obstacles, overflow, deterministic; swipe thresholds')

const data = mkdtempSync('/tmp/mvlos-desktop-layout-')
const port = Number(process.env.PORT ?? 5286)
const vite = spawn('./node_modules/.bin/vite', ['--port', String(port), '--strictPort'], { env: { ...process.env, DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
vite.stdout.on('data', (d) => log += d)
vite.stderr.on('data', (d) => log += d)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await browser?.close(); vite.kill(); process.exit(1) })
let browser: Awaited<ReturnType<typeof launch>> | undefined
try {
  for (let i = 0; i < 100 && !log.includes('ready') && vite.exitCode === null; i++) await sleep(200)
  assert(log.includes('ready'), log)
  browser = await launch(1200, 800)
  const p = await newPage(browser, 1200, 800, '')
  const evaluate = <T = unknown>(expression: string) => p.eval<T>(`(async () => (${expression}))()`)
  const origin = `http://127.0.0.1:${port}`
  await p.send('Page.navigate', { url: origin })
  await p.waitFor(`!!document.querySelector('.desktop') && !document.querySelector('.boot')`, 90_000)
  await sleep(2500)
  await evaluate(`(async () => {
    const { widgetPlaces, changeSet } = await import('/src/os/widgetPlaces.ts')
    const all = { places: {}, removed: '' }
    for (let i = 0; i < 5; i++) all.places['test'+i] = { id: 'test'+i, kind: 'status', x: 100, y: 100, w: 240, h: 200, vw: 1200, vh: 800, at: 1 }
    widgetPlaces.set(all)
    // Local external mutations are displayed on reload, like existing persisted setups.
    ;(await import('/src/os/startup.ts')).setStartupPrefs({ windows: 'empty' })
    const ds = await import('/src/os/desktopStore.ts')
    ds.updateDesktop(s => ({...s, names: {games: 'Very long multiline filename '.repeat(12)}}))
  })()`)
  console.log('browser: reload')
  await p.send('Page.reload')
  await sleep(600)
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.waitFor(`!document.querySelector('.boot')`)
  await p.waitFor(`document.querySelectorAll('[data-app="widget"]').length === 5`, 90_000)
  await sleep(1500)
  console.log('browser: widget setup ready')
  const desktopSet = await evaluate(`JSON.stringify((await import('/src/os/widgetPlaces.ts')).widgetPlaces.get())`)
  assert(await evaluate(`(() => { const a=[...document.querySelectorAll('.desk-icon,.window.chrome-note')].filter(e=>getComputedStyle(e).display!=='none').map(e=>e.getBoundingClientRect()); return a.every((r,i)=>a.slice(0,i).every(o=>r.right<=o.left||r.left>=o.right||r.bottom<=o.top||r.top>=o.bottom)) })()`), 'rendered desktop items overlap')
  await p.send('Emulation.setDeviceMetricsOverride', { width: 740, height: 400, deviceScaleFactor: 1, mobile: false })
  await sleep(600)
  assert(await evaluate(`(() => { const a=[...document.querySelectorAll('.desk-icon,.window.chrome-note')].filter(e=>getComputedStyle(e).display!=='none').map(e=>e.getBoundingClientRect()); const s=document.querySelector('.desk-scroll'); return s.scrollHeight>s.clientHeight && a.every((r,i)=>a.slice(0,i).every(o=>r.right<=o.left||r.left>=o.right||r.bottom<=o.top||r.top>=o.bottom)) })()`), 'crowded desktop resize separates rendered items with usable scroll overflow')
  await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: false })
  await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  console.log('browser: mobile resize')
  await p.waitFor(`!!document.querySelector('.home-pages')`)
  await sleep(500)
  // Close one inherited widget through its real UI. Only the mobile set should change.
  await evaluate(`document.querySelector('[data-app="widget"] .note-grip').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, clientX:100, clientY:100}))`)
  await sleep(150)
  await evaluate(`(() => { const els = [...document.querySelectorAll('[role="menuitem"], .context-menu button')]; const close = els.find(e=>e.querySelector('.ctx-label')?.textContent === 'Close'); if (!close) throw Error('no widget close control'); close.click() })()`)
  await p.waitFor(`document.querySelectorAll('[data-app="widget"]').length === 4`)
  assert.equal(await evaluate(`JSON.stringify((await import('/src/os/widgetPlaces.ts')).widgetPlaces.get())`), desktopSet)
  assert.equal(await evaluate(`Object.keys((await import('/src/os/widgetPlaces.ts')).mobileWidgetPlaces.get().places).length`), 4)
  const grip = await evaluate<{x:number;y:number}>(`(() => { const r=document.querySelector('[data-app="widget"] .note-grip').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
  await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [grip] })
  await sleep(450)
  await p.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: grip.x, y: grip.y+320 }] })
  await sleep(100)
  await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(250)
  assert(await evaluate(`Object.values((await import('/src/os/widgetPlaces.ts')).mobileWidgetPlaces.get().places).some(p=>typeof p.stack==='number')`), 'touch grip reorder persists mobile order')
  assert.equal(await evaluate(`JSON.stringify((await import('/src/os/widgetPlaces.ts')).widgetPlaces.get())`), desktopSet)
  await evaluate(`document.querySelector('.home-pages button:last-child').click()`)
  await p.waitFor(`!!document.querySelector('.desk.is-home-icons')`)
  await sleep(300)
  const at = await evaluate<{x:number;y:number}>(`(() => { const r=document.querySelector('.desk-icon').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+20} })()`)
  assert(await evaluate(`!!document.elementFromPoint(${at.x},${at.y})?.closest('.desk-icon')`), 'touch hits an icon')
  for (const [type, dy] of [['touchStart',0],['touchMove',125],['touchEnd',125]] as const) {
    await p.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: at.x, y: at.y+dy }] })
    await sleep(60)
  }
  const mobilePositions = await evaluate(`JSON.stringify(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.endsWith('.sync.desktop')))).value.mobilePositions)`)
  assert.notEqual(mobilePositions, undefined, 'touch move saves mobile icon positions')
  assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.endsWith('.sync.desktop')))).value.positions`), {}, 'mobile icon movement leaves desktop positions untouched')
  console.log('browser: reload')
  await p.send('Page.reload')
  await sleep(600)
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await p.waitFor(`!document.querySelector('.boot')`)
  await p.waitFor(`!!document.querySelector('.home-pages')`, 90_000)
  await sleep(600)
  assert.equal(await evaluate(`JSON.stringify(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.endsWith('.sync.desktop')))).value.mobilePositions)`), mobilePositions)
  // Real touch gesture on empty home background, without dragging an icon.
  for (const [type, x] of [['touchStart',30],['touchMove',150],['touchEnd',150]] as const) {
    await p.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: 690 }] })
    await sleep(60)
  }
  await p.waitFor(`!document.querySelector('.desk.is-home-icons')`)
  assert.equal(await evaluate(`document.querySelectorAll('[data-app="widget"]').length`), 4)
  await p.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false })
  await p.waitFor(`document.querySelectorAll('[data-app="widget"]').length === 5`)
  assert.equal(await evaluate(`JSON.stringify((await import('/src/os/widgetPlaces.ts')).widgetPlaces.get())`), desktopSet)
  console.log('PASS browser: multiline/collision bounds; mobile selection, touch widget reorder/icon move, reload, swipe, width switching preserve desktop')
} finally {
  await browser?.close()
  vite.kill()
  await new Promise<void>((resolve) => vite.exitCode !== null ? resolve() : vite.once('exit', () => resolve()))
  rmSync(data, { recursive: true, force: true })
}
