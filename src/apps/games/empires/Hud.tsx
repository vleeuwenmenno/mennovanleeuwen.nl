import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { battleLayout, type LayoutStore } from './layout'
import { clampToViewport, placeTip, screenArea, topBarInset, useKeepInside, type Box } from './fit'
import {
  ENGINEERS, MODULE, REBUILD_MODULE, RUSH_TECH, WORKS_NAME, modulesFor, needsModule, stationType, worksOf, yardOf, yardType, yardsFor, type ModuleId,
  abilityOf, siteUpgradeOf, stageName, DEFENSE_WING, FACTIONS, LEVEL_UP, REBUILD, baseBuilds, builtAt, isEngineer, wingOf, SITE_UPGRADES, type SiteUpgradeId, YIELD_PER_LEVEL, roleOf, siteOptions, MAX_LEVEL, MAX_QUEUE, MAX_RESEARCH, MINE_INCOME, SURVEY_TIME, TECH, UNIT, buildable, isShip, techsFor, unitOf, type FactionId, type HardpointKind,
  type UnitType,
} from './data'
import { HP_COLOR, HP_ICON, hpName } from './icons'
import { traits } from './codexInfo'
import { modelFor, typeOfSprite } from './models/index.ts'
import { moduleThumbnail, thumbnail } from './models/paint.ts'
import { keyName, modName, useSettings, type Action } from './settings'
import { freeGroup, type GroupInfo } from './groups'
import { CANCEL_TIP, LongPress, isTouch, shiftOf, useCancelPress, useCoarse, useLongPressWheel } from './Touch'
import { FIELD_DAMAGE, cantReinforce, shipPrice, yardOffer, cantExpand, expUp, moduleLock, moduleRebuildCost, cantConstruct, cantRush, rushRules, rushShare, siteRefund, dpsVs, cantUpgradeSite, mineOutput, siteUpgradeNext, REFUND_DELAY, REPAIR_TIME, RETREAT_REFUND, canRetreat, cantRepair, repairCost, retreatRefund, RANKS, RANK_BONUS, SHIELD_REBOOT, STANCES, building, cantBuild, fromHangar, cantResearch, cantSite, escorts, escortsOf, mendTarget, wingState, researchCost, researchLock, shieldFull, shieldMax, techBonus, type EarnSource, type LedgerEntry, type OreNode, type Owner, type SpendKind, type ResearchItem, type Stance, type Unit, type World } from './sim'

// The battle HUD, framed like a ship's command deck: a top bar with the faction, credits, fleet,
// shipyard, research and game speed; and along the bottom the tactical map, a details panel for
// whatever is selected (the station's shipyard lives there, so building happens at the station),
// and the selected units with their command grid. Research has its own screen, the tech tree
// (TechTree.tsx); the tiles here only show a ship type's own upgrades.

export type Hud = {
  /** Control groups that still hold anything: their key, size, and the picture of the main unit. */
  groups: GroupInfo[]
  /** Our warships with nothing to do. */
  idle: number
  credits: number
  income: number
  pop: number
  popCap: number
  /** Our faction, and our station's level. */
  faction: FactionId
  level: number
  research: ResearchItem[]
  techs: string[]
  queue: { unit: string; left: number; total: number; reserve?: boolean }[]
  /** Ships waiting in the fleet reserve, by type id. */
  reserve: string[]
  time: number
  sel: number[]
  winner: Owner | -1
  beacons: number
  beaconsAll: number
  mines: number
  /** Hybrid bases (sim.ts World.hybrid): the station is a Command Station with yards round it. */
  hybrid: boolean
  /** Our yards: built ones with their queue, and sites with how far along they are (0 to 1). */
  yards: { id: number; unit: string; queue: QueueItem[]; built: boolean; progress: number }[]
}
/** What a left-click on the battlefield does: select, or carry out a command picked from the grid
 * ('place': put down the yard being placed). */
export type Mode = 'normal' | 'move' | 'attack' | 'patrol' | 'rally' | 'guard' | 'place'
export type MapFilter = 'all' | 'ships' | 'stations' | 'enemies'
export type Command = Exclude<Mode, 'normal' | 'place'> | 'stop' | 'hold' | 'ability' | 'retreat'

export const fmt = (n: number) => Math.floor(n).toLocaleString('en-US')
/** Green, amber or red for a round trip in milliseconds. */
export const pingClass = (ms: number) => (ms < 90 ? 'is-good' : ms < 180 ? 'is-fair' : 'is-poor')
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
  back: 'M15 5l-7 7l7 7',
  play: 'M7 4.5l12 7.5l-12 7.5z',
  gear: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M12 2.5v3 M12 18.5v3 M2.5 12h3 M18.5 12h3 M5.3 5.3l2.1 2.1 M16.6 16.6l2.1 2.1 M5.3 18.7l2.1-2.1 M16.6 7.4l2.1-2.1',
  menu: 'M4 7h16 M4 12h16 M4 17h16',
  move: 'M5 19L19 5 M10 5h9v9',
  attack: 'M12 12m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0 M12 2v5 M12 17v5 M2 12h5 M17 12h5',
  stop: 'M6 6h12v12H6z',
  patrol: 'M4 12a8 8 0 0 1 14-5.3 M20 12a8 8 0 0 1-14 5.3 M18 2.5v4.5h-4.5 M6 21.5V17h4.5',
  hold: 'M12 2.5l7.5 3v5.5c0 4.8-3.2 8.6-7.5 10.5c-4.3-1.9-7.5-5.7-7.5-10.5V5.5z',
  dice: 'M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z M8.5 8.5h.01 M15.5 8.5h.01 M12 12h.01 M8.5 15.5h.01 M15.5 15.5h.01',
  roam: 'M12 12L5 5 M12 12l7-7 M12 12l-7 7 M12 12l7 7 M5 9.5V5h4.5 M19 9.5V5h-4.5 M5 14.5V19h4.5 M19 14.5V19h-4.5',
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
  keys: 'M2.5 6.5h19v11h-19z M6 10h.01 M9.5 10h.01 M13 10h.01 M16.5 10h.01 M7.5 14h9',
  restart: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3 M4.5 3.5v4h4',
  exit: 'M14 4.5h5.5v15H14 M10.5 8l-4 4l4 4 M6.5 12H16',
  speed: 'M4 6l7 6l-7 6z M12 6l7 6l-7 6z',
  // A grid with one corner cell shaded off: the fog grid.
  grid: 'M3.5 3.5h17v17h-17z M3.5 9.17h17 M3.5 14.83h17 M9.17 3.5v17 M14.83 3.5v17 M14.83 14.83l5.67 5.67 M17.6 14.83l2.9 2.9',
  // An open book: the Codex.
  codex: 'M12 6.5C10 5 7 4.5 4 5v13.5c3-.5 6 0 8 1.5c2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5z M12 6.5V20',
  // A slipway: two rails, a gantry across them and a hull taking shape between.
  slip: 'M5 3v18 M19 3v18 M5 8h14 M9.5 21v-7l2.5-4l2.5 4v7',
  // Hyperspace: streaks closing in on a point.
  jump: 'M12 12m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0 M2 12h5 M17 12h5 M4.5 5.5l3.5 3 M19.5 18.5l-3.5-3 M4.5 18.5l3.5-3 M19.5 5.5l-3.5 3',
  // Credits handed across: a coin and an arrow on its way.
  give: 'M7.5 12m-4.5 0a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0 M7.5 9.5v5 M14 12h7.5 M18.5 9l3 3l-3 3',
} as const
export type IconName = keyof typeof ICONS

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="ew-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  )
}

/**
 * The selection on a touch screen, kept small (Touch.tsx useTapAway): one button with an icon (or a
 * picture), a short label and a count that opens its panel, and a ✕ beside it that lets go of the
 * selection. The same in a battle and on the galaxy map.
 */
export function SelChip({ icon, label, count, title, className = '', onOpen, onClear }: {
  icon: IconName | ReactNode
  label?: string
  count?: number | string
  /** What it is, for screen readers and the tooltip. */
  title: string
  className?: string
  onOpen: () => void
  onClear: () => void
}) {
  return (
    <span className={`ew-selchip ${className}`}>
      <button className="ew-selchip-main" onClick={onOpen} aria-label={`${title}${count !== undefined ? `: ${count}` : ''}. Open`} title={title}>
        {typeof icon === 'string' ? <Icon name={icon as IconName} size={22} /> : icon}
        {label && <span className="ew-selchip-label">{label}</span>}
        {count !== undefined && <b>{count}</b>}
      </button>
      <button className="ew-selchip-x" onClick={onClear} aria-label="Deselect" title="Deselect">
        ✕
      </button>
    </span>
  )
}

/** A panel with a bevelled metal rim and clipped corners. */
/**
 * The game's own tooltips, in place of the browser's: anything inside this screen with a
 * `data-tip` shows it in a game panel after a moment, above it (or below when there's no room),
 * kept inside the screen with a margin (fit.ts). The text is read again while it shows, so countdowns and prices stay
 * current. The element is found by where the pointer is, so hints on disabled buttons show too.
 * Put one inside each screen's root.
 */
export function Tips({ live }: { live?: (id: number) => Unit | undefined } = {}) {
  const anchor = useRef<HTMLSpanElement>(null)
  const box = useRef<HTMLDivElement>(null)
  // `at`: the element's box on the page, which the tip goes above or below.
  const [tip, setTip] = useState<{ text: string; unit?: string; big?: boolean; uid?: number; who?: string; rel?: string; at: Box } | null>(null)
  useEffect(() => {
    const root = anchor.current?.parentElement
    if (!root) return
    let cur: Element | null = null
    let timer = 0
    let live = 0
    const hide = () => {
      cur = null
      clearTimeout(timer)
      clearInterval(live)
      setTip(null)
    }
    const place = () => {
      const text = cur?.isConnected ? cur.getAttribute('data-tip') : null
      const unit = cur?.isConnected ? cur.getAttribute('data-tip-unit') : null
      if (!cur || (!text && !unit)) return hide()
      const r = cur.getBoundingClientRect()
      setTip({
        text: text ?? '', unit: unit ?? undefined, uid: Number(cur.getAttribute('data-tip-uid')) || undefined, who: cur.getAttribute('data-tip-who') ?? undefined, rel: cur.getAttribute('data-tip-rel') ?? undefined,
        at: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      })
    }
    const move = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const under = document.elementFromPoint(e.clientX, e.clientY)
      const t = under && root.contains(under) ? under.closest('[data-tip],[data-tip-unit]') : null
      if (t === cur) return
      hide()
      if (!t) return
      cur = t
      // The unit card is a long hover: it waits a little longer than a plain tip.
      timer = window.setTimeout(() => {
        place()
        live = window.setInterval(place, 250)
      }, t.hasAttribute('data-tip-unit') ? 600 : 380)
    }
    // Fingers have no hover: a long press on anything with a tip shows it until the next touch
    // (things with a long press of their own, like ship cards, keep theirs).
    const press = new LongPress()
    let shown = 0
    const down = (e: PointerEvent) => {
      hide()
      clearTimeout(shown)
      if (!isTouch(e)) return
      const under = document.elementFromPoint(e.clientX, e.clientY)
      const t = under && root.contains(under) ? under.closest('[data-tip],[data-tip-unit],[data-longpress]') : null
      if (!t || t.hasAttribute('data-longpress')) return
      press.start(e, () => {
        cur = t
        place()
        live = window.setInterval(place, 250)
        shown = window.setTimeout(hide, 6000)
      })
    }
    const touchMove = (e: PointerEvent) => void (isTouch(e) && press.move(e))
    const touchUp = () => press.cancel()
    // The tap that ends a long press on a button must not also press it.
    const swallow = (e: MouseEvent) => {
      if (!press.fired) return
      press.fired = false
      e.preventDefault()
      e.stopPropagation()
    }
    root.addEventListener('pointermove', move)
    root.addEventListener('pointermove', touchMove)
    root.addEventListener('pointerup', touchUp)
    root.addEventListener('pointercancel', touchUp)
    root.addEventListener('click', swallow, true)
    root.addEventListener('pointerleave', hide)
    root.addEventListener('pointerdown', down)
    root.addEventListener('wheel', hide, { passive: true })
    return () => {
      hide()
      press.cancel()
      clearTimeout(shown)
      root.removeEventListener('pointermove', move)
      root.removeEventListener('pointermove', touchMove)
      root.removeEventListener('pointerup', touchUp)
      root.removeEventListener('pointercancel', touchUp)
      root.removeEventListener('click', swallow, true)
      root.removeEventListener('pointerleave', hide)
      root.removeEventListener('pointerdown', down)
      root.removeEventListener('wheel', hide)
    }
  }, [])
  useLayoutEffect(() => {
    const b = box.current
    const root = anchor.current?.parentElement
    if (!b || !root || !tip) return
    // Above the element, or below it when that fits better; kept inside the screen (see fit.ts).
    const rr = root.getBoundingClientRect()
    const p = placeTip(tip.at, b.offsetWidth, b.offsetHeight, screenArea(root))
    b.style.left = `${p.x - rr.left + root.scrollLeft}px`
    b.style.top = `${p.y - rr.top + root.scrollTop}px`
    b.style.visibility = 'visible'
  }, [tip])
  return (
    <>
      <span ref={anchor} hidden />
      {tip && (
        <div ref={box} className={`ew-tip ${tip.unit ? 'is-unit' : ''}`} role="tooltip" style={{ visibility: 'hidden' }}>
          {tip.unit && UNIT[tip.unit] ? <UnitIntel t={UNIT[tip.unit]} who={tip.who} rel={tip.rel} note={tip.text || undefined} live={tip.uid ? live?.(tip.uid) : undefined} /> : tip.text}
        </div>
      )}
    </>
  )
}

