import type { WeaponKind } from './data'

// The cutout puppet: a 2D skeleton posed by a handful of angles, and the clips that animate it.
// Angles are in degrees while authoring. 0 points straight up and positive turns towards the way
// the gladiator faces, so 90 is straight ahead and 180 hangs down. Arms are relative to the torso,
// forearms to the upper arm (negative bends the elbow), weapons to the forearm, and shins to the
// thigh (positive bends the knee). Thighs and the torso are absolute.

export type Face = 'calm' | 'grit' | 'shout' | 'hurt' | 'smile' | 'ko'
export type Pose = {
  torso: number
  head: number
  armF: number
  foreF: number
  handF: number
  armB: number
  foreB: number
  legF: number
  shinF: number
  legB: number
  shinB: number
  /** Hip shift along the facing direction. */
  rootX: number
  /** 0: feet planted on the sand. 1: the hip floats at `lift` above it (falls, jumps). */
  free: number
  lift: number
  /** Whole-body roll about the hip, for falling over. */
  rot: number
  face: Face
}

export const BONES = { thigh: 58, shin: 56, foot: 24, torso: 72, neck: 9, head: 22, upper: 44, fore: 40 }

const NUMERIC: (keyof Pose)[] = ['torso', 'head', 'armF', 'foreF', 'handF', 'armB', 'foreB', 'legF', 'shinF', 'legB', 'shinB', 'rootX', 'free', 'lift', 'rot']

export type Grip = 'slash' | 'thrust' | 'heavy' | 'fist'
export function gripOf(kind: WeaponKind | null): Grip {
  if (!kind) return 'fist'
  if (kind === 'spear' || kind === 'trident' || kind === 'dagger' || kind === 'staff' || kind === 'wand') return 'thrust'
  if (kind === 'greatsword' || kind === 'warhammer') return 'heavy'
  return 'slash'
}

const GUARD: Record<Grip, Pose> = {
  slash: { torso: 6, head: -4, armF: 150, foreF: -72, handF: -62, armB: 158, foreB: -82, legF: 158, shinF: 26, legB: 204, shinB: 8, rootX: 0, free: 0, lift: 0, rot: 0, face: 'calm' },
  thrust: { torso: 8, head: -6, armF: 172, foreF: -86, handF: -6, armB: 150, foreB: -76, legF: 156, shinF: 28, legB: 206, shinB: 8, rootX: 0, free: 0, lift: 0, rot: 0, face: 'calm' },
  heavy: { torso: 10, head: -6, armF: 160, foreF: -96, handF: -40, armB: 150, foreB: -70, legF: 156, shinF: 30, legB: 208, shinB: 10, rootX: 0, free: 0, lift: 0, rot: 0, face: 'calm' },
  fist: { torso: 8, head: -4, armF: 150, foreF: -100, handF: -90, armB: 160, foreB: -100, legF: 158, shinF: 26, legB: 204, shinB: 8, rootX: 0, free: 0, lift: 0, rot: 0, face: 'calm' },
}

type Key = { at: number; pose: Partial<Pose> }
type ClipDef = { dur: number; keys: Key[]; loop?: boolean }

export type ClipName =
  | 'guard' | 'walk' | 'walkBack' | 'quick' | 'normal' | 'power' | 'hit' | 'block' | 'dodge' | 'taunt' | 'rest' | 'cast' | 'drink' | 'stunned' | 'ko' | 'victory' | 'tired'

/** Where in each attack clip the blow connects, in ms. The arena times the impact to this. */
export const IMPACT: Record<'quick' | 'normal' | 'power', number> = { quick: 190, normal: 300, power: 470 }

