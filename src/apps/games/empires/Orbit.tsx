import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FACTIONS, MODULE, ORBITAL_MAX, ORBITAL_TOP, ORBITALS, REBUILD, dims, orbitalMod, orbitalName, orbitalSlots, orbitalType, stageName, stationType, yardOf, yardType, type FactionId, type OrbitalModId, type UnitType } from './data'
import {
  AUTO_SPOT, SPOT_D, structLong, YARD_KINDS, cancelBuild, orbitalAt, orbitalCost, orbitalLock, orbitalTime, orbitalWorkId, orderOrbital, parseOrbital, rebuildLevel, slotLevel,
  type Galaxy, type OrbitalState, type OrbitalWork, type Planet, type PlanetBase, type Spot, type StructId,
} from './galaxy'
import { HpIcon, Icon, ShipArt, unitTip } from './Hud'
import { HP_COLOR } from './icons'
import { modelFor } from './models/index'
import { thumbnail } from './models/paint'
import type { EmpiresSound } from './sound'
import { TAP_SLOP } from './Touch'

// Galactic conquest's orbit view: zoomed right in on one planet, its Command Station, its yards and
// its defense stations round it, drawn as their real models (from the same cached bitmaps as the
// cards: one painted picture per look), slowly orbiting together, where the planet's layout on its
// battle map puts them, turned back round the planet (conquestMap.ts mapToPolar; they are placed on
// the map's preview beside it, PlanetMap.tsx). Each can be picked (the orbit card then shows its
// orders); only what is built shows (and ruins), each as it looks at its level, the empty yard and
// defense sites listed on the Command Station's card to order them from. The same
// structures show as small pictures round every planet at the zoom between (see orbitThings and the
// galaxy map's pins), so what a planet has is plain to see without zooming all the way in.
//
// Also the Defense page of a planet's shipyard (PlanetDefense): the two defense sites, their levels
// and their module slots, ordered in the planet's queue.

const ME = 0

/** One structure round a planet as the views show it: what it is now (null: an empty site), standing,
 * a ruin, being built (or rebuilt from its ruin: drawn as what it will be), or a site to build on. */
export type OrbitThing = { id: StructId; t: UnitType; state: 'up' | 'ruin' | 'ghost' | 'building'; name: string }

/** The work under way on one of a planet's structures (the head of its queue, the one being worked
 * on): a new one going up (or a ruin rebuilt, `t` what it will be), or one that stands being
 * upgraded or fitted (an upgrade, a module, an expansion). */
export type StructWork = { id: StructId; kind: 'build' | 'up'; unit: string; t?: UnitType; name?: string }

/**
 * The work under way on planet `p`'s structures, as side ME can see it: only while we see the system
 * (`live`; the fog of war hides queues), and only what is being worked on now (the head of the
 * queue; what waits behind it isn't started). Faction `f`'s, the planet's holder.
 */
export function structWork(f: FactionId, p: Planet, base: PlanetBase, live: boolean): StructWork | null {
  const q = p.queue[0]
  if (!live || !q || p.station <= 0) return null
  if (q.unit === 'yard' || q.unit === 'cyard') {
    if (base.yards[q.unit] === 'up') return null
    const t = yardOf(f, q.unit)
    return { id: q.unit, kind: 'build', unit: q.unit, t, name: t.name }
  }
  const w = parseOrbital(q.unit)
  if (w) {
    const id: StructId = w.i ? 'def1' : 'def0'
    const o = base.orb?.[w.i]
    if (w.k === 'build' && (!o || o.ruin)) {
      const lv = q.lv ?? o?.level ?? 1
      return { id, kind: 'build', unit: q.unit, t: orbitalType(f, lv, []), name: orbitalName(f, lv) }
    }
    return o && !o.ruin ? { id, kind: 'up', unit: q.unit } : null
  }
  if (q.unit === 'station') return { id: 'station', kind: 'up', unit: q.unit }
  const m = MODULE[q.unit as keyof typeof MODULE]
  if (m) return m.on === 'station' || base.yards[m.on] === 'up' ? { id: m.on, kind: 'up', unit: q.unit } : null
  return null
}

