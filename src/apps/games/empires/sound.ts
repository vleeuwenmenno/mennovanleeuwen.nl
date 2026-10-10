import type { AbilityId, FactionId, Tier, WeaponKind } from './data'

// Empires At War sounds, all synthesised: no audio files. Each sound is rendered once, in a few
// slightly different takes, into a sample (small DSP below: oscillators, envelopes, a resonant
// filter, noise), then played through one of three buses: the battle, the interface (crew
// acknowledgements and alerts), and the ambience. Battle sounds are panned and, further away,
// quieter and muffled; everything gets a touch of a long, soft reverb.
//
// Crews answer orders over the radio: Republic ships with a squelch and clean military beeps,
// droids with chattering square-wave bleeps.

const VOLUME_KEY = 'mvlos.empires.volume'
const MUTE_KEY = 'mvlos.empires.muted'
const MIX_KEY = 'mvlos.empires.mix'

export type Where = { pan: number; gain: number }
export type Bus = 'sfx' | 'ui' | 'amb'
export type OrderKind = 'move' | 'attack' | 'attackMove' | 'patrol' | 'hold' | 'stop' | 'rally' | 'target'

// --- DSP ------------------------------------------------------------------------------------------------

const TAU = Math.PI * 2
type Rnd = () => number

/** A resonant state-variable filter, one sample at a time. */
class Svf {
  low = 0
  band = 0
  high = 0
  run(x: number, f: number, q: number, sr: number) {
    const F = 2 * Math.sin((Math.PI * Math.min(f, sr / 6)) / sr)
    this.low += F * this.band
    this.high = x - this.low - q * this.band
    this.band += F * this.high
    return this
  }
}

/** An oscillator with a running phase, so its pitch can glide. Saw and square are band-limited. */
class Osc {
  p = 0
  constructor(phase = 0) {
    this.p = phase
  }
  private blep(t: number, dt: number) {
    if (t < dt) {
      t /= dt
      return t + t - t * t - 1
    }
    if (t > 1 - dt) {
      t = (t - 1) / dt
      return t * t + t + t + 1
    }
    return 0
  }
  step(f: number, sr: number) {
    const dt = f / sr
    this.p += dt
    if (this.p >= 1) this.p -= 1
    return dt
  }
  sin(f: number, sr: number) {
    this.step(f, sr)
    return Math.sin(this.p * TAU)
  }
  saw(f: number, sr: number) {
    const dt = this.step(f, sr)
    return 2 * this.p - 1 - this.blep(this.p, dt)
  }
  sqr(f: number, sr: number) {
    const dt = this.step(f, sr)
    let v = this.p < 0.5 ? 1 : -1
    v += this.blep(this.p, dt)
    v -= this.blep((this.p + 0.5) % 1, dt)
    return v
  }
  tri(f: number, sr: number) {
    this.step(f, sr)
    return 1 - 4 * Math.abs(this.p - 0.5)
  }
}

/** Attack then exponential decay. */
const ad = (t: number, a: number, d: number) => (t < 0 ? 0 : t < a ? t / a : Math.exp(-(t - a) / d))
/** An exponential glide from f0 to f1 over `len` seconds. */
const glide = (f0: number, f1: number, t: number, len: number) => f0 * Math.pow(f1 / f0, Math.min(1, Math.max(0, t / len)))
const semi = (n: number) => Math.pow(2, n / 12)
const soft = (x: number) => Math.tanh(x)

function render(sr: number, secs: number, fn: (t: number, i: number) => number) {
  const n = Math.ceil(secs * sr)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = fn(i / sr, i)
  // Normalise, and fade the last few ms so nothing clicks.
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]))
  const k = peak > 0 ? 0.9 / peak : 0
  const fade = Math.min(n, Math.ceil(0.006 * sr))
  for (let i = 0; i < n; i++) out[i] *= k * (i > n - fade ? (n - i) / fade : 1)
  return out
}

/** Several layers summed: each is a render of its own length, starting at its own offset. */
function layers(sr: number, parts: { at?: number; gain?: number; data: Float32Array }[]) {
  const len = Math.max(...parts.map((p) => Math.ceil((p.at ?? 0) * sr) + p.data.length))
  const out = new Float32Array(len)
  for (const p of parts) {
    const o = Math.ceil((p.at ?? 0) * sr)
    for (let i = 0; i < p.data.length; i++) out[o + i] += p.data[i] * (p.gain ?? 1)
  }
  let peak = 0
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(out[i]))
  for (let i = 0; i < len; i++) out[i] *= 0.9 / (peak || 1)
  return out
}

const noise = () => Math.random() * 2 - 1

// --- Recipes ------------------------------------------------------------------------------------------
// Each takes the sample rate and a random source, and returns one take. Banks below render 3-4
// takes per sound so repeats don't sound copied.

type Recipe = (sr: number, r: Rnd) => Float32Array

/** A blaster bolt: a bright zap that falls in pitch, through a resonant filter that falls with it. */
const blaster = (droid: boolean): Recipe => (sr, r) => {
  const o1 = new Osc(r())
  const o2 = new Osc(r())
  const f = new Svf()
  const f0 = (droid ? 1000 : 1250) * (0.92 + r() * 0.16)
  const f1 = droid ? 170 : 230
  return render(sr, 0.2, (t) => {
    const fr = glide(f0, f1, t, 0.16)
    const tone = droid ? o1.sqr(fr, sr) * 0.6 + o2.sqr(fr * 1.012, sr) * 0.4 : o1.saw(fr, sr) * 0.7 + o2.sin(fr * 2, sr) * 0.3
    const cut = glide(3200, 600, t, 0.16)
    const v = f.run(tone + noise() * 0.08, cut, 0.35, sr).band * 1.8 + f.low * 0.4
    return soft(v * 1.4) * ad(t, 0.002, droid ? 0.05 : 0.06)
  })
}

