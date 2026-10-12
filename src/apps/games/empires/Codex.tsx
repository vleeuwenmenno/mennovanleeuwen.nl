import { useEffect, useMemo, useRef, useState } from 'react'
import { ABILITIES, FACTIONS, STATIONS, TECH, TECHS, UNITS, moduleSprite, roleOf, stationType, type FactionId, type Tier, type UnitType, type WeaponKind } from './data'
import { info, sameSel, selName, targets, weaponLine, WEAPON_NAME, type Sel } from './codexInfo'
import { Frame, HpIcon, Icon, Tips, fmt } from './Hud'
import { HP_COLOR, hpName } from './icons'
import { BREAK_WEIGHTS, hasModel, hullState, modelFor, modelStyles, pickAt, type Model } from './models/index.ts'
import { ModelFx } from './models/fx.ts'
import { LIGHT } from './models/kit.ts'
import { cacheStats, drawHull, drawMounts, liveEngines } from './models/paint.ts'
import type { BreakKind } from './models/types.ts'
import { spriteUrl } from './render'
import type { EmpiresSound } from './sound'
import { Seg } from './Menus'
import { LongPress, TAP_SLOP, WheelHost, isTouch, useCoarse, useWheel } from './Touch'
import './codex.css'

// The Codex: every ship and structure of both sides, with its numbers (hull, shields, guns and
// their reach, cost, what it beats and what beats it) next to a view of it, nose up, that can be
// dragged round and zoomed. The view shows the procedural model where a unit has one and its
// sprite where it doesn't yet.
//
// Every module and named part can be looked at: hovering one outlines it and shows a tip with its
// numbers, and clicking (tapping) it selects it, which adds a Module section to the
// specifications (what it does, what losing it costs, and for a gun its reach drawn round it on
// the model). The hardpoint list in the specifications selects the same way, both ways round.
//
// Workshop mode is for checking models: part outlines, hardpoints, weapon ranges and engine glow
// can be switched on, the hull can be dragged down, a tool picks what a click does (inspect,
// damage, detach), and Destroy plays the death break-up the battle would show, re-rolled to see
// the other ways it can break. On a touch screen, holding a finger on a part opens a wheel with
// the same actions.

const TIER_GROUPS: { name: string; tiers: Tier[] }[] = [
  { name: 'Strike craft', tiers: ['fighter'] },
  { name: 'Gunships', tiers: ['gunship'] },
  { name: 'Frigates', tiers: ['frigate'] },
  { name: 'Cruisers', tiers: ['cruiser'] },
  { name: 'Flagships', tiers: ['capital'] },
  { name: 'Structures', tiers: ['station', 'mine', 'defense'] },
]
const RANGE_RGB: Record<WeaponKind, string> = { laser: '255,128,112', flak: '255,196,92', turbo: '122,190,255', missile: '255,140,222', ion: '176,146,255' }
const TAU = Math.PI * 2

/** The unit as the Codex shows it: a station at the level picked, with every module it can have. */
function shown(t: UnitType, level: number) {
  if (t.tier !== 'station') return t
  return stationType(t.faction, level, TECHS.filter((x) => x.faction === t.faction).map((x) => x.id))
}

/** Every gun a unit carries, grouped by kind and numbers. */
function guns(t: UnitType) {
  const all = [...t.weapons.map((w) => ({ w, hp: false })), ...t.hardpoints.flatMap((h) => (h.weapon ? [{ w: h.weapon, hp: true }] : []))]
  const groups: { kind: WeaponKind; dmg: number; burst: number; range: number; cd: number; n: number; turret: boolean }[] = []
  for (const { w, hp } of all) {
    const g = groups.find((x) => x.kind === w.kind && x.dmg === w.damage && x.range === w.range && x.cd === w.cooldown && x.turret === hp)
    if (g) g.n++
    else groups.push({ kind: w.kind, dmg: w.damage, burst: w.burst ?? 1, range: w.range, cd: w.cooldown, n: 1, turret: hp })
  }
  return groups
}

/** The selected module or part, in full. */
function ModuleCard({ t, model, sel, dmg, onClear }: { t: UnitType; model: Model | null; sel: Sel; dmg: Damage; onClear: () => void }) {
  const i = info(t, model, sel)
  const st = 'hp' in sel ? dmg.hps[sel.hp] : null
  const tg = i.weapon ? targets(i.weapon.kind) : null
  return (
    <div className="ew-cx-module">
      <header>
        <h5>Module</h5>
        <button className="ew-cx-x" onClick={onClear} aria-label="Clear the selection">
          ✕
        </button>
      </header>
      <b className="ew-cx-mname">
        {'hp' in sel && <HpIcon kind={t.hardpoints[sel.hp].kind} size={14} />} {i.title}
      </b>
      <small className="ew-muted">{i.kind}</small>
      {i.hp !== undefined && (
        <div className="ew-cx-stat">
          <span>Health</span>
          <b>{st && st.hp < st.max ? `${fmt(Math.max(0, st.hp))} / ${fmt(i.hp)}` : fmt(i.hp)}</b>
        </div>
      )}
      {i.weapon && (
        <>
          <div className="ew-cx-stat">
            <span>Weapon</span>
            <b>{WEAPON_NAME[i.weapon.kind]}</b>
          </div>
          <p className="ew-small">{weaponLine(i.weapon)} · its reach is ringed on the model (zoom out for all of it)</p>
          {tg && tg.good.length > 0 && <p className="ew-small"><span className="ew-good">Good against</span> {tg.good.join(', ')}</p>}
          {tg && tg.poor.length > 0 && <p className="ew-small"><span className="ew-bad-text">Poor against</span> {tg.poor.join(', ')}</p>}
        </>
      )}
      <p className="ew-small">{i.does}</p>
      {i.lost && <p className="ew-small"><span className="ew-bad-text">If destroyed:</span> {i.lost}</p>}
      {i.off && <p className="ew-small ew-muted">{i.off}</p>}
    </div>
  )
}

