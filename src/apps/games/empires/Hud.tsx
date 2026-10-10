import type { ReactNode } from 'react'
import {
  ABILITIES, FACTIONS, LEVEL_UP, MAX_LEVEL, MAX_QUEUE, MAX_RESEARCH, MINE_INCOME, SURVEY_TIME, TECH, UNIT, buildable, isShip, techsFor, unitOf, type FactionId, type HardpointKind,
  type UnitType,
} from './data'
import { HP_COLOR, HP_ICON, HP_NAME } from './icons'
import { spriteUrl } from './render'
import { keyName, useSettings } from './settings'
import { building, cantBuild, cantResearch, cantSite, researchCost, researchLock, shieldFull, shieldMax, techBonus, type OreNode, type Owner, type ResearchItem, type Unit, type World } from './sim'

// The battle HUD, framed like a ship's command deck: a top bar with the faction, credits, fleet,
// shipyard, research and game speed; and along the bottom the tactical map, a details panel for
// whatever is selected (the station's shipyard lives there, so building happens at the station),
// and the selected units with their command grid. Research has its own screen, the tech tree
// (TechTree.tsx); the tiles here only show a ship type's own upgrades.

export type Hud = {
  credits: number
  income: number
  pop: number
  popCap: number
  level: number
  research: ResearchItem[]
  techs: string[]
  queue: { unit: string; left: number; total: number }[]
  time: number
  sel: number[]
  winner: Owner | -1
  beacons: number
  beaconsAll: number
  mines: number
}
/** What a left-click on the battlefield does: select, or carry out a command picked from the grid. */
export type Mode = 'normal' | 'move' | 'attack' | 'patrol' | 'rally'
export type MapFilter = 'all' | 'ships' | 'stations' | 'enemies'
export type Command = Exclude<Mode, 'normal'> | 'stop' | 'hold' | 'ability'

export const fmt = (n: number) => Math.floor(n).toLocaleString('en-US')
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

// Line icons on a 24-unit grid, stroked in the current colour.
const ICONS = {
  credits: 'M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z M12 7.5v9 M9.5 9.5h4a1.75 1.75 0 0 1 0 3.5h-3a1.75 1.75 0 0 0 0 3.5h4',
  fleet: 'M12 3l3 7h-6z M5 10l2.5 5h-5z M19 10l2.5 5h-5z M12 12v9 M5 15v4 M19 15v4',
  ore: 'M12 2.5l6 6.5l-6 13l-6-13z M6 9h12',
  beacon: 'M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M7 7a7 7 0 0 0 0 10 M17 7a7 7 0 0 1 0 10 M4 4a11 11 0 0 0 0 16 M20 4a11 11 0 0 1 0 16',
  yard: 'M3 21h18 M5 21V9l7-5l7 5v12 M9 21v-6h6v6',
  clock: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M12 7v5l3 2',
  pause: 'M8 5v14 M16 5v14',
  play: 'M7 4.5l12 7.5l-12 7.5z',
  gear: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M12 2.5v3 M12 18.5v3 M2.5 12h3 M18.5 12h3 M5.3 5.3l2.1 2.1 M16.6 16.6l2.1 2.1 M5.3 18.7l2.1-2.1 M16.6 7.4l2.1-2.1',
  menu: 'M4 7h16 M4 12h16 M4 17h16',
  move: 'M5 19L19 5 M10 5h9v9',
  attack: 'M12 12m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0 M12 2v5 M12 17v5 M2 12h5 M17 12h5',
  stop: 'M6 6h12v12H6z',
  patrol: 'M4 12a8 8 0 0 1 14-5.3 M20 12a8 8 0 0 1-14 5.3 M18 2.5v4.5h-4.5 M6 21.5V17h4.5',
  hold: 'M12 2.5l7.5 3v5.5c0 4.8-3.2 8.6-7.5 10.5c-4.3-1.9-7.5-5.7-7.5-10.5V5.5z',
  rally: 'M6 21V3 M6 4h11l-2.5 4l2.5 4H6',
  ability: 'M13 2L4.5 13.5H11L10 22l8.5-11.5H12z',
  target: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0 -16 0 M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M12 1v4 M12 19v4 M1 12h4 M19 12h4',
  radar: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M12 12m-4.5 0a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0 M12 12L19 5',
  idle: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M9 9.5h.01 M15 9.5h.01 M8.5 15h7',
  army: 'M4 20l4-9l4 9 M12 20l4-9l4 9 M8 11V4 M16 11V4',
  help: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.6v.6 M12 17h.01',
  sound: 'M4 9.5h4l5-4.5v14l-5-4.5H4z M16.5 8.5a5 5 0 0 1 0 7 M19 6a8.5 8.5 0 0 1 0 12',
  mute: 'M4 9.5h4l5-4.5v14l-5-4.5H4z M16.5 9.5l5 5 M21.5 9.5l-5 5',
  time: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M12 7v5h4',
  tree: 'M3.5 9.5h5v5h-5z M15.5 3.5h5v5h-5z M15.5 15.5h5v5h-5z M8.5 12H12 M12 6v12 M12 6h3.5 M12 18h3.5',
} as const
export type IconName = keyof typeof ICONS

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="ew-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  )
}

