import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { shortPlaceName, type Place } from '../../data/weather'
import { reducedMotion } from './Sky'

// The precipitation radar: RainViewer's past frames (and nowcast frames when it publishes them)
// over a quiet Esri canvas. Every frame of the loop is its own stacked layer of tiles, loaded up
// front, so playing or scrubbing only changes which layer is opaque (a short crossfade, no
// reloading, no flicker). The dashboard card loops by itself while it is on screen; the detail
// has play/pause, a draggable timeline, speed, and drag-to-pan with zoom.

const TILE = 256
/** Radar tiles come at 512 px one zoom level down: a quarter of the requests for the same detail. */
const RADAR_TILE = 512
export const RADAR_ZOOM = 7
const MIN_ZOOM = 4
const MAX_ZOOM = 8
const RADAR_TTL = 10 * 60_000

// CARTO Dark Matter raster tiles have required an API key since September 2026: without one the
// CDN returns a blank tile that only says the key is required. Esri's gray canvas is the quiet
// dark/light basemap that still serves plain tiles, and it follows :root[data-mode].
const BASE_DARK = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile'
const BASE_LIGHT = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile'

export type RadarFrame = { time: number; path: string; forecast: boolean }
type RadarSnap = { host: string; frames: RadarFrame[]; failed: boolean; at: number }

let radarSnap: RadarSnap | null = null
let radarFlight: Promise<void> | null = null
const radarWaiters = new Set<() => void>()

function parseFrames(list: unknown, forecast: boolean): RadarFrame[] {
  if (!Array.isArray(list)) return []
  const out: RadarFrame[] = []
  for (const f of list as { time?: unknown; path?: unknown }[]) {
    if (!f || typeof f.path !== 'string' || typeof f.time !== 'number') continue
    out.push({ time: f.time, path: f.path.startsWith('/') ? f.path : `/${f.path}`, forecast })
  }
  return out
}

function ensureRadar() {
  if (radarFlight) return
  if (radarSnap && Date.now() - radarSnap.at < RADAR_TTL) return
  radarFlight = fetch('https://api.rainviewer.com/public/weather-maps.json', { signal: AbortSignal.timeout(10_000) })
    .then((res) => {
      if (!res.ok) throw new Error('radar')
      return res.json() as Promise<{ host?: unknown; radar?: { past?: unknown; nowcast?: unknown } }>
    })
    .then((data) => {
      const host = typeof data.host === 'string' ? data.host.replace(/\/$/, '') : ''
      const frames = [...parseFrames(data.radar?.past, false), ...parseFrames(data.radar?.nowcast, true)]
      if (!host || !frames.some((f) => !f.forecast)) throw new Error('radar')
      radarSnap = { host, frames, failed: false, at: Date.now() }
    })
    .catch(() => {
      // Keep frames we already had; only say "unavailable" when there are none.
      radarSnap = radarSnap && !radarSnap.failed ? { ...radarSnap, at: Date.now() } : { host: '', frames: [], failed: true, at: Date.now() }
    })
    .finally(() => {
      radarFlight = null
      radarWaiters.forEach((fn) => fn())
    })
}

export function useRadar(): { host: string; frames: RadarFrame[]; failed: boolean; nowIndex: number } {
  const [snap, setSnap] = useState<RadarSnap>(() => radarSnap ?? { host: '', frames: [], failed: false, at: 0 })
  useEffect(() => {
    const pull = () => {
      if (radarSnap) setSnap(radarSnap)
    }
    radarWaiters.add(pull)
    ensureRadar()
    pull()
    const t = setInterval(ensureRadar, RADAR_TTL)
    return () => {
      clearInterval(t)
      radarWaiters.delete(pull)
    }
  }, [])
  let nowIndex = -1
  for (let k = 0; k < snap.frames.length; k++) if (!snap.frames[k].forecast) nowIndex = k
  return { host: snap.host, frames: snap.frames, failed: snap.failed, nowIndex: Math.max(0, nowIndex) }
}