function Stats({ t, model, dmg, selected, hover, onSelect, onHover }: {
  t: UnitType
  model: Model | null
  dmg: Damage
  selected: Sel | null
  hover: Sel | null
  onSelect: (s: Sel | null) => void
  onHover: (s: Sel | null) => void
}) {
  const role = roleOf(t)
  const g = guns(t)
  const dps = g.reduce((s, x) => s + (x.dmg * x.burst * x.n) / x.cd, 0)
  const tech = t.tech ? TECH[t.tech] : undefined
  const row = (label: string, value: React.ReactNode, tip?: string) => (
    <div className="ew-cx-stat" data-tip={tip}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
  const ship = t.tier !== 'station' && t.tier !== 'mine' && t.tier !== 'defense'
  return (
    <div className="ew-cx-stats">
      <header>
        <h3 style={{ color: FACTIONS[t.faction].color }}>{t.name}</h3>
        {role && <em>{role.role}</em>}
      </header>
      {selected && <ModuleCard t={t} model={model} sel={selected} dmg={dmg} onClear={() => onSelect(null)} />}
      <p className="ew-muted">{t.blurb}</p>
      <div className="ew-cx-grid">
        {row('Hull', fmt(t.hull))}
        {row('Shields', t.shield ? `${fmt(t.shield)} · +${t.regen}/s` : 'None')}
        {ship && row('Speed', fmt(t.speed))}
        {ship && row('Turn rate', `${Math.round((t.turn * 180) / Math.PI)}°/s`)}
        {row('Sensors', fmt(t.sensor))}
        {ship && row('Fleet space', t.pop || 'Free')}
        {t.cost > 0 && row('Cost', `${fmt(t.cost)} cr`)}
        {t.build > 0 && row('Build time', `${t.build} s`)}
        {ship && row('Station level', t.level)}
        {t.squad > 1 && row('Squadron', `${t.squad} craft`)}
        {dps > 0 && row('Firepower', `${dps.toFixed(1)} dps`, 'Damage a second with every gun firing, before shields, armour and accuracy')}
        {tech && row('Research', tech.name, tech.blurb)}
      </div>
      {g.length > 0 && (
        <>
          <h5>Weapons</h5>
          <ul className="ew-cx-list">
            {g.map((x, i) => (
              <li key={i}>
                <i style={{ background: `rgb(${RANGE_RGB[x.kind]})` }} />
                <span>
                  {x.n > 1 ? `${x.n}× ` : ''}
                  {WEAPON_NAME[x.kind]}
                  {x.turret ? ' turret' : ''}
                </span>
                <small>
                  {x.dmg}
                  {x.burst > 1 ? `×${x.burst}` : ''} dmg · {x.range} range · {x.cd}s
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
      {t.hardpoints.length > 0 && (
        <>
          <h5>Hardpoints</h5>
          <ul className="ew-cx-list ew-cx-hps" onPointerLeave={() => onHover(null)}>
            {t.hardpoints.map((h, i) => {
              const s = { hp: i }
              const st = dmg.hps[i]
              return (
                <li key={i} className={`${sameSel(s, selected) ? 'is-on' : ''} ${sameSel(s, hover) ? 'is-over' : ''}`}>
                  <button onClick={() => onSelect(sameSel(s, selected) ? null : s)} onPointerEnter={() => onHover(s)} aria-pressed={sameSel(s, selected)}>
                    <i style={{ background: st && st.hp <= 0 ? '#ff5a50' : HP_COLOR[h.kind] }} />
                    <span>
                      {hpName(h)} <em className="ew-muted">#{i + 1}</em>
                    </span>
                    <small>
                      {st && st.hp < st.max ? (st.hp <= 0 ? 'destroyed · ' : `${fmt(st.hp)} / `) : ''}
                      {fmt(h.hp)} hp{h.weapon ? ` · ${h.weapon.range} range` : ''}
                    </small>
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
      {role && (
        <>
          <h5>In battle</h5>
          <p className="ew-cx-role">
            <span className="ew-good">Strong against</span> {role.strong.join(', ')}
            <br />
            <span className="ew-bad-text">Weak against</span> {role.weak.join(', ')}
          </p>
        </>
      )}
      {t.ability && (
        <>
          <h5>Ability: {ABILITIES[t.ability].name}</h5>
          <p className="ew-muted">{ABILITIES[t.ability].blurb}</p>
        </>
      )}
      {t.support && <p className="ew-muted">Repairs up to {t.support.max} ships within {t.support.range}, {t.support.repair} hull a second each.</p>}
      {t.carrier && <p className="ew-muted">Launches a squadron every {t.carrier.every} s, up to {t.carrier.max} out at once.</p>}
    </div>
  )
}

/** The tip beside the pointer for the module or part under it. */
function HoverTip({ t, model, sel, x, y, dmg }: { t: UnitType; model: Model | null; sel: Sel; x: number; y: number; dmg: Damage }) {
  const i = info(t, model, sel)
  const st = 'hp' in sel ? dmg.hps[sel.hp] : null
  const tg = i.weapon ? targets(i.weapon.kind) : null
  return (
    <div className="ew-cx-tip" style={{ left: x + 16, top: y + 14 }}>
      <b>{i.title}</b>
      <small className="ew-muted">{i.kind}{i.hp !== undefined ? ` · ${st && st.hp < st.max ? `${fmt(Math.max(0, st.hp))} / ` : ''}${fmt(i.hp)} hp` : ''}</small>
      {i.weapon && <small>{weaponLine(i.weapon)}</small>}
      {tg && tg.good.length > 0 && <small><span className="ew-good">Good vs</span> {tg.good.join(', ')}</small>}
      {!i.weapon && 'part' in sel && <small className="ew-muted">{i.off}</small>}
    </div>
  )
}

/** A dim star field, painted once. */
function starfield() {
  const c = document.createElement('canvas')
  c.width = c.height = 512
  const g = c.getContext('2d')!
  let s = 77
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 180; i++) {
    g.fillStyle = `rgba(${r() < 0.3 ? '170,200,255' : '255,255,255'},${0.2 + r() * 0.5})`
    g.beginPath()
    g.arc(r() * 512, r() * 512, r() < 0.08 ? 1.2 : 0.6, 0, TAU)
    g.fill()
  }
  return c
}

type Damage = { hull: number; hps: { hp: number; max: number }[]; forced: number }
const fresh = (t: UnitType): Damage => ({ hull: 1, hps: t.hardpoints.map((h) => ({ hp: h.hp, max: h.hp })), forced: 0 })

/** Toggles of the workshop. */
type Show = { hardpoints: boolean; ranges: boolean; glow: boolean; outlines: boolean; spin: boolean }
/** What a click (a tap) on the model does: select what's under it, shoot it up, or shoot it off. */
type Tool = 'inspect' | 'damage' | 'detach'

/** How the view is turned and zoomed, and where the unit sits in it, as the last frame drew it:
 * pointer hits are worked out from this, so they match what's on screen. */
type ViewState = { rot: number; zoom: number; z: number; w: number; h: number }

function Viewer({ t, model, workshop, show, dmg, boom, hover, selected, resetKey, onHover, onClick, onLongPress, onNote }: {
  t: UnitType
  model: Model | null
  workshop: boolean
  show: Show
  dmg: Damage
  /** The destroy preview: a counter that changes for every Destroy or re-roll, and the outcome forced (or null). */
  boom: { n: number; force: BreakKind | null } | null
  hover: Sel | null
  selected: Sel | null
  /** Changes when the view should go back to nose up at its fitting zoom. */
  resetKey: number
  /** The module or part under the pointer (null for none), and where the pointer is in the view. */
  onHover: (s: Sel | null, x: number, y: number) => void
  /** A click or tap on the model (null: on empty space). */
  onClick: (s: Sel | null) => void
  /** A finger held down on the model (touch): opens the action wheel. */
  onLongPress: (s: Sel, x: number, y: number) => void
  onNote: (text: string) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const view = useRef<ViewState>({ rot: 0, zoom: 1, z: 1, w: 1, h: 1 })
  const live = useRef({ t, model, workshop, show, dmg, boom, hover, selected, onNote })
  live.current = { t, model, workshop, show, dmg, boom, hover, selected, onNote }
  const fx = useMemo(() => new ModelFx(), [])
  const stars = useMemo(starfield, [])
  const imgs = useRef(new Map<string, HTMLImageElement>())
  const img = (name: string) => {
    let i = imgs.current.get(name)
    if (!i) {
      i = new Image()
      i.src = spriteUrl(name)
      imgs.current.set(name, i)
    }
    return i.complete && i.naturalWidth ? i : null
  }
  // A new unit (or Reset view): nose up at the fitting zoom, the previous one's debris swept away.
  useEffect(() => fx.clear(), [t, fx])
  useEffect(() => {
    view.current.rot = 0
    view.current.zoom = 1
  }, [resetKey, t])
  // Destroy: play the break-up the battle would show for a wreck numbered after the counter.
  const prevMask = useRef({ det: 0, hps: [] as boolean[], unit: '' })
  useEffect(() => {
    fx.clear()
    if (!boom || !model) return
    const size = t.size
    fx.boom(0, 0, size, boom.n)
    const st = hullState(model, { id: boom.n, hull: dmg.hull * t.hull, hullMax: t.hull, hps: dmg.hps }, t.tier)
    const id = 1000 + boom.n
    if (BREAK_WEIGHTS[t.tier]) {
      fx.anchor(id, model, t.tier, 0, 0, view.current.rot, size, 4242, st.detached | dmg.forced, boom.force ?? undefined)
      const kind = fx.hulkKind(id)
      live.current.onNote(`Wreck ${id}${boom.force ? '' : ' (rolled)'}: ${kind === 'intact' ? 'stays in one scorched piece' : kind === 'half' ? 'broken in half' : 'broken into pieces'}`)
    } else {
      fx.shatter(model, t.tier, 0, 0, view.current.rot, size, 0, 0, id, st)
      live.current.onNote(`Unit ${id}: burst into fragments`)
    }
  }, [boom?.n, boom?.force, model])

  /** The scale that fits the unit (or its longest gun, with the ranges on) into the view. A selected
   * gun's reach doesn't change it: the view would jump; scrolling out shows the whole ring. */
  const fitOf = (w: number, h: number) => {
    const { t, show } = live.current
    const reach = show.ranges ? Math.max(t.size * 0.6, ...guns(t).map((x) => x.range)) * 2 : t.size * 1.25
    return (Math.min(w, h) * 0.86) / reach
  }
  /** A hardpoint's place in the view's world units, as drawn this frame. */
  const hpAt = (i: number) => {
    const { t, model } = live.current
    const { rot } = view.current
    const h = t.hardpoints[i]
    const [sw, sh] = model ? [(model.w * t.size) / model.long, (model.h * t.size) / model.long] : [t.size * Math.min(1, t.aspect), t.size / Math.max(1, t.aspect)]
    const mx = (h.x / 10 - 0.5) * sw
    const my = (h.y / 10 - 0.5) * sh
    return [mx * Math.cos(rot) - my * Math.sin(rot), mx * Math.sin(rot) + my * Math.cos(rot)] as const
  }

  useEffect(() => {
    const c = canvas.current!
    const g = c.getContext('2d')!
    let raf = 0
    let starPat: CanvasPattern | null = null
    let last = performance.now()
    const scan = new Map<number, number>()
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const { t, model, show, dmg, boom, hover, selected } = live.current
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = c.clientWidth
      const h = c.clientHeight
      if (!w || !h) return
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr)
        c.height = Math.round(h * dpr)
      }
      const v = view.current
      // Off by default: the model sits still, nose up, until it's dragged round.
      if (show.spin && !drag.current) v.rot += dt * 0.25
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.fillStyle = '#04060d'
      g.fillRect(0, 0, w, h)
      const pat = (starPat ??= g.createPattern(stars, 'repeat'))
      if (pat) {
        g.fillStyle = pat
        g.fillRect(0, 0, w, h)
      }
      const glow = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.6)
      glow.addColorStop(0, 'rgba(60,90,150,0.18)')
      glow.addColorStop(1, 'rgba(0,0,0,0)')
      g.fillStyle = glow
      g.fillRect(0, 0, w, h)
      const z = fitOf(w, h) * v.zoom
      Object.assign(v, { z, w, h })
      const zdpr = z * dpr
      g.translate(w / 2, h / 2)
      g.scale(z, z)
      fx.step(dt)
      const rot = v.rot
      const st = model ? hullState(model, { id: 1, hull: dmg.hull * t.hull, hullMax: t.hull, hps: dmg.hps }, t.tier) : null
      if (st) st.detached |= dmg.forced
      // Parts coming off in the workshop fly away, as they would in battle.
      if (model && st) {
        const pm = prevMask.current
        const deadNow = dmg.hps.map((x) => x.hp <= 0)
        if (pm.unit === model.key && !boom) {
          model.detachable.forEach((pi, i) => {
            if (st.detached & (1 << i) && !(pm.det & (1 << i))) fx.flyPart(model, pi, 0, 0, rot, t.size, 0, 0, i * 31 + Math.floor(now))
          })
          model.mounts.forEach((mt, i) => {
            if (mt.detach && deadNow[i] && !pm.hps[i]) fx.flyMount(model, i, 0, 0, rot, scan.get(i) ?? rot, t.size, 0, 0, i * 17 + Math.floor(now))
          })
        }
        prevMask.current = { det: st.detached, hps: deadNow, unit: model.key }
      }
      const k = model ? t.size / model.long : 1
      const toWorld = (mx: number, my: number) => [(mx * Math.cos(rot) - my * Math.sin(rot)) * k, (mx * Math.sin(rot) + my * Math.cos(rot)) * k] as const
      const ring = (x: number, y: number, r: number, kind: WeaponKind, label: string) => {
        g.strokeStyle = `rgba(${RANGE_RGB[kind]},0.65)`
        g.lineWidth = 1.5 / z
        g.setLineDash([10 / z, 6 / z])
        g.beginPath()
        g.arc(x, y, r, 0, TAU)
        g.stroke()
        g.setLineDash([])
        g.fillStyle = `rgba(${RANGE_RGB[kind]},0.95)`
        g.font = `${11 / z}px system-ui, sans-serif`
        g.textAlign = 'center'
        g.fillText(label, x, y - r - 4 / z)
        g.textAlign = 'start'
      }
      if (show.ranges) {
        const seen = new Set<string>()
        for (const x of guns(t)) {
          const key = `${x.kind}${x.range}`
          if (seen.has(key)) continue
          seen.add(key)
          ring(0, 0, x.range, x.kind, `${WEAPON_NAME[x.kind]} ${x.range}`)
        }
      }
      // The selected gun's own reach, from where it sits.
      const sw = selected && 'hp' in selected ? t.hardpoints[selected.hp]?.weapon : undefined
      if (sw && selected && 'hp' in selected && !boom) {
        const [x, y] = hpAt(selected.hp)
        ring(x, y, sw.range, sw.kind, `${WEAPON_NAME[sw.kind]} ${sw.range}`)
      }
      if (boom && model) {
        fx.drawHulk(g, 1000 + boom.n, zdpr)
      } else if (model && st) {
        // Engine glow under the hull, as in battle.
        if (show.glow) {
          g.globalCompositeOperation = 'lighter'
          const lit = liveEngines(model, st)
          model.engines.forEach(([ex, ey], i) => {
            if (!lit[i]) return
            const [x, y] = toWorld(ex, ey)
            const r = t.size * (t.tier === 'fighter' ? 0.3 : 0.065) * (0.9 + Math.random() * 0.1)
            const grd = g.createRadialGradient(x, y, 0, x, y, r)
            grd.addColorStop(0, '#ffffff')
            grd.addColorStop(0.3, FACTIONS[t.faction].glow)
            grd.addColorStop(1, 'rgba(0,0,0,0)')
            g.fillStyle = grd
            g.beginPath()
            g.arc(x, y, r, 0, TAU)
            g.fill()
          })
          g.globalCompositeOperation = 'source-over'
        }
        drawHull(g, model, 0, 0, rot, t.size, zdpr, st, { debug: show.outlines })
        const ship = t.tier !== 'station' && t.tier !== 'mine' && t.tier !== 'defense'
        drawMounts(g, model, 0, 0, rot, t.size, zdpr, dmg.hps, (i) => {
          // With nothing to shoot at, the crews sweep their guns to and fro; a selected gun holds
          // still, pointing ahead, so it's easy to look at.
          if (selected && 'hp' in selected && selected.hp === i) return rot
          const sweep = (now / 1000) * (0.3 + (i % 4) * 0.05) + i * 1.7
          const a = rot + (ship ? Math.sin(sweep) * 0.8 : Math.sin(sweep) * Math.PI)
          if (dmg.hps[i]?.hp > 0) scan.set(i, a)
          return scan.get(i) ?? a
        })
      } else {
        // No model yet: the sprite and its module sprites.
        const s = img(t.sprite)
        if (s) {
          const sc = t.size / Math.max(s.naturalWidth, s.naturalHeight)
          g.save()
          g.rotate(rot)
          g.drawImage(s, (-s.naturalWidth * sc) / 2, (-s.naturalHeight * sc) / 2, s.naturalWidth * sc, s.naturalHeight * sc)
          const [sw, sh] = [s.naturalWidth * sc, s.naturalHeight * sc]
          t.hardpoints.forEach((hp, i) => {
            if (!hp.art) return
            const mi = img(moduleSprite(t.faction, dmg.hps[i]?.hp <= 0 && t.faction === 'republic' && hp.weapon ? 'wreck' : hp.art))
            if (!mi) return
            const ms = (hp.s ?? 0.05) * t.size
            g.globalAlpha = dmg.hps[i]?.hp <= 0 ? 0.5 : 1
            g.drawImage(mi, (hp.x / 10 - 0.5) * sw - ms / 2, (hp.y / 10 - 0.5) * sh - ms / 2, ms, ms)
            g.globalAlpha = 1
          })
          g.restore()
        }
      }
      fx.draw(g, zdpr)
      // The hovered and the selected module or part: a glowing outline round it, the selected one
      // solid and pulsing, the hovered one fainter.
      if (!boom) {
        const mark = (s: Sel, strong: boolean) => {
          g.save()
          g.shadowColor = '#7ff0ff'
          g.shadowBlur = strong ? 12 : 6
          g.strokeStyle = strong ? `rgba(127,240,255,${0.75 + 0.25 * Math.sin(now / 160)})` : 'rgba(127,240,255,0.6)'
          g.lineWidth = (strong ? 2.6 : 1.8) / z
          g.lineJoin = 'round'
          if ('hp' in s) {
            const [x, y] = hpAt(s.hp)
            const hp = t.hardpoints[s.hp]
            const r = Math.max(9 / z, (model?.mounts[s.hp]?.r ?? ((hp.s ?? 0.05) * t.size) / 2 / k) * k * 1.3)
            g.beginPath()
            g.arc(x, y, r, 0, TAU)
            g.stroke()
          } else if (model) {
            const p = model.parts[s.part]
            g.rotate(rot)
            g.scale(k, k)
            g.lineWidth /= k
            g.beginPath()
            p.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
            g.closePath()
            g.stroke()
          }
          g.restore()
        }
        if (hover && !sameSel(hover, selected)) mark(hover, false)
        if (selected) mark(selected, true)
      }
      if (show.hardpoints && !boom) {
        t.hardpoints.forEach((hp, i) => {
          const [x, y] = hpAt(i)
          const r = Math.max(7 / z, (hp.s ?? 0.05) * t.size * 0.55)
          const d = dmg.hps[i]
          g.lineWidth = 2 / z
          g.strokeStyle = 'rgba(0,0,0,0.6)'
          g.beginPath()
          g.arc(x, y, r, 0, TAU)
          g.stroke()
          g.strokeStyle = d.hp <= 0 ? '#ff5a50' : HP_COLOR[hp.kind]
          g.beginPath()
          g.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.max(0.05, d.hp / d.max) * TAU)
          g.stroke()
          g.fillStyle = '#e8eef8'
          g.font = `600 ${10 / z}px system-ui, sans-serif`
          g.fillText(String(i + 1), x + r + 2 / z, y - r)
        })
        // Engine glow spots.
        if (model)
          for (const [ex, ey] of model.engines) {
            const [x, y] = toWorld(ex, ey)
            g.strokeStyle = '#ffe066'
            g.lineWidth = 1.2 / z
            g.beginPath()
            g.moveTo(x - 4 / z, y)
            g.lineTo(x + 4 / z, y)
            g.moveTo(x, y - 4 / z)
            g.lineTo(x, y + 4 / z)
            g.stroke()
          }
      }
      if (live.current.workshop) {
        // The light's direction, so the cel shading can be judged.
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.strokeStyle = 'rgba(255,230,150,0.7)'
        g.fillStyle = 'rgba(255,230,150,0.9)'
        g.lineWidth = 1.5
        g.beginPath()
        g.arc(26, 26, 7, 0, TAU)
        g.fill()
        g.beginPath()
        g.moveTo(26 - LIGHT[0] * 10, 26 - LIGHT[1] * 10)
        g.lineTo(26 - LIGHT[0] * 30, 26 - LIGHT[1] * 30)
        g.stroke()
        const cs = cacheStats()
        g.font = '11px system-ui, sans-serif'
        g.fillText(`light · ${cs.bitmaps} bitmaps, ${cs.mb.toFixed(1)} MB`, 44, 30)
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [fx, stars])

  /** What's under a point on the screen: worked out from the model's actual parts and mounts as
   * the last frame placed them (zoom, turn), mounts within a finger's width however small. */
  const hitAt = (cx: number, cy: number): Sel | null => {
    const { t, model, dmg, boom } = live.current
    if (boom) return null
    const rect = canvas.current!.getBoundingClientRect()
    const { z, rot } = view.current
    const wx = (cx - rect.left - rect.width / 2) / z
    const wy = (cy - rect.top - rect.height / 2) / z
    const finger = (coarseRef.current ? 16 : 7) / z
    if (model) {
      const k = model.long / t.size
      const mx = (wx * Math.cos(-rot) - wy * Math.sin(-rot)) * k
      const my = (wx * Math.sin(-rot) + wy * Math.cos(-rot)) * k
      const st = hullState(model, { id: 1, hull: dmg.hull * t.hull, hullMax: t.hull, hps: dmg.hps }, t.tier)
      const hit = pickAt(model, mx, my, st.detached | dmg.forced, finger * k)
      return hit ? ('mount' in hit ? { hp: hit.mount } : { part: hit.part }) : null
    }
    // A sprite: only its hardpoints can be picked.
    let best: Sel | null = null
    let bestD = Infinity
    t.hardpoints.forEach((hp, i) => {
      const [x, y] = hpAt(i)
      const d = Math.hypot(wx - x, wy - y)
      if (d < Math.max(finger, (hp.s ?? 0.05) * t.size * 0.6) && d < bestD) (best = { hp: i }), (bestD = d)
    })
    return best
  }
  const coarseRef = useRef(false)
  coarseRef.current = useCoarse()

  // Pointer: drag to turn it, wheel or pinch to zoom, hover to highlight, click or tap to use the
  // tool on what's under it, hold a finger down for the action wheel.
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const pts = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ d: number; zoom: number } | null>(null)
  const press = useRef(new LongPress())
  const relative = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top] as const
  }
  const down = (e: React.PointerEvent) => {
    try {
      canvas.current!.setPointerCapture(e.pointerId)
    } catch {
      // Synthetic pointers (tests) can't be captured; dragging still works without it.
    }
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()]
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.current.zoom }
      drag.current = null
      press.current.cancel()
      return
    }
    drag.current = { x: e.clientX, y: e.clientY, moved: false }
    if (isTouch(e)) {
      const hit = hitAt(e.clientX, e.clientY)
      if (hit) {
        const [x, y] = relative(e)
        onHover(hit, x, y)
        const { clientX, clientY } = e
        press.current.start(e, () => {
          if (drag.current) drag.current.moved = true
          onLongPress(hit, clientX, clientY)
        })
      }
    }
  }
  const moveP = (e: React.PointerEvent) => {
    if (!pts.current.has(e.pointerId)) {
      // A mouse moving over the view without a button down: hover.
      if (!isTouch(e)) {
        const [x, y] = relative(e)
        onHover(hitAt(e.clientX, e.clientY), x, y)
      }
      return
    }
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current && pts.current.size >= 2) {
      const [a, b] = [...pts.current.values()]
      view.current.zoom = Math.min(6, Math.max(0.3, (pinch.current.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / Math.max(1, pinch.current.d)))
      return
    }
    const d = drag.current
    if (!d) return
    press.current.move(e)
    const dx = e.clientX - d.x
    if (!d.moved && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > TAP_SLOP) {
      d.moved = true
      press.current.cancel()
      onHover(null, 0, 0)
    }
    if (d.moved) {
      view.current.rot += dx * 0.01
      d.x = e.clientX
      d.y = e.clientY
    }
  }
  const up = (e: React.PointerEvent) => {
    pts.current.delete(e.pointerId)
    if (pts.current.size < 2) pinch.current = null
    press.current.cancel()
    const d = drag.current
    drag.current = null
    if (isTouch(e)) onHover(null, 0, 0)
    if (!d || d.moved || press.current.fired) return
    onClick(hitAt(e.clientX, e.clientY))
  }
  const wheel = (e: React.WheelEvent) => {
    view.current.zoom = Math.min(6, Math.max(0.3, view.current.zoom * Math.exp(-e.deltaY * 0.0015)))
  }
  return (
    <canvas
      ref={canvas}
      className={`ew-cx-canvas ${hover ? 'is-over' : ''}`}
      onPointerDown={down}
      onPointerMove={moveP}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={(e) => !isTouch(e) && onHover(null, 0, 0)}
      onWheel={wheel}
    />
  )
}

export function Codex({ sound, onClose }: { sound: EmpiresSound; onClose: () => void }) {
  return (
    <div className="ew-root ew-deck ew-codex" onContextMenu={(e) => e.preventDefault()}>
      <WheelHost>
        <CodexBody sound={sound} onClose={onClose} />
      </WheelHost>
    </div>
  )
}

function CodexBody({ sound, onClose }: { sound: EmpiresSound; onClose: () => void }) {
  const [faction, setFaction] = useState<FactionId>('republic')
  const list = useMemo(() => UNITS.filter((u) => u.faction === faction), [faction])
  const [pickId, setPickId] = useState<string>('r-frigate')
  const base = list.find((u) => u.id === pickId) ?? list[0]
  const [level, setLevel] = useState(4)
  const t = shown(base, level)
  const styles = modelStyles(t)
  const [style, setStyle] = useState('')
  const model = modelFor(t, styles.includes(style) ? style : '')
  const [workshop, setWorkshop] = useState(false)
  const [show, setShow] = useState<Show>({ hardpoints: false, ranges: false, glow: true, outlines: false, spin: false })
  const [tool, setTool] = useState<Tool>('inspect')
  const [dmg, setDmg] = useState<Damage>(() => fresh(t))
  const [boom, setBoom] = useState<{ n: number; force: BreakKind | null } | null>(null)
  const [force, setForce] = useState<BreakKind | null>(null)
  const [note, setNote] = useState('')
  const [selected, setSelected] = useState<Sel | null>(null)
  const [hover, setHover] = useState<{ sel: Sel; x: number; y: number; fromList?: boolean } | null>(null)
  const [resetKey, setResetKey] = useState(0)
  const coarse = useCoarse()
  const wheel = useWheel()
  // A different unit (or station level, or frame): start it undamaged, nothing selected.
  useEffect(() => {
    setDmg(fresh(t))
    setBoom(null)
    setNote('')
    setSelected(null)
    setHover(null)
  }, [t, model])
  // Esc clears the selection first, then closes the Codex.
  const selRef = useRef(selected)
  selRef.current = selected
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (selRef.current) setSelected(null)
      else onClose()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])
  const click = (fn: () => void) => () => {
    sound.unlock()
    sound.click()
    fn()
  }
  const toggle = (k: keyof Show, label: string, tip?: string) => (
    <button className={show[k] ? 'is-on' : ''} aria-pressed={show[k]} onClick={click(() => setShow((s) => ({ ...s, [k]: !s[k] })))} data-tip={tip}>
      {label}
    </button>
  )
  const wreckable = !!BREAK_WEIGHTS[t.tier]

  // What the tools do to a module or part.
  const damage = (s: Sel, all = false) => {
    if ('hp' in s) {
      // Each hit takes off half its health; a destroyed one is rebuilt.
      const hps = dmg.hps.map((x) => ({ ...x }))
      const cur = hps[s.hp]
      cur.hp = all ? 0 : cur.hp <= 0 ? cur.max : cur.hp > cur.max * 0.5 ? cur.max * 0.5 : 0
      setBoom(null)
      setDmg({ ...dmg, hps })
      setNote(`${selName(t, model, s)}: ${cur.hp <= 0 ? (model?.mounts[s.hp]?.detach ? 'blown off' : 'destroyed') : cur.hp >= cur.max ? 'rebuilt' : `${Math.round((cur.hp / cur.max) * 100)}%`}`)
      return
    }
    detach(s)
  }
  const detach = (s: Sel) => {
    if (!model) return
    if ('hp' in s) {
      if (model.mounts[s.hp]?.detach) return damage(s, true)
      return setNote(`${selName(t, model, s)}: doesn't come off, it's wrecked where it stands (Damage it)`)
    }
    const d = model.detachable.indexOf(s.part)
    if (d < 0) return setNote(`${selName(t, model, s)}: part of the hull, doesn't come off`)
    setBoom(null)
    setDmg({ ...dmg, forced: dmg.forced ^ (1 << d) })
    setNote(`${selName(t, model, s)}: ${dmg.forced & (1 << d) ? 'back on' : `shot off (${info(t, model, s).off.toLowerCase()})`}`)
  }
  const use = (s: Sel | null) => {
    const how = workshop ? tool : 'inspect'
    if (how === 'inspect' || !s) {
      setSelected(s && sameSel(s, selected) ? null : s)
      if (s) sound.click()
      return
    }
    if (how === 'damage') damage(s)
    else detach(s)
  }
  const longPress = (s: Sel, x: number, y: number) => {
    const mount = 'hp' in s
    const canOff = mount ? !!model?.mounts[s.hp]?.detach : !!model && model.detachable.includes(s.part)
    wheel({
      x,
      y,
      title: selName(t, model, s),
      items: [
        { id: 'inspect', label: 'Inspect', icon: <Icon name="target" size={18} />, run: () => setSelected(s) },
        { id: 'damage', label: 'Damage', icon: <Icon name="attack" size={18} />, disabled: !model ? true : mount ? false : 'Only modules take damage', run: () => damage(s) },
        { id: 'destroy', label: 'Destroy', icon: <Icon name="stop" size={18} />, danger: true, disabled: !model ? true : mount ? false : 'Only modules can be destroyed', run: () => damage(s, true) },
        { id: 'detach', label: 'Detach', icon: <Icon name="move" size={18} />, disabled: canOff ? false : "Doesn't come off", run: () => detach(s) },
      ],
    })
  }
  const toolHint = !workshop || tool === 'inspect' ? 'select it' : tool === 'damage' ? 'damage it' : 'shoot it off'
  return (
    <>
      <Tips />
      <header className="ew-cx-top">
        <h2>Codex</h2>
        <div className="ew-seg" role="group" aria-label="Side">
          {(['republic', 'droid'] as const).map((f) => (
            <button key={f} className={faction === f ? 'is-on' : ''} onClick={click(() => setFaction(f))}>
              {FACTIONS[f].name}
            </button>
          ))}
        </div>
        <button className={`ew-cx-ws ${workshop ? 'is-on' : ''}`} aria-pressed={workshop} onClick={click(() => setWorkshop(!workshop))} data-tip="Tools for checking the models: parts, hardpoints, damage and break-ups">
          <Icon name="gear" size={14} /> Workshop
        </button>
        <button className="ew-close" onClick={click(onClose)} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="ew-cx-body">
        <nav className="ew-cx-nav" aria-label="Units">
          {TIER_GROUPS.map((grp) => {
            const units = list.filter((u) => grp.tiers.includes(u.tier))
            if (!units.length) return null
            return (
              <section key={grp.name}>
                <h5>{grp.name}</h5>
                {units.map((u) => (
                  <button key={u.id} className={u.id === base.id ? 'is-on' : ''} onClick={click(() => setPickId(u.id))}>
                    <span>{u.name}</span>
                    {hasModel(u) && <em className="ew-cx-tag" data-tip="Drawn as a procedural model (the setting Procedural models switches back to the sprites)">Model</em>}
                  </button>
                ))}
              </section>
            )
          })}
        </nav>
        <main className="ew-cx-view">
          <div className="ew-cx-stage">
            <Viewer
              t={t}
              model={model}
              workshop={workshop}
              show={show}
              dmg={dmg}
              boom={boom}
              hover={hover?.sel ?? null}
              selected={selected}
              resetKey={resetKey}
              onHover={(s, x, y) => setHover((h) => (s ? { sel: s, x, y } : h?.fromList ? h : null))}
              onClick={use}
              onLongPress={longPress}
              onNote={setNote}
            />
            {hover && !hover.fromList && <HoverTip t={t} model={model} sel={hover.sel} x={hover.x} y={hover.y} dmg={dmg} />}
            {(t.tier === 'station' || styles.length > 0) && (
              <div className="ew-cx-level">
                {t.tier === 'station' && <Seg label="Station level" value={level} options={STATIONS[t.faction].stages.map((_, i) => [i + 1, `Level ${i + 1}`] as [number, string])} onChange={(v) => setLevel(v)} />}
                {styles.length > 0 && <Seg label="Outer frame" value={styles.includes(style) ? style : styles[0]} options={styles.map((s) => [s, s[0].toUpperCase() + s.slice(1)] as [string, string])} onChange={(v) => setStyle(v)} />}
              </div>
            )}
            <button className="ew-cx-reset" onClick={click(() => setResetKey((k) => k + 1))} data-tip="Back to nose up at the starting zoom">
              <Icon name="restart" size={13} /> Reset view
            </button>
            <p className="ew-cx-hint ew-muted ew-small">
              {coarse ? 'Drag to turn, pinch to zoom' : 'Drag to turn, scroll to zoom'}
              {` · ${coarse ? 'tap' : 'click'} a module or part to ${toolHint}`}
              {coarse ? ', hold for more' : ''}
              {!model ? ' · sprite (no model yet)' : ''}
            </p>
          </div>
          {workshop && (
            <div className="ew-cx-tools">
              <div className="ew-cx-row">
                <Seg label="Click tool" value={tool} options={[['inspect', 'Inspect'], ['damage', 'Damage'], ['detach', 'Detach']]} onChange={(v) => setTool(v)} />
                {toggle('hardpoints', 'Hardpoints')}
                {toggle('ranges', 'Ranges')}
                {toggle('glow', 'Engine glow')}
                {model && toggle('outlines', 'Part outlines')}
                {toggle('spin', 'Spin', 'Turns the model slowly, to watch the light move over it')}
              </div>
              {model && (
                <>
                  <label className="ew-cx-row ew-cx-slider">
                    <span>Hull</span>
                    <input type="range" min={0.01} max={1} step={0.01} value={dmg.hull} onChange={(e) => (setBoom(null), setDmg({ ...dmg, hull: Number(e.target.value) }))} />
                    <b>{Math.round(dmg.hull * 100)}%</b>
                  </label>
                  {model.detachable.length > 0 && (
                    <div className="ew-cx-row ew-cx-parts">
                      <span className="ew-muted">Detach</span>
                      {model.detachable.map((pi, i) => {
                        const off = !!(dmg.forced & (1 << i))
                        return (
                          <button
                            key={pi}
                            className={off ? 'is-on' : ''}
                            onPointerEnter={() => setHover({ sel: { part: pi }, x: 0, y: 0, fromList: true })}
                            onPointerLeave={() => setHover(null)}
                            onClick={click(() => detach({ part: pi }))}
                          >
                            {model.parts[pi].id}
                          </button>
                        )
                      })}
                    </div>
                  )}
                  <div className="ew-cx-row">
                    <button className="ew-cx-destroy" onClick={click(() => setBoom({ n: (boom?.n ?? 0) + 1, force }))} data-tip="Plays the death the battle would show; again for another roll of how it breaks">
                      {boom ? 'Re-roll' : 'Destroy'}
                    </button>
                    {wreckable && (
                      <Seg
                        label="Break-up"
                        value={force ?? 'roll'}
                        options={[['roll', 'As rolled'], ['intact', 'Intact'], ['half', 'Half'], ['pieces', 'Pieces']]}
                        onChange={(v) => {
                          const f = v === 'roll' ? null : (v as BreakKind)
                          setForce(f)
                          if (boom) setBoom({ n: boom.n, force: f })
                        }}
                      />
                    )}
                    <button onClick={click(() => (setBoom(null), setDmg(fresh(t)), setNote('')))}>Reset</button>
                  </div>
                  <p className="ew-cx-note ew-small">
                    {note || (wreckable ? `Breaks up: intact ${BREAK_WEIGHTS[t.tier]!.intact * 100}%, in half ${BREAK_WEIGHTS[t.tier]!.half * 100}%, in pieces ${BREAK_WEIGHTS[t.tier]!.pieces * 100}%` : 'Bursts into fragments when destroyed')}
                    {model ? ` · ${model.parts.length} parts, ${model.mounts.length} mounts` : ''}
                  </p>
                </>
              )}
            </div>
          )}
        </main>
        <aside className="ew-cx-side">
          <Frame title="Specifications">
            <Stats
              t={t}
              model={model}
              dmg={dmg}
              selected={selected}
              hover={hover?.sel ?? null}
              onSelect={(s) => (sound.click(), setSelected(s))}
              onHover={(s) => setHover(s ? { sel: s, x: 0, y: 0, fromList: true } : null)}
            />
          </Frame>
        </aside>
      </div>
    </>
  )
}
