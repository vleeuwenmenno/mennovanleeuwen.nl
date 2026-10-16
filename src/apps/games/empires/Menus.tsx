import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DIFFICULTY, PROFILES, PROFILE_IDS, profileOf, type Difficulty, type Profile } from './ai'
import { BEACON_INCOME, BEACON_POP, BEACON_SENSOR, CREDIT_STEPS, DEFENSE_DEFAULT, DEFENSE_STEPS, FACTION_IDS, FACTIONS, ORBITALS, cleanDefense, type FactionId } from './data'
import { Frame, Icon, Tips } from './Hud'
import { battleLayout, type LayoutStore } from './layout'
import { NAME_MAX, nameProblem, tidyName } from './names'
import { REJOIN_WAIT, mpName } from './net'
import { DEFAULT_RULES, GENERATED, MAP, MAPS, MAX_BEACONS, MAX_SEED, PLAYER_COUNTS, cleanRules, defaultArea, generateMap, type Amount, type MapDef, type MapRules, type Players, type Rect } from './maps'
import { ALLY, ENEMY, OWN, drawTerrainOverview, relColor } from './render'
import { ACTIONS, GROUP_MODS, RESERVED, bindKey, keyName, keyOf, modName, resetKeys, setGroupMod, setSettings, useAskedPanel, useSettings, type Action, type Settings } from './settings'
import { empiresMapSort, empiresMix, empiresMusic, empiresMuted, empiresVolume, type EmpiresMapSort as MapSort } from '../prefs'
import { performanceOverlayPref } from '../../../os/PerformanceOverlay'
import { REINFORCE, SURCHARGE_MAX, cleanReinforce, newWorld, type Owner, type Reinforce, type World } from './sim'
import { MAP_SCALE } from './scale'
import { Codex } from './Codex'
import { score } from './Scoreboard'
import type { Bus, EmpiresSound, MusicScene } from './sound'
import { TAP_SLOP, isTouch, useCoarse } from './Touch'
import './touch-menus.css'

// Everything outside a battle: the main menu, the skirmish lobby (map, players, teams), and the
// settings, which the battle's own menu opens too. Key bindings live on the settings' Keybinds tab.

export type SlotKind = 'you' | 'ai' | 'closed'
/** One spawn point in the lobby: who plays there, as what, on which side. Team 0 is yours. An AI
 * plays at its difficulty, the way its profile says (ai.ts PROFILES). */
export type Slot = { kind: SlotKind; faction: FactionId; team: 0 | 1; difficulty: Difficulty; profile: Profile }
/** `map` is a fixed map's id, or GENERATED to build one from `gen`. `areas` are the start areas
 * drawn in the lobby, by slot; a slot without one starts round its spawn point. `names`, by slot:
 * who plays there, for a multiplayer battle carried on offline (otherwise "You", "Enemy 2"…). */
export type Setup = { map: string; slots: Slot[]; credits: number; gen: MapRules; areas: (Rect | null)[]; areasFor?: string; names?: (string | null)[]
  /** Reinforcements (sim.ts Reinforce); setups saved before them get the defaults. */
  reinforce?: Reinforce
  /** Defense stations each player may have (data.ts DEFENSE_STEPS, 0: off); setups saved before
   * them get DEFENSE_DEFAULT. */
  stations?: number
  /** Defense platforms on ore (World `oreDefense`); setups saved before the choice get them off,
   * as a new lobby has them. */
  oreDefense?: boolean
}

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
    if (i === 0) return { kind: 'you', faction: 'republic', team: 0, difficulty: 'easy', profile: 'balanced' }
    return { kind: i === 1 ? 'ai' : 'closed', faction: i % 2 ? 'droid' : 'republic', team: 1, difficulty: prev[1]?.difficulty ?? 'easy', profile: prev[1]?.profile ?? 'balanced' }
  })
}