/** A turbolaser: a heavy zap on top of a deep thump, with a burst of hiss. */
const turbolaser: Recipe = (sr, r) => {
  const z = new Osc()
  const z2 = new Osc()
  const b = new Osc()
  const fz = new Svf()
  const fn = new Svf()
  const f0 = 760 * (0.9 + r() * 0.2)
  return render(sr, 0.7, (t) => {
    const fr = glide(f0, 70, t, 0.32)
    const zap = fz.run(z.saw(fr, sr) + z2.saw(fr * 1.505, sr) * 0.5, glide(2600, 260, t, 0.3), 0.5, sr).band * ad(t, 0.002, 0.12)
    const thump = b.sin(glide(140, 38, t, 0.4), sr) * ad(t, 0.004, 0.2)
    const hiss = fn.run(noise(), glide(6000, 400, t, 0.25), 0.8, sr).low * ad(t, 0.001, 0.07)
    return soft(zap * 1.6 + thump * 1.3 + hiss * 0.6)
  })
}

/** Flak: a sharp crack and a short thud. */
const flak: Recipe = (sr, r) => {
  const hp = new Svf()
  const lp = new Svf()
  const o = new Osc()
  const tone = 85 + r() * 30
  return render(sr, 0.16, (t) => {
    const crack = hp.run(noise(), 2400 + r() * 800, 0.9, sr).high * ad(t, 0.0005, 0.018)
    const body = lp.run(noise(), 900, 0.6, sr).low * ad(t, 0.002, 0.045)
    const thud = o.sin(glide(tone * 2, tone, t, 0.05), sr) * ad(t, 0.002, 0.05)
    return soft(crack * 1.2 + body * 0.9 + thud)
  })
}

/** A missile leaving its pod: a thump, then a rising, fading whoosh. */
const missile: Recipe = (sr, r) => {
  const bp = new Svf()
  const o = new Osc()
  return render(sr, 0.75, (t) => {
    const thump = o.sin(glide(160, 60, t, 0.08), sr) * ad(t, 0.002, 0.05)
    const whoosh = bp.run(noise(), glide(500, 2800 + r() * 600, t, 0.55), 0.35, sr).band * ad(t, 0.06, 0.25)
    return thump * 1.1 + whoosh * 1.6
  })
}

/** A bolt splashing on shields: glassy partials, a tremble, and a fizz. */
const shieldHit: Recipe = (sr, r) => {
  const os = [new Osc(), new Osc(), new Osc()]
  const fr = [880, 1320, 1760].map((f) => f * (0.9 + r() * 0.2))
  const bp = new Svf()
  return render(sr, 0.4, (t) => {
    const trem = 0.75 + 0.25 * Math.sin(TAU * 38 * t)
    const ring = os.reduce((s, o, k) => s + o.sin(fr[k] * (1 + 0.004 * Math.sin(TAU * 7 * t)), sr) * Math.exp(-t / (0.16 - k * 0.04)), 0)
    const fizz = bp.run(noise(), 2800, 0.6, sr).band * ad(t, 0.001, 0.04)
    return ring * trem * 0.6 + fizz
  })
}

/** Metal struck: inharmonic partials ringing out, lower and longer for heavy hits. */
const metal = (heavy: boolean): Recipe => (sr, r) => {
  const base = heavy ? [210, 395, 660, 1090, 1610] : [520, 890, 1460, 2280, 3150]
  const os = base.map(() => new Osc(r()))
  const fr = base.map((f) => f * (0.94 + r() * 0.12))
  const lp = new Svf()
  const len = heavy ? 0.6 : 0.18
  return render(sr, len, (t) => {
    const ring = os.reduce((s, o, k) => s + o.sin(fr[k], sr) * Math.exp(-t / ((heavy ? 0.2 : 0.06) / (1 + k * 0.4))) / (k + 1), 0)
    const hit = lp.run(noise(), heavy ? 2500 : 6000, 0.7, sr).low * ad(t, 0.0005, heavy ? 0.03 : 0.008)
    return soft(ring * 1.4 + hit * 1.2)
  })
}

/** An explosion: a crack, a roaring body that darkens, a sub thump, crackling debris, and for big
 * ones, secondary blasts rolling on. Size 0 is a fighter, 1 a frigate, 2 a capital ship. */
const explosion = (size: 0 | 1 | 2): Recipe => (sr, r) => {
  const len = [0.9, 1.8, 3.4][size]
  const body = new Svf()
  const crk = new Svf()
  const sub = new Osc()
  const pops = Array.from({ length: [10, 22, 40][size] }, () => [r() * len * 0.8, 0.3 + r() * 0.7] as const)
  const secondary = size === 2 ? [0.35 + r() * 0.2, 0.8 + r() * 0.3, 1.3 + r() * 0.4] : size === 1 ? [0.3 + r() * 0.2] : []
  return render(sr, len, (t) => {
    const crack = crk.run(noise(), 3000, 0.7, sr).high * ad(t, 0.0005, 0.02)
    let env = ad(t, 0.004, [0.18, 0.4, 0.8][size])
    for (const s of secondary) env += 0.7 * ad(t - s, 0.01, 0.35)
    const roar = body.run(noise(), glide([3200, 2400, 1800][size], [220, 140, 90][size], t, len * 0.7), 0.5, sr).low * env
    const thump = sub.sin(glide([120, 80, 60][size], [40, 30, 24][size], t, 0.5), sr) * ad(t, 0.005, [0.15, 0.3, 0.6][size])
    let debris = 0
    for (const [at, g] of pops) {
      const d = t - at
      if (d >= 0 && d < 0.012) debris += noise() * g * (1 - d / 0.012)
    }
    return soft(crack * 0.9 + roar * 1.8 + thump * [1, 1.3, 1.7][size] + debris * 0.5)
  })
}