/** A plain box (a popover, a hint) kept inside the screen with a margin (fit.ts). */
export function KeptInside({ children, ...rest }: React.HTMLAttributes<HTMLDivElement> & { 'data-nodrag'?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useKeepInside(ref)
  return (
    <div ref={ref} {...rest}>
      {children}
    </div>
  )
}

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

/** How many pixels a menu thumbnail of a model is on its long side: sharp on a high-density screen at
 * the size the biggest cards show it. */
const THUMB_PX = 192

/** A unit's picture by its look's name (data.ts `sprite`, or moduleLook for an expansion module),
 * for the menus and tiles that only know that: a still of its model, as a data URL (empty for a
 * name nothing has). */
export function unitArt(sprite: string) {
  const mod = /^(republic|droid)-x-(\w+)$/.exec(sprite)
  if (mod && MODULE[mod[2] as ModuleId]) {
    // A module: on its own, cut from a building that has it.
    const x = MODULE[mod[2] as ModuleId]
    const f = mod[1] as FactionId
    const t = x.on === 'station' ? stationType(f, 4, [], [x.id]) : yardType(yardOf(f, x.on).id, [x.id])
    const m = modelFor(t)
    const hp = t.hardpoints.findIndex((h) => h.exp === x.id)
    return m && hp >= 0 ? moduleThumbnail(m, hp, THUMB_PX) : ''
  }
  const t = typeOfSprite(sprite)
  const m = t ? modelFor(t) : null
  return m ? thumbnail(m, THUMB_PX).url : ''
}

/**
 * A ship or structure as it looks in battle: a still of its model with every module on it (shot-off
 * ones burnt), fitted into whatever box the CSS gives it like an image would be.
 */
export function ShipArt({ t, hps, className = '' }: { t: UnitType; hps?: { hp: number }[]; className?: string }) {
  const W = t.aspect >= 1 ? 100 : 100 * t.aspect
  const H = t.aspect >= 1 ? 100 / t.aspect : 100
  const m = modelFor(t)
  if (!m) return <svg className={`ew-art ${className}`} viewBox={`0 0 ${W} ${H}`} aria-hidden />
  const { url, pad } = thumbnail(m, THUMB_PX, hps?.map((h) => h.hp <= 0))
  // The model's box is the viewBox; the picture's margin hangs over it.
  const k = W / m.w
  return (
    <svg className={`ew-art ${className}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" overflow="visible" aria-hidden>
      <image href={url} x={-pad * k} y={-pad * k} width={(m.w + pad * 2) * k} height={(m.h + pad * 2) * k} />
    </svg>
  )
}

export function Schematic({ u, size = 116, tip }: { u: Unit; size?: number; tip?: Record<string, string> }) {
  const t = u.t
  const w = t.aspect >= 1 ? size : size * t.aspect
  const h = t.aspect >= 1 ? size / t.aspect : size
  return (
    <div className="ew-schem-box" style={{ width: size, height: size }} {...tip}>
      <div className="ew-schem" style={{ width: w, height: h }}>
        <ShipArt t={t} hps={u.hps} />
        {t.hardpoints.map((p, i) => {
          const s = u.hps[i]
          return (
            <span
              key={i}
              className={`ew-schem-hp ${s.hp <= 0 ? 'is-dead' : ''}`}
              style={{ left: `${p.x * 10}%`, top: `${p.y * 10}%`, ['--c' as string]: HP_COLOR[p.kind], ['--f' as string]: `${(s.hp / s.max) * 360}deg` }}
              data-tip={`${hpName(p, t.faction)}: ${s.hp <= 0 ? 'destroyed' : `${fmt(s.hp)} / ${fmt(s.max)}`}`}
            >
              <HpIcon kind={p.kind} size={9} />
            </span>
          )
        })}
      </div>
    </div>
  )
}

/** The unit card's retreat button: a small jump icon for gunships and bigger, lit while their
 * drives charge. */
function RetreatIcon({ ships, onRetreat }: { ships: Unit[]; onRetreat: (ids: number[]) => void }) {
  const { keys } = useSettings()
  const able = ships.filter(canRetreat)
  if (!able.length) return null
  const charging = able.filter((u) => u.retreat > 0)
  const all = charging.length === able.length
  const refund = able.reduce((s, u) => s + retreatRefund(u), 0)
  const left = charging.length ? Math.ceil(Math.max(...charging.map((u) => u.retreat))) : 0
  return (
    <button
      className={`ew-retreaticon ${charging.length ? 'is-on' : ''}`}
      onClick={() => onRetreat(able.map((u) => u.id))}
      data-tip={all
        ? `Jumping out in ${left} s. Click (${keyName(keys.retreat)}) to call it off.`
        : `Hyperspace retreat (${keyName(keys.retreat)}): charges for a few seconds while holding still and firing, then jumps out and frees its fleet space; +${fmt(refund)} credits follow ${REFUND_DELAY} s later (up to ${Math.round(RETREAT_REFUND * 100)}% of the cost, less when damaged).`}
      aria-label="Hyperspace retreat"
    >
      <Icon name="jump" size={15} />
      {all ? <b>{left}s</b> : <b>+{fmt(refund)}</b>}
    </button>
  )
}

/** A mining platform's own upgrades: what it earns now, and a button per upgrade with its level
 * pips and price, or its progress while it's being fitted. */
/** What a mining platform earns: "+296/min" for its card's header, and the longer line for its tooltip. */
function mineEarning(w: World, me: Owner, u: Unit) {
  const perMin = (MINE_INCOME * mineOutput(u) * w.players[me].incomeMul * 60) | 0
  return { short: `+${fmt(perMin)}/min`, long: `Earning +${fmt(perMin)} credits a minute${(u.upg.yield ?? 0) ? `, drills at +${Math.round(YIELD_PER_LEVEL * 100 * (u.upg.yield ?? 0))}%` : ''}.` }
}

function SiteUpgrades({ w, me, u, onUpgrade, onCancel }: { w: World; me: Owner; u: Unit; onUpgrade: (id: number, upgrade: SiteUpgradeId) => void; onCancel: (id: number) => void }) {
  const press = useCancelPress()
  return (
    <div className="ew-siteupg">
      <div>
        {SITE_UPGRADES.map((x) => siteUpgradeOf(x.id, u.t.faction)).map((up) => {
          const have = u.upg[up.id] ?? 0
          const next = siteUpgradeNext(u, up.id)
          const busy = u.upgrading?.id === up.id ? u.upgrading : null
          const why = cantUpgradeSite(w, me, u, up.id)
          return (
            <button key={up.id} className={`ew-siteupg-btn ${busy ? 'is-busy' : !next ? 'is-done' : why ? 'is-off' : ''}`} onClick={() => !busy && onUpgrade(u.id, up.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                if (busy && !press.touched()) onCancel(u.id)
              }}
              {...press.handlers(busy ? () => onCancel(u.id) : null)}
              data-tip={`${up.name}: ${up.blurb}\nThis platform only: rebuilt, it starts again.${next ? `\nLevel ${next.level}: ${next.cost} credits, ${next.time} s.` : '\nFully upgraded.'}${why && next && !busy ? `\n\n${why}` : ''}${busy ? '\n\nRight-click to cancel (full refund). Long-press on touch.' : ''}`}>
              <strong>{up.name}</strong>
              <span className="ew-pips">{Array.from({ length: up.levels }, (_, i) => <i key={i} className={i < have ? 'is-on' : ''} />)}</span>
              <small>{busy ? `Fitting… ${Math.ceil(busy.left)}s` : next ? <><Icon name="credits" size={11} /> {next.cost}</> : 'Done'}</small>
              {busy && <i className="ew-siteupg-bar" style={{ transform: `scaleX(${1 - busy.left / busy.total})` }} />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * What a structure's guns are aimed at: its focus (with a button to let them choose again), the
 * guns with targets of their own, and the gun picked by clicking it, with how to aim it.
 */
function FocusInfo({ w, u, pick, onClear, quiet = false }: { w: World; u: Unit; pick: { unit: number; hp: number } | null; onClear: (id: number) => void; /** No hint while nothing is focused (a ⓘ has it). */ quiet?: boolean }) {
  const focus = u.focus ? w.byId.get(u.focus) : undefined
  const own = u.guns.filter((g) => g.focus && w.byId.get(g.focus))
  const picked = pick && pick.unit === u.id ? u.t.hardpoints[pick.hp] : null
  if (quiet && !focus && !own.length && !picked) return null
  return (
    <div className="ew-focus">
      {focus || own.length ? (
        <span>
          <Icon name="target" size={12} /> {focus ? `Focus: ${focus.t.name}` : ''}
          {own.length ? `${focus ? ' · ' : 'Focus: '}${own.length} gun${own.length === 1 ? '' : 's'} on their own target` : ''}
          <button className="ew-focus-x" onClick={() => onClear(u.id)} data-tip="Let every gun choose its own targets again">×</button>
        </span>
      ) : (
        <span className="ew-muted">Guns choose their own targets. Right-click an enemy to focus them{picked ? '' : '; click one gun first to aim just that one'}.</span>
      )}
      {picked && <span className="ew-focus-pick">{hpName(picked, u.t.faction)} picked: right-click an enemy to aim it.</span>}
    </div>
  )
}

/** Send a repair crew to a structure: the price for what's missing, or how far along it is. */
function RepairButton({ w, me, u, onRepair }: { w: World; me: Owner; u: Unit; onRepair: (id: number) => void }) {
  if (u.repair > 0)
    return (
      <span className="ew-repair is-busy" data-tip="The repair crew mends the hull and rebuilds shot-off modules">
        <Icon name="yard" size={13} /> Repairing… {Math.ceil(u.repair)}s
        <i style={{ width: `${(1 - u.repair / REPAIR_TIME) * 100}%` }} />
      </span>
    )
  const why = cantRepair(w, me, u)
  if (why === 'Nothing to repair' || why === 'Still under construction') return null
  return (
    <button className={`ew-repair ${why ? 'is-off' : ''}`} onClick={() => onRepair(u.id)} data-tip={`Send a repair crew: it mends the hull and rebuilds every module that was shot off, over ${REPAIR_TIME} s.${why ? `\n\n${why}` : ''}`}>
      <Icon name="yard" size={13} /> Repair <Icon name="credits" size={12} /> {repairCost(u)}
    </button>
  )
}

/** Hardpoints counted by kind: "5/6" next to a turret icon. */
function HpSummary({ u }: { u: Unit }) {
  // By name, so point defence and turbolasers count apart.
  const names = [...new Set(u.t.hardpoints.map((h) => hpName(h, u.t.faction)))]
  return (
    <div className="ew-hpsum">
      {names.map((n) => {
        const all = u.t.hardpoints.map((h, i) => (hpName(h, u.t.faction) === n ? i : -1)).filter((i) => i >= 0)
        const up = all.filter((i) => u.hps[i].hp > 0).length
        const k = u.t.hardpoints[all[0]].kind
        // A rush-launched ship's parts not yet installed.
        const unbuilt = all.filter((i) => u.rush?.parts.includes(i)).length
        return (
          <span key={n} className={`ew-hpchip ${up === 0 ? 'is-dead' : up < all.length ? 'is-hurt' : ''}`} style={{ ['--c' as string]: HP_COLOR[k] }} data-tip={`${n}: ${up} of ${all.length} working${unbuilt ? `, ${unbuilt} not yet installed` : ''}`}>
            <HpIcon kind={k} size={13} />
            {up} / {all.length}
          </span>
        )
      })}
    </div>
  )
}

/** Hull and shield bars. `compact` (the unit card): thin bars side by side, wrapping under each other
 * when the card is narrow. */
function Vitals({ u, squad = [u], now, compact = false }: { u: Unit; squad?: Unit[]; now: number; compact?: boolean }) {
  const reboot = SHIELD_REBOOT - (now - u.shieldOut)
  const t = u.t
  const hull = squad.reduce((s, x) => s + x.hull, 0)
  const max = squad.reduce((s, x) => s + x.hullMax, 0)
  const weak = shieldMax(u) < shieldFull(u)
  if (compact)
    return (
      <div className="ew-bars is-compact">
        <span className="ew-barcell">
          <span>Hull</span>
          <Bar value={hull} max={max} kind="hull" />
          <small>{fmt(hull)} / {fmt(max)}</small>
        </span>
        {t.shield > 0 && (
          <span className="ew-barcell" data-tip={weak ? 'Shield generators damaged: the shields cannot fully recharge' : undefined}>
            <span>Shield</span>
            <Bar value={u.shield} max={shieldFull(u)} kind="shield" />
            <small>{fmt(u.shield)} / {fmt(shieldFull(u))}{weak ? ' ⚠' : ''}</small>
          </span>
        )}
        {u.nebula && <p className="ew-terrain-note">{t.shield > 0 ? 'In a nebula: shields down, sensors at half range' : 'In a nebula: sensors at half range'}</p>}
        {!u.nebula && t.shield > 0 && reboot > 0 && <p className="ew-terrain-note">Shields failed: back online in {Math.ceil(reboot)} s</p>}
      </div>
    )
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
          <small data-tip={shieldMax(u) < shieldFull(u) ? 'Shield generators damaged: the shields cannot fully recharge' : undefined}>
            {fmt(u.shield)} / {fmt(shieldFull(u))}
            {shieldMax(u) < shieldFull(u) ? ' ⚠' : ''}
          </small>
        </>
      )}
      {u.nebula && <p className="ew-terrain-note">{t.shield > 0 ? 'In a nebula: shields down, sensors at half range' : 'In a nebula: sensors at half range'}</p>}
      {!u.nebula && t.shield > 0 && reboot > 0 && <p className="ew-terrain-note">Shields failed: back online in {Math.ceil(reboot)} s</p>}
    </div>
  )
}

// --- Top bar ----------------------------------------------------------------------------------------

export function TopBar({ hud, faction, sector, ui, onPause, onSpeed, onMenu, onShipyard, onYard, onTechTree, onReserves, onEconomy, onPlayers, onMap, mapOpen, ping, onGift, giftOpen }: {
  hud: Hud
  /** Select one of our yards (hybrid bases). */
  onYard?: (id: number) => void
  faction: FactionId
  sector: string
  ui: { paused: boolean; speed: number }
  /** Left out in multiplayer, where the server keeps time: only the clock shows. */
  onPause?: () => void
  onSpeed?: (s: number) => void
  onMenu: () => void
  onShipyard: () => void
  onTechTree: () => void
  onReserves: () => void
  onEconomy: () => void
  /** The player list (scores; online, pings too). */
  onPlayers?: () => void
  /** Online: our round trip to the server, in milliseconds (-1 while the connection is down). */
  ping?: number
  /** Phones hide the tactical map: this shows it again (the button only shows on phones). */
  onMap?: () => void
  mapOpen?: boolean
  /** Team battles: opens the panel to send credits to an ally (left out without allies). */
  onGift?: () => void
  giftOpen?: boolean
}) {
  const q = hud.queue[0]
  const r = hud.research[0]
  const { keys } = useSettings()
  return (
    <div className="ew-top">
      <FactionButton hud={hud} faction={faction} sector={sector} onReserves={onReserves} />
      <button className="ew-top-cell ew-creditcell" onClick={onEconomy} data-tip="Credits and income per minute.\nClick for the economy: where it comes from, where it went, and recent purchases.">
        <span className="ew-gold"><Icon name="credits" size={20} /></span>
        <b className="ew-big">{fmt(hud.credits)}</b>
        <small className="ew-good">+{fmt(hud.income * 60)} / min</small>
      </button>
      {onGift && (
        <button className={`ew-top-cell ew-top-btn ew-giftbtn ${giftOpen ? 'is-on' : ''}`} onClick={onGift} aria-pressed={!!giftOpen} aria-label="Send credits to an ally" data-tip="Send credits to an ally">
          <span className="ew-gold"><Icon name="give" size={18} /></span>
        </button>
      )}
      <div className={`ew-top-cell ${hud.pop >= hud.popCap ? 'is-full' : ''}`} data-tip="Fleet size / capacity. Capture beacons and upgrade the station for more.">
        <Icon name="fleet" size={20} />
        <b className="ew-big">{hud.pop}</b>
        <small>/ {hud.popCap}</small>
      </div>
      <div className="ew-top-cell ew-hide-narrow" data-tip="Mining platforms, and beacons held">
        <span className="ew-ore"><Icon name="ore" size={17} /></span>
        <b>{hud.mines}</b>
        <span className="ew-beacon"><Icon name="beacon" size={17} /></span>
        <b>{hud.beacons}</b>
        <small>/ {hud.beaconsAll}</small>
      </div>
      <div className="ew-top-right">
        {/* The shipyard and the lab: an icon each, a bar filling as the current job runs and a badge
            counting what's queued; the tooltip names it. */}
        <button className={`ew-top-cell ew-jobbtn ${q ? 'is-busy' : ''}`} onClick={onShipyard} aria-label={hud.hybrid ? 'Command Station' : 'Shipyard'}
          data-tip={q ? `${hud.hybrid ? 'Command Station' : 'Shipyard'}: ${UNIT[q.unit].name}, ${Math.ceil(q.left)} s left${hud.queue.length > 1 ? `, ${hud.queue.length - 1} more queued` : ''}.\nClick to select the station (H).` : `${hud.hybrid ? 'Command Station' : 'Shipyard'} idle.\nClick to select the station and build ships (H).`}>
          <Icon name="yard" size={18} />
          {hud.queue.length > 0 && <em>{hud.queue.length}</em>}
          {q && <i style={{ transform: `scaleX(${1 - q.left / q.total})` }} />}
        </button>
        {/* Hybrid bases: a job button per yard, the same way (a site shows its progress). */}
        {onYard && hud.yards.map((y) => {
          const yq = y.queue[0]
          const name = UNIT[y.unit].name
          return (
            <button key={y.id} className={`ew-top-cell ew-jobbtn ew-yardbtn ${yq || !y.built ? 'is-busy' : ''}`} onClick={() => onYard(y.id)} aria-label={name}
              data-tip={!y.built ? `${name}: under construction, ${Math.round(y.progress * 100)}%.\nClick to select it (${keyName(keys.yard)}).` : yq ? `${name}: ${UNIT[yq.unit].name}, ${Math.ceil(yq.left)} s left${y.queue.length > 1 ? `, ${y.queue.length - 1} more queued` : ''}.\nClick to select it (${keyName(keys.yard)}).` : `${name} idle.\nClick to select it and build ${y.unit.endsWith('cyard') ? 'cruisers' : 'frigates'} (${keyName(y.unit.endsWith('cyard') ? keys.cyard : keys.yard)}).`}>
              <Icon name="slip" size={18} />
              {y.queue.length > 0 && <em>{y.queue.length}</em>}
              {!y.built ? <i style={{ transform: `scaleX(${y.progress})` }} /> : yq && <i style={{ transform: `scaleX(${1 - yq.left / yq.total})` }} />}
            </button>
          )
        })}
        <button className={`ew-top-cell ew-jobbtn ${r ? 'is-busy' : ''}`} onClick={onTechTree} aria-label="Tech tree"
          data-tip={r ? `Research: ${researchName(r.id, hud.level, hud.faction)}, ${Math.ceil(r.left)} s left${hud.research.length > 1 ? `, ${hud.research.length - 1} more queued` : ''}.\nClick for the tech tree (${keyName(keys.techTree)}).` : `Research idle.\nClick for the tech tree (${keyName(keys.techTree)}).`}>
          <Icon name="tree" size={18} />
          {hud.research.length > 0 && <em>{hud.research.length}</em>}
          {r && <i style={{ transform: `scaleX(${1 - r.left / r.total})` }} />}
        </button>
        {/* Time: pause and play, the battle clock, and the speed, which cycles 1x, 2x, 3x. */}
        <div className={`ew-top-cell ew-timectl ${ui.paused ? 'is-paused' : ''} ${onPause ? '' : 'is-clockonly'}`} role="group" aria-label="Time">
          {onPause && (
            <button onClick={onPause} data-tip={`${ui.paused ? 'Resume' : 'Pause'} (${keyName(keys.pause)})`} aria-label={ui.paused ? 'Resume' : 'Pause'}>
              <Icon name={ui.paused ? 'play' : 'pause'} size={16} />
            </button>
          )}
          <b className="ew-clockval">{clock(hud.time)}</b>
          {onSpeed && (
            <button className="ew-speedbtn" onClick={() => onSpeed((ui.speed % 3) + 1)} data-tip="Game speed: click to cycle 1x, 2x, 3x" aria-label={`Game speed ${ui.speed}x`}>
              {ui.speed}×
            </button>
          )}
        </div>
        {onPlayers && (
          <button className="ew-top-cell ew-top-btn ew-playersbtn" onClick={onPlayers} data-tip={`Players: scores${ping !== undefined ? ' and pings' : ''} (Tab)`} aria-label="Players">
            <Icon name="army" size={18} />
            {ping !== undefined && <small className={`ew-ping ${ping < 0 ? 'is-poor' : pingClass(ping)}`}>{ping < 0 ? 'offline' : `${ping} ms`}</small>}
          </button>
        )}
        {onMap && (
          <button className={`ew-top-cell ew-top-btn ew-maptoggle ${mapOpen ? 'is-on' : ''}`} onClick={onMap} aria-pressed={!!mapOpen} data-tip="Tactical map: show or hide it" aria-label="Tactical map">
            <Icon name="radar" size={18} />
          </button>
        )}
        <button className="ew-top-cell ew-top-btn" onClick={onMenu} data-tip="Battle menu: settings, keybinds, restart (Esc)" aria-label="Menu">
          <Icon name="menu" size={18} />
        </button>
      </div>
    </div>
  )
}

/**
 * Our faction's emblem and name, which opens the fleet inventory. A badge on the emblem counts the
 * ships waiting there, and hovering shows what they are.
 */
function FactionButton({ hud, faction, sector, onReserves }: { hud: Hud; faction: FactionId; sector: string; onReserves: () => void }) {
  const art = unitArt
  const [hover, setHover] = useState(false)
  const timer = useRef(0)
  const kinds = [...new Set(hud.reserve)]
  return (
    <span className="ew-factionwrap">
      <button
        className="ew-top-cell ew-top-faction"
        onClick={() => {
          setHover(false)
          onReserves()
        }}
        onPointerEnter={(e) => {
          if (e.pointerType === 'touch') return
          clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setHover(true), 300)
        }}
        onPointerLeave={() => {
          clearTimeout(timer.current)
          setHover(false)
        }}
        aria-label={`Open the fleet inventory: ${hud.reserve.length} ships waiting`}
      >
        <span className="ew-emblem">
          <img src={FACTIONS[faction].emblem} alt="" />
          {hud.reserve.length > 0 && <em>{hud.reserve.length}</em>}
        </span>
        <div>
          <strong>{FACTIONS[faction].name}</strong>
          <small>{sector}</small>
        </div>
      </button>
      {hover && (
        <span className="ew-tip ew-fleettip" role="tooltip">
          <b>Open fleet inventory</b>
          {kinds.length ? (
            <span className="ew-fleettip-ships">
              {kinds.map((id) => (
                <span key={id}>
                  <img src={art(UNIT[id].sprite)} alt="" />
                  <small>×{hud.reserve.filter((x) => x === id).length}</small>
                </span>
              ))}
            </span>
          ) : (
            <small className="ew-muted">Empty: ships you build at the station wait here until you drag them onto the battlefield.</small>
          )}
        </span>
      )}
    </span>
  )
}

// --- Credits for allies -------------------------------------------------------------------------------

/** An ally credits can go to: their seat, name, side and (teammates see it) credits. */
export type Ally = { seat: Owner; name: string; faction: FactionId; credits: number; ai: boolean }
/** What the amount buttons add. */
const GIFT_STEPS = [250, 500, 1000]
/** "All but": what the last button keeps back. */
const GIFT_KEEP = 100

/**
 * The panel the top bar's send button opens in a team battle: pick an ally (with their credits), an
 * amount (+250, +500, +1000 add up; Half and All but 100 set it; or type it), and send. `onSend`
 * answers why not, or null once it's on its way; the message log (and the ally's) confirms it when
 * it lands.
 */
export function GiftPanel({ credits, allies, onSend, onClose }: {
  credits: number
  allies: Ally[]
  onSend: (seat: Owner, amount: number) => string | null
  onClose: () => void
}) {
  const [to, setTo] = useState(allies[0]?.seat ?? -1)
  const [amount, setAmount] = useState(0)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const have = Math.floor(credits)
  const ally = allies.find((a) => a.seat === to) ?? allies[0]
  const amt = Math.max(0, Math.min(amount, have))
  const pick = (n: number) => {
    setAmount(Math.max(0, Math.min(have, Math.floor(n))))
    setNote(null)
  }
  const send = () => {
    if (!ally || amt <= 0) return
    const why = onSend(ally.seat, amt)
    setNote(why ? { text: why, ok: false } : { text: `${fmt(amt)} credits sent to ${ally.name}`, ok: true })
    if (!why) setAmount(0)
  }
  return (
    <KeptInside className="ew-giftpop" data-nodrag role="dialog" aria-label="Send credits">
      <Frame title="Send credits" aside={<button className="ew-giftx" onClick={onClose} aria-label="Close">×</button>}>
        <div className="ew-giftallies" role="radiogroup" aria-label="Ally">
          {allies.map((a) => (
            <button key={a.seat} role="radio" aria-checked={a.seat === ally?.seat} className={a.seat === ally?.seat ? 'is-on' : ''} onClick={() => (setTo(a.seat), setNote(null))}>
              <img src={FACTIONS[a.faction].emblem} alt="" />
              <span>
                <b>{a.name}</b>
                <small>{a.ai ? 'AI ally' : 'Ally'} · <span className="ew-gold">{fmt(a.credits)}</span> credits</small>
              </span>
            </button>
          ))}
        </div>
        <div className="ew-giftamts">
          {GIFT_STEPS.map((n) => (
            <button key={n} onClick={() => pick(amt + n)} disabled={amt >= have}>+{fmt(n)}</button>
          ))}
          <button onClick={() => pick(have / 2)} disabled={have < 2}>Half</button>
          <button onClick={() => pick(have - GIFT_KEEP)} disabled={have <= GIFT_KEEP}>All but {GIFT_KEEP}</button>
        </div>
        <label className="ew-giftcustom">
          <span className="ew-muted">Amount</span>
          <input type="number" inputMode="numeric" min={0} max={have} step={50} value={amt || ''} placeholder="0"
            onChange={(e) => pick(Number(e.target.value) || 0)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') send()
              else if (e.key === 'Escape') onClose()
            }} />
          <small className="ew-muted">of {fmt(have)}</small>
        </label>
        <button className="ew-go ew-giftsend" onClick={send} disabled={!ally || amt <= 0}>
          {ally && amt > 0 ? `Send ${fmt(amt)} to ${ally.name}` : 'Pick an amount'}
        </button>
        {note && <small className={note.ok ? 'ew-good' : 'ew-bad'} role="status">{note.text}</small>}
      </Frame>
    </KeptInside>
  )
}

// --- Tactical map -----------------------------------------------------------------------------------

export function TacticalMap({ canvas, sides, filter, onFilter, onStation, onAlert, onIdle, onArmy, onPointer, onPointerEnd, idle, fogGrid, onFogGrid, onMove }: {
  onMove?: (box: { x: number; y: number; w: number; h: number }, root: { w: number; h: number }) => void
  idle: number
  fogGrid: boolean
  onFogGrid: () => void
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
  /** The pointer let go of the map (or was taken away): ends a touch long press. */
  onPointerEnd?: () => void
}) {
  const filters: [MapFilter, string][] = [
    ['all', 'All'],
    ['ships', 'Ships'],
    ['stations', 'Stations'],
    ['enemies', 'Enemies'],
  ]
  return (
    <Floating id="map" title="Tactical map" at={{ left: 6, bottom: 6 }} className="ew-mapframe" onMove={onMove} aside={<span className="ew-muted ew-small ew-mapsides">{sides}</span>}>
      <div className="ew-mapbody">
        <div className="ew-maptools">
          <button onClick={onStation} data-tip="Select the station (H)" aria-label="Station"><Icon name="target" size={17} /></button>
          <button onClick={onAlert} data-tip="Jump to the last alert (Space)" aria-label="Last alert"><Icon name="radar" size={17} /></button>
          <button className="ew-badged" onClick={onIdle} data-tip={`Select idle ships (I): ${idle} idle`} aria-label="Idle ships">
            <Icon name="idle" size={17} />
            {idle > 0 && <em>{idle}</em>}
          </button>
          <button onClick={onArmy} data-tip="Select every warship (Ctrl+A)" aria-label="All ships"><Icon name="army" size={17} /></button>
          <FogGridButton on={fogGrid} onToggle={onFogGrid} />
        </div>
        <canvas ref={canvas} className="ew-mini" onPointerDown={onPointer} onPointerMove={(e) => e.buttons === 1 && onPointer(e)} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} />
      </div>
      <div className="ew-mapfilters" role="tablist" aria-label="Show on the map">
        {filters.map(([f, label]) => (
          <button key={f} role="tab" aria-selected={filter === f} className={`is-${f} ${filter === f ? 'is-on' : ''}`} onClick={() => onFilter(f)}>
            {f !== 'all' && <i />}
            {label}
          </button>
        ))}
      </div>
    </Floating>
  )
}

function FogGridButton({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const { keys } = useSettings()
  return (
    <button className={on ? 'is-on' : ''} onClick={onToggle} aria-pressed={on} aria-label="Fog of war grid"
      data-tip={`Fog of war grid (${keyName(keys.fogGrid)}): shows, cell by cell, where your fleet's sight ends.`}>
      <Icon name="grid" size={17} />
    </button>
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
  /** `at`: the yard to build it at (0 or left out: the station). */
  onBuild: (id: string, times: number, reserve?: boolean, at?: number) => void
  onUnqueue: (id: string, at?: number) => void
  onCancel: (index: number, at?: number) => void
  /** Hybrid bases: start placing a yard (with the selected engineers, or any we have). */
  onPlace: (unit: string) => void
  /** Call off a yard still going up. */
  onCancelSite: (id: number) => void
  /** Select one of ours (the base tabs: the station, a yard). */
  onSelect: (id: number) => void
  /** Order an expansion on building `uid`, or call off the one at `index` in its queue. */
  onExpand: (uid: number, id: ModuleId) => void
  onCancelExpand: (uid: number, index: number) => void
  /** Rush launch: the Capital Yard `uid` sends out its ship in progress unfinished. */
  onRush: (uid: number) => void
  onResearch: (id: string) => void
  /** Call off the research at this queue slot (full refund). */
  onCancelResearch: (index: number) => void
  onTechTree: () => void
  onSite: (node: number, id: string) => void
  onRepair: (id: number) => void
  onUpgradeSite: (id: number, upgrade: SiteUpgradeId) => void
  /** Call off the upgrade being fitted to a mining platform (full refund). */
  onCancelUpgradeSite: (id: number) => void
  /** Select our engineers (for their Build section); false when there are none. */
  onEngineers: () => boolean
  /** Retreat these ships into hyperspace (or call it off). */
  onRetreat: (ids: number[]) => void
  /** A structure's gun picked by clicking it, if any. */
  turretPick: { unit: number; hp: number } | null
  /** Clear a structure's focus fire (its own and every gun's). */
  onClearFocus: (id: number) => void
  onStation: () => void
  /** The ore asteroid clicked on, if no ships are selected. */
  node: OreNode | null
}

export function DetailPanel(p: DetailProps) {
  const { sel, me } = p
  if (!sel.length && p.node) return <OreDetail {...p} n={p.node} />
  if (!sel.length) return null
  const station = sel.find((u) => u.owner === me && u.t.tier === 'station')
  if (station) return <StationDetail {...p} st={station} />
  const first = sel[0]
  if (first.owner === me && first.t.tier === 'yard' && sel.length === 1) return <YardDetail {...p} y={first} />
  if (sel.every((u) => u.t.id === first.t.id)) return <UnitDetail {...p} u={first} squad={sel} />
  return <GroupDetail {...p} />
}

export function Pips({ level, faction }: { level: number; faction?: FactionId }) {
  return (
    <span className="ew-pips" data-tip={`${faction ? `${stageName(faction, level)}: s` : 'S'}tation level ${level} of ${MAX_LEVEL}`}>
      {Array.from({ length: MAX_LEVEL }, (_, i) => (
        <i key={i} className={i < level ? 'is-on' : ''} />
      ))}
    </span>
  )
}

/** A piece of research's name; a station level by the name the station goes by there. */
export const researchName = (id: string, level: number, faction: FactionId) => (id === LEVEL_UP ? `Station level ${level + 1}: ${stageName(faction, level + 1)}` : TECH[id].name)

/** The generated icon for a piece of research (or the one it borrows, Tech `icon`); every station level shares one. */
export const techIconUrl = (id: string) => `/games/empires/tech/${id === LEVEL_UP ? 'level' : (TECH[id]?.icon ?? id)}.webp`

/** What reaching a station level brings, for its tile in the tech tree. */
export function levelBlurb(faction: FactionId, level: number) {
  const unlocks = buildable(faction).filter((u) => u.level === level)
  return `It grows into the ${stageName(faction, level)}: more hull and firepower, +4 fleet capacity${unlocks.length ? `, unlocks the ${unlocks.map((u) => u.name).join(', ')}` : ''}.`
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
function TechTile({ id, w, me, hud, onResearch, onCancel }: { id: string; w: World; me: Owner; hud: Hud; onResearch: (id: string) => void; onCancel: (index: number) => void }) {
  const press = useCancelPress()
  const s = techState(w, me, hud, id)
  const queued = s.slot >= 0
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
      onClick={() => {
        if (!queued) onResearch(id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        if (queued && !press.touched()) onCancel(s.slot)
      }}
      {...press.handlers(queued ? () => onCancel(s.slot) : null)}
      disabled={s.status === 'done'}
      data-tip={`${researchName(id, hud.level, hud.faction)}\n${blurb}${s.why && s.status !== 'done' && !queued ? `\n\n${s.why}` : queued ? `\n\n${CANCEL_TIP}` : ''}`}
    >
      <TechIcon id={id} size={30} progress={s.progress} status={s.status} />
      <strong>{researchName(id, hud.level, hud.faction)}</strong>
      <span>{line}</span>
    </button>
  )
}

/** Opens the tech tree, showing what's being researched and how far along it is. */
function TechTreeButton({ hud, onOpen }: { hud: Hud; onOpen: () => void }) {
  const r = hud.research[0]
  const { keys } = useSettings()
  return (
    <button className={`ew-treebtn ${r ? 'is-busy' : ''}`} onClick={onOpen} data-tip={`Open the tech tree to research upgrades (${keyName(keys.techTree)})`}>
      {r ? <TechIcon id={r.id} size={30} progress={1 - r.left / r.total} status="busy" /> : <Icon name="tree" size={22} />}
      <span>
        <strong>Tech tree</strong>
        <small>{r ? `${researchName(r.id, hud.level, hud.faction)}, ${Math.ceil(r.left)}s` : 'Nothing researching'}</small>
      </span>
      <b>{hud.research.length}/{MAX_RESEARCH}</b>
      <kbd>{keyName(keys.techTree)}</kbd>
      {r && <i style={{ width: `${(1 - r.left / r.total) * 100}%` }} />}
    </button>
  )
}

/** One page of a building's build panel: which of the two groups it belongs to, and how it looks. */
export type BpTab = { id: string; group: 'units' | 'buildings'; label: string; badge?: ReactNode; tip: string }

const BP_GROUP = {
  units: { label: 'Units', icon: 'fleet' as IconName, tip: 'Units: the ships built here.' },
  buildings: { label: 'Buildings', icon: 'yard' as IconName, tip: 'Buildings: the yards, and the expansions each building takes.' },
}

/**
 * The same build panel on every building (Command Station, Frigate Yard, Capital Yard, and a
 * galaxy planet's shipyard): a slim rail of icons down the left, Units and Buildings (the picked
 * one lit gold, a count as a badge, its name in the tooltip), and across the top of the cards the
 * pages of the picked one as tabs, the open page underlined. A group with nothing in it isn't
 * offered. `badges`: a small count on a group's icon.
 */
export function BuildPanel({ tabs, page, onPick, badges = {}, children }: { tabs: BpTab[]; page: string; onPick: (id: string) => void; badges?: Partial<Record<'units' | 'buildings', ReactNode>>; children: ReactNode }) {
  const cur = tabs.find((t) => t.id === page) ?? tabs[0]
  const groups = (['units', 'buildings'] as const).filter((g) => tabs.some((t) => t.group === g))
  // Each group opens on the page last used in it.
  const last = useRef<Partial<Record<'units' | 'buildings', string>>>({})
  last.current[cur.group] = cur.id
  const inGroup = tabs.filter((t) => t.group === cur.group)
  return (
    <div className="ew-yardbody ew-bp">
      <div className="ew-bp-rail" role="tablist" aria-orientation="vertical" aria-label="Units or buildings">
        {groups.map((g) => {
          const mine = tabs.filter((t) => t.group === g)
          return (
            <button key={g} role="tab" aria-selected={cur.group === g} aria-label={BP_GROUP[g].label} className={cur.group === g ? 'is-on' : ''} data-tip={BP_GROUP[g].tip}
              onClick={() => onPick(mine.find((t) => t.id === last.current[g])?.id ?? mine[0].id)}>
              <Icon name={BP_GROUP[g].icon} size={20} />
              {badges[g] !== undefined && <em>{badges[g]}</em>}
            </button>
          )
        })}
      </div>
      <div className="ew-bp-main">
        <div className="ew-bp-tabs" role="tablist" aria-label={BP_GROUP[cur.group].label}>
          {inGroup.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.id === cur.id} className={t.id === cur.id ? 'is-on' : ''} onClick={() => onPick(t.id)} data-tip={t.tip}>
              <span>{t.label}</span>
              {t.badge !== undefined && <em>{t.badge}</em>}
            </button>
          ))}
        </div>
        {children}
      </div>
    </div>
  )
}

/** Which page the Command Station's build panel opens on: the one picked last (remembered across
 * battles, and with the galaxy map's planet panel), else Strike craft. Pages the panel doesn't have
 * map to the nearest it does: with hybrid bases the station builds no warships, so Warships means
 * Strike craft there; the galaxy's Buildings page means Yards. */
export function storedPage<T extends string>(have: readonly T[], fallback: T, map: Partial<Record<string, T>> = {}): T {
  try {
    const v = localStorage.getItem('mvlos.empires.yardpage') ?? ''
    const to = (map[v] ?? v) as T
    return have.includes(to) ? to : fallback
  } catch {
    return fallback
  }
}
export function storePage(page: string) {
  try {
    localStorage.setItem('mvlos.empires.yardpage', page)
  } catch {
    // Not remembered this time.
  }
}

/** A small ⓘ beside a name: the longer story in its tooltip, so the column itself stays short. */
export function InfoDot({ tip }: { tip: string }) {
  return (
    <span className="ew-infodot" tabIndex={0} role="note" aria-label={tip} data-tip={tip}>
      i
    </span>
  )
}

/** How many columns a building's cards take in the battle's build panel: up to three side by side
 * in one row, more in two rows; the grid shares out the width between them (see empires.css,
 * .ew-bp .ew-yard). */
const cardCols = (n: number) => ({ ['--cols' as string]: String(n <= 3 ? Math.max(1, n) : Math.ceil(n / 2)) })

/** The left column's head on a building: its name with the ⓘ beside it, and what it is. */
function SideName({ w, me, u, sub, info }: { w: World; me: Owner; u: Unit; sub: string; info: string }) {
  return (
    <div className="ew-side-info">
      <span className="ew-side-name">
        <strong {...unitTip(u.t, ownerTag(w, me, u.owner), undefined, u)}>{u.t.name}</strong>
        <InfoDot tip={info} />
      </span>
      <small className="ew-muted">{sub}</small>
    </div>
  )
}

/** What a structure's guns do and how to aim them: for the ⓘ. */
const GUNS_TIP = 'Guns choose their own targets. Right-click an enemy to focus every gun on it (long-press on touch); click one gun on the picture first to aim just that one.'

/** A ghost card in the shipyard's grid where a page has nothing to build here: what it would show,
 * where it is built instead, and a way there. */
function GhostCard({ t, text, go, onGo }: { t: UnitType; text: string; go: string; onGo: () => void }) {
  return (
    <div className="ew-shipcard ew-ghostcard">
      <ShipArt t={t} />
      <span className="ew-ghost-text">{text}</span>
      <button className="ew-chip ew-ghost-go" onClick={onGo} data-tip={go}>
        Go <Icon name="jump" size={12} />
      </button>
    </div>
  )
}

function StationDetail(p: DetailProps & { st: Unit }) {
  const { w, me, st, hud, faction } = p
  // Ships the station isn't upgraded for yet stay out of the shipyard, unless the setting shows them.
  const { lockedShips } = useSettings()
  // With hybrid bases the Command Station builds strike craft, gunships, engineers and (until their
  // yard comes) the heaviest ships; the frigates and corvettes come from the Frigate Yard.
  const list = w.hybrid ? baseBuilds(faction).filter((t) => builtAt(t) === 'station') : buildable(faction)
  const all = list.map((t) => UNIT[t.id]).filter((t) => lockedShips || t.level <= hud.level)
  const queued = (id: string) => hud.queue.filter((q) => q.unit === id).length
  // Strike craft and warships on separate pages (and, with hybrid bases, the yards and expansions),
  // Strike craft first; the choice is remembered (see storedPage).
  // (Yards are built by engineers: their Build section has the cards, the station has no page for them.)
  type Page = 'strike' | 'warships' | 'expansions'
  const [chosen, setPage] = useState<Page>(() =>
    storedPage<Page>(w.hybrid ? ['strike', 'warships', 'expansions'] : ['strike', 'warships'], 'strike', w.hybrid ? { warships: 'strike', buildings: 'expansions' } : { buildings: 'strike' }),
  )
  // The expansions page exists only with hybrid bases.
  const page = !w.hybrid && chosen === 'expansions' ? 'strike' : chosen
  const pick = (pg: Page) => {
    setPage(pg)
    storePage(pg)
  }
  // Small craft on one page (fighters, bombers and gunships), the warships proper on the other.
  // Corvettes share the gunship tier but count as warships.
  const small = (t: UnitType) => fromHangar(t) || (t.tier === 'gunship' && t.kind !== 'support')
  const strike = all.filter(small)
  const warships = all.filter((t) => !small(t))
  const ships = page === 'strike' ? strike : warships
  // (The Frigate Yard first: it builds the line's frigates.)
  const myYard = w.units.filter((u) => !u.dead && u.owner === me && u.t.tier === 'yard' && !u.site).sort((a, b) => Number(worksOf(a.t) === 'cyard') - Number(worksOf(b.t) === 'cyard'))[0]
  const hasEngineers = w.units.some((u) => !u.dead && u.owner === me && isEngineer(u.t))
  const grid = useRef<HTMLDivElement>(null)
  // The wheel scrolls the cards sideways when they don't all fit.
  useEffect(() => {
    const el = grid.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])
  return (
    <div className="ew-stationwrap">
      <BuildQueue queue={hud.queue} onCancel={p.onCancel} launch={!!w.reinforce} />
      <Frame className="ew-detail is-station">
        <div className="ew-detail-side">
          <Schematic u={st} size={96} tip={unitTip(st.t, ownerTag(w, me, st.owner), undefined, st)} />
          <SideName w={w} me={me} u={st} sub={`${stageName(st.t.faction, hud.level)} · ${w.hybrid ? 'Command Station' : 'Production station'}`} info={`${st.t.blurb}\n\n${GUNS_TIP}`} />
          <Pips level={hud.level} faction={st.t.faction} />
          <Vitals u={st} now={w.time} />
          <HpSummary u={st} />
          <WingInfo w={w} st={st} />
          <FocusInfo w={w} u={st} pick={p.turretPick} onClear={p.onClearFocus} quiet />
          <RepairButton w={w} me={me} u={st} onRepair={p.onRepair} />
        </div>
        <div className="ew-detail-main">
          {/* With a yard (or a ruin) beside the station, the tech tree button keeps to its icon and count. */}
          <header className={`ew-yardhead ${w.hybrid && (w.units.some((u) => !u.dead && u.owner === me && u.t.tier === 'yard') || (w.ruins ?? []).some((r) => r.owner === me)) ? 'is-tight' : ''}`}>
            {w.hybrid ? <BaseTabs w={w} me={me} cur={st.id} onSelect={p.onSelect} onRuin={() => !p.onEngineers() && pick('strike')} /> : <h5 className="ew-yardtitle">Shipyard</h5>}
            <TechTreeButton hud={hud} onOpen={p.onTechTree} />
          </header>
          <BuildPanel
            tabs={[
              { id: 'strike', group: 'units', label: 'Strike craft', badge: strike.length,
                tip: w.reinforce
                  ? `Strike craft: fighters, bombers, gunships${w.hybrid ? ', engineers' : ''} and repair craft fly out of the station's hangar.${w.reinforce.strike || w.reinforce.ships ? ' The red corner button calls one in as a reinforcement instead, anywhere your fleet can see.' : ''}`
                  : `Strike craft: fighters and bombers${w.hybrid ? ', and engineers,' : ''} launch from the station's hangar; gunships go to the fleet inventory, or jump in at the station with the small button.` },
              { id: 'warships', group: 'units', label: 'Warships', badge: warships.length,
                tip: w.hybrid ? 'Warships: none are built at the Command Station any more. Frigates and corvettes come from the Frigate Yard, cruisers and flagships from the Capital Yard.' : 'Warships: corvettes, frigates, cruisers and dreadnoughts. Built for the fleet inventory, or straight to the station with the small jump button.' },
              ...(w.hybrid ? [
                { id: 'expansions', group: 'buildings' as const, label: 'Expansions', badge: `${st.xm?.length ?? 0}/${modulesFor('station', st.t.faction).length}`, tip: `Expansions: modules the Command Station builds onto itself, one at a time (${modulesFor('station', st.t.faction).map((m) => m.name).join(', ')}).` },
              ] : []),
            ]}
            page={page} onPick={(id) => pick(id as typeof page)} badges={w.hybrid ? { buildings: `${st.xm?.length ?? 0}/${modulesFor('station', st.t.faction).length}` } : {}}>
            <div className="ew-yard" ref={grid} style={cardCols(page === 'expansions' ? modulesFor('station', st.t.faction).length : page === 'warships' && w.hybrid && !ships.length ? 4 : ships.length)}>
                {/* No warships at the Command Station with hybrid bases: a ghost card points the way. */}
                {page === 'warships' && w.hybrid && !ships.length && (
                  <GhostCard t={UNIT[unitOf(faction, 'frigate').id]} text={myYard ? `Built at the ${WORKS_NAME[worksOf(myYard.t) ?? 'yard']}` : 'Built at the Frigate Yard'}
                    go={myYard ? `Select the ${myYard.t.name}` : hasEngineers ? 'No yard yet: selects your engineers, their Build section has the yards' : 'No yard yet, and no engineers: build engineers first'}
                    onGo={() => (myYard ? p.onSelect(myYard.id) : !p.onEngineers() && pick('strike'))} />
                )}
                {page === 'expansions' && <ExpansionCards w={w} me={me} u={st} onExpand={p.onExpand} onCancel={p.onCancelExpand} />}
                {(page === 'warships' || page === 'strike') && ships.map((t) => (
                  <ShipCard key={t.id} t={t} who={ownerTag(w, me, me)} why={cantBuild(w, me, t.id)} whyReserve={cantBuild(w, me, t.id, true)} level={hud.level} queued={queued(t.id)} onBuild={p.onBuild} onUnqueue={p.onUnqueue} reinf={reinforceOffer(w, t.id)}
                    research={t.tech && !hud.techs.includes(t.tech) ? TECH[t.tech].name : null} need={moduleNeed(w, me, t, st)} />
                ))}
            </div>
          </BuildPanel>
        </div>
      </Frame>
    </div>
  )
}

/** The station's defense wing: craft left, and when the hangar sends the next one. */
function WingInfo({ w, st }: { w: World; st: Unit }) {
  const s = wingState(w, st)
  const name = wingOf(st.t.faction).name
  const line = s.next === null ? 'At full strength.' : s.next === Infinity ? 'Hangar down: no new craft until it is repaired.' : `The next craft in ${Math.ceil(s.next)} s.`
  return (
    <small className="ew-muted ew-wing" data-tip-unit={wingOf(st.t.faction).id} data-tip-who="Yours" data-tip-rel="own"
      data-tip={`${name}: the free defense wing, ${s.left} of ${s.full} craft. ${line}\nLost craft come back from its hangar one at a time, every ${DEFENSE_WING.every} s, starting ${DEFENSE_WING.wait} s after the last loss, while a hangar stands.`}>
      <Icon name="fleet" size={12} /> Wing {s.left}/{s.full}{s.next === null ? '' : s.next === Infinity ? ' · hangar down' : ` · ${Math.ceil(s.next)}s`}
    </small>
  )
}

/** An ore asteroid: who has surveyed it, and what we can build on it. */
function OreDetail(p: DetailProps & { n: OreNode }) {
  const { w, me, n, faction } = p
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
  // What each option is for, in a few words.
  const forWhat = (t: UnitType) =>
    t.tier === 'mine' ? `+${fmt(ore * 60)} credits a minute` : t.id.endsWith('-flak') ? 'Against fighters and bombers' : t.id.endsWith('-gun') ? 'Against warships' : 'All-round, a little weaker'
  const option = (t: UnitType) => {
    const why = cantSite(w, me, n.id, t.id)
    return (
      <button key={t.id} className={`ew-shipcard ew-sitecard ${why ? 'is-off' : ''}`} onClick={() => p.onSite(n.id, t.id)} data-tip={`${t.name}\n${t.blurb}${why ? `\n\n${why}` : ''}`}>
        <ShipArt t={t} />
        <strong>{t.name}</strong>
        <span className="ew-cost"><Icon name="credits" size={12} /> {t.cost} <Icon name="time" size={12} /> {t.build}s</span>
        <small className="ew-muted">{forWhat(t)}</small>
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
            {siteOptions(faction).map(option)}
          </div>
        )}
      </div>
    </Frame>
  )
}

