import { useEffect, useMemo, useRef, useState } from 'react'
import { ABILITIES, FACTIONS, STATIONS, TECH, TECHS, UNITS, moduleSprite, roleOf, stationType, type FactionId, type Tier, type UnitType, type WeaponKind } from './data'
import { Frame, Icon, Tips, fmt } from './Hud'
import { HP_COLOR, hpName } from './icons'
import { BREAK_WEIGHTS, hasModel, hullState, modelFor, pickAt, type Model } from './models/index.ts'
import { ModelFx } from './models/fx.ts'
import { LIGHT } from './models/kit.ts'
import { cacheStats, drawHull, drawMounts, liveEngines } from './models/paint.ts'
import type { BreakKind } from './models/types.ts'
import { spriteUrl } from './render'
import type { EmpiresSound } from './sound'
import { Seg } from './Menus'
import { useCoarse } from './Touch'
import './codex.css'

// The Codex: every ship and structure of both sides, with its numbers (hull, shields, guns and
// their reach, cost, what it beats and what beats it) next to a turning view of it. The view shows
// the procedural model where a unit has one and its sprite where it doesn't yet.
//
// Workshop mode is for checking models: part outlines, hardpoints, weapon ranges and engine glow
// can be switched on, the hull can be dragged down, parts and hardpoints clicked (tapped) to shoot
// them up or off, and Destroy plays the death break-up the battle would show, re-rolled to see the
// other ways it can break.

const TIER_GROUPS: { name: string; tiers: Tier[] }[] = [
  { name: 'Strike craft', tiers: ['fighter'] },
  { name: 'Gunships', tiers: ['gunship'] },
  { name: 'Frigates', tiers: ['frigate'] },
  { name: 'Cruisers', tiers: ['cruiser'] },
  { name: 'Flagships', tiers: ['capital'] },
  { name: 'Structures', tiers: ['station', 'mine', 'defense'] },
]
const WEAPON_NAME: Record<WeaponKind, string> = { laser: 'Lasers', flak: 'Flak', turbo: 'Turbolaser', missile: 'Torpedoes', ion: 'Ion cannon' }
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

