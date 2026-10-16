import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BUILD_RADIUS, dims, orbitalType, yardOf, type FactionId, type UnitType } from './data'
import { calendar, setLayout, type Galaxy, type Known, type Planet, type StructId } from './galaxy'
import { orbitThings, structArt, type OrbitCam } from './Orbit'
import { ENTRY_R, STRUCT_ORDER, planetMap, type PlanetLayout, type PlanetMap, type Place } from './conquestMap'
import { drawTerrainOverview } from './render'
import { HOME_R, LAYOUT_IDS, layoutProblem, layoutTop, layoutWorld, nearestClear, standBase, stationProblem, type LayoutItem, type Stood, type World } from './sim'
import type { EmpiresSound } from './sound'
import { TAP_SLOP } from './Touch'
import './planetmap.css'

// The orbit view's battle map: zoomed all the way in on a planet, it settles a little smaller, to
// one side, and this panel sits beside it (below it on a tall screen), pinned to it: no handle, it
// moves with the planet as the camera eases in and out, fading and sliding in as the zoom crosses
// into the orbit view. It shows the battle map that planet is always fought on (conquestMap.ts): its
// terrain and rocks, the planet far below, an entry zone for every hyperlane into the system (named
// after the system at its other end) and the structures that stand there in a battle, each its real
// model at its true size and heading, laid out exactly as a battle stands them (sim.ts standBase on
// the same map: what shows here is what the battle does).
//
// On our own planets the structures can be dragged (mouse or finger): the Command Station within its
// home zone, the yards and defense stations within its build radius, clear of the rocks, fields, the
// map's edge and each other. Empty sites show as ghosts to place ahead of building them. A click or
// tap picks one for the orbit card, as the pictures round the planet do. Enemy and neutral planets
// are read only, their structures as we last saw them (the fog of war, galaxy.ts Intel.layout).

const ME = 0
/** The panel's near edge, out from the planet's middle as a share of the width of the orbit view
 * (the planet and what is pictured round it): it overlaps the pictures' ring by 40%, the planet's
 * own edge a little. */
const OVERLAP = 0.1
/** The panel's header, and its padding round the map (pixels). */
const HEAD = 30
const PAD = 12
/** Room the galaxy screen's top bar takes. */
const TOP = 46

/** Where the orbit view puts a planet and its battle map: the zoom it settles at, the planet's middle
 * on screen from the view's middle (dx, dy), and the panel's side and size. */
export type OrbitFrame = { k: number; dx: number; dy: number; side: 'right' | 'below'; pw: number; ph: number }

/**
 * The orbit view's frame in a view of `size`, for a planet whose pictures reach `span` map units
 * across at zoom 1 (and a battle map of `aspect`): the panel beside the planet on a wide view, below
 * it on a tall one (a phone held upright), the planet a little smaller than the view so they fit
 * together, overlapping by OVERLAP.
 */
export function orbitFrame(size: { w: number; h: number }, span: number, aspect: number, kMin: number, kMax: number): OrbitFrame {
  const W = size.w
  const H = Math.max(160, size.h - TOP - 10)
  const below = W < H * 1.1
  let pw: number
  let ph: number
  let D: number
  if (!below) {
    pw = Math.max(240, Math.min(640, W * 0.44))
    ph = pw / aspect + HEAD + PAD
    if (ph > H * 0.94) {
      ph = H * 0.94
      pw = (ph - HEAD - PAD) * aspect
    }
    D = Math.min(H * 0.86, (W * 0.97 - pw) / (0.5 + OVERLAP))
  } else {
    pw = Math.min(W - 16, 560)
    ph = pw / aspect + HEAD + PAD
    D = Math.min(W * 0.94, (H * 0.97 - ph) / (0.5 + OVERLAP))
  }
  const k = Math.max(kMin, Math.min(kMax, D / span))
  D = span * k
  const total = (0.5 + OVERLAP) * D + (below ? ph : pw)
  const px = below ? W / 2 : (W - total) / 2 + D / 2
  const py = below ? TOP + (H - total) / 2 + D / 2 : TOP + H / 2
  return { k, dx: px - W / 2, dy: py - size.h / 2, side: below ? 'below' : 'right', pw, ph }
}

