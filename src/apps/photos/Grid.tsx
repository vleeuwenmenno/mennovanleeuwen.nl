import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { dayTitle, duration, monthTitle, thumbUrl, type Bucket, type Item, type SourceId, type ThumbSize } from '../../data/photos'
import { useIsMobile } from '../../os/useIsMobile'
import type { Timeline } from './useTimeline'

// The timeline's grid: months, then days, then square tiles, newest first. Only the rows on
// screen (and a screen's worth either side) are in the page, so 20,000 photos scroll as easily
// as 20. Months not loaded yet take the room their count says they will need, and when one above
// the screen loads (and turns out taller or shorter) the scroll position moves with it, so what is
// on screen stays put. Thumbnails load a few at a time, the newest wish first, and the browser
// keeps them (the server sends them with an ETag and a week's Cache-Control).
//
// Zoom: Ctrl+wheel, a pinch, or the buttons (which set `zoom`). The scrubber on the right jumps
// through the years: drag it, or click a year.

export const ZOOMS = [56, 84, 124, 180, 260]
const GAP = 2
const MONTH_H = 52
const DAY_H = 34

type Row =
  | { kind: 'month'; top: number; height: number; bucket: number; month: string }
  | { kind: 'day'; top: number; height: number; bucket: number; wall: number; count: number }
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
        rows.push({ kind: 'day', top: y, height: DAY_H, bucket: bi, wall: items[i].wall, count: j - i })
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

const Tile = memo(function Tile({ source, item, size, px, left, onOpen, index }: { source: SourceId; item: Item; size: ThumbSize; px: number; left: number; onOpen: (i: number) => void; index: number }) {
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
    <button className={`ph-tile ${item.video ? 'is-video' : ''}`} style={{ left, width: px, height: px }} onClick={() => onOpen(index)} aria-label={item.video ? 'Video' : 'Photo'} data-id={item.id}>
      {src && !failed && <img src={src} alt="" draggable={false} onLoad={() => settle(true)} onError={() => settle(false)} />}
      {failed && <span className="ph-tile-none" aria-hidden>{item.video ? '▶' : '🖼'}</span>}
      {item.video && <span className="ph-badge">{item.duration ? duration(item.duration) : '▶'}</span>}
      {item.fav && (
        <svg className="ph-fav" viewBox="0 0 24 24" width="14" height="14" aria-label="Favourite">
          <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
        </svg>
      )}
    </button>
  )
})

export function Grid({ source, timeline, zoom, onZoom, onOpen, empty }: { source: SourceId; timeline: Timeline; zoom: number; onZoom: (z: number) => void; onOpen: (index: number) => void; empty: React.ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null)
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
    if (e.pointerType !== 'touch') return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) pinch.current = dist()
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
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

  // Each loaded photo's place in the flat list, for the lightbox.
  const offsets = useMemo(() => {
    const m = new Map<string, number>()
    let n = 0
    for (const b of buckets ?? []) {
      m.set(b.key, n)
      n += loaded.get(b.key)?.length ?? 0
    }
    return m
  }, [buckets, loaded])

  // The same function for every render, so the tiles (memo) do not draw again for nothing.
  const openRef = useRef(onOpen)
  openRef.current = onOpen
  const open = useCallback((i: number) => openRef.current(i), [])

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const size: ThumbSize = l.tile * dpr <= 256 ? 'small' : l.tile * dpr <= 600 ? 'medium' : 'large'

  const rows = l.rows.slice(from, to + 1)
  return (
    <div className="ph-grid-wrap">
      <div className="ph-scroll" ref={scroller} onScroll={onScroll} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} data-no-touch-menu>
        {buckets && !buckets.length ? (
          empty
        ) : (
        <div className="ph-canvas" style={{ height: l.total }}>
          {rows.map((r) => {
            const bucket = buckets![r.bucket]
            if (r.kind === 'month')
              return (
                <h2 key={`m${bucket.key}`} className="ph-month" style={{ top: r.top, height: r.height }}>
                  {monthTitle(r.month)}
                </h2>
              )
            if (r.kind === 'day')
              return (
                <h3 key={`d${bucket.key}${r.top}`} className="ph-day" style={{ top: r.top, height: r.height }}>
                  {dayTitle(r.wall)}
                  <span className="muted">{r.count}</span>
                </h3>
              )
            if (r.kind === 'pending') return <div key={`p${bucket.key}`} className="ph-pending" style={{ top: r.top, height: r.height, ['--tile' as string]: `${l.tile + GAP}px` }} />
            const base = (offsets.get(bucket.key) ?? 0) + r.first
            return (
              <div key={`t${bucket.key}${r.first}`} className="ph-row" style={{ top: r.top, height: l.tile }}>
                {r.items.map((item, i) => (
                  <Tile key={item.id} source={source} item={item} size={size} px={l.tile} left={i * (l.tile + GAP)} index={base + i} onOpen={open} />
                ))}
              </div>
            )
          })}
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
    const rect = target.getBoundingClientRect()
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
        go(e.clientY, e.currentTarget)
      }}
      onPointerMove={(e) => {
        if (dragging.current) go(e.clientY, e.currentTarget)
        else if (e.pointerType === 'mouse') {
          const rect = e.currentTarget.getBoundingClientRect()
          const y = Math.max(0, Math.min(usable, e.clientY - rect.top - pad))
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
