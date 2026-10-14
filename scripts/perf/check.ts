// pnpm check:perf: runs fixed scenes in headless Chromium and holds them to perf-budgets.json and
// the pixel snapshots in scripts/perf/baselines. See "Performance guardrails" in README.md.
//
//   pnpm check:perf                     check every scene
//   pnpm check:perf --only galaxy-late  one scene (or a comma-separated few)
//   pnpm check:perf --update            after an intended change: new budgets and snapshots,
//                                       with the difference printed
//   pnpm check:perf --fixtures          rebuild the galaxy saves in scripts/perf/fixtures
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, newPage, type Browser } from './cdp.ts'
import { compare, decodePng, encodePng, type Image } from './png.ts'
import { rawLog, SCENES, type Metric } from './scenes.ts'
import { startServer } from './server.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BUDGETS = new URL('../../perf-budgets.json', import.meta.url)
const BASELINES = new URL('./baselines/', import.meta.url)
const FIXTURES = new URL('./fixtures/', import.meta.url)
const HARNESS = (process.env.PERF_TIMERS ? 'window.__perfTimerFrom = {};\n' : '') + readFileSync(new URL('./harness.js', import.meta.url), 'utf8')
const [VW, VH] = [1280, 720]

const args = process.argv.slice(2)
const flag = (k: string) => args.includes(`--${k}`)
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : undefined
}
const UPDATE = flag('update')
const ONLY = opt('only')?.split(',')
const CI = !!process.env.CI

/** Counts get this much headroom over what they measured when the budgets were set... */
const COUNT_HEADROOM = 1.15
/** ...and at least this much (a count of 0 or 1 that may become 2 is no regression)... */
const COUNT_SLACK = 2
/** ...and times this much: machines differ, so time is a soft budget (never fails the check). */
const TIME_HEADROOM = 3
/** ...plus at least this many milliseconds (a frame that costs next to nothing may cost a bit). */
const TIME_SLACK = 1
/** A snapshot passes when its mean difference (0–255, all channels) and its share of clearly
 * changed pixels both stay under these. */
const VISUAL = { mean: 1.5, changed: 0.01 }

/** A count's budget keeps what it was set from; a time's is only a threshold (rounded up to whole
 * milliseconds), since times are the machine's, not the code's. */
type Entry = { baseline?: number; budget: number; kind: 'count' | 'strict' | 'time' }
type Budgets = { about: string; visual: typeof VISUAL; scenes: Record<string, Record<string, Entry>> }

const budgetFor = (m: Metric) => (m.kind === 'strict' ? m.value : m.kind === 'time' ? Math.ceil(Math.max(m.value * TIME_HEADROOM, m.value + TIME_SLACK)) : Math.max(Math.ceil(m.value * COUNT_HEADROOM), Math.ceil(m.value + COUNT_SLACK)))

function readBudgets(): Budgets {
  if (!existsSync(BUDGETS)) return { about: '', visual: VISUAL, scenes: {} }
  return JSON.parse(readFileSync(BUDGETS, 'utf8')) as Budgets
}

// --- Fixtures: two galactic conquest saves, built from fixed seeds ---

