import { useEffect, useRef, useState } from 'react'
import { download, sfPath } from '../../data/seafile'
import { coordinates, duration, exposureText, fullDate, getInfo, originalUrl, setFavourite, thumbUrl, wallOf, webShows, type Info, type Item, type SourceId } from '../../data/photos'
import { formatSize } from '../../terminal/vfs'
import { openContextMenu, openMenuAt, type MenuItem } from '../../os/ContextMenu'
import { useWM } from '../../os/wm'

// One photo at a time, over the timeline. The large thumbnail shows at once and the original
// replaces it when it has loaded (when the browser can show it: HEIC and TIFF stay the large
// thumbnail). Zoom with the wheel, a pinch, double-click or + and −, towards the pointer; drag to
// pan when zoomed in. Arrow keys, swipes and the side buttons go through the timeline, Escape or a
// swipe down closes, I shows the details (camera, lens, exposure, size, place), full stop makes
// it a favourite, Delete (or the bin) moves it to the trash and goes on to the next one, and
// right-click (or ⋯) has the same menu as in the grid. Videos play in Player.

const MAX = 8

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
const Icon = ({ d, fill }: { d: string; fill?: boolean }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden {...stroke} fill={fill ? 'currentColor' : 'none'}>
    <path d={d} />
  </svg>
)
const HEART = 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z'
const INFO = 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.5'
const SAVE = 'M12 4v11M7 10l5 5 5-5M5 20h14'
const BIN = 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'
type View = { s: number; x: number; y: number }
const FIT: View = { s: 1, x: 0, y: 0 }

