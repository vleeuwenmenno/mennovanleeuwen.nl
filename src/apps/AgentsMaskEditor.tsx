import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import './AgentsMaskEditor.css'

export type AgentsMaskResult = { mask: Blob; width: number; height: number }
export type AgentsMaskEditorProps = {
  /** Authenticated, same-origin HTTP(S) image URL. Dimensions must include EXIF orientation. */
  sourceUrl: string
  sourceName: string
  width: number
  height: number
  /** A saved mask to start from (same-origin PNG, the source's size): white is selected. */
  initialMaskUrl?: string
  /** What Apply says, e.g. "Save mask" when it only saves. */
  applyLabel?: string
  onApply: (result: AgentsMaskResult) => void | Promise<void>
  onCancel: () => void
}
type Point = { x: number; y: number }
type Stroke = { kind: 'stroke'; erase: boolean; size: number; points: Point[] }
/** Whole-mask steps: invert, and grow (positive px) or shrink (negative px), in source pixels. */
type Step = Stroke | { kind: 'invert' } | { kind: 'grow'; px: number }
const MAX_POINTS = 32_768
const MAX_STROKES = 512
const MAX_BYTES = 8 * 1024 * 1024
const GROW_STEP = 4

export function maskDimensionsValid(width: number, height: number) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_777_216
}

function sameOrigin(raw: string | undefined) {
  if (!raw) return ''
  try {
    const parsed = new URL(raw, location.href)
    return parsed.origin === location.origin && /^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : ''
  } catch { return '' }
}

function draw(ctx: CanvasRenderingContext2D, stroke: Stroke, color: string) {
  ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over'
  ctx.strokeStyle = ctx.fillStyle = color
  ctx.lineWidth = stroke.size
  ctx.lineCap = ctx.lineJoin = 'round'
  const first = stroke.points[0]
  ctx.beginPath()
  ctx.arc(first.x, first.y, stroke.size / 2, 0, Math.PI * 2)
  ctx.fill()
  if (stroke.points.length > 1) {
    ctx.beginPath()
    ctx.moveTo(first.x, first.y)
    for (const p of stroke.points.slice(1)) ctx.lineTo(p.x, p.y)
    ctx.stroke()
  }
}

/** The selection lives in the alpha channel of `ctx`'s canvas, in one colour. */
function invert(ctx: CanvasRenderingContext2D, color: string) {
  const c = ctx.canvas, copy = document.createElement('canvas')
  copy.width = c.width; copy.height = c.height
  copy.getContext('2d')!.drawImage(c, 0, 0)
  ctx.save(); ctx.resetTransform()
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, c.width, c.height)
  ctx.fillStyle = color; ctx.fillRect(0, 0, c.width, c.height)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.drawImage(copy, 0, 0)
  ctx.restore()
  copy.width = copy.height = 1
}
/** Dilate by stamping the selection around a ring; shrinking dilates the inverse. */
function grow(ctx: CanvasRenderingContext2D, px: number, color: string) {
  if (!px) return
  if (px < 0) { invert(ctx, color); grow(ctx, -px, color); invert(ctx, color); return }
  const c = ctx.canvas, copy = document.createElement('canvas')
  copy.width = c.width; copy.height = c.height
  copy.getContext('2d')!.drawImage(c, 0, 0)
  ctx.save(); ctx.resetTransform(); ctx.globalCompositeOperation = 'source-over'
  for (const r of [px / 2, px]) for (let i = 0; i < 16; i++) ctx.drawImage(copy, Math.cos(i * Math.PI / 8) * r, Math.sin(i * Math.PI / 8) * r)
  ctx.restore()
  copy.width = copy.height = 1
}

/** Owns its modal and focus; no window manager or shell provider is required. */
export function AgentsMaskEditor(props: AgentsMaskEditorProps) {
  return <Editor key={`${props.sourceUrl}:${props.width}:${props.height}:${props.initialMaskUrl ?? ''}`} {...props} />
}

