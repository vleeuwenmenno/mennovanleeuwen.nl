import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

// One interactive time chart for every Weather detail: lines, areas and bars over a shared time
// axis, a crosshair that follows the pointer (mouse hover, touch or pen drag), a scrubber handle
// under the axis, arrow keys, and a tooltip with every series' value at that point. The parent
// owns the index, so a compass, a gauge or a readout can follow the same hour. Plain SVG drawn at
// the box's real pixel width (one ResizeObserver), no chart library.

export type ChartSeries = {
  name: string
  values: number[]
  kind?: 'line' | 'area' | 'bars'
  /** A theme colour, e.g. `var(--accent)`. */
  color?: string
  /** Drawn thinner and fainter: a second quantity for context. */
  faint?: boolean
  /** Its own value range, for a quantity with other units on the same time axis. */
  domain?: [number, number]
  fmt: (v: number) => string
}

export type ChartZone = { from: number; to: number; color: string }

type Props = {
  /** The first series without its own domain sets the y axis and its labels. */
  series: ChartSeries[]
  /** Tooltip heading for each index. */
  labels: string[]
  /** Axis label under an index, or null for none. */
  tick: (i: number) => string | null
  index: number
  onIndex: (i: number) => void
  /** Format for the y axis labels. */
  axis: (v: number) => string
  floor?: number
  ceil?: number
  /** Value bands behind the plot (UV and air quality levels). */
  zones?: ChartZone[]
  /** A shaded range, e.g. each day's low to high. */
  band?: { lo: number[]; hi: number[]; color?: string }
  /** Wind direction per index, drawn as small arrows along the top. */
  arrows?: number[]
  /** A dashed vertical line, e.g. "Now". */
  marker?: { index: number; label: string }
  height?: number
  label: string
  /** Optional icon row along the top, one per index (thinned to fit). */
  icons?: string[]
}

const PAD_L = 38
const PAD_R = 10
const PAD_T = 50
const PAD_B = 22