export function Lightbox({
  source,
  items,
  index,
  onIndex,
  onClose,
  onFavourite,
  phone,
  info: startWithInfo = false,
  menu,
  onTrash,
}: {
  source: SourceId
  items: Item[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
  onFavourite: (id: string, on: boolean) => void
  phone: boolean
  /** Opened with Info: the details shown */
  info?: boolean
  /** The photo's menu, as in the grid */
  menu: (id: string) => MenuItem[]
  onTrash: (id: string) => void
}) {
  const wm = useWM()
  const item = items[index]
  const [info, setInfo] = useState<Info | null>(null)
  const [infoError, setInfoError] = useState<string | null>(null)
  const [panel, setPanel] = useState(startWithInfo || (!phone && (() => {
    try {
      return localStorage.getItem('mvlos.photos.info') === '1'
    } catch {
      return false
    }
  })()))
  const [view, setView] = useState<View>(FIT)
  const [full, setFull] = useState<string | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => root.current?.focus({ preventScroll: true }), [])
  useEffect(() => {
    try {
      if (!phone) localStorage.setItem('mvlos.photos.info', panel ? '1' : '0')
    } catch {
      /* not kept */
    }
  }, [panel, phone])

  // A new photo: fitted, its details asked for, its original loaded behind the thumbnail.
  useEffect(() => {
    setView(FIT)
    setFull(null)
    setInfo(null)
    setInfoError(null)
    if (!item) return
    let live = true
    getInfo(source, item.id).then(
      (i) => {
        if (!live) return
        setInfo(i)
        if (i.kind === 'image' && webShows(i.name)) {
          const url = originalUrl(source, item.id)
          const img = new Image()
          img.onload = () => live && setFull(url)
          img.src = url
        }
      },
      (e: Error) => live && setInfoError(e.message),
    )
    return () => {
      live = false
    }
  }, [source, item?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // The photos either side, so going on is instant.
  useEffect(() => {
    for (const i of [index + 1, index - 1]) if (items[i]) new Image().src = thumbUrl(source, items[i].id, 'large', items[i].v)
  }, [index, items, source])

  if (!item) return null
  const go = (by: number) => {
    const next = index + by
    if (next >= 0 && next < items.length) onIndex(next)
  }
  const favourite = () => {
    const on = !item.fav
    onFavourite(item.id, on)
    setFavourite(source, item.id, on).catch(() => onFavourite(item.id, !on))
  }
  const play = () => {
    if (source === 'seafile' && info?.repo && info.path) wm.openNew('player', { path: sfPath(info.repo, info.path) })
    if (source === 'immich') wm.openNew('player', { path: `immich://${item.id}/${encodeURIComponent(info?.name ?? 'video.mp4')}` })
  }
  const save = () => {
    if (source === 'seafile' && info?.repo && info.path) void download(sfPath(info.repo, info.path))
    else {
      const a = document.createElement('a')
      a.href = originalUrl(source, item.id, true)
      a.download = info?.name ?? ''
      a.click()
    }
  }
  const showInFiles = () => {
    if (!info?.repo || !info.path) return
    const path = sfPath(info.repo, info.path)
    wm.openNew('files', { path: path.split('/').slice(0, -1).join('/'), select: path })
  }

  // --- zoom and pan ---------------------------------------------------------------------------------

  const clamp = (v: View): View => {
    const s = Math.max(1, Math.min(MAX, v.s))
    if (s === 1) return FIT
    const el = stage.current
    const w = el?.clientWidth ?? 0
    const h = el?.clientHeight ?? 0
    const mx = (w * (s - 1)) / 2
    const my = (h * (s - 1)) / 2
    return { s, x: Math.max(-mx, Math.min(mx, v.x)), y: Math.max(-my, Math.min(my, v.y)) }
  }
  /** Zooms to `s` keeping the point under (cx, cy) (client coordinates) where it is. */
  const zoomTo = (s: number, cx?: number, cy?: number) =>
    setView((v) => {
      const rect = stage.current?.getBoundingClientRect()
      if (!rect) return v
      const px = (cx ?? rect.left + rect.width / 2) - rect.left - rect.width / 2
      const py = (cy ?? rect.top + rect.height / 2) - rect.top - rect.height / 2
      const next = Math.max(1, Math.min(MAX, s))
      return clamp({ s: next, x: px - ((px - v.x) * next) / v.s, y: py - ((py - v.y) * next) / v.s })
    })

  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))
      setView((v) => {
        const rect = el.getBoundingClientRect()
        const px = e.clientX - rect.left - rect.width / 2
        const py = e.clientY - rect.top - rect.height / 2
        const next = Math.max(1, Math.min(MAX, v.s * factor))
        return clamp({ s: next, x: px - ((px - v.x) * next) / v.s, y: py - ((py - v.y) * next) / v.s })
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }) // eslint-disable-line react-hooks/exhaustive-deps

  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ kind: 'pan' | 'swipe' | 'pinch'; x: number; y: number; view: View; dist: number; mid: { x: number; y: number } } | null>(null)
  const [swipe, setSwipe] = useState({ x: 0, y: 0 })
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pts = [...pointers.current.values()]
    if (pts.length === 2) {
      gesture.current = { kind: 'pinch', x: 0, y: 0, view, dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } }
      setSwipe({ x: 0, y: 0 })
    } else gesture.current = { kind: view.s > 1 ? 'pan' : 'swipe', x: e.clientX, y: e.clientY, view, dist: 0, mid: { x: 0, y: 0 } }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (!g) return
    if (g.kind === 'pinch') {
      const pts = [...pointers.current.values()]
      if (pts.length < 2) return
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      const rect = stage.current!.getBoundingClientRect()
      const px = g.mid.x - rect.left - rect.width / 2
      const py = g.mid.y - rect.top - rect.height / 2
      const next = Math.max(1, Math.min(MAX, (g.view.s * d) / g.dist))
      setView(clamp({ s: next, x: px - ((px - g.view.x) * next) / g.view.s, y: py - ((py - g.view.y) * next) / g.view.s }))
    } else if (g.kind === 'pan') setView(clamp({ s: g.view.s, x: g.view.x + e.clientX - g.x, y: g.view.y + e.clientY - g.y }))
    else setSwipe({ x: e.clientX - g.x, y: Math.max(0, e.clientY - g.y) })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    const g = gesture.current
    if (g?.kind === 'swipe' && pointers.current.size === 0) {
      const dx = e.clientX - g.x
      const dy = e.clientY - g.y
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1)
      else if (dy > 90 && e.pointerType !== 'mouse') onClose()
    }
    setSwipe({ x: 0, y: 0 })
    gesture.current = pointers.current.size ? gesture.current : null
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return
    const k = e.key
    if (k === 'ArrowRight') go(1)
    else if (k === 'ArrowLeft') go(-1)
    else if (k === 'Escape') view.s > 1 ? setView(FIT) : onClose()
    else if (k === 'i' || k === 'I') setPanel((p) => !p)
    else if (k === '.') favourite()
    else if (k === '+' || k === '=') zoomTo(view.s * 1.5)
    else if (k === '-') zoomTo(view.s / 1.5)
    else if (k === '0') setView(FIT)
    else if ((k === ' ' || k === 'Enter') && item.video) play()
    else if (k === 'Delete') onTrash(item.id)
    else if (k === 'ContextMenu' || (e.shiftKey && k === 'F10')) {
      const r = stage.current?.getBoundingClientRect()
      if (r) openContextMenu({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, preventDefault() {}, stopPropagation() {} }, menu(item.id))
    } else return
    e.preventDefault()
    e.stopPropagation()
  }

  const src = full ?? thumbUrl(source, item.id, 'large', item.v)
  const when = info ? wallOf(info) : item.wall
  const camera = info && [info.make && !info.model?.startsWith(info.make) ? info.make : null, info.model].filter(Boolean).join(' ')
  const exposure = info && [info.fnumber ? `f/${Math.round(info.fnumber * 10) / 10}` : null, info.exposure ? exposureText(info.exposure) : null, info.iso ? `ISO ${info.iso}` : null, info.focal ? `${Math.round(info.focal * 10) / 10} mm${info.focal35 ? ` (${info.focal35} mm full frame)` : ''}` : null].filter(Boolean).join(' · ')

  return (
    <div className={`ph-lightbox ${panel ? 'has-panel' : ''}`} ref={root} tabIndex={-1} onKeyDown={onKeyDown} role="dialog" aria-label={info?.name ?? 'Photo'}>
      <div className="ph-lb-bar">
        <button className="ph-lb-btn" onClick={onClose} aria-label="Back to the timeline" title="Back (Esc)">
          ‹
        </button>
        <span className="ph-lb-title">
          <strong>{new Date(when).toLocaleDateString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })}</strong>
          <span className="muted">{new Date(when).toLocaleTimeString(undefined, { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })}</span>
        </span>
        <span className="spacer" />
        <button className={`ph-lb-btn ${item.fav ? 'is-fav' : ''}`} onClick={favourite} aria-pressed={item.fav} aria-label="Favourite" title="Favourite (.)">
          <Icon d={HEART} fill={item.fav} />
        </button>
        <button className={`ph-lb-btn ${panel ? 'is-on' : ''}`} onClick={() => setPanel(!panel)} aria-pressed={panel} aria-label="Info" title="Info (I)">
          <Icon d={INFO} />
        </button>
        <button className="ph-lb-btn" onClick={save} disabled={!info} aria-label="Download" title="Download">
          <Icon d={SAVE} />
        </button>
        <button className="ph-lb-btn" onClick={() => onTrash(item.id)} aria-label="Move to trash" title="Move to trash (Del)">
          <Icon d={BIN} />
        </button>
        {source === 'seafile' ? (
          <button className="ph-lb-btn ph-lb-text" onClick={showInFiles} disabled={!info?.path}>
            {phone ? 'Files' : 'Show in Files'}
          </button>
        ) : (
          info?.web && (
            <a className="ph-lb-btn ph-lb-text" href={info.web} target="_blank" rel="noopener noreferrer">
              {phone ? 'Immich' : 'Open in Immich'}
            </a>
          )
        )}
        <button className="ph-lb-btn" onClick={(e) => openMenuAt(e.currentTarget, menu(item.id))} aria-label="More" title="More">
          ⋯
        </button>
      </div>
      <div className="ph-lb-main">
        <div className="ph-lb-stage" ref={stage} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onDoubleClick={(e) => (view.s > 1 ? setView(FIT) : zoomTo(2.5, e.clientX, e.clientY))} onContextMenu={(e) => openContextMenu(e, menu(item.id))} data-no-touch-menu>
          <img
            key={item.id}
            className="ph-lb-img"
            src={src}
            alt={info?.name ?? ''}
            draggable={false}
            style={{ transform: `translate(${view.x + swipe.x}px, ${view.y + swipe.y}px) scale(${view.s})`, opacity: swipe.y ? Math.max(0.3, 1 - swipe.y / 400) : 1, transition: gesture.current ? 'none' : undefined }}
          />
          {item.video && (
            <button className="ph-lb-play" onClick={play} disabled={!info} aria-label="Play in Player">
              ▶
              {item.duration ? <span>{duration(item.duration)}</span> : null}
            </button>
          )}
          {index > 0 && (
            <button className="ph-lb-nav is-prev" onClick={() => go(-1)} aria-label="Newer">
              ‹
            </button>
          )}
          {index < items.length - 1 && (
            <button className="ph-lb-nav is-next" onClick={() => go(1)} aria-label="Older">
              ›
            </button>
          )}
        </div>
        {panel && (
          <aside className="ph-info" aria-label="Details">
            {infoError && <p className="t-red copyable">{infoError}</p>}
            {!info && !infoError && <p className="muted">Loading…</p>}
            {info && (
              <>
                <h3 className="selectable">{info.name}</h3>
                <dl className="selectable">
                  <dt>Taken</dt>
                  <dd>
                    {fullDate(when)}
                    {info.offset && <span className="muted"> ({info.offset})</span>}
                    {info.takenFrom === 'file' && <span className="muted"> · the file's date (no EXIF date)</span>}
                  </dd>
                  {camera && (
                    <>
                      <dt>Camera</dt>
                      <dd>{camera}</dd>
                    </>
                  )}
                  {info.lens && (
                    <>
                      <dt>Lens</dt>
                      <dd>{info.lens}</dd>
                    </>
                  )}
                  {exposure && (
                    <>
                      <dt>Exposure</dt>
                      <dd>{exposure}</dd>
                    </>
                  )}
                  {(info.width || info.size) && (
                    <>
                      <dt>{info.kind === 'video' ? 'Video' : 'Picture'}</dt>
                      <dd>
                        {[info.width && info.height ? `${info.width} × ${info.height}` : null, info.width && info.height && info.kind === 'image' && info.width * info.height >= 1e5 ? `${Math.round((info.width * info.height) / 1e5) / 10} MP` : null, info.size ? formatSize(info.size) : null, info.duration ? duration(info.duration) : null].filter(Boolean).join(' · ')}
                      </dd>
                    </>
                  )}
                  {(info.lat !== null && info.lon !== null) || info.place ? (
                    <>
                      <dt>Place</dt>
                      <dd>
                        {info.place && <div>{info.place}</div>}
                        {info.lat !== null && info.lon !== null && (
                          <span className="ph-coords" title="Latitude, longitude">
                            {coordinates(info.lat, info.lon)}
                            {info.alt !== null && ` · ${Math.round(info.alt)} m`}
                          </span>
                        )}
                      </dd>
                    </>
                  ) : null}
                  {info.path && (
                    <>
                      <dt>File</dt>
                      <dd className="ph-path">
                        {info.library}
                        {info.path}
                      </dd>
                    </>
                  )}
                </dl>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}
