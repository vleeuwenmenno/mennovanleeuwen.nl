import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { WinState } from '../../os/wm'
import { DIFFICULTY, aidAllies, fleetThink, newBrain, profileOf, think, type Brain } from './empires/ai'
import { BUILD_RADIUS, FACTIONS, MODULE, MODULES, SITE_UPGRADES, TECH, UNIT, WORKS_NAME, buildable, dims, isEngineer, isShip, worksOf, yardOf, yardsFor, type HardpointKind, type ModuleId, type Tier } from './empires/data'
import { DetailPanel, EconomyPanel, FieldIntel, Floating, Frame, GiftPanel, GroupBar, Icon, KeptInside, ReserveTray, SelChip, Tips, STANCE_INFO, SelectionPanel, TacticalMap, TopBar, fmt, nextStance, type Ally, type Command, type GroupEdit, type Hud, type IconName, type MapFilter, type Mode } from './empires/Hud'
import { LongPress, SELPOP_KEEP, TouchBar, WheelHost, getTouchMods, isTouch, useCoarse, useTapAway, setTouchMod, shiftOf, useWheel, type WheelItem, type WheelRequest } from './empires/Touch'
import { BattleMenu, HowToPlay, KeybindsPanel, Lobby, MainMenu, Modal, Result, SettingsPanel, setupAreas, setupMap, slotName, type MenuScreen, type Setup, type Slot } from './empires/Menus'
import { Conquest, type ConquestBattle } from './empires/Conquest'
import { Multiplayer } from './empires/Multiplayer'
import { Net, REJOIN_WAIT, awayBattle, battleToRejoin, type NetView } from './empires/net'
import { cmd as makeCmd, runCmd, thinPath, type CmdArgs, type CmdName, type CmdResult } from './empires/commands'
import { matchBrains, matchMap, matchWorld, stepTurn, type MatchInfo } from './empires/match'
import { HASH_EVERY } from './empires/protocol'
import { outdatedSnapshot, restoreBrain, restoreWorld, snapBrain, snapshotWorld, type BattleSnap } from './empires/snapshot'
import { listSaves, loadSave, type Galaxy } from './empires/galaxy'
import { loadSkirmish, mpActive, resumeGalaxy, saveSkirmish } from './empires/keep'
import { actionFor, getSettings, groupKeyOf, keyName, modOf, setSettings, useAskedPanel, useSettings } from './empires/settings'
import { DoublePress, addToGroup, groupInfo, members, setGroup as putGroup, type Groups } from './empires/groups'
import { HP_NAME, hpName } from './empires/icons'
import { Renderer, drawRank, relColor, type Camera, type View } from './empires/render'
import { beginLayout } from './empires/layout'
import { defaultArea, inRect, inside, type Pt } from './empires/maps'
import {
  STEP, RANKS, autoStart, REFUND_DELAY, canRetreat, canSee, cantConstruct, cantHeal, closedLoop, isRepairer, cantWarp, escorts, faceTargets, lineGroups, lineTargets, foes, hpPos, newFleetBattle, newWorld, placement, startProblem, tick, wrapAngle, type Owner, type SimEvent, type Unit, type World, stateHash,
} from './empires/sim'
import { EmpiresSound, type OrderKind } from './empires/sound'
import { TechTree } from './empires/TechTree'
import { Scoreboard } from './empires/Scoreboard'
import type { AwayVote, SeatStatus } from './empires/protocol'
import { useHighScore, useIsFocused } from './shared'
import './empires/empires.css'
import './empires/touch-battle.css'

// Empires At War: a space RTS in the spirit of Empire at War, set in a Clone Wars style war
// between a Republic navy and a droid Confederacy. One skirmish map against the AI: mine ore,
// capture beacons, upgrade the station, build up from fighters to a flagship, and destroy the
// enemy station. This file holds the screens, the input and the HUD; the battle runs in
// empires/sim.ts and is drawn by empires/render.ts.

