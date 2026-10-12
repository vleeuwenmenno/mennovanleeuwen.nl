import { SHIP_SIZE_BLURB, SHIP_SIZE_NAMES, SHIP_SIZES, type ShipSizes } from './models/sizes.ts'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DIFFICULTY, type Difficulty } from './ai'
import { CREDIT_STEPS, FACTIONS, type FactionId } from './data'
import { Frame, Icon, Tips } from './Hud'
import { battleLayout, type LayoutStore } from './layout'
import { NAME_MAX, nameProblem, tidyName } from './names'
import { REJOIN_WAIT, mpName } from './net'
import { DEFAULT_RULES, GENERATED, MAP, MAPS, MAX_BEACONS, MAX_SEED, cleanRules, defaultArea, generateMap, type Amount, type MapDef, type MapRules, type Rect } from './maps'
import { ALLY, ENEMY, OWN, drawTerrainOverview, relColor } from './render'
import { ACTIONS, RESERVED, bindKey, keyName, keyOf, resetKeys, setSettings, useAskedPanel, useSettings, type Action, type Settings } from './settings'
import { empiresMix, empiresMusic, empiresMuted, empiresVolume } from '../prefs'
import { newWorld, type Owner, type World } from './sim'
import { MAP_SCALE } from './scale'
import { Codex } from './Codex'
import { score } from './Scoreboard'
import type { Bus, EmpiresSound } from './sound'
import { TAP_SLOP, isTouch, useCoarse } from './Touch'
import './touch-menus.css'

// Everything outside a battle: the main menu, the skirmish lobby (map, players, teams), and the
// settings and key bindings, which the battle's own menu opens too.

export type SlotKind = 'you' | 'ai' | 'closed'
/** One spawn point in the lobby: who plays there, as what, on which side. Team 0 is yours. */
export type Slot = { kind: SlotKind; faction: FactionId; team: 0 | 1; difficulty: Difficulty }
/** `map` is a fixed map's id, or GENERATED to build one from `gen`. `areas` are the start areas
 * drawn in the lobby, by slot; a slot without one starts round its spawn point. `names`, by slot:
 * who plays there, for a multiplayer battle carried on offline (otherwise "You", "Enemy 2"…). */
/** `sizes`: the battle's ship sizes (models/sizes.ts); left out, Classic. */
export type Setup = { map: string; slots: Slot[]; credits: number; gen: MapRules; areas: (Rect | null)[]; areasFor?: string; names?: (string | null)[]; sizes?: ShipSizes }

/** Which map, at which size, start areas were drawn for: areas saved for anything else (another
 * map, or this one before it was resized) are dropped rather than landing in the wrong place. */
const areaKey = (map: MapDef) => `${map.id}:${map.w}x${map.h}`

const SETUP_KEY = 'mvlos.empires.lobby'
export { CREDIT_STEPS }

/** Each slot's start area: the one drawn in the lobby, or a square round its spawn point. */
export const setupAreas = (s: Setup, map: MapDef): Rect[] => map.spawns.map((_, i) => (s.areasFor === areaKey(map) ? s.areas[i] : null) ?? defaultArea(map, i))

/** The map a setup plays on. */
export const setupMap = (s: Setup): MapDef => (s.map === GENERATED ? generateMap(s.gen) : (MAP[s.map] ?? MAPS[0]))

/** Slots for a map, keeping what was chosen before where the spawn still exists. */
function slotsFor(map: MapDef, prev: Slot[] = []): Slot[] {
  return map.spawns.map((_, i) => {
    if (prev[i]) return prev[i]
    if (i === 0) return { kind: 'you', faction: 'republic', team: 0, difficulty: 'easy' }
    return { kind: i === 1 ? 'ai' : 'closed', faction: i % 2 ? 'droid' : 'republic', team: 1, difficulty: prev[1]?.difficulty ?? 'easy' }
  })
}

/** The lobby as it was left, remembered in this browser. */
function lastSetup(): Setup {
  try {
    const v = JSON.parse(localStorage.getItem(SETUP_KEY) ?? 'null') as Partial<Setup> | null
    // Setups saved before the generator existed have no rules: they get the defaults.
    const gen = cleanRules(v?.gen)
    const map = v?.map === GENERATED ? generateMap(gen) : v?.map && MAP[v.map] ? MAP[v.map] : MAPS[0]
    const ok = (s: Partial<Slot>): s is Slot =>
      !!s && (s.kind === 'ai' || s.kind === 'closed' || s.kind === 'you') && (s.faction === 'republic' || s.faction === 'droid') && (s.team === 0 || s.team === 1) && !!s.difficulty && s.difficulty in DIFFICULTY
    const slots = Array.isArray(v?.slots) ? v.slots.filter(ok) : []
    if (slots[0]) slots[0] = { ...slots[0], kind: 'you', team: 0 }
    const credits = typeof v?.credits === 'number' && CREDIT_STEPS.includes(v.credits) ? v.credits : 1600
    const isRect = (r: unknown): r is Rect =>
      !!r && typeof r === 'object' && (['x', 'y', 'w', 'h'] as const).every((k) => Number.isFinite((r as Rect)[k])) && (r as Rect).w > 0 && (r as Rect).h > 0
    const areas = Array.isArray(v?.areas) && v.areasFor === areaKey(map) ? v.areas.slice(0, map.spawns.length).map((r) => (isRect(r) ? r : null)) : []
    return {
      areas,
      areasFor: areaKey(map),
      map: v?.map === GENERATED ? GENERATED : map.id,
      slots: slotsFor(map, slots.slice(0, map.spawns.length)).map((s, i) => (i ? { ...s, kind: s.kind === 'you' ? 'ai' : s.kind } : s)),
      credits,
      gen,
      // Big is the default; a setup that chose Classic keeps it.
      sizes: v?.sizes === 'classic' ? 'classic' : 'big',
    }
  } catch {
    return { map: MAPS[0].id, slots: slotsFor(MAPS[0]), credits: 1600, gen: { ...DEFAULT_RULES }, areas: [], sizes: 'big' }
  }
}

function saveSetup(s: Setup) {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(s))
  } catch {
    // Private mode: the lobby just won't be remembered.
  }
}

/** What a slot shows on maps and in messages: "You", "Ally 2 (Republic AI)", "Enemy 3 (Confederacy AI)". */
export const slotName = (s: Slot, i: number) => (s.kind === 'you' ? 'You' : `${s.team === 0 ? 'Ally' : 'Enemy'} ${i + 1} (${FACTIONS[s.faction].name} AI)`)

// --- Bits shared by the menus ------------------------------------------------------------------------

/** No browser or window menu on right-click anywhere in the game. */
const noMenu = (e: React.MouseEvent) => {
  e.preventDefault()
  e.stopPropagation()
}

export function Seg<T extends string | number | boolean>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ew-seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} className={value === v ? 'is-on' : ''} onClick={() => onChange(v)} aria-pressed={value === v}>
          {text}
        </button>
      ))}
    </div>
  )
}

/** A centred panel over a dimmed background; clicking outside closes it. */
export function Modal({ title, onClose, children, wide, className = '' }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  return (
    <div className="ew-modal-back" onClick={onClose}>
      <div className={`ew-modal ${wide ? 'is-wide' : ''} ${className}`} onClick={(e) => e.stopPropagation()}>
        <Frame title={title} aside={<button className="ew-close" onClick={onClose} aria-label="Close">✕</button>}>
          {children}
        </Frame>
      </div>
    </div>
  )
}

/**
 * The battle menu (Esc), with the battle paused behind it: where you are and how it's going, a big
 * Resume, quick switches for sound, speed and the fog grid, the panels, and restarting or leaving,
 * which each ask once more before they throw the battle away.
 */