/** A hardpoint wrecked: a heavy clang, a burst, and electrical sputtering. */
const hardpointDown: Recipe = (sr, r) => {
  const zap = new Osc()
  const f = new Svf()
  const buzz = render(sr, 0.7, (t) => {
    const sputter = Math.sin(TAU * (12 + r() * 0.01) * t) > 0.2 ? 1 : 0.15
    return f.run(zap.saw(110 + 30 * Math.sin(TAU * 7 * t), sr), 1800, 0.4, sr).band * sputter * ad(t, 0.01, 0.25)
  })
  return layers(sr, [{ data: metal(true)(sr, r), gain: 0.8 }, { data: explosion(0)(sr, r), gain: 0.7 }, { data: buzz, gain: 0.5, at: 0.05 }])
}

/** Shields failing: a power-down glide with a stutter and a last fizz. */
const shieldsDown: Recipe = (sr) => {
  const o = new Osc()
  const o2 = new Osc()
  const bp = new Svf()
  return render(sr, 0.9, (t) => {
    const fr = glide(700, 60, t, 0.7)
    const stutter = 0.6 + 0.4 * Math.sign(Math.sin(TAU * glide(30, 8, t, 0.7) * t))
    const tone = (o.sin(fr, sr) + o2.saw(fr * 0.5, sr) * 0.3) * stutter * ad(t, 0.01, 0.4)
    const fizz = bp.run(noise(), 2600, 0.5, sr).band * ad(t - 0.5, 0.02, 0.15)
    return tone + fizz * 0.6
  })
}

/** Fighters out of a hangar: an engine whine rising past, in a gust of air. */
const launch: Recipe = (sr, r) => {
  const o = new Osc()
  const bp = new Svf()
  const lp = new Svf()
  return render(sr, 0.7, (t) => {
    const env = Math.sin(Math.PI * Math.min(1, t / 0.6)) ** 2
    const whine = lp.run(o.saw(glide(200, 600 + r() * 120, t, 0.5), sr), 1800, 0.5, sr).low
    const air = bp.run(noise(), glide(500, 1600, t, 0.35), 0.5, sr).band
    return (whine * 0.5 + air) * env
  })
}

// Interface and crew -----------------------------------------------------------------------------------

/** A radio: band-limited and a little crunchy, like a comm channel. */
function radio(sr: number, data: Float32Array, squelch = true) {
  const f = new Svf()
  const pre = squelch ? Math.ceil(0.03 * sr) : 0
  const out = new Float32Array(data.length + pre + Math.ceil(0.03 * sr))
  const hp = new Svf()
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    let x = i >= pre && i - pre < data.length ? data[i - pre] : 0
    // Squelch: a short burst of static before and after the message.
    if (squelch && (i < pre || i - pre >= data.length)) x += noise() * 0.25 * Math.exp(-((i < pre ? pre - i : i - pre - data.length) / sr) / 0.012)
    hp.run(x, 260, 0.7, sr)
    const y = f.run(hp.high, 2400, 0.6, sr).low
    out[i] = soft(y * 2.2) * (1 + 0.04 * Math.sin(TAU * 50 * t))
  }
  return out
}

/** Notes in sequence: [semitones above base, seconds]. `wave` picks the timbre. */
function melody(sr: number, base: number, notes: [number, number][], wave: 'sin' | 'sqr' | 'tri' | 'saw', gap = 0.012) {
  const total = notes.reduce((s, [, d]) => s + d + gap, 0)
  const o = new Osc()
  let k = 0
  let start = 0
  return render(sr, total + 0.05, (t) => {
    while (k < notes.length && t >= start + notes[k][1] + gap) {
      start += notes[k][1] + gap
      k++
    }
    if (k >= notes.length) return 0
    const [n, d] = notes[k]
    const lt = t - start
    if (lt > d) return 0
    const env = Math.min(1, lt / 0.004) * Math.min(1, (d - lt) / 0.008)
    return o[wave](base * semi(n), sr) * env
  })
}

/** Droid chatter: a burst of quick, random bleeps from a pentatonic scale, slightly bit-crushed. */
function chatter(sr: number, r: Rnd, count: number, contour: number, base = 380) {
  const scale = [0, 3, 5, 7, 10, 12, 15]
  const notes: [number, number][] = []
  for (let i = 0; i < count; i++) {
    const drift = Math.round(contour * (i / Math.max(1, count - 1)) * 4)
    notes.push([scale[Math.floor(r() * scale.length)] + drift, 0.028 + r() * 0.03])
  }
  const m = melody(sr, base, notes, 'sqr', 0.008)
  // Sample-and-hold at a low rate for that robotic edge.
  const hold = Math.max(1, Math.floor(sr / 9000))
  for (let i = 0; i < m.length; i++) if (i % hold) m[i] = m[i - (i % hold)]
  return m
}

/** A crew acknowledgement: what they say depends on the order and who they are. */
const ack = (kind: OrderKind | 'select', faction: FactionId, tier: Tier = 'frigate'): Recipe => (sr, r) => {
  // Small craft answer higher and quicker, flagships lower.
  const shift = { fighter: 4, gunship: 2, frigate: 0, cruiser: -2, capital: -4, station: -5, mine: 0, defense: 0 }[tier]
  if (faction === 'droid') {
    const contour = { select: 0, move: 1, attack: -1, attackMove: -0.5, patrol: 0.5, hold: 0, stop: -1, rally: 1, target: 1.5 }[kind]
    const count = kind === 'select' ? 3 + Math.floor(r() * 3) : 4 + Math.floor(r() * 3)
    return radio(sr, chatter(sr, r, count, contour, 360 * semi(shift)), false)
  }
  const tunes: Record<OrderKind | 'select', [number, number][]> = {
    select: [[7, 0.05], [12, 0.07]],
    move: [[0, 0.05], [7, 0.08]],
    attack: [[12, 0.05], [7, 0.05], [0, 0.09]],
    attackMove: [[7, 0.05], [0, 0.08]],
    patrol: [[0, 0.05], [5, 0.05], [0, 0.07]],
    hold: [[5, 0.16]],
    stop: [[0, 0.05], [0, 0.05]],
    rally: [[12, 0.05], [19, 0.1]],
    target: [[12, 0.03], [12, 0.03], [12, 0.03], [19, 0.12]],
  }
  const base = 466 * semi(shift)
  const wave = kind === 'attack' || kind === 'target' ? 'sqr' : 'tri'
  const msg = melody(sr, base, tunes[kind], wave)
  // Flagships and stations add a low bridge tone under the beeps.
  if (tier === 'capital' || tier === 'station') {
    const o = new Osc()
    const hum = render(sr, msg.length / sr, (t) => o.saw(110, sr) * 0.3 * Math.min(1, t / 0.02))
    for (let i = 0; i < msg.length; i++) msg[i] = msg[i] * 0.8 + hum[i] * 0.4
  }
  return radio(sr, msg)
}