/** How far into the orbit view the zoom is (0 at 85% of its zoom, 1 there): the panel fades and
 * slides in over it. */
export const panelIn = (k: number, kIn: number) => Math.max(0, Math.min(1, (k - kIn * 0.85) / (kIn * 0.15)))

const worlds = new Map<string, World>()
/** A planet map's world, made once (its rocks are scattered from the map's seed). */
function worldOf(pm: PlanetMap) {
  let w = worlds.get(pm.key)
  if (!w) {
    if (worlds.size > 16) worlds.clear()
    worlds.set(pm.key, (w = layoutWorld(pm.map)))
  }
  return w
}

/** One structure on the map as the panel draws it. */
type Shown = Stood & { state: 'up' | 'ruin' | 'ghost'; name: string }

/**
 * Where everything stands on planet `p`'s map as side ME knows it (`kn`): the structures that would
 * fight there (as a battle stands them), then the empty sites and ruins where they'd go. Null for a
 * planet with no station.
 */
export function shownLayout(g: Galaxy, p: Planet, kn: Known): { pm: PlanetMap; w: World; f: FactionId | null; shown: Shown[] } {
  const pm = planetMap(g, p.id)
  const w = worldOf(pm)
  const f = kn.owner >= 0 && kn.station > 0 ? g.sides[kn.owner].faction : null
  if (!f) return { pm, w, f, shown: [] }
  const ours = kn.owner === ME && kn.live
  const things = orbitThings(f, kn.station, kn.base, true)
  const attackers = pm.map.spawns.slice(1)
  // What fights there, by the types the battle checks them by.
  const battleType = (id: StructId): UnitType => {
    if (id === 'yard' || id === 'cyard') return yardOf(f, id)
    const i = id === 'def1' ? 1 : 0
    const o = kn.base.orb?.[i]
    return o && !o.ruin ? orbitalType(f, o.level, o.mods, i) : layoutTop(f, id)
  }
  const up = things.filter((th) => th.state === 'up' && th.id !== 'station')
  const items: LayoutItem[] = up.map((th) => ({ id: th.id, t: battleType(th.id) }))
  const stood = standBase(w, ME, f, pm.home, kn.layout, attackers, items)
  // The empty sites and ruins: where they'd stand among the rest (shown only).
  const rest = things.filter((th) => th.state !== 'up' && (ours || th.state === 'ruin'))
  const all = rest.length ? standBase(w, ME, f, pm.home, kn.layout, attackers, STRUCT_ORDER.slice(1).map((id) => ({ id, t: up.some((u) => u.id === id) ? battleType(id) : layoutTop(f, id) }))) : []
  const shown: Shown[] = []
  for (const th of things) {
    const s = th.id === 'station' ? stood[0] : th.state === 'up' ? stood.find((x) => x.id === th.id) : all.find((x) => x.id === th.id)
    if (!s || (th.state !== 'up' && !rest.includes(th))) continue
    shown.push({ ...s, t: th.t, state: th.state, name: th.name })
  }
  return { pm, w, f, shown }
}

/** The structures' places on the map for the orbit view's pictures round the planet. */
export const placesOf = (shown: Shown[]) => Object.fromEntries(shown.map((s) => [s.id, { x: s.x, y: s.y }])) as Partial<Record<StructId, Place>>
export type ShownLayout = ReturnType<typeof shownLayout>
/** shownLayout for planet `p` (or nothing), worked out again only when what stands there or its
 * layout changes. */
export function useShownLayout(g: Galaxy, p: Planet | null, kn: Known | null): ShownLayout | null {
  const key = p && kn ? `${p.id}:${kn.owner}:${kn.station}:${JSON.stringify(kn.base)}:${JSON.stringify(kn.layout ?? null)}:${kn.live}` : ''
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (p && kn ? shownLayout(g, p, kn) : null), [key])
}

/**
 * The battle map panel pinned to planet `p` in the orbit view (see the top of this file). `at`, `span`
 * and `kIn`: where the planet is on the galaxy map, how far its pictures reach at zoom 1, and the
 * zoom the orbit view settles at; `frame`: where the panel goes (orbitFrame).
 */
