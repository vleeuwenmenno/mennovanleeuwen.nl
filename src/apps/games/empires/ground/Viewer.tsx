import { useEffect, useMemo, useRef, useState } from 'react'
import type { Symmetry } from '../maps.ts'
import { createGroundLayer } from './gl.ts'
import { mapToTs } from './mapTs.ts'
import { GROUND_MAPS } from './maps.ts'
import { buildGroundMap, expandFeatures } from './terrain.ts'
import { TERRAINS, TF, TILE, type GroundFeatures, type GroundMap, type GroundMapDef, type TilePt } from './types.ts'
import './viewer.css'

// Dev builds only: the ground map viewer and editor. Loaded only in dev builds (from the ground
// lobby's Map viewer), so production builds don't contain it.
//
// Viewing: pan and zoom (mouse drag and wheel, touch drag and pinch), a debug overlay of the tile
// grid, heights and flags, and the flat fallback (Flat). The ground is the battle's own ground layer
// (gl.ts), with a 2D canvas over it for overlays, as the battle screen stacks them; the view may pan
// a little past the map's edge, to see the mirrored border.
//
// Editing (Edit): a round 2 map's shapes (GroundFeatures in types.ts), in tile units:
// - Level: a brush that paints raised ground (each dab a round plateau at the chosen level);
// - Plateau, Forest: polygons, a point per tap (Finish, Enter or a double-click closes one);
// - River, Road: polylines with a width, likewise;
// - Ramp, Bridge: a drag from one end to the other (a ramp from its foot to its top), with a width;
// - Ford (with a radius), Crystals, Ruin, Spawn: a tap;
// - Erase: a tap on a shape removes it; Undo takes back the last change.
// The map's symmetry copies everything (expandFeatures), shown as faint outlines; the layer redraws
// after each change. Export copies the map definition as TypeScript, to paste into ground/maps.ts.
// Touch works at tablet size: one finger draws with the tool, two pan and pinch.

const FLAG_NAMES: [number, string][] = [
  [TF.blocked, 'blocked'],
  [TF.noBuild, 'no build'],
  [TF.ramp, 'ramp'],
  [TF.deposit, 'crystals'],
  [TF.water, 'water'],
  [TF.bridge, 'bridge'],
  [TF.ford, 'ford'],
  [TF.forest, 'forest'],
]

type Debug = { grid: boolean; heights: boolean; flags: boolean }
type Tool = 'pan' | 'level' | 'plateau' | 'forest' | 'river' | 'road' | 'ramp' | 'bridge' | 'ford' | 'deposit' | 'ruin' | 'spawn' | 'erase'
const TOOLS: [Tool, string, string][] = [
  ['pan', 'Pan', 'Drag to look round'],
  ['level', 'Level', 'Paint raised ground with a round brush'],
  ['plateau', 'Plateau', 'A plateau polygon: tap its corners, then Finish'],
  ['ramp', 'Ramp', 'Drag from the ramp’s foot up to its top'],
  ['river', 'River', 'A river: tap points along it, then Finish'],
  ['road', 'Road', 'A dirt road: tap points along it, then Finish'],
  ['forest', 'Forest', 'A forest polygon: tap its corners, then Finish'],
  ['bridge', 'Bridge', 'Drag from bank to bank across a river'],
  ['ford', 'Ford', 'Tap a river where it should be shallow'],
  ['deposit', 'Crystals', 'Tap to place a kyber crystal field'],
  ['ruin', 'Ruin', 'Tap to place ruins'],
  ['spawn', 'Spawn', 'Tap to place a start spot (the symmetry adds the others)'],
  ['erase', 'Erase', 'Tap a shape to remove it'],
]
const SYMMETRIES: [string, string][] = [
  ['none', 'None'],
  ['point', 'Point (2)'],
  ['diagonal', 'Diagonal (2)'],
  ['quad', 'Quad (4)'],
  ['tri', 'Three-way (3)'],
  ['hex', 'Six-way (6)'],
]

