import type { WeaponKind } from './data'

// Empires At War sounds, synthesised with Web Audio like the other games: blaster pews that drop
// in pitch, deep turbolaser shots, flak pops, missile whooshes, shield shimmers, explosions with a
// sub thump for big ships, interface blips, and a low drone for the void. Sounds from the battle
// are panned and quietened by where they happen relative to the camera, and rate-limited so a
// hundred droids firing at once doesn't clip.

const MUTE_KEY = 'mvlos.empires.muted'
const VOLUME_KEY = 'mvlos.empires.volume'

type Where = { pan: number; gain: number }

export class EmpiresSound {
  private ctx: AudioContext | null = null
  private out: GainNode | null = null
  private noise: AudioBuffer | null = null
  private drone: { stop: () => void } | null = null
  private recent = new Map<string, number[]>()
  muted: boolean
  volume: number

  constructor() {
    let m = false
    let v = 0.7
    try {
      m = localStorage.getItem(MUTE_KEY) === '1'
      const raw = localStorage.getItem(VOLUME_KEY)
      if (raw) v = Math.min(1, Math.max(0, Number(raw)))
    } catch {
      // Private mode: defaults.
    }
    this.muted = m
    this.volume = v
  }

  /** Browsers only allow audio after a click or key press. */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return
      this.ctx = new Ctx()
      this.out = this.ctx.createGain()
      const comp = this.ctx.createDynamicsCompressor()
      comp.threshold.value = -14
      comp.ratio.value = 6
      this.out.connect(comp).connect(this.ctx.destination)
      this.applyVolume()
      const n = this.ctx.sampleRate * 2
      this.noise = this.ctx.createBuffer(1, n, this.ctx.sampleRate)
      const d = this.noise.getChannelData(0)
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  private applyVolume() {
    if (this.out) this.out.gain.value = this.muted ? 0 : this.volume * 0.55
  }

  setMuted(m: boolean) {
    this.muted = m
    try {
      localStorage.setItem(MUTE_KEY, m ? '1' : '0')
    } catch {
      // ignore
    }
    this.applyVolume()
  }

  setVolume(v: number) {
    this.volume = v
    try {
      localStorage.setItem(VOLUME_KEY, String(v))
    } catch {
      // ignore
    }
    this.applyVolume()
  }

  /** At most `max` of one kind of sound per `window` seconds. */
  private allow(kind: string, max: number, window = 0.08) {
    if (!this.ctx) return false
    const now = this.ctx.currentTime
    const list = (this.recent.get(kind) ?? []).filter((t) => now - t < window)
    if (list.length >= max) return false
    list.push(now)
    this.recent.set(kind, list)
    return true
  }

  private bus(where: Where) {
    const ctx = this.ctx!
    const g = ctx.createGain()
    g.gain.value = where.gain
    const p = ctx.createStereoPanner()
    p.pan.value = Math.max(-1, Math.min(1, where.pan))
    g.connect(p).connect(this.out!)
    setTimeout(() => {
      g.disconnect()
      p.disconnect()
    }, 4000)
    return g
  }

