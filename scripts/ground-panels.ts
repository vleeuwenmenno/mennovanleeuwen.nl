// Checks a ground battle's panels against a running dev server, in headless Chromium: an engineer's
// Build cards, and a factory's Units and Upgrades pages, at 1280x720, 1000x820, 1920x1080 and a
// phone held upright and on its side. A panel fails when a card's name or price line is cut off, a card runs out of the panel
// (a row of cards may scroll sideways instead), or anything in it scrolls up and down.
// With a screenshot dir it also saves each panel, and the placement ghost of a Power Generator and of
// a Vehicle Factory (the exit row in front of a door only where units come out).
//
//   node scripts/ground-panels.ts [http://localhost:5173] [screenshot dir]
//
// Ground battles are dev builds only, so this needs a Vite dev server (the lobby's Ground switch).
import { mkdirSync, writeFileSync } from 'node:fs'
import { launch, newPage, sleep, type Page } from './perf/cdp.ts'

const URL_ = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '')
const OUT = process.argv[3] ?? ''
if (OUT) mkdirSync(OUT, { recursive: true })
const inject = `try { localStorage.setItem('mvlos.empires.muted', '1'); localStorage.setItem('mvlos.empires.music', '0') } catch {}`
const ALL: [number, number, boolean][] = [[1280, 720, false], [1000, 820, false], [1920, 1080, false], [390, 844, true], [740, 360, true]]
/** SIZE=1280x720 checks one size. */
const SIZES = process.env.SIZE ? ALL.filter(([w, h]) => `${w}x${h}` === process.env.SIZE) : ALL

