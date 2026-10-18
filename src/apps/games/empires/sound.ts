import { FACTIONS, type AbilityId, type FactionId, type Tier, type WeaponKind } from './data'
import { MusicDirector, type MusicScene } from './music'
import { RETREAT_TIME, WARP_RESERVE, WARP_YARD } from './sim'
import { WARP_STYLE, type WarpStyle } from './warpfx.ts'
import { empiresMix, empiresMusic, empiresMuted, empiresVolume, type EmpiresBus, type EmpiresMix } from '../prefs'

export type { MusicScene }

// Empires At War sounds, all synthesised: no audio files. Each sound is rendered once, in a few
// slightly different takes, into a sample (small DSP below: oscillators, envelopes, a resonant
// filter, noise), then played through one of three buses: the battle, the interface (crew
// acknowledgements and alerts), and the ambience. Battle sounds are panned and, further away,
// quieter and muffled; everything gets a touch of a long, soft reverb.
//
// Music (music.ts): six separate pieces (menu, lobby, skirmish, skirmish combat, galaxy, galaxy
// alarm) with hard cuts — no shared bed. Combat heat and GC threats flip the in-game variants.
//
// Each faction has a set of its own (see SET): the Republic's clone crews answer over a squelchy
// radio with clean military beeps, and its guns are the films' blasters and turbolasers; the
// Confederacy is industrial and military, plasma guns and cannons with breeches clanking home and a
// command net of relays and pulse tones; the Swarm is alive, spitting, pulsing and chittering, its
// big ships groaning. The sound test (Menus.tsx) plays every faction's.


export type Where = { pan: number; gain: number }
/** Battle sounds, crews answering (and abilities), interface and alerts, ambience (the far-off
 * battle rumble) and music (adaptive score): each has its own volume. */
export type Bus = EmpiresBus
const BUSES: Bus[] = ['sfx', 'voice', 'ui', 'amb', 'music']
export type OrderKind = 'move' | 'attack' | 'attackMove' | 'patrol' | 'hold' | 'stop' | 'rally' | 'target'

/** A faction's sound set: the Republic's, the Confederacy's machine-shop military ('forge') or the
 * Swarm's living ships ('hive'). Picked by faction id: every sound of a side follows from it. */
export type SoundSet = 'republic' | 'forge' | 'hive'
export const SET: Record<FactionId, SoundSet> = { republic: 'republic', droid: 'forge', swarm: 'hive' }
/** How a set's crews answer: clone crews over the radio, the Confederacy's command net, the Swarm's
 * chitters. */
const VOICE: Record<FactionId, 'crew' | 'net' | 'hive'> = { republic: 'crew', droid: 'net', swarm: 'hive' }

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
  // A sample that isn't a number would silence everything sharing its bus (the reverb with it): drop it.
  for (let i = 0; i < n; i++) {
    const v = fn(i / sr, i)
    out[i] = Number.isFinite(v) ? v : 0
  }
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

/** The film's blaster trick: Ben Burtt struck a steel guy-wire, and the twang reached the
 * microphone highs first, lows after, as a falling "pew" that rang on. A click sent down a long
 * chain of all-pass filters does the same (each stage holds the lows back a little longer than the
 * highs), and fed back round a short loop it rings like the wire. `stages` and `a` set how long the
 * fall takes, `loop` how quickly it repeats, `fb` how long it rings. */
function wire(sr: number, secs: number, o: { stages: number; a: number; loop: number; fb: number; hiss?: number }) {
  const n = Math.ceil(secs * sr)
  const out = new Float32Array(n)
  const xs = new Float64Array(o.stages)
  const ys = new Float64Array(o.stages)
  const L = Math.max(1, Math.round(o.loop * sr))
  const burst = Math.ceil(0.002 * sr)
  for (let i = 0; i < n; i++) {
    let x = (i === 0 ? 1 : 0) + (i < burst ? noise() * (o.hiss ?? 0) * (1 - i / burst) : 0) + (i >= L ? out[i - L] * o.fb : 0)
    for (let k = 0; k < o.stages; k++) {
      const y = -o.a * x + xs[k] + o.a * ys[k]
      xs[k] = x
      ys[k] = y
      x = y
    }
    out[i] = x
  }
  // To a peak of 1, so the recipes can mix it by ear.
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]))
  for (let i = 0; i < n; i++) out[i] /= peak || 1
  return out
}

/** A starfighter's laser cannon, after the film's TIE fighters: a short, gritty, overdriven zap
 * that drops in pitch at once and stops, with no ring or tail. Kept between 300 Hz and 2.4 kHz so it
 * bites without being shrill. Droid fighters' are a little lower and buzzier. */
const fighterBlaster = (droid: boolean): Recipe => (sr, r) => {
  // One fall of the wire, without the loop that made it ring on.
  const chirp = wire(sr, 0.08, { stages: 70, a: 0.88, loop: 1, fb: 0 })
  const o1 = new Osc(r())
  const o2 = new Osc(r())
  const bp = new Svf()
  const lp = new Svf()
  const hp = new Svf()
  const f0 = (droid ? 1250 : 1500) * (0.94 + r() * 0.12)
  const f1 = droid ? 300 : 360
  return render(sr, 0.08, (t, i) => {
    const fr = glide(f0, f1, t, 0.045)
    // A saw and a square a fifth under it, for the snarl.
    const raw = o1.saw(fr, sr) * 0.7 + o2.sqr(fr * (droid ? 0.5 : 0.667), sr) * (droid ? 0.5 : 0.35)
    const zap = bp.run(raw + noise() * 0.25, glide(2200, 650, t, 0.05), 0.9, sr).band
    const v = (zap * 1.3 + chirp[i] * 0.5) * ad(t, 0.0004, 0.02)
    // Overdriven for grit, then held between 300 Hz and 2.4 kHz.
    const hot = soft(v * 3.2)
    const low = lp.run(hot, droid ? 2000 : 2400, 0.7, sr).low
    return low - hp.run(low, 300, 0.9, sr).low
  })
}

/** A warship's laser cannon: a fuller zap that falls in pitch through a resonant filter, with a
 * slower, deeper ring of the wire under it. */
const blaster = (droid: boolean): Recipe => (sr, r) => {
  const ring = wire(sr, 0.26, { stages: 200, a: 0.93, loop: 0.042 + r() * 0.008, fb: 0.38, hiss: 0.2 })
  const o1 = new Osc(r())
  const o2 = new Osc(r())
  const f = new Svf()
  const lp = new Svf()
  const f0 = (droid ? 1000 : 1250) * (0.92 + r() * 0.16)
  const f1 = droid ? 170 : 230
  return render(sr, 0.26, (t, i) => {
    const fr = glide(f0, f1, t, 0.16)
    const tone = droid ? o1.sqr(fr, sr) * 0.6 + o2.sqr(fr * 1.012, sr) * 0.4 : o1.saw(fr, sr) * 0.7 + o2.sin(fr * 2, sr) * 0.3
    const cut = glide(3200, 600, t, 0.16)
    const zap = (f.run(tone + noise() * 0.08, cut, 0.35, sr).band * 1.8 + f.low * 0.4) * ad(t, 0.002, droid ? 0.05 : 0.06)
    const v = zap * 1.4 + ring[i] * 0.45 * ad(t, 0.001, 0.07)
    return soft(lp.run(v, 2800, 0.7, sr).low)
  })
}

/** A turbolaser: a heavy zap on top of a deep thump, with a burst of hiss. */
const turbolaser: Recipe = (sr, r) => {
  const z = new Osc()
  const z2 = new Osc()
  const b = new Osc()
  const fz = new Svf()
  const fn = new Svf()
  const lp = new Svf()
  const f0 = 760 * (0.9 + r() * 0.2)
  // A big, slow wire under it: the long ringing "pkoww" of a capital ship's battery.
  const ring = wire(sr, 0.7, { stages: 260, a: 0.95, loop: 0.065 + r() * 0.01, fb: 0.45, hiss: 0.2 })
  return render(sr, 0.7, (t, i) => {
    const fr = glide(f0, 70, t, 0.32)
    const zap = fz.run(z.saw(fr, sr) + z2.saw(fr * 1.505, sr) * 0.5, glide(2600, 260, t, 0.3), 0.5, sr).band * ad(t, 0.002, 0.12)
    const thump = b.sin(glide(140, 38, t, 0.4), sr) * ad(t, 0.004, 0.2)
    const hiss = fn.run(noise(), glide(6000, 400, t, 0.25), 0.8, sr).low * ad(t, 0.001, 0.07)
    const twang = lp.run(ring[i], 1800, 0.8, sr).low * 0.8 * ad(t, 0.002, 0.16)
    return soft(zap * 1.5 + thump * 1.3 + hiss * 0.5 + twang)
  })
}

/** An ion cannon: a deep electric "vwomm" that wobbles as it falls, over a crackle of discharge.
 * Over in half a second. */
