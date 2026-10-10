import { useEffect, useRef, useState } from 'react'
import type { WinState } from '../../os/wm'
import { DIFFICULTY, newBrain, think, type Brain, type Difficulty } from './empires/ai'
import { ABILITIES, FACTIONS, MAX_LEVEL, UNIT, UNITS, UPGRADES, buildable, dims, isShip, unitOf, type FactionId, type HardpointKind, type UnitType } from './empires/data'
import { Renderer, spriteUrl, type Camera, type View } from './empires/render'
import {
  STEP, building, cancelUpgrade, cantBuild, cantMine, cantUpgrade, cmdAbility, cmdAttack, cmdBuild, cmdCancel, cmdMine, cmdMove, cmdRally, cmdStop, cmdUpgrade, hpPos, newWorld,
  other, shieldMax, tick, type Owner, type SimEvent, type Unit, type World,
} from './empires/sim'
import { EmpiresSound } from './empires/sound'
import { useHighScore, useIsFocused } from './shared'
import './empires/empires.css'

// Empires At War: a space RTS in the spirit of Empire at War, set in a Clone Wars style war
// between a Republic navy and a droid Confederacy. One skirmish map against the AI: mine ore,
// capture beacons, upgrade the station, build up from fighters to a flagship, and destroy the
// enemy station. This file holds the screens, the input and the HUD; the battle runs in
// empires/sim.ts and is drawn by empires/render.ts.

const SPRITES = [...new Set(UNITS.map((u) => u.sprite))]
const HP_NAME: Record<HardpointKind, string> = { turret: 'Turbolaser', shield: 'Shield generator', engine: 'Engines', hangar: 'Hangar' }
const fmt = (n: number) => Math.floor(n).toLocaleString('en-US')
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** Orbitron for the HUD headings, loaded only once the game is opened. */
function useDisplayFont() {
  useEffect(() => {
    if (document.getElementById('ew-font')) return
    const l = document.createElement('link')
    l.id = 'ew-font'
    l.rel = 'stylesheet'
    l.href = 'https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&display=swap'
    document.head.appendChild(l)
  }, [])
}

type Setup = { faction: FactionId; difficulty: Difficulty }

export function EmpiresAtWar({ win }: { win: WinState }) {
  useDisplayFont()
  const [setup, setSetup] = useState<Setup | null>(null)
  const [round, setRound] = useState(0)
  const sound = useRef<EmpiresSound>(null as unknown as EmpiresSound)
  if (!sound.current) sound.current = new EmpiresSound()
  useEffect(() => () => sound.current.dispose(), [])

  if (!setup) return <Title onStart={(s) => (sound.current.unlock(), sound.current.click(), setSetup(s))} />
  return (
    <Battle
      key={round}
      win={win}
      setup={setup}
      sound={sound.current}
      onExit={() => setSetup(null)}
      onAgain={() => setRound((r) => r + 1)}
    />
  )
}

// --- Title ----------------------------------------------------------------------------------------

function Title({ onStart }: { onStart: (s: Setup) => void }) {
  const [faction, setFaction] = useState<FactionId>('republic')
  const [difficulty, setDifficulty] = useState<Difficulty>('normal')
  const { best } = useHighScore('empires')
  return (
    <div className="ew-root ew-title" style={{ backgroundImage: 'url(/games/empires/world/title.webp)' }}>
      <div className="ew-title-panel">
        <h1>
          Empires <span>at</span> War
        </h1>
        <p className="ew-tag">A war in the stars, fought one fleet at a time.</p>
        <h3>Choose your side</h3>
        <div className="ew-sides">
          {(['republic', 'droid'] as FactionId[]).map((f) => (
            <button key={f} className={`ew-side ew-side-${f} ${faction === f ? 'is-on' : ''}`} onClick={() => setFaction(f)} aria-pressed={faction === f}>
              <img src={spriteUrl(unitOf(f, 'capital').sprite)} alt="" />
              <strong>{FACTIONS[f].long}</strong>
              <span>{FACTIONS[f].blurb}</span>
            </button>
          ))}
        </div>
        <h3>Enemy admiral</h3>
        <div className="ew-seg">
          {(Object.keys(DIFFICULTY) as Difficulty[]).map((d) => (
            <button key={d} className={difficulty === d ? 'is-on' : ''} onClick={() => setDifficulty(d)} title={DIFFICULTY[d].blurb}>
              {DIFFICULTY[d].name}
            </button>
          ))}
        </div>
        <p className="ew-muted">{DIFFICULTY[difficulty].blurb}</p>
        <button className="ew-go" onClick={() => onStart({ faction, difficulty })}>
          Launch battle
        </button>
        <p className="ew-muted ew-small">Victories: {best ?? 0}</p>
      </div>
      <div className="ew-title-help">
        <h3>How to play</h3>
        <ul>
          <li>Destroy the enemy station. Protect yours.</li>
          <li>Drag to select ships. Right-click to move or attack.</li>
          <li>Build mining platforms on the glowing ore for credits.</li>
          <li>Hold ships near a beacon to capture it: more income, bigger fleet.</li>
          <li>Upgrade your station to unlock frigates, cruisers and a flagship.</li>
          <li>Big ships have hardpoints. Hover one, right-click a marker to target it.</li>
        </ul>
        <p className="ew-muted ew-small">
          Keys: A attack-move · S stop · Q ability · H station · Ctrl+1–9 groups · Arrows pan · Wheel zoom · P pause
        </p>
      </div>
    </div>
  )
}

// --- Battle ---------------------------------------------------------------------------------------

type Toast = { id: number; text: string; tone: 'good' | 'bad' | 'info'; t: number }
type Hud = {
  credits: number
  income: number
  pop: number
  popCap: number
  level: number
  upgrade: { left: number; total: number } | null
  queue: { unit: string; left: number; total: number }[]
  time: number
  sel: number[]
  winner: Owner | -1
  beacons: number
  mines: number
}
type Mode = 'normal' | 'attack' | 'mine'