/** A panel with a bevelled metal rim and clipped corners. */
export function Frame({ className = '', children, title, aside }: { className?: string; children: ReactNode; title?: string; aside?: ReactNode }) {
  return (
    <section className={`ew-frame ${className}`}>
      <div className="ew-frame-in">
        {title && (
          <header className="ew-frame-head">
            <h4>{title}</h4>
            {aside}
          </header>
        )}
        {children}
      </div>
    </section>
  )
}

export function HpIcon({ kind, size = 14 }: { kind: HardpointKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={HP_ICON[kind]} />
    </svg>
  )
}

export function Bar({ value, max, kind }: { value: number; max: number; kind: 'hull' | 'shield' | 'hp' }) {
  const f = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  return (
    <span className={`ew-bar is-${kind} ${kind === 'hull' && f < 0.3 ? 'is-low' : ''}`}>
      <i style={{ width: `${f * 100}%` }} />
    </span>
  )
}

/** The ship's sprite with its hardpoints marked where they sit, each showing its health. */
export function Schematic({ u, size = 116 }: { u: Unit; size?: number }) {
  const t = u.t
  const w = t.aspect >= 1 ? size : size * t.aspect
  const h = t.aspect >= 1 ? size / t.aspect : size
  return (
    <div className="ew-schem-box" style={{ width: size, height: size }}>
      <div className="ew-schem" style={{ width: w, height: h }}>
        <img src={spriteUrl(t.sprite)} alt="" />
        {t.hardpoints.map((p, i) => {
          const s = u.hps[i]
          return (
            <span
              key={i}
              className={`ew-schem-hp ${s.hp <= 0 ? 'is-dead' : ''}`}
              style={{ left: `${p.x * 10}%`, top: `${p.y * 10}%`, ['--c' as string]: HP_COLOR[p.kind], ['--f' as string]: `${(s.hp / s.max) * 360}deg` }}
              title={`${HP_NAME[p.kind]}: ${s.hp <= 0 ? 'destroyed' : `${fmt(s.hp)} / ${fmt(s.max)}`}`}
            >
              <HpIcon kind={p.kind} size={9} />
            </span>
          )
        })}
      </div>
    </div>
  )
}

/** Hardpoints counted by kind: "5/6" next to a turret icon. */
function HpSummary({ u }: { u: Unit }) {
  const kinds = [...new Set(u.t.hardpoints.map((h) => h.kind))]
  return (
    <div className="ew-hpsum">
      {kinds.map((k) => {
        const all = u.t.hardpoints.map((h, i) => (h.kind === k ? i : -1)).filter((i) => i >= 0)
        const up = all.filter((i) => u.hps[i].hp > 0).length
        return (
          <span key={k} className={`ew-hpchip ${up === 0 ? 'is-dead' : up < all.length ? 'is-hurt' : ''}`} style={{ ['--c' as string]: HP_COLOR[k] }} title={`${HP_NAME[k]}: ${up} of ${all.length} working`}>
            <HpIcon kind={k} size={13} />
            {up} / {all.length}
          </span>
        )
      })}
    </div>
  )
}

function Vitals({ u, squad = [u] }: { u: Unit; squad?: Unit[] }) {
  const t = u.t
  const hull = squad.reduce((s, x) => s + x.hull, 0)
  const max = squad.reduce((s, x) => s + x.hullMax, 0)
  return (
    <div className="ew-bars">
      <span>Hull</span>
      <Bar value={hull} max={max} kind="hull" />
      <small>
        {fmt(hull)} / {fmt(max)}
      </small>
      {t.shield > 0 && (
        <>
          <span>Shield</span>
          <Bar value={u.shield} max={shieldFull(u)} kind="shield" />
          <small title={shieldMax(u) < shieldFull(u) ? 'Shield generators damaged: the shields cannot fully recharge' : undefined}>
            {fmt(u.shield)} / {fmt(shieldFull(u))}
            {shieldMax(u) < shieldFull(u) ? ' ⚠' : ''}
          </small>
        </>
      )}
    </div>
  )
}

