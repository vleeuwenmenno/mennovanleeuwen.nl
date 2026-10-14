// Checks that Empires At War keeps its floating GUI inside the screen, against a running dev server,
// in headless Chromium, at 1280x720, 1000x820, 1920x1080, 2560x1440 and a phone:
//
//   1. Every floating panel (the tactical map, the unit card or build panel, the selection) is on
//      the screen.
//   2. Tooltips of the HUD's buttons nearest the screen's edges (the bottom cards, the map's
//      buttons, the top bar's ends) stay 8 px or more inside it.
//   3. The tactical map dragged into the bottom right corner stays on the screen, and stays on it
//      when the window is then made smaller.
//   4. The tech tree window fits.
//   5. On the phone: the action wheel opened in each corner of the battlefield is all on the screen.
//
//   node scripts/empires-gui-fit.ts [http://localhost:5173] [screenshot dir]
//
// SIZE=1280x720 checks one size. Exits 1 on any failure.
import { mkdirSync, writeFileSync } from 'node:fs'
import { launch, newPage, sleep, type Page } from './perf/cdp.ts'

const URL_ = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '')
const OUT = process.argv[3] ?? ''
if (OUT) mkdirSync(OUT, { recursive: true })
const inject = `try { localStorage.setItem('mvlos.empires.muted', '1'); localStorage.setItem('mvlos.empires.music', '0') } catch {}`
const press = (page: Page, sel: string, text: string) =>
  page.eval(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); b.click() })()`)

const ALL: [number, number, boolean][] = [[1280, 720, false], [1000, 820, false], [1920, 1080, false], [2560, 1440, false], [390, 844, true]]
const SIZES = process.env.SIZE ? ALL.filter(([w, h]) => `${w}x${h}` === process.env.SIZE) : ALL
const EDGE = 8

let failures = 0
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures++
}

type R = { x: number; y: number; w: number; h: number }
/** How far a box sticks out past the screen less `m` on each side (0 when it doesn't). */
const out = (r: R, W: number, H: number, m: number) => Math.max(0, m - r.x, m - r.y, r.x + r.w - (W - m), r.y + r.h - (H - m))
const fmtR = (r: R) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}`

async function shot(page: Page, name: string, clip?: R) {
  if (!OUT) return
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 1 } } : {}) })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'))
}

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
  const box = await page.eval<R>(`(() => { const b = document.querySelector('canvas.ew-canvas').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })()`)
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

/** Every floating panel showing, with its box. */
const FLOATS = `[...document.querySelectorAll('.ew-float')].filter((e) => e.getClientRects().length && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden').map((e) => { const b = e.getBoundingClientRect(); return { cls: String(e.className).replace(/\\s+/g, ' ').slice(0, 40), x: b.x, y: b.y, w: b.width, h: b.height } }).filter((r) => r.w > 0 && r.h > 0)`

/** The HUD's elements with a tooltip nearest each edge of the screen, at most `n`. */
const TIPPED = (n: number) => `(() => {
  const W = innerWidth, H = innerHeight
  const all = [...document.querySelectorAll('.ew-battle [data-tip]')].map((e) => ({ e, b: e.getBoundingClientRect() }))
    .filter(({ e, b }) => b.width > 4 && b.height > 4 && b.x >= 0 && b.y >= 0 && b.right <= W && b.bottom <= H && !e.closest('.ew-tip') && !e.closest('.ew-devbtn, [data-dev]') && e.textContent.trim() !== 'DEV')
    .filter(({ e, b }) => { const at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return !!at && (at === e || e.contains(at) || at.closest('[data-tip]') === e) })
  const near = (f) => [...all].sort((a, b) => f(a.b) - f(b.b))
  const pick = [...near((b) => H - b.bottom).slice(0, ${n} - 4), ...near((b) => b.x).slice(0, 1), ...near((b) => W - b.right).slice(0, 1), ...near((b) => b.y).slice(0, 1), ...near((b) => Math.min(b.x, W - b.right) + (H - b.bottom)).slice(0, 1)]
  return [...new Set(pick)].map(({ e, b }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2, label: (e.getAttribute('aria-label') || e.textContent || e.className).trim().replace(/\\s+/g, ' ').slice(0, 28) }))
})()`

