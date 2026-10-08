// Gladiator sounds, all synthesised with Web Audio like Pool's: struck metal and wood, blows on
// flesh, blade whooshes and grunts, a crowd that murmurs, cheers and boos, spells, coins and a
// fanfare. Music too: war drums in the arena and a plucked lyre in town, generated as it plays.

const MUTE_KEY = 'mvlos.gladiator.muted'
const VOLUME_KEY = 'mvlos.gladiator.volume'
const MUSIC_KEY = 'mvlos.gladiator.music'

type Mode = [ratio: number, decay: number, amp: number]
// A blade or helmet rings at inharmonic partials like a struck plate.
const METAL: Mode[] = [
  [1, 0.42, 1],
  [2.32, 0.3, 0.7],
  [4.25, 0.2, 0.55],
  [6.63, 0.14, 0.4],
  [9.38, 0.09, 0.3],
  [12.1, 0.06, 0.2],
]
const WOOD: Mode[] = [
  [1, 0.05, 1],
  [2.1, 0.035, 0.6],
  [3.9, 0.02, 0.4],
]

function modal(ctx: BaseAudioContext, f0: number, modes: Mode[], noise: number, len: number) {
  const sr = ctx.sampleRate
  const n = Math.ceil(len * sr)
  const buf = ctx.createBuffer(1, n, sr)
  const d = buf.getChannelData(0)
  for (const [ratio, tau, a] of modes) {
    const w = 2 * Math.PI * f0 * ratio * (0.98 + Math.random() * 0.04)
    const ph = Math.random() * 6.28
    for (let i = 0; i < n; i++) d[i] += a * Math.exp(-i / sr / tau) * Math.sin(w * (i / sr) + ph)
  }
  const cn = Math.ceil(0.004 * sr)
  for (let i = 0; i < cn; i++) d[i] += noise * (Math.random() * 2 - 1) * (1 - i / cn)
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]))
  for (let i = 0; i < n; i++) d[i] *= 0.9 / peak
  return buf
}

/** A plucked string by Karplus-Strong: a burst of noise ringing round a damped delay line. */
function pluck(ctx: BaseAudioContext, freq: number, len = 1.6) {
  const sr = ctx.sampleRate
  const n = Math.ceil(len * sr)
  const buf = ctx.createBuffer(1, n, sr)
  const d = buf.getChannelData(0)
  const p = Math.max(2, Math.round(sr / freq))
  const line = new Float32Array(p)
  for (let i = 0; i < p; i++) line[i] = Math.random() * 2 - 1
  let idx = 0
  for (let i = 0; i < n; i++) {
    const next = (idx + 1) % p
    const v = 0.5 * (line[idx] + line[next]) * 0.996
    d[i] = line[idx]
    line[idx] = v
    idx = next
  }
  return buf
}

const NOTE = (semi: number) => 293.66 * Math.pow(2, semi / 12) // D4 based
// D dorian, two octaves, for the lyre.
const DORIAN = [-12, -10, -9, -7, -5, -3, -2, 0, 2, 3, 5, 7, 9, 10, 12]

export class GladiatorSound {
  private ctx: AudioContext | null = null
  private out: GainNode | null = null
  private sfx: GainNode | null = null
  private musicBus: GainNode | null = null
  private verb: GainNode | null = null
  private noise: AudioBuffer | null = null
  private clangs: AudioBuffer[] = []
  private woods: AudioBuffer[] = []
  private plucks = new Map<number, AudioBuffer>()
  private crowdGain: GainNode | null = null
  private crowdFilters: BiquadFilterNode[] = []
  private crowdBase = 0.05
  private music: { kind: 'arena' | 'town'; timer: ReturnType<typeof setInterval>; next: number; step: number } | null = null
  private wantMusic: 'arena' | 'town' | null = null
  intensity = 0.3
  muted = false
  volume = 0.8
  musicOn = true

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1'
      this.musicOn = localStorage.getItem(MUSIC_KEY) !== '0'
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