// --- Top bar ----------------------------------------------------------------------------------------

export function TopBar({ hud, faction, sector, ui, onPause, onSpeed, onMenu, onSettings, onShipyard, onTechTree }: {
  hud: Hud
  faction: FactionId
  sector: string
  ui: { paused: boolean; speed: number }
  onPause: () => void
  onSpeed: (s: number) => void
  onMenu: () => void
  onSettings: () => void
  onShipyard: () => void
  onTechTree: () => void
}) {
  const q = hud.queue[0]
  const r = hud.research[0]
  const { keys } = useSettings()
  return (
    <div className="ew-top">
      <div className="ew-top-cell ew-top-faction">
        <img src={`/games/empires/world/emblem-${faction}.webp`} alt="" />
        <div>
          <strong>{FACTIONS[faction].name}</strong>
          <small>{sector}</small>
        </div>
      </div>
      <div className="ew-top-cell" title="Credits, and income per minute">
        <span className="ew-gold"><Icon name="credits" size={20} /></span>
        <b className="ew-big">{fmt(hud.credits)}</b>
        <small className="ew-good">+{fmt(hud.income * 60)} / min</small>
      </div>
      <div className={`ew-top-cell ${hud.pop >= hud.popCap ? 'is-full' : ''}`} title="Fleet size / capacity. Capture beacons and upgrade the station for more.">
        <Icon name="fleet" size={20} />
        <b className="ew-big">{hud.pop}</b>
        <small>/ {hud.popCap}</small>
      </div>
      <div className="ew-top-cell ew-hide-narrow" title="Mining platforms, and beacons held">
        <span className="ew-ore"><Icon name="ore" size={17} /></span>
        <b>{hud.mines}</b>
        <span className="ew-beacon"><Icon name="beacon" size={17} /></span>
        <b>{hud.beacons}</b>
        <small>/ {hud.beaconsAll}</small>
      </div>
      <button className={`ew-top-cell ew-yardchip ${q ? 'is-busy' : ''}`} onClick={onShipyard} title="Select the station to build ships (H)">
        <Icon name="yard" size={18} />
        {q ? (
          <>
            <img src={spriteUrl(UNIT[q.unit].sprite)} alt="" />
            <span>{UNIT[q.unit].name}</span>
            <b>{Math.ceil(q.left)}s</b>
            {hud.queue.length > 1 && <small>+{hud.queue.length - 1}</small>}
            <i style={{ width: `${(1 - q.left / q.total) * 100}%` }} />
          </>
        ) : (
          <span>Shipyard idle</span>
        )}
      </button>
      <button className={`ew-top-cell ew-yardchip ew-labchip ${r ? 'is-busy' : ''}`} onClick={onTechTree} title={`Tech tree (${keyName(keys.techTree)})`}>
        <Icon name="tree" size={18} />
        {r ? (
          <>
            <img src={techIconUrl(r.id)} alt="" />
            <span>{researchName(r.id, hud.level)}</span>
            <b>{Math.ceil(r.left)}s</b>
            {hud.research.length > 1 && <small>+{hud.research.length - 1}</small>}
            <i style={{ width: `${(1 - r.left / r.total) * 100}%` }} />
          </>
        ) : (
          <span>Research idle</span>
        )}
      </button>
      <div className="ew-top-right">
        <div className="ew-top-cell ew-clock">
          <b>{clock(hud.time)}</b>
        </div>
        <div className="ew-top-cell ew-speed" role="group" aria-label="Game speed">
          {[1, 2, 3].map((s) => (
            <button key={s} className={ui.speed === s ? 'is-on' : ''} onClick={() => onSpeed(s)}>
              {s}x
            </button>
          ))}
        </div>
        <button className="ew-top-cell ew-top-btn" onClick={onPause} title="Pause (P)" aria-label="Pause">
          <Icon name={ui.paused ? 'play' : 'pause'} size={18} />
        </button>
        <button className="ew-top-cell ew-top-btn" onClick={onSettings} title="Sound and controls" aria-label="Settings">
          <Icon name="gear" size={18} />
        </button>
        <button className="ew-top-cell ew-top-btn" onClick={onMenu} title="Menu" aria-label="Menu">
          <Icon name="menu" size={18} />
        </button>
      </div>
    </div>
  )
}

// --- Tactical map -----------------------------------------------------------------------------------

