// The scenes `pnpm check:perf` measures. Each is set up the same way every run (fixed seeds, the
// stepped clock from harness.js, a fixed camera path) and reports counts that don't depend on the
// machine: canvas calls per frame, canvases made, React commits, DOM nodes, timers. The main
// thread's time per frame is reported too, but only as a soft budget (machines differ).
import { readFileSync } from 'node:fs'
import type { Page } from './cdp.ts'
import { decodePng, type Image } from './png.ts'

/** count: a budget with headroom; strict: no more than now (a filter is never cheap: each new one
 * should be a decision); time: soft; info: shown, not budgeted. */
export type Metric = { value: number; kind: 'count' | 'strict' | 'time' | 'info' }
export type SceneResult = { metrics: Record<string, Metric>; shots: Record<string, Image> }
export type Scene = { name: string; about: string; run: (page: Page, url: string) => Promise<SceneResult> }

const FIXTURES = new URL('./fixtures/', import.meta.url)
/** Frames a second of the stepped clock. */
const FPS = 60
/** The pixel snapshots' size: small, so the baselines stay a few KB. */
const SHOT_W = 320
const SHOT_H = 180

type Raw = { counts: Record<string, number>; frameMs: number[]; commitLog: number[] }
/** The raw counters of every measured window, by scene, for `--json`. */
export const rawLog: Record<string, Raw[]> = {}
let current = ''
const r2 = (x: number) => Math.round(x * 100) / 100
const count = (value: number): Metric => ({ value: r2(value), kind: 'count' })
const strict = (value: number): Metric => ({ value: r2(value), kind: 'strict' })
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)

/** Canvas work per frame from the counters: what the frame drew, and what it drew off screen
 * (bitmap caches being filled). */
function canvasMetrics(raw: Raw, frames: number): Record<string, Metric> {
  const c = raw.counts
  const both = (...names: string[]) => names.reduce((s, n) => s + (c[`on.${n}`] ?? 0) + (c[`off.${n}`] ?? 0), 0)
  const off = (...names: string[]) => names.reduce((s, n) => s + (c[`off.${n}`] ?? 0), 0)
  const draws = ['fill', 'stroke', 'fillRect', 'strokeRect', 'drawImage', 'fillText', 'strokeText']
  return {
    'canvas draw calls / frame': count(both(...draws) / frames),
    'canvas drawImage / frame': count(both('drawImage') / frames),
    'canvas fill+stroke / frame': count(both('fill', 'stroke') / frames),
    'canvas save+restore / frame': count(both('save', 'restore') / frames),
    'canvas gradients / frame': count(both('createRadialGradient', 'createLinearGradient', 'createConicGradient', 'createPattern') / frames),
    'canvas filters+shadows / frame': strict(((c['set.filter'] ?? 0) + (c['set.shadowBlur'] ?? 0)) / frames),
    'canvas pixel reads / frame': count(both('getImageData') / frames),
    'offscreen draw calls / frame': count(off(...draws) / frames),
    'new canvases / sim s': count(((c.newCanvas ?? 0) * FPS) / frames),
  }
}

/** Steps `frames` frames with counting on (after `each` per frame), and reads the counters. */
async function measure(page: Page, frames: number, each = ''): Promise<Raw> {
  const r = await page.eval<Raw>(`(async () => {
    const each = ${each ? `(i) => { ${each} }` : 'null'}
    __perf.reset()
    __perf.count(true)
    await __perf.frames(${frames}, each)
    __perf.count(false)
    return __perf.read()
  })()`)
  ;(rawLog[current] ??= []).push(r)
  return r
}

const commitsPerSec = (raw: Raw, frames: number) => count(((raw.counts.commits ?? 0) * FPS) / frames)
const msPerFrame = (raw: Raw): Metric => ({ value: r2(mean(raw.frameMs)), kind: 'time' })

/** A canvas, scaled down to the snapshot size, as RGBA. */
async function canvasShot(page: Page, selector: string): Promise<Image> {
  const b64 = await page.eval<string>(`(() => {
    const src = document.querySelector(${JSON.stringify(selector)})
    const c = document.createElement('canvas')
    c.width = ${SHOT_W}
    c.height = ${SHOT_H}
    const g = c.getContext('2d')
    g.imageSmoothingEnabled = true
    g.imageSmoothingQuality = 'high'
    g.drawImage(src, 0, 0, c.width, c.height)
    const d = g.getImageData(0, 0, c.width, c.height).data
    let s = ''
    for (let i = 0; i < d.length; i += 8192) s += String.fromCharCode.apply(null, d.subarray(i, i + 8192))
    return btoa(s)
  })()`)
  return { width: SHOT_W, height: SHOT_H, data: new Uint8Array(Buffer.from(b64, 'base64')) }
}

