import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DIFFICULTY, type Difficulty } from './ai'
import { FACTIONS, UNIT, buildable, isShip, type FactionId, type UnitType } from './data'
import {
  BLOCKADES, CAPTURE_TIME, DAY, GALAXIES, GIANTS, blockedBy, contested, type BlockadeRule, H, MAX_YARD, PLANET_KINDS, SIZES, STAR_COLOR, STATION_COST, STATION_INCOME, STATION_TIME, W, WEEK,
  autoResolve, buildAt, calendar, cancelBuild, cantBuildAt, cantUpgradeStation, clashAt, deleteSave, eta, factionName, fleetsAt, incomeOf, listSaves, loadSave, moveFleet, renameSave, setResume, newGalaxy, planetIncome, saveGalaxy,
  settlePending, systemOwner, tickGalaxy, upgradeStation, withdraw,
  type BattleResult, type Clash, type Fleet, type Galaxy, type GalaxyChoice, type GalaxySize, type Planet, type PlanetKind, type Side, type StarSystem,
} from './galaxy'
import { BuildQueue, Floating, Frame, Icon, Pips, ShipArt, ShipCard, Tips, unitTip } from './Hud'
import { galaxyLayout } from './layout'
import { loadCampaignBattle, saveCampaignBattle, type BattleSnap } from './snapshot'
import { generateMap, DEFAULT_RULES, MAX_SEED, type MapDef } from './maps'
import { LayoutSection, Modal, SettingsPanel } from './Menus'
import { actionFor, getSettings, keyName, useSettings } from './settings'
import type { FleetSide, World } from './sim'
import type { EmpiresSound } from './sound'

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
  names: string[]
  onDone: (w: World, left: boolean) => void
  /** Saved mid-fight: the battle carries on from here. */
  resume?: BattleSnap | null
  /** Keeps it saved as it goes, with the campaign. */
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
/** Who blockades a system (whose fleets it stops), for drawing: the blockading side, or -1. */
function blockade(g: Galaxy, s: number): { by: number; against: number } | null {
  for (let o = 0; o < g.sides.length; o++) {
    const by = blockedBy(g, s, o)
    if (by >= 0) return { by, against: o }
  }
  return null
}
const blockadeTip = (g: Galaxy, s: number) => {
  const b = blockade(g, s)
  if (!b) return ''
  return b.by === ME
    ? ` Our blockade: enemy fleets can't fly through ${g.systems[s].name}, only into it.`
    : ` Enemy blockade: our fleets can't fly through ${g.systems[s].name}, only into it.`
}
const secs = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.ceil(s)}s`)

/** Ship ids counted by type, biggest first: [id, count]. */
function grouped(ships: string[]): [string, number][] {
  const m = new Map<string, number>()
  for (const id of ships) m.set(id, (m.get(id) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => UNIT[b[0]].cost - UNIT[a[0]].cost)
}

/** The campaign: `g` is held by the caller, so it outlasts the battle view. Without one, the
 * Galactic conquest menu: continue the latest save, load one, or start a new campaign. */
export function Conquest({ g, setG, sound, onExit, onBattle, start = 'new' }: {
  g: Galaxy | null
  setG: (g: Galaxy | null) => void
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
  // While a campaign is open, a reload of the page comes straight back to it.
  useEffect(() => {
    if (g) setResume(g.save.id)
  }, [g])
  const leave = () => {
    setResume(null)
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
      sound={sound}
      onExit={() => {
        saveGalaxy(g)
        leave()
      }}
      onAbandon={() => {
        saveCampaignBattle(g.save.id, null)
        deleteSave(g.save.id)
        setG(null)
        leave()
      }}
      onEnd={() => {
        saveCampaignBattle(g.save.id, null)
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
          <img src={`/games/empires/world/emblem-${s.faction}.webp`} alt="" />
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
  const [difficulty, setDifficulty] = useState<Difficulty>('easy')
  const [credits, setCredits] = useState(3000)
  const [name, setName] = useState('')
  const [blockadeRule, setBlockadeRule] = useState<BlockadeRule>('majority')
  const [frontline, setFrontline] = useState(true)
  const choice: GalaxyChoice = kind === 'rim' ? { kind: 'rim' } : { kind: 'generated', seed }
  const preview = useMemo(() => newGalaxy({ choice, size, faction, difficulty, credits }), [kind, seed, size, faction, difficulty, credits]) // eslint-disable-line react-hooks/exhaustive-deps
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
              <Seg value={faction} options={[['republic', FACTIONS.republic.name], ['droid', FACTIONS.droid.name]]} onChange={setFaction} />
            </Field>
            <Field label="Enemy admiral">
              <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)} data-tip={DIFFICULTY[difficulty].blurb}>
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
              <button className="ew-menu-btn is-primary" onClick={click(() => onStart(newGalaxy({ choice, size, faction, difficulty, credits, name, blockade: blockadeRule, frontline })))}>
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

type Sel = { kind: 'fleet'; id: number } | { kind: 'fleets'; ids: number[] } | { kind: 'planet'; id: number } | null
/** The fleets a selection holds. */
const selectedIds = (sel: Sel) => new Set(sel?.kind === 'fleet' ? [sel.id] : sel?.kind === 'fleets' ? sel.ids : [])
type GToast = { id: number; text: string; tone: 'good' | 'bad' | 'info'; t: number }

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
  return { x: s.x + planetR(g.planets[f.planet]) * k + 26, y: s.y - 8 + fleetsAt(g, f.planet).indexOf(f) * 22 }
}

/**
 * The galaxy, at any zoom. Zoomed out, each system is a star with a dot per planet and fleets are
 * badges beside it; zooming in, the systems open up into their planets on their orbits, with
 * stations, captures and the fleets in orbit beside each planet. Markers and text keep their
 * on-screen size; the planets and stars grow. Without `cam` it shows the whole galaxy (the setup's
 * preview).
 */
function GalaxyView({ g, cam, size, sel, mini = false, on }: {
  g: Galaxy
  cam?: Cam
  size?: { w: number; h: number }
  sel?: Sel
  mini?: boolean
  on?: {
    planet: (p: Planet, double: boolean) => void
    planetOrder: (p: Planet) => void
    system: (s: number) => void
    systemOrder: (s: number) => void
    fleet: (f: Fleet) => void
    fleets?: (fs: Fleet[]) => void
  }
}) {
  const k = cam ? cam.k : 1
  const px = (n: number) => n / k
  const vb = cam && size ? `${cam.x - size.w / 2 / k} ${cam.y - size.h / 2 / k} ${size.w / k} ${size.h / k}` : `0 0 ${W} ${H}`
  const d = mini ? 0 : detail(k)
  const selIds = selectedIds(sel ?? null)
  // What's on screen, so a close view doesn't draw the whole galaxy.
  const view = cam && size ? { x0: cam.x - size.w / 2 / k - 40, x1: cam.x + size.w / 2 / k + 40, y0: cam.y - size.h / 2 / k - 40, y1: cam.y + size.h / 2 / k + 40 } : null
  const shown = (x: number, y: number) => !view || (x > view.x0 && x < view.x1 && y > view.y0 && y < view.y1)
  const label = (x: number, y: number, children: ReactNode, cls = '') => (
    <g transform={`translate(${x} ${y}) scale(${1 / k})`} className={cls}>{children}</g>
  )
  // Zoomed out, the fleets parked in a system show as one badge per side.
  const parked = new Map<string, Fleet[]>()
  if (d < 0.5)
    for (const f of g.fleets) {
      if (f.leg) continue
      const key = `${f.system}:${f.owner}`
      parked.set(key, [...(parked.get(key) ?? []), f])
    }
  // Where the selected fleets are headed.
  const routes = g.fleets
    .filter((f) => selIds.has(f.id) && (f.leg || f.route.length))
    .map((f) => [fleetAt(g, f), ...[...(f.leg ? [f.leg] : []), ...f.route].map((h) => (h.planet >= 0 ? planetAt(g, g.planets[h.planet]) : g.systems[h.system]))])
  return (
    <svg className={`ew-gsvg ${mini ? 'is-mini' : ''}`} viewBox={vb} preserveAspectRatio="xMidYMid meet">
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
      {g.systems.map((s) => {
        const o = systemOwner(g, s.id)
        return o >= 0 && shown(s.x, s.y) ? <circle key={`t${s.id}`} cx={s.x} cy={s.y} r={46} fill={color(g, o)} opacity={0.12 * (1 - d * 0.5)} /> : null
      })}
      {g.lanes.map(([a, b], i) => {
        const A = g.systems[a]
        const B = g.systems[b]
        // Opened-up systems: the lane starts at the edge of each one's planets.
        const len = Math.hypot(B.x - A.x, B.y - A.y) || 1
        const ta = (d * reach(g, a)) / len
        const tb = (d * reach(g, b)) / len
        return (
          <line key={i} x1={A.x + (B.x - A.x) * ta} y1={A.y + (B.y - A.y) * ta} x2={B.x - (B.x - A.x) * tb} y2={B.y - (B.y - A.y) * tb} className="ew-glane" vectorEffect="non-scaling-stroke" />
        )
      })}
      {routes.map((route, i) => (
        <polyline key={i} className="ew-groute" points={route.map((p) => `${p.x},${p.y}`).join(' ')} vectorEffect="non-scaling-stroke" />
      ))}
      {g.systems.map((s) => {
        if (!shown(s.x, s.y)) return null
        const battle = g.pending >= 0 && g.planets[g.pending].system === s.id
        const block = mini ? null : blockade(g, s.id)
        const R = reach(g, s.id)
        return (
          <g key={s.id} className="ew-gsys">
            <g
              className="ew-gsys-hit"
              onClick={() => on?.system(s.id)}
              onContextMenu={(e) => (e.preventDefault(), e.stopPropagation(), on?.systemOrder(s.id))}
              data-tip={mini || d > 0.5 ? undefined : `${s.name}: ${s.planets.map((p) => g.planets[p].name).join(', ')}.${blockadeTip(g, s.id)} Click to zoom in; right-click to send the selected fleet.`}
            >
              <circle cx={s.x} cy={s.y} r={d > 0.5 ? px(30) : Math.max(px(22), 4)} fill="transparent" />
              <circle cx={s.x} cy={s.y} r={Math.max(px(13), 7)} fill={`url(#star-${s.star})`} />
              <circle cx={s.x} cy={s.y} r={Math.max(px(3.2), 1.6)} fill="#fff" />
            </g>
            {/* Zoomed out: a dot per planet in its owner's colour. */}
            {d < 1 &&
              s.planets.map((pid, i) => {
                const p = g.planets[pid]
                const a = -Math.PI / 2 + (i - (s.planets.length - 1) / 2) * 0.55
                return <circle key={pid} cx={s.x + Math.cos(a) * px(15)} cy={s.y + Math.sin(a) * px(15)} r={px(2.6)} fill={color(g, p.owner)} stroke="#000" strokeWidth={px(0.6)} opacity={1 - d} />
              })}
            {/* Zoomed in: the planets on their orbits. */}
            {d > 0 && (
              <g opacity={d}>
                {s.planets.map((pid) => {
                  const o = orbitOf(g.planets[pid].orbit)
                  return <ellipse key={pid} cx={s.x} cy={s.y} rx={o.rx} ry={o.ry} className="ew-sorbit" vectorEffect="non-scaling-stroke" />
                })}
                {s.planets.map((pid) => {
                  const p = g.planets[pid]
                  const q = planetAt(g, p)
                  const r = planetR(p)
                  const on2 = sel?.kind === 'planet' && sel.id === pid
                  const capture = p.capture ? p.capture.t / CAPTURE_TIME : 0
                  return (
                    <g key={pid} className={`ew-splanet ${on2 ? 'is-sel' : ''}`}
                      onClick={(e) => (e.stopPropagation(), on?.planet(p, e.detail > 1))}
                      onContextMenu={(e) => (e.preventDefault(), e.stopPropagation(), on?.planetOrder(p))}
                      data-tip={`${p.name}: ${PLANET_KINDS[p.kind].name}, ${planetIncome(g, p)} credits a day. ${p.owner < 0 ? 'Unclaimed.' : `Held by the ${factionName(g, p.owner)}.`} Double-click to zoom in; right-click to send the selected fleet.`}>
                      <circle cx={q.x} cy={q.y} r={r + Math.max(px(6), r * 0.18)} fill="none" stroke={color(g, p.owner)} strokeWidth={p.owner < 0 ? 1 : 2.5} strokeDasharray={p.owner < 0 ? '3 4' : undefined} vectorEffect="non-scaling-stroke" className="ew-sring" />
                      <image href={PLANET_ART(p.kind)} x={q.x - r} y={q.y - r} width={r * 2} height={r * 2} />
                      {p.capture && (
                        <>
                          {/* Being taken: a track round the planet filling in the taker's colour, and a tag. */}
                          <circle cx={q.x} cy={q.y} r={r + Math.max(px(11), r * 0.3)} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={4} vectorEffect="non-scaling-stroke" className="ew-gcap" />
                          <circle cx={q.x} cy={q.y} r={r + Math.max(px(11), r * 0.3)} fill="none" stroke={color(g, p.capture.owner)} strokeWidth={4} vectorEffect="non-scaling-stroke" pathLength={1} strokeDasharray={`${capture} 1`} transform={`rotate(-90 ${q.x} ${q.y})`} className="ew-gcap" />
                          {label(q.x, q.y - r, <CaptureTag g={g} p={p} />)}
                        </>
                      )}
                      {label(q.x - r * 0.75, q.y - r * 0.75, (
                        <>
                          {p.station > 0 && (
                            <g transform="translate(-10 -10)">
                              <rect x={-9} y={-9} width={18} height={18} rx={4} fill="#0b1226" stroke={color(g, p.owner)} />
                              <text y={4} className="ew-slv">{p.station}</text>
                            </g>
                          )}
                          {p.queue.length > 0 && <circle cx={p.station ? 6 : -6} cy={-16} r={4} className="ew-sbusy" />}
                        </>
                      ))}
                      {k > 7 && label(q.x, q.y + r, <text y={20} className="ew-spname" opacity={clamp((k - 7) / 4, 0, 1)}>{p.name}</text>)}
                    </g>
                  )
                })}
              </g>
            )}
            {battle && <circle cx={s.x} cy={s.y} r={Math.max(px(20), d * R)} className="ew-gbattle" vectorEffect="non-scaling-stroke" />}
            {/* Zoomed out: a planet being taken shows as a filling ring round the system and its percentage. */}
            {!mini && d < 0.6 && s.planets.map((pid) => g.planets[pid]).filter((p) => p.capture).slice(0, 1).map((p) => (
              <g key={`c${p.id}`} opacity={1 - d / 0.6}>
                <circle cx={s.x} cy={s.y} r={px(19)} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={3.5} vectorEffect="non-scaling-stroke" className="ew-gcap" />
                <circle cx={s.x} cy={s.y} r={px(19)} fill="none" stroke={color(g, p.capture!.owner)} strokeWidth={3.5} vectorEffect="non-scaling-stroke" pathLength={1} strokeDasharray={`${p.capture!.t / CAPTURE_TIME} 1`} transform={`rotate(-90 ${s.x} ${s.y})`} className="ew-gcap" />
                {label(s.x, s.y, <text x={0} y={-26} className={`ew-gcaptext ${p.capture!.owner === ME ? 'is-ours' : 'is-theirs'}`}>{p.capture!.owner === ME ? 'Taking' : 'Losing'} {p.name} {Math.floor((p.capture!.t / CAPTURE_TIME) * 100)}%</text>)}
              </g>
            ))}
            {/* A blockade: a barrier ring round the system in the blockading side's colour, and a
                shield on it; red-edged when it's against us. */}
            {block && (
              <g className={`ew-gblock ${block.by === ME ? 'is-ours' : 'is-theirs'}`}>
                <circle cx={s.x} cy={s.y} r={Math.max(px(26), d * (R + 2))} fill="none" stroke={color(g, block.by)} vectorEffect="non-scaling-stroke" />
                {label(s.x + Math.max(px(26), d * (R + 2)) * 0.7071, s.y - Math.max(px(26), d * (R + 2)) * 0.7071, (
                  <g data-tip={`${block.by === ME ? 'Our' : 'Enemy'} blockade.${blockadeTip(g, s.id)}`}>
                    <path d="M0,-9 L8,-5 L8,1 C8,6 4,9 0,11 C-4,9 -8,6 -8,1 L-8,-5 Z" fill="#0b1226" stroke={color(g, block.by)} strokeWidth={1.6} />
                    <path d="M-4,-1 L4,-1 M-4,3 L4,3" stroke={block.by === ME ? '#7dffa0' : '#ff6a5e'} strokeWidth={1.6} strokeLinecap="round" />
                  </g>
                ))}
              </g>
            )}
            {!mini && label(s.x, s.y - (d > 0.3 ? R * d : 0), <text y={d > 0.3 ? -10 : 27} className={`ew-gname ${d > 0.3 ? 'is-big' : ''}`}>{s.name}</text>)}
          </g>
        )
      })}
      {!mini &&
        [...parked.entries()].map(([key, fs]) => {
          const [sys, owner] = key.split(':').map(Number)
          const s = g.systems[sys]
          if (!shown(s.x, s.y)) return null
          const n = fs.reduce((v, f) => v + f.ships.length, 0)
          const lead = fs.slice().sort((a, b) => b.ships.length - a.ships.length)[0]
          const on2 = fs.some((f) => selIds.has(f.id))
          return (
            <g key={key} className={`ew-gfleet ${on2 ? 'is-sel' : ''}`} transform={`translate(${s.x} ${s.y}) scale(${1 / k}) translate(${owner === ME ? -24 : 24} -16)`}
              onClick={(e) => (e.stopPropagation(), fs.length > 1 && on?.fleets ? on.fleets(fs) : on?.fleet(lead))}
              data-tip={`${factionName(g, owner)} fleet${fs.length > 1 ? `s (${fs.length})` : ''}: ${n} ships`}>
              <rect x={-11} y={-7} width={22} height={14} rx={3} fill={color(g, owner)} />
              <text y={3.5}>{n}</text>
            </g>
          )
        })}
      {!mini &&
        g.fleets.map((f) => {
          if (!f.leg && d < 0.5) return null
          const p = fleetAt(g, f)
          if (!shown(p.x, p.y)) return null
          // In orbit, beside its planet (several stack downwards).
          let off = { x: 0, y: 0 }
          if (!f.leg && f.planet >= 0) {
            const pl = g.planets[f.planet]
            const i = fleetsAt(g, f.planet).indexOf(f)
            off = { x: planetR(pl) * k + 26, y: -8 + i * 22 }
          }
          return (
            <g key={f.id} className={`ew-gfleet ${f.leg ? 'is-moving' : 'is-orbit'} ${selIds.has(f.id) ? 'is-sel' : ''}`} transform={`translate(${p.x} ${p.y}) scale(${1 / k}) translate(${off.x} ${off.y})`} onClick={(e) => (e.stopPropagation(), on?.fleet(f))}
              data-tip={`${factionName(g, f.owner)} fleet: ${f.ships.length} ships${f.leg ? `, ${secs(eta(f))} to go` : ''}`}>
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
            </g>
          )
        })}
    </svg>
  )
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

