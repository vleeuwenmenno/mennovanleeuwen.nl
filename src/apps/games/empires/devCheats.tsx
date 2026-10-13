import { useEffect, useReducer, useRef, useState } from 'react'
import { FACTIONS, LEVEL_UP, MAX_LEVEL, RUSH, TECH, UNIT, type FactionId } from './data'
import { Floating } from './Hud'
import { damage, shieldMax, spawn, spawnGroup, type Owner, type Unit, type World } from './sim'
import type { Pt } from './maps'

// Developer cheats for single-player Empires At War battles. DEV BUILDS ONLY: the one place that
// loads this module is behind `import.meta.env.DEV` in EmpiresAtWar.tsx, so a production build
// never contains it (checked by grepping dist/ for this file's strings). Everything here changes the
// local world directly; it never goes through the commands table or the lockstep protocol, and the
// panel is never mounted in a multiplayer battle (the server only runs orders it was sent anyway).
// The sim itself is untouched: with every cheat off nothing here runs, and the state hash is the same.

/** The toggles. Module state: the battle's loop reads them every tick. */
export const cheats = { fast: false, money: false, reveal: false, god: false }
const OFF = { ...cheats }

/** Credits an infinite-income player is topped up to. */
const RICH = 999_999
/** Seconds every build, research and upgrade of ours is cut down to. */
const FAST = 2

/**
 * Called by the battle after every sim tick (single-player only). Fast build clamps what is left
 * on each of our timers to FAST seconds, so everything finishes about two seconds after it starts;
 * an engineer-built site is clamped lower, as a lone engineer works a site at a third of real time.
 */
export function afterTick(w: World, me: Owner) {
  const p = w.players[me]
  if (!p) return
  if (cheats.money) p.credits = Math.max(p.credits, RICH)
  if (cheats.fast) {
    for (const q of p.queue) q.left = Math.min(q.left, FAST)
    for (const r of p.research) r.left = Math.min(r.left, FAST)
    // A finished ship's jump in from hyperspace too, so the whole thing takes about FAST seconds.
    for (const a of w.arrivals) if (a.owner === me && a.rally) a.at = Math.min(a.at, w.time + 0.1)
    for (const u of w.units) {
      if (u.dead || u.owner !== me) continue
      if (u.building > 0) u.building = Math.min(u.building, u.site ? FAST / 3 : FAST)
      for (const q of u.yq ?? []) q.left = Math.min(q.left, FAST)
      for (const x of u.xq ?? []) x.left = Math.min(x.left, FAST)
      if (u.upgrading) u.upgrading.left = Math.min(u.upgrading.left, FAST)
    }
  }
  if (cheats.god) {
    for (const u of w.units) {
      if (u.dead || u.owner !== me || u.site || u.building > 0) continue
      u.hull = u.hullMax
      u.shield = shieldMax(u)
      for (const h of u.hps) h.hp = h.max
    }
  }
  if (cheats.reveal) for (const u of w.units) u.seen[p.team] = true
}

/** What the battle gives the panel: the things it keeps in refs. */
export type DevCtx = {
  world: () => World
  me: Owner
  /** Every seat's name, by owner. */
  names: string[]
  selected: () => Set<number>
  canvas: () => HTMLCanvasElement | null
  /** Canvas pixels to map units. */
  toWorld: (sx: number, sy: number) => Pt
  camera: () => Pt
  setSpeed: (s: number) => void
  speed: () => number
  focused: () => boolean
  toast: (text: string, tone?: 'good' | 'bad' | 'info') => void
}

/** Ships and structures to spawn: every faction's, except stations (one per player) and mining
 * platforms (they need an ore asteroid). Yards only where the battle has hybrid bases. */
const spawnable = (w: World) => Object.values(UNIT).filter((t) => t.tier !== 'station' && t.tier !== 'mine' && (t.tier !== 'yard' || w.hybrid))

