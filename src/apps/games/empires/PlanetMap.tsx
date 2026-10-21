import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BUILD_RADIUS, dims, orbitalType, yardOf, type FactionId, type UnitType } from './data'
import { calendar, setLayout, type Galaxy, type Known, type Planet, type StructId } from './galaxy'
import { WorkBar, orbitThings, structArt, structWork, withWork, workProgress, type OrbitCam, type StructWork } from './Orbit'
import { ENTRY_R, cleanTurn, planetMap, type LayoutPlace, type PlanetLayout, type PlanetMap } from './conquestMap'
import { drawTerrainOverview } from './render'
import { LAYOUT_IDS, STATION_ENTRY_GAP, homeZone, layoutProblem, layoutTop, layoutWorld, nearestClear, standBase, stationProblem, type LayoutItem, type Stood, type World } from './sim'
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
// the same map: what shows here is what the battle does). Only what is built shows, each as it looks
// built (the station at its level, a yard with its expansions, a defense station at its level with
// its modules), and ruins, darkened; a yard or defense station not built yet shows once it is, at
// its spot in the layout (its default unless placed before).
//
// On our own planets the structures can be dragged (mouse or finger): the Command Station within its
// third of the map (sim.ts homeZone) clear of the entry zones, the yards and defense stations within its build radius, clear of the rocks, fields, the
// map's edge and each other. A picked one of ours can be turned too: by the handle at its nose (mouse
// or finger), the wheel over it, or R and Shift+R (also while dragging it); a double click on the
// handle turns it back to its default heading. Battles here stand it turned so (the layout keeps the
// heading, LayoutPlace.a). A click or tap picks one for the orbit card, as the pictures round the
// planet do. Enemy and neutral planets are read only, their structures as we last saw them, turned as
// they were (the fog of war, galaxy.ts Intel.layout).

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
type Shown = Stood & { state: 'up' | 'ruin' | 'building'; name: string }

/** How far one step of the wheel or of R turns a structure, and what the handle snaps to (radians). */
const TURN_STEP = Math.PI / 12
/** How far the wheel scrolls (CSS pixels) for one turn step: about one notch of a plain wheel. */
const WHEEL_STEP_PX = 100
/** A wheel line (deltaMode 1, Firefox on some wheels) in CSS pixels. */
const WHEEL_LINE_PX = 40
/** The smallest single wheel event taken as a whole notch (high-resolution wheels send less). */
const WHEEL_NOTCH_PX = 40
/** How long a pause in the wheel forgets a part-scrolled step (ms). */
const WHEEL_IDLE_MS = 300
const TURN_SNAP = Math.PI / 36

/**
 * Where everything stands on planet `p`'s map as side ME knows it (`kn`): the structures that would
 * fight there (as a battle stands them, each its built type at its level), then the ruins and the
 * one being built (drawn as what it will be) where they'd go, each at its real size. Sites with
 * nothing built or being built on them don't show and take no room. Nothing for a planet with no
 * station. `work`: the work under way there (structWork); `items` and `stationT`: what stands,
 * by the types standBase keeps them apart by (for the panel's checks).
 */