export function BattleMenu({ w, me, sound, speed, onSpeed, onResume, onPanel, onRestart, onExit, campaign = false, online = false }: {
  w: World
  me: Owner
  sound: EmpiresSound
  speed: number
  onSpeed: (s: number) => void
  onResume: () => void
  onPanel: (panel: 'settings' | 'keys' | 'howto') => void
  /** Left out in a campaign battle: it can't be fought again. */
  onRestart?: () => void
  onExit: () => void
  /** A galactic conquest battle: leaving means pulling the fleet out. */
  campaign?: boolean
  /** A multiplayer battle: it doesn't pause, and runs at one speed. */
  online?: boolean
}) {
  const s = useSettings()
  // Fingers have no keys to bind, so the keybinds panel stays out of their way.
  const coarse = useCoarse()
  const muted = empiresMuted.use()
  const [confirm, setConfirm] = useState<'restart' | 'exit' | null>(null)
  const p = w.players[me]
  const fac = FACTIONS[p.faction]
  const mins = `${Math.floor(w.time / 60)}:${String(Math.floor(w.time % 60)).padStart(2, '0')}`
  return (
    <div className="ew-modal-back" onClick={onResume}>
      <div className="ew-modal ew-battlemenu" onClick={(e) => e.stopPropagation()}>
        <Frame>
          <header className="ew-bm-head">
            <img src={`/games/empires/world/emblem-${p.faction}.webp`} alt="" />
            <div>
              <strong>{w.map.name}</strong>
              <small className="ew-muted">{fac.long} · {mins} · {online ? 'the battle goes on' : 'battle paused'}</small>
            </div>
            <button className="ew-close" onClick={onResume} aria-label="Close the menu">✕</button>
          </header>
          <dl className="ew-bm-stats">
            <div><dt>Built</dt><dd>{p.stats.built}</dd></div>
            <div><dt>Destroyed</dt><dd>{p.stats.killed}</dd></div>
            <div><dt>Lost</dt><dd>{p.stats.lost}</dd></div>
            <div><dt>Earned</dt><dd>{Math.round(p.stats.earned).toLocaleString('en-US')}</dd></div>
          </dl>
          <button className="ew-menu-btn is-primary ew-bm-resume" onClick={onResume}>
            <Icon name="play" size={16} /> Resume
          </button>
          <div className="ew-bm-quick">
            <button className={`ew-bm-toggle ${muted ? '' : 'is-on'}`} onClick={() => sound.setMuted(!muted)} data-tip={muted ? 'Sound is off: click to turn it on' : 'Sound is on: click to mute'}>
              <Icon name={muted ? 'mute' : 'sound'} size={16} /> Sound
            </button>
            {!online && <div className="ew-bm-speed" role="group" aria-label="Game speed">
              <Icon name="speed" size={15} />
              {[1, 2, 3].map((x) => (
                <button key={x} className={speed === x ? 'is-on' : ''} onClick={() => onSpeed(x)} aria-pressed={speed === x}>
                  {x}×
                </button>
              ))}
            </div>}
            <button className={`ew-bm-toggle ${s.fogGrid ? 'is-on' : ''}`} onClick={() => setSettings({ fogGrid: !s.fogGrid })} data-tip={`Fog of war grid (${keyName(s.keys.fogGrid)})`}>
              <Icon name="grid" size={16} /> Fog grid
            </button>
          </div>
          <div className={`ew-bm-panels ${coarse ? 'is-touch' : ''}`}>
            <button className="ew-menu-btn" onClick={() => onPanel('settings')}><Icon name="gear" size={16} /> Settings</button>
            {!coarse && <button className="ew-menu-btn" onClick={() => onPanel('keys')}><Icon name="keys" size={16} /> Keybinds</button>}
            <button className="ew-menu-btn" onClick={() => onPanel('howto')}><Icon name="help" size={16} /> How to play</button>
          </div>
          <LayoutSection />
          {confirm ? (
            <div className="ew-bm-confirm" role="alertdialog" aria-label="Are you sure?">
              <span>
                {confirm === 'restart' ? 'Restart this battle from the beginning? It can\'t be picked up again.'
                  : campaign ? 'Pull our fleet out of this battle? Every ship still here jumps back to the galaxy, and the enemy keeps the field.'
                  : online ? 'Leave this battle? An AI admiral takes over your fleet, and you can\'t come back to it.'
                  : 'Leave this battle for the lobby? It can\'t be picked up again.'}
              </span>
              <div>
                <button className="ew-menu-btn is-danger" onClick={confirm === 'restart' ? onRestart : onExit}>{confirm === 'restart' ? 'Restart' : campaign ? 'Retreat' : 'Leave'}</button>
                <button className="ew-menu-btn" onClick={() => setConfirm(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="ew-bm-danger">
              {onRestart && <button className="ew-menu-btn" onClick={() => setConfirm('restart')}><Icon name="restart" size={16} /> Restart battle</button>}
              <button className="ew-menu-btn is-danger" onClick={() => setConfirm('exit')}><Icon name="exit" size={16} /> {campaign ? 'Retreat to the galaxy' : online ? 'Leave the battle' : 'Leave to lobby'}</button>
            </div>
          )}
        </Frame>
      </div>
    </div>
  )
}

/**
 * The windows' layout, in the battle menu: put everything back, save the arrangement under a name,
 * and load, delete or start every battle with a saved one.
 */
/** Saving, loading and resetting where the windows are: a battle's, or (`campaign`) the galaxy map's. */
export function LayoutSection({ store = battleLayout, campaign = false }: { store?: LayoutStore; campaign?: boolean }) {
  store.useLayoutVersion()
  const { layoutMoved, resetLayout, saveLayout, loadLayout, deleteLayout, setStartLayout } = store
  const [naming, setNaming] = useState<string | null>(null)
  const names = store.savedLayouts()
  const start = store.startLayout()
  const save = () => {
    const name = (naming ?? '').trim().slice(0, 30)
    if (!name) return
    saveLayout(name)
    setNaming(null)
  }
  return (
    <section className="ew-bm-layout">
      <header>
        <h5>Window layout</h5>
        <button className="ew-bm-mini" onClick={resetLayout} disabled={!layoutMoved()} data-tip="Put every window back in its default spot">
          <Icon name="restart" size={13} /> Reset
        </button>
        <button className="ew-bm-mini" onClick={() => setNaming(naming === null ? `Layout ${names.length + 1}` : null)} data-tip="Save where the windows are now, to load again later">
          <Icon name="keys" size={13} /> Save…
        </button>
      </header>
      {naming !== null && (
        <form className="ew-bm-name" onSubmit={(e) => (e.preventDefault(), save())}>
          <input autoFocus value={naming} maxLength={30} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setNaming(null))} aria-label="Layout name" />
          <button className="ew-bm-mini is-primary" type="submit" disabled={!naming.trim()}>{names.includes(naming.trim()) ? 'Replace' : 'Save'}</button>
          <button className="ew-bm-mini" type="button" onClick={() => setNaming(null)}>Cancel</button>
        </form>
      )}
      {names.length > 0 ? (
        <ul>
          {names.map((n) => (
            <li key={n}>
              {!campaign && (
                <button className={`ew-bm-star ${start === n ? 'is-on' : ''}`} onClick={() => setStartLayout(start === n ? null : n)} aria-pressed={start === n}
                  data-tip={start === n ? 'New battles start with this layout: click to start with the defaults instead' : 'Start every new battle with this layout'}>
                  {start === n ? '★' : '☆'}
                </button>
              )}
              <span>{n}</span>
              <button className="ew-bm-mini" onClick={() => loadLayout(n)}>Load</button>
              <button className="ew-bm-mini is-x" onClick={() => deleteLayout(n)} aria-label={`Delete the layout ${n}`} data-tip="Delete this layout">×</button>
            </li>
          ))}
        </ul>
      ) : (
        <small className="ew-muted">
          {campaign
            ? 'Drag the galaxy map, the planet dock, the fleets and the economy where you like them; they stay there. Save the layout here to load it again later.'
            : 'Drag the map, unit card, selection and other windows where you like them, then save the layout here. It lasts for this battle; a saved one can be loaded again, or starred to start every battle with.'}
        </small>
      )}
    </section>
  )
}

// --- Settings and keys ----------------------------------------------------------------------------------

