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
  onApply: (result: AgentsMaskResult) => void | Promise<void>
  onCancel: () => void
}
type Point = { x: number; y: number }
type Stroke = { erase: boolean; size: number; points: Point[] }
const MAX_POINTS = 32_768
const MAX_STROKES = 512
const MAX_BYTES = 8 * 1024 * 1024

export function maskDimensionsValid(width: number, height: number) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_000_000
}

function draw(ctx: CanvasRenderingContext2D, stroke: Stroke, color: string, opaque = false) {
  ctx.globalCompositeOperation = stroke.erase && !opaque ? 'destination-out' : 'source-over'
  ctx.strokeStyle = ctx.fillStyle = stroke.erase && opaque ? '#000000' : color
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

/** Owns its modal and focus; no window manager or shell provider is required. */
export function AgentsMaskEditor(props: AgentsMaskEditorProps) {
  return <Editor key={`${props.sourceUrl}:${props.width}:${props.height}`} {...props} />
}

function Editor({ sourceUrl, sourceName, width, height, onApply, onCancel }: AgentsMaskEditorProps) {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const cursor = useRef<HTMLSpanElement>(null)
  const history = useRef<Stroke[]>([])
  const active = useRef<{ id: number; stroke: Stroke } | null>(null)
  const pointCount = useRef(0)
  const ended = useRef(false)
  const exporting = useRef(false)
  const [count, setCount] = useState(0)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [erase, setErase] = useState(false)
  const [size, setSize] = useState(Math.max(1, Math.round(Math.min(width, height) / 12)))
  const position = useRef<Point>({ x: width / 2, y: height / 2 })
  const valid = maskDimensionsValid(width, height)
  let url = ''
  try {
    const parsed = new URL(sourceUrl, location.href)
    if (parsed.origin === location.origin && /^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.href
  } catch { /* Report invalid URLs without requesting them. */ }
  const problem = !valid ? 'Image must be at most 8192 pixels per side and 16 megapixels.' : !url ? 'The source must be a same-origin image URL.' : ''
  const scale = valid ? Math.min(1, 1600 / Math.max(width, height)) : 1
  const pw = valid ? Math.max(1, Math.round(width * scale)) : 1
  const ph = valid ? Math.max(1, Math.round(height * scale)) : 1

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

  function cancel() {
    ended.current = true
    onCancel()
  }
  function redraw() {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx) return
    ctx.resetTransform()
    ctx.clearRect(0, 0, pw, ph)
    ctx.scale(pw / width, ph / height)
    const color = getComputedStyle(canvas.current!).color
    for (const stroke of history.current) draw(ctx, stroke, color)
    if (active.current) draw(ctx, active.current.stroke, color)
  }
  function showCursor(p: Point) {
    position.current = p
    if (cursor.current) {
      Object.assign(cursor.current.style, { left: `${100 * p.x / width}%`, top: `${100 * p.y / height}%`, width: `${100 * size / width}%`, height: `${100 * size / height}%` })
    }
  }
  useEffect(() => { showCursor(position.current) }, [size])
  function undo() {
    if (active.current || exporting.current) return
    const last = history.current.pop()
    if (last) pointCount.current -= last.points.length
    setCount(history.current.length)
    setError('')
    redraw()
  }
  function start(p: Point, pointerId: number) {
    if (!ready || exporting.current || active.current) return false
    if (history.current.length >= MAX_STROKES || pointCount.current >= MAX_POINTS) {
      setError('Mask history is full. Undo a stroke or reset before drawing more.')
      return false
    }
    setError('')
    active.current = { id: pointerId, stroke: { erase, size, points: [p] } }
    pointCount.current++
    const ctx = canvas.current!.getContext('2d')!
    ctx.setTransform(pw / width, 0, 0, ph / height, 0, 0)
    draw(ctx, active.current.stroke, getComputedStyle(canvas.current!).color)
    return true
  }
  function finish(discard = false) {
    const a = active.current
    if (!a) return
    active.current = null
    if (discard) { pointCount.current -= a.stroke.points.length; redraw() }
    else history.current.push(a.stroke)
    setCount(history.current.length)
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
      const ctx = output.getContext('2d', { alpha: false, willReadFrequently: true })
      if (!ctx) throw new Error('Mask export is unavailable in this browser.')
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, width, height)
      for (const stroke of history.current) draw(ctx, stroke, '#ffffff', true)
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

  return createPortal(<dialog ref={dialog} className="agt-mask" aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`} onCancel={e => { e.preventDefault(); cancel() }} onKeyDown={e => {
    e.stopPropagation()
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo() }
  }}>
    <header><h2 id={`${id}-title`}>Edit mask: {sourceName}</h2><span>{width} × {height}</span></header>
    <div className="agt-mask-tools" role="group" aria-label="Mask tools">
      <button type="button" aria-pressed={!erase} onClick={() => setErase(false)}>Brush</button>
      <button type="button" aria-pressed={erase} onClick={() => setErase(true)}>Erase</button>
      <label>Brush size <input aria-label="Brush size in image pixels" type="range" min="1" max={valid ? Math.max(width, height) : 1} value={size} onChange={e => setSize(Number(e.target.value))} /><output>{size} px</output></label>
      <button type="button" disabled={!count || busy} onClick={undo}>Undo</button>
      <button type="button" disabled={!count || busy} onClick={() => { if (active.current) return; history.current = []; pointCount.current = 0; setCount(0); setError(''); redraw() }}>Reset</button>
    </div>
    <p id={`${id}-help`}>Colored areas will change. The image always fits. Brush or erase with a pointer; on the canvas, arrow keys move the cursor (Shift: larger steps), Space paints a dot. Ctrl/⌘+Z undoes.</p>
    <div className="agt-mask-stage">
      {!problem && <div className="agt-mask-image" style={{ aspectRatio: `${width} / ${height}`, width: `min(100%, ${58 * width / height}dvh)` }}>
        <img src={url} alt={sourceName} draggable={false} onLoad={e => {
          if (e.currentTarget.naturalWidth !== width || e.currentTarget.naturalHeight !== height) { setReady(false); setError('Source dimensions do not match the oriented image. Reopen with the correct dimensions.') }
          else setReady(true)
        }} onError={() => { setReady(false); setError('Could not load the source image. Check access and reopen the editor.') }} />
        <canvas ref={canvas} width={pw} height={ph} tabIndex={ready && !busy ? 0 : -1} role="application" aria-label="Mask drawing canvas" aria-describedby={`${id}-help`} aria-disabled={!ready || busy}
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
    <p className="agt-mask-status" role={problem || error ? 'alert' : 'status'}>{problem || error || (busy ? 'Exporting mask…' : !ready ? 'Loading source…' : count ? `${count} strokes. Apply exports a PNG mask only.` : 'No area selected. Brush over the area to change.')}</p>
    <footer><button type="button" onClick={cancel} data-mask-cancel="">Cancel</button><button type="button" className="agt-mask-apply" disabled={!!problem || !ready || !count || busy} onClick={() => void apply()}>Apply mask</button></footer>
  </dialog>, document.body)
}