/** `things` with work `w` shown: a structure going up (or a ruin being rebuilt) as what it will be. */
export function withWork(things: OrbitThing[], w: StructWork | null): OrbitThing[] {
  if (!w || w.kind !== 'build' || !w.t) return things
  const order: StructId[] = ['station', 'yard', 'cyard', 'def0', 'def1']
  const out = things.filter((th) => th.id !== w.id)
  out.push({ id: w.id, t: w.t, state: 'building', name: w.name ?? w.t.name })
  return out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
}

/** How far the work at the head of planet `p`'s queue is (0 to 1) and the seconds it has left. */
export function workProgress(p: Planet): { done: number; left: number } {
  const q = p.queue[0]
  if (!q) return { done: 0, left: 0 }
  return { done: q.total > 0 ? Math.max(0, Math.min(1, 1 - q.left / q.total)) : 0, left: Math.max(0, Math.ceil(q.left)) }
}

/** A thin progress bar with the seconds left, for a structure being built or upgraded. */
export function WorkBar({ p, className, style }: { p: Planet; className: string; style?: React.CSSProperties }) {
  const { done, left } = workProgress(p)
  return (
    <span className={className} style={style} aria-hidden>
      <i style={{ transform: `scaleX(${done.toFixed(3)})` }} />
      <b>{left}s</b>
    </span>
  )
}

/**
 * What stands round a planet with a station of level `station` and buildings `base` (faction `f`'s):
 * its Command Station, each yard and each defense station, standing or a ruin, and with `sites` the
 * empty sites too (ours, to order from).
 */
export function orbitThings(f: FactionId, station: number, base: PlanetBase, sites: boolean): OrbitThing[] {
  if (station <= 0) return []
  const out: OrbitThing[] = [{ id: 'station', t: stationType(f, station, [], base.mods.filter((id) => MODULE[id].on === 'station')), state: 'up', name: stageName(f, station) }]
  for (const k of YARD_KINDS) {
    const y = base.yards[k]
    const t = yardOf(f, k)
    if (y === 'up') out.push({ id: k, t: yardType(t.id, base.mods), state: 'up', name: t.name })
    else if (y === 'ruin') out.push({ id: k, t, state: 'ruin', name: `${t.name} (ruin)` })
    else if (sites) out.push({ id: k, t, state: 'ghost', name: `${t.name} site` })
  }
  for (let i = 0; i < ORBITAL_MAX; i++) {
    const o = base.orb?.[i]
    const id: StructId = i ? 'def1' : 'def0'
    if (o && !o.ruin) out.push({ id, t: orbitalType(f, o.level, o.mods), state: 'up', name: orbitalName(f, o.level) })
    else if (o?.ruin) out.push({ id, t: orbitalType(f, o.level, []), state: 'ruin', name: `${orbitalName(f, o.level)} (ruin)` })
    else if (sites) out.push({ id, t: orbitalType(f, 1, []), state: 'ghost', name: `Defense site ${i + 1}` })
  }
  return out
}

/** A structure's picture: its model's cached still, nose up, `px` on its long side, and the margin
 * painted round its box (a share of its long side). */
export function structArt(t: UnitType, px: number) {
  const m = modelFor(t)
  return m ? { url: thumbnail(m, px).url, pad: 0.04 } : null
}

/** The camera the orbit view follows (the galaxy map's CamView). */
export type OrbitCam = { cam: { x: number; y: number; k: number }; size: { w: number; h: number }; sub: (f: () => void) => () => void }

/** How fast the structures orbit their planet together: once round in twelve minutes. */
const ORBIT_SPEED = (Math.PI * 2) / 720
/** How many pixels the orbit view's pictures are painted at on their long side. */
const ART_PX = 512