/** Every sound in the game on a button, to audition them. */
function SoundTest({ sound }: { sound: EmpiresSound }) {
  const at = { pan: 0, gain: 1 }
  const groups: [string, [string, () => void][]][] = [
    ['Weapons', [
      ['Fighter guns (Republic)', () => sound.fire('laser', at, 'republic', true)],
      ['Fighter guns (droid)', () => sound.fire('laser', at, 'droid', true)],
      ['Laser cannon (Republic)', () => sound.fire('laser', at, 'republic')],
      ['Laser cannon (droid)', () => sound.fire('laser', at, 'droid')],
      ['Turbolaser', () => sound.fire('turbo', at, 'republic')],
      ['Flak', () => sound.fire('flak', at, 'republic')],
      ['Missile', () => sound.fire('missile', at, 'republic')],
      ['Ion cannon', () => sound.fire('ion', at, 'droid')],
    ]],
    ['Hits and damage', [
      ['Shield hit', () => sound.hit(true, false, at)],
      ['Hull hit', () => sound.hit(false, false, at)],
      ['Heavy hull hit', () => sound.hit(false, true, at)],
      ['Shields down', () => sound.shieldsDown(at)],
      ['Hardpoint destroyed', () => sound.hardpointDown(at)],
      ['Fighter explodes', () => sound.boom(30, at)],
      ['Frigate explodes', () => sound.boom(130, at)],
      ['Capital explodes', () => sound.boom(380, at)],
      ['Fighters launch', () => sound.launch(at)],
    ]],
    ['Republic crew', [
      ['Select fighter', () => sound.select('republic', 'fighter')],
      ['Select cruiser', () => sound.select('republic', 'cruiser')],
      ['Select flagship', () => sound.select('republic', 'capital')],
      ['Move', () => sound.order('move', 'republic')],
      ['Attack', () => sound.order('attack', 'republic')],
      ['Attack move', () => sound.order('attackMove', 'republic')],
      ['Patrol', () => sound.order('patrol', 'republic')],
      ['Hold', () => sound.order('hold', 'republic')],
      ['Stop', () => sound.order('stop', 'republic')],
      ['Rally', () => sound.order('rally', 'republic', 'station')],
      ['Target hardpoint', () => sound.order('target', 'republic')],
    ]],
    ['Droid crew', [
      ['Select fighter', () => sound.select('droid', 'fighter')],
      ['Select flagship', () => sound.select('droid', 'capital')],
      ['Move', () => sound.order('move', 'droid')],
      ['Attack', () => sound.order('attack', 'droid')],
      ['Hold', () => sound.order('hold', 'droid')],
      ['Target hardpoint', () => sound.order('target', 'droid')],
    ]],
    ['Station and economy', [
      ['Queue ship', () => sound.queued()],
      ['Cancel ship', () => sound.unqueued()],
      ['Ship ready', () => sound.shipReady('republic', 'frigate')],
      ['Flagship ready', () => sound.shipReady('republic', 'capital')],
      ['Research started', () => sound.researchStarted()],
      ['Research done', () => sound.researchDone()],
      ['Station level up', () => sound.levelUp()],
      ['Construction', () => sound.constructing()],
      ['Mine online', () => sound.structureDone('mine')],
      ['Defense online', () => sound.structureDone('defense')],
      ['Ore surveyed', () => sound.surveyed()],
      ['Day ends (conquest)', () => sound.payday()],
      ['Beacon taken', () => sound.capture(true)],
      ['Beacon lost', () => sound.capture(false)],
    ]],
    ['Abilities', [
      ['Shield boost', () => sound.ability('shieldBoost')],
      ['Flak barrage', () => sound.ability('flakBarrage')],
      ['Repair swarm', () => sound.ability('repairSwarm')],
      ['Tractor lock', () => sound.ability('tractor')],
      ['Full broadside', () => sound.ability('broadside')],
      ['Launch swarm', () => sound.ability('launchSwarm')],
    ]],
    ['Alerts and interface', [
      ['Under attack', () => sound.alarm(false)],
      ['Station under attack', () => sound.alarm(true)],
      ['Ally eliminated', () => sound.eliminated(true)],
      ['Enemy eliminated', () => sound.eliminated(false)],
      ['Command armed', () => sound.arm()],
      ['Click', () => sound.click()],
      ['Denied', () => sound.error()],
      ['Menu open', () => sound.menu(true)],
      ['Menu close', () => sound.menu(false)],
      ['Pause', () => sound.pause(true)],
      ['Resume', () => sound.pause(false)],
      ['Victory', () => sound.victory()],
      ['Defeat', () => sound.defeat()],
    ]],
  ]
  return (
    <div className="ew-soundtest">
      {groups.map(([g, items]) => (
        <section key={g}>
          <h5>{g}</h5>
          <div className="ew-soundgrid">
            {items.map(([label, play]) => (
              <button key={label} onClick={() => (sound.unlock(), play())}>
                {label}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export function SettingsPanel({ sound }: { sound: EmpiresSound }) {
  const s = useSettings()
  // The sound's settings, which Settings → Apps → Games may change too.
  const vol = empiresVolume.use()
  const muted = empiresMuted.use()
  const mix = empiresMix.use()
  const music = empiresMusic.use()
  const [testing, setTesting] = useState(false)
  // Scroll speed and edge scrolling are for mice: a finger drags the view.
  const coarse = useCoarse()
  const set = (next: Partial<Settings>) => setSettings(next)
  return (
    <div className="ew-form">
      <h5>Sound</h5>
      <label className="ew-row">
        <span>Master volume</span>
        <span className="ew-range">
          <input type="range" min={0} max={1} step={0.05} value={vol} onChange={(e) => sound.setVolume(Number(e.target.value))} />
          <b>{Math.round(vol * 100)}%</b>
        </span>
      </label>
      {(
        [
          ['sfx', 'Battle'],
          ['voice', 'Unit responses'],
          ['ui', 'Interface and alerts'],
          ['amb', 'Ambience'],
          ['music', 'Music'],
        ] as [Bus, string][]
      ).map(([bus, label]) => (
        <label key={bus} className="ew-row">
          <span>{label}</span>
          <span className="ew-range">
            <input type="range" min={0} max={1} step={0.05} value={mix[bus]} onChange={(e) => sound.setMix(bus, Number(e.target.value))} />
            <b>{Math.round(mix[bus] * 100)}%</b>
          </span>
        </label>
      ))}
      <div className="ew-row">
        <span>Sound</span>
        <Seg label="Sound effects" value={!muted} options={[[true, 'On'], [false, 'Off']]} onChange={(on) => sound.setMuted(!on)} />
      </div>
      <div className="ew-row">
        <span>Music</span>
        <Seg label="Music" value={music} options={[[true, 'On'], [false, 'Off']]} onChange={(on) => sound.setMusic(on)} />
      </div>
      <div className="ew-row">
        <span>Day ends (conquest)</span>
        <Seg label="Sound when a day ends in Galactic conquest" value={s.daySound} options={[[true, 'On'], [false, 'Off']]} onChange={(on) => set({ daySound: on })} />
      </div>
      {!coarse && (
        <>
          <h5>Camera</h5>
          <label className="ew-row">
            <span>Scroll speed</span>
            <span className="ew-range">
              <input type="range" min={0.4} max={2.5} step={0.1} value={s.cameraSpeed} onChange={(e) => set({ cameraSpeed: Number(e.target.value) })} />
              <b>{s.cameraSpeed.toFixed(1)}×</b>
            </span>
          </label>
          <div className="ew-row">
            <span>Edge scrolling</span>
            <Seg label="Edge scrolling" value={s.edgeScroll} options={[['off', 'Off'], ['fullscreen', 'Fullscreen only'], ['always', 'Always']]} onChange={(v) => set({ edgeScroll: v })} />
          </div>
        </>
      )}
      <h5>Battlefield</h5>
      <div className="ew-row">
        <span>Health bars</span>
        <Seg label="Health bars" value={s.bars} options={[['damaged', 'Damaged'], ['always', 'Always'], ['selected', 'Selected only']]} onChange={(v) => set({ bars: v })} />
      </div>
      <div className="ew-row">
        <span>Team rings under ships</span>
        <Seg label="Team rings" value={s.rings} options={[[true, 'On'], [false, 'Off']]} onChange={(v) => set({ rings: v })} />
      </div>
      <div className="ew-row">
        <span>{coarse ? 'Weapon ranges of selected ships' : 'Show weapon ranges on hover'}</span>
        <Seg label="Weapon ranges" value={s.ranges} options={[[true, 'On'], [false, 'Off']]} onChange={(v) => set({ ranges: v })} />
      </div>
      <div className="ew-row">
        <span>Procedural models (preview)</span>
        <Seg label="Procedural models" value={s.models} options={[[true, 'On'], [false, 'Sprites']]} onChange={(v) => set({ models: v })} />
      </div>
      <div className="ew-row">
        <span>Messages</span>
        <Seg label="Messages" value={s.toasts} options={[[true, 'All'], [false, 'Alerts only']]} onChange={(v) => set({ toasts: v })} />
      </div>
      <h5>Shipyard</h5>
      <div className="ew-row">
        <span>Ships the station isn't upgraded for</span>
        <Seg label="Locked ships" value={s.lockedShips} options={[[false, 'Hide'], [true, 'Show greyed out']]} onChange={(v) => set({ lockedShips: v })} />
      </div>
      <h5>Multiplayer</h5>
      <MpNameRow sound={sound} />
      <h5>Sound test</h5>
      {testing ? <SoundTest sound={sound} /> : <button className="ew-soundtest-open" onClick={() => (sound.unlock(), setTesting(true))}>Play every sound in the game…</button>}
    </div>
  )
}

/** The multiplayer name the game remembers (net.ts): joining takes it by itself. It can be changed
 * here for next time (in a lobby, the header's Change renames at once), or forgotten, so the next
 * visit asks again. */
function MpNameRow({ sound }: { sound: EmpiresSound }) {
  const name = mpName.use()
  const [draft, setDraft] = useState<string | null>(null)
  if (draft === null)
    return (
      <div className="ew-row">
        <span>
          Name <small className="ew-muted">{name ? <>· <b>{name}</b>, taken by itself when you join</> : '· none yet, asked when you join'}</small>
        </span>
        <span className="ew-chips">
          <button className="ew-chip" onClick={() => (sound.click(), setDraft(name ?? ''))}>
            {name ? 'Change' : 'Pick one'}
          </button>
          {name && (
            <button className="ew-chip" onClick={() => (sound.click(), mpName.set(null))} data-tip="The next time you join, you're asked for a name">
              Forget
            </button>
          )}
        </span>
      </div>
    )
  const tidy = tidyName(draft)
  const why = nameProblem(tidy)
  return (
    <form
      className="ew-row ew-mpname"
      onSubmit={(e) => {
        e.preventDefault()
        if (why) return sound.error()
        sound.click()
        mpName.set(tidy)
        setDraft(null)
      }}
    >
      <span>Name</span>
      <span className="ew-mpname-edit">
        <input value={draft} maxLength={NAME_MAX + 4} autoFocus spellCheck={false} onChange={(e) => setDraft(e.target.value)} aria-label="Multiplayer name" aria-invalid={!!why} />
        <button type="submit" className="ew-chip" disabled={!!why}>
          Save
        </button>
        <button type="button" className="ew-chip" onClick={() => (sound.click(), setDraft(null))}>
          Cancel
        </button>
      </span>
      {why && draft && <small className="ew-mp-bad ew-mpname-why">{why}</small>}
    </form>
  )
}

export function KeybindsPanel() {
  const s = useSettings()
  const [waiting, setWaiting] = useState<Action | null>(null)
  // While waiting, the next key press is the new binding; Esc gives up. Listening in the capture
  // phase keeps the battle from acting on it too.
  useEffect(() => {
    if (!waiting) return
    const on = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      const k = keyOf(e)
      if (k !== 'escape' && !RESERVED.has(k) && !e.ctrlKey && !e.metaKey && !e.altKey && !['shift', 'control', 'alt', 'meta'].includes(k)) bindKey(waiting, k)
      setWaiting(null)
    }
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [waiting])
  const groups = [...new Set(ACTIONS.map((a) => a.group))]
  return (
    <div className="ew-form">
      <p className="ew-muted ew-small">Click a binding, then press the new key. A key that's already used swaps places. Arrow keys always move the camera; 1–9 are control groups.</p>
      <div className="ew-keys">
        {groups.map((g) => (
          <section key={g}>
            <h5>{g}</h5>
            {ACTIONS.filter((a) => a.group === g).map((a) => (
              <div key={a.id} className="ew-row">
                <span>{a.label}</span>
                <button className={`ew-keycap ${waiting === a.id ? 'is-on' : ''}`} onClick={() => setWaiting(waiting === a.id ? null : a.id)}>
                  {waiting === a.id ? 'Press a key…' : keyName(s.keys[a.id])}
                </button>
              </div>
            ))}
          </section>
        ))}
      </div>
      <div className="ew-form-foot">
        <button onClick={resetKeys}>Reset to defaults</button>
      </div>
    </div>
  )
}

export function HowToPlay() {
  const { keys } = useSettings()
  const k = (a: Action) => <kbd>{keyName(keys[a])}</kbd>
  const coarse = useCoarse()
  return (
    <div className="ew-form ew-howto">
      {coarse && (
        <>
          <h5>On a touchscreen</h5>
          <ul>
            <li>Tap a ship to select it. Drag with one finger to move the view, and pinch with two fingers to zoom.</li>
            <li>Long-press anywhere on the battlefield for the action wheel: orders, building and more. Slide onto an action and let go, or let go first and tap one.</li>
            <li>The ⇧ Shift button stays on until tapped again: orders queue up, taps add to the selection, and the shipyard builds five at a time. The ▢ Box button makes the next drag draw a box round a group instead of moving the view.</li>
            <li>Double-tap a ship to select every ship of its kind. Long-press a ship card in the shipyard to build five or take one out of the queue.</li>
            <li>On the galaxy map, tap a planet or a fleet to select it, and long-press for its orders.</li>
            <li>In the lobby, tap Draw areas, then drag on the map to draw where each player may start. In the tech tree, long-press a queued tile to cancel it.</li>
            <li>Long-press anything with a tip to read it.</li>
          </ul>
          <h5>How the battle works</h5>
        </>
      )}
      <ul>
        <li>Destroy every enemy station. A side is out when its stations are gone.</li>
        <li>In the lobby, drag on the map to draw where each player may start. Before the battle, click inside your area to place your station, then start.</li>
        <li>Drag to select ships. Right-click to move, or to attack what's under the cursor. Hold the right button and draw a line to spread the ships evenly along it, or draw a loop to ring them round it. Hold Ctrl as you draw to attack-move. Hold Shift with a click order to queue it after the ones the ships already have.</li>
        <li>With one ship or squadron selected, right-drag from where it should go towards where it should face; hold Alt to do that with the whole selection, which keeps its formation. Shift and right-drag draws a circle: every enemy inside it gets attacked, the targets shared out between your ships.</li>
        <li>Ships built at the station (other than fighters and bombers) wait in the fleet inventory: click your faction's emblem at the top left to open it, and drag one to any spot your fleet can see to call it in from hyperspace. The small jump button on a shipyard card sends one straight to the station instead.</li>
        <li>Click your credits for the economy: income by source, a chart over the battle, what you've earned and spent, and the latest purchases. The economy and fleet inventory panels can be dragged by their title bars.</li>
        <li>Ships steer round asteroid fields and nebulas on their own; click inside one to send them in.</li>
        <li>Select a mining platform to upgrade it: Deeper drills (twice) for more credits, Armour plating, and a Shield generator, since platforms start without shields. Upgrades belong to that platform: lose it and a new one starts from scratch. Every platform has a small flak turret that can just about hold off one fighter squadron.</li>
        <li>Guard ({k('guard')}), then click one of your ships or structures: the selection stays with it and fights off whatever comes near.</li>
        <li>Gunships and bigger can retreat into hyperspace ({k('retreat')}): the drive charges for 6 to 12 seconds while the ship holds still and keeps firing, then it jumps out, freeing its fleet space; 15 seconds later up to half its cost comes back, less the more damaged it was. Destroyed before it jumps, it's lost.</li>
        <li>Park ships at glowing ore for a few seconds to survey it, then click it to build a mining platform (credits) or a defense platform (guns).</li>
        <li>Hold ships near a beacon to capture it: more income and a bigger fleet for your whole team.</li>
        <li>Select your station ({k('station')}) to build ships. Open the tech tree ({k('techTree')}) to research upgrades, including station levels that unlock frigates, cruisers and a flagship. The battle carries on while it's open.</li>
        <li>Big ships have hardpoints. Hover one and right-click a marker to target it: knock out shield generators first.</li>
        <li>Fighters beat cruisers and flagships, gunships beat fighters, frigates beat gunships, cruisers beat frigates.</li>
        <li>Asteroid fields wear down frigates, cruisers and flagships flying through them (fighters and gunships dodge the rocks). Nebulas knock out shields and halve sensor range.</li>
        <li>Park warships next to a wreck to strip it for credits, as long as no enemy ships are there. Destroyed frigates, cruisers and flagships leave wrecks too.</li>
      </ul>
      <p className="ew-muted ew-small">
        Commands: {k('move')} move, {k('attack')} attack move, {k('patrol')} patrol, {k('hold')} stance (hold, maneuver, roam), {k('stop')} stop, {k('ability')} ability, {k('rally')} rally point. Camera: {k('panUp')}
        {k('panLeft')}
        {k('panDown')}
        {k('panRight')} or arrows, wheel to zoom. Ctrl+1–9 sets a control group. {k('pause')} pauses, Esc opens the menu.
      </p>
    </div>
  )
}

// --- Main menu ------------------------------------------------------------------------------------------

export type MenuScreen = 'main' | 'single' | 'multi' | 'conquest'
export function MainMenu({ sound, victories, onPlay, onMultiplayer, onConquest, latest, saves = 0, initial = 'main', rejoin = false }: {
  sound: EmpiresSound
  victories: number
  onPlay: () => void
  /** Online battles against other players. */
  onMultiplayer: () => void
  /** A multiplayer battle this browser stepped away from may still be waiting: offer to rejoin it. */
  rejoin?: boolean
  /** Galactic conquest: carry on with the latest save, pick one to load, or set up a new one. */
  onConquest: (how: 'continue' | 'load' | 'new') => void
  /** The latest save ("name, week 3"), and how many there are. */
  latest?: string
  saves?: number
  initial?: MenuScreen
}) {
  const [panel, setPanel] = useState<'settings' | 'keys' | 'howto' | 'codex' | null>(null)
  // Settings → Apps → Games asked for the game's settings or key bindings.
  useAskedPanel(setPanel)
  // Fingers get no keybinds, and the notes that are tooltips for a mouse as text.
  const coarse = useCoarse()
  // The menu goes one level deep: single player or multiplayer, then the modes each one has.
  const [screen, setScreen] = useState<MenuScreen>(initial)
  const click = (fn: () => void) => () => {
    sound.unlock()
    sound.click()
    fn()
  }
  // Esc steps back out of a sub-menu.
  useEffect(() => {
    if (screen === 'main' || panel) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      sound.click()
      setScreen(screen === 'conquest' ? 'single' : 'main')
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [screen, panel, sound])
  /** A choice that isn't there yet (not built, or nothing to pick): dimmed, with a tag saying why. */
  const soon = (label: string, icon: Parameters<typeof Icon>[0]['name'], tip: string, tag = 'Coming soon') => (
    <button className="ew-menu-btn is-soon" aria-disabled="true" onClick={() => (sound.unlock(), sound.error())} data-tip={tip}>
      <Icon name={icon} size={20} /> {label}
      <em className="ew-soon">{tag}</em>
    </button>
  )
  return (
    <div className="ew-root ew-deck ew-menu" style={{ backgroundImage: 'url(/games/empires/world/title.webp)' }} onContextMenu={noMenu}>
      <Tips />
      <div className="ew-menu-col">
        <h1 className="ew-logo">
          Empires <span>at</span> War
        </h1>
        <p className="ew-tagline">A war in the stars, fought one fleet at a time.</p>
        {screen === 'single' && (
          <Frame className="ew-menu-frame" title="Single player">
            <button className="ew-menu-btn is-primary" onClick={click(onPlay)} data-tip="One battle against the AI, on a map and with the sides you pick.">
              <Icon name="attack" size={20} /> Skirmish
            </button>
            <button className="ew-menu-btn" onClick={click(() => setScreen('conquest'))} data-tip="A campaign across a galaxy of star systems: take planets, build fleets, and fight for every orbit.">
              <Icon name="radar" size={20} /> Galactic conquest
              <em className="ew-beta" data-tip="Still being built: expect rough edges, and changes to come">Beta</em>
            </button>
            {coarse && <small className="ew-muted ew-small">Galactic conquest is still being built: expect rough edges, and changes to come.</small>}
            <button className="ew-menu-btn" onClick={click(() => setScreen('main'))}>
              <Icon name="back" size={20} /> Back
            </button>
          </Frame>
        )}
        {screen === 'conquest' && (
          <Frame className="ew-menu-frame" title="Galactic conquest" aside={<em className="ew-beta" data-tip="Still being built: expect rough edges, and changes to come">Beta</em>}>
            {latest ? (
              <button className="ew-menu-btn is-primary" onClick={click(() => onConquest('continue'))} data-tip={`Carry on with the latest save: ${latest}`}>
                <Icon name="play" size={20} /> Continue
                <em className="ew-ghome-sub">{latest}</em>
              </button>
            ) : (
              soon('Continue', 'play', 'No saved campaign yet: start a new game', 'No saves')
            )}
            {saves > 0 ? (
              <button className="ew-menu-btn" onClick={click(() => onConquest('load'))} data-tip={`${saves} saved campaign${saves === 1 ? '' : 's'}: load, rename or delete them`}>
                <Icon name="keys" size={20} /> Load game
                <em className="ew-ghome-sub">{saves}</em>
              </button>
            ) : (
              soon('Load game', 'keys', 'No saved campaigns yet', 'No saves')
            )}
            <button className={`ew-menu-btn ${latest ? '' : 'is-primary'}`} onClick={click(() => onConquest('new'))} data-tip="Pick a galaxy, its length, your side and the enemy admiral">
              <Icon name="radar" size={20} /> New game
            </button>
            {coarse && <small className="ew-muted ew-small">Beta: still being built, so expect rough edges, and changes to come.</small>}
            <button className="ew-menu-btn" onClick={click(() => setScreen('single'))}>
              <Icon name="back" size={20} /> Back
            </button>
          </Frame>
        )}
        {screen === 'multi' && (
          <Frame className="ew-menu-frame" title="Multiplayer">
            {rejoin && (
              <button className="ew-menu-btn is-primary" onClick={click(onMultiplayer)} data-tip={`Your battle waits ${REJOIN_WAIT} for you to come back`}>
                <Icon name="play" size={20} /> Rejoin battle
              </button>
            )}
            <button className={`ew-menu-btn ${rejoin ? '' : 'is-primary'}`} onClick={click(onMultiplayer)} data-tip="Battles against other players online, with AI on any spare spawns">
              <Icon name="attack" size={20} /> Skirmish
            </button>
            <button className="ew-menu-btn" onClick={click(() => setScreen('main'))}>
              <Icon name="back" size={20} /> Back
            </button>
          </Frame>
        )}
        {screen === 'main' && <Frame className="ew-menu-frame">
          <button className={`ew-menu-btn ${rejoin ? '' : 'is-primary'}`} onClick={click(() => setScreen('single'))}>
            <Icon name="fleet" size={20} /> Single player
          </button>
          {rejoin && (
            <button className="ew-menu-btn is-primary" onClick={click(onMultiplayer)} data-tip={`Your battle waits ${REJOIN_WAIT} for you to come back`}>
              <Icon name="play" size={20} /> Rejoin battle
            </button>
          )}
          <button className="ew-menu-btn" onClick={click(() => setScreen('multi'))}>
            <Icon name="army" size={20} /> Multiplayer
          </button>
          <button className="ew-menu-btn" onClick={click(() => setPanel('codex'))} data-tip="Every ship and structure of both sides: what they carry, what they cost and what they beat">
            <Icon name="codex" size={20} /> Codex
          </button>
          <button className="ew-menu-btn" onClick={click(() => setPanel('settings'))}>
            <Icon name="gear" size={20} /> Settings
          </button>
          {!coarse && (
            <button className="ew-menu-btn" onClick={click(() => setPanel('keys'))}>
              <Icon name="menu" size={20} /> Keybinds
            </button>
          )}
          <button className="ew-menu-btn" onClick={click(() => setPanel('howto'))}>
            <Icon name="help" size={20} /> How to play
          </button>
        </Frame>}
        <p className="ew-muted ew-small">Victories: {victories}</p>
      </div>
      {panel === 'settings' && (
        <Modal title="Settings" onClose={() => setPanel(null)}>
          <SettingsPanel sound={sound} />
        </Modal>
      )}
      {panel === 'keys' && (
        <Modal title="Keybinds" onClose={() => setPanel(null)} wide>
          <KeybindsPanel />
        </Modal>
      )}
      {panel === 'codex' && <Codex sound={sound} onClose={() => setPanel(null)} />}
      {panel === 'howto' && (
        <Modal title="How to play" onClose={() => setPanel(null)}>
          <HowToPlay />
        </Modal>
      )}
    </div>
  )
}

// --- Lobby ---------------------------------------------------------------------------------------------

export const slotColor = (s: Slot) => (s.kind === 'closed' ? '#5a6478' : s.kind === 'you' ? OWN : s.team === 0 ? ALLY : ENEMY)

/** The map from above: nebulas, asteroid fields, rocks, ore, beacons, and the spawns numbered and
 * coloured by slot. Given start areas, it shows them too, and with `onArea` they can be redrawn:
 * drag out a box for the active slot, or click inside an area to make that slot the active one.
 * A finger draws only with `fingerDraws`; otherwise it taps an area or scrolls the page past the map. */
export function MapPreview({ map, slots, areas, active = -1, onArea, onPick, fingerDraws = true, className = '' }: {
  map: MapDef
  slots?: Slot[]
  areas?: Rect[]
  active?: number
  onArea?: (r: Rect) => void
  onPick?: (i: number) => void
  fingerDraws?: boolean
  className?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  // The real map, with dummy players, for its asteroid layout (maps are seeded, so it matches).
  const [world] = useState(() => new Map<string, ReturnType<typeof newWorld>>())
  /** Screen to map units, from the last draw; and the box being dragged out, in map units. */
  const frame = useRef({ s: 1, ox: 0, oy: 0 })
  const drag = useRef<{ x0: number; y0: number; x1: number; y1: number; moved: boolean; tap?: { x: number; y: number } } | null>(null)
  const redraw = useRef(() => {})
  useEffect(() => {
    const c = ref.current
    if (!c) return
    let w = world.get(map.id)
    if (!w) {
      // Rerolling a generated map makes a new one each time: keep only the last few.
      if (world.size > 12) world.clear()
      world.set(map.id, (w = newWorld(map, map.spawns.map((_, i) => ({ faction: 'republic', team: i, spawn: i })))))
    }
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const cw = c.clientWidth
      const ch = c.clientHeight
      c.width = Math.max(1, Math.round(cw * dpr))
      c.height = Math.max(1, Math.round(ch * dpr))
      const g = c.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      const s = Math.min(cw / map.w, ch / map.h)
      const ox = (cw - map.w * s) / 2
      const oy = (ch - map.h * s) / 2
      frame.current = { s, ox, oy }
      g.clearRect(0, 0, cw, ch)
      g.fillStyle = '#050813'
      g.fillRect(ox, oy, map.w * s, map.h * s)
      g.strokeStyle = 'rgba(140,180,240,0.08)'
      const cell = 700 * MAP_SCALE
      for (let x = cell; x < map.w; x += cell) g.strokeRect(ox + x * s, oy, 0, map.h * s)
      for (let y = cell; y < map.h; y += cell) g.strokeRect(ox, oy + y * s, map.w * s, 0)
      drawTerrainOverview(g, map, ox, oy, s)
      g.fillStyle = 'rgba(150,150,165,0.45)'
      for (const r of w!.rocks) {
        g.beginPath()
        g.arc(ox + r.x * s, oy + r.y * s, Math.max(1, r.r * s * 0.8), 0, Math.PI * 2)
        g.fill()
      }
      g.fillStyle = '#f2c14a'
      for (const h of map.wrecks) g.fillRect(ox + h.x * s - 2.5, oy + h.y * s - 2.5, 5, 5)
      g.fillStyle = '#4fe3d8'
      for (const n of map.ore) {
        const x = ox + n.x * s
        const y = oy + n.y * s
        g.beginPath()
        g.moveTo(x, y - 4)
        g.lineTo(x + 3, y)
        g.lineTo(x, y + 4)
        g.lineTo(x - 3, y)
        g.fill()
      }
      g.strokeStyle = '#c8d4ee'
      g.lineWidth = 1.5
      for (const b of map.beacons) {
        g.beginPath()
        g.arc(ox + b.x * s, oy + b.y * s, 5, 0, Math.PI * 2)
        g.stroke()
      }
      // Start areas, under the spawn markers; the active one solid, the box being drawn on top.
      areas?.forEach((a, i) => {
        const slot = slots?.[i]
        if (!slot || slot.kind === 'closed') return
        const col = slotColor(slot)
        g.fillStyle = col
        g.globalAlpha = i === active ? 0.2 : 0.1
        g.fillRect(ox + a.x * s, oy + a.y * s, a.w * s, a.h * s)
        g.globalAlpha = i === active ? 1 : 0.6
        g.strokeStyle = col
        g.lineWidth = i === active ? 2 : 1
        g.setLineDash(i === active ? [] : [5, 4])
        g.strokeRect(ox + a.x * s + 0.5, oy + a.y * s + 0.5, a.w * s - 1, a.h * s - 1)
        g.setLineDash([])
        g.globalAlpha = 1
      })
      const d = drag.current
      if (d?.moved && active >= 0 && slots?.[active]) {
        g.strokeStyle = slotColor(slots[active])
        g.lineWidth = 2
        g.setLineDash([6, 4])
        g.strokeRect(ox + Math.min(d.x0, d.x1) * s, oy + Math.min(d.y0, d.y1) * s, Math.abs(d.x1 - d.x0) * s, Math.abs(d.y1 - d.y0) * s)
        g.setLineDash([])
      }
      const big = cw > 260
      map.spawns.forEach((p, i) => {
        const slot = slots?.[i]
        if (areas && slot?.kind === 'closed') return
        // With areas, the marker sits at the spawn when it's inside the area, else mid-area.
        const a = areas?.[i]
        const at = !a || (p.x >= a.x && p.y >= a.y && p.x <= a.x + a.w && p.y <= a.y + a.h) ? p : { x: a.x + a.w / 2, y: a.y + a.h / 2 }
        const x = ox + at.x * s
        const y = oy + at.y * s
        const r = big ? 11 : 6
        g.fillStyle = slot ? slotColor(slot) : '#c8d4ee'
        g.globalAlpha = slot?.kind === 'closed' ? 0.5 : 1
        g.beginPath()
        g.arc(x, y, r, 0, Math.PI * 2)
        g.fill()
        g.globalAlpha = 1
        if (big) {
          g.fillStyle = '#050813'
          g.font = '700 12px system-ui'
          g.textAlign = 'center'
          g.textBaseline = 'middle'
          g.fillText(String(i + 1), x, y + 0.5)
        }
      })
      g.strokeStyle = 'rgba(183,154,98,0.5)'
      g.lineWidth = 1
      g.strokeRect(ox + 0.5, oy + 0.5, map.w * s - 1, map.h * s - 1)
    }
    redraw.current = draw
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(c)
    return () => ro.disconnect()
  }, [map, slots, world, areas, active])
  const toMap = (e: React.PointerEvent) => {
    const b = ref.current!.getBoundingClientRect()
    const { s, ox, oy } = frame.current
    return { x: Math.max(0, Math.min(map.w, (e.clientX - b.left - ox) / s)), y: Math.max(0, Math.min(map.h, (e.clientY - b.top - oy) / s)) }
  }
  const editable = !!onArea
  return (
    <canvas
      ref={ref}
      className={`ew-mappreview ${editable ? 'is-editable' : ''} ${editable && !fingerDraws ? 'is-tap' : ''} ${className}`}
      // Shaped like the map, so the panel doesn't carry empty bands above and below it.
      style={className ? undefined : { aspectRatio: `${map.w} / ${map.h}` }}
      onPointerDown={
        editable
          ? (e) => {
              const p = toMap(e)
              // A finger that can't draw only taps: the page scrolls if it moves instead.
              if (isTouch(e) && !fingerDraws) {
                drag.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, moved: false, tap: { x: e.clientX, y: e.clientY } }
                return
              }
              ;(e.target as Element).setPointerCapture(e.pointerId)
              drag.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, moved: false }
            }
          : undefined
      }
      onPointerMove={
        editable
          ? (e) => {
              const d = drag.current
              if (!d) return
              if (d.tap) {
                if (Math.hypot(e.clientX - d.tap.x, e.clientY - d.tap.y) > TAP_SLOP) drag.current = null
                return
              }
              const p = toMap(e)
              d.x1 = p.x
              d.y1 = p.y
              if (Math.abs(d.x1 - d.x0) * frame.current.s > 6 || Math.abs(d.y1 - d.y0) * frame.current.s > 6) d.moved = true
              redraw.current()
            }
          : undefined
      }
      onPointerUp={
        editable
          ? () => {
              const d = drag.current
              drag.current = null
              if (!d) return
              const r = { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) }
              // A real box sets the active slot's area; a click picks whose area is under it.
              if (d.moved && r.w >= MIN_AREA && r.h >= MIN_AREA) onArea!(r)
              else if (!d.moved) {
                const hit = areas?.findIndex((a, i) => slots?.[i]?.kind !== 'closed' && d.x0 >= a.x && d.y0 >= a.y && d.x0 <= a.x + a.w && d.y0 <= a.y + a.h) ?? -1
                if (hit >= 0) onPick?.(hit)
              } else redraw.current()
            }
          : undefined
      }
      onPointerCancel={
        editable
          ? () => {
              drag.current = null
              redraw.current()
            }
          : undefined
      }
    />
  )
}

/** The smallest start area that can be drawn, in map units: room for a station and its fleet. */
const MIN_AREA = 700

const AMOUNTS: [Amount, string][] = [
  ['none', 'None'],
  ['few', 'Few'],
  ['many', 'Many'],
]

/** A map's size class by its area, and its dimensions in thousands of units. */
export function mapSize(m: MapDef) {
  // Measured against the battlefield's scale, so a map keeps its class whatever MAP_SCALE is.
  const area = (m.w * m.h) / 1e6 / MAP_SCALE ** 2
  const cls = area < 30 ? 'Small' : area < 50 ? 'Medium' : 'Large'
  return { cls, dims: `${(m.w / 1000).toFixed(1)}k × ${(m.h / 1000).toFixed(1)}k` }
}

/** A map in the picker: preview, size, what's on it, and its description. */
export function MapCard({ m, title, blurb, on, onPick }: { m: MapDef; title: string; blurb: string; on: boolean; onPick: () => void }) {
  const size = mapSize(m)
  const terrain = [m.fields.length && 'asteroid fields', m.nebulas.length && 'nebulas'].filter(Boolean).join(' and ')
  return (
    <button className={`ew-mapcard ${on ? 'is-on' : ''}`} onClick={onPick} aria-pressed={on}>
      <MapPreview map={m} className="is-thumb" />
      <span className="ew-mapcard-head">
        <strong>{title}</strong>
        <em data-tip={`${size.dims} units`}>{size.cls}</em>
      </span>
      <span className="ew-mapcard-stats">
        <b>{m.spawns.length} players</b>
        <span>{size.dims}</span>
        <span>{m.ore.length} ore</span>
        <span>{m.beacons.length} beacons</span>
        {m.wrecks.length > 0 && <span>{m.wrecks.length} wrecks</span>}
      </span>
      {terrain && <small className="ew-mapcard-terrain">With {terrain}</small>}
      <small className="ew-mapcard-blurb">{blurb}</small>
    </button>
  )
}

/** What the marks on the preview are: only the kinds this map has. */
export function MapLegend({ map }: { map: MapDef }) {
  const items: [string, string][] = [
    ['spawn', 'Spawn'],
    ['ore', 'Ore'],
    ['beacon', 'Beacon'],
    ...(map.wrecks.length ? ([['wreck', 'Wreck']] as [string, string][]) : []),
    ['rock', 'Rocks'],
    ...(map.fields.length ? ([['field', 'Asteroid field']] as [string, string][]) : []),
    ...(map.nebulas.length ? ([['nebula', 'Nebula']] as [string, string][]) : []),
  ]
  return (
    <ul className="ew-legend">
      {items.map(([k, label]) => (
        <li key={k}>
          <i className={`is-${k}`} />
          {label}
        </li>
      ))}
    </ul>
  )
}

/** The generator's rules: compact rows under the map preview, which redraws as they change. */
export function GenControls({ rules, onChange, onReroll }: { rules: MapRules; onChange: (patch: Partial<MapRules>) => void; onReroll: () => void }) {
  // One labelled control: the label above, so every group reads top to bottom.
  const field = (label: string, control: ReactNode) => (
    <label className="ew-genfield">
      <span>{label}</span>
      {control}
    </label>
  )
  return (
    <div className="ew-gen">
      <div className="ew-genseed">
        {field(
          'Seed',
          <input
            type="number"
            min={0}
            max={MAX_SEED}
            value={rules.seed}
            onChange={(e) => onChange({ seed: Math.min(MAX_SEED, Math.max(0, Math.floor(Number(e.target.value)) || 0)) })}
          />,
        )}
        <button className="ew-genroll" onClick={onReroll} data-tip="Roll a new random seed: a different map with the same rules">
          <Icon name="dice" size={18} /> New seed
        </button>
        <small className="ew-muted">The same seed and rules always build the same map, so a seed can be shared.</small>
      </div>
      <section>
        <h6>Layout</h6>
        {field('Players', <Seg<2 | 3 | 4> label="Players" value={rules.players} options={[[2, '2'], [3, '3'], [4, '4']]} onChange={(v) => onChange({ players: v })} />)}
        {field('Size', <Seg label="Size" value={rules.size} options={[['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']]} onChange={(v) => onChange({ size: v })} />)}
      </section>
      <section>
        <h6>Resources</h6>
        {field('Ore', <Seg label="Ore" value={rules.resources} options={[['scarce', 'Scarce'], ['normal', 'Normal'], ['rich', 'Rich']]} onChange={(v) => onChange({ resources: v })} />)}
        {field(
          'Beacons',
          <select value={String(rules.beacons)} onChange={(e) => onChange({ beacons: e.target.value === 'auto' ? 'auto' : Number(e.target.value) })}>
            <option value="auto">Auto (one more than players)</option>
            {Array.from({ length: MAX_BEACONS + 1 }, (_, i) => (
              <option key={i} value={i}>{i}</option>
            ))}
          </select>,
        )}
        {field('Wrecks', <Seg label="Wrecks" value={rules.wrecks} options={AMOUNTS} onChange={(v) => onChange({ wrecks: v })} />)}
      </section>
      <section>
        <h6>Terrain</h6>
        {field('Asteroid fields', <Seg label="Asteroid fields" value={rules.asteroidFields} options={AMOUNTS} onChange={(v) => onChange({ asteroidFields: v })} />)}
        {field('Nebulas', <Seg label="Nebulas" value={rules.nebulas} options={AMOUNTS} onChange={(v) => onChange({ nebulas: v })} />)}
      </section>
    </div>
  )
}

export function Lobby({ sound, onBack, onLaunch }: { sound: EmpiresSound; onBack: () => void; onLaunch: (s: Setup) => void }) {
  const [setup, setSetup] = useState(lastSetup)
  const [picker, setPicker] = useState(false)
  /** Whose start area a drag on the map redraws. */
  const [active, setActive] = useState(0)
  // On a touchscreen a swipe over the map scrolls the lobby, until Draw areas turns drawing on.
  const coarse = useCoarse()
  const [drawing, setDrawing] = useState(false)
  const generated = useMemo(() => generateMap(setup.gen), [setup.gen])
  const isGen = setup.map === GENERATED
  const map = isGen ? generated : (MAP[setup.map] ?? MAPS[0])
  const areas = useMemo(() => setupAreas(setup, map), [setup, map])
  const update = (next: Setup) => {
    setSetup(next)
    saveSetup(next)
  }
  const setSlot = (i: number, patch: Partial<Slot>) => update({ ...setup, slots: setup.slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  // A different map starts from its own areas.
  const pickMap = (m: MapDef, id = m.id) => {
    sound.click()
    setActive(0)
    setPicker(false)
    update({ ...setup, map: id, areas: [], slots: slotsFor(m, setup.slots.slice(0, m.spawns.length)) })
  }
  const setRules = (patch: Partial<MapRules>) => {
    const gen = cleanRules({ ...setup.gen, ...patch })
    const m = generateMap(gen)
    update({ ...setup, gen, areas: isGen ? [] : setup.areas, slots: isGen ? slotsFor(m, setup.slots.slice(0, m.spawns.length)) : setup.slots })
  }
  const setArea = (r: Rect) => {
    sound.click()
    const next = map.spawns.map((_, i) => (setup.areasFor === areaKey(map) ? setup.areas[i] : null) ?? null)
    next[active] = r
    update({ ...setup, areas: next, areasFor: areaKey(map) })
  }
  const enemies = setup.slots.filter((s) => s.kind === 'ai' && s.team === 1).length
  const allies = setup.slots.filter((s) => s.kind === 'ai' && s.team === 0).length
  const step = Math.max(0, CREDIT_STEPS.indexOf(setup.credits))
  const act = setup.slots[active]?.kind === 'closed' ? 0 : active
  return (
    <div className="ew-root ew-deck ew-lobby" style={{ backgroundImage: 'url(/games/empires/world/title.webp)' }} onContextMenu={noMenu}>
      <Tips />
      <header className="ew-lobby-head">
        <button onClick={() => (sound.click(), onBack())}>← Main menu</button>
        <h2>Skirmish</h2>
      </header>
      <div className="ew-lobby-grid">
        <Frame title="Players" className="ew-lobby-slots" aside={<span className="ew-muted ew-small">{map.spawns.length} spawns</span>}>
          <div className="ew-slottable" role="table" aria-label="Players">
            <div className="ew-slotrow is-head" role="row">
              <span />
              <span>Player</span>
              <span>Faction</span>
              <span>Side</span>
              <span>AI level</span>
            </div>
            {setup.slots.map((s, i) => (
              <div key={i} role="row" className={`ew-slotrow ${s.kind === 'closed' ? 'is-closed' : ''} ${i === act ? 'is-active' : ''}`}>
                <button
                  className="ew-spawnno"
                  style={{ background: slotColor(s) }}
                  disabled={s.kind === 'closed'}
                  onClick={() => (sound.click(), setActive(i))}
                  data-tip="Draw this player's start area on the map"
                  aria-label={`Spawn ${i + 1}: draw its start area`}
                  aria-pressed={i === act}
                >
                  {i + 1}
                </button>
                {s.kind === 'you' ? (
                  <strong className="ew-slotwho">You</strong>
                ) : (
                  <select className="ew-slotwho" value={s.kind} onChange={(e) => setSlot(i, { kind: e.target.value as SlotKind })} aria-label={`Spawn ${i + 1}`}>
                    <option value="ai">AI</option>
                    <option value="closed">Closed</option>
                  </select>
                )}
                {s.kind === 'closed' ? (
                  <span className="ew-muted ew-small ew-slotopen">Open this spawn for a bigger battle</span>
                ) : (
                  <>
                    <div className="ew-seg ew-factionseg" role="group" aria-label="Faction">
                      {(['republic', 'droid'] as FactionId[]).map((f) => (
                        <button key={f} className={s.faction === f ? 'is-on' : ''} onClick={() => setSlot(i, { faction: f })} data-tip={FACTIONS[f].long} aria-pressed={s.faction === f}>
                          <img src={`/games/empires/world/emblem-${f}.webp`} alt="" />
                          <span>{FACTIONS[f].name}</span>
                        </button>
                      ))}
                    </div>
                    {s.kind === 'you' ? (
                      <span className="ew-teamtag is-own">Your team</span>
                    ) : (
                      <button className={`ew-teamtag ${s.team === 0 ? 'is-ally' : 'is-enemy'}`} onClick={() => setSlot(i, { team: s.team === 0 ? 1 : 0 })} data-tip="Click to switch sides">
                        {s.team === 0 ? 'Ally' : 'Enemy'}
                      </button>
                    )}
                    {s.kind === 'ai' ? (
                      <select value={s.difficulty} onChange={(e) => setSlot(i, { difficulty: e.target.value as Difficulty })} aria-label="Difficulty" data-tip={DIFFICULTY[s.difficulty].blurb}>
                        {(Object.keys(DIFFICULTY) as Difficulty[]).map((d) => (
                          <option key={d} value={d}>{DIFFICULTY[d].name}</option>
                        ))}
                      </select>
                    ) : (
                      <span />
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          <p className="ew-muted ew-small">{DIFFICULTY[setup.slots.find((s) => s.kind === 'ai' && s.team === 1)?.difficulty ?? 'easy'].blurb}</p>
          <h5>Starting credits</h5>
          <label className="ew-range">
            <input type="range" min={0} max={CREDIT_STEPS.length - 1} step={1} value={step} onChange={(e) => update({ ...setup, credits: CREDIT_STEPS[Number(e.target.value)] })} aria-label="Starting credits" />
            <b>{setup.credits.toLocaleString('en-US')}</b>
          </label>
          <h5>Ship sizes</h5>
          <Seg label="Ship sizes" value={setup.sizes ?? 'classic'} options={SHIP_SIZES.map((v) => [v, SHIP_SIZE_NAMES[v]])} onChange={(v) => (sound.click(), update({ ...setup, sizes: v }))} />
          <p className="ew-muted ew-small">{SHIP_SIZE_BLURB[setup.sizes ?? 'classic']}</p>
          <div className="ew-launch">
            <span className="ew-muted ew-small">
              {enemies ? `You${allies ? ` and ${allies} ${allies === 1 ? 'ally' : 'allies'}` : ''} against ${enemies} ${enemies === 1 ? 'enemy' : 'enemies'}` : 'Add at least one enemy.'}
            </span>
            <button className="ew-go" disabled={!enemies} onClick={() => (sound.unlock(), sound.click(), onLaunch(setup))}>
              Launch battle
            </button>
          </div>
        </Frame>
        <Frame title={map.name} className="ew-lobby-preview" aside={
            <span className="ew-chips">
              {isGen && (
                <button className="ew-chip" onClick={() => (sound.click(), setRules({ seed: Math.floor(Math.random() * (MAX_SEED + 1)) }))} data-tip="A different map with the same rules">
                  <Icon name="dice" size={13} /> New seed
                </button>
              )}
              <button className="ew-chip" onClick={() => (sound.click(), setPicker(true))}>Change map</button>
            </span>
          }>
          <MapPreview map={map} slots={setup.slots} areas={areas} active={act} onArea={setArea} onPick={(i) => (sound.click(), setActive(i))} fingerDraws={drawing || !coarse} />
          <div className="ew-areahint">
            <span className="ew-small">
              <i className="ew-dot" style={{ background: slotColor(setup.slots[act]) }} />
              {coarse ? (
                <>
                  {drawing ? 'Drag on the map' : 'Tap Draw areas, then drag on the map'} to draw the start area for <b>{slotName(setup.slots[act], act)}</b>. Tap an area, or a player's number, to switch.
                </>
              ) : (
                <>
                  Drag on the map to draw the start area for <b>{slotName(setup.slots[act], act)}</b>. Click an area, or a number on the left, to switch.
                </>
              )}
            </span>
            {coarse && (
              <button className={`ew-chip ${drawing ? 'is-on' : ''}`} aria-pressed={drawing} onClick={() => (sound.click(), setDrawing(!drawing))}>
                {drawing ? 'Done' : 'Draw areas'}
              </button>
            )}
            <button className="ew-chip" disabled={!setup.areas.some(Boolean)} onClick={() => (sound.click(), update({ ...setup, areas: [] }))}>
              Reset areas
            </button>
          </div>
          <MapLegend map={map} />
          <p className="ew-muted">
            {map.blurb} <span className="ew-small">{mapSize(map).cls} map ({mapSize(map).dims}) · {map.spawns.length} spawns · {map.beacons.length} beacons · {map.ore.length} ore.</span>
          </p>
          {isGen && (
            <GenControls
              rules={setup.gen}
              onChange={setRules}
              onReroll={() => {
                sound.click()
                setRules({ seed: Math.floor(Math.random() * (MAX_SEED + 1)) })
              }}
            />
          )}
        </Frame>
      </div>
      {picker && (
        <Modal title="Choose a map" onClose={() => setPicker(false)} wide className="ew-mappicker-modal">
          <div className="ew-mappicker">
            {MAPS.map((m) => (
              <MapCard key={m.id} m={m} title={m.name} blurb={m.blurb} on={!isGen && m.id === map.id} onPick={() => pickMap(m)} />
            ))}
            <MapCard
              m={generated}
              title="Generated"
              blurb={`Built from your own rules and seed (now: ${generated.name}, seed ${setup.gen.seed}). Change them under the map after picking it.`}
              on={isGen}
              onPick={() => pickMap(generated, GENERATED)}
            />
          </div>
        </Modal>
      )}
    </div>
  )
}

// --- After the battle --------------------------------------------------------------------------------

const fmt = (n: number) => Math.floor(n).toLocaleString('en-US')
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function Result({ w, me, names, won, onAgain, onExit, campaign = false, online = false }: { w: World; me: Owner; names: string[]; won: boolean; onAgain: () => void; onExit: () => void; campaign?: boolean; online?: boolean }) {
  const order = w.players.map((p, i) => ({ p, i })).sort((a, b) => (a.p.team === w.players[me].team ? 0 : 1) - (b.p.team === w.players[me].team ? 0 : 1))
  return (
    <div className="ew-modal-back">
      <div className={`ew-modal ew-result ${won ? 'is-won' : 'is-lost'}`}>
        <Frame title={won ? 'Victory' : 'Defeat'} aside={<span className="ew-muted ew-small">{clock(w.time)} · {w.map.name}</span>}>
          <h2>{won ? 'Victory' : 'Defeat'}</h2>
          <p className="ew-muted">
            {campaign ? (won ? 'The enemy is destroyed or driven off. Our survivors hold the orbit.' : 'Our fleet is gone from this battle. Ships that jumped out are back in the galaxy.')
              : won ? 'Every enemy station is destroyed.' : 'Our side has no stations left.'}
          </p>
          <table>
            <thead>
              <tr>
                <th />
                <th>Built</th>
                <th>Kills</th>
                <th>Losses</th>
                <th>Earned</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {order.map(({ p, i }) => (
                <tr key={i} className={p.alive ? '' : 'is-out'}>
                  <td>
                    <i className="ew-dot" style={{ background: relColor(w, me, i) }} />
                    {names[i]}
                  </td>
                  <td>{p.stats.built}</td>
                  <td>{p.stats.killed}</td>
                  <td>{p.stats.lost}</td>
                  <td>{fmt(p.stats.earned)}</td>
                  <td>{fmt(score(w, i))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ew-menu-list is-row">
            {campaign ? (
              <button className="ew-menu-btn is-primary" onClick={onExit}>Return to the galaxy</button>
            ) : online ? (
              <>
                <button className="ew-menu-btn is-primary" onClick={onAgain}>Back to the lobby</button>
                <button className="ew-menu-btn" onClick={onExit}>Leave the lobby</button>
              </>
            ) : (
              <>
                <button className="ew-menu-btn is-primary" onClick={onAgain}>Fight again</button>
                <button className="ew-menu-btn" onClick={onExit}>Back to the lobby</button>
              </>
            )}
          </div>
        </Frame>
      </div>
    </div>
  )
}
