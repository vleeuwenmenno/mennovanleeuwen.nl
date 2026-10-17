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
    s.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; color: transparent !important; text-shadow: none !important } text, tspan { fill: transparent !important; stroke: transparent !important } body *:not(${only}, ${only} *) { visibility: hidden !important } ${only} { visibility: visible !important } html, body { background: #000 !important }'
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
  // Counted in real sleeps: the page's Date stands still with its clock.
  const ok = await page.eval<boolean>(`(async () => { for (let i = 0; i < ${Math.ceil(ms / 10)}; i++) { await __perf.settle(); if (${expr}) return true; await __perf.realSleep(10) } return false })()`)
  if (!ok) throw new Error(`Never happened: ${expr}`)
}

const MENU = `[...document.querySelectorAll('.ew-menu-btn')].some((b) => b.textContent.includes('Single player'))`

// --- A skirmish battle ---

/** A skirmish from the main menu to its first frames: our station placed, the battle started, on
 * the stepped clock from launch (seeded with `seed`). Returns the canvas's box. */
async function startSkirmish(page: Page, url: string, seed: number, setup?: object) {
  await page.send('Page.navigate', { url: `${url}/play/empires` })
  await page.waitFor(MENU)
  // The lobby as it was left: the map and seats to play, read when the skirmish setup opens.
  if (setup) await page.eval(`localStorage.setItem('mvlos.empires.lobby', ${JSON.stringify(JSON.stringify(setup))})`)
  await press(page, '.ew-menu-btn', 'Single player')
  await page.waitFor(`[...document.querySelectorAll('.ew-menu-btn')].some((b) => b.textContent.includes('Skirmish'))`)
  await press(page, '.ew-menu-btn', 'Skirmish')
  await page.waitFor(`!!document.querySelector('.ew-go')`)
  // From here the clock is ours: the battle starts on the stepped clock, its loop waiting for
  // the first stepped frame.
  await page.eval(`__perf.manual(${seed})`)
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
  return box
}

/** Two fleets of `n` craft in all, spawned through the sim in the middle of the map, attack-moving
 * at each other; the camera pans across the fight. */
