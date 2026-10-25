import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { dayTitle, duration, monthTitle, thumbUrl, type Bucket, type Item, type SourceId, type ThumbSize } from '../../data/photos'
import { useIsMobile } from '../../os/useIsMobile'
import { VideoThumb } from '../../os/VideoThumb'
import type { Timeline } from './useTimeline'
import { toUi, uiRect } from '../../os/uiScale'

// The timeline's grid: months, then days, then square tiles, newest first. Only the rows on
// screen (and a screen's worth either side) are in the page, so 20,000 photos scroll as easily
// as 20. Months not loaded yet take the room their count says they will need, and when one above
// the screen loads (and turns out taller or shorter) the scroll position moves with it, so what is
// on screen stays put. Thumbnails load a few at a time, the newest wish first, and the browser
// keeps them (the server sends them with an ETag and a week's Cache-Control).
//
// Zoom: Ctrl+wheel, a pinch, or the buttons (which set `zoom`). The scrubber on the right jumps
// through the years: drag it, or click a year.
//
// Selection (kept as ids by the app, so it outlives the rows that scroll away): a click opens the
// photo, until something is selected; the circle on a tile (on hover, and always once something
// is selected) and on each day and month heading selects one or all of them, and from then on a
// click takes a photo in or out. Ctrl or Cmd+click does that too, whatever is selected, and Shift
// adds everything from the last one clicked, in timeline order. Dragging over empty space draws a box
// (scrolling on at the edges), hit-tested against the layout, not the page, so it reaches rows
// that are not drawn. On a touch screen a tap opens, a long press selects, and taps then add and take
// away; holding a selected photo then drags the selection.

export const ZOOMS = [56, 84, 124, 180, 260]
const GAP = 2
const MONTH_H = 52
const DAY_H = 34

type Row =
  | { kind: 'month'; top: number; height: number; bucket: number; month: string }
  | { kind: 'day'; top: number; height: number; bucket: number; wall: number; count: number; first: number }
  | { kind: 'tiles'; top: number; height: number; bucket: number; items: Item[]; first: number }
  | { kind: 'pending'; top: number; height: number; bucket: number }

type Layout = { rows: Row[]; tops: number[]; heights: number[]; total: number; tile: number; cols: number }

function layout(buckets: Bucket[], loaded: Map<string, Item[]>, width: number, zoom: number): Layout {
  const target = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, zoom))]
  const cols = Math.max(2, Math.floor((width + GAP) / (target + GAP)))
  const tile = Math.max(20, (width - (cols - 1) * GAP) / cols)
  const rows: Row[] = []
  const tops: number[] = []
  const heights: number[] = []
  let y = 0
  buckets.forEach((b, bi) => {
    const start = y
    tops.push(y)
    rows.push({ kind: 'month', top: y, height: MONTH_H, bucket: bi, month: b.month })
    y += MONTH_H
    const items = loaded.get(b.key)
    if (!items) {
      // Room for what is coming: a day heading for every six photos or so, and their rows.
      const days = Math.min(31, Math.max(1, Math.round(b.count / 6)))
      const lines = Math.max(days, Math.ceil(b.count / cols))
      const h = days * DAY_H + lines * (tile + GAP)
      rows.push({ kind: 'pending', top: y, height: h, bucket: bi })
      y += h
    } else {
      let i = 0
      while (i < items.length) {
        const day = Math.floor(items[i].wall / 86_400_000)
        let j = i
        while (j < items.length && Math.floor(items[j].wall / 86_400_000) === day) j++
        rows.push({ kind: 'day', top: y, height: DAY_H, bucket: bi, wall: items[i].wall, count: j - i, first: i })
        y += DAY_H
        for (let k = i; k < j; k += cols) {
          rows.push({ kind: 'tiles', top: y, height: tile + GAP, bucket: bi, items: items.slice(k, Math.min(j, k + cols)), first: k })
          y += tile + GAP
        }
        i = j
      }
    }
    heights.push(y - start)
  })
  return { rows, tops, heights, total: y, tile, cols }
}

