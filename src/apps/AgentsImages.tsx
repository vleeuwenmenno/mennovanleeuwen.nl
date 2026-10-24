import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { GeneratedImage } from '../data/agentImages'
import { imageProgressFraction, imageProgressLabel, type ImageProgress } from '../data/imageModels'
import { createPortal } from 'react-dom'
import { fileSize, pictureUrl, type AgentMessage, type Attachment, type AttachmentInfo } from '../data/agents'
import { useWM } from '../os/wm'
import { openContextMenu, type MenuItem } from '../os/ContextMenu'
import { imageFileName } from '../data/agentImageFiles'
import { saveImageToFiles, saveLabel, useSaveDestination } from './AgentsSaveImage'
import { ActionRow, MoreButton, tidy } from './AgentsActions'

// Pictures attached to Agents messages: small thumbnails in the message box and on your sent
// messages, and a full-size view over the window when one is clicked (arrow keys or a swipe to the
// next, Escape or a click outside to close, Open in Preview and Download). Thumbnails are the
// picture itself scaled down by CSS: no copies are made. A sent picture comes from the server
// (server/agents.ts keeps its bytes with the message), so it is still there when the thread is
// opened again; one in the message box is the data in memory.

/** A picture to show: where it loads from, and whether that is an address Preview can open later too. */
export type Picture = { name: string; src: string; size: number; source: string; preview: boolean }

const dataUrls = new WeakMap<Attachment, string>()
/**
 * A picture still in memory (the message box) as a data: address. Made once per file, so the same
 * string goes to the <img> on every render instead of a new copy of megabytes each keystroke.
 */
export function memoryPicture(f: Attachment): Picture | null {
  if (f.kind !== 'image' || !f.data) return null
  let src = dataUrls.get(f)
  if (!src) dataUrls.set(f, (src = `data:${f.mime || 'image/png'};base64,${f.data}`))
  return { name: f.name, src, size: f.size, source: f.source, preview: false }
}

/** A sent message's pictures, from the server: they load (and open in Preview) whenever the thread is open. */
export const sentPicture = (thread: string, m: AgentMessage) => (f: AttachmentInfo, i: number): Picture | null =>
  f.kind === 'image' ? { name: f.name, src: pictureUrl(thread, m.id, i), size: f.size, source: f.source, preview: true } : null

/**
 * A message's files: pictures as thumbnails, everything else (and a picture that cannot be shown)
 * as a chip with its name. In the message box (`onRemove`) chips show the size and an ×.
 */
export function AttachedFiles({ files, pictureOf, onRemove, sent = false, more }: { files: (Attachment | AttachmentInfo)[]; pictureOf: (f: Attachment | AttachmentInfo, i: number) => Picture | null; onRemove?: (i: number) => void; sent?: boolean; /** Chips after the files ("Reading 2…") */ more?: ReactNode }) {
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set())
  const shown = files.map((f, i) => ({ f, i, picture: broken.has(`${i}:${f.name}`) ? null : pictureOf(f, i) }))
  const pictures = shown.filter((s) => s.picture)
  const chips = shown.filter((s) => !s.picture)
  return (
    <>
      <Thumbnails pictures={pictures.map((s) => s.picture!)} onRemove={onRemove && ((j) => onRemove(pictures[j].i))} onBroken={(j) => setBroken((b) => new Set(b).add(`${pictures[j].i}:${pictures[j].f.name}`))} />
      {(chips.length > 0 || more) && (
        <ul className={`agt-files ${sent ? 'is-sent' : ''}`}>
          {chips.map(({ f, i }) => (
            <li key={`${f.name}-${i}`} title={f.source}>
              <span aria-hidden>{f.kind === 'image' ? '🖼' : '📄'}</span> {f.name}
              {!sent && <span className="muted">{fileSize(f.size)}</span>}
              {onRemove && (
                <button type="button" onClick={() => onRemove(i)} aria-label={`Remove ${f.name}`}>
                  ×
                </button>
              )}
            </li>
          ))}
          {more}
        </ul>
      )}
    </>
  )
}