/** The expansion a ship still waits for at the building that builds it (hybrid bases: the Strike
 * hangar for bombers, the Capital slip for flagships), by name; null when it needs none or it stands. */
export function moduleNeed(w: World, me: Owner, t: UnitType, at: Unit | undefined): string | null {
  const id = w.hybrid ? needsModule(t) : null
  if (!id || (at && at.owner === me && expUp(at, id))) return null
  return MODULE[id].name
}

/** A ship card's reinforcement, in a battle with the lobby's reinforcement rules: its price (with
 * the surcharge), or null when the lobby turned reinforcements off for its class. */
export type ReinforceOffer = { price: number; pct: number } | null
/** What a ship card offers as a reinforcement in this battle: undefined in a battle from before the
 * rules (the old cards: the inventory, or the jump button), else see ReinforceOffer. */
export const reinforceOffer = (w: World, id: string): ReinforceOffer | undefined =>
  !w.reinforce ? undefined : cantReinforce(w, id) ? null : { price: shipPrice(w, id, true), pct: w.reinforce.surcharge }

export function ShipCard({ t, who, why, whyReserve, level, queued, onBuild, onUnqueue, campaign = false, research = null, need = null, lock = null, where = 'the station', reinf }: {
  t: UnitType; who: { who: string; rel: string }; why: string | null; whyReserve: string | null; level: number; queued: number; onBuild: (id: string, times: number, reserve?: boolean) => void; onUnqueue: (id: string) => void
  /** Where a ship that jumps in straight away arrives: beside the station, or the yard building it. */
  where?: string
  /** On the galaxy map: every ship joins the fleet in orbit, so no jump-in button. */
  campaign?: boolean
  /** The research it still waits for, by name (null once it's done, or when it needs none). */
  research?: string | null
  /** The expansion it still waits for, by name (see moduleNeed). */
  need?: string | null
  /** Anything else that keeps it from being built here (a galaxy planet without the yard for it),
   * and the word on its badge. */
  lock?: { text: string; badge: string } | null
  /** Battles with reinforcement rules (see reinforceOffer): a click builds a ship that flies out of
   * where it is built, and the red corner button, showing its price, buys it as a reinforcement.
   * Undefined: a battle from before them, with the old cards. */
  reinf?: ReinforceOffer
}) {
  const locked = t.level > level || !!research || !!need || !!lock
  const lockText = t.level > level ? `Needs station level ${t.level}.` : research ? `Needs research: ${research}. Find it in the tech tree.` : need ? `Needs the ${need}: an expansion, ordered from its building's Expansions tab.` : `${lock?.text}.`
  // Battles with reinforcement rules: a click launches, the red button is the reinforcement.
  const launch = reinf !== undefined && !campaign
  const out = where === 'the station' ? "the station's hangar" : where
  // The old cards: strike craft from the hangar; anything else to the inventory, the button jumps in.
  const toInventory = !launch && !fromHangar(t) && !campaign
  const cardWhy = launch ? why : toInventory ? whyReserve : why
  // A finger has no Shift-click or right-click: a long press offers them on a wheel.
  const press = useLongPressWheel(
    () =>
      locked
        ? []
        : [
            { id: 'one', label: 'Build 1', run: () => onBuild(t.id, 1, toInventory) },
            { id: 'five', label: 'Build 5', run: () => onBuild(t.id, 5, toInventory) },
            ...(launch && reinf ? [{ id: 'jump', label: 'Reinforce', disabled: whyReserve ?? undefined, run: () => onBuild(t.id, 1, true) }] : []),
            ...(toInventory ? [{ id: 'jump', label: 'Jump in', disabled: why ?? undefined, run: () => onBuild(t.id, 1, false) }] : []),
            { id: 'less', label: 'Remove 1', disabled: queued ? undefined : 'Nothing queued', danger: true, run: () => onUnqueue(t.id) },
          ],
    t.name,
  )
  const how = launch
    ? `Click to build: it flies out of ${out} to the rally point.${reinf ? ` The red corner button calls one in as a reinforcement instead, for ${reinf.price} (+${reinf.pct}%): it waits in the fleet inventory, to be called in anywhere your fleet can see.` : ''}`
    : campaign ? 'Click to build it here: it joins the fleet in orbit.' : fromHangar(t) ? 'Click to build: it launches from the hangar.' : `Click to build it for the fleet inventory, then drag it out to any spot your fleet can see. The small corner button builds one that jumps in beside ${where}.`
  const card = (
    <button
      {...press}
      className={`ew-shipcard ${locked ? 'is-locked' : cardWhy ? 'is-off' : ''}`}
      onClick={(e) => onBuild(t.id, shiftOf(e) ? 5 : 1, toInventory)}
      onContextMenu={(e) => {
        e.preventDefault()
        onUnqueue(t.id)
      }}
      {...unitTip(t, who, `${locked ? lockText : how}${locked ? '' : ' Shift-click for five, right-click to remove one.'}${!locked && cardWhy ? `\n${cardWhy}` : ''}`)}
    >
      <ShipArt t={t} />
      <strong>{t.name}</strong>
      <span className="ew-cost" {...(launch ? { 'aria-label': `Launch: ${t.cost} credits` } : {})}><Icon name="credits" size={11} /> {t.cost}</span>
      <span className="ew-time"><Icon name="time" size={11} /> {t.build}s</span>
      {locked && <span className="ew-lock">{t.level > level ? `Lv${t.level}` : research ? 'Research' : need ? 'Expansion' : lock?.badge}</span>}
      {queued > 0 && <span className="ew-qbadge">{queued}</span>}
    </button>
  )
  if (locked || campaign) return card
  if (launch) {
    // No reinforcements for its class in this battle: the card alone.
    if (!reinf) return card
    return (
      <div className="ew-shipwrap">
        {card}
        <button
          className={`ew-reservebtn is-price ${whyReserve ? 'is-off' : ''}`}
          onClick={(e) => onBuild(t.id, shiftOf(e) ? 5 : 1, true)}
          onContextMenu={(e) => {
            e.preventDefault()
            onUnqueue(t.id)
          }}
          data-tip={`Call in reinforcement: ${t.name} for ${reinf.price} credits (${t.cost} + ${reinf.pct}%). It is built as usual, then waits in hyperspace (the fleet inventory) until you drag it onto any spot your fleet can see. Shift-click for five, right-click to remove one.${whyReserve ? `\n\n${whyReserve}` : ''}`}
          aria-label={`Call in reinforcement: ${t.name}, ${reinf.price} credits`}
        >
          <Icon name="jump" size={10} />
          <b>{reinf.price}</b>
        </button>
      </div>
    )
  }
  // The old cards: strike craft launch from the hangar; everything else goes to the fleet inventory,
  // or with the small button jumps straight in beside the station.
  if (fromHangar(t)) return card
  return (
    <div className="ew-shipwrap">
      {card}
      <button
        className={`ew-reservebtn ${why ? 'is-off' : ''}`}
        onClick={(e) => onBuild(t.id, shiftOf(e) ? 5 : 1, false)}
        data-tip={`Build a ${t.name} that jumps in beside ${where} as soon as it's done, instead of going to the fleet inventory. Shift-click for five.${why ? `\n\n${why}` : ''}`}
        aria-label={`Build a ${t.name} that jumps in at ${where}`}
      >
        <Icon name="jump" size={13} />
      </button>
    </div>
  )
}

