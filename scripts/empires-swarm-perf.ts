// A big mixed battle with the Swarm in it, measured the way `pnpm check:perf` measures its skirmish
// scenes (headless Chromium, the stepped clock from scripts/perf/harness.js): main-thread ms per
// frame, canvas draw calls and the bitmap cache, at the default zoom and zoomed right in. The same
// battle is run with the Republic, and with the Confederacy (a mirror), in the Swarm's place to compare.
//
//   node scripts/empires-swarm-perf.ts [ships]     (default 200)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { launch, newPage, type Page } from './perf/cdp.ts'
import { startServer } from './perf/server.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const HARNESS = readFileSync(new URL('./perf/harness.js', import.meta.url), 'utf8')
const [VW, VH] = [1280, 720]
const N = Number(process.argv[2] ?? 200)

const MIX: Record<string, [string, number][]> = {
  swarm: [['s-fighter', 0.3], ['s-bomber', 0.1], ['s-gunship', 0.14], ['s-corvette', 0.08], ['s-frigate', 0.18], ['s-cruiser', 0.12], ['s-capital', 0.08]],
  republic: [['r-fighter', 0.3], ['r-bomber', 0.1], ['r-gunship', 0.14], ['r-corvette', 0.08], ['r-frigate', 0.18], ['r-cruiser', 0.12], ['r-capital', 0.08]],
  droid: [['d-fighter', 0.3], ['d-bomber', 0.1], ['d-gunship', 0.14], ['d-ion', 0.06], ['d-frigate', 0.18], ['d-cruiser', 0.14], ['d-capital', 0.08]],
}

const press = (page: Page, sel: string, text: string) =>
  page.eval(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); b.click() })()`)

async function settleUntil(page: Page, expr: string, ms = 60_000) {
  const ok = await page.eval<boolean>(`(async () => { for (let i = 0; i < ${Math.ceil(ms / 10)}; i++) { await __perf.settle(); if (${expr}) return true; await __perf.realSleep(10) } return false })()`)
  if (!ok) throw new Error(`Never happened: ${expr}`)
}

/** Steps `frames` frames and returns the mean main-thread ms per frame and the draw calls. */
async function measure(page: Page, frames: number, each = '') {
  return page.eval<{ ms: number; draws: number }>(`(async () => {
    const each = ${each ? `(i) => { ${each} }` : 'null'}
    __perf.reset(); __perf.count(true)
    await __perf.frames(${frames}, each)
    __perf.count(false)
    const r = __perf.read()
    const c = r.counts
    const draws = ['fill', 'stroke', 'fillRect', 'strokeRect', 'drawImage', 'fillText', 'strokeText'].reduce((s, n) => s + (c['on.' + n] ?? 0) + (c['off.' + n] ?? 0), 0)
    return { ms: r.frameMs.reduce((a, b) => a + b, 0) / r.frameMs.length, draws: draws / ${frames} }
  })()`)
}

async function battle(page: Page, url: string, side: string) {
  await page.send('Page.navigate', { url: `${url}/play/empires` })
  await page.waitFor(`[...document.querySelectorAll('.ew-menu-btn')].some((b) => b.textContent.includes('Single player'))`)
  await page.eval(`localStorage.setItem('mvlos.empires.muted', '1'); localStorage.setItem('mvlos.empires.music', '0')`)
  await press(page, '.ew-menu-btn', 'Single player')
  await page.waitFor(`[...document.querySelectorAll('.ew-menu-btn')].some((b) => b.textContent.includes('Skirmish'))`)
  await press(page, '.ew-menu-btn', 'Skirmish')
  await page.waitFor(`!!document.querySelector('.ew-go')`)
  await page.eval(`__perf.manual(7)`)
  await press(page, '.ew-go', 'Launch battle')
  await settleUntil(page, `!!window.__ew && document.querySelector('canvas.ew-canvas')?.width === document.querySelector('canvas.ew-canvas')?.clientWidth && !!document.querySelector('.ew-deploybox')`)
  await page.eval(`__perf.frames(2)`)
  const box = await page.eval<{ x: number; y: number; w: number; h: number }>(`(() => { const b = document.querySelector('canvas.ew-canvas').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })()`)
  for (const [fx, fy] of [[0.5, 0.42], [0.45, 0.4], [0.55, 0.45], [0.5, 0.3], [0.4, 0.5], [0.6, 0.35]]) {
    await page.click(box.x + box.w * fx, box.y + box.h * fy)
    await page.eval(`__perf.frames(1)`)
    if (await page.eval(`!document.querySelector('.ew-deploybox .ew-go')?.disabled`)) break
  }
  await press(page, '.ew-deploybox .ew-go', 'Start battle')
  await page.eval(`__perf.frames(2)`)
  await page.eval(`(async () => {
    const sim = await import('/src/apps/games/empires/sim.ts')
    const w = __ew.world
    const MIX = ${JSON.stringify(MIX)}
    const cx = w.w / 2, cy = w.h / 2
    const per = ${N} / 2
    const place = (owner, mix, s) => {
      let made = 0, row = 0, col = 0
      const cols = Math.max(4, Math.ceil(Math.sqrt(per)))
      for (const [id, share] of mix) {
        const want = Math.max(1, Math.round(per * share))
        let got = 0
        while (got < want && made < per) {
          const us = sim.spawnGroup(w, id, owner, cx + s * (380 + row * 150), cy + (col - cols / 2) * 150, s < 0 ? 0 : Math.PI)
          got += us.length; made += us.length
          if (++col >= cols) (col = 0), row++
        }
      }
    }
    place(0, MIX[${JSON.stringify(side)}], -1)
    place(1, MIX.droid, 1)
    for (const o of [0, 1]) sim.cmdMove(w, o, w.units.filter((u) => !u.dead && u.owner === o && u.t.speed > 0 && !['station', 'mine', 'yard', 'defense'].includes(u.t.tier)).map((u) => u.id), cx, cy, true, false)
    Object.assign(__ew.cam, { x: cx - 300, y: cy, zoom: Math.max(0.08, Math.min(1, document.querySelector('canvas.ew-canvas').clientWidth / 3000)) })
  })()`)
  await page.eval(`__perf.frames(150)`)
  const wide = await measure(page, 60, `__ew.cam.x += 10`)
  await page.eval(`Object.assign(__ew.cam, { zoom: 1.6 }); __perf.frames(60)`)
  const close = await measure(page, 60, `__ew.cam.x += 2`)
  const mb = await page.eval<number>(`(async () => (await import('/src/apps/games/empires/models/paint.ts')).cacheStats().mb)()`)
  return { wide, close, mb }
}

const { url, server } = await startServer(ROOT)
const browser = await launch(VW, VH)
try {
  for (const side of ['republic', 'swarm', 'droid']) {
    const page = await newPage(browser, VW, VH, HARNESS)
    const r = await battle(page, url, side)
    console.log(`${side} v droid, ${N} ships: default zoom ${r.wide.ms.toFixed(2)} ms/frame, ${r.wide.draws.toFixed(0)} draws; max zoom ${r.close.ms.toFixed(2)} ms/frame, ${r.close.draws.toFixed(0)} draws; cache ${r.mb.toFixed(1)} MB${page.errors.length ? `; page errors: ${page.errors.slice(0, 2).join(' | ')}` : ''}`)
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
