import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { jsonPref } from '../../../../os/localPref'
import { useIsMobile } from '../../../../os/useIsMobile'
import { FACTIONS, FACTION_IDS, type FactionId } from '../data.ts'
import { DoublePress, GROUP_KEYS, addToGroup, setGroup, type Groups } from '../groups.ts'
import { Bar, Frame, Icon, KeptInside, Tips, clock, fmt } from '../Hud.tsx'
import { Seg } from '../Menus.tsx'
import { thumbnail } from '../models/paint.ts'
import { getSettings, groupKeyOf, modOf } from '../settings.ts'
import type { EmpiresSound } from '../sound.ts'
import { LongPress, TAP_SLOP, TouchBar, WheelHost, getTouchMods, isTouch, shiftOf, useWheel, type WheelItem, type WheelRequest } from '../Touch.tsx'
import { SLICE_IDS, buildable, cantTrain, placement, queueOf, siteProgress, trainable, type Placement } from './build.ts'
import { cleanGroundCmd, groundCmd, runGroundCmd, type GroundCmd } from './commands.ts'
import { FogShade, MiniMap, OWN, drawBox, drawGhost, drawPings, drawRally, drawRings, drawStarts, drawUnits, modelOf, seenNow, updateMemory, type Look, type Ping, type Seen } from './draw.ts'
import { GROUND_MAPS } from './maps.ts'
import { GroundRenderer, type GroundView } from './render.ts'
import { FOG_HZ, GROUND_UNIT, STEP, addStructure, newGroundWorld, spawnUnit, tick, typeOf, type GroundUnit, type GroundWorld, type Owner } from './sim.ts'
import { buildGroundMap } from './terrain.ts'
import { TILE, type GroundMap } from './types.ts'
import './battle.css'

// The ground battle screen (dev builds only, until ground units can fight): a short setup, then a
// skirmish against the AI on a ground map. Menus.tsx loads this file behind `import.meta.env.DEV`.
//
// The battle runs as a multiplayer client would: the world ticks at the sim's fixed STEP, and every
// order goes through the order table (commands.ts), cleaned as the server would clean it, to run at
// the start of the next tick. What an order answers (why it can't be done) shows as a message.
// Everything else here is this player's view: the camera, the selection, control groups, the
// placement ghost, the memory of enemy buildings seen, rally flags.
//
// Drawing goes through GroundRenderer's hooks (draw.ts): units, sites, rings and bars, the fog, the
// ghost and the enemy start spots. React renders the HUD a few times a second from a snapshot; the
// camera and the frame loop live in refs.

const GroundViewer = lazy(() => import('./Viewer.tsx'))

type GroundSetup = { map: string; you: FactionId; ai: FactionId; credits: number }
const CREDIT_STEPS = [1000, 2000, 5000, 20000]
const setupPref = jsonPref<GroundSetup>('mvlos.empires.groundsetup', { map: GROUND_MAPS[0].id, you: 'republic', ai: 'droid', credits: 2000 }, (v) => ({
  map: GROUND_MAPS.some((m) => m.id === v.map) ? v.map : GROUND_MAPS[0].id,
  you: FACTION_IDS.includes(v.you) ? v.you : 'republic',
  ai: FACTION_IDS.includes(v.ai) ? v.ai : 'droid',
  credits: CREDIT_STEPS.includes(v.credits) ? v.credits : 2000,
}))

const noMenu = (e: React.MouseEvent) => e.preventDefault()

export default function GroundBattle({ sound, onBack }: { sound: EmpiresSound; onBack: () => void }) {
  const [stage, setStage] = useState<'setup' | 'viewer' | 'battle'>('setup')
  const [run, setRun] = useState(0)
  const setup = setupPref.use()
  if (stage === 'viewer')
    return (
      <Suspense fallback={null}>
        <GroundViewer onBack={() => (sound.click(), setStage('setup'))} />
      </Suspense>
    )
  if (stage === 'battle') return <Battle key={run} setup={setup} sound={sound} onLeave={() => setStage('setup')} onRestart={() => setRun((r) => r + 1)} />
  return (
    <div className="ew-root ew-deck ew-lobby ew-landsetup" style={{ backgroundImage: 'url(/games/empires/world/title.webp)' }} onContextMenu={noMenu}>
      <Tips />
      <div className="ew-lobby-body">
        <header className="ew-lobby-head">
          <h2>Skirmish</h2>
          <div className="ew-seg" role="group" aria-label="Battle mode (dev builds only)">
            <button onClick={() => (sound.click(), onBack())} aria-pressed={false}>
              Space
            </button>
            <button className="is-on" aria-pressed>
              Ground
            </button>
          </div>
        </header>
        <Frame title="Ground battle" aside={<span className="ew-muted ew-small">dev builds only</span>} className="ew-landsetup-frame">
          <p className="ew-muted ew-small">A first slice: each side has a Command Center and an Engineer. Train engineers, build and expand, and scout the AI's plateau. No combat yet.</p>
          <div className="ew-landsetup-grid">
            <span>You</span>
            <Seg label="Your faction" value={setup.you} options={FACTION_IDS.map((f) => [f, FACTIONS[f].name])} onChange={(you) => (sound.click(), setupPref.patch({ you }))} />
            <span>AI</span>
            <Seg label="The AI's faction" value={setup.ai} options={FACTION_IDS.map((f) => [f, FACTIONS[f].name])} onChange={(ai) => (sound.click(), setupPref.patch({ ai }))} />
            <span>Map</span>
            <div>
              {GROUND_MAPS.length > 1 ? (
                <Seg label="Map" value={setup.map} options={GROUND_MAPS.map((m) => [m.id, m.name])} onChange={(map) => (sound.click(), setupPref.patch({ map }))} />
              ) : (
                <strong>{GROUND_MAPS[0].name}</strong>
              )}
              <p className="ew-muted ew-small">{(GROUND_MAPS.find((m) => m.id === setup.map) ?? GROUND_MAPS[0]).blurb}</p>
            </div>
            <span>Credits</span>
            <Seg label="Starting credits" value={setup.credits} options={CREDIT_STEPS.map((c) => [c, fmt(c)])} onChange={(credits) => (sound.click(), setupPref.patch({ credits }))} />
          </div>
          <div className="ew-landsetup-actions">
            <button className="ew-menu-btn" onClick={() => (sound.click(), setStage('viewer'))} data-tip="The terrain on its own, with a debug overlay of tiles, heights and flags">
              Map viewer
            </button>
            <button className="ew-go" onClick={() => (sound.click(), setStage('battle'))}>
              Launch battle
            </button>
          </div>
        </Frame>
      </div>
    </div>
  )
}

// --- Setting up a battle ------------------------------------------------------------------------

/** The slice's unit types for a faction, or the sim's test types while the real ones are not in the
 * game yet (so the screen can be tried on its own). */
function sliceTypes(f: FactionId) {
  const ids = SLICE_IDS[f]
  return { center: GROUND_UNIT[ids.center] ? ids.center : 'test-block', engineer: GROUND_UNIT[ids.engineer] ? ids.engineer : 'test-scout' }
}

/** A new battle: seat 0 is the player, seat 1 the AI, each with its Command Center on its start
 * spot and an Engineer at its door. */