export function frameClock(f: RadarFrame): string {
  return new Date(f.time * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function frameRelative(f: RadarFrame, now: RadarFrame | undefined): string {
  if (!now) return ''
  const mins = Math.round((f.time - now.time) / 60)
  if (mins === 0) return 'Now'
  const abs = Math.abs(mins)
  const span = abs >= 60 ? `${Math.floor(abs / 60)} h${abs % 60 ? ` ${abs % 60} min` : ''}` : `${abs} min`
  return mins < 0 ? `${span} ago` : `+${span}`
}

function useLightMap(): boolean {
  const [light, setLight] = useState(() => document.documentElement.dataset.mode === 'light')
  useEffect(() => {
    const root = document.documentElement
    const sync = () => setLight(root.dataset.mode === 'light')
    const mo = new MutationObserver(sync)
    mo.observe(root, { attributes: true, attributeFilter: ['data-mode'] })
    sync()
    return () => mo.disconnect()
  }, [])
  return light
}

/** On screen and the page visible: the loop only runs then. */
function useLive(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(true)
  const [shown, setShown] = useState(() => typeof document === 'undefined' || !document.hidden)
  useEffect(() => {
    const onVis = () => setShown(!document.hidden)
    document.addEventListener('visibilitychange', onVis)
    const el = ref.current
    let io: IntersectionObserver | null = null
    if (el && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((entries) => setSeen(entries.some((e) => e.isIntersecting)))
      io.observe(el)
    }
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      io?.disconnect()
    }
  }, [ref])
  return seen && shown
}

function wrapTile(n: number, size: number) {
  return ((n % size) + size) % size
}

function worldX(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z * TILE
}

function worldY(lat: number, z: number) {
  const clamped = Math.min(85.05112878, Math.max(-85.05112878, lat))
  const r = (clamped * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z * TILE
}

type Tile = { key: string; x: number; y: number; left: number; top: number }

/** Tiles of `size` px (grid of zoom `tz`) covering a w×h view whose top-left is at world px (left, top). */
function coverTiles(left: number, top: number, w: number, h: number, size: number, tz: number): Tile[] {
  const n = 2 ** tz
  const x0 = Math.floor(left / size)
  const y0 = Math.floor(top / size)
  const x1 = Math.floor((left + Math.max(w, 1) - 1) / size)
  const y1 = Math.floor((top + Math.max(h, 1) - 1) / size)
  const out: Tile[] = []
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= n) continue
      out.push({ key: `${x},${y}`, x: wrapTile(x, n), y, left: Math.round(x * size - left), top: Math.round(y * size - top) })
    }
  }
  return out
}

function hideBrokenTile(e: { currentTarget: HTMLImageElement }) {
  e.currentTarget.hidden = true
}

type MapProps = {
  place: Place
  host: string
  frames: RadarFrame[]
  active: number
  failed: boolean
  zoom: number
  pan: { x: number; y: number }
  className?: string
  scrubbing?: boolean
  /** Where the size is reported, for the pan/zoom wrapper. */
  boxRef?: RefObject<HTMLDivElement | null>
  layerRef?: RefObject<HTMLDivElement | null>
}

