// Background sound for each place in the game, synthesised like everything else: steady beds of
// filtered noise or drones, plus little events on random timers (a bird, a hammer on the anvil,
// a bubble). One place plays at a time; GladiatorSound crossfades between them.

export type AmbiencePlace = 'title' | 'town' | 'arena' | 'forge' | 'armoury' | 'mage' | 'apothecary' | 'training' | 'estate' | 'market'

/** How loud the music plays over each place: quieter where the place itself is the show. */
export const MUSIC_LEVEL: Record<AmbiencePlace, number> = { title: 1, town: 1, arena: 0.8, forge: 0.55, armoury: 0.9, mage: 0.5, apothecary: 0.9, training: 0.85, estate: 0.9, market: 0.9 }

export type AmbienceKit = { ctx: AudioContext; noise: AudioBuffer; verb: GainNode; woods: AudioBuffer[]; clangs: AudioBuffer[]; anvils: AudioBuffer[] }
export type Ambience = { gain: GainNode; stop: () => void }

const rand = (a: number, b: number) => a + Math.random() * (b - a)

export function startAmbience(kit: AmbienceKit, place: AmbiencePlace, out: AudioNode): Ambience {
  const { ctx, noise } = kit
  const gain = ctx.createGain()
  gain.gain.value = 0
  gain.connect(out)
  const wet = ctx.createGain()
  wet.gain.value = 0.5
  gain.connect(wet).connect(kit.verb)
  const sources: AudioScheduledSourceNode[] = []
  const timers: ReturnType<typeof setTimeout>[] = []
  let alive = true

  /** A steady bed: looping noise through a filter, its level gently wandering. */
  const bed = (type: BiquadFilterType, freq: number, q: number, level: number, wobble = 0.3, rate = 0.15) => {
    const src = ctx.createBufferSource()
    src.buffer = noise
    src.loop = true
    src.playbackRate.value = rand(0.9, 1.1)
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = q
    const g = ctx.createGain()
    g.gain.value = level
    const lfo = ctx.createOscillator()
    lfo.frequency.value = rate * rand(0.7, 1.3)
    const depth = ctx.createGain()
    depth.gain.value = level * wobble
    lfo.connect(depth).connect(g.gain)
    src.connect(f).connect(g).connect(gain)
    src.start(0, rand(0, 1.5))
    lfo.start()
    sources.push(src, lfo)
  }

  /** A sustained tone for drones. */
  const drone = (freq: number, level: number, type: OscillatorType = 'sine', cutoff = 800) => {
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.value = freq
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = cutoff
    const g = ctx.createGain()
    g.gain.value = level
    o.connect(f).connect(g).connect(gain)
    o.start()
    sources.push(o)
  }

  const burst = (at: number, dur: number, type: BiquadFilterType, freq: number, q: number, level: number, sweepTo?: number) => {
    const src = ctx.createBufferSource()
    src.buffer = noise
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.setValueAtTime(freq, at)
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, at + dur)
    f.Q.value = q
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(level, at + Math.min(0.05, dur / 3))
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    src.connect(f).connect(g).connect(gain)
    src.start(at, rand(0, 1.5))
    src.stop(at + dur + 0.05)
  }

  const tone = (at: number, dur: number, f0: number, f1: number, level: number, type: OscillatorType = 'sine', attack = 0.005) => {
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(f0, at)
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, at + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(level, at + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    o.connect(g).connect(gain)
    o.start(at)
    o.stop(at + dur + 0.05)
  }

  const sample = (buf: AudioBuffer, at: number, level: number, rate = 1) => {
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const g = ctx.createGain()
    g.gain.value = level
    src.connect(g).connect(gain)
    src.start(at)
  }

  /** Runs `fn` again and again, a random `min`..`max` seconds apart. */
  const every = (min: number, max: number, fn: (at: number) => void) => {
    const next = () => {
      if (!alive) return
      fn(ctx.currentTime + 0.05)
      timers.push(setTimeout(next, rand(min, max) * 1000))
    }
    timers.push(setTimeout(next, rand(min * 0.3, max * 0.6) * 1000))
  }

  const bird = (at: number, level = 0.03) => {
    const base = rand(2600, 3800)
    const n = 2 + Math.floor(rand(0, 4))
    for (let i = 0; i < n; i++) tone(at + i * rand(0.08, 0.14), 0.07, base * rand(0.95, 1.1), base * rand(1.2, 1.45), level, 'sine', 0.01)
  }
  const crowd = (level: number) => {
    bed('bandpass', 450, 1.1, level, 0.35, 0.12)
    bed('bandpass', 1050, 1.3, level * 0.6, 0.4, 0.17)
    bed('bandpass', 2300, 1.5, level * 0.25, 0.5, 0.21)
  }
  const crackle = (at: number, level: number) => {
    for (let i = 0; i < 4; i++) if (Math.random() < 0.7) burst(at + rand(0, 0.4), 0.012, 'highpass', rand(2000, 4500), 0.8, level * rand(0.4, 1))
  }
  const wind = (level: number) => bed('lowpass', 320, 0.6, level, 0.6, 0.07)

  switch (place) {
    case 'title':
      // Behind the gate: a muffled crowd, torches, a draught through the tunnel.
      bed('lowpass', 380, 0.8, 0.18, 0.4, 0.1)
      wind(0.08)
      every(0.4, 1.2, (at) => crackle(at, 0.05))
      every(9, 18, (at) => burst(at, 2.2, 'lowpass', 300, 0.7, 0.14, 700))
      break
    case 'estate':
      // Out in the country: wind in the trees, birds, and from the hill the mine's pickaxes.
      wind(0.07)
      bed('highpass', 3000, 0.7, 0.008, 0.8, 1.2)
      every(1.2, 4, (at) => bird(at))
      every(3, 7, (at) => {
        const hits = 2 + Math.floor(rand(0, 3))
        for (let i = 0; i < hits; i++) sample(kit.anvils[Math.floor(Math.random() * kit.anvils.length)], at + i * rand(0.7, 1), 0.025, rand(0.6, 0.75))
      })
      every(8, 16, (at) => sample(kit.woods[Math.floor(Math.random() * kit.woods.length)], at, 0.06, rand(0.7, 0.9)))
      break
    case 'market':
      // The forum on market day: haggling all round, coins changing hands.
      crowd(0.08)
      every(1.5, 4, (at) => {
        for (let i = 0; i < 3; i++) tone(at + i * rand(0.05, 0.09), 0.18, rand(2300, 3200), rand(2300, 3200), 0.02, 'sine', 0.002)
      })
      every(5, 11, (at) => bird(at, 0.015))
      break
    case 'town':
      // Market chatter, a fountain, birds, now and then a cart.
      crowd(0.05)
      bed('highpass', 3200, 0.7, 0.012, 0.8, 1.7)
      every(1.5, 5, (at) => bird(at))
      every(12, 25, (at) => {
        for (let i = 0; i < 6; i++) burst(at + i * 0.32, 0.12, 'lowpass', 420, 0.7, 0.06)
      })
      break
    case 'arena':
      // The stands: a big murmur, wind over the sand, the odd cheer.
      crowd(0.11)
      wind(0.06)
      every(6, 14, (at) => burst(at, 1.6, 'bandpass', 900, 1, 0.09, 1400))
      break
    case 'forge':
      // Fire, bellows, and the smith at the anvil in bursts of blows.
      bed('lowpass', 500, 0.7, 0.12, 0.25, 0.4)
      every(0.15, 0.6, (at) => crackle(at, 0.08))
      every(4, 7, (at) => burst(at, 1.4, 'bandpass', 260, 1.2, 0.16, 700))
      every(3, 7, (at) => {
        const hits = 2 + Math.floor(rand(0, 3))
        // Blows land slightly unevenly and the last is often lighter, like a smith working a blade.
        for (let i = 0; i < hits; i++) sample(kit.anvils[Math.floor(Math.random() * kit.anvils.length)], at + i * rand(0.42, 0.62), (i === hits - 1 ? 0.07 : 0.11) * rand(0.8, 1.1), rand(0.94, 1.04))
      })
      break
    case 'armoury':
      // A quiet room: shuffled chainmail, plate set down, boards creaking.
      bed('lowpass', 180, 0.7, 0.05, 0.3, 0.08)
      every(4, 9, (at) => {
        for (let i = 0; i < 10; i++) burst(at + rand(0, 0.35), 0.02, 'bandpass', rand(4000, 7000), 3, 0.025)
      })
      every(7, 14, (at) => sample(kit.clangs[Math.floor(Math.random() * kit.clangs.length)], at, 0.05, rand(0.45, 0.6)))
      every(6, 12, (at) => tone(at, 0.5, rand(140, 220), rand(110, 160), 0.02, 'triangle', 0.15))
      break
    case 'mage':
      // A low hum of power, slow shimmering chimes.
      drone(55, 0.05, 'sawtooth', 220)
      drone(55.4, 0.04, 'sawtooth', 220)
      drone(110, 0.025)
      bed('bandpass', 5000, 4, 0.006, 0.9, 0.3)
      every(1.2, 3.5, (at) => {
        const scale = [0, 2, 4, 7, 9, 12, 14]
        const f = 523 * Math.pow(2, scale[Math.floor(Math.random() * scale.length)] / 12) * (Math.random() < 0.5 ? 1 : 2)
        tone(at, 2.4, f, f, 0.025, 'sine', 0.02)
        tone(at, 1.6, f * 2.01, f * 2.01, 0.008, 'sine', 0.02)
      })
      break
    case 'apothecary':
      // Bubbling flasks, a clink of glass, birds through the window.
      bed('lowpass', 250, 0.7, 0.03, 0.3, 0.1)
      every(0.15, 0.7, (at) => {
        const f = rand(320, 900)
        tone(at, 0.07, f, f * rand(1.4, 2), 0.035)
      })
      every(5, 11, (at) => {
        const f = rand(2800, 3600)
        tone(at, 0.4, f, f, 0.03, 'sine', 0.002)
        tone(at, 0.3, f * 1.53, f * 1.53, 0.015, 'sine', 0.002)
      })
      every(4, 9, (at) => bird(at, 0.015))
      break
    case 'training':
      // Wind across the yard, wooden swords knocking, someone grunting through drills.
      wind(0.08)
      bed('highpass', 2500, 0.6, 0.006, 0.6, 0.2)
      every(1.6, 4, (at) => {
        const hits = 1 + Math.floor(rand(0, 3))
        for (let i = 0; i < hits; i++) sample(kit.woods[Math.floor(Math.random() * kit.woods.length)], at + i * rand(0.25, 0.4), rand(0.08, 0.14), rand(1.1, 1.4))
      })
      every(5, 10, (at) => burst(at, 0.25, 'bandpass', 700, 5, 0.025, 500))
      every(4, 10, (at) => bird(at, 0.012))
      break
  }

  return {
    gain,
    stop: () => {
      alive = false
      timers.forEach(clearTimeout)
      for (const s of sources) {
        try {
          s.stop()
        } catch {
          /* already stopped */
        }
      }
      setTimeout(() => {
        gain.disconnect()
        wet.disconnect()
      }, 200)
    },
  }
}