function attackClip(grip: Grip, type: 'quick' | 'normal' | 'power'): ClipDef {
  const hit = IMPACT[type]
  const wind = hit - (type === 'power' ? 150 : 110)
  const k = type === 'quick' ? 0.55 : type === 'normal' ? 0.8 : 1
  if (grip === 'thrust') {
    return {
      dur: hit + 260,
      keys: [
        { at: 0, pose: {} },
        { at: wind, pose: { torso: -6 * k, armF: 200 + 14 * k, foreF: -118, handF: -2, rootX: -8 * k, face: 'grit' } },
        { at: hit, pose: { torso: 20 * k, armF: 96, foreF: -4, handF: 0, rootX: 34 * k, legF: 140, shinF: 20, legB: 222, shinB: 2, face: 'shout' } },
        { at: hit + 110, pose: { torso: 16 * k, armF: 104, foreF: -10, handF: 0, rootX: 30 * k, legF: 142, legB: 220, face: 'grit' } },
        { at: hit + 260, pose: {} },
      ],
    }
  }
  if (grip === 'fist') {
    return {
      dur: hit + 240,
      keys: [
        { at: 0, pose: {} },
        { at: wind, pose: { torso: -4, armF: 190, foreF: -120, rootX: -6, face: 'grit' } },
        { at: hit, pose: { torso: 18, armF: 92, foreF: -6, rootX: 26 * k, legF: 144, legB: 218, face: 'shout' } },
        { at: hit + 240, pose: {} },
      ],
    }
  }
  const heavy = grip === 'heavy' ? 1 : 0
  return {
    dur: hit + 300,
    keys: [
      { at: 0, pose: {} },
      { at: wind, pose: { torso: -8 - 10 * k, head: -12, armF: 40 - 46 * k, foreF: -40 - 20 * heavy, handF: -70, rootX: -10 * k, legF: 164, legB: 200, face: 'grit' } },
      { at: hit - 40, pose: { torso: 14 * k, armF: 80, foreF: -20, handF: -40, rootX: 18 * k, face: 'shout' } },
      { at: hit, pose: { torso: 24 * k, head: 4, armF: 118, foreF: -6, handF: -10, rootX: 30 * k, legF: 140, shinF: 24, legB: 222, shinB: 4, face: 'shout' } },
      { at: hit + 120, pose: { torso: 26 * k, armF: 140, foreF: -4, handF: 0, rootX: 30 * k, legF: 142, legB: 220, face: 'grit' } },
      { at: hit + 300, pose: {} },
    ],
  }
}