/** Base canvas plus one stacked layer per radar frame; only the active layer is opaque. */
const RadarMap = memo(function RadarMap({ place, host, frames, active, failed, zoom, pan, className, scrubbing, boxRef, layerRef }: MapProps) {
  const ownBox = useRef<HTMLDivElement>(null)
  const box = boxRef ?? ownBox
  const [size, setSize] = useState({ w: 0, h: 0 })
  const light = useLightMap()

  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const sync = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [box])

  const left = worldX(place.lon, zoom) + pan.x - size.w / 2
  const top = worldY(place.lat, zoom) + pan.y - size.h / 2
  const ok = size.w > 0 && size.h > 0
  const base = ok ? coverTiles(left, top, size.w, size.h, TILE, zoom) : []
  const radar = ok ? coverTiles(left, top, size.w, size.h, RADAR_TILE, zoom - 1) : []
  const baseUrl = light ? BASE_LIGHT : BASE_DARK

  return (
    <div ref={box} className={`wa-radar${className ? ` ${className}` : ''}${scrubbing ? ' is-scrub' : ''}`}>
      <div ref={layerRef} className="wa-radar-pan">
        {base.map((t) => (
          <img key={`b${zoom}:${t.key}`} className="wa-radar-tile" alt="" draggable={false} decoding="async" src={`${baseUrl}/${zoom}/${t.y}/${t.x}`} style={{ left: t.left, top: t.top }} onError={hideBrokenTile} />
        ))}
        {host &&
          frames.map((f, k) => (
            <div key={f.path} className={`wa-radar-frame${k === active ? ' is-on' : ''}`}>
              {radar.map((t) => (
                <img
                  key={`${zoom}:${t.key}`}
                  className="wa-radar-tile is-radar"
                  alt=""
                  draggable={false}
                  decoding="async"
                  src={`${host}${f.path}/${RADAR_TILE}/${zoom - 1}/${t.x}/${t.y}/2/1_1.png`}
                  style={{ left: t.left, top: t.top }}
                  onError={hideBrokenTile}
                />
              ))}
            </div>
          ))}
        {ok && <i className="wa-radar-pin" style={{ left: Math.round(size.w / 2 - pan.x), top: Math.round(size.h / 2 - pan.y) }} />}
      </div>
      {failed && <p className="wa-radar-miss">Radar unavailable</p>}
    </div>
  )
})

const NO_PAN = { x: 0, y: 0 }

/** Dashboard card: a quiet loop of the last two hours while it is on screen. */
export function RadarCard({ place, onOpen }: { place: Place; onOpen: () => void }) {
  const { host, frames, failed, nowIndex } = useRadar()
  const ref = useRef<HTMLElement>(null)
  const live = useLive(ref)
  const [active, setActive] = useState(-1)
  const still = reducedMotion()
  const shown = active < 0 || active >= frames.length || still ? nowIndex : active

  useEffect(() => {
    if (!live || still || frames.length < 2) return
    const at = active < 0 || active >= frames.length ? nowIndex : active
    const last = frames.length - 1
    const wait = at === last ? 2200 : at === nowIndex ? 1400 : 520
    const t = setTimeout(() => setActive(at >= last ? 0 : at + 1), wait)
    return () => clearTimeout(t)
  }, [live, still, frames.length, active, nowIndex])

  const name = shortPlaceName(place.name)
  const f = frames[shown]
  return (
    <article ref={ref} className="wa-card wa-map">
      <h3>Radar</h3>
      <div className="wa-map-view" aria-hidden>
        <RadarMap place={place} host={host} frames={frames} active={shown} failed={failed} zoom={RADAR_ZOOM} pan={NO_PAN} />
        {f && (
          <span className={`wa-map-chip${f.forecast ? ' is-forecast' : ''}`}>
            {frameClock(f)} · {frameRelative(f, frames[nowIndex])}
          </span>
        )}
        {frames.length > 1 && (
          <span className="wa-map-progress">
            <i style={{ transform: `scaleX(${(shown + 1) / frames.length})` }} />
          </span>
        )}
      </div>
      <button type="button" className="wa-cover" aria-label={failed ? `Precipitation radar for ${name}, radar unavailable` : `Precipitation radar for ${name}, open the animated map`} onClick={onOpen} />
    </article>
  )
}

const SPEEDS: [number, string][] = [
  [0.5, '½×'],
  [1, '1×'],
  [2, '2×'],
]

