import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { WinState } from '../../os/wm'
import { DIFFICULTY, fleetThink, newBrain, think, type Brain } from './empires/ai'
import { ALL_SPRITES, FACTIONS, SITE_UPGRADES, TECH, UNIT, buildable, dims, isShip, type HardpointKind, type Tier } from './empires/data'
import { DetailPanel, EconomyPanel, FieldIntel, Floating, Frame, ReserveTray, Tips, STANCE_INFO, SelectionPanel, TacticalMap, TopBar, nextStance, type Command, type Hud, type MapFilter, type Mode } from './empires/Hud'
import { BattleMenu, HowToPlay, KeybindsPanel, Lobby, MainMenu, Modal, Result, SettingsPanel, setupAreas, setupMap, slotName, type MenuScreen, type Setup, type Slot } from './empires/Menus'
import { Conquest, type ConquestBattle } from './empires/Conquest'
import { Multiplayer } from './empires/Multiplayer'
import { Net, mpActive, type NetView } from './empires/net'
import { cmd as makeCmd, runCmd, thinPath, type CmdArgs, type CmdName, type CmdResult } from './empires/commands'
import { matchBrains, matchMap, matchWorld, stepTurn, type MatchInfo } from './empires/match'
import { HASH_EVERY } from './empires/protocol'
import { loadSkirmish, restoreBrain, restoreWorld, saveSkirmish, snapBrain, snapshotWorld, type BattleSnap } from './empires/snapshot'
import { listSaves, loadSave, resumeGalaxy, type Galaxy } from './empires/galaxy'
import { actionFor, getSettings, keyName, setSettings, useSettings } from './empires/settings'
import { HP_NAME, hpName } from './empires/icons'
import { Renderer, relColor, type Camera, type View } from './empires/render'
import { beginLayout } from './empires/layout'
import { defaultArea, inRect, inside, type Pt } from './empires/maps'
import {
  STEP, RANKS, autoStart, REFUND_DELAY, canSee, closedLoop, cantWarp, faceTargets, lineGroups, lineTargets, foes, hpPos, newFleetBattle, newWorld, startProblem, tick, type Owner, type SimEvent, type Unit, type World, stateHash,
} from './empires/sim'
import { EmpiresSound, type OrderKind } from './empires/sound'
import { TechTree } from './empires/TechTree'
import { Scoreboard } from './empires/Scoreboard'
import type { SeatStatus } from './empires/protocol'
import { useHighScore, useIsFocused } from './shared'
import './empires/empires.css'

// Empires At War: a space RTS in the spirit of Empire at War, set in a Clone Wars style war
// between a Republic navy and a droid Confederacy. One skirmish map against the AI: mine ore,
// capture beacons, upgrade the station, build up from fighters to a flagship, and destroy the
// enemy station. This file holds the screens, the input and the HUD; the battle runs in
// empires/sim.ts and is drawn by empires/render.ts.

const SPRITES = ALL_SPRITES
/** Closest the camera zooms in: near enough to read a frigate's guns and shield domes, while the
 * sprites stay sharp. */