/** How many holo projectors stand on the station window's edge. */
const PROJECTORS = 5

/**
 * The station's build queue: a row of little holo projectors standing on the top edge of its
 * window. Each queued ship is a hologram in its projector's beam, the one being built lighting up
 * from the bottom as it goes (the rest of it stays faint); a projector with nothing queued is off.
 * Click a hologram to cancel that ship (refunded).
 */
export type QueueItem = { unit: string; left: number; total: number; reserve?: boolean; sprite?: string; name?: string }
export function BuildQueue({ queue, onCancel, max = MAX_QUEUE, campaign = false, at = 'the station', rush, launch = false }: {
  queue: QueueItem[]; onCancel: (i: number) => void; max?: number; campaign?: boolean; /** Where its ships jump in: the station, or the yard it belongs to. */ at?: string
  /** New ships fly out (a battle with reinforcement rules): a reinforcement is the one marked. */
  launch?: boolean
  /** A Capital Yard with Rushed construction researched and its ship far enough along: the Rush
   * launch button (see RushButton). */
  rush?: RushProps
}) {
  const art = unitArt
  return (
    <div className="ew-buildq" aria-label={`Build queue: ${queue.length} of ${max}`}>
      {Array.from({ length: PROJECTORS }, (_, i) => {
        const q = queue[i]
        if (!q)
          return (
            <span key={i} className="ew-holo is-off" data-tip={i === 0 ? 'Build queue: empty. Click a ship card to build one.' : undefined}>
              <span className="ew-holo-base" />
            </span>
          )
        const t = UNIT[q.unit] as UnitType | undefined
        const sprite = q.sprite ?? t?.sprite ?? ''
        const name = q.name ?? t?.name ?? q.unit
        const done = i === 0 ? 1 - q.left / q.total : 0
        const where = !t ? `at ${at}` : campaign ? 'joins the fleet in orbit' : q.reserve ? (launch ? 'a reinforcement, for the fleet inventory' : 'for the fleet inventory') : launch ? `flies out of ${at === 'the station' ? "the station's hangar" : at}` : fromHangar(t) ? 'from the hangar' : `jumps in at ${at}`
        return (
          <button key={i} className={`ew-holo ${i === 0 ? 'is-building' : ''}`} onClick={() => onCancel(i)}
            onContextMenu={(e) => {
              e.preventDefault()
              onCancel(i)
            }}
            data-tip={`${name}, ${where}${i === 0 ? `: ${Math.round(done * 100)}%, ${Math.ceil(q.left)} s left` : `: waiting (${i + 1} in the queue)`}.\nClick or right-click to cancel (full refund).`}>
            <span className="ew-holo-beam" />
            <span className="ew-holo-ship">
              <img className="is-dim" src={art(sprite)} alt="" draggable={false} />
              <img className="is-lit" src={art(sprite)} alt="" draggable={false} style={{ clipPath: `inset(${(1 - done) * 100}% 0 0 0)` }} />
            </span>
            <span className="ew-holo-base" />
            {i === 0 && <em>{Math.ceil(q.left)}s</em>}
            {!campaign && t && (launch ? !!q.reserve : !q.reserve && !fromHangar(t)) && <Icon name="jump" size={10} />}
          </button>
        )
      })}
      {queue.length > PROJECTORS && <span className="ew-holo-more" data-tip={`${queue.length - PROJECTORS} more queued`}>+{queue.length - PROJECTORS}</span>}
      {rush && <RushButton {...rush} />}
    </div>
  )
}