function snapshot(w: World, me: Owner, sel: Set<number>): Hud {
  const p = w.players[me]
  return {
    credits: p.credits, income: p.income, pop: p.pop, popCap: p.popCap, level: p.level, upgrade: p.upgrade && { ...p.upgrade },
    queue: p.queue.map((q) => ({ ...q })), time: w.time, sel: [...sel], winner: w.winner,
    beacons: w.beacons.filter((b) => b.owner === me).length, mines: w.units.filter((u) => u.owner === me && u.t.tier === 'mine').length,
  }
}

function Battle({ win, setup, sound, onExit, onAgain }: { win: WinState; setup: Setup; sound: EmpiresSound; onExit: () => void; onAgain: () => void }) {
  const me: Owner = 0
  const enemyFaction: FactionId = setup.faction === 'republic' ? 'droid' : 'republic'
  const world = useRef<World>(null as unknown as World)
  if (!world.current) world.current = newWorld(setup.faction, enemyFaction, { incomeMul: [1, DIFFICULTY[setup.difficulty].income] })
  const brain = useRef<Brain>(newBrain(1, setup.difficulty))
  const renderer = useRef<Renderer>(null as unknown as Renderer)
  if (!renderer.current) renderer.current = new Renderer(SPRITES)
  const w0 = world.current
  const st0 = w0.byId.get(w0.players[me].station)!
  const cam = useRef<Camera>({ x: st0.x + 500, y: st0.y, zoom: 0.5 })
  // Dev builds expose the battle for poking at from the console.
  if (import.meta.env.DEV) (window as unknown as { __ew: unknown }).__ew = { world: world.current, brain: brain.current, cam: cam.current }
  const selected = useRef(new Set<number>())
  const groups = useRef(new Map<string, number[]>())
  const mode = useRef<Mode>('normal')
  const hover = useRef({ unit: 0, hp: -1, node: -1 })
  const mouse = useRef({ x: -1, y: -1, inside: false })
  const keys = useRef(new Set<string>())
  const speed = useRef(1)
  const paused = useRef(false)
  const lastAlarm = useRef<{ x: number; y: number } | null>(null)
  const drag = useRef<{ x0: number; y0: number; box: boolean; pan: boolean; moved: boolean; cx: number; cy: number; button: number } | null>(null)
  const touches = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ d: number; zoom: number } | null>(null)
  const lastClick = useRef({ t: 0, id: 0 })

  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const mini = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  const [hud, setHud] = useState<Hud>(() => snapshot(world.current, me, selected.current))
  const [toasts, setToasts] = useState<Toast[]>([])
  const [ui, setUi] = useState({ paused: false, speed: 1, mode: 'normal' as Mode, help: false, muted: sound.muted, menu: false })
  const focused = useIsFocused(win)
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  const { best, submit } = useHighScore('empires')
  const bestRef = useRef(best)
  bestRef.current = best
  const toastId = useRef(1)

  const toast = (text: string, tone: Toast['tone'] = 'info') => setToasts((ts) => [...ts.slice(-3), { id: toastId.current++, text, tone, t: performance.now() }])
  const setMode = (m: Mode) => {
    mode.current = m
    setUi((u) => ({ ...u, mode: m }))
  }
  const view = () => {
    const c = canvas.current!
    return { vw: c.clientWidth, vh: c.clientHeight }
  }
  const toWorld = (sx: number, sy: number) => {
    const { vw, vh } = view()
    const c = cam.current
    return { x: c.x + (sx - vw / 2) / c.zoom, y: c.y + (sy - vh / 2) / c.zoom }
  }
  const clampCam = () => {
    const c = cam.current
    const { vw, vh } = view()
    const w = world.current
    const minZ = Math.min(vw / w.w, vh / w.h) * 0.9
    c.zoom = Math.max(minZ, Math.min(1.6, c.zoom))
    const hw = vw / 2 / c.zoom
    const hh = vh / 2 / c.zoom
    c.x = hw * 2 >= w.w ? w.w / 2 : Math.max(hw - 150, Math.min(w.w - hw + 150, c.x))
    c.y = hh * 2 >= w.h ? w.h / 2 : Math.max(hh - 150, Math.min(w.h - hh + 150, c.y))
  }
  const where = (x: number, y: number) => {
    const { vw, vh } = view()
    const c = cam.current
    const dx = (x - c.x) * c.zoom
    const dy = (y - c.y) * c.zoom
    const d = Math.hypot(dx, dy) / Math.max(vw, vh)
    return { pan: (dx / (vw / 2)) * 0.7, gain: Math.max(0, Math.min(1, 1.15 - d * 1.3)) * (0.35 + 0.65 * Math.min(1, c.zoom * 1.6)) }
  }

  /** Expand a selection so a fighter always brings its whole squadron. */
  const withSquads = (ids: number[]) => {
    const w = world.current
    const squads = new Set(ids.map((i) => w.byId.get(i)?.squad).filter((s): s is number => !!s))
    const out = new Set(ids)
    if (squads.size) for (const u of w.units) if (u.owner === me && squads.has(u.squad)) out.add(u.id)
    return [...out]
  }
  const select = (ids: number[], add = false) => {
    if (!add) selected.current.clear()
    for (const id of withSquads(ids)) selected.current.add(id)
  }
  const mySelection = () => [...selected.current].map((i) => world.current.byId.get(i)).filter((u): u is Unit => !!u && u.owner === me)

  /** The unit under a screen point, small craft first; plus the hardpoint, if one is close. */
  const pick = (sx: number, sy: number) => {
    const w = world.current
    const p = toWorld(sx, sy)
    const z = cam.current.zoom
    let best: Unit | undefined
    let bestScore = Infinity
    for (const u of w.units) {
      if (u.owner !== me && !u.seen[me]) continue
      const [uw, uh] = dims(u.t)
      const minR = 12 / z
      // Point into the ship's own frame for an oriented box test.
      const dx = p.x - u.x
      const dy = p.y - u.y
      const c = Math.cos(-u.a - Math.PI / 2)
      const s = Math.sin(-u.a - Math.PI / 2)
      const lx = dx * c - dy * s
      const ly = dx * s + dy * c
      const inside = Math.abs(lx) <= Math.max(uw * 0.45, minR) && Math.abs(ly) <= Math.max(uh * 0.45, minR)
      if (!inside) continue
      const score = u.t.size + Math.hypot(dx, dy) * 0.1
      if (score < bestScore) {
        bestScore = score
        best = u
      }
    }
    let hp = -1
    if (best && best.hps.length && best.t.size * z > 90) {
      let bd = Infinity
      best.hps.forEach((h, i) => {
        if (h.hp <= 0) return
        const q = hpPos(best!, i)
        const d = Math.hypot(q.x - p.x, q.y - p.y)
        const r = Math.max(14 / z, best!.t.size * 0.06)
        if (d < r && d < bd) {
          bd = d
          hp = i
        }
      })
    }
    let node = -1
    for (const n of w.nodes) if (Math.hypot(n.x - p.x, n.y - p.y) < 130) node = n.id
    return { unit: best, hp, node, at: p }
  }

  const command = (sx: number, sy: number, attackMove: boolean) => {
    const w = world.current
    const { unit, hp, at } = pick(sx, sy)
    const ships = mySelection().filter((u) => isShip(u.t))
    const stationSel = mySelection().some((u) => u.t.tier === 'station')
    if (!ships.length) {
      if (stationSel) {
        cmdRally(w, me, at.x, at.y)
        renderer.current.ping(at.x, at.y, '#7dffa0')
        sound.order()
      }
      return
    }
    if (unit && unit.owner !== me) {
      cmdAttack(w, me, ships.map((u) => u.id), unit.id, hp)
      renderer.current.ping(unit.x, unit.y, '#ff5a50')
      sound.order(true)
      if (hp >= 0) toast(`Targeting ${HP_NAME[unit.t.hardpoints[hp].kind].toLowerCase()}`, 'info')
    } else {
      cmdMove(w, me, ships.map((u) => u.id), at.x, at.y, attackMove)
      renderer.current.ping(at.x, at.y, attackMove ? '#ffaa5a' : '#7dffa0')
      sound.order(attackMove)
    }
  }

  const placeMine = (node: number) => {
    const why = cmdMine(world.current, me, node)
    if (why) {
      toast(why, 'bad')
      sound.error()
      return false
    }
    sound.click()
    setMode('normal')
    return true
  }

  const centerOn = (x: number, y: number) => {
    cam.current.x = x
    cam.current.y = y
    clampCam()
  }
  const goHome = () => {
    const st = world.current.byId.get(world.current.players[me].station)
    if (st) centerOn(st.x + 300, st.y)
  }
  const selectArmy = () => {
    select(world.current.units.filter((u) => u.owner === me && isShip(u.t)).map((u) => u.id))
    sound.click()
  }
  const useAbility = () => {
    const n = cmdAbility(world.current, me, mySelection().map((u) => u.id))
    if (n) sound.ability()
    else if (mySelection().some((u) => u.t.ability)) sound.error()
  }

  const build = (id: string) => {
    sound.unlock()
    const why = cmdBuild(world.current, me, id)
    if (why) {
      toast(why, 'bad')
      sound.error()
    } else sound.click()
  }
  const upgrade = () => {
    const why = cmdUpgrade(world.current, me)
    if (why) {
      toast(why, 'bad')
      sound.error()
    } else sound.click()
  }

  // Load the art, then start.
  useEffect(() => {
    let live = true
    void renderer.current.ready().then(() => live && setReady(true))
    return () => {
      live = false
    }
  }, [])

  // The loop: fixed-step sim, AI, effects and sound from events, camera, drawing, HUD refresh.
  useEffect(() => {
    if (!ready) return
    const c = canvas.current!
    const m = mini.current!
    const ctx = c.getContext('2d')!
    const mctx = m.getContext('2d')!
    sound.unlock()
    sound.startDrone()
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      for (const [el, g] of [
        [c, ctx],
        [m, mctx],
      ] as const) {
        const pw = Math.max(1, Math.round(el.clientWidth * dpr))
        const ph = Math.max(1, Math.round(el.clientHeight * dpr))
        if (el.width !== pw || el.height !== ph) {
          el.width = pw
          el.height = ph
        }
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      clampCam()
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(c)
    ro.observe(m)

    let raf = 0
    let last = performance.now()
    let acc = 0
    let hudT = 0
    let ended = false
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const w = world.current
      const events: SimEvent[] = []
      if (!paused.current && w.winner === -1) {
        acc += dt * speed.current
        let steps = 0
        while (acc >= STEP && steps < 12) {
          think(w, brain.current, STEP)
          tick(w)
          events.push(...w.events)
          w.events.length = 0
          acc -= STEP
          steps++
        }
      }
      // Camera: arrow keys, and screen edges when the game fills the page.
      const cm = cam.current
      const { vw, vh } = { vw: c.clientWidth, vh: c.clientHeight }
      const pan = (900 / cm.zoom) * dt
      const k = keys.current
      if (k.has('ArrowLeft')) cm.x -= pan
      if (k.has('ArrowRight')) cm.x += pan
      if (k.has('ArrowUp')) cm.y -= pan
      if (k.has('ArrowDown')) cm.y += pan
      const full = !!root.current?.closest('.is-page-full')
      if (full && mouse.current.inside) {
        const e = 8
        if (mouse.current.x < e) cm.x -= pan
        if (mouse.current.x > vw - e) cm.x += pan
        if (mouse.current.y < e) cm.y -= pan
        if (mouse.current.y > vh - e) cm.y += pan
      }
      clampCam()

      // Effects and sound.
      renderer.current.consume(events, w, me)
      for (const e of events) {
        if (e.k === 'fire') sound.fire(e.kind, where(e.x, e.y), w.players[e.owner].faction === 'droid')
        else if (e.k === 'hit') sound.hit(e.shield, e.kind === 'turbo' || e.kind === 'missile', where(e.x, e.y))
        else if (e.k === 'boom') sound.boom(e.size, where(e.x, e.y))
        else if (e.k === 'hpdown') {
          sound.boom(60, where(e.x, e.y))
          if (e.owner === me) toast(`${HP_NAME[e.what as HardpointKind]} destroyed on one of our ships`, 'bad')
        } else if (e.k === 'built' && e.owner === me) {
          const t = UNIT[e.unit]
          sound.built()
          toast(t.tier === 'mine' ? `${t.name} is drilling` : `${t.name}${t.squad > 1 ? ' squadron' : ''} ready`, 'good')
        } else if (e.k === 'beacon') {
          if (e.owner === me) {
            sound.capture(true)
            toast('Beacon captured: +6 fleet capacity', 'good')
          } else if (e.prev === me) {
            sound.capture(false)
            toast('We lost a beacon', 'bad')
          }
        } else if (e.k === 'alarm' && e.owner === me) {
          sound.alarm()
          lastAlarm.current = { x: e.x, y: e.y }
          toast(`${e.what} under attack! (Space to look)`, 'bad')
        } else if (e.k === 'level' && e.owner === me) {
          sound.fanfare()
          const unlocked = buildable(setup.faction).filter((t) => t.level === e.level).map((t) => t.name)
          toast(`Station level ${e.level}${unlocked.length ? `: ${unlocked.join(', ')} unlocked` : ''}`, 'good')
        }
      }
      // Drop dead ships from the selection.
      for (const id of selected.current) if (!w.byId.get(id)) selected.current.delete(id)

      const h = hover.current
      const v: View = {
        me,
        selected: selected.current,
        hover: h.unit,
        hoverHp: h.hp,
        box: drag.current?.box && drag.current.moved ? { x0: drag.current.x0, y0: drag.current.y0, x1: mouse.current.x, y1: mouse.current.y } : null,
        placingMine: mode.current === 'mine',
        hoverNode: h.node,
        showRally: mySelection().some((u) => u.t.tier === 'station'),
      }
      renderer.current.draw(ctx, w, cm, vw, vh, v, dt * (paused.current ? 0 : speed.current))
      renderer.current.minimap(mctx, w, me, cm, vw, vh, m.clientWidth, m.clientHeight)

      hudT -= dt
      if (hudT <= 0 || (w.winner !== -1 && !ended)) {
        hudT = 0.15
        setHud(snapshot(w, me, selected.current))
        if (w.winner !== -1 && !ended) {
          ended = true
          sound.stopDrone()
          if (w.winner === me) {
            sound.fanfare()
            submit((bestRef.current ?? 0) + 1)
          } else sound.defeat()
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      sound.stopDrone()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // Old toasts fade out.
  useEffect(() => {
    if (!toasts.length) return
    const t = setTimeout(() => setToasts((ts) => ts.filter((x) => performance.now() - x.t < 4500)), 1000)
    return () => clearTimeout(t)
  }, [toasts])

  // Keyboard, only while this window is focused.
  useEffect(() => {
    if (!focused) {
      keys.current.clear()
      return
    }
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return
      const k = e.key
      const w = world.current
      if (k.startsWith('Arrow')) {
        keys.current.add(k)
        e.preventDefault()
        return
      }
      if (e.ctrlKey && /^[1-9]$/.test(k)) {
        groups.current.set(k, mySelection().map((u) => u.id))
        toast(`Group ${k} set`, 'info')
        e.preventDefault()
        return
      }
      if (e.ctrlKey && (k === 'a' || k === 'A')) {
        selectArmy()
        e.preventDefault()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (/^[1-9]$/.test(k)) {
        const ids = (groups.current.get(k) ?? []).filter((i) => w.byId.get(i))
        if (ids.length) {
          const again = ids.length === selected.current.size && ids.every((i) => selected.current.has(i))
          select(ids)
          if (again) {
            const us = ids.map((i) => w.byId.get(i)!)
            centerOn(us.reduce((s, u) => s + u.x, 0) / us.length, us.reduce((s, u) => s + u.y, 0) / us.length)
          }
        }
      } else if (k === 'a' || k === 'A') setMode(mode.current === 'attack' ? 'normal' : 'attack')
      else if (k === 's' || k === 'S') cmdStop(w, me, mySelection().map((u) => u.id))
      else if (k === 'q' || k === 'Q') useAbility()
      else if (k === 'h' || k === 'H' || k === 'Home') goHome()
      else if (k === 'm' || k === 'M') setMode(mode.current === 'mine' ? 'normal' : 'mine')
      else if (k === ' ') {
        if (lastAlarm.current) centerOn(lastAlarm.current.x, lastAlarm.current.y)
      } else if (k === 'p' || k === 'P') {
        paused.current = !paused.current
        setUi((u) => ({ ...u, paused: paused.current }))
      } else if (k === 'f' || k === 'F') {
        const us = mySelection()
        if (us.length) centerOn(us.reduce((s, u) => s + u.x, 0) / us.length, us.reduce((s, u) => s + u.y, 0) / us.length)
      } else if (k === '+' || k === '=') zoomBy(1.2)
      else if (k === '-' || k === '_') zoomBy(1 / 1.2)
      else if (k === 'Escape') {
        if (mode.current !== 'normal') setMode('normal')
        else selected.current.clear()
      } else return
      e.preventDefault()
    }
    const up = (e: KeyboardEvent) => keys.current.delete(e.key)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused])

  const zoomBy = (f: number, sx?: number, sy?: number) => {
    const { vw, vh } = view()
    const px = sx ?? vw / 2
    const py = sy ?? vh / 2
    const before = toWorld(px, py)
    cam.current.zoom *= f
    clampCam()
    const after = toWorld(px, py)
    cam.current.x += before.x - after.x
    cam.current.y += before.y - after.y
    clampCam()
  }

  // Pointer input on the battlefield: mouse drag-select and right-click orders; on touch, drag to
  // pan, pinch to zoom, tap to select or to order the selection.

  const local = (e: React.PointerEvent | React.WheelEvent) => {
    const r = canvas.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    sound.unlock()
    const p = local(e)
    mouse.current = { ...p, inside: true }
    ;(e.target as Element).setPointerCapture(e.pointerId)
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, p)
      if (touches.current.size === 2) {
        const [a, b] = [...touches.current.values()]
        pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: cam.current.zoom }
        drag.current = null
        return
      }
      drag.current = { x0: p.x, y0: p.y, box: false, pan: true, moved: false, cx: cam.current.x, cy: cam.current.y, button: 0 }
      return
    }
    if (e.button === 1) {
      drag.current = { x0: p.x, y0: p.y, box: false, pan: true, moved: false, cx: cam.current.x, cy: cam.current.y, button: 1 }
      e.preventDefault()
      return
    }
    if (e.button === 2) {
      if (mode.current !== 'normal') setMode('normal')
      else command(p.x, p.y, false)
      return
    }
    if (mode.current === 'attack') {
      command(p.x, p.y, true)
      setMode('normal')
      return
    }
    if (mode.current === 'mine') {
      const { node } = pick(p.x, p.y)
      if (node >= 0) placeMine(node)
      else setMode('normal')
      return
    }
    drag.current = { x0: p.x, y0: p.y, box: true, pan: false, moved: false, cx: 0, cy: 0, button: 0 }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e)
    mouse.current = { ...p, inside: true }
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) {
      touches.current.set(e.pointerId, p)
      if (pinch.current && touches.current.size === 2) {
        const [a, b] = [...touches.current.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        const target = (pinch.current.zoom * d) / Math.max(10, pinch.current.d)
        zoomBy(target / cam.current.zoom, (a.x + b.x) / 2, (a.y + b.y) / 2)
        return
      }
    }
    const d = drag.current
    if (d) {
      if (Math.hypot(p.x - d.x0, p.y - d.y0) > 6) d.moved = true
      if (d.pan && d.moved) {
        cam.current.x = d.cx - (p.x - d.x0) / cam.current.zoom
        cam.current.y = d.cy - (p.y - d.y0) / cam.current.zoom
        clampCam()
      }
    }
    const h = pick(p.x, p.y)
    hover.current = { unit: h.unit?.id ?? 0, hp: h.unit && h.unit.owner !== me ? h.hp : -1, node: h.node }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const p = local(e)
    const d = drag.current
    if (e.pointerType === 'touch') {
      touches.current.delete(e.pointerId)
      if (touches.current.size < 2) pinch.current = null
      drag.current = null
      if (!d || d.moved) return
      // A tap.
      if (mode.current === 'mine') {
        const { node } = pick(p.x, p.y)
        if (node >= 0) placeMine(node)
        else setMode('normal')
        return
      }
      const { unit } = pick(p.x, p.y)
      if (unit && unit.owner === me) select([unit.id])
      else if (mySelection().length && (mode.current === 'attack' || !unit || unit.owner !== me)) {
        command(p.x, p.y, mode.current === 'attack')
        setMode('normal')
      } else if (unit) select([unit.id])
      else selected.current.clear()
      return
    }
    drag.current = null
    if (!d || !d.box) return
    const w = world.current
    if (d.moved) {
      const a = toWorld(Math.min(d.x0, p.x), Math.min(d.y0, p.y))
      const b = toWorld(Math.max(d.x0, p.x), Math.max(d.y0, p.y))
      const inBox = (u: Unit) => u.owner === me && u.x >= a.x && u.x <= b.x && u.y >= a.y && u.y <= b.y
      let ids = w.units.filter((u) => inBox(u) && isShip(u.t)).map((u) => u.id)
      if (!ids.length) ids = w.units.filter(inBox).map((u) => u.id)
      select(ids, e.shiftKey)
      if (ids.length) sound.click()
      return
    }
    const { unit } = pick(p.x, p.y)
    if (!unit) {
      if (!e.shiftKey) selected.current.clear()
      return
    }
    const now = performance.now()
    const dbl = lastClick.current.id === unit.id && now - lastClick.current.t < 350
    lastClick.current = { t: now, id: unit.id }
    if (unit.owner !== me) {
      selected.current.clear()
      selected.current.add(unit.id)
      return
    }
    if (dbl) {
      // Every ship of that type on screen.
      const { vw, vh } = view()
      const a = toWorld(0, 0)
      const b = toWorld(vw, vh)
      select(w.units.filter((u) => u.owner === me && u.t.id === unit.t.id && u.x >= a.x && u.x <= b.x && u.y >= a.y && u.y <= b.y).map((u) => u.id), e.shiftKey)
    } else if (e.shiftKey && selected.current.has(unit.id)) {
      for (const id of withSquads([unit.id])) selected.current.delete(id)
    } else select([unit.id], e.shiftKey)
    sound.click()
  }

  const onWheel = (e: React.WheelEvent) => {
    const p = local(e)
    zoomBy(Math.exp(-e.deltaY * 0.0015), p.x, p.y)
  }

  // Wheel needs a non-passive listener to stop the window from scrolling.
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const stop = (e: WheelEvent) => e.preventDefault()
    c.addEventListener('wheel', stop, { passive: false })
    return () => c.removeEventListener('wheel', stop)
  }, [ready])

  const onMini = (e: React.PointerEvent) => {
    const m = mini.current!
    const r = m.getBoundingClientRect()
    const w = world.current
    const s = Math.min(r.width / w.w, r.height / w.h)
    const ox = (r.width - w.w * s) / 2
    const oy = (r.height - w.h * s) / 2
    const x = (e.clientX - r.left - ox) / s
    const y = (e.clientY - r.top - oy) / s
    if (e.button === 2) {
      const ships = mySelection().filter((u) => isShip(u.t))
      if (ships.length) {
        cmdMove(w, me, ships.map((u) => u.id), x, y, mode.current === 'attack')
        sound.order()
      }
      return
    }
    centerOn(x, y)
    if (e.type === 'pointerdown') (e.target as Element).setPointerCapture(e.pointerId)
  }

  const togglePause = () => {
    paused.current = !paused.current
    setUi((u) => ({ ...u, paused: paused.current, menu: false }))
  }
  const setSpeed = (s: number) => {
    speed.current = s
    setUi((u) => ({ ...u, speed: s }))
  }

  const w = world.current
  const fac = FACTIONS[setup.faction]
  if (!ready)
    return (
      <div className="ew-root ew-loading">
        <p>Charting the system…</p>
      </div>
    )

  const sel = hud.sel.map((i) => w.byId.get(i)).filter((u): u is Unit => !!u)
  return (
    <div className={`ew-root ew-battle ew-${setup.faction}`} ref={root} style={{ ['--ew-accent' as string]: fac.color }}>
      <canvas
        ref={canvas}
        className={`ew-canvas ${ui.mode !== 'normal' ? 'is-targeting' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => ((drag.current = null), touches.current.clear(), (pinch.current = null))}
        onPointerLeave={() => (mouse.current.inside = false)}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />

      <TopBar hud={hud} faction={setup.faction} ui={ui} onPause={togglePause} onSpeed={setSpeed} onMenu={() => setUi((u) => ({ ...u, menu: !u.menu }))}
        onMute={() => {
          sound.setMuted(!sound.muted)
          setUi((u) => ({ ...u, muted: sound.muted }))
        }}
        onHelp={() => setUi((u) => ({ ...u, help: !u.help }))}
      />

      <div className="ew-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`ew-toast is-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
      {ui.mode !== 'normal' && (
        <div className="ew-modehint">
          {ui.mode === 'attack' ? 'Attack-move: click where to go. Ships fight whatever they meet.' : 'Pick a free ore asteroid for the mining platform.'} <kbd>Esc</kbd> to cancel
        </div>
      )}

      <div className="ew-dock">
        <div className="ew-panel ew-minipanel">
          <canvas ref={mini} className="ew-mini" onPointerDown={onMini} onPointerMove={(e) => e.buttons === 1 && onMini(e)} onContextMenu={(e) => e.preventDefault()} />
          <div className="ew-minibtns">
            <button onClick={selectArmy} title="Select every warship (Ctrl+A)">All ships</button>
            <button onClick={goHome} title="Jump to the station (H)">Station</button>
          </div>
        </div>
        <Selection sel={sel} me={me} onAbility={useAbility} onStop={() => cmdStop(w, me, mySelection().map((u) => u.id))}
          onAttackMode={() => setMode('attack')}
          onOnly={(id, drop) => {
            const keep = sel.filter((u) => (drop ? u.t.id !== id : u.t.id === id)).map((u) => u.id)
            selected.current = new Set(keep)
          }}
        />
        <BuildPanel w={w} hud={hud} faction={setup.faction} mode={ui.mode} onBuild={build} onUpgrade={upgrade} onCancel={(i) => cmdCancel(w, me, i)}
          onCancelUpgrade={() => cancelUpgrade(w, me)}
          onMine={() => setMode(mode.current === 'mine' ? 'normal' : 'mine')}
        />
      </div>

      {ui.paused && hud.winner === -1 && !ui.menu && (
        <div className="ew-overlay" onClick={togglePause}>
          <div className="ew-card">
            <h2>Paused</h2>
            <p className="ew-muted">Click or press P to resume.</p>
          </div>
        </div>
      )}
      {ui.menu && hud.winner === -1 && (
        <div className="ew-overlay">
          <div className="ew-card">
            <h2>Battle menu</h2>
            <button className="ew-go" onClick={() => setUi((u) => ({ ...u, menu: false }))}>Resume</button>
            <button onClick={onAgain}>Restart battle</button>
            <button onClick={onExit}>Retreat to title</button>
          </div>
        </div>
      )}
      {ui.help && <Help onClose={() => setUi((u) => ({ ...u, help: false }))} />}
      {hud.winner !== -1 && <Result w={w} me={me} won={hud.winner === me} difficulty={setup.difficulty} onAgain={onAgain} onExit={onExit} />}
    </div>
  )
}