function clips(grip: Grip): Record<ClipName, ClipDef> {
  return {
    guard: { dur: 2400, loop: true, keys: [{ at: 0, pose: {} }] },
    tired: { dur: 2400, loop: true, keys: [{ at: 0, pose: { torso: 18, head: 10, armF: 165, foreF: -50, legF: 162, shinF: 30, face: 'hurt' } }] },
    walk: { dur: 520, loop: true, keys: [{ at: 0, pose: {} }] },
    walkBack: { dur: 600, loop: true, keys: [{ at: 0, pose: {} }] },
    quick: attackClip(grip, 'quick'),
    normal: attackClip(grip, 'normal'),
    power: attackClip(grip, 'power'),
    hit: {
      dur: 420,
      keys: [
        { at: 0, pose: {} },
        { at: 70, pose: { torso: -20, head: -18, armF: 175, foreF: -40, armB: 175, foreB: -40, rootX: -12, legF: 164, legB: 200, face: 'hurt' } },
        { at: 200, pose: { torso: -12, head: -8, rootX: -8, face: 'hurt' } },
        { at: 420, pose: {} },
      ],
    },
    block: {
      dur: 420,
      keys: [
        { at: 0, pose: {} },
        { at: 80, pose: { torso: -6, head: 4, armB: 118, foreB: -86, rootX: -8, face: 'grit' } },
        { at: 260, pose: { torso: -4, armB: 124, foreB: -84, rootX: -6, face: 'grit' } },
        { at: 420, pose: {} },
      ],
    },
    dodge: {
      dur: 460,
      keys: [
        { at: 0, pose: {} },
        { at: 110, pose: { torso: -26, head: -14, rootX: -24, legF: 150, shinF: 16, legB: 214, shinB: 24, face: 'calm' } },
        { at: 280, pose: { torso: -16, rootX: -14 } },
        { at: 460, pose: {} },
      ],
    },
    taunt: {
      dur: 1100,
      keys: [
        { at: 0, pose: {} },
        { at: 180, pose: { torso: -12, head: -16, armF: 24, foreF: -24, handF: -20, armB: 214, foreB: -126, legF: 168, legB: 196, face: 'shout' } },
        { at: 420, pose: { torso: -8, head: -20, armF: 12, foreF: -12, handF: -10, armB: 214, foreB: -126, face: 'smile' } },
        { at: 640, pose: { torso: -12, head: -14, armF: 26, foreF: -26, handF: -20, armB: 214, foreB: -126, face: 'shout' } },
        { at: 880, pose: { torso: -8, head: -16, armF: 18, foreF: -16, armB: 214, foreB: -126, face: 'smile' } },
        { at: 1100, pose: {} },
      ],
    },
    rest: {
      dur: 1100,
      keys: [
        { at: 0, pose: {} },
        { at: 260, pose: { torso: 34, head: 16, armF: 168, foreF: -36, armB: 150, foreB: -40, legF: 118, shinF: 96, legB: 196, shinB: 84, face: 'hurt' } },
        { at: 800, pose: { torso: 30, head: 8, armF: 168, foreF: -36, armB: 150, foreB: -40, legF: 118, shinF: 96, legB: 196, shinB: 84, face: 'calm' } },
        { at: 1100, pose: {} },
      ],
    },
    cast: {
      dur: 760,
      keys: [
        { at: 0, pose: {} },
        { at: 260, pose: { torso: -10, head: -10, armF: 12, foreF: -14, handF: -30, armB: 120, foreB: -20, face: 'shout' } },
        { at: 420, pose: { torso: 16, head: 0, armF: 88, foreF: -4, handF: -60, armB: 110, foreB: -10, rootX: 10, face: 'shout' } },
        { at: 560, pose: { torso: 14, armF: 92, foreF: -4, handF: -60, rootX: 10, face: 'grit' } },
        { at: 760, pose: {} },
      ],
    },
    drink: {
      dur: 900,
      keys: [
        { at: 0, pose: {} },
        { at: 220, pose: { torso: -6, head: -10, armB: 120, foreB: -140, face: 'calm' } },
        { at: 420, pose: { torso: -14, head: -30, armB: 110, foreB: -150, face: 'calm' } },
        { at: 680, pose: { torso: -12, head: -26, armB: 110, foreB: -150, face: 'smile' } },
        { at: 900, pose: {} },
      ],
    },
    stunned: {
      dur: 900,
      loop: true,
      keys: [
        { at: 0, pose: { torso: -10, head: 14, armF: 176, foreF: -30, armB: 184, foreB: -20, rootX: -4, face: 'ko' } },
        { at: 450, pose: { torso: 6, head: -12, armF: 172, foreF: -26, armB: 180, foreB: -30, rootX: 4, face: 'ko' } },
        { at: 900, pose: { torso: -10, head: 14, armF: 176, foreF: -30, armB: 184, foreB: -20, rootX: -4, face: 'ko' } },
      ],
    },
    ko: {
      dur: 1300,
      keys: [
        { at: 0, pose: {} },
        { at: 160, pose: { torso: -30, head: -26, armF: 200, foreF: -20, armB: 210, foreB: -20, rootX: -26, face: 'hurt' } },
        { at: 520, pose: { torso: -24, head: -10, armF: 160, foreF: -10, armB: 220, foreB: -10, legF: 140, shinF: 100, legB: 190, shinB: 100, rootX: -30, face: 'ko' } },
        { at: 900, pose: { torso: -10, head: 20, armF: 196, foreF: -20, handF: -150, armB: 210, foreB: -6, legF: 176, shinF: 14, legB: 186, shinB: 22, rootX: -40, free: 1, lift: 22, rot: -86, face: 'ko' } },
        { at: 1050, pose: { torso: -10, head: 14, armF: 192, foreF: -24, handF: -150, armB: 214, foreB: -6, legF: 172, shinF: 22, legB: 186, shinB: 18, rootX: -42, free: 1, lift: 26, rot: -82, face: 'ko' } },
        { at: 1300, pose: { torso: -10, head: 16, armF: 194, foreF: -22, handF: -150, armB: 212, foreB: -6, legF: 174, shinF: 18, legB: 186, shinB: 20, rootX: -42, free: 1, lift: 20, rot: -86, face: 'ko' } },
      ],
    },
    victory: {
      dur: 1400,
      loop: true,
      keys: [
        { at: 0, pose: { torso: -6, head: -16, armF: -4, foreF: -14, handF: -10, armB: 206, foreB: -120, legF: 166, legB: 196, face: 'shout' } },
        { at: 700, pose: { torso: -10, head: -22, armF: -10, foreF: -8, handF: -4, armB: 206, foreB: -120, legF: 166, legB: 196, face: 'smile' } },
        { at: 1400, pose: { torso: -6, head: -16, armF: -4, foreF: -14, handF: -10, armB: 206, foreB: -120, legF: 166, legB: 196, face: 'shout' } },
      ],
    },
  }
}