export function shownLayout(g: Galaxy, p: Planet, kn: Known): { pm: PlanetMap; w: World; f: FactionId | null; shown: Shown[]; work: StructWork | null; items: LayoutItem[]; stationT: UnitType | null } {
  const pm = planetMap(g, p.id)
  const w = worldOf(pm)
  const f = kn.owner >= 0 && kn.station > 0 ? g.sides[kn.owner].faction : null
  if (!f) return { pm, w, f, shown: [], work: null, items: [], stationT: null }
  const work = structWork(f, p, kn.base, kn.live)
  const things = withWork(orbitThings(f, kn.station, kn.base, false), work)
  const attackers = pm.map.spawns.slice(1)
  // What fights there, by the types the battle checks them by.
  const battleType = (id: StructId): UnitType => {
    if (id === 'yard' || id === 'cyard') return yardOf(f, id)
    const i = id === 'def1' ? 1 : 0
    const o = kn.base.orb?.[i]
    return o && !o.ruin ? orbitalType(f, o.level, o.mods, i) : layoutTop(f, id)
  }
  // What fights there first, as a battle stands it (later items never move earlier ones), then the
  // ruins and the one being built where they'd go among it (a battle has those not: one being built
  // joins the battles once it is finished, where it shows now).
  const up = things.filter((th) => th.state === 'up' && th.id !== 'station')
  const rest = things.filter((th) => th.state === 'ruin' || th.state === 'building')
  const items: LayoutItem[] = [...up.map((th) => ({ id: th.id, t: battleType(th.id) })), ...rest.map((th) => ({ id: th.id, t: th.t }))]
  const stationT = things.find((th) => th.id === 'station')?.t ?? null
  const stood = standBase(w, ME, f, pm.home, kn.layout, attackers, items, stationT ?? undefined)
  const shown: Shown[] = []
  for (const th of things) {
    const s = th.id === 'station' ? stood[0] : stood.find((x) => x.id === th.id)
    if (!s || th.state === 'ghost') continue
    shown.push({ ...s, t: th.t, state: th.state, name: th.name })
  }
  return { pm, w, f, shown, work, items, stationT }
}

/** The structures' places and headings on the map for the orbit view's pictures round the planet. */
export const placesOf = (shown: Shown[]) => Object.fromEntries(shown.map((s) => [s.id, { x: s.x, y: s.y, a: s.a }])) as Partial<Record<StructId, LayoutPlace>>
export type ShownLayout = ReturnType<typeof shownLayout>
/** shownLayout for planet `p` (or nothing), worked out again only when what stands there or its
 * layout changes. */