/** The lobby as it was left, remembered in this browser. */
function lastSetup(): Setup {
  try {
    const v = JSON.parse(localStorage.getItem(SETUP_KEY) ?? 'null') as Partial<Setup> | null
    // Setups saved before the generator existed have no rules: they get the defaults.
    const gen = cleanRules(v?.gen)
    const map = v?.map === GENERATED ? generateMap(gen) : v?.map && MAP[v.map] ? MAP[v.map] : MAPS[0]
    const sides: readonly FactionId[] = FACTION_IDS
    const ok = (s: Partial<Slot>): s is Slot =>
      !!s && (s.kind === 'ai' || s.kind === 'closed' || s.kind === 'you') && !!s.faction && sides.includes(s.faction) && (s.team === 0 || s.team === 1) && !!s.difficulty && s.difficulty in DIFFICULTY
    // Setups saved before profiles: their AIs play Balanced.
    const slots = Array.isArray(v?.slots) ? v.slots.filter(ok).map((s) => ({ ...s, profile: profileOf(s.profile) })) : []
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
      // Setups saved before reinforcements had rules: the defaults.
      reinforce: cleanReinforce(v?.reinforce),
      // Setups saved before defense stations: the default limit.
      stations: cleanDefense(v?.stations),
      // Setups saved before the choice: off, as a new lobby has them.
      oreDefense: v?.oreDefense === true,
    }
  } catch {
    return { map: MAPS[0].id, slots: slotsFor(MAPS[0]), credits: 1600, gen: { ...DEFAULT_RULES }, areas: [], reinforce: { ...REINFORCE }, stations: DEFENSE_DEFAULT, oreDefense: false }
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

/** An AI seat's difficulty and its style (profile), one above the other, for the skirmish setup
 * and the multiplayer lobby. */
export function AiPicker({ difficulty, profile, onChange }: { difficulty: Difficulty; profile: Profile; onChange: (patch: { difficulty?: Difficulty; profile?: Profile }) => void }) {
  return (
    <div className="ew-aipick">
      <select value={difficulty} onChange={(e) => onChange({ difficulty: e.target.value as Difficulty })} aria-label="AI difficulty" data-tip={DIFFICULTY[difficulty].blurb}>
        {(Object.keys(DIFFICULTY) as Difficulty[]).map((d) => (
          <option key={d} value={d}>{DIFFICULTY[d].name}</option>
        ))}
      </select>
      <select value={profile} onChange={(e) => onChange({ profile: e.target.value as Profile })} aria-label="AI style" data-tip={PROFILES[profile].blurb}>
        {PROFILE_IDS.map((p) => (
          <option key={p} value={p}>{PROFILES[p].name}</option>
        ))}
      </select>
    </div>
  )
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

/**
 * The reinforcement rules, for the skirmish setup and the multiplayer lobby (where only the host
 * changes them, `onChange` absent for the others): whether strike craft and warships may be bought
 * as reinforcements, and the surcharge. New ships always fly out of the yards; a reinforcement is
 * only ever the red button's choice on a ship's card.
 */
export function ReinforceOptions({ value, onChange }: { value: Reinforce; onChange?: (patch: Partial<Reinforce>) => void }) {
  const r = cleanReinforce(value)
  const set = onChange ?? (() => {})
  const off = !onChange
  const onOff = (label: string, v: boolean, key: 'strike' | 'ships', tip: string) => (
    <label className="ew-genfield" data-tip={tip}>
      <span>{label}</span>
      {off ? <b className="ew-reinf-ro">{v ? 'On' : 'Off'}</b> : <Seg label={label} value={v} options={[[true, 'On'], [false, 'Off']]} onChange={(x) => set({ [key]: x })} />}
    </label>
  )
  return (
    <div className="ew-reinf">
      <div className="ew-reinf-row">
        {onOff('Strike craft', r.strike, 'strike', 'Fighters, bombers, repair craft and engineers can be called in from hyperspace')}
        {onOff('Warships', r.ships, 'ships', 'Gunships, corvettes, frigates, cruisers and flagships can be called in from hyperspace')}
      </div>
      <label className="ew-range">
        <span className="ew-small ew-muted">Surcharge</span>
        <input type="range" min={0} max={SURCHARGE_MAX} step={5} value={r.surcharge} disabled={off} onChange={(e) => set({ surcharge: Number(e.target.value) })} aria-label="Reinforcement surcharge" />
        <b>+{r.surcharge}%</b>
      </label>
      <p className="ew-muted ew-small">
        New ships fly out of their yard or the station's hangar. A ship's red button buys it as a reinforcement instead: built the same way, it waits in hyperspace to be called in anywhere your fleet can see{r.surcharge ? `, for ${r.surcharge}% more` : ', at no extra cost'}.
      </p>
    </div>
  )
}

/**
 * The defense station limit, for the skirmish setup and the multiplayer lobby (where only the host
 * changes it, `onChange` absent for the others): how many each player may have at a time, standing or
 * going up, or Off (none can be built, and the AI builds none).
 */
export function DefenseOptions({ value, onChange }: { value: number; onChange?: (n: number) => void }) {
  const n = cleanDefense(value)
  const names = Object.values(ORBITALS).map((o) => o.name.replace(/ defense station$/, '')).join(', ')
  return (
    <div className="ew-reinf ew-defopts" data-tip={`Engineers build defense stations round the Command Station like a yard (the ${names}), and each one upgrades itself to level 3 and takes a module in each of its slots: guns, flak, a launcher, shields or a hangar.`}>
      {onChange ? (
        <Seg label="Defense stations per player" value={n} options={DEFENSE_STEPS.map((x): [number, string] => [x, x ? String(x) : 'Off'])} onChange={onChange} />
      ) : (
        <b className="ew-reinf-ro">{n ? `${n} per player` : 'Off'}</b>
      )}
      <p className="ew-muted ew-small">
        {n ? `Up to ${n} defense station${n === 1 ? '' : 's'} per player, put up by engineers near the Command Station and fitted with modules.` : 'No defense stations in this battle.'}
      </p>
    </div>
  )
}

/**
 * Defense platforms on ore, for the skirmish setup and the multiplayer lobby (where only the host
 * changes it, `onChange` absent for the others): Off (the default), surveyed ore takes only a mining
 * platform; On, it may take a gun, flak or all-round defense platform instead.
 */
export function OreDefenseOptions({ value, onChange }: { value: boolean; onChange?: (on: boolean) => void }) {
  return (
    <div className="ew-reinf ew-defopts" data-tip="Whether surveyed ore can take a defense platform (gun, flak or all-round) instead of a mining platform. The AI builds them too when they're on.">
      {onChange ? <Seg label="Defense platforms on ore" value={value} options={[[false, 'Off'], [true, 'On']]} onChange={onChange} /> : <b className="ew-reinf-ro">{value ? 'On' : 'Off'}</b>}
      <p className="ew-muted ew-small">{value ? 'Surveyed ore takes a mining platform or a defense platform: guns against warships, flak against strike craft, or both.' : 'Surveyed ore takes only mining platforms.'}</p>
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
 * Resume, quick switches for sound, speed and the fog grid, settings and how to play, and
 * restarting or leaving, which each ask once more before they throw the battle away.
 */
export function BattleMenu({ w, me, sound, speed, onSpeed, onResume, onPanel, onRestart, onExit, campaign = false, online = false }: {
  w: World
  me: Owner
  sound: EmpiresSound
  speed: number
  onSpeed: (s: number) => void
  onResume: () => void
  onPanel: (panel: 'settings' | 'howto') => void
  /** Left out in a campaign battle: it can't be fought again. */
  onRestart?: () => void
  onExit: () => void
  /** A galactic conquest battle: leaving means pulling the fleet out. */
  campaign?: boolean
  /** A multiplayer battle: it doesn't pause, and runs at one speed. */
  online?: boolean
}) {
  const s = useSettings()
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
            <img src={FACTIONS[p.faction].emblem} alt="" />
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
          <div className="ew-bm-panels">
            <button className="ew-menu-btn" onClick={() => onPanel('settings')}><Icon name="gear" size={16} /> Settings</button>
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
  const [musicScene, setMusicScene] = useState(sound.musicScene)
  // Leave the shell's scene as we found it when the test closes.
  useEffect(() => {
    const prev = sound.musicScene
    return () => {
      if (prev === 'lobby') sound.setMusicScene('lobby')
      else if (prev === 'galaxy' || prev === 'galaxyAlarm') sound.setMusicScene('galaxy')
      else if (prev === 'skirmish' || prev === 'skirmishCombat') sound.setMusicScene('skirmish')
      else sound.setMusicScene('menu')
    }
  }, [sound])
  // Each faction's own set (sound.ts SET): its guns, hits and deaths, and its crews.
  const side = (f: FactionId): [string, [string, () => void][]][] => [
    [`${FACTIONS[f].name}: weapons and damage`, [
      ['Fighter guns', () => sound.fire('laser', at, f, true)],
      ['Laser cannon', () => sound.fire('laser', at, f)],
      ['Heavy guns', () => sound.fire('turbo', at, f)],
      ['Point defence', () => sound.fire('flak', at, f)],
      ['Torpedoes', () => sound.fire('missile', at, f)],
      ['Ion weapon', () => sound.fire('ion', at, f)],
      ['Hull hit', () => sound.hit(false, false, at, f)],
      ['Heavy hull hit', () => sound.hit(false, true, at, f)],
      ['Hardpoint destroyed', () => sound.hardpointDown(at, f)],
      ['Fighter explodes', () => sound.boom(30, at, f)],
      ['Frigate explodes', () => sound.boom(130, at, f)],
      ['Capital explodes', () => sound.boom(380, at, f)],
      ['Fighters launch', () => sound.launch(at, f)],
    ]],
    [`${FACTIONS[f].name}: crew`, [
      ['Select fighter', () => sound.select(f, 'fighter')],
      ['Select cruiser', () => sound.select(f, 'cruiser')],
      ['Select flagship', () => sound.select(f, 'capital')],
      ['Select station', () => sound.select(f, 'station')],
      ['Move', () => sound.order('move', f)],
      ['Attack', () => sound.order('attack', f)],
      ['Attack move', () => sound.order('attackMove', f)],
      ['Patrol', () => sound.order('patrol', f)],
      ['Hold', () => sound.order('hold', f)],
      ['Stop', () => sound.order('stop', f)],
      ['Rally', () => sound.order('rally', f, 'station')],
      ['Target hardpoint', () => sound.order('target', f)],
      ['Ship ready', () => sound.shipReady(f, 'frigate')],
      ['Flagship ready', () => sound.shipReady(f, 'capital')],
      ['Repair ability', () => sound.ability('repairSwarm', undefined, f)],
      ['Launch ability', () => sound.ability('launchSwarm', undefined, f)],
    ]],
  ]
  const groups: [string, [string, () => void][]][] = [
    ...FACTION_IDS.flatMap(side),
    ['Shields', [
      ['Shield hit', () => sound.hit(true, false, at)],
      ['Shields down', () => sound.shieldsDown(at)],
    ]],
    ['Station and economy', [
      ['Queue ship', () => sound.queued()],
      ['Cancel ship', () => sound.unqueued()],
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
      ['Damage control', () => sound.ability('repairSwarm')],
      ['Tractor lock', () => sound.ability('tractor')],
      ['Full broadside', () => sound.ability('broadside')],
      ['Scramble', () => sound.ability('launchSwarm')],
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
  const pickMusic = (scene: MusicScene) => {
    sound.unlock()
    sound.previewMusic(scene)
    setMusicScene(scene)
  }
  return (
    <div className="ew-soundtest">
      <section>
        <h5>Music</h5>
        <p className="ew-muted ew-small">Six separate pieces — no shared bed. Skirmish flips to combat when the fight heats up; the galaxy map flips to alarm on a threat.</p>
        <div className="ew-soundgrid">
          {([
            ['Menu', 'menu'],
            ['Lobby', 'lobby'],
            ['Skirmish (calm)', 'skirmish'],
            ['Skirmish (combat)', 'skirmishCombat'],
            ['Galaxy map', 'galaxy'],
            ['Galaxy (alarm)', 'galaxyAlarm'],
            ['Stop', 'none'],
          ] as const).map(([label, scene]) => (
            <button key={scene} className={musicScene === scene ? 'is-on' : ''} onClick={() => pickMusic(scene)}>
              {label}
            </button>
          ))}
        </div>
      </section>
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

/** Pages of the settings dialog. `pointer` pages are for a mouse and keyboard: a finger drags the
 * view and has no keys to bind, so those tabs stay out of the way. */
export type SettingsTab = 'sound' | 'controls' | 'camera' | 'gameplay' | 'keys' | 'multiplayer'
const SETTINGS_TABS: { id: SettingsTab; label: string; pointer?: boolean }[] = [
  { id: 'sound', label: 'Sound' },
  { id: 'controls', label: 'Controls', pointer: true },
  { id: 'camera', label: 'Camera', pointer: true },
  { id: 'gameplay', label: 'Gameplay' },
  { id: 'keys', label: 'Keybinds', pointer: true },
  { id: 'multiplayer', label: 'Multiplayer' },
]

export function SettingsPanel({ sound, initial = 'sound' }: { sound: EmpiresSound; initial?: SettingsTab }) {
  const s = useSettings()
  // The sound's settings, which Settings → Apps → Games may change too.
  const vol = empiresVolume.use()
  const muted = empiresMuted.use()
  const mix = empiresMix.use()
  const music = empiresMusic.use()
  // The page-wide frame timing box (Settings → Appearance), here too since a game on its own has no OS settings.
  const fps = performanceOverlayPref.use()
  const [testing, setTesting] = useState(false)
  // Scroll speed, edge scrolling and key bindings are for a mouse and keyboard.
  const coarse = useCoarse()
  const tabs = SETTINGS_TABS.filter((t) => !t.pointer || !coarse)
  const [tab, setTab] = useState<SettingsTab>(tabs.some((t) => t.id === initial) ? initial : 'sound')
  const tabsRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const set = (next: Partial<Settings>) => setSettings(next)
  const pick = (id: SettingsTab) => {
    if (id === tab) return
    sound.click()
    setTab(id)
    if (pageRef.current) pageRef.current.scrollTop = 0
  }
  return (
    <div className="ew-settings">
      <div
        className="ew-set-tabs"
        role="tablist"
        aria-label="Settings"
        ref={tabsRef}
        onKeyDown={(e) => {
          const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
          if (!dir) return
          e.preventDefault()
          const i = tabs.findIndex((t) => t.id === tab)
          const next = tabs[(i + dir + tabs.length) % tabs.length]
          pick(next.id)
          queueMicrotask(() => tabsRef.current?.querySelector<HTMLButtonElement>(`#ew-set-tab-${next.id}`)?.focus())
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`ew-set-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="ew-set-page"
            tabIndex={tab === t.id ? 0 : -1}
            className={tab === t.id ? 'is-on' : ''}
            onClick={() => pick(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="ew-set-page ew-form" role="tabpanel" id="ew-set-page" aria-labelledby={`ew-set-tab-${tab}`} ref={pageRef}>
        {tab === 'sound' && (
          <>
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
            <h5>Sound test</h5>
            {testing ? <SoundTest sound={sound} /> : <button className="ew-soundtest-open" onClick={() => (sound.unlock(), setTesting(true))}>Play every sound in the game…</button>}
          </>
        )}
        {tab === 'controls' && (
          <>
            <p className="ew-muted ew-small">The pointer at the edge of the screen moves the view.</p>
            <div className="ew-row">
              <span>Edge scrolling</span>
              <Seg label="Edge scrolling" value={s.edgeScroll} options={[['off', 'Off'], ['fullscreen', 'Fullscreen only'], ['always', 'Always']]} onChange={(v) => set({ edgeScroll: v })} />
            </div>
          </>
        )}
        {tab === 'camera' && (
          <>
            <p className="ew-muted ew-small">How fast the view moves with the keys and with the screen edge. Arrow keys always move it.</p>
            <label className="ew-row">
              <span>Scroll speed</span>
              <span className="ew-range">
                <input type="range" min={0.4} max={2.5} step={0.1} value={s.cameraSpeed} onChange={(e) => set({ cameraSpeed: Number(e.target.value) })} />
                <b>{s.cameraSpeed.toFixed(1)}×</b>
              </span>
            </label>
          </>
        )}
        {tab === 'gameplay' && (
          <>
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
              <span>Messages</span>
              <Seg label="Messages" value={s.toasts} options={[[true, 'All'], [false, 'Alerts only']]} onChange={(v) => set({ toasts: v })} />
            </div>
            <div className="ew-row">
              <span>Show FPS and frame time</span>
              <Seg label="Show FPS and frame time" value={fps} options={[[true, 'On'], [false, 'Off']]} onChange={(v) => performanceOverlayPref.set(v)} />
            </div>
            <h5>Windows</h5>
            <div className="ew-row">
              <span data-tip={coarse ? 'Dragging a window shows anchors: its default spot and the screen\'s corners and edges. Let go near one and it snaps there.' : 'Dragging a window shows anchors: its default spot and the screen\'s corners and edges. Let go near one and it snaps there. Hold Shift while dragging to place it freely.'}>Snap windows to dock points</span>
              <Seg label="Snap windows to dock points" value={s.snapWindows} options={[[true, 'On'], [false, 'Off']]} onChange={(v) => set({ snapWindows: v })} />
            </div>
            <h5>Shipyard</h5>
            <div className="ew-row">
              <span>Ships the station isn't upgraded for</span>
              <Seg label="Locked ships" value={s.lockedShips} options={[[false, 'Hide'], [true, 'Show greyed out']]} onChange={(v) => set({ lockedShips: v })} />
            </div>
          </>
        )}
        {tab === 'keys' && <KeybindsPanel />}
        {tab === 'multiplayer' && <MpNameRow sound={sound} />}
      </div>
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
      <p className="ew-muted ew-small">Click a binding, then press the new key. A key that's already used swaps places. Arrow keys always move the camera.</p>
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
            {g === 'Control groups' && (
              <>
                {(['groupSet', 'groupAdd'] as const).map((which) => (
                  <div key={which} className="ew-row ew-modrow">
                    <span>{which === 'groupSet' ? 'Set a group to the selection' : 'Add the selection to a group'}</span>
                    <span className="ew-seg ew-modseg" role="group" aria-label={which === 'groupSet' ? 'Modifier to set a group' : 'Modifier to add to a group'}>
                      {GROUP_MODS.map((m) => (
                        <button key={m} className={s[which] === m ? 'is-on' : ''} aria-pressed={s[which] === m} onClick={() => setGroupMod(which, m)}>
                          {modName(m)}
                        </button>
                      ))}
                    </span>
                  </div>
                ))}
                <p className="ew-muted ew-small">
                  {modName(s.groupSet)}+{keyName(s.keys.group1)} sets group {keyName(s.keys.group1)}, {modName(s.groupAdd)}+{keyName(s.keys.group1)} adds to it, {keyName(s.keys.group1)} selects it, and pressing it twice quickly looks at it. Ctrl+number is also the browser's tab switch: the game keeps it while it has the keyboard. If your browser still switches tabs, pick Ctrl+Shift for setting groups.
                </p>
              </>
            )}
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
  const { groupSet, groupAdd } = useSettings()
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
            <li>Control groups: tap + Group above the selection to save what's selected as a group. Tap a group to select it, double-tap to look at it, and long-press it to set it again, add to it or clear it.</li>
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
        <li>New ships fly out of the yard that builds them (or the station's hangar) to its rally point. The small red button on a ship's card buys it as a reinforcement instead, for a surcharge (15% unless the lobby says otherwise): it waits in the fleet inventory, so click your faction's emblem at the top left to open it, and drag it to any spot your fleet can see to call it in from hyperspace.</li>
        <li>Control groups: {modName(groupSet)}+{k('group1')} puts the selection in group 1 (ships, a yard or the station), {modName(groupAdd)}+{k('group1')} adds the selection to it, and {k('group1')} selects it; press it twice quickly to look at it. The same for 2 to 9 and 0. The groups show above the selection: click one to select it, double-click to look at it.</li>
        <li>In a team battle, the send button beside your credits gives credits to an ally. AI allies take them gladly, and one with plenty to spare helps out a player on its team who's broke.</li>
        <li>Click your credits for the economy: income by source, a chart over the battle, what you've earned and spent, and the latest purchases. The economy and fleet inventory panels can be dragged by their title bars.</li>
        <li>Ships steer round asteroid fields and nebulas on their own; click inside one to send them in.</li>
        <li>Ships two or more classes apart fly over each other, friend or foe, as fighters fly over everything: gunships and corvettes over cruisers and flagships, frigates over flagships. Closer sizes keep clear of each other's hulls.</li>
        <li>Select a mining platform to upgrade it: Deeper drills (twice) for more credits, Armour plating, and a Shield generator, since platforms start without shields. Upgrades belong to that platform: lose it and a new one starts from scratch. Every platform has a small flak turret that can just about hold off one fighter squadron.</li>
        <li>Guard ({k('guard')}), then click one of your ships or structures: the selection stays with it and fights off whatever comes near. On a ship two classes bigger (a flagship for gunships and corvettes, say) they escort it: each takes a place over its hull, moves and turns with it, takes on enemies that come within reach of it and comes back, and repair ships mend it first.</li>
        <li>Gunships and bigger can retreat into hyperspace ({k('retreat')}): the drive charges for 6 to 12 seconds while the ship holds still and keeps firing, then it jumps out, freeing its fleet space; 15 seconds later up to half its cost comes back, less the more damaged it was. Destroyed before it jumps, it's lost.</li>
        <li>Engineers also build defense stations near the Command Station (as many as the lobby allows, two unless it says otherwise): select one to upgrade it to level 2 and 3 and to fit a module into each of its slots (one, two and four by level): a battery against warships, flak against strike craft, a launcher whose missiles go through shields, a shield generator or a hangar. Fitting a filled slot swaps its module.</li>
        <li>Park ships at glowing ore for a few seconds to survey it, then click it to build a mining platform (credits). With Defense platforms on ore turned on in the lobby (they're off unless it says so), it can take a defense platform (guns) instead.</li>
        <li>Hold ships near a beacon to capture it. Each beacon your team holds gives every player on it +{BEACON_POP} fleet capacity and +{Math.round(BEACON_INCOME * 60)} credits a minute, and it sees {BEACON_SENSOR} round it for your whole team: the fog lifts there, on the minimap too, and reinforcements can be called in there. Hover over one to see what it gives.</li>
        <li>Select your station ({k('station')}) to build ships. Open the tech tree ({k('techTree')}) to research upgrades, including station levels that unlock frigates, cruisers and a flagship. The battle carries on while it's open.</li>
        <li>Your station is a Command Station: it builds strike craft, gunships and engineers. From station level 2, engineers build a Frigate Yard anywhere inside the build ring round it ({k('build')} with engineers or the station selected): the yard builds frigates and corvettes, with its own queue and rally point ({k('yard')} selects it). Engineers also weld our structures back together: right-click one with them. A destroyed yard leaves a ruin that engineers rebuild for half the price.</li>
        <li>From station level 3 engineers build a Capital Yard as well: cruisers come from there, and flagships once its Capital slip expansion is fitted (station level 4). {k('cyard')} selects it.</li>
        <li>Expansions: the Command Station and both yards build modules onto themselves, one at a time, from the Expansions tab of their panel (and the tech tree). The station takes a Strike hangar (needed for bombers), a Sensor array and a Shield core; the Frigate Yard a Second slip (two ships at once), a Drydock (mends ships nearby) and an Armour works (more hull for every frigate and corvette); the Capital Yard a Capital slip (flagships) and a Fighter wing (its own defense wing). Each can be shot off: its feature stops until engineers weld it back for part of its price. A ruined yard loses its expansions.</li>
        <li>Big ships have hardpoints. Hover one and right-click a marker to target it: knock out shield generators first.</li>
        <li>Fighters beat cruisers and flagships, gunships beat fighters, frigates beat gunships, cruisers beat frigates.</li>
        <li>Asteroid fields wear down frigates, cruisers and flagships flying through them, the faster the harder: shields first, then hull, and a Swarm hull doesn't grow back while the rocks hit it (fighters and gunships dodge the rocks). Nebulas knock out shields and halve sensor range.</li>
        <li>Park warships next to a wreck to strip it for credits, as long as no enemy ships are there. Destroyed frigates, cruisers and flagships leave wrecks too.</li>
      </ul>
      <p className="ew-muted ew-small">
        Commands: {k('move')} move, {k('attack')} attack move, {k('patrol')} patrol, {k('hold')} stance (hold, maneuver, roam), {k('stop')} stop, {k('ability')} ability, {k('rally')} rally point. Camera: {k('panUp')}
        {k('panLeft')}
        {k('panDown')}
        {k('panRight')} or arrows, wheel to zoom. {modName(groupSet)}+number sets a control group, the number selects it. {k('pause')} pauses, Esc opens the menu.
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
  const [panel, setPanel] = useState<'settings' | 'codex' | null>(null)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('sound')
  // Settings → Apps → Games asked for the game's settings, or for its key bindings (that tab).
  useAskedPanel((asked) => {
    setSettingsTab(asked === 'keys' ? 'keys' : 'sound')
    setPanel('settings')
  })
  // Notes that are tooltips for a mouse, written out where a finger can't hover.
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
          <button className="ew-menu-btn" onClick={click(() => { setSettingsTab('sound'); setPanel('settings') })}>
            <Icon name="gear" size={20} /> Settings
          </button>
        </Frame>}
        <p className="ew-muted ew-small">Victories: {victories}</p>
      </div>
      {panel === 'settings' && (
        <Modal title="Settings" onClose={() => setPanel(null)} className="is-settings">
          <SettingsPanel sound={sound} initial={settingsTab} />
        </Modal>
      )}
      {panel === 'codex' && <Codex sound={sound} onClose={() => setPanel(null)} />}
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
      // Markers keep their size, except in a small thumbnail of a big map, where they'd run together:
      // there they shrink as the map grows past a medium one, down to half.
      const big = cw > 260
      const k = big ? 1 : Math.max(0.5, Math.min(1, (7600 * MAP_SCALE) / Math.max(map.w, map.h)))
      g.fillStyle = '#f2c14a'
      for (const h of map.wrecks) g.fillRect(ox + h.x * s - 2.5 * k, oy + h.y * s - 2.5 * k, 5 * k, 5 * k)
      g.fillStyle = '#4fe3d8'
      for (const n of map.ore) {
        const x = ox + n.x * s
        const y = oy + n.y * s
        g.beginPath()
        g.moveTo(x, y - 4 * k)
        g.lineTo(x + 3 * k, y)
        g.lineTo(x, y + 4 * k)
        g.lineTo(x - 3 * k, y)
        g.fill()
      }
      g.strokeStyle = '#c8d4ee'
      g.lineWidth = 1.5
      for (const b of map.beacons) {
        g.beginPath()
        g.arc(ox + b.x * s, oy + b.y * s, 5 * k, 0, Math.PI * 2)
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
      map.spawns.forEach((p, i) => {
        const slot = slots?.[i]
        if (areas && slot?.kind === 'closed') return
        // With areas, the marker sits at the spawn when it's inside the area, else mid-area.
        const a = areas?.[i]
        const at = !a || (p.x >= a.x && p.y >= a.y && p.x <= a.x + a.w && p.y <= a.y + a.h) ? p : { x: a.x + a.w / 2, y: a.y + a.h / 2 }
        const x = ox + at.x * s
        const y = oy + at.y * s
        const r = big ? 11 : 6 * k
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
  const cls = area < 30 ? 'Small' : area < 50 ? 'Medium' : area < 90 ? 'Large' : 'Huge'
  return { cls, dims: `${(m.w / 1000).toFixed(1)}k × ${(m.h / 1000).toFixed(1)}k` }
}

/** One map in the picker's list: a thumbnail, its name and terrain, a one-line description, and
 * its size, players, beacons and ore in columns. */
function MapRow({ m, title, blurb, on, sel, onPick, onFocus }: { m: MapDef; title: string; blurb: string; on: boolean; sel: boolean; onPick: () => void; onFocus: () => void }) {
  const size = mapSize(m)
  const terrain = [m.fields.length > 0 && 'Fields', m.nebulas.length > 0 && 'Nebulas', m.wrecks.length > 0 && 'Wrecks'].filter(Boolean) as string[]
  return (
    <button className={`ew-maprow ${on ? 'is-on' : ''} ${sel ? 'is-sel' : ''}`} onClick={onPick} onFocus={onFocus} role="option" aria-selected={sel} aria-current={on || undefined} tabIndex={sel ? 0 : -1}>
      <MapPreview map={m} className="is-thumb" />
      <span className="ew-maprow-main">
        <span className="ew-maprow-name">
          <strong>{title}</strong>
          {on && <em className="is-now">Current</em>}
          {terrain.map((t) => (
            <em key={t}>{t}</em>
          ))}
        </span>
        <small className="ew-maprow-blurb">{blurb}</small>
        <small className="ew-maprow-short">
          {m.spawns.length} players · {size.cls}
        </small>
      </span>
      <span className="ew-maprow-size" data-tip={`${size.dims} units`}>
        <b>{size.cls}</b>
        <small>{size.dims}</small>
      </span>
      <span className="ew-maprow-n">{m.spawns.length}</span>
      <span className="ew-maprow-n">{m.beacons.length}</span>
      <span className="ew-maprow-n">{m.ore.length}</span>
    </button>
  )
}

const SORTS: [MapSort['by'], string][] = [
  ['name', 'Name'],
  ['size', 'Size'],
  ['players', 'Players'],
]
const mapArea = (m: MapDef) => m.w * m.h

/**
 * The map picker of both lobbies: the maps as a list to search (name and description) and sort
 * (name, size or players; the last sort is remembered in this browser), with quick filters by
 * player count. The generated map stays pinned at the foot, whatever the search. Arrow keys move
 * through the list and Enter picks; the search box takes the keys while it has the focus.
 */
export function MapPicker({ current, generated, generatedBlurb, onPick, onClose }: { current: string; generated: MapDef; generatedBlurb: string; onPick: (id: string) => void; onClose: () => void }) {
  const coarse = useCoarse()
  const sort = empiresMapSort.use()
  const [query, setQuery] = useState('')
  const [players, setPlayers] = useState<number | null>(null)
  const counts = useMemo(() => [...new Set(MAPS.map((m) => m.spawns.length))].sort((a, b) => a - b), [])
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const shown = MAPS.filter((m) => (players === null || m.spawns.length === players) && words.every((w) => `${m.name} ${m.blurb}`.toLowerCase().includes(w))).sort((a, b) => {
    const by = sort.by === 'size' ? mapArea(a) - mapArea(b) : sort.by === 'players' ? a.spawns.length - b.spawns.length : 0
    return (by || a.name.localeCompare(b.name)) * (sort.desc ? -1 : 1)
  })
  // Every row, the generated map last: what the arrow keys walk through.
  const ids = [...shown.map((m) => m.id), GENERATED]
  // The selected row, by its map (null: the first), so a new sort keeps it and a new search starts at the top.
  const [selId, setSelId] = useState<string | null>(current)
  const at = selId === null ? 0 : Math.max(0, ids.indexOf(selId))
  const list = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  // The current map in view when the picker opens; the selected one as it moves.
  useEffect(() => {
    list.current?.querySelector(`[data-id="${ids[at]}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [at, ids.join()])
  // Typing on a desktop goes straight to the search; a phone's keyboard waits for a tap.
  useEffect(() => {
    if (!coarse) search.current?.focus({ preventScroll: true })
  }, [coarse])
  const move = (d: number, focusRow: boolean) => {
    const next = Math.max(0, Math.min(ids.length - 1, at + d))
    setSelId(ids[next])
    if (focusRow) list.current?.querySelector<HTMLElement>(`[data-id="${ids[next]}"] > button`)?.focus()
  }
  const keys = (e: React.KeyboardEvent, inRows: boolean) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 1 : -1, inRows)
    } else if (e.key === 'Enter' && !inRows) {
      e.preventDefault()
      onPick(ids[at])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }
  const setSort = (by: MapSort['by']) => empiresMapSort.set((s) => ({ by, desc: s.by === by ? !s.desc : false }))
  const clear = () => {
    setQuery('')
    setPlayers(null)
    setSelId(null)
    search.current?.focus({ preventScroll: true })
  }
  const filtered = !!words.length || players !== null
  return (
    <Modal title="Choose a map" onClose={onClose} wide className="ew-mappicker-modal">
      <div className="ew-mappicker">
        <div className="ew-mappicker-tools">
          <label className="ew-mapsearch">
            <Icon name="search" size={15} />
            <input
              ref={search}
              type="search"
              value={query}
              placeholder="Search maps"
              aria-label="Search maps by name or description"
              spellCheck={false}
              onChange={(e) => {
                setQuery(e.target.value)
                setSelId(null)
              }}
              onKeyDown={(e) => keys(e, false)}
            />
          </label>
          <div className="ew-mappicker-opts">
            <div className="ew-seg ew-mapfilter" role="group" aria-label="Players">
              <button className={players === null ? 'is-on' : ''} aria-pressed={players === null} onClick={() => (setPlayers(null), setSelId(null))}>
                All
              </button>
              {counts.map((n) => (
                <button key={n} className={players === n ? 'is-on' : ''} aria-pressed={players === n} onClick={() => (setPlayers(players === n ? null : n), setSelId(null))} data-tip={`Maps for ${n} players`}>
                  {n}P
                </button>
              ))}
            </div>
            <div className="ew-seg ew-mapsort" role="group" aria-label="Sort maps">
              {SORTS.map(([by, label]) => {
                const on = sort.by === by
                return (
                  <button key={by} className={on ? 'is-on' : ''} aria-pressed={on} onClick={() => setSort(by)} data-tip={on ? 'Click again to reverse' : `Sort by ${label.toLowerCase()}`}>
                    {label}
                    {on && <span aria-label={sort.desc ? 'descending' : 'ascending'}>{sort.desc ? ' ↓' : ' ↑'}</span>}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
        <div className="ew-maprow is-head" aria-hidden="true">
          <span />
          <span>Map</span>
          <span>Size</span>
          <span>Players</span>
          <span>Beacons</span>
          <span>Ore</span>
        </div>
        <div className="ew-maplist" ref={list} role="listbox" aria-label="Maps" onKeyDown={(e) => keys(e, true)}>
          {/* The maps scroll; the generated map stays in view under them. */}
          <div className="ew-maplist-maps" role="none">
            {shown.map((m, i) => (
              <div key={m.id} data-id={m.id} role="none">
                <MapRow m={m} title={m.name} blurb={m.blurb} on={current === m.id} sel={at === i} onPick={() => onPick(m.id)} onFocus={() => setSelId(m.id)} />
              </div>
            ))}
            {!shown.length && (
              <div className="ew-mapempty">
                <p>
                  No maps match{words.length ? ` “${query.trim()}”` : ''}
                  {players !== null ? ` with ${players} players` : ''}.
                </p>
                <button className="ew-chip" onClick={clear}>
                  {words.length ? 'Clear search' : 'Show all maps'}
                </button>
              </div>
            )}
          </div>
          <p className="ew-maplist-sep">{filtered && shown.length ? 'Or build your own' : 'Build your own'}</p>
          <div data-id={GENERATED} role="none">
            <MapRow m={generated} title="Generated" blurb={generatedBlurb} on={current === GENERATED} sel={at === shown.length} onPick={() => onPick(GENERATED)} onFocus={() => setSelId(GENERATED)} />
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** What the marks on the preview are: only the kinds this map has. With `counts`, how many of each
 * there are (the lobbies' map panel, where this is the map's facts too). */
export function MapLegend({ map, counts = false }: { map: MapDef; counts?: boolean }) {
  const items: [string, string, number?][] = [
    ['spawn', 'Spawn', map.spawns.length],
    ['ore', 'Ore', map.ore.length],
    ['beacon', 'Beacon', map.beacons.length],
    ...(map.wrecks.length ? ([['wreck', 'Wreck', map.wrecks.length]] as [string, string, number][]) : []),
    ['rock', 'Rocks'],
    ...(map.fields.length ? ([['field', 'Asteroid field']] as [string, string][]) : []),
    ...(map.nebulas.length ? ([['nebula', 'Nebula']] as [string, string][]) : []),
  ]
  return (
    <ul className={`ew-legend ${counts ? 'has-counts' : ''}`}>
      {items.map(([k, label, n]) => (
        <li key={k}>
          <i className={`is-${k}`} />
          {counts && n !== undefined ? (
            <>
              <b>{n}</b> {n === 1 || label === 'Ore' ? label : `${label}s`}
            </>
          ) : (
            label
          )}
        </li>
      ))}
    </ul>
  )
}

/** The map's description and size, under its preview in the lobbies. */
export function MapBlurb({ map }: { map: MapDef }) {
  const size = mapSize(map)
  return (
    <p className="ew-mapblurb">
      {map.blurb} <span className="ew-small">{size.cls} map, {size.dims}.</span>
    </p>
  )
}

/** The foot of a lobby, always in view: what the battle is waiting for (or that it's ready), and
 * the button that starts it (or says we're ready). */
export function LaunchBar({ ok, note, summary, children }: { ok: boolean; note: string; summary?: string; children: ReactNode }) {
  return (
    <Frame className="ew-launchbar">
      <div className={`ew-launch-note ${ok ? 'is-ok' : 'is-wait'}`} role="status">
        <i className="ew-launch-dot" />
        <span>
          <span className="ew-launch-text">{note}</span>
          {summary && <small className="ew-muted">{summary}</small>}
        </span>
      </div>
      <div className="ew-launch-acts">{children}</div>
    </Frame>
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
        {field('Players', <Seg<Players> label="Players" value={rules.players} options={PLAYER_COUNTS.map((n): [Players, string] => [n, String(n)])} onChange={(v) => onChange({ players: v })} />)}
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

// Dev builds only, until ground units can fight: the Space / Ground switch in the skirmish setup and
// the ground battle behind it (its setup, the battle, and the map viewer). The condition is false in
// a production build, so the ground chunk is never emitted.
const GroundBattle = import.meta.env.DEV ? lazy(() => import('./ground/Battle.tsx')) : null

export function Lobby({ sound, onBack, onLaunch }: { sound: EmpiresSound; onBack: () => void; onLaunch: (s: Setup) => void }) {
  const [setup, setSetup] = useState(lastSetup)
  const [mode, setMode] = useState<'space' | 'ground'>('space')
  const factions = FACTION_IDS
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
  if (GroundBattle && mode === 'ground')
    return (
      <Suspense fallback={null}>
        <GroundBattle sound={sound} onBack={() => setMode('space')} />
      </Suspense>
    )
  return (
    <div className="ew-root ew-deck ew-lobby" style={{ backgroundImage: 'url(/games/empires/world/title.webp)' }} onContextMenu={noMenu}>
      <Tips />
      <div className="ew-lobby-body">
        <header className="ew-lobby-head">
          <button onClick={() => (sound.click(), onBack())}>← Main menu</button>
          <h2>Skirmish</h2>
          {GroundBattle && (
            <div className="ew-seg" role="group" aria-label="Battle mode (dev builds only)">
              <button className="is-on" aria-pressed>
                Space
              </button>
              <button onClick={() => (sound.click(), setMode('ground'))} aria-pressed={false} data-tip="Ground battles: dev builds only, a first slice with no combat yet">
                Ground
              </button>
            </div>
          )}
        </header>
        <div className="ew-room">
          <div className="ew-room-col is-main">
            <Frame title="Players" className="ew-lobby-slots" aside={<span className="ew-muted ew-small">{setup.slots.filter((s) => s.kind !== 'closed').length} of {map.spawns.length} spawns</span>}>
              <div className="ew-slottable" role="table" aria-label="Players">
                <div className="ew-slotrow is-head" role="row">
                  <span />
                  <span>Player</span>
                  <span>Faction</span>
                  <span>Side</span>
                  <span>AI level · style</span>
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
                          {factions.map((f) => (
                            <button key={f} className={s.faction === f ? 'is-on' : ''} onClick={() => setSlot(i, { faction: f })} data-tip={FACTIONS[f].long} aria-pressed={s.faction === f}>
                              <img src={FACTIONS[f].emblem} alt="" />
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
                          <AiPicker difficulty={s.difficulty} profile={s.profile} onChange={(patch) => setSlot(i, patch)} />
                        ) : (
                          <span />
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
              {(() => {
                const foe = setup.slots.find((s) => s.kind === 'ai' && s.team === 1)
                return (
                  <p className="ew-muted ew-small">
                    {DIFFICULTY[foe?.difficulty ?? 'easy'].blurb} {PROFILES[foe?.profile ?? 'balanced'].name}: {PROFILES[foe?.profile ?? 'balanced'].blurb}
                  </p>
                )
              })()}
            </Frame>
            <Frame title="Battle settings" className="ew-lobby-settings">
              <div className="ew-setting">
                <h5>Starting credits</h5>
                <label className="ew-range">
                  <input type="range" min={0} max={CREDIT_STEPS.length - 1} step={1} value={step} onChange={(e) => update({ ...setup, credits: CREDIT_STEPS[Number(e.target.value)] })} aria-label="Starting credits" />
                  <b>{setup.credits.toLocaleString('en-US')}</b>
                </label>
              </div>
              <div className="ew-setting">
                <h5>Reinforcements</h5>
                <ReinforceOptions value={setup.reinforce ?? REINFORCE} onChange={(patch) => update({ ...setup, reinforce: cleanReinforce({ ...cleanReinforce(setup.reinforce), ...patch }) })} />
              </div>
              <div className="ew-setting">
                <h5>Defense stations</h5>
                <DefenseOptions value={setup.stations ?? DEFENSE_DEFAULT} onChange={(n) => update({ ...setup, stations: n })} />
              </div>
              <div className="ew-setting">
                <h5>Defense platforms on ore</h5>
                <OreDefenseOptions value={setup.oreDefense === true} onChange={(on) => update({ ...setup, oreDefense: on })} />
              </div>
              {isGen && (
                <div className="ew-setting">
                  <h5>Generated map</h5>
                  <GenControls
                    rules={setup.gen}
                    onChange={setRules}
                    onReroll={() => {
                      sound.click()
                      setRules({ seed: Math.floor(Math.random() * (MAX_SEED + 1)) })
                    }}
                  />
                </div>
              )}
            </Frame>
          </div>
          <div className="ew-room-col is-map">
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
                      Drag on the map to draw the start area for <b>{slotName(setup.slots[act], act)}</b>. Click an area, or a player's number, to switch.
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
              <MapLegend map={map} counts />
              <MapBlurb map={map} />
            </Frame>
          </div>
        </div>
        <LaunchBar
          ok={!!enemies}
          note={enemies ? `You${allies ? ` and ${allies} ${allies === 1 ? 'ally' : 'allies'}` : ''} against ${enemies} ${enemies === 1 ? 'enemy' : 'enemies'}.` : 'Add at least one enemy.'}
          summary={`${map.name} · ${setup.credits.toLocaleString('en-US')} credits`}
        >
          <button className="ew-go" disabled={!enemies} onClick={() => (sound.unlock(), sound.click(), onLaunch(setup))}>
            Launch battle
          </button>
        </LaunchBar>
      </div>
      {picker && (
        <MapPicker
          current={isGen ? GENERATED : map.id}
          generated={generated}
          generatedBlurb={`From your own rules and seed (now: ${generated.name}, seed ${setup.gen.seed}). Change them in Battle settings after picking it.`}
          onPick={(id) => (id === GENERATED ? pickMap(generated, GENERATED) : pickMap(MAP[id] ?? MAPS[0]))}
          onClose={() => setPicker(false)}
        />
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