export function PlanetMapPanel({ g, p, kn, lay, view, at, span, kIn, frame, sel, coarse, sound, toast, onPick, onChange }: {
  g: Galaxy
  p: Planet
  kn: Known
  /** What stands there (useShownLayout). */
  lay: ShownLayout
  view: OrbitCam
  at: { x: number; y: number }
  span: number
  kIn: number
  frame: OrbitFrame
  sel: StructId | null
  coarse: boolean
  sound: EmpiresSound
  toast: (t: string, tone?: 'good' | 'bad' | 'info') => void
  onPick: (id: StructId | null) => void
  onChange: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const ours = kn.owner === ME && kn.live && p.owner === ME
  const { pm, w, f, shown } = lay
  const map = pm.map
  const mw = frame.pw - PAD
  const s = mw / map.w
  const mh = map.h * s
  const [drag, setDrag] = useState<{ id: StructId; x: number; y: number; why: string | null } | null>(null)

  // The camera places the panel beside the planet (no render): it follows the planet, and fades
  // and slides in as the zoom reaches the orbit view.
  useLayoutEffect(() => {
    const aim = () => {
      const el = root.current
      if (!el) return
      const { x, y, k } = view.cam
      const sx = (at.x - x) * k + view.size.w / 2
      const sy = (at.y - y) * k + view.size.h / 2
      const D = span * k
      const t = panelIn(k, kIn)
      const slide = (1 - t) * 28
      const left = frame.side === 'right' ? sx + OVERLAP * D + slide : sx - frame.pw / 2
      const top = frame.side === 'right' ? sy - frame.ph / 2 : sy + OVERLAP * D + slide
      const tr = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
      if (el.style.transform !== tr) el.style.transform = tr
      const o = t.toFixed(3)
      if (el.style.opacity !== o) el.style.opacity = o
      el.classList.toggle('is-off', t < 0.6)
    }
    aim()
    return view.sub(aim)
  }, [view, at.x, at.y, span, kIn, frame])

  // The map itself, drawn once per look: space, its terrain and rocks.
  useLayoutEffect(() => {
    const c = cv.current
    if (!c) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = Math.max(1, Math.round(mw * dpr))
    c.height = Math.max(1, Math.round(mh * dpr))
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, mw, mh)
    drawTerrainOverview(ctx, map, 0, 0, s)
    const css = getComputedStyle(c)
    ctx.fillStyle = css.getPropertyValue('--pm-rock').trim() || css.color
    for (const r of w.rocks) {
      ctx.beginPath()
      ctx.arc(r.x * s, r.y * s, Math.max(0.8, r.r * s * 0.85), 0, Math.PI * 2)
      ctx.fill()
    }
  }, [pm.key, mw, mh, s, map, w])

  const station = shown.find((x) => x.id === 'station')
  /** Where everything stands now, for the checks: each at its biggest. */
  const full = (): Record<StructId, Stood> => {
    const out = {} as Record<StructId, Stood>
    for (const x of shown) out[x.id] = { ...x, t: layoutTop(f!, x.id) }
    return out
  }
  /** Why structure `id` can't stand at (x, y) with the rest where they are, or null. */
  const problem = (id: StructId, x: number, y: number) => {
    if (!f || !station) return 'Nothing stands here'
    if (id === 'station') return stationProblem(w, f, pm.home, x, y)
    const now = full()
    const st = now.station
    const others = LAYOUT_IDS.filter((o) => o !== id && o !== 'station' && now[o]).map((o) => now[o])
    return layoutProblem(w, ME, layoutTop(f, id), st, x, y, [st, ...others])
  }
  /** The layout with `id` put at (x, y) (the station takes the rest along), checked as a battle
   * would stand it; null (and why) when it can't. */
  const moved = (id: StructId, x: number, y: number): { layout: PlanetLayout } | { why: string } => {
    if (!f || !station) return { why: 'Nothing stands here' }
    const now = full()
    const attackers = map.spawns.slice(1)
    const all = LAYOUT_IDS.slice(1).map((o) => ({ id: o, t: layoutTop(f, o) }))
    if (id === 'station') {
      const why = stationProblem(w, f, pm.home, x, y)
      if (why) return { why }
      const dx = x - now.station.x
      const dy = y - now.station.y
      const want: PlanetLayout = { station: { x, y } }
      for (const o of LAYOUT_IDS.slice(1)) if (now[o]) want[o] = { x: now[o].x + dx, y: now[o].y + dy }
      // Each of the others where it went along with the station, else the nearest clear spot.
      const res = standBase(w, ME, f, pm.home, want, attackers, all)
      return { layout: Object.fromEntries(res.map((r) => [r.id, { x: r.x, y: r.y }])) }
    }
    let q: { x: number; y: number } | null = { x, y }
    if (problem(id, x, y)) {
      const st = now.station
      const others = LAYOUT_IDS.filter((o) => o !== id && o !== 'station' && now[o]).map((o) => now[o])
      q = nearestClear(w, st, layoutTop(f, id), q, [st, ...others])
    }
    if (!q) return { why: problem(id, x, y) ?? 'No room there' }
    const want: PlanetLayout = Object.fromEntries(Object.values(now).map((r) => [r.id, { x: r.x, y: r.y }]))
    want[id] = q
    // As a battle would stand them, every one where we want it.
    const res = standBase(w, ME, f, pm.home, want, attackers, all)
    const off = res.find((r) => { const v = want[r.id]; return !v || Math.abs(v.x - r.x) > 0.5 || Math.abs(v.y - r.y) > 0.5 })
    if (off || res.length < LAYOUT_IDS.length) return { why: 'Too close to another structure' }
    return { layout: want }
  }
  /** A press on a structure: a tap picks it, a drag (ours) moves it on the map. */
  const down = (id: StructId, e: React.PointerEvent) => {
    e.stopPropagation()
    if (e.button !== 0) return
    const el = e.currentTarget as HTMLElement
    const me = shown.find((x) => x.id === id)
    if (!me) return
    const x0 = e.clientX
    const y0 = e.clientY
    const slop = e.pointerType === 'mouse' ? 4 : TAP_SLOP
    let moving = false
    let last: { x: number; y: number; why: string | null } | null = null
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // (A pointer that went away.)
    }
    const toMap = (cx: number, cy: number) => {
      let x = me.x + (cx - x0) / s
      let y = me.y + (cy - y0) / s
      if (id === 'station') {
        // Kept within its home zone.
        const d = Math.hypot(x - pm.home.x, y - pm.home.y)
        if (d > HOME_R) {
          x = pm.home.x + ((x - pm.home.x) / d) * HOME_R
          y = pm.home.y + ((y - pm.home.y) / d) * HOME_R
        }
      }
      return { x, y }
    }
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId) return
      if (!moving && Math.hypot(m.clientX - x0, m.clientY - y0) <= slop) return
      if (!ours) return
      moving = true
      const q = toMap(m.clientX, m.clientY)
      last = { ...q, why: problem(id, q.x, q.y) }
      setDrag({ id, ...last })
    }
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setDrag(null)
      if (!moving) {
        if (u.type === 'pointerup') onPick(sel === id ? null : id)
        return
      }
      if (!last || u.type !== 'pointerup') return
      const r = moved(id, last.x, last.y)
      if ('why' in r) {
        sound.error()
        toast(r.why, 'bad')
        return
      }
      const why = setLayout(g, ME, p.id, r.layout)
      if (why) {
        sound.error()
        toast(why, 'bad')
      } else sound.click()
      onChange()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const fog = !kn.live
  const note = kn.owner < 0 || !kn.station
    ? fog ? (kn.t <= 0 ? 'Pre-war charts' : 'As last seen') : 'No station'
    : fog ? (kn.t <= 0 ? 'Pre-war charts' : `Last seen day ${dayOf(kn.t)}`) : ours ? (coarse ? 'Drag to place' : 'Drag to place: battles here stand them so') : 'Live'
  const st = drag?.id === 'station' ? drag : station
  const px = (v: number) => `${(v * s).toFixed(1)}px`
  return (
    <div
      ref={root}
      className={`ew-pmap is-${frame.side} ${fog ? 'is-fog' : ''} ${ours ? 'is-ours' : ''}`}
      style={{ width: frame.pw, height: frame.ph }}
      aria-label={`Battle map of ${p.name}`}
      data-no-touch-menu
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <header className="ew-pmap-head">
        <b>{p.name}</b>
        <span className="ew-pmap-sub">Battle map</span>
        <small className="ew-pmap-note">{note}</small>
      </header>
      <div ref={box} className="ew-pmap-map" style={{ width: mw, height: mh }} onPointerDown={() => sel && onPick(null)}>
        {map.planet && (
          <img className="ew-pmap-planet" src={`/games/empires/planets/${map.planet.kind}.webp`} alt="" draggable={false}
            style={{ left: px(map.planet.x), top: px(map.planet.y), width: map.planet.r * 4.4 * s, height: map.planet.r * 4.4 * s }} />
        )}
        <canvas ref={cv} className="ew-pmap-terrain" style={{ width: mw, height: mh }} />
        {pm.entries.map((e) => (
          <div key={e.system} className="ew-pmap-entry" style={{ left: px(e.x), top: px(e.y), ['--r' as string]: px(ENTRY_R) }}
            data-tip={`Entry zone: ${e.system === p.system ? `fleets coming from the other planets of ${g.systems[p.system].name}` : e.system < 0 ? 'fleets' : `fleets coming down the lane from ${e.name}`} drop out of hyperspace here when they attack ${p.name}.`}>
            <i />
            <span>{e.name}</span>
          </div>
        ))}
        {ours && drag?.id === 'station' && <i className="ew-pmap-home" style={{ left: px(pm.home.x), top: px(pm.home.y), width: HOME_R * 2 * s, height: HOME_R * 2 * s }} />}
        {st && <i className="ew-pmap-reach" style={{ left: px(st.x), top: px(st.y), width: BUILD_RADIUS * 2 * s, height: BUILD_RADIUS * 2 * s }} data-tip="The Command Station's build radius: its yards and defense stations stand within it" />}
        {shown.map((x) => {
          const d = drag?.id === x.id ? drag : null
          const cx = d ? d.x : x.x
          const cy = d ? d.y : x.y
          const a = x.id === 'station' ? x.a : d && x.t.tier === 'yard' && st ? Math.atan2(cy - st.y, cx - st.x) : x.a
          const [dw, dh] = dims(x.t)
          const long = Math.max(dw, dh)
          const art = structArt(x.t, 160)
          const iw = (dw + long * 0.08) * s
          const ih = (dh + long * 0.08) * s
          const hit = Math.max(24, long * s)
          const tip = x.state === 'ghost'
            ? `${x.name}: nothing built here yet.${ours ? ' Drag it to where it will stand once built; click to order it.' : ''}`
            : `${x.name}${x.state === 'ruin' ? ': a ruin, rebuilt for half' : ''}${fog ? ' (as last seen)' : ''}.${ours ? ` Drag it to where it stands in battles here; click for its orders.${x.id === 'station' ? ' The station moves within its home zone, and takes the rest along.' : ''}` : ' Click for what it is.'}`
          return (
            <div
              key={x.id}
              className={`ew-pstruct is-${x.state} ${sel === x.id ? 'is-sel' : ''} ${d ? 'is-dragging' : ''} ${d?.why ? 'is-bad' : ''}`}
              style={{ left: px(cx), top: px(cy), width: hit, height: hit }}
              data-tip={d?.why ?? tip}
              data-struct={x.id}
              onPointerDown={(e) => down(x.id, e)}
            >
              <span className="ew-pstruct-in" style={{ width: iw, height: ih, transform: `translate(-50%, -50%) rotate(${(a + Math.PI / 2).toFixed(4)}rad)` }}>
                {art && <img src={art.url} alt="" draggable={false} />}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** The galaxy's day for a time in seconds (as the rest of the screen counts them). */
const dayOf = (t: number) => calendar(Math.max(0, t)).day + 1
