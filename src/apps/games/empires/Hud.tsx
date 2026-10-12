import { bigType, sizedType, type ShipSizes } from './models/sizes.ts'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { battleLayout, type LayoutStore } from './layout'
import {
  ABILITIES, DEFENSE_WING, FACTIONS, LEVEL_UP, wingOf, SITE_UPGRADES, type SiteUpgradeId, YIELD_PER_LEVEL, moduleSprite, roleOf, siteOptions, MAX_LEVEL, MAX_QUEUE, MAX_RESEARCH, MINE_INCOME, SURVEY_TIME, TECH, UNIT, buildable, isShip, techsFor, unitOf, type FactionId, type HardpointKind,
  type UnitType,
} from './data'
import { HP_COLOR, HP_ICON, hpName } from './icons'
import { modelFor, typeOfSprite } from './models/index.ts'
import { thumbnail } from './models/paint.ts'
import { spriteUrl } from './render'
import { keyName, useSettings } from './settings'
import { LongPress, isTouch, shiftOf, useCoarse, useLongPressWheel } from './Touch'
import { FIELD_DAMAGE, dpsVs, cantUpgradeSite, mineOutput, siteUpgradeNext, REFUND_DELAY, REPAIR_TIME, RETREAT_REFUND, canRetreat, cantRepair, repairCost, retreatRefund, RANKS, RANK_BONUS, SHIELD_REBOOT, STANCES, building, cantBuild, fromHangar, typeOf, cantResearch, cantSite, mendTarget, wingState, researchCost, researchLock, shieldFull, shieldMax, techBonus, type EarnSource, type LedgerEntry, type OreNode, type Owner, type SpendKind, type ResearchItem, type Stance, type Unit, type World } from './sim'

// The battle HUD, framed like a ship's command deck: a top bar with the faction, credits, fleet,
// shipyard, research and game speed; and along the bottom the tactical map, a details panel for
// whatever is selected (the station's shipyard lives there, so building happens at the station),
// and the selected units with their command grid. Research has its own screen, the tech tree
// (TechTree.tsx); the tiles here only show a ship type's own upgrades.

export type Hud = {
  /** Control groups that still have ships: their key, size, and the sprite of the biggest. */
  groups: { key: string; count: number; sprite: string }[]
  /** Our warships with nothing to do. */
  idle: number
  credits: number
  income: number
  pop: number
  popCap: number
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
}
/** What a left-click on the battlefield does: select, or carry out a command picked from the grid. */
export type Mode = 'normal' | 'move' | 'attack' | 'patrol' | 'rally' | 'guard'
export type MapFilter = 'all' | 'ships' | 'stations' | 'enemies'
export type Command = Exclude<Mode, 'normal'> | 'stop' | 'hold' | 'ability' | 'retreat'

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
  // Hyperspace: streaks closing in on a point.
  jump: 'M12 12m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0 M2 12h5 M17 12h5 M4.5 5.5l3.5 3 M19.5 18.5l-3.5-3 M4.5 18.5l3.5-3 M19.5 5.5l-3.5 3',
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
/**
 * The game's own tooltips, in place of the browser's: anything inside this screen with a
 * `data-tip` shows it in a game panel after a moment, above it (or below when there's no room),
 * kept inside the screen. The text is read again while it shows, so countdowns and prices stay
 * current. The element is found by where the pointer is, so hints on disabled buttons show too.
 * Put one inside each screen's root.
 */