/** A soft tactile click for buttons. */
const click: Recipe = (sr, r) => {
  const o = new Osc()
  const f = 900 + r() * 150
  return render(sr, 0.04, (t) => o.sin(glide(f, f * 0.6, t, 0.03), sr) * ad(t, 0.001, 0.01) + noise() * ad(t, 0.0002, 0.002) * 0.3)
}

/** Arming a command: a little rising tick. */
const arm: Recipe = (sr) => {
  const o = new Osc()
  return render(sr, 0.08, (t) => o.tri(glide(480, 860, t, 0.05), sr) * ad(t, 0.002, 0.03))
}

/** Denied: two low, dull blips. */
const denied: Recipe = (sr) => {
  const o = new Osc()
  const f = new Svf()
  return render(sr, 0.28, (t) => {
    const fr = t < 0.12 ? 220 : 175
    const on = t < 0.1 || (t > 0.13 && t < 0.25) ? 1 : 0
    return f.run(o.sqr(fr, sr), 900, 0.7, sr).low * on
  })
}

/** Something clunks into the build queue: a relay, a latch, a confirm beep. */
const queue = (cancel: boolean): Recipe => (sr, r) => {
  const beep = melody(sr, 660, cancel ? [[0, 0.04], [-5, 0.06]] : [[0, 0.04], [5, 0.06]], 'sin')
  return layers(sr, [{ data: metal(true)(sr, r), gain: 0.35 }, { data: click(sr, r), gain: 0.5, at: 0.02 }, { data: beep, gain: 0.5, at: cancel ? 0 : 0.06 }])
}

/** Data streaming into the research lab: a quick climbing arpeggio. */
const researchStart: Recipe = (sr) => {
  const notes: [number, number][] = [0, 4, 7, 11, 14, 19].map((n) => [n, 0.035])
  return melody(sr, 330, notes, 'sin', 0.006)
}

/** A bell-like chord: for research done and similar good news. */
function bells(sr: number, root: number, chord: number[], len: number, stagger = 0.06) {
  const os = chord.map(() => [new Osc(), new Osc()])
  return render(sr, len, (t) =>
    chord.reduce((s, n, k) => {
      const lt = t - k * stagger
      if (lt < 0) return s
      const f = root * semi(n)
      return s + (os[k][0].sin(f, sr) + os[k][1].sin(f * 2.76, sr) * 0.12) * ad(lt, 0.003, len * 0.35)
    }, 0),
  )
}

/** A brass-ish swell: saws through a filter that opens with the note. */
function brass(sr: number, root: number, chords: [number[], number][], tail = 0.6) {
  const total = chords.reduce((s, [, d]) => s + d, 0) + tail
  const os = Array.from({ length: 4 }, () => [new Osc(Math.random()), new Osc(Math.random())])
  const f = new Svf()
  return render(sr, total, (t) => {
    let start = 0
    let idx = chords.length - 1
    for (let k = 0; k < chords.length; k++) {
      if (t < start + chords[k][1]) {
        idx = k
        break
      }
      start += chords[k][1]
    }
    if (idx === chords.length - 1 && t >= start) start = chords.slice(0, -1).reduce((s, [, d]) => s + d, 0)
    const [notes, d] = chords[idx]
    const lt = t - start
    const last = idx === chords.length - 1
    const env = Math.min(1, lt / 0.05) * (last ? Math.exp(-Math.max(0, lt - d * 0.6) / (tail * 0.5)) : Math.min(1, (d - lt) / 0.03 + 0.2))
    const x = notes.reduce((s, n, k) => s + os[k][0].saw(root * semi(n), sr) + os[k][1].saw(root * semi(n) * 1.004, sr), 0)
    return f.run(x, 500 + 2600 * Math.min(1, lt / 0.25), 0.6, sr).low * env
  })
}

/** A timpani-ish thump for fanfares. */
const drum = (sr: number) => {
  const o = new Osc()
  return render(sr, 0.5, (t) => o.sin(glide(110, 70, t, 0.2), sr) * ad(t, 0.003, 0.18) + noise() * ad(t, 0.001, 0.01) * 0.2)
}

/** A ship rolls out of the yard: hangar doors, a gust, and the crew reporting in. Flagships get a horn. */
const shipReady = (faction: FactionId, tier: Tier): Recipe => (sr, r) => {
  const parts = [{ data: metal(true)(sr, r), gain: 0.3 }, { data: launch(sr, r), gain: 0.5, at: 0.05 }, { data: ack('select', faction, tier)(sr, r), gain: 0.7, at: 0.3 }]
  if (tier === 'capital') parts.push({ data: brass(sr, 110, [[[0, 7, 12], 1.0]], 0.8), gain: 0.8, at: 0 })
  return layers(sr, parts)
}

/** Construction starting: three hammer blows on hull plating. */
const construct: Recipe = (sr, r) => layers(sr, [0, 0.16, 0.3].map((at) => ({ data: metal(r() < 0.5)(sr, r), at, gain: 0.8 })))

/** A mining platform spinning up its drills. */
const drillUp: Recipe = (sr) => {
  const o = new Osc()
  const f = new Svf()
  const spin = render(sr, 1.1, (t) => f.run(o.saw(glide(40, 160, t, 0.8), sr) + noise() * 0.3, 900, 0.6, sr).low * Math.min(1, t / 0.2) * ad(t - 0.6, 0.01, 0.3))
  return layers(sr, [{ data: spin }, { data: bells(sr, 660, [0, 7], 0.5, 0.05), gain: 0.4, at: 0.7 }])
}

