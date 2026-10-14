// Checks that the battle's build panels fit their card against a running dev server, in headless
// Chromium: the Command Station, the Frigate Yard and the Capital Yard (ships and expansions pages),
// a yard under construction and a ruin tab, with one, two and three buildings, at 1280x720,
// 1000x820, 1440x900, 1920x1080, 2560x1440 and a phone. A panel fails when anything in it scrolls,
// a building tab wraps onto a second row, a card is cut off, its cards stand in one column with room
// for two, or two or three of them don't share a row where they would fit.
//
// Unit cards too: a gunship, a frigate, engineers with their build cards, an escorted flagship, a
// rushed cruiser and a mine with its upgrades must not scroll; and at 1440x900 and up the simple ones
// (the gunship and the frigate) must show their description and role line (see useFitLines).
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
  // Unit cards: a gunship, a frigate, engineers, a flagship escorted by three gunships, a cruiser
  // rush-launched (by hand: hull, parts not yet installed) and a mine with an upgrade.
  const far = (turn, d) => at(turn, d)
  const g = far(-2.2, 700)
  const gun = sim.spawn(w, p.faction === 'droid' ? 'd-gunship' : 'r-gunship', 0, g.x, g.y, g.a)
  const f = far(-1.6, 900)
  const frig = sim.spawn(w, p.faction === 'droid' ? 'd-frigate' : 'r-frigate', 0, f.x, f.y, f.a)
  const e = far(-1.9, 450)
  const eng = sim.spawnGroup(w, p.faction === 'droid' ? 'd-engineer' : 'r-engineer', 0, e.x, e.y, 0)
  const fa = far(0.1, 2600)
  const flag = sim.spawn(w, p.faction === 'droid' ? 'd-capital' : 'r-capital', 0, fa.x, fa.y, fa.a)
  flag.hull = flag.hullMax * 0.6
  const esc = [0, 1, 2].map((i) => sim.spawn(w, p.faction === 'droid' ? 'd-gunship' : 'r-gunship', 0, fa.x + 300 + i * 80, fa.y + 700, 0))
  sim.cmdGuard(w, 0, esc.map((u) => u.id), flag.id)
  const ra = far(-0.3, 2000)
  const cr = sim.spawn(w, p.faction === 'droid' ? 'd-cruiser' : 'r-cruiser', 0, ra.x, ra.y, ra.a)
  const parts = cr.t.hardpoints.map((h, i) => (h.kind !== 'engine' ? i : -1)).filter((i) => i >= 0).slice(-3)
  for (const i of parts) cr.hps[i].hp = 0
  cr.hull = cr.hullMax * 0.55
  cr.rush = { left: 14, total: 14, gap: cr.hullMax * 0.45, parts, n: parts.length, work: false }
  const n = [...w.nodes].sort((a, b) => Math.hypot(a.x - st.x, a.y - st.y) - Math.hypot(b.x - st.x, b.y - st.y))[0]
  n.owner = p.team
  const m = sim.spawn(w, p.faction === 'droid' ? 'd-mine' : 'r-mine', 0, n.x, n.y, n.rot)
  n.site = m.id
  m.node = n.id
  m.upg = { yield: 1 }
  m.hull = m.hullMax * 0.7
  return { st: st.id, fy: fy.id, cy: cy.id, site: site.id, gun: gun.id, frig: frig.id, eng: eng[0].id, flag: flag.id, rush: cr.id, mine: m.id }
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
  // Unit cards (with three buildings, so the engineers' yards are built or going up).
  ['unit-gunship', ['fy', 'cy'], 'gun', null],
  ['unit-frigate', ['fy', 'cy'], 'frig', null],
  ['unit-engineers', ['fy', 'site'], 'eng', null],
  ['unit-flagship', ['fy', 'cy'], 'flag', null],
  ['unit-rushed', ['fy', 'cy'], 'rush', null],
  ['unit-mine', ['fy', 'cy'], 'mine', null],
]
/** Unit cards that must show their description and role line on a big enough window. */
const SIMPLE = ['unit-gunship', 'unit-frigate']

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

/** Selects unit `id` with a click (a tap on a phone) on it: on its middle, or failing that (a small
 * craft flying over it took the click) further along its hull, until its card is the one showing. */
async function select(page: Page, id: number, phone: boolean, zoom: number) {
  await page.eval(`(() => { const u = __ew.world.byId.get(${id}); Object.assign(__ew.cam, { x: u.x, y: u.y, zoom: ${zoom} }); return true })()`)
  await sleep(350)
  for (const along of [0, -0.3, 0.3, -0.15, 0.15]) {
    const spot = await page.eval<{ x: number; y: number }>(`(() => {
      const u = __ew.world.byId.get(${id})
      const b = document.querySelector('canvas.ew-canvas').getBoundingClientRect()
      const d = u.t.size * ${along}
      const x = u.x + Math.cos(u.a) * d, y = u.y + Math.sin(u.a) * d
      return { x: b.x + b.width / 2 + (x - __ew.cam.x) * __ew.cam.zoom, y: b.y + b.height / 2 + (y - __ew.cam.y) * __ew.cam.zoom }
    })()`)
    if (phone) {
      await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: spot.x, y: spot.y }] })
      await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else await page.click(spot.x, spot.y)
    await sleep(800)
    if (await page.eval<boolean>(`(() => { const u = __ew.world.byId.get(${id}); const d = document.querySelector('.ew-detailfloat'); return !!d && d.textContent.includes(u.t.name) })()`)) return
  }
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
  const shown = (sel) => { const e = d.querySelector(sel); return !!e && !e.hidden && e.getClientRects().length > 0 }
  return { w: Math.round(db.width), h: Math.round(db.height), cards: cards.length, bad, desc: shown('.ew-fit-desc'), role: shown('.ew-fit-role'), rect: { x: db.x, y: db.y, w: db.width, h: db.height } }
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
        await select(page, ids[key], phone, key === 'st' ? 0.6 : key === 'flag' ? 0.15 : key === 'eng' || key === 'gun' ? 0.8 : 0.3)
        const m = await page.eval<any>(MEASURE(phone))
        const tag = `${name}-${W}x${H}`
        if (!m.none && SIMPLE.includes(name) && W >= 1440 && !(m.desc && m.role)) m.bad.push(`the ${m.desc ? '' : 'description'}${!m.desc && !m.role ? ' and ' : ''}${m.role ? '' : 'role line'} hidden with room to spare`)
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
        const text = name.startsWith('unit-') ? `, text: ${m.desc ? 'description' : '-'}/${m.role ? 'role' : '-'}` : ''
        console.log(`${m.bad.length ? 'FAIL' : 'ok  '} ${tag}: ${m.w}x${m.h}, ${m.cards} cards${text}${m.bad.length ? ': ' + m.bad.join('; ') : ''}`)
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
