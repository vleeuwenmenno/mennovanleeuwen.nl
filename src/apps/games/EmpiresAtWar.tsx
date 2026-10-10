import { useEffect, useRef, useState } from 'react'
import type { WinState } from '../../os/wm'
import { DIFFICULTY, newBrain, think, type Brain } from './empires/ai'
import { FACTIONS, TECH, UNIT, UNITS, buildable, dims, isShip, type HardpointKind, type Tier } from './empires/data'
import { DetailPanel, Frame, SelectionPanel, TacticalMap, TopBar, type Command, type Hud, type MapFilter, type Mode } from './empires/Hud'
import { HowToPlay, KeybindsPanel, Lobby, MainMenu, Modal, Result, SettingsPanel, slotName, type Setup } from './empires/Menus'
import { MAP } from './empires/maps'
import { actionFor, getSettings, keyName, useSettings } from './empires/settings'
import { HP_NAME } from './empires/icons'
import { Renderer, type Camera, type View } from './empires/render'
import {
  STEP, cmdAbility, cmdAttack, cmdBuild, cmdCancel, cmdCancelResearch, cmdHold, cmdMove, cmdPatrol, cmdRally, cmdResearch, cmdSite, cmdStop, foes, hpPos, newWorld, tick, type Owner, type SimEvent,
  type Unit, type World,
} from './empires/sim'
import { EmpiresSound, type OrderKind } from './empires/sound'
import { TechTree } from './empires/TechTree'
import { useHighScore, useIsFocused } from './shared'
import './empires/empires.css'

// Empires At War: a space RTS in the spirit of Empire at War, set in a Clone Wars style war
// between a Republic navy and a droid Confederacy. One skirmish map against the AI: mine ore,
// capture beacons, upgrade the station, build up from fighters to a flagship, and destroy the
// enemy station. This file holds the screens, the input and the HUD; the battle runs in
// empires/sim.ts and is drawn by empires/render.ts.

const SPRITES = [...new Set(UNITS.map((u) => u.sprite))]

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

/** Right-click gives orders here, so it must not open the browser's or the window's menu. */
const noMenu = (e: React.MouseEvent) => {
  e.preventDefault()
  e.stopPropagation()
}

export function EmpiresAtWar({ win }: { win: WinState }) {
  useDisplayFont()
  const [screen, setScreen] = useState<'menu' | 'lobby' | 'battle'>('menu')
  const [setup, setSetup] = useState<Setup | null>(null)
  const [round, setRound] = useState(0)
  const { best } = useHighScore('empires')
  const sound = useRef<EmpiresSound>(null as unknown as EmpiresSound)
  if (!sound.current) sound.current = new EmpiresSound()
  useEffect(() => () => sound.current.dispose(), [])

  if (screen === 'menu') return <MainMenu sound={sound.current} victories={best ?? 0} onPlay={() => setScreen('lobby')} />
  if (screen === 'lobby' || !setup)
    return (
      <Lobby
        sound={sound.current}
        onBack={() => setScreen('menu')}
        onLaunch={(s) => {
          setSetup(s)
          setRound((r) => r + 1)
          setScreen('battle')
        }}
      />
    )
  return (
    <Battle
      key={round}
      win={win}
      setup={setup}
      sound={sound.current}
      onExit={() => setScreen('lobby')}
      onAgain={() => setRound((r) => r + 1)}
    />
  )
}

// --- Battle ---------------------------------------------------------------------------------------

type Toast = { id: number; text: string; tone: 'good' | 'bad' | 'info'; t: number }

function snapshot(w: World, me: Owner, sel: Set<number>): Hud {
  const p = w.players[me]
  return {
    credits: p.credits, income: p.income, pop: p.pop, popCap: p.popCap, level: p.level,
    queue: p.queue.map((q) => ({ ...q })), research: p.research.map((r) => ({ ...r })), techs: [...p.techs], time: w.time, sel: [...sel], winner: w.winner,
    beacons: w.beacons.filter((b) => b.owner === p.team).length, beaconsAll: w.beacons.length, mines: w.units.filter((u) => u.owner === me && u.t.tier === 'mine').length,
  }
}

