// Empires At War music: six separate synthesised pieces, no shared bed.
//
//   menu            — title fanfare (bright, melodic)
//   lobby           — prep / waiting (plucked arpeggios, no drums)
//   skirmish        — calm space battle underscore (sparse, high)
//   skirmishCombat  — full engagement (war drums + brass, different piece)
//   galaxy          — galactic conquest map (mysterious, slow)
//   galaxyAlarm     — GC under threat (urgent pulse, different from combat)
//
// Hard cuts between pieces. Skirmish↔combat flips on combat heat; galaxy↔alarm
// from conquest threat calls. Original motifs — not film themes.

export type MusicScene =
  | 'menu'
  | 'lobby'
  | 'skirmish'
  | 'skirmishCombat'
  | 'galaxy'
  | 'galaxyAlarm'
  | 'none'

const semi = (n: number) => Math.pow(2, n / 12)

type Piece = {
  stop: (fade: number) => void
  /** 16th-note step; return false to skip scheduling this frame's remaining work. */
  step: (step: number, at: number) => void
  bpm: number
}

/** Adaptive score on the music bus — one live piece at a time. */
export class MusicDirector {
  private ctx: AudioContext
  private master: GainNode
  private duck: GainNode
  private scene: MusicScene = 'none'
  /** Location the shell asked for (menu/lobby/skirmish/galaxy), before combat/alarm flips. */
  private base: 'menu' | 'lobby' | 'skirmish' | 'galaxy' | 'none' = 'none'
  private piece: Piece | null = null
  private combat = false
  private alarmUntil = 0
  private raf = 0
  private next = 0
  private stepN = 0
  private disposed = false
  private noise: AudioBuffer
  private last = 0

  constructor(ctx: AudioContext, musicBus: GainNode) {
    this.ctx = ctx
    this.duck = ctx.createGain()
    this.duck.gain.value = 1
    this.master = ctx.createGain()
    this.master.gain.value = 1
    this.duck.connect(this.master).connect(musicBus)
    const n = Math.ceil(ctx.sampleRate * 0.05)
    this.noise = ctx.createBuffer(1, n, ctx.sampleRate)
    const d = this.noise.getChannelData(0)
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1
  }

  get currentScene() {
    return this.scene
  }

  /**
   * Shell locations only. Combat and GC-alarm variants are chosen automatically
   * (heat / `galaxyThreat`), never passed here.
   */
  setScene(scene: 'menu' | 'lobby' | 'skirmish' | 'galaxy' | 'none') {
    if (this.disposed) return
    this.base = scene
    if (scene !== 'skirmish') this.combat = false
    if (scene === 'none') {
      this.play('none')
      return
    }
    if (scene === 'skirmish') this.play(this.combat ? 'skirmishCombat' : 'skirmish')
    else if (scene === 'galaxy') this.play(performance.now() < this.alarmUntil ? 'galaxyAlarm' : 'galaxy')
    else this.play(scene)
  }

  /** Combat heat 0..~6 from the battle loop. Flips skirmish ↔ skirmishCombat with hysteresis. */
  setHeat(heat: number) {
    if (this.base !== 'skirmish') return
    // Enter on the first real volley; leave only after the fight has gone quiet.
    if (!this.combat && heat > 0.45) {
      this.combat = true
      this.play('skirmishCombat')
    } else if (this.combat && heat < 0.12) {
      this.combat = false
      this.play('skirmish')
    }
  }

  /** Galactic conquest: something hostile just happened. Holds alarm music for a while. */
  galaxyThreat(seconds = 16) {
    this.alarmUntil = performance.now() + seconds * 1000
    if (this.base === 'galaxy') this.play('galaxyAlarm')
  }

  /** Sound-test: play any piece directly, including combat / alarm variants. */
  preview(scene: MusicScene) {
    if (this.disposed) return
    if (scene === 'none') {
      this.base = 'none'
      this.combat = false
      this.alarmUntil = 0
      this.play('none')
      return
    }
    if (scene === 'skirmishCombat') {
      this.base = 'skirmish'
      this.combat = true
      this.play('skirmishCombat')
      return
    }
    if (scene === 'galaxyAlarm') {
      this.base = 'galaxy'
      this.alarmUntil = performance.now() + 60_000
      this.play('galaxyAlarm')
      return
    }
    if (scene === 'skirmish') {
      this.base = 'skirmish'
      this.combat = false
      this.play('skirmish')
      return
    }
    if (scene === 'galaxy') {
      this.base = 'galaxy'
      this.alarmUntil = 0
      this.play('galaxy')
      return
    }
    this.base = scene
    this.combat = false
    this.play(scene)
  }