const ionShot: Recipe = (sr, r) => {
  const o1 = new Osc(r())
  const o2 = new Osc(r())
  const lp = new Svf()
  const bp = new Svf()
  const f0 = 230 * (0.92 + r() * 0.16)
  return render(sr, 0.45, (t) => {
    const fr = glide(f0, 70, t, 0.32)
    const wob = 1 + 0.3 * Math.sin(TAU * 26 * t)
    const tone = lp.run(o1.saw(fr, sr) + o2.sqr(fr * 1.01, sr) * 0.5, glide(1400, 280, t, 0.3), 1.6, sr).low * wob * ad(t, 0.004, 0.15)
    const crackle = bp.run(noise() * (r() < 0.08 ? 1 : 0.15), 1700, 1.2, sr).band * ad(t, 0.001, 0.09)
    return soft(tone * 1.5 + crackle * 0.8)
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

/** A missile or torpedo leaving its tube: a soft "thoonk" and a short, falling spit of exhaust
 * that's gone in a quarter of a second (a long rising hiss read as a whoosh over everything). */
const missile: Recipe = (sr, r) => {
  const bp = new Svf()
  const o = new Osc()
  const hp = new Svf()
  const f = 1300 + r() * 300
  return render(sr, 0.25, (t) => {
    const thoonk = o.sin(glide(150, 70, t, 0.05), sr) * ad(t, 0.002, 0.04)
    const spit = bp.run(noise(), glide(f, 500, t, 0.15), 0.8, sr).band * ad(t, 0.004, 0.05)
    const v = thoonk * 0.35 + spit * 1.4
    return soft(v - hp.run(v, 90, 0.8, sr).low)
  })
}

/** A bolt striking a hull: a short, dull crunch with a spit of sparks. No ringing partials (those
 * read as glass); a heavy hit adds a low thump under it. */
const impact = (heavy: boolean): Recipe => (sr, r) => {
  const len = heavy ? 0.2 : 0.09
  const lp = new Svf()
  const bp = new Svf()
  const hp = new Svf()
  const o = new Osc()
  const snaps = Array.from({ length: heavy ? 14 : 7 }, () => [r() ** 1.5 * (heavy ? 0.08 : 0.04), 0.4 + r() * 0.6] as const)
  return render(sr, len, (t) => {
    let crackle = 0
    for (const [at, g] of snaps) {
      const d = t - at
      if (d >= 0 && d < 0.002) crackle += noise() * g * (1 - d / 0.002)
    }
    const crunch = lp.run(noise(), heavy ? 900 : 1300, 0.6, sr).low * ad(t, 0.0005, heavy ? 0.045 : 0.016)
    const sparks = bp.run(crackle, 1700, 1.2, sr).band * ad(t, 0, heavy ? 0.05 : 0.025)
    const thump = o.sin(glide(heavy ? 100 : 160, heavy ? 42 : 90, t, 0.05), sr) * ad(t, 0.002, heavy ? 0.07 : 0.015)
    const v = crunch * 1.4 + sparks * 0.9 + (heavy ? thump * 1.1 : 0)
    return soft(v - hp.run(v, heavy ? 60 : 140, 0.8, sr).low)
  })
}

/** A bolt splashing on a deflector shield: an electric crackle that sizzles down, over a soft,
 * shimmering hum of the field taking the hit. Airy, with nothing low or knocking in it. */
const shieldHit: Recipe = (sr, r) => {
  const bp = new Svf()
  const hp = new Svf()
  const o1 = new Osc(r())
  const o2 = new Osc(r())
  const f = (520 + r() * 80) | 0
  // Sparks: a few dozen tiny snaps, thinning out.
  const snaps = Array.from({ length: 28 }, () => [r() ** 1.8 * 0.22, 0.4 + r() * 0.6] as const)
  return render(sr, 0.3, (t) => {
    let crackle = 0
    for (const [at, g] of snaps) {
      const d = t - at
      if (d >= 0 && d < 0.003) crackle += noise() * g * (1 - d / 0.003)
    }
    const sizzle = bp.run(noise() * 0.5 + crackle, glide(2200, 900, t, 0.2), 1.4, sr).band
    const vib = 1 + 0.012 * Math.sin(TAU * 23 * t)
    const hum = (o1.sin(f * vib, sr) + o2.sin(f * 1.505 * vib, sr) * 0.5) * ad(t, 0.012, 0.09)
    const v = sizzle * ad(t, 0.001, 0.07) * 1.6 + hum * 0.35
    // Off the bottom: below 350 Hz a hit starts to knock.
    return soft(v - hp.run(v, 350, 0.8, sr).low)
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

/** An explosion in the film's manner: a deep "thoom" whose pitch drops away under a dark roar
 * (no fizz on top), crackling debris, and for bigger ships the hull's plates shearing (a slow, low
 * ring of the wire) and secondary blasts rolling on. Capital ships groan as they break up. Size 0
 * is a fighter, 1 a frigate or cruiser, 2 a capital ship. */
const explosion = (size: 0 | 1 | 2, organic = false): Recipe => (sr, r) => {
  const len = [0.5, 1.9, 3.6][size]
  const body = new Svf()
  const crk = new Svf()
  const sub = new Osc()
  const groanO = new Osc()
  const groanF = new Svf()
  const ringLp = new Svf()
  const pops = Array.from({ length: [10, 22, 40][size] }, () => [r() * len * 0.8, 0.3 + r() * 0.7] as const)
  const secondary = size === 2 ? [0.35 + r() * 0.2, 0.8 + r() * 0.3, 1.3 + r() * 0.4] : size === 1 ? [0.3 + r() * 0.2] : []
  // A living hull tears rather than shears: no ringing plates, a wet splat and bubbling instead.
  const shear = size && !organic ? wire(sr, len, { stages: 160, a: 0.96, loop: 0.08 + r() * 0.03, fb: 0.55, hiss: 0.4 }) : null
  const splatF = new Svf()
  const bubbles = organic ? Array.from({ length: [6, 14, 22][size] }, () => [r() * len * 0.6, 140 + r() * 260, 0.012 + r() * 0.025] as const) : []
  // A fighter's is a soft, airy pop: a quick thump without much pitch to it, or it reads as a knock.
  const f0 = [120, 130, 95][size] * (0.9 + r() * 0.2)
  const f1 = [48, 34, 26][size]
  return render(sr, len, (t, i) => {
    const crack = crk.run(noise(), 1800, 0.8, sr).high * ad(t, 0.0005, 0.012)
    let env = ad(t, 0.003, [0.07, 0.38, 0.75][size])
    for (const s of secondary) env += 0.7 * ad(t - s, 0.01, 0.35)
    // A fighter's darkens fast and is over, or the falling roar reads as a whoosh.
    const roar = body.run(noise(), glide([1800, 1900, 1500][size], [300, 120, 80][size], t, [0.08, len * 0.6, len * 0.6][size]), 0.6, sr).low * env
    // The "thoom": fast pitch drop, the punch of it.
    const thoom = sub.sin(glide(f0, f1, t, [0.06, 0.25, 0.4][size]), sr) * ad(t, 0.004, [0.08, 0.3, 0.6][size])
    let debris = 0
    for (const [at, g] of pops) {
      const d = t - at
      if (d >= 0 && d < 0.012) debris += noise() * g * (1 - d / 0.012)
    }
    const plates = shear ? ringLp.run(shear[i], 900, 0.8, sr).low * ad(t, 0.02, len * 0.3) : 0
    // A dying capital ship's hull groans: a low, wavering tone sinking through a closing filter.
    const groan =
      size === 2 || (organic && size === 1)
        ? groanF.run(groanO.saw(glide(62, 34, t, len) * (1 + 0.03 * Math.sin(TAU * 1.7 * t)), sr), glide(420, 140, t, len), 1.2, sr).low * ad(t - 0.4, 0.5, 1.1)
        : 0
    let wet = 0
    if (organic) {
      wet = splatF.run(noise(), 700, 0.7, sr).low * ad(t, 0.002, [0.05, 0.2, 0.35][size])
      for (const [at, f, l] of bubbles) wet += bubble(t, at, f, l) * 0.25
    }
    return soft(crack * (organic ? 0.2 : 0.6) + roar * [1.6, 1.6, 1.6][size] + thoom * [0.55, 1.5, 1.9][size] + debris * (organic ? 0.2 : [0.7, 0.45, 0.45][size]) + plates * [0, 0.9, 1.1][size] + groan * 0.9 + wet * 1.4)
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

/**
 * A jump starting: a low hum winding up, with a shimmer rising on top, lasting exactly as long as
 * the jump so it swells right into the arrival, then hands over to it in a short fade rather than
 * stopping dead (a sound cut off mid-wave clicks).
 */
const warpCharge = (len: number): Recipe => (sr, r) => {
  const a = new Osc()
  const b = new Osc()
  const lp = new Svf()
  const bp = new Svf()
  const tail = 0.12
  return render(sr, len + tail, (t) => {
    const rise = Math.min(1, t / len)
    const env = rise * rise * (3 - 2 * rise) * (t > len ? Math.cos(((t - len) / tail) * Math.PI * 0.5) ** 2 : 1)
    const hum = lp.run(a.saw(glide(55, 150 + r() * 20, t, len), sr) + b.saw(glide(56.5, 152, t, len), sr), glide(300, 1400, t, len), 0.7, sr).low
    // A narrow band (low damping): Svf's q is damping, and a high one blows the filter up once the
    // sweep climbs past a few kHz.
    const shimmer = bp.run(noise(), glide(900, 6000, t, len), 0.25, sr).band * 0.3
    return (hum * 0.45 + shimmer * 0.35) * env
  })
}

/** A ship dropping out of hyperspace: a tearing whoosh falling from high to low, a crack, and a
 * deep thump as the mass arrives. Bigger ships fall lower and boom longer. */
const warpArrive = (big: boolean): Recipe => (sr, r) => {
  const o = new Osc()
  const lp = new Svf()
  const bp = new Svf()
  const len = big ? 2.2 : 1.4
  const low = big ? 38 : 60
  // Every part fades in over a few milliseconds and the end tapers to silence: a sound that starts or
  // stops at full level pops.
  const fadeIn = (t: number, secs: number) => {
    const k = Math.min(1, t / secs)
    return k * k * (3 - 2 * k)
  }
  return render(sr, len, (t) => {
    const end = Math.min(1, (len - t) / 0.3)
    const whoosh = bp.run(noise(), glide(6500, 260, t, 0.32), 0.9, sr).band * Math.exp(-t * 6) * fadeIn(t, 0.04)
    const tone = lp.run(o.saw(glide(1900 + r() * 200, low, t, 0.28), sr), glide(3000, 180, t, 0.4), 0.6, sr).low * Math.exp(-t * (big ? 2.6 : 3.6)) * fadeIn(t, 0.02)
    const crack = noise() * Math.exp(-t * 45) * fadeIn(t, 0.006)
    const thump = Math.sin(TAU * glide(low * 1.6, low * 0.7, t, 0.5) * t) * Math.exp(-t * (big ? 2.2 : 4)) * fadeIn(t, 0.012)
    return soft((whoosh * 0.9 + tone * 0.55 + crack * 0.3 + thump * 0.9) * 1.1) * end
  })
}

/**
 * A Swarm wormhole opening (for a jump in or a retreat): a deep, organic drone that throbs faster as
 * it opens, a vowel-like warble sweeping with the throb, and a long inward suck of air. Lasts as
 * long as the jump, like warpCharge.
 */
const wormCharge = (len: number): Recipe => (sr) => {
  const a = new Osc()
  const b = new Osc()
  const sub = new Osc()
  const lp = new Svf()
  const vowel = new Svf()
  const air = new Svf()
  const tail = 0.15
  return render(sr, len + tail, (t) => {
    const rise = Math.min(1, t / len)
    const env = rise * rise * (3 - 2 * rise) * (t > len ? Math.cos(((t - len) / tail) * Math.PI * 0.5) ** 2 : 1)
    // The throb: 1.5 a second at first, 7.5 by the end.
    const tt = Math.min(t, len)
    const ph = TAU * (1.5 * tt + (3 * tt * tt) / len)
    const wob = 0.5 + 0.5 * Math.sin(ph)
    const f0 = glide(32, 58, t, len)
    const drone = lp.run(a.saw(f0 * (1 + 0.035 * Math.sin(ph)), sr) + b.saw(f0 * 1.505, sr) * 0.5, 140 + 800 * wob * rise, 0.5, sr).low
    const warble = vowel.run(drone, 260 + 520 * wob, 0.3, sr).band
    const suck = air.run(noise(), glide(180, 1600, t, len), 0.35, sr).band * rise
    return (drone * 0.4 + warble * 0.55 + sub.sin(f0 * 0.5, sr) * 0.35 + suck * 0.22) * env
  })
}

/** A ship out of (or into) a Swarm wormhole: a deep wet whomp with a wobble, a bubble's gloop, and a
 * rush of air falling away. Bigger ships whomp lower and longer. */
const wormArrive = (big: boolean): Recipe => (sr) => {
  const o = new Osc()
  const o2 = new Osc()
  const lp = new Svf()
  const len = big ? 2 : 1.3
  return render(sr, len, (t) => {
    const end = Math.min(1, (len - t) / 0.3)
    const fade = Math.min(1, t / 0.01)
    const vib = 1 + 0.12 * Math.sin(TAU * 9 * t) * Math.exp(-t * 3)
    const whomp = o.sin(glide(big ? 110 : 150, big ? 28 : 40, t, 0.5) * vib, sr) * Math.exp(-t * (big ? 2 : 3))
    const gloop = o2.sin(glide(180, 900, t, 0.09), sr) * ad(t, 0.004, 0.06)
    const rush = lp.run(noise(), glide(2400, 120, t, 0.6), 0.6, sr).low * Math.exp(-t * 4)
    return soft((whomp * 1.1 + gloop * 0.35 + rush * 0.8) * fade) * end
  })
}

/**
 * A Confederacy rift tearing open: electrical crackle, sparse at first and a storm by the end, over
 * a harsh buzz rising in pitch and stuttering, like something forced. Lasts as long as the jump.
 */
const riftCharge = (len: number): Recipe => (sr, r) => {
  const o = new Osc()
  const o2 = new Osc()
  const buzzF = new Svf()
  const crackF = new Svf()
  const tail = 0.12
  let crack = 0
  let amp = 0
  const decay = Math.exp(-1 / (0.004 * sr))
  return render(sr, len + tail, (t) => {
    const rise = Math.min(1, t / len)
    const env = (0.25 + 0.75 * rise * rise) * Math.min(1, t / 0.05) * (t > len ? Math.cos(((t - len) / tail) * Math.PI * 0.5) ** 2 : 1)
    if (r() < (15 + 420 * rise * rise) / sr) {
      crack = 1
      amp = 0.4 + r() * 0.6
    }
    crack *= decay
    const crackle = crackF.run(noise(), 3200, 0.5, sr).band * crack * amp
    const f = glide(46, 115, t, len)
    const stutter = Math.sin(TAU * glide(9, 31, t, len) * t) > -0.3 ? 1 : 0.25
    const buzz = buzzF.run(o.saw(f, sr) + o2.sqr(f * 2.01, sr) * 0.4, 600 + 1400 * rise, 0.6, sr).band
    return (crackle * 1.4 + soft(buzz * 3) * 0.3 * stutter * rise) * env
  })
}

/** A ship shoved out of (or lurching into) a Confederacy rift: a ripping tear stuttering as it goes, a
 * crack, a heavy distorted thump, and a sizzle dying away. */
const riftArrive = (big: boolean): Recipe => (sr) => {
  const bp = new Svf()
  const fz = new Svf()
  const len = big ? 1.9 : 1.3
  const low = big ? 40 : 58
  return render(sr, len, (t) => {
    const end = Math.min(1, (len - t) / 0.3)
    const fade = Math.min(1, t / 0.006)
    const jag = Math.sin(TAU * 62 * t) > 0 ? 1 : 0.35
    const rip = bp.run(noise(), glide(700, 4200, t, 0.22), 0.5, sr).band * jag * ad(t, 0.01, 0.16)
    const crack = noise() * Math.exp(-t * 50)
    const thump = soft(Math.sin(TAU * glide(low * 1.8, low * 0.7, t, 0.4) * t) * 2.2) * Math.exp(-t * (big ? 2.4 : 3.6))
    const sizzle = fz.run(noise(), 5200, 0.4, sr).band * (Math.sin(TAU * 23 * t) > 0.4 ? 1 : 0.2) * ad(t - 0.15, 0.05, 0.35)
    return soft((rip * 0.9 + crack * 0.35 + thump * 0.9 + sizzle * 0.35) * fade * 1.1) * end
  })
}

/** Each WarpStyle's sounds: the wind-up and the drop out, and its names' suffix. */
const JUMPS: Record<WarpStyle, { charge: (len: number) => Recipe; arrive: (big: boolean) => Recipe; tag: string }> = {
  hyperspace: { charge: warpCharge, arrive: warpArrive, tag: '' },
  wormhole: { charge: wormCharge, arrive: wormArrive, tag: '-worm' },
  rift: { charge: riftCharge, arrive: riftArrive, tag: '-rift' },
}

// The Confederacy: industrial and military ------------------------------------------------------------
// Heavy machinery rather than droids: cannon breeches, orange plasma, relays and servos. No chatter.

/** Short metal partials, struck once: a breech, a latch, a slide coming home. */
function clank(sr: number, r: Rnd, f0: number, len: number) {
  const fs = [1, 1.83, 2.71, 4.1].map((k) => f0 * k * (0.96 + r() * 0.08))
  const os = fs.map(() => new Osc(r()))
  const lp = new Svf()
  return render(sr, len, (t) => {
    const ring = os.reduce((s, o, k) => s + o.sin(fs[k], sr) * Math.exp(-t / (len * 0.25 / (1 + k * 0.6))) / (k + 1), 0)
    const knock = lp.run(noise(), 2200, 0.8, sr).low * ad(t, 0.0004, 0.006)
    return ring + knock * 1.4
  })
}

/** A Confederacy fighter's plasma gun: a lower, harder zap than the Republic's, with a short hot
 * sizzle on its front, held between 260 Hz and 2.2 kHz. */
const forgePew: Recipe = (sr, r) => {
  const o1 = new Osc(r())
  const o2 = new Osc(r())
  const bp = new Svf()
  const hs = new Svf()
  const lp = new Svf()
  const hp = new Svf()
  const f0 = 1100 * (0.94 + r() * 0.12)
  return render(sr, 0.085, (t) => {
    const fr = glide(f0, 260, t, 0.05)
    const raw = o1.sqr(fr, sr) * 0.6 + o2.saw(fr * 0.5, sr) * 0.5
    const zap = bp.run(raw + noise() * 0.2, glide(1900, 520, t, 0.05), 0.85, sr).band
    const sizzle = hs.run(noise(), 1800, 0.6, sr).band * ad(t, 0.0003, 0.008)
    const hot = soft((zap * 1.4 + sizzle * 0.9) * ad(t, 0.0004, 0.022) * 3)
    const low = lp.run(hot, 2200, 0.7, sr).low
    return low - hp.run(low, 260, 0.9, sr).low
  })
}

/** A Confederacy warship's plasma bolt: a thick, falling square pair through a closing filter, with
 * the breech clanking home under it. Darker than the Republic's laser cannon. */
const forgeBolt: Recipe = (sr, r) => {
  const o1 = new Osc(r())
  const o2 = new Osc(r())
  const f = new Svf()
  const lp = new Svf()
  const f0 = 880 * (0.92 + r() * 0.16)
  const bolt = render(sr, 0.24, (t) => {
    const fr = glide(f0, 140, t, 0.15)
    const tone = o1.sqr(fr, sr) * 0.6 + o2.sqr(fr * 1.5, sr) * 0.25
    const zap = f.run(tone + noise() * 0.1, glide(2600, 450, t, 0.15), 0.4, sr).band * ad(t, 0.002, 0.055)
    return soft(lp.run(zap * 2.2, 2400, 0.7, sr).low)
  })
  return layers(sr, [{ data: bolt }, { data: clank(sr, r, 210, 0.12), gain: 0.28 }])
}

/** A Confederacy heavy gun: a cannon, not a turbolaser. A deep thump, a blast of dark noise and the
 * breech sliding home in short metal partials. */
const forgeCannon: Recipe = (sr, r) => {
  const b = new Osc()
  const body = new Svf()
  const zf = new Svf()
  const z = new Osc(r())
  const f0 = 520 * (0.9 + r() * 0.2)
  const blast = render(sr, 0.65, (t) => {
    const thump = b.sin(glide(120, 32, t, 0.35), sr) * ad(t, 0.003, 0.22)
    const roar = body.run(noise(), glide(1300, 180, t, 0.3), 0.7, sr).low * ad(t, 0.001, 0.09)
    // A short plasma zap on top, so it still reads as a shot rather than a blast.
    const zap = zf.run(z.saw(glide(f0, 90, t, 0.2), sr), glide(1800, 240, t, 0.2), 0.5, sr).band * ad(t, 0.002, 0.07)
    return soft(thump * 1.6 + roar * 1.2 + zap * 0.9)
  })
  return layers(sr, [{ data: blast }, { data: clank(sr, r, 150, 0.3), gain: 0.35, at: 0.07 }])
}

/** Confederacy point defence: an autocannon's "chug", the flak crack over a lower, punchier body. */
const forgeFlak: Recipe = (sr, r) => {
  const hp = new Svf()
  const lp = new Svf()
  const o = new Osc()
  const tone = 62 + r() * 20
  return render(sr, 0.15, (t) => {
    const crack = hp.run(noise(), 1700 + r() * 500, 0.9, sr).high * ad(t, 0.0005, 0.012)
    const body = lp.run(noise(), 650, 0.6, sr).low * ad(t, 0.002, 0.05)
    const chug = o.sin(glide(tone * 2.4, tone, t, 0.04), sr) * ad(t, 0.002, 0.06)
    return soft(crack * 0.9 + body * 1.1 + chug * 1.3)
  })
}

/** The Breaker's ion lance: a capacitor whining up, then a heavy, wobbling discharge with a crackle
 * of arcs. Longer and deeper than the Republic's ion cannon. */
const forgeLance: Recipe = (sr, r) => {
  const w = new Osc(r())
  const o1 = new Osc(r())
  const o2 = new Osc(r())
  const lp = new Svf()
  const bp = new Svf()
  const f0 = 170 * (0.92 + r() * 0.16)
  return render(sr, 0.75, (t) => {
    const whine = w.sin(glide(320, 1500, t, 0.14), sr) * (t < 0.15 ? Math.min(1, t / 0.12) * 0.35 : 0) * ad(t - 0.15, 0, 0.01)
    const d = t - 0.13
    const wob = 1 + 0.35 * Math.sin(TAU * 21 * t)
    const tone = d < 0 ? 0 : lp.run(o1.saw(glide(f0, 46, d, 0.45), sr) + o2.sqr(glide(f0, 46, d, 0.45) * 1.01, sr) * 0.5, glide(1300, 220, d, 0.4), 1.4, sr).low * wob * ad(d, 0.004, 0.2)
    const arcs = d < 0 ? 0 : bp.run(noise() * (r() < 0.07 ? 1 : 0.12), 1500, 1.1, sr).band * ad(d, 0.001, 0.14)
    return soft(whine + tone * 1.6 + arcs * 0.8)
  })
}

// The Swarm: living ships ---------------------------------------------------------------------------
// Wet, organic and breathing: spit, pulses, spores and acid, chitters for voices, and the deep groans
// of the big living hulls.

/**
 * A bubble's pop: a sine whose pitch rises as it decays (a bubble shrinking), started `at` seconds
 * in. Stateless, so any recipe can sprinkle a few.
 */
function bubble(t: number, at: number, f0: number, len: number) {
  const d = t - at
  if (d < 0 || d > len * 6) return 0
  return Math.sin(TAU * f0 * (d + (d * d) / (len * 2))) * Math.exp(-d / len) * Math.min(1, d / 0.0015)
}

/** A Swarm strike craft's spit: a short wet slap of noise with a quick downward blip. */
const swarmSpit: Recipe = (sr, r) => {
  const bp = new Svf()
  const o = new Osc(r())
  const lp = new Svf()
  const f = 1400 * (0.9 + r() * 0.2)
  return render(sr, 0.09, (t) => {
    const slap = bp.run(noise(), glide(f, 480, t, 0.05), 0.7, sr).band * ad(t, 0.0006, 0.018)
    const blip = o.sin(glide(700, 190, t, 0.035), sr) * ad(t, 0.001, 0.025)
    return soft(lp.run(slap * 1.5 + blip * 0.9 + bubble(t, 0.012, 520, 0.012) * 0.4, 2400, 0.7, sr).low * 2)
  })
}

/** A Swarm warship's bio-plasma pulse: a wet, vowel-like "bwop", a falling tone through two moving
 * formants. */
const swarmPulse: Recipe = (sr, r) => {
  const o = new Osc(r())
  const o2 = new Osc(r())
  const f1 = new Svf()
  const f2 = new Svf()
  const f0 = 240 * (0.9 + r() * 0.2)
  return render(sr, 0.24, (t) => {
    const fr = glide(f0, 85, t, 0.16)
    const src = o.saw(fr, sr) * 0.7 + o2.sin(fr * 0.5, sr) * 0.5
    const a = f1.run(src, glide(800, 300, t, 0.14), 0.45, sr).band
    const b = f2.run(src, glide(1500, 750, t, 0.14), 0.55, sr).band
    return soft((a * 1.6 + b * 0.9) * ad(t, 0.003, 0.06) + bubble(t, 0.05, 380, 0.02) * 0.25)
  })
}

/** A Swarm heavy weapon: a spore sac thudding off. A muffled deep thump, a wet splat and a short
 * gurgle of bubbles. */
const sporeThud: Recipe = (sr, r) => {
  const b = new Osc()
  const lp = new Svf()
  const pops = Array.from({ length: 6 }, () => [0.08 + r() * 0.3, 200 + r() * 260, 0.012 + r() * 0.015] as const)
  return render(sr, 0.6, (t) => {
    const thump = b.sin(glide(95, 34, t, 0.3), sr) * ad(t, 0.004, 0.18)
    const splat = lp.run(noise(), glide(1100, 260, t, 0.12), 0.7, sr).low * ad(t, 0.001, 0.05)
    let gurgle = 0
    for (const [at, f, len] of pops) gurgle += bubble(t, at, f, len)
    return soft(thump * 1.7 + splat * 1.3 + gurgle * 0.35)
  })
}

/** Swarm point defence: spore bursts, a few soft popping puffs close together. */
const sporeBurst: Recipe = (sr, r) => {
  const lp = new Svf()
  const o = new Osc()
  const puffs = Array.from({ length: 3 + Math.floor(r() * 2) }, (_, i) => i * 0.028 + r() * 0.012)
  return render(sr, 0.17, (t) => {
    let env = 0
    for (const at of puffs) env += ad(t - at, 0.002, 0.016)
    const puff = lp.run(noise(), 900, 0.7, sr).low * env
    const pop = o.sin(glide(180, 90, t, 0.06), sr) * ad(t, 0.002, 0.03)
    return soft(puff * 1.6 + pop * 0.6)
  })
}

/** Acid (the Swarm's torpedoes and parasites): a hiss of high noise sizzling down, with a fizzing
 * tail of tiny crackles. */
const acidHiss: Recipe = (sr, r) => {
  const bp = new Svf()
  const hp = new Svf()
  const snaps = Array.from({ length: 24 }, () => [0.04 + r() * 0.3, 0.3 + r() * 0.7] as const)
  return render(sr, 0.38, (t) => {
    let fizz = 0
    for (const [at, g] of snaps) {
      const d = t - at
      if (d >= 0 && d < 0.002) fizz += noise() * g * (1 - d / 0.002)
    }
    const hiss = bp.run(noise(), glide(4800, 1700, t, 0.3), 0.5, sr).band * ad(t, 0.01, 0.12)
    const v = hiss * 1.3 + fizz * 0.6
    return soft(v - hp.run(v, 500, 0.8, sr).low)
  })
}

/** A Swarm nerve pulse (its ion kind): a low throbbing wobble, felt more than heard. */
const nervePulse: Recipe = (sr, r) => {
  const o = new Osc(r())
  const s = new Osc(r())
  const lp = new Svf()
  return render(sr, 0.5, (t) => {
    const throb = 0.55 + 0.45 * Math.sin(TAU * 17 * t)
    const tone = lp.run(o.saw(glide(150, 62, t, 0.35), sr), glide(900, 220, t, 0.3), 1.2, sr).low * throb
    const sub = s.sin(glide(70, 40, t, 0.4), sr)
    return soft((tone * 1.3 + sub * 0.8) * ad(t, 0.01, 0.16))
  })
}

/** A living hull's groan: a slow, wavering low tone sinking through a closing filter, `len` long. */
function groan(sr: number, r: Rnd, len: number, f0 = 58) {
  const o = new Osc(r())
  const o2 = new Osc(r())
  const f = new Svf()
  const rate = 1.2 + r() * 1.2
  return render(sr, len, (t) => {
    const fr = glide(f0, f0 * 0.62, t, len) * (1 + 0.04 * Math.sin(TAU * rate * t))
    const v = o.saw(fr, sr) + o2.saw(fr * 1.007, sr) * 0.6
    return f.run(v, glide(520, 150, t, len), 1.1, sr).low * Math.sin(Math.PI * Math.min(1, t / len)) ** 1.5
  })
}

/** A bolt striking living tissue: a wet thud and a splat, no metal in it. */
const wetHit = (heavy: boolean): Recipe => (sr, r) => {
  const len = heavy ? 0.22 : 0.1
  const lp = new Svf()
  const o = new Osc()
  const hp = new Svf()
  return render(sr, len, (t) => {
    const splat = lp.run(noise(), heavy ? 700 : 1000, 0.7, sr).low * ad(t, 0.0008, heavy ? 0.04 : 0.016)
    const thud = o.sin(glide(heavy ? 120 : 190, heavy ? 55 : 110, t, 0.05), sr) * ad(t, 0.002, heavy ? 0.06 : 0.02)
    const v = splat * 1.5 + thud * (heavy ? 1.2 : 0.6) + bubble(t, heavy ? 0.03 : 0.015, 300 + r() * 200, 0.015) * 0.3
    return soft(v - hp.run(v, heavy ? 50 : 120, 0.8, sr).low)
  })
}

// Ground squads' members falling (EmpiresSound.death), one sound a faction.

/** A trooper going down: a short grunt through the helmet, then armour plates clattering. */
const trooperDown: Recipe = (sr, r) => {
  const o = new Osc(r())
  const f1 = new Svf()
  const f2 = new Svf()
  const bp = new Svf()
  const hp = new Svf()
  const f0 = 150 + r() * 40
  const clicks = [0.08, 0.12, 0.17, 0.2].map((t) => t + r() * 0.02)
  return render(sr, 0.28, (t) => {
    const src = o.saw(glide(f0, f0 * 0.62, t, 0.13), sr) * ad(t, 0.006, 0.05)
    const voice = f1.run(src, 620, 2.4, sr).band * 1.3 + f2.run(src, 1150, 3, sr).band * 0.6
    let c = 0
    for (const at of clicks) {
      const d = t - at
      if (d >= 0 && d < 0.014) c += noise() * Math.exp(-d / 0.003)
    }
    const clank = bp.run(c, 3000 + r() * 400, 5, sr).band
    const v = voice * 1.3 + clank * 1.7
    return soft(v - hp.run(v, 90, 0.8, sr).low)
  })
}

/** A droid coming apart: its servos whining down, an electrical pop, a clank of parts landing. */
const droidDown: Recipe = (sr, r) => {
  const o = new Osc(r())
  const hp = new Svf()
  const bp = new Svf()
  const f0 = 650 + r() * 350
  return render(sr, 0.26, (t) => {
    const whine = o.sqr(glide(f0, 80, t, 0.17), sr) * ad(t, 0.004, 0.08) * 0.28
    const pop = hp.run(noise(), 2600, 0.7, sr).high * ad(t, 0.0004, 0.009)
    const clank = bp.run(noise(), 1700 + r() * 300, 7, sr).band * (ad(t - 0.1, 0.001, 0.025) + ad(t - 0.16, 0.001, 0.02) * 0.6)
    return soft(whine + pop * 1.5 + clank * 2.2)
  })
}

/** A bug dying: a thin squeal that cracks and drops, over a wet splat. */
const bugDown: Recipe = (sr, r) => {
  const o = new Osc(r())
  const lfo = new Osc(r())
  const lp = new Svf()
  const f0 = 1700 + r() * 500
  return render(sr, 0.24, (t) => {
    const f = t < 0.05 ? glide(f0, f0 * 1.35, t, 0.05) : glide(f0 * 1.35, f0 * 0.45, t - 0.05, 0.15)
    const squeal = o.sin(f * (1 + 0.04 * lfo.sin(38, sr)), sr) * ad(t, 0.006, 0.07) * 0.5
    const splat = lp.run(noise(), 900, 0.7, sr).low * ad(t, 0.0008, 0.03)
    return soft(squeal + splat * 1.4 + bubble(t, 0.05 + r() * 0.04, 250 + r() * 150, 0.015) * 0.25)
  })
}

const DEATH: Record<SoundSet, Recipe> = { republic: trooperDown, forge: droidDown, hive: bugDown }

/** A Swarm brood hatching: a fleshy squelch, bubbles, and a burst of chitters. */
const hatch: Recipe = (sr, r) => {
  const lp = new Svf()
  const pops = Array.from({ length: 8 }, () => [r() * 0.3, 160 + r() * 300, 0.01 + r() * 0.02] as const)
  const squelch = render(sr, 0.5, (t) => {
    let g = 0
    for (const [at, f, len] of pops) g += bubble(t, at, f, len)
    return lp.run(noise(), glide(500, 1400, t, 0.3), 0.7, sr).low * Math.sin(Math.PI * Math.min(1, t / 0.45)) ** 2 + g * 0.3
  })
  return layers(sr, [{ data: squelch }, { data: chitter(sr, r, 'select'), gain: 0.5, at: 0.2 }])
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
/** A line of notes: [semitones above `base`, seconds]. `soft` fades each note in and out slowly,
 * for a hum rather than a ping. */
function melody(sr: number, base: number, notes: [number, number][], wave: 'sin' | 'sqr' | 'tri' | 'saw', gap = 0.012, soft = false) {
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
    const env = Math.min(1, lt / (soft ? 0.02 : 0.004)) * Math.min(1, (d - lt) / (soft ? 0.04 : 0.008))
    return o[wave](base * semi(n), sr) * env
  })
}

/** Droid chatter: a burst of quick, random bleeps from a pentatonic scale, slightly bit-crushed. */
function chatter(sr: number, r: Rnd, count: number, contour: number, base = 380) {
  // A narrow, low range of soft, rounded notes: still droid chatter, but murmured rather than
  // beeped, so hearing it a hundred times a battle doesn't grate.
  const scale = [0, 2, 3, 5, 7]
  const notes: [number, number][] = []
  for (let i = 0; i < count; i++) {
    const drift = Math.round(contour * (i / Math.max(1, count - 1)) * 2)
    notes.push([scale[Math.floor(r() * scale.length)] + drift, 0.045 + r() * 0.035])
  }
  const m = melody(sr, base, notes, 'tri', 0.01, true)
  // A gentle low-pass takes the edge off the triangle.
  let y = 0
  const k = 1 - Math.exp((-2 * Math.PI * 1400) / sr)
  for (let i = 0; i < m.length; i++) m[i] = y += (m[i] - y) * k
  return m
}

/**
 * The Confederacy's command net: a relay's clack, then terse low pulse tones over a narrow, crunchy
 * telemetry channel (bit-crushed, no squelch). Orders read as data bursts: rising pulses to move,
 * hard falling ones to attack, one long low tone to hold.
 */
function commandNet(sr: number, r: Rnd, kind: OrderKind | 'select', base: number) {
  const tunes: Record<OrderKind | 'select', [number, number][]> = {
    select: [[0, 0.04], [7, 0.06]],
    move: [[0, 0.04], [5, 0.04], [7, 0.06]],
    attack: [[7, 0.035], [3, 0.035], [0, 0.07]],
    attackMove: [[5, 0.04], [0, 0.06]],
    patrol: [[0, 0.04], [7, 0.04], [0, 0.05]],
    hold: [[0, 0.16]],
    stop: [[-5, 0.05], [-5, 0.05]],
    rally: [[0, 0.04], [12, 0.07]],
    target: [[12, 0.025], [12, 0.025], [7, 0.025], [12, 0.08]],
  }
  const tones = melody(sr, base, tunes[kind], 'sqr', 0.018, true)
  // Bit-crushed: held every few samples and stepped to a few levels, like a telemetry link.
  const hold = 3 + Math.floor(r() * 2)
  let held = 0
  for (let i = 0; i < tones.length; i++) {
    if (i % hold === 0) held = Math.round(tones[i] * 6) / 6
    tones[i] = held
  }
  const bp = new Svf()
  const relay = render(sr, 0.02, (t) => bp.run(noise(), 2600, 0.7, sr).band * ad(t, 0.0003, 0.003))
  return layers(sr, [{ data: relay, gain: 0.8 }, { data: tones, gain: 0.7, at: 0.018 }])
}

/** A big Confederacy ship's servo whine, under its command net. */
function servo(sr: number, r: Rnd, len: number) {
  const o = new Osc(r())
  const f = new Svf()
  return render(sr, len, (t) => f.run(o.saw(glide(300, 520, t, len * 0.6), sr), 900, 0.8, sr).low * Math.sin(Math.PI * Math.min(1, t / len)))
}

/**
 * Swarm chitters: a fast trill of clicks through a moving formant. A short chirrup to answer a
 * selection, a hissing rattle to attack, a low purr to move.
 */
function chitter(sr: number, r: Rnd, kind: OrderKind | 'select', pitch = 1) {
  const fierce = kind === 'attack' || kind === 'attackMove' || kind === 'target'
  const calm = kind === 'move' || kind === 'patrol' || kind === 'rally' || kind === 'hold' || kind === 'stop'
  const len = fierce ? 0.3 : calm ? 0.26 : 0.14
  const rate = (fierce ? 75 : calm ? 34 : 55) * (0.9 + r() * 0.2) * pitch
  const bp = new Svf()
  const hs = new Svf()
  const f0 = (calm ? 650 : 1700) * pitch
  const f1 = (calm ? 480 : fierce ? 1300 : 2500) * pitch
  return render(sr, len, (t) => {
    // A click at every turn of the trill: a couple of milliseconds of noise.
    const ph = (t * rate) % 1
    const click = ph < 0.08 ? noise() * (1 - ph / 0.08) : 0
    const trill = bp.run(click, glide(f0, f1, t, len), 0.35, sr).band
    const hiss = fierce ? hs.run(noise(), 3200, 0.6, sr).band * 0.35 : 0
    return soft((trill * 2.2 + hiss) * Math.sin(Math.PI * Math.min(1, t / len)))
  })
}

/** A crew acknowledgement: what they say depends on the order and who they are. */
const ack = (kind: OrderKind | 'select', faction: FactionId, tier: Tier = 'frigate'): Recipe => (sr, r) => {
  // Small craft answer higher and quicker, flagships lower.
  const shift = { fighter: 4, gunship: 2, frigate: 0, cruiser: -2, capital: -4, station: -5, mine: 0, defense: 0, yard: -3, vehicle: 2, building: -5 }[tier]
  const big = tier === 'cruiser' || tier === 'capital' || tier === 'station'
  // Each faction's crews have their own voice (see VOICE): clone crews beep over a squelchy radio,
  // the Confederacy's command net clacks and pulses, the Swarm chitters.
  const voice = VOICE[faction]
  if (voice === 'net') {
    const msg = commandNet(sr, r, kind, 196 * semi(shift))
    const net = radio(sr, msg, false)
    if (!big) return net
    // Big ships add a servo whine under it, the station a deep transformer hum.
    const under = tier === 'station'
      ? (() => {
          const a = new Osc()
          const b = new Osc()
          return render(sr, net.length / sr, (t) => (a.sin(100, sr) + b.sin(200, sr) * 0.4) * Math.min(1, t / 0.02))
        })()
      : servo(sr, r, net.length / sr)
    return layers(sr, [{ data: net }, { data: under, gain: 0.3 }])
  }
  if (voice === 'hive') {
    const ch = chitter(sr, r, kind, semi(shift * 0.5))
    // Cruisers and the Leviathan answer with a living ship's groan under the chitter.
    return big ? layers(sr, [{ data: groan(sr, r, 0.7, tier === 'cruiser' ? 70 : 52), gain: 0.9 }, { data: ch, gain: 0.6, at: 0.05 }]) : ch
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
  // Answered softly (a low sine, notes eased in and out) so they don't ping over the battle; a
  // selection a touch higher than an order, so the two still sound different.
  const base = (kind === 'select' ? 415 : 392) * semi(shift)
  const msg = melody(sr, base, tunes[kind], 'sin', 0.012, true)
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
/** A build order on a starship console: a soft key "thock", then two warm notes stepping up (or
 * down, to cancel). Short and dry, with nothing ringing on after it. */
const queue = (cancel: boolean): Recipe => (sr, r) => {
  const o = new Osc()
  const lp = new Svf()
  const thock = render(sr, 0.05, (t) => lp.run(o.sin(glide(320, 180, t, 0.03), sr) + noise() * 0.4, 1400, 0.7, sr).low * ad(t, 0.0008, 0.012))
  const n1 = new Osc(r())
  const n2 = new Osc(r())
  const notes = cancel ? [7, 0] : [0, 7]
  const chirp = render(sr, 0.13, (t) => {
    const k = t < 0.055 ? 0 : 1
    const lt = k ? t - 0.055 : t
    const f = 523 * semi(notes[k])
    // A sine with a soft triangle an octave up: warm, not a piercing beep.
    return (n1.sin(f, sr) * 0.8 + n2.tri(f * 2, sr) * 0.12) * ad(lt, 0.004, k ? 0.035 : 0.02)
  })
  return layers(sr, [{ data: thock, gain: 0.7 }, { data: chirp, gain: 0.55, at: 0.012 }])
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

/** A soft note: a sine with a gentle attack (no click) and a decay, plus a touch of its octave
 * (`bright`), for something that happens often and must not nag. */
function softNote(sr: number, f: number, attack: number, decay: number, secs: number, bright = 0.1) {
  const o = new Osc()
  const o2 = new Osc()
  return render(sr, secs, (t) => (o.sin(f, sr) + o2.sin(f * 2, sr) * bright) * ad(t, attack, decay))
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
  // A Swarm ship is born, not launched: a birthing groan and its first chitter.
  if (SET[faction] === 'hive') return layers(sr, [{ data: groan(sr, r, tier === 'capital' ? 1.4 : 0.8, tier === 'capital' ? 48 : 66), gain: 0.8 }, { data: hatch(sr, r), gain: 0.5, at: 0.1 }, { data: ack('select', faction, tier)(sr, r), gain: 0.7, at: 0.35 }])
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

const abilitySound = (id: AbilityId, set: SoundSet = 'republic'): Recipe => (sr, r) => {
  if (id === 'shieldBoost') {
    const shimmer = bells(sr, 440, [0, 4, 7, 12, 16], 1.0, 0.04)
    return layers(sr, [{ data: shimmer }, { data: swoosh(true)(sr, r), gain: 0.6 }])
  }
  if (id === 'flakBarrage') {
    const o = new Osc()
    const charge = render(sr, 0.35, (t) => o.saw(glide(220, 900, t, 0.35), sr) * Math.min(1, t / 0.3) * 0.5)
    return layers(sr, [{ data: charge }, ...Array.from({ length: 8 }, (_, k) => ({ data: flak(sr, r), at: 0.32 + k * 0.07, gain: 0.7 }))])
  }
  if ((id === 'repairSwarm' || id === 'fieldRepair') && set === 'forge') {
    // Welding torches crackling and ratchets turning: repair machinery, no bleeps.
    const bp = new Svf()
    const torch = render(sr, 1.0, (t) => bp.run(noise() * (Math.random() < 0.12 ? 1 : 0.2), 2400, 0.9, sr).band * Math.sin(Math.PI * Math.min(1, t / 0.95)))
    const ratchet = render(sr, 0.5, (t) => ((t * 28) % 1 < 0.1 ? noise() : 0) * ad(t, 0.01, 0.3))
    return layers(sr, [{ data: torch, gain: 0.7 }, { data: ratchet, gain: 0.5, at: 0.15 }, { data: clank(sr, r, 260, 0.15), gain: 0.4, at: 0.6 }])
  }
  if ((id === 'repairSwarm' || id === 'fieldRepair') && set === 'hive') {
    // A slow, warm pulse of tissue knitting, with a few wet clicks.
    const o = new Osc()
    const swell = render(sr, 1.2, (t) => o.sin(110 + 8 * Math.sin(TAU * 0.8 * t), sr) * (0.5 + 0.5 * Math.sin(TAU * 3 * t)) * Math.sin(Math.PI * Math.min(1, t / 1.15)))
    return layers(sr, [{ data: swell }, ...[0.2, 0.5, 0.8].map((at) => ({ data: wetHit(false)(sr, r), gain: 0.35, at }))])
  }
  if (id === 'launchSwarm' && set === 'hive') return layers(sr, Array.from({ length: 3 }, (_, k) => ({ data: hatch(sr, r), at: k * 0.16, gain: 0.8 })))
  if (id === 'launchSwarm' && set === 'forge') {
    const o = new Osc()
    const f = new Svf()
    const blip = render(sr, 0.3, (t) => f.run(o.sqr(t < 0.15 ? 440 : 330, sr), 1400, 0.6, sr).low * (t % 0.15 < 0.13 ? 1 : 0))
    return layers(sr, [{ data: blip, gain: 0.5 }, ...Array.from({ length: 4 }, (_, k) => ({ data: launch(sr, r), at: 0.25 + k * 0.12, gain: 0.8 }))])
  }
  if (id === 'repairSwarm' || id === 'fieldRepair') {
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

/** Each set's guns, by weapon kind; `light` is a strike craft's (and gunship's) guns. */
const GUNS: Record<SoundSet, Record<WeaponKind | 'light', Recipe>> = {
  republic: { light: fighterBlaster(false), laser: blaster(false), turbo: turbolaser, flak, missile, ion: ionShot },
  forge: { light: forgePew, laser: forgeBolt, turbo: forgeCannon, flak: forgeFlak, missile, ion: forgeLance },
  hive: { light: swarmSpit, laser: swarmPulse, turbo: sporeThud, flak: sporeBurst, missile: acidHiss, ion: nervePulse },
}

// --- Engine ---------------------------------------------------------------------------------------------

type Mix = EmpiresMix

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
  /** The game's sound, for what the screen makes up on its own (a squad member falling,
   * ground/deaths.ts) rather than reads from the battle's events. */
  static active: EmpiresSound | null = null
  constructor() {
    EmpiresSound.active = this
  }
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private buses: Partial<Record<Bus, GainNode>> = {}
  private verb: GainNode | null = null
  private bank = new Map<string, AudioBuffer[]>()
  private recent = new Map<string, number[]>()
  private ackSrc: AudioBufferSourceNode | null = null
  private musicDir: MusicDirector | null = null
  private rumble: GainNode | null = null
  private rumbleSrc: AudioBufferSourceNode | null = null
  private heat = 0
  /** Off, the volume, the mix and the music are kept with Settings (../prefs.ts), which may
   * change them mid-game. The music can be switched off on its own, keeping its volume. */
  private unsubscribe: (() => void) | null = null
  get muted() {
    return empiresMuted.get()
  }
  get volume() {
    return empiresVolume.get()
  }
  get mix(): Mix {
    return empiresMix.get()
  }
  get music() {
    return empiresMusic.get()
  }

  /** Browsers only allow audio after a click or key press. iOS also wants a silent buffer
   * played in the same gesture, and may suspend again when the tab backgrounds. */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return
      const ctx = (this.ctx = new Ctx())
      const offs = [empiresMuted, empiresVolume, empiresMix, empiresMusic].map((p) => p.subscribe(() => this.applyVolume()))
      this.unsubscribe = () => offs.forEach((off) => off())
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
      for (const b of BUSES) {
        const g = ctx.createGain()
        g.connect(shelf)
        this.buses[b] = g
      }
      this.musicDir = new MusicDirector(ctx, this.buses.music!)
      this.applyVolume()
    }
    // iOS Safari: a zero-length buffer played under the user gesture unlocks the graph for later.
    try {
      const buf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate)
      const src = this.ctx.createBufferSource()
      src.buffer = buf
      src.connect(this.ctx.destination)
      src.start(0)
    } catch {
      /* ignore */
    }
    const kick = () => this.musicDir?.kick()
    if (this.ctx.state === 'suspended') void this.ctx.resume().then(kick)
    else kick()
  }

  private applyVolume() {
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume * 0.8
    for (const b of BUSES) if (this.buses[b]) this.buses[b]!.gain.value = b === 'music' && !this.music ? 0 : this.mix[b]
  }

  setMuted(m: boolean) {
    empiresMuted.set(m)
  }

  setVolume(v: number) {
    empiresVolume.set(v)
  }

  setMusic(on: boolean) {
    empiresMusic.set(on)
  }

  setMix(bus: Bus, v: number) {
    empiresMix.patch({ [bus]: v })
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
    // No sound yet (nothing clicked since the page loaded): nothing to play.
    if (!this.ctx) return false
    const now = this.ctx.currentTime
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
    // Every set's guns (a battle can have all three sides in it), then the rest.
    const guns = (Object.keys(GUNS) as SoundSet[]).flatMap((set) => (Object.keys(GUNS[set]) as (WeaponKind | 'light')[]).map((k): [string, Recipe, number] => [`${k}-${set}`, GUNS[set][k], k === 'missile' || k === 'ion' ? 3 : 4]))
    const hive = SET[faction] === 'hive'
    const jobs: [string, Recipe, number][] = [
      ...guns,
      ['shield', shieldHit, 4], ['hull', impact(false), 4], ['hull-heavy', impact(true), 4], ['wet', wetHit(false), 4], ['wet-heavy', wetHit(true), 4],
      ['boom0', explosion(0), 3], ['boom1', explosion(1), 3], ['boom2', explosion(2), 2], ['boom0-hive', explosion(0, true), 3], ['boom1-hive', explosion(1, true), 3], ['boom2-hive', explosion(2, true), 2],
      ['hpdown', hardpointDown, 3], ['shdown', shieldsDown, 3], ['launch', launch, 3], ...(hive ? [['hatch', hatch, 3] as [string, Recipe, number]] : []),
      // Jumps: rendered ahead, so the first one in a battle doesn't stall a frame and come in late.
      // Every side's jumps in (any side can be in the battle), our own side's retreats.
      ...Object.values(JUMPS).flatMap((j): [string, Recipe, number][] => [
        [`warp${j.tag}-${Math.round(WARP_YARD * 10)}`, j.charge(WARP_YARD), 2], [`warp${j.tag}-${Math.round(WARP_RESERVE * 10)}`, j.charge(WARP_RESERVE), 2], [`arrive${j.tag}`, j.arrive(false), 2], [`arriveBig${j.tag}`, j.arrive(true), 2],
      ]),
      ...Object.values(RETREAT_TIME).map((secs): [string, Recipe, number] => [`warp${JUMPS[WARP_STYLE[faction]].tag}-${Math.round(secs * 10)}`, JUMPS[WARP_STYLE[faction]].charge(secs), 1]),
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

  /** `light`: a fighter's guns, smaller and quieter than a warship's. Each faction's guns sound its
   * own (see GUNS); the rate limits are per kind of gun, whoever fires it. */
  fire(kind: WeaponKind, where: Where, faction: FactionId, light = false) {
    if (!this.ready()) return
    this.feel(kind === 'turbo' ? 0.4 : light ? 0.05 : 0.1, where)
    if (where.gain < 0.03) return
    const set = SET[faction]
    const play = (k: WeaponKind | 'light', o: { gain: number; verb?: number; rate?: number; takes?: number }) => this.play(`${k}-${set}`, GUNS[set][k], { where, ...o })
    if (kind === 'laser' && light) {
      // Dry: reverb would draw the snap out into a whoosh.
      if (this.allow('pew', 4)) play('light', { gain: 0.32, verb: 0.08, takes: 4 })
    } else if (kind === 'laser' && this.allow('laser', 3)) play('laser', { gain: 0.5, takes: 4 })
    else if (kind === 'turbo' && this.allow('turbo', 3, 0.1)) play('turbo', { gain: set === 'republic' ? 0.8 : 0.7, rate: FACTIONS[faction].sound.turbo, takes: 4 })
    else if (kind === 'flak' && this.allow('flak', 3)) play('flak', { gain: 0.55, takes: 4 })
    else if (kind === 'missile' && this.allow('missile', 2, 0.15)) play('missile', { gain: set === 'hive' ? 0.45 : 0.6, takes: 3 })
    else if (kind === 'ion' && this.allow('ion', 2, 0.15)) play('ion', { gain: 0.55, takes: 3 })
  }

  /** A squad member falling in a ground battle (ground/deaths.ts), by its faction: a trooper's grunt
   * and armour clatter, a droid's servo pop, a bug's squeal. A few at a time at most, so a big fight
   * doesn't turn into noise. */
  death(faction: FactionId, where: Where) {
    if (!this.ready() || where.gain < 0.05) return
    const set = SET[faction]
    if (!this.allow('death', 4, 0.4) || !this.allow(`death-${set}`, 2, 0.3)) return
    this.play(`death-${set}`, DEATH[set], { where, gain: set === 'forge' ? 0.4 : 0.35, verb: 0.12, takes: 4 })
  }

  /** A shot landing; `faction`: whose ship it hit (a living hull thuds wetly instead of crunching). */
  hit(shield: boolean, heavy: boolean, where: Where, faction?: FactionId) {
    if (!this.ready()) return
    this.feel(heavy ? 0.4 : shield ? 0.12 : 0.2, where)
    if (where.gain < 0.03) return
    if (shield) {
      if (this.allow('shield', 2, 0.1)) this.play('shield', shieldHit, { where, gain: 0.12, takes: 4 })
    } else if (this.allow('hull', heavy ? 3 : 2, 0.1)) {
      if (faction && SET[faction] === 'hive') this.play(heavy ? 'wet-heavy' : 'wet', wetHit(heavy), { where, gain: heavy ? 0.55 : 0.3, verb: 0.15, takes: 4 })
      else this.play(heavy ? 'hull-heavy' : 'hull', impact(heavy), { where, gain: heavy ? 0.6 : 0.3, verb: 0.15, takes: 4 })
    }
  }

  /** Size is the ship's size in world units: fighters ~30, capital ships ~380. `faction`: whose it
   * was (a living ship tears and groans rather than shearing). */
  boom(size: number, where: Where, faction?: FactionId) {
    if (!this.ready()) return
    const cls = size > 200 ? 2 : size > 60 ? 1 : 0
    this.feel([0.6, 1.5, 4][cls], where)
    if (where.gain < 0.02) return
    if (!this.allow(`boom${cls}`, [4, 3, 2][cls], 0.15)) return
    const hive = !!faction && SET[faction] === 'hive'
    this.play(`boom${cls}${hive ? '-hive' : ''}`, explosion(cls, hive), { where, gain: [0.6, 0.85, 1][cls], verb: 0.5, takes: cls === 2 ? 2 : 3 })
  }

  /** A jump starting somewhere we can see or hear; it winds up for `secs`, until the ship drops out.
   * `faction`: whose ship (each side jumps its own way, see WARP_STYLE). */
  warp(where: Where, secs: number, faction: FactionId = 'republic') {
    const j = JUMPS[WARP_STYLE[faction]]
    const name = `warp${j.tag}-${Math.round(secs * 10)}`
    if (this.ready() && where.gain > 0.05 && this.allow('warp', 2, 0.3)) this.play(name, j.charge(secs), { where, gain: j.tag ? 0.2 : 0.175, verb: 0.3, takes: 2 })
  }

  /** A ship dropping out of hyperspace (or its wormhole or rift), or jumping away into it. */
  arrive(where: Where, size: number, faction: FactionId = 'republic') {
    if (!this.ready()) return
    const big = size > 200
    const j = JUMPS[WARP_STYLE[faction]]
    this.feel(big ? 2.5 : 1, where)
    if (where.gain > 0.03 && this.allow(big ? 'arriveBig' : 'arrive', 3, 0.1)) this.play(`${big ? 'arriveBig' : 'arrive'}${j.tag}`, j.arrive(big), { where, gain: big ? 0.45 : 0.35, verb: 0.5, takes: 2 })
  }

  /** `faction`: whose part it was (a Swarm organ bursts wetly). */
  hardpointDown(where: Where, faction?: FactionId) {
    if (!this.ready() || where.gain <= 0.03 || !this.allow('hpdown', 2, 0.2)) return
    if (faction && SET[faction] === 'hive') this.play('hpdown-hive', (sr, r) => layers(sr, [{ data: wetHit(true)(sr, r) }, { data: explosion(0, true)(sr, r), gain: 0.6 }]), { where, gain: 0.8 })
    else this.play('hpdown', hardpointDown, { where, gain: 0.8 })
  }

  shieldsDown(where: Where) {
    if (this.ready() && where.gain > 0.05 && this.allow('shdown', 1, 0.3)) this.play('shdown', shieldsDown, { where, gain: 0.35 })
  }

  /** Strike craft out of a hangar; a Swarm brood hatching. */
  launch(where: Where, faction?: FactionId) {
    if (!this.ready() || where.gain <= 0.05 || !this.allow('launch', 2, 0.2)) return
    if (faction && SET[faction] === 'hive') this.play('hatch', hatch, { where, gain: 0.45 })
    else this.play('launch', launch, { where, gain: 0.5 })
  }

  /** An ability used; `faction`: whose (each set does its repairs and launches its own way). */
  ability(id: AbilityId, where?: Where, faction?: FactionId) {
    const set = faction ? SET[faction] : 'republic'
    if (this.ready()) this.play(`ab-${id}-${set}`, abilitySound(id, set), { bus: 'voice', where, gain: 0.8 * UI_LEVEL, takes: 2 })
  }

  // --- Crew and interface ---------------------------------------------------------------------------------

  /** A crew answering, over the radio. A new answer cuts off the last one. */
  private say(name: string, recipe: Recipe, gain = 0.6) {
    if (!this.ready()) return
    try {
      this.ackSrc?.stop()
    } catch {
      // Already over.
    }
    this.ackSrc = this.play(name, recipe, { bus: 'voice', gain: gain * UI_LEVEL, verb: 0.15, takes: 4 })
  }

  select(faction: FactionId, tier: Tier) {
    if (this.allow('select', 1, 0.12)) this.say(`sel-${faction}-${tier}`, ack('select', faction, tier), 0.4)
  }

  order(kind: OrderKind, faction: FactionId, tier: Tier = 'frigate') {
    if (this.ready() && this.allow('order', 1, 0.1)) this.say(`ord-${kind}-${faction}-${tier}`, ack(kind, faction, tier), 0.36)
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
  structureDone(kind: 'mine' | 'defense' | 'yard') {
    this.ui(`done-${kind}`, kind === 'mine' ? drillUp : weaponsOnline, 0.6, 1)
  }
  surveyed() {
    this.ui('scan', scan, 0.5, 1)
  }
  capture(ours: boolean) {
    this.ui(ours ? 'beacon-won' : 'beacon-lost', (sr) => (ours ? bells(sr, 440, [0, 7, 12, 16], 1.1, 0.07) : bells(sr, 311, [7, 3, 0, -5], 1.1, 0.09)), 0.55, 1)
  }
  /** A wreck stripped bare: a last clang and the tally chime. */
  salvaged() {
    if (this.ready() && this.allow('salvaged', 1, 0.5)) this.ui('salvaged', (sr) => layers(sr, [{ data: metal(true)(sr, Math.random), gain: 0.5 }, { data: bells(sr, 330, [0, 7, 12], 0.7, 0.06), at: 0.12, gain: 0.6 }]), 0.5, 1)
  }
  /** A day ends in Galactic conquest (payday): it comes often, so one soft, round note, kept quiet. */
  payday() {
    if (this.ready() && this.allow('payday', 1, 0.5)) this.ui('payday', (sr) => softNote(sr, 1318, 0.015, 0.09, 0.35), 0.035, 1)
  }
  /** A ship ranked up: a short rising chime. */
  promoted() {
    if (this.ready() && this.allow('promoted', 1, 0.5)) this.ui('promoted', (sr) => bells(sr, 392, [0, 4, 7, 12], 0.8, 0.05), 0.5, 1)
  }
  levelUp() {
    this.ui('levelup', (sr) => brass(sr, 196, [[[0, 4, 7], 0.22], [[2, 5, 9], 0.22], [[4, 7, 12], 0.7]], 0.6), 0.55, 1)
  }
  alarm(station: boolean) {
    // Under attack: snap the score into combat music, don't wait for heat to crawl up.
    this.heat = Math.max(this.heat, station ? 3.5 : 2.5)
    this.musicDir?.setHeat(this.heat)
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
    this.musicDir?.duckFor(3.2)
    this.ui('victory', (sr) =>
      layers(sr, [
        { data: brass(sr, 196, [[[0, 4, 7], 0.3], [[0, 4, 7], 0.15], [[5, 9, 12], 0.3], [[7, 11, 14], 0.3], [[12, 16, 19], 1.6]], 1.2) },
        ...[0, 0.45, 0.9, 1.05].map((at) => ({ data: drum(sr), at, gain: 0.7 })),
      ]),
      0.75, 1)
  }
  defeat() {
    this.musicDir?.duckFor(3.2)
    this.ui('defeat', (sr) =>
      layers(sr, [{ data: brass(sr, 147, [[[0, 3, 7], 0.6], [[-2, 2, 5], 0.6], [[-5, -2, 3], 1.6]], 1.2) }, { data: explosion(2)(sr, Math.random), gain: 0.35, at: 0.1 }]),
      0.7, 1)
  }

  // --- Ambience and music ---------------------------------------------------------------------------------

  /**
   * Combat heat for music + rumble. Nearby fighting matters most (where.gain high) — the old
   * `(1 - gain)` formula only heated distant battles, so combat music never started on-camera.
   */
  private feel(amount: number, where: Where) {
    const near = 0.3 + where.gain * 0.7
    this.heat = Math.min(6, this.heat + amount * near * 0.7)
  }

  /** Call every frame: rumble + combat-heat flip between skirmish and skirmishCombat music. */
  ambience(dt: number) {
    if (!this.ctx) return
    // Hold heat a bit so a skirmish stays in combat music between volleys.
    this.heat *= Math.exp(-dt / 4.5)
    if (this.rumble) this.rumble.gain.setTargetAtTime(Math.min(0.5, this.heat * 0.12), this.ctx.currentTime, 0.4)
    this.musicDir?.setHeat(this.heat)
    this.musicDir?.tick(dt)
  }

  /** Distant battle rumble on the ambience bus (skirmish / combat only). */
  private ensureRumble() {
    if (!this.ctx || this.rumble) return
    const ctx = this.ctx
    const n = ctx.sampleRate * 3
    const nb = ctx.createBuffer(1, n, ctx.sampleRate)
    const d = nb.getChannelData(0)
    for (let i = 0; i < n; i++) d[i] = noise()
    const rb = ctx.createBufferSource()
    rb.buffer = nb
    rb.loop = true
    rb.playbackRate.value = 0.5
    const rf = ctx.createBiquadFilter()
    rf.type = 'lowpass'
    rf.frequency.value = 160
    const rumble = ctx.createGain()
    rumble.gain.value = 0
    rb.connect(rf).connect(rumble).connect(this.buses.amb!)
    rb.start()
    this.rumble = rumble
    this.rumbleSrc = rb
  }

  private stopRumble() {
    const rumble = this.rumble
    const rb = this.rumbleSrc
    this.rumble = null
    this.rumbleSrc = null
    if (!rumble || !this.ctx) return
    const t = this.ctx.currentTime
    rumble.gain.cancelScheduledValues(t)
    rumble.gain.setValueAtTime(rumble.gain.value, t)
    rumble.gain.linearRampToValueAtTime(0, t + 0.6)
    setTimeout(() => {
      try {
        rb?.stop()
      } catch {
        /* already stopped */
      }
      rumble.disconnect()
    }, 800)
  }

  /**
   * Shell music location. Combat and GC-alarm pieces flip automatically (heat / galaxyThreat).
   * `'none'` stops. Skirmish starts the distant rumble.
   */
  setMusicScene(scene: 'menu' | 'lobby' | 'skirmish' | 'galaxy' | 'none') {
    this.unlock()
    if (!this.musicDir) return
    if (scene === 'skirmish') this.ensureRumble()
    else this.stopRumble()
    if (scene !== 'skirmish') this.heat = 0
    this.musicDir.setScene(scene)
    this.musicDir.kick()
  }

  /** Sound-test: audition any piece, including combat / alarm variants. */
  previewMusic(scene: MusicScene) {
    this.unlock()
    if (!this.musicDir) return
    if (scene === 'skirmish' || scene === 'skirmishCombat') this.ensureRumble()
    else this.stopRumble()
    this.musicDir.preview(scene)
    this.musicDir.kick()
  }

  /** Galactic conquest: hostile event — switches map music to the alarm piece for a while. */
  galaxyThreat(seconds = 16) {
    this.unlock()
    this.musicDir?.galaxyThreat(seconds)
  }

  get musicScene(): MusicScene {
    return this.musicDir?.currentScene ?? 'none'
  }

  dispose() {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.stopRumble()
    this.musicDir?.dispose()
    this.musicDir = null
    void this.ctx?.close()
    this.ctx = null
  }
}