/** How long a finger holds Rush launch down to confirm it. */
const RUSH_HOLD_MS = 600
export type RushProps = { share: number; why: string | null; onRush: () => void; /** Its tooltip, where the default (a skirmish yard's) doesn't fit. */ tip?: string }
/**
 * Rush launch: sends the Capital Yard's ship out now, unfinished. A click with a mouse; on a touch
 * screen it has to be held (a ring fills round it) so a stray tap can't throw a ship away. Disabled
 * while the yard's cooldown runs, with the time left on it.
 */
function RushButton({ share, why, onRush, tip }: RushProps) {
  const [hold, setHold] = useState(false)
  const timer = useRef(0)
  const touched = useRef(false)
  useEffect(() => () => clearTimeout(timer.current), [])
  const label = why?.startsWith('Ready again in ') ? `Rush launch · ${why.slice('Ready again in '.length)}` : `Rush launch (${Math.floor(share * 100)}%)`
  const stop = () => {
    clearTimeout(timer.current)
    setHold(false)
  }
  return (
    <button
      className={`ew-rush ${hold ? 'is-holding' : ''}`}
      disabled={!!why}
      onPointerDown={(e) => {
        touched.current = false
        if (why || !isTouch(e)) return
        touched.current = true
        setHold(true)
        timer.current = window.setTimeout(() => {
          setHold(false)
          onRush()
        }, RUSH_HOLD_MS)
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        // A finger confirms by holding (above), not by the tap that ends the hold.
        if (touched.current) return void (touched.current = false)
        onRush()
      }}
      data-tip={tip ? `${tip}${why ? `\n\n${why}` : ''}\n\nOn a touch screen: hold it down to confirm.` : `Rush launch: the ship in progress jumps out now, ${Math.floor(share * 100)}% built. It comes out with that share of its hull, no shields and its last turrets in scaffolding (they don't fire); a Drydock, repair craft or engineers finish it, taking the build time it had left. The yard then can't rush for a while, and its next ship builds slower.${why ? `\n\n${why}` : ''}${'\n\nOn a touch screen: hold it down to confirm.'}`}
    >
      <svg className="ew-rush-ring" viewBox="0 0 20 20" aria-hidden>
        <circle cx="10" cy="10" r="8" pathLength={1} style={{ animationDuration: `${RUSH_HOLD_MS}ms` }} />
      </svg>
      {label}
    </button>
  )
}

/** A rush-launched ship's state, for its card and tooltip (null when it is finished). */
/** A rushed ship's state in a few words, for its card (rushNote has the whole of it, for the tooltip). */
export function rushShort(u: Unit) {
  if (!u.rush) return null
  const all = u.t.hardpoints.filter((h) => h.kind !== 'engine').length
  return `Rushed: ${u.rush.parts.length} of ${all} parts to install · ${Math.ceil(u.rush.left)} s of work`
}
export function rushNote(u: Unit) {
  if (!u.rush) return null
  const all = u.t.hardpoints.filter((h) => h.kind !== 'engine')
  const noun = all.every((h) => h.weapon) ? 'turrets' : 'turrets and modules'
  return `Rushed: ${u.rush.parts.length} of ${all.length} ${noun} not yet installed · ${Math.ceil(u.rush.left)} s of work to finish it (a Drydock, repair craft or engineers)`
}

/**
 * The fleet inventory: ships built and waiting in hyperspace, one tile per type. Drag a tile onto
 * the battlefield to call one in; it takes a moment to arrive.
 */
export function ReserveTray({ reserve, onGrab, onClose, launch = false }: { reserve: string[]; onGrab: (id: string, e: React.PointerEvent) => void; onClose: () => void
  /** A battle with reinforcement rules: what waits here are the reinforcements bought. */
  launch?: boolean
}) {
  const art = unitArt
  const kinds = [...new Set(reserve)]
  return (
    <Floating id="reserve" title="Fleet inventory" at={{ left: 12, top: 56 }} onClose={onClose} className="ew-reserve">
      {kinds.length ? (
        <>
          <div className="ew-reserve-tiles">
            {kinds.map((id) => (
              <button key={id} className="ew-reserve-tile" onPointerDown={(e) => onGrab(id, e)} data-tip={`${UNIT[id].name}: drag onto the battlefield to call one in`}>
                <img src={art(UNIT[id].sprite)} alt="" draggable={false} />
                <span>{UNIT[id].name}</span>
                <b>×{reserve.filter((x) => x === id).length}</b>
              </button>
            ))}
          </div>
          <small className="ew-muted">Drag a ship to any open spot your fleet can see. Nebulas are fine; an asteroid field costs {Math.round(FIELD_DAMAGE * 100)}% of its hull.</small>
        </>
      ) : (
        <small className="ew-muted">{launch ? 'Empty. Reinforcements (the red corner button on a ship\'s card) wait here, built, until you call them in.' : 'Empty. Ships you build at the station (except fighters and bombers) wait here until you call them in.'}</small>
      )}
    </Floating>
  )
}

/** Where a window sits until it's moved: distances from the screen's edges, like CSS. */
export type Anchor = { left?: number; right?: number; top?: number; bottom?: number }

/** What a drag can't start on: the controls inside a window. */
const NO_DRAG = 'button, input, select, textarea, canvas, a, [data-nodrag]'

/**
 * A window that floats over the battle and can be dragged by any empty part of it. Until it's
 * moved it sits at `at`, measured from the screen's edges (so a window in the bottom corner stays
 * there as it grows); once moved, the layout (layout.ts) keeps it there for the rest of the
 * battle. Double-clicking an empty part puts it back. `bare` leaves the frame to the content (a
 * panel that draws its own); otherwise it gets one with `title` in its header.
 */
export function Floating({ id, title, at, onClose, aside, onMove, bare, className = '', layout = battleLayout, vars, children }: {
  id: string
  /** Where its position is kept: the battle's layout, or the galaxy map's. */
  layout?: LayoutStore
  title?: string
  at: Anchor
  onClose?: () => void
  aside?: ReactNode
  onMove?: (box: { x: number; y: number; w: number; h: number }, root: { w: number; h: number }) => void
  bare?: boolean
  className?: string
  /** CSS custom properties for its stylesheet rules (the unit card's room beside the map, say). */
  vars?: Record<`--${string}`, string>
  children: ReactNode
}) {
  layout.useLayoutVersion()
  const moved = layout.panelPos(id)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const pos = drag ?? moved
  /** A position (inside the screen's box) moved inside the screen with a margin, below the top
   * bar: where a drag can take it (see fit.ts). */
  const clamp = (x: number, y: number) => {
    const el = box.current
    const root = el?.parentElement
    if (!el || !root) return { x, y }
    const rr = root.getBoundingClientRect()
    const p = clampToViewport({ x: rr.left + x, y: rr.top + y, w: el.offsetWidth, h: el.offsetHeight }, screenArea(root, undefined, topBarInset(root)))
    return { x: p.x - rr.left, y: p.y - rr.top }
  }
  // Wherever it sits (its default spot, or where it was dragged), all of it stays on the screen:
  // pushed up off the bottom, in from the sides, below the top bar, as the window is resized or
  // its content grows. Measured before it reports its box below, so that box is where it shows.
  useKeepInside(box, { root: () => box.current?.parentElement ?? null, top: topBarInset })
  // Tell whoever lays out round it where it is, after every change. Whoever that is may move other
  // panels in turn, so this must settle: only a box that changed by a whole pixel is reported, in
  // the screen's own coordinates (however it got scrolled), and a box that keeps changing as fast as
  // it's reported (laying out round it moves it again) is reported at most once a frame until it
  // holds still, rather than over and over until React gives up ("Maximum update depth exceeded").
  const report = useRef({ key: '', onMove, t: 0, n: 0, slow: false, raf: 0 })
  const tell = (fromFrame = false) => {
    const el = box.current
    const root = el?.parentElement
    const g = report.current
    if (!el || !root || !onMove) return
    const r = el.getBoundingClientRect()
    const rr = root.getBoundingClientRect()
    const b = { x: r.left - rr.left + root.scrollLeft, y: r.top - rr.top + root.scrollTop, w: r.width, h: r.height }
    const key = [b.x, b.y, b.w, b.h, rr.width, rr.height].map(Math.round).join()
    if (key === g.key && onMove === g.onMove) {
      g.slow = false
      return
    }
    const now = performance.now()
    if (now - g.t > 50) (g.t = now), (g.n = 0)
    if ((g.slow || ++g.n > 8) && !fromFrame) {
      g.slow = true
      g.raf ||= requestAnimationFrame(() => ((g.raf = 0), tellRef.current(true)))
      return
    }
    g.key = key
    g.onMove = onMove
    onMove(b, { w: rr.width, h: rr.height })
  }
  const tellRef = useRef(tell)
  tellRef.current = tell
  useLayoutEffect(() => tell())
  useEffect(() => () => cancelAnimationFrame(report.current.raf), [])
  const lastPointer = useRef('mouse')
  const grab = (e: React.PointerEvent) => {
    lastPointer.current = e.pointerType
    if (e.button !== 0 || (e.target as Element).closest(NO_DRAG)) return
    // A finger on a panel's body scrolls or taps it: only its header (or a handle) moves it.
    if (isTouch(e) && !(e.target as Element).closest('.ew-float-head, [data-drag-handle]')) return
    const el = box.current
    const root = el?.parentElement
    if (!el || !root) return
    e.preventDefault()
    const r = el.getBoundingClientRect()
    const rr = root.getBoundingClientRect()
    const start = { px: e.clientX, py: e.clientY, x: r.left - rr.left, y: r.top - rr.top }
    let last = { x: start.x, y: start.y }
    let went = false
    const move = (ev: PointerEvent) => {
      if (!went && Math.hypot(ev.clientX - start.px, ev.clientY - start.py) < 4) return
      went = true
      last = clamp(start.x + ev.clientX - start.px, start.y + ev.clientY - start.py)
      setDrag(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (went) layout.setPanelPos(id, last)
      setDrag(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const reset = (e: React.MouseEvent) => {
    if (lastPointer.current === 'touch') return
    if (!(e.target as Element).closest(NO_DRAG)) layout.setPanelPos(id, undefined)
  }
  const style: React.CSSProperties = { ...(pos ? { left: pos.x, top: pos.y } : at), ...vars }
  return (
    <div ref={box} className={`ew-float ${bare ? 'is-bare' : ''} ${pos ? 'is-moved' : ''} ${className}`} style={style} onPointerDown={grab} onDoubleClick={reset}>
      {bare ? (
        children
      ) : (
        <section className="ew-frame">
          <div className="ew-frame-in">
            <header className="ew-frame-head ew-float-head" data-tip="Drag any empty part to move it; double-click to put it back">
              <h4>{title}</h4>
              {aside}
              {onClose && <button className="ew-close" onClick={onClose} aria-label={`Close the ${(title ?? 'panel').toLowerCase()}`}>×</button>}
            </header>
            {children}
          </div>
        </section>
      )}
    </div>
  )
}

const EARN: [EarnSource, string, string][] = [
  ['station', 'Station', '#59c8ff'],
  ['mines', 'Mining', '#4fe3d8'],
  ['beacons', 'Beacons', '#c8d4ee'],
  ['salvage', 'Salvage', '#f2c14a'],
  ['refunds', 'Retreat refunds', '#c890ff'],
]
const SPEND: [SpendKind, string, string][] = [
  ['ships', 'Ships', '#ff9a6e'],
  ['research', 'Research', '#b08cff'],
  ['structures', 'Platforms', '#7dffa0'],
  ['repairs', 'Repairs', '#ffd36e'],
]
const LEDGER_COLOR: Record<LedgerEntry['kind'], string> = { ships: '#ff9a6e', research: '#b08cff', structures: '#7dffa0', repairs: '#ffd36e', salvage: '#f2c14a', refund: '#c890ff', cancel: '#9fb0c8', gift: '#59c8ff' }

/** Credits and income over the battle: credits as a gold area, income per minute as a green line,
 * each on its own scale. */
function EconomyChart({ history, now }: { history: { t: number; credits: number; income: number }[]; now: number }) {
  const W = 360
  const H = 110
  if (history.length < 2) return <div className="ew-econ-chart is-empty ew-muted ew-small">The chart fills in as the battle goes on.</div>
  const maxC = Math.max(100, ...history.map((h) => h.credits))
  const maxI = Math.max(1, ...history.map((h) => h.income))
  const x = (t: number) => (t / Math.max(1, now)) * W
  const yc = (v: number) => H - 4 - (v / maxC) * (H - 14)
  const yi = (v: number) => H - 4 - (v / maxI) * (H - 14)
  const credits = history.map((h, i) => `${i ? 'L' : 'M'}${x(h.t).toFixed(1)} ${yc(h.credits).toFixed(1)}`).join(' ')
  const income = history.map((h, i) => `${i ? 'L' : 'M'}${x(h.t).toFixed(1)} ${yi(h.income).toFixed(1)}`).join(' ')
  const last = history[history.length - 1]
  return (
    <div className="ew-econ-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Credits and income over the battle">
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} className="ew-econ-grid" />)}
        <path d={`${credits} L${x(last.t).toFixed(1)} ${H} L${x(history[0].t).toFixed(1)} ${H} Z`} className="ew-econ-area" />
        <path d={credits} className="ew-econ-credits" />
        <path d={income} className="ew-econ-income" />
      </svg>
      <div className="ew-econ-legend">
        <span><i className="is-credits" /> Credits (peak {fmt(maxC)})</span>
        <span><i className="is-income" /> Income (peak +{fmt(maxI * 60)}/min)</span>
        <span className="ew-muted">{clock(history[0].t)}–{clock(now)}</span>
      </div>
    </div>
  )
}

/** Rows with a bar each, sized against the biggest. */
function Breakdown({ rows }: { rows: { label: string; color: string; value: number; note?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div className="ew-econ-rows">
      {rows.map((r) => (
        <div key={r.label} className="ew-econ-row">
          <span><i style={{ background: r.color }} /> {r.label}{r.note && <small className="ew-muted"> {r.note}</small>}</span>
          <span className="ew-econ-bar"><b style={{ width: `${(r.value / max) * 100}%`, background: r.color }} /></span>
          <b>{fmt(r.value)}</b>
        </div>
      ))}
    </div>
  )
}

/**
 * The economy: credits now and coming in, where the income comes from, credits over the battle,
 * what was earned and spent by kind, refunds on their way, and the latest purchases and payouts.
 */
/** A ledger line as the economy shows it: a gift names the ally. */
const ledgerWhat = (e: LedgerEntry, names?: string[]) =>
  e.kind === 'gift' && e.seat !== undefined && names?.[e.seat] ? (e.amount < 0 ? `Sent to ${names[e.seat]}` : `From ${names[e.seat]}`) : e.what

export function EconomyPanel({ w, me, onClose, names }: { w: World; me: Owner; onClose: () => void; /** Players' names by seat, for gifts. */ names?: string[] }) {
  const p = w.players[me]
  const parts = p.incomeParts
  const mines = w.units.filter((u) => u.owner === me && !u.dead && u.t.tier === 'mine').length
  const beacons = w.beacons.filter((b) => b.owner === p.team).length
  const pending = p.refunds.reduce((s, r) => s + r.amount, 0)
  const total = parts.station + parts.mines + parts.beacons
  return (
    <Floating id="economy" title="Economy" at={{ left: 120, top: 56 }} onClose={onClose} className="ew-econ">
      <div className="ew-econ-top">
        <div>
          <small className="ew-muted">Credits</small>
          <b className="ew-gold">{fmt(p.credits)}</b>
        </div>
        <div>
          <small className="ew-muted">Income</small>
          <b className="ew-good">+{fmt(p.income * 60)}<small> /min</small></b>
        </div>
        <div>
          <small className="ew-muted">Refunds due</small>
          <b className={pending ? 'ew-refund' : 'ew-muted'}>{pending ? `+${fmt(pending)}` : 'none'}</b>
        </div>
      </div>
      <h5>Income now</h5>
      <div className="ew-econ-stack" aria-hidden>
        {total > 0 && (['station', 'mines', 'beacons'] as const).map((k) => <i key={k} style={{ width: `${(parts[k] / total) * 100}%`, background: EARN.find((e) => e[0] === k)![2] }} />)}
      </div>
      <Breakdown rows={[
        { label: 'Station', color: '#59c8ff', value: parts.station * 60, note: `level ${p.level}` },
        { label: 'Mining', color: '#4fe3d8', value: parts.mines * 60, note: `${mines} platform${mines === 1 ? '' : 's'}` },
        { label: 'Beacons', color: '#c8d4ee', value: parts.beacons * 60, note: `${beacons} held` },
      ]} />
      {(p.gave || p.got) && (
        <>
        <h5>Shared with allies</h5>
        <Breakdown rows={[
          { label: 'Sent to allies', color: '#59c8ff', value: p.gave ?? 0 },
          { label: 'From allies', color: '#7dffa0', value: p.got ?? 0 },
        ]} />
        </>
      )}
      <h5>Over the battle</h5>
      <EconomyChart history={p.history} now={w.time} />
      <div className="ew-econ-cols">
        <div>
          <h5>Earned · {fmt(Object.values(p.earnedBy).reduce((a, b) => a + b, 0))}</h5>
          <Breakdown rows={EARN.map(([k, label, color]) => ({ label, color, value: p.earnedBy[k] }))} />
        </div>
        <div>
          <h5>Spent · {fmt(Object.values(p.spentBy).reduce((a, b) => a + b, 0))}</h5>
          <Breakdown rows={SPEND.map(([k, label, color]) => ({ label, color, value: p.spentBy[k] }))} />
        </div>
      </div>
      {p.refunds.length > 0 && (
        <>
          <h5>Refunds on their way</h5>
          <ul className="ew-econ-log">
            {p.refunds.map((r, i) => (
              <li key={i}>
                <span className="ew-muted">in {Math.ceil(r.at - w.time)} s</span>
                <span>{UNIT[r.unit].name} retreated</span>
                <b className="ew-refund">+{fmt(r.amount)}</b>
              </li>
            ))}
          </ul>
        </>
      )}
      <h5>Latest</h5>
      {p.ledger.length ? (
        <ul className="ew-econ-log">
          {[...p.ledger].reverse().slice(0, 12).map((e, i) => (
            <li key={i}>
              <span className="ew-muted">{clock(e.t)}</span>
              <span><i style={{ background: LEDGER_COLOR[e.kind] }} /> {ledgerWhat(e, names)}</span>
              <b className={e.amount >= 0 ? 'ew-good' : 'ew-spent'}>{e.amount >= 0 ? '+' : '−'}{fmt(Math.abs(e.amount))}</b>
            </li>
          ))}
        </ul>
      ) : (
        <small className="ew-muted">Nothing bought yet. Retreat refunds arrive {REFUND_DELAY} s after the ship jumps out.</small>
      )}
    </Floating>
  )
}

/** "Strong against cruisers, flagships · weak against gunships": the counter loop at a glance. */
/** Who a unit belongs to, as the unit card names it: ours, an ally's or an enemy's, and which side. */
export function ownerTag(w: World, me: Owner, owner: Owner) {
  const p = w.players[owner]
  const side = FACTIONS[p.faction].long
  if (owner === me) return { who: `Yours · ${side}`, rel: 'own' as const }
  const ally = p.team === w.players[me].team
  return { who: `${ally ? 'Allied' : 'Enemy'}, player ${owner + 1} · ${side}`, rel: ally ? ('ally' as const) : ('enemy' as const) }
}
/** The attributes that make an element's hover show the unit card for type `t`. */
export const unitTip = (t: UnitType, who: { who: string; rel: string }, note?: string, live?: Unit) => ({
  'data-tip-unit': t.id,
  'data-tip-who': who.who,
  'data-tip-rel': who.rel,
  ...(note ? { 'data-tip': note } : {}),
  // A unit on the field: the card shows its own hull and shields as they are now.
  ...(live ? { 'data-tip-uid': String(live.id) } : {}),
})

/** The unit card for something on the battlefield, beside the cursor, with its live hull and shields. */
export function FieldIntel({ w, me, id, x, y }: { w: World; me: Owner; id: number; x: number; y: number }) {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const b = box.current
    const root = b?.parentElement
    if (!b || !root) return
    // Down and to the right of the cursor; flipped to the other side near the edges, and kept
    // inside the screen (fit.ts).
    const rr = root.getBoundingClientRect()
    const area = screenArea(root)
    const px = rr.left + x
    const py = rr.top + y
    const right = px + 18 + b.offsetWidth > area.right
    const below = py + 18 + b.offsetHeight > area.bottom
    const p = clampToViewport({ x: right ? px - 18 - b.offsetWidth : px + 18, y: below ? py - 18 - b.offsetHeight : py + 18, w: b.offsetWidth, h: b.offsetHeight }, area)
    b.style.left = `${p.x - rr.left}px`
    b.style.top = `${p.y - rr.top}px`
    b.style.visibility = 'visible'
  })
  const u = w.byId.get(id)
  if (!u || u.dead) return null
  const o = ownerTag(w, me, u.owner)
  return (
    <div ref={box} className="ew-tip is-unit" role="tooltip" style={{ visibility: 'hidden' }}>
      <UnitIntel t={u.t} who={o.who} rel={o.rel} live={u} />
    </div>
  )
}