/** The debug overlay: heights and flags one pixel a tile, scaled up sharp. */
function overlay(map: GroundMap, d: Debug): HTMLCanvasElement | null {
  if (!d.heights && !d.flags) return null
  const g = map.grid
  const c = document.createElement('canvas')
  c.width = g.cols
  c.height = g.rows
  const img = new ImageData(g.cols, g.rows)
  for (let t = 0; t < g.cols * g.rows; t++) {
    let rgba = [0, 0, 0, 0]
    if (d.heights && g.height[t] === 1) rgba = [60, 140, 255, 70]
    if (d.heights && g.height[t] === 2) rgba = [255, 150, 40, 80]
    if (d.flags) {
      const f = g.flags[t]
      if (f & TF.bridge) rgba = [220, 120, 255, 150]
      else if (f & TF.ford) rgba = [120, 200, 255, 150]
      else if (f & TF.water) rgba = [40, 90, 255, 150]
      else if (f & TF.forest) rgba = [20, 120, 30, 150]
      else if (f & TF.blocked) rgba = [255, 40, 40, 140]
      else if (f & TF.ramp) rgba = [60, 255, 90, 130]
      else if (f & TF.deposit) rgba = [40, 240, 255, 160]
      else if (f & TF.noBuild) rgba = [255, 230, 60, 70]
    }
    img.data.set(rgba, t * 4)
  }
  c.getContext('2d')!.putImageData(img, 0, 0)
  return c
}

/** A fresh, editable copy of a map definition (shapes never shared with GROUND_MAP's). */
const editable = (d: GroundMapDef): GroundMapDef => JSON.parse(JSON.stringify(d)) as GroundMapDef
const blankMap = (cols: number, rows: number, sym: string): GroundMapDef => ({
  id: 'new-map',
  name: 'New map',
  blurb: 'A map made in the editor.',
  cols,
  rows,
  cell: 1,
  sym: sym === 'diagonal' ? 'none' : (sym as Symmetry),
  ...(sym === 'diagonal' ? { mirror: 'diagonal' as const } : {}),
  seed: 1,
  biome: 'temperate',
  sketch: [],
  features: { spawns: [[16, 16]] },
})

/** A round polygon, `r` tiles, for the level brush. */
const disc = (c: TilePt, r: number): TilePt[] => Array.from({ length: 12 }, (_, i) => [c[0] + Math.cos((i / 12) * Math.PI * 2) * r, c[1] + Math.sin((i / 12) * Math.PI * 2) * r] as TilePt)
const round = (v: number) => Math.round(v * 2) / 2
const pt = (p: TilePt): TilePt => [round(p[0]), round(p[1])]
/** Distance from a point to a polyline (or a polygon, closed). */
function toLine(p: TilePt, line: TilePt[], closed = false) {
  let best = Infinity
  const n = line.length
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = line[i], b = line[(i + 1) % n]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]))
  }
  return n === 1 ? Math.hypot(p[0] - line[0][0], p[1] - line[0][1]) : best
}
function insidePoly(p: TilePt, pts: TilePt[]) {
  let inn = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inn = !inn
  }
  return inn
}