/** Spawns `n` of a unit for `owner` in a loose grid round (x, y), facing the middle of the map. */
function spawnAt(w: World, id: string, owner: Owner, x: number, y: number, n: number) {
  const t = UNIT[id]
  const gap = Math.max(60, t.size * (t.squad > 1 ? 2.4 : 1.2))
  const cols = Math.ceil(Math.sqrt(n))
  const a = Math.atan2(w.h / 2 - y, w.w / 2 - x)
  let made = 0
  for (let i = 0; i < n; i++) {
    const px = Math.min(w.w - 60, Math.max(60, x + ((i % cols) - (cols - 1) / 2) * gap))
    const py = Math.min(w.h - 60, Math.max(60, y + (Math.floor(i / cols) - (Math.ceil(n / cols) - 1) / 2) * gap))
    if (t.tier === 'yard' || t.tier === 'defense') {
      const u = spawn(w, id, owner, px, py, a)
      if (t.tier === 'yard') {
        u.yq = []
        u.yr = { x: px + Math.cos(a) * (t.size + 200), y: py + Math.sin(a) * (t.size + 200) }
      }
      made++
    } else made += spawnGroup(w, id, owner, px, py, a).length
  }
  return made
}

/** Orders for every tech of ours not yet researched, after the station levels, queued to finish at
 * once (the queue runs one at a time, so a prerequisite always comes before what needs it). */
function researchAll(w: World, me: Owner) {
  const p = w.players[me]
  const quick = (id: string) => p.research.push({ id, left: 0.03, total: 0.03 })
  let level = p.level + p.research.filter((r) => r.id === LEVEL_UP).length
  while (level++ < MAX_LEVEL) quick(LEVEL_UP)
  const todo = Object.keys(TECH).filter((id) => TECH[id].faction === p.faction && !p.techs.includes(id) && !p.research.some((r) => r.id === id))
  const queued = new Set<string>()
  for (let guard = 0; todo.length && guard < 100; guard++) {
    const next = todo.findIndex((id) => (TECH[id].requires ?? []).every((r) => p.techs.includes(r) || queued.has(r) || p.research.some((q) => q.id === r)))
    if (next < 0) break
    const [id] = todo.splice(next, 1)
    queued.add(id)
    quick(id)
  }
  return queued.size
}

const CSS = `
.ew-dev { width: 308px; }
.ew-dev .ew-dev-body { display: flex; flex-direction: column; gap: 8px; font-size: 12px; max-height: calc(100vh - 160px); overflow: auto; }
.ew-dev h5 { margin: 2px 0 0; font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ew-muted, #8fa0bd); }
.ew-dev label.ew-dev-row { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.ew-dev .ew-dev-line { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.ew-dev select, .ew-dev input[type=number] { background: rgba(8, 14, 30, 0.9); color: inherit; border: 1px solid rgba(143, 186, 255, 0.35); border-radius: 4px; padding: 3px 5px; font: inherit; }
.ew-dev select { flex: 1; min-width: 0; }
.ew-dev input[type=number] { width: 58px; }
.ew-dev .ew-chip.is-on { background: linear-gradient(180deg, var(--ew-active-hi), var(--ew-active)); border-color: #8fbaff; color: #fff; }
.ew-dev-chip { position: absolute; left: 50%; bottom: 6px; transform: translateX(-50%); z-index: 6; }
@media (pointer: coarse) { .ew-dev-chip { bottom: auto; top: 54px; left: auto; right: 6px; transform: none; opacity: 0.7; } }
.ew-dev-chip {  padding: 2px 8px; font-size: 10.5px; letter-spacing: 0.12em; }
.ew-dev-hint { color: #f2c14a; }
`

/**
 * The rush launch's numbers (data.ts RUSH), tried out live on this battle: they go on the local
 * world (World.rushTune), which the sim reads in place of RUSH. Nothing of it reaches another player.
 */
function RushTune({ w, onChange }: { w: World; onChange: () => void }) {
  const cur = w.rushTune ?? RUSH
  const set = (patch: Partial<typeof RUSH>) => {
    w.rushTune = { ...cur, ...patch }
    onChange()
  }
  const num = (label: string, value: number, min: number, max: number, step: number, apply: (v: number) => void, tip: string) => (
    <label className="ew-dev-row" data-tip={tip}>
      {label}
      <input type="number" min={min} max={max} step={step} value={value} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && apply(Math.min(max, Math.max(min, e.target.valueAsNumber)))} aria-label={label} />
    </label>
  )
  return (
    <>
      {num('Min %', Math.round(cur.min * 100), 0, 100, 5, (v) => set({ min: v / 100 }), 'How far the ship must be built before it can be rushed')}
      {num('Cooldown s', cur.cooldown, 0, 1200, 10, (v) => set({ cooldown: v }), 'Seconds before the same yard can rush again')}
      {num('Slowdown %', Math.round(cur.slowdown * 100), 0, 300, 5, (v) => set({ slowdown: v / 100 }), 'How much longer the yard\'s next ship takes')}
      <button className="ew-chip" disabled={!w.rushTune} onClick={() => (delete w.rushTune, onChange())}>
        Defaults
      </button>
    </>
  )
}