const press = (page: Page, sel: string, text: string) =>
  page.eval(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); b.click() })()`)

async function startGround(page: Page) {
  await page.send('Page.navigate', { url: `${URL_}/play/empires` })
  await page.waitFor(`[...document.querySelectorAll('.ew-menu-btn')].some((b) => b.textContent.includes('Single player'))`)
  await press(page, '.ew-menu-btn', 'Single player')
  await page.waitFor(`[...document.querySelectorAll('.ew-menu-btn')].some((b) => b.textContent.includes('Skirmish'))`)
  await press(page, '.ew-menu-btn', 'Skirmish')
  await page.waitFor(`[...document.querySelectorAll('.ew-seg button')].some((b) => b.textContent.includes('Ground'))`)
  await press(page, '.ew-seg button', 'Ground')
  await page.waitFor(`[...document.querySelectorAll('.ew-seg button')].some((b) => b.textContent.includes('Ground') && b.classList.contains('is-on'))`)
  await sleep(500)
  await press(page, '.ew-go', 'Launch battle')
  await page.waitFor(`!!window.__ew && !!__ew.world.ground && !!document.querySelector('canvas.ew-canvas')`)
  await sleep(1500)
}

/** A Vehicle Factory raised beside our Command Center, kyber and research points to spend; our
 * engineer's and the factory's ids. */
const SETUP = `(async () => {
  const gw = await import('/src/apps/games/empires/ground/world.ts')
  const data = await import('/src/apps/games/empires/data.ts')
  const w = __ew.world
  const p = w.players[0]
  p.credits = 90000
  p.rp = 5000
  const ids = gw.groundIds(p.faction)
  const cc = w.units.find((u) => !u.dead && u.owner === 0 && u.t.id === ids.center)
  let fac = 0
  for (let dx = -16; dx <= 16 && !fac; dx += 2)
    for (let dy = -12; dy <= 12 && !fac; dy += 2) {
      if (Math.abs(dx) < 9 && Math.abs(dy) < 9) continue
      const pl = gw.groundPlacement(w, 0, ids.vfactory, cc.x + dx * 32, cc.y + dy * 32)
      if (!pl.why) fac = gw.raiseBuilding(w, data.UNIT[ids.vfactory], 0, pl.tc, pl.tr).id
    }
  const eng = w.units.find((u) => !u.dead && u.owner === 0 && u.t.id === ids.engineer).id
  return { eng, fac, cc: cc.id, generator: ids.generator, vfactory: ids.vfactory }
})()`

/** Puts the camera on unit `id` and clicks (taps) it until its card shows. */
async function select(page: Page, id: number, phone: boolean) {
  for (let i = 0; i < 4; i++) {
    await page.eval(`(() => { const u = __ew.world.byId.get(${id}); Object.assign(__ew.cam, { x: u.x, y: u.y, zoom: 0.8 }); return true })()`)
    await sleep(400)
    const spot = await page.eval<{ x: number; y: number }>(`(() => {
      const u = __ew.world.byId.get(${id})
      const b = document.querySelector('canvas.ew-canvas').getBoundingClientRect()
      return { x: b.x + b.width / 2 + (u.x - __ew.cam.x) * __ew.cam.zoom, y: b.y + b.height / 2 + (u.y - __ew.cam.y) * __ew.cam.zoom }
    })()`)
    if (phone) {
      await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: spot.x, y: spot.y }] })
      await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else await page.click(spot.x, spot.y)
    await sleep(800)
    if (await page.eval<boolean>(`(() => { const u = __ew.world.byId.get(${id}); const d = document.querySelector('.ew-detail'); return !!d && d.textContent.includes(u.t.name) })()`)) return true
  }
  return false
}

/** What's wrong with the panel on screen: names or price lines cut off, cards out of the panel, scrolling. */
const MEASURE = (phone: boolean) => `(() => {
  const d = document.querySelector('.ew-detail')
  if (!d) return { none: true }
  const db = d.getBoundingClientRect()
  const bad = []
  for (const e of [d, ...d.querySelectorAll('*')]) {
    const cs = getComputedStyle(e)
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 1) bad.push('scrolls: ' + String(e.className).slice(0, 40))
  }
  const cards = [...d.querySelectorAll('.ew-shipcard')]
  for (const c of cards) {
    const name = c.querySelector('strong')
    if (name && name.scrollWidth > name.clientWidth + 1) bad.push('name cut: ' + name.textContent)
    for (const l of c.querySelectorAll('.ew-yc-line, .ew-jobcost'))
      if (l.scrollWidth > l.clientWidth + 1) bad.push('price cut: ' + (name?.textContent ?? ''))
    for (const i of c.querySelectorAll('.ew-yc-line > span, .ew-jobcost > span')) {
      const r = i.getBoundingClientRect(), cr = c.getBoundingClientRect()
      if (r.right > cr.right + 0.5) bad.push('price runs out of its card: ' + (name?.textContent ?? ''))
    }
    const r = c.getBoundingClientRect()
    const row = c.closest('.ew-yard')
    const rb = row ? row.getBoundingClientRect() : db
    // A row of cards that scrolls sideways (a phone's, or the engineer's on a narrow panel) may hide
    // some to the right; otherwise every card shows whole.
    const sideways = !!row && ['auto', 'scroll'].includes(getComputedStyle(row).overflowX)
    if (r.bottom > Math.min(db.bottom, rb.bottom) + 1 || (!${phone} && !sideways && r.right > Math.min(db.right, rb.right) + 1)) bad.push('card cut off: ' + (name?.textContent ?? '') + ' (' + Math.round(r.width) + 'x' + Math.round(r.height) + ', ' + Math.round(db.bottom - r.top) + ' px of room below its top)')
  }
  return { w: Math.round(db.width), h: Math.round(db.height), cards: cards.length, bad, rect: { x: db.x, y: db.y, w: db.width, h: db.height } }
})()`

async function shot(page: Page, tag: string, clip: { x: number; y: number; width: number; height: number }) {
  if (!OUT) return
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } })
  writeFileSync(`${OUT}/${tag}.png`, Buffer.from(data, 'base64'))
}

async function main() {
  let failures = 0
  for (const [W, H, phone] of SIZES) {
    const b = await launch(W, H)
    const page = await newPage(b, W, H, inject)
    if (phone) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true })
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    }
    try {
      await startGround(page)
      const ids = await page.eval<{ eng: number; fac: number; cc: number; generator: string; vfactory: string }>(SETUP)
      const scenes: [string, number, string | null][] = [['engineer', ids.eng, null], ['factory-units', ids.fac, 'Units'], ['factory-upgrades', ids.fac, 'Buildings']]
      for (const [name, id, rail] of scenes) {
        const tag = `${name}-${W}x${H}`
        if (!(await select(page, id, phone))) {
          console.log(`FAIL ${tag}: couldn't select it`)
          failures++
          continue
        }
        if (rail) await page.eval(`(() => { const b = [...document.querySelectorAll('.ew-bp-rail button')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(rail)}); b?.click(); return !!b })()`)
        await sleep(500)
        const m = await page.eval<any>(MEASURE(phone))
        if (m.none) {
          console.log(`FAIL ${tag}: no panel`)
          failures++
          continue
        }
        const r = m.rect
        await shot(page, tag, { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.min(W - Math.max(0, r.x - 8), r.w + 16), height: Math.min(H - Math.max(0, r.y - 8), r.h + 16) })
        if (m.bad.length) failures++
        console.log(`${m.bad.length ? 'FAIL' : 'ok  '} ${tag}: ${m.w}x${m.h}, ${m.cards} cards${m.bad.length ? ': ' + [...new Set(m.bad)].join('; ') : ''}`)
      }
      // The placement ghosts, for the screenshots: a building that trains nothing has no exit row.
      if (OUT && !phone) {
        for (const unit of [ids.generator, ids.vfactory]) {
          await select(page, ids.eng, phone)
          const name = await page.eval<string>(`(async () => (await import('/src/apps/games/empires/data.ts')).UNIT[${JSON.stringify(unit)}].name)()`)
          await press(page, '.ew-engbuild button', name)
          await sleep(300)
          // Open ground below our Command Center, in the middle of the screen.
          const at = await page.eval<{ x: number; y: number }>(`(() => {
            const cc = __ew.world.byId.get(${ids.cc})
            Object.assign(__ew.cam, { x: cc.x, y: cc.y + 12 * 32, zoom: 1.2 })
            const b = document.querySelector('canvas.ew-canvas').getBoundingClientRect()
            return { x: b.x + b.width / 2, y: b.y + b.height * 0.35 }
          })()`)
          await sleep(300)
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
          await sleep(400)
          await shot(page, `ghost-${unit}-${W}x${H}`, { x: Math.max(0, at.x - 160), y: Math.max(0, at.y - 160), width: 320, height: 320 })
          await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
          await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
          await sleep(300)
        }
      }
      if (page.errors.length) console.log('errors', page.errors)
    } finally {
      await page.close()
      await b.close()
    }
  }
  console.log(failures ? `\n${failures} panel(s) failed` : '\nAll ground panels fit')
  process.exit(failures ? 1 : 0)
}

await main()