export default function GroundViewer({ onBack }: { onBack: () => void }) {
  const [def, setDef] = useState<GroundMapDef>(() => editable(GROUND_MAPS[0]))
  const map = useMemo(() => buildGroundMap(def), [def])
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const info = useRef<HTMLSpanElement>(null)
  const [debug, setDebug] = useState<Debug>({ grid: false, heights: false, flags: false })
  const [flat, setFlat] = useState(false)
  const [editing, setEditing] = useState(false)
  const [tool, setTool] = useState<Tool>('pan')
  const [level, setLevel] = useState(1)
  const [width, setWidth] = useState(6)
  const [radius, setRadius] = useState(5)
  const [draftLen, setDraftLen] = useState(0)
  const [history, setHistory] = useState<GroundMapDef[]>([])
  const [toast, setToast] = useState('')
  const [exported, setExported] = useState<string | null>(null)
  const canEdit = !!def.features
  // What the canvas code reads: kept current without restarting it.
  const live = useRef({ def, map, tool, level, width, radius, editing })
  live.current = { def, map, tool, level, width, radius, editing }
  const api = useRef<{ zoomBy: (f: number) => void; fit: () => void; setDebug: (d: Debug) => void; setMap: (m: GroundMap) => void; finish: () => void; cancel: () => void; redraw: () => void } | null>(null)

  /** A change to the shapes: remembered for Undo, then the map rebuilds. */
  const change = (fn: (f: GroundFeatures) => void) => {
    const d = live.current.def
    const next = editable(d)
    next.features ??= {}
    fn(next.features)
    setHistory((h) => [...h.slice(-40), d])
    setDef(next)
  }
  const undo = () =>
    setHistory((h) => {
      if (!h.length) return h
      setDef(h[h.length - 1])
      return h.slice(0, -1)
    })

  useEffect(() => {
    const cv = canvas.current!
    const box = wrap.current!
    const ctx = cv.getContext('2d')!
    const layer = createGroundLayer({ flat })
    layer.canvas.className = 'ew-groundview-ground'
    box.insertBefore(layer.canvas, cv)
    let shown = live.current.map
    layer.setMap(shown)
    const size = () => [shown.grid.cols * TILE, shown.grid.rows * TILE]
    const view = { x: size()[0] / 2, y: size()[1] / 2, zoom: 0.3, w: 1, h: 1, dpr: 1 }
    let minZoom = 0.05
    const MAX_ZOOM = 3
    let dbg: Debug = { grid: false, heights: false, flags: false }
    let dbgPic: HTMLCanvasElement | null = null
    let raf = 0
    const t0 = performance.now()
    // The shape being drawn (tile units), and a drag in progress (ramp, bridge, brush).
    let draft: TilePt[] = []
    let drag: { from: TilePt; to: TilePt; dabs: TilePt[] } | null = null
    let hover: TilePt | null = null
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame)
    }
    const frame = () => {
      raf = 0
      layer.draw(view, view.w, view.h, view.dpr, (performance.now() - t0) / 1000)
      drawOverlay()
      if (layer.gl) kick()
    }
    const toTile = (sx: number, sy: number): TilePt => [(view.x + (sx - view.w / 2) / view.zoom) / TILE, (view.y + (sy - view.h / 2) / view.zoom) / TILE]

    const drawOverlay = () => {
      const d = view.zoom * view.dpr
      const [W, H] = size()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, cv.width, cv.height)
      ctx.setTransform(d, 0, 0, d, cv.width / 2 - view.x * d, cv.height / 2 - view.y * d)
      if (dbgPic) {
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(dbgPic, 0, 0, W, H)
      }
      if (dbg.grid && TILE * d >= 6) {
        const g = shown.grid
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
        ctx.lineWidth = 1 / d
        ctx.beginPath()
        for (let c = 0; c <= g.cols; c++) ctx.moveTo(c * TILE, 0), ctx.lineTo(c * TILE, H)
        for (let r = 0; r <= g.rows; r++) ctx.moveTo(0, r * TILE), ctx.lineTo(W, r * TILE)
        ctx.stroke()
      }
      if (!live.current.editing) return
      // Shapes: the copies the symmetry makes faint, the ones drawn here bold.
      const lw = 1.6 / d
      const T = TILE
      const poly = (pts: TilePt[], closed: boolean) => {
        ctx.beginPath()
        pts.forEach((p, i) => (i ? ctx.lineTo(p[0] * T, p[1] * T) : ctx.moveTo(p[0] * T, p[1] * T)))
        if (closed) ctx.closePath()
        ctx.stroke()
      }
      const dot = (p: TilePt, r: number) => {
        ctx.beginPath()
        ctx.arc(p[0] * T, p[1] * T, r, 0, Math.PI * 2)
        ctx.stroke()
      }
      const shapes = (f: GroundFeatures, faint: boolean) => {
        ctx.globalAlpha = faint ? 0.35 : 1
        ctx.setLineDash(faint ? [6 / d, 5 / d] : [])
        ctx.lineWidth = lw * (faint ? 1 : 1.4)
        for (const p of f.plateaus ?? []) (ctx.strokeStyle = p.level > 1 ? '#ff7a50' : '#ffc060'), poly(p.pts, true)
        ctx.strokeStyle = '#60e070'
        for (const p of f.forests ?? []) poly(p, true)
        ctx.strokeStyle = '#60b0ff'
        for (const r of f.rivers ?? []) r.pts.length > 1 && r.pts.some((q) => q[0] !== r.pts[0][0] || q[1] !== r.pts[0][1]) ? poly(r.pts, false) : dot(r.pts[0], (r.width / 2) * T)
        ctx.strokeStyle = '#e0c080'
        for (const r of f.roads ?? []) poly(r.pts, false)
        ctx.strokeStyle = '#80ff90'
        for (const r of f.ramps ?? []) poly([r.from, r.to], false), dot(r.to, 4 / d)
        ctx.strokeStyle = '#d0d0d0'
        for (const b of f.bridges ?? []) poly([b.from, b.to], false)
        ctx.strokeStyle = '#a0e0ff'
        for (const fd of f.fords ?? []) dot(fd.at, fd.radius * T)
        ctx.strokeStyle = '#40f0ff'
        for (const p of f.deposits ?? []) dot(p, 1.75 * T)
        ctx.strokeStyle = '#e0d8c0'
        for (const p of f.ruins ?? []) ctx.strokeRect((p[0] - 1.6) * T, (p[1] - 1.15) * T, 3.2 * T, 2.3 * T)
        ctx.strokeStyle = '#ffffff'
        for (const p of f.spawns ?? []) dot(p, 8 * T * 0.5), dot(p, 6 / d)
      }
      const own = live.current.def.features ?? {}
      shapes(expandFeatures(live.current.def), true)
      shapes(own, false)
      ctx.globalAlpha = 1
      ctx.setLineDash([])
      // What is being drawn now.
      ctx.strokeStyle = '#fff36a'
      ctx.lineWidth = lw * 1.6
      if (draft.length) poly(hover ? [...draft, hover] : draft, false)
      if (drag && live.current.tool !== 'level') poly([drag.from, drag.to], false)
      if (drag && live.current.tool === 'level') for (const p of drag.dabs) dot(p, live.current.radius * T)
      if (hover && (live.current.tool === 'level' || live.current.tool === 'ford')) (ctx.globalAlpha = 0.6), dot(hover, live.current.radius * T), (ctx.globalAlpha = 1)
    }
    const clampView = () => {
      const [W, H] = size()
      view.zoom = Math.min(MAX_ZOOM, Math.max(minZoom, view.zoom))
      view.x = Math.min(W, Math.max(0, view.x))
      view.y = Math.min(H, Math.max(0, view.y))
    }
    const fit = () => {
      const [W, H] = size()
      view.zoom = Math.min(view.w / W, view.h / H)
      view.x = W / 2
      view.y = H / 2
      clampView()
      kick()
    }
    const resize = () => {
      const [W, H] = size()
      const r = box.getBoundingClientRect()
      view.w = Math.max(1, r.width)
      view.h = Math.max(1, r.height)
      view.dpr = Math.min(2, devicePixelRatio || 1)
      cv.width = Math.round(view.w * view.dpr)
      cv.height = Math.round(view.h * view.dpr)
      minZoom = Math.min(view.w / W, view.h / H) * 0.6
      clampView()
      kick()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(box)
    resize()
    fit()
    const zoomAt = (f: number, sx: number, sy: number) => {
      const wx = view.x + (sx - view.w / 2) / view.zoom, wy = view.y + (sy - view.h / 2) / view.zoom
      view.zoom = Math.min(MAX_ZOOM, Math.max(minZoom, view.zoom * f))
      view.x = wx - (sx - view.w / 2) / view.zoom
      view.y = wy - (sy - view.h / 2) / view.zoom
      clampView()
      kick()
    }
    const showTile = (sx: number, sy: number) => {
      if (!info.current) return
      const [tc, tr] = toTile(sx, sy)
      const c = Math.floor(tc), r = Math.floor(tr)
      const g = shown.grid
      if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return
      const t = r * g.cols + c
      const flags = FLAG_NAMES.filter(([f]) => g.flags[t] & f).map(([, n]) => n)
      info.current.textContent = `${c}, ${r} · height ${g.height[t]} · ${TERRAINS[g.terrain[t]]}${flags.length ? ` · ${flags.join(', ')}` : ''}`
    }

    // --- Editing ---
    const drawing = () => live.current.editing && live.current.tool !== 'pan'
    const polyTools: Tool[] = ['plateau', 'forest', 'river', 'road']
    const finish = () => {
      const t = live.current.tool
      const pts = draft.map(pt)
      draft = []
      setDraftLen(0)
      kick()
      if (t === 'plateau' && pts.length >= 3) change((f) => (f.plateaus ??= []).push({ level: live.current.level, pts }))
      if (t === 'forest' && pts.length >= 3) change((f) => (f.forests ??= []).push(pts))
      if (t === 'river' && pts.length >= 2) change((f) => (f.rivers ??= []).push({ pts, width: live.current.width }))
      if (t === 'road' && pts.length >= 2) change((f) => (f.roads ??= []).push({ pts, width: Math.min(4, live.current.width) }))
    }
    const cancel = () => {
      draft = []
      drag = null
      setDraftLen(0)
      kick()
    }
    /** Removes the shape nearest a point, if one is within 3 tiles (or the point is inside it). */
    const erase = (p: TilePt) => {
      const f = live.current.def.features ?? {}
      type Hit = { d: number; del: (g: GroundFeatures) => void }
      const hits: Hit[] = []
      const each = <T,>(list: T[] | undefined, dist: (t: T) => number, key: keyof GroundFeatures) => (list ?? []).forEach((t, i) => hits.push({ d: dist(t), del: (g) => void (g[key] as unknown[]).splice(i, 1) }))
      each(f.plateaus, (q) => (insidePoly(p, q.pts) ? 0.5 : toLine(p, q.pts, true)), 'plateaus')
      each(f.forests, (q) => (insidePoly(p, q) ? 0.5 : toLine(p, q, true)), 'forests')
      each(f.rivers, (q) => toLine(p, q.pts) - q.width / 2, 'rivers')
      each(f.roads, (q) => toLine(p, q.pts), 'roads')
      each(f.ramps, (q) => toLine(p, [q.from, q.to]) - q.width / 2, 'ramps')
      each(f.bridges, (q) => toLine(p, [q.from, q.to]) - q.width / 2, 'bridges')
      each(f.fords, (q) => Math.hypot(p[0] - q.at[0], p[1] - q.at[1]) - q.radius, 'fords')
      each(f.deposits, (q) => Math.hypot(p[0] - q[0], p[1] - q[1]) - 1.5, 'deposits')
      each(f.ruins, (q) => Math.hypot(p[0] - q[0], p[1] - q[1]) - 1.5, 'ruins')
      each(f.spawns, (q) => Math.hypot(p[0] - q[0], p[1] - q[1]) - 2, 'spawns')
      const best = hits.filter((h) => h.d < 3).sort((a, b) => a.d - b.d)[0]
      if (best) change(best.del)
    }
    /** A tap with the tool. */
    const tap = (p: TilePt) => {
      const t = live.current.tool
      if (polyTools.includes(t)) {
        draft.push(p)
        setDraftLen(draft.length)
      } else if (t === 'ford') change((f) => (f.fords ??= []).push({ at: pt(p), radius: live.current.radius }))
      else if (t === 'deposit') change((f) => (f.deposits ??= []).push(pt(p)))
      else if (t === 'ruin') change((f) => (f.ruins ??= []).push(pt(p)))
      else if (t === 'spawn') change((f) => (f.spawns ??= []).push(pt(p)))
      else if (t === 'erase') erase(p)
      kick()
    }

    // Pointers: two always pan and pinch; one draws with the tool (or pans with Pan, or when not editing).
    const pts = new Map<number, { x: number; y: number; sx: number; sy: number }>()
    let pinch = 0
    const local = (e: PointerEvent | WheelEvent) => {
      const r = cv.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const down = (e: PointerEvent) => {
      try {
        cv.setPointerCapture(e.pointerId)
      } catch {
        // A pointer the browser no longer tracks: carry on without capture.
      }
      const p = local(e)
      pts.set(e.pointerId, { ...p, sx: p.x, sy: p.y })
      if (pts.size === 2) {
        drag = null
        const [a, b] = [...pts.values()]
        pinch = Math.hypot(a.x - b.x, a.y - b.y)
      } else if (drawing()) {
        const t = live.current.tool
        const at = toTile(p.x, p.y)
        if (t === 'ramp' || t === 'bridge' || t === 'level') drag = { from: at, to: at, dabs: t === 'level' ? [pt(at)] : [] }
      }
      kick()
    }
    const move = (e: PointerEvent) => {
      const p = local(e)
      if (e.pointerType === 'mouse') showTile(p.x, p.y)
      hover = drawing() ? toTile(p.x, p.y) : null
      const was = pts.get(e.pointerId)
      if (!was) return kick()
      if (pts.size === 1 && drag) {
        drag.to = toTile(p.x, p.y)
        if (live.current.tool === 'level') {
          const last = drag.dabs[drag.dabs.length - 1]
          if (Math.hypot(drag.to[0] - last[0], drag.to[1] - last[1]) > live.current.radius * 0.7) drag.dabs.push(pt(drag.to))
        }
      } else if (pts.size === 1 && !drawing()) {
        view.x -= (p.x - was.x) / view.zoom
        view.y -= (p.y - was.y) / view.zoom
        clampView()
      } else if (pts.size === 2) {
        const other = [...pts.entries()].find(([id]) => id !== e.pointerId)![1]
        const d = Math.hypot(p.x - other.x, p.y - other.y)
        const mx = (p.x + other.x) / 2, my = (p.y + other.y) / 2
        const pmx = (was.x + other.x) / 2, pmy = (was.y + other.y) / 2
        view.x -= (mx - pmx) / view.zoom
        view.y -= (my - pmy) / view.zoom
        if (pinch > 0) zoomAt(d / pinch, mx, my)
        pinch = d
        clampView()
      }
      pts.set(e.pointerId, { ...was, x: p.x, y: p.y })
      kick()
    }
    const up = (e: PointerEvent) => {
      const p = pts.get(e.pointerId)
      const single = pts.size === 1
      pts.delete(e.pointerId)
      pinch = 0
      if (!p || !single) return
      if (e.pointerType !== 'mouse') showTile(p.x, p.y)
      if (!drawing()) return
      const t = live.current.tool
      if (drag) {
        const d = drag
        drag = null
        const len = Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1])
        if (t === 'level') change((f) => (f.plateaus ??= []).push(...d.dabs.map((c) => ({ level: live.current.level, pts: disc(c, live.current.radius).map(pt) }))))
        else if (len >= 2 && t === 'ramp') change((f) => (f.ramps ??= []).push({ from: pt(d.from), to: pt(d.to), width: Math.min(8, live.current.width) }))
        else if (len >= 2 && t === 'bridge') change((f) => (f.bridges ??= []).push({ from: pt(d.from), to: pt(d.to), width: Math.min(6, live.current.width) }))
        kick()
        return
      }
      // A tap (it barely moved).
      if (Math.hypot(p.x - p.sx, p.y - p.sy) < 8) tap(toTile(p.x, p.y))
    }
    const dbl = () => {
      if (drawing() && polyTools.includes(live.current.tool)) {
        // The double-click's second tap added a point on top of the last one.
        if (draft.length > 1) draft.pop()
        finish()
      }
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = local(e)
      zoomAt(Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1)), p.x, p.y)
    }
    const key = (e: KeyboardEvent) => {
      if (!live.current.editing || (e.target as HTMLElement)?.closest?.('input, select, textarea')) return
      if (e.key === 'Enter') finish()
      else if (e.key === 'Escape') cancel()
      else if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) (e.preventDefault(), undo())
    }
    cv.addEventListener('pointerdown', down)
    cv.addEventListener('pointermove', move)
    cv.addEventListener('pointerup', up)
    cv.addEventListener('pointercancel', up)
    cv.addEventListener('dblclick', dbl)
    cv.addEventListener('wheel', wheel, { passive: false })
    window.addEventListener('keydown', key)
    api.current = {
      zoomBy: (f) => zoomAt(f, view.w / 2, view.h / 2),
      fit,
      setDebug: (d) => {
        dbg = d
        dbgPic = overlay(shown, d)
        kick()
      },
      setMap: (m) => {
        const resized = m.grid.cols !== shown.grid.cols || m.grid.rows !== shown.grid.rows
        shown = m
        layer.setMap(m)
        dbgPic = overlay(m, dbg)
        if (resized) resize(), fit()
        kick()
      },
      finish,
      cancel,
      redraw: kick,
    }
    void (layer as { ready?: Promise<void> }).ready?.then(kick)
    ;(window as unknown as { __ground: unknown }).__ground = { layer, view, kick, get map() { return shown }, toTile, api: api.current }
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      cv.removeEventListener('pointerdown', down)
      cv.removeEventListener('pointermove', move)
      cv.removeEventListener('pointerup', up)
      cv.removeEventListener('pointercancel', up)
      cv.removeEventListener('dblclick', dbl)
      cv.removeEventListener('wheel', wheel)
      window.removeEventListener('keydown', key)
      layer.dispose()
      layer.canvas.remove()
      api.current = null
    }
  }, [flat])

  // A changed map goes to the layer a moment after the last change (a bake takes a little while).
  useEffect(() => {
    const t = setTimeout(() => api.current?.setMap(map), 60)
    return () => clearTimeout(t)
  }, [map])
  useEffect(() => api.current?.setDebug(debug), [debug, flat])
  useEffect(() => api.current?.redraw(), [editing, tool])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 2500)
    return () => clearTimeout(t)
  }, [toast])

  const open = (id: string) => {
    api.current?.cancel()
    setHistory([])
    if (id === '__new') setDef(blankMap(96, 96, 'point'))
    else setDef(editable(GROUND_MAPS.find((m) => m.id === id) ?? GROUND_MAPS[0]))
  }
  const setSym = (s: string) => {
    setHistory((h) => [...h, def])
    const next = editable(def)
    next.sym = s === 'diagonal' ? 'none' : (s as Symmetry)
    if (s === 'diagonal') {
      next.mirror = 'diagonal'
      next.rows = next.cols
    } else delete next.mirror
    if (s === 'tri' || s === 'hex' || s === 'quad') next.rows = next.cols
    setDef(next)
  }
  const setSize = (cols: number, rows: number) => {
    const c = Math.max(32, Math.min(200, Math.round(cols) || 96)), r = Math.max(32, Math.min(200, Math.round(rows) || 96))
    const square = def.mirror === 'diagonal' || ['tri', 'hex', 'quad'].includes(def.sym)
    setHistory((h) => [...h, def])
    setDef({ ...editable(def), cols: c, rows: square ? c : r })
  }
  const exportMap = () => {
    const ts = mapToTs(def)
    const done = () => setToast('Copied as TypeScript: paste it into GROUND_MAPS in ground/maps.ts')
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(ts).then(done, () => setExported(ts))
    else setExported(ts)
  }
  const symValue = def.mirror === 'diagonal' ? 'diagonal' : def.sym
  const toggle = (k: keyof typeof debug) => setDebug((d) => ({ ...d, [k]: !d[k] }))
  const spawns = map.spawns.length
  return (
    <div className="ew-root ew-groundview">
      <div className="ew-groundview-bar">
        <button onClick={onBack}>← Back</button>
        <select value={GROUND_MAPS.some((m) => m.id === def.id) ? def.id : '__edited'} onChange={(e) => open(e.target.value)} aria-label="Ground map">
          {!GROUND_MAPS.some((m) => m.id === def.id) && <option value="__edited">{def.name}</option>}
          {GROUND_MAPS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          <option value="__new">New map…</option>
        </select>
        <span className="ew-muted ew-small ew-groundview-dev">{spawns} players · {def.cols} × {def.rows} · dev only</span>
        <span className="ew-groundview-gap" />
        <div className="ew-groundview-group" role="group" aria-label="Debug overlay">
          <button className={debug.grid ? 'is-on' : ''} aria-pressed={debug.grid} onClick={() => toggle('grid')}>
            Grid
          </button>
          <button className={debug.heights ? 'is-on' : ''} aria-pressed={debug.heights} onClick={() => toggle('heights')}>
            Heights
          </button>
          <button className={debug.flags ? 'is-on' : ''} aria-pressed={debug.flags} onClick={() => toggle('flags')}>
            Flags
          </button>
          <button className={flat ? 'is-on' : ''} aria-pressed={flat} onClick={() => setFlat((v) => !v)} data-tip="The flat fallback drawn where WebGL2 is missing">
            Flat
          </button>
        </div>
        <div className="ew-groundview-group" role="group" aria-label="Zoom">
          <button onClick={() => api.current?.zoomBy(1 / 1.4)} aria-label="Zoom out">
            −
          </button>
          <button onClick={() => api.current?.fit()}>Fit</button>
          <button onClick={() => api.current?.zoomBy(1.4)} aria-label="Zoom in">
            +
          </button>
        </div>
        <button className={editing ? 'is-on' : ''} aria-pressed={editing} disabled={!canEdit} onClick={() => (setEditing((v) => !v), api.current?.cancel())} data-tip={canEdit ? 'Edit the map’s shapes' : 'A round 1 sketch map: view only'}>
          Edit
        </button>
      </div>
      {editing && (
        <div className="ew-groundview-edit">
          <div className="ew-groundview-tools" role="group" aria-label="Tools">
            {TOOLS.map(([t, label, tip]) => (
              <button key={t} className={tool === t ? 'is-on' : ''} aria-pressed={tool === t} data-tip={tip} onClick={() => (api.current?.cancel(), setTool(t))}>
                {label}
              </button>
            ))}
          </div>
          <div className="ew-groundview-opts">
            {(tool === 'level' || tool === 'plateau') && (
              <label>
                Level
                <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
                  <option value={1}>1 (mid)</option>
                  <option value={2}>2 (high)</option>
                </select>
              </label>
            )}
            {(tool === 'river' || tool === 'road' || tool === 'ramp' || tool === 'bridge') && (
              <label>
                Width
                <input type="range" min={2} max={12} step={0.5} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
                <b>{width}</b>
              </label>
            )}
            {(tool === 'level' || tool === 'ford') && (
              <label>
                {tool === 'level' ? 'Brush' : 'Radius'}
                <input type="range" min={2} max={12} step={0.5} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
                <b>{radius}</b>
              </label>
            )}
            {['plateau', 'forest', 'river', 'road'].includes(tool) && (
              <>
                <button disabled={draftLen < (tool === 'river' || tool === 'road' ? 2 : 3)} onClick={() => api.current?.finish()}>
                  Finish
                </button>
                <button disabled={!draftLen} onClick={() => api.current?.cancel()}>
                  Cancel
                </button>
              </>
            )}
            <span className="ew-groundview-gap" />
            <button disabled={!history.length} onClick={undo}>
              Undo
            </button>
          </div>
          <div className="ew-groundview-opts">
            <label>
              Name
              <input value={def.name} onChange={(e) => setDef({ ...def, name: e.target.value, id: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map' })} />
            </label>
            <label>
              Symmetry
              <select value={symValue} onChange={(e) => setSym(e.target.value)}>
                {SYMMETRIES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Size
              <input type="number" min={32} max={200} step={4} value={def.cols} onChange={(e) => setSize(Number(e.target.value), def.rows)} aria-label="Columns" />×
              <input type="number" min={32} max={200} step={4} value={def.rows} onChange={(e) => setSize(def.cols, Number(e.target.value))} aria-label="Rows" />
            </label>
            <span className="ew-groundview-gap" />
            <button onClick={exportMap} data-tip="Copy the map as TypeScript for ground/maps.ts">
              Export
            </button>
          </div>
        </div>
      )}
      <div className="ew-groundview-stage" ref={wrap}>
        <canvas ref={canvas} />
        {(debug.heights || debug.flags) && (
          <div className="ew-groundview-legend ew-small">
            {debug.heights && (
              <>
                <span><i style={{ background: 'rgba(60,140,255,0.6)' }} />mid</span>
                <span><i style={{ background: 'rgba(255,150,40,0.6)' }} />plateau</span>
              </>
            )}
            {debug.flags && (
              <>
                <span><i style={{ background: 'rgba(255,40,40,0.7)' }} />blocked</span>
                <span><i style={{ background: 'rgba(255,230,60,0.6)' }} />no build</span>
                <span><i style={{ background: 'rgba(60,255,90,0.7)' }} />ramp</span>
                <span><i style={{ background: 'rgba(40,240,255,0.7)' }} />crystals</span>
                <span><i style={{ background: 'rgba(40,90,255,0.7)' }} />water</span>
                <span><i style={{ background: 'rgba(120,200,255,0.7)' }} />ford</span>
                <span><i style={{ background: 'rgba(220,120,255,0.7)' }} />bridge</span>
                <span><i style={{ background: 'rgba(20,120,30,0.7)' }} />forest</span>
              </>
            )}
          </div>
        )}
        <span className="ew-groundview-info ew-small" ref={info}>
          {map.def.blurb}
        </span>
        {toast && <div className="ew-groundview-toast ew-small">{toast}</div>}
        {exported !== null && (
          <div className="ew-groundview-export">
            <p className="ew-small">The browser didn&rsquo;t allow copying: select the text and copy it, then paste it into GROUND_MAPS in ground/maps.ts.</p>
            <textarea readOnly value={exported} onFocus={(e) => e.currentTarget.select()} />
            <button onClick={() => setExported(null)}>Close</button>
          </div>
        )}
      </div>
    </div>
  )
}