  duckFor(seconds: number) {
    if (this.disposed) return
    const t = this.ctx.currentTime
    const g = this.duck.gain
    g.cancelScheduledValues(t)
    g.setValueAtTime(g.value, t)
    g.linearRampToValueAtTime(0.1, t + 0.12)
    g.linearRampToValueAtTime(0.1, t + Math.max(0.5, seconds - 0.5))
    g.linearRampToValueAtTime(1, t + seconds)
  }

  kick() {
    if (this.disposed || this.scene === 'none') return
    if (this.next < this.ctx.currentTime) this.next = this.ctx.currentTime + 0.04
    this.startLoop()
    this.scheduleAhead()
  }

  tick(dt: number) {
    if (this.disposed || this.scene === 'none') return
    if (this.base === 'galaxy' && this.scene === 'galaxyAlarm' && performance.now() >= this.alarmUntil) {
      this.play('galaxy')
    }
    this.scheduleAhead()
    void dt
  }

  dispose() {
    this.disposed = true
    this.stopLoop()
    this.piece?.stop(0.05)
    this.piece = null
    try {
      this.duck.disconnect()
      this.master.disconnect()
    } catch {
      /* ignore */
    }
  }

  // --- Piece switching ------------------------------------------------------------------------------------

  private play(scene: MusicScene) {
    if (this.disposed) return
    if (scene === this.scene && this.piece) {
      this.kick()
      return
    }
    const prev = this.piece
    this.piece = null
    const fade = scene === 'none' ? 0.9 : 1.4
    // Crossfade: old piece keeps playing while it dies; new piece fades in under it.
    prev?.stop(fade)
    this.scene = scene
    this.stepN = 0
    this.next = this.ctx.currentTime + 0.08
    if (scene === 'none') {
      this.stopLoop()
      return
    }
    this.piece = this.build(scene)
    this.startLoop()
    this.scheduleAhead()
  }

  private build(scene: Exclude<MusicScene, 'none'>): Piece {
    switch (scene) {
      case 'menu':
        return this.menuPiece()
      case 'lobby':
        return this.lobbyPiece()
      case 'skirmish':
        return this.skirmishPiece()
      case 'skirmishCombat':
        return this.skirmishCombatPiece()
      case 'galaxy':
        return this.galaxyPiece()
      case 'galaxyAlarm':
        return this.galaxyAlarmPiece()
    }
  }

  private startLoop() {
    if (this.raf || this.disposed) return
    this.last = performance.now()
    const loop = (now: number) => {
      this.raf = 0
      if (this.disposed || this.scene === 'none') return
      const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000))
      this.last = now
      if (this.base === 'galaxy' && this.scene === 'galaxyAlarm' && now >= this.alarmUntil) this.play('galaxy')
      this.scheduleAhead()
      void dt
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  private stopLoop() {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private scheduleAhead() {
    if (!this.piece || this.disposed) return
    if (this.ctx.state !== 'running') return
    const stepDur = 60 / this.piece.bpm / 4
    const now = this.ctx.currentTime
    if (this.next < now - 0.05) {
      this.next = now + 0.02
      this.stepN = 0
    }
    const horizon = now + 0.3
    while (this.next < horizon) {
      this.piece.step(this.stepN, this.next)
      this.next += stepDur
      this.stepN++
    }
  }

  // --- Voices (one-shots into the current piece bus) ------------------------------------------------------

  private tone(at: number, freq: number, dur: number, type: OscillatorType, bus: GainNode, gain: number, attack = 0.02) {
    const ctx = this.ctx
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.value = freq
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(gain, at + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    o.connect(g).connect(bus)
    o.start(at)
    o.stop(at + dur + 0.02)
  }

  private brass(at: number, freq: number, dur: number, bus: GainNode, gain: number) {
    const ctx = this.ctx
    const merge = ctx.createGain()
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(gain, at + 0.025)
    g.gain.linearRampToValueAtTime(gain * 0.7, at + dur * 0.5)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.setValueAtTime(1200, at)
    f.frequency.linearRampToValueAtTime(3600, at + Math.min(0.15, dur * 0.3))
    f.frequency.linearRampToValueAtTime(1400, at + dur)
    for (const det of [1, 1.008]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = freq * det
      o.connect(merge)
      o.start(at)
      o.stop(at + dur + 0.03)
    }
    merge.connect(f).connect(g).connect(bus)
  }

  private timp(at: number, bus: GainNode, gain: number, dur = 0.45) {
    const ctx = this.ctx
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(160, at)
    o.frequency.exponentialRampToValueAtTime(90, at + 0.18)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), at + 0.003)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    o.connect(g).connect(bus)
    o.start(at)
    o.stop(at + dur + 0.02)
    const n = ctx.createBufferSource()
    n.buffer = this.noise
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(gain * 0.5, at)
    ng.gain.exponentialRampToValueAtTime(0.0001, at + 0.03)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1100
    n.connect(ng).connect(lp).connect(bus)
    n.start(at)
    n.stop(at + 0.04)
  }

