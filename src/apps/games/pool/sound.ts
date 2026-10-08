// Pool sounds, synthesised with Web Audio so there are no files to load: the click of phenolic
// balls, the tip on the cue ball, the thud of a cushion, a ball dropping and rolling down the
// return, and the hiss of balls rolling on the cloth.

const MUTE_KEY = 'mvlos.pool.muted'
const VOLUME_KEY = 'mvlos.pool.volume'

type Mode = [freq: number, decay: number, amp: number]

// A struck ball rings at a few inharmonic modes that die within milliseconds; the hit itself is a
// fraction of a millisecond of broadband contact noise. Each call detunes the modes a little, so
// no two clicks are identical.
const BALL: Mode[] = [
  [380, 0.006, 0.55], // the weight: a heavy ball's low-mid thock
  [620, 0.005, 0.7],
  [1050, 0.0045, 0.9],
  [1700, 0.0035, 1],
  [2500, 0.0025, 0.7],
  [3500, 0.0018, 0.45],
  [5000, 0.0012, 0.25],
]
// Leather tip on phenolic: softer contact, lower and shorter.
const TIP: Mode[] = [
  [420, 0.008, 0.5],
  [900, 0.006, 1],
  [1650, 0.004, 0.6],
  [2900, 0.003, 0.4],
]

function impact(ctx: BaseAudioContext, modes: Mode[], click: number, contact: number) {
  const sr = ctx.sampleRate
  const n = Math.ceil(0.06 * sr)
  const buf = ctx.createBuffer(1, n, sr)
  const d = buf.getChannelData(0)
  for (const [f, tau, a] of modes) {
    const w = 2 * Math.PI * f * (0.97 + Math.random() * 0.06)
    const ph = Math.random() * 2 * Math.PI
    for (let i = 0; i < n; i++) {
      const t = i / sr
      d[i] += a * Math.exp(-t / tau) * Math.sin(w * t + ph)
    }
  }
  const cn = Math.max(2, Math.ceil(contact * sr))
  let lp = 0
  for (let i = 0; i < cn; i++) {
    lp += 0.35 * (Math.random() * 2 - 1 - lp) // smoothed, so the snap has body rather than fizz
    d[i] += click * 2.5 * lp * (1 - i / cn)
  }
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]))
  for (let i = 0; i < n; i++) d[i] *= 0.9 / peak
  return buf
}