const MAX_ZOOM = 3

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
  // Galactic conquest: the campaign lives here, so it outlasts the battles fought in it. A campaign
  // that was open when the page went away (a reload, a closed tab) opens again straight away.
  const [galaxy, setGalaxy] = useState<Galaxy | null>(() => resumeGalaxy())
  // A skirmish that was being fought when the page went away is fought on, from where it was.
  const [skirmish, setSkirmish] = useState(() => (galaxy ? null : loadSkirmish<Setup>()))
  const [screen, setScreen] = useState<'menu' | 'lobby' | 'battle' | 'conquest' | 'fleetBattle' | 'multiplayer'>(() => (galaxy ? 'conquest' : skirmish ? 'battle' : 'menu'))
  const [fight, setFight] = useState<ConquestBattle | null>(null)
  // Where the main menu opens (back from the campaign's load or new-game screen: its own sub-menu),
  // and which of those two screens the campaign opens on.
  const [menuAt, setMenuAt] = useState<MenuScreen>('main')
  const [conquestAt, setConquestAt] = useState<'new' | 'load'>('new')
  const [setup, setSetup] = useState<Setup | null>(() => skirmish?.setup ?? null)
  const [round, setRound] = useState(0)
  const { best } = useHighScore('empires')
  const sound = useRef<EmpiresSound>(null as unknown as EmpiresSound)
  if (!sound.current) sound.current = new EmpiresSound()
  useEffect(() => () => sound.current.dispose(), [])
  // The multiplayer connection: opened on the way into the multiplayer screens, closed on the way out.
  const [net, setNet] = useState<Net | null>(null)
  const netRef = useRef(net)
  netRef.current = net
  useEffect(() => () => netRef.current?.close(), [])
  const mp = useSyncExternalStore(net ? net.subscribe : noSubscribe, net ? net.getView : noView)
  // A reload in the middle of multiplayer goes back to it: the server still has us for a while.
  useEffect(() => {
    if (!mpActive.get()) return
    const n = new Net()
    setNet(n)
    setScreen('multiplayer')
    return () => n.close()
  }, [])

  if (screen === 'menu') {
    const saves = listSaves()
    return (
      <MainMenu sound={sound.current} victories={best ?? 0} onPlay={() => setScreen('lobby')} initial={menuAt}
        onMultiplayer={() => {
          mpActive.set(true)
          setNet(new Net())
          setScreen('multiplayer')
        }}
        latest={saves[0] ? `${saves[0].name}, week ${saves[0].week}` : undefined}
        saves={saves.length}
        onConquest={(how) => {
          if (how === 'continue') {
            const g = saves[0] && loadSave(saves[0].id)
            if (!g) return
            setGalaxy(g)
          } else {
            setGalaxy(null)
            setConquestAt(how)
          }
          setScreen('conquest')
        }}
      />
    )
  }
  if (screen === 'multiplayer' && net && mp?.match)
    return (
      <Battle
        key={mp.match.info.id}
        win={win}
        online={{ net, info: mp.match.info, me: mp.match.me }}
        sound={sound.current}
        // Leaving (mid-battle, or from the result) leaves the lobby too; "back to the lobby" stays.
        onExit={() => net.leave()}
        onAgain={() => net.endMatch()}
      />
    )
  if (screen === 'multiplayer' && net)
    return (
      <Multiplayer
        net={net}
        sound={sound.current}
        onBack={() => {
          mpActive.set(false)
          net.close()
          setNet(null)
          setMenuAt('multi')
          setScreen('menu')
        }}
      />
    )
  if (screen === 'conquest')
    return (
      <Conquest
        g={galaxy}
        setG={setGalaxy}
        sound={sound.current}
        start={conquestAt}
        onExit={() => {
          // Back at the menu (on its Galactic conquest page); the campaign is picked up again from its save.
          setGalaxy(null)
          setMenuAt('conquest')
          setScreen('menu')
        }}
        onBattle={(b) => {
          setFight({
            ...b,
            onDone: (w, left) => {
              b.onDone(w, left)
              setFight(null)
              setScreen('conquest')
            },
          })
          setRound((r) => r + 1)
          setScreen('fleetBattle')
        }}
      />
    )
  if (screen === 'fleetBattle' && fight) return <Battle key={round} win={win} conquest={fight} resume={fight.resume} onSnap={fight.onSnap} sound={sound.current} onExit={() => setScreen('conquest')} onAgain={() => {}} />
  if (screen === 'lobby' || !setup)
    return (
      <Lobby
        sound={sound.current}
        onBack={() => setScreen('menu')}
        onLaunch={(s) => {
          setSkirmish(null)
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
      resume={skirmish?.snap}
      onSnap={(snap) => saveSkirmish(snap ? { setup, snap } : null)}
      sound={sound.current}
      onExit={() => {
        setSkirmish(null)
        setScreen('lobby')
      }}
      onAgain={() => {
        saveSkirmish(null)
        setSkirmish(null)
        setRound((r) => r + 1)
      }}
    />
  )
}

const noSubscribe = () => () => {}
const noView = (): NetView | null => null

// --- Battle ---------------------------------------------------------------------------------------

/** Multiplayer turns the battle keeps queued at most before it plays faster to catch up: about
 * 70 ms of slack for uneven arrivals, without falling far behind the server. */
const TURN_BUFFER = 2

type Toast = { id: number; text: string; tone: 'good' | 'bad' | 'info'; t: number }

function snapshot(w: World, me: Owner, sel: Set<number>, groups: Map<string, number[]>): Hud {
  const p = w.players[me]
  const RANKED: Tier[] = ['fighter', 'gunship', 'frigate', 'cruiser', 'capital']
  return {
    groups: [...groups.entries()]
      .map(([key, ids]) => {
        const us = ids.map((i) => w.byId.get(i)).filter((u): u is Unit => !!u && !u.dead)
        const lead = us.reduce<Unit | null>((b, u) => (!b || RANKED.indexOf(u.t.tier) > RANKED.indexOf(b.t.tier) ? u : b), null)
        return { key, count: us.length, sprite: lead?.t.sprite ?? '' }
      })
      .filter((g) => g.count)
      .sort((a, b) => a.key.localeCompare(b.key)),
    idle: w.units.filter((u) => u.owner === me && isShip(u.t) && !u.parent && u.order.k === 'idle' && !u.target && u.stance !== 'hold').length,
    credits: p.credits, income: p.income, pop: p.pop, popCap: p.popCap, level: p.level,
    queue: p.queue.map((q) => ({ ...q })), reserve: [...p.reserve], research: p.research.map((r) => ({ ...r })), techs: [...p.techs], time: w.time, sel: [...sel], winner: w.winner,
    beacons: w.beacons.filter((b) => b.owner === p.team).length, beaconsAll: w.beacons.length, mines: w.units.filter((u) => u.owner === me && u.t.tier === 'mine').length,
  }
}

function Battle({ win, setup, conquest, online, resume, onSnap, sound, onExit, onAgain }: {
  win: WinState
  setup?: Setup
  conquest?: ConquestBattle
  /** A multiplayer battle: built from the match, played from the server's turns, and every order
   * goes through the server. */
  online?: { net: Net; info: MatchInfo; me: number }
  /** A battle saved mid-fight, to carry on from. */
  resume?: BattleSnap | null
  /** Keeps the battle saved as it goes (null once it's over), so a reload can resume it. */
  onSnap?: (s: BattleSnap | null) => void
  sound: EmpiresSound
  onExit: () => void
  onAgain: () => void
}) {
  // A new battle lays the windows out afresh: the start layout, or the defaults. Before anything
  // draws, so nothing jumps.
  useState(() => beginLayout())
  // Players are the open slots, in spawn order; we're the one marked 'you'.
  // A galactic conquest battle brings its own map and fleets; a skirmish comes from the lobby.
  const [map] = useState(() => (online ? matchMap(online.info) : conquest ? conquest.map : setupMap(setup!)))
  const [seats] = useState(() => {
    // Online, every other seat counts as 'ai' here: it only decides who's 'you' (the world and
    // the AI admirals come from the match itself).
    if (online)
      return online.info.seats.map((s, i) => ({
        kind: (i === online.me ? 'you' : 'ai') as Slot['kind'], faction: s.faction, team: s.team, difficulty: s.difficulty, spawn: s.spawn, name: s.name, area: defaultArea(map, s.spawn),
      }))
    if (conquest)
      return conquest.sides.map((s, i) => ({
        kind: (i === conquest.me ? 'you' : 'ai') as Slot['kind'], faction: s.faction, team: s.team as 0 | 1, difficulty: conquest.ai, spawn: i, name: conquest.names[i], area: defaultArea(map, i),
      }))
    const areas = setupAreas(setup!, map)
    return setup!.slots.map((s, i) => ({ ...s, spawn: i, name: slotName(s, i), area: areas[i] })).filter((s) => s.kind !== 'closed')
  })
  const me: Owner = seats.findIndex((s) => s.kind === 'you')
  // Leaving a campaign battle (won, lost, or pulled out of) hands it back to the galaxy.
  const left = useRef(false)
  const exit = () => {
    left.current = true
    onSnap?.(null)
    if (conquest) conquest.onDone(world.current, world.current.winner === -1)
    else onExit()
  }
  const world = useRef<World>(null as unknown as World)
  const makeWorld = (at: Pt[]) =>
    newWorld(
      map,
      seats.map((s, i) => ({ faction: s.faction, team: s.team, spawn: s.spawn, at: at[i], incomeMul: s.kind === 'ai' ? DIFFICULTY[s.difficulty].income : 1 })),
      { credits: setup?.credits },
    )
  /** Where each station starts. Everyone gets a sensible spot in their area to begin with; the
   * player may move theirs before the battle starts. */
  const starts = useRef<Pt[]>([])
  // A battle saved mid-fight picks up where it was.
  const resumed = useRef<boolean | null>(null)
  if (resumed.current === null) {
    const back = resume ? restoreWorld(resume.world) : null
    if (back) world.current = back
    resumed.current = !!back
  }
  if (!world.current && online) world.current = matchWorld(online.info)
  if (!world.current && conquest) world.current = newFleetBattle(map, conquest.sides, { seed: map.seed })
  if (!world.current) {
    const base = makeWorld(seats.map((s) => map.spawns[s.spawn]))
    for (const s of seats) starts.current.push(autoStart(base, s.area, map.spawns[s.spawn], starts.current))
    world.current = makeWorld(starts.current)
  }
  /** Before the battle: time stands still while the player picks where to start. Our station
   * isn't placed (or shown) until they've clicked a spot. */
  const deploying = useRef(!conquest && !online && !resumed.current)
  const placed = useRef(!!conquest || !!online || !!resumed.current)
  const myTeam = world.current.players[me].team
  const myFaction = world.current.players[me].faction
  const brains = useRef<Brain[]>(
    online ? matchBrains(online.info) : resumed.current && resume ? resume.brains.map(restoreBrain) : seats.map((s, i) => (s.kind === 'ai' ? newBrain(i, s.difficulty) : null)).filter((b): b is Brain => !!b),
  )
  const settings = useSettings()
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const renderer = useRef<Renderer>(null as unknown as Renderer)
  if (!renderer.current) renderer.current = new Renderer(SPRITES)
  const w0 = world.current
  // The camera starts on our station, or in a fleet battle where our fleet comes in.
  const st0 = w0.byId.get(w0.players[me].station) ?? w0.fleet?.entry[me] ?? { x: w0.w / 2, y: w0.h / 2 }
  const cam = useRef<Camera>(resumed.current && resume ? { ...resume.cam } : { x: st0.x, y: st0.y, zoom: 0.4 })
  // Dev builds expose the battle for poking at from the console.
  if (import.meta.env.DEV) (window as unknown as { __ew: unknown }).__ew = { world: world.current, brains: brains.current, cam: cam.current }
  const selected = useRef(new Set<number>(resumed.current && resume ? resume.sel : []))
  const groups = useRef(new Map<string, number[]>(resumed.current && resume ? resume.groups : []))
  const mode = useRef<Mode>('normal')
  /** An ore asteroid picked with nothing else selected: the command card offers to build on it. */
  const pickedNode = useRef(-1)
  const hover = useRef({ unit: 0, hp: -1, node: -1, wreck: 0 })
  // A long hover on a ship or structure brings up its unit card beside the cursor.
  const [intel, setIntel] = useState<{ id: number; x: number; y: number } | null>(null)
  const intelFor = useRef(0)
  const intelTimer = useRef(0)
  const dropIntel = () => {
    intelFor.current = 0
    clearTimeout(intelTimer.current)
    setIntel(null)
  }
  const mouse = useRef({ x: -1, y: -1, inside: false })
  const keys = useRef(new Set<string>())
  const speed = useRef(resumed.current && resume ? resume.speed : 1)
  const paused = useRef(false)
  const lastAlarm = useRef<{ x: number; y: number; t: number } | null>(null)
  const drag = useRef<{ x0: number; y0: number; box: boolean; pan: boolean; moved: boolean; cx: number; cy: number; button: number; attack?: boolean; face?: boolean; area?: boolean; armed?: boolean } | null>(null)
  const touches = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ d: number; zoom: number } | null>(null)
  const lastClick = useRef({ t: 0, id: 0 })
  /** A line being drawn with the right button, in map units: ships spread along it on release. */
  const line = useRef<Pt[] | null>(null)

  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const mini = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  const [hud, setHud] = useState<Hud>(() => snapshot(world.current, me, selected.current, groups.current))
  const [toasts, setToasts] = useState<Toast[]>([])
  const [ui, setUi] = useState({ paused: false, speed: speed.current, mode: 'normal' as Mode, menu: false, panel: null as 'settings' | 'keys' | 'howto' | null, tree: false, deploy: deploying.current, placed: placed.current, reserves: !!conquest, economy: false, players: false })
  /** Whether the game was paused before a menu opened (menus pause it, closing them restores that). */
  const pausedBefore = useRef(false)
  const uiRef = useRef(ui)
  uiRef.current = ui
  const [mapFilter, setMapFilter] = useState<MapFilter>('all')
  const mapFilterRef = useRef(mapFilter)
  mapFilterRef.current = mapFilter
  // A name for the battlefield, for the top bar.
  // The battlefield's name for the top bar, and who's fighting whom for the map header ("2 v 2").
  const sector = world.current.map.name
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
  const minZoom = () => {
    const { vw, vh } = view()
    return Math.min(vw / world.current.w, vh / world.current.h) * 0.9
  }
  const clampCam = () => {
    const c = cam.current
    const { vw, vh } = view()
    const w = world.current
    c.zoom = Math.max(minZoom(), Math.min(MAX_ZOOM, c.zoom))
    const hw = vw / 2 / c.zoom
    const hh = vh / 2 / c.zoom
    // The camera may run well past the map's edge, so ships in a corner can be brought clear of
    // the HUD (more room at the bottom, where the panels are), zoomed out as well as in.
    const fit = (v: number, lo: number, hi: number, mid: number) => (lo > hi ? mid : Math.max(lo, Math.min(hi, v)))
    c.x = fit(c.x, hw - (vw * 0.35) / c.zoom, w.w - hw + (vw * 0.35) / c.zoom, w.w / 2)
    c.y = fit(c.y, hh - (vh * 0.3) / c.zoom, w.h - hh + (vh * 0.5) / c.zoom, w.h / 2)
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
    // A hull's modules come first, each as big as it's drawn (and shot-off ones too), so a part on
    // the very edge of a hull, or sticking out past it, can still be pointed at.
    const reach = (u: Unit, i: number) => {
      const h = u.t.hardpoints[i]
      return Math.max(10 / z, h.s ? h.s * u.t.size * 0.5 : u.t.size * 0.06)
    }
    let hp = -1
    let hpD = Infinity
    for (const u of w.units) {
      if (!u.seen[myTeam] || !u.hps.length || u.t.size * z <= 90) continue
      for (let i = 0; i < u.hps.length; i++) {
        const q = hpPos(u, i)
        const d = Math.hypot(q.x - p.x, q.y - p.y)
        if (d < reach(u, i) && d / reach(u, i) < hpD) {
          hpD = d / reach(u, i)
          best = u
          hp = i
        }
      }
    }
    if (best) bestScore = -1
    for (const u of w.units) {
      if (bestScore < 0) break
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
      // A little wider than the hull's box, so its edges still count.
      const inside = Math.abs(lx) <= Math.max(uw * 0.55, minR) && Math.abs(ly) <= Math.max(uh * 0.55, minR)
      if (!inside) continue
      const score = u.t.size + Math.hypot(dx, dy) * 0.1
      if (score < bestScore) {
        bestScore = score
        best = u
      }
    }

    let node = -1
    for (const n of w.nodes) if (Math.hypot(n.x - p.x, n.y - p.y) < 130) node = n.id
    const wreck = w.wrecks.find((h) => Math.hypot(h.x - p.x, h.y - p.y) < h.size * 0.55 + 20)?.id ?? 0
    return { unit: best, hp, node, wreck, at: p }
  }

  /** Gives an order. In single player it runs at once. Online it goes to the server and runs on
   * everyone's machine at the next tick: it answers null here, and a refusal comes back as a toast
   * when the turn arrives (a tick or two later). */
  const order = <K extends CmdName>(f: K, ...a: CmdArgs<K>): CmdResult<K> | null => {
    const c = makeCmd(f, ...a)
    if (!online) return runCmd(world.current, me, c) as CmdResult<K>
    online.net.send({ t: 'cmd', c })
    return null
  }

  /** Who answers an order on the radio: the biggest ship in the selection. */
  const RANK: Tier[] = ['station', 'fighter', 'gunship', 'frigate', 'cruiser', 'capital']
  const voice = (): Tier => mySelection().reduce<Tier>((best, u) => (RANK.indexOf(u.t.tier) > RANK.indexOf(best) ? u.t.tier : best), 'station')
  const say = (kind: OrderKind) => sound.order(kind, myFaction, voice())

  /** A click with a command from the grid (or its key) armed: move, attack-move, patrol or rally. */
  /** `queued` (Shift): after the orders the ships already have, rather than instead of them. */
  const modeClick = (sx: number, sy: number, m: Mode, queued = false) => {
    const { at } = pick(sx, sy)
    const ids = mySelection().map((u) => u.id)
    if (m === 'rally') {
      order('rally', at.x, at.y)
      renderer.current.ping(at.x, at.y, '#7dffa0')
    } else if (m === 'patrol') {
      order('patrol', ids, at.x, at.y, queued)
      renderer.current.ping(at.x, at.y, '#8fd0ff')
    } else if (m === 'move') {
      order('move', ids, at.x, at.y, false, queued)
      renderer.current.ping(at.x, at.y, '#7dffa0')
    } else if (m === 'guard') {
      const { unit } = pick(sx, sy)
      const why = unit ? order('guard', ids, unit.id) : 'Click one of our ships or structures to guard'
      if (why) {
        toast(why, 'bad')
        sound.error()
        return
      }
      renderer.current.ping(unit!.x, unit!.y, '#7dffa0')
    } else return command(sx, sy, true, queued)
    say(m === 'rally' ? 'rally' : m === 'patrol' ? 'patrol' : 'move')
  }

  /** The command grid (and its keys). Point-and-click ones arm a mode; the rest act at once. */
  const runCommand = (c: Command) => {
    const ids = mySelection().map((u) => u.id)
    sound.unlock()
    if (c === 'stop') {
      if (!mySelection().some((u) => isShip(u.t) || (u.owner === me && u.guns.length > 0))) return sound.error()
      order('stop', ids)
      turretPick.current = null
      say('stop')
    } else if (c === 'hold') {
      // Cycle the stance: from the selection's own, or Maneuver's next if they're mixed.
      const ships = mySelection().filter((u) => isShip(u.t))
      if (!ships.length) return sound.error()
      const now = ships.every((u) => u.stance === ships[0].stance) ? ships[0].stance : 'roam'
      const next = nextStance(now)
      order('stance', ids, next)
      say('hold')
      toast(`Stance: ${STANCE_INFO[next].label}, ${STANCE_INFO[next].blurb}`, 'info')
    } else if (c === 'ability') useAbility()
    else if (c === 'retreat') {
      const why = order('retreat', ids)
      if (why) {
        toast(why, 'bad')
        sound.error()
      } else sound.arm()
    } else {
      // Attack also works for armed structures: their guns focus where it's clicked.
      const armed = mySelection().some((u) => !isShip(u.t) && u.guns.length)
      if (c === 'rally' ? !mySelection().some((u) => u.t.tier === 'station') : !mySelection().some((u) => isShip(u.t)) && !(c === 'attack' && armed)) return sound.error()
      setMode(mode.current === c ? 'normal' : c)
      sound.arm()
    }
  }

  const command = (sx: number, sy: number, attackMove: boolean, queued = false) => {
    const w = world.current
    const { unit, hp, at } = pick(sx, sy)
    const ships = mySelection().filter((u) => isShip(u.t))
    const stationSel = mySelection().some((u) => u.t.tier === 'station')
    const armed = mySelection().filter((u) => !isShip(u.t) && u.guns.length)
    // The attack key or button on one of our own: friendly fire, on purpose. A plain right-click
    // on our own never shoots.
    const friendly = !!unit && attackMove && !foes(w, unit.owner, me)
    if (friendly && !mySelection().some((u) => u.id !== unit.id && (isShip(u.t) || u.guns.length))) {
      toast('Nothing selected can fire on it', 'bad')
      sound.error()
      return
    }
    const target = unit && (foes(w, unit.owner, me) || friendly) ? unit : undefined
    // Structures fire where they're told: every gun, or the one gun that was clicked.
    if (armed.length && target) {
      const tp = turretPick.current && armed.some((u) => u.id === turretPick.current!.unit) ? turretPick.current : null
      const why = order('focus', tp ? [tp.unit] : armed.map((u) => u.id), target.id, tp ? tp.hp : -1, friendly)
      if (why) {
        toast(why, 'bad')
        sound.error()
      } else {
        renderer.current.ping(target.x, target.y, '#ff5a50')
        sound.order('target', myFaction, 'station')
        const gunName = tp ? hpName(w.byId.get(tp.unit)!.t.hardpoints[tp.hp]) : null
        toast(gunName ? `${gunName} focusing on the ${target.t.name}` : `Guns focusing on the ${target.t.name}`, 'info')
      }
      if (!ships.length) return
    }
    if (!ships.length) {
      // Attack with only structures picked: they can't move, so it takes an enemy to aim at.
      if (attackMove && armed.length) {
        toast(turretPick.current ? 'Click an enemy for that gun to aim at' : 'Click an enemy for the guns to aim at', 'bad')
        sound.error()
        return
      }
      if (stationSel) {
        order('rally', at.x, at.y)
        renderer.current.ping(at.x, at.y, '#7dffa0')
        say('rally')
      }
      return
    }
    if (target) {
      order('attack', ships.map((u) => u.id), target.id, hp, queued, friendly)
      if (friendly) toast(`Opening fire on our own ${target.t.name}`, 'bad')

      renderer.current.ping(target.x, target.y, '#ff5a50')
      say(hp >= 0 ? 'target' : 'attack')
      if (hp >= 0) toast(`Targeting ${HP_NAME[target.t.hardpoints[hp].kind].toLowerCase()}`, 'info')
    } else {
      order('move', ships.map((u) => u.id), at.x, at.y, attackMove, queued)
      renderer.current.ping(at.x, at.y, attackMove ? '#ffaa5a' : '#7dffa0')
      say(attackMove ? 'attackMove' : 'move')
    }
  }

  const buildSite = (node: number, id: string) => {
    sound.unlock()
    const why = order('site', node, id)
    if (why) {
      toast(why, 'bad')
      sound.error()
      return
    }
    sound.constructing()
    // Select what's going up, so its construction shows in the card (online it isn't there yet).
    if (!online) select([world.current.nodes[node].site])
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
  /** Select a control group; asking for the one already selected looks at it. */
  const recallGroup = (k: string) => {
    const w = world.current
    const ids = (groups.current.get(k) ?? []).filter((i) => w.byId.get(i))
    if (!ids.length) return
    const again = ids.length === selected.current.size && ids.every((i) => selected.current.has(i))
    select(ids)
    if (again) {
      const us = ids.map((i) => w.byId.get(i)!)
      centerOn(us.reduce((s, u) => s + u.x, 0) / us.length, us.reduce((s, u) => s + u.y, 0) / us.length)
    } else sound.select(myFaction, voice())
  }
  const selectArmy = () => {
    select(world.current.units.filter((u) => u.owner === me && isShip(u.t)).map((u) => u.id))
    if (mySelection().length) sound.select(myFaction, voice())
  }
  const useAbility = () => {
    const ready = mySelection().filter((u) => u.t.ability && u.abilityCd <= 0)
    // Online the count isn't known yet: the abilities that are ready will fire.
    const n = order('ability', mySelection().map((u) => u.id)) ?? ready.length
    if (n) for (const id of new Set(ready.map((u) => u.t.ability!))) sound.ability(id)
    else if (mySelection().some((u) => u.t.ability)) sound.error()
  }

  const build = (id: string, times = 1, reserve = false) => {
    sound.unlock()
    let why: string | null = null
    let n = 0
    for (let i = 0; i < times; i++) {
      why = order('build', id, reserve)
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
        order('cancel', i)
        sound.unqueued()
        return
      }
  }
  const research = (id: string) => {
    sound.unlock()
    const why = order('research', id)
    if (why) {
      toast(why, 'bad')
      sound.error()
    } else sound.researchStarted()
  }

  // Load the art, then start.
  useEffect(() => {
    let live = true
    sound.unlock()
    void Promise.all([renderer.current.ready(), sound.warm(myFaction)]).then(() => {
      if (!live) return
      setReady(true)
      online?.net.send({ t: 'loaded' })
    })
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
    // Picking a start: frame our whole start area.
    if (deploying.current) {
      const a = seats[me].area
      Object.assign(cam.current, { x: a.x + a.w / 2, y: a.y + a.h / 2, zoom: Math.min(c.clientWidth / a.w, (c.clientHeight - 240) / a.h) * 0.85 })
      clampCam()
    }
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
      // Online: the server's battle replaces ours when ours drifted, or when we came back to it.
      const sync = online?.net.sync
      if (sync) {
        online!.net.sync = null
        const back = restoreWorld(sync.world)
        if (back) {
          world.current = back
          brains.current = sync.brains.map(restoreBrain)
          acc = 0
          toast(sync.why === 'drift' ? "Your battle had drifted from everyone else's: it's been put right from the server." : 'Back in the battle.', 'info')
        }
      }
      const w = world.current
      const events: SimEvent[] = []
      if (online && w.winner === -1) {
        // Multiplayer: play the server's turns, about one a tick. More queued than the buffer (a
        // slow frame, a hidden tab) plays faster to catch up; none queued waits for the next.
        const q = online.net.turns
        acc += dt
        let steps = Math.min(q.length, Math.floor(acc / STEP))
        if (q.length - steps > TURN_BUFFER) steps = Math.min(q.length, steps + Math.ceil((q.length - steps - TURN_BUFFER) / 3), 300)
        for (let i = 0; i < steps && w.winner === -1; i++) {
          const t = q.shift()!
          stepTurn(w, brains.current, t, (seat, _c, r) => {
            if (seat === me && typeof r === 'string') {
              toast(r, 'bad')
              sound.error()
            }
          })
          events.push(...w.events)
          w.events.length = 0
          if (t.n % HASH_EVERY === 0) online.net.send({ t: 'hash', n: t.n, h: stateHash(w) })
        }
        acc = q.length ? Math.max(0, acc - steps * STEP) : Math.min(acc - steps * STEP, STEP)
      } else if (!paused.current && !deploying.current && w.winner === -1) {
        acc += dt * speed.current
        let steps = 0
        while (acc >= STEP && steps < 12) {
          for (const b of brains.current) (w.fleet ? fleetThink : think)(w, b, STEP)
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
      const zg = zoomGoal.current
      if (zg) {
        // Close most of the gap each frame (about 90% in a tenth of a second), in log space so
        // zooming in and out feel the same.
        const before = cm.zoom
        zoomBy(Math.pow(zg.z / cm.zoom, 1 - Math.exp(-dt * 22)), zg.sx, zg.sy)
        // Done, or held at the zoom limits: stop chasing.
        if (Math.abs(Math.log(zg.z / cm.zoom)) < 0.002 || cm.zoom === before) {
          if (cm.zoom !== before) zoomBy(zg.z / cm.zoom, zg.sx, zg.sy)
          zoomGoal.current = null
        }
      }

      // Effects and sound.
      renderer.current.consume(events, w, me)
      const seesPoint = (x: number, y: number) => canSee(w, w.players[me].team, x, y)
      for (const e of events) {
        if (e.k === 'fire') sound.fire(e.kind, where(e.x, e.y), w.players[e.owner].faction, e.light)
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
        } else if (e.k === 'warp') {
          if (e.owner === me || seesPoint(e.x, e.y)) sound.warp(where(e.x, e.y), e.delay)
        } else if (e.k === 'arrived') {
          if (e.owner === me || seesPoint(e.x, e.y)) sound.arrive(where(e.x, e.y), UNIT[e.unit].size)
          if (e.owner === me && e.field) toast(`${UNIT[e.unit].name} dropped out inside an asteroid field and took heavy damage`, 'bad')
          else if (e.owner !== me && foes(w, e.owner, me) && seesPoint(e.x, e.y)) toast(`Enemy ${UNIT[e.unit].name.toLowerCase()} out of hyperspace`, 'bad')
        } else if (e.k === 'retreating') {
          if (e.owner === me || seesPoint(e.x, e.y)) sound.warp(where(e.x, e.y), e.secs)
        } else if (e.k === 'retreated') {
          if (e.owner === me || seesPoint(e.x, e.y)) sound.arrive(where(e.x, e.y), UNIT[e.unit].size)
          if (e.owner === me) toast(e.refund > 0 ? `${UNIT[e.unit].name} jumped out: +${Math.round(e.refund)} credits in ${REFUND_DELAY} s` : `${UNIT[e.unit].name} jumped out`, 'good')
          else if (foes(w, e.owner, me) && seesPoint(e.x, e.y)) toast(`An enemy ${UNIT[e.unit].name.toLowerCase()} escaped into hyperspace`, 'info')
        } else if (e.k === 'upgraded' && e.owner === me) {
          const up = SITE_UPGRADES.find((x) => x.id === e.id)!
          sound.researchDone()
          toast(`${up.name}${up.levels > 1 ? ` ${e.level}` : ''} fitted`, 'good')
        } else if (e.k === 'refunded' && e.owner === me) {
          toast(`Retreat refund: +${Math.round(e.amount)} credits for the ${UNIT[e.unit].name}`, 'good')
        } else if (e.k === 'repaired' && e.owner === me) {
          const u = w.byId.get(e.unit)
          if (u) toast(`${u.t.name} repaired`, 'good')
        } else if (e.k === 'reserved' && e.owner === me) {
          sound.shipReady(myFaction, UNIT[e.unit].tier)
          toast(`${UNIT[e.unit].name} ready in the fleet inventory: drag it onto the battlefield`, 'good')
          // The first one opens the inventory, so it's clear where ships go.
          if (!inventoryShown.current) {
            inventoryShown.current = true
            setUi((u) => ({ ...u, reserves: true }))
          }
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
        } else if (e.k === 'salvaged' && e.owner === me) {
          sound.salvaged()
          toast(`Wreck salvaged: +${Math.round(e.value)} credits in all`, 'good')
        } else if (e.k === 'rankUp' && e.owner === me) {
          const u = w.byId.get(e.unit)
          sound.promoted()
          if (u && u.t.tier !== 'fighter') toast(`${u.t.name} promoted: ${RANKS[e.rank]}`, 'good')
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
        fogGrid: settingsRef.current.fogGrid,
        turretPick: turretPick.current && selected.current.has(turretPick.current.unit) ? turretPick.current : null,
        selected: selected.current,
        hover: h.unit,
        hoverHp: h.hp,
        box: drag.current?.box && drag.current.moved ? { x0: drag.current.x0, y0: drag.current.y0, x1: mouse.current.x, y1: mouse.current.y } : null,
        node: selected.current.size ? -1 : pickedNode.current,
        hoverNode: h.node,
        hoverWreck: h.wreck,
        line: line.current && drag.current?.moved ? orderPreview(w, line.current, !!drag.current.attack, !!drag.current.face, !!drag.current.area) : null,
        areas: deploying.current ? seats.map((s, i) => ({ r: s.area, color: relColor(w, me, i), label: s.name, mine: i === me })) : undefined,
        ghost: deploying.current && mouse.current.inside ? ghostAt(mouse.current.x, mouse.current.y) : null,
        warpGhost: warpGhost(),
        hideOwner: deploying.current && !placed.current ? me : -1,
        showRally: mySelection().some((u) => u.t.tier === 'station'),
      }
      renderer.current.draw(ctx, w, cm, vw, vh, v, dt * (paused.current ? 0 : speed.current))
      sound.ambience(paused.current ? 0 : dt)
      renderer.current.minimap(mctx, w, me, cm, vw, vh, m.clientWidth, m.clientHeight, lastAlarm.current, mapFilterRef.current, deploying.current && !placed.current ? me : -1)

      hudT -= dt
      if (hudT <= 0 || (w.winner !== -1 && !ended)) {
        hudT = 0.15
        setHud(snapshot(w, me, selected.current, groups.current))
        if (w.winner !== -1 && !ended) {
          ended = true
          // Over: nothing to resume any more.
          onSnap?.(null)
          sound.stopDrone()
          if (w.winner === myTeam) {
            sound.victory()
            // Skirmish wins count on the menu; campaign battles count in the campaign.
            if (!w.fleet) submit((bestRef.current ?? 0) + 1)
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
      const keymap = settingsRef.current.keys
      if ((uiRef.current.menu || uiRef.current.panel) && k !== 'escape') return
      if (deploying.current && k === 'enter') {
        beginBattle()
        return
      }
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
      if (/^[1-9]$/.test(k)) recallGroup(k)
      else if (k === 'escape') {
        // Esc backs out of whatever is open, one step at a time, and finally opens the menu.
        if (uiRef.current.menu || uiRef.current.panel) closeMenu()
        else if (uiRef.current.tree) setTree(false)
        else if (mode.current !== 'normal') setMode('normal')
        else if (turretPick.current) turretPick.current = null
        else if (selected.current.size || pickedNode.current >= 0) {
          selected.current.clear()
          pickedNode.current = -1
        } else openMenu()
      } else if (action === 'attack' || action === 'move' || action === 'patrol' || action === 'rally' || action === 'hold' || action === 'stop' || action === 'retreat' || action === 'guard') runCommand(action)
      else if (action === 'ability') useAbility()
      else if (action === 'station' || k === 'home') selectStation()
      else if (action === 'idle') selectIdle()
      else if (action === 'alert') {
        if (lastAlarm.current) centerOn(lastAlarm.current.x, lastAlarm.current.y)
      } else if (action === 'techTree') setTree(!uiRef.current.tree)
      else if (action === 'pause') togglePause()
      else if (action === 'fogGrid') setSettings({ fogGrid: !settingsRef.current.fogGrid })
      else if (k === 'tab') setUi((u) => ({ ...u, players: !u.players }))
      else if (action === 'focus') {
        const us = mySelection()
        if (us.length) centerOn(us.reduce((s, u) => s + u.x, 0) / us.length, us.reduce((s, u) => s + u.y, 0) / us.length)
      } else if (action === 'zoomIn' || k === '+') zoomTo(1.2)
      else if (action === 'zoomOut' || k === '_') zoomTo(1 / 1.2)
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

  /** Where a wheel or key zoom is heading: the frame loop eases towards it, around the point that
   * was under the pointer, so wheel notches don't show as jumps. */
  const zoomGoal = useRef<{ z: number; sx: number; sy: number } | null>(null)
  const zoomTo = (f: number, sx?: number, sy?: number) => {
    const { vw, vh } = view()
    const from = zoomGoal.current?.z ?? cam.current.zoom
    // Kept inside the limits, so turning the wheel back answers at once.
    zoomGoal.current = { z: Math.max(minZoom(), Math.min(MAX_ZOOM, from * f)), sx: sx ?? vw / 2, sy: sy ?? vh / 2 }
  }
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
    dropIntel()
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
    if (deploying.current) {
      if (e.button === 0) placeStart(p.x, p.y)
      return
    }
    // Attack armed, ships selected: either button drags an area-attack circle (as Shift+right-drag
    // does), and a click without a drag is the usual attack order, on release.
    if ((e.button === 0 || e.button === 2) && mode.current === 'attack' && mySelection().some((u) => isShip(u.t))) {
      drag.current = { x0: p.x, y0: p.y, box: false, pan: false, moved: false, cx: 0, cy: 0, button: e.button, area: true, armed: true }
      line.current = [toWorld(p.x, p.y)]
      return
    }
    if (e.button === 2) {
      // A right-click orders on release; dragging first draws a line to spread the ships along.
      // Another order armed (move, patrol...): a right-click puts it away.
      if (mode.current !== 'normal') setMode('normal')
      else {
        // Ctrl draws an attack-move line instead.
        // With one ship or one squadron selected, the drag sets the way it faces on arrival instead.
        // Alt does that for any selection: it moves as a formation, turned to face the drag.
        const face = e.altKey || lineGroups(world.current, me, mySelection().map((u) => u.id)).length === 1
        // Shift draws a circle instead: everything in it gets attacked, the targets shared out.
        const area = e.shiftKey
        drag.current = { x0: p.x, y0: p.y, box: false, pan: false, moved: false, cx: 0, cy: 0, button: 2, attack: e.ctrlKey || e.metaKey, face: face && !area, area }
        line.current = [toWorld(p.x, p.y)]
      }
      return
    }
    if (mode.current !== 'normal') {
      modeClick(p.x, p.y, mode.current, e.shiftKey)
      // Shift keeps the command armed for more clicks, each queued after the last.
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
        zoomGoal.current = null
        zoomBy(target / cam.current.zoom, (a.x + b.x) / 2, (a.y + b.y) / 2)
        return
      }
    }
    const d = drag.current
    if (d) {
      if (Math.hypot(p.x - d.x0, p.y - d.y0) > 6) d.moved = true
      const ln = line.current
      if ((d.button === 2 || d.armed) && d.moved && ln) {
        const q = toWorld(p.x, p.y)
        const last = ln[ln.length - 1]
        // A facing drag or a circle is just where it starts and how far; a line keeps every point.
        if (d.face || d.area) line.current = [ln[0], q]
        else if (Math.hypot(q.x - last.x, q.y - last.y) * cam.current.zoom > 6) ln.push(q)
      }
      if (d.pan && d.moved) {
        cam.current.x = d.cx - (p.x - d.x0) / cam.current.zoom
        cam.current.y = d.cy - (p.y - d.y0) / cam.current.zoom
        clampCam()
      }
    }
    const h = pick(p.x, p.y)
    hover.current = { unit: h.unit?.id ?? 0, hp: h.hp, node: h.node, wreck: h.wreck }
    const w0 = world.current
    const hid = h.unit && !drag.current && e.pointerType !== 'touch' && h.unit.seen[w0.players[me].team] ? h.unit.id : 0
    if (hid !== intelFor.current) {
      dropIntel()
      intelFor.current = hid
      if (hid) intelTimer.current = window.setTimeout(() => setIntel({ id: hid, x: p.x, y: p.y }), 700)
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const p = local(e)
    const d = drag.current
    if (e.pointerType === 'touch') {
      touches.current.delete(e.pointerId)
      if (touches.current.size < 2) pinch.current = null
      drag.current = null
      if (!d || d.moved) return
      if (deploying.current) return placeStart(p.x, p.y)
      // A tap.
      const { unit, node, hp: part } = pick(p.x, p.y)
      if (mode.current !== 'normal') {
        modeClick(p.x, p.y, mode.current)
        setMode('normal')
      } else if (unit && unit.owner === me) {
        select([unit.id])
        turretPick.current = !isShip(unit.t) && part >= 0 && unit.t.hardpoints[part]?.weapon ? { unit: unit.id, hp: part } : null
      } else if (mySelection().length && (!unit || foes(w0, unit.owner, me))) command(p.x, p.y, false)
      else if (unit) select([unit.id])
      else {
        selected.current.clear()
        pickedNode.current = node
      }
      return
    }
    drag.current = null
    if (d?.armed) {
      const ln = line.current
      line.current = null
      const ids = mySelection().filter((u) => isShip(u.t)).map((u) => u.id)
      if (d.moved && ln && ln.length > 1 && ids.length) {
        const [a, b] = [ln[0], ln[ln.length - 1]]
        const r = Math.max(60, Math.hypot(b.x - a.x, b.y - a.y))
        order('area', ids, a.x, a.y, r)
        renderer.current.ping(a.x, a.y, '#ff5a50')
        say('attack')
      } else modeClick(d.x0, d.y0, 'attack', e.shiftKey)
      // Shift keeps attack armed for more, as with clicks.
      if (!e.shiftKey) setMode('normal')
      return
    }
    if (d?.button === 2) {
      const ln = line.current
      line.current = null
      const ids = mySelection().filter((u) => isShip(u.t)).map((u) => u.id)
      if (d.area && d.moved && ln && ln.length > 1 && ids.length) {
        const [a, b] = [ln[0], ln[ln.length - 1]]
        const r = Math.max(60, Math.hypot(b.x - a.x, b.y - a.y))
        order('area', ids, a.x, a.y, r)
        renderer.current.ping(a.x, a.y, '#ff5a50')
        say('attack')
      } else if (d.moved && ln && ln.length > 1 && ids.length) {
        const w = world.current
        const [a, b] = [ln[0], ln[ln.length - 1]]
        const face = Math.atan2(b.y - a.y, b.x - a.x)
        const targets = d.face ? faceTargets(w, me, ids, a.x, a.y, face) : lineTargets(w, me, ids, ln)
        if (d.face) order('face', ids, a.x, a.y, face, d.attack, e.shiftKey)
        else order('line', ids, thinPath(ln), d.attack, e.shiftKey)
        for (const q of targets) renderer.current.ping(q.x, q.y, d.attack ? '#ffaa5a' : '#7dffa0')
        say(d.attack ? 'attackMove' : 'move')
      } else command(d.x0, d.y0, false, e.shiftKey)
      return
    }
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
    // Clicking one of a structure's guns picks that gun: a right-click then aims just it.
    const { hp: part } = pick(p.x, p.y)
    turretPick.current = !isShip(unit.t) && part >= 0 && unit.t.hardpoints[part]?.weapon && !e.shiftKey ? { unit: unit.id, hp: part } : null
    // The crew of what we just picked answers (structures just click).
    if (isShip(unit.t) || unit.t.tier === 'station') sound.select(myFaction, unit.t.tier)
    else sound.click()
  }

  const onWheel = (e: React.WheelEvent) => {
    dropIntel()
    const p = local(e)
    // Lines or pages (some mice) rather than pixels: scale to about one notch's worth.
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
    zoomTo(Math.exp(-dy * 0.0015), p.x, p.y)
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
        if (mode.current === 'patrol') order('patrol', ships.map((u) => u.id), x, y)
        else order('move', ships.map((u) => u.id), x, y, mode.current === 'attack')
        say(mode.current === 'patrol' ? 'patrol' : mode.current === 'attack' ? 'attackMove' : 'move')
      }
      return
    }
    centerOn(x, y)
    if (e.type === 'pointerdown') (e.target as Element).setPointerCapture(e.pointerId)
  }

  /** What a right-drag would order, for the renderer: one spot per ship, and for a facing drag the
   * heading as an arrow from where it goes. */
  const orderPreview = (w: World, path: Pt[], attack: boolean, face: boolean, area = false) => {
    if (area) {
      const [a, b] = [path[0], path[path.length - 1]]
      const r = Math.max(60, Math.hypot(b.x - a.x, b.y - a.y))
      const team = w.players[me].team
      const inside = w.units.filter((u) => !u.dead && foes(w, u.owner, me) && u.seen[team] && Math.hypot(u.x - a.x, u.y - a.y) < r + Math.max(...dims(u.t)) * 0.25)
      return { attack: true, ring: false, path, spots: [], face: null, area: { x: a.x, y: a.y, r, targets: inside.map((u) => ({ x: u.x, y: u.y, r: Math.max(...dims(u.t)) * 0.6 })) } }
    }
    const ids = mySelection().filter((u) => isShip(u.t)).map((u) => u.id)
    const [a, b] = [path[0], path[path.length - 1]]
    const heading = Math.atan2(b.y - a.y, b.x - a.x)
    const targets = face ? faceTargets(w, me, ids, a.x, a.y, heading) : lineTargets(w, me, ids, path)
    return { attack, ring: !face && closedLoop(path), path, spots: targets.map((t) => ({ x: t.x, y: t.y })), face: face ? heading : null }
  }

  /** Room the dock keeps at its left for the tactical map, while the map sits in that corner. */
  const [mapRoom, setMapRoom] = useState(0)
  const mapMoved = useCallback((b: { x: number; y: number; w: number; h: number }, root: { w: number; h: number }) => {
    const docked = b.x < 60 && b.y + b.h > root.h - 60
    setMapRoom(docked ? b.w : 0)
  }, [])
  /** A structure's gun picked by clicking it: right-clicking an enemy aims that gun alone. */
  const turretPick = useRef<{ unit: number; hp: number } | null>(null)
  /** Whether the fleet inventory has been opened for its first ship this battle. */
  const inventoryShown = useRef(false)
  /** A ship being dragged out of the reserve: its type, while the pointer is down. */
  const reserveDrag = useRef<{ unit: string } | null>(null)
  /** The way a ship called in faces: out from our station, towards where it arrives. */
  const arrivalFacing = (x: number, y: number) => {
    const st = world.current.byId.get(world.current.players[me].station)
    return st ? Math.atan2(y - st.y, x - st.x) : 0
  }
  /** The ghost of a ship being dragged from the reserve: where it would drop out and whether it can. */
  const warpGhost = () => {
    const d = reserveDrag.current
    if (!d || !mouse.current.inside) return null
    const at = toWorld(mouse.current.x, mouse.current.y)
    const t = UNIT[d.unit]
    const why = cantWarp(world.current, me, d.unit, at.x, at.y)
    return { sprite: t.sprite, x: at.x, y: at.y, a: arrivalFacing(at.x, at.y), size: t.size, ok: !why, why, field: inside(world.current.map.fields, at.x, at.y) }
  }
  /** Grab a ship in the reserve tray: from here the pointer is followed over the whole page. */
  const grabReserve = (id: string, e: React.PointerEvent) => {
    e.preventDefault()
    sound.unlock()
    reserveDrag.current = { unit: id }
    const move = (ev: PointerEvent) => {
      const r = canvas.current?.getBoundingClientRect()
      if (!r) return
      const x = ev.clientX - r.left
      const y = ev.clientY - r.top
      mouse.current = { x, y, inside: x >= 0 && y >= 0 && x <= r.width && y <= r.height && !(ev.target as Element | null)?.closest?.('.ew-frame, .ew-top') }
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      move(ev)
      const g = warpGhost()
      reserveDrag.current = null
      if (!g) return
      const why = order('deploy', id, g.x, g.y, g.a)
      if (why) {
        toast(why, 'bad')
        sound.error()
      } else sound.order('move', myFaction, UNIT[id].tier)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  /** The station's footprint under the pointer while picking a start, and whether it can go there. */
  const ghostAt = (sx: number, sy: number) => {
    const at = toWorld(sx, sy)
    const s = seats[me]
    const ok = inRect(s.area, at.x, at.y) && !startProblem(world.current, at.x, at.y, starts.current.filter((_, i) => i !== me))
    return { ...at, ok }
  }
  /** Move our station (and starting ships) to a spot in our start area. */
  const placeStart = (sx: number, sy: number) => {
    const at = toWorld(sx, sy)
    const why = inRect(seats[me].area, at.x, at.y) ? startProblem(world.current, at.x, at.y, starts.current.filter((_, i) => i !== me)) : 'Pick a spot inside your start area'
    if (why) {
      sound.error()
      toast(why, 'bad')
      return
    }
    starts.current[me] = at
    world.current = makeWorld(starts.current)
    if (!placed.current) {
      placed.current = true
      setUi((u) => ({ ...u, placed: true }))
    }
    selected.current.clear()
    groups.current.clear()
    sound.click()
  }
  const beginBattle = () => {
    if (!deploying.current) return
    if (!placed.current) {
      sound.error()
      toast('Click inside your start area to place your station first', 'bad')
      return
    }
    deploying.current = false
    setUi((u) => ({ ...u, deploy: false }))
    sound.menu(false)
    const st = world.current.byId.get(world.current.players[me].station)
    if (st) centerOn(st.x + 250, st.y + 120)
    toast('Battle stations!', 'good')
  }

  const togglePause = () => {
    // The server keeps time in multiplayer: nobody pauses it.
    if (online) return
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
      paused.current = !online
      return { ...u, paused: !online, menu: panel ? u.menu : true, panel }
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
    order('cancelResearch', i)
    sound.unqueued()
  }
  const setSpeed = (s: number) => {
    speed.current = s
    setUi((u) => ({ ...u, speed: s }))
  }
  /** The battle as it stands, for picking up after a reload: only once it's under way, and not
   * once it's over or left. */
  const keep = () => {
    const w = world.current
    if (!onSnap || left.current || deploying.current || w.winner !== -1) return
    onSnap({
      world: snapshotWorld(w),
      brains: brains.current.map(snapBrain),
      cam: { ...cam.current },
      sel: [...selected.current],
      groups: [...groups.current.entries()],
      speed: speed.current,
    })
  }
  const keepRef = useRef(keep)
  keepRef.current = keep
  // Every few seconds, and the moment the page goes away.
  useEffect(() => {
    const id = window.setInterval(() => keepRef.current(), 4000)
    const hide = () => keepRef.current()
    const hidden = () => document.visibilityState === 'hidden' && keepRef.current()
    window.addEventListener('pagehide', hide)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      clearInterval(id)
      window.removeEventListener('pagehide', hide)
      document.removeEventListener('visibilitychange', hidden)
    }
  }, [])

  // Online: who's still in the battle. A player dropping out, coming back or giving up is news.
  const net = useSyncExternalStore(online ? online.net.subscribe : noSubscribe, online ? online.net.getView : noView)
  const lastRoster = useRef<SeatStatus[] | null>(null)
  useEffect(() => {
    const roster = net?.roster
    if (!roster) return
    const was = lastRoster.current
    lastRoster.current = roster.map((r) => r.status)
    if (!was) return
    roster.forEach((r, i) => {
      if (i === me || r.status === was[i]) return
      const who = `${seats[i].name} (${seats[i].team === myTeam ? 'ally' : 'enemy'})`
      if (r.status === 'away') toast(`${who} lost the connection. Waiting for them to come back…`, 'info')
      else if (r.status === 'playing' && was[i] === 'away') toast(`${who} is back`, 'good')
      else if (r.status === 'left') toast(`${who} gave up: an AI admiral takes over their fleet`, seats[i].team === myTeam ? 'bad' : 'good')
      else if (r.status === 'dropped') toast(`${who} didn't come back: an AI admiral takes over their fleet`, 'info')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net?.roster])

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
      <Tips live={(id) => world.current.byId.get(id)} />
      {intel && <FieldIntel w={w} me={me} id={intel.id} x={intel.x} y={intel.y} />}
      <canvas
        ref={canvas}
        className={`ew-canvas ${ui.mode !== 'normal' ? `is-targeting is-mode-${ui.mode}` : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => ((drag.current = null), (line.current = null), touches.current.clear(), (pinch.current = null))}
        onPointerLeave={() => {
          mouse.current.inside = false
          hover.current = { unit: 0, hp: -1, node: -1, wreck: 0 }
          dropIntel()
        }}
        onWheel={onWheel}
      />

      <TopBar hud={hud} faction={myFaction} sector={sector} ui={ui} onShipyard={selectStation} onPause={online ? undefined : togglePause} onSpeed={online ? undefined : setSpeed}
        onMenu={() => (ui.menu ? closeMenu() : openMenu())}
        onTechTree={() => setTree(!ui.tree)}
        onReserves={() => setUi((u) => ({ ...u, reserves: !u.reserves }))}
        onEconomy={() => setUi((u) => ({ ...u, economy: !u.economy }))}
        onPlayers={() => setUi((u) => ({ ...u, players: !u.players }))}
        ping={online ? (net?.status === 'online' ? Math.round(net.rtt) : -1) : undefined}
      />
      {ui.players && <Scoreboard w={w} me={me} names={seats.map((s) => s.name)} roster={online ? net?.roster : undefined} onClose={() => setUi((u) => ({ ...u, players: false }))} />}
      {online && net?.status !== 'online' && hud.winner === -1 && (
        <div className="ew-pausebox">
          <Frame title="Connection lost">
            <p>Reconnecting to the server. The battle goes on without your orders for now; you'll be put back in it as soon as the connection is back.</p>
          </Frame>
        </div>
      )}
      {ui.economy && hud.winner === -1 && <EconomyPanel w={w} me={me} onClose={() => setUi((u) => ({ ...u, economy: false }))} />}
      {ui.reserves && hud.winner === -1 && <ReserveTray reserve={hud.reserve} onGrab={grabReserve} onClose={() => setUi((u) => ({ ...u, reserves: false }))} />}

      <div className={`ew-toasts ${ui.paused && !ui.menu && !ui.panel ? 'is-low' : ''}`} aria-live="polite">
        {toasts.map((t) => {
          const dismiss = () => setToasts((ts) => ts.filter((x) => x.id !== t.id))
          return (
            // Right-click, or the × that shows on hover, puts it away.
            <section key={t.id} className={`ew-frame ew-toast is-${t.tone}`} onContextMenu={(e) => (e.preventDefault(), dismiss())}>
              <div className="ew-frame-in">
                <span>{t.text}</span>
                <button className="ew-toast-x" onClick={dismiss} aria-label="Dismiss">×</button>
              </div>
            </section>
          )
        })}
      </div>
      {ui.mode !== 'normal' && (
        <div className="ew-modehint">
          {ui.mode === 'attack' && !mySelection().some((u) => isShip(u.t))
            ? turretPick.current ? 'Attack: click an enemy for the picked gun to aim at.' : 'Attack: click an enemy for every gun to aim at. Click one gun first to aim just that one.'
            : ui.mode === 'attack' ? 'Attack move: click where to go. Ships fight whatever they meet. Drag a circle (either button) to attack everything in it; click one of ours to open fire on it.'
            : ui.mode === 'move' ? 'Move: click where to go. Ships ignore enemies on the way.'
              : ui.mode === 'patrol' ? 'Patrol: click the far end. Ships fly back and forth, fighting what they meet.'
              : ui.mode === 'guard' ? 'Guard: click one of our ships or structures. The selection stays with it and fights off what comes near.'
                : "Rally point: click where new ships should gather."}{' '}
          Shift-click to keep going, <kbd>Esc</kbd> to cancel.
        </div>
      )}

      {/* The tactical map floats: it can be dragged anywhere. While it sits in its corner the dock
          leaves room for it, so the unit card stays beside it. */}
      <TacticalMap canvas={mini} sides={sides} filter={mapFilter} onFilter={setMapFilter} onPointer={onMini}
        onStation={selectStation} onIdle={selectIdle} onArmy={selectArmy} idle={hud.idle}
        fogGrid={settings.fogGrid} onFogGrid={() => setSettings({ fogGrid: !settings.fogGrid })}
        onAlert={() => (lastAlarm.current ? centerOn(lastAlarm.current.x, lastAlarm.current.y) : toast('No alerts yet', 'info'))}
        onMove={mapMoved}
      />
      {/* The bottom of the screen: a shade for the panels to sit on; the unit card (beside the map
          while it sits in its corner) and the selection float like the map, and can be moved. */}
      <div className="ew-dockshade" />
      <Floating id="detail" bare at={{ left: mapRoom ? mapRoom + 12 : 6, bottom: 6 }} className="ew-detailfloat">
          <DetailPanel w={w} me={me} sel={sel} hud={hud} faction={myFaction}
            onOnly={(id, drop) => {
              const keep = sel.filter((u) => (drop ? u.t.id !== id : u.t.id === id)).map((u) => u.id)
              selected.current = new Set(keep)
            }}
            onBuild={build}
            onUnqueue={unqueue}
            onCancel={(i) => order('cancel', i)}
            onResearch={research}
            onTechTree={() => setTree(true)}
            onSite={buildSite}
            onUpgradeSite={(id, upgrade) => {
              const why = order('upgradeSite', id, upgrade)
              if (why) {
                toast(why, 'bad')
                sound.error()
              } else sound.constructing()
            }}
            turretPick={turretPick.current}
          onClearFocus={(id) => {
            // No target: every gun picks its own again.
            order('focus', [id], 0)
            sound.click()
          }}
          onRetreat={(ids) => {
              const why = order('retreat', ids)
              if (why) {
                toast(why, 'bad')
                sound.error()
              } else sound.arm()
            }}
            onRepair={(id) => {
              const why = order('repair', id)
              if (why) {
                toast(why, 'bad')
                sound.error()
              } else sound.constructing()
            }}
            node={hud.sel.length || pickedNode.current < 0 ? null : w.nodes[pickedNode.current]}
            onStation={selectStation}
          />
      </Floating>
      <Floating id="selection" bare at={{ right: 6, bottom: 6 }} className="ew-selfloat">
          <SelectionPanel w={world.current} sel={sel} me={me} mode={ui.mode} onCommand={runCommand} groups={hud.groups} onGroup={recallGroup}
            onPick={(id, shift) => {
              const ids = withSquads([id])
              if (shift) for (const i of ids) selected.current.delete(i)
              else selected.current = new Set(ids)
              sound.click()
            }}
          />
      </Floating>

      {ui.deploy && !ui.menu && !ui.panel && (
        <div className="ew-pausebox ew-deploybox">
          <Frame title="Choose your start">
            <p>
              {ui.placed
                ? 'Click again to move your station, or start when you are ready.'
                : 'Click inside your start area (the bright box) to place your station. Everyone else picks inside theirs.'}
            </p>
            <button className="ew-go" onClick={beginBattle} disabled={!ui.placed}>
              Start battle (Enter)
            </button>
          </Frame>
        </div>
      )}
      {online && hud.time === 0 && !ui.menu && !ui.panel && (
        <div className="ew-pausebox">
          <Frame title="Get ready">
            <p>Waiting for every player's game to load. The battle starts for everyone at once.</p>
          </Frame>
        </div>
      )}
      {ui.paused && !ui.deploy && !ui.menu && !ui.panel && hud.winner === -1 && (
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
        <BattleMenu w={w} me={me} sound={sound} speed={ui.speed} onSpeed={setSpeed} onResume={closeMenu} onPanel={openMenu} onRestart={conquest || online ? undefined : onAgain} onExit={exit} campaign={!!conquest} online={!!online} />
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
      {hud.winner !== -1 && <Result w={w} me={me} names={seats.map((s) => s.name)} won={hud.winner === myTeam} onAgain={onAgain} onExit={exit} campaign={!!conquest} online={!!online} />}
    </div>
  )
}