/** A defense platform's guns charging up. */
const weaponsOnline: Recipe = (sr, r) => {
  const o = new Osc()
  const whine = render(sr, 0.8, (t) => o.sin(glide(150, 900, t, 0.6), sr) * Math.min(1, t / 0.3) * ad(t - 0.6, 0.005, 0.08))
  return layers(sr, [{ data: whine, gain: 0.6 }, { data: metal(true)(sr, r), gain: 0.7, at: 0.62 }, { data: turbolaser(sr, r), gain: 0.4, at: 0.66 }])
}

/** A scanner sweep and a ping: ore surveyed. */
const scan: Recipe = (sr) => {
  const o = new Osc()
  const p = new Osc()
  return render(sr, 0.9, (t) => {
    const sweep = o.sin(glide(280, 1300, t, 0.4), sr) * (0.6 + 0.4 * Math.sin(TAU * 24 * t)) * ad(t, 0.02, 0.18) * (t < 0.45 ? 1 : 0)
    const ping = p.sin(880, sr) * ad(t - 0.42, 0.002, 0.2) + p.sin(880 * 2, sr) * 0.1 * ad(t - 0.42, 0.002, 0.08)
    return sweep * 0.6 + ping
  })
}

/** A klaxon: two tones alternating, harsher for the station. */
const klaxon = (station: boolean): Recipe => (sr) => {
  const o = new Osc()
  const f = new Svf()
  const reps = station ? 4 : 2
  return render(sr, reps * 0.36, (t) => {
    const phase = t % 0.36
    const fr = phase < 0.18 ? (station ? 440 : 560) : station ? 330 : 440
    const on = phase % 0.18 < 0.16 ? 1 : 0
    return soft(f.run(o.sqr(fr, sr) + o.saw(fr * 1.5, sr) * 0.3, 1500, 0.5, sr).low * 1.6) * on * 0.8
  })
}

/** Tape-stop down (pause) or spin-up (resume). */
const tape = (down: boolean): Recipe => (sr) => {
  const o = new Osc()
  const o2 = new Osc()
  return render(sr, 0.35, (t) => {
    const fr = down ? glide(700, 60, t, 0.3) : glide(60, 700, t, 0.25)
    return (o.tri(fr, sr) + o2.sin(fr * 1.5, sr) * 0.5) * (down ? ad(t, 0.005, 0.15) : Math.min(1, t / 0.2) * ad(t - 0.25, 0.005, 0.04))
  })
}

/** A menu sliding open or shut. */
const swoosh = (open: boolean): Recipe => (sr) => {
  const bp = new Svf()
  return render(sr, 0.25, (t) => bp.run(noise(), open ? glide(400, 1800, t, 0.2) : glide(1800, 400, t, 0.2), 0.4, sr).band * Math.sin(Math.PI * Math.min(1, t / 0.22)) ** 2)
}

const abilitySound = (id: AbilityId): Recipe => (sr, r) => {
  if (id === 'shieldBoost') {
    const shimmer = bells(sr, 440, [0, 4, 7, 12, 16], 1.0, 0.04)
    return layers(sr, [{ data: shimmer }, { data: swoosh(true)(sr, r), gain: 0.6 }])
  }
  if (id === 'flakBarrage') {
    const o = new Osc()
    const charge = render(sr, 0.35, (t) => o.saw(glide(220, 900, t, 0.35), sr) * Math.min(1, t / 0.3) * 0.5)
    return layers(sr, [{ data: charge }, ...Array.from({ length: 8 }, (_, k) => ({ data: flak(sr, r), at: 0.32 + k * 0.07, gain: 0.7 }))])
  }
  if (id === 'repairSwarm') {
    const chirps = Array.from({ length: 6 }, (_, k) => ({ data: chatter(sr, r, 3, 1, 520), at: k * 0.14, gain: 0.5 }))
    return layers(sr, [...chirps, { data: metal(false)(sr, r), at: 0.2, gain: 0.4 }, { data: metal(false)(sr, r), at: 0.55, gain: 0.4 }])
  }
  if (id === 'tractor') {
    const c = new Osc()
    const m = new Osc()
    return render(sr, 1.4, (t) => c.sin(90 + 60 * m.sin(3.5, sr) + 30 * Math.sin(TAU * 0.7 * t), sr) * Math.min(1, t / 0.2) * ad(t - 1.0, 0.01, 0.2))
  }
  if (id === 'broadside') {
    const o = new Osc()
    const charge = render(sr, 0.6, (t) => o.saw(glide(80, 400, t, 0.6), sr) * Math.min(1, t / 0.5) * 0.6)
    return layers(sr, [{ data: charge }, { data: turbolaser(sr, r), at: 0.58 }, { data: explosion(0)(sr, r), at: 0.6, gain: 0.5 }])
  }
  return layers(sr, Array.from({ length: 4 }, (_, k) => ({ data: launch(sr, r), at: k * 0.12, gain: 0.8 })))
}

/** Crew answers, interface sounds and abilities play at half the level they were first tuned at:
 * heard on every click, they were too loud next to the battle. */
const UI_LEVEL = 0.5

// --- Engine ---------------------------------------------------------------------------------------------

type Mix = Record<Bus, number>

/** A long, dark, stereo tail made of decaying noise, for the convolution reverb. */
function impulse(ctx: BaseAudioContext, secs: number) {
  const n = Math.ceil(secs * ctx.sampleRate)
  const buf = ctx.createBuffer(2, n, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    let lp = 0
    for (let i = 0; i < n; i++) {
      lp += 0.25 * (noise() - lp)
      d[i] = lp * Math.pow(1 - i / n, 3)
    }
  }
  return buf
}

