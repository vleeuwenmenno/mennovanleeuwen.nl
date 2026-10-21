import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { DIFFICULTY, type Difficulty, type Profile } from './ai'
import { FACTION_IDS, FACTIONS, MODULE, ORBITAL_MAX, ORBITAL_TOP, REBUILD, UNIT, WORKS_NAME, buildable, modulesFor, moduleLook, orbitalName, orbitalSlots, orbitalSprite, orbitalType, stationType, yardOf, yardType, type FactionId, type ModuleId, type UnitType, type Works } from './data'
import {
  orbitalAt, orbitalCost, orbitalTime, orbitalsUp, parseOrbital, queueName, rebuildLevel, resetLayout,
  type StructId, type PlanetLayout,
  BLOCKADES, CAPTURE_TIME, DAY, GALAXIES, GALAXY_AI, blockadeIn, canSee, contested, known, ownerFor, sees, type BlockadeRule, H, MAX_YARD, PLANET_KINDS, SIZES, STAR_COLOR, STATION_COST, STATION_INCOME, STATION_TIME, W, WEEK,
  autoResolve, clashBattle, buildAt, buildWork, cantRushAt, queueShare, rushLaunch, rushOffered, rushSlot, RUSH_GC, calendar, cancelBuild, cantBuildAt, cantUpgradeStation, cantWork, isWork, isYard, worksUp, workCost, workLock, workName, workTime, yardLock, YARD_KINDS, clashAt, deleteSave, dropWaypoint, eta, factionName, fleetsAt, incomeOf, listSaves, loadSave, moveFleet, plannedHops, renameSave, routeTo, newGalaxy, planetIncome, saveGalaxy,
  galaxyProfile, rivalOf, settlePending, stopFleet, systemOwner, tickGalaxy, upgradeStation, withdraw,
  type Clash, type Fleet, type Galaxy, type GalaxyChoice, type GalaxySize, type Planet, type PlanetBase, type PlanetKind, type Side, type StarSystem, type WorkId, type YardKind,
} from './galaxy'
import { BuildPanel, BuildQueue, Floating, Frame, HpIcon, Icon, Pips, SelChip, ShipArt, ShipCard, Tips, storePage, storedPage, unitTip, type IconName } from './Hud'
import { HP_COLOR } from './icons'
import { resultOf } from './result'
import { FleetInventory } from './Inventory'
import { galaxyLayout } from './layout'
import type { BattleSnap } from './snapshot'
import { loadCampaignBattle, saveCampaignBattle, setResume } from './keep'
import { MAX_SEED, type MapDef } from './maps'
import { autoLayoutOf, mapToPolar, planetMap } from './conquestMap'
import { PlanetMapPanel, orbitFrame, placesOf, useShownLayout, type OrbitFrame } from './PlanetMap'
import { LayoutSection, Modal, SettingsPanel } from './Menus'
import { actionFor, getSettings, keyName, useSettings, type Action } from './settings'
import type { FleetSide, World } from './sim'
import type { EmpiresSound } from './sound'
import { LongPress, SELPOP_KEEP, TAP_SLOP, TouchBar, WheelHost, getTouchMods, isTouch, setTouchMod, shiftOf, useCoarse, useLongPressWheel, useTapAway, useWheel, type WheelItem, type WheelRequest } from './Touch'
import { OrbitView, PlanetDefense, orbitThings, type OrbitThing } from './Orbit'
import './touch-conquest.css'

// Galactic conquest's screens: the setup, then the galaxy map (systems, lanes and fleets), the
// view inside one system (its star and planets), the panels for a planet or a fleet, and the prompt
// when a battle starts. The campaign itself is galaxy.ts; battles are fought in the normal battle
// view (EmpiresAtWar.tsx), handed a ConquestBattle.

/** A fleet battle to fight in the battle view, and what to do with the world once it's over. */
export type ConquestBattle = {
  map: MapDef
  sides: FleetSide[]
  /** Which side (index into `sides`) the player is. */
  me: number
  ai: Difficulty
  /** How the AI empire plays (galaxyProfile); left out, Balanced. */
  profile?: Profile
  names: string[]
  onDone: (w: World, left: boolean) => void
  /** Saved mid-fight: the battle carries on from here. */
  resume?: BattleSnap | null
  /** Keeps it as it goes, for a reload of the window. */
  onSnap?: (s: BattleSnap | null) => void
}

const PLANET_ART = (kind: string) => `/games/empires/planets/${kind}.webp`
/** Right-click gives orders here, so it must not open the browser's or the window's menu. */
const noMenu = (e: React.MouseEvent) => {
  e.preventDefault()
  e.stopPropagation()
}
const ME = 0
const color = (g: Galaxy, o: number) => (o < 0 ? '#7d879c' : FACTIONS[g.sides[o].faction].color)
const fmt = (n: number) => Math.floor(n).toLocaleString('en-US')
/** Who blockades a system (whose fleets it stops), for drawing, as far as we know: the blockading
 * side and the side it stops, or null. */