/**
 * The orbit view over the galaxy map: planet `p` (its middle at `at` on the map, `R` map units round)
 * with what stands round it, drawn in content pixels (100 for a map unit) that the camera scales and
 * places without a render (as the map's own layer is). It fades in as the camera closes in on the
 * planet (`kIn` is the zoom it settles at). `sel`: the structure picked; `onPick` picks one (null:
 * none). `spots`: where each sits round the planet (its own spot, AUTO_SPOT, where left out).
 */
export function OrbitView({ p, at, R, view, kIn, sel, faction, live, base, station, spots, onPick }: {
  p: Planet
  at: { x: number; y: number }
  R: number
  view: OrbitCam
  kIn: number
  sel: StructId | null
  faction: FactionId
  live: boolean
  base: PlanetBase
  station: number
  spots: Partial<Record<StructId, Spot>>
  onPick: (id: StructId | null) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const world = useRef<HTMLDivElement>(null)
  const ours = p.owner === ME && live
  // What stands there (and ruins), and what is being built: a site with nothing built or being built
  // on it shows nothing (the station's card lists them to build on).
  const work = structWork(faction, p, base, live)
  const things = withWork(orbitThings(faction, station, base, false), work)
  // The orbit's turn so far (radians), and whether it's held still (something picked).
  const phase = useRef(0)
  const held = useRef(false)
  held.current = !!sel
  const spotsRef = useRef(spots)
  spotsRef.current = spots
  const els = useRef(new Map<StructId, HTMLElement>())
  // The content pixels per planet radius (each structure is drawn its own length of them, see
  // structLong).
  const RD = R * 100
  // Each picture turned as it stands on the battle map (Spot.h), turning on with the orbit; one
  // with no heading stands nose up.
  const place = (id: StructId, el: HTMLElement) => {
    const s = spotsRef.current[id] ?? AUTO_SPOT[id]
    const a = s.a + phase.current
    const t = `translate(${(Math.cos(a) * s.d * RD).toFixed(2)}px, ${(Math.sin(a) * s.d * RD).toFixed(2)}px)`
    if (el.style.transform !== t) el.style.transform = t
    const inner = el.firstElementChild as HTMLElement | null
    if (!inner) return
    const r = s.h === undefined ? '' : `rotate(${(s.h + phase.current + Math.PI / 2).toFixed(4)}rad)`
    if (inner.style.transform !== r) inner.style.transform = r
    if (s.h === undefined) delete inner.dataset.heading
    else inner.dataset.heading = (s.h + phase.current).toFixed(4)
  }
  // The camera places the whole view (one transform) and fades it in; nothing renders for it.
  useLayoutEffect(() => {
    const aim = () => {
      const w = world.current
      const r = root.current
      if (!w || !r) return
      const { x, y, k } = view.cam
      const sx = (at.x - x) * k + view.size.w / 2
      const sy = (at.y - y) * k + view.size.h / 2
      const t = `translate(${sx.toFixed(2)}px, ${sy.toFixed(2)}px) scale(${(k / 100).toFixed(4)})`
      if (w.style.transform !== t) w.style.transform = t
      const alpha = String(Math.max(0, Math.min(1, (k - kIn * 0.55) / (kIn * 0.3))).toFixed(3))
      if (r.style.opacity !== alpha) r.style.opacity = alpha
      r.classList.toggle('is-faint', Number(alpha) < 0.6)
    }
    aim()
    return view.sub(aim)
  }, [view, at.x, at.y, kIn])
  // The slow orbit: one transform per structure a frame, held still while something is picked or
  // dragged (or the player asked for less motion).
  useEffect(() => {
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (!still && !held.current) phase.current += dt * ORBIT_SPEED
      for (const [id, el] of els.current) place(id, el)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, RD])
  /** A press on a structure: a tap picks it (structures are moved on the map's preview). */
  const down = (id: StructId, e: React.PointerEvent) => {
    e.stopPropagation()
    if (e.button !== 0) return
    const el = e.currentTarget as HTMLElement
    const x0 = e.clientX
    const y0 = e.clientY
    const slop = e.pointerType === 'mouse' ? 5 : TAP_SLOP
    let moved = false
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // (A pointer that went away.)
    }
    const move = (m: PointerEvent) => {
      if (m.pointerId === e.pointerId && Math.hypot(m.clientX - x0, m.clientY - y0) > slop) moved = true
    }
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      if (!moved && u.type === 'pointerup') onPick(sel === id ? null : id)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  return (
    <div ref={root} className={`ew-orbit ${live ? '' : 'is-fog'}`} aria-label={`Orbit of ${p.name}`}>
      <div ref={world} className="ew-orbit-world">
        <i className="ew-orbit-ring" style={{ width: RD * SPOT_D.max * 2, height: RD * SPOT_D.max * 2 }} aria-hidden />
        {things.map((th) => {
          const [dw, dh] = dims(th.t)
          const long = Math.max(dw, dh)
          const art = structArt(th.t, ART_PX)
          const f = (structLong(th.t) * RD) / long
          const w = (dw + long * 0.08) * f
          const h = (dh + long * 0.08) * f
          const busyHere = work?.id === th.id
          const tip = `${th.name}${th.state === 'building' ? `: under construction, ${workProgress(p).left}s left` : busyHere ? `: upgrading, ${workProgress(p).left}s left` : th.state === 'ruin' ? ': destroyed in a battle, rebuilt for half' : ''}. Click for its orders${ours ? `; drag it on the battle map beside the planet to place it${th.state !== 'ruin' ? ' and turn it' : ''}` : ''}.${ours && th.id === 'station' ? ' Its card lists the empty sites to build on.' : ''}`
          // A ruin whose rebuilding is in the planet's queue shows it.
          const busy = ours && th.state === 'ruin' && p.queue.some((q) => q.unit === (th.id === 'def0' ? 'orb0' : th.id === 'def1' ? 'orb1' : th.id))
          return (
            <div
              key={th.id}
              ref={(el) => {
                if (el) {
                  els.current.set(th.id, el)
                  place(th.id, el)
                } else els.current.delete(th.id)
              }}
              className={`ew-ostruct is-${th.state} ${sel === th.id ? 'is-sel' : ''} ${ours ? 'is-ours' : ''} ${busy ? 'is-building' : ''}`}
              data-tip={tip}
              data-struct={th.id}
              onPointerDown={(e) => down(th.id, e)}
              onContextMenu={(e) => e.preventDefault()}
            >
              <span className="ew-ostruct-in" style={{ width: w, height: h, marginLeft: -w / 2, marginTop: -h / 2 }}>
                {art && <img src={art.url} alt="" draggable={false} />}
              </span>
              {busyHere && <WorkBar p={p} className="ew-owork" style={{ top: Math.max(w, h) / 2 + 2, width: Math.max(40, Math.min(w, h) * 0.9) }} />}
              <b className="ew-ostruct-name" style={{ top: Math.max(w, h) / 2 + (busyHere ? 24 : 4) }}>{th.name}</b>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// --- The Defense page -----------------------------------------------------------------------------

/** The level a slot needs, and what a station of `level` has: for the slot buttons. */
const slotLabel = (slot: number) => `Slot ${slot + 1}`

/**
 * The Defense page of one of our planets: its two defense sites (or with `only`, the one), each
 * either a site to build on, a ruin to rebuild, or a defense station with its level, its upgrade and
 * its module slots. A slot is picked to fit it (or swap what is in it): the modules then show to pick
 * from. Everything is ordered in the planet's queue, refunded in full while it waits.
 */
export function PlanetDefense({ g, p, sound, toast, only }: { g: Galaxy; p: Planet; sound: EmpiresSound; toast: (t: string, tone?: 'good' | 'bad' | 'info') => void; only?: number }) {
  const f = g.sides[ME].faction
  const plan = ORBITALS[f]
  const [pick, setPick] = useState<{ i: number; slot: number } | null>(null)
  const who = { who: `Yours · ${FACTIONS[f].long}`, rel: 'own' }
  const queued = (w: OrbitalWork) => p.queue.findIndex((q) => q.unit === orbitalWorkId(w))
  const order = (w: OrbitalWork) => {
    const at = queued(w)
    if (at >= 0) {
      cancelBuild(g, ME, p.id, at)
      sound.unqueued()
      return
    }
    const why = orderOrbital(g, ME, p.id, w)
    if (why) {
      sound.error()
      toast(why, 'bad')
    } else sound.constructing()
  }
  const price = (w: OrbitalWork) => (
    <>
      <span className="ew-cost"><Icon name="credits" size={11} /> {orbitalCost(g, ME, p, w)}</span>
      <span className="ew-time"><Icon name="time" size={11} /> {Math.round(orbitalTime(g, ME, p, w))}s</span>
    </>
  )
  const progress = (w: OrbitalWork) => {
    const at = queued(w)
    if (at < 0) return null
    const q = p.queue[at]
    return at === 0 ? <><span className="ew-modline">{Math.ceil(q.left)}s left</span><i className="ew-modbar" style={{ transform: `scaleX(${1 - q.left / q.total})` }} /></> : <span className="ew-modline">Queued #{at + 1}</span>
  }
  const site = (i: number) => {
    const o: OrbitalState | null = orbitalAt(p, i)
    const build: OrbitalWork = { k: 'build', i }
    if (!o || o.ruin) {
      const lv = rebuildLevel(g, ME, p, i)
      const lock = orbitalLock(g, ME, p.id, build)
      const busy = queued(build) >= 0
      const t = orbitalType(f, o?.ruin ? lv : 1, [])
      return (
        <div key={i} className="ew-gdef" role="group" aria-label={`Defense site ${i + 1}`}>
          {only === undefined && <small>Defense site {i + 1}</small>}
          <button className={`ew-shipcard ew-yardcard ${o?.ruin ? 'is-ruin' : ''} ${lock && !busy ? 'is-locked' : ''}`} onClick={() => order(build)}
            {...unitTip(t, who, `${o?.ruin ? `A ruin: rebuild it as the ${orbitalName(f, lv)} for ${Math.round(REBUILD * 100)}% of what its levels cost (its modules were lost).` : `Build the ${orbitalName(f, 1)} on this site: ${plan.stages[0].hull.toLocaleString('en-US')} hull and one module slot, two at level 2 and four at level 3.`} Fought in every battle here, in orbit beside the Command Station.\n\n${busy ? 'Click to call it off (refunded).' : lock ?? 'Click to build it.'}`)}
            aria-label={`Defense site ${i + 1}: ${o?.ruin ? 'ruin' : 'empty'}`}>
            <ShipArt t={t} className={o?.ruin ? 'is-ruin' : 'is-ghost'} />
            <strong>{o?.ruin ? `Rebuild ${orbitalName(f, lv)}` : `Build ${orbitalName(f, 1)}`}</strong>
            {progress(build) ?? price(build)}
            {lock && !busy && <span className="ew-lock">{lock.startsWith('Needs station level') ? `Lv${plan.stages[0].station}` : 'Locked'}</span>}
          </button>
        </div>
      )
    }
    const up: OrbitalWork = { k: 'up', i }
    const upLock = orbitalLock(g, ME, p.id, up)
    const upBusy = queued(up) >= 0
    const t = orbitalType(f, o.level, o.mods)
    const n = orbitalSlots(ORBITAL_TOP)
    return (
      <div key={i} className="ew-gdef" role="group" aria-label={`Defense site ${i + 1}`}>
        {only === undefined && <small>Defense site {i + 1}</small>}
        <div className={`ew-shipcard ew-yardcard is-built`} {...unitTip(t, who, `The ${orbitalName(f, o.level)}, level ${o.level} of ${ORBITAL_TOP}: ${orbitalSlots(o.level)} module slot${orbitalSlots(o.level) > 1 ? 's' : ''}.`)}>
          <ShipArt t={t} />
          <strong>{orbitalName(f, o.level)}</strong>
          <span className="ew-modline">Level {o.level}</span>
        </div>
        <div className="ew-gdef-side">
        {o.level < ORBITAL_TOP && (
          <button className={`ew-gp-up ew-gdef-up ${upLock && !upBusy ? 'is-off' : ''}`} onClick={() => order(up)}
            data-tip={`Upgrade to the ${orbitalName(f, o.level + 1)}: ${orbitalSlots(o.level + 1)} module slots, more hull. ${orbitalCost(g, ME, p, up)} credits, ${Math.round(orbitalTime(g, ME, p, up))} s.${upBusy ? '\nClick to call it off (refunded).' : upLock ? `\n${upLock}` : ''}`}>
            <Icon name="yard" size={13} /> {upBusy ? (queued(up) === 0 ? `${Math.ceil(p.queue[0].left)}s` : 'Queued') : `Level ${o.level + 1}`} {!upBusy && <><Icon name="credits" size={12} /> {orbitalCost(g, ME, p, up)}</>}
          </button>
        )}
        <div className="ew-gdef-slots">
          {Array.from({ length: n }, (_, s) => {
            const have = s < orbitalSlots(o.level)
            const m = o.mods[s] ? orbitalMod(f, o.mods[s]!) : null
            const fitting = p.queue.find((q) => { const w = parseOrbital(q.unit); return w?.k === 'mod' && w.i === i && w.slot === s })
            const into = fitting ? orbitalMod(f, (parseOrbital(fitting.unit) as { mod: OrbitalModId }).mod) : null
            const on = pick?.i === i && pick.slot === s
            return (
              <button key={s} className={`ew-gdef-slot ${have ? '' : 'is-locked'} ${on ? 'is-on' : ''} ${m ? 'is-full' : ''} ${into ? 'is-fitting' : ''}`} disabled={!have}
                onClick={() => (sound.click(), setPick(on ? null : { i, slot: s }))}
                data-tip={have ? `${slotLabel(s)}: ${m ? `${m.name}. ${m.blurb}` : 'empty.'}${into ? `\nBeing fitted: ${into.name}.` : ''}\nClick to ${m ? 'swap it for another module' : 'fit a module'}.` : `${slotLabel(s)}: comes with level ${slotLevel(s)}.`}
                aria-label={`${slotLabel(s)}: ${m?.name ?? (have ? 'empty' : 'locked')}`}>
                {m ? <span className="ew-modicon" style={{ ['--c' as string]: HP_COLOR[m.kind] }}><HpIcon kind={m.kind} size={16} /></span> : <i className="ew-gdef-empty">{have ? '+' : `Lv${slotLevel(s)}`}</i>}
                <small>{m?.name ?? (have ? 'Empty' : 'Locked')}</small>
                {into && <em>→ {into.name}</em>}
              </button>
            )
          })}
        </div>
        </div>
        {pick?.i === i && (
          <div className="ew-gdef-pick" role="group" aria-label={`Modules for slot ${pick.slot + 1}`}>
            {plan.modules.map((m) => {
              const w: OrbitalWork = { k: 'mod', i, slot: pick.slot, mod: m.id }
              const busy = queued(w) >= 0
              const lock = orbitalLock(g, ME, p.id, w)
              return (
                <button key={m.id} className={`ew-shipcard ew-modcard ${busy ? 'is-busy' : lock ? 'is-locked' : ''}`} onClick={() => order(w)}
                  data-tip={`${m.name}\n${m.blurb}\n${m.cost} credits, ${m.time} s. Into slot ${pick.slot + 1}${o.mods[pick.slot] ? `, in place of the ${orbitalMod(f, o.mods[pick.slot]!).name}` : ''}. Lost if it is shot off in a battle here.\n\n${busy ? 'Click to call it off (refunded).' : lock ?? 'Click to fit it.'}`}
                  aria-label={m.name}>
                  <span className="ew-modicon" style={{ ['--c' as string]: HP_COLOR[m.kind] }}><HpIcon kind={m.kind} size={22} /></span>
                  <strong>{m.name}</strong>
                  {progress(w) ?? price(w)}
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  }
  return <div className="ew-yard ew-gbuild ew-gdefs">{only === undefined ? Array.from({ length: ORBITAL_MAX }, (_, i) => site(i)) : site(only)}</div>
}