// --- HUD pieces -----------------------------------------------------------------------------------

function TopBar({ hud, faction, ui, onPause, onSpeed, onMenu, onMute, onHelp }: {
  hud: Hud; faction: FactionId; ui: { paused: boolean; speed: number; muted: boolean }; onPause: () => void; onSpeed: (s: number) => void; onMenu: () => void; onMute: () => void; onHelp: () => void
}) {
  return (
    <div className="ew-top">
      <span className="ew-badge">{FACTIONS[faction].name}</span>
      <span className="ew-stat" title="Credits (income per minute)">
        <b>{fmt(hud.credits)}</b> <small>cr · +{fmt(hud.income * 60)}/min</small>
      </span>
      <span className={`ew-stat ${hud.pop >= hud.popCap ? 'is-full' : ''}`} title="Fleet size / capacity. Capture beacons and upgrade the station for more.">
        Fleet <b>{hud.pop}</b>/{hud.popCap}
      </span>
      <span className="ew-stat ew-hide-narrow" title="Mining platforms and beacons held">
        Ore <b>{hud.mines}</b> · Beacons <b>{hud.beacons}</b>/3
      </span>
      <span className="ew-stat ew-hide-narrow">{clock(hud.time)}</span>
      <span className="ew-top-right">
        <span className="ew-speed" role="group" aria-label="Game speed">
          {[1, 2, 3].map((s) => (
            <button key={s} className={ui.speed === s ? 'is-on' : ''} onClick={() => onSpeed(s)}>
              {s}×
            </button>
          ))}
        </span>
        <button onClick={onPause} title="Pause (P)">{ui.paused ? '▶' : '❚❚'}</button>
        <button onClick={onMute} title="Sound">{ui.muted ? '🔇' : '🔊'}</button>
        <button onClick={onHelp} title="Controls">?</button>
        <button onClick={onMenu} title="Menu">☰</button>
      </span>
    </div>
  )
}