function startWorld(map: GroundMap, setup: GroundSetup): GroundWorld {
  const factions = [setup.you, setup.ai]
  const w = newGroundWorld(
    map,
    factions.map((faction, team) => ({ faction, team })),
    { credits: setup.credits },
  )
  factions.forEach((f, owner) => {
    const s = map.spawns[owner]
    if (!s) return
    const { center, engineer } = sliceTypes(f)
    const [fw, fh] = GROUND_UNIT[center].foot ?? [3, 3]
    const tc = Math.round(s.x / TILE - fw / 2)
    const tr = Math.round(s.y / TILE - fh / 2)
    addStructure(w, center, owner, tc, tr)
    spawnUnit(w, engineer, owner, (tc + fw / 2) * TILE, (tr + fh + 1.5) * TILE, Math.PI / 2)
  })
  return w
}

/** The AI's turn each tick. ground/ai.ts (the building session's passive AI) plugs in here: until
 * it does, the AI's side stands still. */
function runAi(_w: GroundWorld, _seat: Owner) {
  // AI HOOK: call ground/ai.ts's per-tick function here once it exists.
}

const isEngineerType = (w: GroundWorld, u: GroundUnit) => {
  const f = w.players[u.owner]?.faction
  return !!f && u.type === sliceTypes(f).engineer
}
const typeName = (type: string) => GROUND_UNIT[type]?.name ?? type
/** A thumbnail of a type's model, or '' while it has none. */
const artOf = (type: string) => {
  const m = modelOf(type)
  return m ? thumbnail(m, 96).url : ''
}

// --- The HUD's snapshot -------------------------------------------------------------------------

type Card = { type: string; name: string; art: string; cost: number; why: string | null; queued: number }
type SelSnap = {
  ids: number[]
  kinds: { type: string; name: string; count: number }[]
  /** Only ours, and at least one moves. */
  vehicles: boolean
  /** One unit selected: the details. */
  one: null | {
    id: number
    type: string
    name: string
    ours: boolean
    hull: number
    max: number
    site: number | null
    queue: { items: string[]; progress: number }
    train: Card[]
    trains: boolean
  }
  /** Our engineers are selected: what they can build. */
  build: Card[] | null
  /** Our sites among the selection, to cancel. */
  sites: number[]
}
type HudSnap = {
  credits: number
  income: number
  time: number
  units: number
  sel: SelSnap | null
  place: { type: string; name: string; why: string | null; cost: number } | null
  groups: { key: string; count: number }[]
}
type Toast = { id: number; text: string }

// --- The battle ---------------------------------------------------------------------------------

const ME: Owner = 0
const MAX_ZOOM = 2.5
/** Steps run in one frame at most (a stalled tab doesn't fast-forward). */
const MAX_STEPS = 8
/** The HUD's snapshot, a second. */
const HUD_HZ = 5

type Place = { type: string; x: number; y: number }
type Drag = {
  id: number
  touch: boolean
  button: number
  kind: 'pending' | 'box' | 'pan' | 'ghost'
  sx: number
  sy: number
  x: number
  y: number
  /** A finger that landed on the placement ghost drags it rather than the view. */
  onGhost: boolean
}

/** Puts the action wheel's opener (from the WheelHost round the screen) where the frame loop's
 * input handlers can reach it. */
function WheelBridge({ to }: { to: { current: (r: WheelRequest | null) => void } }) {
  to.current = useWheel()
  return null
}