const RANGE = (t: UnitType) => Math.max(0, ...[...t.weapons, ...t.hardpoints.flatMap((h) => (h.weapon ? [h.weapon] : []))].map((x) => x.range))
/** The unit card: what a ship type is, what it beats and loses to, its numbers, and its price. */
export function UnitIntel({ t, who, rel, note, live }: { t: UnitType; who?: string; rel?: string; note?: string; live?: Unit }) {
  const r = roleOf(t)
  // A squadron's guns together.
  const n = t.squad
  const fire = [
    ['Fighters', dpsVs(t, 'fighter') * n],
    ['Warships', dpsVs(t, 'frigate') * n],
    ['Capitals', dpsVs(t, 'capital') * n],
    ['Structures', dpsVs(t, 'station') * n],
  ] as const
  const top = Math.max(1, ...fire.map(([, v]) => v))
  const hull = live ? live.hullMax : t.hull
  const ab = t.ability ? abilityOf(t.ability, t.faction) : null
  return (
    <div className={`ew-intel is-${rel ?? 'own'}`}>
      <header>
        <ShipArt t={t} />
        <div>
          <strong>{t.name}{t.squad > 1 ? ` ×${t.squad}` : ''}</strong>
          <small>{t.tier === 'capital' ? 'flagship' : t.tier}{r ? ` · ${r.role}` : ''}</small>
          {who && <em>{who}</em>}
        </div>
      </header>
      <p>{t.blurb}</p>
      {live?.rush && <p className="ew-intel-rush">{rushNote(live)}</p>}
      {r && (
        <div className="ew-intel-vs">
          <span className="is-strong"><b>Strong vs</b> {r.strong.join(', ')}</span>
          <span className="is-weak"><b>Weak vs</b> {r.weak.join(', ')}</span>
        </div>
      )}
      <dl className="ew-intel-stats">
        <div><dt>Hull{n > 1 ? ' (each)' : ''}</dt><dd>{Math.round(live ? live.hull : hull)}{live ? ` / ${Math.round(hull)}` : ''}</dd></div>
        <div><dt>Shields</dt><dd>{t.shield ? `${Math.round(live ? live.shield : t.shield)}${live ? ` / ${Math.round(shieldFull(live))}` : ''} · +${t.regen}/s` : 'none'}</dd></div>
        <div><dt>Speed</dt><dd>{Math.round(t.speed) || 'fixed'}</dd></div>
        <div><dt>Range</dt><dd>{RANGE(t) || '—'}</dd></div>
        <div><dt>Sensors</dt><dd>{t.sensor}</dd></div>
        <div><dt>Fleet size</dt><dd>{t.pop}</dd></div>
      </dl>
      <small className="ew-intel-h">Damage per second{n > 1 ? ', whole squadron,' : ''} against</small>
      <div className="ew-intel-fire" aria-label="Damage per second">
        {fire.map(([k, v]) => (
          <div key={k}>
            <span>{k}</span>
            <i><b style={{ width: `${(v / top) * 100}%` }} /></i>
            <em>{Math.round(v)}</em>
          </div>
        ))}
      </div>
      {ab && <p className="ew-intel-ab"><b>{ab.name}:</b> {ab.blurb}</p>}
      {traits(t).map((x) => <p key={x.name} className="ew-intel-ab">{x.tip}</p>)}
      {t.kind === 'wing' && (
        <p className="ew-intel-ab">
          <b>Home defense:</b> weaker away from the station. Within {fmt(DEFENSE_WING.radius)} of it full strength; further out, or once it's gone, {Math.round(DEFENSE_WING.away * 100)}% damage. Free, no fleet space, and rebuilt by the station's hangar when lost.
        </p>
      )}
      {live && live.rank > 0 && <p className="ew-intel-ab"><b>{RANKS[live.rank]}</b> · {live.kills} kills</p>}
      {t.tier !== 'station' && t.kind !== 'wing' && <footer>
        <span className="ew-cost"><Icon name="credits" size={12} /> {t.cost}</span>
        <span className="ew-time"><Icon name="time" size={12} /> {t.build} s</span>
        {t.level > 1 && <span className="ew-intel-lv">Station level {t.level}</span>}
        {t.tech && <span className="ew-intel-lv">Research: {TECH[t.tech].name}</span>}
      </footer>}
      {note && <p className="ew-intel-note">{note}</p>}
    </div>
  )
}

/** "Escorted by 3" on a ship card: the ships flying over it as its escort (one ship's card). */
function EscortLine({ w, u }: { w: World; u: Unit }) {
  const n = isShip(u.t) && u.t.tier !== 'fighter' ? escortsOf(w, u).length : 0
  if (!n) return null
  return (
    <span className="ew-escorted" data-tip="Ships told to guard this one fly over its hull as its escort: they move with it, take on what comes near it, and repair ships mend it first.">
      <Icon name="hold" size={12} /> Escorted by {n}
    </span>
  )
}

function orderText(w: World, u: Unit) {
  if (building(u)) return `Under construction: ${Math.ceil(u.building)} s`
  const o = u.order
  const mend = mendTarget(w, u)
  if (mend) return `Field repair: ${mend.t.name}`
  if (o.k === 'move') return o.attack ? 'Attack-moving' : 'Moving'
  if (u.retreat > 0) return `Charging hyperspace drive: jumping out in ${Math.ceil(u.retreat)} s`
  if (o.k === 'patrol') return 'Patrolling'
  if (o.k === 'mend') {
    const t = w.byId.get(o.id)
    return t ? `Repairing ${t.owner === u.owner ? '' : 'allied '}${t.t.name}` : 'Repairing'
  }
  if (o.k === 'guard') {
    const g = w.byId.get(o.id)
    return g ? `${escorts(u, g) ? 'Escorting' : 'Guarding'} ${g.t.name}` : 'Guarding'
  }
  if (o.k === 'area') {
    const t = u.target ? w.byId.get(u.target) : undefined
    return t ? `Area attack: ${t.t.name}` : 'Area attack: closing in'
  }
  if (o.k === 'attack') {
    const t = w.byId.get(o.id)
    return t ? `Attacking ${t.t.name}${o.hp >= 0 ? `: ${hpName(t.t.hardpoints[o.hp], t.t.faction).toLowerCase()}` : ''}` : 'Attacking'
  }
  const t = u.target ? w.byId.get(u.target) : undefined
  if (t) return `Engaging ${t.t.name}`
  return u.stance === 'hold' ? 'Holding position' : 'Idle'
}

/** The longer story of a unit, for the ⓘ on its card: what it is, a rushed ship's state, what it is
 * strong and weak against, a mine's earnings, how its guns pick targets (our structures) and how to
 * aim at an enemy's hardpoints. The card itself keeps to a few short rows. */
function unitInfo(w: World, me: Owner, u: Unit, coarse: boolean) {
  const t = u.t
  const mine = u.owner === me
  const enemy = w.players[u.owner].team !== w.players[me].team
  const r = roleOf(t)
  const out: string[] = [t.blurb]
  if (u.rush) out.push(rushNote(u)!)
  if (r) out.push(`${r.role}\nStrong vs ${r.strong.join(', ')}\nWeak vs ${r.weak.join(', ')}`)
  for (const x of traits(t)) out.push(x.tip)
  if (mine && t.tier === 'mine' && !building(u)) out.push(mineEarning(w, me, u).long)
  if (mine && !isShip(t) && u.guns.length > 0) out.push(GUNS_TIP)
  if (mine && (t.support || t.ability === 'fieldRepair'))
    out.push(`${coarse ? 'Long-press' : 'Right-click'} a damaged ship of ours or an ally's${t.support ? '' : ' (gunship class or bigger, or a station)'} to repair it: ${t.support ? 'it stays in reach' : 'the crew stays with it, welding whenever Field repair is ready,'} until it is whole, then goes back to what it was guarding or escorting.`)
  if (enemy && u.hps.length > 0) out.push(coarse ? 'Select your ships, then long-press a marker on this one and pick Attack to target that hardpoint.' : 'Select your ships, hover this one and right-click a marker to target that hardpoint.')
  return out.join('\n\n')
}

/**
 * Lines of a card that give way when it runs out of height: each element marked `data-fit` is hidden
 * (lowest number first) while the column `ref` would otherwise scroll, and shown again when there is
 * room. It measures when the card's rows change (`key`) and when the column is resized, never per
 * frame, and sets the `hidden` attribute itself: no React state, so no extra renders.
 */