function Bar({ value, max, kind }: { value: number; max: number; kind: 'hull' | 'shield' | 'hp' }) {
  const f = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  return (
    <span className={`ew-bar is-${kind} ${kind === 'hull' && f < 0.3 ? 'is-low' : ''}`}>
      <i style={{ width: `${f * 100}%` }} />
    </span>
  )
}

function Selection({ sel, me, onAbility, onStop, onAttackMode, onOnly }: {
  sel: Unit[]; me: Owner; onAbility: () => void; onStop: () => void; onAttackMode: () => void; onOnly: (id: string, drop: boolean) => void
}) {
  if (!sel.length)
    return (
      <div className="ew-panel ew-sel is-empty">
        <p>Drag across your ships to select them, then right-click to move or attack.</p>
        <p className="ew-muted ew-small">Tap a ship on touch screens, then tap where it should go.</p>
      </div>
    )
  const mine = sel[0].owner === me
  if (sel.length === 1 || (sel.every((u) => u.t.id === sel[0].t.id) && sel[0].t.squad > 1 && sel.length <= sel[0].t.squad)) {
    const u = sel[0]
    const t = u.t
    const ab = t.ability ? ABILITIES[t.ability] : null
    const squad = sel.length > 1
    return (
      <div className={`ew-panel ew-sel ${mine ? '' : 'is-enemy'}`}>
        <div className="ew-sel-head">
          <img src={spriteUrl(t.sprite)} alt="" className="ew-portrait" />
          <div>
            <strong>{t.name}{squad ? ` ×${sel.length}` : ''}</strong>
            <span className="ew-muted ew-small">{mine ? t.blurb : `Enemy ${t.tier}. ${t.blurb}`}</span>
            <div className="ew-bars">
              <span>Hull</span>
              <Bar value={squad ? sel.reduce((s, x) => s + x.hull, 0) : u.hull} max={squad ? sel.length * u.hullMax : u.hullMax} kind="hull" />
              <small>{fmt(u.hull)}</small>
              {t.shield > 0 && (
                <>
                  <span>Shield</span>
                  <Bar value={u.shield} max={t.shield} kind="shield" />
                  <small>{fmt(u.shield)}{shieldMax(u) < t.shield ? ' (damaged)' : ''}</small>
                </>
              )}
            </div>
          </div>
        </div>
        {u.hps.length > 0 && (
          <div className="ew-hps">
            {t.hardpoints.map((h, i) => (
              <span key={i} className={`ew-hp is-${h.kind} ${u.hps[i].hp <= 0 ? 'is-dead' : ''}`} title={`${HP_NAME[h.kind]}: ${fmt(u.hps[i].hp)}/${fmt(u.hps[i].max)}`}>
                <em>{HP_NAME[h.kind]}</em>
                <Bar value={u.hps[i].hp} max={u.hps[i].max} kind="hp" />
              </span>
            ))}
          </div>
        )}
        {!mine && u.hps.length > 0 && <p className="ew-muted ew-small">Select your ships, hover this one and right-click a marker to target a hardpoint.</p>}
        {mine && isShip(t) && (
          <div className="ew-actions">
            <button onClick={onAttackMode} title="Attack-move (A)">Attack-move</button>
            <button onClick={onStop} title="Stop (S)">Stop</button>
            {ab && (
              <button className="ew-ability" disabled={u.abilityCd > 0} onClick={onAbility} title={`${ab.blurb} (Q)`}>
                {ab.name}
                {u.abilityCd > 0 ? ` · ${Math.ceil(u.abilityCd)}s` : ''}
              </button>
            )}
            {u.kills > 0 && <span className="ew-muted ew-small">{u.kills} kills</span>}
          </div>
        )}
        {mine && building(u) && <p className="ew-muted ew-small">Under construction: {Math.ceil(u.building)} s</p>}
        {mine && t.tier === 'station' && <p className="ew-muted ew-small">Right-click to set where new ships gather.</p>}
      </div>
    )
  }
  // Several kinds: a row per type.
  const types = new Map<string, Unit[]>()
  for (const u of sel) types.set(u.t.id, [...(types.get(u.t.id) ?? []), u])
  const ready = sel.filter((u) => u.t.ability && u.abilityCd <= 0).length
  const withAb = sel.filter((u) => u.t.ability).length
  return (
    <div className="ew-panel ew-sel">
      <div className="ew-group">
        {[...types.values()].map((us) => {
          const t = us[0].t
          const hull = us.reduce((s, u) => s + u.hull, 0) / us.reduce((s, u) => s + u.hullMax, 0)
          return (
            <button key={t.id} className="ew-group-item" onClick={(e) => onOnly(t.id, e.shiftKey)} title={`${t.name}: click to keep only these, Shift-click to drop them`}>
              <img src={spriteUrl(t.sprite)} alt="" />
              <b>{us.length}</b>
              <Bar value={hull} max={1} kind="hull" />
            </button>
          )
        })}
      </div>
      <div className="ew-actions">
        <span className="ew-muted ew-small">{sel.length} ships</span>
        <button onClick={onAttackMode} title="Attack-move (A)">Attack-move</button>
        <button onClick={onStop} title="Stop (S)">Stop</button>
        {withAb > 0 && (
          <button className="ew-ability" disabled={!ready} onClick={onAbility} title="Every selected ship that can fires its ability (Q)">
            Abilities ({ready}/{withAb})
          </button>
        )}
      </div>
    </div>
  )
}

