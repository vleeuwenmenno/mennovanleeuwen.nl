// A desktop widget keeps its share of the room it can travel when the browser is resized.
// Own scratch dev server and muted Chromium; no account, no production data.
// pnpm check:widget-resize (PORT overrides the scratch dev-server port)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { widgetBounds } from '../src/os/widgetLayout.ts'
import { launch, newPage, sleep } from './perf/cdp.ts'

const port = Number(process.env.PORT ?? 5285)
const data = mkdtempSync('/tmp/mvlos-widget-resize-')
const vite = spawn('./node_modules/.bin/vite', ['--port', String(port), '--strictPort'], { env: { ...process.env, DATA_DIR: data, MC_WATCH: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
vite.stdout.on('data', (d) => (log += d))
vite.stderr.on('data', (d) => (log += d))
let browser: Awaited<ReturnType<typeof launch>> | undefined
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await browser?.close(); vite.kill(); process.exit(1) })
try {
  for (let i = 0; i < 150 && !log.includes('ready') && vite.exitCode === null; i++) await sleep(200)
  assert(log.includes('ready'), log)
  browser = await launch(1920, 1080)
  // Every write of the widget set to storage, counted: a resize must not cause any.
  const spy = `(() => { window.__writes = 0; const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (/widgets:placed/.test(k)) window.__writes++; return set.call(this, k, v) } })()`
  const p = await newPage(browser, 1920, 1080, spy)
  const evaluate = <T = unknown>(expression: string) => p.eval<T>(`(async () => (${expression}))()`)
  const size = async (w: number, h: number) => { await p.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(450) }
  const origin = `http://127.0.0.1:${port}`
  const place = () => evaluate<{ x: number; y: number; w: number; h: number; vw: number; vh: number; at: number; minimized?: boolean }>(`Object.values((await import('/src/os/widgetPlaces.ts')).widgetPlaces.get().places)[0]`)
  const shown = () => evaluate<{ x: number; y: number; w: number }>(`(() => { const e = document.querySelector('[data-app="widget"]'); return { x: parseFloat(e.style.left), y: parseFloat(e.style.top), w: parseFloat(e.style.width) } })()`)
  const writes = () => evaluate<number>(`window.__writes`)
  const load = async () => {
    await p.send('Page.navigate', { url: origin })
    await p.waitFor(`!!document.querySelector('[data-app="widget"]') && !document.querySelector('.boot')`, 90_000)
    await sleep(700)
  }
  let failed = 0
  const check = (what: string, ok: boolean, extra?: unknown) => { console.log(ok ? 'PASS' : 'FAIL', what, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) failed++ }

  // A widget exactly in the middle of a 1920x1080 browser.
  await p.send('Page.navigate', { url: origin })
  await p.waitFor(`!!document.querySelector('.desktop') && !document.querySelector('.boot')`, 90_000)
  await sleep(1500)
  const b0 = widgetBounds({ w: 280 }, 1920, 1080)
  const centred = { x: Math.round((b0.minX + b0.maxX) / 2), y: Math.round((b0.minY + b0.maxY) / 2) }
  await evaluate(`(async () => {
    const { widgetPlaces } = await import('/src/os/widgetPlaces.ts')
    widgetPlaces.set({ places: { clock: { id: 'clock', kind: 'status', x: ${centred.x}, y: ${centred.y}, w: 280, h: 200, vw: 1920, vh: 1080, at: 5 } }, removed: '' })
    ;(await import('/src/os/startup.ts')).setStartupPrefs({ windows: 'empty' })
  })()`)
  await load()
  const original = await place()
  const first = await shown()
  check('shown where it was put on the screen it was put on', first.x === centred.x && first.y === centred.y, first)
  const middleOf = (g: { x: number; w: number }, width: number) => Math.abs(g.x + g.w / 2 - width / 2)

  // Resizing the browser: still in the middle, and nothing written.
  const before = await writes()
  for (const [w, h] of [[1600, 900], [1280, 720], [1000, 700], [800, 600]]) {
    await size(w, h)
    const g = await shown()
    check(`centred at ${w}x${h}`, middleOf(g, w) <= 2, { g })
  }
  const at740 = await (async () => { await size(740, 500); return shown() })()
  check('still centred at 740x500', middleOf(at740, 740) <= 2, at740)
  check('a resize is not an edit: nothing written to the widget set', (await writes()) === before, { before, after: await writes() })
  check('the saved place is untouched by shrinking', JSON.stringify(await place()) === JSON.stringify(original))

  // Expanding again (through another size) gives back exactly what was put.
  await size(1100, 760)
  await size(1920, 1080)
  const back = await shown()
  check('expanding restores the original place exactly', back.x === first.x && back.y === first.y, { back, first })

  // Reload at a different size: same share (hydration), and still no write.
  await size(1280, 720)
  const w0 = await writes()
  await load()
  const reloaded = await shown()
  check('after a reload at another size it is still centred', middleOf(reloaded, 1280) <= 2, reloaded)
  check('reloading wrote nothing and left the place alone', JSON.stringify(await place()) === JSON.stringify(original) && (await writes()) === w0)

  // The UI scale is a resize of the page too (125%: the page is 1024 wide at 1280).
  await evaluate(`(await import('/src/os/uiScale.ts')).uiScalePref.set(1.25)`)
  await sleep(700)
  const scaled = await shown()
  const pageW = await evaluate<number>(`(await import('/src/os/uiScale.ts')).viewW()`)
  check('a UI scale change keeps it centred in the page', middleOf(scaled, pageW) <= 2, { scaled, pageW })
  await evaluate(`(await import('/src/os/uiScale.ts')).uiScalePref.set(1)`)
  await sleep(700)

  // An edit that is not a move (minimize) at the resized screen keeps the screen the place was put on.
  await evaluate(`(() => { document.querySelector('[data-app="widget"] .note-grip').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 })) })()`)
  await sleep(200)
  const minimized = await evaluate<boolean>(`(() => { const item = [...document.querySelectorAll('.ctx-menu button')].find((e) => e.textContent?.startsWith('Minimize')); if (!item) return false; item.click(); return true })()`)
  await sleep(500)
  const afterMin = await place()
  check('minimizing at another size keeps where and for which screen it was put', minimized && afterMin.minimized === true && afterMin.x === original.x && afterMin.y === original.y && afterMin.vw === 1920 && afterMin.vh === 1080, afterMin)
  await evaluate(`(async () => { const m = await import('/src/os/widgetPlaces.ts'); m.widgetPlaces.set((s) => ({ ...s, places: Object.fromEntries(Object.entries(s.places).map(([k, v]) => [k, { ...v, minimized: undefined, at: v.at + 1 }])) })) })()`)
  await sleep(500)

  // A drag is an edit: it becomes the new place, on the screen it was made on.
  await load()
  const grip = await evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-app="widget"] .note-grip').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...grip, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 6; i++) { await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x + i * 20, y: grip.y, button: 'left', buttons: 1 }); await sleep(30) }
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip.x + 120, y: grip.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(500)
  const dragged = await place()
  const draggedShown = await shown()
  check('a drag saves the new place for the screen it was made on', dragged.vw === 1280 && dragged.vh === 720 && dragged.x === draggedShown.x && dragged.x !== original.x, { dragged, draggedShown })
  const b1 = widgetBounds({ w: dragged.w }, 1280, 720)
  const share = (dragged.x - b1.minX) / (b1.maxX - b1.minX)
  await size(1920, 1080)
  const g1 = await shown()
  const b2 = widgetBounds({ w: dragged.w }, 1920, 1080)
  check('after a drag, resizing keeps the new share', Math.abs((g1.x - b2.minX) / (b2.maxX - b2.minX) - share) < 0.01, { share, g1 })

  // Two widgets that collide on a small screen: the nudge is only shown, never saved.
  await evaluate(`(async () => {
    const { widgetPlaces } = await import('/src/os/widgetPlaces.ts')
    widgetPlaces.set((s) => ({ ...s, places: { ...s.places, b: { id: 'b', kind: 'status', x: ${centred.x} + 20, y: ${centred.y} + 20, w: 280, h: 200, vw: 1920, vh: 1080, at: 9 } } }))
  })()`)
  await load()
  await size(800, 600)
  const set = JSON.stringify(await evaluate(`(await import('/src/os/widgetPlaces.ts')).widgetPlaces.get()`))
  await size(1920, 1080)
  check('a collision nudge is a projection: the saved set is the same after resizing back', JSON.stringify(await evaluate(`(await import('/src/os/widgetPlaces.ts')).widgetPlaces.get()`)) === set)
  assert.deepEqual(p.errors, [])
  if (failed) throw new Error(`${failed} check(s) failed`)
  console.log('PASS widget resize: centre/edges, shrink-expand, reload, UI scale, collisions, explicit drag')
} finally {
  await browser?.close()
  vite.kill()
  await new Promise<void>((resolve) => (vite.exitCode !== null ? resolve() : vite.once('exit', () => resolve())))
  rmSync(data, { recursive: true, force: true })
}