function Battle({ setup, sound, onLeave, onRestart }: { setup: GroundSetup; sound: EmpiresSound; onLeave: () => void; onRestart: () => void }) {
  const map = useMemo(() => buildGroundMap(GROUND_MAPS.find((m) => m.id === setup.map) ?? GROUND_MAPS[0]), [setup.map])
  const world = useRef<GroundWorld | null>(null)
  if (!world.current) world.current = startWorld(map, setup)
  const team = world.current.players[ME].team
  const phone = useIsMobile()
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const mini = useRef<HTMLCanvasElement>(null)
  const wheel = useRef<(r: WheelRequest | null) => void>(() => {})
  const view = useRef<GroundView>({ x: map.spawns[ME]?.x ?? 0, y: map.spawns[ME]?.y ?? 0, zoom: 0.6, w: 1, h: 1, dpr: 1 })
  const selected = useRef(new Set<number>())
  const groups = useRef<Groups>(new Map())
  const memory = useRef(new Map<number, Seen>())
  const rallies = useRef(new Map<number, { x: number; y: number }>())
  const pings = useRef<Ping[]>([])
  const outbox = useRef<GroundCmd[]>([])
  const place = useRef<Place | null>(null)
  const lastPlace = useRef<Placement | null>(null)
  const drag = useRef<Drag | null>(null)
  const hover = useRef(0)
  const mouse = useRef({ x: 0, y: 0, inside: false })
  const touchLast = useRef(false)
  const flags = useRef({ paused: false, speed: 1, reveal: false })
  const income = useRef<{ t: number; got: number }[]>([])
  const [ui, setUi] = useState({ paused: false, speed: 1, menu: false, placing: null as string | null, mapOpen: true, panel: false, debug: { grid: false, heights: false, flags: false }, reveal: false })
  const uiRef = useRef(ui)
  uiRef.current = ui
  const [hud, setHud] = useState<HudSnap | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)
  /** The HUD's snapshot is wanted before its next turn (a selection or an order). */
  const hudSoon = useRef(false)
  const renderer = useRef<GroundRenderer | null>(null)
  const [touchUi, setTouchUi] = useState(() => matchMedia('(pointer: coarse)').matches)

  const toast = useCallback((text: string) => {
    const id = ++toastId.current
    setToasts((t) => [...t.filter((x) => x.text !== text).slice(-3), { id, text }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500)
  }, [])
  const toastRef = useRef(toast)
  toastRef.current = toast

  /** Sends an order: it runs at the start of the next tick, after the server's cleaning. */
  const order = useCallback((c: GroundCmd) => {
    outbox.current.push(c)
    hudSoon.current = true
  }, [])

  /** Our units still alive among the selection. */
  const mine = useCallback(() => {
    const w = world.current!
    const out: GroundUnit[] = []
    for (const id of selected.current) {
      const u = w.byId.get(id)
      if (u && !u.dead && u.owner === ME) out.push(u)
    }
    return out
  }, [])
  const engineersFor = useCallback(() => {
    const w = world.current!
    const sel = mine().filter((u) => isEngineerType(w, u))
    if (sel.length) return sel
    // None selected: every engineer of ours.
    return w.units.filter((u) => !u.dead && u.owner === ME && isEngineerType(w, u))
  }, [mine])

  const select = useCallback((ids: Iterable<number>) => {
    selected.current = new Set(ids)
    hudSoon.current = true
    setUi((u) => (u.panel ? { ...u, panel: false } : u))
  }, [])

  const endPlace = useCallback(() => {
    place.current = null
    lastPlace.current = null
    setUi((u) => ({ ...u, placing: null }))
  }, [])
  /** Starts placing a building: the ghost follows the mouse, or on touch sits in the middle of the
   * view (or where the wheel opened) to be dragged, then confirmed. */
  const startPlace = useCallback((type: string, at?: { x: number; y: number }) => {
    const v = view.current
    place.current = { type, x: at?.x ?? v.x, y: at?.y ?? v.y }
    hudSoon.current = true
    setUi((u) => ({ ...u, placing: type }))
  }, [])
  const confirmPlace = useCallback(
    (keep = false) => {
      const p = place.current
      if (!p) return
      const eng = engineersFor()
      if (!eng.length) {
        toastRef.current('No engineer to build it')
        return
      }
      // The engineers selected, or else the one nearest the spot.
      const ids = mine().some((u) => isEngineerType(world.current!, u))
        ? eng.map((u) => u.id)
        : [eng.reduce((a, b) => ((a.x - p.x) ** 2 + (a.y - p.y) ** 2 <= (b.x - p.x) ** 2 + (b.y - p.y) ** 2 ? a : b)).id]
      order(groundCmd('place', ids, p.type, p.x, p.y, keep))
      sound.click()
      if (!keep) endPlace()
    },
    [engineersFor, mine, order, sound, endPlace],
  )

  const centerOn = useCallback((x: number, y: number) => {
    view.current.x = x
    view.current.y = y
  }, [])

  const train = useCallback((id: number, type: string, five: boolean) => (order(groundCmd('train', id, type, five ? 5 : 1)), sound.click()), [order, sound])
  const cancel = useCallback((id: number, index: number) => (order(groundCmd('cancel', id, index)), sound.click()), [order, sound])
  const stop = useCallback(() => {
    const ids = mine().filter((u) => typeOf(u).kind === 'vehicle').map((u) => u.id)
    if (ids.length) order(groundCmd('stop', ids))
  }, [mine, order])

  // Control groups: '1' to '0', with Ctrl to set and Shift to add (or as rebound in Settings).
  const groupPress = useRef(new DoublePress())
  const groupMembers = useCallback((key: string) => {
    const w = world.current!
    const ids = (groups.current.get(key) ?? []).filter((id) => {
      const u = w.byId.get(id)
      return u && !u.dead && u.owner === ME
    })
    setGroup(groups.current, key, ids)
    return ids
  }, [])
  const recallGroup = useCallback(
    (key: string) => {
      const ids = groupMembers(key)
      if (!ids.length) return
      select(ids)
      if (groupPress.current.hit(key, performance.now())) {
        const w = world.current!
        const us = ids.map((id) => w.byId.get(id)!).filter(Boolean)
        centerOn(us.reduce((s, u) => s + u.x, 0) / us.length, us.reduce((s, u) => s + u.y, 0) / us.length)
      }
    },
    [groupMembers, select, centerOn],
  )

  // The HUD's snapshot.
  const snap = useCallback((): HudSnap => {
    const w = world.current!
    const p = w.players[ME]
    let units = 0
    for (const u of w.units) if (!u.dead && u.owner === ME) units++
    // Income: credits gained over the last ten seconds (spending and refunds set aside as best a
    // screen can: only rises count), a minute's worth.
    const inc = income.current
    const got = inc.reduce((s, x) => s + x.got, 0)
    const span = inc.length > 1 ? inc[inc.length - 1].t - inc[0].t : 0
    let sel: SelSnap | null = null
    const ids = [...selected.current].filter((id) => {
      const u = w.byId.get(id)
      return u && !u.dead && seenNow(w, team, u, flags.current.reveal)
    })
    if (ids.length !== selected.current.size) selected.current = new Set(ids)
    if (ids.length) {
      const us = ids.map((id) => w.byId.get(id)!)
      const kinds = new Map<string, number>()
      for (const u of us) kinds.set(u.type, (kinds.get(u.type) ?? 0) + 1)
      const ours = us.filter((u) => u.owner === ME)
      const engineers = ours.some((u) => isEngineerType(w, u))
      const v = view.current
      const cards = (types: string[], cost: (t: string) => number, why: (t: string) => string | null, queued: (t: string) => number): Card[] =>
        types.map((t) => ({ type: t, name: typeName(t), art: artOf(t), cost: cost(t), why: why(t), queued: queued(t) }))
      let one: SelSnap['one'] = null
      if (us.length === 1) {
        const u = us[0]
        const t = typeOf(u)
        const q = queueOf(u)
        const site = siteProgress(u)
        const trainTypes = u.owner === ME && t.foot && site === null ? trainable(w, u.id) : []
        one = {
          id: u.id,
          type: u.type,
          name: t.name,
          ours: u.owner === ME,
          hull: u.hull,
          max: t.hull,
          site,
          queue: { items: [...q.items], progress: q.progress },
          train: cards(trainTypes, () => 0, (x) => cantTrain(w, ME, u.id, x), (x) => q.items.filter((i) => i === x).length),
          trains: trainTypes.length > 0,
        }
      }
      sel = {
        ids,
        kinds: [...kinds].map(([type, count]) => ({ type, name: typeName(type), count })),
        vehicles: ours.length === us.length && ours.some((u) => typeOf(u).kind === 'vehicle'),
        one,
        build: engineers ? cards(buildable(w, ME), (x) => placement(w, ME, x, v.x, v.y).cost, () => null, () => 0) : null,
        sites: ours.filter((u) => siteProgress(u) !== null).map((u) => u.id),
      }
    }
    const pl = place.current
    const lp = lastPlace.current
    return {
      credits: Math.floor(p.credits),
      income: span > 0.5 ? Math.round((got / span) * 60) : 0,
      time: Math.floor(w.time),
      units,
      sel,
      place: pl ? { type: pl.type, name: typeName(pl.type), why: lp?.why ?? null, cost: lp?.cost ?? 0 } : null,
      groups: GROUP_KEYS.filter((k) => groups.current.has(k)).map((k) => ({ key: k, count: groups.current.get(k)!.length })),
    }
  }, [team])

  // --- The frame loop and input -----------------------------------------------------------------
  useEffect(() => {
    const cv = canvas.current!
    const box = root.current!
    const ctx = cv.getContext('2d', { alpha: false })!
    const w = world.current!
    const lowMem = matchMedia('(pointer: coarse)').matches || window.innerWidth < 720
    const ren = new GroundRenderer(map, lowMem ? { budget: 24 * 1024 * 1024, maxScale: Math.SQRT2 } : {})
    renderer.current = ren
    const fog = new FogShade(map.grid.cols, map.grid.rows)
    const minimap = new MiniMap(map)
    const v = view.current
    const W = w.w, H = w.h
    let minZoom = 0.05
    let raf = 0
    let last = performance.now()
    let acc = 0
    let fogGen = -1
    let fogReveal = false
    let hudT = 0
    let miniT = 0
    const miniWas = [0, 0, 0, 0, 0]
    let lastCredits = w.players[ME].credits
    const keys = new Set<string>()
    const look: Look = { me: ME, team, selected: selected.current, hover: 0, bars: getSettings().bars, reveal: false, memory: memory.current, zoom: 1, zdpr: 1, now: 0 }
    const sel = () => look.selected
    const clampView = () => {
      v.zoom = Math.min(MAX_ZOOM, Math.max(minZoom, v.zoom))
      // A little past the map's edges, so its border isn't stuck under the HUD.
      const m = 140 / v.zoom
      const hw = v.w / 2 / v.zoom, hh = v.h / 2 / v.zoom
      v.x = hw * 2 >= W + 2 * m ? W / 2 : Math.min(W - hw + m, Math.max(hw - m, v.x))
      v.y = hh * 2 >= H + 2 * m ? H / 2 : Math.min(H - hh + m, Math.max(hh - m, v.y))
    }
    const resize = () => {
      const r = cv.getBoundingClientRect()
      v.w = Math.max(1, r.width)
      v.h = Math.max(1, r.height)
      v.dpr = Math.min(2, devicePixelRatio || 1)
      cv.width = Math.round(v.w * v.dpr)
      cv.height = Math.round(v.h * v.dpr)
      minZoom = Math.min(v.w / W, v.h / H) * 0.9
      const m = mini.current
      if (m) {
        const mr = m.getBoundingClientRect()
        m.width = Math.max(1, Math.round(mr.width * v.dpr))
        m.height = Math.max(1, Math.round(mr.height * v.dpr))
      }
      clampView()
      miniT = 0
    }
    const ro = new ResizeObserver(resize)
    ro.observe(cv)
    if (mini.current) ro.observe(mini.current)
    resize()
    const toWorld = (sx: number, sy: number) => ({ x: v.x + (sx - v.w / 2) / v.zoom, y: v.y + (sy - v.h / 2) / v.zoom })
    const zoomAt = (f: number, sx: number, sy: number) => {
      const p = toWorld(sx, sy)
      v.zoom = Math.min(MAX_ZOOM, Math.max(minZoom, v.zoom * f))
      v.x = p.x - (sx - v.w / 2) / v.zoom
      v.y = p.y - (sy - v.h / 2) / v.zoom
      clampView()
    }

    // One tick: last tick's orders first (as the server would send them), the AI, then the sim.
    const step = () => {
      for (const c of outbox.current.splice(0)) {
        const clean = cleanGroundCmd(JSON.parse(JSON.stringify(c)), w)
        if (!clean) continue
        const why = runGroundCmd(w, ME, clean)
        if (typeof why === 'string' && why) toastRef.current(why)
      }
      for (let s = 0; s < w.players.length; s++) if (s !== ME) runAi(w, s)
      tick(w)
      w.events.length = 0
      const c = w.players[ME].credits
      if (c > lastCredits) income.current.push({ t: w.time, got: c - lastCredits })
      lastCredits = c
      while (income.current.length && income.current[0].t < w.time - 10) income.current.shift()
    }

    // Picking.
    const pick = (x: number, y: number): GroundUnit | null => {
      const slack = 6 / v.zoom
      let best: GroundUnit | null = null
      let bestD = Infinity
      let building: GroundUnit | null = null
      for (const u of w.units) {
        if (u.dead || !seenNow(w, team, u, look.reveal)) continue
        const t = typeOf(u)
        if (t.foot) {
          if (x >= u.tc * TILE && x < (u.tc + t.foot[0]) * TILE && y >= u.tr * TILE && y < (u.tr + t.foot[1]) * TILE) building = u
          continue
        }
        const d = Math.hypot(u.x - x, u.y - y)
        if (d < t.radius + slack && d < bestD) (best = u), (bestD = d)
      }
      return best ?? building
    }
    const onScreen = (u: GroundUnit) => {
      const hw = v.w / 2 / v.zoom, hh = v.h / 2 / v.zoom
      return Math.abs(u.x - v.x) <= hw && Math.abs(u.y - v.y) <= hh
    }
    const allOfType = (type: string) => w.units.filter((u) => !u.dead && u.owner === ME && u.type === type && onScreen(u)).map((u) => u.id)
    const clickPress = new DoublePress()
    const clickSelect = (x: number, y: number, add: boolean) => {
      const u = pick(x, y)
      if (!u) {
        if (!add) select([])
        return
      }
      if (u.owner !== ME) {
        select([u.id])
        return
      }
      if (clickPress.hit(`${u.type}`, performance.now())) {
        select(add ? [...sel(), ...allOfType(u.type)] : allOfType(u.type))
        return
      }
      if (add) {
        const next = new Set(sel())
        if (next.has(u.id)) next.delete(u.id)
        else next.add(u.id)
        select(next)
      } else select([u.id])
    }
    const boxSelect = (a: { x: number; y: number }, b: { x: number; y: number }, add: boolean) => {
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y)
      const inside = w.units.filter((u) => !u.dead && u.owner === ME && u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1)
      const movers = inside.filter((u) => typeOf(u).kind === 'vehicle')
      const ids = (movers.length ? movers : inside).map((u) => u.id)
      select(add ? [...sel(), ...ids] : ids)
    }
    const ping = (x: number, y: number, col = OWN) => pings.current.push({ x, y, at: performance.now() / 1000, col })

    // A right-click (or the wheel's Move) at a world point: engineers build or repair one of ours,
    // vehicles move, a structure alone sets its rally point.
    const command = (x: number, y: number, queued: boolean) => {
      const us = mine()
      const movers = us.filter((u) => typeOf(u).kind === 'vehicle')
      const eng = movers.filter((u) => isEngineerType(w, u))
      const target = pick(x, y)
      if (eng.length && target && target.owner === ME && typeOf(target).foot && (siteProgress(target) !== null || target.hull < typeOf(target).hull)) {
        order(groundCmd('construct', eng.map((u) => u.id), target.id, queued))
        ping(target.x, target.y)
        return
      }
      if (movers.length) {
        order(groundCmd('move', movers.map((u) => u.id), x, y, queued))
        ping(x, y)
        return
      }
      const yards = us.filter((u) => typeOf(u).foot && siteProgress(u) === null)
      for (const u of yards) {
        order(groundCmd('rally', u.id, x, y))
        rallies.current.set(u.id, { x, y })
      }
      if (yards.length) ping(x, y)
    }

    // Layers drawn into the renderer's frame.
    const vbox = { x0: 0, y0: 0, x1: 0, y1: 0 }
    const layers = {
      ground: (g: CanvasRenderingContext2D) => {
        drawRings(g, w, look)
        for (const id of sel()) {
          const u = w.byId.get(id)
          const r = u && !u.dead && u.owner === ME ? rallies.current.get(u.id) : undefined
          if (u && r) drawRally(g, u, r, look)
        }
        drawPings(g, pings.current, look)
      },
      units: (g: CanvasRenderingContext2D) => drawUnits(g, w, look, vbox),
      fog: (g: CanvasRenderingContext2D) => {
        if (!look.reveal) fog.draw(g, w)
      },
      overlay: (g: CanvasRenderingContext2D) => {
        drawStarts(g, w, look)
        const p = place.current
        if (p) {
          const pl = placement(w, ME, p.type, p.x, p.y)
          lastPlace.current = pl
          drawGhost(g, w, p.type, pl, p.x, p.y, look)
        }
        const d = drag.current
        if (d?.kind === 'box') drawBox(g, toWorld(d.sx, d.sy), toWorld(d.x, d.y), look)
      },
    }

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000))
      last = now
      const st = flags.current
      if (!st.paused) {
        acc += dt * st.speed
        let n = 0
        while (acc >= STEP && n < MAX_STEPS) {
          step()
          acc -= STEP
          n++
        }
        if (n === MAX_STEPS) acc = 0
      }
      // Camera: keys, and the screen's edges when the game fills the page.
      const set = getSettings()
      const pan = ((900 * set.cameraSpeed) / v.zoom) * dt
      if (keys.has('arrowleft') || keys.has(set.keys.panLeft)) v.x -= pan
      if (keys.has('arrowright') || keys.has(set.keys.panRight)) v.x += pan
      if (keys.has('arrowup') || keys.has(set.keys.panUp)) v.y -= pan
      if (keys.has('arrowdown') || keys.has(set.keys.panDown)) v.y += pan
      const edge = set.edgeScroll === 'always' || (set.edgeScroll === 'fullscreen' && !!box.closest('.is-page-full'))
      const ms = mouse.current
      if (edge && ms.inside && !touchLast.current && !drag.current) {
        if (ms.x < 8) v.x -= pan
        if (ms.x > v.w - 8) v.x += pan
        if (ms.y < 8) v.y -= pan
        if (ms.y > v.h - 8) v.y += pan
      }
      clampView()
      // Fog: after each of the sim's fog refreshes (or the dev reveal switched).
      const gen = Math.floor((w.ticks * FOG_HZ) / 30)
      if (gen !== fogGen || st.reveal !== fogReveal) {
        fogGen = gen
        fogReveal = st.reveal
        look.reveal = st.reveal
        fog.update(w, team, st.reveal)
        updateMemory(w, team, memory.current)
        miniT = 0
      }
      look.selected = selected.current
      look.hover = hover.current
      look.zoom = v.zoom
      look.zdpr = v.zoom * v.dpr
      look.now = now / 1000
      const hw = v.w / 2 / v.zoom, hh = v.h / 2 / v.zoom
      vbox.x0 = v.x - hw
      vbox.x1 = v.x + hw
      vbox.y0 = v.y - hh
      vbox.y1 = v.y + hh
      ren.draw(ctx, v, layers)
      // The minimap: ten times a second, or at once when the view moved.
      const m = mini.current
      miniT -= dt
      if (m && m.width > 1) {
        const was = [v.x, v.y, v.zoom, m.width, m.height]
        if (miniT <= 0 || was.some((x, i) => x !== miniWas[i])) {
          miniT = 0.1
          was.forEach((x, i) => (miniWas[i] = x))
          const g = m.getContext('2d')
          if (g) minimap.draw(g, m.width, m.height, w, look, fog, v)
        }
      }
      hudT -= dt
      // An order or a new selection shows at once (after the tick that runs it).
      if (hudSoon.current && !outbox.current.length) {
        hudSoon.current = false
        hudT = 0
      }
      if (hudT <= 0) {
        hudT = 1 / HUD_HZ
        const next = snap()
        setHud((h) => (h && JSON.stringify(h) === JSON.stringify(next) ? h : next))
      }
    }
    raf = requestAnimationFrame(frame)

    // --- Pointers on the battlefield ---
    const press = new LongPress()
    const touches = new Map<number, { x: number; y: number }>()
    let pinch = 0
    const local = (e: { clientX: number; clientY: number }) => {
      const r = cv.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const nearGhost = (x: number, y: number) => {
      const p = place.current
      if (!p) return false
      const f = GROUND_UNIT[p.type]?.foot ?? [6, 6]
      const m = TILE * 1.5
      return Math.abs(x - p.x) <= (f[0] * TILE) / 2 + m && Math.abs(y - p.y) <= (f[1] * TILE) / 2 + m
    }
    const openWheel = (cx: number, cy: number, sx: number, sy: number) => {
      const at = toWorld(sx, sy)
      const items = wheelItems(at.x, at.y)
      if (items.length) wheel.current({ x: cx, y: cy, items })
    }
    const wheelItems = (x: number, y: number): WheelItem[] => {
      const us = mine()
      const movers = us.filter((u) => typeOf(u).kind === 'vehicle')
      const eng = movers.filter((u) => isEngineerType(w, u))
      const target = pick(x, y)
      const items: WheelItem[] = []
      if (movers.length) items.push({ id: 'move', label: shiftOf() ? 'Queue move' : 'Move', icon: <Icon name="move" size={20} />, run: () => command(x, y, shiftOf()) })
      if (eng.length && target && target.owner === ME && siteProgress(target) !== null)
        items.push({ id: 'construct', label: 'Build it', icon: <Icon name="yard" size={20} />, run: () => command(x, y, shiftOf()) })
      if (eng.length) {
        const types = buildable(w, ME)
        for (const t of types) items.push({ id: `build-${t}`, label: typeName(t), icon: <Icon name="yard" size={20} />, run: () => startPlace(t, { x, y }) })
        if (!types.length) items.push({ id: 'build-none', label: 'Build', icon: <Icon name="yard" size={20} />, disabled: 'Building is not in the game yet', run: () => {} })
      }
      if (!movers.length && us.some((u) => typeOf(u).foot && siteProgress(u) === null))
        items.push({ id: 'rally', label: 'Rally here', icon: <Icon name="rally" size={20} />, run: () => command(x, y, false) })
      if (target && target.owner === ME) items.push({ id: 'all', label: 'All of type', icon: <Icon name="army" size={20} />, run: () => select(allOfType(target.type)) })
      if (movers.length) items.push({ id: 'stop', label: 'Stop', icon: <Icon name="stop" size={20} />, run: stop })
      return items
    }

    const down = (e: PointerEvent) => {
      touchLast.current = isTouch(e)
      try {
        cv.setPointerCapture(e.pointerId)
      } catch {
        // A pointer the browser no longer tracks: no capture.
      }
      const p = local(e)
      if (isTouch(e)) {
        touches.set(e.pointerId, p)
        if (touches.size === 2) {
          // Two fingers: pinch. Whatever the first one started is called off.
          press.cancel()
          drag.current = null
          const [a, b] = [...touches.values()]
          pinch = Math.hypot(a.x - b.x, a.y - b.y)
          return
        }
        if (touches.size > 2) return
        const at = toWorld(p.x, p.y)
        drag.current = { id: e.pointerId, touch: true, button: 0, kind: 'pending', sx: p.x, sy: p.y, x: p.x, y: p.y, onGhost: nearGhost(at.x, at.y) }
        press.start(e, () => {
          drag.current = null
          openWheel(e.clientX, e.clientY, p.x, p.y)
        })
        return
      }
      if (e.button === 0 && place.current) return
      drag.current = { id: e.pointerId, touch: false, button: e.button, kind: 'pending', sx: p.x, sy: p.y, x: p.x, y: p.y, onGhost: false }
    }
    const move = (e: PointerEvent) => {
      const p = local(e)
      if (!isTouch(e)) {
        mouse.current = { x: p.x, y: p.y, inside: true }
        const at = toWorld(p.x, p.y)
        if (place.current) {
          place.current.x = at.x
          place.current.y = at.y
        } else if (!drag.current) hover.current = pick(at.x, at.y)?.id ?? 0
      }
      if (isTouch(e)) {
        const was = touches.get(e.pointerId)
        if (!was) return
        if (touches.size === 2) {
          const other = [...touches.entries()].find(([id]) => id !== e.pointerId)![1]
          const dd = Math.hypot(p.x - other.x, p.y - other.y)
          const mx = (p.x + other.x) / 2, my = (p.y + other.y) / 2
          const pmx = (was.x + other.x) / 2, pmy = (was.y + other.y) / 2
          v.x -= (mx - pmx) / v.zoom
          v.y -= (my - pmy) / v.zoom
          if (pinch > 0) zoomAt(dd / pinch, mx, my)
          pinch = dd
          touches.set(e.pointerId, p)
          return
        }
        touches.set(e.pointerId, p)
        press.move(e)
      }
      const d = drag.current
      if (!d || d.id !== e.pointerId) return
      const dx = p.x - d.x, dy = p.y - d.y
      if (d.kind === 'pending' && Math.hypot(p.x - d.sx, p.y - d.sy) > (d.touch ? TAP_SLOP : 5)) {
        press.cancel()
        if (d.touch) d.kind = d.onGhost ? 'ghost' : getTouchMods().box ? 'box' : 'pan'
        else d.kind = d.button === 0 ? 'box' : 'pan'
      }
      if (d.kind === 'pan') {
        v.x -= dx / v.zoom
        v.y -= dy / v.zoom
        clampView()
      } else if (d.kind === 'ghost' && place.current) {
        place.current.x += dx / v.zoom
        place.current.y += dy / v.zoom
      }
      d.x = p.x
      d.y = p.y
    }
    const up = (e: PointerEvent) => {
      const p = local(e)
      if (isTouch(e)) {
        touches.delete(e.pointerId)
        pinch = 0
        press.cancel()
        if (press.fired) {
          press.fired = false
          drag.current = null
          return
        }
      } else if (e.button === 0 && place.current) {
        const at = toWorld(p.x, p.y)
        place.current.x = at.x
        place.current.y = at.y
        confirmPlace(shiftOf(e))
        return
      } else if (e.button === 2 && place.current) {
        endPlace()
        drag.current = null
        return
      }
      const d = drag.current
      if (!d || d.id !== e.pointerId) return
      drag.current = null
      const at = toWorld(p.x, p.y)
      if (d.kind === 'box') return boxSelect(toWorld(d.sx, d.sy), at, shiftOf(e))
      if (d.kind !== 'pending') return
      if (d.touch) {
        // A tap: moves the ghost while placing, else selects (a second tap on one of a kind: all of
        // it on screen).
        if (place.current) {
          place.current.x = at.x
          place.current.y = at.y
        } else clickSelect(at.x, at.y, shiftOf(e))
        return
      }
      if (d.button === 0) clickSelect(at.x, at.y, shiftOf(e))
      else if (d.button === 2) command(at.x, at.y, shiftOf(e))
    }
    const cancelPointer = (e: PointerEvent) => {
      touches.delete(e.pointerId)
      pinch = 0
      press.cancel()
      if (drag.current?.id === e.pointerId) drag.current = null
    }
    const leave = (e: PointerEvent) => {
      if (!isTouch(e)) {
        mouse.current.inside = false
        hover.current = 0
      }
    }
    const wheelZoom = (e: WheelEvent) => {
      e.preventDefault()
      const p = local(e)
      zoomAt(Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1)), p.x, p.y)
    }
    cv.addEventListener('pointerdown', down)
    cv.addEventListener('pointermove', move)
    cv.addEventListener('pointerup', up)
    cv.addEventListener('pointercancel', cancelPointer)
    cv.addEventListener('pointerleave', leave)
    cv.addEventListener('wheel', wheelZoom, { passive: false })

    // --- Keys ---
    const keyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select')) return
      if (!box.isConnected) return
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase()
      const set = getSettings()
      if (k === 'escape') {
        e.preventDefault()
        if (place.current) endPlace()
        else if (uiRef.current.menu) setMenu(false)
        else if (selected.current.size) select([])
        else setMenu(true)
        return
      }
      if (uiRef.current.menu) return
      // Alt+1…9 belongs to the OS (workspaces): never taken here.
      if (e.altKey) return
      const gk = groupKeyOf(set.keys, e)
      if (gk) {
        e.preventDefault()
        const mod = modOf(e)
        const ids = mine().map((u) => u.id)
        if (mod === set.groupSet) setGroup(groups.current, gk, ids)
        else if (mod === set.groupAdd) addToGroup(groups.current, gk, ids)
        else if (mod === '') recallGroup(gk)
        hudT = 0
        return
      }
      if (k === 'delete' || k === 'backspace') {
        for (const u of mine()) if (siteProgress(u) !== null) cancel(u.id, -1)
        return
      }
      if (k === set.keys.pause) return togglePause()
      if (k === set.keys.station) {
        const cc = w.units.find((u) => !u.dead && u.owner === ME && typeOf(u).foot)
        if (cc) {
          const again = selected.current.size === 1 && selected.current.has(cc.id)
          select([cc.id])
          if (again) centerOn(cc.x, cc.y)
        }
        return
      }
      if (k === set.keys.zoomIn || k === '+') zoomAt(1.25, v.w / 2, v.h / 2)
      else if (k === set.keys.zoomOut) zoomAt(1 / 1.25, v.w / 2, v.h / 2)
      keys.add(k)
    }
    const keyUp = (e: KeyboardEvent) => keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase())
    const blur = () => keys.clear()
    window.addEventListener('keydown', keyDown)
    window.addEventListener('keyup', keyUp)
    window.addEventListener('blur', blur)

    void ren.ready.then(() => (miniT = 0))
    if (import.meta.env.DEV) (window as unknown as { __groundBattle: unknown }).__groundBattle = { world: w, view: v, renderer: ren, selected, order, place }
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      cv.removeEventListener('pointerdown', down)
      cv.removeEventListener('pointermove', move)
      cv.removeEventListener('pointerup', up)
      cv.removeEventListener('pointercancel', cancelPointer)
      cv.removeEventListener('pointerleave', leave)
      cv.removeEventListener('wheel', wheelZoom)
      window.removeEventListener('keydown', keyDown)
      window.removeEventListener('keyup', keyUp)
      window.removeEventListener('blur', blur)
      press.cancel()
      ren.dispose()
      renderer.current = null
    }
    // The world and map are this battle's for its whole life (a restart mounts a new one).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setMenu = (open: boolean) => {
    flags.current.paused = open || uiRef.current.paused
    setUi((u) => ({ ...u, menu: open }))
  }
  const togglePause = () => {
    const paused = !uiRef.current.paused
    flags.current.paused = paused || uiRef.current.menu
    setUi((u) => ({ ...u, paused }))
  }
  const setSpeed = (speed: number) => {
    flags.current.speed = speed
    setUi((u) => ({ ...u, speed }))
  }
  const setDebug = (patch: Partial<typeof ui.debug>) => {
    const debug = { ...ui.debug, ...patch }
    if (renderer.current) renderer.current.debug = { ...debug }
    setUi((u) => ({ ...u, debug }))
  }
  const setReveal = (reveal: boolean) => {
    flags.current.reveal = reveal
    setUi((u) => ({ ...u, reveal }))
  }
  // Phones start with the minimap folded away.
  useEffect(() => setUi((u) => ({ ...u, mapOpen: !phone })), [phone])

  // The minimap: click or drag moves the view there; right-click (or long-press) sends the selection.
  const miniPress = useRef(new LongPress())
  const onMini = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const w = world.current!
    const r = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * w.w
    const y = ((e.clientY - r.top) / r.height) * w.h
    if (e.type === 'pointerdown' && (e.button === 2 || isTouch(e))) {
      if (e.button === 2) {
        const ids = mine().filter((u) => typeOf(u).kind === 'vehicle').map((u) => u.id)
        if (ids.length) order(groundCmd('move', ids, x, y, shiftOf(e)))
        return
      }
      miniPress.current.start(e, () => {
        const ids = mine().filter((u) => typeOf(u).kind === 'vehicle').map((u) => u.id)
        if (ids.length) order(groundCmd('move', ids, x, y, shiftOf()))
      })
    }
    if (e.type === 'pointermove' && isTouch(e)) miniPress.current.move(e)
    if (e.type === 'pointerdown' || e.buttons === 1) centerOn(x, y)
  }

  const w = world.current
  const fac = FACTIONS[setup.you]
  const sel = hud?.sel ?? null
  const Click = touchUi ? 'Tap' : 'Click'
  return (
    <div
      ref={root}
      className={`ew-root ew-deck ew-battle ew-landbattle ew-${setup.you}${phone ? ' is-phone' : ''}${ui.mapOpen ? ' is-mapopen' : ''}`}
      style={{ ['--ew-accent' as string]: fac.color }}
      onContextMenu={noMenu}
      onPointerDownCapture={(e) => {
        touchLast.current = isTouch(e)
        setTouchUi(isTouch(e))
      }}
    >
      <WheelHost>
        <WheelBridge to={wheel} />
        <Tips />
        <canvas ref={canvas} className={`ew-canvas ${ui.placing ? 'is-targeting' : ''}`} />

        <div className="ew-top ew-landtop">
          <span className="ew-top-cell ew-top-faction">
            <span className="ew-emblem">
              <img src={fac.emblem} alt="" />
            </span>
            <div>
              <strong>{fac.name}</strong>
              <small>{map.def.name}</small>
            </div>
          </span>
          <span className="ew-top-cell ew-creditcell" data-tip="Credits, and what came in over the last ten seconds, a minute's worth">
            <span className="ew-gold">
              <Icon name="credits" size={20} />
            </span>
            <b className="ew-big">{fmt(hud?.credits ?? w.players[ME].credits)}</b>
            <small className="ew-good">+{fmt(hud?.income ?? 0)} / min</small>
          </span>
          <span className="ew-top-cell ew-hide-narrow" data-tip="Your units and buildings">
            <Icon name="fleet" size={20} />
            <b className="ew-big">{hud?.units ?? 0}</b>
          </span>
          <div className="ew-top-right">
            <div className={`ew-top-cell ew-timectl ${ui.paused ? 'is-paused' : ''}`} role="group" aria-label="Time">
              <button onClick={togglePause} data-tip={ui.paused ? 'Resume (P)' : 'Pause (P)'} aria-label={ui.paused ? 'Resume' : 'Pause'}>
                <Icon name={ui.paused ? 'play' : 'pause'} size={16} />
              </button>
              <b className="ew-clockval">{clock(hud?.time ?? 0)}</b>
              <button className="ew-speedbtn" onClick={() => setSpeed((ui.speed % 3) + 1)} data-tip="Game speed: click to cycle 1x, 2x, 3x" aria-label={`Game speed ${ui.speed}x`}>
                {ui.speed}×
              </button>
            </div>
            <button className={`ew-top-cell ew-top-btn ew-landmaptoggle ${ui.mapOpen ? 'is-on' : ''}`} onClick={() => setUi((u) => ({ ...u, mapOpen: !u.mapOpen }))} aria-pressed={ui.mapOpen} data-tip="Minimap: show or hide it" aria-label="Minimap">
              <Icon name="radar" size={18} />
            </button>
            <button className="ew-top-cell ew-top-btn" onClick={() => setMenu(!ui.menu)} data-tip="Battle menu (Esc)" aria-label="Menu">
              <Icon name="menu" size={18} />
            </button>
          </div>
        </div>

        {hud && hud.groups.length > 0 && (
          <div className="ew-landgroups" role="group" aria-label="Control groups">
            {hud.groups.map((g) => (
              <button key={g.key} onClick={() => recallGroup(g.key)} data-tip={`Group ${g.key}: ${g.count}. Press ${g.key} to select it, twice to look at it.`}>
                <b>{g.key}</b>
                <small>{g.count}</small>
              </button>
            ))}
          </div>
        )}

        <div className="ew-landtoasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="ew-landtoast">
              {t.text}
            </div>
          ))}
        </div>

        {hud?.place && (
          <KeptInside className="ew-modehint ew-landplacehint">
            <b>{hud.place.name}</b>
            {hud.place.cost > 0 && (
              <span className="ew-cost">
                {' '}
                <Icon name="credits" size={11} /> {fmt(hud.place.cost)}
              </span>
            )}
            <div className={hud.place.why ? 'ew-bad' : 'ew-good'}>{hud.place.why ?? 'It can go here.'}</div>
            <div className="ew-muted ew-small">
              {touchUi ? 'Drag it, or tap where it should go. Shift on: keep placing.' : <>Click to build it, Shift-click to keep placing. <kbd>Esc</kbd> or right-click to cancel.</>}
            </div>
            {touchUi && (
              <div className="ew-placebar">
                <button className="ew-go" onClick={() => confirmPlace(shiftOf())} disabled={!!hud.place.why}>
                  Build here
                </button>
                <button className="ew-menu-btn" onClick={endPlace}>
                  Cancel
                </button>
              </div>
            )}
          </KeptInside>
        )}

        {ui.mapOpen && (
          <div className="ew-landmap">
            <Frame title="Map" aside={<span className="ew-muted ew-small">1 v 1</span>}>
              <canvas
                ref={mini}
                className="ew-landmini"
                style={{ aspectRatio: `${map.grid.cols} / ${map.grid.rows}` }}
                onPointerDown={onMini}
                onPointerMove={(e) => (e.buttons === 1 || isTouch(e)) && onMini(e)}
                onPointerUp={() => miniPress.current.cancel()}
                onPointerCancel={() => miniPress.current.cancel()}
                data-tip={`${Click} to look there. ${touchUi ? 'Long-press' : 'Right-click'} to send the selection.`}
              />
            </Frame>
          </div>
        )}

        <TouchBar className="ew-battlebar ew-landtouchbar" />

        {sel && (
          <Selection
            sel={sel}
            phone={phone}
            open={ui.panel || !phone}
            onOpen={() => setUi((u) => ({ ...u, panel: !u.panel }))}
            onClear={() => select([])}
            onNarrow={(type, drop) => {
              const w2 = world.current!
              select(sel.ids.filter((id) => (w2.byId.get(id)?.type === type) !== drop))
            }}
            onBuild={(type) => (sound.click(), startPlace(type))}
            onTrain={train}
            onCancel={cancel}
            onStop={stop}
            touch={touchUi}
          />
        )}

        {ui.menu && (
          <div className="ew-pausebox ew-landmenu">
            <Frame title="Paused">
              <button className="ew-go" onClick={() => setMenu(false)}>
                Resume
              </button>
              <button className="ew-menu-btn" onClick={() => (sound.click(), onRestart())}>
                <Icon name="restart" size={18} /> Restart
              </button>
              <button className="ew-menu-btn" onClick={() => (sound.click(), onLeave())}>
                <Icon name="exit" size={18} /> Leave battle
              </button>
              <div className="ew-landdebug" role="group" aria-label="Debug (dev builds only)">
                <span className="ew-muted ew-small">Debug</span>
                {(['grid', 'heights', 'flags'] as const).map((k) => (
                  <button key={k} className={ui.debug[k] ? 'is-on' : ''} aria-pressed={ui.debug[k]} onClick={() => setDebug({ [k]: !ui.debug[k] })}>
                    {k[0].toUpperCase() + k.slice(1)}
                  </button>
                ))}
                <button className={ui.reveal ? 'is-on' : ''} aria-pressed={ui.reveal} onClick={() => setReveal(!ui.reveal)}>
                  Reveal map
                </button>
              </div>
            </Frame>
          </div>
        )}
      </WheelHost>
    </div>
  )
}

