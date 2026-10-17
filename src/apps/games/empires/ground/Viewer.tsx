import { useEffect, useMemo, useRef, useState } from 'react'
import { createGroundLayer } from './gl.ts'
import { GROUND_MAPS } from './maps.ts'
import { buildGroundMap } from './terrain.ts'
import { TERRAINS, TF, TILE, type GroundMap } from './types.ts'
import './viewer.css'

// Dev builds only: a look at a ground map, with pan and zoom (mouse drag and wheel, touch drag and
// pinch) and a debug overlay of the tile grid, heights and flags. The ground is the battle's own
// ground layer (gl.ts, WebGL2, or its flat fallback with Flat on), with a 2D canvas over it for the
// overlay, as the battle screen stacks them. Loaded only in dev builds, so production builds don't
// contain it. The view may pan a little past the map's edge, to see the mirrored border.

const FLAG_NAMES: [number, string][] = [
  [TF.blocked, 'blocked'],
  [TF.noBuild, 'no build'],
  [TF.ramp, 'ramp'],
  [TF.deposit, 'deposit'],
  [TF.water, 'water'],
  [TF.bridge, 'bridge'],
  [TF.ford, 'ford'],
  [TF.forest, 'forest'],
]

type Debug = { grid: boolean; heights: boolean; flags: boolean }

/** The debug overlay: heights and flags one pixel a tile, scaled up sharp, and the tile grid. */
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