const blockade = (g: Galaxy, s: number) => blockadeIn(g, s, ME)
const blockadeTip = (g: Galaxy, s: number) => {
  const b = blockade(g, s)
  if (!b) return ''
  return b.by === ME
    ? ` Our blockade: enemy fleets can't fly through ${g.systems[s].name}, only into it.`
    : ` Enemy blockade: our fleets can't fly through ${g.systems[s].name}, only into it.`
}
const secs = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.ceil(s)}s`)
/** The galaxy day (from 1) a moment of it falls on, for "last seen day N". */
const dayOf = (t: number) => calendar(Math.max(0, t)).day + 1
/** What a planet pays with a station of this level, before an AI's difficulty: what we can tell of
 * one we don't see. */
const knownIncome = (p: Planet, station: number) => Math.round(p.income * (1 + STATION_INCOME * station))
/** Fleets at a planet that we can see (all of them where we see the system). */
const seenAt = (g: Galaxy, planet: number) => fleetsAt(g, planet).filter((f) => canSee(g, ME, f))
/** What we know of a planet that's hidden from us, in a few words: who held it when we last looked,
 * its station and the ships we saw there. */
function lastSeen(g: Galaxy, p: Planet) {
  const k = known(g, ME, p)
  if (k.live) return ''
  const who = k.owner < 0 ? 'unclaimed' : k.owner === ME ? 'ours' : `held by the ${factionName(g, k.owner)}`
  const ships = k.ships < 0 ? 'no word of its fleets' : k.ships ? `${k.ships} enemy ship${k.ships > 1 ? 's' : ''} in orbit` : 'no ships in orbit'
  return `Hidden: no fleet or planet of ours in ${g.systems[p.system].name}. Last seen ${k.t <= 0 ? 'on the pre-war charts' : `on day ${dayOf(k.t)}`}: ${who}${k.station ? `, station level ${k.station}` : ''}, ${ships}.`
}

/** Ship ids counted by type, biggest first: [id, count]. */
function grouped(ships: string[]): [string, number][] {
  const m = new Map<string, number>()
  for (const id of ships) m.set(id, (m.get(id) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => UNIT[b[0]].cost - UNIT[a[0]].cost)
}

/** The campaign: `g` is held by the caller, so it outlasts the battle view. Without one, the
 * Galactic conquest menu: continue the latest save, load one, or start a new campaign. */
export function Conquest({ g, setG, session, sound, onExit, onBattle, start = 'new' }: {
  g: Galaxy | null
  setG: (g: Galaxy | null) => void
  /** The window's session (../session.ts): what a reload of the window comes back to. */
  session: string | undefined
  sound: EmpiresSound
  onExit: () => void
  onBattle: (b: ConquestBattle) => void
  /** Without a campaign: the new-game setup, or the list of saves to load. */
  start?: 'new' | 'load'
}) {
  const view = start
  // A campaign opened (or switched to) gets a fresh map view.
  const [opened, setOpened] = useState(0)
  const open = (next: Galaxy) => {
    saveGalaxy(next)
    setOpened((n) => n + 1)
    setG(next)
  }
  // While a campaign is open, a reload of the page comes straight back to it (closing the window
  // forgets that; the campaign stays in its save slot).
  useEffect(() => {
    if (g) setResume(session, g.save.id)
  }, [g, session])
  const leave = () => {
    setResume(session, null)
    onExit()
  }
  if (!g) {
    if (view === 'load')
      return (
        <ConquestFrame sound={sound} title="Load game" onBack={leave}>
          <SaveList sound={sound} onLoad={open} />
          <div className="ew-menu-list is-row">
            <button className="ew-menu-btn" onClick={() => (sound.click(), leave())}><Icon name="back" size={18} /> Back</button>
          </div>
        </ConquestFrame>
      )
    return <ConquestSetup sound={sound} onBack={leave} onStart={open} />
  }
  return (
    <GalaxyMap
      key={opened}
      g={g}
      session={session}
      sound={sound}
      onExit={() => {
        saveGalaxy(g)
        leave()
      }}
      onAbandon={() => {
        saveCampaignBattle(session, g.save.id, null)
        deleteSave(g.save.id)
        setG(null)
        leave()
      }}
      onEnd={() => {
        saveCampaignBattle(session, g.save.id, null)
        deleteSave(g.save.id)
        setG(null)
        leave()
      }}
      onLoad={open}
      onBattle={onBattle}
    />
  )
}

// --- The Galactic conquest menu ---------------------------------------------------------------------------

/** When a save was made, the way people say it: "just now", "5 minutes ago", "yesterday", a date. */
function ago(t: number) {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 172800) return 'yesterday'
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** A menu screen over the title art, framed like the main menu's, with Esc going back. */
function ConquestFrame({ sound, title, onBack, children, wide = false }: { sound: EmpiresSound; title: string; onBack: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement)?.closest?.('input')) return
      sound.click()
      onBack()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onBack, sound])
  return (
    <div className="ew-root ew-deck ew-menu ew-gsetup" style={{ backgroundImage: 'url(/games/empires/world/title.webp)' }} onContextMenu={noMenu}>
      <Tips />
      <Frame className={`ew-gsetup-frame ${wide ? '' : 'is-narrow'}`} title={title} aside={<button className="ew-close" onClick={() => (sound.click(), onBack())} aria-label="Back">✕</button>}>
        {children}
      </Frame>
    </div>
  )
}

/** Every saved campaign, newest first: load one, rename it, or delete it (asked once more). */
function SaveList({ sound, onLoad, current }: { sound: EmpiresSound; onLoad: (g: Galaxy) => void; current?: string }) {
  const [saves, setSaves] = useState(() => listSaves())
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const refresh = () => setSaves(listSaves())
  const load = (id: string) => {
    const g = loadSave(id)
    if (!g) return sound.error()
    sound.click()
    onLoad(g)
  }
  if (!saves.length) return <p className="ew-muted">No saved campaigns yet.</p>
  return (
    <div className="ew-saves">
      {saves.map((s) => (
        <div key={s.id} className={`ew-save ${s.id === current ? 'is-current' : ''}`}>
          <img src={FACTIONS[s.faction].emblem} alt="" />
          {renaming?.id === s.id ? (
            <form className="ew-save-name" onSubmit={(e) => {
              e.preventDefault()
              renameSave(s.id, renaming.name)
              setRenaming(null)
              refresh()
              sound.click()
            }}>
              <input autoFocus value={renaming.name} maxLength={40} onChange={(e) => setRenaming({ id: s.id, name: e.target.value })}
                onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setRenaming(null))} aria-label="Save name" />
              <button type="submit" className="ew-bm-mini is-primary" disabled={!renaming.name.trim()}>Rename</button>
              <button type="button" className="ew-bm-mini" onClick={() => setRenaming(null)}>Cancel</button>
            </form>
          ) : (
            <span className="ew-save-info">
              <b>{s.name}{s.id === current ? <small className="ew-muted"> (playing)</small> : null}</b>
              <small className="ew-muted">{s.galaxy} · week {s.week} · {s.planets} planets ours, {s.enemy} theirs, of {s.total} · saved {ago(s.savedAt)}</small>
            </span>
          )}
          {deleting === s.id ? (
            <span className="ew-save-btns">
              <span className="ew-small">Delete it for good?</span>
              <button className="ew-bm-mini is-x" onClick={() => {
                deleteSave(s.id)
                setDeleting(null)
                refresh()
                sound.click()
              }}>Delete</button>
              <button className="ew-bm-mini" onClick={() => setDeleting(null)}>Cancel</button>
            </span>
          ) : renaming?.id !== s.id && (
            <span className="ew-save-btns">
              <button className="ew-bm-mini is-primary" onClick={() => load(s.id)} disabled={s.id === current}>Load</button>
              {s.id !== current && <button className="ew-bm-mini" onClick={() => setRenaming({ id: s.id, name: s.name })}>Rename</button>}
              {s.id !== current && <button className="ew-bm-mini is-x" onClick={() => setDeleting(s.id)} aria-label={`Delete ${s.name}`} data-tip="Delete this save">×</button>}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

// --- Setup -----------------------------------------------------------------------------------------------

function ConquestSetup({ sound, onBack, onStart }: { sound: EmpiresSound; onBack: () => void; onStart: (g: Galaxy) => void }) {
  const [kind, setKind] = useState<'rim' | 'generated'>('rim')
  const [seed, setSeed] = useState(() => 1 + Math.floor(Math.random() * 9999))
  const [size, setSize] = useState<GalaxySize>('standard')
  const [faction, setFaction] = useState<FactionId>('republic')
  // The AI's side: picked, or (null) the player's side's usual rival. Never the player's own.
  const [rivalPick, setRival] = useState<FactionId | null>(null)
  const rival = rivalOf({ faction, rival: rivalPick ?? undefined })
  const sides = FACTION_IDS
  const [difficulty, setDifficulty] = useState<Difficulty>('easy')
  const [credits, setCredits] = useState(3000)
  const [name, setName] = useState('')
  const [blockadeRule, setBlockadeRule] = useState<BlockadeRule>('majority')
  const [frontline, setFrontline] = useState(true)
  const choice: GalaxyChoice = kind === 'rim' ? { kind: 'rim' } : { kind: 'generated', seed }
  const preview = useMemo(() => newGalaxy({ choice, size, faction, rival, difficulty, credits }), [kind, seed, size, faction, rival, difficulty, credits]) // eslint-disable-line react-hooks/exhaustive-deps
  const click = (fn: () => void) => () => {
    sound.unlock()
    sound.click()
    fn()
  }
  return (
    <ConquestFrame sound={sound} title="New campaign · Galactic conquest (beta)" onBack={onBack} wide>
        <div className="ew-gsetup-body">
          <div className="ew-gsetup-opts">
            <Field label="Name">
              <input className="ew-gname-in" value={name} maxLength={40} placeholder={preview.save.name} onChange={(e) => setName(e.target.value)} aria-label="Campaign name" />
            </Field>
            <Field label="Galaxy">
              <Seg value={kind} options={[['rim', GALAXIES.rim.name], ['generated', 'Generated']]} onChange={(v) => setKind(v)} />
            </Field>
            {kind === 'generated' ? (
              <Field label="Seed">
                <span className="ew-gseed">
                  <input type="number" min={1} max={MAX_SEED} value={seed} onChange={(e) => setSeed(Math.max(1, Math.min(MAX_SEED, Math.floor(Number(e.target.value) || 1))))} />
                  <button onClick={click(() => setSeed(1 + Math.floor(Math.random() * MAX_SEED)))} data-tip="A random seed" aria-label="Random seed"><Icon name="dice" size={16} /></button>
                </span>
              </Field>
            ) : (
              <p className="ew-muted ew-small">{GALAXIES.rim.blurb}</p>
            )}
            <Field label="Length">
              <Seg value={size} options={(Object.keys(SIZES) as GalaxySize[]).map((k) => [k, SIZES[k].label] as [GalaxySize, string])} onChange={setSize} />
            </Field>
            <p className="ew-muted ew-small">{SIZES[size].blurb}. {preview.systems.length} systems, {preview.planets.length} planets.</p>
            <Field label="Your side">
              <Seg value={faction} options={sides.map((f) => [f, FACTIONS[f].name] as [FactionId, string])} onChange={setFaction} />
            </Field>
            <Field label="Enemy side">
              <Seg value={rival} options={sides.filter((f) => f !== faction).map((f) => [f, FACTIONS[f].name] as [FactionId, string])} onChange={setRival} />
            </Field>
            <Field label="Enemy admiral">
              <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)} data-tip={GALAXY_AI[difficulty].blurb}>
                {(Object.keys(DIFFICULTY) as Difficulty[]).map((d) => <option key={d} value={d}>{DIFFICULTY[d].name}</option>)}
              </select>
            </Field>
            <Field label="Starting credits">
              <Seg value={credits} options={[[1500, '1,500'], [3000, '3,000'], [6000, '6,000']]} onChange={setCredits} />
            </Field>
            <Field label="Blockades">
              <Seg value={blockadeRule} options={(Object.keys(BLOCKADES) as BlockadeRule[]).map((k) => [k, BLOCKADES[k].label] as [BlockadeRule, string])} onChange={setBlockadeRule} />
            </Field>
            <p className="ew-muted ew-small">{BLOCKADES[blockadeRule].blurb} Fleets can always fly into a blockaded system to fight for it.</p>
            <Field label="Front lines">
              <Seg value={frontline} options={[[true, 'On'], [false, 'Off']] as [boolean, string][]} onChange={setFrontline} />
            </Field>
            <p className="ew-muted ew-small">
              {frontline
                ? 'A fleet in a system its side doesn\'t control can\'t jump on into another enemy-held system: it must win the system first, or fall back. No hopping deep behind the lines.'
                : 'Fleets may jump from any system straight into any enemy system next to it.'}
            </p>
            <div className="ew-menu-list is-row">
              <button className="ew-menu-btn" onClick={click(onBack)}><Icon name="back" size={18} /> Back</button>
              <button className="ew-menu-btn is-primary" onClick={click(() => onStart(newGalaxy({ choice, size, faction, rival, difficulty, credits, name, blockade: blockadeRule, frontline })))}>
                <Icon name="play" size={18} /> Start
              </button>
            </div>
            <p className="ew-muted ew-small">It saves by itself as you play, under this name. Other campaigns stay saved alongside it.</p>
          </div>
          <div className="ew-gsetup-preview">
            <GalaxyView g={preview} mini />
          </div>
        </div>
    </ConquestFrame>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="ew-row">
      <span>{label}</span>
      {children}
    </label>
  )
}
function Seg<T extends string | number | boolean>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <span className="ew-seg" role="radiogroup">
      {options.map(([v, l]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={v === value} className={v === value ? 'is-on' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </span>
  )
}

// --- The galaxy map -----------------------------------------------------------------------------------

type Sel = { kind: 'fleet'; id: number } | { kind: 'fleets'; ids: number[] } | { kind: 'planet'; id: number } | { kind: 'planets'; ids: number[] } | null
/** The fleets a selection holds. */
const selectedIds = (sel: Sel) => new Set(sel?.kind === 'fleet' ? [sel.id] : sel?.kind === 'fleets' ? sel.ids : [])
/** The planets a selection holds. */
const selectedPlanets = (sel: Sel) => new Set(sel?.kind === 'planet' ? [sel.id] : sel?.kind === 'planets' ? sel.ids : [])
/** Where a message takes the camera when it's clicked: a planet (selected), our fleet at a planet
 * (selected; the planet if the fleet has gone), a fleet wherever it is now, or a whole system. */
type GLook = { k: 'planet'; id: number } | { k: 'fleetAt'; planet: number } | { k: 'fleet'; id: number; planet: number } | { k: 'system'; id: number }
type GToast = { id: number; text: string; tone: 'good' | 'bad' | 'info'; t: number; to?: GLook }

// --- The map: one view from the whole galaxy down to a single planet ---------------------------------

/** Planets orbit their star inside the system's spot on the galaxy map, in galaxy units. */
const orbitOf = (i: number) => {
  const rx = 7.5 + i * 5.6
  return { rx, ry: rx * 0.58 }
}
const planetR = (p: Planet) => 1.15 * p.size
export function planetAt(g: Galaxy, p: Planet) {
  const s = g.systems[p.system]
  const o = orbitOf(p.orbit)
  return { x: s.x + Math.cos(p.angle) * o.rx, y: s.y + Math.sin(p.angle) * o.ry }
}
/** How far a system's planets reach from its star. */
const reach = (g: Galaxy, s: number) => orbitOf(Math.max(0, ...g.systems[s].planets.map((p) => g.planets[p].orbit))).rx + 3

type Cam = { x: number; y: number; k: number }
/** How hard zooming in draws the spot under the cursor to the centre (under a tenth of the way a notch). */
const ZOOM_PULL = 0.33
/** Closest the map zooms in: a planet fills a good part of the view. */
const K_MAX = 140
/**
 * The orbit view (see Orbit.tsx and PlanetMap.tsx): zooming in past a planet locks the camera onto
 * it. It settles at the zoom where the planet and everything round it (ORBIT_REACH planet radii out)
 * fits beside its battle map's panel, the planet a little smaller and to one side (above it on a tall
 * screen), and goes no closer (K_ORBIT_MAX at most). Zooming in further than ORBIT_SNAP of that (or of
 * K_MAX, on a big screen) with the planet under the cursor eases into it, the panel fading and sliding
 * in as it comes, and zooming out below ORBIT_LEAVE of it lets go. Its pictures fade in as it's
 * entered and out over ORBIT_FADE_MS as it's left, rather than coming and going at once.
 */
const K_ORBIT_MAX = 420
const ORBIT_REACH = 3.05
const ORBIT_SNAP = 0.85
const ORBIT_LEAVE = 0.7
const ORBIT_FADE_MS = 300
/**
 * The camera's glides (see GalaxyMap's clock). The zoom (as its log, so each doubling takes as long)
 * and where one world point sits on screen each follow a critically damped spring: a glide starts
 * from however the camera was already moving (a wheel spin carries into the snap into the orbit
 * view), never overshoots where it's going, and a new aim on the way (another notch, a snap) bends it
 * instead of jerking it. The stiffness is per kind of glide: the wheel's quick, a flight and the
 * orbit view's slower (a spring settles to within 1% in about 6.6 / w seconds).
 */
const W_WHEEL = 26
const W_FLY = 10
const W_ORBIT = 11
const W_MAX = 60
type Glide = {
  /** 'wheel': a wheel zoom round the cursor; 'fly': a flight somewhere; 'orbit': into (and in) the
   * orbit view, the planet heading for its place beside the battle map. */
  kind: 'wheel' | 'fly' | 'orbit'
  /** The world point the glide holds on to, where it is on screen (from the view's centre), how fast
   * that moves (px/s) and where it's going. */
  ax: number
  ay: number
  sx: number
  sy: number
  vx: number
  vy: number
  tx: number
  ty: number
  /** The zoom's log, how fast it changes (per second) and where it's going. */
  lk: number
  vk: number
  gk: number
  /** The springs' stiffness: the place's and the zoom's. */
  wp: number
  wk: number
  /** Where the cursor was for a wheel zoom (more notches there carry on with the same spot). */
  cx: number
  cy: number
}
/** `dt` seconds of a critically damped spring of stiffness `w` taking x (moving at v) to g, solved
 * exactly, so it moves the same however the frames fall. */
const spring = (x: number, v: number, g: number, w: number, dt: number): [number, number] => {
  const y = x - g
  const c = v + w * y
  const e = Math.exp(-w * dt)
  return [g + (y + c * dt) * e, (v - w * c * dt) * e]
}
/** Sets a glide's springs for its new aim: stiffness `wp` and `wk`, or stiffer where it's already
 * closing in faster than that (a spring that stiff only slows down: no overshoot, no lurch). */
const aimGlide = (G: Glide, wp: number, wk: number) => {
  const yk = G.lk - G.gk
  const ck = -G.vk * Math.sign(yk)
  G.wk = ck > wk * Math.abs(yk) ? Math.min(W_MAX, ck / Math.abs(yk)) : wk
  if (ck > W_MAX * Math.abs(yk)) G.vk = -Math.sign(yk) * W_MAX * Math.abs(yk)
  const yx = G.sx - G.tx
  const yy = G.sy - G.ty
  const d = Math.hypot(yx, yy)
  const cp = d > 1e-6 ? -(G.vx * yx + G.vy * yy) / d : 0
  G.wp = cp > wp * d ? Math.min(W_MAX, cp / d) : wp
  if (cp > W_MAX * d) {
    const cut = (cp - W_MAX * d) / d
    G.vx += cut * yx
    G.vy += cut * yy
  }
}
/** The player asked for less motion: flights and the orbit view's ease go at once (the wheel still
 * glides its short way, as it follows the hand). */
const reducedMQ = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
const reducedMotion = () => !!reducedMQ?.matches
/** Where planet `p` and its battle map sit in the orbit view, in a view of `size`. */
const orbitFrameOf = (g: Galaxy, p: Planet, size: { w: number; h: number }): OrbitFrame => {
  const m = planetMap(g, p.id).map
  return orbitFrame(size, ORBIT_REACH * 2 * planetR(p), m.w / m.h, 20, K_ORBIT_MAX)
}
/** Where planet `p`'s structures are pictured round it: its layout on its battle map (as we know
 * it: `layout`, else the default) turned back round the planet. */
const ringSpots = (g: Galaxy, p: Planet, layout: PlanetLayout | undefined) => {
  const pm = planetMap(g, p.id)
  return mapToPolar(pm.map, { ...autoLayoutOf(pm), ...(layout ?? {}) })
}
const fitK = (w: number, h: number) => Math.min(w / W, h / H) * 0.94
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
/** How far into the systems the view is: 0 shows the galaxy's markers, 1 the planets themselves. */
const detail = (k: number) => clamp((k - 2.4) / 2.6, 0, 1)

/** Where a fleet is: at its planet, or between where it left and where it's going. */
function fleetAt(g: Galaxy, f: Fleet) {
  if (!f.leg) return { ...(f.planet >= 0 ? planetAt(g, g.planets[f.planet]) : g.systems[f.system]), moving: false, angle: 0 }
  const from = f.from >= 0 && g.planets[f.from].system === f.system ? planetAt(g, g.planets[f.from]) : g.systems[f.system]
  const to = f.leg.planet >= 0 ? planetAt(g, g.planets[f.leg.planet]) : g.systems[f.leg.system]
  const t = 1 - f.leg.left / f.leg.total
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, moving: true, angle: Math.atan2(to.y - from.y, to.x - from.x) }
}

/** Over a planet being taken: who's taking it, how far along, and the seconds left (screen pixels). */
function CaptureTag({ g, p }: { g: Galaxy; p: Planet }) {
  if (!p.capture) return null
  const ours = p.capture.owner === ME
  const f = p.capture.t / CAPTURE_TIME
  const text = `${ours ? 'Taking' : p.owner === ME ? 'Losing' : 'Enemy taking'} · ${Math.ceil(CAPTURE_TIME - p.capture.t)} s`
  const w = 118
  return (
    <g transform="translate(0 -14)" className="ew-gcap">
      <rect x={-w / 2} y={-26} width={w} height={24} rx={5} fill="rgba(6,10,22,0.9)" stroke={color(g, p.capture.owner)} />
      <text x={0} y={-15} className="ew-gcaptag">{text}</text>
      <rect x={-w / 2 + 7} y={-9} width={w - 14} height={3} rx={1.5} fill="rgba(255,255,255,0.15)" />
      <rect x={-w / 2 + 7} y={-9} width={(w - 14) * f} height={3} rx={1.5} fill={color(g, p.capture.owner)} />
    </g>
  )
}

/** A ring of `n` points `r` out, the first `a0` round from the right: an octagon, a hexagon. */
const ringPts = (n: number, r: number, a0 = 0) => Array.from({ length: n }, (_, i) => `${+(Math.cos(a0 + (i / n) * Math.PI * 2) * r).toFixed(3)},${+(Math.sin(a0 + (i / n) * Math.PI * 2) * r).toFixed(3)}`).join(' ')
const OCTAGON = ringPts(8, 9.5, Math.PI / 8)
const HEXAGON = ringPts(6, 7.5, Math.PI / 6)
/**
 * A structure round a planet as a small icon, for the zoom between the system and the orbit view
 * (drawn in vector, so nothing is painted for it while the map zooms): the Command Station an octagon
 * with its level, a yard its slipway (the Capital Yard's longer), a defense station a hexagon with its
 * level, filled once it has a module; a ruin dashed and greyed.
 */
function StructIcon({ th, stroke, level, faded }: { th: OrbitThing; stroke: string; level: number; faded: boolean }) {
  const ruin = th.state === 'ruin'
  const s = ruin ? 'rgba(170, 176, 190, 0.85)' : stroke
  const line = { fill: '#0b1226', stroke: s, strokeWidth: 1.5, strokeDasharray: ruin || faded ? '2 2' : undefined, opacity: ruin ? 0.75 : 1 }
  if (th.id === 'station')
    return (
      <>
        <polygon points={OCTAGON} {...line} />
        <text y={3.6} className="ew-slv is-small">{level}</text>
      </>
    )
  if (th.id === 'yard' || th.id === 'cyard') {
    const [w, h] = th.id === 'cyard' ? [11, 19] : [9, 15]
    return (
      <>
        <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={2} {...line} />
        <path d={`M0 ${n4(-h / 2 + 3)} V${n4(h / 2 - 3)}${th.id === 'cyard' ? ` M-2.5 ${n4(-h / 2 + 4)} V${n4(h / 2 - 4)} M2.5 ${n4(-h / 2 + 4)} V${n4(h / 2 - 4)}` : ''}`} stroke={s} strokeWidth={1} opacity={ruin ? 0.6 : 0.9} />
      </>
    )
  }
  const o = th.t.orbital
  const armed = !ruin && !!o?.slots.some(Boolean)
  return (
    <>
      <polygon points={HEXAGON} {...line} fill={armed ? stroke : line.fill} fillOpacity={armed ? 0.35 : 1} />
      <text y={3.2} className="ew-slv is-small">{o?.level ?? 1}</text>
    </>
  )
}

/** Where a planet is on screen, for picking with a box: zoomed out, where its system's star is. */
function planetScreen(g: Galaxy, p: Planet, cam: Cam, size: { w: number; h: number }) {
  const q = detail(cam.k) < 0.5 ? g.systems[p.system] : planetAt(g, p)
  return { x: (q.x - cam.x) * cam.k + size.w / 2, y: (q.y - cam.y) * cam.k + size.h / 2 }
}

/** Where a fleet's badge is drawn on screen (as GalaxyView places it), for picking with a box. */
function fleetScreen(g: Galaxy, f: Fleet, cam: Cam, size: { w: number; h: number }) {
  const k = cam.k
  const at = (x: number, y: number) => ({ x: (x - cam.x) * k + size.w / 2, y: (y - cam.y) * k + size.h / 2 })
  if (!f.leg && detail(k) < 0.5) {
    const s = at(g.systems[f.system].x, g.systems[f.system].y)
    return { x: s.x + (f.owner === ME ? -24 : 24), y: s.y - 16 }
  }
  const p = fleetAt(g, f)
  const s = at(p.x, p.y)
  if (f.leg || f.planet < 0) return s
  return { x: s.x + planetR(g.planets[f.planet]) * k + 26, y: s.y - 8 + seenAt(g, f.planet).indexOf(f) * 22 }
}

/**
 * The map's camera, kept out of React. Moving it re-aims the map (`placeRegion`, and at a zoom
 * `drawRegion`: see Region) and sets the CSS
 * variables its drawing scales by (`scaleVars`), so zooming and panning re-render nothing; only
 * what switches at a step of the zoom (`zoomBand`) and the few readouts that follow the camera (the
 * bar's place name, the minimap's frame) listen, and they redraw only when what they show changes.
 */
class CamView {
  cam: Cam
  size = { w: 800, h: 520 }
  private subs = new Set<() => void>()
  private ticks = new Set<() => void>()
  constructor(cam: Cam) {
    this.cam = cam
  }
  set(c: Cam) {
    this.cam = c
    for (const f of this.subs) f()
  }
  sub = (f: () => void) => {
    this.subs.add(f)
    return () => {
      this.subs.delete(f)
    }
  }
  /** The galaxy's clock moved on (every frame while it runs, between the map's redraws ten times a
   * second): what moves by itself (the fleets in flight) follows it here, without a render. */
  tick() {
    for (const f of this.ticks) f()
  }
  onTick = (f: () => void) => {
    this.ticks.add(f)
    return () => {
      this.ticks.delete(f)
    }
  }
}
const noSub = () => () => {}

/** What changes only at a step of the zoom, as bits: what is drawn, rather than how big. */
const B_OPEN = 1 // the systems open up into their planets (detail > 0)
const B_DOTS = 2 // the planets still show as dots round the star (detail < 1)
const B_BIG = 4 // the system's name goes over its planets (detail > 0.3)
const B_PARKED = 8 // the fleets in a system show as one badge a side (detail < 0.5)
const B_NEAR = 16 // a system takes clicks round its planets, not only its star (detail > 0.5)
const B_CAPRING = 32 // a planet being taken shows as a ring round the system (detail < 0.6)
const B_NAMES = 64 // the planets' names show (zoom > 7)
const B_GLOW = 128 // the blockade's glow shows (zoom < 6; see glowRings)
const B_BASE = 256 // what stands round each planet shows as small pictures round it (zoom > 9)
function zoomBand(k: number) {
  const d = detail(k)
  return (d > 0 ? B_OPEN : 0) | (d < 1 ? B_DOTS : 0) | (d > 0.3 ? B_BIG : 0) | (d < 0.5 ? B_PARKED : 0) | (d > 0.5 ? B_NEAR : 0) | (d < 0.6 ? B_CAPRING : 0) | (k > 7 ? B_NAMES : 0) | (k < 6 ? B_GLOW : 0) | (k > 9 ? B_BASE : 0)
}
/** The setup's preview: the whole galaxy, at no zoom (and no planet names). */
const MINI_BAND = zoomBand(1) & ~B_NAMES

/**
 * What the map's moving layer (.ew-gpan) has drawn: a region of the map (in map units) at the zoom
 * `k`, from (x0, y0), `w` by `h` screen pixels. A pan that stays inside it only moves the layer,
 * which is the compositor's work: nothing is laid out, painted or rastered again, however much is on
 * the map. A zoom draws it again at the new zoom, round the view and little more (`ZOOM_REACH`);
 * once the zoom has settled (`WIDEN_MS`), or a pan leaves it, it's drawn again reaching well past
 * the view on every side (`panReach`), ready for the next pan.
 */
type Region = { x0: number; y0: number; w: number; h: number; k: number; wide: boolean }
/** Screen pixels past the view the region reaches while zooming: enough to cover the layer's
 * rounding to whole pixels. */
const ZOOM_REACH = 24
/** How long after the last step of a zoom the region widens for panning. */
const WIDEN_MS = 160
/** Screen pixels past the view the region reaches for panning, across and down: half a view each
 * way (a pan leaving that draws it again round where it got to). */
const panReach = (size: { w: number; h: number }) => ({ x: Math.max(400, Math.round(size.w / 2)), y: Math.max(300, Math.round(size.h / 2)) })
const dpr = () => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
/** A screen length rounded to whole device pixels: the layer moves by those, so it's never drawn
 * between pixels (which would blur its lines and text). */
const snap = (v: number) => Math.round(v * dpr()) / dpr()
function regionAt(c: Cam, size: { w: number; h: number }, wide: boolean): Region {
  const reach = wide ? panReach(size) : { x: ZOOM_REACH, y: ZOOM_REACH }
  // No further than any view at this zoom can go: the camera's centre stays on the galaxy.
  const hw = size.w / 2 / c.k
  const hh = size.h / 2 / c.k
  const z = ZOOM_REACH / c.k
  const x0 = Math.max(c.x - hw - reach.x / c.k, Math.min(c.x, 0) - hw - z)
  const y0 = Math.max(c.y - hh - reach.y / c.k, Math.min(c.y, 0) - hh - z)
  const x1 = Math.min(c.x + hw + reach.x / c.k, Math.max(c.x, W) + hw + z)
  const y1 = Math.min(c.y + hh + reach.y / c.k, Math.max(c.y, H) + hh + z)
  // Its corner on a whole pixel of the screen as the camera is now, so it starts out sharp.
  const sx = snap((x0 - c.x) * c.k + size.w / 2)
  const sy = snap((y0 - c.y) * c.k + size.h / 2)
  const r = { x0: c.x + (sx - size.w / 2) / c.k, y0: c.y + (sy - size.h / 2) / c.k }
  return { ...r, w: Math.ceil((x1 - r.x0) * c.k), h: Math.ceil((y1 - r.y0) * c.k), k: c.k, wide }
}
/** Whether the region covers what the camera shows. */
const covers = (r: Region, c: Cam, size: { w: number; h: number }) => {
  if (r.k !== c.k) return false
  const x = (r.x0 - c.x) * c.k + size.w / 2
  const y = (r.y0 - c.y) * c.k + size.h / 2
  // (A pixel to spare: the layer moves by whole pixels.)
  return x <= -1 && y <= -1 && x + r.w >= size.w + 1 && y + r.h >= size.h + 1
}
/** Draws the region: the SVG's view of it, and the transform of the layers under and over it, in
 * map units from its corner. */
function drawRegion(svg: SVGSVGElement, under: HTMLElement, over: HTMLElement, r: Region) {
  svg.setAttribute('viewBox', `${r.x0} ${r.y0} ${r.w / r.k} ${r.h / r.k}`)
  const w = `${r.w}px`
  const h = `${r.h}px`
  for (const el of [svg, under.parentElement!, over.parentElement!] as (HTMLElement | SVGSVGElement)[])
    if (el.style.width !== w || el.style.height !== h) {
      el.style.width = w
      el.style.height = h
    }
  const t = `scale(${r.k}) translate(${-r.x0}px, ${-r.y0}px)`
  under.style.transform = t
  over.style.transform = t
}
/** Moves the layer so the region sits where the camera has it. */
function placeRegion(pan: HTMLElement, r: Region, c: Cam, size: { w: number; h: number }) {
  const t = `translate(${snap((r.x0 - c.x) * c.k + size.w / 2)}px, ${snap((r.y0 - c.y) * c.k + size.h / 2)}px)`
  if (pan.style.transform !== t) pan.style.transform = t
}

/**
 * The variables the map's drawing scales by: --ik, one over the zoom (markers and text keep their
 * size on screen); --d, how far into the systems the view is (see `detail`); --nm, how far the
 * planets' names have faded in. They are registered as not inherited
 * (see empires.css) and set on each element that uses them, not once on the map: a variable that
 * changes on the map's root restyles every element under it, every frame of a zoom (about 3 ms a
 * frame in a late game), where this restyles only the elements that use them, and only those
 * on screen.
 */
type ScaleUser = { el: HTMLElement | SVGElement; root: Element | null; uses: boolean[]; set: string[]; lo: number }
const VARS = ['--ik', '--d', '--nm'] as const
const varsAt = (k: number) => [String(1 / k), String(detail(k)), String(clamp((k - 7) / 4, 0, 1))]
/** The elements that use the variables (their inline style does), which of them each uses (setting
 * one it doesn't use still restyles it, and an SVG text lays itself out again), and the culled
 * thing each is in. An element with `data-ik-lo` takes --ik no lower than that: a size of
 * `n * --ik` pixels on screen but at least `n * lo` map units, as `max()` would have it, except that
 * once the zoom has passed where the map units take over its --ik stays put, and zooming further
 * doesn't restyle it at all. */
function scaleUsers(box: Element): ScaleUser[] {
  return [...box.querySelectorAll<HTMLElement | SVGElement>('[style*="var(--"]')].map((el) => {
    const style = el.getAttribute('style') ?? ''
    return { el, root: el.closest('[data-cull]'), uses: VARS.map((v) => style.includes(`var(${v})`)), set: VARS.map(() => ''), lo: Number(el.getAttribute('data-ik-lo') ?? 0) }
  })
}
function scaleVars(users: ScaleUser[], k: number) {
  const v = varsAt(k)
  for (const u of users) {
    if (u.root?.hasAttribute('data-off')) continue
    for (let i = 0; i < VARS.length; i++) {
      const val = i === 0 && u.lo > 1 / k ? String(u.lo) : v[i]
      if (u.uses[i] && u.set[i] !== val) {
        u.el.style.setProperty(VARS[i], val)
        u.set[i] = val
      }
    }
  }
}

/** Where each lane is drawn at the zoom's detail `d`: opened-up systems, it starts at the edge of
 * each one's planets. */
function laneEnds(g: Galaxy, d: number) {
  return g.lanes.map(([a, b]) => {
    const A = g.systems[a]
    const B = g.systems[b]
    const len = Math.hypot(B.x - A.x, B.y - A.y) || 1
    const ta = (d * reach(g, a)) / len
    const tb = (d * reach(g, b)) / len
    return [A.x + (B.x - A.x) * ta, A.y + (B.y - A.y) * ta, B.x - (B.x - A.x) * tb, B.y - (B.y - A.y) * tb]
  })
}

/** Something on the map that is left out (display: none) while it's well outside what the map's
 * layer has drawn (see Region), so a close view restyles, lays out and paints only round what it
 * shows: at (x, y), reaching r map units, and CULL_PX screen pixels further for its markers and text. */
type Culled = { el: Element; x: number; y: number; r: number }
const CULL_PX = 160
function cull(list: Culled[], reg: Region) {
  const m = CULL_PX / reg.k
  const x0 = reg.x0 - m
  const y0 = reg.y0 - m
  const x1 = reg.x0 + reg.w / reg.k + m
  const y1 = reg.y0 + reg.h / reg.k + m
  for (const { el, x, y, r } of list) {
    const off = x + r < x0 || x - r > x1 || y + r < y0 || y - r > y1
    if (off !== el.hasAttribute('data-off')) {
      if (off) el.setAttribute('data-off', '')
      else el.removeAttribute('data-off')
    }
  }
}
const cullAt = (x: number, y: number, r: number) => `${n4(x)} ${n4(y)} ${n4(r)}`
/** What a render draws, in map units: three views across round the camera of the time (so a close
 * view doesn't draw the whole galaxy at each tick of the clock), with the culling's margin. When
 * what the camera shows (with that margin) leaves it, the map is drawn again. */
type Area = { x0: number; x1: number; y0: number; y1: number }
const areaAt = (c: Cam, size: { w: number; h: number }, views: number): Area => {
  const hw = (views * size.w) / 2 / c.k + CULL_PX / c.k
  const hh = (views * size.h) / 2 / c.k + CULL_PX / c.k
  return { x0: c.x - hw, x1: c.x + hw, y0: c.y - hh, y1: c.y + hh }
}
const within = (a: Area | null, x: number, y: number, r: number) => !a || (x + r > a.x0 && x - r < a.x1 && y + r > a.y0 && y - r < a.y1)

/** A blockade ring's glow, as its old CSS drop-shadow drew it (a blur with a standard deviation
 * of 4 map units, in the side's glow colour) but as rings rather than a filter: a filter
 * is a pass of its own for each ring, every frame of a zoom. Blurred that wide, the dashed stroke
 * is a gaussian band round the ring: here four nested rings (widths in map units, as the blur's),
 * and its strength, which falls with the zoom (alphas per unit of 1/zoom). They are drawn for all
 * the blockades at once (`placeBlockades`). */
function glowRings(alpha: number, stroke: number) {
  const sigma = 4 // map units (drop-shadow's length is the deviation)
  // The dashes' share of the ring, blurred; at the ring's 0.9 opacity, which the shadow took too.
  const peak = (0.9 * alpha * (7 / 12) * stroke) / (sigma * Math.sqrt(2 * Math.PI))
  // Half-widths in deviations, and each ring's share of the bell's height (they stack).
  const steps: [number, number][] = [[2.4, 0.15], [1.6, 0.32], [1, 0.32], [0.5, 0.17]]
  return steps.map(([h, a]): [number, number] => [+(2 * h * sigma).toFixed(4), +(a * peak).toFixed(4)])
}
const GLOW_THEIRS = glowRings(0.6, 3.5)
const GLOW_OURS = glowRings(0.45, 2.5)
const GLOW_COLOR = { ours: 'rgb(125, 255, 160)', theirs: 'rgb(255, 90, 80)' }
/** A blockade, as `placeBlockades` draws it: the system's star, how far its planets reach, and
 * who blockades it. */
type Block = { x: number; y: number; R: number; by: number }
/** A blockade ring's radius in map units at the zoom `k`: round the star zoomed out (26 pixels on
 * screen), round the planets zoomed in (`ringR` in GalaxyView, as CSS). */
const ringAt = (R: number, k: number) => Math.max(26 / k, detail(k) * (R + 2))
/** A circle as path data, from its right-hand point clockwise (where a <circle> starts its dashes). */
const circlePath = (x: number, y: number, r: number) => {
  const R = n4(r)
  return `M${n4(x + r)} ${n4(y)}a${R} ${R} 0 1 1 ${n4(-2 * r)} 0a${R} ${R} 0 1 1 ${n4(2 * r)} 0z`
}
/**
 * The blockades' rings and glows at the zoom `k`, as a few paths that each hold every blockade's
 * circle: a ring for each blockading side, and for the glow (zoomed out) one for each of its rings
 * and each side. So a step of a zoom changes a handful of elements' path data rather than restyling,
 * through the scale variables, five circles a blockade. The glows' widths are in map units (the
 * map's scale widens them with the zoom, as the blur did); the rings are drawn at a width on screen.
 * Blockades well outside what the map's layer has drawn (`reg`, as `cull` reckons it) are left out.
 * `at` is what they were last drawn for: a pan that keeps the region changes nothing.
 */
type BlocksAt = { list: Block[] | null; k: number; reg: Region | null }
function placeBlockades(el: SVGGElement, list: Block[], k: number, reg: Region | null, at: BlocksAt) {
  if (at.list === list && at.k === k && at.reg === reg) return
  Object.assign(at, { list, k, reg })
  const m = CULL_PX / k
  const d = new Map<string, string>()
  const add = (key: string, path: string) => d.set(key, (d.get(key) ?? '') + path)
  for (const b of list) {
    const r = ringAt(b.R, k)
    if (reg && (b.x + r < reg.x0 - m || b.x - r > reg.x0 + reg.w / reg.k + m || b.y + r < reg.y0 - m || b.y - r > reg.y0 + reg.h / reg.k + m)) continue
    const c = circlePath(b.x, b.y, r)
    add(`ring${b.by}`, c)
    add(b.by === ME ? 'ours' : 'theirs', c)
  }
  const fade = clamp((6 - k) / 2, 0, 1) / k
  for (const p of el.children) {
    const key = p.getAttribute('data-key')!
    const path = d.get(key) ?? ''
    if (p.getAttribute('d') !== path) p.setAttribute('d', path)
    const ring = p.getAttribute('data-ring')
    if (ring === null) continue
    const alpha = String(n4(fade * (key === 'ours' ? GLOW_OURS : GLOW_THEIRS)[Number(ring)][1]))
    if (p.getAttribute('stroke-opacity') !== alpha) p.setAttribute('stroke-opacity', alpha)
  }
}

/** A number for a CSS value: no exponents (a CSS length can't take 1e-16). */
const n4 = (v: number) => +v.toFixed(4)
/** Inline style with CSS geometry (r, cx, cy) and transforms, which React's types don't list. */
const css = (o: Record<string, string>) => o as React.CSSProperties
/** A screen-sized thing at (x, y) on the map: the same size on screen at any zoom. `up` lifts it by
 * that many map units times the zoom's detail; `then` is more transform after the scaling. */
const pin = (x: number, y: number, up = 0, then = '', more: Record<string, string> = {}) =>
  css({ transform: `translate(${n4(x)}px, ${up ? `calc(${n4(y)}px - var(--d) * ${n4(up)}px)` : `${n4(y)}px`}) scale(var(--ik))${then}`, ...more })
/** Where a fleet in flight's badge goes: a `pin` at its place (see `fly` in GalaxyView). */
const flyingAt = (p: { x: number; y: number }) => `translate(${n4(p.x)}px, ${n4(p.y)}px) scale(var(--ik))`
/** `n` screen pixels, in map units. */
const spx = (n: number) => `calc(var(--ik) * ${n4(n)}px)`

/** A #rrggbb colour as "r g b", for rgb(… / alpha). */
const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ')
/** A star's glow as a CSS gradient: the same stops as its SVG one (star-…, in GalaxyView), at
 * `alpha` (a hidden system's star is dimmed). */
const starGlow = (hex: string, alpha: number) => {
  const c = rgbOf(hex)
  return `radial-gradient(closest-side, rgb(255 255 255 / ${alpha}) 0%, rgb(${c} / ${alpha}) 30%, rgb(${c} / ${n4(0.3 * alpha)}) 60%, rgb(${c} / 0) 100%)`
}

/**
 * The galaxy, at any zoom. Zoomed out, each system is a star with a dot per planet and fleets are
 * badges beside it; zooming in, the systems open up into their planets on their orbits, with
 * stations, captures and the fleets in orbit beside each planet. Markers and text keep their
 * on-screen size; the planets and stars grow. Without `view` it shows the whole galaxy (the
 * setup's preview).
 *
 * The camera (`view`) doesn't re-render this: everything that follows the zoom is drawn in map
 * units with CSS sizes in terms of the variables `scaleVars` sets (`spx`, `pin`, var(--d)), and
 * only a step of the zoom (`zoomBand`) or the camera leaving what was drawn (`Area`) renders it
 * again. All of it is in one layer (.ew-gpan) covering a region round the view (`Region`): a pan
 * only moves that layer, and a zoom draws the region again. Under the SVG, the big fills are HTML
 * boxes (.ew-gunder); over it, the markers and names (.ew-gover); what's well outside the region is
 * left out (`cull`). The fleets in flight glide every frame of the clock (`fly`), between renders.
 */
function GalaxyView({ g, view, sel, mini = false, orbit = -1, on }: {
  g: Galaxy
  view?: CamView
  sel?: Sel
  mini?: boolean
  /** The planet the orbit view shows (its structures are drawn there, not here), or -1. */
  orbit?: number
  on?: {
    planet: (p: Planet, double: boolean) => void
    system: (s: number) => void
    fleet: (f: Fleet) => void
    fleets?: (fs: Fleet[]) => void
  }
}) {
  const band = useSyncExternalStore(view?.sub ?? noSub, () => (view ? zoomBand(view.cam.k) : MINI_BAND))
  const box = useRef<HTMLDivElement>(null)
  const pan = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const world = useRef<HTMLDivElement>(null)
  const world2 = useRef<HTMLDivElement>(null)
  // What the moving layer has drawn (see Region).
  const region = useRef<Region | null>(null)
  // The lanes stop short of opened-up systems by the zoom's detail: drawn for it here, and moved
  // by the camera (only while it changes, between zooms of 2.4 and 5).
  const lanes = useRef<SVGGElement>(null)
  const laneD = view ? detail(view.cam.k) : 0
  // The blockades' rings and glows (see placeBlockades), drawn for the zoom by the camera too.
  const blocks = useRef<SVGGElement>(null)
  const blockList = useRef<Block[]>([])
  const blocksAt = useRef<BlocksAt>({ list: null, k: 0, reg: null })
  const drawn = useRef({ g, d: laneD })
  // What this render draws (see Area), and a redraw for when the camera leaves it.
  const area = view ? areaAt(view.cam, view.size, 3) : null
  const drawnArea = useRef<Area | null>(null)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  // What can be culled (data-cull), and what scales with the zoom (ScaleUser), found again after
  // each render.
  const cullable = useRef<Culled[]>([])
  const users = useRef<ScaleUser[]>([])
  // The fleets in flight (their badges, and the selected ones' routes), moved every frame of the
  // clock by `fly` rather than at the map's redraws.
  const flying = useRef<{ f: Fleet; el: HTMLElement; route: SVGPolylineElement | null; rest: string }[]>([])
  useLayoutEffect(() => {
    drawn.current = { g, d: laneD }
    drawnArea.current = area
    const b = box.current
    if (!view || !b) return
    cullable.current = [...b.querySelectorAll<Element>('[data-cull]')].map((el) => {
      const [x, y, r] = el.getAttribute('data-cull')!.split(' ').map(Number)
      return { el, x, y, r }
    })
    if (region.current) cull(cullable.current, region.current)
    users.current = scaleUsers(b)
    scaleVars(users.current, view.cam.k)
    blockList.current = blocked
    if (blocks.current) placeBlockades(blocks.current, blocked, view.cam.k, region.current, blocksAt.current)
    flying.current = [...b.querySelectorAll<HTMLElement>('.ew-gfleet.is-moving[data-fid]')].flatMap((el) => {
      const f = g.fleets.find((x) => String(x.id) === el.dataset.fid)
      const route = b.querySelector<SVGPolylineElement>(`.ew-groute[data-fid="${el.dataset.fid}"]`)
      return f ? [{ f, el, route, rest: route?.getAttribute('points')?.split(' ').slice(1).join(' ') ?? '' }] : []
    })
  })
  // Each frame of the clock: the fleets in flight glide on (between the map's redraws, ten a second,
  // they would step). Only their transforms change: a few small repaints.
  useEffect(() => {
    if (!view) return
    const fly = () => {
      for (const m of flying.current) {
        if (!m.f.leg) continue
        const p = fleetAt(g, m.f)
        const t = flyingAt(p)
        if (m.el.style.transform !== t) m.el.style.transform = t
        if (m.route) {
          const pts = `${n4(p.x)},${n4(p.y)}${m.rest ? ` ${m.rest}` : ''}`
          if (m.route.getAttribute('points') !== pts) m.route.setAttribute('points', pts)
        }
      }
    }
    return view.onTick(fly)
  }, [view, g])
  // Aimed before the first paint, and at each move of the camera.
  useLayoutEffect(() => {
    const [b, pn, el, wo, wo2] = [box.current, pan.current, svg.current, world.current, world2.current]
    if (!view || !b || !pn || !el || !wo || !wo2) return
    let widen = 0
    const draw = (wide: boolean) => {
      const r = regionAt(view.cam, view.size, wide)
      region.current = r
      drawRegion(el, wo, wo2, r)
      cull(cullable.current, r)
    }
    const aim = () => {
      const c = view.cam
      const r = region.current
      if (!r || !covers(r, c, view.size)) {
        // A zoom draws round the view; a pan that left the region, or the first aim, a wide one.
        const zooming = !!r && r.k !== c.k
        draw(!zooming)
        clearTimeout(widen)
        if (zooming)
          widen = window.setTimeout(() => {
            const now = region.current
            if (now && !now.wide && now.k === view.cam.k) {
              draw(true)
              placeRegion(pn, region.current!, view.cam, view.size)
              scaleVars(users.current, view.cam.k)
              if (blocks.current) placeBlockades(blocks.current, blockList.current, view.cam.k, region.current, blocksAt.current)
            }
          }, WIDEN_MS)
      }
      placeRegion(pn, region.current!, c, view.size)
      scaleVars(users.current, c.k)
      if (blocks.current) placeBlockades(blocks.current, blockList.current, c.k, region.current, blocksAt.current)
      const a = drawnArea.current
      const v = areaAt(view.cam, view.size, 1)
      if (a && (v.x0 < a.x0 || v.x1 > a.x1 || v.y0 < a.y0 || v.y1 > a.y1)) {
        drawnArea.current = null
        redraw()
      }
      const d = detail(view.cam.k)
      const at = drawn.current
      if (d === at.d || !lanes.current) return
      at.d = d
      const ends = laneEnds(at.g, d)
      const lines = lanes.current.children
      for (let i = 0; i < lines.length && i < ends.length; i++) {
        const [x1, y1, x2, y2] = ends[i]
        lines[i].setAttribute('x1', String(x1))
        lines[i].setAttribute('y1', String(y1))
        lines[i].setAttribute('x2', String(x2))
        lines[i].setAttribute('y2', String(y2))
      }
    }
    aim()
    const unsub = view.sub(aim)
    return () => {
      unsub()
      clearTimeout(widen)
    }
  }, [view])
  const has = (b: number) => (band & b) !== 0
  // The blockades drawn, for their rings and glows.
  const blocked: Block[] = mini ? [] : g.systems.flatMap((s) => {
    const R = reach(g, s.id)
    const b = within(area, s.x, s.y, R + 4) ? blockade(g, s.id) : null
    return b ? [{ x: s.x, y: s.y, R, by: b.by }] : []
  })
  const blockers = [...new Set(blocked.map((b) => b.by))]
  const selIds = selectedIds(sel ?? null)
  const selPs = selectedPlanets(sel ?? null)
  // Only the fleets we can see: ours, and others in systems we see (see the fog of war in galaxy.ts).
  const visible = g.fleets.filter((f) => canSee(g, ME, f))
  // Zoomed out, the fleets parked in a system show as one badge per side.
  const parked = new Map<string, Fleet[]>()
  if (has(B_PARKED))
    for (const f of visible) {
      if (f.leg) continue
      const key = `${f.system}:${f.owner}`
      const group = parked.get(key)
      if (group) group.push(f)
      else parked.set(key, [f])
    }
  // Where the selected fleets are headed, on through any stops queued with Shift.
  // (Ours only: where the enemy's fleets are going is theirs to know.)
  const headed = g.fleets.filter((f) => f.owner === ME && selIds.has(f.id) && (f.leg || f.route.length || f.waypoints?.length))
  const routes = headed.map((f) => [fleetAt(g, f), ...plannedHops(g, f).map((h) => (h.planet >= 0 ? planetAt(g, g.planets[h.planet]) : g.systems[h.system]))])
  const stops = headed.flatMap((f) => (f.waypoints ?? []).map((pid, i) => ({ key: `${f.id}:${i}`, at: planetAt(g, g.planets[pid]), r: planetR(g.planets[pid]), n: i + 1 })))
  // The screen-sized things (markers, badges, names: see `pin`) go over the map in an HTML layer
  // (.ew-gover), each a small SVG of its own, in the order they come: an SVG text inside the map's
  // own SVG is laid out again at every step of a zoom (its scale on screen changes), a few tenths
  // of a millisecond each, where a box's transform changes nothing but where it's drawn.
  const pins: ReactNode[] = []
  const over = (key: string, style: React.CSSProperties, at: string, children: ReactNode, props: Record<string, unknown> = {}) => {
    pins.push(
      <div key={key} {...props} className={`ew-pin ${(props.className as string | undefined) ?? ''}`} style={style} data-cull={at}>
        <svg width="1" height="1">{children}</svg>
      </div>,
    )
    return null
  }
  // On the things below, a finger's long press opens the map's action wheel rather than their tip
  // (data-longpress); mice still hover for the tips.
  const map = (
    <svg ref={svg} className={`ew-gsvg ${mini ? 'is-mini' : ''}`} viewBox={view ? undefined : `0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        {(Object.keys(STAR_COLOR) as (keyof typeof STAR_COLOR)[]).map((s) => (
          <radialGradient key={s} id={`star-${s}`}>
            <stop offset="0" stopColor="#fff" />
            <stop offset="0.3" stopColor={STAR_COLOR[s]} />
            <stop offset="0.6" stopColor={STAR_COLOR[s]} stopOpacity="0.3" />
            <stop offset="1" stopColor={STAR_COLOR[s]} stopOpacity="0" />
          </radialGradient>
        ))}
      </defs>
      {!view && g.systems.map((s) => {
        const o = systemOwner(g, s.id, ME)
        return o >= 0 ? <circle key={`t${s.id}`} cx={s.x} cy={s.y} r={46} fill={color(g, o)} style={css({ opacity: `calc(${n4(0.12 * (sees(g, ME, s.id) ? 1 : 0.5))} * (1 - var(--d) * 0.5))` })} /> : null
      })}
      <g ref={lanes}>
        {laneEnds(g, laneD).map(([x1, y1, x2, y2], i) => {
          const [A, B] = g.lanes[i].map((s) => g.systems[s])
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="ew-glane" vectorEffect="non-scaling-stroke" data-cull={cullAt((A.x + B.x) / 2, (A.y + B.y) / 2, Math.hypot(B.x - A.x, B.y - A.y) / 2)} />
        })}
      </g>
      {routes.map((route, i) => (
        <polyline key={i} className="ew-groute" data-fid={headed[i].id} points={route.map((p) => `${p.x},${p.y}`).join(' ')} vectorEffect="non-scaling-stroke" />
      ))}

      {g.systems.map((s) => {
        const R = reach(g, s.id)
        if (!within(area, s.x, s.y, R + 4)) return null
        const battle = g.pending >= 0 && g.planets[g.pending].system === s.id
        const block = mini ? null : blockade(g, s.id)
        // Hidden from us: what's drawn there is what we last saw, faded.
        const fog = !sees(g, ME, s.id)
        const lastLook = fog ? Math.max(...s.planets.map((pid) => known(g, ME, g.planets[pid]).t)) : 0
        // The blockade's ring: round the star zoomed out, round the planets zoomed in.
        const ringR = `max(${spx(26)}, calc(var(--d) * ${n4(R + 2)}px))`
        const sysAt = cullAt(s.x, s.y, R + 4)
        return (
          <g key={s.id} className={`ew-gsys ${fog ? 'is-fog' : ''}`} data-cull={sysAt}>
            <g
              className="ew-gsys-hit"
              data-sid={s.id}
              data-longpress=""
              onClick={() => on?.system(s.id)}
              data-tip={mini || has(B_NEAR) ? undefined : `${s.name}: ${s.planets.map((p) => g.planets[p].name).join(', ')}.${fog ? ` Hidden: we have no planet or fleet there; what shows is what we last saw (${lastLook <= 0 ? 'the pre-war charts' : `day ${dayOf(lastLook)}`}).` : ''}${blockadeTip(g, s.id)} Click to zoom in; right-click to send the selected fleet (Shift to add a stop).`}
            >
              <circle cx={s.x} cy={s.y} fill="transparent" style={css({ r: spx(has(B_NEAR) ? 30 : 22) })} data-ik-lo={has(B_NEAR) ? undefined : n4(4 / 22)} />
              {(!view || has(B_DOTS)) && <circle cx={s.x} cy={s.y} fill={`url(#star-${s.star})`} style={css({ r: spx(13) })} data-ik-lo={n4(7 / 13)} />}
              <circle cx={s.x} cy={s.y} fill="#fff" style={css({ r: spx(3.2) })} data-ik-lo={0.5} />
            </g>
            {/* Zoomed out: a dot per planet in its owner's colour, over the star. All of a system's
                dots are one pin (a step of the zoom moves one box, rather than restyling and laying
                out a circle a planet); in the setup's preview, at no zoom, they're in the map. */}
            {has(B_DOTS) && (() => {
              const dots = s.planets.map((pid, i) => {
                const a = -Math.PI / 2 + (i - (s.planets.length - 1) / 2) * 0.55
                return <circle key={pid} cx={n4(Math.cos(a) * 15)} cy={n4(Math.sin(a) * 15)} r={2.6} strokeWidth={0.6} fill={color(g, ownerFor(g, ME, g.planets[pid]))} stroke="#000" />
              })
              return view
                ? over(`dt${s.id}`, pin(s.x, s.y, 0, '', { opacity: `calc((1 - var(--d)) * ${fog ? 0.55 : 1})` }), sysAt, dots, { className: 'is-deco' })
                : <g transform={`translate(${n4(s.x)} ${n4(s.y)})`} opacity={fog ? 0.55 : 1}>{dots}</g>
            })()}
            {/* Zoomed in: the planets on their orbits. */}
            {has(B_OPEN) && (
              <g style={css({ opacity: 'var(--d)' })}>
                {s.planets.map((pid) => {
                  const o = orbitOf(g.planets[pid].orbit)
                  return <ellipse key={pid} cx={s.x} cy={s.y} rx={o.rx} ry={o.ry} className="ew-sorbit" vectorEffect="non-scaling-stroke" />
                })}
                {s.planets.map((pid) => {
                  const p = g.planets[pid]
                  const q = planetAt(g, p)
                  const r = planetR(p)
                  const on2 = selPs.has(pid)
                  const capture = p.capture ? p.capture.t / CAPTURE_TIME : 0
                  // What we know of it: as it is, or (hidden) as we last saw it.
                  const k = known(g, ME, p)
                  // The planet takes the clicks, on its markers over the map too.
                  const hit = {
                    'data-pid': pid,
                    'data-longpress': '',
                    onClick: (e: React.MouseEvent) => (e.stopPropagation(), on?.planet(p, e.detail > 1)),
                    'data-tip': k.live
                      ? `${p.name}: ${PLANET_KINDS[p.kind].name}, ${planetIncome(g, p)} credits a day. ${p.owner < 0 ? 'Unclaimed.' : `Held by the ${factionName(g, p.owner)}.`} Double-click to zoom in; right-click to send the selected fleet (Shift to add a stop).`
                      : `${p.name}: ${PLANET_KINDS[p.kind].name}, about ${knownIncome(p, k.station)} credits a day. ${lastSeen(g, p)} Double-click to zoom in; right-click to send the selected fleet (Shift to add a stop).`,
                  }
                  // (They fade in with the planets, as the group round these did.)
                  const fade = { opacity: 'var(--d)' }
                  return (
                    <g key={pid} className={`ew-splanet ${on2 ? 'is-sel' : ''} ${k.live ? '' : 'is-fog'}`} {...hit}>
                      <circle cx={q.x} cy={q.y} fill="none" stroke={color(g, k.owner)} strokeWidth={k.owner < 0 ? 1 : 2.5} strokeDasharray={k.owner < 0 || !k.live ? '3 4' : undefined} vectorEffect="non-scaling-stroke" className="ew-sring"
                        style={css({ r: `calc(${n4(r)}px + ${spx(6)})` })} data-ik-lo={n4((r * 0.18) / 6)} />
                      <image href={PLANET_ART(p.kind)} x={q.x - r} y={q.y - r} width={r * 2} height={r * 2} />
                      {k.live && p.capture && (
                        <>
                          {/* Being taken: a track round the planet filling in the taker's colour, and a tag. */}
                          <circle cx={q.x} cy={q.y} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={4} vectorEffect="non-scaling-stroke" className="ew-gcap" style={css({ r: `calc(${n4(r)}px + ${spx(11)})` })} data-ik-lo={n4((r * 0.3) / 11)} />
                          <circle cx={q.x} cy={q.y} fill="none" stroke={color(g, p.capture.owner)} strokeWidth={4} vectorEffect="non-scaling-stroke" pathLength={1} strokeDasharray={`${capture} 1`} transform={`rotate(-90 ${q.x} ${q.y})`} className="ew-gcap" style={css({ r: `calc(${n4(r)}px + ${spx(11)})` })} data-ik-lo={n4((r * 0.3) / 11)} />
                          {over(`cap${pid}`, pin(q.x, q.y - r, 0, '', fade), sysAt, <CaptureTag g={g} p={p} />, { ...hit, className: 'ew-splanet' })}
                        </>
                      )}
                      {(k.station > 0 || (k.live && p.queue.length > 0)) && over(`st${pid}`, pin(q.x - r * 0.75, q.y - r * 0.75, 0, '', fade), sysAt, (
                        <>
                          {/* (Closer in, the level goes on the station's own picture, below.) */}
                          {k.station > 0 && !(has(B_BASE) && pid !== orbit && k.owner >= 0) && (
                            <g transform="translate(-10 -10)" opacity={k.live ? 1 : 0.6}>
                              <rect x={-9} y={-9} width={18} height={18} rx={4} fill="#0b1226" stroke={color(g, k.owner)} strokeDasharray={k.live ? undefined : '2 2'} />
                              <text y={4} className="ew-slv">{k.station}</text>
                            </g>
                          )}
                          {k.live && p.queue.length > 0 && <circle cx={k.station ? 6 : -6} cy={-16} r={4} className="ew-sbusy" />}
                        </>
                      ), { ...hit, className: 'ew-splanet' })}
                      {/* Closer in: what stands round it, as small pictures where each sits (see
                          Orbit.tsx), at least a little way out past the planet's edge on screen. The
                          planet the orbit view shows has its real models instead. */}
                      {has(B_BASE) && pid !== orbit && k.station > 0 && k.owner >= 0 && orbitThings(g.sides[k.owner].faction, k.station, k.base, false).map((th) => {
                        const s = ringSpots(g, p, k.layout)[th.id] ?? { a: 0, d: 2 }
                        const dist = `max(${n4(s.d * r)}px, calc(${n4(r)}px + var(--ik) * 20px))`
                        return over(`os${pid}${th.id}`, css({ transform: `translate(calc(${n4(q.x)}px + ${n4(Math.cos(s.a))} * ${dist}), calc(${n4(q.y)}px + ${n4(Math.sin(s.a))} * ${dist})) scale(var(--ik))`, opacity: `calc(var(--d) * ${k.live ? 1 : 0.6})` }), sysAt, (
                          <StructIcon th={th} stroke={color(g, k.owner)} level={k.station} faded={!k.live} />
                        ), { ...hit, 'data-tip': `${th.name} at ${p.name}${k.live ? '' : ' (as last seen)'}. Zoom in for the orbit view.`, className: `ew-splanet ew-sbase is-${th.state}` })
                      })}
                      {has(B_NAMES) && over(`nm${pid}`, pin(q.x, q.y + r, 0, '', { opacity: 'var(--nm)' }), sysAt, <text y={20} className="ew-spname">{p.name}</text>)}
                      {!k.live && has(B_NAMES) && over(`ls${pid}`, pin(q.x, q.y + r, 0, '', { opacity: 'calc(var(--nm) * 0.85)' }), sysAt, <text y={34} className="ew-spseen">{k.t <= 0 ? 'Pre-war charts' : `Last seen day ${dayOf(k.t)}`}{k.ships > 0 ? ` · ${k.ships} ships` : ''}</text>)}
                    </g>
                  )
                })}
              </g>
            )}
            {battle && <circle cx={s.x} cy={s.y} className="ew-gbattle" vectorEffect="non-scaling-stroke" style={css({ r: `max(${spx(20)}, calc(var(--d) * ${n4(R)}px))` })} />}
            {/* Zoomed out: a ring round a system with picked planets (solid when it's all of them). */}
            {!mini && has(B_DOTS) && s.planets.some((pid) => selPs.has(pid)) && (
              <circle cx={s.x} cy={s.y} className={`ew-gsyssel ${s.planets.every((pid) => selPs.has(pid)) ? 'is-whole' : ''}`} vectorEffect="non-scaling-stroke" style={css({ r: spx(23), opacity: 'calc(1 - var(--d))' })} />
            )}
            {/* Zoomed out: a planet being taken shows as a filling ring round the system and its percentage. */}
            {!mini && !fog && has(B_CAPRING) && s.planets.map((pid) => g.planets[pid]).filter((p) => p.capture).slice(0, 1).map((p) => (
              <g key={`c${p.id}`} style={css({ opacity: 'calc(1 - var(--d) / 0.6)' })}>
                <circle cx={s.x} cy={s.y} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={3.5} vectorEffect="non-scaling-stroke" className="ew-gcap" style={css({ r: spx(19) })} />
                <circle cx={s.x} cy={s.y} fill="none" stroke={color(g, p.capture!.owner)} strokeWidth={3.5} vectorEffect="non-scaling-stroke" pathLength={1} strokeDasharray={`${p.capture!.t / CAPTURE_TIME} 1`} transform={`rotate(-90 ${s.x} ${s.y})`} className="ew-gcap" style={css({ r: spx(19) })} />
                {over(`ct${s.id}`, pin(s.x, s.y, 0, '', { opacity: 'calc(1 - var(--d) / 0.6)' }), sysAt, <text x={0} y={-26} className={`ew-gcaptext ${p.capture!.owner === ME ? 'is-ours' : 'is-theirs'}`}>{p.capture!.owner === ME ? 'Taking' : 'Losing'} {p.name} {Math.floor((p.capture!.t / CAPTURE_TIME) * 100)}%</text>)}
              </g>
            ))}
            {/* A blockade: a barrier ring round the system in the blockading side's colour (with the
                others, after the systems: see placeBlockades), and a shield on it; red-edged when
                it's against us. */}
            {block &&
                over(`bk${s.id}`, css({ transform: `translate(calc(${n4(s.x)}px + 0.7071 * ${ringR}), calc(${n4(s.y)}px - 0.7071 * ${ringR})) scale(var(--ik))` }), sysAt, (
                  <g data-tip={`${block.by === ME ? 'Our' : 'Enemy'} blockade.${blockadeTip(g, s.id)}`} data-longpress="">
                    <path d="M0,-9 L8,-5 L8,1 C8,6 4,9 0,11 C-4,9 -8,6 -8,1 L-8,-5 Z" fill="#0b1226" stroke={color(g, block.by)} strokeWidth={1.6} />
                    <path d="M-4,-1 L4,-1 M-4,3 L4,3" stroke={block.by === ME ? '#7dffa0' : '#ff6a5e'} strokeWidth={1.6} strokeLinecap="round" />
                  </g>
                ), { className: 'ew-gshield' })}
            {!mini && over(`nm${s.id}s`, pin(s.x, s.y, has(B_BIG) ? R : 0), sysAt, <text y={has(B_BIG) ? -10 : 27} className={`ew-gname ${has(B_BIG) ? 'is-big' : ''}`}>{s.name}</text>)}
          </g>
        )
      })}
      {/* The blockades' glows and rings, each in a few paths for them all (see placeBlockades),
          drawn for the zoom by the camera: a glow under its ring, as a drop-shadow was. */}
      {blocked.length > 0 && (
        <g ref={blocks} className="ew-gblocks">
          {has(B_GLOW) && (['theirs', 'ours'] as const).flatMap((side) => blockers.some((by) => (by === ME) === (side === 'ours'))
            ? (side === 'ours' ? GLOW_OURS : GLOW_THEIRS).map(([width], i) => <path key={`${side}${i}`} data-key={side} data-ring={i} fill="none" stroke={GLOW_COLOR[side]} strokeWidth={width} />)
            : [])}
          {blockers.map((by) => (
            <path key={`ring${by}`} data-key={`ring${by}`} fill="none" stroke={color(g, by)} vectorEffect="non-scaling-stroke" className={`ew-gring ${by === ME ? 'is-ours' : 'is-theirs'}`} />
          ))}
        </g>
      )}
      {!mini &&
        [...parked.entries()].map(([key, fs]) => {
          const [sys, owner] = key.split(':').map(Number)
          const s = g.systems[sys]
          if (!within(area, s.x, s.y, 0)) return null
          const n = fs.reduce((v, f) => v + f.ships.length, 0)
          const lead = fs.slice().sort((a, b) => b.ships.length - a.ships.length)[0]
          const on2 = fs.some((f) => selIds.has(f.id))
          return over(`pk${key}`, pin(s.x, s.y, 0, ` translate(${owner === ME ? -24 : 24}px, -16px)`), cullAt(s.x, s.y, 0), (
            <>
              <rect x={-11} y={-7} width={22} height={14} rx={3} fill={color(g, owner)} />
              <text y={3.5}>{n}</text>
            </>
          ), {
            className: `ew-gfleet ${on2 ? 'is-sel' : ''}`,
            'data-fid': lead.id,
            'data-longpress': '',
            onClick: (e: React.MouseEvent) => (e.stopPropagation(), fs.length > 1 && on?.fleets ? on.fleets(fs) : on?.fleet(lead)),
            'data-tip': `${factionName(g, owner)} fleet${fs.length > 1 ? `s (${fs.length})` : ''}: ${n} ships`,
          })
        })}
      {!mini &&
        visible.map((f) => {
          if (!f.leg && has(B_PARKED)) return null
          const p = fleetAt(g, f)
          if (!within(area, p.x, p.y, f.planet >= 0 && !f.leg ? planetR(g.planets[f.planet]) : 0)) return null
          // In orbit, beside its planet (several stack downwards): past the planet's edge, then a
          // little further on screen.
          let place = f.leg ? css({ transform: flyingAt(p) }) : pin(p.x, p.y)
          if (!f.leg && f.planet >= 0) {
            const i = seenAt(g, f.planet).indexOf(f)
            place = css({ transform: `translate(${n4(p.x + planetR(g.planets[f.planet]))}px, ${n4(p.y)}px) scale(var(--ik)) translate(26px, ${-8 + i * 22}px)` })
          }
          return over(`f${f.id}`, place, cullAt(p.x, p.y, f.planet >= 0 && !f.leg ? planetR(g.planets[f.planet]) : 0), (
            <>
              {f.leg ? (
                <>
                  <path d="M-9,-7 L9,0 L-9,7 L-4,0 Z" transform={`rotate(${(p.angle * 180) / Math.PI})`} fill={color(g, f.owner)} stroke="#000" strokeWidth={0.8} />
                  <text y={-10}>{f.ships.length}</text>
                </>
              ) : (
                <>
                  <rect x={-16} y={-9} width={32} height={18} rx={4} fill="#0b1226" stroke={color(g, f.owner)} strokeWidth={1.6} />
                  <path d="M-11,-4 L-3,0 L-11,4 Z" fill={color(g, f.owner)} />
                  <text x={4} y={4}>{f.ships.length}</text>
                </>
              )}
            </>
          ), {
            className: `ew-gfleet ${f.leg ? 'is-moving' : 'is-orbit'} ${selIds.has(f.id) ? 'is-sel' : ''}`,
            'data-fid': f.id,
            'data-longpress': '',
            onClick: (e: React.MouseEvent) => (e.stopPropagation(), on?.fleet(f)),
            'data-tip': `${factionName(g, f.owner)} fleet: ${f.ships.length} ships${f.leg ? `, ${secs(eta(f))} to go` : ''}`,
          })
        })}
      {/* The stops queued with Shift, numbered in order, just above each planet. */}
      {!mini && stops.map((w) => over(`w${w.key}`, pin(w.at.x, w.at.y, w.r), cullAt(w.at.x, w.at.y, w.r), (
        <g className="ew-gwaypt" transform="translate(0 -12)">
          <circle r={8} />
          <text y={3.5}>{w.n}</text>
        </g>
      )))}
    </svg>
  )
  if (!view) return map
  // Under the SVG, as plain boxes in one transformed layer (see .ew-gunder): what fills most of the
  // screen zoomed in. Big SVG shapes are drawn on the CPU every frame of a zoom in Firefox; boxes
  // and gradients are the compositor's. The territories under everything, and zoomed in (where
  // the lanes stop short of the systems) the stars' glows.
  return (
    <div ref={box} className="ew-gmap">
      <div ref={pan} className="ew-gpan">
        <div className="ew-gunder" aria-hidden="true">
          <div ref={world} className="ew-gworld">
            {g.systems.map((s) => {
              const o = systemOwner(g, s.id, ME)
              // (Its opacity in the colour, not as `opacity`: that would be a layer of its own.)
              const tint = `rgb(${rgbOf(color(g, o))} / calc(${n4(0.12 * (sees(g, ME, s.id) ? 1 : 0.5))} * (1 - var(--d) * 0.5)))`
              return o >= 0 && within(area, s.x, s.y, 46) ? <i key={`t${s.id}`} className="ew-gterr" data-cull={cullAt(s.x, s.y, 46)} style={css({ transform: `translate(${n4(s.x - 46)}px, ${n4(s.y - 46)}px)`, background: `radial-gradient(closest-side, ${tint} calc(100% - var(--ik) * 1px), transparent 100%)` })} /> : null
            })}
            {!has(B_DOTS) && g.systems.filter((s) => within(area, s.x, s.y, 7)).map((s) => (
              <i key={`s${s.id}`} className="ew-gstar" data-cull={cullAt(s.x, s.y, 7)} style={css({ transform: `translate(${n4(s.x - 7)}px, ${n4(s.y - 7)}px)`, background: starGlow(STAR_COLOR[s.star], sees(g, ME, s.id) ? 1 : 0.6) })} />
            ))}
          </div>
        </div>
        {map}
        <div className="ew-gover">
          <div ref={world2} className="ew-gworld">{pins}</div>
        </div>
      </div>
    </div>
  )
}