export function TacticalMap({ canvas, sides, filter, onFilter, onStation, onAlert, onIdle, onArmy, onPointer }: {
  canvas: React.RefObject<HTMLCanvasElement | null>
  /** Who's fighting whom: "1 v 1", "2 v 2". */
  sides: string
  filter: MapFilter
  onFilter: (f: MapFilter) => void
  onStation: () => void
  onAlert: () => void
  onIdle: () => void
  onArmy: () => void
  onPointer: (e: React.PointerEvent) => void
}) {
  const filters: [MapFilter, string][] = [
    ['all', 'All'],
    ['ships', 'Ships'],
    ['stations', 'Stations'],
    ['enemies', 'Enemies'],
  ]
  return (
    <Frame className="ew-mapframe" title="Tactical map" aside={<span className="ew-muted ew-small">{sides}</span>}>
      <div className="ew-mapbody">
        <div className="ew-maptools">
          <button onClick={onStation} title="Select the station (H)" aria-label="Station"><Icon name="target" size={17} /></button>
          <button onClick={onAlert} title="Jump to the last alert (Space)" aria-label="Last alert"><Icon name="radar" size={17} /></button>
          <button onClick={onIdle} title="Select idle ships (I)" aria-label="Idle ships"><Icon name="idle" size={17} /></button>
          <button onClick={onArmy} title="Select every warship (Ctrl+A)" aria-label="All ships"><Icon name="army" size={17} /></button>
        </div>
        <canvas ref={canvas} className="ew-mini" onPointerDown={onPointer} onPointerMove={(e) => e.buttons === 1 && onPointer(e)} />
      </div>
      <div className="ew-mapfilters" role="tablist" aria-label="Show on the map">
        {filters.map(([f, label]) => (
          <button key={f} role="tab" aria-selected={filter === f} className={`is-${f} ${filter === f ? 'is-on' : ''}`} onClick={() => onFilter(f)}>
            {f !== 'all' && <i />}
            {label}
          </button>
        ))}
      </div>
    </Frame>
  )
}

// --- Details panel ----------------------------------------------------------------------------------

type DetailProps = {
  w: World
  me: Owner
  sel: Unit[]
  hud: Hud
  faction: FactionId
  onOnly: (typeId: string, drop: boolean) => void
  onBuild: (id: string, times: number) => void
  onUnqueue: (id: string) => void
  onCancel: (index: number) => void
  onResearch: (id: string) => void
  onTechTree: () => void
  onSite: (node: number, tier: 'mine' | 'defense') => void
  onStation: () => void
  /** The ore asteroid clicked on, if no ships are selected. */
  node: OreNode | null
}

export function DetailPanel(p: DetailProps) {
  const { sel, me } = p
  if (!sel.length && p.node) return <OreDetail {...p} n={p.node} />
  if (!sel.length)
    return (
      <Frame className="ew-detail is-empty">
        <div className="ew-empty">
          <p>
            <strong>No selection.</strong> Drag across your ships to command them.
          </p>
          <p className="ew-muted">
            Select your <button className="ew-link" onClick={p.onStation}>station</button> (H) to build ships, or open the <button className="ew-link" onClick={p.onTechTree}>tech tree</button> for upgrades. Park ships at glowing ore to survey it, then click it to build.
          </p>
        </div>
      </Frame>
    )
  const station = sel.find((u) => u.owner === me && u.t.tier === 'station')
  if (station) return <StationDetail {...p} st={station} />
  const first = sel[0]
  if (sel.every((u) => u.t.id === first.t.id)) return <UnitDetail {...p} u={first} squad={sel} />
  return <GroupDetail {...p} />
}

function Pips({ level }: { level: number }) {
  return (
    <span className="ew-pips" title={`Station level ${level} of ${MAX_LEVEL}`}>
      {Array.from({ length: MAX_LEVEL }, (_, i) => (
        <i key={i} className={i < level ? 'is-on' : ''} />
      ))}
    </span>
  )
}