function Editor({ sourceUrl, sourceName, width, height, initialMaskUrl, applyLabel = 'Apply mask', onApply, onCancel }: AgentsMaskEditorProps) {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const cursor = useRef<HTMLSpanElement>(null)
  const history = useRef<Step[]>([])
  const redoable = useRef<Step[]>([])
  /** The starting mask, white as opaque alpha at full size; dropped by Reset. */
  const base = useRef<HTMLCanvasElement | null>(null)
  const active = useRef<{ id: number; stroke: Stroke } | null>(null)
  const pointCount = useRef(0)
  const ended = useRef(false)
  const exporting = useRef(false)
  const [count, setCount] = useState(0)
  const [redoCount, setRedoCount] = useState(0)
  const [hasBase, setHasBase] = useState(false)
  const [sourceReady, setSourceReady] = useState(false)
  const [baseReady, setBaseReady] = useState(!initialMaskUrl)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [erase, setErase] = useState(false)
  const [overlay, setOverlay] = useState(true)
  const [size, setSize] = useState(Math.max(1, Math.round(Math.min(width, height) / 12)))
  const position = useRef<Point>({ x: width / 2, y: height / 2 })
  const valid = maskDimensionsValid(width, height)
  const url = sameOrigin(sourceUrl)
  const maskUrl = sameOrigin(initialMaskUrl)
  const problem = !valid ? 'Image must be at most 8192 pixels per side and 16 megapixels.' : !url ? 'The source must be a same-origin image URL.' : initialMaskUrl && !maskUrl ? 'The starting mask must be a same-origin image URL.' : ''
  const ready = sourceReady && baseReady
  const scale = valid ? Math.min(1, 1600 / Math.max(width, height)) : 1
  const pw = valid ? Math.max(1, Math.round(width * scale)) : 1
  const ph = valid ? Math.max(1, Math.round(height * scale)) : 1
  const strokes = () => history.current.filter((s) => s.kind === 'stroke').length

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    ended.current = false
    const modal = dialog.current
    modal?.showModal()
    modal?.querySelector<HTMLButtonElement>('[data-mask-cancel]')?.focus()
    return () => {
      ended.current = true
      modal?.close()
      before?.focus({ preventScroll: true })
    }
  }, [])

  // The starting mask: decoded once to alpha (white selected), in strips so big masks stay cheap.
  useEffect(() => {
    if (!maskUrl || problem) return
    let current = true
    const image = new Image()
    image.onload = () => {
      if (!current) return
      if (image.naturalWidth !== width || image.naturalHeight !== height) { setError('The saved mask does not match this picture’s size.'); return }
      const layer = document.createElement('canvas')
      layer.width = width; layer.height = height
      const ctx = layer.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(image, 0, 0)
      for (let y = 0; y < height; y += 64) {
        const strip = ctx.getImageData(0, y, width, Math.min(64, height - y))
        for (let i = 0; i < strip.data.length; i += 4) { strip.data[i + 3] = strip.data[i] >= 128 ? 255 : 0; strip.data[i] = strip.data[i + 1] = strip.data[i + 2] = 255 }
        ctx.putImageData(strip, 0, y)
      }
      base.current = layer
      setHasBase(true)
      setBaseReady(true)
    }
    image.onerror = () => { if (current) setError('Could not load the saved mask. Reopen the editor to retry.') }
    image.src = maskUrl
    return () => { current = false; image.onload = null; image.onerror = null }
  }, [maskUrl, width, height, problem])
  useEffect(() => { if (ready) redraw() }, [ready, hasBase])

  function cancel() {
    ended.current = true
    onCancel()
  }
  /** Replays the starting mask and every step onto `ctx` at `factor` × source size, in `color`. */
  function render(ctx: CanvasRenderingContext2D, factor: number, color: string, steps: Step[]) {
    const c = ctx.canvas
    ctx.resetTransform()
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, c.width, c.height)
    if (base.current) {
      ctx.drawImage(base.current, 0, 0, c.width, c.height)
      ctx.globalCompositeOperation = 'source-in'
      ctx.fillStyle = color
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.globalCompositeOperation = 'source-over'
    }
    for (const step of steps) {
      if (step.kind === 'stroke') { ctx.setTransform(factor, 0, 0, factor, 0, 0); draw(ctx, step, color); ctx.resetTransform() }
      else if (step.kind === 'invert') invert(ctx, color)
      else grow(ctx, step.px * factor, color)
    }
    ctx.globalCompositeOperation = 'source-over'
  }
  function redraw() {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx) return
    const color = getComputedStyle(canvas.current!).color
    render(ctx, pw / width, color, active.current ? [...history.current, active.current.stroke] : history.current)
  }
  function showCursor(p: Point) {
    position.current = p
    if (cursor.current) {
      Object.assign(cursor.current.style, { left: `${100 * p.x / width}%`, top: `${100 * p.y / height}%`, width: `${100 * size / width}%`, height: `${100 * size / height}%` })
    }
  }
  useEffect(() => { showCursor(position.current) }, [size])
  function changed() {
    setCount(history.current.length)
    setRedoCount(redoable.current.length)
    setError('')
  }
  function push(step: Step) {
    history.current.push(step)
    redoable.current = []
    changed()
  }
  function undo() {
    if (active.current || exporting.current) return
    const last = history.current.pop()
    if (!last) return
    if (last.kind === 'stroke') pointCount.current -= last.points.length
    redoable.current.push(last)
    changed()
    redraw()
  }
  function redo() {
    if (active.current || exporting.current) return
    const next = redoable.current.pop()
    if (!next) return
    if (next.kind === 'stroke') pointCount.current += next.points.length
    history.current.push(next)
    changed()
    redraw()
  }
  function wholeMask(step: Exclude<Step, Stroke>) {
    if (!ready || exporting.current || active.current) return
    if (history.current.length >= MAX_STROKES) { setError('Mask history is full. Undo a step or reset before changing more.'); return }
    push(step)
    redraw()
  }
  function start(p: Point, pointerId: number) {
    if (!ready || exporting.current || active.current || !overlay) return false
    if (strokes() >= MAX_STROKES || history.current.length >= MAX_STROKES || pointCount.current >= MAX_POINTS) {
      setError('Mask history is full. Undo a stroke or reset before drawing more.')
      return false
    }
    setError('')
    active.current = { id: pointerId, stroke: { kind: 'stroke', erase, size, points: [p] } }
    pointCount.current++
    // Erasing has to see what lies under it, so a stroke on a starting mask or after a whole-mask step redraws.
    if (erase || base.current || history.current.some((s) => s.kind !== 'stroke')) redraw()
    else {
      const ctx = canvas.current!.getContext('2d')!
      ctx.setTransform(pw / width, 0, 0, ph / height, 0, 0)
      draw(ctx, active.current.stroke, getComputedStyle(canvas.current!).color)
    }
    return true
  }
  function finish(discard = false) {
    const a = active.current
    if (!a) return
    active.current = null
    if (discard) { pointCount.current -= a.stroke.points.length; redraw() }
    else push(a.stroke)
  }
  function point(e: ReactPointerEvent<HTMLCanvasElement>): Point {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(width, (e.clientX - r.left) * width / r.width)), y: Math.max(0, Math.min(height, (e.clientY - r.top) * height / r.height)) }
  }
  function move(e: ReactPointerEvent<HTMLCanvasElement>) {
    const p = point(e)
    showCursor(p)
    const a = active.current
    if (!a || a.id !== e.pointerId) return
    if (pointCount.current >= MAX_POINTS) {
      finish()
      setError('Mask history is full. Undo a stroke or reset before drawing more.')
      return
    }
    const last = a.stroke.points.at(-1)!
    if (Math.hypot(last.x - p.x, last.y - p.y) < 0.5) return
    a.stroke.points.push(p)
    pointCount.current++
    const ctx = canvas.current!.getContext('2d')!
    ctx.setTransform(pw / width, 0, 0, ph / height, 0, 0)
    draw(ctx, { ...a.stroke, points: [last, p] }, getComputedStyle(canvas.current!).color)
  }
  async function apply() {
    if (!ready || exporting.current || active.current || ended.current) return
    exporting.current = true
    setBusy(true)
    setError('')
    const output = document.createElement('canvas')
    try {
      output.width = width
      output.height = height
      const ctx = output.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('Mask export is unavailable in this browser.')
      // The selection is replayed as white alpha at full size, then flattened onto opaque black.
      render(ctx, 1, '#ffffff', history.current)
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, width, height)
      ctx.globalCompositeOperation = 'source-over'
      // Binary, opaque RGB semantics; bounded scan buffers, not full-image undo snapshots.
      let nonempty = false
      for (let y = 0; y < height; y += 64) {
        const strip = ctx.getImageData(0, y, width, Math.min(64, height - y))
        for (let i = 0; i < strip.data.length; i += 4) {
          const value = strip.data[i] >= 128 ? 255 : 0
          nonempty ||= value === 255
          strip.data[i] = strip.data[i + 1] = strip.data[i + 2] = value
          strip.data[i + 3] = 255
        }
        ctx.putImageData(strip, 0, y)
      }
      if (!nonempty) throw new Error('The mask is empty. Brush over an area to edit before applying.')
      const mask = await new Promise<Blob>((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode the PNG mask.')), 'image/png'))
      if (mask.size > MAX_BYTES) throw new Error('The PNG mask exceeds 8 MiB. Simplify the mask and try again.')
      if (!ended.current) await onApply({ mask, width, height })
    } catch (cause) {
      if (!ended.current) setError(cause instanceof Error ? cause.message : 'Could not export the mask.')
    } finally {
      output.width = output.height = 1
      exporting.current = false
      if (!ended.current) setBusy(false)
    }
  }
  const empty = !count && !hasBase
  const growLabel = `${GROW_STEP} px`

  return createPortal(<dialog ref={dialog} className="agt-mask" aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`} onCancel={e => { e.preventDefault(); cancel() }} onKeyDown={e => {
    e.stopPropagation()
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo() }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo() }
  }}>
    <header><h2 id={`${id}-title`}>Edit mask: {sourceName}</h2><span>{width} × {height}</span></header>
    <div className="agt-mask-tools" role="group" aria-label="Mask tools">
      <button type="button" aria-pressed={!erase} onClick={() => setErase(false)}>Brush</button>
      <button type="button" aria-pressed={erase} onClick={() => setErase(true)}>Erase</button>
      <label>Brush size <input aria-label="Brush size in image pixels" type="range" min="1" max={valid ? Math.max(width, height) : 1} value={size} onChange={e => setSize(Number(e.target.value))} /><output>{size} px</output></label>
      <button type="button" disabled={!count || busy} onClick={undo}>Undo</button>
      <button type="button" disabled={!redoCount || busy} onClick={redo}>Redo</button>
      <button type="button" disabled={!ready || busy} onClick={() => wholeMask({ kind: 'invert' })} title="Selected becomes kept and the other way round">Invert</button>
      <button type="button" disabled={!ready || busy || empty} onClick={() => wholeMask({ kind: 'grow', px: GROW_STEP })} title={`Grow the selection by ${growLabel}`} aria-label={`Grow by ${growLabel}`}>Grow</button>
      <button type="button" disabled={!ready || busy || empty} onClick={() => wholeMask({ kind: 'grow', px: -GROW_STEP })} title={`Shrink the selection by ${growLabel}`} aria-label={`Shrink by ${growLabel}`}>Shrink</button>
      <button type="button" aria-pressed={!overlay} disabled={!ready} onClick={() => setOverlay((v) => !v)} title="Hide the mask to see the picture underneath">{overlay ? 'Hide mask' : 'Show mask'}</button>
      <button type="button" disabled={empty || busy} onClick={() => { if (active.current) return; history.current = []; redoable.current = []; base.current = null; setHasBase(false); pointCount.current = 0; changed(); redraw() }}>Reset</button>
    </div>
    <p id={`${id}-help`}>Colored areas will change. The image always fits. Brush or erase with a pointer; on the canvas, arrow keys move the cursor (Shift: larger steps), Space paints a dot. Ctrl/⌘+Z undoes, Ctrl/⌘+Shift+Z redoes. Grow and Shrink move the edge by {growLabel}.</p>
    <div className="agt-mask-stage">
      {!problem && <div className="agt-mask-image" style={{ aspectRatio: `${width} / ${height}`, width: `min(100%, ${58 * width / height}dvh)` }}>
        <img src={url} alt={sourceName} draggable={false} onLoad={e => {
          if (e.currentTarget.naturalWidth !== width || e.currentTarget.naturalHeight !== height) { setSourceReady(false); setError('Source dimensions do not match the oriented image. Reopen with the correct dimensions.') }
          else setSourceReady(true)
        }} onError={() => { setSourceReady(false); setError('Could not load the source image. Check access and reopen the editor.') }} />
        <canvas ref={canvas} width={pw} height={ph} data-hidden={!overlay || undefined} tabIndex={ready && !busy ? 0 : -1} role="application" aria-label="Mask drawing canvas" aria-describedby={`${id}-help`} aria-disabled={!ready || busy}
          onFocus={() => showCursor(position.current)}
          onPointerDown={e => { if (!e.isPrimary || e.button !== 0) return; e.preventDefault(); e.currentTarget.focus(); const p = point(e); showCursor(p); if (start(p, e.pointerId)) e.currentTarget.setPointerCapture(e.pointerId) }}
          onPointerMove={move} onPointerUp={e => { if (active.current?.id === e.pointerId) { move(e); finish() } if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }}
          onPointerCancel={e => { if (active.current?.id === e.pointerId) finish(true) }} onLostPointerCapture={e => { if (active.current?.id === e.pointerId) finish(true) }}
          onKeyDown={e => {
            if (e.altKey || e.ctrlKey || e.metaKey || busy || !ready) return
            const step = Math.max(1, Math.round(size / 4)) * (e.shiftKey ? 5 : 1)
            const p = { ...position.current }
            if (e.key === 'ArrowLeft') p.x -= step
            else if (e.key === 'ArrowRight') p.x += step
            else if (e.key === 'ArrowUp') p.y -= step
            else if (e.key === 'ArrowDown') p.y += step
            else if (e.key === ' ') { e.preventDefault(); if (start(p, -1)) finish(); return }
            else return
            e.preventDefault()
            showCursor({ x: Math.max(0, Math.min(width, p.x)), y: Math.max(0, Math.min(height, p.y)) })
          }} />
        <span ref={cursor} className="agt-mask-cursor" aria-hidden="true" />
      </div>}
    </div>
    <p className="agt-mask-status" role={problem || error ? 'alert' : 'status'}>{problem || error || (busy ? 'Exporting mask…' : !ready ? 'Loading source…' : !overlay ? 'Mask hidden. Show it to keep painting.' : count ? `${count} ${count === 1 ? 'step' : 'steps'}. ${applyLabel} exports a PNG mask only.` : hasBase ? 'Saved mask loaded. Brush, erase or grow it, then save.' : 'No area selected. Brush over the area to change.')}</p>
    <footer><button type="button" onClick={cancel} data-mask-cancel="">Cancel</button><button type="button" className="agt-mask-apply" disabled={!!problem || !ready || empty || busy} onClick={() => void apply()}>{applyLabel}</button></footer>
  </dialog>, document.body)
}