export class EmpiresSound {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private buses: Partial<Record<Bus, GainNode>> = {}
  private verb: GainNode | null = null
  private bank = new Map<string, AudioBuffer[]>()
  private recent = new Map<string, number[]>()
  private ackSrc: AudioBufferSourceNode | null = null
  private drone: { stop: () => void } | null = null
  private rumble: GainNode | null = null
  private heat = 0
  muted: boolean
  volume: number
  mix: Mix

  constructor() {
    let m = false
    let v = 0.7
    let mix: Mix = { sfx: 1, ui: 0.9, amb: 0.7 }
    try {
      m = localStorage.getItem(MUTE_KEY) === '1'
      const raw = localStorage.getItem(VOLUME_KEY)
      if (raw) v = Math.min(1, Math.max(0, Number(raw)))
      const mx = JSON.parse(localStorage.getItem(MIX_KEY) ?? 'null') as Partial<Mix> | null
      if (mx) mix = { ...mix, ...mx }
    } catch {
      // Private mode: defaults.
    }
    this.muted = m
    this.volume = v
    this.mix = mix
  }

  /** Browsers only allow audio after a click or key press. */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return
      const ctx = (this.ctx = new Ctx())
      this.master = ctx.createGain()
      const comp = ctx.createDynamicsCompressor()
      comp.threshold.value = -16
      comp.knee.value = 10
      comp.ratio.value = 5
      comp.attack.value = 0.004
      comp.release.value = 0.2
      const limit = ctx.createDynamicsCompressor()
      limit.threshold.value = -2
      limit.ratio.value = 20
      limit.attack.value = 0.001
      this.master.connect(comp).connect(limit).connect(ctx.destination)
      const conv = ctx.createConvolver()
      conv.buffer = impulse(ctx, 2.6)
      this.verb = ctx.createGain()
      this.verb.gain.value = 0.22
      this.verb.connect(conv).connect(this.master)
      // A gentle treble cut on everything: no piercing highs.
      const shelf = ctx.createBiquadFilter()
      shelf.type = 'highshelf'
      shelf.frequency.value = 5000
      shelf.gain.value = -6
      shelf.connect(this.master)
      for (const b of ['sfx', 'ui', 'amb'] as Bus[]) {
        const g = ctx.createGain()
        g.connect(shelf)
        this.buses[b] = g
      }
      this.applyVolume()
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  private applyVolume() {
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume * 0.8
    for (const b of ['sfx', 'ui', 'amb'] as Bus[]) if (this.buses[b]) this.buses[b]!.gain.value = this.mix[b]
  }

  setMuted(m: boolean) {
    this.muted = m
    this.save(MUTE_KEY, m ? '1' : '0')
    this.applyVolume()
  }

  setVolume(v: number) {
    this.volume = v
    this.save(VOLUME_KEY, String(v))
    this.applyVolume()
  }

  setMix(bus: Bus, v: number) {
    this.mix = { ...this.mix, [bus]: v }
    this.save(MIX_KEY, JSON.stringify(this.mix))
    this.applyVolume()
  }

  private save(k: string, v: string) {
    try {
      localStorage.setItem(k, v)
    } catch {
      // ignore
    }
  }

  /** The takes of a sound, rendered the first time it's needed. */
  private takes(name: string, recipe: Recipe, count = 3) {
    let list = this.bank.get(name)
    if (!list) {
      const ctx = this.ctx!
      list = Array.from({ length: count }, () => {
        const data = recipe(ctx.sampleRate, Math.random)
        const b = ctx.createBuffer(1, data.length, ctx.sampleRate)
        b.getChannelData(0).set(data)
        return b
      })
      this.bank.set(name, list)
    }
    return list
  }

  /** At most `max` of one kind of sound per `window` seconds. */
  private allow(kind: string, max: number, window = 0.08) {
    const now = this.ctx!.currentTime
    const list = (this.recent.get(kind) ?? []).filter((t) => now - t < window)
    if (list.length >= max) return false
    list.push(now)
    this.recent.set(kind, list)
    return true
  }

  private ready() {
    return !!this.ctx && !this.muted && this.ctx.state === 'running'
  }

  /** Play one take: panned, and further away, quieter, darker and wetter. */
  private play(name: string, recipe: Recipe, o: { bus?: Bus; gain?: number; where?: Where; rate?: number; verb?: number; takes?: number } = {}) {
    const ctx = this.ctx!
    const list = this.takes(name, recipe, o.takes)
    const src = ctx.createBufferSource()
    src.buffer = list[Math.floor(Math.random() * list.length)]
    src.playbackRate.value = (o.rate ?? 1) * (0.97 + Math.random() * 0.06)
    const g = ctx.createGain()
    const near = o.where ? o.where.gain : 1
    g.gain.value = (o.gain ?? 1) * near
    let tail: AudioNode = g
    if (o.where) {
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 700 + 17000 * near * near
      const p = ctx.createStereoPanner()
      p.pan.value = Math.max(-1, Math.min(1, o.where.pan))
      g.connect(lp).connect(p)
      tail = p
    }
    src.connect(g)
    tail.connect(this.buses[o.bus ?? 'sfx']!)
    const send = ctx.createGain()
    send.gain.value = (o.verb ?? 0.35) * (o.where ? 0.6 + (1 - near) * 0.8 : 1)
    tail.connect(send).connect(this.verb!)
    src.start()
    src.onended = () => {
      g.disconnect()
      tail.disconnect()
      send.disconnect()
    }
    return src
  }