function Slots({ label, size, items, onCancel }: { label: string; size: number; items: { icon: React.ReactNode; name: string; left: number; total: number }[]; onCancel: (i: number) => void }) {
  return (
    <div className="ew-slots" aria-label={label}>
      <span className="ew-slots-label">{label}</span>
      {Array.from({ length: size }, (_, i) => {
        const q = items[i]
        if (!q) return <span key={i} className="ew-slot is-empty" />
        return (
          <button key={i} className="ew-slot" onClick={() => onCancel(i)} title={`${q.name}${i === 0 ? `: ${Math.ceil(q.left)} s left` : ''}. Click to cancel and refund.`}>
            {q.icon}
            {i === 0 && (
              <>
                <i style={{ height: `${(1 - q.left / q.total) * 100}%` }} />
                <em>{Math.ceil(q.left)}</em>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}

export const researchName = (id: string, level: number) => (id === LEVEL_UP ? `Station level ${level + 1}` : TECH[id].name)

/** The generated icon for a piece of research; every station level shares one. */
export const techIconUrl = (id: string) => `/games/empires/tech/${id === LEVEL_UP ? 'level' : id}.webp`

/** What reaching a station level brings, for its tile in the tech tree. */
export function levelBlurb(faction: FactionId, level: number) {
  const unlocks = buildable(faction).filter((u) => u.level === level)
  return `More hull and firepower for the station, +4 fleet capacity${unlocks.length ? `, unlocks the ${unlocks.map((u) => u.name).join(', ')}` : ''}.`
}

export type TechStatus = 'done' | 'busy' | 'queued' | 'ready' | 'poor' | 'locked'
/**
 * Where one piece of research stands: done, under way (first in the queue), waiting in the queue,
 * ready to buy, held back by credits or a full queue ('poor'), or locked by the station level or
 * a prerequisite. `why` says what's in the way; `slot` is its place in the queue.
 */
export function techState(w: World, me: Owner, hud: Hud, id: string): { status: TechStatus; why: string | null; slot: number; progress: number; left: number } {
  const slot = hud.research.findIndex((r) => r.id === id)
  const r = hud.research[slot]
  const done = id === LEVEL_UP ? hud.level >= MAX_LEVEL : hud.techs.includes(id)
  const lock = researchLock(w.players[me], id)
  const why = cantResearch(w, me, id)
  const status: TechStatus = done ? 'done' : slot === 0 ? 'busy' : slot > 0 ? 'queued' : lock || why === 'No station' ? 'locked' : why ? 'poor' : 'ready'
  return { status, why: lock ?? why, slot, progress: r ? 1 - r.left / r.total : 0, left: r ? r.left : 0 }
}

/** A research icon in a ring that fills as the research runs. */
export function TechIcon({ id, size = 40, progress = 0, status }: { id: string; size?: number; progress?: number; status?: TechStatus }) {
  return (
    <span className={`ew-techicon ${status ? `is-${status}` : ''}`} style={{ width: size, height: size, ['--p' as string]: `${progress * 360}deg` }}>
      <img src={techIconUrl(id)} alt="" />
    </span>
  )
}

/** One piece of research as a compact tile: icon, name and where it stands. Click to research. */
function TechTile({ id, w, me, hud, onResearch }: { id: string; w: World; me: Owner; hud: Hud; onResearch: (id: string) => void }) {
  const s = techState(w, me, hud, id)
  const cost = researchCost(w.players[me], id)
  const blurb = id === LEVEL_UP ? levelBlurb(w.players[me].faction, hud.level + 1) : TECH[id].blurb
  const line =
    s.status === 'done' ? '✓ Researched'
      : s.status === 'busy' ? `${Math.ceil(s.left)}s left`
        : s.status === 'queued' ? `Queued, #${s.slot + 1}`
          : s.status === 'locked' && id !== LEVEL_UP && TECH[id].level > hud.level ? `Station Lv${TECH[id].level}`
            : s.status === 'locked' ? 'Locked'
              : cost ? `${cost.cost} · ${cost.time}s` : ''
  return (
    <button
      className={`ew-tech is-${s.status}`}
      onClick={() => onResearch(id)}
      disabled={s.status === 'done'}
      title={`${researchName(id, hud.level)}\n${blurb}${s.why && s.status !== 'done' && s.status !== 'busy' && s.status !== 'queued' ? `\n\n${s.why}` : ''}`}
    >
      <TechIcon id={id} size={30} progress={s.progress} status={s.status} />
      <strong>{researchName(id, hud.level)}</strong>
      <span>{line}</span>
    </button>
  )
}

/** Opens the tech tree, showing what's being researched and how far along it is. */
function TechTreeButton({ hud, onOpen }: { hud: Hud; onOpen: () => void }) {
  const r = hud.research[0]
  const { keys } = useSettings()
  return (
    <button className={`ew-treebtn ${r ? 'is-busy' : ''}`} onClick={onOpen} title={`Open the tech tree to research upgrades (${keyName(keys.techTree)})`}>
      {r ? <TechIcon id={r.id} size={30} progress={1 - r.left / r.total} status="busy" /> : <Icon name="tree" size={22} />}
      <span>
        <strong>Tech tree</strong>
        <small>{r ? `${researchName(r.id, hud.level)}, ${Math.ceil(r.left)}s` : 'Nothing researching'}</small>
      </span>
      <b>{hud.research.length}/{MAX_RESEARCH}</b>
      <kbd>{keyName(keys.techTree)}</kbd>
      {r && <i style={{ width: `${(1 - r.left / r.total) * 100}%` }} />}
    </button>
  )
}

function StationDetail(p: DetailProps & { st: Unit }) {
  const { w, me, st, hud, faction } = p
  const ships = buildable(faction)
  const queued = (id: string) => hud.queue.filter((q) => q.unit === id).length
  return (
    <Frame className="ew-detail is-station">
      <div className="ew-detail-side">
        <Schematic u={st} size={96} />
        <div className="ew-side-info">
          <strong>{st.t.name}</strong>
          <small className="ew-muted">Production station</small>
          <Pips level={hud.level} />
        </div>
        <Vitals u={st} />
        <HpSummary u={st} />
      </div>
      <div className="ew-detail-main">
        <header className="ew-yardhead">
          <h5 className="ew-yardtitle">Shipyard</h5>
          <TechTreeButton hud={hud} onOpen={p.onTechTree} />
        </header>
        <Slots label={`Build queue ${hud.queue.length}/${MAX_QUEUE}`} size={MAX_QUEUE} onCancel={p.onCancel}
          items={hud.queue.map((q) => ({ icon: <img src={spriteUrl(UNIT[q.unit].sprite)} alt="" />, name: UNIT[q.unit].name, left: q.left, total: q.total }))}
        />
        <div className="ew-yard">
          {ships.map((t) => (
            <ShipCard key={t.id} t={t} why={cantBuild(w, me, t.id)} level={hud.level} queued={queued(t.id)} onBuild={p.onBuild} onUnqueue={p.onUnqueue} />
          ))}
        </div>
      </div>
    </Frame>
  )
}

/** An ore asteroid: who has surveyed it, and what we can build on it. */
function OreDetail(p: DetailProps & { n: OreNode }) {
  const { w, me, n, faction } = p
  const mine = unitOf(faction, 'mine')
  const defense = unitOf(faction, 'defense')
  const site = n.site ? w.byId.get(n.site) : undefined
  const ours = n.owner === me
  const theirs = n.owner !== -1 && n.owner !== me
  const toward = n.progress === 0 ? -1 : n.progress < 0 ? 0 : 1
  const pct = Math.round(Math.abs(n.progress) * 100)
  const ore = MINE_INCOME * (1 + (techBonus(w.players[me], unitOf(faction, 'station').id).mines ?? 0))
  const status = site
    ? `${site.owner === me ? 'Our' : 'Enemy'} ${site.t.name.toLowerCase()}${building(site) ? ' (under construction)' : ''}`
    : ours
      ? 'Surveyed by us: ready to build on.'
      : theirs
        ? `Surveyed by the enemy. Keep ships here to take it over${toward === me ? ` (${100 - pct}% to neutral)` : ''}.`
        : pct > 0
          ? `Survey under way: ${pct}%${toward === me ? '' : ' (enemy)'}.`
          : `Unsurveyed. Keep ships within the ring for ${SURVEY_TIME} s, with no enemies there, to claim it.`
  const option = (t: UnitType, tier: 'mine' | 'defense', text: string) => {
    const why = cantSite(w, me, n.id, tier)
    return (
      <button className={`ew-shipcard ew-sitecard ${why ? 'is-off' : ''}`} onClick={() => p.onSite(n.id, tier)} title={`${t.name}\n${t.blurb}${why ? `\n\n${why}` : ''}`}>
        <img src={spriteUrl(t.sprite)} alt="" />
        <strong>{t.name}</strong>
        <span className="ew-cost"><Icon name="credits" size={12} /> {t.cost} <Icon name="time" size={12} /> {t.build}s</span>
        <small className="ew-muted">{text}</small>
      </button>
    )
  }
  return (
    <Frame className="ew-detail is-ore">
      <div className="ew-detail-side">
        <img className="ew-portrait" src="/games/empires/world/asteroid-ore.webp" alt="" />
      </div>
      <div className="ew-detail-main">
        <header className="ew-unithead">
          <strong>Ore asteroid</strong>
          <span className={`ew-tag ${theirs ? 'is-enemy' : ''}`}>{ours ? 'ours' : theirs ? 'enemy' : 'unclaimed'}</span>
        </header>
        <span className="ew-muted">{status}</span>
        {!site && pct > 0 && pct < 100 && <Bar value={pct} max={100} kind="shield" />}
        {!site && (
          <div className="ew-siteopts">
            {option(mine, 'mine', `+${fmt(ore * 60)} credits a minute`)}
            {option(defense, 'defense', 'Guards this spot and the space around it')}
          </div>
        )}
      </div>
    </Frame>
  )
}

function ShipCard({ t, why, level, queued, onBuild, onUnqueue }: {
  t: UnitType; why: string | null; level: number; queued: number; onBuild: (id: string, times: number) => void; onUnqueue: (id: string) => void
}) {
  const locked = t.level > level
  return (
    <button
      className={`ew-shipcard ${locked ? 'is-locked' : why ? 'is-off' : ''}`}
      onClick={(e) => onBuild(t.id, e.shiftKey ? 5 : 1)}
      onContextMenu={(e) => {
        e.preventDefault()
        onUnqueue(t.id)
      }}
      title={`${t.name}${t.squad > 1 ? ` (squadron of ${t.squad})` : ''}\n${t.blurb}\nFleet size ${t.pop}. Click to build, Shift-click for five, right-click to remove one.${why ? `\n\n${why}` : ''}`}
    >
      <img src={spriteUrl(t.sprite)} alt="" />
      <strong>{t.name}</strong>
      <span className="ew-cost"><Icon name="credits" size={12} /> {t.cost}</span>
      <span className="ew-time"><Icon name="time" size={12} /> {t.build}s</span>
      {locked && <span className="ew-lock">Station Lv{t.level}</span>}
      {queued > 0 && <span className="ew-qbadge">{queued}</span>}
    </button>
  )
}

function orderText(w: World, u: Unit) {
  if (building(u)) return `Under construction: ${Math.ceil(u.building)} s`
  const o = u.order
  if (o.k === 'move') return o.attack ? 'Attack-moving' : 'Moving'
  if (o.k === 'patrol') return 'Patrolling'
  if (o.k === 'attack') {
    const t = w.byId.get(o.id)
    return t ? `Attacking ${t.t.name}${o.hp >= 0 ? `: ${HP_NAME[t.t.hardpoints[o.hp].kind].toLowerCase()}` : ''}` : 'Attacking'
  }
  const t = u.target ? w.byId.get(u.target) : undefined
  if (t) return `Engaging ${t.t.name}`
  return u.hold ? 'Holding position' : 'Idle'
}

function UnitDetail(p: DetailProps & { u: Unit; squad: Unit[] }) {
  const { u, squad, me, w } = p
  const t = u.t
  const mine = u.owner === me
  const ally = !mine && w.players[u.owner].team === w.players[me].team
  return (
    <Frame className={`ew-detail is-unit ${mine ? '' : ally ? 'is-ally' : 'is-enemy'}`}>
      <div className="ew-detail-side">
        {u.hps.length ? <Schematic u={u} size={104} /> : <img className="ew-portrait" src={spriteUrl(t.sprite)} alt="" />}
      </div>
      <div className="ew-detail-main">
        <header className="ew-unithead">
          <strong>
            {t.name}
            {squad.length > 1 ? ` ×${squad.length}` : ''}
          </strong>
          <span className={`ew-tag ${mine ? '' : ally ? 'is-ally' : 'is-enemy'}`}>{mine ? t.tier : `${ally ? 'allied' : 'enemy'} ${t.tier}`}</span>
          {mine && <span className="ew-muted ew-small ew-orders">{orderText(w, u)}{u.kills > 0 ? ` · ${u.kills} kills` : ''}</span>}
        </header>
        <span className="ew-muted ew-small">{t.blurb}</span>
        <Vitals u={u} squad={squad} />
        {u.hps.length > 0 && <HpSummary u={u} />}
        {mine && techsFor(t.id).length > 0 && (
          <div className="ew-unittech">
            <span className="ew-muted ew-small">Upgrades</span>
            {techsFor(t.id).map((x) => (
              <TechTile key={x.id} id={x.id} w={w} me={me} hud={p.hud} onResearch={p.onResearch} />
            ))}
            <button className="ew-unittree" onClick={p.onTechTree} title="Open the tech tree">
              <Icon name="tree" size={15} />
              Tech tree
            </button>
          </div>
        )}
        {!mine && !ally && u.hps.length > 0 && <span className="ew-muted ew-small">Select your ships, hover this one and right-click a marker to target that hardpoint.</span>}
      </div>
    </Frame>
  )
}

/** Several kinds of ship: a row per type. */
function GroupDetail(p: DetailProps) {
  const { sel } = p
  const types = new Map<string, Unit[]>()
  for (const u of sel) types.set(u.t.id, [...(types.get(u.t.id) ?? []), u])
  return (
    <Frame className="ew-detail is-group">
      <div className="ew-detail-main">
        <header className="ew-unithead">
          <strong>Fleet</strong>
          <span className="ew-muted ew-small">Click a type to keep only those, Shift-click to drop them.</span>
        </header>
        <div className="ew-fleet">
          {[...types.values()].map((us) => {
            const t = us[0].t
            const hull = us.reduce((s, u) => s + u.hull, 0) / us.reduce((s, u) => s + u.hullMax, 0)
            return (
              <button key={t.id} className="ew-fleetrow" onClick={(e) => p.onOnly(t.id, e.shiftKey)} title={t.blurb}>
                <img src={spriteUrl(t.sprite)} alt="" />
                <strong>{t.name}</strong>
                <b>×{us.length}</b>
                <Bar value={hull} max={1} kind="hull" />
              </button>
            )
          })}
        </div>
      </div>
    </Frame>
  )
}

// --- Selected units and commands ----------------------------------------------------------------------

const COMMANDS: { id: Command; label: string; icon: IconName; key: string }[] = [
  { id: 'move', label: 'Move', icon: 'move', key: 'M' },
  { id: 'attack', label: 'Attack move', icon: 'attack', key: 'R' },
  { id: 'stop', label: 'Stop', icon: 'stop', key: 'X' },
  { id: 'patrol', label: 'Patrol', icon: 'patrol', key: 'T' },
  { id: 'hold', label: 'Hold position', icon: 'hold', key: 'G' },
  { id: 'rally', label: 'Rally point', icon: 'rally', key: 'Y' },
]

export function SelectionPanel({ sel, me, mode, onCommand, onPick }: {
  sel: Unit[]
  me: Owner
  mode: Mode
  onCommand: (c: Command) => void
  onPick: (id: number, shift: boolean) => void
}) {
  const mine = sel.filter((u) => u.owner === me)
  const ships = mine.filter((u) => isShip(u.t))
  const station = mine.some((u) => u.t.tier === 'station')
  // One tile per ship, or per fighter squadron.
  const tiles: Unit[][] = []
  const bySquad = new Map<number, Unit[]>()
  for (const u of sel) {
    if (u.squad) {
      const g = bySquad.get(u.squad)
      if (g) g.push(u)
      else {
        const ng = [u]
        bySquad.set(u.squad, ng)
        tiles.push(ng)
      }
    } else tiles.push([u])
  }
  const shown = tiles.slice(0, 10)
  const withAb = ships.filter((u) => u.t.ability)
  const ready = withAb.filter((u) => u.abilityCd <= 0)
  const ab = withAb[0]?.t.ability ? ABILITIES[withAb[0].t.ability] : null
  const holding = ships.length > 0 && ships.every((u) => u.hold)
  const enabled = (c: Command) => (c === 'rally' ? station : ships.length > 0)
  return (
    <Frame className="ew-selframe" title="Selected units" aside={<b className="ew-selcount">{sel.length || ''}</b>}>
      <div className="ew-seltiles">
        {shown.map((g) => {
          const u = g[0]
          const hull = g.reduce((s, x) => s + x.hull, 0) / g.reduce((s, x) => s + x.hullMax, 0)
          return (
            <button key={u.id} className={`ew-seltile ${u.owner === me ? '' : 'is-enemy'}`} onClick={(e) => onPick(u.id, e.shiftKey)} title={`${u.t.name}${g.length > 1 ? ` ×${g.length}` : ''}: click to select only this, Shift-click to drop it`}>
              <img src={spriteUrl(u.t.sprite)} alt="" />
              {g.length > 1 && <em>{g.length}</em>}
              <Bar value={hull} max={1} kind="hull" />
            </button>
          )
        })}
        {tiles.length > shown.length && <span className="ew-selmore">+{tiles.length - shown.length}</span>}
        {!sel.length && <span className="ew-muted ew-small">Nothing selected</span>}
      </div>
      <div className="ew-cmdgrid">
        {COMMANDS.map((c) => (
          <button
            key={c.id}
            className={`ew-cmdbtn ${mode === c.id || (c.id === 'hold' && holding) ? 'is-on' : ''}`}
            disabled={!enabled(c.id)}
            onClick={() => onCommand(c.id)}
            title={`${c.label} (${c.key})`}
          >
            <Icon name={c.icon} size={20} />
            <span>{c.label}</span>
            <kbd>{c.key}</kbd>
          </button>
        ))}
        {ab && (
          <button className="ew-cmdbtn ew-abilitybtn" disabled={!ready.length} onClick={() => onCommand('ability')} title={`${ab.blurb} (Q)`}>
            <Icon name="ability" size={18} />
            <span>
              {withAb.length > 1 && new Set(withAb.map((u) => u.t.ability)).size > 1 ? 'Abilities' : ab.name}
              {ready.length ? ` (${ready.length}/${withAb.length})` : ` · ${Math.ceil(Math.min(...withAb.map((u) => u.abilityCd)))}s`}
            </span>
            <kbd>Q</kbd>
          </button>
        )}
      </div>
    </Frame>
  )
}