/** Closest the camera zooms in: near enough to read a frigate's guns and shield domes. */
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
  // What this window keeps to carry on after a reload is stored under its session, and goes when
  // the window is closed (../session.ts): a closed window opens on the main menu next time.
  const session = win.props.session
  // Galactic conquest: the campaign lives here, so it outlasts the battles fought in it. A campaign
  // that was open in this window before a reload opens again straight away.
  const [galaxy, setGalaxy] = useState<Galaxy | null>(() => resumeGalaxy(session))
  // So does a skirmish that was being fought, from where it was.
  const [skirmish, setSkirmish] = useState(() => (galaxy ? null : loadSkirmish<Setup>(session)))
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
  // Closing the window leaves a lobby like quitting does, rather than holding the seat for a
  // reconnect that isn't coming. From a battle it only steps away: the battle waits a few minutes
  // (REJOIN_MS) for the player to open the game again and rejoin it (the others can vote to carry
  // on sooner). A reload never gets here, so the server lets that come back either way.
  useEffect(
    () => () => {
      if (!netRef.current?.inBattle()) netRef.current?.leave()
      netRef.current?.close()
    },
    [],
  )
  const mp = useSyncExternalStore(net ? net.subscribe : noSubscribe, net ? net.getView : noView)
  // A reload in the middle of multiplayer goes back to it: the server still has us for a while.
  useEffect(() => {
    if (!mpActive.get(session)) return
    const n = new Net()
    setNet(n)
    setScreen('multiplayer')
    return () => n.close()
  }, [])

  // Whether a multiplayer battle waits for us, for the main menu's "Rejoin battle": the one this
  // browser was last in to begin with, then what the server says (signed in, that covers a battle
  // left on another device too). Asked again now and then, as the battle stops waiting at some point.
  const [rejoin, setRejoin] = useState(battleToRejoin)
  useEffect(() => {
    if (screen !== 'menu') return
    let live = true
    const ask = () => void awayBattle().then((b) => live && b !== null && setRejoin(b))
    setRejoin(battleToRejoin())
    ask()
    const t = setInterval(ask, 15_000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [screen])

  if (screen === 'menu') {
    const saves = listSaves()
    return (
      <MainMenu sound={sound.current} victories={best ?? 0} onPlay={() => setScreen('lobby')} initial={menuAt}
        onMultiplayer={() => {
          mpActive.set(session, true)
          setNet(new Net())
          setScreen('multiplayer')
        }}
        rejoin={rejoin}
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
  /** Out of multiplayer, back to the main menu's multiplayer page. */
  const quitMultiplayer = (n: Net) => {
    mpActive.set(session, false)
    n.close()
    setNet(null)
    setMenuAt('multi')
    setScreen('menu')
  }
  if (screen === 'multiplayer' && net && mp?.match) {
    const { info, me } = mp.match
    return (
      <Battle
        key={info.id}
        win={win}
        online={{ net, info, me }}
        sound={sound.current}
        // Leaving (mid-battle, or from the result) leaves the lobby too; "back to the lobby" stays.
        onExit={() => net.leave()}
        onAgain={() => net.endMatch()}
        onMenu={() => quitMultiplayer(net)}
        // The server lost the battle: it goes on here as a skirmish, from this very moment, and is
        // kept for a reload like any other skirmish.
        onOffline={(snap) => {
          const s = offlineSetup(info, me)
          quitMultiplayer(net)
          saveSkirmish(session, { setup: s, snap })
          setSkirmish({ setup: s, snap })
          setSetup(s)
          setRound((r) => r + 1)
          setScreen('battle')
        }}
      />
    )
  }
  if (screen === 'multiplayer' && net) return <Multiplayer net={net} sound={sound.current} onBack={() => quitMultiplayer(net)} />
  if (screen === 'conquest')
    return (
      <Conquest
        g={galaxy}
        setG={setGalaxy}
        session={session}
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
      onSnap={(snap) => saveSkirmish(session, snap ? { setup, snap } : null)}
      sound={sound.current}
      onExit={() => {
        setSkirmish(null)
        setScreen('lobby')
      }}
      onAgain={() => {
        saveSkirmish(session, null)
        setSkirmish(null)
        setRound((r) => r + 1)
      }}
    />
  )
}

const noSubscribe = () => () => {}
const noView = (): NetView | null => null

/** The AI admirals that take over every other player's fleet when a multiplayer battle carries on
 * offline (the server's choice for a player who left, too). */
const OFFLINE_AI = 'medium' as const

/** A multiplayer battle as a skirmish setup, to carry it on offline: we're 'you', every other seat
 * an AI, and spawns nobody had are closed. Sides stay as they were (team 0 or 1 by the match, not
 * relative to us): the battle reads ours from the world. The players keep their names. */
function offlineSetup(info: MatchInfo, me: number): Setup {
  const map = matchMap(info)
  const slots: Slot[] = map.spawns.map((_, i) => ({ kind: 'closed', faction: i % 2 ? 'droid' : 'republic', team: (i % 2) as 0 | 1, difficulty: OFFLINE_AI, profile: 'balanced' }))
  const names: (string | null)[] = map.spawns.map(() => null)
  info.seats.forEach((s, i) => {
    slots[s.spawn] = { kind: i === me ? 'you' : 'ai', faction: s.faction, team: s.team, difficulty: s.kind === 'ai' ? s.difficulty : OFFLINE_AI, profile: s.kind === 'ai' ? profileOf(s.profile) : 'balanced' }
    names[s.spawn] = i === me ? null : s.kind === 'ai' ? s.name : `${s.name} (AI)`
  })
  return { map: info.map, gen: info.gen, credits: info.credits, slots, areas: [], names, ...(info.reinforce ? { reinforce: info.reinforce } : {}) }
}

// --- Battle ---------------------------------------------------------------------------------------

/** Multiplayer turns the battle keeps queued at most before it plays faster to catch up: about
 * 70 ms of slack for uneven arrivals, without falling far behind the server. */
const TURN_BUFFER = 2

/** `at`: where the message happened, for the camera to go to when it's clicked; `unit`: the ship or
 * structure it's about, followed to where it is now and selected (if it's still there and ours). */
type Toast = { id: number; text: string; tone: 'good' | 'bad' | 'info'; t: number; at?: { x: number; y: number; unit?: number } }

/** How long a message stays up, in ms. */
const TOAST_MS = 4500

/**
 * The battle's messages, kept apart from the battle's own state: a big fight can bring several a
 * second, and each one redrawing the whole battle screen (every panel and card) cost more than the
 * messages themselves. Only the ToastStack redraws for them.
 */
class ToastStore {
  private list: Toast[] = []
  private subs = new Set<() => void>()
  private set(next: Toast[]) {
    this.list = next
    this.subs.forEach((l) => l())
  }
  push(t: Toast) {
    this.set([...this.list.slice(-3), t])
  }
  dismiss(id: number) {
    this.set(this.list.filter((x) => x.id !== id))
  }
  /** Drops the messages that have been up long enough (no redraw when none has). */
  prune(now: number) {
    if (this.list.some((x) => now - x.t >= TOAST_MS)) this.set(this.list.filter((x) => now - x.t < TOAST_MS))
  }
  subscribe = (l: () => void) => {
    this.subs.add(l)
    return () => void this.subs.delete(l)
  }
  get = () => this.list
}

/** The messages down the side of the battle. `look` takes the camera to what a message is about. */
const ToastStack = memo(function ToastStack({ store, low, look }: { store: ToastStore; low: boolean; look: React.RefObject<(at: NonNullable<Toast['at']>) => void> }) {
  const toasts = useSyncExternalStore(store.subscribe, store.get)
  // Old toasts fade out.
  useEffect(() => {
    if (!toasts.length) return
    const t = setTimeout(() => store.prune(performance.now()), 1000)
    return () => clearTimeout(t)
  }, [toasts, store])
  return (
    <div className={`ew-toasts ${low ? 'is-low' : ''}`} aria-live="polite">
      {toasts.map((t) => {
        const dismiss = () => store.dismiss(t.id)
        // A message about a place takes the camera there (click, tap, or Enter), and is done with.
        const at = t.at
        const go = at ? () => (look.current(at), dismiss()) : undefined
        return (
          // Right-click, or the × that shows on hover, puts it away.
          <section
            key={t.id}
            className={`ew-frame ew-toast is-${t.tone}${go ? ' is-link' : ''}`}
            role={go ? 'button' : undefined}
            tabIndex={go ? 0 : undefined}
            onClick={go}
            onKeyDown={go && ((e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), e.stopPropagation(), go()))}
            onContextMenu={(e) => (e.preventDefault(), dismiss())}
          >
            <div className="ew-frame-in">
              {go && <i className="ew-toast-go" aria-hidden>⌖</i>}
              <span>{t.text}</span>
              <button className="ew-toast-x" onClick={(e) => (e.stopPropagation(), dismiss())} aria-label="Dismiss">×</button>
            </div>
          </section>
        )
      })}
    </div>
  )
})

function snapshot(w: World, me: Owner, sel: Set<number>, groups: Groups): Hud {
  const p = w.players[me]
  return {
    groups: groupInfo(w, me, groups),
    idle: w.units.filter((u) => u.owner === me && isShip(u.t) && !u.parent && u.order.k === 'idle' && !u.target && u.stance !== 'hold').length,
    credits: p.credits, income: p.income, pop: p.pop, popCap: p.popCap, faction: p.faction, level: p.level,
    queue: p.queue.map((q) => ({ ...q })), reserve: [...p.reserve], research: p.research.map((r) => ({ ...r })), techs: [...p.techs], time: w.time, sel: [...sel], winner: w.winner,
    beacons: w.beacons.filter((b) => b.owner === p.team).length, beaconsAll: w.beacons.length, mines: w.units.filter((u) => u.owner === me && u.t.tier === 'mine').length,
    hybrid: !!w.hybrid,
    yards: w.units
      .filter((u) => !u.dead && u.owner === me && u.t.tier === 'yard')
      .map((u) => ({ id: u.id, unit: u.t.id, queue: (u.yq ?? []).map((q) => ({ ...q })), built: !u.site, progress: u.site ? 1 - u.building / u.t.build : 1 })),
  }
}

function Battle({ win, setup, conquest, online, resume, onSnap, sound, onExit, onAgain, onMenu, onOffline }: {
  win: WinState
  setup?: Setup
  conquest?: ConquestBattle
  /** A multiplayer battle: built from the match, played from the server's turns, and every order
   * goes through the server. */
  online?: { net: Net; info: MatchInfo; me: number }
  /** A battle saved mid-fight, to carry on from. */
  resume?: BattleSnap | null
  /** Keeps the battle as it goes (null once it's over), so a reload of its window can resume it. */
  onSnap?: (s: BattleSnap | null) => void
  sound: EmpiresSound
  onExit: () => void
  onAgain: () => void
  /** Online, once the server has lost the battle: out to the main menu, or on against the computer
   * from the battle as it stands. */
  onMenu?: () => void
  onOffline?: (snap: BattleSnap) => void
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
        kind: (i === online.me ? 'you' : 'ai') as Slot['kind'], faction: s.faction, team: s.team, difficulty: s.difficulty, profile: profileOf(s.profile), spawn: s.spawn, name: s.name, area: defaultArea(map, s.spawn),
      }))
    if (conquest)
      return conquest.sides.map((s, i) => ({
        kind: (i === conquest.me ? 'you' : 'ai') as Slot['kind'], faction: s.faction, team: s.team as 0 | 1, difficulty: conquest.ai, profile: profileOf(conquest.profile), spawn: i, name: conquest.names[i], area: defaultArea(map, i),
      }))
    const areas = setupAreas(setup!, map)
    return setup!.slots.map((s, i) => ({ ...s, spawn: i, name: setup!.names?.[i] ?? slotName(s, i), area: areas[i] })).filter((s) => s.kind !== 'closed')
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
      { credits: setup?.credits, reinforce: setup?.reinforce },
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
    online ? matchBrains(online.info) : resumed.current && resume ? resume.brains.map(restoreBrain) : seats.map((s, i) => (s.kind === 'ai' ? newBrain(i, s.difficulty, s.profile) : null)).filter((b): b is Brain => !!b),
  )
  const settings = useSettings()
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const renderer = useRef<Renderer>(null as unknown as Renderer)
  if (!renderer.current) renderer.current = new Renderer()
  const w0 = world.current
  // The camera starts on our station, or in a fleet battle where our fleet comes in.
  const st0 = w0.byId.get(w0.players[me].station) ?? w0.fleet?.entry[me] ?? { x: w0.w / 2, y: w0.h / 2 }
  const cam = useRef<Camera>(resumed.current && resume ? { ...resume.cam } : { x: st0.x, y: st0.y, zoom: 0.4 })
  // Dev builds expose the battle for poking at from the console.
  if (import.meta.env.DEV) (window as unknown as { __ew: unknown }).__ew = { world: world.current, brains: brains.current, cam: cam.current }
  const selected = useRef(new Set<number>(resumed.current && resume ? resume.sel : []))
  // Dev builds only: the cheat panel (empires/devCheats.tsx), loaded on demand and never in a
  // multiplayer battle. The branch is gone from a production build, and the module with it.
  const [dev, setDev] = useState<typeof import('./empires/devCheats') | null>(null)
  const devRef = useRef(dev)
  devRef.current = dev
  useEffect(() => {
    if (import.meta.env.DEV) {
      if (online) return
      let live = true
      void import('./empires/devCheats').then((m) => {
        if (!live) return
        ;(window as unknown as { __ewDev: unknown }).__ewDev = m
        setDev(m)
      })
      return () => {
        live = false
      }
    }
  }, [])
  const groups = useRef(new Map<string, number[]>(resumed.current && resume ? resume.groups : []))
  const mode = useRef<Mode>('normal')
  /** Hybrid bases: the yard being placed ('place' mode), the engineers who will build it, and on
   * touch the spot picked so far (it waits for the confirm button). */
  const placing = useRef<{ unit: string; ids: number[]; at: Pt | null; /** The way the mouth faces, once the player turns it (else away from the station). */ a: number | null } | null>(null)
  /** Mouse: a press at the spot being dragged out to set the facing; the yard goes down on release. */
  const placeDrag = useRef<{ at: Pt; sx: number; sy: number; turned: boolean } | null>(null)
  const wheelAcc = useRef(0)
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
  // Touch: a long press opens the action wheel; a line or facing drag armed from it draws with the
  // next one-finger drag (fingers have no right button). Whether the last pointer was a finger
  // decides the hints' wording, and keeps a finger off the screen edges from scrolling.
  const press = useRef(new LongPress())
  const miniPress = useRef(new LongPress())
  const drawMode = useRef<'line' | 'face' | null>(null)
  const touchLast = useRef(false)
  const [touchUi, setTouchUi] = useState(false)
  const wheel = useRef<(r: WheelRequest | null) => void>(() => {})
  const [mapOpen, setMapOpen] = useState(false)
  // On a touch screen the selection is one small button; its panel opens from it and closes on a tap away.
  const compact = useCoarse()
  const [selOpen, setSelOpen] = useState(false)

  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const mini = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  const [hud, setHud] = useState<Hud>(() => snapshot(world.current, me, selected.current, groups.current))
  const [toasts] = useState(() => new ToastStore())
  const [ui, setUi] = useState({ paused: false, speed: speed.current, mode: 'normal' as Mode, draw: null as 'line' | 'face' | null, menu: false, panel: null as 'settings' | 'keys' | 'howto' | null, tree: false, deploy: deploying.current, placed: placed.current, reserves: !!conquest, economy: false, players: false, gift: false })
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

  const toast = (text: string, tone: Toast['tone'] = 'info', at?: Toast['at']) => {
    if (tone === 'bad' || getSettings().toasts) toasts.push({ id: toastId.current++, text, tone, t: performance.now(), at })
  }
  // A battle kept from before there was one ship size (fought at Classic sizes) can't be carried on:
  // say so, rather than quietly starting a new one.
  useEffect(() => {
    if (resume && !resumed.current && outdatedSnapshot(resume.world)) toast('This battle was saved by an older version of the game and can\'t be carried on: a new one starts.', 'bad')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  /** Where a clicked message points: the camera goes there, and the ship it's about is selected. */
  const lookAt = (at: NonNullable<Toast['at']>) => {
    const u = at.unit !== undefined ? world.current.byId.get(at.unit) : undefined
    if (u && !u.dead) {
      centerOn(u.x, u.y)
      if (u.owner === me) {
        select([u.id])
        sound.select(myFaction, u.t.tier)
      }
    } else centerOn(at.x, at.y)
  }
  const lookRef = useRef(lookAt)
  lookRef.current = lookAt
  const setMode = (m: Mode) => {
    mode.current = m
    if (m !== 'place') placing.current = null
    drawMode.current = null
    setUi((u) => ({ ...u, mode: m, draw: null }))
  }
  /** Touch: arm a line (or facing) drag for the next one-finger drag on the battlefield. */
  const setDraw = (m: 'line' | 'face' | null) => {
    mode.current = 'normal'
    drawMode.current = m
    setUi((u) => ({ ...u, mode: 'normal', draw: m }))
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
  const toScreen = (x: number, y: number) => {
    const { vw, vh } = view()
    const c = cam.current
    return { x: (x - c.x) * c.zoom + vw / 2, y: (y - c.y) * c.zoom + vh / 2 }
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

  /** The unit under a screen point, the topmost first (smaller ships are drawn over bigger ones, see
   * drawRank: a gunship over a flagship's hull is picked, the flagship's hull round it picks the
   * flagship); plus the hardpoint, if one is close and nothing is drawn over it there. */
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
    const onHp = best
    best = undefined
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
      // A little wider than the hull's box, so its edges still count.
      const inside = Math.abs(lx) <= Math.max(uw * 0.55, minR) && Math.abs(ly) <= Math.max(uh * 0.55, minR)
      if (!inside) continue
      const score = -drawRank(u) * 1e6 + u.t.size + Math.hypot(dx, dy) * 0.1
      if (score < bestScore) {
        bestScore = score
        best = u
      }
    }
    // A hardpoint counts unless a ship drawn over its hull is under the point too.
    if (onHp && (!best || drawRank(best) <= drawRank(onHp))) best = onHp
    else hp = -1

    let node = -1
    for (const n of w.nodes) if (Math.hypot(n.x - p.x, n.y - p.y) < 130) node = n.id
    const wreck = w.wrecks.find((h) => Math.hypot(h.x - p.x, h.y - p.y) < h.size * 0.55 + 20)?.id ?? 0
    return { unit: best, hp, node, wreck, at: p }
  }

  /** Guard armed: the ship under the pointer, when one of the selection would escort it (a friendly
   * ship two classes bigger), for its "Escort" tag. */
  const escortHint = (id: number) => {
    const g = id ? world.current.byId.get(id) : undefined
    return g && !g.dead && !foes(world.current, g.owner, me) && mySelection().some((u) => u !== g && escorts(u, g)) ? g.id : undefined
  }

  /** The selected repair ships (tenders and Field repair craft) that a right-click on `unit` would
   * send to repair it: a damaged ship or station of ours or an ally's that each can mend. Engineers
   * aren't among them: structures are theirs through the construct order. */
  const medicsFor = (unit: Unit | undefined) => {
    const w = world.current
    if (!unit || unit.dead || foes(w, unit.owner, me)) return []
    return mySelection().filter((u) => isShip(u.t) && !isEngineer(u.t) && isRepairer(u.t) && !cantHeal(w, me, u, unit))
  }
  /** Engineers in the selection that a right-click on `unit` would send to repair it: a damaged
   * finished structure of ours or an ally's (not a site to build or a ship to finish). */
  const weldersFor = (unit: Unit | undefined) => {
    const w = world.current
    if (!unit || unit.dead || isShip(unit.t) || unit.site || cantConstruct(w, me, unit)) return []
    return mySelection().filter((u) => isEngineer(u.t))
  }
  /** The ship or structure under the pointer to tag "Repair": what a right-click would repair. */
  const repairHint = (id: number) => {
    const u = id ? world.current.byId.get(id) : undefined
    return u && (medicsFor(u).length || weldersFor(u).length) ? u.id : undefined
  }
  /** Sends repair ships to repair `unit`; false (and says why) when it can't be done. */
  const repairOrder = (unit: Unit, medics: Unit[], queued = false) => {
    const why = order('mend', medics.map((u) => u.id), unit.id, queued)
    if (why) {
      toast(why, 'bad')
      sound.error()
      return false
    }
    renderer.current.ping(unit.x, unit.y, '#7dffa0')
    sound.order('move', myFaction, medics.some((u) => u.t.tier !== 'fighter') ? 'gunship' : 'fighter')
    return true
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
    if (m === 'place') return place(at, queued)
    if (m === 'rally') {
      order('rally', at.x, at.y, rallyAt())
      renderer.current.ping(at.x, at.y, rallyAt() ? '#ffc86e' : '#7dffa0')
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
      if (c === 'rally' ? !mySelection().some((u) => u.t.tier === 'station') && !rallyAt() : !mySelection().some((u) => isShip(u.t)) && !(c === 'attack' && armed)) return sound.error()
      setMode(mode.current === c ? 'normal' : c)
      sound.arm()
    }
  }

  const command = (sx: number, sy: number, attackMove: boolean, queued = false) => {
    const w = world.current
    const { unit, hp, at } = pick(sx, sy)
    let ships = mySelection().filter((u) => isShip(u.t))
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
    // Repair ships: a right-click on a damaged ship (or station) of ours or an ally's repairs it, each
    // one that can; the rest of the selection carries on as usual (on a friendly: moves there).
    const medics = !attackMove ? medicsFor(unit) : []
    if (medics.length && unit) {
      repairOrder(unit, medics, queued)
      ships = ships.filter((u) => !medics.includes(u))
      if (!ships.length) return
    }
    // Engineers: a right-click on one of our structures builds or repairs it (and on a rush-launched
    // warship of ours finishes it), on our ruin of a yard rebuilds it; the rest of the selection
    // carries on as usual.
    const crew = ships.filter((u) => isEngineer(u.t))
    if (crew.length && !attackMove) {
      const ruin = (w.ruins ?? []).find((r) => r.owner === me && Math.hypot(r.x - at.x, r.y - at.y) < UNIT[r.unit].size * 0.45)
      // (An ally's damaged structure too: they weld it back for them.)
      const job = unit && unit.owner === me && (!isShip(unit.t) || unit.rush) ? unit : weldersFor(unit).length ? unit : undefined
      if (job || (ruin && !unit)) {
        const why = job ? order('construct', crew.map((u) => u.id), job.id, queued) : order('place', crew.map((u) => u.id), ruin!.unit, ruin!.x, ruin!.y, queued)
        if (why) {
          toast(why, 'bad')
          sound.error()
        } else {
          const to = job ?? ruin!
          renderer.current.ping(to.x, to.y, '#ffc86e')
          sound.order('move', myFaction, 'fighter')
          if (!job) sound.constructing()
        }
        const rest = ships.filter((u) => !isEngineer(u.t))
        if (!rest.length) return
        order('move', rest.map((u) => u.id), at.x, at.y, false, queued)
        return
      }
    }
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
        const gunUnit = tp ? w.byId.get(tp.unit)! : null
        const gunName = tp && gunUnit ? hpName(gunUnit.t.hardpoints[tp.hp], gunUnit.t.faction) : null
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
      if (stationSel || rallyAt()) {
        order('rally', at.x, at.y, rallyAt())
        renderer.current.ping(at.x, at.y, rallyAt() ? '#ffc86e' : '#7dffa0')
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

  // --- Hybrid bases --------------------------------------------------------------------------------

  /** The yard whose rally point a rally order sets: a selected yard of ours (with no station
   * selected, whose own rally point comes first), else 0 for the station's. */
  const rallyAt = () => {
    const mine = mySelection()
    if (mine.some((u) => u.t.tier === 'station')) return 0
    return mine.find((u) => u.t.tier === 'yard' && !!u.yq)?.id ?? 0
  }
  /** Start placing a yard: with the engineers selected, or else every one of ours (idle ones
   * first). Without any, it says how to get some. */
  const startPlace = (unit: string) => {
    sound.unlock()
    const w = world.current
    const ours = w.units.filter((u) => !u.dead && u.owner === me && isEngineer(u.t))
    const chosen = mySelection().filter((u) => isEngineer(u.t))
    const crew = chosen.length ? chosen : ours
    const why = !w.hybrid ? 'No yards in this battle' : !crew.length ? 'No engineers: build an engineer squadron at the Command Station first' : null
    // The rest (level, credits, one at a time) shows on the ghost itself.
    if (why) {
      toast(why, 'bad')
      sound.error()
      return
    }
    setMode('place')
    placing.current = { unit, ids: crew.map((u) => u.id), at: null, a: null }
    sound.arm()
  }
  /** Put the yard down at `at` (the order goes into the engineers' queues with `queued`). */
  const place = (at: Pt, queued = false) => {
    const pl = placing.current
    if (!pl) return
    // A finger pins the spot first (a tap elsewhere moves it): the confirm button builds it.
    if (touchLast.current) {
      pl.at = { x: at.x, y: at.y }
      sound.click()
      setUi((u) => ({ ...u }))
      return
    }
    const why = order('place', pl.ids, pl.unit, at.x, at.y, queued, pl.a ?? undefined)
    if (why) {
      toast(why, 'bad')
      sound.error()
      return
    }
    renderer.current.ping(at.x, at.y, '#ffc86e')
    sound.constructing()
    toast(`${UNIT[pl.unit].name}: the engineers are on their way`, 'info')
    setMode('normal')
  }
  /** Touch (the action wheel): start placing a yard with its spot already pinned at `at`. */
  const pinYard = (at: Pt) => {
    startPlace(nextYard())
    if (placing.current) placing.current.at = { x: at.x, y: at.y }
    setUi((u) => ({ ...u }))
  }
  /** Touch: build at the pinned spot. */
  const confirmPlace = () => {
    const at = placing.current?.at
    if (!at) return
    placing.current!.at = null
    touchLast.current = false
    place(at, shiftOf())
  }
  /** Turn the yard being placed by `deg` degrees (positive: clockwise on screen). */
  const rotatePlace = (deg: number) => {
    const pl = placing.current
    if (!pl) return
    pl.a = wrapAngle((pl.a ?? placeGhost()?.a ?? 0) + (deg * Math.PI) / 180)
    setUi((u) => ({ ...u }))
  }
  /** The ghost of the yard being placed, for the renderer: under the pointer (or the pinned spot). */
  const placeGhost = () => {
    const pl = placing.current
    const w = world.current
    if (!pl || mode.current !== 'place') return null
    const at = pl.at ?? (mouse.current.inside ? toWorld(mouse.current.x, mouse.current.y) : null)
    const st = w.byId.get(w.players[me].station)
    if (!at || !st) return null
    const g = placement(w, me, pl.unit, at.x, at.y, pl.a ?? undefined)
    return { t: UNIT[pl.unit], x: g.x, y: g.y, a: g.a, ok: !g.why, why: g.why, cost: g.cost, rebuild: !!g.ruin, ring: { x: st.x, y: st.y, r: BUILD_RADIUS } }
  }
  /** The yard to place next: the first of ours (the Frigate Yard, then the Capital Yard) we have
   * neither standing nor going up and the station is upgraded for, else the Frigate Yard (its ghost
   * then says why not). */
  const nextYard = () => {
    const w = world.current
    const p = w.players[me]
    const lacking = yardsFor(p.faction).filter((t) => !w.units.some((u) => !u.dead && u.owner === me && u.t.id === t.id))
    return (lacking.find((t) => t.level <= p.level) ?? lacking[0] ?? yardOf(p.faction)).id
  }
  /** Select our Capital Yard and look at it. */
  const selectCapitalYard = () => {
    const w = world.current
    const y = w.units.find((u) => !u.dead && u.owner === me && u.t.id === yardOf(myFaction, 'cyard').id)
    if (!y) {
      toast(w.hybrid ? 'No Capital Yard yet: engineers build one near the Command Station from station level 3' : 'No yards in this battle', 'info')
      return sound.error()
    }
    selectOne(y.id)
  }
  /** Select one of our yards, the next one each time; asked again for the one selected, look at it. */
  const selectYard = () => {
    const w = world.current
    const yards = w.units.filter((u) => !u.dead && u.owner === me && u.t.tier === 'yard')
    if (!yards.length) {
      toast(w.hybrid ? 'No yard yet: engineers build one near the Command Station' : 'No yards in this battle', 'info')
      return sound.error()
    }
    const cur = yards.findIndex((y) => selected.current.has(y.id))
    const next = yards[(cur + 1) % yards.length]
    if (cur >= 0 && yards.length === 1) centerOn(next.x + 150, next.y + 80)
    select([next.id])
    sound.select(myFaction, 'station')
  }
  /** Select a unit of ours and look at it (the base tabs). */
  const selectOne = (id: number) => {
    const u = world.current.byId.get(id)
    if (!u || u.dead) return
    select([id])
    centerOn(u.x + 150, u.y + 80)
    sound.click()
  }
  /** Select every engineer of ours and look at them: their Build section has the yards. False (with
   * a message) when there are none. */
  const selectEngineers = () => {
    const eng = world.current.units.filter((u) => !u.dead && u.owner === me && isEngineer(u.t))
    if (!eng.length) {
      toast('Build engineers first', 'bad')
      sound.error()
      return false
    }
    select(eng.map((u) => u.id))
    centerOn(eng.reduce((s, u) => s + u.x, 0) / eng.length, eng.reduce((s, u) => s + u.y, 0) / eng.length)
    sound.click()
    return true
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
  /** Select a control group (its key, a click or a tap on its chip); twice in quick succession also
   * looks at it. A group of one yard (or the station) opens its build panel, as selecting it does. */
  const groupPress = useRef(new DoublePress())
  const recallGroup = (k: string) => {
    const w = world.current
    const us = members(w, me, groups.current, k)
    if (!us.length) {
      groupPress.current.hit('', 0)
      return
    }
    select(us.map((u) => u.id))
    if (groupPress.current.hit(k, performance.now())) {
      // Where most of it is: the middle of the group, or the one structure in it.
      const one = us.length === 1 && !isShip(us[0].t)
      centerOn(us.reduce((s, u) => s + u.x, 0) / us.length + (one ? 150 : 0), us.reduce((s, u) => s + u.y, 0) / us.length + (one ? 80 : 0))
    } else pickedSound(us.reduce((b, u) => (u.t.size > b.t.size ? u : b), us[0]))
  }
  const selectArmy = () => {
    select(world.current.units.filter((u) => u.owner === me && isShip(u.t)).map((u) => u.id))
    if (mySelection().length) sound.select(myFaction, voice())
  }
  /** `target`: what Field repair should mend; the ship or station under the pointer when left out. */
  const useAbility = (target = hover.current.unit) => {
    const ready = mySelection().filter((u) => u.t.ability && u.abilityCd <= 0)
    // Online the count isn't known yet: the abilities that are ready will fire.
    const n = order('ability', mySelection().map((u) => u.id), target) ?? ready.length
    if (n) for (const id of new Set(ready.map((u) => u.t.ability!))) sound.ability(id, undefined, myFaction)
    else if (mySelection().some((u) => u.t.ability)) {
      sound.error()
      if (ready.some((u) => u.t.ability === 'fieldRepair')) toast('Field repair: no damaged station or gunship-class ship nearby', 'bad')
    }
  }
  /** Every one of ours of this type on screen (a double-click, or a double tap). */
  const selectType = (unit: Unit, add: boolean) => {
    const { vw, vh } = view()
    const a = toWorld(0, 0)
    const b = toWorld(vw, vh)
    select(world.current.units.filter((u) => u.owner === me && u.t.id === unit.t.id && u.x >= a.x && u.x <= b.x && u.y >= a.y && u.y <= b.y).map((u) => u.id), add)
  }
  /** The crew of what was just picked answers (structures just click). */
  const pickedSound = (u: Unit) => (isShip(u.t) || u.t.tier === 'station' ? sound.select(myFaction, u.t.tier) : sound.click())
  /** Set group `k` to the selection, add the selection to it, or clear it (Ctrl or Shift with its
   * key, or a long press on its chip). */
  const editGroup = (k: string, how: GroupEdit) => {
    const ids = mySelection().map((u) => u.id)
    if (how !== 'clear' && !ids.length) {
      toast('Select some of ours first, then put them in a group', 'bad')
      return sound.error()
    }
    if (how === 'clear') putGroup(groups.current, k, [])
    else if (how === 'set') putGroup(groups.current, k, ids)
    else addToGroup(groups.current, k, ids)
    const n = members(world.current, me, groups.current, k).length
    toast(how === 'clear' ? `Group ${k} cleared` : `Group ${k}${how === 'add' ? ' now' : ''}: ${n} ${n === 1 ? 'unit' : 'units'}`, 'info')
    sound.click()
    // The bar shows it at once, not at the next HUD refresh.
    setHud(snapshot(world.current, me, selected.current, groups.current))
  }

  /**
   * Touch: the action wheel for a long press on the battlefield, at a screen point (and where the
   * finger is on the page). What it offers depends on what is selected and what is under the finger;
   * every action goes through the same orders as the mouse and keys.
   */
  const fieldWheel = (sx: number, sy: number, cx: number, cy: number) => {
    const w = world.current
    const { unit, node, at } = pick(sx, sy)
    const mine = mySelection()
    const ships = mine.filter((u) => isShip(u.t))
    const guns = mine.filter((u) => !isShip(u.t) && u.guns.length > 0)
    const ids = () => mySelection().filter((u) => isShip(u.t)).map((u) => u.id)
    const enemy = !!unit && foes(w, unit.owner, me)
    const own = !!unit && unit.owner === me
    // The wheel may stay open a moment while the battle goes on: an action aims at the spot on the
    // unit that was pressed, wherever it has got to, or else at the map point.
    const off = unit ? { x: at.x - unit.x, y: at.y - unit.y } : { x: 0, y: 0 }
    const spot = () => {
      const u = unit && world.current.byId.get(unit.id)
      return u && !u.dead ? toScreen(u.x + off.x, u.y + off.y) : toScreen(at.x, at.y)
    }
    const it = (id: string, label: string, icon: IconName, run: () => void, disabled?: string | false): WheelItem => ({ id, label, icon: <Icon name={icon} size={18} />, run, disabled: disabled || undefined })
    const arm = (m: Mode) => () => {
      const s = spot()
      modeClick(s.x, s.y, m, shiftOf())
    }
    const only = (u: Unit) => () => {
      select([u.id])
      pickedSound(u)
    }
    const info = unit ? [it('info', 'Info', 'help', () => setIntel({ id: unit.id, x: sx, y: sy }))] : []
    const items: WheelItem[] = []
    if (ships.length && unit && enemy) {
      items.push(
        it('attack', 'Attack', 'attack', () => {
          const s = spot()
          command(s.x, s.y, false, shiftOf())
        }),
        it('area', 'Attack area', 'target', () => {
          // A circle round it, about as big on screen as a thumb's sweep: everything in it is shared out.
          const u = world.current.byId.get(unit.id) ?? unit
          order('area', ids(), u.x, u.y, Math.max(60, Math.max(...dims(u.t)) * 0.6, 110 / cam.current.zoom))
          renderer.current.ping(u.x, u.y, '#ff5a50')
          say('attack')
        }),
        it('move', 'Move here', 'move', arm('move')),
        // With structures selected too, their guns alone (Attack sends both).
        ...(guns.length
          ? [
              it('focus', 'Focus fire', 'radar', () => {
                const u = world.current.byId.get(unit.id)
                if (!u) return
                const why = order('focus', guns.map((g) => g.id), u.id, -1, false)
                if (why) {
                  toast(why, 'bad')
                  sound.error()
                } else {
                  renderer.current.ping(u.x, u.y, '#ff5a50')
                  sound.order('target', myFaction, 'station')
                  toast(`Guns focusing on the ${u.t.name}`, 'info')
                }
              }),
            ]
          : []),
        ...info,
      )
    } else if (ships.length && unit && own) {
      // Engineers selected and this one of our structures needs building or mending; repair ships
      // selected and this one hurt: they repair it (both, on a station).
      const crew = ships.filter((u) => isEngineer(u.t))
      const medics = medicsFor(unit)
      if (crew.length && !cantConstruct(w, me, unit))
        items.push(it('construct', unit.site ? 'Build it' : unit.rush ? 'Finish it' : 'Repair it', 'slip', () => {
          const why = order('construct', crew.map((u) => u.id), unit.id, shiftOf())
          if (why) {
            toast(why, 'bad')
            sound.error()
          } else renderer.current.ping(unit.x, unit.y, '#ffc86e')
          if (medicsFor(unit).length) repairOrder(unit, medicsFor(unit), shiftOf())
        }))
      else if (medics.length) items.push(it('repair', 'Repair it', 'ability', () => repairOrder(unit, medicsFor(unit), shiftOf())))
      items.push(it('guard', ships.some((u) => escorts(u, unit)) ? 'Escort it' : 'Guard it', 'hold', arm('guard')), it('only', 'Select only this', 'target', only(unit)), it('type', 'Select all of type', 'fleet', () => selectType(unit, shiftOf())), ...info)
    } else if (ships.length && unit && !enemy && (medicsFor(unit).length || weldersFor(unit).length)) {
      // An ally's damaged ship or structure, with repair ships or engineers selected: repair it, or
      // guard it.
      const medics = medicsFor(unit)
      const crew = weldersFor(unit)
      if (medics.length) items.push(it('repair', 'Repair it', 'ability', () => repairOrder(unit, medicsFor(unit), shiftOf())))
      if (crew.length)
        items.push(it('construct', 'Repair it', 'slip', () => {
          const why = order('construct', crew.map((u) => u.id), unit.id, shiftOf())
          if (why) {
            toast(why, 'bad')
            sound.error()
          } else renderer.current.ping(unit.x, unit.y, '#ffc86e')
        }))
      items.push(it('guard', ships.some((u) => escorts(u, unit)) ? 'Escort it' : 'Guard it', 'hold', arm('guard')), it('move', 'Move here', 'move', arm('move')), ...info)
    } else if (ships.length) {
      // Empty space (or an ally). One ship or squadron turns to face the drag; more spread along it,
      // or keep their formation and turn to face it.
      const several = lineGroups(w, me, ships.map((u) => u.id)).length > 1
      const withAb = ships.filter((u) => u.t.ability)
      // Engineers: put a yard down here (pinned, for the confirm button).
      if (w.hybrid && ships.some((u) => isEngineer(u.t))) items.push(it('yard', 'Build yard', 'slip', () => pinYard(at)))
      items.push(
        it('move', 'Move here', 'move', arm('move')),
        it('attackMove', 'Attack move', 'attack', () => {
          // Straight to the order: on an ally, the attack-move click would open fire on it.
          const s = spot()
          const p = toWorld(s.x, s.y)
          order('move', ids(), p.x, p.y, true, shiftOf())
          renderer.current.ping(p.x, p.y, '#ffaa5a')
          say('attackMove')
        }),
        it('patrol', 'Patrol', 'patrol', arm('patrol')),
        it('line', several ? 'Line' : 'Face', several ? 'fleet' : 'roam', () => setDraw('line')),
        ...(several ? [it('face', 'Face', 'roam', () => setDraw('face'))] : []),
        it('stance', 'Stance', 'hold', () => runCommand('hold')),
        it('stop', 'Stop', 'stop', () => runCommand('stop')),
        ...(withAb.length ? [it('ability', 'Ability', 'ability', () => runCommand('ability'), !withAb.some((u) => u.abilityCd <= 0) && 'Not ready yet')] : []),
        ...(mine.some(canRetreat) ? [{ ...it('retreat', 'Retreat', 'jump', () => runCommand('retreat')), danger: true }] : []),
        ...info,
      )
    } else {
      const station = mine.some((u) => u.t.tier === 'station')
      if (station || rallyAt()) items.push(it('rally', 'Rally here', 'rally', arm('rally')))
      if (station && w.hybrid) items.push(it('yard', 'Build yard', 'slip', () => pinYard(at)))
      if (enemy && guns.length)
        items.push(
          it('focus', 'Focus fire', 'attack', () => {
            const s = spot()
            command(s.x, s.y, false)
          }),
        )
      if (unit && own) items.push(it('only', 'Select', 'target', only(unit)), it('type', 'Select all of type', 'fleet', () => selectType(unit, shiftOf())))
      if (!unit && node >= 0)
        items.push(
          it('ore', 'Ore info', 'ore', () => {
            selected.current.clear()
            pickedNode.current = node
            sound.click()
          }),
        )
      items.push(it('army', 'Select army', 'army', selectArmy), it('idle', 'Select idle', 'idle', selectIdle))
      if (!station) items.push(it('station', 'Station', 'yard', selectStation))
      items.push(...info)
    }
    wheel.current({ x: cx, y: cy, items, title: unit ? unit.t.name : ships.length ? `${ships.length} ship${ships.length > 1 ? 's' : ''}` : undefined })
  }

  /** Touch: the wheel for a long press on the tactical map, at a map point. */
  const miniWheel = (x: number, y: number, cx: number, cy: number) => {
    const ships = () => mySelection().filter((u) => isShip(u.t)).map((u) => u.id)
    const go = (kind: 'move' | 'attackMove' | 'patrol') => () => {
      if (kind === 'patrol') order('patrol', ships(), x, y, shiftOf())
      else order('move', ships(), x, y, kind === 'attackMove', shiftOf())
      say(kind)
    }
    const items: WheelItem[] = []
    if (mySelection().some((u) => isShip(u.t)))
      items.push(
        { id: 'move', label: 'Move here', icon: <Icon name="move" size={18} />, run: go('move') },
        { id: 'attackMove', label: 'Attack move', icon: <Icon name="attack" size={18} />, run: go('attackMove') },
        { id: 'patrol', label: 'Patrol', icon: <Icon name="patrol" size={18} />, run: go('patrol') },
      )
    else if (mySelection().some((u) => u.t.tier === 'station'))
      items.push({
        id: 'rally', label: 'Rally here', icon: <Icon name="rally" size={18} />,
        run: () => {
          order('rally', x, y)
          say('rally')
        },
      })
    wheel.current({ x: cx, y: cy, items })
  }

  /** Touch has no Esc or right-click: the touch bar's ✕ backs out of an armed order, then the selection. */
  const cancelTouch = () => {
    if (drawMode.current) setDraw(null)
    else if (mode.current !== 'normal') setMode('normal')
    else if (turretPick.current) turretPick.current = null
    else {
      selected.current.clear()
      pickedNode.current = -1
    }
    dropIntel()
    sound.click()
  }

  const build = (id: string, times = 1, reserve = false, at = 0) => {
    sound.unlock()
    let why: string | null = null
    let n = 0
    for (let i = 0; i < times; i++) {
      why = order('build', id, reserve, at)
      if (why) break
      n++
    }
    if (!n && why) {
      toast(why, 'bad')
      sound.error()
    } else sound.queued()
  }
  /** Order an expansion on one of our buildings (hybrid bases), or call one off. */
  const expand = (uid: number, id: ModuleId) => {
    sound.unlock()
    const why = order('expand', uid, id)
    if (why) {
      toast(why, 'bad')
      sound.error()
    } else sound.queued()
  }
  const cancelExpand = (uid: number, i: number) => {
    if (!order('cancelExpand', uid, i)) sound.unqueued()
  }
  /** Right-click on a ship card: drop the last one of that type from the queue. */
  const unqueue = (id: string, at = 0) => {
    const q = at ? (world.current.byId.get(at)?.yq ?? []) : world.current.players[me].queue
    for (let i = q.length - 1; i >= 0; i--)
      if (q[i].unit === id) {
        order('cancel', i, at)
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
    // The tactical map is redrawn ten times a second (an alert's pulse included), and at once
    // whenever what it shows of the view changes (the camera, the filter, its size): ships crawl
    // across it, so a redraw every frame bought nothing but drawing time.
    let miniT = 0
    const miniWas = [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN]
    let miniFilter = mapFilterRef.current
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
          for (const [from, to] of t.give ?? []) toast(`${to === me ? 'You take' : `${seats[to].name} takes`} over ${seats[from].name}'s fleet; an AI admiral runs their base`, to === me ? 'good' : 'info')
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
        while (acc >= STEP && steps < (speed.current > 4 ? 24 : 12)) {
          for (const b of brains.current) (w.fleet ? fleetThink : think)(w, b, STEP)
          aidAllies(w, brains.current)
          tick(w)
          if (import.meta.env.DEV) devRef.current?.afterTick(w, me)
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
      if (edge && mouse.current.inside && !touchLast.current) {
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
      /** The newest of our ships of a type near a spot: the one a 'built' or 'arrived' message is about. */
      const newest = (unit: string, x: number, y: number) => {
        let best: Unit | undefined
        for (const u of w.units) if (u.owner === me && !u.dead && u.t.id === unit && (u.x - x) ** 2 + (u.y - y) ** 2 < 400 ** 2 && (!best || u.id > best.id)) best = u
        return best?.id
      }
      for (const e of events) {
        if (e.k === 'fire') sound.fire(e.kind, where(e.x, e.y), w.players[e.owner].faction, e.light)
        else if (e.k === 'hit') sound.hit(e.shield, e.kind === 'turbo' || e.kind === 'missile', where(e.x, e.y), w.players[e.owner]?.faction)
        else if (e.k === 'boom') sound.boom(e.size, where(e.x, e.y), w.players[e.owner]?.faction)
        else if (e.k === 'shieldsDown') sound.shieldsDown(where(e.x, e.y))
        else if (e.k === 'launch') sound.launch(where(e.x, e.y), w.players[e.owner]?.faction)
        else if (e.k === 'ability' && e.owner !== me) sound.ability(e.id, where(e.x, e.y), w.players[e.owner]?.faction)
        else if (e.k === 'hpdown') {
          sound.hardpointDown(where(e.x, e.y), w.players[e.owner]?.faction)
          if (e.owner === me) toast(e.exp ? `${MODULE[e.exp].name} shot off: ${MODULE[e.exp].lost} Engineers weld it back.` : `${HP_NAME[e.what as HardpointKind]} destroyed on one of our ships`, 'bad', { x: e.x, y: e.y })
        } else if (e.k === 'built' && e.owner === me) {
          const t = UNIT[e.unit]
          if (t.tier === 'mine' || t.tier === 'defense' || t.tier === 'yard') sound.structureDone(t.tier)
          else sound.shipReady(myFaction, t.tier)
          toast(t.tier === 'mine' ? `${t.name} is drilling` : t.tier === 'defense' ? `${t.name} online` : t.tier === 'yard' ? `${t.name} complete: ${worksOf(t) === 'cyard' ? 'cruisers' : 'frigates and corvettes'} are built there now` : `${t.name}${t.squad > 1 ? ' squadron' : ''} ready`, 'good', { x: e.x, y: e.y, unit: newest(e.unit, e.x, e.y) })
        } else if (e.k === 'warp') {
          if (e.owner === me || seesPoint(e.x, e.y)) sound.warp(where(e.x, e.y), e.delay)
        } else if (e.k === 'arrived') {
          if (e.owner === me || seesPoint(e.x, e.y)) sound.arrive(where(e.x, e.y), UNIT[e.unit].size)
          if (e.owner === me && e.field) toast(`${UNIT[e.unit].name} dropped out inside an asteroid field and took heavy damage`, 'bad', { x: e.x, y: e.y, unit: newest(e.unit, e.x, e.y) })
          else if (e.owner !== me && foes(w, e.owner, me) && seesPoint(e.x, e.y)) toast(`Enemy ${UNIT[e.unit].name.toLowerCase()} out of hyperspace`, 'bad', { x: e.x, y: e.y })
        } else if (e.k === 'retreating') {
          if (e.owner === me || seesPoint(e.x, e.y)) sound.warp(where(e.x, e.y), e.secs)
        } else if (e.k === 'retreated') {
          if (e.owner === me || seesPoint(e.x, e.y)) sound.arrive(where(e.x, e.y), UNIT[e.unit].size)
          if (e.owner === me) toast(e.refund > 0 ? `${UNIT[e.unit].name} jumped out: +${Math.round(e.refund)} credits in ${REFUND_DELAY} s` : `${UNIT[e.unit].name} jumped out`, 'good')
          else if (foes(w, e.owner, me) && seesPoint(e.x, e.y)) toast(`An enemy ${UNIT[e.unit].name.toLowerCase()} escaped into hyperspace`, 'info', { x: e.x, y: e.y })
        } else if (e.k === 'upgraded' && e.owner === me) {
          const up = SITE_UPGRADES.find((x) => x.id === e.id)!
          const site = w.byId.get(e.unit)
          sound.researchDone()
          toast(`${up.name}${up.levels > 1 ? ` ${e.level}` : ''} fitted`, 'good', site && { x: site.x, y: site.y, unit: site.id })
        } else if (e.k === 'cancelled' && e.owner === me) {
          toast(`+${Math.round(e.amount)} refunded: ${e.what}`, 'good')
        } else if (e.k === 'refunded' && e.owner === me) {
          toast(`Retreat refund: +${Math.round(e.amount)} credits for the ${UNIT[e.unit].name}`, 'good')
        } else if (e.k === 'repaired' && e.owner === me) {
          const u = w.byId.get(e.unit)
          if (u) toast(`${u.t.name} repaired`, 'good', { x: e.x, y: e.y, unit: u.id })
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
            toast('Beacon captured: +6 fleet capacity', 'good', { x: e.x, y: e.y })
          } else if (e.prev === myTeam) {
            sound.capture(false)
            toast('We lost a beacon', 'bad', { x: e.x, y: e.y })
          }
        } else if (e.k === 'alarm' && e.owner === me) {
          sound.alarm(e.what.endsWith('station'))
          lastAlarm.current = { x: e.x, y: e.y, t: w.time }
          toast(`${e.what} under attack! (Space to look)`, 'bad', { x: e.x, y: e.y })
        } else if (e.k === 'survey') {
          if (e.owner === myTeam && e.prev !== myTeam) {
            sound.surveyed()
            toast('Ore surveyed: click it to build a mining or defense platform', 'good', { x: e.x, y: e.y })
          } else if (e.prev === myTeam) toast(e.razed ? 'Platform destroyed: the ore has to be surveyed again' : e.owner === -1 ? 'An unused ore claim has lapsed' : 'We lost the claim on an ore asteroid', 'bad', { x: e.x, y: e.y })
        } else if (e.k === 'salvaged' && e.owner === me) {
          sound.salvaged()
          toast(`Wreck salvaged: +${Math.round(e.value)} credits in all`, 'good', { x: e.x, y: e.y })
        } else if (e.k === 'rankUp' && e.owner === me) {
          const u = w.byId.get(e.unit)
          sound.promoted()
          if (u && u.t.tier !== 'fighter') toast(`${u.t.name} promoted: ${RANKS[e.rank]}`, 'good', { x: e.x, y: e.y, unit: u.id })
        } else if (e.k === 'finished' && e.owner === me) {
          const u = w.byId.get(e.unit)
          sound.structureDone('yard')
          if (u) toast(`${u.t.name} finished: every turret installed`, 'good', { x: e.x, y: e.y, unit: u.id })
        } else if (e.k === 'expanded' && e.owner === me) {
          sound.structureDone('yard')
          toast(`${MODULE[e.id].name} finished on the ${WORKS_NAME[MODULE[e.id].on]}`, 'good', { x: e.x, y: e.y, unit: e.unit })
        } else if (e.k === 'gift' && (e.to === me || e.from === me)) {
          if (e.to === me) {
            sound.payday()
            toast(`${seats[e.from].name} sent you ${fmt(e.amount)} credits`, 'good')
          } else toast(`You sent ${seats[e.to].name} ${fmt(e.amount)} credits`, 'good')
        } else if (e.k === 'tech' && e.owner === me) {
          sound.researchDone()
          toast(`Research complete: ${TECH[e.id].name}`, 'good')
        } else if (e.k === 'level' && e.owner === me) {
          sound.levelUp()
          const unlocked = buildable(myFaction).filter((t) => t.level === e.level).map((t) => t.name)
          // With hybrid bases a level unlocks a yard (level 2 the Frigate Yard, 3 the Capital Yard)
          // and expansions (level 4 the Capital slip, the way to the flagships).
          const yard = w.hybrid ? yardsFor(myFaction).find((t) => t.level === e.level) : undefined
          const exps = w.hybrid ? MODULES.filter((m) => m.level === e.level).map((m) => m.name) : []
          const news = w.hybrid ? [...(yard ? [`the ${yard.name} (build it with engineers)`] : []), ...(exps.length ? [`expansions: ${exps.join(', ')}`] : [])] : unlocked
          toast(`Station level ${e.level}${news.length ? `: ${news.join('; ')} unlocked` : ''}`, 'good')
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
        reveal: import.meta.env.DEV ? devRef.current?.cheats.reveal : undefined,
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
        // A finger has no hover: the selection shows its ranges instead.
        ranges: settingsRef.current.ranges ? (touchLast.current ? 'selected' : 'hover') : 'off',
        place: placeGhost(),
        escortHint: mode.current === 'guard' ? escortHint(h.unit) : undefined,
        repairHint: mode.current === 'normal' && !touchLast.current ? repairHint(h.unit) : undefined,
        buildRing: w.hybrid && mySelection().some((u) => u.t.tier === 'station' || isEngineer(u.t)) ? (() => {
          const st = w.byId.get(w.players[me].station)
          return st ? { x: st.x, y: st.y, r: BUILD_RADIUS } : null
        })() : null,
      }
      renderer.current.draw(ctx, w, cm, vw, vh, v, dt * (paused.current ? 0 : speed.current))
      // The repair cursor, over what a right-click would repair (React's className leaves it be
      // until the mode changes, so it is checked on the element itself).
      const fixing = v.repairHint !== undefined
      if (canvas.current && canvas.current.classList.contains('is-repair') !== fixing) canvas.current.classList.toggle('is-repair', fixing)
      sound.ambience(paused.current ? 0 : dt)
      miniT -= dt
      const hideMine = deploying.current && !placed.current ? me : -1
      const miniNow = [cm.x, cm.y, cm.zoom, vw, vh, m.clientWidth, m.clientHeight, hideMine]
      if (miniT <= 0 || miniNow.some((v, i) => v !== miniWas[i]) || mapFilterRef.current !== miniFilter) {
        miniT = 0.1
        miniNow.forEach((v, i) => (miniWas[i] = v))
        miniFilter = mapFilterRef.current
        renderer.current.minimap(mctx, w, me, cm, vw, vh, m.clientWidth, m.clientHeight, lastAlarm.current, mapFilterRef.current, hideMine)
      }

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
      // Control groups: the key selects; with the set or add modifier (Ctrl and Shift unless
      // rebound) it sets or adds. Ctrl+number is also the browser's tab switch: taking the key
      // press here keeps the browser from switching (and in fullscreen the keys are locked, below).
      const gk = groupKeyOf(keymap, e)
      if (gk) {
        const mod = modOf(e)
        const how = mod === settingsRef.current.groupSet ? 'set' : mod === settingsRef.current.groupAdd ? 'add' : mod === '' ? 'select' : null
        if (how) {
          e.preventDefault()
          if (e.repeat) return
          if (how === 'select') recallGroup(gk)
          else editGroup(gk, how)
          return
        }
      }
      const action = !e.ctrlKey && !e.metaKey && !e.altKey ? actionFor(keymap, k) : undefined
      // Panning keys are held, not pressed.
      if (k.startsWith('arrow') || action === 'panUp' || action === 'panDown' || action === 'panLeft' || action === 'panRight') {
        keys.current.add(k)
        e.preventDefault()
        return
      }
      if (e.ctrlKey && k === 'a') {
        selectArmy()
        e.preventDefault()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // A yard being placed: [ and ] turn it (Shift: fine steps). Q and E are Stop and Attack move.
      if (mode.current === 'place' && placing.current && (k === '[' || k === ']' || k === '{' || k === '}')) {
        rotatePlace((k === '[' || k === '{' ? -1 : 1) * (e.shiftKey ? 5 : 15))
        e.preventDefault()
        return
      }
      if (k === 'escape') {
        // Esc backs out of whatever is open, one step at a time, and finally opens the menu.
        if (uiRef.current.menu || uiRef.current.panel) closeMenu()
        else if (uiRef.current.gift) setUi((u) => ({ ...u, gift: false }))
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
      else if (action === 'yard') selectYard()
      else if (action === 'cyard') selectCapitalYard()
      else if (action === 'build') {
        // The yard's ghost follows the pointer; over our ruin of it, it snaps on and costs half.
        if (mySelection().some((u) => isEngineer(u.t) || u.t.tier === 'station')) startPlace(nextYard())
        else {
          toast('Select engineers (or the Command Station) to build a yard', 'bad')
          sound.error()
        }
      }
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

  // In the browser's fullscreen (the game's own page), lock the number keys to the page where the
  // browser offers it (Keyboard Lock, Chromium): Ctrl+number then reaches the game even in a browser
  // that would otherwise switch tabs with it. Esc isn't locked, so it still leaves fullscreen.
  useEffect(() => {
    const kb = (navigator as Navigator & { keyboard?: { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void } }).keyboard
    if (!kb?.lock || !kb.unlock) return
    const codes = [...'1234567890'].map((d) => `Digit${d}`)
    const sync = () => (document.fullscreenElement ? kb.lock!(codes).catch(() => {}) : kb.unlock!())
    sync()
    document.addEventListener('fullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      kb.unlock!()
    }
  }, [])

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

  // A tap anywhere but the open selection panel only closes it: the pointer press is stopped before
  // the battlefield (or another button) sees it, and so is the click that follows.
  useTapAway(root, compact && selOpen, () => setSelOpen(false), SELPOP_KEEP, [ready])

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
        line.current = null
        press.current.cancel()
        return
      }
      const fresh = touches.current.size === 1 && !deploying.current
      // A line or facing drag armed from the wheel: this drag draws it, as a right-drag would.
      if (fresh && drawMode.current) {
        const face = drawMode.current === 'face' || lineGroups(world.current, me, mySelection().map((u) => u.id)).length === 1
        drag.current = { x0: p.x, y0: p.y, box: false, pan: false, moved: false, cx: 0, cy: 0, button: 2, face }
        line.current = [toWorld(p.x, p.y)]
        return
      }
      // Box mode (the touch bar): this drag selects instead of moving the view.
      if (fresh && getTouchMods().box) {
        drag.current = { x0: p.x, y0: p.y, box: true, pan: false, moved: false, cx: 0, cy: 0, button: 0 }
        return
      }
      drag.current = { x0: p.x, y0: p.y, box: false, pan: true, moved: false, cx: cam.current.x, cy: cam.current.y, button: 0 }
      // Held still: the action wheel, and the finger stops panning.
      const { clientX, clientY } = e
      if (fresh)
        press.current.start(e, () => {
          drag.current = null
          fieldWheel(p.x, p.y, clientX, clientY)
        })
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
    // A yard being placed: press at the spot and drag towards where its mouth should point; it goes
    // down on release (a click without a drag keeps the angle the wheel or keys gave it).
    if (mode.current === 'place' && placing.current && e.button === 0) {
      placeDrag.current = { at: pick(p.x, p.y).at, sx: p.x, sy: p.y, turned: false }
      placing.current.at = placeDrag.current.at
      return
    }
    if (mode.current !== 'normal') {
      modeClick(p.x, p.y, mode.current, e.shiftKey)
      // Shift keeps the command armed for more clicks, each queued after the last. A yard being
      // placed stays armed until it goes down.
      if (!e.shiftKey && mode.current !== 'place') setMode('normal')
      return
    }
    drag.current = { x0: p.x, y0: p.y, box: true, pan: false, moved: false, cx: 0, cy: 0, button: 0 }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e)
    mouse.current = { ...p, inside: true }
    touchLast.current = isTouch(e)
    const pd = placeDrag.current
    if (pd && placing.current && (pd.turned || Math.hypot(p.x - pd.sx, p.y - pd.sy) > 12)) {
      const to = toWorld(p.x, p.y)
      pd.turned = true
      placing.current.a = Math.atan2(to.y - pd.at.y, to.x - pd.at.x)
    }
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) {
      touches.current.set(e.pointerId, p)
      press.current.move(e)
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
      press.current.cancel()
      // A long press: the wheel has it.
      if (press.current.fired) {
        press.current.fired = false
        return
      }
      if (!d) return
      // The touch bar's sticky Shift: queue orders, add to the selection.
      const add = shiftOf()
      if (d.button === 2) {
        finishDrag(d, add)
        if (!add) setDraw(null)
        return
      }
      if (d.box) {
        setTouchMod('box', false)
        if (d.moved) return boxSelect(d, p, add)
      }
      if (d.moved) return
      if (deploying.current) return placeStart(p.x, p.y)
      // A tap.
      const { unit, node, hp: part } = pick(p.x, p.y)
      if (mode.current !== 'normal') {
        modeClick(p.x, p.y, mode.current, add)
        if (!add && mode.current !== 'place') setMode('normal')
      } else if (unit && unit.owner === me) {
        // A double tap takes every one of its type on screen, as a double-click does.
        const now = performance.now()
        const dbl = lastClick.current.id === unit.id && now - lastClick.current.t < 350
        lastClick.current = { t: now, id: unit.id }
        // Tapping the one thing that is selected (a ship, or its squadron) puts it away again.
        const only = withSquads([unit.id])
        if (!dbl && !add && selected.current.size === only.length && only.every((i) => selected.current.has(i))) {
          selected.current.clear()
          pickedNode.current = -1
          sound.click()
        } else if (dbl) selectType(unit, add)
        else if (add && selected.current.has(unit.id)) for (const id of withSquads([unit.id])) selected.current.delete(id)
        else select([unit.id], add)
        turretPick.current = !isShip(unit.t) && part >= 0 && unit.t.hardpoints[part]?.weapon && !add ? { unit: unit.id, hp: part } : null
        pickedSound(unit)
      } else if (mySelection().length && (!unit || foes(world.current, unit.owner, me))) command(p.x, p.y, false, add)
      else if (unit) select([unit.id])
      else if (!add) {
        selected.current.clear()
        pickedNode.current = node
      }
      return
    }
    if (placeDrag.current) {
      const pd = placeDrag.current
      placeDrag.current = null
      if (placing.current) {
        placing.current.at = null
        place(pd.at, e.shiftKey)
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
      finishDrag(d, e.shiftKey)
      return
    }
    if (!d || !d.box) return
    if (d.moved) {
      boxSelect(d, p, e.shiftKey)
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
    if (dbl) selectType(unit, e.shiftKey)
    else if (e.shiftKey && selected.current.has(unit.id)) {
      for (const id of withSquads([unit.id])) selected.current.delete(id)
    } else select([unit.id], e.shiftKey)
    // Clicking one of a structure's guns picks that gun: a right-click then aims just it.
    const { hp: part } = pick(p.x, p.y)
    turretPick.current = !isShip(unit.t) && part >= 0 && unit.t.hardpoints[part]?.weapon && !e.shiftKey ? { unit: unit.id, hp: part } : null
    // The crew of what we just picked answers (structures just click).
    if (isShip(unit.t) || unit.t.tier === 'station') sound.select(myFaction, unit.t.tier)
    else sound.click()
  }

  /** A right-drag (or a line drawn by finger) let go: an area attack, a facing, a line, or, without
   * a drag, the usual order on the spot. `queued` is Shift. */
  const finishDrag = (d: NonNullable<typeof drag.current>, queued: boolean) => {
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
      if (d.face) order('face', ids, a.x, a.y, face, d.attack, queued)
      else order('line', ids, thinPath(ln), d.attack, queued)
      for (const q of targets) renderer.current.ping(q.x, q.y, d.attack ? '#ffaa5a' : '#7dffa0')
      say(d.attack ? 'attackMove' : 'move')
    } else command(d.x0, d.y0, false, queued)
  }
  /** A selection box let go: our warships in it, or our structures if there are none. */
  const boxSelect = (d: NonNullable<typeof drag.current>, p: Pt, add: boolean) => {
    const w = world.current
    const a = toWorld(Math.min(d.x0, p.x), Math.min(d.y0, p.y))
    const b = toWorld(Math.max(d.x0, p.x), Math.max(d.y0, p.y))
    const inBox = (u: Unit) => u.owner === me && u.x >= a.x && u.x <= b.x && u.y >= a.y && u.y <= b.y
    let ids = w.units.filter((u) => inBox(u) && isShip(u.t)).map((u) => u.id)
    if (!ids.length) ids = w.units.filter(inBox).map((u) => u.id)
    select(ids, add)
    if (mySelection().length) sound.select(myFaction, voice())
  }

  const onWheel = (e: React.WheelEvent) => {
    dropIntel()
    const p = local(e)
    // Lines or pages (some mice) rather than pixels: scale to about one notch's worth.
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
    // A yard being placed: the wheel turns it (15 degrees a notch, 5 with Shift) instead of zooming.
    if (mode.current === 'place' && placing.current) {
      wheelAcc.current += dy || e.deltaX
      const n = Math.trunc(wheelAcc.current / 90)
      if (n) {
        wheelAcc.current -= n * 90
        rotatePlace(n * (e.shiftKey ? 5 : 15))
      }
      return
    }
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
    // Touch: held still, the wheel gives the selection its orders there; after it, the finger
    // sliding over the wheel leaves the view alone.
    if (isTouch(e)) {
      if (e.type === 'pointerdown') {
        const { clientX, clientY } = e
        miniPress.current.start(e, () => miniWheel(x, y, clientX, clientY))
      } else if (!miniPress.current.move(e) && miniPress.current.fired) return
    }
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
    const room = docked ? Math.round(b.w) : 0
    // Whole pixels, and only a real change: a sub-pixel wobble is no reason to lay the dock out again.
    setMapRoom((was) => (Math.abs(was - room) <= 1 ? was : room))
  }, [])
  /** Phones stack the unit card above the selection: it needs the selection's height. */
  const selMoved = useCallback((b: { h: number }) => {
    const el = root.current
    const h = `${Math.round(b.h)}px`
    if (el && el.style.getPropertyValue('--ew-selh') !== h) el.style.setProperty('--ew-selh', h)
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
      // A finger's events all go to the tile it started on: what's under it has to be looked up.
      const touch = ev.pointerType === 'touch'
      const over = touch ? document.elementFromPoint(ev.clientX, ev.clientY) : (ev.target as Element | null)
      touchLast.current = touch
      mouse.current = { x, y, inside: x >= 0 && y >= 0 && x <= r.width && y <= r.height && !over?.closest?.('.ew-frame, .ew-top') }
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
  // Settings → Apps → Games asked for the game's settings or key bindings.
  useAskedPanel((panel) => openMenu(panel))
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
    if (!order('cancelResearch', i)) sound.unqueued()
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
  /** The server lost the battle: carry it on here, an AI admiral taking every other player's fleet. */
  const goOffline = () => {
    if (!online || !onOffline) return
    const all = [...brains.current]
    online.info.seats.forEach((_, i) => {
      if (i !== me && !all.some((b) => b.o === i)) all.push(newBrain(i, OFFLINE_AI))
    })
    left.current = true
    sound.click()
    onOffline({
      world: snapshotWorld(world.current),
      brains: all.map(snapBrain),
      cam: { ...cam.current },
      sel: [...selected.current],
      groups: [...groups.current.entries()],
      speed: 1,
    })
  }
  // Every ten seconds, and the moment the page goes away. The snapshot of a big battle takes a
  // frame's worth of time or more, so the regular one waits for a moment the page is idle (between
  // frames, or at the latest two seconds on).
  useEffect(() => {
    let idle = 0
    const later = () => {
      if (idle) return
      const run = () => {
        idle = 0
        keepRef.current()
      }
      idle = typeof requestIdleCallback === 'function' ? requestIdleCallback(run, { timeout: 2000 }) : window.setTimeout(run, 0)
    }
    const id = window.setInterval(later, 10000)
    const hide = () => keepRef.current()
    const hidden = () => document.visibilityState === 'hidden' && keepRef.current()
    window.addEventListener('pagehide', hide)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      clearInterval(id)
      if (idle) (typeof cancelIdleCallback === 'function' ? cancelIdleCallback : clearTimeout)(idle)
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
      if (r.status === 'away') toast(`${who} stepped away. The battle waits for them to rejoin…`, 'info')
      else if (r.status === 'playing' && was[i] === 'away') toast(`${who} is back`, 'good')
      else if (r.status === 'left') toast(`${who} gave up: an AI admiral takes over their fleet`, seats[i].team === myTeam ? 'bad' : 'good')
      // A teammate taking over says so when the fleet changes hands (on the turn it does).
      else if (r.status === 'dropped' && r.to === undefined) toast(`${who} didn't come back: an AI admiral takes over their fleet`, 'info')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net?.roster])
  // Online: an order the server turned down (credits that can't go, say) says why.
  const problemSeen = useRef(net?.problem?.n ?? 0)
  useEffect(() => {
    const p = net?.problem
    if (!p || p.n === problemSeen.current) return
    problemSeen.current = p.n
    toast(p.why, 'bad')
    sound.error()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net?.problem])

  const w = world.current
  // Team battles: the allies credits can go to (teammates still in it; none in a fleet battle).
  const allies: Ally[] = w.fleet ? [] : w.players.flatMap((p, i) => (i !== me && p.team === myTeam && p.alive ? [{ seat: i, name: seats[i].name, faction: p.faction, credits: p.credits, ai: seats[i].kind !== 'you' && (!online || online.info.seats[i].kind === 'ai' || brains.current.some((b) => b.o === i)) }] : []))
  /** Send credits to an ally: at once offline; online through the server, which answers with the
   * turn (or says why not). */
  const sendCredits = (seat: Owner, amount: number) => {
    sound.unlock()
    const why = order('give', seat, Math.floor(amount))
    if (why) sound.error()
    else sound.click()
    return why
  }
  const fac = FACTIONS[myFaction]
  if (!ready)
    return (
      <div className="ew-root ew-deck ew-loading" onContextMenu={noMenu}>
        <p>Charting the system…</p>
      </div>
    )

  const sel = hud.sel.map((i) => w.byId.get(i)).filter((u): u is Unit => !!u)
  // The hints say "tap" to a finger.
  const click = touchUi ? 'tap' : 'click'
  const Click = touchUi ? 'Tap' : 'Click'
  return (
    <div className={`ew-root ew-deck ew-battle ew-${myFaction}${mapOpen ? ' is-mapopen' : ''}`} ref={root} style={{ ['--ew-accent' as string]: fac.color }} onContextMenu={noMenu}
      onPointerDownCapture={(e) => {
        touchLast.current = isTouch(e)
        setTouchUi(isTouch(e))
      }}>
      <WheelHost>
        <WheelBridge to={wheel} />
        <Tips live={(id) => world.current.byId.get(id)} />
        {intel && <FieldIntel w={w} me={me} id={intel.id} x={intel.x} y={intel.y} />}
        <canvas
          ref={canvas}
          className={`ew-canvas ${ui.mode !== 'normal' ? `is-targeting is-mode-${ui.mode}` : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => ((drag.current = null), (line.current = null), touches.current.clear(), (pinch.current = null), press.current.cancel())}
          onPointerLeave={(e) => {
            mouse.current.inside = false
            hover.current = { unit: 0, hp: -1, node: -1, wreck: 0 }
            // A finger "leaves" as it lifts: a unit card opened from the wheel stays up.
            if (!isTouch(e)) dropIntel()
          }}
          onWheel={onWheel}
        />

        {import.meta.env.DEV && dev && !online && (
          <dev.DevCheats
            ctx={{
              world: () => world.current,
              me,
              names: seats.map((x) => x.name),
              selected: () => selected.current,
              canvas: () => canvas.current,
              toWorld,
              camera: () => ({ x: cam.current.x, y: cam.current.y }),
              setSpeed,
              speed: () => speed.current,
              focused: () => focusedRef.current,
              toast,
            }}
          />
        )}
        <TopBar hud={hud} faction={myFaction} sector={sector} ui={ui} onShipyard={selectStation} onYard={selectOne} onPause={online ? undefined : togglePause} onSpeed={online ? undefined : setSpeed}
          onGift={allies.length ? () => setUi((u) => ({ ...u, gift: !u.gift })) : undefined} giftOpen={ui.gift}
          onMenu={() => (ui.menu ? closeMenu() : openMenu())}
          onTechTree={() => setTree(!ui.tree)}
          onReserves={() => setUi((u) => ({ ...u, reserves: !u.reserves }))}
          onEconomy={() => setUi((u) => ({ ...u, economy: !u.economy }))}
          onPlayers={() => setUi((u) => ({ ...u, players: !u.players }))}
          onMap={() => setMapOpen((o) => !o)}
          mapOpen={mapOpen}
          ping={online ? (net?.status === 'online' ? Math.round(net.rtt) : -1) : undefined}
        />
        {ui.players && <Scoreboard w={w} me={me} names={seats.map((s) => s.name)} roster={online ? net?.roster : undefined} onClose={() => setUi((u) => ({ ...u, players: false }))} />}
        {online && net?.status !== 'online' && hud.winner === -1 && !net?.lost && (
          <div className="ew-pausebox">
            {net?.restarting ? (
              <Frame title="Server restarting">
                <p>The server is restarting for an update. It keeps this battle, which waits for everyone and carries on from this moment once the server is back, usually within a minute.</p>
              </Frame>
            ) : (
              <Frame title="Connection lost">
                <p>Reconnecting to the server. The battle waits for you meanwhile (for up to {REJOIN_WAIT}), and you'll be put back in it as soon as the connection is back.</p>
              </Frame>
            )}
          </div>
        )}
        {online && net?.status === 'online' && net.away.length > 0 && !net.lost && hud.winner === -1 && (
          <AwayPanel v={net} net={online.net} me={me} names={seats.map((s) => s.name)} sound={sound} />
        )}
        {online && net?.lost && hud.winner === -1 && (
          // Not a Modal: there's no closing it, only one of the two ways on.
          <div className="ew-modal-back">
            <div className="ew-modal ew-lost">
              <Frame title="Battle lost by the server">
                <p>{net.lost.why} You can keep playing it here against the computer, from where it is now: AI admirals take over every other player's fleet.</p>
                <button className="ew-go" onClick={goOffline}>
                  Keep playing against the computer
                </button>
                <button
                  className="ew-menu-btn"
                  onClick={() => {
                    sound.click()
                    left.current = true
                    onMenu?.()
                  }}
                >
                  <Icon name="back" size={18} /> Leave
                </button>
              </Frame>
            </div>
          </div>
        )}
        {ui.economy && hud.winner === -1 && <EconomyPanel w={w} me={me} names={seats.map((s) => s.name)} onClose={() => setUi((u) => ({ ...u, economy: false }))} />}
        {ui.gift && allies.length > 0 && hud.winner === -1 && <GiftPanel credits={hud.credits} allies={allies} onSend={sendCredits} onClose={() => setUi((u) => ({ ...u, gift: false }))} />}
        {ui.reserves && hud.winner === -1 && <ReserveTray reserve={hud.reserve} onGrab={grabReserve} onClose={() => setUi((u) => ({ ...u, reserves: false }))} launch={!!world.current.reinforce} />}

        <ToastStack store={toasts} low={ui.paused && !ui.menu && !ui.panel} look={lookRef} />
        {ui.mode !== 'normal' && (
          <KeptInside className="ew-modehint">
            {ui.mode === 'attack' && !mySelection().some((u) => isShip(u.t))
              ? turretPick.current ? `Attack: ${click} an enemy for the picked gun to aim at.` : `Attack: ${click} an enemy for every gun to aim at. ${Click} one gun first to aim just that one.`
              : ui.mode === 'attack' ? touchUi ? 'Attack move: tap where to go. Ships fight whatever they meet; tap one of ours to open fire on it.' : 'Attack move: click where to go. Ships fight whatever they meet. Drag a circle (either button) to attack everything in it; click one of ours to open fire on it.'
              : ui.mode === 'move' ? `Move: ${click} where to go. Ships ignore enemies on the way.`
                : ui.mode === 'patrol' ? `Patrol: ${click} the far end. Ships fly back and forth, fighting what they meet.`
                : ui.mode === 'guard' ? `Guard: ${click} one of our ships or structures. The selection stays with it and fights off what comes near. On a ship two classes bigger it escorts it: flies over its hull and moves with it.`
                  : ui.mode === 'place' ? `${UNIT[placing.current?.unit ?? yardOf(myFaction).id].name}: ${click} a spot inside the build ring round the Command Station.${touchUi ? ' Then build it here.' : ''}`
                  : `Rally point: ${click} where new ships should gather${rallyAt() ? ' from this yard' : ''}.`}{' '}
            {ui.mode === 'place'
              ? touchUi ? 'Turn it with the buttons. Shift on: after the engineers\' other orders. ✕ to cancel.' : <>Wheel or <kbd>[</kbd> <kbd>]</kbd> turn it (Shift: finer), or drag to aim its mouth. Shift-click: after the engineers' other orders. <kbd>Esc</kbd> or right-click to cancel.</>
              : touchUi ? 'Turn on Shift to keep going, ✕ to cancel.' : <>Shift-click to keep going, <kbd>Esc</kbd> to cancel.</>}
            {ui.mode === 'place' && touchUi && placing.current?.at && (
              <div className="ew-placebar">
                <button className="ew-menu-btn ew-rot" onClick={() => rotatePlace(-15)} aria-label="Turn it anticlockwise" data-tip="Turn 15 degrees anticlockwise">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
                </button>
                <button className="ew-menu-btn ew-rot" onClick={() => rotatePlace(15)} aria-label="Turn it clockwise" data-tip="Turn 15 degrees clockwise">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: 'scaleX(-1)' }}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
                </button>
                <button className="ew-go" onClick={confirmPlace} disabled={!placeGhost()?.ok}>
                  Build here
                </button>
                <button className="ew-menu-btn" onClick={() => setMode('normal')}>
                  Cancel
                </button>
              </div>
            )}
          </KeptInside>
        )}
        {ui.draw && (
          <KeptInside className="ew-modehint">
            {ui.draw === 'face' || lineGroups(w, me, mySelection().map((u) => u.id)).length === 1
              ? 'Face: drag from where to go towards the way to face.'
              : 'Line: drag a line. The ships spread along it; draw a loop to ring a spot.'}{' '}
            ✕ to cancel.
          </KeptInside>
        )}

        {/* The tactical map floats: it can be dragged anywhere. While it sits in its corner the dock
            leaves room for it, so the unit card stays beside it. */}
        <TacticalMap canvas={mini} sides={sides} filter={mapFilter} onFilter={setMapFilter} onPointer={onMini} onPointerEnd={() => miniPress.current.cancel()}
          onStation={selectStation} onIdle={selectIdle} onArmy={selectArmy} idle={hud.idle}
          fogGrid={settings.fogGrid} onFogGrid={() => setSettings({ fogGrid: !settings.fogGrid })}
          onAlert={() => (lastAlarm.current ? centerOn(lastAlarm.current.x, lastAlarm.current.y) : toast('No alerts yet', 'info'))}
          onMove={mapMoved}
        />
        {/* The bottom of the screen: a shade for the panels to sit on; the unit card (beside the map
            while it sits in its corner) and the selection float like the map, and can be moved. */}
        <div className="ew-dockshade" />
        <Floating id="detail" bare at={{ left: mapRoom ? mapRoom + 12 : 6, bottom: 6 }} vars={{ '--ew-dleft': `${mapRoom ? mapRoom + 12 : 6}px` }} className="ew-detailfloat">
            <DetailPanel w={w} me={me} sel={sel} hud={hud} faction={myFaction}
              onOnly={(id, drop) => {
                const keep = sel.filter((u) => (drop ? u.t.id !== id : u.t.id === id)).map((u) => u.id)
                selected.current = new Set(keep)
              }}
              onBuild={build}
              onUnqueue={unqueue}
              onCancel={(i, at) => order('cancel', i, at ?? 0)}
              onPlace={startPlace}
              onSelect={selectOne}
              onCancelSite={(id) => {
                const why = order('cancelSite', id)
                if (why) {
                  toast(why, 'bad')
                  sound.error()
                } else sound.unqueued()
              }}
              onExpand={expand}
              onCancelExpand={cancelExpand}
              onRush={(id) => {
                sound.unlock()
                const why = order('rush', id)
                if (why) {
                  toast(why, 'bad')
                  sound.error()
                } else {
                  toast('Rush launch: the ship jumps out unfinished. A Drydock, repair craft or engineers finish it.', 'info')
                  sound.queued()
                }
              }}
              onResearch={research}
              onCancelResearch={cancelResearch}
              onTechTree={() => setTree(true)}
              onSite={buildSite}
              onCancelUpgradeSite={(id) => {
                const why = order('cancelUpgradeSite', id)
                if (why) {
                  toast(why, 'bad')
                  sound.error()
                } else sound.unqueued()
              }}
              onEngineers={selectEngineers}
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
        <Floating id="selection" bare at={{ right: 6, bottom: 6 }} className="ew-selfloat" onMove={selMoved}>
            {/* Fingers only: the sticky Shift, box select, and a way to back out (no Esc on a phone). */}
            <TouchBar className="ew-battlebar"
              extra={<>
                {compact && hud.sel.length > 0 && !selOpen && (
                  <SelChip icon="fleet" count={hud.sel.length} title="Selected units" onOpen={() => setSelOpen(true)} onClear={() => (selected.current.clear(), (pickedNode.current = -1), sound.click())} />
                )}
                {(ui.mode !== 'normal' || ui.draw || (!compact && (hud.sel.length > 0 || pickedNode.current >= 0))) && (
                <button onClick={cancelTouch} title={ui.mode !== 'normal' || ui.draw ? 'Cancel the order' : 'Clear the selection'}>
                  ✕<span>{ui.mode !== 'normal' || ui.draw ? 'Cancel' : 'Clear'}</span>
                </button>
                )}
              </>}
            />
            <GroupBar groups={hud.groups} onGroup={recallGroup} onEdit={editGroup} canAssign={sel.some((u) => u.owner === me)} />
            {(() => {
              const panel = (
                <SelectionPanel w={world.current} sel={sel} me={me} mode={ui.mode} onCommand={runCommand}
                  onPick={(id, shift) => {
                    const ids = withSquads([id])
                    if (shift) for (const i of ids) selected.current.delete(i)
                    else selected.current = new Set(ids)
                    sound.click()
                  }}
                />
              )
              if (!compact) return panel
              if (!selOpen || !hud.sel.length) return null
              return (
                <div className="ew-selpop" data-nodrag>
                  <div className="ew-selpop-head">
                    <span className="ew-selpop-gap" />
                    <button onClick={() => (selected.current.clear(), (pickedNode.current = -1), setSelOpen(false), sound.click())} aria-label="Deselect everything">
                      ✕ Deselect
                    </button>
                    <button onClick={() => setSelOpen(false)} aria-label="Close">
                      Close
                    </button>
                  </div>
                  {panel}
                </div>
              )
            })()}
        </Floating>

        {ui.deploy && !ui.menu && !ui.panel && (
          <div className="ew-pausebox ew-deploybox">
            <Frame title="Choose your start">
              <p>
                {ui.placed
                  ? `${Click} again to move your station, or start when you are ready.`
                  : `${Click} inside your start area (the bright box) to place your station. Everyone else picks inside theirs.`}
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
        {ui.tree && hud.winner === -1 && <TechTree w={w} me={me} hud={hud} onResearch={research} onCancel={cancelResearch} onClose={() => setTree(false)} onExpand={expand} onCancelExpand={cancelExpand} />}
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
      </WheelHost>
    </div>
  )
}

/** Players who stepped away from an online battle, which waits for them: how long they have left
 * to rejoin (the server's deadline, on our clock), and the vote on carrying on without them. The
 * battle goes on as soon as everyone still here picks the same; when time runs out, the AI takes
 * over. */
function AwayPanel({ v, net, me, names, sound }: { v: NetView; net: Net; me: number; names: string[]; sound: EmpiresSound }) {
  const [, redraw] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => redraw((n) => n + 1), 250)
    return () => clearInterval(id)
  }, [])
  const roster = v.roster ?? []
  const here = roster.flatMap((r, i) => (r.status === 'playing' ? [i] : []))
  const teams = v.match?.info.seats.map((s) => s.team) ?? []
  const label = (x: AwayVote, away: number) => (x === 'wait' ? 'wait' : x === 'ai' ? 'AI takes over' : `${x === me ? 'you take' : `${names[x]} takes`} over ${names[away]}'s fleet`)
  return (
    <div className="ew-pausebox ew-away">
      {v.away.map((a) => {
        const left = a.deadline ? Math.max(0, Math.ceil((a.deadline - (Date.now() + net.clockOffset)) / 1000)) : null
        const mine = a.votes.find(([s]) => s === me)?.[1] ?? 'wait'
        const mates = here.filter((i) => teams[i] === teams[a.seat] && i !== a.seat)
        const pick = (x: AwayVote) => {
          sound.click()
          net.vote(a.seat, x)
        }
        return (
          <Frame key={a.seat} title={`${names[a.seat]} left`}>
            <p>
              {left === null ? 'Waiting for them to come back after the server restart.' : (
                <>
                  Waiting for them to rejoin: <b className="ew-away-clock">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</b>
                </>
              )}
            </p>
            <div className="ew-away-votes">
              <button className={mine === 'ai' ? 'ew-go is-on' : 'ew-go'} onClick={() => pick('ai')} aria-pressed={mine === 'ai'}>
                Continue: AI takes over {names[a.seat]}
              </button>
              {mates.map((t) => (
                <button key={t} className={mine === t ? 'ew-go is-on' : 'ew-go'} onClick={() => pick(t)} aria-pressed={mine === t}>
                  Continue: {t === me ? 'you take' : `${names[t]} takes`} over {names[a.seat]}'s fleet
                </button>
              ))}
              <button className={mine === 'wait' ? 'ew-menu-btn is-on' : 'ew-menu-btn'} onClick={() => pick('wait')} aria-pressed={mine === 'wait'}>
                Wait
              </button>
            </div>
            <ul className="ew-away-tally">
              {here.map((i) => {
                const x = a.votes.find(([s]) => s === i)?.[1] ?? 'wait'
                return (
                  <li key={i}>
                    <b>{i === me ? 'You' : names[i]}</b>: {label(x, a.seat)}
                  </li>
                )
              })}
            </ul>
            <small className="ew-muted">The battle carries on as soon as everyone here picks the same. When the time runs out, the AI takes over.</small>
          </Frame>
        )
      })}
    </div>
  )
}

/** Hands the battle the action wheel's opener (the battle renders the WheelHost it lives in). */
function WheelBridge({ to }: { to: React.MutableRefObject<(r: WheelRequest | null) => void> }) {
  const open = useWheel()
  useEffect(() => {
    to.current = open
  }, [open, to])
  return null
}
