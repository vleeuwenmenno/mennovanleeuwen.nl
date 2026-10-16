import { useLayoutEffect, useRef } from 'react'
import type { Sky as SkyKind } from '../../data/weather'

// The living sky behind the Weather cards, and small motion helpers. Everything here moves with
// CSS animations on transform and opacity (composited, no frame loop, no React renders), stops
// under prefers-reduced-motion (styles.css), and pauses with the page when it is hidden.

export function reducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

const CLOUDS: Record<SkyKind, number> = { clear: 1, cloudy: 5, fog: 0, rain: 5, snow: 4, storm: 5 }

/** Drifting clouds, rain, snow, stars, lightning or sun glow for the current conditions. */
export function Sky({ sky, day, code }: { sky: SkyKind; day: boolean; code: number }) {
  const clouds = sky === 'clear' && code === 0 ? 0 : CLOUDS[sky]
  const sunny = day && (sky === 'clear' || code === 2)
  const stars = !day && (sky === 'clear' || code === 2)
  return (
    <div className={`wa-sky is-${sky} ${day ? 'is-day' : 'is-night'}`} aria-hidden>
      {sunny && <i className="wa-sky-sun" />}
      {!day && sky === 'clear' && <i className="wa-sky-moon" />}
      {stars && (
        <>
          <i className="wa-sky-stars" />
          <i className="wa-sky-stars is-b" />
        </>
      )}
      {Array.from({ length: clouds }, (_, k) => (
        <i key={k} className={`wa-cloud is-c${k}`} />
      ))}
      {sky === 'fog' && (
        <>
          <i className="wa-sky-fog" />
          <i className="wa-sky-fog is-b" />
        </>
      )}
      {(sky === 'rain' || sky === 'storm') && (
        <span className="wa-sky-tilt">
          <i className="wa-sky-rain" />
          <i className="wa-sky-rain is-b" />
        </span>
      )}
      {sky === 'snow' && (
        <>
          <i className="wa-sky-snow" />
          <i className="wa-sky-snow is-b" />
        </>
      )}
      {sky === 'storm' && <i className="wa-sky-flash" />}
    </div>
  )
}

/** A number that counts to its value when it first shows and tweens when it changes. */
export function CountUp({ value, fmt = (n: number) => String(Math.round(n)), className }: { value: number; fmt?: (n: number) => string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const shown = useRef<number | null>(null)
  const fmtRef = useRef(fmt)
  fmtRef.current = fmt
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const to = value
    const from = shown.current ?? (Math.abs(to) < 4 ? 0 : to - Math.sign(to) * Math.min(Math.abs(to), 12))
    if (reducedMotion() || from === to || !Number.isFinite(to)) {
      shown.current = to
      el.textContent = fmtRef.current(to)
      return
    }
    let raf = 0
    const start = performance.now()
    const dur = 650
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / dur)
      const e = 1 - (1 - k) ** 3
      const v = from + (to - from) * e
      shown.current = v
      el.textContent = fmtRef.current(k >= 1 ? to : v)
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    el.textContent = fmtRef.current(from)
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <span ref={ref} className={`wa-num${className ? ` ${className}` : ''}`} />
}

/** A weather emoji with a gentle motion that suits it (sun turns, clouds drift, rain bobs). */
export function WxIcon({ icon, sky, className }: { icon: string; sky: SkyKind; className?: string }) {
  return (
    <span className={`wa-ico is-${sky} ${className ?? ''}`} aria-hidden>
      {icon}
    </span>
  )
}