function Stats({ t }: { t: UnitType }) {
  const role = roleOf(t)
  const g = guns(t)
  const dps = g.reduce((s, x) => s + (x.dmg * x.burst * x.n) / x.cd, 0)
  const tech = t.tech ? TECH[t.tech] : undefined
  const mods = new Map<string, { n: number; hp: number; kind: keyof typeof HP_COLOR }>()
  for (const h of t.hardpoints) {
    const name = hpName(h)
    const m = mods.get(name)
    if (m) m.n++
    else mods.set(name, { n: 1, hp: h.hp, kind: h.kind })
  }
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
      {mods.size > 0 && (
        <>
          <h5>Hardpoints</h5>
          <ul className="ew-cx-list">
            {[...mods].map(([name, m]) => (
              <li key={name}>
                <i style={{ background: HP_COLOR[m.kind] }} />
                <span>
                  {m.n > 1 ? `${m.n}× ` : ''}
                  {name}
                </span>
                <small>{fmt(m.hp)} hp each</small>
              </li>
            ))}
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

/** Toggles and tools of the workshop. */
type Show = { hardpoints: boolean; ranges: boolean; glow: boolean; outlines: boolean; spin: boolean }

function Viewer({ t, model, workshop, show, dmg, setDmg, boom, onPick }: {
  t: UnitType
  model: Model | null
  workshop: boolean
  show: Show
  dmg: Damage
  setDmg: (d: Damage) => void
  /** The destroy preview: a counter that changes for every Destroy or re-roll, and the outcome forced (or null). */
  boom: { n: number; force: BreakKind | null } | null
  onPick: (text: string) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const view = useRef({ rot: -0.5, zoom: 1, spin: 0.25 })
  const live = useRef({ t, model, workshop, show, dmg, boom, setDmg, onPick })
  live.current = { t, model, workshop, show, dmg, boom, setDmg, onPick }
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
  // A new unit: back to a fitting zoom, the previous one's debris swept away.
  useEffect(() => {
    view.current.zoom = 1
    fx.clear()
  }, [t, fx])
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
      live.current.onPick(`Wreck ${id}${boom.force ? '' : ' (rolled)'}: ${kind === 'intact' ? 'stays in one scorched piece' : kind === 'half' ? 'broken in half' : 'broken into pieces'}`)
    } else {
      fx.shatter(model, t.tier, 0, 0, view.current.rot, size, 0, 0, id, st)
      live.current.onPick(`Unit ${id}: burst into fragments`)
    }
  }, [boom?.n, boom?.force, model])

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
      const { t, model, show, dmg, boom } = live.current
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = c.clientWidth
      const h = c.clientHeight
      if (!w || !h) return
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr)
        c.height = Math.round(h * dpr)
      }
      const v = view.current
      if (show.spin && !drag.current) v.rot += dt * v.spin
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
      // Fit the unit (or its longest gun, with the ranges on) into the view.
      const reach = show.ranges ? Math.max(t.size * 0.6, ...guns(t).map((x) => x.range)) * 2 : t.size * 1.25
      const fit = (Math.min(w, h) * 0.86) / reach
      const z = fit * v.zoom
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
      if (show.ranges) {
        g.lineWidth = 1.5 / z
        g.font = `${11 / z}px system-ui, sans-serif`
        g.textAlign = 'center'
        const seen = new Set<string>()
        for (const x of guns(t)) {
          const key = `${x.kind}${x.range}`
          if (seen.has(key)) continue
          seen.add(key)
          g.strokeStyle = `rgba(${RANGE_RGB[x.kind]},0.6)`
          g.setLineDash([10 / z, 6 / z])
          g.beginPath()
          g.arc(0, 0, x.range, 0, TAU)
          g.stroke()
          g.fillStyle = `rgba(${RANGE_RGB[x.kind]},0.9)`
          g.fillText(`${WEAPON_NAME[x.kind]} ${x.range}`, 0, -x.range - 4 / z)
        }
        g.setLineDash([])
        g.textAlign = 'start'
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
          // With nothing to shoot at, the crews sweep their guns to and fro.
          const sweep = now / 1000 * (0.3 + (i % 4) * 0.05) + i * 1.7
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
      if (show.hardpoints && !boom) {
        const [sw, sh] = model ? [model.w * k, model.h * k] : [t.size * Math.min(1, t.aspect), t.size / Math.max(1, t.aspect)]
        t.hardpoints.forEach((hp, i) => {
          const mx = (hp.x / 10 - 0.5) * sw
          const my = (hp.y / 10 - 0.5) * sh
          const x = mx * Math.cos(rot) - my * Math.sin(rot)
          const y = mx * Math.sin(rot) + my * Math.cos(rot)
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
          g.fillText(String(i), x + r + 2 / z, y - r)
        })
        // Engine glow spots.
        if (model) for (const [ex, ey] of model.engines) {
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

  // Pointer: drag to turn it, wheel or pinch to zoom, click or tap a part in the workshop.
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const pts = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ d: number; zoom: number } | null>(null)
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
    } else drag.current = { x: e.clientX, y: e.clientY, moved: false }
  }
  const moveP = (e: React.PointerEvent) => {
    if (!pts.current.has(e.pointerId)) return
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current && pts.current.size >= 2) {
      const [a, b] = [...pts.current.values()]
      view.current.zoom = Math.min(6, Math.max(0.3, (pinch.current.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / Math.max(1, pinch.current.d)))
      return
    }
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    if (Math.abs(dx) + Math.abs(e.clientY - d.y) > 6) d.moved = true
    if (d.moved) view.current.rot += dx * 0.01
    d.x = e.clientX
    d.y = e.clientY
  }
  const up = (e: React.PointerEvent) => {
    pts.current.delete(e.pointerId)
    if (pts.current.size < 2) pinch.current = null
    const d = drag.current
    drag.current = null
    if (!d || d.moved || !live.current.workshop) return
    pick(e.clientX, e.clientY)
  }
  const pick = (cx: number, cy: number) => {
    const { t, model, dmg, setDmg, onPick, show, boom } = live.current
    if (!model || boom) return
    const c = canvas.current!
    const rect = c.getBoundingClientRect()
    const w = rect.width
    const h = rect.height
    const reach = show.ranges ? Math.max(t.size * 0.6, ...guns(t).map((x) => x.range)) * 2 : t.size * 1.25
    const z = ((Math.min(w, h) * 0.86) / reach) * view.current.zoom
    const wx = (cx - rect.left - w / 2) / z
    const wy = (cy - rect.top - h / 2) / z
    const rot = view.current.rot
    const k = model.long / t.size
    const mx = (wx * Math.cos(-rot) - wy * Math.sin(-rot)) * k
    const my = (wx * Math.sin(-rot) + wy * Math.cos(-rot)) * k
    const st = hullState(model, { id: 1, hull: dmg.hull * t.hull, hullMax: t.hull, hps: dmg.hps }, t.tier)
    const hit = pickAt(model, mx, my, st.detached | dmg.forced)
    if (!hit) return
    if ('mount' in hit) {
      // Each click takes off half its health; a destroyed one is rebuilt.
      const i = hit.mount
      const hps = dmg.hps.map((x) => ({ ...x }))
      const cur = hps[i]
      cur.hp = cur.hp <= 0 ? cur.max : cur.hp > cur.max * 0.5 ? cur.max * 0.5 : 0
      setDmg({ ...dmg, hps })
      onPick(`${hpName(t.hardpoints[i])} ${i}: ${cur.hp <= 0 ? (model.mounts[i].detach ? 'blown off' : 'destroyed') : cur.hp >= cur.max ? 'rebuilt' : `${Math.round((cur.hp / cur.max) * 100)}%`}`)
      return
    }
    const p = model.parts[hit.part]
    const d = model.detachable.indexOf(hit.part)
    if (d < 0) {
      onPick(`${p.id}: part of the hull, doesn't come off`)
      return
    }
    setDmg({ ...dmg, forced: dmg.forced | (1 << d) })
    const why = p.detach!.hp !== undefined ? `with hardpoint ${p.detach!.hp}` : p.detach!.hull !== undefined ? `below ${Math.round(p.detach!.hull * 100)}% hull` : 'when it dies'
    onPick(`${p.id}: shot off (comes off ${why} in battle)`)
  }
  const wheel = (e: React.WheelEvent) => {
    view.current.zoom = Math.min(6, Math.max(0.3, view.current.zoom * Math.exp(-e.deltaY * 0.0015)))
  }
  return <canvas ref={canvas} className={`ew-cx-canvas ${workshop ? 'is-workshop' : ''}`} onPointerDown={down} onPointerMove={moveP} onPointerUp={up} onPointerCancel={up} onWheel={wheel} />
}

