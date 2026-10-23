import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { GeneratedImage } from '../data/agentImages'
import { createPortal } from 'react-dom'
import { fileSize, pictureUrl, type AgentMessage, type Attachment, type AttachmentInfo } from '../data/agents'
import { useWM } from '../os/wm'

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
function Lightbox({ pictures, start, anchor, onClose }: { pictures: Picture[]; start: number; anchor: HTMLElement | null; onClose: () => void }) {
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

/** Same frame before and after generation: only its contents change, never its aspect ratio. */
export function GeneratedPicture({ image, width, height, pending }: { image?: GeneratedImage; width: number; height: number; pending: boolean }) {
  const frame = useRef<HTMLDivElement>(null)
  const displayedImage = useRef<HTMLImageElement>(null)
  const [animate, setAnimate] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
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
  const picture = image ? { name: image.name, src: image.url, size: image.size, source: 'Generated with ComfyUI', preview: true } : null
  return <>
    <div ref={frame} className={`agt-generated-image ${pending && animate ? 'is-animating' : ''}`} style={{ aspectRatio: `${width} / ${height}` }}>
      {(!image || !loaded) && !failed && <div className="agt-image-wait" role="status" aria-live="polite">
        <div className="agt-cube-matrix" aria-hidden="true">{Array.from({ length: 49 }, (_, i) => <span className="agt-image-cube" key={i} style={{ animationDelay: `${-(Math.floor(i / 7) + i % 7) * .19}s` }}><i /><i /><i /></span>)}</div>
        <span className="agt-image-status">{pending ? 'Generating image…' : 'Loading image…'}{pending && <small>Use Stop to cancel</small>}</span>
      </div>}
      {image && <button type="button" className="agt-generated-open" aria-label={`View ${image.name}`} onClick={() => setOpen(true)}><img ref={displayedImage} src={image.url} alt="Generated image" width={width} height={height} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} style={{ opacity: loaded && !failed ? 1 : 0 }} />{failed && <span className="agt-image-status">Image could not load. Open to retry.</span>}</button>}
    </div>
    {open && picture && <Lightbox pictures={[picture]} start={0} anchor={frame.current} onClose={() => setOpen(false)} />}
  </>
}