/** The big map: play/pause, draggable timeline, speed, pan by dragging, zoom buttons. */
export function RadarExplorer({ place }: { place: Place }) {
  const { host, frames, failed, nowIndex } = useRadar()
  const wrap = useRef<HTMLDivElement>(null)
  const live = useLive(wrap)
  const [active, setActive] = useState(-1)
  const [playing, setPlaying] = useState(() => !reducedMotion())
  const [speed, setSpeed] = useState(1)
  const [scrubbing, setScrubbing] = useState(false)
  const [zoom, setZoom] = useState(RADAR_ZOOM)
  const [pan, setPan] = useState(NO_PAN)
  const boxRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; x: number; y: number; dx: number; dy: number } | null>(null)
  const at = active < 0 || active >= frames.length ? nowIndex : active

  useEffect(() => {
    if (!playing || !live || scrubbing || frames.length < 2) return
    const last = frames.length - 1
    const wait = (at === last ? 1600 : at === nowIndex ? 900 : 480) / speed
    const t = setTimeout(() => setActive(at >= last ? 0 : at + 1), wait)
    return () => clearTimeout(t)
  }, [playing, live, scrubbing, frames.length, at, nowIndex, speed])

  // The drag offset is a transform on the layer; once the new pan renders, it goes away.
  useLayoutEffect(() => {
    if (layerRef.current) layerRef.current.style.transform = ''
  }, [pan, zoom])

  const zoomNow = useRef(zoom)
  zoomNow.current = zoom
  const zoomBy = useCallback((by: number) => {
    const z = zoomNow.current
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + by))
    if (next === z) return
    zoomNow.current = next
    setZoom(next)
    setPan((p) => ({ x: p.x * 2 ** (next - z), y: p.y * 2 ** (next - z) }))
  }, [])

  // Wheel zoom (non-passive so the sheet does not scroll under the map).
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    let last = 0
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const t = performance.now()
      if (t - last < 220 || Math.abs(e.deltaY) < 2) return
      last = t
      zoomBy(e.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomBy])

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0 }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    d.dx = Math.round(e.clientX - d.x)
    d.dy = Math.round(e.clientY - d.y)
    if (layerRef.current) layerRef.current.style.transform = `translate(${d.dx}px, ${d.dy}px)`
  }
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (d.dx || d.dy) setPan((p) => ({ x: p.x - d.dx, y: p.y - d.dy }))
  }

  const f = frames[at]
  const moved = pan.x !== 0 || pan.y !== 0 || zoom !== RADAR_ZOOM
  return (
    <div ref={wrap} className="wa-radarx">
      <div className="wa-radarx-map" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <RadarMap place={place} host={host} frames={frames} active={at} failed={failed} zoom={zoom} pan={pan} className="wa-detail-map" scrubbing={scrubbing} boxRef={boxRef} layerRef={layerRef} />
        <div className="wa-radarx-zoom" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => zoomBy(1)}>
            +
          </button>
          <button type="button" aria-label="Zoom out" disabled={zoom <= MIN_ZOOM} onClick={() => zoomBy(-1)}>
            −
          </button>
          {moved && (
            <button
              type="button"
              aria-label="Back to the place"
              title="Back to the place"
              onClick={() => {
                setPan(NO_PAN)
                setZoom(RADAR_ZOOM)
              }}
            >
              ⌖
            </button>
          )}
        </div>
      </div>
      {frames.length > 0 && f && (
        <div className="wa-radarx-bar">
          <button type="button" className="wa-radarx-play" aria-label={playing ? 'Pause' : 'Play'} aria-pressed={playing} onClick={() => setPlaying((p) => !p)}>
            {playing ? (
              <svg viewBox="0 0 16 16" aria-hidden>
                <rect x="3" y="2" width="3.5" height="12" />
                <rect x="9.5" y="2" width="3.5" height="12" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" aria-hidden>
                <path d="M4 2 L14 8 L4 14 Z" />
              </svg>
            )}
          </button>
          <div className={`wa-radarx-time${f.forecast ? ' is-forecast' : ''}`}>
            <strong>{frameClock(f)}</strong>
            <span>{f.forecast ? `Forecast ${frameRelative(f, frames[nowIndex])}` : frameRelative(f, frames[nowIndex])}</span>
          </div>
          <div className="wa-radarx-speed" role="radiogroup" aria-label="Speed">
            {SPEEDS.map(([s, label]) => (
              <button key={s} type="button" role="radio" aria-checked={speed === s} className={speed === s ? 'is-on' : ''} onClick={() => setSpeed(s)}>
                {label}
              </button>
            ))}
          </div>
          <RadarTimeline
            frames={frames}
            nowIndex={nowIndex}
            active={at}
            onActive={(k) => {
              setPlaying(false)
              setActive(k)
            }}
            onScrub={setScrubbing}
          />
        </div>
      )}
      {frames.length > 0 && !frames.some((x) => x.forecast) && <p className="wa-radarx-note">RainViewer publishes past frames only right now, so the loop ends at the latest scan.</p>}
    </div>
  )
}