/** The photos whose tiles a box (in the canvas's own coordinates) touches. */
function inBox(l: Layout, box: { x0: number; y0: number; x1: number; y1: number }): string[] {
  const out: string[] = []
  for (let i = rowAt(l.rows, box.y0); i < l.rows.length && l.rows[i].top < box.y1; i++) {
    const r = l.rows[i]
    if (r.kind !== 'tiles' || r.top + l.tile < box.y0) continue
    r.items.forEach((item, k) => {
      const x = k * (l.tile + GAP)
      if (x < box.x1 && x + l.tile > box.x0) out.push(item.id)
    })
  }
  return out
}

/** The first row whose bottom is below `y`. */
function rowAt(rows: Row[], y: number) {
  let lo = 0
  let hi = rows.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].top + rows[mid].height <= y) lo = mid + 1
    else hi = mid
  }
  return lo
}
const bucketAt = (l: Layout, y: number) => {
  let lo = 0
  let hi = l.tops.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (l.tops[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

// --- Thumbnails, a few at a time ----------------------------------------------------------------------

const CONCURRENT = 6
let active = 0
const queue: { start: () => void }[] = []
function drain() {
  while (active < CONCURRENT && queue.length) {
    // The newest wish first: after a fast scroll, what is on screen now.
    const job = queue.pop()!
    active++
    job.start()
  }
}
/** Waits for a slot; `start` gets the function that frees it. Answers a cancel. */
function enqueue(start: (done: () => void) => void): () => void {
  let state: 'queued' | 'running' | 'done' = 'queued'
  const done = () => {
    if (state !== 'running') return
    state = 'done'
    active--
    drain()
  }
  const job = {
    start: () => {
      state = 'running'
      start(done)
    },
  }
  queue.push(job)
  drain()
  return () => {
    if (state === 'queued') {
      const i = queue.indexOf(job)
      if (i >= 0) queue.splice(i, 1)
      state = 'done'
    } else done()
  }
}

/** What a tile does when it is clicked, held or dragged: the grid's, through one stable object so the tiles need not draw again. */
export type TileActions = {
  click: (item: Item, e: React.MouseEvent) => void
  check: (item: Item, e: React.MouseEvent) => void
  menu: (item: Item, e: React.MouseEvent) => void
  drag: (item: Item, e: React.DragEvent) => void
  press: (item: Item, e: React.PointerEvent) => void
}

const CHECK = <path d="M6 12.5l4 4 8-9" />

const Tile = memo(function Tile({ source, item, size, px, left, act, selected, selecting }: { source: SourceId; item: Item; size: ThumbSize; px: number; left: number; act: { current: TileActions }; selected: boolean; selecting: boolean }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const done = useRef<(() => void) | null>(null)
  const url = thumbUrl(source, item.id, size, item.v)
  useEffect(() => {
    setFailed(false)
    setSrc(null)
    const cancel = enqueue((free) => {
      done.current = free
      setSrc(url)
    })
    return () => {
      cancel()
      done.current = null
    }
  }, [url])
  const settle = (ok: boolean) => {
    done.current?.()
    done.current = null
    if (!ok) setFailed(true)
  }
  return (
    <button
      className={`ph-tile ${item.video ? 'is-video' : ''} ${selected ? 'is-selected' : ''}`}
      style={{ left, width: px, height: px }}
      onClick={(e) => act.current.click(item, e)}
      onContextMenu={(e) => act.current.menu(item, e)}
      onPointerDown={(e) => act.current.press(item, e)}
      draggable
      onDragStart={(e) => act.current.drag(item, e)}
      aria-label={item.video ? 'Video' : 'Photo'}
      aria-pressed={selecting ? selected : undefined}
      data-id={item.id}
    >
      {src && !failed && <img src={src} alt="" draggable={false} onLoad={() => settle(true)} onError={() => settle(false)} />}
      {/* A Seafile video Seafile made no thumbnail for: a frame from it, made in this browser (src/data/videoThumbs.ts). */}
      {failed &&
        (item.video && item.path ? (
          <VideoThumb path={item.path} version={item.v} seafileFirst={false} badge={false} className="ph-tile-frame" fallback={<span className="ph-tile-none" aria-hidden>▶</span>} />
        ) : (
          <span className="ph-tile-none" aria-hidden>{item.video ? '▶' : '🖼'}</span>
        ))}
      {item.video && <span className="ph-badge">{item.duration ? duration(item.duration) : '▶'}</span>}
      {item.fav && (
        <svg className="ph-fav" viewBox="0 0 24 24" width="14" height="14" aria-label="Favourite">
          <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
        </svg>
      )}
      <span
        className="ph-check"
        role="checkbox"
        aria-checked={selected}
        aria-label={selected ? 'Selected' : 'Select'}
        onClick={(e) => {
          e.stopPropagation()
          act.current.check(item, e)
        }}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
          {CHECK}
        </svg>
      </span>
    </button>
  )
})

/** A day's or month's "select all" circle: filled when all of them are selected. */
function HeadCheck({ on, disabled, onToggle, label }: { on: boolean; disabled?: boolean; onToggle: (e: React.MouseEvent) => void; label: string }) {
  return (
    <button
      className={`ph-check ph-check-all ${on ? 'is-on' : ''}`}
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onToggle(e)
      }}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
        {CHECK}
      </svg>
    </button>
  )
}

/** What the grid needs from the app's selection. */
export type GridSelection = {
  selected: Set<string>
  /** Taps on a touch screen add and take away (something is selected) */
  selecting: boolean
  act: { current: TileActions }
  /** Selects these, or (when all of them are) takes them away */
  toggleAll: (ids: string[]) => void
  /** A box drawn over the grid: these, on top of `base` */
  box: (ids: string[], base: Set<string>) => void
  /** A click on empty space (no box drawn) */
  emptyClick: (e: React.PointerEvent) => void
  /** Right-click (or the menu key) on empty space */
  emptyMenu: (e: React.MouseEvent) => void
}

export function Grid({ source, timeline, zoom, onZoom, sel, empty }: { source: SourceId; timeline: Timeline; zoom: number; onZoom: (z: number) => void; sel: GridSelection; empty: React.ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  const { buckets, loaded } = timeline
  const phone = useIsMobile()

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const l = useMemo(() => layout(buckets ?? [], loaded, Math.max(0, box.w - (phone ? 28 : 32)), zoom), [buckets, loaded, box.w, zoom, phone])

  // What stays on screen when the layout changes: the month at the top and how far into it.
  const anchor = useRef<{ bucket: number; frac: number } | null>(null)
  const last = useRef<Layout | null>(null)
  useLayoutEffect(() => {
    const el = scroller.current
    const a = anchor.current
    if (el && a && last.current && last.current !== l && l.tops.length > a.bucket && el.scrollTop > 0) {
      const top = l.tops[a.bucket] + a.frac * l.heights[a.bucket]
      if (Math.abs(top - el.scrollTop) > 1) el.scrollTop = top
    }
    last.current = l
  }, [l])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    setScrollTop(el.scrollTop)
    const lay = last.current
    if (lay && lay.tops.length) {
      const b = bucketAt(lay, el.scrollTop)
      anchor.current = { bucket: b, frac: lay.heights[b] ? (el.scrollTop - lay.tops[b]) / lay.heights[b] : 0 }
    }
  }, [])

  // The months on screen are loaded first.
  const overscan = box.h
  const from = rowAt(l.rows, Math.max(0, scrollTop - overscan))
  const to = rowAt(l.rows, scrollTop + box.h + overscan)
  const visibleBuckets = useMemo(() => {
    const keys: string[] = []
    for (let i = from; i <= to && i < l.rows.length; i++) {
      const k = buckets?.[l.rows[i].bucket]?.key
      if (k && !keys.includes(k)) keys.push(k)
    }
    return keys
  }, [from, to, l, buckets])
  useEffect(() => timeline.want([...visibleBuckets].reverse()), [visibleBuckets.join(), timeline.want]) // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom with Ctrl+wheel (and a trackpad's pinch, which browsers send as one) and two fingers.
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    let acc = 0
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      acc += e.deltaY
      if (Math.abs(acc) < 40) return
      onZoom(Math.max(0, Math.min(ZOOMS.length - 1, zoomRef.current + (acc > 0 ? -1 : 1))))
      acc = 0
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onZoom])
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<number | null>(null)
  const dist = () => {
    const [a, b] = [...pointers.current.values()]
    return Math.hypot(a.x - b.x, a.y - b.y)
  }
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return startBox(e)
    pointers.current.set(e.pointerId, { x: toUi(e.clientX), y: toUi(e.clientY) })
    if (pointers.current.size === 2) pinch.current = dist()
  }

  // The box: dragged from empty space with a mouse or pen. Its corners are kept in the canvas's
  // coordinates, so scrolling (by the wheel, or on its own at the edges) carries it along.
  const [band, setBand] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const selRef = useRef(sel)
  selRef.current = sel
  const startBox = (e: React.PointerEvent) => {
    const el = scroller.current
    const c = canvas.current
    if (e.button !== 0 || !el || !c || (e.target as HTMLElement).closest('.ph-tile, .ph-check, .ph-scrub')) return
    const r0 = uiRect(c)
    const start = { x: toUi(e.clientX) - r0.left, y: toUi(e.clientY) - r0.top }
    const base = e.ctrlKey || e.metaKey || e.shiftKey ? new Set(selRef.current.selected) : new Set<string>()
    let at = { x: toUi(e.clientX), y: toUi(e.clientY) }
    let drawn = false
    let timer: ReturnType<typeof setInterval> | null = null
    const update = () => {
      const r = uiRect(c)
      const x = Math.max(0, Math.min(r.width, at.x - r.left))
      const y = Math.max(0, Math.min(r.height, at.y - r.top))
      if (!drawn && Math.abs(x - start.x) < 5 && Math.abs(y - start.y) < 5) return
      drawn = true
      const box = { x0: Math.min(start.x, x), y0: Math.min(start.y, y), x1: Math.max(start.x, x), y1: Math.max(start.y, y) }
      setBand({ x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 })
      selRef.current.box(inBox(last.current ?? l, box), base)
    }
    // Near the top or bottom edge the grid scrolls on, faster the closer the pointer is.
    const tick = () => {
      const r = uiRect(el)
      const edge = 48
      const speed = at.y < r.top + edge ? -Math.ceil((r.top + edge - at.y) / 3) : at.y > r.bottom - edge ? Math.ceil((at.y - (r.bottom - edge)) / 3) : 0
      if (drawn && speed) {
        el.scrollTop += Math.max(-40, Math.min(40, speed))
        update()
      }
    }
    timer = setInterval(tick, 16)
    const move = (ev: PointerEvent) => {
      at = { x: toUi(ev.clientX), y: toUi(ev.clientY) }
      update()
    }
    const up = (ev: PointerEvent) => {
      if (timer) clearInterval(timer)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setBand(null)
      if (!drawn && ev.type === 'pointerup') selRef.current.emptyClick(e)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: toUi(e.clientX), y: toUi(e.clientY) })
    if (pointers.current.size !== 2 || !pinch.current) return
    const ratio = dist() / pinch.current
    if (ratio > 1.3 || ratio < 0.77) {
      const next = Math.max(0, Math.min(ZOOMS.length - 1, zoomRef.current + (ratio > 1 ? 1 : -1)))
      if (next !== zoomRef.current) onZoom(next)
      pinch.current = dist()
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
  }

  const allOn = (ids: string[]) => ids.length > 0 && ids.every((id) => sel.selected.has(id))

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const size: ThumbSize = l.tile * dpr <= 256 ? 'small' : l.tile * dpr <= 600 ? 'medium' : 'large'

  const rows = l.rows.slice(from, to + 1)
  return (
    <div className="ph-grid-wrap">
      <div
        className="ph-scroll"
        ref={scroller}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => !(e.target as HTMLElement).closest('.ph-tile') && sel.emptyMenu(e)}
        data-no-touch-menu
      >
        {buckets && !buckets.length ? (
          empty
        ) : (
        <div className={`ph-canvas ${sel.selecting ? 'is-selecting' : ''}`} ref={canvas} style={{ height: l.total }}>
          {rows.map((r) => {
            const bucket = buckets![r.bucket]
            const items = loaded.get(bucket.key)
            if (r.kind === 'month') {
              const ids = items?.map((i) => i.id) ?? []
              const on = allOn(ids)
              return (
                <h2 key={`m${bucket.key}`} className="ph-month" style={{ top: r.top, height: r.height }}>
                  <HeadCheck on={on} disabled={!items} onToggle={() => sel.toggleAll(ids)} label={on ? `Deselect ${monthTitle(r.month)}` : `Select all of ${monthTitle(r.month)}`} />
                  {monthTitle(r.month)}
                </h2>
              )
            }
            if (r.kind === 'day') {
              const ids = (items ?? []).slice(r.first, r.first + r.count).map((i) => i.id)
              const on = allOn(ids)
              return (
                <h3 key={`d${bucket.key}${r.top}`} className="ph-day" style={{ top: r.top, height: r.height }}>
                  <HeadCheck on={on} onToggle={() => sel.toggleAll(ids)} label={on ? `Deselect ${dayTitle(r.wall)}` : `Select all of ${dayTitle(r.wall)}`} />
                  {dayTitle(r.wall)}
                  <span className="muted">{r.count}</span>
                </h3>
              )
            }
            if (r.kind === 'pending') return <div key={`p${bucket.key}`} className="ph-pending" style={{ top: r.top, height: r.height, ['--tile' as string]: `${l.tile + GAP}px` }} />
            return (
              <div key={`t${bucket.key}${r.first}`} className="ph-row" style={{ top: r.top, height: l.tile }}>
                {r.items.map((item, i) => (
                  <Tile key={item.id} source={source} item={item} size={size} px={l.tile} left={i * (l.tile + GAP)} act={sel.act} selected={sel.selected.has(item.id)} selecting={sel.selecting} />
                ))}
              </div>
            )
          })}
          {band && <div className="ph-band" style={{ left: band.x, top: band.y, width: band.w, height: band.h }} />}
        </div>
        )}
      </div>
      {buckets && buckets.length > 1 && <Scrubber buckets={buckets} l={l} height={box.h} scrollTop={scrollTop} scroller={scroller} />}
    </div>
  )
}