  /** Render the battle's sounds ahead of time (a few ms each, the big explosions ~80 ms), a little
   * at a time so the page stays responsive, instead of hitching the first time each one plays. */
  async warm(faction: FactionId) {
    if (!this.ctx) return
    const jobs: [string, Recipe, number][] = [
      ['laser-republic', blaster(false), 4], ['laser-droid', blaster(true), 4], ['turbo', turbolaser, 4], ['flak', flak, 4], ['missile', missile, 3],
      ['shield', shieldHit, 4], ['hull', metal(false), 4], ['hull-heavy', metal(true), 4],
      ['boom0', explosion(0), 3], ['boom1', explosion(1), 3], ['boom2', explosion(2), 2],
      ['hpdown', hardpointDown, 3], ['shdown', shieldsDown, 3], ['launch', launch, 3],
      ['click', click, 3], ['arm', arm, 2], ['queue', queue(false), 2], ['unqueue', queue(true), 2], ['construct', construct, 2],
      ...(['fighter', 'gunship', 'frigate', 'cruiser', 'capital', 'station'] as Tier[]).map((t): [string, Recipe, number] => [`sel-${faction}-${t}`, ack('select', faction, t), 4]),
      ...(['move', 'attack', 'attackMove'] as OrderKind[]).map((k): [string, Recipe, number] => [`ord-${k}-${faction}-frigate`, ack(k, faction, 'frigate'), 4]),
    ]
    for (const [name, recipe, n] of jobs) {
      if (!this.ctx) return
      this.takes(name, recipe, n)
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  // --- Battle ------------------------------------------------------------------------------------------

  fire(kind: WeaponKind, where: Where, faction: FactionId) {
    if (!this.ready()) return
    this.feel(kind === 'turbo' ? 0.4 : 0.1, where)
    if (where.gain < 0.03) return
    if (kind === 'laser' && this.allow('laser', 3)) this.play(`laser-${faction}`, blaster(faction === 'droid'), { where, gain: 0.55, takes: 4 })
    else if (kind === 'turbo' && this.allow('turbo', 3, 0.1)) this.play('turbo', turbolaser, { where, gain: 0.8, rate: faction === 'droid' ? 0.92 : 1, takes: 4 })
    else if (kind === 'flak' && this.allow('flak', 3)) this.play('flak', flak, { where, gain: 0.55, takes: 4 })
    else if (kind === 'missile' && this.allow('missile', 2, 0.15)) this.play('missile', missile, { where, gain: 0.6 })
  }

  hit(shield: boolean, heavy: boolean, where: Where) {
    if (!this.ready() || where.gain < 0.03) return
    if (shield) {
      if (this.allow('shield', 2, 0.1)) this.play('shield', shieldHit, { where, gain: 0.45, takes: 4 })
    } else if (this.allow('hull', heavy ? 3 : 2, 0.1)) this.play(heavy ? 'hull-heavy' : 'hull', metal(heavy), { where, gain: heavy ? 0.7 : 0.4, takes: 4 })
  }

  /** Size is the ship's size in world units: fighters ~30, capital ships ~380. */
  boom(size: number, where: Where) {
    if (!this.ready()) return
    const cls = size > 200 ? 2 : size > 60 ? 1 : 0
    this.feel([0.6, 1.5, 4][cls], where)
    if (where.gain < 0.02) return
    if (!this.allow(`boom${cls}`, [4, 3, 2][cls], 0.15)) return
    this.play(`boom${cls}`, explosion(cls), { where, gain: [0.6, 0.85, 1][cls], verb: 0.5, takes: cls === 2 ? 2 : 3 })
  }

  hardpointDown(where: Where) {
    if (this.ready() && where.gain > 0.03 && this.allow('hpdown', 2, 0.2)) this.play('hpdown', hardpointDown, { where, gain: 0.8 })
  }

  shieldsDown(where: Where) {
    if (this.ready() && where.gain > 0.05 && this.allow('shdown', 1, 0.3)) this.play('shdown', shieldsDown, { where, gain: 0.6 })
  }

  launch(where: Where) {
    if (this.ready() && where.gain > 0.05 && this.allow('launch', 2, 0.2)) this.play('launch', launch, { where, gain: 0.5 })
  }

  ability(id: AbilityId, where?: Where) {
    if (this.ready()) this.play(`ab-${id}`, abilitySound(id), { where, gain: 0.8 * UI_LEVEL, takes: 2 })
  }

  // --- Crew and interface ---------------------------------------------------------------------------------

  /** A crew answering, over the radio. A new answer cuts off the last one. */
  private say(name: string, recipe: Recipe) {
    if (!this.ready()) return
    try {
      this.ackSrc?.stop()
    } catch {
      // Already over.
    }
    this.ackSrc = this.play(name, recipe, { bus: 'ui', gain: 0.6 * UI_LEVEL, verb: 0.15, takes: 4 })
  }

  select(faction: FactionId, tier: Tier) {
    if (this.allow('select', 1, 0.12)) this.say(`sel-${faction}-${tier}`, ack('select', faction, tier))
  }

  order(kind: OrderKind, faction: FactionId, tier: Tier = 'frigate') {
    if (this.ready() && this.allow('order', 1, 0.1)) this.say(`ord-${kind}-${faction}-${tier}`, ack(kind, faction, tier))
  }

  private ui(name: string, recipe: Recipe, gain = 0.6, takes = 2) {
    if (this.ready()) this.play(name, recipe, { bus: 'ui', gain: gain * UI_LEVEL, verb: 0.12, takes })
  }

  click() {
    if (this.ready() && this.allow('click', 1, 0.04)) this.ui('click', click, 0.35, 3)
  }
  arm() {
    this.ui('arm', arm, 0.4)
  }
  error() {
    if (this.ready() && this.allow('error', 1, 0.2)) this.ui('error', denied, 0.45, 1)
  }
  queued() {
    this.ui('queue', queue(false), 0.55)
  }
  unqueued() {
    this.ui('unqueue', queue(true), 0.5)
  }
  researchStarted() {
    this.ui('research', researchStart, 0.4, 1)
  }
  researchDone() {
    this.ui('research-done', (sr) => bells(sr, 392, [0, 4, 7, 11, 14], 1.4), 0.55, 1)
  }
  shipReady(faction: FactionId, tier: Tier) {
    if (this.ready() && this.allow('ready', 1, 0.3)) this.play(`ready-${faction}-${tier}`, shipReady(faction, tier), { bus: 'ui', gain: 0.65 * UI_LEVEL, verb: 0.2, takes: 2 })
  }
  constructing() {
    this.ui('construct', construct, 0.5)
  }
  structureDone(kind: 'mine' | 'defense') {
    this.ui(`done-${kind}`, kind === 'mine' ? drillUp : weaponsOnline, 0.6, 1)
  }
  surveyed() {
    this.ui('scan', scan, 0.5, 1)
  }
  capture(ours: boolean) {
    this.ui(ours ? 'beacon-won' : 'beacon-lost', (sr) => (ours ? bells(sr, 440, [0, 7, 12, 16], 1.1, 0.07) : bells(sr, 311, [7, 3, 0, -5], 1.1, 0.09)), 0.55, 1)
  }
  levelUp() {
    this.ui('levelup', (sr) => brass(sr, 196, [[[0, 4, 7], 0.22], [[2, 5, 9], 0.22], [[4, 7, 12], 0.7]], 0.6), 0.55, 1)
  }
  alarm(station: boolean) {
    if (this.ready() && this.allow('alarm', 1, 2)) this.ui(station ? 'klaxon-st' : 'klaxon', klaxon(station), 0.45, 1)
  }
  eliminated(friendly: boolean) {
    this.ui(friendly ? 'out-ally' : 'out-enemy', (sr) =>
      layers(sr, [{ data: explosion(2)(sr, Math.random), gain: 0.6 }, { data: friendly ? brass(sr, 147, [[[0, 3, 7], 1.2]], 0.8) : brass(sr, 196, [[[0, 4, 7], 0.3], [[5, 9, 12], 0.9]], 0.6), at: 0.3, gain: 0.6 }]),
      0.6, 1)
  }
  menu(open: boolean) {
    this.ui(open ? 'menu-open' : 'menu-close', swoosh(open), 0.35)
  }
  pause(paused: boolean) {
    this.ui(paused ? 'pause' : 'resume', tape(paused), 0.4, 1)
  }
  victory() {
    this.ui('victory', (sr) =>
      layers(sr, [
        { data: brass(sr, 196, [[[0, 4, 7], 0.3], [[0, 4, 7], 0.15], [[5, 9, 12], 0.3], [[7, 11, 14], 0.3], [[12, 16, 19], 1.6]], 1.2) },
        ...[0, 0.45, 0.9, 1.05].map((at) => ({ data: drum(sr), at, gain: 0.7 })),
      ]),
      0.75, 1)
  }
  defeat() {
    this.ui('defeat', (sr) =>
      layers(sr, [{ data: brass(sr, 147, [[[0, 3, 7], 0.6], [[-2, 2, 5], 0.6], [[-5, -2, 3], 1.6]], 1.2) }, { data: explosion(2)(sr, Math.random), gain: 0.35, at: 0.1 }]),
      0.7, 1)
  }

  // --- Ambience -------------------------------------------------------------------------------------------

  /** Combat adds to the distant rumble, more for fights far from the camera. */
  private feel(amount: number, where: Where) {
    this.heat = Math.min(6, this.heat + amount * (1 - where.gain) * 0.12)
  }

  /** Call every frame: the rumble follows the fighting, and fades when it stops. */
  ambience(dt: number) {
    if (!this.rumble || !this.ctx) return
    this.heat *= Math.exp(-dt / 2.5)
    this.rumble.gain.setTargetAtTime(Math.min(0.5, this.heat * 0.12), this.ctx.currentTime, 0.4)
  }

  /** The hum of a ship's bridge in deep space, a slow wind of static, and the far-off battle rumble. */
  startDrone() {
    if (!this.ctx || this.drone) return
    const ctx = this.ctx
    const out = this.buses.amb!
    const g = ctx.createGain()
    g.gain.value = 0.0001
    g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 3)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = 240
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.06
    const lg = ctx.createGain()
    lg.gain.value = 110
    lfo.connect(lg).connect(f.frequency)
    const oscs = [55, 55.3, 82.4, 110.4, 164.8].map((fr) => {
      const o = ctx.createOscillator()
      o.type = fr > 100 ? 'triangle' : 'sawtooth'
      o.frequency.value = fr
      o.connect(f)
      o.start()
      return o
    })
    f.connect(g).connect(out)
    lfo.start()
    // Static wind and the battle rumble both come from a looping noise sample.
    const n = ctx.sampleRate * 3
    const nb = ctx.createBuffer(1, n, ctx.sampleRate)
    const d = nb.getChannelData(0)
    for (let i = 0; i < n; i++) d[i] = noise()
    const wind = ctx.createBufferSource()
    wind.buffer = nb
    wind.loop = true
    const wf = ctx.createBiquadFilter()
    wf.type = 'bandpass'
    wf.Q.value = 2
    wf.frequency.value = 900
    const wl = ctx.createOscillator()
    wl.frequency.value = 0.045
    const wlg = ctx.createGain()
    wlg.gain.value = 500
    wl.connect(wlg).connect(wf.frequency)
    const wg = ctx.createGain()
    wg.gain.value = 0.025
    wind.connect(wf).connect(wg).connect(out)
    const rb = ctx.createBufferSource()
    rb.buffer = nb
    rb.loop = true
    rb.playbackRate.value = 0.5
    const rf = ctx.createBiquadFilter()
    rf.type = 'lowpass'
    rf.frequency.value = 160
    this.rumble = ctx.createGain()
    this.rumble.gain.value = 0
    rb.connect(rf).connect(this.rumble).connect(out)
    wind.start()
    wl.start()
    rb.start()
    this.drone = {
      stop: () => {
        const t = ctx.currentTime
        for (const node of [g, wg, this.rumble!]) {
          node.gain.cancelScheduledValues(t)
          node.gain.setValueAtTime(node.gain.value, t)
          node.gain.linearRampToValueAtTime(0, t + 0.6)
        }
        setTimeout(() => {
          for (const o of [...oscs, lfo, wl]) o.stop()
          wind.stop()
          rb.stop()
          g.disconnect()
          wg.disconnect()
          this.rumble?.disconnect()
          this.rumble = null
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