function BuildPanel({ w, hud, faction, mode, onBuild, onUpgrade, onCancel, onCancelUpgrade, onMine }: {
  w: World; hud: Hud; faction: FactionId; mode: Mode; onBuild: (id: string) => void; onUpgrade: () => void; onCancel: (i: number) => void; onCancelUpgrade: () => void; onMine: () => void
}) {
  const me: Owner = 0
  const ships = buildable(faction)
  const mine = unitOf(faction, 'mine')
  const next = hud.level < MAX_LEVEL ? UPGRADES[hud.level + 1] : null
  const freeOre = w.nodes.filter((n) => !n.mine).length
  const [hovered, setHovered] = useState<UnitType | 'upgrade' | null>(null)
  const info = hovered === 'upgrade' ? null : hovered
  return (
    <div className="ew-panel ew-build">
      <div className="ew-queue">
        {hud.upgrade && (
          <button className="ew-q is-upgrade" onClick={onCancelUpgrade} title="Station upgrade: click to cancel and refund">
            <span>Lv{hud.level + 1}</span>
            <i style={{ width: `${(1 - hud.upgrade.left / hud.upgrade.total) * 100}%` }} />
          </button>
        )}
        {hud.queue.map((q, i) => (
          <button key={i} className="ew-q" onClick={() => onCancel(i)} title={`${UNIT[q.unit].name}: click to cancel and refund`}>
            <img src={spriteUrl(UNIT[q.unit].sprite)} alt="" />
            {i === 0 && <i style={{ width: `${(1 - q.left / q.total) * 100}%` }} />}
          </button>
        ))}
        {!hud.queue.length && !hud.upgrade && <span className="ew-muted ew-small">Shipyard idle</span>}
      </div>
      <div className="ew-buildgrid">
        {ships.map((t) => {
          const why = cantBuild(w, me, t.id)
          const locked = t.level > hud.level
          return (
            <button key={t.id} className={`ew-buildbtn ${locked ? 'is-locked' : why ? 'is-off' : ''}`} onClick={() => onBuild(t.id)} onMouseEnter={() => setHovered(t)} onMouseLeave={() => setHovered(null)}
              title={`${t.name} (${t.cost} cr)${why ? `\n${why}` : ''}\n${t.blurb}`}
            >
              <img src={spriteUrl(t.sprite)} alt="" />
              <span>{locked ? `Lv${t.level}` : t.cost}</span>
            </button>
          )
        })}
        <button className={`ew-buildbtn ${mode === 'mine' ? 'is-active' : ''} ${cantMine(w, me, w.nodes.find((n) => !n.mine)?.id ?? -1) === 'Not enough credits' || !freeOre ? 'is-off' : ''}`}
          onClick={onMine} onMouseEnter={() => setHovered(mine)} onMouseLeave={() => setHovered(null)} title={`${mine.name} (${mine.cost} cr): then click a free ore asteroid (M)`}
        >
          <img src={spriteUrl(mine.sprite)} alt="" />
          <span>{mine.cost}</span>
        </button>
        <button className={`ew-buildbtn ew-upbtn ${cantUpgrade(w, me) ? 'is-off' : ''}`} onClick={onUpgrade} onMouseEnter={() => setHovered('upgrade')} onMouseLeave={() => setHovered(null)}
          title={next ? `Upgrade station to level ${hud.level + 1} (${next.cost} cr, ${next.time} s)` : 'Station fully upgraded'}
          disabled={!next}
        >
          <b>{next ? `Lv${hud.level + 1}` : 'Max'}</b>
          <span>{next ? next.cost : ''}</span>
        </button>
      </div>
      <div className="ew-buildinfo">
        {info ? (
          <>
            <strong>{info.name}</strong> <span className="ew-muted">{info.cost} cr · {info.build}s{info.pop ? ` · fleet ${info.pop}` : ''}</span>
            <span className="ew-small">{cantBuild(w, me, info.id) && info.tier !== 'mine' ? cantBuild(w, me, info.id) : info.blurb}</span>
          </>
        ) : hovered === 'upgrade' ? (
          <>
            <strong>Station level {hud.level + 1}</strong>
            <span className="ew-small">{next ? `${next.cost} cr. More hull, stronger guns, +4 fleet capacity and ${buildable(faction).filter((t) => t.level === hud.level + 1).map((t) => t.name).join(', ') || 'income'}.` : 'Fully upgraded.'}</span>
          </>
        ) : (
          <span className="ew-muted ew-small">Station level {hud.level}. Hover a ship for details.</span>
        )}
      </div>
    </div>
  )
}