  setMusic(on: boolean) {
    this.musicOn = on
    this.save(MUSIC_KEY, on ? '1' : '0')
    if (this.musicBus && this.ctx) this.musicBus.gain.setTargetAtTime(on ? 0.5 : 0, this.ctx.currentTime, 0.1)
  }

  private applyGain() {
    if (this.out && this.ctx) this.out.gain.setTargetAtTime(this.muted ? 0 : this.volume * this.volume, this.ctx.currentTime, 0.02)
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
      comp.threshold.value = -12
      comp.ratio.value = 5
      this.out.connect(comp).connect(ctx.destination)
      this.sfx = ctx.createGain()
      this.sfx.connect(this.out)
      this.musicBus = ctx.createGain()
      this.musicBus.gain.value = this.musicOn ? 0.5 : 0
      this.musicBus.connect(this.out)

      this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
      const d = this.noise.getChannelData(0)
      // Pinkish noise: warmer than white, better for crowds and dust.
      let b0 = 0
      let b1 = 0
      let b2 = 0
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1
        b0 = 0.99765 * b0 + w * 0.099046
        b1 = 0.963 * b1 + w * 0.2965164
        b2 = 0.57 * b2 + w * 1.0526913
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2
      }

      // A short, dry room: the arena's walls.
      const conv = ctx.createConvolver()
      const ir = ctx.createBuffer(2, ctx.sampleRate * 1.4, ctx.sampleRate)
      for (let c = 0; c < 2; c++) {
        const ch = ir.getChannelData(c)
        for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, 3.2)
      }
      conv.buffer = ir
      this.verb = ctx.createGain()
      this.verb.gain.value = 0.25
      this.verb.connect(conv).connect(this.out)

      this.clangs = []
      this.woods = []
      for (let i = 0; i < 5; i++) this.clangs.push(modal(ctx, 620 + Math.random() * 380, METAL, 1.2, 0.7))
      for (let i = 0; i < 3; i++) this.woods.push(modal(ctx, 190 + Math.random() * 60, WOOD, 0.8, 0.18))
      for (const s of DORIAN) this.plucks.set(s, pluck(ctx, NOTE(s)))

      // The crowd: noise through vowel-ish bands, its level drifting like a real murmur.
      const src = ctx.createBufferSource()
      src.buffer = this.noise
      src.loop = true
      this.crowdGain = ctx.createGain()
      this.crowdGain.gain.value = 0
      for (const [f, q, g] of [[420, 1.2, 1], [1000, 1.4, 0.7], [2400, 1.6, 0.35]] as const) {
        const bp = ctx.createBiquadFilter()
        bp.type = 'bandpass'
        bp.frequency.value = f
        bp.Q.value = q
        const gg = ctx.createGain()
        gg.gain.value = g
        src.connect(bp).connect(gg).connect(this.crowdGain)
        this.crowdFilters.push(bp)
      }
      this.crowdGain.connect(this.out)
      src.start()
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    if (this.wantMusic && !this.music) this.startMusic(this.wantMusic)
  }

  dispose() {
    this.stopMusic()
    void this.ctx?.close()
    this.ctx = null
  }

  private ready() {
    return this.ctx && this.sfx && this.noise ? this.ctx : null
  }

  private play(buf: AudioBuffer, gain: number, pan = 0, rate = 1, at = 0, wet = 0.3) {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const g = ctx.createGain()
    g.gain.value = gain
    const p = ctx.createStereoPanner()
    p.pan.value = Math.max(-1, Math.min(1, pan))
    src.connect(g).connect(p).connect(this.sfx!)
    if (wet) {
      const w = ctx.createGain()
      w.gain.value = wet
      p.connect(w).connect(this.verb!)
    }
    src.start(ctx.currentTime + at)
  }

  private burst(at: number, dur: number, type: BiquadFilterType, freq: number, q: number, gain: number, pan = 0, sweepTo?: number, bus?: AudioNode) {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.setValueAtTime(freq, at)
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, at + dur)
    f.Q.value = q
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(gain, at + Math.min(0.02, dur / 4))
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    src.connect(f).connect(g).connect(p).connect(bus ?? this.sfx!)
    src.start(at, Math.random() * 1.5)
    src.stop(at + dur + 0.05)
  }

  private tone(at: number, dur: number, f0: number, f1: number, gain: number, type: OscillatorType = 'sine', bus?: AudioNode, attack = 0.005) {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(f0, at)
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, at + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(gain, at + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    o.connect(g).connect(bus ?? this.sfx!)
    o.start(at)
    o.stop(at + dur + 0.05)
  }

  // --- Combat ----------------------------------------------------------------------------------

  /** A blade swishing through the air; `power` 0..1. */
  whoosh(power = 0.5, pan = 0) {
    const ctx = this.ready()
    if (!ctx) return
    const t = ctx.currentTime
    this.burst(t, 0.16 + power * 0.14, 'bandpass', 500, 2.2, 0.25 + power * 0.35, pan, 2400 + power * 1200)
  }

  /** Steel on steel. */
  clang(power = 0.6, pan = 0) {
    const ctx = this.ready()
    if (!ctx) return
    this.play(this.clangs[Math.floor(Math.random() * this.clangs.length)], 0.35 + power * 0.4, pan, 0.85 + Math.random() * 0.3, 0, 0.45)
    this.burst(ctx.currentTime, 0.05, 'highpass', 3000, 0.7, 0.25 * power, pan)
  }

  /** A blow landing on a body: a dull thump with a wet edge. */
  thud(power = 0.6, pan = 0) {
    const ctx = this.ready()
    if (!ctx) return
    const t = ctx.currentTime
    this.tone(t, 0.18, 120 + power * 30, 45, 0.5 + power * 0.4)
    this.burst(t, 0.09, 'lowpass', 900, 0.8, 0.5 + power * 0.3, pan)
    this.burst(t + 0.01, 0.07, 'bandpass', 1400, 3, 0.18 + power * 0.2, pan, 500)
  }

  /** A blow caught on a shield. */
  block(pan = 0) {
    const ctx = this.ready()
    if (!ctx) return
    this.play(this.woods[Math.floor(Math.random() * this.woods.length)], 0.8, pan, 0.9 + Math.random() * 0.2, 0, 0.35)
    this.clang(0.25, pan)
  }

  step(pan = 0) {
    const ctx = this.ready()
    if (!ctx) return
    const t = ctx.currentTime
    this.burst(t, 0.07, 'lowpass', 380, 0.7, 0.22, pan)
    this.burst(t, 0.04, 'highpass', 2600, 0.7, 0.05, pan)
  }

  /** A short vocal grunt through two formants: effort on a swing, pain on a hit. */
  grunt(kind: 'effort' | 'pain' | 'shout', pitch = 1, pan = 0) {
    const ctx = this.ready()
    if (!ctx) return
    const t = ctx.currentTime
    const f0 = (kind === 'pain' ? 190 : kind === 'shout' ? 170 : 130) * pitch
    const dur = kind === 'shout' ? 0.38 : kind === 'pain' ? 0.24 : 0.16
    const o = ctx.createOscillator()
    o.type = 'sawtooth'
    o.frequency.setValueAtTime(f0, t)
    o.frequency.exponentialRampToValueAtTime(f0 * (kind === 'shout' ? 0.9 : 0.7), t + dur)
    const [F1, F2] = kind === 'pain' ? [800, 1250] : kind === 'shout' ? [750, 1150] : [550, 950]
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    for (const [f, q, a] of [[F1, 6, 1], [F2, 8, 0.6], [2600, 10, 0.2]] as const) {
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = f
      bp.Q.value = q
      const gg = ctx.createGain()
      gg.gain.value = a
      o.connect(bp).connect(gg).connect(g)
    }
    g.connect(p).connect(this.sfx!)
    // A breath of noise makes it sound less like a kazoo.
    this.burst(t, dur, 'bandpass', F2, 2, 0.08, pan)
    o.start(t)
    o.stop(t + dur + 0.05)
  }

  /** The big one: a body hitting the sand. */
  fall(pan = 0) {
    const ctx = this.ready()
    if (!ctx) return
    const t = ctx.currentTime
    this.tone(t, 0.4, 90, 35, 0.9)
    this.burst(t, 0.3, 'lowpass', 600, 0.6, 0.7, pan)
    this.clang(0.3, pan)
  }

  // --- Crowd -----------------------------------------------------------------------------------

  /** The murmur's level, 0..1, as the fight heats up. */
  crowd(level: number) {
    if (!this.ctx || !this.crowdGain) return
    this.crowdBase = 0.03 + level * 0.09
    this.crowdGain.gain.setTargetAtTime(this.crowdBase, this.ctx.currentTime, 0.6)
  }

  /** A swell of cheering, with whistles on the big ones. */
  cheer(size = 0.5) {
    const ctx = this.ready()
    if (!ctx || !this.crowdGain) return
    const t = ctx.currentTime
    const peak = this.crowdBase + 0.1 + size * 0.3
    this.crowdGain.gain.cancelScheduledValues(t)
    this.crowdGain.gain.setTargetAtTime(peak, t, 0.08)
    this.crowdGain.gain.setTargetAtTime(this.crowdBase, t + 0.5 + size * 1.2, 0.5)
    for (const f of this.crowdFilters) {
      f.frequency.cancelScheduledValues(t)
      const base = f.frequency.value
      f.frequency.setTargetAtTime(base * 1.25, t, 0.1)
      f.frequency.setTargetAtTime(base, t + 0.8 + size, 0.6)
    }
    const whistles = Math.round(size * 4)
    for (let i = 0; i < whistles; i++) {
      const at = t + 0.1 + Math.random() * 0.8
      const f = 1800 + Math.random() * 1200
      this.tone(at, 0.25 + Math.random() * 0.3, f, f * (1.1 + Math.random() * 0.2), 0.03 + size * 0.03, 'sine', undefined, 0.03)
    }
  }

  /** A low, rolling boo. */
  boo() {
    const ctx = this.ready()
    if (!ctx) return
    const t = ctx.currentTime
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 520
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.25)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4)
    lp.connect(g).connect(this.sfx!)
    for (let i = 0; i < 8; i++) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      const f = 110 + Math.random() * 80
      o.frequency.setValueAtTime(f, t)
      o.frequency.linearRampToValueAtTime(f * 0.85, t + 1.4)
      o.connect(lp)
      o.start(t + Math.random() * 0.15)
      o.stop(t + 1.5)
    }
  }

  gasp() {
    const ctx = this.ready()
    if (!ctx) return
    this.burst(ctx.currentTime, 0.45, 'bandpass', 900, 1.5, 0.18, 0, 1800)
  }

  /** A gong for the start of a fight. */
  gong() {
    const ctx = this.ready()
    if (!ctx) return
    const t = ctx.currentTime
    for (const [r, a, d] of [[1, 0.5, 2.6], [2.76, 0.3, 1.6], [5.4, 0.15, 0.9], [1.5, 0.2, 2.2]] as const) this.tone(t, d, 98 * r, 98 * r * 0.99, a, 'sine', undefined, 0.01)
    this.burst(t, 0.2, 'lowpass', 2000, 0.6, 0.3)
  }

  // --- Magic and items -------------------------------------------------------------------------

  spell(id: string, phase: 'cast' | 'hit', pan = 0) {
    const ctx = this.ready()
    if (!ctx) return
    const t = ctx.currentTime
    if (phase === 'cast') {
      this.burst(t, 0.4, 'bandpass', 300, 3, 0.2, pan, 2400)
      this.tone(t, 0.4, 440, 880, 0.08, 'triangle')
      return
    }
    switch (id) {
      case 'fireball':
        this.burst(t, 0.5, 'lowpass', 2500, 0.7, 0.6, pan, 300)
        this.tone(t, 0.3, 160, 60, 0.4)
        for (let i = 0; i < 8; i++) this.burst(t + Math.random() * 0.6, 0.02, 'highpass', 3000, 1, 0.12, pan)
        break
      case 'frost':
        for (let i = 0; i < 6; i++) this.tone(t + i * 0.03, 0.6, 2200 + i * 330, 2600 + i * 300, 0.04, 'sine')
        this.burst(t, 0.3, 'highpass', 5000, 0.8, 0.25, pan)
        break
      case 'thunder':
        this.burst(t, 0.08, 'highpass', 800, 0.5, 0.9, pan)
        this.burst(t + 0.03, 1.6, 'lowpass', 160, 0.7, 0.9, pan)
        this.tone(t, 1.2, 60, 30, 0.5)
        break
      case 'heal':
        ;[0, 4, 7, 12, 16].forEach((s, i) => this.tone(t + i * 0.07, 0.7, NOTE(s + 12), NOTE(s + 12), 0.08, 'sine', undefined, 0.01))
        break
      case 'weaken':
        for (let i = 0; i < 3; i++) this.tone(t, 0.8, 300 + i * 7, 120, 0.08, 'sawtooth')
        break
      case 'blind':
        this.tone(t, 0.5, 3000, 1200, 0.12, 'sine')
        this.burst(t, 0.25, 'highpass', 4000, 0.7, 0.3, pan)
        break
    }
  }

  drink() {
    const ctx = this.ready()
    if (!ctx) return
    const t = ctx.currentTime
    for (let i = 0; i < 3; i++) {
      this.tone(t + 0.15 + i * 0.16, 0.08, 260 + Math.random() * 60, 420, 0.25)
      this.burst(t + 0.15 + i * 0.16, 0.06, 'bandpass', 700, 4, 0.15)
    }
    this.tone(t + 0.7, 0.2, 500, 380, 0.08, 'triangle')
  }

  coins(n = 4) {
    const ctx = this.ready()
    if (!ctx) return
    const t = ctx.currentTime
    for (let i = 0; i < n; i++) {
      const at = t + i * 0.06 + Math.random() * 0.03
      const f = 2400 + Math.random() * 900
      this.tone(at, 0.25, f, f, 0.08, 'sine', undefined, 0.002)
      this.tone(at, 0.15, f * 1.5, f * 1.5, 0.05, 'sine', undefined, 0.002)
      this.tone(at, 0.1, f * 2.3, f * 2.3, 0.03, 'sine', undefined, 0.002)
    }
  }

  ui() {
    const ctx = this.ready()
    if (!ctx) return
    this.tone(ctx.currentTime, 0.05, 1200, 900, 0.06, 'triangle')
  }

  /** Brass for a level up or a title. */
  fanfare(big = false) {
    const ctx = this.ready()
    if (!ctx) return
    const t = ctx.currentTime
    const seq: [number, number, number][] = big
      ? [[0, 0, 0.18], [0.18, 0, 0.12], [0.3, 7, 0.18], [0.5, 12, 0.7], [0.5, 4, 0.7], [0.5, 7, 0.7]]
      : [[0, 0, 0.14], [0.15, 4, 0.14], [0.3, 7, 0.14], [0.45, 12, 0.6]]
    for (const [at, s, dur] of seq) this.brass(t + at, NOTE(s - 12), dur)
  }

  private brass(at: number, f: number, dur: number, bus?: AudioNode, gain = 0.16) {
    const ctx = this.ctx!
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(400, at)
    lp.frequency.exponentialRampToValueAtTime(2600, at + 0.06)
    lp.frequency.exponentialRampToValueAtTime(1200, at + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(gain, at + 0.04)
    g.gain.setValueAtTime(gain, at + dur * 0.7)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.15)
    lp.connect(g).connect(bus ?? this.sfx!)
    for (const det of [-6, 6]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = f
      o.detune.value = det
      o.connect(lp)
      o.start(at)
      o.stop(at + dur + 0.2)
    }
  }

  // --- Music -----------------------------------------------------------------------------------

  /** Starts (or switches to) the arena drums or the town lyre. */
  startMusic(kind: 'arena' | 'town') {
    this.wantMusic = kind
    const ctx = this.ctx
    if (!ctx) return
    if (this.music?.kind === kind) return
    this.stopMusic()
    this.wantMusic = kind
    const bpm = kind === 'arena' ? 104 : 84
    const stepDur = 60 / bpm / 4
    const m = { kind, next: ctx.currentTime + 0.1, step: 0, timer: 0 as unknown as ReturnType<typeof setInterval> }
    m.timer = setInterval(() => {
      if (!this.ctx || !this.musicBus) return
      while (m.next < this.ctx.currentTime + 0.2) {
        if (kind === 'arena') this.drumStep(m.step, m.next)
        else this.lyreStep(m.step, m.next)
        m.next += stepDur
        m.step++
      }
    }, 50)
    this.music = m
  }

  stopMusic() {
    if (this.music) clearInterval(this.music.timer)
    this.music = null
    this.wantMusic = null
  }

  private drumStep(step: number, at: number) {
    const bus = this.musicBus!
    const s = step % 16
    const bar = Math.floor(step / 16)
    const hot = this.intensity
    // Taiko-style low drum on the main beats, toms in between, rim clicks when it gets heated.
    if (s === 0 || s === 6 || s === 10 || (hot > 0.5 && s === 14)) {
      this.tone(at, 0.45, 82, 46, 0.7, 'sine', bus)
      this.burst(at, 0.05, 'lowpass', 900, 0.7, 0.25, 0, undefined, bus)
    }
    if (s === 4 || s === 12) {
      this.tone(at, 0.25, 170, 110, 0.35, 'sine', bus)
      this.burst(at, 0.04, 'bandpass', 1400, 1.2, 0.15, 0, undefined, bus)
    }
    if (hot > 0.35 && s % 2 === 1 && Math.random() < 0.4 + hot * 0.4) this.burst(at, 0.025, 'highpass', 3500, 0.8, 0.05 + hot * 0.05, 0, undefined, bus)
    // A horn call every fourth bar.
    if (s === 0 && bar % 4 === 0) {
      this.brass(at, NOTE(-24), 0.9, bus, 0.07)
      this.brass(at, NOTE(-17), 0.9, bus, 0.05)
    }
    if (s === 0 && bar % 4 === 2) this.brass(at, NOTE(-22), 0.6, bus, 0.06)
  }

  private lyreStep(step: number, at: number) {
    const bus = this.musicBus!
    const s = step % 32
    // A simple wandering melody: chord tones on the beat, passing notes between.
    if (s % 2 === 0) {
      const chord = Math.floor(step / 32) % 4
      const roots = [0, 3, -2, 0][chord] + 7
      const choices = s % 8 === 0 ? [roots, roots + 2, roots + 4] : [roots - 1, roots, roots + 1, roots + 2, roots + 3, roots + 4, roots + 5]
      const idx = Math.max(0, Math.min(DORIAN.length - 1, choices[Math.floor(Math.random() * choices.length)]))
      const buf = this.plucks.get(DORIAN[idx])
      if (buf && (s % 8 === 0 || Math.random() < 0.7)) {
        const src = this.ctx!.createBufferSource()
        src.buffer = buf
        const g = this.ctx!.createGain()
        g.gain.value = s % 8 === 0 ? 0.32 : 0.2
        src.connect(g).connect(bus)
        src.start(at)
      }
      if (s % 16 === 0) {
        const bass = this.plucks.get(DORIAN[Math.max(0, roots - 7)])
        if (bass) {
          const src = this.ctx!.createBufferSource()
          src.buffer = bass
          src.playbackRate.value = 0.5
          const g = this.ctx!.createGain()
          g.gain.value = 0.3
          src.connect(g).connect(bus)
          src.start(at)
        }
      }
    }
  }
}