  private tone(dest: AudioNode, type: OscillatorType, f0: number, f1: number, len: number, peak: number, delay = 0) {
    const ctx = this.ctx!
    const t = ctx.currentTime + delay
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = type
    o.frequency.setValueAtTime(f0, t)
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + len)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(peak, t + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0001, t + len)
    o.connect(g).connect(dest)
    o.start(t)
    o.stop(t + len + 0.05)
  }

  private hiss(dest: AudioNode, type: BiquadFilterType, f0: number, f1: number, q: number, len: number, peak: number, delay = 0, attack = 0.004) {
    const ctx = this.ctx!
    const t = ctx.currentTime + delay
    const s = ctx.createBufferSource()
    s.buffer = this.noise
    s.playbackRate.value = 0.8 + Math.random() * 0.4
    const f = ctx.createBiquadFilter()
    f.type = type
    f.Q.value = q
    f.frequency.setValueAtTime(f0, t)
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + len)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(peak, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + len)
    s.connect(f).connect(g).connect(dest)
    s.start(t, Math.random() * 1.5)
    s.stop(t + len + 0.05)
  }

  fire(kind: WeaponKind, where: Where, droid: boolean) {
    if (!this.ctx || this.muted || where.gain < 0.03) return
    const d = droid ? 0.85 : 1
    if (kind === 'laser') {
      if (!this.allow('laser', 3)) return
      const b = this.bus(where)
      const f = (1500 + Math.random() * 300) * d
      this.tone(b, 'sawtooth', f, f * 0.22, 0.14, 0.12)
      this.tone(b, 'sine', f * 1.5, f * 0.3, 0.1, 0.1)
    } else if (kind === 'turbo') {
      if (!this.allow('turbo', 3, 0.1)) return
      const b = this.bus(where)
      const f = (520 + Math.random() * 80) * d
      this.tone(b, 'sawtooth', f, 70, 0.32, 0.22)
      this.tone(b, 'square', f * 0.5, 45, 0.3, 0.12)
      this.hiss(b, 'lowpass', 2400, 300, 0.7, 0.18, 0.18)
    } else if (kind === 'flak') {
      if (!this.allow('flak', 3)) return
      const b = this.bus(where)
      this.hiss(b, 'bandpass', 1800 + Math.random() * 600, 600, 2, 0.06, 0.35)
      this.tone(b, 'triangle', 300, 120, 0.05, 0.15)
    } else if (kind === 'missile') {
      if (!this.allow('missile', 2, 0.15)) return
      const b = this.bus(where)
      this.hiss(b, 'bandpass', 500, 3500, 3, 0.5, 0.3, 0, 0.08)
    }
  }

  hit(shield: boolean, heavy: boolean, where: Where) {
    if (!this.ctx || this.muted || where.gain < 0.03) return
    if (shield) {
      if (!this.allow('shield', 2, 0.1)) return
      const b = this.bus({ ...where, gain: where.gain * 0.6 })
      this.tone(b, 'sine', 2200 + Math.random() * 400, 1400, 0.18, 0.08)
      this.tone(b, 'sine', 3300, 2600, 0.12, 0.05, 0.02)
    } else {
      if (!this.allow('hull', heavy ? 3 : 2, 0.1)) return
      const b = this.bus(where)
      this.hiss(b, 'lowpass', heavy ? 2500 : 4000, 300, 1, heavy ? 0.25 : 0.1, heavy ? 0.45 : 0.2)
      this.tone(b, 'triangle', heavy ? 160 : 400, 60, 0.15, heavy ? 0.3 : 0.1)
    }
  }

  boom(size: number, where: Where) {
    if (!this.ctx || this.muted || where.gain < 0.02) return
    const big = size > 100
    if (!this.allow(big ? 'bigboom' : 'boom', big ? 3 : 4, 0.15)) return
    const b = this.bus({ ...where, gain: Math.min(1, where.gain * (big ? 1.4 : 1)) })
    const len = big ? 2.2 : 0.5 + size / 200
    this.hiss(b, 'lowpass', big ? 1400 : 2600, 50, 0.8, len, big ? 0.9 : 0.55)
    this.tone(b, 'sine', big ? 90 : 160, 30, len * 0.7, big ? 0.8 : 0.4)
    if (big) {
      // Secondary blasts rumbling on.
      for (let i = 1; i <= 3; i++) this.hiss(b, 'lowpass', 900, 60, 0.8, 0.8, 0.4, i * 0.25 + Math.random() * 0.1)
    }
  }

  // --- Interface -------------------------------------------------------------------------------------

  private ui() {
    return this.bus({ pan: 0, gain: 0.8 })
  }

  click() {
    if (!this.ctx || this.muted) return
    this.tone(this.ui(), 'sine', 1400, 900, 0.05, 0.12)
  }

  order(attack = false) {
    if (!this.ctx || this.muted || !this.allow('order', 1, 0.1)) return
    const b = this.ui()
    this.tone(b, 'square', attack ? 520 : 660, attack ? 380 : 880, 0.07, 0.06)
    this.tone(b, 'sine', attack ? 780 : 990, attack ? 600 : 1320, 0.08, 0.08, 0.06)
  }

  error() {
    if (!this.ctx || this.muted || !this.allow('error', 1, 0.2)) return
    const b = this.ui()
    this.tone(b, 'square', 180, 150, 0.12, 0.08)
    this.tone(b, 'square', 150, 120, 0.14, 0.08, 0.13)
  }

  built() {
    if (!this.ctx || this.muted || !this.allow('built', 1, 0.3)) return
    const b = this.ui()
    this.tone(b, 'sine', 880, 880, 0.14, 0.12)
    this.tone(b, 'sine', 1320, 1320, 0.2, 0.12, 0.1)
  }

  alarm() {
    if (!this.ctx || this.muted) return
    const b = this.ui()
    for (let i = 0; i < 3; i++) this.tone(b, 'sawtooth', 660, 520, 0.16, 0.08, i * 0.22)
  }

  capture(ours: boolean) {
    if (!this.ctx || this.muted) return
    const b = this.ui()
    const notes = ours ? [523, 659, 784, 1047] : [784, 659, 523, 392]
    notes.forEach((f, i) => this.tone(b, 'triangle', f, f, 0.18, 0.14, i * 0.09))
  }

  fanfare() {
    if (!this.ctx || this.muted) return
    const b = this.ui()
    ;[392, 523, 659, 784, 1047].forEach((f, i) => {
      this.tone(b, 'sawtooth', f, f, 0.3, 0.06, i * 0.12)
      this.tone(b, 'triangle', f, f, 0.35, 0.12, i * 0.12)
    })
  }

  defeat() {
    if (!this.ctx || this.muted) return
    const b = this.ui()
    ;[392, 349, 311, 262].forEach((f, i) => this.tone(b, 'sawtooth', f, f * 0.98, 0.5, 0.08, i * 0.35))
  }

  ability() {
    if (!this.ctx || this.muted) return
    const b = this.ui()
    this.tone(b, 'sine', 300, 1200, 0.35, 0.15)
    this.hiss(b, 'bandpass', 400, 4000, 4, 0.4, 0.15)
  }

  /** The hum of a ship's bridge in deep space. */
  startDrone() {
    if (!this.ctx || this.drone) return
    const ctx = this.ctx
    const g = ctx.createGain()
    g.gain.value = 0.0001
    g.gain.exponentialRampToValueAtTime(0.09, ctx.currentTime + 3)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = 260
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.07
    const lg = ctx.createGain()
    lg.gain.value = 120
    lfo.connect(lg).connect(f.frequency)
    const oscs = [55, 55.4, 82.4, 110.3].map((fr) => {
      const o = ctx.createOscillator()
      o.type = fr > 100 ? 'triangle' : 'sawtooth'
      o.frequency.value = fr
      o.connect(f)
      o.start()
      return o
    })
    f.connect(g).connect(this.out!)
    lfo.start()
    this.drone = {
      stop: () => {
        const t = ctx.currentTime
        g.gain.cancelScheduledValues(t)
        g.gain.setValueAtTime(g.gain.value, t)
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6)
        setTimeout(() => {
          for (const o of oscs) o.stop()
          lfo.stop()
          g.disconnect()
        }, 800)
      },
    }
  }

  stopDrone() {
    this.drone?.stop()
    this.drone = null
  }

  dispose() {
    this.stopDrone()
    void this.ctx?.close()
    this.ctx = null
  }
}