function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="ew-overlay" onClick={onClose}>
      <div className="ew-card ew-help" onClick={(e) => e.stopPropagation()}>
        <h2>Controls</h2>
        <dl>
          <dt>Left-drag</dt><dd>Select ships</dd>
          <dt>Click / Shift-click</dt><dd>Select / add to selection; double-click selects that type on screen</dd>
          <dt>Right-click</dt><dd>Move, or attack what's under the cursor. On a hardpoint marker: target it</dd>
          <dt>A, then click</dt><dd>Attack-move</dd>
          <dt>S · Q</dt><dd>Stop · use ability</dd>
          <dt>Ctrl+1–9 · 1–9</dt><dd>Set group · select group (twice to jump to it)</dd>
          <dt>Arrows · middle-drag · wheel</dt><dd>Pan · pan · zoom</dd>
          <dt>H · Space · F</dt><dd>Station · last alert · selection</dd>
          <dt>M</dt><dd>Place a mining platform</dd>
          <dt>P</dt><dd>Pause</dd>
          <dt>Touch</dt><dd>Drag to pan, pinch to zoom, tap a ship then tap where to go</dd>
        </dl>
        <h3>Tips</h3>
        <ul>
          <li>Flak shreds fighters; turbolasers can't track them. Mix your fleet.</li>
          <li>Missiles and torpedoes go through shields. Destroyed shield generators stop shields recharging.</li>
          <li>Engines down: the ship crawls. Hangars down: no more fighters.</li>
        </ul>
        <button className="ew-go" onClick={onClose}>Got it</button>
      </div>
    </div>
  )
}

