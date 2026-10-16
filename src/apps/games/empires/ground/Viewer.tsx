import { useEffect, useMemo, useRef, useState } from 'react'
import { isMobile } from '../../../../os/useIsMobile'
import { GROUND_MAPS } from './maps.ts'
import { GroundRenderer, type GroundView } from './render.ts'
import { buildGroundMap } from './terrain.ts'
import { TERRAINS, TF, TILE } from './types.ts'
import './viewer.css'

// Dev builds only: a look at a ground map, with pan and zoom (mouse drag and wheel, touch drag and
// pinch) and a debug overlay of the tile grid, heights and flags. Menus.tsx loads it behind
// `import.meta.env.DEV`, so production builds don't contain it. The real ground battle screen
// comes later; this is for checking the terrain and the renderer.

const FLAG_NAMES: [number, string][] = [
  [TF.blocked, 'blocked'],
  [TF.noBuild, 'no build'],
  [TF.ramp, 'ramp'],
  [TF.deposit, 'deposit'],
  [TF.water, 'water'],
]

export default function GroundViewer({ onBack }: { onBack: () => void }) {
  const [mapId, setMapId] = useState(GROUND_MAPS[0].id)
  const map = useMemo(() => buildGroundMap(GROUND_MAPS.find((m) => m.id === mapId) ?? GROUND_MAPS[0]), [mapId])
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const info = useRef<HTMLSpanElement>(null)
  const [debug, setDebug] = useState({ grid: false, heights: false, flags: false })
  const api = useRef<{ zoomBy: (f: number) => void; fit: () => void; setDebug: (d: typeof debug) => void } | null>(null)

  useEffect(() => {
    const cv = canvas.current!
    const box = wrap.current!
    const ctx = cv.getContext('2d', { alpha: false })!
    const phone = isMobile() || matchMedia('(pointer: coarse)').matches
    const renderer = new GroundRenderer(map, phone ? { budget: 24 * 1024 * 1024, maxScale: Math.SQRT2 } : {})
    const W = map.grid.cols * TILE, H = map.grid.rows * TILE
    const view: GroundView = { x: W / 2, y: H / 2, zoom: 0.3, w: 1, h: 1, dpr: 1 }
    let minZoom = 0.05
    const MAX_ZOOM = 3
    let raf = 0
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame)
    }
    const frame = () => {
      raf = 0
      const more = renderer.draw(ctx, view)
      if (more) kick()
    }
    const clampView = () => {
      view.zoom = Math.min(MAX_ZOOM, Math.max(minZoom, view.zoom))
      const hw = view.w / 2 / view.zoom, hh = view.h / 2 / view.zoom
      view.x = hw * 2 >= W ? W / 2 : Math.min(W - hw, Math.max(hw, view.x))
      view.y = hh * 2 >= H ? H / 2 : Math.min(H - hh, Math.max(hh, view.y))
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
      minZoom = Math.min(view.w / W, view.h / H) * 0.9
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
        renderer.debug = { ...d }
        kick()
      },
    }
    void renderer.ready.then(kick)
    if (import.meta.env.DEV) (window as unknown as { __ground: unknown }).__ground = { renderer, view, kick }
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      cv.removeEventListener('pointerdown', down)
      cv.removeEventListener('pointermove', move)
      cv.removeEventListener('pointerup', up)
      cv.removeEventListener('pointercancel', up)
      cv.removeEventListener('wheel', wheel)
      renderer.dispose()
      api.current = null
    }
  }, [map])

  useEffect(() => api.current?.setDebug(debug), [debug, map])

  const toggle = (k: keyof typeof debug) => setDebug((d) => ({ ...d, [k]: !d[k] }))
  return (
    <div className="ew-root ew-groundview">
      <div className="ew-groundview-bar">
        <button onClick={onBack}>← Space</button>
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