export function Codex({ sound, onClose }: { sound: EmpiresSound; onClose: () => void }) {
  const [faction, setFaction] = useState<FactionId>('republic')
  const list = useMemo(() => UNITS.filter((u) => u.faction === faction), [faction])
  const [pickId, setPickId] = useState<string>('r-frigate')
  const base = list.find((u) => u.id === pickId) ?? list[0]
  const [level, setLevel] = useState(4)
  const t = shown(base, level)
  const model = modelFor(t)
  const [workshop, setWorkshop] = useState(false)
  const [show, setShow] = useState<Show>({ hardpoints: false, ranges: false, glow: true, outlines: false, spin: true })
  const [dmg, setDmg] = useState<Damage>(() => fresh(t))
  const [boom, setBoom] = useState<{ n: number; force: BreakKind | null } | null>(null)
  const [force, setForce] = useState<BreakKind | null>(null)
  const [note, setNote] = useState('')
  const coarse = useCoarse()
  // A different unit (or station level): start it undamaged.
  useEffect(() => {
    setDmg(fresh(t))
    setBoom(null)
    setNote('')
  }, [t])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])
  const click = (fn: () => void) => () => {
    sound.unlock()
    sound.click()
    fn()
  }
  const toggle = (k: keyof Show, label: string) => (
    <button className={show[k] ? 'is-on' : ''} aria-pressed={show[k]} onClick={click(() => setShow((s) => ({ ...s, [k]: !s[k] })))}>
      {label}
    </button>
  )
  const wreckable = !!BREAK_WEIGHTS[t.tier]
  return (
    <div className="ew-root ew-deck ew-codex" onContextMenu={(e) => e.preventDefault()}>
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
                    {hasModel(u) && <em className="ew-cx-tag" data-tip="Drawn as a procedural model (the rest still use their sprites)">Model</em>}
                  </button>
                ))}
              </section>
            )
          })}
        </nav>
        <main className="ew-cx-view">
          <Viewer t={t} model={model} workshop={workshop} show={show} dmg={dmg} setDmg={setDmg} boom={boom} onPick={setNote} />
          {t.tier === 'station' && (
            <div className="ew-cx-level">
              <Seg label="Station level" value={level} options={STATIONS[t.faction].stages.map((_, i) => [i + 1, `Level ${i + 1}`] as [number, string])} onChange={(v) => setLevel(v)} />
            </div>
          )}
          <p className="ew-cx-hint ew-muted ew-small">
            {coarse ? 'Drag to turn, pinch to zoom' : 'Drag to turn, scroll to zoom'}
            {workshop && model ? (coarse ? ' · tap a part or hardpoint to shoot it' : ' · click a part or hardpoint to shoot it') : ''}
            {!model ? ' · sprite (no model yet)' : ''}
          </p>
          {workshop && (
            <div className="ew-cx-tools">
              <div className="ew-cx-row">
                {toggle('hardpoints', 'Hardpoints')}
                {toggle('ranges', 'Ranges')}
                {toggle('glow', 'Engine glow')}
                {model && toggle('outlines', 'Part outlines')}
                {toggle('spin', 'Turntable')}
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
                          <button key={pi} className={off ? 'is-on' : ''} onClick={click(() => (setBoom(null), setDmg({ ...dmg, forced: dmg.forced ^ (1 << i) })))}>
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
                    {wreckable && <Seg label="Break-up" value={force ?? 'roll'} options={[['roll', 'As rolled'], ['intact', 'Intact'], ['half', 'Half'], ['pieces', 'Pieces']]} onChange={(v) => { const f = v === 'roll' ? null : (v as BreakKind); setForce(f); if (boom) setBoom({ n: boom.n, force: f }) }} />}
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
            <Stats t={t} />
          </Frame>
        </aside>
      </div>
    </div>
  )
}