function skirmish(n: number): Scene {
  return {
    name: `skirmish-${n}`,
    about: `Skirmish, ${n} ships fighting, camera panning`,
    async run(page, url) {
      await startSkirmish(page, url, n)
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

// --- Six admirals on a huge map ---

/** The first huge six-spawn map (maps.ts), every seat taken: you and five AI admirals, three
 * against three, all three factions. */
const HUGE_SETUP = {
  map: 'velkar',
  credits: 1600,
  slots: [0, 1, 2, 3, 4, 5].map((i) => ({ kind: i ? 'ai' : 'you', faction: ['republic', 'droid', 'swarm'][Math.floor(i / 2)], team: i % 2, difficulty: 'easy', profile: 'balanced' })),
}

/**
 * Six fleets on a huge map: a skirmish on Velkar Core with all six seats taken, 40 craft spawned
 * for each admiral on its side of the middle and sent at it, where they meet. The camera
 * starts zoomed all the way out, the whole map and its six bases on screen, then pans across the
 * fight zoomed in.
 */
const skirmishHuge: Scene = {
  name: 'skirmish-huge',
  about: 'Skirmish on a huge map, six admirals with 40 craft each, zoomed out then panning',
  async run(page, url) {
    await startSkirmish(page, url, 6, HUGE_SETUP)
    const spawned = await page.eval<number>(`(async () => {
      const sim = await import('/src/apps/games/empires/sim.ts')
      const data = await import('/src/apps/games/empires/data.ts')
      const w = __ew.world
      if (w.players.length !== 6) throw new Error('Not six players but ' + w.players.length)
      const cx = w.w / 2, cy = w.h / 2
      const MIX = [['fighter', .3], ['bomber', .1], ['gunship', .2], ['frigate', .2], ['cruiser', .12], ['capital', .08]]
      let made = 0
      w.players.forEach((p, o) => {
        const pre = data.FACTIONS[p.faction].prefix
        const dx = cx - p.start.x, dy = cy - p.start.y
        const d = Math.hypot(dx, dy) || 1
        // A block of ships on its way in, near the middle and facing it, so the six meet there.
        const bx = cx - (dx / d) * 1100, by = cy - (dy / d) * 1100
        let k = 0, got = 0
        for (const [kind, share] of MIX) {
          const id = pre + '-' + kind
          if (!data.UNIT[id]) continue
          let want = Math.max(1, Math.round(40 * share))
          while (want > 0 && got < 40) {
            const side = (k % 5 - 2) * 160, back = Math.floor(k / 5) * 160
            const us = sim.spawnGroup(w, id, o, bx - (dx / d) * back - (dy / d) * side, by - (dy / d) * back + (dx / d) * side, Math.atan2(dy, dx))
            want -= us.length
            got += us.length
            k++
          }
        }
        made += got
        const ids = w.units.filter((u) => !u.dead && u.owner === o && u.t.speed > 0 && !['station', 'mine', 'yard', 'defense'].includes(u.t.tier)).map((u) => u.id)
        sim.cmdMove(w, o, ids, cx, cy, true, false)
      })
      Object.assign(__ew.cam, { x: cx, y: cy, zoom: 0.01 })
      return made
    })()`)
    // Zoomed out over the whole map while the fleets set off (the zoom clamps to the map).
    await page.eval(`__perf.frames(30)`)
    const wide = await measure(page, 60)
    // Then on the fight in the middle as the fleets arrive, panning across it.
    await page.eval(`(() => { const w = __ew.world; Object.assign(__ew.cam, { x: w.w / 2 - 300, y: w.h / 2, zoom: Math.max(0.08, Math.min(1, document.querySelector('canvas.ew-canvas').clientWidth / 3000)) }) })()`)
    await page.eval(`__perf.frames(240)`)
    const fight = await measure(page, 60, `__ew.cam.x += 10`)
    const after = await page.eval<{ mb: number; nodes: number }>(`(async () => {
      const p = await import('/src/apps/games/empires/models/paint.ts')
      return { mb: p.cacheStats().mb, nodes: document.getElementsByTagName('*').length }
    })()`)
    await page.eval(`__perf.noText = true; __perf.frames(1)`)
    const shot = await canvasShot(page, 'canvas.ew-canvas')
    if (spawned < 6 * 40 * 0.9) throw new Error(`Only ${spawned} of 240 ships spawned`)
    const both: Raw = { counts: {}, frameMs: [...wide.frameMs, ...fight.frameMs], commitLog: [] }
    for (const r of [wide, fight]) for (const [k, v] of Object.entries(r.counts)) both.counts[k] = (both.counts[k] ?? 0) + v
    return {
      metrics: {
        ...canvasMetrics(both, 120),
        'zoomed out draw calls / frame': count(['fill', 'stroke', 'fillRect', 'strokeRect', 'drawImage', 'fillText', 'strokeText'].reduce((s, n) => s + (wide.counts[`on.${n}`] ?? 0) + (wide.counts[`off.${n}`] ?? 0), 0) / 60),
        'bitmap cache MB': count(after.mb),
        'React commits / sim s': commitsPerSec(both, 120),
        'DOM nodes': count(after.nodes),
        'main thread ms / frame': msPerFrame(both),
      },
      shots: { 'skirmish-huge': shot },
    }
  },
}

// --- A ground battle ---

/**
 * A ground battle (dev builds only, as the perf check's server is) on Dustfall Ridge, through the
 * space game's battle screen: three dozen vehicles of both sides driving across the low ground in
 * sight of each other, fog of war on, the camera panning over the terrain as they go. The ground is
 * on its own canvas under the battle canvas (groundKit's layer); the metrics are the battle canvas's.
 */
const groundBase: Scene = {
  name: 'ground-base',
  about: 'Ground battle on Dustfall Ridge, 36 vehicles driving over terrain, fog on, camera panning',
  async run(page, url) {
    await page.send('Page.navigate', { url: `${url}/play/empires` })
    await page.waitFor(MENU)
    // The lobby as it was left: a ground battle on Dustfall Ridge, the Republic against the droids.
    const setup = {
      mode: 'ground', groundMap: 'dustfall-ridge', map: 'vanth', credits: 2500,
      slots: [
        { kind: 'you', faction: 'republic', team: 0, difficulty: 'easy', profile: 'balanced' },
        { kind: 'ai', faction: 'droid', team: 1, difficulty: 'easy', profile: 'balanced' },
      ],
    }
    await page.eval(`localStorage.setItem('mvlos.empires.lobby', ${JSON.stringify(JSON.stringify(setup))})`)
    await press(page, '.ew-menu-btn', 'Single player')
    await page.waitFor(`[...document.querySelectorAll('.ew-menu-btn')].some((b) => b.textContent.includes('Skirmish'))`)
    await press(page, '.ew-menu-btn', 'Skirmish')
    // Ground battles load in the lobby (the Ground switch lights once they have).
    await page.waitFor(`[...document.querySelectorAll('.ew-seg button.is-on')].some((b) => b.textContent.includes('Ground')) && !!document.querySelector('.ew-go')`)
    await page.eval(`__perf.manual(11)`)
    await press(page, '.ew-go', 'Launch battle')
    // The terrain's pictures load in real time with the clock stopped.
    await settleUntil(page, `!!window.__ew && !!window.__ewGround && document.querySelector('canvas.ew-canvas')?.width === document.querySelector('canvas.ew-canvas')?.clientWidth`)
    await page.eval(`window.__ewGround.ready.then(() => (window.__groundReady = true))`)
    await settleUntil(page, `!!window.__groundReady`)
    const spawned = await page.eval<number>(`(async () => {
      const sim = await import('/src/apps/games/empires/sim.ts')
      const nav = await import('/src/apps/games/empires/ground/nav.ts')
      const w = __ew.world
      // Each side's own vehicle type (its engineer), 24 of ours and 12 of theirs in two blocks on
      // the low ground between the bases, ours sent across theirs.
      const typeOf = (o) => w.units.find((u) => u.owner === o && u.t.tier === 'vehicle').t
      const cx = w.w * 0.45, cy = w.h * 0.55
      let made = 0
      const block = (o, n, x0, y0) => {
        const t = typeOf(o)
        const ids = []
        for (let i = 0; i < 400 && ids.length < n; i++) {
          const x = x0 + (i % 8) * 56, y = y0 + Math.floor(i / 8) * 56
          if (nav.standsAt(w.ground.nav, t.ground.size, x, y)) ids.push(sim.spawn(w, t.id, o, x, y, 0).id)
        }
        made += ids.length
        return ids
      }
      const ours = block(0, 24, cx - 520, cy - 160)
      const theirs = block(1, 12, cx - 40, cy + 120)
      sim.cmdMove(w, 0, ours, cx + 500, cy, false)
      sim.cmdMove(w, 1, theirs, cx - 500, cy, false)
      Object.assign(__ew.cam, { x: cx - 300, y: cy, zoom: Math.max(0.3, Math.min(1, document.querySelector('canvas.ew-canvas').clientWidth / 2400)) })
      return made
    })()`)
    // The terrain bakes and the fog clears round the vehicles, then a second is measured while
    // the camera pans across them.
    await page.eval(`__perf.frames(120)`)
    const pan = await measure(page, 60, `__ew.cam.x += 10`)
    const after = await page.eval<{ mb: number; terrain: number; nodes: number }>(`(async () => {
      const p = await import('/src/apps/games/empires/models/paint.ts')
      return { mb: p.cacheStats().mb, terrain: (window.__ewGround.cacheBytes ?? 0) / 1048576, nodes: document.getElementsByTagName('*').length }
    })()`)
    await page.eval(`__perf.noText = true; __perf.frames(1)`)
    const shot = await canvasShot(page, 'canvas.ew-canvas')
    if (spawned < 36 * 0.9) throw new Error(`Only ${spawned} of 36 vehicles spawned`)
    return {
      metrics: {
        ...canvasMetrics(pan, 60),
        'bitmap cache MB': count(after.mb),
        'terrain cache MB': count(after.terrain),
        'React commits / sim s': commitsPerSec(pan, 60),
        'DOM nodes': count(after.nodes),
        'main thread ms / frame': msPerFrame(pan),
      },
      shots: { 'ground-base': shot },
    }
  },
}

// --- The ground layer ---

/**
 * The WebGL2 ground layer (ground/gl.ts) on Ashwater Crossing, alone on the page at 1280 × 720:
 * built once, then a second of frames panning across the river with the water moving. The canvas
 * counters don't see WebGL, so the scene counts GL draw calls and texture uploads itself.
 */
const groundLayer: Scene = {
  name: 'ground-layer',
  about: 'WebGL2 ground layer on Ashwater Crossing, panning over the river, water moving',
  async run(page, url) {
    await page.send('Page.navigate', { url: `${url}/play/empires` })
    await page.waitFor(MENU)
    await page.eval(`(async () => {
      const P = WebGL2RenderingContext.prototype
      window.__glCount = { draws: 0, uploads: 0 }
      for (const k of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        const f = P[k]
        P[k] = function (...a) { window.__glCount.draws++; return f.apply(this, a) }
      }
      for (const k of ['texImage2D', 'texSubImage2D']) {
        const f = P[k]
        P[k] = function (...a) { window.__glCount.uploads++; return f.apply(this, a) }
      }
      const { createGroundLayer } = await import('/src/apps/games/empires/ground/gl.ts')
      const { buildGroundMap } = await import('/src/apps/games/empires/ground/terrain.ts')
      const { GROUND_MAP } = await import('/src/apps/games/empires/ground/maps.ts')
      document.body.innerHTML = ''
      const layer = createGroundLayer()
      Object.assign(layer.canvas.style, { position: 'fixed', inset: '0', width: '1280px', height: '720px' })
      layer.canvas.id = 'perf-ground'
      document.body.appendChild(layer.canvas)
      const map = buildGroundMap(GROUND_MAP['ashwater-crossing'])
      layer.setMap(map)
      const view = { x: 1100, y: 1500, zoom: 0.8 }
      window.__groundLayer = { layer, view, frame: () => layer.draw(view, 1280, 720, 1, performance.now() / 1000) }
      ;(layer.ready ?? Promise.resolve()).then(() => (window.__groundLayerReady = true))
    })()`)
    await settleUntil(page, `!!window.__groundLayerReady`)
    const gl = await page.eval<boolean>(`window.__groundLayer.layer.gl`)
    await page.eval(`__perf.frames(10, () => window.__groundLayer.frame())`)
    await page.eval(`window.__glCount = { draws: 0, uploads: 0 }`)
    const pan = await measure(page, 60, `window.__groundLayer.view.x += 8; window.__groundLayer.frame()`)
    const counts = await page.eval<{ draws: number; uploads: number }>(`window.__glCount`)
    // A snapshot drawn and read in one go (a WebGL canvas keeps its picture only until the frame ends).
    const b64 = await page.eval<string>(`(() => {
      window.__groundLayer.frame()
      const c = document.createElement('canvas')
      c.width = ${SHOT_W}
      c.height = ${SHOT_H}
      const g = c.getContext('2d')
      g.imageSmoothingEnabled = true
      g.imageSmoothingQuality = 'high'
      g.drawImage(window.__groundLayer.layer.canvas, 0, 0, c.width, c.height)
      const d = g.getImageData(0, 0, c.width, c.height).data
      let s = ''
      for (let i = 0; i < d.length; i += 8192) s += String.fromCharCode.apply(null, d.subarray(i, i + 8192))
      return btoa(s)
    })()`)
    if (!gl) throw new Error('The ground layer fell back to flat: no WebGL2 in this browser')
    return {
      metrics: {
        'GL draw calls / frame': count(counts.draws / 60),
        'GL texture uploads / frame': count(counts.uploads / 60),
        ...canvasMetrics(pan, 60),
        'main thread ms / frame': msPerFrame(pan),
      },
      shots: { 'ground-layer': { width: SHOT_W, height: SHOT_H, data: new Uint8Array(Buffer.from(b64, 'base64')) } },
    }
  },
}

// --- A skirmish picked up again after a reload ---

/** The window sizes the resumed battle is looked at in: a laptop, a small window (the map and the
 * unit card side by side with little room), a big screen, and one too narrow for the map. */
const RESUME_SIZES = [
  [1000, 820],
  [900, 640],
  [1280, 720],
  [1920, 1080],
  [600, 900],
] as const

/**
 * A skirmish kept for the tab (the resume snapshot, saved as the page goes away) with engineers
 * selected, and the page reloaded into it: the battle comes back where it was. Then, at each of a
 * few window sizes, whatever is in the unit card is scrolled into view, as focusing a control in
 * it or finding a word on the page does. The battle screen never scrolls, and the panels laid out
 * round each other (the unit card beside the tactical map) settle: this once looped until React
 * gave up ("Maximum update depth exceeded", which fails the check as the page throwing).
 */
const skirmishResume: Scene = {
  name: 'skirmish-resume',
  about: 'Skirmish reloaded from its resume snapshot, engineers selected, at 5 window sizes',
  async run(page, url) {
    await startSkirmish(page, url, 5)
    // Engineers by our station, so the unit card shows them with their Build section (its tallest),
    // the camera on them, and one clicked: they're selected.
    const at = await page.eval<{ x: number; y: number } | null>(`(async () => {
      const sim = await import('/src/apps/games/empires/sim.ts')
      const w = __ew.world
      const p = w.players[0]
      const st = w.byId.get(p.station)
      const data = await import('/src/apps/games/empires/data.ts')
      const crew = sim.spawnGroup(w, data.FACTIONS[p.faction].prefix + '-engineer', 0, st.x + 300, st.y, 0)
      if (!crew.length) return null
      Object.assign(__ew.cam, { x: crew[0].x, y: crew[0].y, zoom: 0.8 })
      return { x: crew[0].x, y: crew[0].y }
    })()`)
    if (!at) throw new Error('No engineers to select')
    await page.eval(`__perf.frames(10)`)
    const spot = await page.eval<{ x: number; y: number }>(`(() => {
      const u = __ew.world.units.find((u) => !u.dead && u.owner === 0 && u.t.kind === 'engineer')
      const b = document.querySelector('canvas.ew-canvas').getBoundingClientRect()
      return { x: b.x + b.width / 2 + (u.x - __ew.cam.x) * __ew.cam.zoom, y: b.y + b.height / 2 + (u.y - __ew.cam.y) * __ew.cam.zoom }
    })()`)
    await page.click(spot.x, spot.y)
    await page.eval(`__perf.frames(30)`)
    if (await page.eval<boolean>(`!document.querySelector('.ew-engbuild')`)) throw new Error('The engineers were not selected')
    // The page goes away (the reload): the battle is kept for the tab, and comes back.
    await page.eval(`window.__stale = true`)
    await page.send('Page.reload')
    // Back on real time until the battle is up again (its loading may wait on frames), then the
    // stepped clock.
    await page.waitFor(`!window.__stale && !!window.__ew && document.querySelector('canvas.ew-canvas')?.width === document.querySelector('canvas.ew-canvas')?.clientWidth && !!document.querySelector('.ew-detailfloat')`)
    await page.eval(`__perf.manual(5)`)
    await page.eval(`__perf.frames(30)`)
    if (await page.eval<boolean>(`!document.querySelector('.ew-engbuild')`)) throw new Error('The battle did not come back with its engineers selected')
    let frames = 0
    let commits = 0
    let scrolled = 0
    let ms: number[] = []
    for (const [w, h] of RESUME_SIZES) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
      await page.eval(`__perf.frames(20)`)
      // What a focused control or a found word does: brought into view, by scrolling whatever can be.
      await page.eval(`(() => {
        const root = document.querySelector('.ew-battle')
        document.querySelector('.ew-engbuild')?.scrollIntoView({ block: 'start' })
        document.querySelector('.ew-detailfloat .ew-detail')?.scrollIntoView({ block: 'end', inline: 'end' })
        root.scrollTop = 400
        root.scrollLeft = 400
      })()`)
      const raw = await measure(page, 60)
      frames += 60
      commits += raw.counts.commits ?? 0
      ms = ms.concat(raw.frameMs)
      if (await page.eval<boolean>(`!document.querySelector('.ew-battle')`)) throw new Error(`The battle is gone at ${w}x${h}`)
      scrolled = Math.max(scrolled, await page.eval<number>(`(() => { const r = document.querySelector('.ew-battle'); return r.scrollTop + r.scrollLeft })()`))
    }
    return {
      metrics: {
        'React commits / sim s': count((commits * FPS) / frames),
        'battle screen scrolled px': strict(scrolled),
        'main thread ms / frame': { value: r2(mean(ms)), kind: 'time' },
      },
      shots: {},
    }
  },
}

// --- The galactic conquest map ---

/** A saved campaign (scripts/perf/fixtures), opened paused; the map zooms in and out with the wheel
 * and is dragged round a circle with the middle button. */
/** The galaxy map of fixture `which`, its clock stepped and held still. */
async function openGalaxy(page: Page, url: string, which: 'start' | 'late') {
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
}

/**
 * The orbit view (Orbit.tsx) of the late campaign's capital, with both yards and two armed defense
 * stations round it and its battle map pinned beside it (PlanetMap.tsx): the wheel zooms a little
 * out and back in, again and again, inside it (the panel fading and sliding with the zoom), then the
 * slow orbit on its own. Its pictures and the map are painted once on the way in, so neither paints
 * anything.
 */
const galaxyOrbit: Scene = {
  name: 'galaxy-orbit',
  about: 'Galaxy map, the orbit view of a planet with all its structures and its battle map: wheel zoom in it, then the orbit idling',
  async run(page, url) {
    await openGalaxy(page, url, 'late')
    await page.eval(`(() => {
      const g = window.__galaxy
      const p = g.planets.filter((x) => x.owner === 0 && x.station > 0).sort((a, b) => b.station - a.station)[0]
      p.station = 4
      p.base = { yards: { yard: 'up', cyard: 'up' }, mods: ['secondSlip', 'shieldCore', 'capitalSlip'], orb: [{ level: 3, mods: ['battery', 'flak', 'shield', 'hangar'] }, { level: 2, mods: ['launcher', null] }] }
      window.__gmap.enterOrbit(p.id)
    })()`)
    await page.eval(`__perf.frames(180)`)
    await page.eval(`(() => {
      const r = document.querySelector('.ew-gview').getBoundingClientRect()
      window.__wheel = (notch) => document.querySelector('.ew-gview').dispatchEvent(new WheelEvent('wheel', { deltaY: -notch, deltaMode: 0, clientX: r.left + r.width * 0.4, clientY: r.top + r.height * 0.4, bubbles: true, cancelable: true }))
    })()`)
    // Out a little and back in to the orbit view's closest, five notches at a time (it stays in it).
    const zoom = await measure(page, 100, `__wheel(Math.floor(i / 5) % 2 ? 12 : -12)`)
    await page.eval(`__perf.frames(120)`)
    const idle = await measure(page, 120)
    const dom = await page.eval<{ all: number; orbit: number; structs: number; map: number; placed: number }>(`(() => ({ all: document.getElementsByTagName('*').length, orbit: document.querySelectorAll('.ew-orbit *').length, structs: document.querySelectorAll('.ew-ostruct').length, map: document.querySelectorAll('.ew-pmap *').length, placed: document.querySelectorAll('.ew-pstruct').length }))()`)
    const shot = await pageShot(page, '.ew-gview', '.ew-gview')
    return {
      metrics: {
        'structures shown': strict(dom.structs),
        'orbit view DOM nodes': count(dom.orbit),
        'structures on the battle map': strict(dom.placed),
        'battle map DOM nodes': count(dom.map),
        'DOM nodes': count(dom.all),
        'React commits / sim s, zooming': commitsPerSec(zoom, 100),
        'React commits / sim s, idle': commitsPerSec(idle, 120),
        'canvas draw calls / frame, zooming': canvasMetrics(zoom, 100)['canvas draw calls / frame'],
        'new canvases / sim s, zooming': canvasMetrics(zoom, 100)['new canvases / sim s'],
        'new canvases / sim s, idle': canvasMetrics(idle, 120)['new canvases / sim s'],
        'main thread ms / frame, zooming': msPerFrame(zoom),
        'main thread ms / frame, idle': msPerFrame(idle),
      },
      shots: { 'galaxy-orbit': shot },
    }
  },
}

function galaxy(which: 'start' | 'late'): Scene {
  return {
    name: `galaxy-${which}`,
    about: `Galaxy map, ${which === 'start' ? 'a new campaign' : 'a late campaign'}: wheel zoom, then a drag pan`,
    async run(page, url) {
      await openGalaxy(page, url, which)
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
        return { all: document.getElementsByTagName('*').length, map: map.getElementsByTagName('*').length, filtered, blockades: map.querySelectorAll('.ew-gshield').length }
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

export const SCENES: Scene[] = [skirmish(200), skirmish(300), skirmishHuge, skirmishResume, groundBase, groundLayer, galaxy('start'), galaxy('late'), galaxyOrbit, desktop].map((s) => ({
  ...s,
  run: (page: Page, url: string) => ((current = s.name), s.run(page, url)),
}))