export function Tips({ live }: { live?: (id: number) => Unit | undefined } = {}) {
  const anchor = useRef<HTMLSpanElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ text: string; unit?: string; big?: boolean; uid?: number; who?: string; rel?: string; x: number; top: number; bottom: number } | null>(null)
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
      const rr = root.getBoundingClientRect()
      setTip({
        text: text ?? '', unit: unit ?? undefined, big: cur.hasAttribute('data-tip-big'), uid: Number(cur.getAttribute('data-tip-uid')) || undefined, who: cur.getAttribute('data-tip-who') ?? undefined, rel: cur.getAttribute('data-tip-rel') ?? undefined,
        x: r.left + r.width / 2 - rr.left, top: r.top - rr.top, bottom: r.bottom - rr.top,
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
    const left = Math.max(6, Math.min(root.clientWidth - b.offsetWidth - 6, tip.x - b.offsetWidth / 2))
    const above = tip.top - b.offsetHeight - 8
    b.style.left = `${left}px`
    b.style.top = `${above >= 6 ? above : Math.min(root.clientHeight - b.offsetHeight - 6, tip.bottom + 8)}px`
    b.style.visibility = 'visible'
  }, [tip])
  return (
    <>
      <span ref={anchor} hidden />
      {tip && (
        <div ref={box} className={`ew-tip ${tip.unit ? 'is-unit' : ''}`} role="tooltip" style={{ visibility: 'hidden' }}>
          {tip.unit && UNIT[tip.unit] ? <UnitIntel t={sizedType(tip.unit, tip.big ? 'big' : 'classic')} who={tip.who} rel={tip.rel} note={tip.text || undefined} live={tip.uid ? live?.(tip.uid) : undefined} /> : tip.text}
        </div>
      )}
    </>
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

/**
 * A unit's picture by its sprite name, for the menus and tiles that only know the sprite: a still of
 * its procedural model where it has one and the setting is on, else the sprite itself.
 */
/** The ship sizes the screen's battle or campaign is played at (models/sizes.ts), so pictures that
 * only know a sprite show the ships as they are in it. */
export const SizesContext = createContext<ShipSizes | undefined>(undefined)

export function useUnitArt() {
  const { models } = useSettings()
  const sizes = useContext(SizesContext)
  return (sprite: string) => {
    const plain = models ? typeOfSprite(sprite) : null
    const t = plain && sizes === 'big' ? bigType(plain) : plain
    const m = t ? modelFor(t) : null
    return m ? thumbnail(m, THUMB_PX).url : spriteUrl(sprite)
  }
}

/**
 * A ship or structure as it looks in battle: its hull with every module on it (shot-off ones
 * burnt), fitted into whatever box the CSS gives it like an image would be. With procedural models
 * on, a still of its model (the mounts painted on it); otherwise its sprite with the module sprites.
 */
export function ShipArt({ t, hps, className = '' }: { t: UnitType; hps?: { hp: number }[]; className?: string }) {
  const W = t.aspect >= 1 ? 100 : 100 * t.aspect
  const H = t.aspect >= 1 ? 100 / t.aspect : 100
  const { models } = useSettings()
  const m = models ? modelFor(t) : null
  if (m) {
    const { url, pad } = thumbnail(m, THUMB_PX, hps?.map((h) => h.hp <= 0))
    // The model's box is the viewBox; the picture's margin hangs over it.
    const k = W / m.w
    return (
      <svg className={`ew-art ${className}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" overflow="visible" aria-hidden>
        <image href={url} x={-pad * k} y={-pad * k} width={(m.w + pad * 2) * k} height={(m.h + pad * 2) * k} />
      </svg>
    )
  }
  return (
    <svg className={`ew-art ${className}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
      <image href={spriteUrl(t.sprite)} width={W} height={H} />
      {t.hardpoints.map((m, i) => {
        if (!m.art) return null
        const s = (m.s ?? 0.05) * 100
        return <image key={i} className={hps && hps[i]?.hp <= 0 ? 'is-dead' : ''} href={spriteUrl(moduleSprite(t.faction, m.art))} x={(m.x / 10) * W - s / 2} y={(m.y / 10) * H - s / 2} width={s} height={s} />
      })}
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
              data-tip={`${hpName(p)}: ${s.hp <= 0 ? 'destroyed' : `${fmt(s.hp)} / ${fmt(s.max)}`}`}
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
function SiteUpgrades({ w, me, u, onUpgrade }: { w: World; me: Owner; u: Unit; onUpgrade: (id: number, upgrade: SiteUpgradeId) => void }) {
  const p = w.players[me]
  const perMin = (MINE_INCOME * mineOutput(u) * p.incomeMul * 60) | 0
  return (
    <div className="ew-siteupg">
      <span className="ew-muted ew-small">Earning +{fmt(perMin)} credits a minute{(u.upg.yield ?? 0) ? `, drills at +${Math.round(YIELD_PER_LEVEL * 100 * (u.upg.yield ?? 0))}%` : ''}.</span>
      <div>
        {SITE_UPGRADES.map((up) => {
          const have = u.upg[up.id] ?? 0
          const next = siteUpgradeNext(u, up.id)
          const busy = u.upgrading?.id === up.id ? u.upgrading : null
          const why = cantUpgradeSite(w, me, u, up.id)
          return (
            <button key={up.id} className={`ew-siteupg-btn ${busy ? 'is-busy' : !next ? 'is-done' : why ? 'is-off' : ''}`} onClick={() => onUpgrade(u.id, up.id)}
              data-tip={`${up.name}: ${up.blurb}\nThis platform only: rebuilt, it starts again.${next ? `\nLevel ${next.level}: ${next.cost} credits, ${next.time} s.` : '\nFully upgraded.'}${why && next && !busy ? `\n\n${why}` : ''}`}>
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
function FocusInfo({ w, u, pick, onClear }: { w: World; u: Unit; pick: { unit: number; hp: number } | null; onClear: (id: number) => void }) {
  const focus = u.focus ? w.byId.get(u.focus) : undefined
  const own = u.guns.filter((g) => g.focus && w.byId.get(g.focus))
  const picked = pick && pick.unit === u.id ? u.t.hardpoints[pick.hp] : null
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
      {picked && <span className="ew-focus-pick">{hpName(picked)} picked: right-click an enemy to aim it.</span>}
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
  const names = [...new Set(u.t.hardpoints.map(hpName))]
  return (
    <div className="ew-hpsum">
      {names.map((n) => {
        const all = u.t.hardpoints.map((h, i) => (hpName(h) === n ? i : -1)).filter((i) => i >= 0)
        const up = all.filter((i) => u.hps[i].hp > 0).length
        const k = u.t.hardpoints[all[0]].kind
        return (
          <span key={n} className={`ew-hpchip ${up === 0 ? 'is-dead' : up < all.length ? 'is-hurt' : ''}`} style={{ ['--c' as string]: HP_COLOR[k] }} data-tip={`${n}: ${up} of ${all.length} working`}>
            <HpIcon kind={k} size={13} />
            {up} / {all.length}
          </span>
        )
      })}
    </div>
  )
}

function Vitals({ u, squad = [u], now }: { u: Unit; squad?: Unit[]; now: number }) {
  const reboot = SHIELD_REBOOT - (now - u.shieldOut)
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
          <small data-tip={shieldMax(u) < shieldFull(u) ? 'Shield generators damaged: the shields cannot fully recharge' : undefined}>
            {fmt(u.shield)} / {fmt(shieldFull(u))}
            {shieldMax(u) < shieldFull(u) ? ' ⚠' : ''}
          </small>
        </>
      )}
      {u.nebula && <p className="ew-terrain-note">In a nebula: shields down, sensors at half range</p>}
      {!u.nebula && t.shield > 0 && reboot > 0 && <p className="ew-terrain-note">Shields failed: back online in {Math.ceil(reboot)} s</p>}
    </div>
  )
}

// --- Top bar ----------------------------------------------------------------------------------------

export function TopBar({ hud, faction, sector, ui, onPause, onSpeed, onMenu, onShipyard, onTechTree, onReserves, onEconomy, onPlayers, onMap, mapOpen, ping }: {
  hud: Hud
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
        <button className={`ew-top-cell ew-jobbtn ${q ? 'is-busy' : ''}`} onClick={onShipyard} aria-label="Shipyard"
          data-tip={q ? `Shipyard: ${UNIT[q.unit].name}, ${Math.ceil(q.left)} s left${hud.queue.length > 1 ? `, ${hud.queue.length - 1} more queued` : ''}.\nClick to select the station (H).` : 'Shipyard idle.\nClick to select the station and build ships (H).'}>
          <Icon name="yard" size={18} />
          {hud.queue.length > 0 && <em>{hud.queue.length}</em>}
          {q && <i style={{ transform: `scaleX(${1 - q.left / q.total})` }} />}
        </button>
        <button className={`ew-top-cell ew-jobbtn ${r ? 'is-busy' : ''}`} onClick={onTechTree} aria-label="Tech tree"
          data-tip={r ? `Research: ${researchName(r.id, hud.level)}, ${Math.ceil(r.left)} s left${hud.research.length > 1 ? `, ${hud.research.length - 1} more queued` : ''}.\nClick for the tech tree (${keyName(keys.techTree)}).` : `Research idle.\nClick for the tech tree (${keyName(keys.techTree)}).`}>
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
  const art = useUnitArt()
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
          <img src={`/games/empires/world/emblem-${faction}.webp`} alt="" />
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
  onBuild: (id: string, times: number, reserve?: boolean) => void
  onUnqueue: (id: string) => void
  onCancel: (index: number) => void
  onResearch: (id: string) => void
  onTechTree: () => void
  onSite: (node: number, id: string) => void
  onRepair: (id: number) => void
  onUpgradeSite: (id: number, upgrade: SiteUpgradeId) => void
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
  if (sel.every((u) => u.t.id === first.t.id)) return <UnitDetail {...p} u={first} squad={sel} />
  return <GroupDetail {...p} />
}

export function Pips({ level }: { level: number }) {
  return (
    <span className="ew-pips" data-tip={`Station level ${level} of ${MAX_LEVEL}`}>
      {Array.from({ length: MAX_LEVEL }, (_, i) => (
        <i key={i} className={i < level ? 'is-on' : ''} />
      ))}
    </span>
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
      data-tip={`${researchName(id, hud.level)}\n${blurb}${s.why && s.status !== 'done' && s.status !== 'busy' && s.status !== 'queued' ? `\n\n${s.why}` : ''}`}
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
    <button className={`ew-treebtn ${r ? 'is-busy' : ''}`} onClick={onOpen} data-tip={`Open the tech tree to research upgrades (${keyName(keys.techTree)})`}>
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
  // Ships the station isn't upgraded for yet stay out of the shipyard, unless the setting shows them.
  const { lockedShips } = useSettings()
  // At the battle's ship sizes, so the cards and their tooltips show the numbers the sim uses.
  const all = buildable(faction).map((t) => typeOf(w, t.id)).filter((t) => lockedShips || t.level <= hud.level)
  const queued = (id: string) => hud.queue.filter((q) => q.unit === id).length
  // Warships and strike craft on separate pages, picked on the left; the choice is remembered.
  const [page, setPage] = useState<'warships' | 'strike'>(() => {
    try {
      return localStorage.getItem('mvlos.empires.yardpage') === 'strike' ? 'strike' : 'warships'
    } catch {
      return 'warships'
    }
  })
  const pick = (pg: 'warships' | 'strike') => {
    setPage(pg)
    try {
      localStorage.setItem('mvlos.empires.yardpage', pg)
    } catch {
      // Not remembered this time.
    }
  }
  // Small craft on one page (fighters, bombers and gunships), the warships proper on the other.
  // Corvettes share the gunship tier but count as warships.
  const small = (t: UnitType) => fromHangar(t) || (t.tier === 'gunship' && t.kind !== 'support')
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
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])
  return (
    <div className="ew-stationwrap">
      <BuildQueue queue={hud.queue} onCancel={p.onCancel} />
      <Frame className="ew-detail is-station">
        <div className="ew-detail-side">
          <Schematic u={st} size={96} tip={unitTip(st.t, ownerTag(w, me, st.owner), undefined, st)} />
          <div className="ew-side-info">
            <strong {...unitTip(st.t, ownerTag(w, me, st.owner), undefined, st)}>{st.t.name}</strong>
            <small className="ew-muted">Production station</small>
            <Pips level={hud.level} />
          </div>
          <Vitals u={st} now={w.time} />
          <HpSummary u={st} />
          <WingInfo w={w} st={st} />
          <FocusInfo w={w} u={st} pick={p.turretPick} onClear={p.onClearFocus} />
          <RepairButton w={w} me={me} u={st} onRepair={p.onRepair} />
        </div>
        <div className="ew-detail-main">
          <header className="ew-yardhead">
            <h5 className="ew-yardtitle">Shipyard</h5>
            <TechTreeButton hud={hud} onOpen={p.onTechTree} />
          </header>
          <div className="ew-yardbody">
            <div className="ew-yardtabs" role="tablist" aria-label="Which ships">
              <button role="tab" aria-selected={page === 'warships'} className={page === 'warships' ? 'is-on' : ''} onClick={() => pick('warships')}
                data-tip="Warships: corvettes, frigates, cruisers and dreadnoughts. Built for the fleet inventory, or straight to the station with the small jump button.">
                <Icon name="fleet" size={16} />
                <span>Warships</span>
                <em>{warships.length}</em>
              </button>
              <button role="tab" aria-selected={page === 'strike'} className={page === 'strike' ? 'is-on' : ''} onClick={() => pick('strike')}
                data-tip="Strike craft: fighters and bombers launch from the station's hangar; gunships go to the fleet inventory, or jump in at the station with the small button.">
                <Icon name="attack" size={16} />
                <span>Strike craft</span>
                <em>{strike.length}</em>
              </button>
            </div>
            <div className="ew-yard" ref={grid}>
              {ships.map((t) => (
                <ShipCard key={t.id} t={t} who={ownerTag(w, me, me)} why={cantBuild(w, me, t.id)} whyReserve={cantBuild(w, me, t.id, true)} level={hud.level} queued={queued(t.id)} onBuild={p.onBuild} onUnqueue={p.onUnqueue}
                  research={t.tech && !hud.techs.includes(t.tech) ? TECH[t.tech].name : null} />
              ))}
            </div>
          </div>
        </div>
      </Frame>
    </div>
  )
}

/** The station's defense wing: craft left, and when the hangar sends the next one. */
function WingInfo({ w, st }: { w: World; st: Unit }) {
  const s = wingState(w, st)
  const name = wingOf(st.t.faction).name
  const line = s.next === null ? 'at full strength' : s.next === Infinity ? 'hangar down: no new craft until it is repaired' : `next in ${Math.ceil(s.next)} s`
  return (
    <small className="ew-muted ew-wing" data-tip-unit={wingOf(st.t.faction).id} data-tip-who="Yours" data-tip-rel="own"
      data-tip={`${name}: the station's free defense wing. Lost craft come back from its hangar one at a time, every ${DEFENSE_WING.every} s, starting ${DEFENSE_WING.wait} s after the last loss, while a hangar stands.`}>
      Defense wing {s.left}/{s.full} · {line}
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

export function ShipCard({ t, who, why, whyReserve, level, queued, onBuild, onUnqueue, campaign = false, research = null }: {
  t: UnitType; who: { who: string; rel: string }; why: string | null; whyReserve: string | null; level: number; queued: number; onBuild: (id: string, times: number, reserve?: boolean) => void; onUnqueue: (id: string) => void
  /** On the galaxy map: every ship joins the fleet in orbit, so no jump-in button. */
  campaign?: boolean
  /** The research it still waits for, by name (null once it's done, or when it needs none). */
  research?: string | null
}) {
  const locked = t.level > level || !!research
  const lockText = t.level > level ? `Needs station level ${t.level}.` : `Needs research: ${research}. Find it in the tech tree.`
  // A finger has no Shift-click or right-click: a long press offers them on a wheel.
  const press = useLongPressWheel(
    () =>
      locked
        ? []
        : [
            { id: 'one', label: 'Build 1', run: () => onBuild(t.id, 1, !fromHangar(t) && !campaign) },
            { id: 'five', label: 'Build 5', run: () => onBuild(t.id, 5, !fromHangar(t) && !campaign) },
            ...(!fromHangar(t) && !campaign ? [{ id: 'jump', label: 'Jump in', disabled: why ?? undefined, run: () => onBuild(t.id, 1, false) }] : []),
            { id: 'less', label: 'Remove 1', disabled: queued ? undefined : 'Nothing queued', danger: true, run: () => onUnqueue(t.id) },
          ],
    t.name,
  )
  const card = (
    <button
      {...press}
      className={`ew-shipcard ${locked ? 'is-locked' : (fromHangar(t) ? why : whyReserve) ? 'is-off' : ''}`}
      onClick={(e) => onBuild(t.id, shiftOf(e) ? 5 : 1, !fromHangar(t))}
      onContextMenu={(e) => {
        e.preventDefault()
        onUnqueue(t.id)
      }}
      {...unitTip(t, who, `${locked ? lockText : campaign ? 'Click to build it here: it joins the fleet in orbit.' : fromHangar(t) ? 'Click to build: it launches from the hangar.' : 'Click to build it for the fleet inventory, then drag it out to any spot your fleet can see. The small corner button builds one that jumps in beside the station.'}${locked ? '' : ' Shift-click for five, right-click to remove one.'}${!locked && (fromHangar(t) ? why : whyReserve) ? `\n${fromHangar(t) ? why : whyReserve}` : ''}`)}
    >
      <ShipArt t={t} />
      <strong>{t.name}</strong>
      <span className="ew-cost"><Icon name="credits" size={11} /> {t.cost}</span>
      <span className="ew-time"><Icon name="time" size={11} /> {t.build}s</span>
      {locked && <span className="ew-lock">{t.level > level ? `Lv${t.level}` : 'Research'}</span>}
      {queued > 0 && <span className="ew-qbadge">{queued}</span>}
    </button>
  )
  // Strike craft launch from the hangar; everything else goes to the fleet inventory, or with the
  // small button jumps straight in beside the station.
  if (fromHangar(t) || locked || campaign) return card
  return (
    <div className="ew-shipwrap">
      {card}
      <button
        className={`ew-reservebtn ${why ? 'is-off' : ''}`}
        onClick={(e) => onBuild(t.id, shiftOf(e) ? 5 : 1, false)}
        data-tip={`Build a ${t.name} that jumps in beside the station as soon as it's done, instead of going to the fleet inventory. Shift-click for five.${why ? `\n\n${why}` : ''}`}
        aria-label={`Build a ${t.name} that jumps in at the station`}
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
export function BuildQueue({ queue, onCancel, max = MAX_QUEUE, campaign = false }: { queue: QueueItem[]; onCancel: (i: number) => void; max?: number; campaign?: boolean }) {
  const art = useUnitArt()
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
        const where = !t ? 'at the station' : campaign ? 'joins the fleet in orbit' : q.reserve ? 'for the fleet inventory' : fromHangar(t) ? 'from the hangar' : 'jumps in at the station'
        return (
          <button key={i} className={`ew-holo ${i === 0 ? 'is-building' : ''}`} onClick={() => onCancel(i)}
            data-tip={`${name}, ${where}${i === 0 ? `: ${Math.round(done * 100)}%, ${Math.ceil(q.left)} s left` : `: waiting (${i + 1} in the queue)`}.\nClick to cancel and refund.`}>
            <span className="ew-holo-beam" />
            <span className="ew-holo-ship">
              <img className="is-dim" src={art(sprite)} alt="" draggable={false} />
              <img className="is-lit" src={art(sprite)} alt="" draggable={false} style={{ clipPath: `inset(${(1 - done) * 100}% 0 0 0)` }} />
            </span>
            <span className="ew-holo-base" />
            {i === 0 && <em>{Math.ceil(q.left)}s</em>}
            {!campaign && t && !q.reserve && !fromHangar(t) && <Icon name="jump" size={10} />}
          </button>
        )
      })}
      {queue.length > PROJECTORS && <span className="ew-holo-more" data-tip={`${queue.length - PROJECTORS} more queued`}>+{queue.length - PROJECTORS}</span>}
    </div>
  )
}

/**
 * The fleet inventory: ships built and waiting in hyperspace, one tile per type. Drag a tile onto
 * the battlefield to call one in; it takes a moment to arrive.
 */
export function ReserveTray({ reserve, onGrab, onClose }: { reserve: string[]; onGrab: (id: string, e: React.PointerEvent) => void; onClose: () => void }) {
  const art = useUnitArt()
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
        <small className="ew-muted">Empty. Ships you build at the station (except fighters and bombers) wait here until you call them in.</small>
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
export function Floating({ id, title, at, onClose, aside, onMove, bare, className = '', layout = battleLayout, children }: {
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
  children: ReactNode
}) {
  layout.useLayoutVersion()
  const moved = layout.panelPos(id)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const pos = drag ?? moved
  /** A position moved inside the screen, below the top bar. */
  const clamp = (x: number, y: number) => {
    const el = box.current
    const root = el?.parentElement
    if (!el || !root) return { x, y }
    return { x: Math.max(0, Math.min(root.clientWidth - el.offsetWidth, x)), y: Math.max(50, Math.min(root.clientHeight - Math.min(el.offsetHeight, 40), y)) }
  }
  // Tell whoever lays out round it where it is, after every change.
  useLayoutEffect(() => {
    const el = box.current
    const root = el?.parentElement
    if (!el || !root || !onMove) return
    const r = el.getBoundingClientRect()
    const rr = root.getBoundingClientRect()
    onMove({ x: r.left - rr.left, y: r.top - rr.top, w: r.width, h: r.height }, { w: rr.width, h: rr.height })
  })
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
  const style: React.CSSProperties = pos ? { left: pos.x, top: pos.y } : at
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
const LEDGER_COLOR: Record<LedgerEntry['kind'], string> = { ships: '#ff9a6e', research: '#b08cff', structures: '#7dffa0', repairs: '#ffd36e', salvage: '#f2c14a', refund: '#c890ff', cancel: '#9fb0c8' }

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
export function EconomyPanel({ w, me, onClose }: { w: World; me: Owner; onClose: () => void }) {
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
              <span><i style={{ background: LEDGER_COLOR[e.kind] }} /> {e.what}</span>
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
function Counters({ t }: { t: UnitType }) {
  const r = roleOf(t)
  if (!r) return null
  return (
    <span className="ew-counters">
      <b>{r.role}</b>
      <span className="is-strong">Strong vs {r.strong.join(', ')}</span>
      <span className="is-weak">Weak vs {r.weak.join(', ')}</span>
    </span>
  )
}
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
  // The card shows the type's numbers at the battle's ship sizes (models/sizes.ts).
  ...(t.big ? { 'data-tip-big': '' } : {}),
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
    // Down and to the right of the cursor; flipped to the other side near the edges.
    const right = x + 18 + b.offsetWidth > root.clientWidth - 6
    const below = y + 18 + b.offsetHeight > root.clientHeight - 6
    b.style.left = `${Math.max(6, right ? x - 18 - b.offsetWidth : x + 18)}px`
    b.style.top = `${Math.max(6, below ? y - 18 - b.offsetHeight : y + 18)}px`
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
  const ab = t.ability ? ABILITIES[t.ability] : null
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

function orderText(w: World, u: Unit) {
  if (building(u)) return `Under construction: ${Math.ceil(u.building)} s`
  const o = u.order
  const mend = mendTarget(w, u)
  if (mend) return `Field repair: ${mend.t.name}`
  if (o.k === 'move') return o.attack ? 'Attack-moving' : 'Moving'
  if (u.retreat > 0) return `Charging hyperspace drive: jumping out in ${Math.ceil(u.retreat)} s`
  if (o.k === 'patrol') return 'Patrolling'
  if (o.k === 'guard') {
    const g = w.byId.get(o.id)
    return g ? `Guarding ${g.t.name}` : 'Guarding'
  }
  if (o.k === 'area') {
    const t = u.target ? w.byId.get(u.target) : undefined
    return t ? `Area attack: ${t.t.name}` : 'Area attack: closing in'
  }
  if (o.k === 'attack') {
    const t = w.byId.get(o.id)
    return t ? `Attacking ${t.t.name}${o.hp >= 0 ? `: ${hpName(t.t.hardpoints[o.hp]).toLowerCase()}` : ''}` : 'Attacking'
  }
  const t = u.target ? w.byId.get(u.target) : undefined
  if (t) return `Engaging ${t.t.name}`
  return u.stance === 'hold' ? 'Holding position' : 'Idle'
}

function UnitDetail(p: DetailProps & { u: Unit; squad: Unit[] }) {
  const art = useUnitArt()
  const { u, squad, me, w } = p
  const coarse = useCoarse()
  const t = u.t
  const mine = u.owner === me
  const ally = !mine && w.players[u.owner].team === w.players[me].team
  return (
    <Frame className={`ew-detail is-unit ${mine ? '' : ally ? 'is-ally' : 'is-enemy'}`}>
      <div className="ew-detail-side">
        {u.hps.length ? <Schematic u={u} size={104} tip={unitTip(t, ownerTag(w, me, u.owner), undefined, u)} /> : <img className="ew-portrait" src={art(t.sprite)} alt="" {...unitTip(t, ownerTag(w, me, u.owner), undefined, u)} />}
      </div>
      <div className="ew-detail-main">
        <header className="ew-unithead">
          <strong {...unitTip(t, ownerTag(w, me, u.owner), undefined, u)}>
            {t.name}
            {squad.length > 1 ? ` ×${squad.length}` : ''}
          </strong>
          <span className={`ew-tag ${mine ? '' : ally ? 'is-ally' : 'is-enemy'}`}>{mine ? t.tier : `${ally ? 'allied' : 'enemy'} ${t.tier}`}</span>
          {u.rank > 0 && <span className="ew-rank" data-tip={`${RANKS[u.rank]}: +${Math.round(RANK_BONUS * u.rank * 100)}% damage, hull and shield recharge`}>{'⌃'.repeat(u.rank)} {RANKS[u.rank]}</span>}
          {mine && <span className="ew-muted ew-small ew-orders">{orderText(w, u)}{u.kills > 0 ? ` · ${u.kills} kills` : ''}</span>}
          {mine && <RetreatIcon ships={squad.filter((x) => x.owner === me)} onRetreat={p.onRetreat} />}
        </header>
        <span className="ew-muted ew-small">{t.blurb}</span>
        <Counters t={t} />
        <Vitals u={u} squad={squad} now={w.time} />
        {u.hps.length > 0 && <HpSummary u={u} />}
        {mine && squad.length === 1 && !isShip(t) && u.guns.length > 0 && !building(u) && <FocusInfo w={w} u={u} pick={p.turretPick} onClear={p.onClearFocus} />}
        {mine && squad.length === 1 && t.tier === 'mine' && !building(u) && <SiteUpgrades w={w} me={me} u={u} onUpgrade={p.onUpgradeSite} />}
        {mine && squad.length === 1 && (t.tier === 'mine' || t.tier === 'defense') && <RepairButton w={w} me={me} u={u} onRepair={p.onRepair} />}
        {mine && techsFor(t.id).length > 0 && (
          <div className="ew-unittech">
            <span className="ew-muted ew-small">Upgrades</span>
            {techsFor(t.id).map((x) => (
              <TechTile key={x.id} id={x.id} w={w} me={me} hud={p.hud} onResearch={p.onResearch} />
            ))}
            <button className="ew-unittree" onClick={p.onTechTree} data-tip="Open the tech tree">
              <Icon name="tree" size={15} />
              Tech tree
            </button>
          </div>
        )}
        {!mine && !ally && u.hps.length > 0 && <span className="ew-muted ew-small">{coarse ? 'Select your ships, then long-press a marker on this one and pick Attack to target that hardpoint.' : 'Select your ships, hover this one and right-click a marker to target that hardpoint.'}</span>}
      </div>
    </Frame>
  )
}

/** Several kinds of ship: a row per type. */
function GroupDetail(p: DetailProps) {
  const art = useUnitArt()
  const { sel } = p
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

/** A control group's button: a tap selects it; on touch a long press sets it to the selection. */
function GroupButton({ g, onGroup, onAssign, canAssign }: { g: Hud['groups'][number]; onGroup: (key: string) => void; onAssign?: (key: string, clear?: boolean) => void; canAssign: boolean }) {
  const art = useUnitArt()
  const press = useLongPressWheel(
    () => [
      { id: 'set', label: 'Set to selection', icon: <Icon name="army" size={18} />, disabled: !canAssign && 'Select some of ours first', run: () => onAssign?.(g.key) },
      { id: 'clear', label: 'Clear group', icon: <Icon name="stop" size={18} />, danger: true, run: () => onAssign?.(g.key, true) },
    ],
    `Group ${g.key}`,
  )
  return (
    <button {...(onAssign ? press : {})} onClick={() => onGroup(g.key)} data-tip={`Group ${g.key}: ${g.count} ships (press ${g.key}, twice to look)`}>
      <b>{g.key}</b>
      {g.sprite && <img src={art(g.sprite)} alt="" />}
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

export function SelectionPanel({ w, sel, me, mode, onCommand, onPick, groups, onGroup, canAssign = false, onAssign }: {
  w: World
  groups: Hud['groups']
  onGroup: (key: string) => void
  /** Whether there is anything of ours selected to put in a control group. */
  canAssign?: boolean
  /** Touch: set a control group to the selection (or clear it); keyboards use Ctrl+digit. */
  onAssign?: (key: string, clear?: boolean) => void
  sel: Unit[]
  me: Owner
  mode: Mode
  onCommand: (c: Command) => void
  onPick: (id: number, shift: boolean) => void
}) {
  const art = useUnitArt()
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
  // The stance button shows the selection's stance (if they share one) and cycles to the next.
  const stance = ships.length && ships.every((u) => u.stance === ships[0].stance) ? ships[0].stance : null
  const armed = mine.some((u) => !isShip(u.t) && u.guns.length > 0)
  const enabled = (c: Command) => (c === 'rally' ? station : c === 'attack' || c === 'stop' ? ships.length > 0 || armed : ships.length > 0)
  const retreaters = mine.filter(canRetreat)
  // The keys as bound in Settings, not the defaults.
  const { keys } = useSettings()
  const keyFor = (c: Command) => keyName(keys[c])
  // Fingers have no Ctrl+digit: a button saves the selection as the next free group.
  const coarse = useCoarse()
  const free = onAssign && coarse && canAssign ? ['1', '2', '3', '4', '5', '6', '7', '8', '9'].find((k) => !groups.some((g) => g.key === k)) : undefined
  return (
    <Frame className="ew-selframe" title="Selected units" aside={<b className="ew-selcount">{sel.length || ''}</b>}>
      {(groups.length > 0 || free) && (
        <div className="ew-groups" aria-label="Control groups">
          {groups.map((g) => (
            <GroupButton key={g.key} g={g} onGroup={onGroup} onAssign={onAssign} canAssign={canAssign} />
          ))}
          {free && (
            <button className="ew-groupadd" onClick={() => onAssign!(free)} data-tip={`Save the selection as group ${free}. Long-press a group to set it again.`}>
              <b>+</b>
              <small>Group</small>
            </button>
          )}
        </div>
      )}
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
          data-tip={`Guard (${keyName(keys.guard)}): click one of our ships or structures; the selected ships stay with it and fight off whatever comes near.`}>
          <Icon name="hold" size={20} />
          <span>Guard</span>
          <kbd>{keyName(keys.guard)}</kbd>
        </button>
      </div>
    </Frame>
  )
}