  private snare(at: number, bus: GainNode, gain: number) {
    const ctx = this.ctx
    const n = ctx.createBufferSource()
    n.buffer = this.noise
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 1800
    const g = ctx.createGain()
    g.gain.setValueAtTime(gain, at)
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.08)
    n.connect(hp).connect(g).connect(bus)
    n.start(at)
    n.stop(at + 0.09)
  }

  private pluck(at: number, freq: number, bus: GainNode, gain: number) {
    // Short decaying triangle — reads as a plucked string on phone speakers.
    this.tone(at, freq, 0.55, 'triangle', bus, gain, 0.004)
    this.tone(at, freq * 2, 0.25, 'sine', bus, gain * 0.25, 0.004)
  }

  private bell(at: number, freq: number, bus: GainNode, gain: number) {
    this.tone(at, freq, 1.4, 'sine', bus, gain, 0.01)
    this.tone(at, freq * 2.76, 0.9, 'sine', bus, gain * 0.35, 0.01)
    this.tone(at, freq * 5.4, 0.5, 'sine', bus, gain * 0.12, 0.01)
  }

  private makeOut(level: number) {
    const g = this.ctx.createGain()
    g.gain.value = 0.0001
    g.connect(this.duck)
    const t = this.ctx.currentTime
    // ~1s fade-in so calm↔combat overlaps cleanly with the outgoing piece.
    g.gain.linearRampToValueAtTime(level, t + 1.0)
    return g
  }

  private stopOut(g: GainNode, fade: number, nodes: AudioNode[]) {
    const t = this.ctx.currentTime
    g.gain.cancelScheduledValues(t)
    g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t)
    g.gain.linearRampToValueAtTime(0.0001, t + Math.max(0.05, fade))
    setTimeout(() => {
      for (const n of nodes) {
        try {
          ;(n as OscillatorNode).stop?.()
        } catch {
          /* ignore */
        }
        try {
          n.disconnect()
        } catch {
          /* ignore */
        }
      }
      try {
        g.disconnect()
      } catch {
        /* ignore */
      }
    }, fade * 1000 + 80)
  }

  // --- Menu: bright title fanfare (A minor, melodic fifths) -----------------------------------------------

  private menuPiece(): Piece {
    const out = this.makeOut(0.85)
    const bpm = 104
    // Sustained soft chord under the fanfare — mid register, not a sub drone.
    const held: OscillatorNode[] = []
    for (const [fr, type, g0] of [
      [220, 'triangle', 0.08],
      [330, 'triangle', 0.06],
      [440, 'sine', 0.05],
    ] as const) {
      const o = this.ctx.createOscillator()
      o.type = type
      o.frequency.value = fr
      const g = this.ctx.createGain()
      g.gain.value = g0
      o.connect(g).connect(out)
      o.start()
      held.push(o)
    }
    return {
      bpm,
      stop: (fade) => this.stopOut(out, fade, held),
      step: (step, at) => {
        const s = step % 16
        const bar = Math.floor(step / 16)
        if (s === 0) this.timp(at, out, 0.45)
        if (s === 8) this.timp(at, out, 0.28)
        if (s === 4 || s === 12) this.snare(at, out, 0.12)
        // Melodic call every two bars — clear tune, not a pad.
        if (s === 0 && bar % 2 === 0) {
          const notes = [0, 7, 12, 7, 8, 5, 3, 0]
          notes.forEach((n, i) => this.brass(at + i * 0.18, 220 * semi(n), 0.28, out, 0.2))
        }
        if (s === 0 && bar % 4 === 1) {
          this.brass(at, 220 * semi(15), 0.5, out, 0.16)
          this.brass(at + 0.35, 220 * semi(19), 0.7, out, 0.14)
        }
      },
    }
  }

  // --- Lobby: plucked D-dorian arpeggios, no drums --------------------------------------------------------

  private lobbyPiece(): Piece {
    const out = this.makeOut(0.7)
    const bpm = 78
    // D dorian degrees relative to D3=146.8
    const D = 146.83
    const scale = [0, 2, 3, 5, 7, 9, 10, 12]
    return {
      bpm,
      stop: (fade) => this.stopOut(out, fade, []),
      step: (step, at) => {
        const s = step % 16
        const bar = Math.floor(step / 16)
        // Walking arpeggio on even 16ths — completely different texture from the menu.
        if (s % 2 === 0) {
          const chord = [0, 3, 5, 7][(Math.floor(step / 2) + bar) % 4]
          const deg = scale[(chord + (s === 0 ? 0 : s === 4 ? 2 : s === 8 ? 4 : 3)) % scale.length]
          this.pluck(at, D * semi(deg + (s === 0 ? 12 : 0)), out, s === 0 ? 0.22 : 0.12)
        }
        // Soft bass on 1 of every bar.
        if (s === 0) this.tone(at, D * semi(bar % 2 === 0 ? 0 : -2), 0.9, 'sine', out, 0.14, 0.04)
      },
    }
  }

  // --- Skirmish calm: warm pad with slow chords — no melody lines ----------------------------------------

  private skirmishPiece(): Piece {
    const out = this.makeOut(0.68)
    const bpm = 66
    const held: OscillatorNode[] = []
    const root = 110 // A2
    // Am → F → Dm → Em — slow harmony only, nothing that walks up and down.
    const prog = [0, -4, -7, -2]
    const pad = this.ctx.createBiquadFilter()
    pad.type = 'lowpass'
    pad.frequency.value = 560
    pad.Q.value = 0.5
    pad.connect(out)
    const voices = [0, 7, 12].map((semiOff, i) => {
      const o = this.ctx.createOscillator()
      o.type = i === 2 ? 'triangle' : 'sine'
      o.frequency.value = root * semi(semiOff)
      const g = this.ctx.createGain()
      g.gain.value = i === 0 ? 0.14 : i === 1 ? 0.1 : 0.05
      o.connect(g).connect(pad)
      o.start()
      held.push(o)
      return o
    })
    const lfo = this.ctx.createOscillator()
    lfo.frequency.value = 0.035
    const lg = this.ctx.createGain()
    lg.gain.value = 70
    lfo.connect(lg).connect(pad.frequency)
    lfo.start()
    held.push(lfo)
    return {
      bpm,
      stop: (fade) => this.stopOut(out, fade, held),
      step: (step, at) => {
        const s = step % 16
        const bar = Math.floor(step / 16)
        const chord = prog[Math.floor(bar / 2) % prog.length]
        // Glide the whole chord on the change — held tones, not a tune.
        if (s === 0 && bar % 2 === 0) {
          for (const [i, off] of [0, 7, 12].entries()) {
            voices[i].frequency.cancelScheduledValues(at)
            voices[i].frequency.setValueAtTime(voices[i].frequency.value, at)
            voices[i].frequency.linearRampToValueAtTime(root * semi(chord + off), at + 1.6)
          }
          // One soft brass swell on the new chord (sustained, same notes).
          this.brass(at, root * semi(chord + 7), 2.4, out, 0.045)
        }
        // Very soft heartbeat so it isn't a flat hum — no pitch motion.
        if (s === 0) this.tone(at, root * semi(chord), 0.85, 'sine', out, 0.055, 0.08)
        if (s === 8) this.tone(at, root * semi(chord), 0.7, 'sine', out, 0.035, 0.08)
      },
    }
  }

  // --- Skirmish combat: different piece — war drums, dark brass, E-rooted ---------------------------------

  private skirmishCombatPiece(): Piece {
    const out = this.makeOut(1)
    const bpm = 128
    const E = 164.81
    const held: OscillatorNode[] = []
    // Dark fifth bed — only while fighting, torn down when calm returns.
    for (const [fr, g0] of [
      [E, 0.12],
      [E * semi(7), 0.09],
      [E * 0.5, 0.1],
    ] as const) {
      const o = this.ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = fr
      const g = this.ctx.createGain()
      g.gain.value = g0
      const f = this.ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = 900
      o.connect(g).connect(f).connect(out)
      o.start()
      held.push(o)
    }
    return {
      bpm,
      stop: (fade) => this.stopOut(out, fade, held),
      step: (step, at) => {
        const s = step % 16
        const bar = Math.floor(step / 16)
        // Driving drums — every beat.
        if (s % 4 === 0) this.timp(at, out, 0.55)
        if (s === 4 || s === 12) this.snare(at, out, 0.28)
        if (s === 6 || s === 14) this.snare(at, out, 0.14)
        if (s === 2 || s === 10) this.timp(at, out, 0.28, 0.28)
        // Aggressive brass cells — not the menu motif.
        if (s === 0) {
          this.brass(at, E * semi(12), 0.35, out, 0.22)
          this.brass(at + 0.2, E * semi(15), 0.3, out, 0.18)
          this.brass(at + 0.4, E * semi(12), 0.45, out, 0.2)
        }
        if (s === 8) this.brass(at, E * semi(8), 0.4, out, 0.16)
        if (s === 0 && bar % 4 === 2) {
          this.brass(at, E * semi(19), 0.25, out, 0.2)
          this.brass(at + 0.22, E * semi(24), 0.55, out, 0.18)
        }
      },
    }
  }

  // --- Galaxy map: mysterious slow bells ------------------------------------------------------------------

  private galaxyPiece(): Piece {
    const out = this.makeOut(0.6)
    const bpm = 58
    const root = 196
    return {
      bpm,
      stop: (fade) => this.stopOut(out, fade, []),
      step: (step, at) => {
        const s = step % 32
        const bar = Math.floor(step / 32)
        // Wide, cold intervals — political map, not a battle.
        if (s === 0) this.bell(at, root * semi(bar % 4 === 0 ? 0 : bar % 4 === 1 ? 7 : bar % 4 === 2 ? 3 : 10), out, 0.16)
        if (s === 12) this.bell(at, root * semi(15), out, 0.08)
        if (s === 20) this.tone(at, root * semi(-5), 2.5, 'sine', out, 0.07, 0.5)
        if (s === 0 && bar % 2 === 1) this.pluck(at, root * semi(12), out, 0.06)
      },
    }
  }

  // --- Galaxy alarm: urgent rising pulse — panic, not martial combat --------------------------------------

  private galaxyAlarmPiece(): Piece {
    const out = this.makeOut(0.95)
    const bpm = 144
    const root = 233.08 // Bb
    return {
      bpm,
      stop: (fade) => this.stopOut(out, fade, []),
      step: (step, at) => {
        const s = step % 8
        // Fast heartbeat pulse — clearly different from skirmish war drums.
        if (s === 0 || s === 3) this.tone(at, root, 0.12, 'square', out, 0.12, 0.005)
        if (s === 0) this.timp(at, out, 0.35, 0.3)
        if (s === 4) this.snare(at, out, 0.2)
        // Rising three-note panic figure every half-bar.
        if (s === 0 || s === 4) {
          this.brass(at, root * semi(12), 0.15, out, 0.18)
          this.brass(at + 0.12, root * semi(15), 0.15, out, 0.16)
          this.brass(at + 0.24, root * semi(19), 0.28, out, 0.2)
        }
      },
    }
  }
}