function GalaxyMap({ g, sound, onExit, onAbandon, onEnd, onLoad, onBattle }: { g: Galaxy; sound: EmpiresSound; onExit: () => void; onAbandon: () => void; onEnd: () => void; onLoad: (g: Galaxy) => void; onBattle: (b: ConquestBattle) => void }) {
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
  const [fleetsOpen, setFleetsOpen] = useState(true)
  const viewEl = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 520 })
  const [cam, setCam] = useState<Cam>({ x: W / 2, y: H / 2, k: 0.8 })
  const camRef = useRef(cam)
  camRef.current = cam
  /** Moves the camera now: the ref at once, so moves in the same frame build on each other. */
  const moveCam = (c: Cam) => {
    camRef.current = c
    setCam(c)
  }
  const camGoal = useRef<Cam | null>(null)
  /** A wheel zoom under way: the zoom it's heading for, and the world point (wx, wy) that was under
   * the cursor, now at (sx, sy) from the view's centre and gliding to (tx, ty) (zooming in pulls it
   * towards the centre). (cx, cy) is where the cursor was, so more notches there build on it. */
  const zoomTo = useRef<{ k: number; wx: number; wy: number; sx: number; sy: number; tx: number; ty: number; cx: number; cy: number } | null>(null)
  /** How fast the keys and screen edges are panning, in screen pixels a second (it eases in and out). */
  const panVel = useRef({ x: 0, y: 0 })
  const dragged = useRef(false)
  /** Camera keys held down, and where the mouse is over the map (for edge scrolling). */
  const held = useRef(new Set<string>())
  const mouse = useRef({ x: 0, y: 0, inside: false })
  const rootEl = useRef<HTMLDivElement>(null)
  const state = useRef({ paused, speed, menu })
  state.current = { paused, speed, menu }
  useSettings()
  const mine = g.sides[ME]
  const myFaction = mine.faction
  // Dev builds expose the campaign for poking at from the console.
  if (import.meta.env.DEV) (window as unknown as { __galaxy: Galaxy }).__galaxy = g

  const kMin = fitK(size.w, size.h)
  const kMinRef = useRef(kMin)
  kMinRef.current = kMin
  const fix = (c: Cam): Cam => ({ x: clamp(c.x, 0, W), y: clamp(c.y, 0, H), k: clamp(c.k, kMinRef.current, K_MAX) })
  const flyTo = (x: number, y: number, k: number) => {
    zoomTo.current = null
    camGoal.current = fix({ x, y, k })
  }
  const flyOut = () => flyTo(W / 2, H / 2, kMin)

  // The view's size; the first time, the whole galaxy fits.
  const fitted = useRef(false)
  useLayoutEffect(() => {
    const el = viewEl.current
    if (!el) return
    const measure = () => {
      const s = { w: el.clientWidth || 800, h: el.clientHeight || 520 }
      setSize(s)
      if (!fitted.current) {
        fitted.current = true
        setCam({ x: W / 2, y: H / 2, k: fitK(s.w, s.h) })
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const toast = (text: string, tone: GToast['tone'] = 'info') => {
    const t = { id: Math.random(), text, tone, t: performance.now() }
    setToasts((ts) => [...ts.slice(-4), t])
  }
  useEffect(() => {
    const id = window.setInterval(() => setToasts((ts) => ts.filter((t) => performance.now() - t.t < 7000)), 1000)
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

  // The clock: the galaxy runs while nothing holds it; the camera glides to where it was sent.
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let saveT = 0
    let drawT = 0
    const loop = (now: number) => {
      // Up to a second at a time: a background tab gets few frames, and the galaxy keeps time anyway.
      const dt = Math.min(1, (now - last) / 1000)
      last = now
      const st = state.current
      if (!st.paused && !st.menu && g.pending < 0 && g.winner === -1) {
        tickGalaxy(g, dt * st.speed)
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
      if (v.x || v.y) {
        camGoal.current = null
        const c = camRef.current
        const mx = (v.x * dt) / c.k
        const my = (v.y * dt) / c.k
        moveCam(fix({ ...c, x: c.x + mx, y: c.y + my }))
        // A wheel zoom under way carries on from the panned spot.
        if (zoomTo.current) {
          zoomTo.current.wx += mx
          zoomTo.current.wy += my
        }
      }
      // A wheel zoom glides to its zoom, the point that was under the cursor gliding with it to
      // its spot on screen.
      const z = zoomTo.current
      if (z) {
        const c = camRef.current
        const t = 1 - Math.exp(-dt * 14)
        let k = Math.exp(Math.log(c.k) + (Math.log(z.k) - Math.log(c.k)) * t)
        z.sx += (z.tx - z.sx) * t
        z.sy += (z.ty - z.sy) * t
        if (Math.abs(k / z.k - 1) < 0.002 && Math.hypot(z.tx - z.sx, z.ty - z.sy) < 0.5) {
          k = z.k
          z.sx = z.tx
          z.sy = z.ty
          zoomTo.current = null
        }
        moveCam(fix({ x: z.wx - z.sx / k, y: z.wy - z.sy / k, k }))
      }
      const goal = camGoal.current
      if (goal) {
        const c = camRef.current
        const t = 1 - Math.exp(-dt * 6)
        const next = { x: c.x + (goal.x - c.x) * t, y: c.y + (goal.y - c.y) * t, k: Math.exp(Math.log(c.k) + (Math.log(goal.k) - Math.log(c.k)) * t) }
        if (Math.abs(next.k / goal.k - 1) < 0.01 && Math.hypot(goal.x - next.x, goal.y - next.y) * next.k < 1) {
          camGoal.current = null
          moveCam(goal)
        } else moveCam(next)
      }
      for (const e of g.events) {
        if (e.k === 'captured') {
          const p = g.planets[e.planet]
          if (e.owner === ME) {
            toast(`${p.name} is ours`, 'good')
            sound.capture(true)
          } else if (e.from === ME) {
            toast(`We lost ${p.name}`, 'bad')
            sound.capture(false)
          }
        } else if (e.k === 'built' && e.owner === ME) {
          toast(`${UNIT[e.unit].name} ready at ${g.planets[e.planet].name}`, 'info')
          sound.shipReady(myFaction, UNIT[e.unit].tier)
        } else if (e.k === 'station' && e.owner === ME) {
          toast(`${g.planets[e.planet].name}: station level ${e.level}`, 'good')
          sound.levelUp()
        } else if (e.k === 'arrived' && e.owner === ME) {
          toast(`Fleet arrived at ${g.planets[e.planet].name}`, 'info')
        } else if (e.k === 'battle') {
          const p = g.planets[e.planet]
          if (!e.auto) sound.alarm(true)
          else if (e.owners.includes(ME) && e.winner !== undefined) toast(`Battle at ${p.name}: ${e.winner === ME ? 'won' : 'lost'}`, e.winner === ME ? 'good' : 'bad')
        } else if (e.k === 'out') toast(`The ${factionName(g, e.owner)} is beaten`, e.owner === ME ? 'bad' : 'good')
        else if (e.k === 'capturing') {
          const p = g.planets[e.planet]
          if (e.owner === ME) toast(`Our fleet is taking ${p.name}: ${CAPTURE_TIME} s in orbit`, 'info')
          else if (e.from === ME) {
            toast(`The enemy is taking ${p.name}: ${CAPTURE_TIME} s to stop them`, 'bad')
            sound.alarm(false)
          }
        } else if (e.k === 'blockaded') {
          const where = g.systems[e.system].name
          if (e.owner === ME) {
            toast(e.by >= 0 ? `Our fleet was pulled out of hyperspace by the blockade at ${where}` : `Our fleet stopped at ${where}: blockades closed every way on`, 'bad')
            sound.alarm(false)
          } else if (e.by === ME) toast(`Our blockade at ${where} stopped an enemy fleet`, 'good')
        } else if (e.k === 'payday' && e.owner === ME && e.amount > 0) {
          setPay({ id: Math.random(), amount: e.amount })
          sound.salvaged()
        }
      }
      if (g.events.length) {
        g.events.length = 0
        saveGalaxy(g)
      }
      drawT -= dt
      if (drawT <= 0) {
        drawT = 0.1
        setFrame((n) => n + 1)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g])

  const selFleet = sel?.kind === 'fleet' ? g.fleets.find((f) => f.id === sel.id) : undefined
  const selFleets = sel?.kind === 'fleets' ? g.fleets.filter((f) => sel.ids.includes(f.id)) : []
  const selPlanet = sel?.kind === 'planet' ? g.planets[sel.id] : undefined
  useEffect(() => {
    // Selected fleets that are gone (merged, destroyed) let go.
    if (sel?.kind === 'fleet' && !selFleet) setSel(null)
    if (sel?.kind === 'fleets' && selFleets.length !== sel.ids.length) setSel(selFleets.length > 1 ? { kind: 'fleets', ids: selFleets.map((f) => f.id) } : selFleets.length ? { kind: 'fleet', id: selFleets[0].id } : null)
  })
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
      } else if (action === 'zoomIn' || k === '+') flyTo(c.x, c.y, c.k * 1.8)
      else if (action === 'zoomOut') flyTo(c.x, c.y, c.k / 1.8)
      else if (k === 'escape') {
        if (state.current.menu) setMenu(null)
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
  const send = (planet: number) => {
    if (dragged.current) return
    // Several fleets: each flies there whole, and they join up when they arrive.
    if (selFleets.length) {
      let sent = 0
      let why: string | null = null
      for (const f of selFleets) {
        if (f.owner !== ME) continue
        const w = moveFleet(g, ME, f.id, planet)
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
    const why = moveFleet(g, ME, selFleet.id, planet, ships.length < selFleet.ships.length ? ships : undefined)
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
  const sendToSystem = (s: number) => {
    const ps = g.systems[s].planets.map((p) => g.planets[p])
    const target = ps.find((p) => p.owner >= 0 && p.owner !== ME) ?? ps.find((p) => p.owner < 0) ?? ps[0]
    send(target.id)
  }
  const pickFleet = (f: Fleet) => {
    if (dragged.current) return
    setSel({ kind: 'fleet', id: f.id })
    setTake({})
    if (f.owner === ME) sound.select(myFaction, 'frigate')
    else sound.click()
  }
  /** Look at a planet: the camera flies in and it's selected. */
  const showPlanet = (pid: number, k = 45) => {
    const q = planetAt(g, g.planets[pid])
    flyTo(q.x, q.y, Math.max(camRef.current.k, k))
    setSel({ kind: 'planet', id: pid })
  }

  // The battle waiting for us.
  const clash = g.pending >= 0 ? clashAt(g, g.pending) : null
  // A battle that was being fought when the page went away: straight back into it.
  useEffect(() => {
    const saved = loadCampaignBattle(g.save.id)
    if (!saved) return
    const c = g.pending === saved.planet ? clashAt(g, g.pending) : null
    if (c) fight(c, saved.snap)
    else saveCampaignBattle(g.save.id, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (g.pending >= 0 && !clash) g.pending = -1
  })

  const fight = (c: Clash, resume?: BattleSnap) => {
    const p = g.planets[c.planet]
    const base = generateMap({
      ...DEFAULT_RULES,
      seed: (c.planet * 7919 + Math.floor(g.time)) % 999999 || 1,
      players: 2,
      size: 'small',
      beacons: 0,
      asteroidFields: p.kind === 'barren' || p.kind === 'lava' || p.kind === 'crystal' ? 'many' : p.kind === 'city' ? 'none' : 'few',
      nebulas: GIANTS.includes(p.kind) ? 'many' : p.kind === 'ice' || p.kind === 'ocean' || p.kind === 'swamp' || p.kind === 'toxic' ? 'few' : 'none',
      wrecks: 'none',
    })
    const sp = base.spawns[0]
    const map: MapDef = { ...base, id: 'conquest', name: p.name, ore: [], beacons: [], wrecks: [], planet: { kind: p.kind, x: base.w / 2 + (sp.x - base.w / 2) * 0.5, y: base.h / 2 + 1500, r: 560 } }
    const sides: FleetSide[] = [
      { faction: g.sides[c.holder].faction, team: 0, ships: c.holderShips, station: c.station },
      { faction: g.sides[c.attacker].faction, team: 1, ships: c.attackerShips },
    ]
    const meSide = c.holder === ME ? 0 : 1
    const enemy = meSide === 0 ? c.attacker : c.holder
    onBattle({
      map,
      sides,
      me: meSide,
      ai: g.sides[enemy].ai ?? 'medium',
      names: [factionName(g, c.holder), factionName(g, c.attacker)],
      resume,
      // Saved with the campaign as it's fought, so a reload carries on with it.
      onSnap: (snap) => saveCampaignBattle(g.save.id, snap ? { planet: c.planet, snap } : null),
      onDone: (w, left) => {
        saveCampaignBattle(g.save.id, null)
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
      const k = clamp((zoomTo.current?.k ?? c.k) * Math.exp(step), kMinRef.current, K_MAX)
      // Zooming in draws the spot under the cursor towards the centre, under a tenth of the way a
      // notch; zooming out keeps it under the cursor.
      const pull = k > c.k && step > 0 ? Math.exp(-step * ZOOM_PULL) : 1
      camGoal.current = null
      const z = zoomTo.current
      // More notches with the cursor where it was carry on with the same spot.
      if (z && Math.hypot(z.cx - sx, z.cy - sy) < 6) Object.assign(z, { k, tx: z.tx * pull, ty: z.ty * pull })
      else zoomTo.current = { k, wx: c.x + sx / c.k, wy: c.y + sy / c.k, sx, sy, tx: sx * pull, ty: sy * pull, cx: sx, cy: sy }
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])
  // The left button drags out a box that selects our fleets in it (Shift adds to the selection), and
  // a click on open space lets go of the selection; the middle button drags the map along.
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    const pan = e.button === 1
    if (pan) e.preventDefault()
    const r = viewEl.current!.getBoundingClientRect()
    const x0 = e.clientX
    const y0 = e.clientY
    // Dragging the map holds the point grabbed under the cursor, even while a zoom glides on.
    const grab = toWorld(x0, y0)
    if (pan) camGoal.current = null
    const add = e.shiftKey
    const onSpace = !(e.target as Element).closest('.ew-gsys, .ew-gfleet, .ew-splanet, button')
    dragged.current = false
    const move = (m: PointerEvent) => {
      if (!dragged.current && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return
      dragged.current = true
      if (pan) {
        camGoal.current = null
        const sx = m.clientX - r.left - size.w / 2
        const sy = m.clientY - r.top - size.h / 2
        const z = zoomTo.current
        if (z) Object.assign(z, { wx: grab.x, wy: grab.y, sx, sy, tx: sx, ty: sy, cx: NaN, cy: NaN })
        else {
          const c = camRef.current
          moveCam(fix({ x: grab.x - sx / c.k, y: grab.y - sy / c.k, k: c.k }))
        }
      } else setBox({ x0: x0 - r.left, y0: y0 - r.top, x1: m.clientX - r.left, y1: m.clientY - r.top })
    }
    const up = (u: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!pan && dragged.current) {
        const bx = { l: Math.min(x0, u.clientX) - r.left - 10, r: Math.max(x0, u.clientX) - r.left + 10, t: Math.min(y0, u.clientY) - r.top - 10, b: Math.max(y0, u.clientY) - r.top + 10 }
        const c = camRef.current
        pickFleets(g.fleets.filter((f) => {
          if (f.owner !== ME) return false
          const p = fleetScreen(g, f, c, size)
          return p.x >= bx.l && p.x <= bx.r && p.y >= bx.t && p.y <= bx.b
        }), add)
        setBox(null)
      } else if (!pan && onSpace && !add) setSel(null)
      // The click that ends a drag isn't a click.
      setTimeout(() => (dragged.current = false), 0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** A right-click on open space: the nearest planet (zoomed in) or system (zoomed out) near the
   * cursor gets the order, so it needn't land exactly on it. */
  const onViewOrder = (e: React.MouseEvent) => {
    noMenu(e)
    const at = toWorld(e.clientX, e.clientY)
    const k = camRef.current.k
    if (detail(k) > 0.5) {
      const p = g.planets.reduce((b, x) => (Math.hypot(planetAt(g, x).x - at.x, planetAt(g, x).y - at.y) < Math.hypot(planetAt(g, b).x - at.x, planetAt(g, b).y - at.y) ? x : b))
      const q = planetAt(g, p)
      if (Math.hypot(q.x - at.x, q.y - at.y) * k < Math.max(90, planetR(p) * k * 2.5)) return send(p.id)
    } else {
      const s = g.systems.reduce((b, x) => (Math.hypot(x.x - at.x, x.y - at.y) < Math.hypot(b.x - at.x, b.y - at.y) ? x : b))
      if (Math.hypot(s.x - at.x, s.y - at.y) * k < 60) return sendToSystem(s.id)
    }
    if (selFleet?.owner === ME || selFleets.length) {
      sound.error()
      toast('Right-click a planet or a system to send the fleet there', 'bad')
    }
  }

  const myIncome = incomeOf(g, ME)
  const myFleets = g.fleets.filter((f) => f.owner === ME)
  const idleFleets = myFleets.filter((f) => !f.leg && !f.route.length && f.planet >= 0)
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
  // Where we're looking, for the bar: the nearest system once zoomed in, and planet once close.
  const d = detail(cam.k)
  const near = d > 0.5 ? g.systems.reduce((b, s) => (Math.hypot(s.x - cam.x, s.y - cam.y) < Math.hypot(b.x - cam.x, b.y - cam.y) ? s : b)) : null
  const nearPlanet = near && cam.k > 30 ? near.planets.map((p) => g.planets[p]).reduce((b, p) => (Math.hypot(planetAt(g, p).x - cam.x, planetAt(g, p).y - cam.y) < Math.hypot(planetAt(g, b).x - cam.x, planetAt(g, b).y - cam.y) ? p : b)) : null

  return (
    <div ref={rootEl} className={`ew-root ew-deck ew-galaxy ew-${myFaction}`} style={{ ['--ew-accent' as string]: FACTIONS[myFaction].color }} onContextMenu={noMenu}>
      <Tips />
      {/* The same top bar as a battle's, in the same order: faction, credits, fleet, planets; then
          on the right the shipyards, the time and the menu. */}
      <div className="ew-top ew-gtop">
        <button className={`ew-top-cell ew-top-faction ${fleetsOpen ? 'is-on' : ''}`} onClick={() => (sound.click(), setFleetsOpen(!fleetsOpen))}
          data-tip={`Our fleets: ${myFleets.length}. Click to show or hide the list.`} aria-label="Our fleets">
          <span className="ew-emblem">
            <img src={`/games/empires/world/emblem-${myFaction}.webp`} alt="" />
            {myFleets.length > 0 && <em>{myFleets.length}</em>}
          </span>
          <div>
            <strong>{FACTIONS[myFaction].name} <em className="ew-beta" data-tip="Galactic conquest is still being built: expect rough edges, and changes to come">Beta</em></strong>
            <small>{g.name}{near ? ` › ${near.name}` : ''}{nearPlanet && nearPlanet.name !== near?.name ? ` › ${nearPlanet.name}` : ''}</small>
          </div>
        </button>
        <button className={`ew-top-cell ew-creditcell ${economy ? 'is-on' : ''}`} onClick={() => (sound.click(), setEconomy(!economy))}
          data-tip={`Credits and income per day: our ${g.planets.filter((p) => p.owner === ME).length} planets pay ${fmt(myIncome)} at the end of every day.\nClick for the economy: where it comes from, the best and worst planets, and recent purchases.`}>
          <span className="ew-gold"><Icon name="credits" size={20} /></span>
          <b className="ew-big">{fmt(mine.credits)}</b>
          <small className="ew-good">+{fmt(myIncome)} / day</small>
          {pay && <em key={pay.id} className="ew-gpaid">+{fmt(pay.amount)}</em>}
        </button>
        <div className="ew-top-cell" data-tip={`Ships in our ${myFleets.length} fleets`}>
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
            data-tip={nextJob ? `Shipyards: ${nextJob.q.unit === 'station' ? 'station work' : UNIT[nextJob.q.unit].name} at ${nextJob.p.name}, ${Math.ceil(nextJob.q.left)} s left${queued > 1 ? `, ${queued - 1} more queued` : ''}.\nClick to look at the next yard.` : 'Shipyards idle.\nClick to look at a planet with a station.'}>
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
        className="ew-gview"
        ref={viewEl}
        onPointerDown={onPointerDown}
        onContextMenu={onViewOrder}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          mouse.current = { x: e.clientX - r.left, y: e.clientY - r.top, inside: true }
        }}
        onPointerLeave={() => (mouse.current.inside = false)}
      >
        <GalaxyView
          g={g}
          cam={cam}
          size={size}
          sel={sel}
          on={{
            system: (s) => {
              if (dragged.current) return
              sound.click()
              const sys = g.systems[s]
              flyTo(sys.x, sys.y, Math.max(camRef.current.k, 11))
            },
            systemOrder: sendToSystem,
            planet: (p, double) => {
              if (dragged.current) return
              sound.click()
              if (double) showPlanet(p.id, 70)
              else setSel({ kind: 'planet', id: p.id })
            },
            planetOrder: (p) => send(p.id),
            fleet: pickFleet,
            fleets: (fs) => !dragged.current && pickFleets(fs),
          }}
        />
        {box && <div className="ew-gbox" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />}
        <div className="ew-gzoom">
          <button onClick={() => flyTo(cam.x, cam.y, cam.k * 2)} data-tip={`Zoom in (${keyName(getSettings().keys.zoomIn)} or the wheel)`}>+</button>
          <button onClick={() => flyTo(cam.x, cam.y, cam.k / 2)} data-tip={`Zoom out (${keyName(getSettings().keys.zoomOut)} or the wheel)`}>−</button>
          <button onClick={flyOut} data-tip="The whole galaxy (Esc)"><Icon name="radar" size={14} /></button>
        </div>
      </div>

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
        cam={cam}
        size={size}
        onLook={(x, y) => {
          camGoal.current = null
          setCam(fix({ ...camRef.current, x, y }))
        }}
        onWhole={flyOut}
        onCapital={() => {
          const cap = g.planets.filter((p) => p.owner === ME).sort((a, b) => b.station - a.station || planetIncome(g, b) - planetIncome(g, a))[0]
          if (cap) showPlanet(cap.id, 30)
          else sound.error()
        }}
        idle={idleFleets.length}
        onIdle={() => {
          if (!idleFleets.length) return sound.error()
          const i = selFleet ? (idleFleets.indexOf(selFleet) + 1) % idleFleets.length : 0
          const f = idleFleets[i]
          pickFleet(f)
          const p = fleetAt(g, f)
          flyTo(p.x, p.y, Math.max(camRef.current.k, 12))
        }}
        economy={economy}
        onEconomy={() => (sound.click(), setEconomy(!economy))}
      />

      {selFleet && <FleetPanel g={g} f={selFleet} take={take} setTake={setTake} onClose={() => setSel(null)} />}
      {selFleets.length > 1 && <FleetsPanel g={g} fleets={selFleets} onOnly={pickFleet} onClose={() => setSel(null)} />}
      {selPlanet && (
        <PlanetDock
          g={g}
          p={selPlanet}
          sound={sound}
          onClose={() => setSel(null)}
          onFleet={pickFleet}
          onLook={() => showPlanet(selPlanet.id, 70)}
          toast={toast}
        />
      )}
      {economy && <GalaxyEconomy g={g} onClose={() => setEconomy(false)} onPlanet={(pid) => showPlanet(pid)} onSystem={(s) => flyTo(g.systems[s].x, g.systems[s].y, Math.max(camRef.current.k, 11))} />}

      <div className="ew-toasts">
        {toasts.map((t) => {
          const dismiss = () => setToasts((ts) => ts.filter((x) => x.id !== t.id))
          return (
            <section key={t.id} className={`ew-frame ew-toast is-${t.tone}`} onContextMenu={(e) => (e.preventDefault(), dismiss())}>
              <div className="ew-frame-in">
                <span>{t.text}</span>
                <button className="ew-toast-x" onClick={dismiss} aria-label="Dismiss">×</button>
              </div>
            </section>
          )
        })}
      </div>

      {clash && g.winner === -1 && (
        <BattlePrompt
          g={g}
          c={clash}
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
    </div>
  )
}

// --- The galaxy minimap ------------------------------------------------------------------------------------

type GMapFilter = 'all' | 'fleets' | 'planets' | 'enemies'

/**
 * The whole galaxy small, like a battle's tactical map: lanes, systems in their holder's colour,
 * fleets as dots, and the box of what the main view shows. Click or drag on it to look there. The
 * buttons beside it jump to the capital, cycle through idle fleets, and open the economy.
 */
function GalaxyMinimap({ g, cam, size, onLook, onCapital, onIdle, idle, onEconomy, economy, onWhole }: {
  g: Galaxy
  cam: Cam
  size: { w: number; h: number }
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
  const vw = size.w / cam.k
  const vh = size.h / cam.k
  const showFleet = (f: Fleet) => filter === 'all' || filter === 'fleets' || (filter === 'enemies' && f.owner !== ME)
  const showSystem = (s: StarSystem) => filter !== 'fleets' && (filter !== 'enemies' || s.planets.some((p) => g.planets[p].owner >= 0 && g.planets[p].owner !== ME))
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
        <svg className="ew-mini ew-gmini" data-nodrag viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" onPointerDown={look} onPointerMove={(e) => e.buttons === 1 && look(e)}>
          {g.systems.map((s) => {
            const o = systemOwner(g, s.id)
            return o >= 0 && showSystem(s) ? <circle key={`t${s.id}`} cx={s.x} cy={s.y} r={40} fill={color(g, o)} opacity={0.18} /> : null
          })}
          {g.lanes.map(([a, b], i) => (
            <line key={i} x1={g.systems[a].x} y1={g.systems[a].y} x2={g.systems[b].x} y2={g.systems[b].y} stroke="rgba(140,180,240,0.3)" strokeWidth={2} />
          ))}
          {g.systems.map((s) =>
            showSystem(s) ? <circle key={s.id} cx={s.x} cy={s.y} r={9} fill={color(g, systemOwner(g, s.id))} stroke="#000" strokeWidth={2} /> : <circle key={s.id} cx={s.x} cy={s.y} r={5} fill="rgba(160,180,210,0.35)" />,
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
          <rect x={cam.x - vw / 2} y={cam.y - vh / 2} width={vw} height={vh} className="ew-gmini-view" />
        </svg>
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
function PlanetDock({ g, p, sound, onClose, onFleet, onLook, toast }: { g: Galaxy; p: Planet; sound: EmpiresSound; onClose: () => void; onFleet: (f: Fleet) => void; onLook: () => void; toast: (t: string, tone?: GToast['tone']) => void }) {
  const ours = p.owner === ME
  const theirs = p.owner >= 0 && !ours
  const k = PLANET_KINDS[p.kind]
  const { lockedShips } = useSettings()
  const fac = g.sides[ME].faction
  const all = buildable(fac).filter((t) => lockedShips || t.level <= p.station)
  const [page, setPage] = useState<'warships' | 'strike'>(() => {
    try {
      return localStorage.getItem('mvlos.empires.yardpage') === 'strike' ? 'strike' : 'warships'
    } catch {
      return 'warships'
    }
  })
  const pickPage = (pg: 'warships' | 'strike') => {
    setPage(pg)
    try {
      localStorage.setItem('mvlos.empires.yardpage', pg)
    } catch {
      // Not remembered this time.
    }
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
  const here = fleetsAt(g, p.id)
  const who = { who: `Yours · ${FACTIONS[fac].long}`, rel: 'own' }
  const queue = p.queue.map((q) => (q.unit === 'station' ? { ...q, sprite: `${fac}-station-${Math.min(4, p.station + 1)}`, name: p.station ? `Station level ${p.station + 1}` : 'A new station' } : q))
  const stationBtn = p.station < 4 && (
    <button className={`ew-gp-up ${upWhy ? 'is-off' : ''}`} onClick={upgrade}
      data-tip={`${p.station ? `Upgrade to level ${p.station + 1}: bigger ships, a tougher station, +${Math.round(STATION_INCOME * 100)}% income` : `Build a station: it defends the planet, builds ships and adds ${Math.round(STATION_INCOME * 100)}% income`}. ${STATION_TIME[p.station + 1]} s.${upWhy ? `\n${upWhy}` : ''}`}>
      <Icon name="yard" size={13} /> {p.station ? 'Upgrade' : 'Build station'} <Icon name="credits" size={12} /> {STATION_COST[p.station + 1]}
    </button>
  )
  return (
    <Floating id="gDock" bare at={{ left: 375, bottom: 6 }} className="ew-detailfloat ew-gdock" layout={galaxyLayout}>
      <div className="ew-stationwrap">
        {ours && (p.station > 0 || p.queue.length > 0) && <BuildQueue queue={queue} max={MAX_YARD} campaign onCancel={(i) => (cancelBuild(g, ME, p.id, i), sound.unqueued())} />}
        <Frame className={`ew-detail is-station ew-gplanet ${theirs ? 'is-enemy' : ''}`}>
          <div className="ew-detail-side">
            <button className="ew-gp-look" onClick={onLook} data-tip="Zoom in on it">
              <img src={PLANET_ART(p.kind)} alt="" />
            </button>
            <div className="ew-side-info">
              <strong>{p.name}</strong>
              <small className="ew-muted">{k.name} · {g.systems[p.system].name}</small>
              {p.station > 0 && <Pips level={p.station} />}
            </div>
            <span className="ew-gp-line" data-tip={p.station ? `${p.income} a day, +${Math.round(STATION_INCOME * p.station * 100)}% from its station` : k.blurb}>
              <Icon name="credits" size={13} /> <b>+{planetIncome(g, p)}</b> a day
            </span>
            <span className="ew-gp-line" style={{ color: color(g, p.owner) }}>
              {p.owner < 0 ? 'Unclaimed' : ours ? 'Ours' : `Held by the ${factionName(g, p.owner)}`}
            </span>
            {blockade(g, p.system) && (
              <span className="ew-gp-line ew-small ew-gp-block" data-tip={blockadeTip(g, p.system).trim()} style={{ color: color(g, blockade(g, p.system)!.by) }}>
                <Icon name="hold" size={13} /> {blockade(g, p.system)!.by === ME ? 'Our blockade' : 'Enemy blockade'}
              </span>
            )}
            {p.capture && (
              <span className="ew-gp-cap" style={{ ['--cap' as string]: color(g, p.capture.owner) }} data-tip={`A fleet takes a planet by holding its orbit for ${CAPTURE_TIME} s with no defender there.`}>
                <span>{p.capture.owner === ME ? 'Our fleet is taking it' : 'The enemy is taking it'}: {Math.ceil(CAPTURE_TIME - p.capture.t)} s</span>
                <i><b style={{ width: `${(p.capture.t / CAPTURE_TIME) * 100}%` }} /></i>
              </span>
            )}
          </div>
          <div className="ew-detail-main">
            <header className="ew-yardhead">
              <h5 className="ew-yardtitle">{ours && p.station ? 'Shipyard' : ours ? 'No station' : 'Planet'}</h5>
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
              <div className="ew-yardbody">
                <div className="ew-yardtabs" role="tablist" aria-label="Which ships">
                  <button role="tab" aria-selected={page === 'warships'} className={page === 'warships' ? 'is-on' : ''} onClick={() => pickPage('warships')} data-tip="Warships: corvettes, frigates, cruisers and dreadnoughts">
                    <Icon name="fleet" size={16} />
                    <span>Warships</span>
                    <em>{warships.length}</em>
                  </button>
                  <button role="tab" aria-selected={page === 'strike'} className={page === 'strike' ? 'is-on' : ''} onClick={() => pickPage('strike')} data-tip="Strike craft: fighters, bombers and gunships">
                    <Icon name="attack" size={16} />
                    <span>Strike craft</span>
                    <em>{strike.length}</em>
                  </button>
                </div>
                <div className="ew-yard" ref={grid}>
                  {ships.map((t) => (
                    <ShipCard key={t.id} t={t} who={who} why={cantBuildAt(g, ME, p.id, t.id)} whyReserve={cantBuildAt(g, ME, p.id, t.id)} level={p.station} queued={p.queue.filter((q) => q.unit === t.id).length} onBuild={build} onUnqueue={unqueue} campaign />
                  ))}
                </div>
              </div>
            ) : ours ? (
              <p className="ew-gp-note">Build a station here to defend {p.name} and build ships at it. Each station level also adds {Math.round(STATION_INCOME * 100)}% to what the planet pays.</p>
            ) : (
              <p className="ew-gp-note">
                {k.blurb} {theirs ? (p.station ? `Its level ${p.station} station defends it: bring a fleet strong enough to beat it.` : 'No station defends it: a fleet that holds its orbit takes it.') : 'Unclaimed: a fleet that holds its orbit for a few seconds takes it.'} Select a fleet and right-click the planet to send it.
              </p>
            )}
          </div>
        </Frame>
      </div>
    </Floating>
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
  const threatened = (p: Planet) => (p.capture && p.capture.owner !== ME) || g.fleets.some((f) => f.owner !== ME && (f.planet === p.id || (f.leg && f.leg.planet === p.id) || f.route.some((h) => h.planet === p.id)))
  const enemyIncome = g.sides.reduce((v, _, o) => v + (o === ME ? 0 : incomeOf(g, o)), 0)
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
        <span>Stations <b>{fmt(s.spent.stations)}</b></span>
        <span className="ew-muted" data-tip="What the enemy's planets pay them a day">Enemy: {enemyPlanets} planets, about +{fmt(enemyIncome)} a day</span>
      </div>
    </Floating>
  )
}

/** The battle that's over: who won, what's left on each side, and who jumped out. */
function resultOf(w: World, c: Clash, meSide: number, left: boolean): BattleResult {
  const owners = [c.holder, c.attacker]
  const winSide = left ? 1 - meSide : w.winner
  const survivors: Record<number, string[]> = { [c.holder]: [], [c.attacker]: [] }
  const escaped: Record<number, string[]> = { [c.holder]: [], [c.attacker]: [] }
  owners.forEach((o, side) => {
    const won = side === winSide
    const p = w.players[side]
    // A fighter squadron is one fleet entry while any of it lives.
    const squads = new Set<number>()
    for (const u of w.units) {
      if (u.dead || u.owner !== side || !isShip(u.t) || u.parent) continue
      if (u.squad) {
        if (squads.has(u.squad)) continue
        squads.add(u.squad)
      }
      if (u.retreat > 0 || (!won && left && side === meSide)) escaped[o].push(u.t.id)
      else if (won) survivors[o].push(u.t.id)
    }
    // Ships that never made it onto the field: still with the fleet, or gone with it.
    const waiting = [...p.reserve, ...w.arrivals.filter((a) => a.owner === side).map((a) => a.unit)]
    if (won) survivors[o].push(...waiting)
    else escaped[o].push(...waiting.filter((id) => UNIT[id].tier !== 'fighter'))
    escaped[o].push(...p.escaped)
  })
  const st = w.byId.get(w.players[0].station)
  return { winner: owners[winSide] ?? c.holder, survivors, escaped, stationLeft: !!st && !st.dead }
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

/** Several fleets picked with a box: what they hold together, and each one to pick on its own. */
function FleetsPanel({ g, fleets, onOnly, onClose }: { g: Galaxy; fleets: Fleet[]; onOnly: (f: Fleet) => void; onClose: () => void }) {
  const ships = fleets.flatMap((f) => f.ships)
  return (
    <Floating id="gFleet" title={`${fleets.length} fleets`} at={{ right: 8, top: 52 }} onClose={onClose} className="ew-gpanel" layout={galaxyLayout} aside={<b className="ew-selcount">{ships.length}</b>}>
      <div className="ew-gships">
        {grouped(ships).map(([id, n]) => <ShipRow key={id} g={g} owner={ME} id={id} n={n} />)}
      </div>
      <div className="ew-gmulti">
        {fleets.map((f) => (
          <button key={f.id} onClick={() => onOnly(f)} data-tip="Select only this fleet">
            <b>{f.ships.length}</b>
            <span>{f.leg ? `→ ${g.planets[(f.route.length ? f.route[f.route.length - 1] : f.leg).planet]?.name ?? g.systems[f.leg.system].name}` : g.planets[f.planet]?.name}</span>
            {f.leg && <small>{secs(eta(f))}</small>}
          </button>
        ))}
      </div>
      <p className="ew-ghint">Right-click a planet or system to send them all: they join up into one fleet where they arrive.</p>
    </Floating>
  )
}

function FleetPanel({ g, f, take, setTake, onClose }: { g: Galaxy; f: Fleet; take: Record<string, number>; setTake: (t: Record<string, number>) => void; onClose: () => void }) {
  const ours = f.owner === ME
  const where = f.leg
    ? `Flying to ${g.planets[(f.route.length ? f.route[f.route.length - 1] : f.leg).planet]?.name ?? g.systems[f.leg.system].name}, ${secs(eta(f))} to go`
    : `In orbit of ${g.planets[f.planet]?.name}`
  const groups = grouped(f.ships)
  const picked = groups.reduce((s, [id, n]) => s + Math.min(n, take[id] ?? n), 0)
  return (
    <Floating id="gFleet" title={ours ? 'Our fleet' : `${factionName(g, f.owner)} fleet`} at={{ right: 8, top: 52 }} onClose={onClose} className="ew-gpanel" layout={galaxyLayout}>
      <p className="ew-muted ew-small">{where}</p>
      {!f.leg && f.planet >= 0 && g.planets[f.planet].capture?.owner === f.owner && (
        <span className="ew-gp-cap" style={{ ['--cap' as string]: color(g, f.owner) }}>
          <span>Taking {g.planets[f.planet].name}: {Math.ceil(CAPTURE_TIME - g.planets[f.planet].capture!.t)} s</span>
          <i><b style={{ width: `${(g.planets[f.planet].capture!.t / CAPTURE_TIME) * 100}%` }} /></i>
        </span>
      )}
      {ours && !f.leg && g.rules.frontline && contested(g, f.system, ME) && (
        <p className="ew-ghint">Front line: {g.systems[f.system].name} is contested. Win it before advancing into other enemy systems; the fleet can still fall back.</p>
      )}
      {ours && !f.leg && f.planet >= 0 && g.planets[f.planet].owner !== ME && !g.planets[f.planet].capture && !fleetsAt(g, f.planet).some((x) => x.owner !== ME) && !(g.planets[f.planet].owner >= 0 && g.planets[f.planet].station) && (
        <p className="ew-ghint">Holding orbit: it takes the planet in {CAPTURE_TIME} s.</p>
      )}
      <div className="ew-gships">
        {groups.map(([id, n]) => (
          <ShipRow key={id} g={g} owner={f.owner} id={id} n={n}>
            {ours && !f.leg && n > 0 && (
              <span className="ew-gstep" data-tip="How many of these to send">
                <button onClick={() => setTake({ ...take, [id]: Math.max(0, Math.min(n, take[id] ?? n) - 1) })}>−</button>
                <em>{Math.min(n, take[id] ?? n)}</em>
                <button onClick={() => setTake({ ...take, [id]: Math.min(n, (take[id] ?? n) + 1) })}>+</button>
              </span>
            )}
          </ShipRow>
        ))}
      </div>
      {ours && (
        <p className="ew-ghint">
          {f.leg ? 'Right-click a planet or system to change course.' : picked < f.ships.length ? `Right-click a planet or system to send these ${picked} ships as a new fleet.` : 'Right-click a planet or system to send the fleet. Use − to leave some ships behind.'}
        </p>
      )}
    </Floating>
  )
}

function BattlePrompt({ g, c, onFight, onAuto, onRetreat }: { g: Galaxy; c: Clash; onFight: () => void; onAuto: () => void; onRetreat: () => void }) {
  const p = g.planets[c.planet]
  const odds = useMemo(() => {
    let wins = 0
    for (let i = 0; i < 9; i++) if (autoResolve(g, c, g.time + i * 13.7).winner === ME) wins++
    return wins / 9
  }, [g, c])
  const side = (o: number, ships: string[], station: number) => (
    <div className="ew-gb-side" style={{ borderColor: color(g, o) }}>
      <h5 style={{ color: color(g, o) }}>{o === ME ? 'Our forces' : `${factionName(g, o)} forces`}</h5>
      {station > 0 && <p className="ew-small"><Icon name="yard" size={13} /> Station level {station}</p>}
      <div className="ew-gships">
        {grouped(ships).map(([id, n]) => <ShipRow key={id} g={g} owner={o} id={id} n={n} />)}
        {!ships.length && <span className="ew-muted ew-small">No ships</span>}
      </div>
    </div>
  )
  return (
    <div className="ew-modal-back">
      <div className="ew-modal is-wide ew-gbattle-modal">
        <Frame title={`Battle at ${p.name}`} aside={<span className="ew-muted ew-small">{g.systems[p.system].name} system</span>}>
          <div className="ew-gb-sides">
            {side(c.holder, c.holderShips, c.station)}
            <span className="ew-gb-vs">vs</span>
            {side(c.attacker, c.attackerShips, 0)}
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