/** Where the map is looking, for the bar: the nearest system once zoomed in, and planet once close.
 * It follows the camera by itself, redrawing only when the name changes. */
function MapWhere({ g, view }: { g: Galaxy; view: CamView }) {
  const where = useSyncExternalStore(view.sub, () => whereOf(g, view.cam))
  return <>{g.name}{where}</>
}
function whereOf(g: Galaxy, cam: Cam) {
  const dist = (x: number, y: number) => Math.hypot(x - cam.x, y - cam.y)
  const near = detail(cam.k) > 0.5 ? g.systems.reduce((b, s) => (dist(s.x, s.y) < dist(b.x, b.y) ? s : b)) : null
  if (!near) return ''
  const nearPlanet = cam.k > 30 ? near.planets.map((p) => g.planets[p]).reduce((b, p) => (dist(planetAt(g, p).x, planetAt(g, p).y) < dist(planetAt(g, b).x, planetAt(g, b).y) ? p : b)) : null
  return ` › ${near.name}${nearPlanet && nearPlanet.name !== near.name ? ` › ${nearPlanet.name}` : ''}`
}

/** The minimap's frame round what the map shows: it follows the camera by itself. */
function MiniFrame({ view }: { view: CamView }) {
  const el = useRef<SVGRectElement>(null)
  useLayoutEffect(() => {
    const put = () => {
      const r = el.current
      if (!r) return
      const c = view.cam
      const vw = view.size.w / c.k
      const vh = view.size.h / c.k
      r.setAttribute('x', String(c.x - vw / 2))
      r.setAttribute('y', String(c.y - vh / 2))
      r.setAttribute('width', String(vw))
      r.setAttribute('height', String(vh))
    }
    put()
    return view.sub(put)
  }, [view])
  return <rect ref={el} className="ew-gmini-view" />
}

/** The week: six bars, one a day, filling as the day goes; planets pay as each one fills. */
function WeekClock({ g }: { g: Galaxy }) {
  const c = calendar(g.time)
  return (
    <span className="ew-gclock" data-tip={`Week ${c.week + 1}, day ${c.weekDay + 1} of ${WEEK}. Our planets pay at the end of every day: ${fmt(incomeOf(g, ME))} credits, in ${Math.ceil((1 - c.frac) * DAY)} s.`}>
      <b>Week {c.week + 1}</b>
      <span className="ew-gdays">
        {Array.from({ length: WEEK }, (_, i) => (
          <i key={i} className={i < c.weekDay ? 'is-full' : i === c.weekDay ? 'is-now' : ''}>
            <em style={{ height: `${i < c.weekDay ? 100 : i === c.weekDay ? c.frac * 100 : 0}%` }} />
          </i>
        ))}
      </span>
    </span>
  )
}