/** The dev panel: its hotkey (F9), a small DEV button, the cheat toggles and the spawn menu. */
export function DevCheats({ ctx }: { ctx: DevCtx }) {
  const [open, setOpen] = useState(false)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const [side, setSide] = useState<Owner>(ctx.me)
  const [unit, setUnit] = useState('r-capital')
  const [count, setCount] = useState(1)
  const [armed, setArmed] = useState(false)
  const last = useRef<Pt | null>(null)
  const armedRef = useRef(armed)
  armedRef.current = armed
  const form = useRef({ side, unit, count })
  form.current = { side, unit, count }
  const w = ctx.world()

  // A new battle starts with every cheat off.
  useEffect(() => {
    Object.assign(cheats, OFF)
  }, [])
  // The numbers shown (credits, station level) move on their own.
  useEffect(() => {
    if (!open) return
    const t = setInterval(redraw, 400)
    return () => clearInterval(t)
  }, [open])

  const spawnNow = (at: Pt) => {
    const f = form.current
    const world = ctx.world()
    const n = spawnAt(world, f.unit, f.side, at.x, at.y, Math.max(1, Math.min(60, f.count)))
    ctx.toast(`Spawned ${n} x ${UNIT[f.unit].name} for ${ctx.names[f.side] ?? 'side ' + f.side}`, 'info')
  }

  // F9 opens and closes the panel; Escape ends click-to-place. A capture listener, so the game's
  // own keys (Escape opens its menu) don't also fire while placing.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!ctx.focused()) return
      if (e.key === 'F9') {
        e.preventDefault()
        e.stopPropagation()
        setOpen((o) => !o)
      } else if (e.key === 'F10') {
        // Spawn what the form says at the cursor, without opening anything.
        e.preventDefault()
        e.stopPropagation()
        spawnNow(last.current ?? ctx.camera())
      } else if (e.key === 'Escape' && armedRef.current) {
        e.preventDefault()
        e.stopPropagation()
        setArmed(false)
      }
    }
    window.addEventListener('keydown', down, true)
    return () => window.removeEventListener('keydown', down, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Click-to-place: native capture listeners on the canvas, so the game's own pointer handlers
  // (selecting, giving orders) never see the clicks while it is armed. The wheel still zooms.
  useEffect(() => {
    const c = ctx.canvas()
    if (!c) return
    const track = (e: PointerEvent) => {
      const r = c.getBoundingClientRect()
      last.current = ctx.toWorld(e.clientX - r.left, e.clientY - r.top)
    }
    const down = (e: PointerEvent) => {
      if (!armedRef.current) return
      e.preventDefault()
      e.stopPropagation()
      if (e.button === 2) return setArmed(false)
      if (e.button !== 0) return
      track(e)
      spawnNow(last.current!)
    }
    c.addEventListener('pointermove', track)
    c.addEventListener('pointerdown', down, true)
    return () => {
      c.removeEventListener('pointermove', track)
      c.removeEventListener('pointerdown', down, true)
      c.style.cursor = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const c = ctx.canvas()
    if (c) c.style.cursor = armed ? 'crosshair' : ''
  }, [armed])

  const p = w.players[ctx.me]
  const flip = (k: keyof typeof cheats) => {
    cheats[k] = !cheats[k]
    redraw()
  }
  const kill = () => {
    let n = 0
    for (const id of ctx.selected()) {
      const u: Unit | undefined = w.byId.get(id)
      if (u && !u.dead && u.owner === ctx.me) {
        damage(w, u, 1e9, 'laser', -1, u.x, u.y, u.owner)
        n++
      }
    }
    ctx.toast(n ? `Destroyed ${n} selected` : 'Nothing of yours selected', 'info')
  }
  const types = spawnable(w)
  const levelUp = (to: number) => {
    const have = p.level + p.research.filter((r) => r.id === LEVEL_UP).length
    for (let i = have; i < to; i++) p.research.push({ id: LEVEL_UP, left: 0.03, total: 0.03 })
  }

  if (!open)
    return (
      <>
        <style>{CSS}</style>
        <button className="ew-chip ew-dev-chip" onClick={() => setOpen(true)} data-tip="Dev cheats (F9)">
          DEV
        </button>
      </>
    )
  return (
    <>
      <style>{CSS}</style>
      <Floating id="devcheats" title="Dev cheats" at={{ right: 8, top: 56 }} className="ew-dev" onClose={() => setOpen(false)} aside={<span className="ew-muted ew-small">dev build only</span>}>
        <div className="ew-dev-body">
          <h5>Cheats</h5>
          <label className="ew-dev-row">
            <input type="checkbox" checked={cheats.fast} onChange={() => flip('fast')} /> Fast build ({FAST} s: ships, structures, upgrades, research)
          </label>
          <label className="ew-dev-row">
            <input type="checkbox" checked={cheats.money} onChange={() => flip('money')} /> Infinite income ({Math.round(p.credits).toLocaleString('en')} credits)
          </label>
          <label className="ew-dev-row">
            <input type="checkbox" checked={cheats.reveal} onChange={() => flip('reveal')} /> Reveal the map (no fog)
          </label>
          <label className="ew-dev-row">
            <input type="checkbox" checked={cheats.god} onChange={() => flip('god')} /> God mode (our units)
          </label>
          <h5>Game speed</h5>
          <div className="ew-dev-line">
            {[1, 2, 4, 8].map((s) => (
              <button key={s} className={`ew-chip ${ctx.speed() === s ? 'is-on' : ''}`} onClick={() => (ctx.setSpeed(s), redraw())}>
                {s}x
              </button>
            ))}
          </div>
          <h5>Station and research</h5>
          <div className="ew-dev-line">
            <span>Level {p.level}:</span>
            {[2, 3, 4].map((l) => (
              <button key={l} className="ew-chip" disabled={p.level >= l} onClick={() => levelUp(l)}>
                to {l}
              </button>
            ))}
            <button className="ew-chip" onClick={() => ctx.toast(`Researching ${researchAll(w, ctx.me)} more techs`, 'info')}>
              Complete all research
            </button>
            <button className="ew-chip" onClick={kill}>
              Kill selected
            </button>
          </div>
          <h5>Rush launch (playtest)</h5>
          <div className="ew-dev-line">
            <RushTune w={w} onChange={redraw} />
          </div>
          <h5>Spawn</h5>
          <div className="ew-dev-line">
            <select value={side} onChange={(e) => setSide(Number(e.target.value))} aria-label="Side">
              {w.players.map((pl, i) => (
                <option key={i} value={i}>
                  {i === ctx.me ? 'Me' : ctx.names[i] ?? `Seat ${i + 1}`} ({i === ctx.me ? '' : pl.team === p.team ? 'ally, ' : 'enemy, '}{FACTIONS[pl.faction].name})
                </option>
              ))}
            </select>
          </div>
          <div className="ew-dev-line">
            <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unit">
              {(Object.keys(FACTIONS) as FactionId[]).map((f) => (
                <optgroup key={f} label={FACTIONS[f].name}>
                  {types.filter((t) => t.faction === f).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.tier})
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <input type="number" min={1} max={60} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} aria-label="Count" />
          </div>
          <div className="ew-dev-line">
            <button className={`ew-chip ${armed ? 'is-on' : ''}`} onClick={() => setArmed((a) => !a)}>
              {armed ? 'Placing: click the map' : 'Click map to place'}
            </button>
            <button className="ew-chip" onClick={() => spawnNow(last.current ?? ctx.camera())} data-tip="Where the pointer last was on the map (F10)">
              At cursor
            </button>
            <button className="ew-chip" onClick={() => spawnNow(ctx.camera())}>
              At camera
            </button>
          </div>
          {armed && <div className="ew-dev-hint ew-small">Left click places (again and again), right click or Esc stops.</div>}
          {w.fleet && <div className="ew-muted ew-small">Campaign battle: what you spawn counts in the result.</div>}
        </div>
      </Floating>
    </>
  )
}