/** A part of the page as the screen shows it, scaled down: only what's in `only` (the panels
 * round it are text, laid out in each machine's fonts), with its text hidden too, and animations
 * and transitions off (they run on real time). */
async function pageShot(page: Page, selector: string, only: string): Promise<Image> {
  const box = await page.eval<{ x: number; y: number; w: number; h: number }>(`(() => {
    const s = document.createElement('style')
    s.id = 'perf-shot'
    s.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; color: transparent !important; text-shadow: none !important } text, tspan { fill: transparent !important; stroke: transparent !important } body *:not(${only}, ${only} *) { visibility: hidden !important } ${only} { visibility: visible !important }'
    document.head.appendChild(s)
    const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()
    return { x: b.x, y: b.y, w: b.width, h: b.height }
  })()`)
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: SHOT_W / box.w } })
  await page.eval(`document.getElementById('perf-shot')?.remove()`)
  return decodePng(Buffer.from(data, 'base64'))
}

/** Clicks a button by its text with the page's own click(): no frames needed. */
const press = (page: Page, sel: string, text: string) =>
  page.eval(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); b.click() })()`)
/** Waits (in real time) until `expr` holds, with the clock stopped: what's loading (modules,
 * pictures) arrives in real time, and anything set to run at once runs, but no frame is drawn, so
 * what comes after starts at the same moment of the stepped clock however long loading took. */
async function settleUntil(page: Page, expr: string, ms = 60_000) {
  const ok = await page.eval<boolean>(`(async () => { const t0 = Date.now(); while (Date.now() - t0 < ${ms}) { await __perf.settle(); if (${expr}) return true; await __perf.realSleep(10) } return false })()`)
  if (!ok) throw new Error(`Never happened: ${expr}`)
}

const MENU = `[...document.querySelectorAll('.ew-menu-btn')].some((b) => b.textContent.includes('Single player'))`

// --- A skirmish battle ---

/** Two fleets of `n` craft in all, spawned through the sim in the middle of the map, attack-moving
 * at each other; the camera pans across the fight. */
function skirmish(n: number): Scene {
  return {
    name: `skirmish-${n}`,
    about: `Skirmish, ${n} ships fighting, camera panning`,
    async run(page, url) {
      await page.send('Page.navigate', { url: `${url}/play/empires` })
      await page.waitFor(MENU)
      await press(page, '.ew-menu-btn', 'Single player')
      await page.waitFor(`[...document.querySelectorAll('.ew-menu-btn')].some((b) => b.textContent.includes('Skirmish'))`)
      await press(page, '.ew-menu-btn', 'Skirmish')
      await page.waitFor(`!!document.querySelector('.ew-go')`)
      // From here the clock is ours: the battle starts on the stepped clock, its loop waiting for
      // the first stepped frame.
      await page.eval(`__perf.manual(${n})`)
      await press(page, '.ew-go', 'Launch battle')
      // Its art loads on the stepped clock; the loop starts by sizing the canvas to the page.
      await settleUntil(page, `!!window.__ew && document.querySelector('canvas.ew-canvas')?.width === document.querySelector('canvas.ew-canvas')?.clientWidth && !!document.querySelector('.ew-deploybox')`)
      await page.eval(`__perf.frames(2)`)
      // Our station: the first spot in the start area that takes it, clicked on the canvas.
      const box = await page.eval<{ x: number; y: number; w: number; h: number }>(`(() => { const b = document.querySelector('canvas.ew-canvas').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })()`)
      for (const [fx, fy] of [[0.5, 0.42], [0.45, 0.4], [0.55, 0.45], [0.5, 0.3], [0.4, 0.5], [0.6, 0.35]]) {
        await page.click(box.x + box.w * fx, box.y + box.h * fy)
        await page.eval(`__perf.frames(1)`)
        if (await page.eval(`!document.querySelector('.ew-deploybox .ew-go')?.disabled`)) break
      }
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + box.w / 2, y: box.y + 40 })
      await press(page, '.ew-deploybox .ew-go', 'Start battle')
      await page.eval(`__perf.frames(2)`)
      if (await page.eval(`!!document.querySelector('.ew-deploybox')`)) throw new Error('The battle did not start')
      const spawned = await page.eval<number>(`(async () => {
        const sim = await import('/src/apps/games/empires/sim.ts')
        const w = __ew.world
        const me = 0
        const foe = w.players.findIndex((p, i) => i !== me && p.team !== w.players[me].team)
        const cx = w.w / 2, cy = w.h / 2
        const MIX = {
          republic: [['r-fighter', .30], ['r-bomber', .10], ['r-gunship', .14], ['r-corvette', .08], ['r-frigate', .18], ['r-cruiser', .12], ['r-capital', .08]],
          droid: [['d-fighter', .30], ['d-bomber', .10], ['d-gunship', .14], ['d-ion', .06], ['d-frigate', .18], ['d-cruiser', .14], ['d-capital', .08]],
        }
        const per = ${n} / 2
        const place = (owner, side) => {
          let made = 0, row = 0, col = 0
          const cols = Math.max(4, Math.ceil(Math.sqrt(per)))
          for (const [id, share] of MIX[w.players[owner].faction]) {
            const want = Math.max(1, Math.round(per * share))
            let got = 0
            while (got < want && made < per) {
              const us = sim.spawnGroup(w, id, owner, cx + side * (380 + row * 150), cy + (col - cols / 2) * 150, side < 0 ? 0 : Math.PI)
              got += us.length
              made += us.length
              if (++col >= cols) (col = 0), row++
            }
          }
          return made
        }
        const made = place(me, -1) + place(foe, 1)
        for (const o of [me, foe]) {
          const ids = w.units.filter((u) => !u.dead && u.owner === o && u.t.speed > 0 && !['station', 'mine', 'yard', 'defense'].includes(u.t.tier)).map((u) => u.id)
          sim.cmdMove(w, o, ids, cx, cy, true, false)
        }
        Object.assign(__ew.cam, { x: cx - 300, y: cy, zoom: Math.max(0.08, Math.min(1, document.querySelector('canvas.ew-canvas').clientWidth / 3000)) })
        return made
      })()`)
      // The fleets close in (and the bitmap caches fill), then a second of the fight is measured
      // while the camera pans across it.
      await page.eval(`__perf.frames(150)`)
      const fight = await measure(page, 60, `__ew.cam.x += 10`)
      const after = await page.eval<{ mb: number; nodes: number; alive: number }>(`(async () => {
        const p = await import('/src/apps/games/empires/models/paint.ts')
        return { mb: p.cacheStats().mb, nodes: document.getElementsByTagName('*').length, alive: __ew.world.units.filter((u) => !u.dead).length }
      })()`)
      // The snapshot: the battlefield canvas, text left out.
      await page.eval(`__perf.noText = true; __perf.frames(1)`)
      const shot = n === 200 ? await canvasShot(page, 'canvas.ew-canvas') : null
      if (spawned < n * 0.9) throw new Error(`Only ${spawned} of ${n} ships spawned`)
      return {
        metrics: {
          ...canvasMetrics(fight, 60),
          'bitmap cache MB': count(after.mb),
          'React commits / sim s': commitsPerSec(fight, 60),
          'DOM nodes': count(after.nodes),
          'main thread ms / frame': msPerFrame(fight),
        },
        // One battle's snapshot is enough to see a ship drawn differently.
        shots: shot ? { [`skirmish-${n}`]: shot } : {},
      }
    },
  }
}

// --- The galactic conquest map ---

/** A saved campaign (scripts/perf/fixtures), opened paused; the map zooms in and out with the wheel
 * and is dragged round a circle with the middle button. */
function galaxy(which: 'start' | 'late'): Scene {
  return {
    name: `galaxy-${which}`,
    about: `Galaxy map, ${which === 'start' ? 'a new campaign' : 'a late campaign'}: wheel zoom, then a drag pan`,
    async run(page, url) {
      const save = readFileSync(new URL(`galaxy-${which}.json`, FIXTURES), 'utf8')
      await page.send('Page.navigate', { url: `${url}/play/empires` })
      await page.waitFor(MENU)
      await page.eval(`(() => {
        for (const k of Object.keys(localStorage)) if (k.includes('empires')) localStorage.removeItem(k)
        for (const [k, v] of Object.entries(${save})) localStorage.setItem(k, v)
        localStorage.setItem('mvlos.empires.muted', '1')
        window.__stale = true
      })()`)
      await page.send('Page.reload')
      await page.waitFor(`!window.__stale && ${MENU}`)
      await press(page, '.ew-menu-btn', 'Single player')
      await page.waitFor(`[...document.querySelectorAll('.ew-menu-btn')].some((b) => b.textContent.includes('Galactic conquest'))`)
      await press(page, '.ew-menu-btn', 'Galactic conquest')
      await page.waitFor(`[...document.querySelectorAll('.ew-menu-btn')].some((b) => b.textContent.includes('Continue'))`)
      // The stepped clock from before the galaxy opens: it never runs on its own.
      await page.eval(`__perf.manual(41)`)
      await press(page, '.ew-menu-btn', 'Continue')
      await settleUntil(page, `!!document.querySelector('.ew-gview svg') && !!document.querySelector('.ew-timectl button')`)
      await page.eval(`(() => { const b = document.querySelector('.ew-timectl button'); if (b.getAttribute('aria-label') === 'Pause') b.click() })()`)
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
      await page.eval(`__perf.frames(90)`)
      // The cursor on the system nearest the middle of the map, where the wheel zooms.
      await page.eval(`(() => {
        const r = document.querySelector('.ew-gview').getBoundingClientRect()
        const mid = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        const at = [...document.querySelectorAll('.ew-gsys-hit')].map((e) => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })
          .sort((a, b) => Math.hypot(a.x - mid.x, a.y - mid.y) - Math.hypot(b.x - mid.x, b.y - mid.y))[0]
        window.__at = at
        window.__wheel = (notch) => document.querySelector('.ew-gview').dispatchEvent(new WheelEvent('wheel', { deltaY: -notch, deltaMode: 0, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }))
      })()`)
      // Zooming: in for 72 frames (to about 18 times, past every step where the map shows more),
      // and back out.
      const zoom = await measure(page, 144, `__wheel(i < 72 ? 16 : -16)`)
      // Then in to where the systems open up, and a middle-button drag round a circle, a move a frame.
      await page.eval(`__perf.frames(90, (i) => i < 26 && __wheel(16))`)
      await page.eval(`(() => {
        const e = document.querySelector('.ew-gview'), r = e.getBoundingClientRect()
        window.__pan = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, o: (x, y, b) => ({ bubbles: true, cancelable: true, pointerId: 41, pointerType: 'mouse', isPrimary: true, button: 1, buttons: b, clientX: x, clientY: y }) }
        e.querySelector('svg').dispatchEvent(new PointerEvent('pointerdown', __pan.o(__pan.cx + 200, __pan.cy, 4)))
      })()`)
      const pan = await measure(page, 120, `const a = (2 * Math.PI * (i + 1)) / 120; window.dispatchEvent(new PointerEvent('pointermove', __pan.o(__pan.cx + Math.cos(a) * 200, __pan.cy + Math.sin(a) * 200, 4)))`)
      await page.eval(`window.dispatchEvent(new PointerEvent('pointerup', __pan.o(__pan.cx + 200, __pan.cy, 0))); __perf.frames(30)`)
      // What's on the map, and how much of it is drawn through a CSS filter (a pass of its own
      // each frame of a zoom).
      const dom = await page.eval<{ all: number; map: number; filtered: number; blockades: number }>(`(() => {
        const map = document.querySelector('.ew-gview')
        let filtered = 0
        for (const el of map.querySelectorAll('*')) {
          if (el.closest('[data-off]')) continue
          const s = getComputedStyle(el)
          if (s.display !== 'none' && ((s.filter && s.filter !== 'none') || (s.backdropFilter && s.backdropFilter !== 'none'))) filtered++
        }
        return { all: document.getElementsByTagName('*').length, map: map.getElementsByTagName('*').length, filtered, blockades: map.querySelectorAll('.ew-gblock').length }
      })()`)
      const shot = await pageShot(page, '.ew-gview', '.ew-gmap')
      return {
        metrics: {
          'React commits / sim s, zooming': commitsPerSec(zoom, 144),
          'React commits / sim s, panning': commitsPerSec(pan, 120),
          'map DOM nodes': count(dom.map),
          'DOM nodes': count(dom.all),
          'filtered map elements': strict(dom.filtered),
          'blockade rings': { value: dom.blockades, kind: 'info' },
          'canvas draw calls / frame, zooming': canvasMetrics(zoom, 144)['canvas draw calls / frame'],
          'new canvases / sim s, zooming': canvasMetrics(zoom, 144)['new canvases / sim s'],
          'main thread ms / frame, zooming': msPerFrame(zoom),
          'main thread ms / frame, panning': msPerFrame(pan),
        },
        shots: { [`galaxy-${which}`]: shot },
      }
    },
  }
}

// --- The desktop, idle ---

/** The desktop with its usual windows (terminal and notes) and a few apps opened, left alone: what
 * runs while nothing happens, shown and hidden. */
/** How long the desktop is watched, shown and then hidden, in frames: long enough for the slow
 * pollers (a minute hidden). */
const SHOWN = 20 * FPS
const HIDDEN = 60 * FPS
const desktop: Scene = {
  name: 'desktop-idle',
  about: 'Desktop with apps open, idle; then hidden',
  async run(page, url) {
    await page.send('Page.navigate', { url: `${url}/` })
    // Past the boot screen (a key skips it) to the desktop with its windows.
    await page.waitFor(`document.readyState === 'complete'`)
    for (let i = 0; i < 40 && !(await page.eval<boolean>(`document.querySelectorAll('.window').length >= 2`)); i++) {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await page.eval(`__perf.realSleep(250)`)
    }
    for (const app of ['settings', 'games', 'calendar']) await page.eval(`window.dispatchEvent(new CustomEvent('mvlos:open', { detail: ${JSON.stringify(app)} }))`)
    // Everything opened and settled, in real time; then the stepped clock.
    await page.eval(`__perf.realSleep(3000)`)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 700 })
    await page.eval(`__perf.manual(3)`)
    await page.eval(`__perf.frames(60)`)
    const shown = await measure(page, SHOWN)
    const live = await page.eval<{ intervals: number; timeouts: number; frameCallbacks: number }>(`__perf.liveTimers()`)
    const nodes = await page.eval<number>(`document.getElementsByTagName('*').length`)
    const windows = await page.eval<number>(`document.querySelectorAll('.window').length`)
    if (process.env.PERF_TIMERS) (rawLog[current] ??= []).push(await page.eval(`(() => { const t = window.__perfTimerFrom; window.__perfTimerFrom = {}; return t })()`))
    // Hidden, frames stop (as in a background tab); only timers run.
    await page.eval(`__perf.setHidden(true); __perf.frames(30)`)
    const hidden = await page.eval<Raw>(`(async () => {
      __perf.reset()
      __perf.count(true)
      await __perf.frames(${HIDDEN})
      __perf.count(false)
      return __perf.read()
    })()`)
    if (windows < 4) throw new Error(`Only ${windows} windows open on the desktop`)
    // With PERF_TIMERS=1: which timers fired, by where they were set (in --json's raw).
    if (process.env.PERF_TIMERS) (rawLog[current] ??= []).push(await page.eval(`window.__perfTimerFrom`))
    const fires = (raw: Raw, frames: number) => count((((raw.counts.intervalFires ?? 0) + (raw.counts.timeoutFires ?? 0)) * FPS) / frames)
    return {
      metrics: {
        'open windows': { value: windows, kind: 'info' },
        'DOM nodes': count(nodes),
        // An idle desktop draws nothing, and a hidden one does nothing: held exactly.
        'frame callbacks / frame': strict((shown.counts.rafCallbacks ?? 0) / SHOWN),
        'timer callbacks / s': fires(shown, SHOWN),
        'live intervals': count(live.intervals),
        'React commits / s': commitsPerSec(shown, SHOWN),
        'canvas draw calls / frame': canvasMetrics(shown, SHOWN)['canvas draw calls / frame'],
        'hidden: frame callbacks / frame': strict((hidden.counts.rafCallbacks ?? 0) / HIDDEN),
        'hidden: timer callbacks / s': strict(fires(hidden, HIDDEN).value),
        'hidden: React commits / s': strict(commitsPerSec(hidden, HIDDEN).value),
        'main thread ms / frame': msPerFrame(shown),
      },
      shots: {},
    }
  },
}

export const SCENES: Scene[] = [skirmish(200), skirmish(300), galaxy('start'), galaxy('late'), desktop].map((s) => ({
  ...s,
  run: (page: Page, url: string) => ((current = s.name), s.run(page, url)),
}))