function Battle({ win, setup, sound, onExit, onAgain }: { win: WinState; setup: Setup; sound: EmpiresSound; onExit: () => void; onAgain: () => void }) {
  // Players are the open slots, in spawn order; we're the one marked 'you'.
  const [seats] = useState(() => setup.slots.map((s, i) => ({ ...s, spawn: i, name: slotName(s, i) })).filter((s) => s.kind !== 'closed'))
  const me: Owner = seats.findIndex((s) => s.kind === 'you')
  const world = useRef<World>(null as unknown as World)
  if (!world.current)
    world.current = newWorld(
      MAP[setup.map],
      seats.map((s) => ({ faction: s.faction, team: s.team, spawn: s.spawn, incomeMul: s.kind === 'ai' ? DIFFICULTY[s.difficulty].income : 1 })),
      { credits: setup.credits },
    )
  const myTeam = world.current.players[me].team
  const myFaction = world.current.players[me].faction
  const brains = useRef<Brain[]>(seats.map((s, i) => (s.kind === 'ai' ? newBrain(i, s.difficulty) : null)).filter((b): b is Brain => !!b))
  const settings = useSettings()
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const renderer = useRef<Renderer>(null as unknown as Renderer)
  if (!renderer.current) renderer.current = new Renderer(SPRITES)
  const w0 = world.current
  const st0 = w0.byId.get(w0.players[me].station)!
  const cam = useRef<Camera>({ x: st0.x + 500, y: st0.y, zoom: 0.5 })
  // Dev builds expose the battle for poking at from the console.
  if (import.meta.env.DEV) (window as unknown as { __ew: unknown }).__ew = { world: world.current, brains: brains.current, cam: cam.current }
  const selected = useRef(new Set<number>())
  const groups = useRef(new Map<string, number[]>())
  const mode = useRef<Mode>('normal')
  /** An ore asteroid picked with nothing else selected: the command card offers to build on it. */
  const pickedNode = useRef(-1)
  const hover = useRef({ unit: 0, hp: -1, node: -1 })
  const mouse = useRef({ x: -1, y: -1, inside: false })
  const keys = useRef(new Set<string>())
  const speed = useRef(1)
  const paused = useRef(false)
  const lastAlarm = useRef<{ x: number; y: number; t: number } | null>(null)
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
  const [ui, setUi] = useState({ paused: false, speed: 1, mode: 'normal' as Mode, menu: false, panel: null as 'settings' | 'keys' | 'howto' | null, tree: false })
  /** Whether the game was paused before a menu opened (menus pause it, closing them restores that). */
  const pausedBefore = useRef(false)
  const uiRef = useRef(ui)
  uiRef.current = ui
  const [mapFilter, setMapFilter] = useState<MapFilter>('all')
  const mapFilterRef = useRef(mapFilter)
  mapFilterRef.current = mapFilter
  // A name for the battlefield, for the top bar.
  // The battlefield's name for the top bar, and who's fighting whom for the map header ("2 v 2").
  const sector = MAP[setup.map].name
  const sides = `${seats.filter((x) => x.team === myTeam).length} v ${seats.filter((x) => x.team !== myTeam).length}`
  const focused = useIsFocused(win)
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  const { best, submit } = useHighScore('empires')
  const bestRef = useRef(best)
  bestRef.current = best
  const toastId = useRef(1)

  const toast = (text: string, tone: Toast['tone'] = 'info') =>
    (tone === 'bad' || getSettings().toasts) &&
    setToasts((ts) => [...ts.slice(-3), { id: toastId.current++, text, tone, t: performance.now() }])
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
    if (ids.length) pickedNode.current = -1
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
      if (!u.seen[myTeam]) continue
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

  /** Who answers an order on the radio: the biggest ship in the selection. */
  const RANK: Tier[] = ['station', 'fighter', 'gunship', 'frigate', 'cruiser', 'capital']
  const voice = (): Tier => mySelection().reduce<Tier>((best, u) => (RANK.indexOf(u.t.tier) > RANK.indexOf(best) ? u.t.tier : best), 'station')
  const say = (kind: OrderKind) => sound.order(kind, myFaction, voice())

  /** A click with a command from the grid (or its key) armed: move, attack-move, patrol or rally. */
  const modeClick = (sx: number, sy: number, m: Mode) => {
    const w = world.current
    const { at } = pick(sx, sy)
    const ids = mySelection().map((u) => u.id)
    if (m === 'rally') {
      cmdRally(w, me, at.x, at.y)
      renderer.current.ping(at.x, at.y, '#7dffa0')
    } else if (m === 'patrol') {
      cmdPatrol(w, me, ids, at.x, at.y)
      renderer.current.ping(at.x, at.y, '#8fd0ff')
    } else if (m === 'move') {
      cmdMove(w, me, ids, at.x, at.y)
      renderer.current.ping(at.x, at.y, '#7dffa0')
    } else return command(sx, sy, true)
    say(m === 'rally' ? 'rally' : m === 'patrol' ? 'patrol' : 'move')
  }

  /** The command grid (and its keys). Point-and-click ones arm a mode; the rest act at once. */
  const runCommand = (c: Command) => {
    const w = world.current
    const ids = mySelection().map((u) => u.id)
    sound.unlock()
    if (c === 'stop') {
      if (!mySelection().some((u) => isShip(u.t))) return sound.error()
      cmdStop(w, me, ids)
      say('stop')
    } else if (c === 'hold') {
      if (!mySelection().some((u) => isShip(u.t))) return sound.error()
      cmdHold(w, me, ids)
      say('hold')
    } else if (c === 'ability') useAbility()
    else {
      if (c === 'rally' ? !mySelection().some((u) => u.t.tier === 'station') : !mySelection().some((u) => isShip(u.t))) return sound.error()
      setMode(mode.current === c ? 'normal' : c)
      sound.arm()
    }
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
        say('rally')
      }
      return
    }
    if (unit && foes(w, unit.owner, me)) {
      cmdAttack(w, me, ships.map((u) => u.id), unit.id, hp)

      renderer.current.ping(unit.x, unit.y, '#ff5a50')
      say(hp >= 0 ? 'target' : 'attack')
      if (hp >= 0) toast(`Targeting ${HP_NAME[unit.t.hardpoints[hp].kind].toLowerCase()}`, 'info')
    } else {
      cmdMove(w, me, ships.map((u) => u.id), at.x, at.y, attackMove)
      renderer.current.ping(at.x, at.y, attackMove ? '#ffaa5a' : '#7dffa0')
      say(attackMove ? 'attackMove' : 'move')
    }
  }

  const buildSite = (node: number, tier: 'mine' | 'defense') => {
    sound.unlock()
    const why = cmdSite(world.current, me, node, tier)
    if (why) {
      toast(why, 'bad')
      sound.error()
      return
    }
    sound.constructing()
    // Select what's going up, so its construction shows in the card.
    select([world.current.nodes[node].site])
  }

  const centerOn = (x: number, y: number) => {
    cam.current.x = x
    cam.current.y = y
    clampCam()
  }
  /** Select the station (where ships are built) and look at it. */
  const selectStation = () => {
    const st = world.current.byId.get(world.current.players[me].station)
    if (!st) return
    select([st.id])
    centerOn(st.x + 250, st.y + 120)
    sound.select(myFaction, 'station')
  }
  const selectIdle = () => {
    const idle = world.current.units.filter((u) => u.owner === me && isShip(u.t) && !u.parent && u.order.k === 'idle' && !u.target)
    select(idle.map((u) => u.id))
    if (idle.length) centerOn(idle.reduce((s, u) => s + u.x, 0) / idle.length, idle.reduce((s, u) => s + u.y, 0) / idle.length)
    else toast('No idle ships', 'info')
    if (idle.length) sound.select(myFaction, voice())
    else sound.error()
  }
  const selectArmy = () => {
    select(world.current.units.filter((u) => u.owner === me && isShip(u.t)).map((u) => u.id))
    if (mySelection().length) sound.select(myFaction, voice())
  }
  const useAbility = () => {
    const ready = mySelection().filter((u) => u.t.ability && u.abilityCd <= 0)
    const n = cmdAbility(world.current, me, mySelection().map((u) => u.id))
    if (n) for (const id of new Set(ready.map((u) => u.t.ability!))) sound.ability(id)
    else if (mySelection().some((u) => u.t.ability)) sound.error()
  }

  const build = (id: string, times = 1) => {
    sound.unlock()
    let why: string | null = null
    let n = 0
    for (let i = 0; i < times; i++) {
      why = cmdBuild(world.current, me, id)
      if (why) break
      n++
    }
    if (!n && why) {
      toast(why, 'bad')
      sound.error()
    } else sound.queued()
  }
  /** Right-click on a ship card: drop the last one of that type from the queue. */
  const unqueue = (id: string) => {
    const q = world.current.players[me].queue
    for (let i = q.length - 1; i >= 0; i--)
      if (q[i].unit === id) {
        cmdCancel(world.current, me, i)
        sound.unqueued()
        return
      }
  }
  const research = (id: string) => {
    sound.unlock()
    const why = cmdResearch(world.current, me, id)
    if (why) {
      toast(why, 'bad')
      sound.error()
    } else sound.researchStarted()
  }

  // Load the art, then start.
  useEffect(() => {
    let live = true
    sound.unlock()
    void Promise.all([renderer.current.ready(), sound.warm(myFaction)]).then(() => live && setReady(true))
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
          for (const b of brains.current) think(w, b, STEP)
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
      const set = settingsRef.current
      const pan = ((900 * set.cameraSpeed) / cm.zoom) * dt
      const k = keys.current
      if (k.has('arrowleft') || k.has(set.keys.panLeft)) cm.x -= pan
      if (k.has('arrowright') || k.has(set.keys.panRight)) cm.x += pan
      if (k.has('arrowup') || k.has(set.keys.panUp)) cm.y -= pan
      if (k.has('arrowdown') || k.has(set.keys.panDown)) cm.y += pan
      const edge = set.edgeScroll === 'always' || (set.edgeScroll === 'fullscreen' && !!root.current?.closest('.is-page-full'))
      if (edge && mouse.current.inside) {
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
        if (e.k === 'fire') sound.fire(e.kind, where(e.x, e.y), w.players[e.owner].faction)
        else if (e.k === 'hit') sound.hit(e.shield, e.kind === 'turbo' || e.kind === 'missile', where(e.x, e.y))
        else if (e.k === 'boom') sound.boom(e.size, where(e.x, e.y))
        else if (e.k === 'shieldsDown') sound.shieldsDown(where(e.x, e.y))
        else if (e.k === 'launch') sound.launch(where(e.x, e.y))
        else if (e.k === 'ability' && e.owner !== me) sound.ability(e.id, where(e.x, e.y))
        else if (e.k === 'hpdown') {
          sound.hardpointDown(where(e.x, e.y))
          if (e.owner === me) toast(`${HP_NAME[e.what as HardpointKind]} destroyed on one of our ships`, 'bad')
        } else if (e.k === 'built' && e.owner === me) {
          const t = UNIT[e.unit]
          if (t.tier === 'mine' || t.tier === 'defense') sound.structureDone(t.tier)
          else sound.shipReady(myFaction, t.tier)
          toast(t.tier === 'mine' ? `${t.name} is drilling` : t.tier === 'defense' ? `${t.name} online` : `${t.name}${t.squad > 1 ? ' squadron' : ''} ready`, 'good')
        } else if (e.k === 'out') {
          sound.eliminated(!foes(w, e.owner, me))
          if (e.owner === me) toast('Our station has fallen', 'bad')
          else toast(`${seats[e.owner].name} has been eliminated`, foes(w, e.owner, me) ? 'good' : 'bad')
        } else if (e.k === 'beacon') {
          if (e.owner === myTeam) {
            sound.capture(true)
            toast('Beacon captured: +6 fleet capacity', 'good')
          } else if (e.prev === myTeam) {
            sound.capture(false)
            toast('We lost a beacon', 'bad')
          }
        } else if (e.k === 'alarm' && e.owner === me) {
          sound.alarm(e.what.endsWith('station'))
          lastAlarm.current = { x: e.x, y: e.y, t: w.time }
          toast(`${e.what} under attack! (Space to look)`, 'bad')
        } else if (e.k === 'survey') {
          if (e.owner === myTeam && e.prev !== myTeam) {
            sound.surveyed()
            toast('Ore surveyed: click it to build a mining or defense platform', 'good')
          } else if (e.prev === myTeam) toast(e.owner === -1 ? 'An unused ore claim has lapsed' : 'We lost the claim on an ore asteroid', 'bad')
        } else if (e.k === 'tech' && e.owner === me) {
          sound.researchDone()
          toast(`Research complete: ${TECH[e.id].name}`, 'good')
        } else if (e.k === 'level' && e.owner === me) {
          sound.levelUp()
          const unlocked = buildable(myFaction).filter((t) => t.level === e.level).map((t) => t.name)
          toast(`Station level ${e.level}${unlocked.length ? `: ${unlocked.join(', ')} unlocked` : ''}`, 'good')
        }
      }
      // Drop dead ships from the selection.
      for (const id of selected.current) if (!w.byId.get(id)) selected.current.delete(id)

      const h = hover.current
      const v: View = {
        me,
        bars: settingsRef.current.bars,
        rings: settingsRef.current.rings,
        selected: selected.current,
        hover: h.unit,
        hoverHp: h.hp,
        box: drag.current?.box && drag.current.moved ? { x0: drag.current.x0, y0: drag.current.y0, x1: mouse.current.x, y1: mouse.current.y } : null,
        node: selected.current.size ? -1 : pickedNode.current,
        hoverNode: h.node,
        showRally: mySelection().some((u) => u.t.tier === 'station'),
      }
      renderer.current.draw(ctx, w, cm, vw, vh, v, dt * (paused.current ? 0 : speed.current))
      sound.ambience(paused.current ? 0 : dt)
      renderer.current.minimap(mctx, w, me, cm, vw, vh, m.clientWidth, m.clientHeight, lastAlarm.current, mapFilterRef.current)

      hudT -= dt
      if (hudT <= 0 || (w.winner !== -1 && !ended)) {
        hudT = 0.15
        setHud(snapshot(w, me, selected.current))
        if (w.winner !== -1 && !ended) {
          ended = true
          sound.stopDrone()
          if (w.winner === myTeam) {
            sound.victory()
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
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select')) return
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase()
      const w = world.current
      const keymap = settingsRef.current.keys
      if ((uiRef.current.menu || uiRef.current.panel) && k !== 'escape') return
      const action = !e.ctrlKey && !e.metaKey && !e.altKey ? actionFor(keymap, k) : undefined
      // Panning keys are held, not pressed.
      if (k.startsWith('arrow') || action === 'panUp' || action === 'panDown' || action === 'panLeft' || action === 'panRight') {
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
      if (e.ctrlKey && k === 'a') {
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
      } else if (k === 'escape') {
        // Esc backs out of whatever is open, one step at a time, and finally opens the menu.
        if (uiRef.current.menu || uiRef.current.panel) closeMenu()
        else if (uiRef.current.tree) setTree(false)
        else if (mode.current !== 'normal') setMode('normal')
        else if (selected.current.size || pickedNode.current >= 0) {
          selected.current.clear()
          pickedNode.current = -1
        } else openMenu()
      } else if (action === 'attack' || action === 'move' || action === 'patrol' || action === 'rally' || action === 'hold' || action === 'stop') runCommand(action)
      else if (action === 'ability') useAbility()
      else if (action === 'station' || k === 'home') selectStation()
      else if (action === 'idle') selectIdle()
      else if (action === 'alert') {
        if (lastAlarm.current) centerOn(lastAlarm.current.x, lastAlarm.current.y)
      } else if (action === 'techTree') setTree(!uiRef.current.tree)
      else if (action === 'pause') togglePause()
      else if (action === 'focus') {
        const us = mySelection()
        if (us.length) centerOn(us.reduce((s, u) => s + u.x, 0) / us.length, us.reduce((s, u) => s + u.y, 0) / us.length)
      } else if (action === 'zoomIn' || k === '+') zoomBy(1.2)
      else if (action === 'zoomOut' || k === '_') zoomBy(1 / 1.2)
      else return
      e.preventDefault()
    }
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase())
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
    if (mode.current !== 'normal') {
      modeClick(p.x, p.y, mode.current)
      // Shift keeps the command armed for more clicks.
      if (!e.shiftKey) setMode('normal')
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
    hover.current = { unit: h.unit?.id ?? 0, hp: h.hp, node: h.node }
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
      const { unit, node } = pick(p.x, p.y)
      if (unit && unit.owner === me) select([unit.id])
      else if (mode.current !== 'normal') {
        modeClick(p.x, p.y, mode.current)
        setMode('normal')
      } else if (mySelection().length && (!unit || foes(w0, unit.owner, me))) command(p.x, p.y, false)
      else if (unit) select([unit.id])
      else {
        selected.current.clear()
        pickedNode.current = node
      }
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
      if (mySelection().length) sound.select(myFaction, voice())
      return
    }
    const { unit, node } = pick(p.x, p.y)
    if (!unit) {
      if (!e.shiftKey) {
        selected.current.clear()
        // Clicking ore (with nothing on it to select) opens its build card.
        pickedNode.current = node
        if (node >= 0) sound.click()
      }
      return
    }
    const now = performance.now()
    const dbl = lastClick.current.id === unit.id && now - lastClick.current.t < 350
    lastClick.current = { t: now, id: unit.id }
    if (unit.owner !== me) {
      selected.current.clear()
      selected.current.add(unit.id)
      sound.click()
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
    // The crew of what we just picked answers (structures just click).
    if (isShip(unit.t) || unit.t.tier === 'station') sound.select(myFaction, unit.t.tier)
    else sound.click()
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
        if (mode.current === 'patrol') cmdPatrol(w, me, ships.map((u) => u.id), x, y)
        else cmdMove(w, me, ships.map((u) => u.id), x, y, mode.current === 'attack')
        say(mode.current === 'patrol' ? 'patrol' : mode.current === 'attack' ? 'attackMove' : 'move')
      }
      return
    }
    centerOn(x, y)
    if (e.type === 'pointerdown') (e.target as Element).setPointerCapture(e.pointerId)
  }

  const togglePause = () => {
    paused.current = !paused.current
    sound.pause(paused.current)
    setUi((u) => ({ ...u, paused: paused.current }))
  }
  // The battle menu and the settings panels pause the game while they're open.
  const openMenu = (panel: 'settings' | 'keys' | 'howto' | null = null) => {
    if (panel) sound.click()
    else sound.menu(true)
    setUi((u) => {
      if (!u.menu && !u.panel) pausedBefore.current = paused.current
      paused.current = true
      return { ...u, paused: true, menu: panel ? u.menu : true, panel }
    })
  }
  const closeMenu = () => {
    sound.menu(false)
    setUi((u) => {
      // Closing a panel opened from the menu goes back to the menu.
      if (u.panel && u.menu) return { ...u, panel: null }
      paused.current = pausedBefore.current
      return { ...u, menu: false, panel: null, paused: paused.current }
    })
  }
  // The tech tree is an RTS research screen, not a menu: the battle keeps running behind it.
  const setTree = (open: boolean) => {
    if (open !== uiRef.current.tree) sound.menu(open)
    setUi((u) => ({ ...u, tree: open }))
  }
  const cancelResearch = (i: number) => {
    cmdCancelResearch(world.current, me, i)
    sound.unqueued()
  }
  const setSpeed = (s: number) => {
    speed.current = s
    setUi((u) => ({ ...u, speed: s }))
  }

  const w = world.current
  const fac = FACTIONS[myFaction]
  if (!ready)
    return (
      <div className="ew-root ew-deck ew-loading" onContextMenu={noMenu}>
        <p>Charting the system…</p>
      </div>
    )

  const sel = hud.sel.map((i) => w.byId.get(i)).filter((u): u is Unit => !!u)
  return (
    <div className={`ew-root ew-deck ew-battle ew-${myFaction}`} ref={root} style={{ ['--ew-accent' as string]: fac.color }} onContextMenu={noMenu}>
      <canvas
        ref={canvas}
        className={`ew-canvas ${ui.mode !== 'normal' ? 'is-targeting' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => ((drag.current = null), touches.current.clear(), (pinch.current = null))}
        onPointerLeave={() => {
          mouse.current.inside = false
          hover.current = { unit: 0, hp: -1, node: -1 }
        }}
        onWheel={onWheel}
      />

      <TopBar hud={hud} faction={myFaction} sector={sector} ui={ui} onShipyard={selectStation} onPause={togglePause} onSpeed={setSpeed}
        onMenu={() => (ui.menu ? closeMenu() : openMenu())}
        onSettings={() => openMenu('settings')}
        onTechTree={() => setTree(!ui.tree)}
      />

      <div className={`ew-toasts ${ui.paused && !ui.menu && !ui.panel ? 'is-low' : ''}`} aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`ew-toast is-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
      {ui.mode !== 'normal' && (
        <div className="ew-modehint">
          {ui.mode === 'attack' ? 'Attack move: click where to go. Ships fight whatever they meet.'
            : ui.mode === 'move' ? 'Move: click where to go. Ships ignore enemies on the way.'
              : ui.mode === 'patrol' ? 'Patrol: click the far end. Ships fly back and forth, fighting what they meet.'
                : "Rally point: click where new ships should gather."}{' '}
          Shift-click to keep going, <kbd>Esc</kbd> to cancel.
        </div>
      )}

      <div className="ew-dock">
        <TacticalMap canvas={mini} sides={sides} filter={mapFilter} onFilter={setMapFilter} onPointer={onMini}
          onStation={selectStation} onIdle={selectIdle} onArmy={selectArmy}
          onAlert={() => (lastAlarm.current ? centerOn(lastAlarm.current.x, lastAlarm.current.y) : toast('No alerts yet', 'info'))}
        />
        <DetailPanel w={w} me={me} sel={sel} hud={hud} faction={myFaction}
          onOnly={(id, drop) => {
            const keep = sel.filter((u) => (drop ? u.t.id !== id : u.t.id === id)).map((u) => u.id)
            selected.current = new Set(keep)
          }}
          onBuild={build}
          onUnqueue={unqueue}
          onCancel={(i) => cmdCancel(w, me, i)}
          onResearch={research}
          onTechTree={() => setTree(true)}
          onSite={buildSite}
          node={hud.sel.length || pickedNode.current < 0 ? null : w.nodes[pickedNode.current]}
          onStation={selectStation}
        />
        <SelectionPanel sel={sel} me={me} mode={ui.mode} onCommand={runCommand}
          onPick={(id, shift) => {
            const ids = withSquads([id])
            if (shift) for (const i of ids) selected.current.delete(i)
            else selected.current = new Set(ids)
            sound.click()
          }}
        />
      </div>

      {ui.paused && !ui.menu && !ui.panel && hud.winner === -1 && (
        <div className="ew-pausebox">
          <Frame title="Paused">
            <p>The battle is on hold. You can still look around and give orders.</p>
            <button className="ew-go" onClick={togglePause}>
              Resume ({keyName(settings.keys.pause)})
            </button>
          </Frame>
        </div>
      )}
      {ui.tree && hud.winner === -1 && <TechTree w={w} me={me} hud={hud} onResearch={research} onCancel={cancelResearch} onClose={() => setTree(false)} />}
      {ui.menu && !ui.panel && hud.winner === -1 && (
        <Modal title="Battle menu" onClose={closeMenu}>
          <div className="ew-menu-list">
            <button className="ew-menu-btn is-primary" onClick={closeMenu}>Resume</button>
            <button className="ew-menu-btn" onClick={() => openMenu('settings')}>Settings</button>
            <button className="ew-menu-btn" onClick={() => openMenu('keys')}>Keybinds</button>
            <button className="ew-menu-btn" onClick={() => openMenu('howto')}>How to play</button>
            <button className="ew-menu-btn" onClick={onAgain}>Restart battle</button>
            <button className="ew-menu-btn is-danger" onClick={onExit}>Leave to the lobby</button>
          </div>
        </Modal>
      )}
      {ui.panel === 'settings' && (
        <Modal title="Settings" onClose={closeMenu}>
          <SettingsPanel sound={sound} />
        </Modal>
      )}
      {ui.panel === 'keys' && (
        <Modal title="Keybinds" onClose={closeMenu} wide>
          <KeybindsPanel />
        </Modal>
      )}
      {ui.panel === 'howto' && (
        <Modal title="How to play" onClose={closeMenu}>
          <HowToPlay />
        </Modal>
      )}
      {hud.winner !== -1 && <Result w={w} me={me} names={seats.map((s) => s.name)} won={hud.winner === myTeam} onAgain={onAgain} onExit={onExit} />}
    </div>
  )
}