export function InteractiveChart({ series, labels, tick, index, onIndex, axis, floor, ceil, zones, band, arrows, marker, height = 200, label, icons }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const pending = useRef<number | null>(null)
  const raf = useRef(0)
  const dragging = useRef(false)
  const [live, setLive] = useState(false)
  const liveTimer = useRef(0)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    setW(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setW((prev) => (prev === el.clientWidth ? prev : el.clientWidth)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current)
      clearTimeout(liveTimer.current)
    },
    [],
  )
  const showTip = (on: boolean, after = 0) => {
    clearTimeout(liveTimer.current)
    if (after) liveTimer.current = window.setTimeout(() => setLive(on), after)
    else setLive(on)
  }

  const n = Math.max(0, ...series.map((s) => s.values.length))
  const hasBars = series.some((s) => s.kind === 'bars')
  const plotW = Math.max(1, w - PAD_L - PAD_R)
  const plotH = Math.max(1, height - PAD_T - PAD_B)
  const step = hasBars ? plotW / Math.max(1, n) : plotW / Math.max(1, n - 1)
  const xAt = (i: number) => (hasBars ? PAD_L + (i + 0.5) * step : n <= 1 ? PAD_L + plotW / 2 : PAD_L + i * step)

  // Main domain from the series that share the axis, plus the band.
  const shared = series.filter((s) => !s.domain).flatMap((s) => s.values)
  if (band) shared.push(...band.lo, ...band.hi)
  const finite = shared.filter(Number.isFinite)
  let lo = finite.length ? Math.min(...finite) : 0
  let hi = finite.length ? Math.max(...finite) : 1
  if (floor !== undefined) lo = Math.min(lo, floor)
  if (ceil !== undefined) hi = Math.max(hi, ceil)
  if (hi - lo < 1e-6) hi = lo + 1
  const pad = (hi - lo) * 0.08
  const dLo = floor !== undefined && lo === floor ? lo : lo - pad
  const dHi = hi + pad
  const yMain = (v: number) => PAD_T + (1 - (v - dLo) / (dHi - dLo)) * plotH
  const yFor = (s: ChartSeries) => {
    if (!s.domain) return yMain
    const [a, b] = s.domain
    const span = b - a || 1
    return (v: number) => PAD_T + (1 - (v - a) / span) * plotH
  }
  const grid = niceTicks(dLo, dHi, 4)

  const i = Math.min(Math.max(0, index), Math.max(0, n - 1))
  const cx = xAt(i)

  const indexAt = (clientX: number) => {
    const el = box.current
    if (!el || n === 0) return 0
    const px = clientX - el.getBoundingClientRect().left - PAD_L
    const raw = hasBars ? Math.floor(px / step) : Math.round(px / step)
    return Math.min(n - 1, Math.max(0, raw))
  }
  const push = (next: number) => {
    pending.current = next
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      if (pending.current !== null && pending.current !== index) onIndex(pending.current)
      pending.current = null
    })
  }
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    dragging.current = true
    showTip(true)
    e.currentTarget.setPointerCapture?.(e.pointerId)
    push(indexAt(e.clientX))
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current || e.pointerType === 'mouse') push(indexAt(e.clientX))
  }
  const up = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false
    if (e.pointerType !== 'mouse') showTip(false, 1600)
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const by = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'PageUp' ? 6 : e.key === 'PageDown' ? -6 : 0
    if (e.key === 'Home') onIndex(0)
    else if (e.key === 'End') onIndex(n - 1)
    else if (by) onIndex(Math.min(n - 1, Math.max(0, i + by)))
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  // Thin the tick labels, arrows and icons so they never crowd.
  const every = (px: number) => Math.max(1, Math.ceil(px / Math.max(1, step)))
  const tickEvery = every(44)
  const iconEvery = every(30)
  const sig = `${n}:${series.map((s) => s.name + (s.values[0] ?? '') + (s.values[n - 1] ?? '')).join('|')}`

  const tipW = 152
  const tipLeft = Math.min(Math.max(cx - tipW / 2, 0), Math.max(0, w - tipW))
  const valueText = `${labels[i] ?? ''}: ${series.map((s) => `${s.name} ${s.fmt(s.values[i] ?? 0)}`).join(', ')}`

  return (
    <div
      ref={box}
      className={`wa-ichart${live ? ' is-live' : ''}`}
      style={{ height }}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, n - 1)}
      aria-valuenow={i}
      aria-valuetext={valueText}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      onPointerEnter={(e) => e.pointerType === 'mouse' && showTip(true)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && !dragging.current && showTip(false)}
      onFocus={() => showTip(true)}
      onBlur={() => showTip(false)}
    >
      {w > 0 && n > 0 && (
        <>
          <svg width={w} height={height} aria-hidden>
            <defs>
              <clipPath id={`${uid}c`}>
                <rect key={sig} className="wa-ichart-reveal" x={0} y={0} width={w} height={height} />
              </clipPath>
              {series.map((s, k) => (
                <linearGradient key={k} id={`${uid}g${k}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color ?? 'var(--accent)'} stopOpacity={s.faint ? 0.18 : 0.42} />
                  <stop offset="100%" stopColor={s.color ?? 'var(--accent)'} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            {zones?.map((z, k) => {
              const top = Math.max(PAD_T, yMain(Math.min(z.to, dHi)))
              const bot = Math.min(PAD_T + plotH, yMain(Math.max(z.from, dLo)))
              if (bot <= top) return null
              return <rect key={k} x={PAD_L} y={top} width={plotW} height={bot - top} style={{ fill: `color-mix(in srgb, ${z.color} 14%, transparent)` }} />
            })}
            {grid.map((g) => (
              <g key={g} className="wa-ichart-grid">
                <line x1={PAD_L} x2={PAD_L + plotW} y1={yMain(g)} y2={yMain(g)} />
                <text x={PAD_L - 6} y={yMain(g)} textAnchor="end" dominantBaseline="middle">
                  {axis(g)}
                </text>
              </g>
            ))}
            <g clipPath={`url(#${uid}c)`}>
              {band && (
                <path
                  className="wa-ichart-band"
                  d={bandPath(band.lo.map((v, k) => [xAt(k), yMain(v)]), band.hi.map((v, k) => [xAt(k), yMain(v)]))}
                  style={{ fill: `color-mix(in srgb, ${band.color ?? 'var(--accent)'} 26%, transparent)` }}
                />
              )}
              {series.map((s, k) => {
                const y = yFor(s)
                const color = s.color ?? 'var(--accent)'
                if (s.kind === 'bars') {
                  const bw = Math.max(2, Math.min(18, step * 0.62))
                  const base = PAD_T + plotH
                  return (
                    <g key={k} className="wa-ichart-bars" style={{ fill: color, opacity: s.faint ? 0.45 : 0.9 }}>
                      {s.values.map((v, j) => {
                        const top = Math.min(base - (v > 0 ? 2 : 0), y(Math.max(0, v)))
                        return <rect key={j} x={xAt(j) - bw / 2} y={top} width={bw} height={Math.max(0, base - top)} opacity={j === i ? 1 : 0.8} />
                      })}
                    </g>
                  )
                }
                const pts = s.values.map((v, j) => [xAt(j), y(v)] as [number, number])
                const d = smoothPath(pts)
                return (
                  <g key={k}>
                    {s.kind === 'area' && <path d={`${d} L ${pts[pts.length - 1][0]} ${PAD_T + plotH} L ${pts[0][0]} ${PAD_T + plotH} Z`} fill={`url(#${uid}g${k})`} />}
                    <path d={d} fill="none" stroke={color} strokeWidth={s.faint ? 1.5 : 2.5} strokeOpacity={s.faint ? 0.55 : 1} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={s.faint ? '4 4' : undefined} />
                  </g>
                )
              })}
            </g>
            {arrows &&
              arrows.map((deg, j) =>
                j % iconEvery === 0 ? (
                  <g key={j} transform={`translate(${xAt(j)} ${PAD_T - 8}) rotate(${deg})`} className={`wa-ichart-arrow${j === i ? ' is-on' : ''}`}>
                    <path d="M0 -5 L3.5 3 L0 1.5 L-3.5 3 Z" />
                  </g>
                ) : null,
              )}
            {marker && marker.index >= 0 && marker.index < n && (
              <g className="wa-ichart-marker">
                <line x1={xAt(marker.index)} x2={xAt(marker.index)} y1={PAD_T} y2={PAD_T + plotH} />
              </g>
            )}
            {Array.from({ length: n }, (_, j) => {
              const t = j % tickEvery === 0 ? tick(j) : null
              return t ? (
                <text key={j} className="wa-ichart-tick" x={xAt(j)} y={height - 6} textAnchor="middle">
                  {t}
                </text>
              ) : null
            })}
            <g className="wa-ichart-cross" style={{ transform: `translateX(${cx}px)` }}>
              <line x1={0} x2={0} y1={PAD_T - 2} y2={PAD_T + plotH} />
            </g>
            {series.map((s, k) => {
              if (s.kind === 'bars') return null
              const v = s.values[i]
              if (v === undefined || !Number.isFinite(v)) return null
              return <circle key={k} className="wa-ichart-dot" r={s.faint ? 3.5 : 5} style={{ transform: `translate(${cx}px, ${yFor(s)(v)}px)`, fill: s.color ?? 'var(--accent)' }} />
            })}
          </svg>
          {icons && (
            <div className="wa-ichart-icons" aria-hidden>
              {icons.map((ic, j) =>
                j % iconEvery === 0 ? (
                  <span key={j} style={{ left: xAt(j) }}>
                    {ic}
                  </span>
                ) : null,
              )}
            </div>
          )}
          <div className="wa-ichart-tip" style={{ transform: `translateX(${tipLeft}px)`, width: tipW }} aria-hidden>
            <strong>{labels[i]}</strong>
            {series.map((s, k) => (
              <span key={k}>
                <i style={{ background: s.color ?? 'var(--accent)', opacity: s.faint ? 0.6 : 1 }} />
                {s.name} <b>{s.fmt(s.values[i] ?? 0)}</b>
              </span>
            ))}
          </div>
          <div className="wa-ichart-scrub" aria-hidden>
            <b style={{ transform: `translateX(${cx}px)` }} />
          </div>
          {marker && marker.index >= 0 && marker.index < n && (
            <span className="wa-ichart-mlabel" style={{ left: xAt(marker.index) }} aria-hidden>
              {marker.label}
            </span>
          )}
        </>
      )}
    </div>
  )
}

/** A small drawn-in line or bar strip for a dashboard tile. Static once drawn; no listeners. */
export function Sparkline({ values, kind = 'line', floor, className }: { values: number[]; kind?: 'line' | 'bars'; floor?: number; className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const vals = values.filter(Number.isFinite)
  if (vals.length < 2) return null
  const W = 100
  const H = 28
  let lo = Math.min(...vals)
  const hi = Math.max(...vals)
  if (floor !== undefined) lo = Math.min(lo, floor)
  const span = hi - lo || 1
  const y = (v: number) => 2 + (1 - (v - lo) / span) * (H - 4)
  if (kind === 'bars') {
    const bw = W / vals.length
    return (
      <svg className={`wa-spark is-bars ${className ?? ''}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        {vals.map((v, i) => {
          const top = v > 0 ? Math.min(H - 1.5, y(v)) : H - 0.8
          return <rect key={i} x={i * bw + bw * 0.18} y={top} width={bw * 0.64} height={H - top} style={{ animationDelay: `${i * 18}ms` }} />
        })}
      </svg>
    )
  }
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * W, y(v)] as [number, number])
  const d = smoothPath(pts)
  return (
    <svg className={`wa-spark ${className ?? ''}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={`${uid}s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.35} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${d} L ${W} ${H} L 0 ${H} Z`} fill={`url(#${uid}s)`} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
    </svg>
  )
}

/** Monotone cubic through the points (no overshoot above a peak or below zero). */
export function smoothPath(pts: [number, number][]): string {
  const n = pts.length
  if (n === 0) return ''
  if (n === 1) return `M ${pts[0][0]} ${pts[0][1]}`
  const dx: number[] = []
  const m: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0])
    m.push((pts[i + 1][1] - pts[i][1]) / (dx[i] || 1))
  }
  const t: number[] = [m[0]]
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2)
  t.push(m[n - 2])
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0
      t[i + 1] = 0
      continue
    }
    const a = t[i] / m[i]
    const b = t[i + 1] / m[i]
    const h = a * a + b * b
    if (h > 9) {
      const s = 3 / Math.sqrt(h)
      t[i] = s * a * m[i]
      t[i + 1] = s * b * m[i]
    }
  }
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[i + 1]
    const h = dx[i] / 3
    d += ` C ${(x0 + h).toFixed(1)} ${(y0 + t[i] * h).toFixed(1)} ${(x1 - h).toFixed(1)} ${(y1 - t[i + 1] * h).toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`
  }
  return d
}

function bandPath(lo: [number, number][], hi: [number, number][]): string {
  if (!lo.length) return ''
  const top = smoothPath(hi)
  const back = smoothPath([...lo].reverse()).replace(/^M/, 'L')
  return `${top} ${back} Z`
}

function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo
  if (!(span > 0)) return [lo]
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const stepSize = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag
  const out: number[] = []
  for (let v = Math.ceil(lo / stepSize) * stepSize; v <= hi + 1e-9; v += stepSize) out.push(Number(v.toFixed(6)))
  return out
}

/** A label row with a value that follows a chart's index: "14:00 · 18°". */
export function Readout({ title, big, sub, extra }: { title: string; big: ReactNode; sub?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="wa-readout">
      <span className="wa-readout-title">{title}</span>
      <span className="wa-readout-big">{big}</span>
      {sub && <span className="wa-readout-sub">{sub}</span>}
      {extra}
    </div>
  )
}