const CLIP_CACHE = new Map<Grip, Record<ClipName, ClipDef>>()
const clipsFor = (grip: Grip) => {
  let c = CLIP_CACHE.get(grip)
  if (!c) CLIP_CACHE.set(grip, (c = clips(grip)))
  return c
}

const smooth = (t: number) => t * t * (3 - 2 * t)

function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const out = { ...a }
  for (const k of NUMERIC) (out[k] as number) = (a[k] as number) + ((b[k] as number) - (a[k] as number)) * t
  out.face = t < 0.5 ? a.face : b.face
  return out
}

function sample(def: ClipDef, base: Pose, t: number): Pose {
  if (def.loop) t %= def.dur
  else t = Math.min(t, def.dur)
  const keys = def.keys
  let i = 0
  while (i < keys.length - 1 && keys[i + 1].at <= t) i++
  const a = { ...base, ...keys[i].pose }
  if (i === keys.length - 1) return a
  const b = { ...base, ...keys[i + 1].pose }
  const span = keys[i + 1].at - keys[i].at
  return lerpPose(a, b, smooth(span ? (t - keys[i].at) / span : 1))
}

/** One fighter's animation state: the clip playing, crossfaded from whatever was showing. */
export class Puppet {
  grip: Grip
  clip: ClipName = 'guard'
  t = 0
  private from: Pose
  private fade = 0
  private fadeDur = 1
  private last: Pose
  /** Ambient extras layered on top: breathing, and how worn out the fighter looks. */
  tired = 0
  speed = 1

  constructor(grip: Grip) {
    this.grip = grip
    this.from = this.last = { ...GUARD[grip] }
  }

  play(clip: ClipName, fade = 90) {
    this.from = this.last
    this.clip = clip
    this.t = 0
    this.fade = 0
    this.fadeDur = Math.max(1, fade)
  }

  done() {
    const d = clipsFor(this.grip)[this.clip]
    return !d.loop && this.t >= d.dur
  }

  update(dt: number) {
    this.t += dt * this.speed
    this.fade += dt
  }

  pose(time: number): Pose {
    const base = GUARD[this.grip]
    const def = clipsFor(this.grip)[this.clip]
    let p: Pose
    if (this.clip === 'walk' || this.clip === 'walkBack') {
      const ph = ((this.t / def.dur) * Math.PI * 2) * (this.clip === 'walk' ? 1 : -1)
      const s = Math.sin(ph)
      p = {
        ...base,
        legF: 172 - 24 * s,
        shinF: 10 + 26 * Math.max(0, Math.cos(ph)),
        legB: 188 + 24 * s,
        shinB: 10 + 26 * Math.max(0, -Math.cos(ph)),
        torso: base.torso + 4,
        armF: base.armF + 5 * s,
        armB: base.armB - 5 * s,
        face: 'grit',
      }
    } else p = sample(def, base, this.t)
    if (this.clip === 'guard' && this.tired > 0) p = lerpPose(p, sample(clipsFor(this.grip).tired, base, 0), this.tired)
    // Breathing and a slight bounce on the balls of the feet.
    const br = Math.sin(time / 520)
    if (p.free < 0.5 && (this.clip === 'guard' || this.clip === 'victory' || this.clip === 'stunned')) {
      p.torso += br * 1.6
      p.head -= br * 1.2
      p.armF += br * 2.4
      p.armB -= br * 2
      p.shinF += (br + 1) * 3
      p.shinB += (br + 1) * 2
    }
    if (this.fade < this.fadeDur) p = lerpPose(this.from, p, smooth(this.fade / this.fadeDur))
    this.last = p
    return p
  }
}

/** The idle pose for a grip, for still previews. */
export const guardPose = (grip: Grip): Pose => ({ ...GUARD[grip] })
