import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { download, fileLink, isSf, libraryName, parseSf } from '../data/seafile'
import { folderOf, nameOf, thumbOf, useMedia, useSiblings } from '../data/media'
import { useWM, type WinState } from '../os/wm'
import { useBackButton } from '../os/backButton'
import { formatSize, prettyPath } from '../terminal/vfs'

// Preview, for pictures, after macOS's: the picture fitted to the window, zoom (buttons, keys,
// Ctrl+wheel or a pinch, towards the pointer), pan by dragging or scrolling when zoomed in, rotate,
// the other pictures in the folder in a sidebar and with the arrow keys, an inspector, a slideshow
// and full screen. Nothing on the page scrolls: the wheel only ever zooms or pans the picture.

const MIN = 0.05
const MAX = 16
const PAD = 24 // px around a fitted picture
const STEP = 1.25

type View = { mode: 'auto' | 'fit' | 'free'; scale: number; x: number; y: number }
const AUTO: View = { mode: 'auto', scale: 1, x: 0, y: 0 }

const PREFS = 'mvlos.preview'
function loadPrefs(): { sidebar: boolean } {
  try {
    return { sidebar: false, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') }
  } catch {
    return { sidebar: false }
  }
}

export const previewTitle = (w: WinState) => (w.props.path ? nameOf(w.props.path) : 'Preview')

export function Preview({ win }: { win: WinState }) {
  const wm = useWM()
  const [path, setPathState] = useState(win.props.path ?? '')
  useEffect(() => {
    if (win.props.path) setPathState(win.props.path)
  }, [win.props.path, win.props.t])
  // Going to another picture: the window's title (and the saved layout) follow.
  const setPath = (p: string) => {
    setPathState(p)
    wm.setProps(win.pid, { path: p })
  }

  const media = useMedia(path)
  const siblings = useSiblings(path, ['image'])
  const index = siblings.indexOf(path)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [view, setView] = useState<View>(AUTO)
  const [rotation, setRotation] = useState(0)
  const [sidebar, setSidebarState] = useState(() => loadPrefs().sidebar)
  const [inspector, setInspector] = useState(false)
  const [slideshow, setSlideshow] = useState(false)
  const [full, setFull] = useState(false)
  const [failed, setFailed] = useState(false)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const root = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)

  const setSidebar = (on: boolean) => {
    setSidebarState(on)
    try {
      localStorage.setItem(PREFS, JSON.stringify({ sidebar: on }))
    } catch {
      /* not kept */
    }
  }

  // A new picture starts fitted, upright.
  useEffect(() => {
    setNatural(null)
    setView(AUTO)
    setRotation(0)
    setFailed(false)
  }, [path])

  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // --- geometry ------------------------------------------------------------------------------

  const turned = rotation % 180 !== 0
  const rw = natural ? (turned ? natural.h : natural.w) : 1
  const rh = natural ? (turned ? natural.w : natural.h) : 1
  const fitScale = natural && box.w ? Math.max(MIN, Math.min((box.w - PAD * 2) / rw, (box.h - PAD * 2) / rh)) : 1
  // Opened, a picture is shown at its own size if it fits and fitted if not; vector pictures always fill.
  const vector = /\.svg$/i.test(media.name)
  const scale = view.mode === 'free' ? view.scale : view.mode === 'fit' || vector ? fitScale : Math.min(fitScale, 1)
  const pannable = rw * scale > box.w + 1 || rh * scale > box.h + 1

  const clamp = useCallback(
    (x: number, y: number, s: number) => {
      const mx = Math.max(0, (rw * s - box.w) / 2 + PAD)
      const my = Math.max(0, (rh * s - box.h) / 2 + PAD)
      return { x: Math.max(-mx, Math.min(mx, x)), y: Math.max(-my, Math.min(my, y)) }
    },
    [rw, rh, box.w, box.h],
  )

  /** Zooms to `next`, keeping the point under (cx, cy) (from the stage's middle) where it is. */
  const zoomTo = useCallback(
    (next: number, cx = 0, cy = 0) => {
      setView((v) => {
        const s0 = v.mode === 'free' ? v.scale : scale
        const s1 = Math.max(MIN, Math.min(MAX, next))
        const x0 = v.mode === 'free' ? v.x : 0
        const y0 = v.mode === 'free' ? v.y : 0
        const k = s1 / s0
        return { mode: 'free', scale: s1, ...clamp(cx - (cx - x0) * k, cy - (cy - y0) * k, s1) }
      })
    },
    [scale, clamp],
  )
  const panBy = useCallback((dx: number, dy: number) => setView((v) => ({ mode: 'free', scale: v.mode === 'free' ? v.scale : scale, ...clamp((v.mode === 'free' ? v.x : 0) + dx, (v.mode === 'free' ? v.y : 0) + dy, v.mode === 'free' ? v.scale : scale) })), [scale, clamp])
  const fit = () => setView({ mode: 'fit', scale: 1, x: 0, y: 0 })
  const actual = () => zoomTo(1)
  const rotate = (by: number) => {
    setRotation((r) => (r + by + 360) % 360)
    setView(AUTO)
  }

  // The wheel never scrolls anything: Ctrl+wheel and trackpad pinches zoom, plain scrolling pans.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const cx = e.clientX - r.left - r.width / 2
      const cy = e.clientY - r.top - r.height / 2
      if (e.ctrlKey || e.metaKey) zoomTo(scale * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), cx, cy)
      else if (pannable) panBy(-e.deltaX, -e.deltaY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomTo, panBy, scale, pannable])

  // Dragging pans; two fingers pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ d: number; s: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), s: scale }
    }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const last = pointers.current.get(e.pointerId)
    if (!last) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()]
      const r = stage.current!.getBoundingClientRect()
      zoomTo((pinch.current.s * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.current.d, (a.x + b.x) / 2 - r.left - r.width / 2, (a.y + b.y) / 2 - r.top - r.height / 2)
    } else if (pannable) panBy(e.clientX - last.x, e.clientY - last.y)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
  }
  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    const r = stage.current!.getBoundingClientRect()
    if (view.mode === 'free' && view.scale > fitScale) setView(AUTO)
    else zoomTo(Math.max(1, scale * 2), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2)
  }

  // --- going through the folder --------------------------------------------------------------

  const go = useCallback(
    (by: number) => {
      if (siblings.length < 2) return
      const i = index < 0 ? 0 : index
      setPath(siblings[(i + by + siblings.length) % siblings.length])
    },
    [siblings, index],
  )

  useBackButton(win.pid, { back: () => go(-1), forward: () => go(1) })

  // The pictures either side load ahead, so the arrow keys feel instant.
  useEffect(() => {
    if (siblings.length < 2 || index < 0) return
    for (const p of [siblings[(index + 1) % siblings.length], siblings[(index - 1 + siblings.length) % siblings.length]]) {
      if (isSf(p)) fileLink(p, 'download').then((u) => void (new Image().src = u)).catch(() => {})
    }
  }, [siblings, index])

  useEffect(() => {
    if (!slideshow) return
    const t = setInterval(() => go(1), 3500)
    return () => clearInterval(t)
  }, [slideshow, go])

  // --- full screen ---------------------------------------------------------------------------

  useEffect(() => {
    const on = () => {
      const isFull = document.fullscreenElement === root.current
      setFull(isFull)
      if (!isFull) setSlideshow(false)
    }
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])
  const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : root.current?.requestFullscreen())?.catch(() => {})
  const toggleSlideshow = () => {
    if (slideshow) {
      setSlideshow(false)
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    } else {
      setSlideshow(true)
      if (!document.fullscreenElement) root.current?.requestFullscreen().catch(() => {})
    }
  }

  // Focusing the window lets the keys work straight away.
  useEffect(() => {
    if (wm.focusedPid === win.pid && !root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true })
  }, [wm.focusedPid, win.pid])

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    const k = e.key
    if (k === 'ArrowRight' || k === 'PageDown') go(1)
    else if (k === 'ArrowLeft' || k === 'PageUp') go(-1)
    else if (k === '+' || k === '=') zoomTo(scale * STEP)
    else if (k === '-' || k === '_') zoomTo(scale / STEP)
    else if (k === '0') actual()
    else if (k === '9') fit()
    else if (k.toLowerCase() === 'r' && !mod) rotate(e.shiftKey ? -90 : 90)
    else if (k.toLowerCase() === 'l' && !mod) rotate(-90)
    else if (k.toLowerCase() === 'i' && !mod) setInspector((v) => !v)
    else if (k.toLowerCase() === 's' && !mod) setSidebar(!sidebar)
    else if (k.toLowerCase() === 'f' && !mod) toggleFull()
    else if (k === ' ') toggleSlideshow()
    else if (k === 'Escape' && slideshow) toggleSlideshow()
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  // --- rendering -----------------------------------------------------------------------------

  const at = parseSf(path)
  const where = at ? `${libraryName(at.repo)}${at.p.split('/').slice(0, -1).join('/') || '/'}` : prettyPath(folderOf(path))
  const showInFiles = () => wm.openNew('files', { path: folderOf(path), select: path })
  const save = () => (isSf(path) ? download(path).catch(() => {}) : media.url && Object.assign(document.createElement('a'), { href: media.url, download: media.name }).click())
  const zoomLabel = `${Math.round(scale * 100)}%`

  return (
    <div ref={root} className={`pv ${full ? 'is-full' : ''} ${slideshow ? 'is-slideshow' : ''}`} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="pv-bar">
        <Tool label="Sidebar (S)" on={sidebar} onClick={() => setSidebar(!sidebar)}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </Tool>
        <span className="pv-title muted">{siblings.length > 1 && index >= 0 ? `${index + 1} of ${siblings.length}` : ''}</span>
        <span className="spacer" />
        <div className="pv-group" role="group" aria-label="Zoom">
          <Tool label="Zoom out (−)" onClick={() => zoomTo(scale / STEP)}>
            <circle cx="11" cy="11" r="6.5" />
            <path d="M8 11h6M16 16l4 4" />
          </Tool>
          <button className="pv-zoom" onClick={actual} title="Actual size (0)">
            {zoomLabel}
          </button>
          <Tool label="Zoom in (+)" onClick={() => zoomTo(scale * STEP)}>
            <circle cx="11" cy="11" r="6.5" />
            <path d="M8 11h6M11 8v6M16 16l4 4" />
          </Tool>
        </div>
        <Tool label="Zoom to fit (9)" on={view.mode === 'fit'} onClick={fit}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M8 12h8M10 10l-2 2 2 2M14 10l2 2-2 2" />
        </Tool>
        <div className="pv-group" role="group" aria-label="Rotate">
          <Tool label="Rotate left (L)" onClick={() => rotate(-90)}>
            <path d="M4 9a8 8 0 1 1 1.5 7" />
            <path d="M4 4v5h5" />
          </Tool>
          <Tool label="Rotate right (R)" onClick={() => rotate(90)}>
            <path d="M20 9a8 8 0 1 0-1.5 7" />
            <path d="M20 4v5h-5" />
          </Tool>
        </div>
        <Tool label="Slideshow (Space)" on={slideshow} disabled={siblings.length < 2} onClick={toggleSlideshow}>
          <path d="M8 5l11 7-11 7z" />
        </Tool>
        <Tool label="Inspector (I)" on={inspector} onClick={() => setInspector((v) => !v)}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6M12 7.5v.5" />
        </Tool>
        <Tool label={full ? 'Exit full screen (F)' : 'Full screen (F)'} onClick={toggleFull}>
          {full ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
        </Tool>
      </div>

      <div className="pv-body">
        {sidebar && <Thumbs paths={siblings} current={path} onPick={setPath} />}
        <div
          ref={stage}
          className={`pv-stage ${pannable ? 'can-pan' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
        >
          {media.error || failed ? (
            <div className="pv-empty">
              <p className="pv-big">{media.name || 'Preview'}</p>
              <p className="muted">{failed ? 'This picture could not be shown here (a format the browser does not know?).' : media.error}</p>
              {failed && isSf(path) && (
                <button className="btn btn-small" onClick={save}>
                  Download
                </button>
              )}
            </div>
          ) : media.url ? (
            <img
              key={media.url}
              className="pv-img"
              src={media.url}
              alt={media.name}
              draggable={false}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 300, h: e.currentTarget.naturalHeight || 150 })}
              onError={() => setFailed(true)}
              style={
                natural
                  ? {
                      width: natural.w,
                      height: natural.h,
                      marginLeft: -natural.w / 2,
                      marginTop: -natural.h / 2,
                      transform: `translate(${view.mode === 'free' ? view.x : 0}px, ${view.mode === 'free' ? view.y : 0}px) rotate(${rotation}deg) scale(${scale})`,
                      imageRendering: scale >= 4 ? 'pixelated' : undefined,
                    }
                  : { visibility: 'hidden' }
              }
            />
          ) : null}
          {!natural && !media.error && !failed && <div className="pv-loading">Loading…</div>}
          {siblings.length > 1 && (
            <>
              <button className="pv-nav is-prev" onClick={() => go(-1)} aria-label="Previous picture (←)">
                ‹
              </button>
              <button className="pv-nav is-next" onClick={() => go(1)} aria-label="Next picture (→)">
                ›
              </button>
            </>
          )}
        </div>
        {inspector && (
          <aside className="pv-inspector">
            <h4>Info</h4>
            <dl>
              <dt>Name</dt>
              <dd>{media.name}</dd>
              <dt>Kind</dt>
              <dd>{(media.name.split('.').pop() ?? '').toUpperCase()} image</dd>
              {natural && (
                <>
                  <dt>Dimensions</dt>
                  <dd>
                    {natural.w} × {natural.h}
                  </dd>
                </>
              )}
              {media.size !== null && (
                <>
                  <dt>Size</dt>
                  <dd>{formatSize(media.size)}</dd>
                </>
              )}
              {media.mtime && (
                <>
                  <dt>Modified</dt>
                  <dd>{new Date(media.mtime).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</dd>
                </>
              )}
              <dt>Where</dt>
              <dd>{where}</dd>
              <dt>Zoom</dt>
              <dd>
                {zoomLabel}
                {rotation ? `, turned ${rotation}°` : ''}
              </dd>
            </dl>
            <div className="pv-actions">
              <button className="btn btn-small" onClick={showInFiles}>
                Show in Files
              </button>
              <button className="btn btn-small" onClick={save}>
                Download
              </button>
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}

/** The other pictures in the folder, down the side. */
function Thumbs({ paths, current, onPick }: { paths: string[]; current: string; onPick: (p: string) => void }) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' })
  }, [current])
  return (
    <div className="pv-thumbs" ref={list}>
      {paths.map((p) => (
        <button key={p} className={`pv-thumb ${p === current ? 'is-current' : ''}`} onClick={() => onPick(p)} title={nameOf(p)}>
          <ThumbImage path={p} />
          <span>{nameOf(p)}</span>
        </button>
      ))}
      {!paths.length && <p className="muted">No other pictures here.</p>}
    </div>
  )
}

function ThumbImage({ path }: { path: string }) {
  const [broken, setBroken] = useState(false)
  const src = useMemo(() => thumbOf(path, 192), [path])
  if (!src || broken) return <span className="pv-thumb-none">{(nameOf(path).split('.').pop() ?? '').toUpperCase()}</span>
  return <img src={src} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} />
}

function Tool({ label, onClick, on, disabled, children }: { label: string; onClick: () => void; on?: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button className={`pv-tool ${on ? 'is-on' : ''}`} onClick={onClick} title={label} aria-label={label} aria-pressed={on} disabled={disabled}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  )
}