export class PoolSound {
  private ctx: AudioContext | null = null
  private out: GainNode | null = null
  private noise: AudioBuffer | null = null
  private rollGain: GainNode | null = null
  private recent: number[] = []
  private clicks: AudioBuffer[] = []
  private tips: AudioBuffer[] = []
  muted = false
  /** 0 to 1, on top of mute. */
  volume = 0.8

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1'
      const v = Number(localStorage.getItem(VOLUME_KEY))
      if (localStorage.getItem(VOLUME_KEY) !== null && v >= 0 && v <= 1) this.volume = v
    } catch {
      /* defaults */
    }
  }

  private save(key: string, value: string) {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* the choice just won't persist */
    }
  }

  private applyGain() {
    // Squared, so the slider feels even to the ear rather than all happening at the top.
    if (this.out && this.ctx) this.out.gain.setTargetAtTime(this.muted ? 0 : this.volume * this.volume, this.ctx.currentTime, 0.02)
  }

  setMuted(m: boolean) {
    this.muted = m
    this.save(MUTE_KEY, m ? '1' : '0')
    this.applyGain()
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v))
    this.save(VOLUME_KEY, String(this.volume))
    if (this.muted && v > 0) this.setMuted(false)
    else this.applyGain()
  }

  /** Browsers only allow audio after a user gesture, so this is called from one. */
  wake() {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      this.ctx = ctx
      this.out = ctx.createGain()
      this.out.gain.value = this.muted ? 0 : this.volume * this.volume
      const comp = ctx.createDynamicsCompressor()
      comp.threshold.value = -14
      comp.ratio.value = 6
      this.out.connect(comp).connect(ctx.destination)
      this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
      const d = this.noise.getChannelData(0)
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
      for (let i = 0; i < 8; i++) this.clicks.push(impact(ctx, BALL, 1, 0.0008))
      for (let i = 0; i < 4; i++) this.tips.push(impact(ctx, TIP, 0.6, 0.0012))
      // Rolling: filtered noise, always running, its gain following how fast balls are rolling.
      const src = ctx.createBufferSource()
      src.buffer = this.noise
      src.loop = true
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 220
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = 60
      this.rollGain = ctx.createGain()
      this.rollGain.gain.value = 0
      src.connect(lp).connect(hp).connect(this.rollGain).connect(this.out)
      src.start()
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  dispose() {
    void this.ctx?.close()
    this.ctx = null
  }

  private ready() {
    return this.ctx && this.out && this.noise && !this.muted ? this.ctx : null
  }

  /** At most a handful of sounds in any 30 ms, or a break would be a wall of noise. */
  private allow() {
    const now = performance.now()
    this.recent = this.recent.filter((t) => now - t < 30)
    if (this.recent.length >= 5) return false
    this.recent.push(now)
    return true
  }

  private burst(ctx: AudioContext, at: number, dur: number, type: BiquadFilterType, freq: number, q: number, gain: number) {
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = q
    const g = ctx.createGain()
    g.gain.setValueAtTime(gain, at)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    src.connect(f).connect(g).connect(this.out!)
    src.start(at, Math.random() * 0.5)
    src.stop(at + dur + 0.02)
  }

  private tone(ctx: AudioContext, at: number, dur: number, f0: number, f1: number, gain: number, type: OscillatorType = 'sine') {
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(f0, at)
    o.frequency.exponentialRampToValueAtTime(f1, at + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(gain, at)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    o.connect(g).connect(this.out!)
    o.start(at)
    o.stop(at + dur + 0.02)
  }

  /** Plays one of the impact buffers: harder hits are louder and brighter. */
  private hit(ctx: AudioContext, bufs: AudioBuffer[], gain: number, bright: number, pan: number) {
    const src = ctx.createBufferSource()
    src.buffer = bufs[Math.floor(Math.random() * bufs.length)]
    src.playbackRate.value = 0.95 + Math.random() * 0.1
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = bright
    const g = ctx.createGain()
    g.gain.value = gain
    const p = ctx.createStereoPanner()
    p.pan.value = Math.max(-1, Math.min(1, pan))
    src.connect(lp).connect(g).connect(p).connect(this.out!)
    src.start()
  }

  /** Two balls meeting at `speed` m/s; `pan` is where on the table, -1 left to 1 right. */
  clack(speed: number, pan = 0) {
    const ctx = this.ready()
    if (!ctx || speed < 0.02 || !this.allow()) return
    const k = Math.min(1, speed / 2.5)
    this.hit(ctx, this.clicks, Math.min(1, Math.pow(speed / 3, 0.8)) * 0.95, 1800 + 5500 * k, pan * 0.6)
  }

  /** The tip on the cue ball, and the cue ball's own click. */
  cue(speed: number, pan = 0) {
    const ctx = this.ready()
    if (!ctx) return
    const k = Math.min(1, speed / 7)
    this.hit(ctx, this.tips, 0.3 + 0.5 * k, 1800 + 5000 * k, pan * 0.6)
    this.hit(ctx, this.clicks, 0.08 + 0.15 * k, 2000 + 3500 * k, pan * 0.6)
    this.tone(ctx, ctx.currentTime, 0.05, 220, 140, 0.15 + 0.25 * k)
  }

  /** A ball into a cushion. */
  rail(speed: number) {
    const ctx = this.ready()
    if (!ctx || speed < 0.05 || !this.allow()) return
    const v = Math.min(1, speed / 3.5) * 0.7
    const t = ctx.currentTime
    this.tone(ctx, t, 0.12, 130, 70, v)
    this.burst(ctx, t, 0.05, 'lowpass', 700, 0.8, v * 0.8)
    this.burst(ctx, t, 0.01, 'bandpass', 2200, 2, v * 0.2)
  }

  /** A ball going down, then knocking along the ball return. */
  pocket() {
    const ctx = this.ready()
    if (!ctx) return
    const t = ctx.currentTime
    this.tone(ctx, t, 0.16, 180, 85, 0.6)
    this.burst(ctx, t, 0.06, 'lowpass', 900, 0.7, 0.45)
    let at = t + 0.18
    for (let i = 0; i < 4; i++) {
      const g = 0.32 * Math.pow(0.6, i)
      this.tone(ctx, at, 0.07, 260 - i * 25, 140, g)
      this.burst(ctx, at, 0.03, 'bandpass', 1500, 1.5, g * 0.6)
      at += 0.12 + Math.random() * 0.12
    }
    this.tone(ctx, at + 0.15, 0.12, 320, 200, 0.18, 'triangle')
  }

  /** `speed` is the sum of every ball's speed, in m/s. */
  roll(speed: number) {
    if (!this.ctx || !this.rollGain) return
    const g = Math.min(0.03, speed * 0.00625)
    this.rollGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.08)
  }
}
