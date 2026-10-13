export type FrameStats = { fps: number; p50: number; p95: number }

/** One second of page animation callbacks, with bounded storage and no per-frame allocation. */
export class FrameSampler {
  private intervals = new Float64Array(1024)
  private previous: number | null = null
  private elapsed = 0
  private count = 0

  reset() {
    this.previous = null
    this.elapsed = 0
    this.count = 0
  }

  frame(now: number): FrameStats | null {
    const previous = this.previous
    this.previous = now
    if (previous === null) return null
    const interval = now - previous
    if (interval <= 0) return null
    this.intervals[this.count % this.intervals.length] = interval
    this.count++
    this.elapsed += interval
    if (this.elapsed < 1000) return null
    const sorted = this.intervals.slice(0, Math.min(this.count, this.intervals.length)).sort()
    const result = {
      fps: (this.count * 1000) / this.elapsed,
      p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    }
    this.elapsed = 0
    this.count = 0
    return result
  }
}