const TIP = `(() => { const t = document.querySelector('.ew-tip'); if (!t || getComputedStyle(t).visibility === 'hidden') return null; const b = t.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })()`

async function hover(page: Page, x: number, y: number) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, buttons: 0 })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 10; i++)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10, button: 'left', buttons: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
}

async function main() {
  for (const [W, H, phone] of SIZES) {
    const tag = `${W}x${H}`
    const b = await launch(W, H)
    const page = await newPage(b, W, H, inject)
    const metrics = (w: number, h: number) =>
      page.send('Emulation.setDeviceMetricsOverride', phone ? { width: w, height: h, deviceScaleFactor: 2, mobile: true } : { width: w, height: h, deviceScaleFactor: 1, mobile: false })
    if (phone) {
      await metrics(W, H)
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    }
    try {
      await startBattle(page)
      // The Command Station selected: the build panel is the biggest card there is.
      await page.eval(`(() => { const w = __ew.world; const st = w.byId.get(w.players[0].station); Object.assign(__ew.cam, { x: st.x, y: st.y, zoom: 0.5 }); return true })()`)
      await sleep(400)
      if (!phone) await page.click(W / 2, H / 2)
      await sleep(900)

      // 1. Panels.
      const floats = await page.eval<(R & { cls: string })[]>(FLOATS)
      for (const f of floats) check(`${tag}: panel ${f.cls} is on the screen`, out(f, W, H, 0) <= 0.5, fmtR(f))
      await shot(page, `hud-${tag}`)

      // 2. Tooltips near the edges.
      if (!phone) {
        const spots = await page.eval<{ x: number; y: number; label: string }[]>(TIPPED(10))
        let shown = 0
        let lowest: { y: number; label: string } | null = null
        for (const s of spots) {
          await hover(page, 1, 1)
          await sleep(120)
          await hover(page, s.x, s.y)
          await sleep(650)
          const r = await page.eval<R | null>(TIP)
          if (!r) continue
          shown++
          const o = out(r, W, H, EDGE)
          check(`${tag}: tooltip of "${s.label}" stays ${EDGE} px inside the screen`, o <= 0.5, `${fmtR(r)}${o ? `, ${o.toFixed(1)} px out` : ''}`)
          if (!lowest || s.y > lowest.y) lowest = { y: s.y, label: s.label }
        }
        check(`${tag}: tooltips showed (${shown} of ${spots.length})`, shown >= Math.min(4, spots.length))
        // The tooltip of the lowest button, as it shows (the whole screen, so its edges show).
        const low = spots.find((s) => s.label === lowest?.label)
        if (low) {
          await hover(page, 1, 1)
          await sleep(120)
          await hover(page, low.x, low.y)
          await sleep(650)
          if (await page.eval<R | null>(TIP)) await shot(page, `tip-bottom-${tag}`)
        }
        await hover(page, W / 2, H / 3)
      }

      // 3. The tactical map dragged into the bottom right corner, then the window made smaller.
      if (!phone) {
        const head = await page.eval<{ x: number; y: number } | null>(`(() => { const h = document.querySelector('.ew-mapframe .ew-float-head h4'); if (!h) return null; const b = h.getBoundingClientRect(); return { x: b.x + 4, y: b.y + b.height / 2 } })()`)
        if (head) {
          await drag(page, head, { x: W - 4, y: H - 4 })
          await sleep(500)
          const m1 = await page.eval<R>(`(() => { const b = document.querySelector('.ew-mapframe').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })()`)
          check(`${tag}: the map dragged into the corner stays ${EDGE} px inside`, out(m1, W, H, EDGE) <= 0.5, fmtR(m1))
          const w2 = Math.round(W * 0.7)
          const h2 = Math.round(H * 0.7)
          await metrics(w2, h2)
          await sleep(700)
          const m2 = await page.eval<R>(`(() => { const b = document.querySelector('.ew-mapframe').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })()`)
          check(`${tag}: and still on the screen at ${w2}x${h2}`, out(m2, w2, h2, 0) <= 0.5, fmtR(m2))
          const floats2 = await page.eval<(R & { cls: string })[]>(FLOATS)
          for (const f of floats2) check(`${tag} made ${w2}x${h2}: panel ${f.cls} is on the screen`, out(f, w2, h2, 0) <= 0.5, fmtR(f))
          await shot(page, `dragged-map-shrunk-${tag}`)
          await metrics(W, H)
          await sleep(600)
          // Put it back (double-click its header).
          const back = await page.eval<{ x: number; y: number }>(`(() => { const b = document.querySelector('.ew-mapframe .ew-float-head h4').getBoundingClientRect(); return { x: b.x + 4, y: b.y + b.height / 2 } })()`)
          await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: back.x, y: back.y, button: 'left', buttons: 1, clickCount: 2 })
          await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: back.x, y: back.y, button: 'left', buttons: 0, clickCount: 2 })
          await sleep(300)
        }
      }

      // 4. The tech tree.
      if (await page.eval<boolean>(`!!document.querySelector('.ew-top button[aria-label="Tech tree"]')`)) {
        await page.eval(`document.querySelector('.ew-top button[aria-label="Tech tree"]').click()`)
        await sleep(600)
        const t = await page.eval<R | null>(`(() => { const e = document.querySelector('.ew-modal.is-tree'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })()`)
        check(`${tag}: the tech tree fits`, !!t && out(t, W, H, 0) <= 0.5, t ? fmtR(t) : 'not open')
        await page.eval(`document.querySelector('.ew-top button[aria-label="Tech tree"]')?.click()`)
        await sleep(300)
      }

      // 5. The action wheel in each corner (phone).
      if (phone) {
        const cv = await page.eval<R>(`(() => { const b = document.querySelector('canvas.ew-canvas').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })()`)
        // Something selected, so the wheel offers orders.
        await page.eval(`(() => { const w = __ew.world; const g = w.units.find((u) => !u.dead && u.owner === 0 && u.t.tier === 'gunship') ?? w.units.find((u) => !u.dead && u.owner === 0 && u.t.tier === 'fighter'); return !!g })()`)
        for (const [name, fx, fy] of [['top-left', 0.03, 0.1], ['top-right', 0.97, 0.1], ['bottom-left', 0.03, 0.8], ['bottom-right', 0.97, 0.8]] as const) {
          const x = cv.x + cv.w * fx
          const y = cv.y + cv.h * fy
          await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
          await sleep(750)
          await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          await sleep(300)
          const r = await page.eval<R | null>(`(() => {
            const el = document.querySelector('.ew-wheel')
            if (!el) return null
            let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
            for (const e of [el, ...el.querySelectorAll('*')]) { const q = e.getBoundingClientRect(); if (!q.width && !q.height) continue; l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom) }
            return { x: l, y: t, w: r - l, h: b - t }
          })()`)
          if (!r) {
            console.log(`note ${tag}: no wheel in the ${name} corner`)
            continue
          }
          const o = out(r, W, H, EDGE)
          check(`${tag}: the action wheel in the ${name} corner stays ${EDGE} px inside`, o <= 0.5, `${fmtR(r)}${o ? `, ${o.toFixed(1)} px out` : ''}`)
          if (name === 'bottom-right') await shot(page, `wheel-${name}-${tag}`)
          await page.eval(`document.querySelector('.ew-wheel-mid')?.click()`)
          await sleep(300)
        }
      }
      if (page.errors.length) check(`${tag}: no errors in the page`, false, page.errors.join(' | '))
    } finally {
      await page.close()
      await b.close()
    }
  }
  console.log(failures ? `${failures} problem(s)` : 'everything stays on the screen')
  process.exit(failures ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