// --- The selection panel ------------------------------------------------------------------------

function Art({ card }: { card: { art: string; name: string } }) {
  return card.art ? <img src={card.art} alt="" /> : <span className="ew-art ew-landart">{card.name.slice(0, 1)}</span>
}

function Selection({ sel, phone, open, onOpen, onClear, onNarrow, onBuild, onTrain, onCancel, onStop, touch }: {
  sel: SelSnap
  phone: boolean
  open: boolean
  onOpen: () => void
  onClear: () => void
  onNarrow: (type: string, drop: boolean) => void
  onBuild: (type: string) => void
  onTrain: (id: number, type: string, five: boolean) => void
  onCancel: (id: number, index: number) => void
  onStop: () => void
  touch: boolean
}) {
  const one = sel.one
  const title = one ? one.name : `${sel.ids.length} selected`
  const body: ReactNode[] = []
  if (sel.kinds.length > 1)
    body.push(
      <div key="kinds" className="ew-landkinds">
        {sel.kinds.map((k) => (
          <button key={k.type} onClick={(e) => onNarrow(k.type, e.shiftKey)} data-tip={`${k.name}: ${touch ? 'tap' : 'click'} to keep only these${touch ? '' : ', Shift-click to drop them'}`}>
            {k.name} <b>×{k.count}</b>
          </button>
        ))}
      </div>,
    )
  if (one) {
    body.push(
      <div key="hull" className="ew-landhull">
        <span className="ew-muted ew-small">{one.ours ? 'Hull' : 'Enemy · hull'}</span>
        <Bar value={one.hull} max={one.max} kind="hull" />
        <small>
          {fmt(one.hull)} / {fmt(one.max)}
        </small>
      </div>,
    )
    if (one.site !== null)
      body.push(
        <div key="site" className="ew-landsite">
          <span>Under construction: {Math.round(one.site * 100)}%</span>
          <Bar value={one.site} max={1} kind="hp" />
          {one.ours && (
            <button className="ew-menu-btn" onClick={() => onCancel(one.id, -1)} data-tip="Call off the building (Delete). Refunds follow the usual rules.">
              Cancel construction
            </button>
          )}
        </div>,
      )
  } else if (sel.sites.length)
    body.push(
      <button key="sites" className="ew-menu-btn" onClick={() => sel.sites.forEach((id) => onCancel(id, -1))}>
        Cancel {sel.sites.length} site{sel.sites.length > 1 ? 's' : ''}
      </button>,
    )
  if (sel.vehicles)
    body.push(
      <p key="move" className="ew-muted ew-small ew-landhelp">
        {touch ? 'Long-press the ground to move (Shift on: queue).' : 'Right-click to move, Shift to queue.'}{' '}
        <button className="ew-landlink" onClick={onStop}>
          Stop
        </button>
      </p>,
    )
  if (sel.build)
    body.push(
      <section key="build" className="ew-landcards" aria-label="Build">
        <h6>Build</h6>
        {sel.build.length ? (
          <div className="ew-landcardrow">
            {sel.build.map((c) => (
              <button key={c.type} className="ew-shipcard" onClick={() => onBuild(c.type)} data-tip={`${c.name}: ${touch ? 'tap, then drag the ghost and confirm' : 'click, then click where it goes'}`}>
                <Art card={c} />
                <strong>{c.name}</strong>
                {c.cost > 0 && (
                  <span className="ew-cost">
                    <Icon name="credits" size={11} /> {fmt(c.cost)}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <p className="ew-muted ew-small">Building is not in the game yet.</p>
        )}
      </section>,
    )
  if (one?.ours && one.site === null && GROUND_UNIT[one.type]?.foot)
    body.push(
      <section key="train" className="ew-landcards" aria-label="Train">
        <h6>Train</h6>
        {one.trains ? (
          <div className="ew-landcardrow">
            {one.train.map((c) => (
              <button
                key={c.type}
                className={`ew-shipcard ${c.why ? 'is-off' : ''}`}
                onClick={(e) => onTrain(one.id, c.type, shiftOf(e))}
                onContextMenu={(e) => {
                  e.preventDefault()
                  const i = one.queue.items.lastIndexOf(c.type)
                  if (i >= 0) onCancel(one.id, i)
                }}
                data-tip={`${c.name}${c.why ? `\n${c.why}` : ''}\n${touch ? 'Tap to train one, Shift on for five.' : 'Click to train one, Shift-click for five, right-click to take one off the queue.'}`}
              >
                <Art card={c} />
                <strong>{c.name}</strong>
                {c.queued > 0 && <span className="ew-qbadge">{c.queued}</span>}
              </button>
            ))}
          </div>
        ) : (
          <p className="ew-muted ew-small">Training is not in the game yet.</p>
        )}
        {one.queue.items.length > 0 && (
          <div className="ew-landqueue" aria-label="Queue">
            {one.queue.items.map((t, i) => (
              <button key={i} onClick={() => onCancel(one.id, i)} data-tip={`${typeName(t)}${i === 0 ? `: ${Math.round(one.queue.progress * 100)}%` : ''}\n${touch ? 'Tap' : 'Click'} to cancel`}>
                <Art card={{ art: artOf(t), name: typeName(t) }} />
                {i === 0 && <i style={{ transform: `scaleX(${one.queue.progress})` }} />}
              </button>
            ))}
          </div>
        )}
        <p className="ew-muted ew-small ew-landhelp">{touch ? 'Long-press the ground: Rally here.' : 'Right-click the ground to set the rally point.'}</p>
      </section>,
    )
  if (phone && !open)
    return (
      <div className="ew-landselchip">
        <button className="ew-menu-btn" onClick={onOpen}>
          {title}
        </button>
        <button className="ew-menu-btn" onClick={onClear} aria-label="Deselect">
          ✕
        </button>
      </div>
    )
  return (
    <div className="ew-landsel">
      <Frame
        title={title}
        aside={
          <span className="ew-landsel-x">
            {phone && (
              <button onClick={onOpen} aria-label="Fold the panel">
                ▾
              </button>
            )}
            <button onClick={onClear} aria-label="Deselect">
              ✕
            </button>
          </span>
        }
      >
        <div className="ew-landsel-body">{body}</div>
      </Frame>
    </div>
  )
}

