import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { flagPref } from './localPref'
import { FrameSampler, type FrameStats } from './frameStats'
import './performance.css'

export const performanceOverlayPref = flagPref('mvlos.performance-overlay', false)

function Counter() {
  const [stats, setStats] = useState<FrameStats | null>(null)
  const [host, setHost] = useState<Element>(() => document.fullscreenElement ?? document.body)
  useEffect(() => {
    const sampler = new FrameSampler()
    let raf = 0
    const frame = (now: number) => {
      const next = sampler.frame(now)
      if (next) setStats(next)
      raf = requestAnimationFrame(frame)
    }
    const visibility = () => {
      cancelAnimationFrame(raf)
      sampler.reset()
      setStats(null)
      if (!document.hidden) raf = requestAnimationFrame(frame)
    }
    const fullscreen = () => setHost(document.fullscreenElement ?? document.body)
    visibility()
    document.addEventListener('visibilitychange', visibility)
    document.addEventListener('fullscreenchange', fullscreen)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', visibility)
      document.removeEventListener('fullscreenchange', fullscreen)
    }
  }, [])
  return createPortal(
    <div className="performance-overlay" aria-label="Page frame timing" title="Page animation callback rate, not game simulation or displayed-frame rate. Follows the browser's refresh cadence.">
      <strong>Page {stats ? `${Math.round(stats.fps)} FPS` : 'measuring…'}</strong>
      <span>{stats ? `p50 ${stats.p50.toFixed(1)} · p95 ${stats.p95.toFixed(1)} ms` : 'Frame intervals'}</span>
    </div>,
    host,
  )
}

/** Kept outside the desktop and game trees so sampling never re-renders their UI. */
export function PerformanceOverlay() {
  return performanceOverlayPref.use() ? <Counter /> : null
}