async function buildFixtures(b: Browser, url: string) {
  mkdirSync(FIXTURES, { recursive: true })
  const page = await newPage(b, VW, VH, HARNESS)
  await page.send('Page.navigate', { url: `${url}/play/empires` })
  await page.waitFor(`[...document.querySelectorAll('.ew-menu-btn')].some((b) => b.textContent.includes('Single player'))`)
  for (const which of ['start', 'late']) {
    const save = await page.eval<Record<string, string>>(`(async () => {
      const G = await import('/src/apps/games/empires/galaxy.ts')
      const D = await import('/src/apps/games/empires/data.ts')
      for (const k of Object.keys(localStorage)) if (k.includes('empires')) localStorage.removeItem(k)
      let g
      if (${JSON.stringify(which)} === 'start') g = G.newGalaxy({ choice: { kind: 'rim' }, size: 'standard', faction: 'republic', difficulty: 'easy', credits: 3000 })
      else {
        // A long generated galaxy, played 30 weeks by a simple script: our planets build what they
        // can afford and our fleets head for the nearest planet that isn't ours.
        g = G.newGalaxy({ choice: { kind: 'generated', seed: 41 }, size: 'long', faction: 'republic', difficulty: 'hard', credits: 20000 })
        const end = 30 * G.WEEK * G.DAY
        while (g.time < end && g.winner === -1) {
          const s = g.sides[0]
          for (const p of g.planets.filter((p) => p.owner === 0 && p.station > 0)) {
            if (p.queue.length >= 2) continue
            const can = D.buildable(s.faction).filter((t) => t.level <= p.station && t.cost <= s.credits)
            if (can.length) G.buildAt(g, 0, p.id, can[Math.floor(g.time / 7) % can.length].id)
          }
          for (const f of g.fleets.filter((f) => f.owner === 0 && !f.leg && !f.route.length && f.planet >= 0).slice(0, 3)) {
            const goal = g.planets.filter((p) => p.owner !== 0).map((p) => ({ p, d: G.lanePath(g, f.system, p.system, 0)?.length ?? 99 })).filter((x) => x.d < 99).sort((a, b) => a.d - b.d)[0]
            if (goal) G.moveFleet(g, 0, f.id, goal.p.id)
          }
          if (g.pending >= 0) G.settlePending(g, 'auto')
          G.tickGalaxy(g, 0.5)
          g.events.length = 0
        }
      }
      G.saveGalaxy(g)
      return Object.fromEntries(Object.keys(localStorage).filter((k) => k.includes('empires')).map((k) => [k, localStorage.getItem(k)]))
    })()`)
    writeFileSync(new URL(`galaxy-${which}.json`, FIXTURES), JSON.stringify(save) + '\n')
    console.log(`fixture galaxy-${which}: ${Object.keys(save).length} keys, ${JSON.stringify(save).length} bytes`)
  }
  await page.close()
}

// --- The check ---

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s)
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2))