function RadarTimeline({ frames, nowIndex, active, onActive, onScrub }: { frames: RadarFrame[]; nowIndex: number; active: number; onActive: (k: number) => void; onScrub: (on: boolean) => void }) {
  const track = useRef<HTMLDivElement>(null)
  const held = useRef<number | null>(null)
  const n = frames.length
  const pct = (k: number) => (n <= 1 ? 50 : (k / (n - 1)) * 100)
  const at = (clientX: number) => {
    const el = track.current
    if (!el || n <= 1) return 0
    const r = el.getBoundingClientRect()
    return Math.min(n - 1, Math.max(0, Math.round(((clientX - r.left) / Math.max(1, r.width)) * (n - 1))))
  }
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    held.current = e.pointerId
    e.currentTarget.setPointerCapture?.(e.pointerId)
    onScrub(true)
    onActive(at(e.clientX))
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (held.current !== e.pointerId) return
    const k = at(e.clientX)
    if (k !== active) onActive(k)
  }
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (held.current !== e.pointerId) return
    held.current = null
    onScrub(false)
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const by = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0
    if (e.key === 'Home') onActive(0)
    else if (e.key === 'End') onActive(n - 1)
    else if (by) onActive(Math.min(n - 1, Math.max(0, active + by)))
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  const f = frames[active]
  const now = frames[nowIndex]
  const forecastFrom = frames.findIndex((x) => x.forecast)
  return (
    <div
      className="wa-tl"
      role="slider"
      tabIndex={0}
      aria-label="Radar time"
      aria-valuemin={0}
      aria-valuemax={n - 1}
      aria-valuenow={active}
      aria-valuetext={f ? `${frameClock(f)}, ${frameRelative(f, now)}` : ''}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
    >
      <div ref={track} className="wa-tl-track">
        <i className="wa-tl-past" style={{ width: `${pct(nowIndex)}%` }} />
        {forecastFrom >= 0 && <i className="wa-tl-future" style={{ left: `${pct(nowIndex)}%`, right: 0 }} />}
        <i className="wa-tl-fill" style={{ transform: `scaleX(${pct(active) / 100})` }} />
        {frames.map((x, k) => (
          <b key={x.path} className={`wa-tl-tick${x.forecast ? ' is-forecast' : ''}${k === nowIndex ? ' is-now' : ''}`} style={{ left: `${pct(k)}%` }} />
        ))}
        <span className={`wa-tl-thumb${f?.forecast ? ' is-forecast' : ''}`} style={{ left: `${pct(active)}%` }} />
      </div>
      <div className="wa-tl-labels" aria-hidden>
        {frames[0] && <span style={{ left: 0 }}>{frameClock(frames[0])}</span>}
        {now && (
          <span className="is-now" style={{ left: `${pct(nowIndex)}%` }}>
            Now
          </span>
        )}
        {n > 1 && nowIndex !== n - 1 && <span style={{ left: '100%' }}>{frameClock(frames[n - 1])}</span>}
      </div>
    </div>
  )
}