export function useShownLayout(g: Galaxy, p: Planet | null, kn: Known | null): ShownLayout | null {
  // (The work under way by what it is, not how far: the panel shows its progress as it renders.)
  const key = p && kn ? `${p.id}:${kn.owner}:${kn.station}:${JSON.stringify(kn.base)}:${JSON.stringify(kn.layout ?? null)}:${kn.live}:${kn.live ? (p.queue[0]?.unit ?? '') : ''}` : ''
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
  const { pm, w, f, shown, work, items, stationT } = lay
  const map = pm.map
  const mw = frame.pw - PAD
  const s = mw / map.w
  const mh = map.h * s
  const [drag, setDrag] = useState<{ id: StructId; x: number; y: number; a?: number; why: string | null } | null>(null)
  /** A structure being turned by its handle: its heading so far. */
  const [turn, setTurn] = useState<{ id: StructId; a: number; why: string | null } | null>(null)
  /** The drag under way, for R to turn what is being dragged. */
  const dragging = useRef<{ id: StructId; turnBy: (by: number) => void } | null>(null)

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
  /** The heading the layout keeps for structure `id` (turned by the player), or undefined. */
  const turnOf = (id: StructId) => kn.layout?.[id]?.a
  /** A place in the layout, with the heading `a` it keeps (if any). */
  const placeOf = (x: number, y: number, a: number | undefined): LayoutPlace => (a === undefined ? { x, y } : { x, y, a: cleanTurn(a) })
  /** The type structure `id` is kept apart from the rest by, as standBase does: its real one (the
   * station at its level, one being built as what it will be). */
  const typeOf = (id: StructId): UnitType => (id === 'station' ? (stationT ?? layoutTop(f!, id)) : (items.find((i) => i.id === id)?.t ?? layoutTop(f!, id)))
  const nameOf = (id: StructId) => shown.find((x) => x.id === id)?.name ?? id
  /** Where everything shown stands now, for the checks: each at its real size, as it is turned.
   * (Empty sites take no room.) */
  const full = (): Partial<Record<StructId, Stood>> => {
    const out: Partial<Record<StructId, Stood>> = {}
    for (const x of shown) out[x.id] = { ...x, t: typeOf(x.id) }
    return out
  }
  /** Why structure `id` can't stand at (x, y) (turned to `a`, else as the layout has it) with the
   * rest where they are, or null. */
  const problem = (id: StructId, x: number, y: number, a = turnOf(id)) => {
    if (!f || !station) return 'Nothing stands here'
    if (id === 'station') return stationProblem(w, f, pm.home, x, y)
    const now = full()
    const st = now.station!
    const others = LAYOUT_IDS.filter((o) => o !== id && o !== 'station' && now[o]).map((o) => now[o]!)
    return layoutProblem(w, ME, typeOf(id), st, x, y, [st, ...others], a)
  }
  /**
   * The layout with `id` put at (x, y) and turned to `a` (null: back to its default heading; left
   * out: as the layout has it; the station takes the rest along), checked as a battle would stand
   * it; null (and why) when it can't. Sites with nothing built keep where the layout has them, or
   * make way.
   */
  const moved = (id: StructId, x: number, y: number, a?: number | null): { layout: PlanetLayout } | { why: string } => {
    if (!f || !station) return { why: 'Nothing stands here' }
    const now = full()
    const attackers = map.spawns.slice(1)
    const turned = (o: StructId) => (o === id ? (a === null ? undefined : (a ?? turnOf(o))) : turnOf(o))
    // Where standBase stood what shows, and where the layout has the empty sites (kept as they are:
    // they take no room until something is built there).
    const keep = (res: Stood[]): PlanetLayout => ({ ...Object.fromEntries(LAYOUT_IDS.filter((o) => !now[o] && want[o]).map((o) => [o, want[o]!])), ...Object.fromEntries(res.map((r) => [r.id, placeOf(r.x, r.y, turned(r.id))])) })
    // What the layout has already (sites placed before they were built), then what stands.
    const want: PlanetLayout = {}
    for (const o of LAYOUT_IDS) {
      const q = now[o] ?? kn.layout?.[o]
      if (q) want[o] = placeOf(q.x, q.y, turned(o))
    }
    if (id === 'station') {
      const why = stationProblem(w, f, pm.home, x, y)
      if (why) return { why }
      const dx = x - now.station!.x
      const dy = y - now.station!.y
      for (const o of LAYOUT_IDS.slice(1)) if (want[o]) want[o] = placeOf(want[o]!.x + dx, want[o]!.y + dy, turned(o))
      want.station = placeOf(x, y, turned('station'))
      // Each of the others where it went along with the station, else the nearest clear spot.
      return { layout: keep(standBase(w, ME, f, pm.home, want, attackers, items, stationT ?? undefined)) }
    }
    const ta = turned(id)
    let q: { x: number; y: number } | null = { x, y }
    const bad = problem(id, x, y, ta)
    // Dropped onto another structure: refused, naming it (a drop on rocks or a field, or past the
    // edge, goes to the nearest clear spot instead).
    if (bad?.startsWith('Too close to the ')) return { why: bad }
    if (bad) {
      const st = now.station!
      const others = LAYOUT_IDS.filter((o) => o !== id && o !== 'station' && now[o]).map((o) => now[o]!)
      q = nearestClear(w, st, typeOf(id), q, [st, ...others], ta)
    }
    if (!q) return { why: problem(id, x, y, ta) ?? 'No room there' }
    want[id] = placeOf(q.x, q.y, ta)
    // As a battle would stand what shows (at their real sizes), every one where we want it.
    const res = standBase(w, ME, f, pm.home, want, attackers, items, stationT ?? undefined)
    const off = res.slice(1).find((r) => {
      const v = want[r.id]
      return !v || Math.abs(v.x - r.x) > 0.5 || Math.abs(v.y - r.y) > 0.5
    })
    if (off) return { why: off.id === id ? (problem(id, q.x, q.y, ta) ?? 'No room there') : `Too close to the ${nameOf(off.id)}` }
    return { layout: keep(res) }
  }
  /** Puts layout `r` in place (or says why not). */
  const commit = (r: { layout: PlanetLayout } | { why: string }) => {
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
  /** Whether structure `id` is ours to turn: one that stands or is being built (a ruin is rebuilt
   * where it lies). */
  const canTurn = (id: StructId) => ours && shown.some((x) => x.id === id && x.state !== 'ruin')
  /** Structure `id` turned a step (TURN_STEP) either way (`by`'s sign), to the nearest whole step. */
  const turnBy = (id: StructId, by: number) => {
    const me = shown.find((x) => x.id === id)
    if (!me || !canTurn(id)) return
    commit(moved(id, me.x, me.y, (Math.round(me.a / TURN_STEP) + Math.sign(by)) * TURN_STEP))
  }
  // The wheel anywhere on the panel never zooms the galaxy map (nor lets go of the orbit view): a
  // wheel meant to turn a structure that slips off it would otherwise fly out of the planet. Over
  // one of our structures it turns it; elsewhere it does nothing. (A touchpad pinch is a wheel with
  // Ctrl held: caught the same way.)
  // A step per notch of a plain wheel: high-resolution wheels and touchpads send many small events
  // for one notch, so the distance is gathered up (per structure, forgotten after a pause) and a
  // step taken for each WHEEL_STEP_PX of it.
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {})
  const wheelSum = useRef<{ id: StructId | null; sum: number; at: number }>({ id: null, sum: 0, at: 0 })
  wheelRef.current = (e: WheelEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.ctrlKey) return
    const el = (e.target as HTMLElement | null)?.closest?.('[data-struct]') as HTMLElement | null
    const id = el?.dataset.struct as StructId | undefined
    if (!id || !canTurn(id)) return
    const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
    const d = raw * (e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? WHEEL_STEP_PX * 3 : 1)
    const w = wheelSum.current
    if (w.id !== id || e.timeStamp - w.at > WHEEL_IDLE_MS || Math.sign(d) !== Math.sign(w.sum)) w.sum = 0
    w.id = id
    w.at = e.timeStamp
    w.sum += d
    // A single event as big as a plain wheel's notch (some scroll ~50 px a notch) is a step itself.
    if (Math.abs(d) >= WHEEL_NOTCH_PX) w.sum = Math.sign(d) * WHEEL_STEP_PX
    if (Math.abs(w.sum) < WHEEL_STEP_PX) return
    turnBy(id, w.sum)
    w.sum -= Math.sign(w.sum) * WHEEL_STEP_PX
    // At most a step per event: a fast flick doesn't spin it round.
    w.sum = Math.max(-WHEEL_STEP_PX, Math.min(WHEEL_STEP_PX, w.sum))
  }
  useEffect(() => {
    const el = root.current
    if (!el) return
    const on = (e: WheelEvent) => wheelRef.current(e)
    el.addEventListener('wheel', on, { passive: false })
    return () => el.removeEventListener('wheel', on)
  }, [])
  // R and Shift+R turn the structure picked (or the one being dragged) a step either way, caught
  // before the galaxy screen's own keys (R is a fleet order there).
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'r') return
    if ((e.target as HTMLElement)?.closest?.('input, select, textarea, [contenteditable="true"]')) return
    const d = dragging.current
    const id = d?.id ?? sel
    if (!id || !canTurn(id) || !root.current || root.current.classList.contains('is-off')) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (d) d.turnBy(e.shiftKey ? -1 : 1)
    else turnBy(id, e.shiftKey ? -1 : 1)
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [])
  /** A press on the handle of structure `id`: dragged round it, the structure turns with it
   * (snapped to TURN_SNAP); let go, it stands so. */
  const turnDown = (id: StructId, e: React.PointerEvent) => {
    e.stopPropagation()
    if (e.button !== 0 || !canTurn(id)) return
    const me = shown.find((x) => x.id === id)
    const b = box.current?.getBoundingClientRect()
    if (!me || !b) return
    const el = e.currentTarget as HTMLElement
    const cx = b.left + me.x * s
    const cy = b.top + me.y * s
    let last: { a: number; why: string | null } | null = null
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // (A pointer that went away.)
    }
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId || Math.hypot(m.clientX - cx, m.clientY - cy) < 4) return
      const a = cleanTurn(Math.round(Math.atan2(m.clientY - cy, m.clientX - cx) / TURN_SNAP) * TURN_SNAP)
      if (last && last.a === a) return
      last = { a, why: problem(id, me.x, me.y, a) }
      setTurn({ id, ...last })
    }
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setTurn(null)
      if (!last || u.type !== 'pointerup' || Math.abs(cleanTurn(last.a - me.a)) < 1e-3) return
      commit(moved(id, me.x, me.y, last.a))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
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
    let last: { x: number; y: number; a?: number; why: string | null } | null = null
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // (A pointer that went away.)
    }
    // (The station may go anywhere in our third of the map: outside it, it shows why not, and a drop
    // there is refused.)
    const toMap = (cx: number, cy: number) => ({ x: me.x + (cx - x0) / s, y: me.y + (cy - y0) / s })
    // Turned with R while dragged: the heading it is let go with (undefined: as the layout has it).
    let a = turnOf(id)
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId) return
      if (!moving && Math.hypot(m.clientX - x0, m.clientY - y0) <= slop) return
      if (!ours) return
      if (!moving && me.state !== 'ruin')
        dragging.current = {
          id,
          turnBy: (by) => {
            a = (Math.round((a ?? me.a) / TURN_STEP) + Math.sign(by)) * TURN_STEP
            if (!last) return
            last = { ...last, a, why: problem(id, last.x, last.y, a) }
            setDrag({ id, ...last })
          },
        }
      moving = true
      const q = toMap(m.clientX, m.clientY)
      last = { ...q, a, why: problem(id, q.x, q.y, a) }
      setDrag({ id, ...last })
    }
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setDrag(null)
      dragging.current = null
      if (!moving) {
        if (u.type === 'pointerup') onPick(sel === id ? null : id)
        return
      }
      if (!last || u.type !== 'pointerup') return
      commit(moved(id, last.x, last.y, a))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const fog = !kn.live
  const note = kn.owner < 0 || !kn.station
    ? fog ? (kn.t <= 0 ? 'Pre-war charts' : 'As last seen') : 'No station'
    : fog ? (kn.t <= 0 ? 'Pre-war charts' : `Last seen day ${dayOf(kn.t)}`) : ours ? (coarse ? 'Drag to place, pick to turn' : 'Drag to place, pick to turn: battles here stand them so') : 'Live'
  const st = drag?.id === 'station' ? drag : station
  // Where the station may go (while it's dragged): our third of the map, clear of the entry zones.
  const zone = homeZone(map, pm.home)
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
        {ours && drag?.id === 'station' && (
          <>
            <i className="ew-pmap-zone" style={{ left: px(zone.x0), top: px(zone.y0), width: (zone.x1 - zone.x0) * s, height: (zone.y1 - zone.y0) * s }} />
            {map.spawns.slice(1).map((q, i) => <i key={i} className="ew-pmap-keep" style={{ left: px(q.x), top: px(q.y), width: STATION_ENTRY_GAP * 2 * s, height: STATION_ENTRY_GAP * 2 * s }} />)}
          </>
        )}
        {st && <i className="ew-pmap-reach" style={{ left: px(st.x), top: px(st.y), width: BUILD_RADIUS * 2 * s, height: BUILD_RADIUS * 2 * s }} data-tip="The Command Station's build radius: its yards and defense stations stand within it" />}
        {shown.map((x) => {
          const d = drag?.id === x.id ? drag : null
          const tr = turn?.id === x.id ? turn : null
          const cx = d ? d.x : x.x
          const cy = d ? d.y : x.y
          // Its heading: as turned by its handle or R; dragged, a yard nobody turned faces away from the station.
          const a = tr ? tr.a : d?.a !== undefined ? d.a : x.id !== 'station' && d && x.t.tier === 'yard' && st ? Math.atan2(cy - st.y, cx - st.x) : x.a
          const [dw, dh] = dims(x.t)
          const long = Math.max(dw, dh)
          const art = structArt(x.t, 160)
          const iw = (dw + long * 0.08) * s
          const ih = (dh + long * 0.08) * s
          const hit = Math.max(24, long * s)
          const turnable = canTurn(x.id)
          const why = d?.why ?? tr?.why ?? null
          const busy = work?.id === x.id
          const tip = `${x.name}${x.state === 'building' ? `: under construction, ${workProgress(p).left}s left` : busy ? `: upgrading, ${workProgress(p).left}s left` : x.state === 'ruin' ? ': a ruin, rebuilt for half' : ''}${fog ? ' (as last seen)' : ''}.${ours ? ` Drag it to where it stands in battles here; click for its orders${turnable ? `, then turn it by its handle${coarse ? '' : ', the wheel or R'}` : ''}.${x.id === 'station' ? ' The station moves anywhere in our third of the map, clear of the entry zones, and takes the rest along.' : ''}` : ' Click for what it is.'}`
          // The handle it is turned by, at its nose, a little way out past its hit area.
          const reach = hit / 2 + (coarse ? 22 : 14)
          const handle = turnable && sel === x.id && !d
          return (
            <Fragment key={x.id}>
              <div
                className={`ew-pstruct is-${x.state} ${sel === x.id ? 'is-sel' : ''} ${d ? 'is-dragging' : ''} ${tr ? 'is-turning' : ''} ${why ? 'is-bad' : ''}`}
                style={{ left: px(cx), top: px(cy), width: hit, height: hit }}
                data-tip={why ?? tip}
                data-struct={x.id}
                data-heading={a.toFixed(4)}
                onPointerDown={(e) => down(x.id, e)}
              >
                <span className="ew-pstruct-in" style={{ width: iw, height: ih, transform: `translate(-50%, -50%) rotate(${(a + Math.PI / 2).toFixed(4)}rad)` }}>
                  {art && <img src={art.url} alt="" draggable={false} />}
                </span>
              </div>
              {busy && <WorkBar p={p} className="ew-pwork" style={{ left: px(cx), top: `calc(${px(cy)} + ${(hit / 2 + 2).toFixed(1)}px)`, width: Math.max(28, Math.min(64, hit)) }} />}
              {handle && (
                <>
                  <i className="ew-pturn-arm" style={{ left: px(cx), top: px(cy), width: reach, transform: `rotate(${a.toFixed(4)}rad)` }} />
                  <button
                    type="button"
                    className={`ew-pturn ${coarse ? 'is-coarse' : ''} ${tr ? 'is-on' : ''}`}
                    style={{ left: `calc(${px(cx)} + ${(Math.cos(a) * reach).toFixed(1)}px)`, top: `calc(${px(cy)} + ${(Math.sin(a) * reach).toFixed(1)}px)` }}
                    data-tip={`Turn the ${x.name}: drag this round it${coarse ? '' : ', or use the wheel over it, R and Shift+R'}. Battles here stand it turned so.${turnOf(x.id) !== undefined ? ' Double-click to turn it back the way it faces by default.' : ''}`}
                    aria-label={`Turn the ${x.name}`}
                    data-turn={x.id}
                    onPointerDown={(e) => turnDown(x.id, e)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      if (turnOf(x.id) !== undefined) commit(moved(x.id, x.x, x.y, null))
                    }}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden><path d="M12.5 5.5A5 5 0 1 0 13 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><path d="M13.5 2v4h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                </>
              )}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

/** The galaxy's day for a time in seconds (as the rest of the screen counts them). */
const dayOf = (t: number) => calendar(Math.max(0, t)).day + 1