export default function GroundViewer({ onBack }: { onBack: () => void }) {
  const [mapId, setMapId] = useState(GROUND_MAPS[0].id)
  const map = useMemo(() => buildGroundMap(GROUND_MAPS.find((m) => m.id === mapId) ?? GROUND_MAPS[0]), [mapId])
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const info = useRef<HTMLSpanElement>(null)
  const [debug, setDebug] = useState<Debug>({ grid: false, heights: false, flags: false })
  const [flat, setFlat] = useState(false)
  const api = useRef<{ zoomBy: (f: number) => void; fit: () => void; setDebug: (d: Debug) => void } | null>(null)

  useEffect(() => {
    const cv = canvas.current!
    const box = wrap.current!
    const ctx = cv.getContext('2d')!
    const layer = createGroundLayer({ flat })
    layer.canvas.className = 'ew-groundview-ground'
    box.insertBefore(layer.canvas, cv)
    layer.setMap(map)
    const W = map.grid.cols * TILE, H = map.grid.rows * TILE
    const view = { x: W / 2, y: H / 2, zoom: 0.3, w: 1, h: 1, dpr: 1 }
    let minZoom = 0.05
    const MAX_ZOOM = 3
    let dbg: Debug = { grid: false, heights: false, flags: false }
    let dbgPic: HTMLCanvasElement | null = null
    let raf = 0
    const t0 = performance.now()
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame)
    }
    const frame = () => {
      raf = 0
      layer.draw(view, view.w, view.h, view.dpr, (performance.now() - t0) / 1000)
      drawOverlay()
      // The water moves: keep drawing while the layer animates.
      if (layer.gl) kick()
    }
    const drawOverlay = () => {
      const d = view.zoom * view.dpr
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, cv.width, cv.height)
      if (!dbgPic && !dbg.grid) return
      ctx.setTransform(d, 0, 0, d, cv.width / 2 - view.x * d, cv.height / 2 - view.y * d)
      if (dbgPic) {
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(dbgPic, 0, 0, W, H)
      }
      if (dbg.grid && TILE * d >= 6) {
        const g = map.grid
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
        ctx.lineWidth = 1 / d
        ctx.beginPath()
        for (let c = 0; c <= g.cols; c++) ctx.moveTo(c * TILE, 0), ctx.lineTo(c * TILE, H)
        for (let r = 0; r <= g.rows; r++) ctx.moveTo(0, r * TILE), ctx.lineTo(W, r * TILE)
        ctx.stroke()
      }
    }
    // The view's middle stays on the map; zoomed out, the mirrored border shows round it.
    const clampView = () => {
      view.zoom = Math.min(MAX_ZOOM, Math.max(minZoom, view.zoom))
      view.x = Math.min(W, Math.max(0, view.x))
      view.y = Math.min(H, Math.max(0, view.y))
    }
    const fit = () => {
      view.zoom = Math.min(view.w / W, view.h / H)
      view.x = W / 2
      view.y = H / 2
      clampView()
      kick()
    }
    const resize = () => {
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
    // Zoom about a point on the canvas (CSS pixels from its top left).
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
      const wx = view.x + (sx - view.w / 2) / view.zoom, wy = view.y + (sy - view.h / 2) / view.zoom
      const c = Math.floor(wx / TILE), r = Math.floor(wy / TILE)
      const g = map.grid
      if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return
      const t = r * g.cols + c
      const flags = FLAG_NAMES.filter(([f]) => g.flags[t] & f).map(([, n]) => n)
      info.current.textContent = `${c}, ${r} · height ${g.height[t]} · ${TERRAINS[g.terrain[t]]}${flags.length ? ` · ${flags.join(', ')}` : ''}`
    }
    // Pointers: one drags the view, two pinch (zoom about their middle, and pan as it moves).
    const pts = new Map<number, { x: number; y: number }>()
    let pinch = 0
    const local = (e: PointerEvent | WheelEvent) => {
      const r = cv.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const down = (e: PointerEvent) => {
      try {
        cv.setPointerCapture(e.pointerId)
      } catch {
        // A pointer the browser no longer tracks: drag without capture.
      }
      pts.set(e.pointerId, local(e))
      if (pts.size === 2) {
        const [a, b] = [...pts.values()]
        pinch = Math.hypot(a.x - b.x, a.y - b.y)
      }
    }
    const move = (e: PointerEvent) => {
      const p = local(e)
      if (e.pointerType === 'mouse') showTile(p.x, p.y)
      const was = pts.get(e.pointerId)
      if (!was) return
      if (pts.size === 1) {
        view.x -= (p.x - was.x) / view.zoom
        view.y -= (p.y - was.y) / view.zoom
        clampView()
        kick()
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
        kick()
      }
      pts.set(e.pointerId, p)
    }
    const up = (e: PointerEvent) => {
      const p = pts.get(e.pointerId)
      if (p && e.pointerType !== 'mouse' && pts.size === 1) showTile(p.x, p.y)
      pts.delete(e.pointerId)
      pinch = 0
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = local(e)
      zoomAt(Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1)), p.x, p.y)
    }
    cv.addEventListener('pointerdown', down)
    cv.addEventListener('pointermove', move)
    cv.addEventListener('pointerup', up)
    cv.addEventListener('pointercancel', up)
    cv.addEventListener('wheel', wheel, { passive: false })
    api.current = {
      zoomBy: (f) => zoomAt(f, view.w / 2, view.h / 2),
      fit,
      setDebug: (d) => {
        dbg = d
        dbgPic = overlay(map, d)
        kick()
      },
    }
    void (layer as { ready?: Promise<void> }).ready?.then(kick)
    ;(window as unknown as { __ground: unknown }).__ground = { layer, view, kick, map }
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      cv.removeEventListener('pointerdown', down)
      cv.removeEventListener('pointermove', move)
      cv.removeEventListener('pointerup', up)
      cv.removeEventListener('pointercancel', up)
      cv.removeEventListener('wheel', wheel)
      layer.dispose()
      layer.canvas.remove()
      api.current = null
    }
  }, [map, flat])

  useEffect(() => api.current?.setDebug(debug), [debug, map, flat])

  const toggle = (k: keyof typeof debug) => setDebug((d) => ({ ...d, [k]: !d[k] }))
  return (
    <div className="ew-root ew-groundview">
      <div className="ew-groundview-bar">
        <button onClick={onBack}>← Back</button>
        {GROUND_MAPS.length > 1 ? (
          <select value={mapId} onChange={(e) => setMapId(e.target.value)} aria-label="Ground map">
            {GROUND_MAPS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : (
          <strong>{map.def.name}</strong>
        )}
        <span className="ew-muted ew-small ew-groundview-dev">Ground map viewer · dev only</span>
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
      </div>
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
                <span><i style={{ background: 'rgba(40,240,255,0.7)' }} />deposit</span>
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
      </div>
    </div>
  )
}