function useFitLines(ref: { current: HTMLElement | null }, key: string) {
  useLayoutEffect(() => {
    const col = ref.current
    if (!col) return
    const fit = () => {
      const lines = [...col.querySelectorAll<HTMLElement>('[data-fit]')].sort((a, b) => Number(a.dataset.fit) - Number(b.dataset.fit))
      for (const l of lines) l.hidden = false
      for (const l of lines) {
        if (col.scrollHeight <= col.clientHeight + 1) break
        l.hidden = true
      }
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(col)
    return () => ro.disconnect()
  }, [ref, key])
}

/**
 * One kind of unit selected (a ship, a squadron, several of a type, a platform): a few short rows,
 * so the card fits its 240 px without scrolling. The header has its name, class, rank, a ⓘ with the
 * longer story (see unitInfo), what it is doing and Retreat; then thin hull and shield bars, its
 * hardpoints, and what it can do: engineers' yards to build, a platform's upgrades, the research for
 * its type.
 */
function UnitDetail(p: DetailProps & { u: Unit; squad: Unit[] }) {
  const art = unitArt
  const { u, squad, me, w } = p
  const coarse = useCoarse()
  const t = u.t
  const mine = u.owner === me
  const ally = !mine && w.players[u.owner].team === w.players[me].team
  const one = squad.length === 1
  const earning = mine && one && t.tier === 'mine' && !building(u) ? mineEarning(w, me, u) : null
  const techs = mine ? techsFor(t.id) : []
  const r = roleOf(t)
  // The description and the role line show while they fit (the ⓘ has them too): what decides that
  // is which rows the card has, so it is measured again only when that changes.
  const col = useRef<HTMLDivElement>(null)
  const escorted = mine && one && isShip(t) && t.tier !== 'fighter' ? escortsOf(w, u).length > 0 : false
  const reboot = t.shield > 0 && SHIELD_REBOOT - (w.time - u.shieldOut) > 0
  useFitLines(col, [t.id, squad.length, mine, !!u.rush, escorted, u.nebula, reboot, !!earning, building(u), u.repair > 0, u.focus, !!p.turretPick, u.hps.some((h) => h.hp < h.max)].join('|'))
  return (
    <Frame className={`ew-detail is-unit ${mine ? '' : ally ? 'is-ally' : 'is-enemy'}`}>
      <div className="ew-detail-side">
        {u.hps.length ? <Schematic u={u} size={104} tip={unitTip(t, ownerTag(w, me, u.owner), undefined, u)} /> : <img className="ew-portrait" src={art(t.sprite)} alt="" {...unitTip(t, ownerTag(w, me, u.owner), undefined, u)} />}
      </div>
      <div className="ew-detail-main" ref={col}>
        <header className="ew-unithead">
          <strong {...unitTip(t, ownerTag(w, me, u.owner), undefined, u)}>
            {t.name}
            {squad.length > 1 ? ` ×${squad.length}` : ''}
          </strong>
          <span className={`ew-tag ${mine ? '' : ally ? 'is-ally' : 'is-enemy'}`}>{mine ? t.tier : `${ally ? 'allied' : 'enemy'} ${t.tier}`}</span>
          {u.rank > 0 && <span className="ew-rank" data-tip={`${RANKS[u.rank]}: +${Math.round(RANK_BONUS * u.rank * 100)}% damage, hull and shield recharge`}>{'⌃'.repeat(u.rank)} {RANKS[u.rank]}</span>}
          <InfoDot tip={unitInfo(w, me, u, coarse)} />
          {mine && one && <EscortLine w={w} u={u} />}
          {mine && (
            <span className="ew-muted ew-small ew-orders" data-tip={earning?.long}>
              {earning ? earning.short : orderText(w, u)}
              {u.kills > 0 ? ` · ${u.kills} kills` : ''}
            </span>
          )}
          {mine && <RetreatIcon ships={squad.filter((x) => x.owner === me)} onRetreat={p.onRetreat} />}
        </header>
        {/* What sets it apart (faction mechanics): a chip each, the whole story in its tip; given up
            after the description and the role line when room runs out. */}
        {traits(t).length > 0 && (
          <span className="ew-traits" data-fit="3">
            {traits(t).map((x) => <span key={x.name} className="ew-tag" data-tip={x.tip}>{x.name} {x.value}</span>)}
          </span>
        )}
        {/* Given up first when room runs out: the description, then the role line. */}
        <span className="ew-muted ew-small ew-fit-desc" data-fit="1">{t.blurb}</span>
        {r && (
          <span className="ew-counters ew-fit-role" data-fit="2">
            <b>{r.role}</b>
            <span className="is-strong">Strong vs {r.strong.join(', ')}</span>
            <span className="is-weak">Weak vs {r.weak.join(', ')}</span>
          </span>
        )}
        <Vitals u={u} squad={squad} now={w.time} compact />
        {u.rush && <span className="ew-rushnote" data-tip={rushNote(u) ?? undefined}>{rushShort(u)}</span>}
        {(u.hps.length > 0 || (mine && one && (t.tier === 'mine' || t.tier === 'defense'))) && (
          <div className="ew-unitrow">
            {u.hps.length > 0 && <HpSummary u={u} />}
            {mine && one && (t.tier === 'mine' || t.tier === 'defense') && <RepairButton w={w} me={me} u={u} onRepair={p.onRepair} />}
          </div>
        )}
        {/* Engineers: the yards they can build, and how. */}
        {mine && isEngineer(t) && w.hybrid && <EngineerBuild w={w} me={me} crew={squad.filter((x) => x.owner === me && isEngineer(x.t))} onPlace={p.onPlace} onSelect={p.onSelect} />}
        {mine && one && !isShip(t) && u.guns.length > 0 && !building(u) && <FocusInfo w={w} u={u} pick={p.turretPick} onClear={p.onClearFocus} quiet />}
        {mine && one && t.tier === 'mine' && !building(u) && <SiteUpgrades w={w} me={me} u={u} onUpgrade={p.onUpgradeSite} onCancel={p.onCancelUpgradeSite} />}
        {techs.length > 0 && (
          <div className="ew-unittech">
            <span className="ew-muted ew-small">Upgrades</span>
            {techs.map((x) => (
              <TechTile key={x.id} id={x.id} w={w} me={me} hud={p.hud} onResearch={p.onResearch} onCancel={p.onCancelResearch} />
            ))}
            <button className="ew-unittree" onClick={p.onTechTree} data-tip="Open the tech tree" aria-label="Tech tree">
              <Icon name="tree" size={15} />
              <span>Tech tree</span>
            </button>
          </div>
        )}
      </div>
    </Frame>
  )
}

// --- Hybrid bases --------------------------------------------------------------------------------------

/** Switches between the Command Station and our yards: one tab each, the one shown lit. A yard
 * still going up shows how far along it is. */
/**
 * The building switcher over the build panel: a small picture tab for the Command Station and each
 * of our yards (one going up shows how far along it is), and a dimmed one for a yard's ruin, which
 * selects the engineers, whose Build section rebuilds it.
 */
function BaseTabs({ w, me, cur, onSelect, onRuin }: { w: World; me: Owner; cur: number; onSelect: (id: number) => void; onRuin?: () => void }) {
  const { keys } = useSettings()
  const st = w.byId.get(w.players[me].station)
  const yards = w.units.filter((u) => !u.dead && u.owner === me && u.t.tier === 'yard').sort((a, b) => Number(worksOf(a.t) === 'cyard') - Number(worksOf(b.t) === 'cyard'))
  const ruins = (w.ruins ?? []).filter((r) => r.owner === me && !yards.some((y) => y.t.id === r.unit))
  // Three or more: the pictures alone (names in the tooltips), so the row never wraps.
  const many = (st ? 1 : 0) + yards.length + ruins.length >= 3
  return (
    <div className={`ew-basetabs ${many ? 'is-compact' : ''}`} role="tablist" aria-label="Station and yards">
      {st && (
        <button role="tab" aria-selected={cur === st.id} className={cur === st.id ? 'is-on' : ''} onClick={() => onSelect(st.id)} data-tip={`Command Station: strike craft, gunships and engineers, and its expansions (${keyName(keys.station)})`}>
          <ShipArt t={st.t} />
          <span>Command</span>
        </button>
      )}
      {yards.map((y) => {
        const cap = worksOf(y.t) === 'cyard'
        const up = building(y)
        return (
          <button key={y.id} role="tab" aria-selected={cur === y.id} className={`${cur === y.id ? 'is-on' : ''} ${up ? 'is-site' : ''}`} onClick={() => onSelect(y.id)}
            data-tip={`${y.t.name}: ${cap ? 'cruisers and flagships' : 'frigates and corvettes'}, and its expansions (${keyName(cap ? keys.cyard : keys.yard)})${up ? `\nUnder construction: ${Math.round((1 - y.building / y.t.build) * 100)}%` : ''}`}>
            <ShipArt t={y.t} className={up ? 'is-site' : ''} />
            <span>{cap ? 'Capital' : 'Frigate'}</span>
            {up && <em>{Math.round((1 - y.building / y.t.build) * 100)}%</em>}
          </button>
        )
      })}
      {ruins.map((r) => (
        <button key={r.id} role="tab" aria-selected={false} className="is-ruin" onClick={onRuin} data-tip={`${UNIT[r.unit].name}: a ruin. Engineers rebuild it there for ${Math.round(REBUILD * 100)}% of the price (click: select them, their Build section has it).`}>
          <ShipArt t={UNIT[r.unit]} className="is-ruin" />
          <span>{r.unit.endsWith('cyard') ? 'Capital' : 'Frigate'}</span>
          <em>Ruin</em>
        </button>
      ))}
    </div>
  )
}

/** Who is welding, for a crew of `craft` engineer craft: whole squadrons (three craft each) where they are, else craft. */
const crewName = (craft: number) => {
  const sq = craft / 3
  return Number.isInteger(sq) ? `${sq} squadron${sq === 1 ? '' : 's'}` : `${craft} engineer craft`
}

/** One yard as something to build: its name, and in one short line its price (or the rebuild price
 * for a ruin), how long the selected crew takes and who that is; or how ours is doing (standing or
 * going up). A station too low for it dims the card a little and puts its level in a chip in the
 * corner, the reason in the tooltip. Click to place it with the selected engineers, or to select the
 * one we have. */
export function YardCard({ w, me, t, crew, onPlace, onSelect, hint }: { w: World; me: Owner; t: UnitType; crew: number; onPlace: (unit: string) => void; onSelect: (id: number) => void; /** How to place one, for the tooltip. */ hint: string }) {
  const { ours, ruin, cost, locked, poor, why, secs } = yardOffer(w, me, t, crew)
  const state = ours ? (building(ours) ? `Going up: ${Math.round((1 - ours.building / ours.t.build) * 100)}%` : 'Built') : null
  const tip = `${t.name}\n${t.blurb}\nEngineers build it within the Command Station's build radius: ${t.build} s for one squadron, more go faster (up to ${ENGINEERS.crew / 3}). A destroyed yard leaves its ruin: rebuilt there, it costs ${Math.round(REBUILD * 100)}% (its expansions are lost with it).\nExpansions it takes: ${modulesFor(worksOf(t) ?? 'yard', t.faction).map((m) => m.name).join(', ')}.${ours ? '\n\nClick to select it.' : why ? `\n\n${why}` : `\n\n${hint}.`}`
  const lv = locked && why?.startsWith('Needs station level') ? `Lv ${t.level}` : 'Locked'
  return (
    <button className={`ew-shipcard ew-yardcard ${locked ? 'is-locked' : poor ? 'is-poor' : ''} ${ours ? 'is-built' : ''} ${ruin ? 'is-ruin' : ''}`} onClick={() => (ours ? onSelect(ours.id) : onPlace(t.id))} {...unitTip(t, ownerTag(w, me, me), tip)}>
      <ShipArt t={t} />
      <strong>{t.name.replace(/^\S+ /, '')}{ruin && !ours ? ' (ruin)' : ''}</strong>
      {state ? (
        <span className="ew-yc-line is-state">{state}</span>
      ) : (
        <span className="ew-yc-line">
          <span className="ew-cost"><Icon name="credits" size={10} /> {ruin ? `Rebuild ${cost}` : cost}</span>
          <span className="ew-time"><Icon name="time" size={10} /> {secs}s</span>
          <span className="ew-yc-crew">{crewName(crew)}</span>
        </span>
      )}
      {locked && <span className="ew-yc-lv">{lv}</span>}
    </button>
  )
}

/**
 * The Build section of selected engineers: the yards they can put up as cards (the Frigate Yard and
 * the Capital Yard, one of them a ruin to rebuild if it was destroyed), each with its price, the
 * level it needs, and how long the selected squadrons take. Shown wherever engineers are in the
 * selection, alone or with others.
 */
export function EngineerBuild({ w, me, crew, onPlace, onSelect }: { w: World; me: Owner; crew: Unit[]; onPlace: (unit: string) => void; onSelect: (id: number) => void }) {
  const { keys } = useSettings()
  const coarse = useCoarse()
  if (!crew.length || !w.hybrid) return null
  const faction = crew[0].t.faction
  const hint = coarse ? 'Tap a card, then a spot in the build ring' : `Click a card (${keyName(keys.build)}), then a spot in the build ring`
  return (
    <section className="ew-engbuild" aria-label="Build">
      <header>
        <strong>Build</strong>
        <span className="ew-muted ew-small" data-tip={`${hint}. ${coarse ? 'Long-press' : 'Right-click'} one of our structures to repair it.`}>{hint}</span>
      </header>
      <div className="ew-yard ew-engbuild-cards">
        {yardsFor(faction).map((yt) => <YardCard key={yt.id} w={w} me={me} t={yt} crew={crew.length} onPlace={onPlace} onSelect={onSelect} hint={hint} />)}
      </div>
    </section>
  )
}

/** Where one expansion stands on a building: built (and standing, or shot off), being built,
 * waiting in the building's queue, ready to order, held back by credits or a full queue ('poor'),
 * or locked (with why). */
export type ModuleState = { status: 'built' | 'lost' | 'busy' | 'queued' | 'ready' | 'poor' | 'locked'; why: string | null; slot: number; progress: number; left: number }
export function moduleState(w: World, me: Owner, u: Unit | undefined, id: ModuleId): ModuleState {
  const slot = u?.xq?.findIndex((j) => j.id === id) ?? -1
  const j = slot >= 0 ? u!.xq![slot] : undefined
  const base = { slot, progress: j ? 1 - j.left / j.total : 0, left: j?.left ?? 0 }
  if (u?.xm?.includes(id)) return { ...base, status: expUp(u, id) ? 'built' : 'lost', why: null }
  if (j) return { ...base, status: slot === 0 ? 'busy' : 'queued', why: null }
  const lock = moduleLock(w, me, u, id)
  if (lock) return { ...base, status: 'locked', why: lock }
  const why = u ? cantExpand(w, me, u.id, id) : 'No building'
  return { ...base, status: why ? 'poor' : 'ready', why }
}

/** The tooltip for an expansion: what it does, what losing it costs, its price and time. */
export const moduleTip = (id: ModuleId) => {
  const m = MODULE[id]
  return `${m.name}: an expansion of the ${WORKS_NAME[m.on]}\n${m.blurb}\nIf it is shot off: ${m.lost} Engineers (or repair craft at the station) weld it back for ${Math.round(REBUILD_MODULE * 100)}% of its price; a repair crew mends it with the rest.\n${m.cost} credits, ${m.time} s${m.level > 1 ? `, station level ${m.level}` : ''}. Built by the ${WORKS_NAME[m.on]} itself, one at a time.`
}

/**
 * A building's expansions as a row of cards: each one built (or shot off), being built, queued,
 * ready to order or locked with the reason, with its price and time. Click one to order it;
 * right-click one queued or under way to cancel it (a full refund).
 */
export function ExpansionCards({ w, me, u, onExpand, onCancel }: { w: World; me: Owner; u: Unit; onExpand: (uid: number, id: ModuleId) => void; onCancel: (uid: number, index: number) => void }) {
  const kind = worksOf(u.t)
  const press = useCancelPress()
  if (!kind) return null
  return (
    <>
      {modulesFor(kind, u.t.faction).map((m) => {
        const s = moduleState(w, me, u, m.id)
        const line =
          s.status === 'built' ? '✓ Built'
            : s.status === 'lost' ? `Shot off · ${moduleRebuildCost(m.id)}`
              : s.status === 'busy' ? `${Math.ceil(s.left)}s left`
                : s.status === 'queued' ? `Queued #${s.slot + 1}`
                  : null
        const what = s.status === 'built' ? 'It stands: its feature works.'
          : s.status === 'lost' ? `Shot off: its feature is down. Engineers weld it back for ${moduleRebuildCost(m.id)} credits (right-click the building with them), or send a repair crew.`
            : s.status === 'busy' || s.status === 'queued' ? `Right-click to cancel (full refund: ${MODULE[m.id].cost} credits). Long-press on touch.`
              : s.status === 'ready' ? 'Click to build it.'
                : s.why ?? ''
        return (
          <button key={m.id} className={`ew-shipcard ew-modcard is-${s.status} ${s.status === 'locked' ? 'is-locked' : s.status === 'poor' ? 'is-off' : ''}`}
            onClick={() => (s.status === 'ready' || s.status === 'poor' ? onExpand(u.id, m.id) : undefined)}
            onContextMenu={(e) => {
              e.preventDefault()
              if ((s.status === 'busy' || s.status === 'queued') && !press.touched()) onCancel(u.id, s.slot)
            }}
            {...press.handlers(s.status === 'busy' || s.status === 'queued' ? () => onCancel(u.id, s.slot) : null)}
            data-tip={`${moduleTip(m.id)}\n\n${what}`} aria-label={`${m.name}: ${s.status}`}>
            <span className="ew-modicon" style={{ ['--c' as string]: HP_COLOR[m.kind] }}><HpIcon kind={m.kind} size={22} /></span>
            <strong>{m.name}</strong>
            {line ? <span className="ew-modline">{line}</span> : (
              <>
                <span className="ew-cost"><Icon name="credits" size={11} /> {m.cost}</span>
                <span className="ew-time"><Icon name="time" size={11} /> {m.time}s</span>
              </>
            )}
            {s.status === 'locked' && <span className="ew-lock">{s.why?.startsWith('Needs station level') ? `Lv${m.level}` : 'Locked'}</span>}
            {s.status === 'busy' && <i className="ew-modbar" style={{ transform: `scaleX(${s.progress})` }} />}
          </button>
        )
      })}
    </>
  )
}

/** Who is welding a site: whole squadrons where they are, else craft (more than three squadrons add
 * nothing, see ENGINEERS.crew). */
const siteCrew = (craft: number) => {
  const sq = craft / 3
  const n = Number.isInteger(sq) ? `${sq} squadron${sq === 1 ? '' : 's'}` : `${craft} engineer craft`
  return craft > ENGINEERS.crew ? `${n} (only ${ENGINEERS.crew / 3} count)` : n
}

/**
 * One of our yards: while it goes up, its progress, who is building it and a way to call it off
 * (with the refund); once built, its own queue and build cards, as the station's shipyard has.
 */
function YardDetail(p: DetailProps & { y: Unit }) {
  const { w, me, y, hud } = p
  const { lockedShips } = useSettings()
  const faction = y.t.faction
  const site = !!y.site
  const kind = worksOf(y.t) ?? 'yard'
  const ships = baseBuilds(faction).filter((t) => builtAt(t) === kind).map((t) => UNIT[t.id]).filter((t) => lockedShips || t.level <= hud.level)
  // Its ships or its expansions, on tabs down the left as the station's are; the choice is remembered.
  const [page, setPage] = useState<'ships' | 'expansions'>(() => {
    try {
      return localStorage.getItem('mvlos.empires.yardpage2') === 'expansions' ? 'expansions' : 'ships'
    } catch {
      return 'ships'
    }
  })
  const pick = (pg: 'ships' | 'expansions') => {
    setPage(pg)
    try {
      localStorage.setItem('mvlos.empires.yardpage2', pg)
    } catch {
      // Not remembered this time.
    }
  }
  const queue = y.yq ?? []
  const crews = w.units.filter((u) => !u.dead && isEngineer(u.t) && u.mending.includes(y.id)).length
  const coming = w.units.filter((u) => !u.dead && u.owner === me && isEngineer(u.t) && u.order.k === 'construct' && u.order.id === y.id).length
  const progress = 1 - y.building / y.t.build
  // Rush launch: once Rushed construction is done and the ship in progress is far enough along.
  const share = rushShare(y)
  const rush = !site && kind === 'cyard' && y.owner === me && hud.techs.includes(RUSH_TECH[faction]) && share >= rushRules(w).min ? { share, why: cantRush(w, me, y.id), onRush: () => p.onRush(y.id) } : undefined
  return (
    <div className="ew-stationwrap">
      {!site && <BuildQueue queue={queue} onCancel={(i) => p.onCancel(i, y.id)} at="the yard" rush={rush} launch={!!w.reinforce} />}
      <Frame className="ew-detail is-station is-yard">
        <div className="ew-detail-side">
          <Schematic u={y} size={96} tip={unitTip(y.t, ownerTag(w, me, y.owner), undefined, y)} />
          <SideName w={w} me={me} u={y} sub={WORKS_NAME[kind]} info={`${y.t.blurb}\n\n${GUNS_TIP}`} />
          <Vitals u={y} now={w.time} />
          <HpSummary u={y} />
          {!site && y.xm?.includes('fighterWing') && <WingInfo w={w} st={y} />}
          {!site && <FocusInfo w={w} u={y} pick={p.turretPick} onClear={p.onClearFocus} quiet />}
          {!site && <RepairButton w={w} me={me} u={y} onRepair={p.onRepair} />}
        </div>
        <div className="ew-detail-main">
          <header className="ew-yardhead">
            <BaseTabs w={w} me={me} cur={y.id} onSelect={p.onSelect} onRuin={() => p.onEngineers()} />
          </header>
          {site ? (
            <div className="ew-sitebox" data-tip={`Engineers build a yard at one squadron's pace per three craft, up to three squadrons at once: this one takes ${y.t.build} s with one squadron, ${Math.round(y.t.build / 2)} s with two, ${Math.round(y.t.build / 3)} s with three.`}>
              <span className="ew-muted">
                {!y.site!.started
                  ? coming
                    ? `Engineers on their way (${coming} craft).`
                    : 'Waiting for engineers: send some to build it.'
                  : crews
                    ? `Under construction: ${Math.round(progress * 100)}%, ${siteCrew(crews)} welding · ${Math.ceil(y.building / (Math.min(crews, ENGINEERS.crew) / 3))} s left.`
                    : `Under construction: ${Math.round(progress * 100)}%, nobody welding.`}
              </span>
              <Bar value={progress} max={1} kind="shield" />
              <button className="ew-repair" onClick={() => p.onCancelSite(y.id)} data-tip={y.site!.started ? 'Call it off: work has started, so only part of the price comes back.' : 'Call it off before work starts: the full price comes back.'}>
                <Icon name="stop" size={13} /> Cancel <Icon name="credits" size={12} /> +{siteRefund(y)}
              </button>
              {cantConstruct(w, me, y) === null && !crews && !coming && <small className="ew-muted">Select engineers and right-click it (long-press on touch).</small>}
            </div>
          ) : (
            <BuildPanel
              tabs={[
                { id: 'ships', group: 'units', label: 'Warships', badge: ships.length,
                  tip: kind === 'cyard' ? 'Warships: cruisers, and flagships once the Capital slip stands (station level 4).' : 'Warships: frigates and corvettes.' },
                { id: 'expansions', group: 'buildings', label: 'Expansions', badge: `${y.xm?.length ?? 0}/${modulesFor(kind, y.t.faction).length}`,
                  tip: `Expansions: modules the yard builds onto itself, one at a time (${modulesFor(kind, y.t.faction).map((m) => m.name).join(', ')}).` },
              ]}
              page={page} onPick={(id) => pick(id as typeof page)}>
              <div className="ew-yard" style={cardCols(page === 'expansions' ? modulesFor(kind, y.t.faction).length : ships.length)}>
                {page === 'expansions' && <ExpansionCards w={w} me={me} u={y} onExpand={p.onExpand} onCancel={p.onCancelExpand} />}
                {page === 'ships' && ships.map((t) => (
                  <ShipCard key={t.id} t={t} who={ownerTag(w, me, me)} why={cantBuild(w, me, t.id, false, y.id)} whyReserve={cantBuild(w, me, t.id, true, y.id)} level={hud.level} queued={queue.filter((q) => q.unit === t.id).length}
                    onBuild={(id, n, reserve) => p.onBuild(id, n, reserve, y.id)} onUnqueue={(id) => p.onUnqueue(id, y.id)} where="the yard" reinf={reinforceOffer(w, t.id)}
                    research={t.tech && !hud.techs.includes(t.tech) ? TECH[t.tech].name : null} need={moduleNeed(w, me, t, y)} />
                ))}
              </div>
            </BuildPanel>
          )}
        </div>
      </Frame>
    </div>
  )
}

/** Several kinds of ship: a row per type. */
function GroupDetail(p: DetailProps) {
  const art = unitArt
  const { sel, w } = p
  const coarse = useCoarse()
  const types = new Map<string, Unit[]>()
  for (const u of sel) types.set(u.t.id, [...(types.get(u.t.id) ?? []), u])
  return (
    <Frame className="ew-detail is-group">
      <div className="ew-detail-main">
        <header className="ew-unithead">
          <strong>Fleet</strong>
          <span className="ew-muted ew-small">{coarse ? 'Tap a type to keep only those; with Shift on, a tap drops them.' : 'Click a type to keep only those, Shift-click to drop them.'}</span>
        </header>
        {w.hybrid && p.sel.some((u) => u.owner === p.me && isEngineer(u.t)) && <EngineerBuild w={w} me={p.me} crew={p.sel.filter((u) => u.owner === p.me && isEngineer(u.t))} onPlace={p.onPlace} onSelect={p.onSelect} />}
        <div className="ew-fleet">
          {[...types.values()].map((us) => {
            const t = us[0].t
            const hull = us.reduce((s, u) => s + u.hull, 0) / us.reduce((s, u) => s + u.hullMax, 0)
            return (
              <button key={t.id} className="ew-fleetrow" onClick={(e) => p.onOnly(t.id, shiftOf(e))} data-tip={t.blurb}>
                <img src={art(t.sprite)} alt="" />
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

/** The three stances, as the stance button shows them. */
export const STANCE_INFO: Record<Stance, { label: string; icon: IconName; blurb: string }> = {
  hold: { label: 'Hold position', icon: 'hold', blurb: 'never chases: fires at whatever comes within reach' },
  maneuver: { label: 'Maneuver', icon: 'patrol', blurb: 'fires back and gives chase a little way, then comes back' },
  roam: { label: 'Roam', icon: 'roam', blurb: 'chases anything it sees, however far' },
}
/** The stance after this one, for the button and its key. */
export const nextStance = (s: Stance) => STANCES[(STANCES.indexOf(s) + 1) % STANCES.length]

// --- Control groups ---------------------------------------------------------------------------------

/** How a control group changes: set to the selection, the selection added, or emptied. */
export type GroupEdit = 'set' | 'add' | 'clear'

/**
 * The control groups that hold anything, as a strip of chips above the selection: the group's key,
 * the picture of its main unit and how many it holds. A click (a tap) selects the group, a double
 * click (a double tap) looks at it too. Keyboards set and add with the group modifiers; fingers
 * long-press a chip to set it to the selection, add to it or clear it, and tap "+ Group" to save
 * the selection as the next free group. Nothing shows while there are no groups.
 */
export function GroupBar({ groups, onGroup, onEdit, canAssign }: {
  groups: GroupInfo[]
  onGroup: (key: string) => void
  onEdit: (key: string, how: GroupEdit) => void
  /** Whether there is anything of ours selected to put in a group. */
  canAssign: boolean
}) {
  const coarse = useCoarse()
  const free = coarse && canAssign ? freeGroup(groups) : undefined
  if (!groups.length && !free) return null
  return (
    <div className="ew-groupbar" role="group" aria-label="Control groups" data-nodrag>
      {groups.map((g) => (
        <GroupChip key={g.key} g={g} onGroup={onGroup} onEdit={onEdit} canAssign={canAssign} />
      ))}
      {free && (
        <button className="ew-gchip ew-gadd" onClick={() => onEdit(free, 'set')} data-tip={`Save the selection as group ${free}. Long-press a group to set it again, add to it or clear it.`}>
          <b>+</b>
          <small>Group</small>
        </button>
      )}
    </div>
  )
}

function GroupChip({ g, onGroup, onEdit, canAssign }: { g: GroupInfo; onGroup: (key: string) => void; onEdit: (key: string, how: GroupEdit) => void; canAssign: boolean }) {
  const { keys, groupSet, groupAdd } = useSettings()
  const key = keyName(keys[`group${g.key}` as Action])
  const press = useLongPressWheel(
    () => [
      { id: 'set', label: 'Set to selection', icon: <Icon name="army" size={18} />, disabled: !canAssign && 'Select some of ours first', run: () => onEdit(g.key, 'set') },
      { id: 'add', label: 'Add selection', icon: <Icon name="fleet" size={18} />, disabled: !canAssign && 'Select some of ours first', run: () => onEdit(g.key, 'add') },
      { id: 'clear', label: 'Clear group', icon: <Icon name="stop" size={18} />, danger: true, run: () => onEdit(g.key, 'clear') },
    ],
    `Group ${g.key}`,
  )
  return (
    <button className="ew-gchip" {...press} onClick={() => onGroup(g.key)} aria-label={`Group ${g.key}: ${g.count}`}
      data-tip={`Group ${g.key}: ${g.count} ${g.count === 1 ? 'unit' : 'units'}. Click to select it (${key}), double-click to look at it.\n${modName(groupSet)}+${key} sets it to the selection, ${modName(groupAdd)}+${key} adds the selection.`}>
      <b>{g.key}</b>
      {g.sprite && <img src={unitArt(g.sprite)} alt="" />}
      <small>{g.count}</small>
    </button>
  )
}

const COMMANDS: { id: Command; label: string; icon: IconName }[] = [
  { id: 'move', label: 'Move', icon: 'move' },
  { id: 'attack', label: 'Attack move', icon: 'attack' },
  { id: 'stop', label: 'Stop', icon: 'stop' },
  { id: 'patrol', label: 'Patrol', icon: 'patrol' },
  { id: 'hold', label: 'Hold position', icon: 'hold' },
  { id: 'rally', label: 'Rally point', icon: 'rally' },
]

export function SelectionPanel({ w, sel, me, mode, onCommand, onPick }: {
  w: World
  sel: Unit[]
  me: Owner
  mode: Mode
  onCommand: (c: Command) => void
  onPick: (id: number, shift: boolean) => void
}) {
  const art = unitArt
  const mine = sel.filter((u) => u.owner === me)
  const ships = mine.filter((u) => isShip(u.t))
  const station = mine.some((u) => u.t.tier === 'station' || (u.t.tier === 'yard' && !!u.yq))
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
  const ab = withAb[0]?.t.ability ? abilityOf(withAb[0].t.ability, withAb[0].t.faction) : null
  // The stance button shows the selection's stance (if they share one) and cycles to the next.
  const stance = ships.length && ships.every((u) => u.stance === ships[0].stance) ? ships[0].stance : null
  const armed = mine.some((u) => !isShip(u.t) && u.guns.length > 0)
  const enabled = (c: Command) => (c === 'rally' ? station : c === 'attack' || c === 'stop' ? ships.length > 0 || armed : ships.length > 0)
  const retreaters = mine.filter(canRetreat)
  // The keys as bound in Settings, not the defaults.
  const { keys } = useSettings()
  const keyFor = (c: Command) => keyName(keys[c])
  return (
    <Frame className="ew-selframe" title="Selected units" aside={<b className="ew-selcount">{sel.length || ''}</b>}>
      <div className="ew-seltiles">
        {shown.map((g) => {
          const u = g[0]
          const hull = g.reduce((s, x) => s + x.hull, 0) / g.reduce((s, x) => s + x.hullMax, 0)
          return (
            <button key={u.id} className={`ew-seltile ${u.owner === me ? '' : 'is-enemy'}`} onClick={(e) => onPick(u.id, shiftOf(e))} {...unitTip(u.t, ownerTag(w, me, u.owner), `${g.length > 1 ? `${g.length} selected. ` : ''}Click to select only this, Shift-click to drop it.`, g.length === 1 ? u : undefined)}>
              <img src={art(u.t.sprite)} alt="" />
              {g.length > 1 && <em>{g.length}</em>}
              <Bar value={hull} max={1} kind="hull" />
            </button>
          )
        })}
        {tiles.length > shown.length && <span className="ew-selmore">+{tiles.length - shown.length}</span>}
        {!sel.length && <span className="ew-muted ew-small">Nothing selected</span>}
      </div>
      <div className="ew-cmdgrid">
        {COMMANDS.map((c) => {
          const st = c.id === 'hold' ? STANCE_INFO[stance ?? 'maneuver'] : null
          const label = st ? (ships.length && !stance ? 'Mixed stance' : st.label) : c.label
          const title = st
            ? `Stance: ${label}${stance ? `, ${st.blurb}` : ''}. Click (${keyFor(c.id)}) for ${STANCE_INFO[nextStance(stance ?? 'roam')].label}.`
            : `${c.label} (${keyFor(c.id)})`
          return (
            <button key={c.id} className={`ew-cmdbtn ${mode === c.id ? 'is-on' : ''} ${st ? 'ew-stancebtn' : ''}`} disabled={!enabled(c.id)} onClick={() => onCommand(c.id)} data-tip={title}>
              <Icon name={st ? st.icon : c.icon} size={20} />
              <span>{label}</span>
              <kbd>{keyFor(c.id)}</kbd>
            </button>
          )
        })}
        {/* The third row: the ships' ability, a hyperspace retreat, and guard. */}
        <button className="ew-cmdbtn ew-abilitybtn" disabled={!ready.length} onClick={() => onCommand('ability')}
          data-tip={ab ? `${ab.name}: ${ab.blurb} (${keyName(keys.ability)})` : 'Ability: none of the selected ships has one'}>
          <Icon name="ability" size={20} />
          <span>
            {!ab ? 'Ability' : withAb.length > 1 && new Set(withAb.map((u) => u.t.ability)).size > 1 ? 'Abilities' : ab.name}
            {ab && (ready.length ? ` ${ready.length}/${withAb.length}` : ` ${Math.ceil(Math.min(...withAb.map((u) => u.abilityCd)))}s`)}
          </span>
          <kbd>{keyName(keys.ability)}</kbd>
        </button>
        {(() => {
          const charging = retreaters.filter((u) => u.retreat > 0)
          const all = retreaters.length > 0 && charging.length === retreaters.length
          const refund = retreaters.reduce((sum, u) => sum + retreatRefund(u), 0)
          const left = charging.length ? Math.ceil(Math.max(...charging.map((u) => u.retreat))) : 0
          return (
            <button className={`ew-cmdbtn ew-retreatbtn ${charging.length ? 'is-on' : ''}`} disabled={!retreaters.length} onClick={() => onCommand('retreat')}
              data-tip={!retreaters.length
                ? 'Hyperspace retreat: for gunships and bigger (fighters and bombers have no drive)'
                : all
                  ? `Charging hyperspace drives: jumping out in ${left} s. Click (${keyName(keys.retreat)}) to call it off.`
                  : `Hyperspace retreat (${keyName(keys.retreat)}): the drive charges for a few seconds while the ship holds still and keeps firing, then it jumps out, freeing its fleet space; ${REFUND_DELAY} s later up to ${Math.round(RETREAT_REFUND * 100)}% of its cost comes back, less the more damaged it was. Destroyed before it jumps, it's simply lost.`}>
              <Icon name="jump" size={20} />
              <span>{all ? `Jumping · ${left}s` : retreaters.length ? `Retreat +${fmt(refund)}` : 'Retreat'}</span>
              <kbd>{keyName(keys.retreat)}</kbd>
            </button>
          )
        })()}
        <button className={`ew-cmdbtn ${mode === 'guard' ? 'is-on' : ''}`} disabled={!ships.length} onClick={() => onCommand('guard')}
          data-tip={`Guard (${keyName(keys.guard)}): click one of our ships or structures; the selected ships stay with it and fight off whatever comes near. A ship two classes bigger they escort: they fly over its hull, move with it, and repair ships mend it first.`}>
          <Icon name="hold" size={20} />
          <span>Guard</span>
          <kbd>{keyName(keys.guard)}</kbd>
        </button>
      </div>
    </Frame>
  )
}
