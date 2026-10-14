// Checks that the battle's build panels fit their card against a running dev server, in headless
// Chromium: the Command Station, the Frigate Yard and the Capital Yard (ships and expansions pages),
// a yard under construction and a ruin tab, with one, two and three buildings, at 1280x720,
// 1000x820, 1440x900, 1920x1080, 2560x1440 and a phone. A panel fails when anything in it scrolls,
// a building tab wraps onto a second row, a card is cut off, its cards stand in one column with room
// for two, or two or three of them don't share a row where they would fit.
//
//   node scripts/empires-panel-fit.ts [http://localhost:5173] [screenshot dir]
//
// SIZE=1280x720 checks one size; a third argument picks the scenes whose name has it.
import { mkdirSync, writeFileSync } from 'node:fs'
import { launch, newPage, sleep, type Page } from './perf/cdp.ts'

const URL_ = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '')
const OUT = process.argv[3] ?? ''
const ONLY = process.argv[4]
if (OUT) mkdirSync(OUT, { recursive: true })
const inject = `try { localStorage.setItem('mvlos.empires.muted', '1'); localStorage.setItem('mvlos.empires.music', '0') } catch {}`
const press = (page: Page, sel: string, text: string) =>
  page.eval(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); b.click() })()`)

const ALL: [number, number, boolean][] = [[1280, 720, false], [1000, 820, false], [1440, 900, false], [1920, 1080, false], [2560, 1440, false], [390, 844, true]]
const SIZES = process.env.SIZE ? ALL.filter(([w, h]) => `${w}x${h}` === process.env.SIZE) : ALL

/** Our base: a Frigate Yard with two expansions, a Capital Yard (built), a Capital Yard going up at
 * 73%, and a Capital Yard's ruin; which of them exist is set per scene (see show). */
const SETUP = `(async () => {
  const sim = await import('/src/apps/games/empires/sim.ts')
  const data = await import('/src/apps/games/empires/data.ts')
  const w = __ew.world
  const p = w.players[0]
  p.credits = 90000
  p.level = 4
  const st = w.byId.get(p.station)
  const mid = Math.atan2(w.h / 2 - st.y, w.w / 2 - st.x)
  const at = (turn, d) => ({ x: st.x + Math.cos(mid + turn) * d, y: st.y + Math.sin(mid + turn) * d, a: mid + turn })
  const mk = (kind, turn, d) => { const q = at(turn, d); const y = sim.spawn(w, data.yardOf(p.faction, kind).id, 0, q.x, q.y, q.a); y.yq = []; return y }
  const fy = mk('yard', -0.9, 1000)
  fy.xm = ['drydock', 'secondSlip']
  fy.t = data.yardType(fy.t.id, fy.xm)
  fy.hps = fy.t.hardpoints.map((h) => ({ hp: h.hp, max: h.hp }))
  const cy = mk('cyard', 0.8, 1500)
  const site = mk('cyard', 0.8, 1500)
  delete site.yq
  site.site = { paid: 2000, started: true }
  site.building = site.t.build * 0.27
  site.hull = site.hullMax * 0.6
  const ruin = { id: 99999, owner: 0, unit: data.yardOf(p.faction, 'cyard').id, x: site.x, y: site.y, a: site.a }
  window.__base = { fy, cy, site, ruin, st }
  window.__show = (keys) => {
    const b = window.__base
    for (const k of ['fy', 'cy', 'site']) {
      const u = b[k]
      const on = keys.includes(k)
      if (on && u.dead) { u.dead = false; w.units.push(u); w.byId.set(u.id, u) }
      if (!on && !u.dead) { u.dead = true; w.units = w.units.filter((x) => x !== u); w.byId.delete(u.id) }
    }
    w.ruins = keys.includes('ruin') ? [b.ruin] : []
    return true
  }
  window.__show([])
  return { st: st.id, fy: fy.id, cy: cy.id, site: site.id }
})()`

/** Name, buildings shown, the one to select, and the page (localStorage) to open on. */
const SCENES: [string, string[], string, string | null][] = [
  ['1-station', [], 'st', null],
  ['2-station', ['fy'], 'st', null],
  ['2-frigate-ships', ['fy'], 'fy', 'ships'],
  ['2-frigate-expansions', ['fy'], 'fy', 'expansions'],
  ['3-station', ['fy', 'cy'], 'st', null],
  ['3-station-expansions', ['fy', 'cy'], 'st', 'station-expansions'],
  ['3-frigate-ships', ['fy', 'cy'], 'fy', 'ships'],
  ['3-frigate-expansions', ['fy', 'cy'], 'fy', 'expansions'],
  ['3-capital-ships', ['fy', 'cy'], 'cy', 'ships'],
  ['3-capital-expansions', ['fy', 'cy'], 'cy', 'expansions'],
  ['3-site-frigate', ['fy', 'site'], 'fy', 'ships'],
  ['3-site-capital', ['fy', 'site'], 'site', null],
  ['3-ruin-station', ['fy', 'ruin'], 'st', null],
  ['3-ruin-frigate', ['fy', 'ruin'], 'fy', 'ships'],
]

async function startBattle(page: Page) {
  await page.send('Page.navigate', { url: `${URL_}/play/empires` })
  await page.waitFor(`[...document.querySelectorAll('.ew-menu-btn')].some((b) => b.textContent.includes('Single player'))`)
  await press(page, '.ew-menu-btn', 'Single player')
  await page.waitFor(`[...document.querySelectorAll('.ew-menu-btn')].some((b) => b.textContent.includes('Skirmish'))`)
  await press(page, '.ew-menu-btn', 'Skirmish')
  await page.waitFor(`!!document.querySelector('.ew-go')`)
  await sleep(500)
  await press(page, '.ew-go', 'Launch battle')
  await page.waitFor(`!!window.__ew && !!document.querySelector('.ew-deploybox')`)
  await sleep(1200)
  const box = await page.eval<{ x: number; y: number; w: number; h: number }>(`(() => { const b = document.querySelector('canvas.ew-canvas').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })()`)
  for (const [fx, fy] of [[0.5, 0.42], [0.45, 0.4], [0.55, 0.45], [0.5, 0.3], [0.4, 0.5], [0.6, 0.35], [0.5, 0.5], [0.5, 0.65]]) {
    if (await page.eval(`!!document.querySelector('.ew-deploybox .ew-go') && !document.querySelector('.ew-deploybox .ew-go').disabled`)) break
    await page.click(box.x + box.w * fx, box.y + box.h * fy)
    await sleep(250)
  }
  for (let i = 0; i < 8 && (await page.eval(`!!document.querySelector('.ew-deploybox')`)); i++) {
    await page.eval(`(() => { const b = [...document.querySelectorAll('.ew-deploybox button')].find((e) => /Start/.test(e.textContent)); b?.click(); return !!b })()`)
    await sleep(600)
  }
}

async function select(page: Page, id: number, phone: boolean, zoom: number) {
  await page.eval(`(() => { const u = __ew.world.byId.get(${id}); Object.assign(__ew.cam, { x: u.x, y: u.y, zoom: ${zoom} }); return true })()`)
  await sleep(350)
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
}

/** What's wrong with the panel on screen: scrolling, wrapped tabs, cut-off cards, one column with room for two. */
const MEASURE = (phone: boolean) => `(() => {
  const d = document.querySelector('.ew-detailfloat .ew-detail')
  if (!d) return { none: true }
  const db = d.getBoundingClientRect()
  const bad = []
  for (const e of [d, ...d.querySelectorAll('*')]) {
    const cs = getComputedStyle(e)
    const isYard = e.classList.contains('ew-yard') || e.classList.contains('ew-bp-tabs')
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 1) bad.push('scrolls: ' + String(e.className).slice(0, 40))
    if (!(${phone} && isYard) && (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && e.scrollWidth > e.clientWidth + 1) bad.push('scrolls sideways: ' + String(e.className).slice(0, 40))
  }
  const tabs = [...d.querySelectorAll('.ew-basetabs > button')].map((b) => b.getBoundingClientRect())
  if (new Set(tabs.map((r) => Math.round(r.top))).size > 1) bad.push('tabs wrap onto ' + new Set(tabs.map((r) => Math.round(r.top))).size + ' rows')
  for (const r of tabs) if (r.right > db.right + 1) bad.push('a tab runs out of the card')
  const yard = d.querySelector('.ew-bp .ew-yard')
  const cards = yard ? [...yard.querySelectorAll('.ew-shipcard')].map((c) => c.getBoundingClientRect()) : []
  if (yard && !${phone}) {
    const yb = yard.getBoundingClientRect()
    const cut = cards.filter((r) => r.bottom > Math.min(yb.bottom, db.bottom) + 1 || r.right > Math.min(yb.right, db.right) + 1 || r.top < yb.top - 1)
    if (cut.length) bad.push(cut.length + ' card(s) cut off')
    const cols = new Set(cards.map((r) => Math.round(r.left))).size
    if (cards.length > 1 && cols === 1 && yb.width >= 2 * 66 + 4) bad.push('one column with room for two')
    // Two or three cards go side by side in one row, where there is room for them.
    if (cards.length > 1 && cards.length <= 3 && yb.width >= cards.length * 66 + (cards.length - 1) * 4 && new Set(cards.map((r) => Math.round(r.top))).size > 1) bad.push(cards.length + ' cards on more than one row')
  }
  return { w: Math.round(db.width), h: Math.round(db.height), cards: cards.length, bad, rect: { x: db.x, y: db.y, w: db.width, h: db.height } }
})()`

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
      await startBattle(page)
      const ids = await page.eval<Record<string, number>>(SETUP)
      for (const [name, show, key, pg] of SCENES) {
        if (ONLY && !name.includes(ONLY)) continue
        await page.eval(`window.__show(${JSON.stringify(show)})`)
        if (pg === 'ships' || pg === 'expansions') await page.eval(`localStorage.setItem('mvlos.empires.yardpage2', ${JSON.stringify(pg)})`)
        await page.eval(`localStorage.setItem('mvlos.empires.yardpage', ${JSON.stringify(pg === 'station-expansions' ? 'expansions' : 'strike')})`)
        // Something else first, so the panel opens afresh on the page set above.
        await select(page, ids.st, phone, 0.25)
        await page.eval(`(() => { const st = __ew.world.byId.get(${ids.st}); return true })()`)
        const away = await page.eval<number>(`__ew.world.units.find((u) => !u.dead && u.owner === 0 && u.t.tier === 'gunship')?.id ?? 0`)
        if (away) await select(page, away, phone, 0.6)
        await select(page, ids[key], phone, key === 'st' ? 0.6 : 0.3)
        const m = await page.eval<any>(MEASURE(phone))
        const tag = `${name}-${W}x${H}`
        if (m.none) {
          console.log(`FAIL ${tag}: no panel`)
          failures++
          continue
        }
        const r = m.rect
        const top = Math.max(0, r.y - 50)
        const clip = { x: Math.max(0, r.x - 8), y: top, width: Math.min(W - Math.max(0, r.x - 8), r.w + 16), height: Math.min(H - top, r.y - top + r.h + 8), scale: 1 }
        const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip })
        if (OUT) writeFileSync(`${OUT}/${tag}.png`, Buffer.from(data, 'base64'))
        if (m.bad.length) failures++
        console.log(`${m.bad.length ? 'FAIL' : 'ok  '} ${tag}: ${m.w}x${m.h}, ${m.cards} cards${m.bad.length ? ': ' + m.bad.join('; ') : ''}`)
      }
      if (page.errors.length) console.log('errors', page.errors)
    } finally {
      await page.close()
      await b.close()
    }
  }
  console.log(failures ? `${failures} panel(s) don't fit` : 'every panel fits')
  process.exit(failures ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