/** A row of thumbnails; clicking one opens the full view at it. `onRemove` adds an × to each (the message box). */
export function Thumbnails({ pictures, onRemove, onBroken }: { pictures: Picture[]; onRemove?: (i: number) => void; /** One could not load: show it as a plain chip instead */ onBroken?: (i: number) => void }) {
  const [open, setOpen] = useState<number | null>(null)
  const anchor = useRef<HTMLUListElement>(null)
  if (!pictures.length) return null
  return (
    <>
      <ul ref={anchor} className={`agt-thumbs ${pictures.length === 1 ? 'is-one' : ''}`}>
        {pictures.map((p, i) => (
          <li key={`${p.src.slice(0, 120)}-${i}`}>
            <button type="button" className="agt-thumb" onClick={() => setOpen(i)} title={`${p.name} (${fileSize(p.size)}): click to view`} aria-label={`View ${p.name}`}>
              <img src={p.src} alt={p.name} loading="lazy" draggable={false} onError={() => onBroken?.(i)} />
              <span className="agt-thumb-name">{p.name}</span>
            </button>
            {onRemove && (
              <button type="button" className="agt-thumb-x" onClick={() => onRemove(i)} aria-label={`Remove ${p.name}`} title={`Remove ${p.name}`}>
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {open !== null && <Lightbox pictures={pictures} start={Math.min(open, pictures.length - 1)} anchor={anchor.current} onClose={() => setOpen(null)} />}
    </>
  )
}

/**
 * The full view: over the window the thumbnail is in (or the whole page outside one). It takes the
 * keys while open, so Escape and the arrows do not also reach the message box behind it.
 */
export function Lightbox({ pictures, start, anchor, onClose, actions = [] }: { pictures: Picture[]; start: number; anchor: HTMLElement | null; onClose: () => void; /** More buttons in the bar, before Download (they close the view first) */ actions?: { label: string; onSelect: () => void }[] }) {
  const wm = useWM()
  const [at, setAt] = useState(start)
  const [failed, setFailed] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const picture = pictures[Math.min(at, pictures.length - 1)]
  const many = pictures.length > 1
  const go = (by: number) => {
    setFailed(false)
    setAt((i) => (i + by + pictures.length) % pictures.length)
  }

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    box.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' && many) go(1)
      else if (e.key === 'ArrowLeft' && many) go(-1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      before?.focus?.({ preventScroll: true })
    }
  }, [many])

  const save = () => Object.assign(document.createElement('a'), { href: picture.src, download: picture.name, rel: 'noopener' }).click()
  const toPreview = () => {
    wm.openNew('preview', { src: picture.src, name: picture.name, from: 'Agents' })
    onClose()
  }
  // A swipe sideways goes to the next or previous picture; a tap outside the picture closes.
  const onPointerDown = (e: React.PointerEvent) => (swipe.current = { x: e.clientX, y: e.clientY })
  const onPointerUp = (e: React.PointerEvent) => {
    const s = swipe.current
    swipe.current = null
    if (!s) return
    const dx = e.clientX - s.x
    if (many && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - s.y)) go(dx < 0 ? 1 : -1)
    else if (Math.abs(dx) < 8 && e.target === e.currentTarget) onClose()
  }

  const host = anchor?.closest<HTMLElement>('.window') ?? null
  return createPortal(
    <div ref={box} className={`agt-lightbox ${host ? '' : 'is-page'}`} role="dialog" aria-modal="true" aria-label={picture.name} tabIndex={-1} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      <div className="agt-lightbox-bar">
        <span className="agt-lightbox-name" title={picture.source ? `${picture.name}, from ${picture.source}` : picture.name}>
          {picture.name}
          <span className="muted">
            {' '}
            · {fileSize(picture.size)}
            {many ? ` · ${at + 1} of ${pictures.length}` : ''}
          </span>
        </span>
        {picture.preview && (
          <button type="button" className="btn btn-small" onClick={toPreview} title="Open it in Preview: zoom, rotate, full screen">
            Open in Preview
          </button>
        )}
        {actions.map((a) => (
          <button key={a.label} type="button" className="btn btn-small" onClick={() => (onClose(), a.onSelect())}>
            {a.label}
          </button>
        ))}
        <button type="button" className="btn btn-small" onClick={save}>
          Download
        </button>
        <button type="button" className="agt-lightbox-x" onClick={onClose} aria-label="Close" title="Close (Esc)">
          ×
        </button>
      </div>
      <div className="agt-lightbox-stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => (swipe.current = null)}>
        {failed ? <p className="muted">This picture could not be shown.</p> : <img src={picture.src} alt={picture.name} draggable={false} onError={() => setFailed(true)} />}
        {many && (
          <>
            <button type="button" className="agt-lightbox-nav is-prev" onClick={() => go(-1)} aria-label="Previous picture (←)">
              ‹
            </button>
            <button type="button" className="agt-lightbox-nav is-next" onClick={() => go(1)} aria-label="Next picture (→)">
              ›
            </button>
          </>
        )}
      </div>
    </div>,
    host ?? document.body,
  )
}

/**
 * The waiting grid: about 220 small square blocks (never more than 400) in columns and rows that follow the
 * picture's shape. Each block gets a place in a scattered diagonal order, top left to bottom right,
 * so a job 40% done lights the first 40% of them.
 */
function blockGrid(width: number, height: number) {
  const ratio = width / height
  const cols = Math.max(6, Math.min(20, Math.round(Math.sqrt(220 * ratio))))
  const rows = Math.max(6, Math.min(20, Math.round(cols / ratio)))
  const n = cols * rows
  // A fixed scatter per block (no Math.random), so the order is the same on every render and in every window.
  const jitter = (i: number) => (((i * 2654435761) >>> 0) % 1000) / 1000
  const order = Array.from({ length: n }, (_, i) => ({ i, key: ((i % cols) / Math.max(1, cols - 1) + Math.floor(i / cols) / Math.max(1, rows - 1)) / 2 * 0.65 + jitter(i) * 0.35 })).sort((a, b) => a.key - b.key)
  const rank = new Array<number>(n)
  order.forEach((o, r) => (rank[o.i] = r))
  return { cols, rows, rank }
}

/** Same frame before and after generation: only its contents change, never its aspect ratio. */
export function GeneratedPicture({ image, width, height, pending, progress, frame, onView, onMenu }: { image?: GeneratedImage; width: number; height: number; pending: boolean; /** Where the job is, from the server; none yet means waiting */ progress?: ImageProgress; frame: RefObject<HTMLDivElement | null>; onView: () => void; onMenu?: (e: React.MouseEvent) => void }) {
  const displayedImage = useRef<HTMLImageElement>(null)
  const [animate, setAnimate] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setLoaded(!!displayedImage.current?.complete && displayedImage.current.naturalWidth > 0); setFailed(false) }, [image?.url])
  useEffect(() => {
    if (!pending || !frame.current) { setAnimate(false); return }
    const element = frame.current
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    let intersects = false
    const update = () => setAnimate(intersects && !document.hidden && !reduced.matches && (typeof element.checkVisibility !== 'function' || element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })))
    const observer = new IntersectionObserver(([entry]) => { intersects = entry.isIntersecting; update() })
    observer.observe(element)
    const attributes = new MutationObserver(update)
    // Window visibility/workspace changes must stop the animation even with an open browser tab.
    for (let parent = element.parentElement; parent; parent = parent.parentElement) attributes.observe(parent, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] })
    document.addEventListener('visibilitychange', update)
    reduced.addEventListener('change', update)
    return () => { observer.disconnect(); attributes.disconnect(); document.removeEventListener('visibilitychange', update); reduced.removeEventListener('change', update) }
  }, [pending])
  const grid = useMemo(() => blockGrid(width, height), [width, height])
  const fraction = pending ? imageProgressFraction(progress) : null
  const lit = fraction === null ? 0 : Math.round(fraction * grid.rank.length)
  return (
    <div ref={frame} className={`agt-generated-image ${pending && animate ? 'is-animating' : ''}`} style={{ aspectRatio: `${width} / ${height}` }} onContextMenu={image ? onMenu : undefined}>
      {(!image || !loaded) && !failed && <div className={`agt-image-wait ${fraction === null ? 'is-idle' : ''}`} role="status" aria-live="polite" aria-busy={progress?.phase === 'sampling'}>
        <div className="agt-block-grid" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))` }}>
          {grid.rank.map((r, i) => <span key={i} className={`agt-block ${r < lit ? 'is-lit' : ''}`} style={{ animationDelay: `${-((i % grid.cols) + Math.floor(i / grid.cols)) * 0.12}s` }} />)}
        </div>
        <span className="agt-image-status">{pending ? imageProgressLabel(progress) : 'Loading image…'}{pending && <small>Use Stop to cancel</small>}</span>
      </div>}
      {image && <button type="button" className="agt-generated-open" aria-label={`View ${image.name}`} onClick={onView}><img ref={displayedImage} src={image.url} alt="Generated image" width={width} height={height} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} style={{ opacity: loaded && !failed ? 1 : 0 }} />{failed && <span className="agt-image-status">Image could not load. Open to retry.</span>}</button>}
    </div>
  )
}

/**
 * A generated image in the thread: its size, the picture, seed and settings, then the one action
 * row every message has (AgentsActions.tsx): Save to Files, Generate another, More. More and the
 * picture's right-click menu hold View, Open in Preview, Download, and `more` (Branch off).
 */
export function ImageCard({ image, width, height, pending, progress, again, more }: { image?: GeneratedImage; width: number; height: number; pending: boolean; progress?: ImageProgress; /** Generate another, when it can be offered */ again?: { disabled: boolean; hint: string; onClick: () => void }; /** The message's own actions, after the image's */ more: MenuItem[] }) {
  const frame = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const wm = useWM()
  // Save to Files only where it can work: no Seafile and no browser store, no entry (not a dead one).
  const to = useSaveDestination()
  const save = image && to ? { label: saveLabel(to), onSelect: () => void saveImageToFiles(image) } : null
  const own: MenuItem[] = image ? [
    { label: 'View full size', onSelect: () => setOpen(true) },
    { label: 'Open in Preview', hint: 'Zoom, rotate, full screen', onSelect: () => wm.openNew('preview', { src: image.url, name: imageFileName(image), from: 'Agents' }) },
    { label: 'Download', onSelect: () => Object.assign(document.createElement('a'), { href: image.url, download: imageFileName(image), rel: 'noopener' }).click() },
  ] : []
  const picture = image ? { name: imageFileName(image), src: image.url, size: image.size, source: 'Generated with ComfyUI', preview: true } : null
  return <>
    <p className="muted">{image ? 'Generated image' : 'Generating image'} · {width} × {height}</p>
    <GeneratedPicture image={image} width={width} height={height} pending={pending} progress={progress} frame={frame} onView={() => setOpen(true)} onMenu={(e) => openContextMenu(e, tidy([...own, ...(save ? [save] : []), { separator: true }, ...more]))} />
    {image && <p className="muted">Seed {image.seed}</p>}
    {image?.settings && <details className="agt-image-settings">
      <summary>Generation settings</summary>
      <pre className="copyable">{JSON.stringify(image.settings, null, 2)}</pre>
      <a href={`${image.url}/metadata`} download={`${image.id}.json`}>Download settings</a>
    </details>}
    {image && <ActionRow label="Image actions">
      {save && <button key="save" type="button" className="btn btn-small" aria-label={save.label} title={save.label} onClick={save.onSelect}>Save to Files…</button>}
      {again && <button key="again" type="button" className="btn btn-small" disabled={again.disabled} title={again.hint} onClick={again.onClick}>Generate another</button>}
      <MoreButton key="more" label="Image" items={tidy([...own, { separator: true }, ...more])} />
    </ActionRow>}
    {open && picture && <Lightbox pictures={[picture]} start={0} anchor={frame.current} onClose={() => setOpen(false)} actions={save ? [save] : []} />}
  </>
}