/** The years down the right edge: drag along it (or click) to jump through the timeline. */
function Scrubber({ buckets, l, height, scrollTop, scroller }: { buckets: Bucket[]; l: Layout; height: number; scrollTop: number; scroller: React.RefObject<HTMLDivElement | null> }) {
  const [at, setAt] = useState<{ y: number; month: string } | null>(null)
  const dragging = useRef(false)
  const span = Math.max(1, l.total - height)
  const pad = 8
  const usable = Math.max(1, height - pad * 2)
  // One label per year, where its newest month is, unless it would sit on the one before.
  const years: { y: number; year: string }[] = []
  buckets.forEach((b, i) => {
    const year = b.month.slice(0, 4)
    if (i && buckets[i - 1].month.startsWith(year)) return
    const y = pad + (Math.min(l.tops[i], span) / span) * usable
    if (!years.length || y - years[years.length - 1].y >= 18) years.push({ y, year })
  })
  const go = (clientY: number, target: HTMLElement) => {
    const rect = uiRect(target)
    const y = Math.max(0, Math.min(usable, clientY - rect.top - pad))
    const top = (y / usable) * span
    if (scroller.current) scroller.current.scrollTop = top
    const b = buckets[bucketAt(l, top)]
    setAt({ y: y + pad, month: b?.month ?? '' })
  }
  const thumb = pad + (Math.min(scrollTop, span) / span) * usable
  return (
    <div
      className="ph-scrub"
      onPointerDown={(e) => {
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        go(toUi(e.clientY), e.currentTarget)
      }}
      onPointerMove={(e) => {
        if (dragging.current) go(toUi(e.clientY), e.currentTarget)
        else if (e.pointerType === 'mouse') {
          const rect = uiRect(e.currentTarget)
          const y = Math.max(0, Math.min(usable, toUi(e.clientY) - rect.top - pad))
          setAt({ y: y + pad, month: buckets[bucketAt(l, (y / usable) * span)]?.month ?? '' })
        }
      }}
      onPointerUp={() => {
        dragging.current = false
        setAt(null)
      }}
      onPointerLeave={() => !dragging.current && setAt(null)}
      role="scrollbar"
      aria-orientation="vertical"
      aria-valuenow={Math.round((scrollTop / span) * 100)}
      aria-label="Scroll through the years"
      data-no-touch-menu
    >
      {years.map((y) => (
        <span key={y.year} className="ph-scrub-year" style={{ top: y.y }}>
          {y.year}
        </span>
      ))}
      <span className="ph-scrub-thumb" style={{ top: thumb }} />
      {at && at.month && (
        <span className="ph-scrub-tip" style={{ top: at.y }}>
          {monthTitle(at.month)}
        </span>
      )}
    </div>
  )
}