function Result({ w, me, won, difficulty, onAgain, onExit }: { w: World; me: Owner; won: boolean; difficulty: Difficulty; onAgain: () => void; onExit: () => void }) {
  const p = w.players[me]
  const e = w.players[other(me)]
  return (
    <div className="ew-overlay">
      <div className={`ew-card ew-result ${won ? 'is-won' : 'is-lost'}`}>
        <h2>{won ? 'Victory' : 'Defeat'}</h2>
        <p className="ew-muted">
          {won ? `The ${FACTIONS[e.faction].name} station is destroyed.` : `Our station has fallen.`} {clock(w.time)} against the {DIFFICULTY[difficulty].name.toLowerCase()}.
        </p>
        <table>
          <tbody>
            <tr><th /><th>Us</th><th>Them</th></tr>
            <tr><td>Ships built</td><td>{p.stats.built}</td><td>{e.stats.built}</td></tr>
            <tr><td>Kills</td><td>{p.stats.killed}</td><td>{e.stats.killed}</td></tr>
            <tr><td>Losses</td><td>{p.stats.lost}</td><td>{e.stats.lost}</td></tr>
            <tr><td>Credits earned</td><td>{fmt(p.stats.earned)}</td><td>{fmt(e.stats.earned)}</td></tr>
          </tbody>
        </table>
        <button className="ew-go" onClick={onAgain}>Fight again</button>
        <button onClick={onExit}>Back to title</button>
      </div>
    </div>
  )
}