async function main() {
  const t0 = Date.now()
  const { url, server } = await startServer(ROOT)
  const browser = await launch(VW, VH)
  console.log(`perf check: ${browser.version}, ${VW}x${VH}, software rendering${CI ? ', CI (time budgets are soft)' : ''}`)
  const budgets = readBudgets()
  const fresh: Budgets = { about: budgets.about || 'pnpm check:perf budgets: written by `pnpm check:perf --update`. Counts are machine-independent; times are soft (see README, Performance guardrails).', visual: budgets.visual ?? VISUAL, scenes: { ...budgets.scenes } }
  const failures: string[] = []
  const soft: string[] = []
  const rows: string[][] = []
  const shotsOut: Record<string, Image> = {}
  const measured: Record<string, Record<string, Metric>> = {}
  try {
    if (flag('fixtures')) {
      await buildFixtures(browser, url)
      return
    }
    for (const scene of SCENES) {
      if (ONLY && !ONLY.includes(scene.name)) continue
      const s0 = Date.now()
      const page = await newPage(browser, VW, VH, HARNESS)
      let result
      try {
        result = await scene.run(page, url)
      } catch (e) {
        failures.push(`${scene.name}: the scene didn't run: ${(e as Error).message}${page.errors.length ? `\n    page errors: ${page.errors.slice(0, 3).join('\n    ')}` : ''}`)
        await page.close()
        continue
      }
      if (page.errors.length) failures.push(`${scene.name}: the page threw: ${page.errors.slice(0, 3).join(' | ')}`)
      await page.close()
      console.log(`  ${scene.name} (${scene.about}): ${((Date.now() - s0) / 1000).toFixed(1)} s`)
      measured[scene.name] = result.metrics
      const old = budgets.scenes[scene.name] ?? {}
      const next: Record<string, Entry> = {}
      for (const [name, m] of Object.entries(result.metrics)) {
        if (m.kind === 'info') {
          rows.push([scene.name, name, '', fmt(m.value), 'info'])
          continue
        }
        const e = old[name]
        next[name] = m.kind === 'time' ? { budget: budgetFor(m), kind: m.kind } : { baseline: m.value, budget: budgetFor(m), kind: m.kind }
        if (UPDATE) {
          const was = !e ? 'new' : e.baseline === undefined ? `budget ${fmt(e.budget)}` : `${fmt(e.baseline)} (budget ${fmt(e.budget)})`
          const now = `${fmt(m.value)} (budget ${fmt(next[name].budget)})`
          rows.push([scene.name, name, was, now, e && e.baseline === next[name].baseline && e.budget === next[name].budget ? '' : 'changed'])
          continue
        }
        if (!e) {
          failures.push(`${scene.name} / ${name}: no budget yet (run pnpm check:perf --update)`)
          rows.push([scene.name, name, '-', fmt(m.value), 'NO BUDGET'])
          continue
        }
        const over = m.value > e.budget
        const status = !over ? 'ok' : m.kind === 'time' ? 'over (soft)' : 'FAIL'
        rows.push([scene.name, name, fmt(e.budget), fmt(m.value), status])
        const was = e.baseline === undefined ? '' : ` (it was ${fmt(e.baseline)} when the budget was set, ${m.value > 0 && e.baseline > 0 ? `${Math.round((m.value / e.baseline - 1) * 100)}% more` : 'up from nothing'})`
        const msg = `${scene.name} / ${name}: ${fmt(m.value)} against a budget of ${fmt(e.budget)}${was}`
        if (over && m.kind === 'time') soft.push(msg)
        else if (over) failures.push(msg)
      }
      if (UPDATE) fresh.scenes[scene.name] = next
      // Pixels.
      for (const [name, img] of Object.entries(result.shots)) {
        const file = new URL(`${name}.png`, BASELINES)
        shotsOut[name] = img
        if (UPDATE) continue
        if (!existsSync(file)) {
          failures.push(`${name}: no snapshot yet (run pnpm check:perf --update)`)
          rows.push([scene.name, 'pixels vs snapshot', '-', '-', 'NO SNAPSHOT'])
          continue
        }
        const d = compare(decodePng(readFileSync(file)), img)
        const tol = budgets.visual ?? VISUAL
        const ok = d.mean <= tol.mean && d.changed <= tol.changed
        rows.push([scene.name, 'pixels: mean diff / changed', `${tol.mean} / ${(tol.changed * 100).toFixed(1)}%`, `${d.mean.toFixed(2)} / ${(d.changed * 100).toFixed(2)}%`, ok ? 'ok' : 'FAIL'])
        if (!ok) {
          failures.push(`${name}: looks different from scripts/perf/baselines/${name}.png (mean difference ${d.mean.toFixed(2)}/255, ${(d.changed * 100).toFixed(2)}% of pixels changed; the new picture is in ${writeActual(name, img)})`)
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }

  // Everything measured, as JSON, for a closer look (--json <file>).
  if (opt('json')) writeFileSync(opt('json')!, JSON.stringify({ ...measured, raw: rawLog }, null, 1))

  // The table.
  const head = UPDATE ? ['scene', 'metric', 'before', 'after', ''] : ['scene', 'metric', 'budget', 'actual', 'result']
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (r: string[]) => r.map((c, i) => (i === 2 || i === 3 ? lpad(c, w[i]) : pad(c, w[i]))).join('  ')
  console.log('\n' + line(head))
  console.log(w.map((n) => '-'.repeat(n)).join('  '))
  let prev = ''
  for (const r of rows) {
    console.log(line([r[0] === prev ? '' : r[0], ...r.slice(1)]))
    prev = r[0]
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)} s`)

  if (UPDATE) {
    if (!failures.length) {
      // In the scenes' order.
      const scenes = Object.fromEntries([...SCENES.map((s) => s.name).filter((n) => fresh.scenes[n]), ...Object.keys(fresh.scenes).filter((n) => !SCENES.some((s) => s.name === n))].map((n) => [n, fresh.scenes[n]]))
      writeFileSync(BUDGETS, JSON.stringify({ ...fresh, scenes }, null, 2) + '\n')
      mkdirSync(BASELINES, { recursive: true })
      for (const [name, img] of Object.entries(shotsOut)) writeFileSync(new URL(`${name}.png`, BASELINES), encodePng(img))
      console.log(`Updated perf-budgets.json and ${Object.keys(shotsOut).length} snapshots in scripts/perf/baselines. Check the diff before committing.`)
      return
    }
    console.log('\nNot updated: some scenes failed to run.')
  }
  for (const s of soft) console.log(`soft: ${s}`)
  if (failures.length) {
    console.log(`\nperf check FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
    console.log('\nIf the change is intended (a new feature that costs this), run `pnpm check:perf --update` and commit the new budgets with it.')
    process.exitCode = 1
  } else console.log(`perf check passed${soft.length ? ` (${soft.length} soft time budget${soft.length > 1 ? 's' : ''} over)` : ''}`)
}

/** Where a failing snapshot's picture goes, to look at. */
function writeActual(name: string, img: Image) {
  const dir = process.env.PERF_ACTUAL_DIR || join(tmpdir(), 'mvlos-perf-actual')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.png`)
  writeFileSync(file, encodePng(img))
  return file
}

await main()