function GalaxyMap({ g, session, sound, onExit, onAbandon, onEnd, onLoad, onBattle }: { g: Galaxy; session: string | undefined; sound: EmpiresSound; onExit: () => void; onAbandon: () => void; onEnd: () => void; onLoad: (g: Galaxy) => void; onBattle: (b: ConquestBattle) => void }) {
  const [, setFrame] = useState(0)
  const [sel, setSel] = useState<Sel>(null)
  const [take, setTake] = useState<Record<string, number>>({})
  const [speed, setSpeed] = useState(1)
  const [paused, setPaused] = useState(false)
  const [menu, setMenu] = useState<null | 'menu' | 'settings' | 'abandon' | 'saveas' | 'load'>(null)
  const [saveName, setSaveName] = useState('')
  const [economy, setEconomy] = useState(false)
  const [toasts, setToasts] = useState<GToast[]>([])
  const [pay, setPay] = useState<{ id: number; amount: number } | null>(null)
  // (On a touch screen the list starts closed: the faction button at the top left opens it.)
  const [fleetsOpen, setFleetsOpen] = useState(() => typeof matchMedia === 'undefined' || !matchMedia('(pointer: coarse)').matches)
  /** The fleet inventory closed for this planet (or fleet in flight): it opens again for the next one. */
  const [invClosed, setInvClosed] = useState<string | null>(null)
  /** 'move': the next click on the map sends the selected fleets there (as a right-click would). */
  const [mode, setMode] = useState<'normal' | 'move'>('normal')
  /** Phones and short screens hide the galaxy map until it's asked for (the map button). */
  const [mapOpen, setMapOpen] = useState(false)
  const viewEl = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 520 })
  // The camera lives outside React (see CamView): moving it redraws none of this screen.
  const [view] = useState(() => new CamView({ x: W / 2, y: H / 2, k: 0.8 }))
  const camRef = useRef(view.cam)
  /** Moves the camera now: the ref at once, so moves in the same frame build on each other. */
  const moveCam = (c: Cam) => {
    camRef.current = c
    view.set(c)
  }
  /** The glide under way, if any (see Glide). */
  const glide = useRef<Glide | null>(null)
  /** How the camera moved over the last frames (world units and the zoom's log, per second): a glide
   * that starts after a pinch or a drag carries on from it. */
  const camVel = useRef({ x: 0, y: 0, k: 0 })
  /** How fast the keys and screen edges are panning, in screen pixels a second (it eases in and out). */
  const panVel = useRef({ x: 0, y: 0 })
  const dragged = useRef(false)
  /** Camera keys held down, and where the mouse is over the map (for edge scrolling). */
  const held = useRef(new Set<string>())
  const mouse = useRef({ x: 0, y: 0, inside: false })
  const rootEl = useRef<HTMLDivElement>(null)
  // The planet's dock keeps clear of the selection panel on its right: as wide as the room between
  // the dock's left edge and the panel (wherever either has been moved to), measured after each draw.
  useLayoutEffect(() => {
    const root = rootEl.current
    const dock = root?.querySelector<HTMLElement>('.ew-gdock')
    const selp = root?.querySelector<HTMLElement>('.ew-gselfloat')
    if (!root || !dock) return
    const d = dock.getBoundingClientRect()
    const s = selp?.getBoundingClientRect()
    const room = s && s.width && s.left > d.left + 200 ? `${Math.floor(s.left - d.left - 8)}px` : ''
    if (root.style.getPropertyValue('--ew-gdock-max') !== room) root.style.setProperty('--ew-gdock-max', room || null)
    // Little room (a small window): the planet's picture column folds away, its name goes in the header.
    root.classList.toggle('has-narrow-dock', !!s && s.width > 0 && s.left - d.left < 480)
  })
  // On a touch screen what is selected is one small button (SelChip); its panels (the selection, the
  // planet's dock, the fleets at the planet) open from it as a sheet, and a tap anywhere else only
  // closes them again, giving no order and changing no selection, as in a battle.
  const compact = useCoarse()
  const [selOpen, setSelOpen] = useState(false)
  const sheetOpen = compact && selOpen && !!sel
  useTapAway(rootEl, sheetOpen, () => setSelOpen(false), GSHEET_KEEP)
  useEffect(() => {
    if (!sel) setSelOpen(false)
  }, [sel])
  // Move mode waits for a tap on the map: the sheet folds away for it.
  useEffect(() => {
    if (mode === 'move') setSelOpen(false)
  }, [mode])
  const state = useRef({ paused, speed, menu, mode })
  state.current = { paused, speed, menu, mode }
  useSettings()
  const mine = g.sides[ME]
  const myFaction = mine.faction
  // Dev builds expose the campaign for poking at from the console.
  if (import.meta.env.DEV) (window as unknown as { __galaxy: Galaxy }).__galaxy = g

  const kMin = fitK(size.w, size.h)
  const kMinRef = useRef(kMin)
  kMinRef.current = kMin
  // The orbit view (see Orbit.tsx): the planet the camera is locked onto (-1: none), and the
  // structure picked round it.
  const [orbit, setOrbitState] = useState(-1)
  const orbitRef = useRef(-1)
  const [orbitSel, setOrbitSel] = useState<StructId | null>(null)
  /** Where the orbit view of planet `pid` puts it and its battle map, for the view's size now. */
  const orbitAt = (pid: number) => orbitFrameOf(g, g.planets[pid], view.size)
  /** The zoom the orbit view of planet `pid` settles at. */
  const orbitK = (pid: number) => orbitAt(pid).k
  // Locked onto a planet, the camera stays on it, the planet where the orbit view has it on screen
  // (to one side of its battle map), and goes no closer than the orbit view's own zoom.
  const fix = (c: Cam): Cam => {
    const o = orbitRef.current
    if (o >= 0) {
      const q = planetAt(g, g.planets[o])
      const fr = orbitAt(o)
      const k = clamp(c.k, kMinRef.current, fr.k)
      return { x: q.x - fr.dx / k, y: q.y - fr.dy / k, k }
    }
    return { x: clamp(c.x, 0, W), y: clamp(c.y, 0, H), k: clamp(c.k, kMinRef.current, K_MAX) }
  }
  /** Where a glide moves the camera now. */
  const glideCam = (G: Glide): Cam => {
    const k = Math.exp(G.lk)
    return { x: G.ax - G.sx / k, y: G.ay - G.sy / k, k }
  }
  /** Where a glide leaves the camera. */
  const glideGoal = (G: Glide): Cam => {
    const k = Math.exp(G.gk)
    return { x: G.ax - G.tx / k, y: G.ay - G.ty / k, k }
  }
  /** A new glide holding world point (ax, ay), taking it to (tx, ty) on screen and the zoom to e^gk,
   * carrying on from however the camera moves now (the glide under way, or a pinch or drag). */
  const startGlide = (kind: Glide['kind'], ax: number, ay: number, tx: number, ty: number, gk: number, wp: number, wk: number): Glide => {
    const c = camRef.current
    const was = glide.current
    // The camera's velocity: world units and the zoom's log per second.
    let v = camVel.current
    if (was) {
      const k = Math.exp(was.lk)
      v = { x: (was.sx * was.vk - was.vx) / k, y: (was.sy * was.vk - was.vy) / k, k: was.vk }
    }
    const sx = (ax - c.x) * c.k
    const sy = (ay - c.y) * c.k
    const G: Glide = { kind, ax, ay, sx, sy, vx: -v.x * c.k + sx * v.k, vy: -v.y * c.k + sy * v.k, tx, ty, lk: Math.log(c.k), vk: v.k, gk, wp, wk, cx: NaN, cy: NaN }
    aimGlide(G, wp, wk)
    glide.current = G
    return G
  }
  /** A flight to camera `to` (already within bounds). Zooming in, the spot it's going to glides to the
   * middle of the screen as the zoom grows; zooming far out, the camera zooms round the one point that
   * is in the same place on screen before and after, so nothing swings out and back. */
  const flyCam = (to: Cam) => {
    if (reducedMotion()) {
      glide.current = null
      moveCam(to)
      return
    }
    const c = camRef.current
    let ax = to.x
    let ay = to.y
    let tx = 0
    let ty = 0
    if (Math.log(to.k / c.k) < -0.9) {
      ax = (to.x * to.k - c.x * c.k) / (to.k - c.k)
      ay = (to.y * to.k - c.y * c.k) / (to.k - c.k)
      tx = (ax - to.x) * to.k
      ty = (ay - to.y) * to.k
    }
    startGlide('fly', ax, ay, tx, ty, Math.log(to.k), W_FLY, W_FLY)
  }
  /** In the orbit view, the zoom to `k` (no closer than the view's own), `wk` its spring's stiffness;
   * the planet keeps gliding to its place beside the battle map. */
  const orbitTo = (k: number, wk: number) => {
    const o = orbitRef.current
    const fr = orbitAt(o)
    const gk = Math.log(clamp(k, kMinRef.current, fr.k))
    if (reducedMotion() && wk !== W_WHEEL) {
      glide.current = null
      moveCam(fix({ ...camRef.current, k: Math.exp(gk) }))
      return
    }
    const was = glide.current
    if (was?.kind === 'orbit') {
      was.gk = gk
      aimGlide(was, W_ORBIT, wk)
      return
    }
    const q = planetAt(g, g.planets[o])
    startGlide('orbit', q.x, q.y, fr.dx, fr.dy, gk, W_ORBIT, wk)
  }
  /** The orbit view just left (-1: none): its pictures fade out over ORBIT_FADE_MS rather than go. */
  const [gone, setGone] = useState(-1)
  const goneTimer = useRef(0)
  /** Into the orbit view of planet `pid`: the camera eases onto it and in, and it's selected. */
  const enterOrbit = (pid: number) => {
    const p = g.planets[pid]
    if (!p) return
    orbitRef.current = pid
    setOrbitState(pid)
    setOrbitSel(null)
    clearTimeout(goneTimer.current)
    setGone(-1)
    // The view clears for it: the planet's panels give way to the orbit card of what's picked.
    setTake({})
    setSel(null)
    // (A glide into another planet's orbit view starts afresh from where the camera is.)
    if (glide.current?.kind === 'orbit') glide.current.kind = 'fly'
    orbitTo(orbitK(pid), W_ORBIT)
  }
  /** Out of the orbit view (the camera lets go where it is; `out`: and pulls back to the system). */
  const leaveOrbit = (out = false) => {
    const o = orbitRef.current
    if (o < 0) return
    orbitRef.current = -1
    setOrbitState(-1)
    setOrbitSel(null)
    if (!reducedMotion()) {
      setGone(o)
      clearTimeout(goneTimer.current)
      // (Gone when its fade ends; this in case that never comes, as in a hidden tab.)
      goneTimer.current = window.setTimeout(() => setGone(-1), ORBIT_FADE_MS + 200)
    }
    // A glide into the view carries on to where it was going, no longer held to the planet.
    if (glide.current?.kind === 'orbit') glide.current.kind = 'fly'
    if (!out) return
    const q = planetAt(g, g.planets[o])
    flyCam(fix({ x: q.x, y: q.y, k: Math.min(K_MAX * 0.4, orbitK(o) * 0.45) }))
  }
  /** The planet a zoom at world point (x, y) is going into, if any: the nearest within reach of it
   * (its structures' reach), else the one nearest the middle of the view within that. */
  const snapPlanet = (x: number, y: number) => {
    const near = (px: number, py: number) => {
      let best: Planet | null = null
      let bd = Infinity
      for (const p of g.planets) {
        const q = planetAt(g, p)
        const d = Math.hypot(q.x - px, q.y - py) / planetR(p)
        if (d < ORBIT_REACH && d < bd) (best = p), (bd = d)
      }
      return best
    }
    return near(x, y) ?? near(camRef.current.x, camRef.current.y)
  }
  const flyTo = (x: number, y: number, k: number) => {
    // Somewhere else, or out past where the orbit view lets go: the camera is let go first.
    const o = orbitRef.current
    if (o >= 0) {
      const q = planetAt(g, g.planets[o])
      if (Math.hypot(q.x - x, q.y - y) > planetR(g.planets[o]) * ORBIT_REACH || k < orbitK(o) * ORBIT_LEAVE) leaveOrbit()
    }
    if (orbitRef.current >= 0) orbitTo(k, W_ORBIT)
    else flyCam(fix({ x, y, k }))
  }
  /** The zoom keys and buttons: in or out round the middle of the view, snapping into a planet's
   * orbit view the way the wheel does. */
  const zoomBy = (f: number) => {
    const c = glide.current ? glideGoal(glide.current) : camRef.current
    if (orbitRef.current < 0 && f > 1) {
      const p = snapPlanet(c.x, c.y)
      if (p && c.k * f >= Math.min(K_MAX * 0.97, orbitK(p.id) * ORBIT_SNAP)) return enterOrbit(p.id)
    }
    flyTo(c.x, c.y, c.k * f)
  }
  const flyOut = () => flyTo(W / 2, H / 2, kMin)
  // Dev builds can drive the camera from the console (and the browser checks).
  if (import.meta.env.DEV) (window as unknown as { __gmap: unknown }).__gmap = { enterOrbit, leaveOrbit, flyTo, cam: () => camRef.current, at: (pid: number) => planetAt(g, g.planets[pid]), orbitK, orbit: () => orbitRef.current }

  // The view's size; the first time, the whole galaxy fits.
  const fitted = useRef(false)
  useLayoutEffect(() => {
    const el = viewEl.current
    if (!el) return
    const measure = () => {
      const s = { w: el.clientWidth || 800, h: el.clientHeight || 520 }
      setSize(s)
      view.size = s
      if (!fitted.current) {
        fitted.current = true
        moveCam({ x: W / 2, y: H / 2, k: fitK(s.w, s.h) })
        // A small touch screen starts with the map clear: the fleet list opens from the top bar.
        if (matchMedia('(pointer: coarse)').matches && (s.w <= 680 || matchMedia('(max-height: 500px)').matches)) setFleetsOpen(false)
      }
    }
    measure()
    // The map re-aimed at the new size.
    view.set(camRef.current)
    const ro = new ResizeObserver(() => (measure(), view.set(camRef.current)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const toast = (text: string, tone: GToast['tone'] = 'info', to?: GLook) => {
    const t = { id: Math.random(), text, tone, t: performance.now(), to }
    setToasts((ts) => [...ts.slice(-4), t])
  }
  useEffect(() => {
    // The same list back when none has run out, so a quiet second doesn't redraw the whole map.
    const id = window.setInterval(() => setToasts((ts) => (ts.some((t) => performance.now() - t.t >= 7000) ? ts.filter((t) => performance.now() - t.t < 7000) : ts)), 1000)
    return () => clearInterval(id)
  }, [])

  // Saved the moment the page goes away (a reload, a closed tab, another app in front), so it comes
  // back exactly as it was.
  useEffect(() => {
    const save = () => saveGalaxy(g)
    const hidden = () => document.visibilityState === 'hidden' && save()
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('pagehide', save)
      document.removeEventListener('visibilitychange', hidden)
      save()
    }
  }, [g])

  /** Whether the player clicked, tapped, typed or scrolled since the last redraw (see the clock). */
  const poked = useRef(true)
  useEffect(() => {
    const poke = () => {
      poked.current = true
    }
    // (Not the wheel: it only moves the camera, which redraws the map by itself.)
    const kinds = ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup'] as const
    for (const k of kinds) window.addEventListener(k, poke, { capture: true, passive: true })
    return () => {
      for (const k of kinds) window.removeEventListener(k, poke, { capture: true })
    }
  }, [])

  // The clock: the galaxy runs while nothing holds it; the camera glides to where it was sent.
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let saveT = 0
    let drawT = 0
    let prevCam = camRef.current
    const loop = (now: number) => {
      // Up to a second at a time: a background tab gets few frames, and the galaxy keeps time anyway.
      const dt = Math.min(1, (now - last) / 1000)
      last = now
      const st = state.current
      const running = !st.paused && !st.menu && g.pending < 0 && g.winner === -1
      if (running) {
        tickGalaxy(g, dt * st.speed)
        view.tick()
        saveT += dt
        if (saveT > 20) {
          saveT = 0
          saveGalaxy(g)
        }
      }
      // The camera keys and screen edges pan, the same as in a battle.
      const set = getSettings()
      const keys = held.current
      let dx = 0
      let dy = 0
      if (keys.has('arrowleft') || keys.has(set.keys.panLeft)) dx--
      if (keys.has('arrowright') || keys.has(set.keys.panRight)) dx++
      if (keys.has('arrowup') || keys.has(set.keys.panUp)) dy--
      if (keys.has('arrowdown') || keys.has(set.keys.panDown)) dy++
      const edge = set.edgeScroll === 'always' || (set.edgeScroll === 'fullscreen' && !!rootEl.current?.closest('.is-page-full'))
      const el = viewEl.current
      if (edge && mouse.current.inside && el) {
        if (mouse.current.x < 8) dx--
        if (mouse.current.x > el.clientWidth - 8) dx++
        if (mouse.current.y < 8) dy--
        if (mouse.current.y > el.clientHeight - 8) dy++
      }
      // Eases up to speed and back to a stop rather than starting and stopping dead; diagonals go
      // no faster than straight. Closer in it goes faster across the screen, so getting from one
      // system to the next doesn't crawl.
      const len = Math.hypot(dx, dy) || 1
      const top = 1100 * set.cameraSpeed * (camRef.current.k / kMinRef.current) ** 0.25
      const v = panVel.current
      const ease = 1 - Math.exp(-dt * 12)
      v.x += ((dx / len) * top - v.x) * ease
      v.y += ((dy / len) * top - v.y) * ease
      if (!dx && !dy && Math.hypot(v.x, v.y) < 5) v.x = v.y = 0
      // (Locked onto a planet in the orbit view, the keys and edges don't pan.)
      if (orbitRef.current >= 0) v.x = v.y = 0
      if (v.x || v.y) {
        // A flight stops; a wheel zoom under way carries on from the panned spot.
        const G = glide.current
        if (G && G.kind !== 'wheel') glide.current = null
        const c = camRef.current
        const mx = (v.x * dt) / c.k
        const my = (v.y * dt) / c.k
        moveCam(fix({ ...c, x: c.x + mx, y: c.y + my }))
        if (G?.kind === 'wheel') {
          G.ax += mx
          G.ay += my
        }
      }
      // A glide (see Glide): its springs move on by this frame's time.
      const G = glide.current
      if (G && dt > 0) {
        ;[G.sx, G.vx] = spring(G.sx, G.vx, G.tx, G.wp, dt)
        ;[G.sy, G.vy] = spring(G.sy, G.vy, G.ty, G.wp, dt)
        ;[G.lk, G.vk] = spring(G.lk, G.vk, G.gk, G.wk, dt)
        // No closer than the map (or the orbit view) goes, nor further out than the whole galaxy.
        const hi = Math.log(orbitRef.current >= 0 ? orbitK(orbitRef.current) : K_MAX)
        const lo = Math.log(kMinRef.current)
        if (G.lk > hi) (G.lk = hi), (G.vk = Math.min(0, G.vk))
        if (G.lk < lo) (G.lk = lo), (G.vk = Math.max(0, G.vk))
        if (Math.abs(G.lk - G.gk) < 1e-3 && Math.abs(G.vk) < 0.02 && Math.hypot(G.sx - G.tx, G.sy - G.ty) < 0.3 && Math.hypot(G.vx, G.vy) < 4) {
          G.lk = G.gk
          G.sx = G.tx
          G.sy = G.ty
          glide.current = null
        }
        const c = glideCam(G)
        if (G.kind === 'orbit') moveCam(c)
        else {
          // Held inside the galaxy: the glide carries on from where that left it.
          const f = fix(c)
          if (f.x !== c.x || f.y !== c.y) {
            G.sx = (G.ax - f.x) * f.k
            G.sy = (G.ay - f.y) * f.k
          }
          moveCam(f)
        }
      }
      // How the camera moved this frame (smoothed: a pinch's moves come between frames), for a
      // glide that starts next; a jump (the minimap, a resize) is no motion to carry on.
      {
        const c = camRef.current
        const cv = camVel.current
        if (dt > 0) {
          const lk = Math.log(c.k / prevCam.k)
          if (Math.abs(lk) > 0.4 || Math.hypot(c.x - prevCam.x, c.y - prevCam.y) * c.k > 400) cv.x = cv.y = cv.k = 0
          else {
            const a = 1 - Math.exp(-dt * 25)
            cv.x += ((c.x - prevCam.x) / dt - cv.x) * a
            cv.y += ((c.y - prevCam.y) / dt - cv.y) * a
            cv.k += (lk / dt - cv.k) * a
          }
        }
        prevCam = c
      }
      for (const e of g.events) {
        if (e.k === 'captured') {
          const p = g.planets[e.planet]
          if (e.owner === ME) {
            toast(`${p.name} is ours`, 'good', { k: 'planet', id: p.id })
            sound.capture(true)
          } else if (e.from === ME) {
            toast(`We lost ${p.name}`, 'bad', { k: 'planet', id: p.id })
            sound.capture(false)
            sound.galaxyThreat()
          }
        } else if (e.k === 'built' && e.owner === ME) {
          // The new ship joins our fleet at the planet: clicking picks that fleet.
          toast(`${UNIT[e.unit].name} ready at ${g.planets[e.planet].name}`, 'info', { k: 'fleetAt', planet: e.planet })
          sound.shipReady(myFaction, UNIT[e.unit].tier)
        } else if (e.k === 'works' && e.owner === ME) {
          toast(`${g.planets[e.planet].name}: ${workName(e.what)} built`, 'good', { k: 'planet', id: e.planet })
          sound.levelUp()
        } else if (e.k === 'orbital' && e.owner === ME) {
          toast(`${g.planets[e.planet].name}: ${e.text}`, 'good', { k: 'planet', id: e.planet })
          sound.levelUp()
        } else if (e.k === 'station' && e.owner === ME) {
          toast(`${g.planets[e.planet].name}: station level ${e.level}`, 'good', { k: 'planet', id: e.planet })
          sound.levelUp()
        } else if (e.k === 'arrived' && e.owner === ME) {
          toast(`Fleet arrived at ${g.planets[e.planet].name}`, 'info', { k: 'fleet', id: e.fleet, planet: e.planet })
        } else if (e.k === 'battle') {
          const p = g.planets[e.planet]
          if (!e.auto) {
            sound.alarm(true)
            sound.galaxyThreat()
          } else if (e.owners.includes(ME) && e.winner !== undefined) toast(`Battle at ${p.name}: ${e.winner === ME ? 'won' : 'lost'}`, e.winner === ME ? 'good' : 'bad', { k: 'planet', id: p.id })
        } else if (e.k === 'out') toast(`The ${factionName(g, e.owner)} is beaten`, e.owner === ME ? 'bad' : 'good')
        else if (e.k === 'capturing') {
          const p = g.planets[e.planet]
          if (e.owner === ME) toast(`Our fleet is taking ${p.name}: ${CAPTURE_TIME} s in orbit`, 'info', { k: 'planet', id: p.id })
          else if (e.from === ME) {
            toast(`The enemy is taking ${p.name}: ${CAPTURE_TIME} s to stop them`, 'bad', { k: 'planet', id: p.id })
            sound.alarm(false)
            sound.galaxyThreat()
          }
        } else if (e.k === 'blockaded') {
          const where = g.systems[e.system].name
          if (e.owner === ME) {
            const f = g.fleets.find((x) => x.id === e.fleet)
            toast(e.by >= 0 ? `Our fleet was pulled out of hyperspace by the blockade at ${where}` : `Our fleet stopped at ${where}: blockades closed every way on`, 'bad', f ? { k: 'fleet', id: f.id, planet: f.planet } : { k: 'system', id: e.system })
            sound.alarm(false)
            sound.galaxyThreat()
          } else if (e.by === ME) toast(`Our blockade at ${where} stopped an enemy fleet`, 'good', { k: 'system', id: e.system })
        } else if (e.k === 'yardFull' && e.owner === ME) {
          toast(`${g.planets[e.planet].name}: our fleets there are full. The ${UNIT[e.unit].name} waits in the shipyard until one makes room or leaves`, 'bad', { k: 'planet', id: e.planet })
          sound.error()
        } else if (e.k === 'payday' && e.owner === ME && e.amount > 0) {
          setPay({ id: Math.random(), amount: e.amount })
          if (getSettings().daySound) sound.payday()
        }
      }
      const news = g.events.length > 0
      if (news) {
        g.events.length = 0
        saveGalaxy(g)
      }
      drawT -= dt
      if (drawT <= 0) {
        drawT = 0.1
        // With the clock held (paused, a menu, a battle waiting) the galaxy only changes when the
        // player does something, and some orders change it without a redraw of their own: redraw
        // after any input then, rather than ten times a second for nothing.
        if (running || news || poked.current) {
          poked.current = false
          setFrame((n) => n + 1)
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g])

  // (An enemy fleet that slips out of sight is let go, as if it were gone.)
  const selFleet = sel?.kind === 'fleet' ? g.fleets.find((f) => f.id === sel.id && canSee(g, ME, f)) : undefined
  const selFleets = sel?.kind === 'fleets' ? g.fleets.filter((f) => sel.ids.includes(f.id)) : []
  const selPlanet = sel?.kind === 'planet' ? g.planets[sel.id] : undefined
  const selPlanets = sel?.kind === 'planets' ? sel.ids.map((id) => g.planets[id]) : selPlanet ? [selPlanet] : []
  // The orbit view's planet, as we know it.
  const orbitP = orbit >= 0 ? g.planets[orbit] : null
  // The planet whose orbit view and battle map are drawn: the one we're in, or the one just left
  // while they fade out.
  const shownP = orbitP ?? (gone >= 0 ? g.planets[gone] : null)
  const orbitKn = shownP ? known(g, ME, shownP) : null
  // What stands on its battle map (PlanetMap.tsx), and so where it is pictured round the planet.
  const orbitLay = useShownLayout(g, shownP, orbitKn)
  const orbitSpots = useMemo(() => (orbitLay ? mapToPolar(orbitLay.pm.map, placesOf(orbitLay.shown)) : {}), [orbitLay])
  // Where the planet and its battle map sit (worked out again only when the view changes size).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const orbitFr = useMemo(() => (shownP ? orbitAt(shownP.id) : null), [shownP, size.w, size.h])
  // The view resized while in the orbit view: the planet back where the orbit view has it.
  useEffect(() => {
    if (orbitRef.current < 0) return
    // (Still gliding in: it glides to the new place instead.)
    const G = glide.current
    if (G?.kind === 'orbit') {
      const fr = orbitAt(orbitRef.current)
      G.tx = fr.dx
      G.ty = fr.dy
      G.gk = Math.min(G.gk, Math.log(fr.k))
      aimGlide(G, W_ORBIT, W_ORBIT)
      return
    }
    glide.current = null
    moveCam(fix(camRef.current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h])
  // Something else selected (a fleet, a planet) lets go of what's picked in the orbit view.
  useEffect(() => {
    if (sel) setOrbitSel(null)
  }, [sel])
  useEffect(() => {
    // Selected fleets that are gone (merged, destroyed) let go.
    if (sel?.kind === 'fleet' && !selFleet) setSel(null)
    if (sel?.kind === 'fleets' && selFleets.length !== sel.ids.length) setSel(selFleets.length > 1 ? { kind: 'fleets', ids: selFleets.map((f) => f.id) } : selFleets.length ? { kind: 'fleet', id: selFleets[0].id } : null)
  })
  /** A box with no fleets of ours in it picked these planets: ours if any, else all of them. One
   * opens its dock; several (a whole system, say) show in the selection. */
  const pickPlanets = (ps: Planet[], add = false) => {
    const mine = ps.filter((p) => p.owner === ME)
    const ids = [...new Set([...(add ? selectedPlanets(sel) : []), ...(mine.length ? mine : ps).map((p) => p.id)])]
    setTake({})
    if (!ids.length) return setSel(null)
    setSel(ids.length === 1 ? { kind: 'planet', id: ids[0] } : { kind: 'planets', ids })
    sound.click()
  }
  /** A box or a click picked these fleets: one, several, or (an empty box) none. */
  const pickFleets = (fs: Fleet[], add = false) => {
    const ids = [...new Set([...(add ? selectedIds(sel) : []), ...fs.map((f) => f.id)])].filter((id) => g.fleets.some((f) => f.id === id && f.owner === ME))
    setTake({})
    if (!ids.length) return setSel(null)
    setSel(ids.length === 1 ? { kind: 'fleet', id: ids[0] } : { kind: 'fleets', ids })
    sound.select(myFaction, 'frigate')
  }

  // Keys, as bound in Settings (the battle's camera keys): pan (held), zoom, pause (or Space), and
  // Esc steps back out (selection, zoom, then the menu).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, select, textarea')) return
      const c = camRef.current
      const k = e.key.toLowerCase()
      const action = !e.ctrlKey && !e.metaKey && !e.altKey ? actionFor(getSettings().keys, k) : undefined
      if (state.current.menu && k !== 'escape') return
      // Ctrl+A: every fleet of ours, as in a battle.
      if ((e.ctrlKey || e.metaKey) && k === 'a') {
        e.preventDefault()
        pickFleets(g.fleets.filter((f) => f.owner === ME))
        return
      }
      if (k.startsWith('arrow') || action === 'panUp' || action === 'panDown' || action === 'panLeft' || action === 'panRight') {
        held.current.add(k)
        e.preventDefault()
      } else if (k === ' ' || action === 'pause') {
        e.preventDefault()
        setPaused((p) => !p)
      } else if (action === 'zoomIn' || k === '+') zoomBy(1.8)
      else if (action === 'zoomOut') zoomBy(1 / 1.8)
      else if (g.pending >= 0 && (k === 'backspace' || (action && action in KEY_COMMAND))) {
        // A battle waiting to be fought: it gets settled first.
        e.preventDefault()
      } else if (k === 'backspace') {
        e.preventDefault()
        runCommand('drop')
      } else if (action && action in KEY_COMMAND) {
        e.preventDefault()
        runCommand(KEY_COMMAND[action]!, e.shiftKey)
      } else if (k === 'escape') {
        if (state.current.menu) setMenu(null)
        else if (state.current.mode !== 'normal') setMode('normal')
        // The orbit view: what's picked in it, then the view itself.
        else if (orbitSel) setOrbitSel(null)
        else if (orbitRef.current >= 0) leaveOrbit(true)
        else if (sel) setSel(null)
        else if (c.k > kMin * 1.15) flyOut()
        else setMenu('menu')
      }
    }
    const up = (e: KeyboardEvent) => held.current.delete(e.key.toLowerCase())
    const blur = () => held.current.clear()
    window.addEventListener('keydown', key)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  })

  /** The ships to send: the counts picked in the fleet panel, or the whole fleet. */
  const chosen = (f: Fleet) => {
    const out: string[] = []
    for (const [id, n] of grouped(f.ships)) for (let i = 0; i < Math.min(n, take[id] ?? n); i++) out.push(id)
    return out
  }
  /** Send the selected fleets to a planet; with `queue` (Shift), as a stop after what they're doing. */
  const send = (planet: number, queue = false) => {
    // Several fleets: each flies there whole, and they join up when they arrive.
    if (selFleets.length) {
      let sent = 0
      let why: string | null = null
      for (const f of selFleets) {
        if (f.owner !== ME) continue
        const w = moveFleet(g, ME, f.id, planet, undefined, queue)
        if (w) why = w
        else sent++
      }
      if (!sent) {
        sound.error()
        if (why) toast(why, 'bad')
        return
      }
      sound.order('move', myFaction)
      return
    }
    if (!selFleet || selFleet.owner !== ME) {
      sound.error()
      toast('Select one of our fleets first', 'bad')
      return
    }
    const ships = chosen(selFleet)
    if (!ships.length) return sound.error()
    const before = new Set(g.fleets.map((f) => f.id))
    const why = moveFleet(g, ME, selFleet.id, planet, ships.length < selFleet.ships.length ? ships : undefined, queue)
    if (why) {
      sound.error()
      toast(why, 'bad')
      return
    }
    // A split-off fleet becomes the selection.
    const split = g.fleets.find((f) => !before.has(f.id))
    setSel({ kind: 'fleet', id: (split ?? selFleet).id })
    setTake({})
    sound.order('move', myFaction)
  }
  /** Right-click on a system: the planet worth going to (an enemy's, then a free one, then ours). */
  const sendToSystem = (s: number, queue = false) => {
    const ps = g.systems[s].planets.map((p) => g.planets[p])
    const target = ps.find((p) => ownerFor(g, ME, p) >= 0 && ownerFor(g, ME, p) !== ME) ?? ps.find((p) => ownerFor(g, ME, p) < 0) ?? ps[0]
    send(target.id, queue)
  }
  const pickFleet = (f: Fleet) => {
    if (dragged.current) return
    setSel({ kind: 'fleet', id: f.id })
    setTake({})
    if (f.owner === ME) sound.select(myFaction, 'frigate')
    else sound.click()
  }
  // Move mode ends with nothing of ours left to move.
  useEffect(() => {
    if (mode === 'move' && !(selFleet?.owner === ME || selFleets.length)) setMode('normal')
  })
  // Right-click gives orders on the map, Shift+right-click too: never the browser's menu (which the
  // desktop lets through with Shift elsewhere), except in a text field.
  useEffect(() => {
    const el = rootEl.current
    if (!el) return
    const stop = (e: MouseEvent) => {
      if (!(e.target as Element)?.closest?.('input, textarea')) e.preventDefault()
    }
    el.addEventListener('contextmenu', stop, true)
    return () => el.removeEventListener('contextmenu', stop, true)
  }, [])
  /** Our selected fleets, for the commands. */
  const ourSel = () => (selFleet ? [selFleet] : selFleets).filter((f) => f.owner === ME)
  /** The next fleet of ours waiting in orbit with nothing to do: selected, and shown. */
  const nextIdle = () => {
    const idle = g.fleets.filter((f) => f.owner === ME && !f.leg && !f.route.length && !f.waypoints?.length && f.planet >= 0)
    if (!idle.length) return sound.error()
    const f = idle[selFleet ? (idle.indexOf(selFleet) + 1) % idle.length : 0]
    pickFleet(f)
    const p = fleetAt(g, f)
    flyTo(p.x, p.y, Math.max(camRef.current.k, 12))
  }
  /** Send each fleet to the planet it gets to soonest of those `want` allows, or report why not. */
  const sendEach = (fs: Fleet[], want: (p: Planet, f: Fleet) => boolean, none: string, queue: boolean) => {
    let sent = 0
    for (const f of fs) {
      // From where it'll be once done, when queued.
      const last = queue ? (f.waypoints?.length ? f.waypoints[f.waypoints.length - 1] : f.route.length ? f.route[f.route.length - 1].planet : f.leg ? f.leg.planet : f.planet) : -1
      const from = last >= 0 ? { ...f, leg: null, route: [], planet: last, system: g.planets[last].system } : f
      let best = -1
      let bt = Infinity
      for (const p of g.planets) {
        if (!want(p, f)) continue
        const hops = routeTo(g, from, p.id)
        const t = hops ? hops.reduce((n, h) => n + h.total, 0) : Infinity
        if (t < bt) {
          bt = t
          best = p.id
        }
      }
      if (best >= 0 && !moveFleet(g, ME, f.id, best, undefined, queue)) sent++
    }
    if (sent) sound.order('move', myFaction)
    else {
      sound.error()
      toast(none, 'bad')
    }
  }
  /** The selection panel's commands (and their keys); Shift queues the ones that send fleets.
   * `only`: these fleets of ours instead of the selection (the action wheel on a fleet). */
  const runCommand = (c: GCommand, queue = false, only?: Fleet[]) => {
    const fs = only ?? ourSel()
    if (c === 'idle') return nextIdle()
    if (c === 'all') return pickFleets(g.fleets.filter((f) => f.owner === ME))
    if (c === 'yards') return showYard()
    if (c === 'economy') return (sound.click(), setEconomy(!economy))
    if (c === 'upgrade') {
      let done = 0
      let why: string | null = null
      for (const p of selPlanets) {
        if (p.owner !== ME) continue
        const w = upgradeStation(g, ME, p.id)
        if (w) why = w
        else done++
      }
      if (done) return sound.constructing()
      sound.error()
      return toast(why ?? 'None of these planets is ours', 'bad')
    }
    if (c === 'look') {
      const ps = only ? only.map((f) => fleetAt(g, f)) : selPlanets.length ? selPlanets.map((p) => planetAt(g, p)) : (selFleet ? [selFleet] : selFleets).map((f) => fleetAt(g, f))
      if (!ps.length) return sound.error()
      const x0 = Math.min(...ps.map((p) => p.x))
      const x1 = Math.max(...ps.map((p) => p.x))
      const y0 = Math.min(...ps.map((p) => p.y))
      const y1 = Math.max(...ps.map((p) => p.y))
      const fit = Math.min(size.w / (x1 - x0 + 60), size.h / (y1 - y0 + 60))
      return flyTo((x0 + x1) / 2, (y0 + y1) / 2, Math.min(Math.max(camRef.current.k, 12), fit))
    }
    if (!fs.length) return sound.error()
    if (c === 'move') {
      sound.click()
      return setMode(mode === 'move' ? 'normal' : 'move')
    }
    if (c === 'stop') {
      for (const f of fs) stopFleet(g, ME, f.id)
      return sound.order('move', myFaction)
    }
    if (c === 'drop') {
      const dropped = fs.filter((f) => dropWaypoint(g, ME, f.id)).length
      return dropped ? sound.click() : sound.error()
    }
    if (c === 'take') {
      // Not where it is (or is going) already.
      const busyAt = (f: Fleet) => new Set([f.planet, f.leg?.planet ?? -1, ...f.route.map((h) => h.planet), ...(f.waypoints ?? [])])
      return sendEach(fs, (p, f) => p.owner !== ME && !busyAt(f).has(p.id), 'No planet left to take within reach', queue)
    }
    if (c === 'fallback') {
      const stations = g.planets.some((p) => p.owner === ME && p.station)
      return sendEach(fs, (p) => p.owner === ME && (!stations || p.station > 0), 'None of our planets within reach', queue)
    }
    if (c === 'gather') {
      if (fs.length < 2) return sound.error()
      // At the biggest one: where it is, or where it's going.
      const big = fs.slice().sort((a, b) => b.ships.length - a.ships.length)[0]
      const at = big.route.length ? big.route[big.route.length - 1].planet : big.leg ? big.leg.planet : big.planet
      let sent = 0
      for (const f of fs) {
        if (f === big || moveFleet(g, ME, f.id, at, undefined, queue)) continue
        // Fleets stay apart at a planet unless told otherwise: these join the big one there.
        f.join = big.id
        sent++
      }
      return sent ? sound.order('move', myFaction) : sound.error()
    }
  }
  /** Look at a planet: the camera flies in and it's selected. */
  const showPlanet = (pid: number, k = 45) => {
    const q = planetAt(g, g.planets[pid])
    flyTo(q.x, q.y, Math.max(camRef.current.k, k))
    setSel({ kind: 'planet', id: pid })
  }
  /** Look at one of our fleets, wherever it is now: the camera flies there and it's selected. */
  const showFleet = (f: Fleet) => {
    const q = fleetAt(g, f)
    flyTo(q.x, q.y, Math.max(camRef.current.k, 45))
    setTake({})
    setSel({ kind: 'fleet', id: f.id })
  }
  /** Where a clicked message points: the camera flies there and selects what it's about. A fleet
   * that has since merged into another, or been lost, falls back to its planet. */
  const lookAt = (to: GLook) => {
    sound.click()
    if (to.k === 'system') return flyTo(g.systems[to.id].x, g.systems[to.id].y, Math.max(camRef.current.k, 11))
    const f = to.k === 'fleet' ? g.fleets.find((x) => x.id === to.id && x.owner === ME) : to.k === 'fleetAt' ? fleetsAt(g, to.planet).find((x) => x.owner === ME) : undefined
    if (f) return showFleet(f)
    showPlanet(to.k === 'planet' ? to.id : to.planet)
  }

  // The battle waiting for us.
  const clash = g.pending >= 0 ? clashAt(g, g.pending) : null
  // A battle that was being fought in this window before a reload: straight back into it.
  useEffect(() => {
    const saved = loadCampaignBattle(session, g.save.id)
    if (!saved) return
    const c = g.pending === saved.planet ? clashAt(g, g.pending) : null
    if (c) fight(c, saved.snap)
    else saveCampaignBattle(session, g.save.id, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (g.pending >= 0 && !clash) g.pending = -1
  })
  /** Where the waiting battle is: the camera flies there (without selecting anything). */
  const lookAtClash = (pid: number) => {
    const q = planetAt(g, g.planets[pid])
    flyTo(q.x, q.y, Math.max(camRef.current.k, 45))
  }
  // A new battle for us: fly to it, so the prompt's planet is right there on the map.
  const clashPlanet = clash?.planet ?? -1
  useEffect(() => {
    if (clashPlanet >= 0) lookAtClash(clashPlanet)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clashPlanet])

  const fight = (c: Clash, resume?: BattleSnap) => {
    // The planet's own map, its base standing where its layout has it (see clashBattle).
    const { map, sides } = clashBattle(g, c)
    const meSide = c.holder === ME ? 0 : 1
    const enemy = meSide === 0 ? c.attacker : c.holder
    onBattle({
      map,
      sides,
      me: meSide,
      ai: g.sides[enemy].ai ?? 'medium',
      profile: galaxyProfile(g, enemy),
      names: [factionName(g, c.holder), factionName(g, c.attacker)],
      resume,
      // Kept for the window as it's fought, so a reload carries on with it.
      onSnap: (snap) => saveCampaignBattle(session, g.save.id, snap ? { planet: c.planet, snap } : null),
      onDone: (w, left) => {
        saveCampaignBattle(session, g.save.id, null)
        const res = resultOf(w, c, meSide, left)
        settlePending(g, res)
        saveGalaxy(g)
      },
    })
  }

  // Panning by dragging, zooming with the wheel round the cursor.
  const toWorld = (cx: number, cy: number) => {
    const r = viewEl.current!.getBoundingClientRect()
    const c = camRef.current
    return { x: c.x + (cx - r.left - size.w / 2) / c.k, y: c.y + (cy - r.top - size.h / 2) / c.k, sx: cx - r.left, sy: cy - r.top }
  }
  // The wheel (and a touchpad pinch) sets where the zoom is heading; the clock glides there, so a
  // notch of the wheel is a smooth step and a quick spin one long glide. A native listener, as
  // React's is passive and couldn't keep a pinch from zooming the whole page.
  useEffect(() => {
    const el = viewEl.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
      // A pinch comes as small steps with Ctrl held.
      const step = clamp(-dy * (e.ctrlKey ? 0.012 : 0.0025), -0.7, 0.7)
      const r = el.getBoundingClientRect()
      const c = camRef.current
      const sx = e.clientX - r.left - el.clientWidth / 2
      const sy = e.clientY - r.top - el.clientHeight / 2
      // (From where a wheel zoom under way is heading, or the zoom into the orbit view.)
      const G = glide.current
      const raw = (G && G.kind !== 'fly' ? Math.exp(G.gk) : c.k) * Math.exp(step)
      const o = orbitRef.current
      if (o >= 0) {
        // In the orbit view the zoom goes in closer than anywhere else, out to where it lets go;
        // the planet stays where the view has it.
        if (raw >= orbitK(o) * ORBIT_LEAVE) return orbitTo(raw, W_WHEEL)
        leaveOrbit()
      } else if (step > 0) {
        // Zooming in past a planet snaps into its orbit view (the zoom's speed carrying into it).
        const p = snapPlanet(c.x + sx / c.k, c.y + sy / c.k)
        if (p && raw >= Math.min(K_MAX * 0.97, orbitK(p.id) * ORBIT_SNAP)) return enterOrbit(p.id)
      }
      const k = clamp(raw, kMinRef.current, K_MAX)
      // Zooming in draws the spot under the cursor towards the centre, under a tenth of the way a
      // notch; zooming out keeps it under the cursor.
      const pull = k > c.k && step > 0 ? Math.exp(-step * ZOOM_PULL) : 1
      const z = glide.current
      // More notches with the cursor where it was carry on with the same spot.
      if (z?.kind === 'wheel' && Math.hypot(z.cx - sx, z.cy - sy) < 6) {
        z.gk = Math.log(k)
        z.tx *= pull
        z.ty *= pull
        aimGlide(z, W_WHEEL, W_WHEEL)
      } else {
        const n = startGlide('wheel', c.x + sx / c.k, c.y + sy / c.k, sx * pull, sy * pull, Math.log(k), W_WHEEL, W_WHEEL)
        n.cx = sx
        n.cy = sy
      }
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])
  /** Drags the map so the world point `grab` sits under (cx, cy), even while a zoom glides on. (The
   * orbit view holds the camera on its planet.) */
  const dragTo = (grab: { x: number; y: number }, cx: number, cy: number) => {
    if (orbitRef.current >= 0) return
    const r = viewEl.current!.getBoundingClientRect()
    const sx = cx - r.left - size.w / 2
    const sy = cy - r.top - size.h / 2
    const z = glide.current
    if (z?.kind === 'wheel') Object.assign(z, { ax: grab.x, ay: grab.y, sx, sy, tx: sx, ty: sy, vx: 0, vy: 0, cx: NaN, cy: NaN })
    else {
      glide.current = null
      const c = camRef.current
      moveCam(fix({ x: grab.x - sx / c.k, y: grab.y - sy / c.k, k: c.k }))
    }
  }
  // The left button drags out a box that selects our fleets in it (Shift adds to the selection), and
  // a click on open space lets go of the selection; the middle button drags the map along.
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    // Fingers have their own gestures, unless the touch bar's Box mode wants a box drawn.
    if (isTouch(e) && (!getTouchMods().box || fingers.current)) return touchDown(e)
    // Orders go out on the press, as in a battle: the right button, or the left one in move mode
    // (Shift keeps it on, for the next stop). The click that follows isn't a click.
    if (e.button === 2 || (e.button === 0 && mode === 'move' && !isTouch(e))) {
      e.preventDefault()
      orderAt(e.target as Element, e.clientX, e.clientY, e.shiftKey)
      if (e.button === 0) {
        if (!e.shiftKey) setMode('normal')
        dragged.current = true
        window.addEventListener('pointerup', () => setTimeout(() => (dragged.current = false), 0), { once: true })
      }
      return
    }
    if (e.button !== 0 && e.button !== 1) return
    const pan = e.button === 1
    if (pan) e.preventDefault()
    const r = viewEl.current!.getBoundingClientRect()
    const x0 = e.clientX
    const y0 = e.clientY
    // Dragging the map holds the point grabbed under the cursor, even while a zoom glides on.
    const grab = toWorld(x0, y0)
    if (pan && glide.current?.kind === 'fly') glide.current = null
    const add = shiftOf(e)
    const finger = isTouch(e)
    const onSpace = !(e.target as Element).closest('.ew-gsys, .ew-gfleet, .ew-splanet, button')
    dragged.current = false
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId) return
      if (!dragged.current && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return
      dragged.current = true
      if (pan) dragTo(grab, m.clientX, m.clientY)
      else setBox({ x0: x0 - r.left, y0: y0 - r.top, x1: m.clientX - r.left, y1: m.clientY - r.top })
    }
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!pan && dragged.current) {
        const bx = { l: Math.min(x0, u.clientX) - r.left - 10, r: Math.max(x0, u.clientX) - r.left + 10, t: Math.min(y0, u.clientY) - r.top - 10, b: Math.max(y0, u.clientY) - r.top + 10 }
        const c = camRef.current
        const inBox = (p: { x: number; y: number }) => p.x >= bx.l && p.x <= bx.r && p.y >= bx.t && p.y <= bx.b
        const fs = g.fleets.filter((f) => f.owner === ME && inBox(fleetScreen(g, f, c, size)))
        // No fleets of ours in it: the planets (a system's all of them, zoomed out, where its star is).
        if (fs.length || (add && selectedIds(sel).size)) pickFleets(fs, add)
        else pickPlanets(g.planets.filter((p) => inBox(planetScreen(g, p, c, size))), add)
        setBox(null)
        // The touch bar's Box mode is for one box; the next drag moves the map again.
        if (finger) setTouchMod('box', false)
      } else if (!pan && onSpace && !add) {
        setSel(null)
        setOrbitSel(null)
      }
      // The click that ends a drag isn't a click.
      setTimeout(() => (dragged.current = false), 0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Touch: one finger drags the map and two pinch-zoom round their middle; a finger that stays put
  // taps (the map's own clicks then select and zoom, as with a mouse) or, held, opens the action
  // wheel. In move mode a tap sends the selected fleets there (a stop, with the sticky Shift).
  const fingers = useRef<{ at: Map<number, { x: number; y: number }>; grab: { x: number; y: number }; pinch: { d: number; k: number; wx: number; wy: number } | null; moved: boolean; /** Snapped into an orbit view: the rest of this gesture does nothing. */ snapped?: boolean; end: () => void } | null>(null)
  const press = useRef(new LongPress())
  /** Until when the map swallows clicks: the click a browser sends after a finger's gesture. */
  const noClick = useRef(0)
  /** The last tap on a planet (for a double tap). */
  const lastTap = useRef<{ pid: number; t: number } | null>(null)
  const startPinch = (st: NonNullable<typeof fingers.current>) => {
    const [a, b] = [...st.at.values()]
    const w = toWorld((a.x + b.x) / 2, (a.y + b.y) / 2)
    // The fingers take the camera (in the orbit view the planet glides on to its place).
    if (glide.current?.kind !== 'orbit') glide.current = null
    st.pinch = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), k: camRef.current.k, wx: w.x, wy: w.y }
  }
  const pinchTo = (st: NonNullable<typeof fingers.current>) => {
    const [a, b] = [...st.at.values()]
    const z = st.pinch!
    const r = viewEl.current!.getBoundingClientRect()
    const dist = Math.hypot(a.x - b.x, a.y - b.y)
    const raw = (z.k * dist) / z.d
    const sx = (a.x + b.x) / 2 - r.left - size.w / 2
    const sy = (a.y + b.y) / 2 - r.top - size.h / 2
    const o = orbitRef.current
    // Pinching in past a planet snaps into its orbit view (the rest of the pinch is let be: the
    // camera glides on into it from the pinch's own speed), and pinching out of the orbit view far
    // enough lets go.
    if (o < 0 && raw > z.k) {
      const p = snapPlanet(z.wx, z.wy)
      if (p && raw >= Math.min(K_MAX * 0.97, orbitK(p.id) * ORBIT_SNAP)) {
        const k = clamp(raw, kMinRef.current, K_MAX)
        glide.current = null
        moveCam(fix({ x: z.wx - sx / k, y: z.wy - sy / k, k }))
        st.pinch = null
        st.snapped = true
        enterOrbit(p.id)
        return
      }
    }
    if (o >= 0) {
      const fr = orbitAt(o)
      if (raw >= fr.k * ORBIT_LEAVE) {
        // In the orbit view the pinch only zooms: the planet keeps (or glides on to) its place.
        const k = clamp(raw, kMinRef.current, fr.k)
        let G = glide.current
        if (G?.kind !== 'orbit') {
          const q = planetAt(g, g.planets[o])
          G = startGlide('orbit', q.x, q.y, fr.dx, fr.dy, Math.log(k), W_ORBIT, W_ORBIT)
        }
        G.lk = G.gk = Math.log(k)
        G.vk = 0
        moveCam(glideCam(G))
        return
      }
      leaveOrbit()
      // Let go: the pinch carries on from the spot between the fingers now, where the camera is.
      glide.current = null
      const w = toWorld((a.x + b.x) / 2, (a.y + b.y) / 2)
      st.pinch = { d: Math.max(1, dist), k: camRef.current.k, wx: w.x, wy: w.y }
      return
    }
    const k = clamp(raw, kMinRef.current, K_MAX)
    glide.current = null
    moveCam(fix({ x: z.wx - sx / k, y: z.wy - sy / k, k }))
  }
  const touchDown = (e: React.PointerEvent) => {
    const busy = fingers.current
    // A first finger while others seem down: their lift went missing, so start afresh.
    if (busy && e.isPrimary) busy.end()
    else if (busy) {
      // Another finger: two pinch.
      busy.at.set(e.pointerId, { x: e.clientX, y: e.clientY })
      press.current.cancel()
      busy.moved = true
      dragged.current = true
      startPinch(busy)
      return
    }
    const target = e.target as Element
    if (target.closest('button, .ew-touchbar')) return
    const x0 = e.clientX
    const y0 = e.clientY
    const st: NonNullable<typeof fingers.current> = { at: new Map([[e.pointerId, { x: x0, y: y0 }]]), grab: toWorld(x0, y0), pinch: null, moved: false, end: () => {} }
    fingers.current = st
    dragged.current = false
    press.current.start(e, () => mapWheel(target, x0, y0))
    const move = (m: PointerEvent) => {
      const p = st.at.get(m.pointerId)
      // Once the wheel is open, the finger is choosing on it.
      if (!p || press.current.fired || st.snapped) return
      p.x = m.clientX
      p.y = m.clientY
      if (st.pinch) return pinchTo(st)
      if (!st.moved) {
        if (Math.hypot(m.clientX - x0, m.clientY - y0) <= TAP_SLOP) return
        st.moved = true
        dragged.current = true
        press.current.cancel()
      }
      dragTo(st.grab, m.clientX, m.clientY)
    }
    const up = (u: PointerEvent) => {
      if (!st.at.delete(u.pointerId)) return
      if (st.at.size >= 2) return startPinch(st)
      if (st.at.size === 1) {
        // One finger left: it drags on from where it is.
        st.pinch = null
        const [p] = st.at.values()
        st.grab = toWorld(p.x, p.y)
        return
      }
      st.end()
      if (st.moved || press.current.fired) noClick.current = performance.now() + 400
      else if (u.type === 'pointerup') {
        const shift = getTouchMods().shift
        if (mode === 'move') {
          orderAt(target, u.clientX, u.clientY, shift, true)
          if (!shift) setMode('normal')
          noClick.current = performance.now() + 400
        } else {
          // A double tap on a planet: its orbit view.
          const hit = mapHit(target, u.clientX, u.clientY)
          const now = performance.now()
          const pid = hit && 'planet' in hit ? hit.planet.id : -1
          if (pid >= 0 && lastTap.current?.pid === pid && now - lastTap.current.t < 400) {
            lastTap.current = null
            enterOrbit(pid)
            noClick.current = now + 400
          } else {
            lastTap.current = pid >= 0 ? { pid, t: now } : null
            if (!target.closest('.ew-gsys, .ew-gfleet, .ew-splanet') && !shift) {
              setSel(null)
              setOrbitSel(null)
            }
          }
        }
      }
      setTimeout(() => (dragged.current = false), 0)
    }
    st.end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (fingers.current === st) fingers.current = null
      press.current.cancel()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  /**
   * An order at a spot on the map (a right-click, or a click in move mode): a planet, a system or a
   * fleet's badge under the cursor (a fleet: where it is), else the nearest planet (zoomed in) or
   * system (zoomed out) near the cursor, so it needn't land exactly on it.
   */
  const orderAt = (target: Element, cx: number, cy: number, queue: boolean, touch = false) => {
    if (!selFleet && !selFleets.length) return
    const hit = target.closest('[data-pid], [data-sid], [data-fid]')
    if (hit instanceof SVGElement || hit instanceof HTMLElement) {
      const { pid, sid, fid } = hit.dataset
      if (pid) return send(Number(pid), queue)
      if (sid) return sendToSystem(Number(sid), queue)
      const f = g.fleets.find((x) => x.id === Number(fid))
      const to = f ? (f.leg ? (f.route.length ? f.route[f.route.length - 1].planet : f.leg.planet) : f.planet) : -1
      if (f && !selectedIds(sel).has(f.id) && to >= 0) return send(to, queue)
    }
    const at = toWorld(cx, cy)
    const k = camRef.current.k
    if (detail(k) > 0.5) {
      const p = g.planets.reduce((b, x) => (Math.hypot(planetAt(g, x).x - at.x, planetAt(g, x).y - at.y) < Math.hypot(planetAt(g, b).x - at.x, planetAt(g, b).y - at.y) ? x : b))
      const q = planetAt(g, p)
      if (Math.hypot(q.x - at.x, q.y - at.y) * k < Math.max(90, planetR(p) * k * 2.5)) return send(p.id, queue)
    } else {
      const s = g.systems.reduce((b, x) => (Math.hypot(x.x - at.x, x.y - at.y) < Math.hypot(b.x - at.x, b.y - at.y) ? x : b))
      if (Math.hypot(s.x - at.x, s.y - at.y) * k < 60) return sendToSystem(s.id, queue)
    }
    if (selFleet?.owner === ME || selFleets.length) {
      sound.error()
      toast(touch ? 'Tap a planet or a system to send the fleet there' : 'Right-click a planet or a system to send the fleet there', 'bad')
    }
  }

  // The fleet inventory: our fleets at the selected planet (or where the selected fleets are), or
  // the one selected fleet of ours in flight.
  const selAll = selFleet ? [selFleet] : selFleets
  const invPlanet = selPlanet ? selPlanet.id : selAll.length && selAll.every((f) => !f.leg && f.planet >= 0 && f.planet === selAll[0].planet) ? selAll[0].planet : -1
  const invFlight = invPlanet < 0 && selFleet?.owner === ME && selFleet.leg ? selFleet : undefined
  const invKey = invPlanet >= 0 ? `p${invPlanet}` : invFlight ? `f${invFlight.id}` : null
  const showInv = !!invKey && invKey !== invClosed && (!!invFlight || fleetsAt(g, invPlanet).some((f) => f.owner === ME))

  const myIncome = incomeOf(g, ME)
  const myFleets = g.fleets.filter((f) => f.owner === ME)
  const idleFleets = myFleets.filter((f) => !f.leg && !f.route.length && !f.waypoints?.length && f.planet >= 0)
  // The shipyards across our planets: what's queued, and what comes off a slip next.
  const yards = g.planets.filter((p) => p.owner === ME && p.queue.length)
  const queued = yards.reduce((n, p) => n + p.queue.length, 0)
  const nextJob = yards.map((p) => ({ p, q: p.queue[0] })).sort((a, b) => a.q.left - b.q.left)[0]
  const showYard = () => {
    sound.click()
    const list = (yards.length ? yards : g.planets.filter((p) => p.owner === ME && p.station)).sort((a, b) => (a.queue[0]?.left ?? 1e9) - (b.queue[0]?.left ?? 1e9))
    if (!list.length) return sound.error()
    const i = selPlanet ? (list.indexOf(selPlanet) + 1) % list.length : 0
    showPlanet(list[i].id, 30)
  }
  /** Our capital: the planet with our biggest station (the richest, between equals). */
  const toCapital = () => {
    const cap = g.planets.filter((p) => p.owner === ME).sort((a, b) => b.station - a.station || planetIncome(g, b) - planetIncome(g, a))[0]
    if (cap) showPlanet(cap.id, 30)
    else sound.error()
  }

  /** What's under a finger on the map: a planet, a system or a fleet's badge (zoomed out, a badge
   * stands for its side's fleets parked there), else the nearest of them close by. */
  const mapHit = (target: Element, cx: number, cy: number): { planet: Planet } | { system: number } | { fleets: Fleet[] } | null => {
    const c = camRef.current
    const out = detail(c.k) < 0.5
    const group = (f: Fleet) => (!f.leg && out ? g.fleets.filter((x) => !x.leg && x.system === f.system && x.owner === f.owner && canSee(g, ME, x)) : [f])
    const hit = target.closest('[data-pid], [data-sid], [data-fid]')
    if (hit instanceof SVGElement || hit instanceof HTMLElement) {
      const { pid, sid, fid } = hit.dataset
      if (pid) return { planet: g.planets[Number(pid)] }
      if (sid) return { system: Number(sid) }
      const f = g.fleets.find((x) => x.id === Number(fid))
      if (f && canSee(g, ME, f)) return { fleets: group(f) }
    }
    // Fingers are broad: a fleet's badge within reach, then a planet or system as orders find them.
    const r = viewEl.current!.getBoundingClientRect()
    let near: Fleet | null = null
    let best = 26
    for (const f of g.fleets) {
      if (!canSee(g, ME, f)) continue
      const q = fleetScreen(g, f, c, size)
      const dd = Math.hypot(q.x - (cx - r.left), q.y - (cy - r.top))
      if (dd < best) (near = f), (best = dd)
    }
    if (near) return { fleets: group(near) }
    const at = toWorld(cx, cy)
    if (!out) {
      const p = g.planets.reduce((b, x) => (Math.hypot(planetAt(g, x).x - at.x, planetAt(g, x).y - at.y) < Math.hypot(planetAt(g, b).x - at.x, planetAt(g, b).y - at.y) ? x : b))
      const q = planetAt(g, p)
      if (Math.hypot(q.x - at.x, q.y - at.y) * c.k < Math.max(90, planetR(p) * c.k * 2.5)) return { planet: p }
    } else {
      const sys = g.systems.reduce((b, x) => (Math.hypot(x.x - at.x, x.y - at.y) < Math.hypot(b.x - at.x, b.y - at.y) ? x : b))
      if (Math.hypot(sys.x - at.x, sys.y - at.y) * c.k < 60) return { system: sys.id }
    }
    return null
  }
  /** Opens the action wheel (from the WheelHost round the screen). */
  const wheel = useRef<(r: WheelRequest | null) => void>(() => {})
  /** A long press on the map: what can be done with what's under the finger, on the action wheel. */
  const mapWheel = (target: Element, cx: number, cy: number) => {
    const hit = mapHit(target, cx, cy)
    const ours = ourSel()
    const noFleet = ours.length ? false : 'Select one of our fleets first'
    const k = camRef.current.k
    const ic = (name: IconName) => <Icon name={name} size={18} />
    let title: string
    let items: WheelItem[]
    if (hit && 'planet' in hit) {
      const p = hit.planet
      const mine = p.owner === ME
      const k = known(g, ME, p)
      title = `${p.name} · ${k.owner < 0 ? 'unclaimed' : mine ? 'ours' : factionName(g, k.owner)}${k.live ? '' : ` (day ${dayOf(k.t)})`} · +${k.live ? planetIncome(g, p) : knownIncome(p, k.station)} a day`
      items = [
        { id: 'send', label: 'Send fleet', icon: ic('move'), disabled: noFleet, run: () => send(p.id) },
        { id: 'queue', label: 'Add stop', icon: ic('rally'), disabled: noFleet, run: () => send(p.id, true) },
        { id: 'open', label: mine && p.station ? 'Shipyard' : 'Open', icon: ic(mine && p.station ? 'yard' : 'target'), run: () => (sound.click(), setTake({}), setSel({ kind: 'planet', id: p.id })) },
      ]
      if (mine && p.station < 4)
        items.push({
          id: 'upgrade', label: p.station ? 'Upgrade station' : 'Build station', icon: ic('yard'), disabled: cantUpgradeStation(g, ME, p.id) ?? false,
          run: () => {
            const why = upgradeStation(g, ME, p.id)
            if (!why) return sound.constructing()
            sound.error()
            toast(why, 'bad')
          },
        })
      items.push({ id: 'zoom', label: 'Orbit view', icon: ic('radar'), run: () => (sound.click(), enterOrbit(p.id)) })
    } else if (hit && 'system' in hit) {
      const sys = g.systems[hit.system]
      title = `${sys.name} · ${sys.planets.length} planet${sys.planets.length > 1 ? 's' : ''}`
      items = [
        { id: 'send', label: 'Send fleet', icon: ic('move'), disabled: noFleet, run: () => sendToSystem(sys.id) },
        { id: 'queue', label: 'Add stop', icon: ic('rally'), disabled: noFleet, run: () => sendToSystem(sys.id, true) },
        { id: 'planets', label: 'Its planets', icon: ic('target'), run: () => pickPlanets(sys.planets.map((pid) => g.planets[pid])) },
        { id: 'zoom', label: 'Zoom in', icon: ic('radar'), run: () => (sound.click(), flyTo(sys.x, sys.y, Math.max(k, 11))) },
      ]
    } else if (hit && hit.fleets[0].owner === ME) {
      const fs = hit.fleets
      const f = fs[0]
      // Orders go to the selection when the finger is on part of it, else to these fleets.
      const acts = fs.some((x) => selectedIds(sel).has(x.id)) ? ours : fs
      const here = f.leg ? [] : g.fleets.filter((x) => x.owner === ME && !x.leg && (detail(k) < 0.5 ? x.system === f.system : x.planet === f.planet))
      title = `${fs.length > 1 ? `Our ${fs.length} fleets` : 'Our fleet'} · ${fs.reduce((n, x) => n + x.ships.length, 0)} ships`
      items = [
        { id: 'select', label: fs.length > 1 ? 'Select them' : 'Select', icon: ic('fleet'), run: () => pickFleets(fs) },
        { id: 'here', label: 'All here', icon: ic('army'), disabled: f.leg ? 'In flight' : false, run: () => pickFleets(here) },
        { id: 'stop', label: 'Stop', icon: ic('stop'), run: () => runCommand('stop', false, acts) },
        { id: 'gather', label: 'Gather', icon: ic('rally'), disabled: acts.length < 2 ? 'Needs two fleets or more' : false, run: () => runCommand('gather', false, acts) },
        { id: 'fallback', label: 'Fall back', icon: ic('jump'), run: () => runCommand('fallback', false, acts) },
        { id: 'drop', label: 'Drop stop', icon: ic('back'), disabled: acts.some((x) => x.waypoints?.length) ? false : 'No stops queued', run: () => runCommand('drop', false, acts) },
        { id: 'look', label: 'Look', icon: ic('target'), run: () => runCommand('look', false, acts) },
      ]
    } else if (hit) {
      const f = hit.fleets[0]
      const to = f.leg ? (f.route.length ? f.route[f.route.length - 1].planet : f.leg.planet) : f.planet
      const noTarget = noFleet || (to < 0 ? 'Nowhere to meet it' : false)
      title = `${factionName(g, f.owner)} fleet${hit.fleets.length > 1 ? `s (${hit.fleets.length})` : ''} · ${hit.fleets.reduce((n, x) => n + x.ships.length, 0)} ships`
      items = [
        { id: 'send', label: 'Attack', icon: ic('attack'), disabled: noTarget, run: () => send(to) },
        { id: 'queue', label: 'Add stop', icon: ic('rally'), disabled: noTarget, run: () => send(to, true) },
        { id: 'select', label: 'Info', icon: ic('fleet'), run: () => (sound.click(), setTake({}), setSel({ kind: 'fleet', id: f.id })) },
        {
          id: 'look', label: 'Look', icon: ic('target'),
          run: () => {
            const q = fleetAt(g, f)
            flyTo(q.x, q.y, Math.max(k, 12))
          },
        },
      ]
    } else {
      title = 'The galaxy'
      items = [
        { id: 'all', label: 'All fleets', icon: ic('army'), disabled: myFleets.length ? false : 'We have no fleets', run: () => runCommand('all') },
        { id: 'idle', label: 'Next idle', icon: ic('idle'), disabled: idleFleets.length ? false : 'No fleet is idle', run: nextIdle },
        { id: 'move', label: mode === 'move' ? 'Cancel move' : 'Move mode', icon: ic('move'), disabled: mode !== 'move' && noFleet, run: () => (mode === 'move' ? (sound.click(), setMode('normal')) : runCommand('move')) },
        { id: 'whole', label: 'Whole galaxy', icon: ic('radar'), run: flyOut },
        { id: 'capital', label: 'Capital', icon: ic('target'), disabled: g.planets.some((p) => p.owner === ME) ? false : 'We hold no planets', run: toCapital },
        { id: 'yards', label: 'Shipyards', icon: ic('yard'), disabled: g.planets.some((p) => p.owner === ME && p.station) ? false : 'No stations', run: showYard },
        { id: 'clear', label: 'Let go', icon: ic('back'), disabled: sel ? false : 'Nothing selected', run: () => (setSel(null), setTake({})) },
      ]
    }
    wheel.current({ x: cx, y: cy, title, items })
  }

  return (
    <div ref={rootEl} className={`ew-root ew-deck ew-galaxy ew-${myFaction} ${selPlanet ? 'has-dock' : ''} ${mapOpen ? 'is-map-open' : ''} ${sheetOpen ? 'has-sheet' : ''}`} style={{ ['--ew-accent' as string]: FACTIONS[myFaction].color }} onContextMenu={noMenu}>
      <WheelHost>
        <WheelHook to={wheel} />
        <Tips />
        {/* The same top bar as a battle's, in the same order: faction, credits, fleet, planets; then
            on the right the shipyards, the time and the menu. */}
        <div className="ew-top ew-gtop">
          <button className={`ew-top-cell ew-top-faction ${fleetsOpen ? 'is-on' : ''}`} onClick={() => (sound.click(), setFleetsOpen(!fleetsOpen), setMapOpen(false))}
            data-tip={`Our fleets: ${myFleets.length}. Click to show or hide the list.`} aria-label="Our fleets">
            <span className="ew-emblem">
              <img src={FACTIONS[myFaction].emblem} alt="" />
              {myFleets.length > 0 && <em>{myFleets.length}</em>}
            </span>
            <div>
              <strong>{FACTIONS[myFaction].name} <em className="ew-beta" data-tip="Galactic conquest is still being built: expect rough edges, and changes to come">Beta</em></strong>
              <small><MapWhere g={g} view={view} /></small>
            </div>
          </button>
          <button className={`ew-top-cell ew-creditcell ${economy ? 'is-on' : ''}`} onClick={() => (sound.click(), setEconomy(!economy))}
            data-tip={`Credits and income per day: our ${g.planets.filter((p) => p.owner === ME).length} planets pay ${fmt(myIncome)} at the end of every day.\nClick for the economy: where it comes from, the best and worst planets, and recent purchases.`}>
            <span className="ew-gold"><Icon name="credits" size={20} /></span>
            <b className="ew-big">{fmt(mine.credits)}</b>
            <small className="ew-good">+{fmt(myIncome)} / day</small>
            {pay && <em key={pay.id} className="ew-gpaid">+{fmt(pay.amount)}</em>}
          </button>
          <div className="ew-top-cell ew-gshipscell" data-tip={`Ships in our ${myFleets.length} fleets`}>
            <Icon name="fleet" size={20} />
            <b className="ew-big">{myFleets.reduce((n, f) => n + f.ships.length, 0)}</b>
            <small>in {myFleets.length}</small>
          </div>
          <div className="ew-top-cell ew-hide-narrow" data-tip="Planets held: ours, and the enemy's">
            <span className="ew-good"><Icon name="radar" size={17} /></span>
            <b>{g.planets.filter((p) => p.owner === ME).length}</b>
            <small>vs</small>
            <b className="ew-bad">{g.planets.filter((p) => p.owner >= 0 && p.owner !== ME).length}</b>
            <small>/ {g.planets.length}</small>
          </div>
          <div className="ew-top-right">
            {/* The shipyards: a bar filling as the next ship comes off a slip, a badge counting
                what's queued across every planet; a click looks at the busiest yard. */}
            <button className={`ew-top-cell ew-jobbtn ${nextJob ? 'is-busy' : ''}`} onClick={showYard} aria-label="Shipyards"
              data-tip={nextJob ? `Shipyards: ${queueName(g, ME, nextJob.p, nextJob.q)} at ${nextJob.p.name}, ${Math.ceil(nextJob.q.left)} s left${queued > 1 ? `, ${queued - 1} more queued` : ''}.\nClick to look at the next yard.` : 'Shipyards idle.\nClick to look at a planet with a station.'}>
              <Icon name="yard" size={18} />
              {queued > 0 && <em>{queued}</em>}
              {nextJob && <i style={{ transform: `scaleX(${1 - nextJob.q.left / nextJob.q.total})` }} />}
            </button>
            {/* Time: pause and play, the week, and the speed, which cycles 1x, 2x, 4x. */}
            <div className={`ew-top-cell ew-timectl ${paused ? 'is-paused' : ''}`} role="group" aria-label="Time">
              <button onClick={() => setPaused(!paused)} data-tip={`${paused ? 'Resume' : 'Pause'} (${keyName(getSettings().keys.pause)} or Space)`} aria-label={paused ? 'Resume' : 'Pause'}>
                <Icon name={paused ? 'play' : 'pause'} size={16} />
              </button>
              <WeekClock g={g} />
              <button className="ew-speedbtn" onClick={() => setSpeed(speed === 1 ? 2 : speed === 2 ? 4 : 1)} data-tip="Galaxy speed: click to cycle 1x, 2x, 4x" aria-label={`Galaxy speed ${speed}x`}>
                {speed}×
              </button>
            </div>
            <button className="ew-top-cell ew-top-btn" onClick={() => setMenu('menu')} data-tip="Campaign menu: save, settings, window layout (Esc)" aria-label="Menu">
              <Icon name="menu" size={18} />
            </button>
          </div>
        </div>

        <div
          className={`ew-gview ${mode === 'move' ? 'is-ordering' : ''}`}
          ref={viewEl}
          onPointerDown={onPointerDown}
          onClickCapture={(e) => {
            if (performance.now() > noClick.current) return
            noClick.current = 0
            e.stopPropagation()
            e.preventDefault()
          }}
          onPointerMove={(e) => {
            // Fingers don't scroll the screen edges.
            if (isTouch(e)) return
            const r = e.currentTarget.getBoundingClientRect()
            mouse.current = { x: e.clientX - r.left, y: e.clientY - r.top, inside: true }
          }}
          onPointerLeave={() => (mouse.current.inside = false)}
        >
          <GalaxyView
            g={g}
            view={view}
            sel={sel}
            orbit={orbit}
            on={{
              system: (s) => {
                if (dragged.current) return
                sound.click()
                const sys = g.systems[s]
                flyTo(sys.x, sys.y, Math.max(camRef.current.k, 11))
              },
              planet: (p, double) => {
                if (dragged.current) return
                sound.click()
                if (double) enterOrbit(p.id)
                // A finger tapping the planet that is selected puts it away again.
                else if (compact && sel?.kind === 'planet' && sel.id === p.id) setSel(null)
                else setSel({ kind: 'planet', id: p.id })
              },
              fleet: (f) => {
                if (compact && !dragged.current && sel?.kind === 'fleet' && sel.id === f.id) return (setSel(null), sound.click())
                pickFleet(f)
              },
              fleets: (fs) => {
                if (dragged.current) return
                const had = selectedIds(sel)
                if (compact && had.size === fs.length && fs.every((f) => had.has(f.id))) return (setSel(null), sound.click())
                pickFleets(fs)
              },
            }}
          />
          {/* The orbit view and its battle map: they fade in as the view is entered, and out (no
              longer taking the pointer) for a moment after it's left (empires.css). */}
          {shownP && orbitKn && (
            <div className={`ew-orbitfade ${orbitP ? '' : 'is-gone'}`} onAnimationEnd={(e) => e.animationName === 'ew-orbit-fadeout' && orbitRef.current < 0 && setGone(-1)}>
              <OrbitView
                p={shownP}
                at={planetAt(g, shownP)}
                R={planetR(shownP)}
                view={view}
                kIn={orbitK(shownP.id)}
                sel={orbitSel}
                faction={orbitKn.owner >= 0 ? g.sides[orbitKn.owner].faction : myFaction}
                live={orbitKn.live}
                base={orbitKn.base}
                station={orbitKn.station}
                spots={orbitSpots}
                onPick={(id) => {
                  sound.click()
                  setOrbitSel(id)
                  if (id && sel) setSel(null)
                }}
              />
              {orbitLay && orbitFr && (
                <PlanetMapPanel
                  g={g}
                  p={shownP}
                  kn={orbitKn}
                  lay={orbitLay}
                  view={view}
                  at={planetAt(g, shownP)}
                  span={ORBIT_REACH * 2 * planetR(shownP)}
                  kIn={orbitK(shownP.id)}
                  frame={orbitFr}
                  sel={orbitSel}
                  coarse={compact}
                  sound={sound}
                  toast={toast}
                  onPick={(id) => {
                    sound.click()
                    setOrbitSel(id)
                    if (id && sel) setSel(null)
                  }}
                  onChange={() => setFrame((n) => n + 1)}
                />
              )}
            </div>
          )}
          {orbitP && (
            <div className="ew-orbithint" onPointerDown={(e) => e.stopPropagation()}>
              <span><b>Orbit view</b> · {orbitP.name}{orbitP.owner === ME ? (compact ? ': tap a structure for its orders, drag it on the battle map to place it' : ': click a structure for its orders, drag it on the battle map to place it') : ''}</span>
              <button onClick={() => (sound.click(), leaveOrbit(true))} data-tip="Back out to the system (Esc)">{compact ? 'Leave' : 'Leave · Esc'}</button>
            </div>
          )}
          {box && <div className="ew-gbox" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />}
          <div className="ew-gzoom">
            <button onClick={() => zoomBy(2)} data-tip={`Zoom in (${keyName(getSettings().keys.zoomIn)} or the wheel)`}>+</button>
            <button onClick={() => zoomBy(0.5)} data-tip={`Zoom out (${keyName(getSettings().keys.zoomOut)} or the wheel)`}>−</button>
            <button onClick={flyOut} data-tip="The whole galaxy (Esc)"><Icon name="radar" size={14} /></button>
            {/* Phones and short screens: the galaxy map, hidden there until asked for. */}
            <button className={`ew-gmapbtn ${mapOpen ? 'is-on' : ''}`} onClick={() => (sound.click(), setMapOpen(!mapOpen), mapOpen || setFleetsOpen(false))} aria-pressed={mapOpen} aria-label="Galaxy map" data-tip="Show or hide the galaxy map">
              <Icon name="grid" size={14} />
            </button>
          </div>
        </div>
        <TouchBar className="ew-gtouchbar" extra={
          <button className={mode === 'move' ? 'is-on' : ''} aria-pressed={mode === 'move'} disabled={mode !== 'move' && !ourSel().length} onClick={() => (mode === 'move' ? (sound.click(), setMode('normal')) : runCommand('move'))}
            title={mode === 'move' ? 'Cancel move mode' : 'Move: the next tap on the map sends the selected fleets there'}>
            <Icon name="move" size={16} /><span>{mode === 'move' ? 'Cancel' : 'Move'}</span>
          </button>
        } />

        {compact && sel && (sheetOpen ? <GSheetHead g={g} sel={sel} onDeselect={() => (setSel(null), sound.click())} onClose={() => (setSelOpen(false), sound.click())} />
          : <div className="ew-gselchipbar"><GSelChip g={g} sel={sel} onOpen={() => (setSelOpen(true), sound.click())} onClear={() => (setSel(null), sound.click())} /></div>)}

        {/* Our fleets, to find them quickly. */}
        {fleetsOpen && <Floating id="gFleets" title="Our fleets" at={{ left: 6, top: 56 }} className="ew-gfleets" layout={galaxyLayout} onClose={() => setFleetsOpen(false)} aside={<b className="ew-selcount">{myFleets.length || ''}</b>}>
          {myFleets.length ? (
            <ul>
              {myFleets.map((f) => (
                <li key={f.id}>
                  <button className={selectedIds(sel).has(f.id) ? 'is-on' : ''} onClick={() => {
                    pickFleet(f)
                    const p = fleetAt(g, f)
                    flyTo(p.x, p.y, Math.max(camRef.current.k, 12))
                  }}>
                    <b>{f.ships.length}</b>
                    <span>{f.leg ? `→ ${g.planets[(f.route.length ? f.route[f.route.length - 1] : f.leg).planet]?.name ?? g.systems[f.leg.system].name}` : g.planets[f.planet]?.name}</span>
                    {f.leg && <small>{secs(eta(f))}</small>}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <span className="ew-muted ew-small">No fleets. Build ships at a planet with a station.</span>
          )}
        </Floating>}

        <GalaxyMinimap
          g={g}
          view={view}
          onLook={(x, y) => {
            leaveOrbit()
            glide.current = null
            moveCam(fix({ ...camRef.current, x, y }))
          }}
          onWhole={flyOut}
          onCapital={toCapital}
          idle={idleFleets.length}
          onIdle={nextIdle}
          economy={economy}
          onEconomy={() => (sound.click(), setEconomy(!economy))}
        />

        {(!compact || sheetOpen) && <GalaxySelection
          g={g}
          fleets={selFleet ? [selFleet] : selFleets}
          planets={sel?.kind === 'planets' ? selPlanets : []}
          take={take}
          setTake={setTake}
          mode={mode}
          onCommand={(c) => runCommand(c)}
          onFleets={(fs, drop) => {
            const ids = drop ? [...selectedIds(sel)].filter((id) => !fs.some((f) => f.id === id)) : fs.map((f) => f.id)
            setTake({})
            setSel(ids.length > 1 ? { kind: 'fleets', ids } : ids.length ? { kind: 'fleet', id: ids[0] } : null)
            sound.click()
          }}
          onPlanets={(ps, drop) => {
            const ids = drop ? [...selectedPlanets(sel)].filter((id) => !ps.some((p) => p.id === id)) : ps.map((p) => p.id)
            setSel(ids.length > 1 ? { kind: 'planets', ids } : ids.length ? { kind: 'planet', id: ids[0] } : null)
            sound.click()
          }}
          enabled={(c) => {
            const fs = ourSel()
            if (c === 'idle') return myFleets.some((f) => !f.leg && !f.route.length && !f.waypoints?.length && f.planet >= 0)
            if (c === 'all') return myFleets.length > 0
            if (c === 'look') return selFleets.length > 0 || !!selFleet || selPlanets.length > 0
            if (c === 'yards') return g.planets.some((p) => p.owner === ME && p.station)
            if (c === 'economy') return true
            if (c === 'upgrade') return selPlanets.some((p) => p.owner === ME && !cantUpgradeStation(g, ME, p.id))
            if (c === 'gather') return fs.length > 1
            if (c === 'drop') return fs.some((f) => f.waypoints?.length)
            return fs.length > 0
          }}
        />}
        {showInv && (!compact || sheetOpen) && (
          <FleetInventory
            key={invKey}
            g={g}
            planet={invPlanet}
            flight={invFlight}
            selected={selectedIds(sel)}
            sound={sound}
            toast={toast}
            onSelect={(f) => {
              setTake({})
              setSel({ kind: 'fleet', id: f.id })
              sound.select(myFaction, 'frigate')
            }}
            onMoved={(from, to) => {
              // A selected fleet that gave away all it had: the selection follows its ships.
              if (g.fleets.some((f) => f.id === from)) return
              if (sel?.kind === 'fleet' && sel.id === from) setSel({ kind: 'fleet', id: to.id })
              else if (sel?.kind === 'fleets' && sel.ids.includes(from)) {
                const ids = [...new Set(sel.ids.map((id) => (id === from ? to.id : id)))]
                setSel(ids.length > 1 ? { kind: 'fleets', ids } : { kind: 'fleet', id: ids[0] })
              }
            }}
            onClose={() => setInvClosed(invKey)}
          />
        )}
        {orbitP && orbitSel && (
          <OrbitCard key={`${orbitP.id}:${orbitSel}`} g={g} p={orbitP} id={orbitSel} sound={sound} toast={toast} onClose={() => (sound.click(), setOrbitSel(null))} />
        )}
        {selPlanet && !(orbitSel && orbitP === selPlanet) && (!compact || sheetOpen) && (
          <PlanetDock
            g={g}
            p={selPlanet}
            sound={sound}
            onClose={() => setSel(null)}
            onFleet={pickFleet}
            onLook={() => enterOrbit(selPlanet.id)}
            onOpen={(id) => {
              // As a click on that structure in the orbit view: into the view (if not in it), and it picked.
              if (orbitRef.current !== selPlanet.id) enterOrbit(selPlanet.id)
              setOrbitSel(id)
            }}
            toast={toast}
          />
        )}
        {economy && <GalaxyEconomy g={g} onClose={() => setEconomy(false)} onPlanet={(pid) => showPlanet(pid)} onSystem={(s) => flyTo(g.systems[s].x, g.systems[s].y, Math.max(camRef.current.k, 11))} />}

        <div className="ew-toasts">
          {toasts.map((t) => {
            const dismiss = () => setToasts((ts) => ts.filter((x) => x.id !== t.id))
            // A message about a place takes the camera there (click, tap, or Enter), and is done with.
            const to = t.to
            const go = to ? () => (lookAt(to), dismiss()) : undefined
            return (
              <section
                key={t.id}
                className={`ew-frame ew-toast is-${t.tone}${go ? ' is-link' : ''}`}
                role={go ? 'button' : undefined}
                tabIndex={go ? 0 : undefined}
                onClick={go}
                onKeyDown={go && ((e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), e.stopPropagation(), go()))}
                onContextMenu={(e) => (e.preventDefault(), dismiss())}
                onPointerUp={(e) => isTouch(e) && !go && dismiss()}
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

        {clash && g.winner === -1 && (
          <BattlePrompt
            g={g}
            c={clash}
            onShow={() => lookAtClash(clash.planet)}
            onFight={() => {
              sound.click()
              fight(clash)
            }}
            onAuto={() => {
              sound.click()
              settlePending(g, 'auto')
              saveGalaxy(g)
              setFrame((n) => n + 1)
            }}
            onRetreat={() => {
              sound.click()
              withdraw(g, ME)
              saveGalaxy(g)
              setFrame((n) => n + 1)
            }}
          />
        )}

        {g.winner !== -1 && (
          <div className="ew-modal-back">
            <div className={`ew-modal ew-result ${g.winner === ME ? 'is-won' : 'is-lost'}`}>
              <Frame title={g.winner === ME ? 'Victory' : 'Defeat'}>
                <h2>{g.winner === ME ? 'The galaxy is ours' : 'The war is lost'}</h2>
                <p className="ew-muted">{g.winner === ME ? `The ${factionName(g, 1)} holds no planets and no fleets.` : `The ${factionName(g, 1)} took everything we held.`} Week {calendar(g.time).week + 1}.</p>
                <div className="ew-menu-list is-row">
                  <button className="ew-menu-btn is-primary" onClick={onAbandon}>New campaign</button>
                  <button className="ew-menu-btn" onClick={onEnd}>Main menu</button>
                </div>
              </Frame>
            </div>
          </div>
        )}

        {menu === 'menu' && (
          <Modal title="Galactic conquest" onClose={() => setMenu(null)}>
            <div className="ew-menu-list">
              <button className="ew-menu-btn is-primary" onClick={() => setMenu(null)}><Icon name="play" size={18} /> Resume</button>
              <button className="ew-menu-btn" onClick={() => {
                const ok = saveGalaxy(g)
                toast(ok ? `Saved: ${g.save.name}` : 'Could not save: the browser\'s storage is full', ok ? 'good' : 'bad')
                setMenu(null)
              }}
                data-tip={`Save into "${g.save.name}". It also saves by itself as you play.`}>
                <Icon name="yard" size={18} /> Save
              </button>
              <button className="ew-menu-btn" onClick={() => (setSaveName(g.save.name), setMenu('saveas'))} data-tip="Save a copy under a new name, and play on in that one">
                <Icon name="keys" size={18} /> Save as…
              </button>
              <button className="ew-menu-btn" onClick={() => (saveGalaxy(g), setMenu('load'))} data-tip="Switch to another saved campaign (this one is saved first)">
                <Icon name="back" size={18} /> Load game…
              </button>
              <button className="ew-menu-btn" onClick={() => setMenu('settings')}><Icon name="gear" size={18} /> Settings</button>
              <button className="ew-menu-btn" onClick={onExit}><Icon name="exit" size={18} /> Save and quit to the main menu</button>
              <button className="ew-menu-btn is-danger" onClick={() => setMenu('abandon')}>Abandon this campaign</button>
            </div>
            <LayoutSection store={galaxyLayout} campaign />
          </Modal>
        )}
        {menu === 'saveas' && (
          <Modal title="Save as" onClose={() => setMenu('menu')}>
            <form className="ew-saveas" onSubmit={(e) => {
              e.preventDefault()
              if (!saveName.trim()) return
              const ok = saveGalaxy(g, saveName)
              toast(ok ? `Saved as: ${g.save.name}` : 'Could not save: the browser\'s storage is full', ok ? 'good' : 'bad')
              setMenu(null)
            }}>
              <label className="ew-row">
                <span>Name</span>
                <input autoFocus value={saveName} maxLength={40} onChange={(e) => setSaveName(e.target.value)} aria-label="Save name" />
              </label>
              <p className="ew-muted ew-small">A new save with this name; the campaign carries on in it, and "{g.save.name}" stays as it is now.</p>
              <div className="ew-menu-list is-row">
                <button type="submit" className="ew-menu-btn is-primary" disabled={!saveName.trim()}>Save</button>
                <button type="button" className="ew-menu-btn" onClick={() => setMenu('menu')}>Cancel</button>
              </div>
            </form>
          </Modal>
        )}
        {menu === 'load' && (
          <Modal title="Load game" onClose={() => setMenu('menu')} wide>
            <SaveList sound={sound} current={g.save.id} onLoad={(next) => (setMenu(null), setSel(null), onLoad(next))} />
          </Modal>
        )}
        {menu === 'abandon' && (
          <Modal title="Abandon the campaign?" onClose={() => setMenu('menu')}>
            <p>The save &ldquo;{g.save.name}&rdquo; is deleted. It can&apos;t be picked up again. Your other saves stay.</p>
            <div className="ew-menu-list is-row">
              <button className="ew-menu-btn is-danger" onClick={onAbandon}>Abandon</button>
              <button className="ew-menu-btn" onClick={() => setMenu('menu')}>Cancel</button>
            </div>
          </Modal>
        )}
        {menu === 'settings' && (
          <Modal title="Settings" onClose={() => setMenu('menu')}>
            <SettingsPanel sound={sound} />
          </Modal>
        )}
      </WheelHost>
    </div>
  )
}

/** Hands the screen's action wheel (from the WheelHost round it) to the screen itself. */
function WheelHook({ to }: { to: { current: (r: WheelRequest | null) => void } }) {
  const open = useWheel()
  useEffect(() => {
    to.current = open
  }, [to, open])
  return null
}

// --- The galaxy minimap ------------------------------------------------------------------------------------

type GMapFilter = 'all' | 'fleets' | 'planets' | 'enemies'

/**
 * The whole galaxy small, like a battle's tactical map: lanes, systems in their holder's colour,
 * fleets as dots, and the box of what the main view shows. Click or drag on it to look there. The
 * buttons beside it jump to the capital, cycle through idle fleets, and open the economy. Under the
 * fog of war it shows the fleets we can see and, for systems we don't, who held them when we last
 * looked (faded); how many planets each side holds is public knowledge.
 */
function GalaxyMinimap({ g, view, onLook, onCapital, onIdle, idle, onEconomy, economy, onWhole }: {
  g: Galaxy
  view: CamView
  onLook: (x: number, y: number) => void
  onCapital: () => void
  onIdle: () => void
  idle: number
  onEconomy: () => void
  economy: boolean
  onWhole: () => void
}) {
  const [filter, setFilter] = useState<GMapFilter>(() => {
    try {
      const v = localStorage.getItem('mvlos.empires.gmapfilter')
      return v === 'fleets' || v === 'planets' || v === 'enemies' ? v : 'all'
    } catch {
      return 'all'
    }
  })
  const pick = (f: GMapFilter) => {
    setFilter(f)
    try {
      localStorage.setItem('mvlos.empires.gmapfilter', f)
    } catch {
      // Not remembered this time.
    }
  }
  const look = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const s = Math.min(r.width / W, r.height / H)
    const ox = (r.width - W * s) / 2
    const oy = (r.height - H * s) / 2
    onLook(clamp((e.clientX - r.left - ox) / s, 0, W), clamp((e.clientY - r.top - oy) / s, 0, H))
  }
  // Only what we can see, and what we last saw where we can't (faded).
  const showFleet = (f: Fleet) => canSee(g, ME, f) && (filter === 'all' || filter === 'fleets' || (filter === 'enemies' && f.owner !== ME))
  const showSystem = (s: StarSystem) => filter !== 'fleets' && (filter !== 'enemies' || s.planets.some((p) => ownerFor(g, ME, g.planets[p]) >= 0 && ownerFor(g, ME, g.planets[p]) !== ME))
  const filters: [GMapFilter, string][] = [
    ['all', 'All'],
    ['fleets', 'Fleets'],
    ['planets', 'Planets'],
    ['enemies', 'Enemies'],
  ]
  return (
    <Floating id="gMap" title="Galaxy map" at={{ left: 6, bottom: 6 }} className="ew-mapframe ew-gmapframe" layout={galaxyLayout}
      aside={<span className="ew-muted ew-small ew-mapsides">{g.planets.filter((p) => p.owner === ME).length} v {g.planets.filter((p) => p.owner >= 0 && p.owner !== ME).length}</span>}>
      <div className="ew-mapbody">
        <div className="ew-maptools">
          <button onClick={onWhole} data-tip="The whole galaxy" aria-label="Whole galaxy"><Icon name="radar" size={17} /></button>
          <button onClick={onCapital} data-tip="Our capital: the planet with our biggest station" aria-label="Capital"><Icon name="target" size={17} /></button>
          <button className="ew-badged" onClick={onIdle} data-tip={`Next idle fleet: ${idle} waiting in orbit`} aria-label="Idle fleets">
            <Icon name="idle" size={17} />
            {idle > 0 && <em>{idle}</em>}
          </button>
          <button className={economy ? 'is-on' : ''} onClick={onEconomy} data-tip="The economy" aria-label="Economy"><Icon name="credits" size={17} /></button>
        </div>
        <div className="ew-gmini-box">
          <svg className="ew-mini ew-gmini" data-nodrag viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" onPointerDown={look} onPointerMove={(e) => e.buttons === 1 && look(e)}>
            {g.systems.map((s) => {
              const o = systemOwner(g, s.id, ME)
              return o >= 0 && showSystem(s) ? <circle key={`t${s.id}`} cx={s.x} cy={s.y} r={40} fill={color(g, o)} opacity={sees(g, ME, s.id) ? 0.18 : 0.08} /> : null
            })}
            {g.lanes.map(([a, b], i) => (
              <line key={i} x1={g.systems[a].x} y1={g.systems[a].y} x2={g.systems[b].x} y2={g.systems[b].y} stroke="rgba(140,180,240,0.3)" strokeWidth={2} />
            ))}
            {g.systems.map((s) =>
              showSystem(s) ? (
                <circle key={s.id} cx={s.x} cy={s.y} r={9} fill={color(g, systemOwner(g, s.id, ME))} stroke={sees(g, ME, s.id) ? '#000' : 'rgba(200,215,240,0.5)'} strokeWidth={2} strokeDasharray={sees(g, ME, s.id) ? undefined : '3 3'} opacity={sees(g, ME, s.id) ? 1 : 0.55} />
              ) : <circle key={s.id} cx={s.x} cy={s.y} r={5} fill="rgba(160,180,210,0.35)" />,
            )}
            {g.fleets.filter(showFleet).map((f) => {
              const p = fleetAt(g, f)
              return <rect key={f.id} x={p.x - 7 + (f.leg ? 0 : f.owner === ME ? -16 : 16)} y={p.y - 7 - (f.leg ? 0 : 14)} width={14} height={14} fill={color(g, f.owner)} stroke="#fff" strokeWidth={f.owner === ME ? 2 : 0} transform={`rotate(45 ${p.x + (f.leg ? 0 : f.owner === ME ? -16 : 16)} ${p.y - (f.leg ? 0 : 14)})`} />
            })}
            {g.systems.map((s) => {
              const b = blockade(g, s.id)
              return b ? <circle key={`b${s.id}`} cx={s.x} cy={s.y} r={17} fill="none" stroke={color(g, b.by)} strokeWidth={3.5} strokeDasharray="6 4" /> : null
            })}
            {g.pending >= 0 && <circle cx={g.systems[g.planets[g.pending].system].x} cy={g.systems[g.planets[g.pending].system].y} r={22} className="ew-gbattle" />}
          </svg>
          {/* The frame round what the map shows, over the minimap in a layer of its own: it follows
              the camera every frame, and alone it's all that is drawn again. */}
          <svg className="ew-gmini-over" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
            <MiniFrame view={view} />
          </svg>
        </div>
      </div>
      <div className="ew-mapfilters" role="tablist" aria-label="Show on the map">
        {filters.map(([f, label]) => (
          <button key={f} role="tab" aria-selected={filter === f} className={`is-${f} ${filter === f ? 'is-on' : ''}`} onClick={() => pick(f)}>
            {f !== 'all' && <i />}
            {label}
          </button>
        ))}
      </div>
    </Floating>
  )
}

// --- The planet dock ---------------------------------------------------------------------------------------

/**
 * A planet, docked next to the galaxy map like a battle's station panel: on the left the planet,
 * what it pays, its station and the fleets in its orbit; on the right its shipyard (warships and
 * strike craft on two pages) with the build queue as holograms standing on the window's edge. A
 * planet that isn't ours shows what holds it instead.
 */
function PlanetDock({ g, p, sound, onClose, onFleet, onLook, onOpen, toast }: { g: Galaxy; p: Planet; sound: EmpiresSound; onClose: () => void; onFleet: (f: Fleet) => void; onLook: () => void; onOpen: (id: StructId) => void; toast: (t: string, tone?: GToast['tone']) => void }) {
  const ours = p.owner === ME
  // What we know of it: as it is where we see the system, else as we last saw it.
  const kn = known(g, ME, p)
  const theirs = kn.owner >= 0 && !ours
  const k = PLANET_KINDS[p.kind]
  const { lockedShips } = useSettings()
  const coarse = useCoarse()
  const fac = g.sides[ME].faction
  const all = buildable(fac).map((t) => UNIT[t.id]).filter((t) => lockedShips || t.level <= p.station)
  // Strike craft first, as at a battle's Command Station; the page picked last is remembered (shared
  // with the battle's build panel, see storedPage).
  const [page, setPage] = useState<YardPage>(() => storedPage<YardPage>(['strike', 'warships', 'yards', 'expansions', 'defense'], 'strike', { buildings: 'yards' }))
  const pickPage = (pg: YardPage) => {
    setPage(pg)
    storePage(pg)
  }
  const small = (t: UnitType) => t.tier === 'fighter' || (t.tier === 'gunship' && t.kind !== 'support')
  const strike = all.filter(small)
  const warships = all.filter((t) => !small(t))
  const ships = page === 'strike' ? strike : warships
  const grid = useRef<HTMLDivElement>(null)
  // The wheel scrolls the cards sideways when they don't all fit.
  useEffect(() => {
    const el = grid.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
      e.preventDefault()
      e.stopPropagation()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  })
  const build = (id: string, times: number) => {
    let n = 0
    let why: string | null = null
    for (let i = 0; i < times; i++) {
      why = buildAt(g, ME, p.id, id)
      if (why) break
      n++
    }
    if (n) sound.queued()
    else if (why) {
      sound.error()
      toast(why, 'bad')
    }
  }
  const unqueue = (id: string) => {
    for (let i = p.queue.length - 1; i >= 0; i--)
      if (p.queue[i].unit === id) {
        cancelBuild(g, ME, p.id, i)
        sound.unqueued()
        return
      }
  }
  const upWhy = cantUpgradeStation(g, ME, p.id)
  const upgrade = () => {
    const why = upgradeStation(g, ME, p.id)
    if (why) {
      sound.error()
      toast(why, 'bad')
    } else sound.constructing()
  }
  const here = seenAt(g, p.id)
  const who = { who: `Yours · ${FACTIONS[fac].long}`, rel: 'own' }
  const queue = planetQueue(g, p)
  // Rush launch: the Capital Yard ship being built, once its planet can rush (a Capital Yard, station level 3).
  const rushAt = rushSlot(p)
  const rush = ours && rushOffered(p) ? {
    share: queueShare(p.queue[rushAt]),
    why: cantRushAt(g, ME, p.id, rushAt),
    onRush: () => {
      const why = rushLaunch(g, ME, p.id, rushAt)
      if (why) {
        sound.error()
        toast(why, 'bad')
      } else sound.constructing()
    },
    tip: `Rush launch: ${UNIT[p.queue[rushAt].unit].name} joins the fleet in orbit now, ${Math.floor(queueShare(p.queue[rushAt]) * 100)}% built. It fights as that share of a ship: that much hull, no shields, its last turrets in scaffolding (they don't fire). It finishes by itself, in ${Math.ceil(p.queue[rushAt].left)} s, while its fleet is parked at one of our planets with a Capital Yard or a Drydock; not while flying. This planet then can't rush for ${Math.round(RUSH_GC.cooldown)} s, and its next Capital Yard ship builds ${Math.round(RUSH_GC.slowdown * 100)}% slower.`,
  } : undefined
  const yardsUp = YARD_KINDS.filter((k) => p.base.yards[k] === 'up').length
  const allMods = modulesFor('station', fac).length + modulesFor('yard', fac).length + modulesFor('cyard', fac).length
  const stationBtn = p.station < 4 && (
    <button className={`ew-gp-up ${upWhy ? 'is-off' : ''}`} onClick={upgrade}
      data-tip={`${p.station ? `Upgrade to level ${p.station + 1}: bigger ships, a tougher station, +${Math.round(STATION_INCOME * 100)}% income` : `Build a station: it defends the planet, builds ships and adds ${Math.round(STATION_INCOME * 100)}% income`}. ${STATION_TIME[p.station + 1]} s.${p.queue.some((q) => q.unit !== 'station') && !upWhy ? ' Starts after the ships in the queue.' : ''}${upWhy ? `\n${upWhy}` : ''}`}>
      <Icon name="yard" size={13} /> {p.station ? 'Upgrade' : 'Build station'} <Icon name="credits" size={12} /> {STATION_COST[p.station + 1]}
    </button>
  )
  return (
    <Floating id="gDock" bare at={{ left: 375, bottom: 6 }} className="ew-detailfloat ew-gdock" layout={galaxyLayout}>
      <div className="ew-stationwrap">
        {ours && (p.station > 0 || p.queue.length > 0) && <BuildQueue queue={queue} max={MAX_YARD} campaign rush={rush} onCancel={(i) => (cancelBuild(g, ME, p.id, i), sound.unqueued())} />}
        <Frame className={`ew-detail is-station ew-gplanet ${theirs ? 'is-enemy' : ''}`}>
          <div className="ew-detail-side">
            <button className="ew-gp-look" onClick={onLook} data-tip="Orbit view: zoom right in on it, with its station, yards and defense stations, and the battle map it is fought on (place them there)">
              <img src={PLANET_ART(p.kind)} alt="" />
            </button>
            <div className="ew-side-info">
              <strong>{p.name}</strong>
              <small className="ew-muted">{k.name} · {g.systems[p.system].name}</small>
              {kn.station > 0 && <Pips level={kn.station} />}
            </div>
            <span className="ew-gp-line" data-tip={kn.station ? `${p.income} a day, +${Math.round(STATION_INCOME * kn.station * 100)}% from its station` : k.blurb}>
              <Icon name="credits" size={13} /> <b>+{kn.live ? planetIncome(g, p) : knownIncome(p, kn.station)}</b> a day
            </span>
            <span className="ew-gp-line" style={{ color: color(g, kn.owner), opacity: kn.live ? 1 : 0.7 }}>
              {kn.owner < 0 ? 'Unclaimed' : ours ? 'Ours' : `Held by the ${factionName(g, kn.owner)}`}
            </span>
            {!kn.live && (
              <span className="ew-gp-line ew-small ew-gp-fog" data-tip={lastSeen(g, p)}>
                <Icon name="radar" size={13} /> {kn.t <= 0 ? 'Pre-war charts' : `Last seen day ${dayOf(kn.t)}`}{kn.ships >= 0 ? ` · ${kn.ships} ships` : ''}
              </span>
            )}
            {ours && p.queue[0]?.full && (
              <span className="ew-gp-line ew-small ew-gp-full" data-tip="Every fleet here is full and there are already four: the finished ship waits in the shipyard (and the queue behind it) until a fleet makes room or leaves.">
                <Icon name="fleet" size={13} /> Fleets full: a ship waits
              </span>
            )}
            {blockade(g, p.system) && (
              <span className="ew-gp-line ew-small ew-gp-block" data-tip={blockadeTip(g, p.system).trim()} style={{ color: color(g, blockade(g, p.system)!.by) }}>
                <Icon name="hold" size={13} /> {blockade(g, p.system)!.by === ME ? 'Our blockade' : 'Enemy blockade'}
              </span>
            )}
            {kn.live && p.capture && (
              <span className="ew-gp-cap" style={{ ['--cap' as string]: color(g, p.capture.owner) }} data-tip={`A fleet takes a planet by holding its orbit for ${CAPTURE_TIME} s with no defender there.`}>
                <span>{p.capture.owner === ME ? 'Our fleet is taking it' : 'The enemy is taking it'}: {Math.ceil(CAPTURE_TIME - p.capture.t)} s</span>
                <i><b style={{ width: `${(p.capture.t / CAPTURE_TIME) * 100}%` }} /></i>
              </span>
            )}
          </div>
          <div className="ew-detail-main">
            <header className="ew-yardhead">
              <h5 className="ew-yardtitle">{ours && p.station ? 'Shipyard' : ours ? 'No station' : 'Planet'}<span className="ew-gp-headname"> · {p.name}</span></h5>
              {ours && stationBtn}
              <button className="ew-close" onClick={onClose} aria-label="Close">✕</button>
            </header>
            {here.length > 0 && (
              <div className="ew-gp-fleets">
                {here.map((f) => (
                  <button key={f.id} onClick={() => onFleet(f)} style={{ borderColor: color(g, f.owner) }}>
                    {f.owner === ME ? 'Our fleet' : `${factionName(g, f.owner)} fleet`}: {f.ships.length} ships
                  </button>
                ))}
              </div>
            )}
            {ours && p.station > 0 ? (
              <BuildPanel
                tabs={[
                  { id: 'strike', group: 'units', label: 'Strike craft', badge: strike.length, tip: 'Strike craft: fighters, bombers and gunships, built at the station.' },
                  { id: 'warships', group: 'units', label: 'Warships', badge: warships.length, tip: 'Warships: frigates and corvettes from the Frigate Yard, cruisers and flagships from the Capital Yard.' },
                  { id: 'yards', group: 'buildings', label: 'Yards', badge: `${yardsUp}/2`, tip: "Yards: the Command Station, the Frigate Yard (frigates and corvettes) and the Capital Yard (cruisers and flagships). Built in this planet's queue." },
                  { id: 'expansions', group: 'buildings', label: 'Expansions', badge: `${p.base.mods.length}/${allMods}`, tip: "Expansions: the modules on the station and on each yard. Built in this planet's queue." },
                  { id: 'defense', group: 'buildings', label: 'Defense', badge: `${orbitalsUp(p.base).length}/${ORBITAL_MAX}`, tip: `Defense stations: up to ${ORBITAL_MAX} in orbit beside the Command Station, each with three levels and its own module slots (1, 2 and 4) we fit as we like. Built in this planet's queue; they fight in every battle here. Zoom right in (or double-click the planet) for the orbit view.` },
                ]}
                page={page} onPick={(id) => pickPage(id as YardPage)} badges={{ buildings: `${yardsUp + p.base.mods.length + orbitalsUp(p.base).length}/${2 + allMods + ORBITAL_MAX}` }}>
                {page === 'defense' ? (
                  <DefenseSites g={g} p={p} sound={sound} onOpen={onOpen} />
                ) : page === 'yards' || page === 'expansions' ? (
                  <PlanetBuildings g={g} p={p} sound={sound} toast={toast} grid={grid} show={page} />
                ) : (
                  <div className="ew-yard" ref={grid}>
                    {ships.map((t) => {
                      const why = yardLock(p, t)
                      return (
                        <ShipCard key={t.id} t={t} who={who} why={cantBuildAt(g, ME, p.id, t.id)} whyReserve={cantBuildAt(g, ME, p.id, t.id)} level={p.station} queued={p.queue.filter((q) => q.unit === t.id).length} onBuild={build} onUnqueue={unqueue} campaign
                          lock={why && t.level <= p.station ? { text: why, badge: why.includes('Yard') ? 'Yard' : 'Expansion' } : null} />
                      )
                    })}
                  </div>
                )}
              </BuildPanel>
            ) : ours ? (
              <p className="ew-gp-note">Build a station here to defend {p.name} and build ships at it. Each station level also adds {Math.round(STATION_INCOME * 100)}% to what the planet pays.</p>
            ) : !kn.live ? (
              <>
                <p className="ew-gp-note">
                  {k.blurb} {lastSeen(g, p)} Send a fleet to find out what holds it now. {coarse ? 'Select a fleet, then long-press the planet to send it.' : 'Select a fleet and right-click the planet to send it.'}
                </p>
                <KnownBase faction={kn.owner >= 0 ? g.sides[kn.owner].faction : fac} station={kn.station} base={kn.base} live={false} />
              </>
            ) : (
              <>
                <p className="ew-gp-note">
                  {k.blurb} {theirs ? (p.station ? `Its level ${p.station} station defends it${YARD_KINDS.some((x) => p.base.yards[x] === 'up') ? ', with its yards' : ''}: bring a fleet strong enough to beat it.` : 'No station defends it: a fleet that holds its orbit takes it.') : 'Unclaimed: a fleet that holds its orbit for a few seconds takes it.'} {coarse ? 'Select a fleet, then long-press the planet to send it.' : 'Select a fleet and right-click the planet to send it.'}
                </p>
                <KnownBase faction={kn.owner >= 0 ? g.sides[kn.owner].faction : fac} station={kn.station} base={kn.base} live />
              </>
            )}
          </div>
        </Frame>
      </div>
    </Floating>
  )
}

/**
 * The orbit view's card: what the structure picked round the planet is, and (ours) its orders, from
 * the same pieces as the planet's shipyard: the station's upgrade and expansions, a yard (or its
 * site, or its ruin) and its expansions, a defense station's levels and module slots; the planet's
 * queue under them, and putting the layout back.
 */
function OrbitCard({ g, p, id, sound, toast, onClose }: { g: Galaxy; p: Planet; id: StructId; sound: EmpiresSound; toast: (t: string, tone?: GToast['tone']) => void; onClose: () => void }) {
  const ours = p.owner === ME
  const coarse = useCoarse()
  const kn = known(g, ME, p)
  const fac = kn.owner >= 0 ? g.sides[kn.owner].faction : g.sides[ME].faction
  const th = orbitThings(fac, kn.station, kn.base, ours).find((x) => x.id === id)
  if (!th) return null
  const who = ours ? { who: `Yours · ${FACTIONS[fac].long}`, rel: 'own' } : { who: FACTIONS[fac].long, rel: 'enemy' }
  const upWhy = cantUpgradeStation(g, ME, p.id)
  const upgrade = () => {
    const why = upgradeStation(g, ME, p.id)
    if (why) {
      sound.error()
      toast(why, 'bad')
    } else sound.constructing()
  }
  const yard = id === 'yard' || id === 'cyard' ? id : null
  const site = id === 'def0' ? 0 : id === 'def1' ? 1 : -1
  const reset = () => {
    resetLayout(g, ME, p.id)
    sound.click()
  }
  return (
    <Floating id="gOrbit" bare at={{ left: 375, bottom: 6 }} className="ew-gorbitcard" layout={galaxyLayout}>
      <div className="ew-stationwrap">
        {ours && p.queue.length > 0 && <BuildQueue queue={planetQueue(g, p)} max={MAX_YARD} campaign onCancel={(i) => (cancelBuild(g, ME, p.id, i), sound.unqueued())} />}
        <Frame className={`ew-gorbit ${ours ? '' : 'is-enemy'}`}>
          <header className="ew-yardhead">
            <h5 className="ew-yardtitle">{th.name}<span className="ew-gp-headname"> · {p.name}</span></h5>
            {ours && id === 'station' && p.station < 4 && (
              <button className={`ew-gp-up ${upWhy ? 'is-off' : ''}`} onClick={upgrade} data-tip={`Upgrade to level ${p.station + 1}: bigger ships, a tougher station, +${Math.round(STATION_INCOME * 100)}% income. ${STATION_TIME[p.station + 1]} s.${upWhy ? `\n${upWhy}` : ''}`}>
                <Icon name="yard" size={13} /> Upgrade <Icon name="credits" size={12} /> {STATION_COST[p.station + 1]}
              </button>
            )}
            <button className="ew-close" onClick={onClose} aria-label="Close">✕</button>
          </header>
          <div className="ew-gorbit-body">
            {!ours ? (
              <div className="ew-gorbit-info" {...unitTip(th.t, who)}>
                <ShipArt t={th.t} className={th.state === 'ruin' ? 'is-ruin' : ''} />
                <p className="ew-gp-note">{kn.live ? 'What stands there now.' : 'As we last saw it: it may have changed since.'} {th.t.blurb}</p>
              </div>
            ) : id === 'station' ? (
              <PlanetBuildings g={g} p={p} sound={sound} toast={toast} show="expansions" only="station" />
            ) : yard ? (
              <>
                <PlanetBuildings g={g} p={p} sound={sound} toast={toast} show="yards" only={yard} />
                {p.base.yards[yard] === 'up' && <PlanetBuildings g={g} p={p} sound={sound} toast={toast} show="expansions" only={yard} />}
              </>
            ) : (
              <PlanetDefense g={g} p={p} sound={sound} toast={toast} only={site} />
            )}
          </div>
          {ours && (
            <footer className="ew-gorbit-foot">
              <small className="ew-muted">{coarse ? 'Drag a structure on the battle map to place it.' : 'Drag a structure on the battle map to place it; battles here stand it there.'}</small>
              <button className="ew-gp-up" disabled={!p.layout} onClick={reset} data-tip="Put every structure back where it stands by default on the planet's battle map">Reset layout</button>
            </footer>
          )}
        </Frame>
      </div>
    </Floating>
  )
}

/**
 * The shipyard's Defense page: the planet's defense sites as two compact tiles (picture at its real
 * level, name, state). A tap picks the structure as a click on it in the orbit view does, which opens
 * its card there (OrbitCard: levels, module slots, build or rebuild), so the card exists once.
 */
function DefenseSites({ g, p, sound, onOpen }: { g: Galaxy; p: Planet; sound: EmpiresSound; onOpen: (id: StructId) => void }) {
  const f = g.sides[ME].faction
  return (
    <div className="ew-yard ew-gbuild ew-gsites">
      {Array.from({ length: ORBITAL_MAX }, (_, i) => {
        const id: StructId = i ? 'def1' : 'def0'
        const o = orbitalAt(p, i)
        // The work ordered on this site: the first in the queue shows its progress.
        const at = p.queue.findIndex((q) => parseOrbital(q.unit)?.i === i)
        const q = at >= 0 ? p.queue[at] : null
        const work = q ? parseOrbital(q.unit) : null
        const bar = q && at === 0 ? <i className="ew-modbar" style={{ transform: `scaleX(${1 - q.left / q.total})` }} /> : null
        const wait = q ? (at === 0 ? `${Math.ceil(q.left)}s left` : `Queued #${at + 1}`) : ''
        let name: string
        let line: string
        let t: UnitType
        let cls = ''
        if (o && !o.ruin) {
          t = orbitalType(f, o.level, o.mods)
          name = orbitalName(f, o.level)
          const fitted = o.mods.filter(Boolean).length
          line = work?.k === 'up' ? `Upgrading · ${wait}` : work?.k === 'mod' ? `Fitting a module · ${wait}` : `Level ${o.level} · ${fitted}/${orbitalSlots(o.level)} modules`
          cls = 'is-built'
        } else if (o?.ruin) {
          const lv = rebuildLevel(g, ME, p, i)
          t = orbitalType(f, lv, [])
          name = orbitalName(f, lv)
          line = work?.k === 'build' ? `Under construction · ${wait}` : `Ruin · rebuild for half`
          cls = 'is-ruin'
        } else {
          t = orbitalType(f, 1, [])
          name = orbitalName(f, 1)
          const w = { k: 'build', i } as const
          line = work?.k === 'build' ? `Under construction · ${wait}` : `Empty · build ${name} ${orbitalCost(g, ME, p, w)} / ${Math.round(orbitalTime(g, ME, p, w))}s`
          cls = 'is-empty'
        }
        const label = `Defense site ${i + 1}`
        return (
          <button key={id} className={`ew-gsite ${cls} ${bar ? 'is-busy' : ''}`} onClick={() => (sound.click(), onOpen(id))} aria-label={`${label}: ${name}. ${line}`}
            data-tip={`${label}: click for its card, with its levels, module slots and orders.`}>
            <ShipArt t={t} className={cls === 'is-ruin' ? 'is-ruin' : cls === 'is-empty' ? 'is-ghost' : ''} />
            <span className="ew-gsite-txt">
              <small>{label}</small>
              <strong>{cls === 'is-empty' && !work ? 'Empty site' : name}</strong>
              <span className="ew-modline">{line}</span>
            </span>
            {bar}
          </button>
        )
      })}
    </div>
  )
}

type YardPage = 'strike' | 'warships' | 'yards' | 'expansions' | 'defense'

/** One of our planets' queue as the build queue shows it: each entry's picture and name (a station
 * level, a yard, an expansion, a defense station's work, or a ship). */
function planetQueue(g: Galaxy, p: Planet) {
  const fac = g.sides[ME].faction
  return p.queue.map((q) => {
    const orb = parseOrbital(q.unit)
    if (orb) {
      const lv = orb.k === 'build' ? (q.lv ?? 1) : orb.k === 'up' ? Math.min(ORBITAL_TOP, (orbitalAt(p, orb.i)?.level ?? 1) + 1) : (orbitalAt(p, orb.i)?.level ?? 1)
      return { ...q, sprite: orbitalSprite(fac, lv), name: queueName(g, ME, p, q) }
    }
    return q.unit === 'station' ? { ...q, sprite: `${fac}-station-${Math.min(4, p.station + 1)}`, name: p.station ? `Station level ${p.station + 1}` : 'A new station' }
      : isYard(q.unit) ? { ...q, sprite: yardOf(fac, q.unit).sprite, name: WORKS_NAME[q.unit] }
        : isWork(q.unit) ? { ...q, sprite: moduleLook(fac, q.unit as ModuleId), name: MODULE[q.unit as ModuleId].name }
          : q
  })
}

/** Where a yard or an expansion stands at one of our planets: built, being built (with how far),
 * waiting in the queue, a ruin to rebuild, ready to order, held back by credits or a full queue
 * ('poor'), or locked (with why). */
type WorkState = { status: 'built' | 'busy' | 'queued' | 'ruin' | 'ready' | 'poor' | 'locked'; why: string | null; slot: number; progress: number; left: number }
function workState(g: Galaxy, p: Planet, id: WorkId): WorkState {
  const slot = p.queue.findIndex((q) => q.unit === id)
  const q = p.queue[slot]
  const base = { slot, progress: q ? 1 - q.left / q.total : 0, left: q?.left ?? 0 }
  if (isYard(id) ? p.base.yards[id] === 'up' : p.base.mods.includes(id)) return { ...base, status: 'built', why: null }
  if (q) return { ...base, status: slot === 0 ? 'busy' : 'queued', why: null }
  const lock = workLock(g, ME, p.id, id)
  if (lock) return { ...base, status: 'locked', why: lock }
  const why = cantWork(g, ME, p.id, id)
  if (isYard(id) && p.base.yards[id] === 'ruin') return { ...base, status: 'ruin', why }
  return { ...base, status: why ? 'poor' : 'ready', why }
}

/**
 * The Buildings pages of one of our planets: Yards (the Command Station, the Frigate Yard and the
 * Capital Yard) and Expansions (each building's modules, a group per building). Click a card to
 * build it (a ruin: rebuild it, for half), click one in the queue to call it off (refunded); a
 * locked one says what it waits for.
 */
function PlanetBuildings({ g, p, sound, toast, grid, show, only }: { g: Galaxy; p: Planet; sound: EmpiresSound; toast: (t: string, tone?: GToast['tone']) => void; grid?: React.RefObject<HTMLDivElement | null>; show: 'yards' | 'expansions'; /** One building only (the orbit card's). */ only?: Works }) {
  const fac = g.sides[ME].faction
  const order = (id: WorkId) => {
    const s = workState(g, p, id)
    if (s.status === 'built') return
    if (s.status === 'busy' || s.status === 'queued') {
      cancelBuild(g, ME, p.id, s.slot)
      sound.unqueued()
      return
    }
    const why = buildWork(g, ME, p.id, id)
    if (why) {
      sound.error()
      toast(why, 'bad')
    } else sound.constructing()
  }
  const line = (s: WorkState) => (s.status === 'built' ? '✓ Built' : s.status === 'busy' ? `${Math.ceil(s.left)}s left` : s.status === 'queued' ? `Queued #${s.slot + 1}` : null)
  const cost = (id: WorkId) => (
    <>
      <span className="ew-cost"><Icon name="credits" size={11} /> {workCost(g, ME, p, id)}</span>
      <span className="ew-time"><Icon name="time" size={11} /> {Math.round(workTime(g, ME, id))}s</span>
    </>
  )
  const what = (s: WorkState) =>
    s.status === 'built' ? 'It stands.' : s.status === 'busy' || s.status === 'queued' ? 'Click to call it off (refunded).' : s.status === 'ruin' ? `A ruin: click to rebuild it for ${Math.round(REBUILD * 100)}% of the price.${s.why ? `
${s.why}` : ''}` : s.status === 'ready' ? 'Click to build it here.' : s.why ?? ''
  const modCards = (on: Works) =>
    modulesFor(on, g.sides[ME].faction).map((m) => {
      const s = workState(g, p, m.id)
      const l = line(s)
      return (
        <button key={m.id} className={`ew-shipcard ew-modcard is-${s.status} ${s.status === 'locked' ? 'is-locked' : s.status === 'poor' ? 'is-off' : ''}`} onClick={() => order(m.id)}
          data-tip={`${m.name}: an expansion of the ${WORKS_NAME[on]}
${m.blurb}
${galaxyEffect(m.id)}
${workCost(g, ME, p, m.id)} credits, ${Math.round(workTime(g, ME, m.id))} s${m.level > 1 ? `, station level ${m.level}` : ''}. Lost if it is shot off in a battle here, or with its building.

${what(s)}`}
          aria-label={`${m.name}: ${s.status}`}>
          <span className="ew-modicon" style={{ ['--c' as string]: HP_COLOR[m.kind] }}><HpIcon kind={m.kind} size={22} /></span>
          <strong>{m.name}</strong>
          {l ? <span className="ew-modline">{l}</span> : cost(m.id)}
          {s.status === 'locked' && <span className="ew-lock">{s.why?.startsWith('Needs station level') ? `Lv${m.level}` : 'Locked'}</span>}
          {s.status === 'busy' && <i className="ew-modbar" style={{ transform: `scaleX(${s.progress})` }} />}
        </button>
      )
    })
  const yardCard = (k: YardKind) => {
    const t = yardOf(fac, k)
    const s = workState(g, p, k)
    const l = line(s) ?? (s.status === 'ruin' ? 'Ruin: rebuild' : null)
    return (
      <button key={k} className={`ew-shipcard ew-yardcard is-${s.status} ${s.status === 'built' ? 'is-built' : ''} ${s.status === 'locked' ? 'is-locked' : s.status === 'poor' ? 'is-off' : ''}`} onClick={() => order(k)}
        {...unitTip(yardType(t.id, p.base.mods), { who: `Yours · ${FACTIONS[fac].long}`, rel: 'own' }, `${WORKS_NAME[k]}: it builds ${k === 'yard' ? 'frigates and corvettes' : 'cruisers, and flagships once its Capital slip stands'} at ${p.name}. Here: ${workCost(g, ME, p, k)} credits, ${Math.round(workTime(g, ME, k))} s on the galaxy clock, station level ${t.level}. A yard destroyed in a battle leaves a ruin, rebuilt for ${Math.round(REBUILD * 100)}% (its expansions are lost with it).

${what(s)}`)}
        aria-label={`${WORKS_NAME[k]}: ${s.status}`}>
        <ShipArt t={s.status === 'built' ? yardType(t.id, p.base.mods) : t} className={s.status === 'ruin' ? 'is-ruin' : ''} />
        <strong>{WORKS_NAME[k]}</strong>
        {l ? <span className="ew-modline">{l}</span> : cost(k)}
        {s.status === 'locked' && <span className="ew-lock">{s.why?.startsWith('Needs station level') ? `Lv${t.level}` : 'Locked'}</span>}
        {s.status === 'busy' && <i className="ew-modbar" style={{ transform: `scaleX(${s.progress})` }} />}
      </button>
    )
  }
  const st = stationType(fac, p.station, [], p.base.mods.filter((id) => MODULE[id].on === 'station'))
  if (show === 'expansions')
    return (
      <div className="ew-yard ew-gbuild is-mods" ref={grid}>
        {(['station', 'yard', 'cyard'] as Works[]).filter((on) => !only || on === only).map((on) => (
          <div key={on} className="ew-gmodgroup" role="group" aria-label={WORKS_NAME[on]}>
            <small className={!worksUp(p, on) ? 'is-off' : ''}>{WORKS_NAME[on]}</small>
            <div>{modCards(on)}</div>
          </div>
        ))}
      </div>
    )
  return (
    <div className="ew-yard ew-gbuild" ref={grid}>
      {(!only || only === 'station') && (
        <div className="ew-shipcard ew-yardcard is-built" {...unitTip(st, { who: `Yours · ${FACTIONS[fac].long}`, rel: 'own' }, `The Command Station at level ${p.station}: it builds strike craft, gunships and repair craft, and the yards round it build the warships. Upgrade it with the button above.`)}>
          <ShipArt t={st} />
          <strong>Command Station</strong>
          <span className="ew-modline">Level {p.station}</span>
        </div>
      )}
      {(!only || only === 'yard') && yardCard('yard')}
      {(!only || only === 'cyard') && yardCard('cyard')}
    </div>
  )
}

/** What an expansion does on the galaxy map, as opposed to in a battle at its planet. */
function galaxyEffect(id: ModuleId) {
  switch (id) {
    case 'secondSlip':
      return 'Here: the first two ships in the queue are built at once.'
    case 'sensorArray':
      return 'Here: we see the systems next door, down every lane from this one.'
    case 'strikeHangar':
      return 'Here: bombers can be built at this planet.'
    case 'capitalSlip':
      return 'Here: flagships can be built at this planet.'
    case 'drydock':
      return 'Fleets carry no damage between battles, so it mends ships only in a battle here.'
    default:
      return 'It works in battles here, and in auto-resolved ones.'
  }
}

/** A planet's buildings as we know them (live, or as last seen): for planets that aren't ours. */
function KnownBase({ faction, station, base, live }: { faction: FactionId; station: number; base: PlanetBase; live: boolean }) {
  const yards = YARD_KINDS.filter((k) => base.yards[k])
  if (!station && !yards.length) return null
  return (
    <div className="ew-gp-base" data-tip={live ? 'What stands there now.' : 'What stood there when we last looked: it may have changed since.'}>
      <small className="ew-muted">{live ? 'Buildings' : 'Buildings, as last seen'}</small>
      {station > 0 && (
        <span className="ew-gp-bchip" {...unitTip(stationType(faction, station, [], base.mods.filter((id) => MODULE[id].on === 'station')), { who: FACTIONS[faction].long, rel: 'enemy' })}>
          <ShipArt t={stationType(faction, station, [], base.mods.filter((id) => MODULE[id].on === 'station'))} /> Station Lv{station}
        </span>
      )}
      {yards.map((k) => (
        <span key={k} className={`ew-gp-bchip ${base.yards[k] === 'ruin' ? 'is-ruin' : ''}`}>
          <ShipArt t={yardOf(faction, k)} /> {WORKS_NAME[k]}{base.yards[k] === 'ruin' ? ' (ruin)' : ''}
        </span>
      ))}
      {base.mods.map((id) => (
        <span key={id} className="ew-gp-bchip" data-tip={`${MODULE[id].name}: ${MODULE[id].blurb}`}>
          <HpIcon kind={MODULE[id].kind} size={14} /> {MODULE[id].name}
        </span>
      ))}
      {(base.orb ?? []).map((o, i) => o && (
        <span key={`o${i}`} className={`ew-gp-bchip ${o.ruin ? 'is-ruin' : ''}`} {...(o.ruin ? {} : unitTip(orbitalType(faction, o.level, o.mods), { who: FACTIONS[faction].long, rel: 'enemy' }))}>
          <ShipArt t={orbitalType(faction, o.level, o.ruin ? [] : o.mods)} /> {orbitalName(faction, o.level)}{o.ruin ? ' (ruin)' : ` · ${o.mods.filter(Boolean).length}/${o.mods.length} modules`}
        </span>
      ))}
    </div>
  )
}

// --- The economy window -----------------------------------------------------------------------------------

type EconTab = 'planets' | 'kinds' | 'systems' | 'ledger'
type EconSort = 'best' | 'worst' | 'earned' | 'name'

/** Credits over the campaign: the balance as a line, each day's pay as bars under it. */
function EconChart({ history }: { history: Side['history'] }) {
  const pts = history.slice(-60)
  if (pts.length < 2) return <div className="ew-gchart is-empty ew-muted ew-small">The chart fills in as the days pass.</div>
  const Wc = 520
  const Hc = 120
  const maxC = Math.max(1, ...pts.map((p) => p.credits))
  const maxI = Math.max(1, ...pts.map((p) => p.income))
  const x = (i: number) => (i / (pts.length - 1)) * Wc
  const bw = Math.max(2, Wc / pts.length - 2)
  return (
    <div className="ew-gchart">
      <svg viewBox={`0 0 ${Wc} ${Hc}`} preserveAspectRatio="none">
        {pts.map((p, i) => (
          <rect key={i} x={x(i) - bw / 2} y={Hc - (p.income / maxI) * Hc * 0.45} width={bw} height={(p.income / maxI) * Hc * 0.45} className="ew-gchart-pay" />
        ))}
        <polyline points={pts.map((p, i) => `${x(i)},${Hc - 4 - (p.credits / maxC) * (Hc - 12)}`).join(' ')} className="ew-gchart-credits" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="ew-gchart-legend">
        <span><i className="is-credits" /> Credits (top {fmt(maxC)})</span>
        <span><i className="is-pay" /> Paid each day (top {fmt(maxI)})</span>
        <span className="ew-muted">Last {pts.length} days</span>
      </div>
    </div>
  )
}

/**
 * Where the money comes from and where it goes: today's income and the week's, a chart of the
 * campaign so far, and every planet we hold by what it pays (best and worst marked, click one to fly
 * there), by kind and by system, plus the latest money in and out.
 */
function GalaxyEconomy({ g, onClose, onPlanet, onSystem }: { g: Galaxy; onClose: () => void; onPlanet: (pid: number) => void; onSystem: (s: number) => void }) {
  const [tab, setTab] = useState<EconTab>('planets')
  const [sort, setSort] = useState<EconSort>('best')
  const s = g.sides[ME]
  const income = incomeOf(g, ME)
  const c = calendar(g.time)
  const ours = g.planets.filter((p) => p.owner === ME)
  const byIncome = ours.slice().sort((a, b) => planetIncome(g, b) - planetIncome(g, a))
  const best = new Set(byIncome.slice(0, Math.min(3, Math.floor(ours.length / 2))).map((p) => p.id))
  const worst = new Set(byIncome.slice(-Math.min(3, Math.floor(ours.length / 2))).map((p) => p.id))
  const rows = ours.slice().sort((a, b) =>
    sort === 'best' ? planetIncome(g, b) - planetIncome(g, a) : sort === 'worst' ? planetIncome(g, a) - planetIncome(g, b) : sort === 'earned' ? b.earned - a.earned : a.name.localeCompare(b.name),
  )
  // (Enemy fleets we can see there, or flying to it inside its system: the rest are in hyperspace.)
  const threatened = (p: Planet) => (p.capture && p.capture.owner !== ME) || g.fleets.some((f) => f.owner !== ME && canSee(g, ME, f) && (f.planet === p.id || (f.leg && f.leg.planet === p.id)))
  // What we can tell of the enemy's income: their planets as we know them, at the stations we saw.
  const enemyIncome = g.planets.reduce((v, p) => {
    const k = known(g, ME, p)
    return v + (k.owner >= 0 && k.owner !== ME ? knownIncome(p, k.station) : 0)
  }, 0)
  const enemyPlanets = g.planets.filter((p) => p.owner >= 0 && p.owner !== ME).length
  const kinds = (Object.keys(PLANET_KINDS) as PlanetKind[])
    .map((k) => ({ k, n: ours.filter((p) => p.kind === k).length, v: ours.filter((p) => p.kind === k).reduce((v, p) => v + planetIncome(g, p), 0) }))
    .filter((x) => x.n)
    .sort((a, b) => b.v - a.v)
  const systems = g.systems
    .map((sys) => ({ s: sys, n: sys.planets.filter((p) => g.planets[p].owner === ME).length, v: sys.planets.reduce((v, p) => v + (g.planets[p].owner === ME ? planetIncome(g, g.planets[p]) : 0), 0) }))
    .filter((x) => x.n)
    .sort((a, b) => b.v - a.v)
  const top = Math.max(1, ...kinds.map((x) => x.v), ...systems.map((x) => x.v))
  return (
    <Floating id="gEconomy" title="Economy" at={{ right: 8, top: 52 }} onClose={onClose} className="ew-gecon" layout={galaxyLayout}>
      <div className="ew-gecon-sum">
        <div>
          <small>Credits</small>
          <b className="ew-gold">{fmt(s.credits)}</b>
        </div>
        <div>
          <small>Income per day</small>
          <b className="is-good">+{fmt(income)}</b>
        </div>
        <div>
          <small>Per week</small>
          <b>+{fmt(income * WEEK)}</b>
        </div>
        <div data-tip="Planets pay at the end of every day">
          <small>Next payday</small>
          <b>{Math.ceil((1 - c.frac) * DAY)} s</b>
        </div>
      </div>
      <EconChart history={s.history} />
      <div className="ew-gecon-tabs" role="tablist">
        {([['planets', `Planets (${ours.length})`], ['kinds', 'By kind'], ['systems', 'By system'], ['ledger', 'Ledger']] as [EconTab, string][]).map(([t, l]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'is-on' : ''} onClick={() => setTab(t)}>{l}</button>
        ))}
      </div>
      {tab === 'planets' && (
        <>
          <div className="ew-gecon-sort">
            <span className="ew-muted ew-small">Sort:</span>
            {([['best', 'Most paying'], ['worst', 'Least paying'], ['earned', 'Paid so far'], ['name', 'Name']] as [EconSort, string][]).map(([k, l]) => (
              <button key={k} className={sort === k ? 'is-on' : ''} onClick={() => setSort(k)}>{l}</button>
            ))}
          </div>
          <div className="ew-gecon-list">
            {rows.map((p) => (
              <button key={p.id} className={`ew-gecon-row ${best.has(p.id) ? 'is-best' : worst.has(p.id) ? 'is-worst' : ''}`} onClick={() => onPlanet(p.id)} data-tip="Click to fly there">
                <img src={PLANET_ART(p.kind)} alt="" />
                <span className="ew-gecon-name">
                  <b>{p.name}</b>
                  <small>{g.systems[p.system].name} · {PLANET_KINDS[p.kind].name}{p.station ? ` · station ${p.station} (+${Math.round(STATION_INCOME * p.station * 100)}%)` : ''}</small>
                </span>
                <span className="ew-gecon-tags">
                  {threatened(p) && <em className="ew-gecon-tag is-bad">Under threat</em>}
                  {best.has(p.id) && <em className="ew-gecon-tag is-best">Top</em>}
                  {worst.has(p.id) && <em className="ew-gecon-tag">Least</em>}
                </span>
                <span className="ew-gecon-num" data-tip="Credits a day">+{planetIncome(g, p)}</span>
                <span className="ew-gecon-num ew-muted" data-tip="Paid to us since we took it">{fmt(p.earned)}</span>
              </button>
            ))}
            {!rows.length && <span className="ew-muted ew-small">We hold no planets.</span>}
          </div>
        </>
      )}
      {tab === 'kinds' && (
        <div className="ew-gecon-bars">
          {kinds.map((x) => (
            <div key={x.k}>
              <img src={PLANET_ART(x.k)} alt="" />
              <span>{PLANET_KINDS[x.k].name} <small className="ew-muted">×{x.n}</small></span>
              <i><b style={{ width: `${(x.v / top) * 100}%` }} /></i>
              <em>+{fmt(x.v)} <small className="ew-muted">{Math.round((x.v / Math.max(1, income)) * 100)}%</small></em>
            </div>
          ))}
        </div>
      )}
      {tab === 'systems' && (
        <div className="ew-gecon-bars">
          {systems.map((x) => (
            <button key={x.s.id} onClick={() => onSystem(x.s.id)} data-tip="Click to fly there">
              <i className="ew-gecon-star" style={{ background: STAR_COLOR[x.s.star] }} />
              <span>{x.s.name} <small className="ew-muted">{x.n}/{x.s.planets.length} planets</small></span>
              <i><b style={{ width: `${(x.v / top) * 100}%` }} /></i>
              <em>+{fmt(x.v)} <small className="ew-muted">{Math.round((x.v / Math.max(1, income)) * 100)}%</small></em>
            </button>
          ))}
        </div>
      )}
      {tab === 'ledger' && (
        <div className="ew-gecon-ledger">
          {s.ledger.slice().reverse().map((e, i) => (
            <div key={i}>
              <small className="ew-muted">Day {e.day + 1}</small>
              <span>{e.what}</span>
              <b className={e.amount >= 0 ? 'is-good' : 'is-bad'}>{e.amount >= 0 ? '+' : ''}{fmt(e.amount)}</b>
            </div>
          ))}
          {!s.ledger.length && <span className="ew-muted ew-small">Nothing yet.</span>}
        </div>
      )}
      <div className="ew-gecon-foot">
        <span>Earned <b>{fmt(s.earned)}</b></span>
        <span>Ships <b>{fmt(s.spent.ships)}</b></span>
        <span data-tip="Stations, yards and expansions">Buildings <b>{fmt(s.spent.stations)}</b></span>
        <span className="ew-muted" data-tip="How many planets the enemy holds is known; what they pay is our guess, from the planets and stations we last saw">Enemy: {enemyPlanets} planets, about +{fmt(enemyIncome)} a day</span>
      </div>
    </Floating>
  )
}

/** What the open sheet is made of on a touch screen: a press there is the sheet's own (see useTapAway). */
const GSHEET_KEEP = `${SELPOP_KEEP}, .ew-gselfloat, .ew-gdock, .ew-inv`

/** What is selected, in a few words, for the compact selection: an icon, a label and a count. */
function selSummary(g: Galaxy, sel: NonNullable<Sel>): { icon: ReactNode; label: string; count?: number; title: string } {
  if (sel.kind === 'planet') {
    const p = g.planets[sel.id]
    return { icon: <img className="ew-selchip-img" src={PLANET_ART(p.kind)} alt="" />, label: p.name, title: `Planet ${p.name}` }
  }
  if (sel.kind === 'planets') return { icon: 'radar', label: 'planets', count: sel.ids.length, title: 'Selected planets' }
  const fs = g.fleets.filter((f) => (sel.kind === 'fleet' ? f.id === sel.id : sel.ids.includes(f.id)))
  const ships = fs.reduce((n, f) => n + f.ships.length, 0)
  const ours = fs.every((f) => f.owner === ME)
  return { icon: 'fleet', label: `${ships} ship${ships === 1 ? '' : 's'}`, count: fs.length > 1 ? fs.length : undefined, title: fs.length > 1 ? `${fs.length} fleets` : ours ? 'Our fleet' : 'Enemy fleet' }
}

/** The compact selection on a touch screen: the selected planet or fleets as one button. */
function GSelChip({ g, sel, onOpen, onClear }: { g: Galaxy; sel: NonNullable<Sel>; onOpen: () => void; onClear: () => void }) {
  const s = selSummary(g, sel)
  return <SelChip icon={s.icon} label={s.label} count={s.count} title={s.title} onOpen={onOpen} onClear={onClear} />
}

/** Over the open sheet: what it shows, and buttons to let go of it or fold it away again. */
function GSheetHead({ g, sel, onDeselect, onClose }: { g: Galaxy; sel: NonNullable<Sel>; onDeselect: () => void; onClose: () => void }) {
  const s = selSummary(g, sel)
  return (
    <div className="ew-selpop ew-gselhead" data-nodrag>
      <span className="ew-gselhead-what">
        {typeof s.icon === 'string' ? <Icon name={s.icon as IconName} size={18} /> : s.icon}
        <b>{s.label}</b>
        {s.count !== undefined && <em>{s.count}</em>}
      </span>
      <button onClick={onDeselect} aria-label="Deselect">✕ Deselect</button>
      <button onClick={onClose} aria-label="Close">Close</button>
    </div>
  )
}

// --- Panels ---------------------------------------------------------------------------------------------

function ShipRow({ g, owner, id, n, children }: { g: Galaxy; owner: number; id: string; n: number; children?: ReactNode }) {
  const t = UNIT[id]
  return (
    <div className="ew-gship" {...unitTip(t, { who: owner === ME ? `Yours · ${FACTIONS[g.sides[owner].faction].long}` : `Enemy · ${FACTIONS[g.sides[owner].faction].long}`, rel: owner === ME ? 'own' : 'enemy' })}>
      <ShipArt t={t} />
      <span>{t.name}</span>
      <b>×{n}</b>
      {children}
    </div>
  )
}

// --- The selection: fleets or planets, and what to do with them -----------------------------------

type GCommand = 'move' | 'take' | 'stop' | 'gather' | 'fallback' | 'look' | 'idle' | 'all' | 'drop' | 'upgrade' | 'yards' | 'economy'
/** The commands with a key, as bound in Settings (the battle's keys, where they mean the same). */
const KEY_COMMAND: Partial<Record<Action, GCommand>> = { move: 'move', attack: 'take', stop: 'stop', hold: 'gather', retreat: 'fallback', focus: 'look', idle: 'idle' }
const FLEET_COMMANDS: { id: GCommand; label: string; icon: IconName; key?: Action; tip: string; touchTip?: string }[] = [
  { id: 'move', label: 'Move', icon: 'move', key: 'move', tip: 'Then click a planet or system to send them there (a right-click sends them straight away). Shift adds it as a stop after what they are doing.', touchTip: 'Then tap a planet or system to send them there (or long-press it). With Shift on, it adds a stop after what they are doing.' },
  { id: 'take', label: 'Take nearest', icon: 'attack', key: 'attack', tip: "Each fleet goes for the nearest planet that isn't ours, to take it. Shift: once it's done with what it's doing." },
  { id: 'stop', label: 'Stop', icon: 'stop', key: 'stop', tip: 'Call off every order and stop: a fleet in flight halts at the next system it reaches.' },
  { id: 'gather', label: 'Gather', icon: 'rally', key: 'hold', tip: 'They all fly to the biggest of them (or where it is going) and join up there.' },
  { id: 'fallback', label: 'Fall back', icon: 'jump', key: 'retreat', tip: 'Each fleet flies to the nearest of our planets with a station.' },
  { id: 'look', label: 'Look', icon: 'target', key: 'focus', tip: 'Show them on the map.' },
  { id: 'idle', label: 'Next idle', icon: 'idle', key: 'idle', tip: 'Select the next fleet of ours waiting in orbit with nothing to do.' },
  { id: 'all', label: 'All fleets', icon: 'army', tip: 'Select every fleet of ours (Ctrl+A).' },
  { id: 'drop', label: 'Drop stop', icon: 'back', tip: 'Take back the last stop queued with Shift (Backspace).' },
]
const PLANET_COMMANDS: typeof FLEET_COMMANDS = [
  { id: 'look', label: 'Look', icon: 'target', key: 'focus', tip: 'Show them on the map.' },
  { id: 'upgrade', label: 'Upgrade stations', icon: 'yard', tip: 'Build or upgrade the station at each of these planets of ours that can, while the credits last.' },
  { id: 'yards', label: 'Shipyards', icon: 'clock', tip: 'Show our shipyards, one after another: the one finishing soonest first.' },
  { id: 'idle', label: 'Next idle', icon: 'idle', key: 'idle', tip: 'Select the next fleet of ours waiting in orbit with nothing to do.' },
  { id: 'all', label: 'All fleets', icon: 'army', tip: 'Select every fleet of ours (Ctrl+A).' },
  { id: 'economy', label: 'Economy', icon: 'credits', tip: 'Our income, planet by planet.' },
]

/** A button that a long press on a touch screen opens an action wheel on (when it has `wheel`);
 * a tap still clicks it. */
function HoldButton({ wheel, wheelTitle, ...rest }: { wheel?: (() => WheelItem[]) | null; wheelTitle?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const press = useLongPressWheel(wheel ?? (() => []), wheelTitle)
  return <button {...rest} {...(wheel ? press : {})} />
}

/** Where a fleet is, as the selection groups them: in orbit of a planet, or on its way to one. */
function fleetWhere(g: Galaxy, f: Fleet) {
  if (!f.leg) {
    const p = g.planets[f.planet]
    const cap = p?.capture
    const status = !p ? '' : cap ? `${cap.owner === f.owner ? 'Taking' : 'Losing'} · ${Math.ceil(CAPTURE_TIME - cap.t)} s` : p.owner === f.owner ? 'In orbit' : 'Holding orbit'
    return { key: `at:${f.planet}`, name: p?.name ?? '', status, moving: false }
  }
  // An enemy fleet we see flying shows where it's flying in the system, not its orders.
  const to = f.owner !== ME ? f.leg.planet : f.route.length ? f.route[f.route.length - 1].planet : f.leg.planet
  return { key: `to:${to}`, name: `→ ${g.planets[to]?.name ?? g.systems[f.leg.system].name}`, status: f.owner !== ME ? 'In flight' : secs(eta(f)), moving: true }
}

/**
 * The selection, bottom right as in a battle. Fleets: grouped by where they are (or where they're
 * going), a tile per kind of ship; for one fleet in orbit, the tiles pick which ships an order sends
 * (click: only these, Shift-click: leave these behind, the wheel: one more or fewer). Planets:
 * grouped by system, a whole system shown as such. Then the commands.
 */
function GalaxySelection({ g, fleets, planets, take, setTake, mode, onCommand, onFleets, onPlanets, enabled }: {
  g: Galaxy
  fleets: Fleet[]
  planets: Planet[]
  take: Record<string, number>
  setTake: (t: Record<string, number>) => void
  mode: 'normal' | 'move'
  onCommand: (c: GCommand) => void
  /** Keep only these (or, with `drop`, let go of them). */
  onFleets: (fs: Fleet[], drop: boolean) => void
  onPlanets: (ps: Planet[], drop: boolean) => void
  enabled: (c: GCommand) => boolean
}) {
  const { keys } = useSettings()
  const coarse = useCoarse()
  const ships = fleets.reduce((n, f) => n + f.ships.length, 0)
  const ours = fleets.length > 0 && fleets.every((f) => f.owner === ME)
  // One fleet of ours in orbit: its ships can be split off by kind.
  const split = fleets.length === 1 && ours && !fleets[0].leg ? fleets[0] : null
  const groups = new Map<string, { name: string; status: string; moving: boolean; fleets: Fleet[] }>()
  for (const f of fleets) {
    const w = fleetWhere(g, f)
    const gr = groups.get(w.key)
    if (gr) gr.fleets.push(f)
    else groups.set(w.key, { ...w, fleets: [f] })
  }
  const systems = new Map<number, Planet[]>()
  for (const p of planets) systems.set(p.system, [...(systems.get(p.system) ?? []), p])
  const stops = Math.max(0, ...fleets.map((f) => f.waypoints?.length ?? 0))
  const picked = split ? grouped(split.ships).reduce((n, [id, c]) => n + Math.min(c, take[id] ?? c), 0) : 0
  const commands = planets.length && !fleets.length ? PLANET_COMMANDS : FLEET_COMMANDS
  // Planets that make up whole systems are named as systems.
  const allWhole = [...systems.entries()].every(([sid, ps]) => ps.length === g.systems[sid].planets.length)
  const title = fleets.length
    ? fleets.length === 1 ? (ours ? 'Our fleet' : `${factionName(g, fleets[0].owner)} fleet`) : `${fleets.length} fleets`
    : !planets.length ? 'Selected' : !allWhole ? `${planets.length} planets` : systems.size === 1 ? g.systems[planets[0].system].name : `${systems.size} systems`
  return (
    <Floating id="gSel" bare at={{ right: 6, bottom: 6 }} className="ew-selfloat ew-gselfloat" layout={galaxyLayout}>
      <Frame className="ew-selframe ew-gselframe" title={title} aside={<b className="ew-selcount">{fleets.length ? ships : planets.length || ''}</b>}>
        <div className="ew-gselgroups">
          {[...groups.values()].map((gr) => {
            const owner = gr.fleets[0].owner
            return (
              <div key={gr.name + owner} className="ew-gselgroup">
                <HoldButton className="ew-gselwhere" onClick={(e) => onFleets(gr.fleets, shiftOf(e))} style={{ ['--own' as string]: color(g, owner) }}
                  data-tip={groups.size > 1 ? 'Click to keep only these fleets, Shift-click to let go of them' : undefined}
                  wheel={groups.size > 1 ? () => [
                    { id: 'only', label: 'Only these', icon: <Icon name="fleet" size={18} />, run: () => onFleets(gr.fleets, false) },
                    { id: 'drop', label: 'Drop these', icon: <Icon name="back" size={18} />, run: () => onFleets(gr.fleets, true) },
                  ] : null} wheelTitle={gr.name}>
                  <i />
                  <b>{gr.name}</b>
                  <small>{gr.fleets.length > 1 ? `${gr.fleets.length} fleets · ` : ''}{gr.status}</small>
                </HoldButton>
                <div className="ew-seltiles">
                  {grouped(gr.fleets.flatMap((f) => f.ships)).map(([id, n]) => {
                    const t = UNIT[id]
                    const k = split ? Math.min(n, take[id] ?? n) : n
                    const set = (v: number) => setTake({ ...take, [id]: clamp(v, 0, n) })
                    const only = () => setTake(Object.fromEntries(grouped(split!.ships).map(([x, c]) => [x, x === id ? c : 0])))
                    // On a touch screen, a long press on a ship of a fleet being split does what Shift
                    // and the mouse wheel do.
                    return (
                      <HoldButton key={id} className={`ew-seltile ${owner === ME ? '' : 'is-enemy'} ${split && k === 0 ? 'is-off' : ''}`}
                        onClick={(e) => (split ? (shiftOf(e) ? set(k ? 0 : n) : picked === k && k === n ? setTake({}) : only()) : onFleets(gr.fleets, shiftOf(e)))}
                        onWheel={(e) => split && set(k + (e.deltaY < 0 ? 1 : -1))}
                        {...unitTip(t, { who: owner === ME ? 'Ours' : factionName(g, owner), rel: owner === ME ? 'own' : 'enemy' }, split ? `${k} of ${n} go with the next order. Click: send only these; Shift-click: leave these behind; the wheel: one more or fewer.` : undefined)}
                        wheel={split ? () => [
                          { id: 'only', label: 'Only these', icon: <Icon name="target" size={18} />, run: only },
                          { id: 'leave', label: 'Leave these', icon: <Icon name="back" size={18} />, disabled: k ? false : 'None of them go', run: () => set(0) },
                          { id: 'more', label: 'One more', icon: <b>+1</b>, disabled: k < n ? false : 'All of them go', run: () => set(k + 1) },
                          { id: 'less', label: 'One fewer', icon: <b>−1</b>, disabled: k ? false : 'None of them go', run: () => set(k - 1) },
                          { id: 'all', label: 'Whole fleet', icon: <Icon name="fleet" size={18} />, disabled: picked < split.ships.length ? false : 'The whole fleet goes', run: () => setTake({}) },
                        ] : null} wheelTitle={`${t.name}: ${k} of ${n} go`}>
                        <ShipArt t={t} />
                        <em>{split && k < n ? `${k}/${n}` : n}</em>
                      </HoldButton>
                    )
                  })}
                </div>
              </div>
            )
          })}
          {[...systems.entries()].map(([sid, ps]) => {
            const whole = ps.length === g.systems[sid].planets.length
            return (
              <div key={sid} className="ew-gselgroup">
                <HoldButton className="ew-gselwhere" onClick={(e) => onPlanets(ps, shiftOf(e))} data-tip={systems.size > 1 ? 'Click to keep only these planets, Shift-click to let go of them' : undefined}
                  wheel={systems.size > 1 ? () => [
                    { id: 'only', label: 'Only these', icon: <Icon name="target" size={18} />, run: () => onPlanets(ps, false) },
                    { id: 'drop', label: 'Drop these', icon: <Icon name="back" size={18} />, run: () => onPlanets(ps, true) },
                  ] : null} wheelTitle={g.systems[sid].name}>
                  <i style={{ background: STAR_COLOR[g.systems[sid].star] }} className="is-star" />
                  <b>{g.systems[sid].name}</b>
                  <small>{whole ? 'Whole system' : `${ps.length} of ${g.systems[sid].planets.length} planets`}</small>
                </HoldButton>
                <div className="ew-seltiles">
                  {ps.map((p) => {
                    const k = known(g, ME, p)
                    return (
                      <button key={p.id} className={`ew-seltile ew-gplanettile ${k.live ? '' : 'is-fog'}`} style={{ ['--own' as string]: color(g, k.owner) }} onClick={(e) => onPlanets([p], shiftOf(e))}
                        data-tip={`${p.name}: ${PLANET_KINDS[p.kind].name}, ${k.live ? planetIncome(g, p) : `about ${knownIncome(p, k.station)}`} credits a day. ${k.live ? `${p.owner < 0 ? 'Unclaimed.' : p.owner === ME ? 'Ours.' : `Held by the ${factionName(g, p.owner)}.`}${p.station ? ` Station level ${p.station}.` : ''}` : lastSeen(g, p)} ${coarse ? 'Tap to open it; with Shift on, tap to let go of it.' : 'Click to open it, Shift-click to let go of it.'}`}>
                        <img src={PLANET_ART(p.kind)} alt="" />
                        {k.station > 0 && <em>{k.station}</em>}
                        {k.live && p.queue.length > 0 && <i className="ew-sbusy" />}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
          {!fleets.length && !planets.length && (
            <span className="ew-muted ew-small">
              {coarse ? 'Nothing selected. Tap a fleet or a planet, or turn on Box and drag round several. Long-press the map for more.' : 'Nothing selected. Drag a box round fleets, or round planets and systems.'}
            </span>
          )}
        </div>
        {ours && (
          <p className="ew-ghint">
            {split && picked < split.ships.length
              ? `The next order sends these ${picked} ships as a new fleet.`
              : coarse ? 'Long-press a planet or system to send them, or tap Move and then it; with Shift on, it adds stops.' : 'Right-click a planet or system to send them; Shift+right-click adds stops.'}
            {stops > 0 && ` ${stops} stop${stops > 1 ? 's' : ''} queued.`}
          </p>
        )}
        {fleets.length === 1 && ours && g.rules.frontline && !fleets[0].leg && contested(g, fleets[0].system, ME) && (
          <p className="ew-ghint">Front line: {g.systems[fleets[0].system].name} is contested. Win it before advancing into other enemy systems; the fleet can still fall back.</p>
        )}
        <div className="ew-cmdgrid">
          {commands.map((c) => (
            <button key={c.id} className={`ew-cmdbtn ${c.id === 'move' && mode === 'move' ? 'is-on' : ''}`} disabled={!enabled(c.id)} onClick={() => onCommand(c.id)}
              data-tip={coarse ? `${c.label}: ${c.touchTip ?? c.tip}` : `${c.label}${c.key ? ` (${keyName(keys[c.key])})` : ''}: ${c.tip}`}>
              <Icon name={c.icon} size={20} />
              <span>{c.label}</span>
              {c.key && <kbd>{keyName(keys[c.key])}</kbd>}
            </button>
          ))}
        </div>
      </Frame>
    </Floating>
  )
}

/**
 * The battle waiting for us, docked at the bottom of the map rather than over it: the galaxy stays
 * paused, but the map can still be looked around (and the battle's planet flown back to) before
 * deciding. It folds down to one line to see more of the map.
 */
function BattlePrompt({ g, c, onShow, onFight, onAuto, onRetreat }: { g: Galaxy; c: Clash; onShow: () => void; onFight: () => void; onAuto: () => void; onRetreat: () => void }) {
  const p = g.planets[c.planet]
  // Short screens (phones on their side, a small window) start folded, so the map stays in view.
  const [folded, setFolded] = useState(() => window.innerHeight < 760)
  const odds = useMemo(() => {
    let wins = 0
    for (let i = 0; i < 9; i++) if (autoResolve(g, c, g.time + i * 13.7).winner === ME) wins++
    return wins / 9
  }, [g, c])
  // Our ships held back are marked: they start the battle in the reserve.
  const side = (o: number, ships: string[], held: string[], station: number) => (
    <div className="ew-gb-side" style={{ borderColor: color(g, o) }}>
      <h5 style={{ color: color(g, o) }}>{o === ME ? 'Our forces' : `${factionName(g, o)} forces`}</h5>
      {station > 0 && <p className="ew-small"><Icon name="yard" size={13} /> Station level {station}</p>}
      {station > 0 && o === c.holder && c.base && orbitalsUp(c.base).length > 0 && (
        <p className="ew-small" data-tip="Defense stations in orbit beside the station: they fight in the battle (and count in an auto-resolve), with their modules.">
          <Icon name="hold" size={13} /> {orbitalsUp(c.base).map(({ o: st }) => `${orbitalName(g.sides[o].faction, st.level)} (${st.mods.filter(Boolean).length} module${st.mods.filter(Boolean).length === 1 ? '' : 's'})`).join(', ')}
        </p>
      )}
      <div className="ew-gships">
        {grouped(ships).map(([id, n]) => {
          const h = o === ME ? held.filter((x) => x === id).length : 0
          return (
            <ShipRow key={id} g={g} owner={o} id={id} n={n}>
              {h > 0 && <small className="ew-gb-held" data-tip={`${n - h} jump in at the start; ${h} held back in the reserve, to be called in during the battle`}><Icon name="hold" size={11} /> {h === n ? 'all held back' : `${n - h} in · ${h} held`}</small>}
            </ShipRow>
          )
        })}
        {!ships.length && <span className="ew-muted ew-small">No ships</span>}
      </div>
      {o === ME && held.length > 0 && <p className="ew-small ew-muted">{held.length} held back: they wait in the reserve, to be called in during the battle.</p>}
    </div>
  )
  const aside = (
    <span className="ew-gb-tools">
      <span className="ew-muted ew-small">{g.systems[p.system].name} system</span>
      <button className="ew-gb-tool" onClick={onShow} data-tip={`Fly the map to ${p.name}`} aria-label={`Show ${p.name} on the map`}>
        <Icon name="target" size={14} /> Show
      </button>
      <button className="ew-gb-tool" onClick={() => setFolded(true)} aria-expanded aria-label="Fold the battle prompt" data-tip="Fold down, to see more of the map">
        ▾
      </button>
    </span>
  )
  // Folded: one slim bar with the choices, the rest of the map in view.
  if (folded)
    return (
      <div className="ew-gbattle-dock" role="dialog" aria-label={`Battle at ${p.name}`}>
        <div className="ew-gb-bar">
          <Icon name="attack" size={16} />
          <strong>Battle at {p.name}</strong>
          <em>{Math.round(odds * 100)}%</em>
          <span className="ew-gb-bar-gap" />
          <button className="ew-gb-tool" onClick={onShow} aria-label={`Show ${p.name} on the map`} data-tip={`Fly the map to ${p.name}`}>
            <Icon name="target" size={14} />
          </button>
          <button className="ew-gb-tool is-primary" onClick={onFight}>Fight</button>
          <button className="ew-gb-tool" onClick={onAuto}>Auto</button>
          {c.attacker === ME && <button className="ew-gb-tool" onClick={onRetreat}>Retreat</button>}
          <button className="ew-gb-tool" onClick={() => setFolded(false)} aria-expanded={false} aria-label="Open the battle prompt" data-tip="Both fleets and the odds">
            ▴
          </button>
        </div>
      </div>
    )
  return (
    <div className="ew-gbattle-dock" role="dialog" aria-label={`Battle at ${p.name}`}>
      <div className="ew-modal is-wide ew-gbattle-modal">
        <Frame title={`Battle at ${p.name}`} aside={aside}>
          <div className="ew-gb-sides">
            {side(c.holder, c.holderShips, c.holderHeld, c.station)}
            <span className="ew-gb-vs">vs</span>
            {side(c.attacker, c.attackerShips, c.attackerHeld, 0)}
          </div>
          <div className="ew-gb-odds" data-tip="How often we'd come out on top if the battle were auto-resolved">
            <span>Our chances</span>
            <i><b style={{ width: `${odds * 100}%` }} /></i>
            <em>{Math.round(odds * 100)}%</em>
          </div>
          <div className="ew-menu-list is-row">
            <button className="ew-menu-btn is-primary" onClick={onFight}><Icon name="attack" size={18} /> Fight it</button>
            <button className="ew-menu-btn" onClick={onAuto} data-tip="Settle it at once from the fleets' strength">Auto-resolve</button>
            {c.attacker === ME && <button className="ew-menu-btn" onClick={onRetreat} data-tip="Turn back before the battle: our fleet flies back where it came from">Retreat</button>}
          </div>
        </Frame>
      </div>
    </div>
  )
}
