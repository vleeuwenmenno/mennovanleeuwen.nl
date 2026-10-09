import { CAPE_COLOURS, isHalfTier, item, MATERIALS, tierStyle, type Item, type Look, type Slot, type WeaponKind } from './data'
import { BONES, type Face, type Pose } from './rig'

// Draws a gladiator: limbs as outlined, tapered capsules like a cutout puppet, a profile face,
// hair and beard, then every piece of gear on the bone it belongs to. Drawn facing right with the
// feet at the origin; the caller mirrors and places it.

type P = { x: number; y: number }
const D = Math.PI / 180
const dir = (deg: number): P => ({ x: Math.sin(deg * D), y: -Math.cos(deg * D) })
const add = (a: P, b: P, k = 1): P => ({ x: a.x + b.x * k, y: a.y + b.y * k })
const OUTLINE = '#22140c'
const LINE = 2.6

export type Rigged = {
  hip: P
  neck: P
  head: P
  headAng: number
  torsoAng: number
  shF: P
  shB: P
  elbowF: P
  handF: P
  elbowB: P
  handB: P
  kneeF: P
  ankleF: P
  kneeB: P
  ankleB: P
  footAngF: number
  footAngB: number
  upperFAng: number
  foreFAng: number
  upperBAng: number
  foreBAng: number
  weaponAng: number
}

export type Kit = { look: Look; gear: Partial<Record<Slot, Item | null>> }

export function kitOf(look: Look, gear: Partial<Record<Slot, string>>): Kit {
  const g: Kit['gear'] = {}
  for (const k of Object.keys(gear) as Slot[]) g[k] = item(gear[k])
  return { look, gear: g }
}

export const weaponKind = (kit: Kit): WeaponKind | null => kit.gear.weapon?.weapon ?? null
const twoHanded = (k: WeaponKind | null) => k === 'greatsword' || k === 'warhammer' || k === 'trident' || k === 'staff'
/** Where along the weapon, behind the front hand, the back hand grips a two-handed weapon. */
const SECOND_GRIP: Partial<Record<WeaponKind, number>> = { greatsword: 13, warhammer: 22, trident: 34, staff: 30 }

/** Solves the skeleton for a pose. Feet stay planted unless the pose floats free. */
export function rig(p: Pose, kind: WeaponKind | null): Rigged {
  const legPts = (thigh: number, shin: number) => {
    const knee = dir(thigh)
    const k = { x: knee.x * BONES.thigh, y: knee.y * BONES.thigh }
    const ankle = add(k, dir(thigh + shin), BONES.shin)
    return { knee: k, ankle }
  }
  const lf = legPts(p.legF, p.shinF)
  const lb = legPts(p.legB, p.shinB)
  const grounded = -(Math.max(lf.ankle.y, lb.ankle.y) + 7)
  const hipY = grounded + (-p.lift - grounded) * p.free
  const hip = { x: p.rootX, y: hipY }

  const rot = p.rot
  const R = (pt: P): P => {
    const c = Math.cos(rot * D)
    const s = Math.sin(rot * D)
    return { x: hip.x + pt.x * c - pt.y * s, y: hip.y + pt.x * s + pt.y * c }
  }
  const T = p.torso
  const torsoTop = dir(T)
  const perp = dir(T + 90)
  const neckL = { x: torsoTop.x * BONES.torso, y: torsoTop.y * BONES.torso }
  const shFL = add(add({ x: torsoTop.x * BONES.torso * 0.88, y: torsoTop.y * BONES.torso * 0.88 }, perp, 2), { x: 0, y: 0 })
  const shBL = add({ x: torsoTop.x * BONES.torso * 0.86, y: torsoTop.y * BONES.torso * 0.86 }, perp, -5)
  const upperF = T + p.armF
  const foreF = upperF + p.foreF
  const elbowFL = add(shFL, dir(upperF), BONES.upper)
  const handFL = add(elbowFL, dir(foreF), BONES.fore)
  let upperB = T + p.armB
  let foreB = upperB + p.foreB
  let elbowBL = add(shBL, dir(upperB), BONES.upper)
  let handBL = add(elbowBL, dir(foreB), BONES.fore)
  const weaponAng = foreF + p.handF

  // Two-handed weapons: the back hand reaches for the handle.
  const second = kind ? SECOND_GRIP[kind] : undefined
  if (second !== undefined) {
    const target = add(handFL, dir(weaponAng), -second)
    const dx = target.x - shBL.x
    const dy = target.y - shBL.y
    const u = BONES.upper
    const f = BONES.fore
    const d = Math.max(Math.abs(u - f) + 1, Math.min(u + f - 0.5, Math.hypot(dx, dy)))
    const base = Math.atan2(dy, dx)
    const a = Math.acos((u * u + d * d - f * f) / (2 * u * d))
    // Of the two elbow solutions, the one that hangs lower looks natural.
    const e1 = { x: shBL.x + Math.cos(base + a) * u, y: shBL.y + Math.sin(base + a) * u }
    const e2 = { x: shBL.x + Math.cos(base - a) * u, y: shBL.y + Math.sin(base - a) * u }
    elbowBL = e1.y > e2.y ? e1 : e2
    const reach = Math.hypot(dx, dy)
    handBL = reach <= u + f ? target : add(elbowBL, { x: (target.x - elbowBL.x) / Math.hypot(target.x - elbowBL.x, target.y - elbowBL.y), y: (target.y - elbowBL.y) / Math.hypot(target.x - elbowBL.x, target.y - elbowBL.y) }, f)
    upperB = Math.atan2(elbowBL.x - shBL.x, -(elbowBL.y - shBL.y)) / D
    foreB = Math.atan2(handBL.x - elbowBL.x, -(handBL.y - elbowBL.y)) / D
  }
  const H = T + p.head
  const headL = add(add(neckL, torsoTop, BONES.neck), dir(H), BONES.head * 0.78)
  const foot = (thigh: number, shin: number) => 90 + Math.max(-25, Math.min(30, (thigh + shin - 180) * 0.35))

  return {
    hip,
    neck: R(neckL),
    head: R(headL),
    headAng: H + rot,
    torsoAng: T + rot,
    shF: R(shFL),
    shB: R(shBL),
    elbowF: R(elbowFL),
    handF: R(handFL),
    elbowB: R(elbowBL),
    handB: R(handBL),
    kneeF: R(lf.knee),
    ankleF: R(lf.ankle),
    kneeB: R(lb.knee),
    ankleB: R(lb.ankle),
    footAngF: foot(p.legF, p.shinF) + rot,
    footAngB: foot(p.legB, p.shinB) + rot,
    upperFAng: upperF + rot,
    foreFAng: foreF + rot,
    upperBAng: upperB + rot,
    foreBAng: foreB + rot,
    weaponAng: weaponAng + rot,
  }
}

// --- Colour helpers ------------------------------------------------------------------------------

function hexToRgb(h: string) {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
/** Mixes `h` towards black (amt < 0) or white (amt > 0). */
export function shade(h: string, amt: number) {
  const [r, g, b] = hexToRgb(h)
  const t = amt < 0 ? 0 : 255
  const k = Math.abs(amt)
  return `rgb(${Math.round(r + (t - r) * k)},${Math.round(g + (t - g) * k)},${Math.round(b + (t - b) * k)})`
}

// --- Primitive shapes ----------------------------------------------------------------------------

function capsulePath(ctx: CanvasRenderingContext2D, a: P, b: P, ra: number, rb: number) {
  const th = Math.atan2(b.y - a.y, b.x - a.x)
  ctx.beginPath()
  ctx.arc(a.x, a.y, ra, th + Math.PI / 2, th + (3 * Math.PI) / 2)
  ctx.arc(b.x, b.y, rb, th - Math.PI / 2, th + Math.PI / 2)
  ctx.closePath()
}

function paint(ctx: CanvasRenderingContext2D, fill: string | CanvasGradient, line = LINE) {
  ctx.fillStyle = fill
  ctx.fill()
  if (line > 0) {
    ctx.lineWidth = line
    ctx.strokeStyle = OUTLINE
    ctx.stroke()
  }
}

function limb(ctx: CanvasRenderingContext2D, a: P, b: P, ra: number, rb: number, fill: string | CanvasGradient, shine = true) {
  capsulePath(ctx, a, b, ra, rb)
  paint(ctx, fill)
  if (shine) {
    // A soft highlight down the lit side gives the limb some roundness.
    const th = Math.atan2(b.y - a.y, b.x - a.x)
    const nx = Math.cos(th - Math.PI / 2)
    const ny = Math.sin(th - Math.PI / 2)
    ctx.beginPath()
    ctx.moveTo(a.x + nx * ra * 0.45 + (b.x - a.x) * 0.15, a.y + ny * ra * 0.45 + (b.y - a.y) * 0.15)
    ctx.lineTo(b.x + nx * rb * 0.45 - (b.x - a.x) * 0.15, b.y + ny * rb * 0.45 - (b.y - a.y) * 0.15)
    ctx.lineWidth = Math.max(1.5, Math.min(ra, rb) * 0.45)
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.lineCap = 'round'
    ctx.stroke()
  }
}

/** Runs `fn` in a frame placed at `o`, rotated so that local -y points along `deg`. */
function frame(ctx: CanvasRenderingContext2D, o: P, deg: number, fn: () => void) {
  ctx.save()
  ctx.translate(o.x, o.y)
  ctx.rotate(deg * D)
  fn()
  ctx.restore()
}

function metal(ctx: CanvasRenderingContext2D, m: (typeof MATERIALS)[number], x0: number, y0: number, x1: number, y1: number) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1)
  g.addColorStop(0, m.light)
  g.addColorStop(0.45, m.base)
  g.addColorStop(1, m.dark)
  return g
}

// --- The figure ----------------------------------------------------------------------------------

export type DrawOpts = {
  time: number
  /** 0..1: how hurt the fighter is, for cuts and bruises. */
  wounds?: number
  /** Extra colour glow (frenzy, spells). */
  aura?: string | null
  /** Which hand holds a potion while drinking. */
  potion?: string | null
  /** Seed for wound placement, so cuts don't jump around. */
  seed?: number
}

export function drawFighter(ctx: CanvasRenderingContext2D, kit: Kit, pose: Pose, o: DrawOpts) {
  const look = kit.look
  const kind = weaponKind(kit)
  const r = rig(pose, kind)
  const b = 0.85 + look.build * 0.35
  const skin = look.skin
  const skinBack = shade(skin, -0.2)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  if (o.aura) {
    ctx.save()
    ctx.shadowColor = o.aura
    ctx.shadowBlur = 28
  }

  const cape = kit.gear.cape
  if (cape) drawCape(ctx, r, cape.tier, o.time)

  // Back leg and back arm, a shade darker so the near side reads in front.
  drawLeg(ctx, r.hip, r.kneeB, r.ankleB, r.footAngB, skinBack, b, kit, true)
  const shield = kit.gear.shield && !twoHanded(kind) ? kit.gear.shield : null
  drawArm(ctx, r.shB, r.elbowB, r.handB, skinBack, b, kit, true)

  drawTorso(ctx, r, look, b, kit, o)
  drawLeg(ctx, r.hip, r.kneeF, r.ankleF, r.footAngF, skin, b, kit, false)
  drawSkirt(ctx, r, look, kit)
  drawHead(ctx, r, look, kit, pose.face, o.time)
  if (shield) drawShield(ctx, r.handB, r.foreBAng, shield)
  if (kit.gear.weapon) drawWeapon(ctx, r.handF, r.weaponAng, kit.gear.weapon)
  if (o.potion) drawPotion(ctx, r.handB, o.potion)
  if (twoHanded(kind)) {
    // The back hand closes over the handle.
    ctx.beginPath()
    ctx.arc(r.handB.x, r.handB.y, 6.2 * b, 0, Math.PI * 2)
    paint(ctx, skinBack)
  }
  drawArm(ctx, r.shF, r.elbowF, r.handF, skin, b, kit, false)

  if (o.aura) ctx.restore()
}

function drawLeg(ctx: CanvasRenderingContext2D, hip: P, knee: P, ankle: P, footAng: number, skin: string, b: number, kit: Kit, back: boolean) {
  limb(ctx, hip, knee, 10.5 * b, 8.5 * b, skin)
  limb(ctx, knee, ankle, 8.4 * b, 5.6 * b, skin)
  // Foot: a rounded wedge pointing forward, sole underneath.
  const feet = kit.gear.feet
  ctx.save()
  ctx.translate(ankle.x, ankle.y)
  ctx.rotate((footAng - 90) * D)
  ctx.beginPath()
  ctx.moveTo(-6, -5)
  ctx.quadraticCurveTo(-8, 4, -2, 6)
  ctx.lineTo(BONES.foot - 2, 6)
  ctx.quadraticCurveTo(BONES.foot + 3, 5, BONES.foot, 0)
  ctx.quadraticCurveTo(BONES.foot - 8, -5, 2, -6)
  ctx.closePath()
  if (feet && tierStyle(feet.tier) > 0) {
    const m = MATERIALS[feet.tier]
    paint(ctx, back ? m.dark : m.base)
    ctx.beginPath()
    ctx.moveTo(-5, 6)
    ctx.lineTo(BONES.foot - 1, 6)
    ctx.lineWidth = 3
    ctx.strokeStyle = m.trim
    ctx.stroke()
  } else {
    paint(ctx, skin)
    // Sandal: sole and straps.
    ctx.beginPath()
    ctx.moveTo(-6, 6.5)
    ctx.lineTo(BONES.foot - 1, 6.5)
    ctx.lineWidth = 3.4
    ctx.strokeStyle = '#5a381e'
    ctx.stroke()
    if (feet) {
      ctx.lineWidth = 1.8
      ctx.beginPath()
      ctx.moveTo(4, -5)
      ctx.lineTo(8, 6)
      ctx.moveTo(12, -3)
      ctx.lineTo(14, 6)
      ctx.stroke()
    }
  }
  ctx.restore()
  if (feet && tierStyle(feet.tier) === 0) {
    // Sandal laces criss-cross up the ankle.
    ctx.strokeStyle = '#5a381e'
    ctx.lineWidth = 1.6
    const up = { x: knee.x - ankle.x, y: knee.y - ankle.y }
    ctx.beginPath()
    for (let i = 0; i < 3; i++) {
      const t0 = 0.05 + i * 0.09
      const t1 = t0 + 0.07
      ctx.moveTo(ankle.x + up.x * t0 - 5 * b, ankle.y + up.y * t0)
      ctx.lineTo(ankle.x + up.x * t1 + 5 * b, ankle.y + up.y * t1)
    }
    ctx.stroke()
  } else if (feet && tierStyle(feet.tier) > 0) {
    // The boot's shaft up to mid-calf.
    const m = MATERIALS[feet.tier]
    const top = { x: ankle.x + (knee.x - ankle.x) * 0.38, y: ankle.y + (knee.y - ankle.y) * 0.38 }
    limb(ctx, ankle, top, 7 * b, 7.6 * b, back ? m.dark : m.base, false)
  }

  const legs = kit.gear.legs
  if (legs) {
    const m = MATERIALS[legs.tier]
    const a = { x: knee.x + (ankle.x - knee.x) * 0.08, y: knee.y + (ankle.y - knee.y) * 0.08 }
    const z = { x: knee.x + (ankle.x - knee.x) * 0.8, y: knee.y + (ankle.y - knee.y) * 0.8 }
    limb(ctx, a, z, 9.6 * b, 7.4 * b, back ? m.dark : metal(ctx, m, a.x + 8, a.y, a.x - 8, a.y), false)
    // Knee cop.
    ctx.beginPath()
    ctx.arc(knee.x, knee.y, 8.6 * b, 0, Math.PI * 2)
    paint(ctx, back ? m.dark : m.light)
    if (m.glow) glowLine(ctx, a, z, m.glow)
  }
}

function drawArm(ctx: CanvasRenderingContext2D, sh: P, elbow: P, hand: P, skin: string, b: number, kit: Kit, back: boolean) {
  limb(ctx, sh, elbow, 8.6 * b, 7 * b, skin)
  limb(ctx, elbow, hand, 7 * b, 5.4 * b, skin)
  const arms = kit.gear.arms
  if (arms) {
    const m = MATERIALS[arms.tier]
    const a = { x: elbow.x + (hand.x - elbow.x) * 0.18, y: elbow.y + (hand.y - elbow.y) * 0.18 }
    const z = { x: elbow.x + (hand.x - elbow.x) * 0.82, y: elbow.y + (hand.y - elbow.y) * 0.82 }
    limb(ctx, a, z, 7.8 * b, 6.6 * b, back ? m.dark : m.base, !back)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(z.x, z.y)
    ctx.strokeStyle = m.trim
    ctx.lineWidth = 1.4
    ctx.stroke()
    if (m.glow) glowLine(ctx, a, z, m.glow)
  }
  // Fist.
  ctx.beginPath()
  ctx.arc(hand.x, hand.y, 6.4 * b, 0, Math.PI * 2)
  paint(ctx, skin)

  const sh2 = kit.gear.shoulders
  if (sh2) {
    const m = MATERIALS[sh2.tier]
    const ang = Math.atan2(elbow.y - sh.y, elbow.x - sh.x)
    ctx.save()
    ctx.translate(sh.x, sh.y)
    ctx.rotate(ang - Math.PI / 2)
    // Overlapping lames, the top one biggest.
    for (let i = 2; i >= 0; i--) {
      const y = 4 + i * 7
      ctx.beginPath()
      ctx.ellipse(0, y, (12 - i * 1.2) * b, 7, 0, Math.PI, 0, true)
      ctx.closePath()
      paint(ctx, back ? m.dark : i === 0 ? metal(ctx, m, -10, 0, 10, 10) : m.base)
    }
    ctx.beginPath()
    ctx.ellipse(0, 2, 13 * b, 10, 0, Math.PI, 0)
    ctx.closePath()
    paint(ctx, back ? m.dark : metal(ctx, m, -12, -6, 12, 6))
    if (m.trim && tierStyle(sh2.tier) >= 3) {
      ctx.beginPath()
      ctx.ellipse(0, 2, 13 * b, 10, 0, Math.PI, 0)
      ctx.strokeStyle = m.trim
      ctx.lineWidth = 1.6
      ctx.stroke()
    }
    ctx.restore()
  }
}

function torsoPath(ctx: CanvasRenderingContext2D, r: Rigged, b: number, grow = 0) {
  // Built in a frame along the torso: u up the spine, v towards the chest.
  const u = dir(r.torsoAng)
  const v = dir(r.torsoAng + 90)
  const pt = (vv: number, uu: number) => ({ x: r.hip.x + u.x * uu + v.x * vv, y: r.hip.y + u.y * uu + v.y * vv })
  const w = b
  const g = grow
  const P0 = pt(-13 * w - g, -2)
  const P1 = pt(12 * w + g, -2)
  const waist = pt(14 * w + g, 22)
  const chest = pt(20 * w + g, 48)
  const shF = pt(13 * w + g, 70 + g * 0.5)
  const nk = pt(4, 76)
  const nkB = pt(-8, 75)
  const shB = pt(-17 * w - g, 66)
  const back = pt(-16 * w - g, 40)
  ctx.beginPath()
  ctx.moveTo(P0.x, P0.y)
  ctx.lineTo(P1.x, P1.y)
  ctx.quadraticCurveTo(waist.x, waist.y, pt(15 * w + g, 32).x, pt(15 * w + g, 32).y)
  ctx.quadraticCurveTo(chest.x, chest.y, shF.x, shF.y)
  ctx.quadraticCurveTo(nk.x, nk.y, nkB.x, nkB.y)
  ctx.quadraticCurveTo(shB.x, shB.y, back.x, back.y)
  ctx.closePath()
  return pt
}

function drawTorso(ctx: CanvasRenderingContext2D, r: Rigged, look: Look, b: number, kit: Kit, o: DrawOpts) {
  const pt = torsoPath(ctx, r, b)
  paint(ctx, look.skin)
  // Muscle lines on a bare chest.
  ctx.strokeStyle = shade(look.skin, -0.3)
  ctx.lineWidth = 1.5
  const line = (pts: [number, number][]) => {
    ctx.beginPath()
    pts.forEach(([v, u], i) => {
      const p = pt(v, u)
      if (i) ctx.lineTo(p.x, p.y)
      else ctx.moveTo(p.x, p.y)
    })
    ctx.stroke()
  }
  line([[17 * b, 44], [10 * b, 40], [3 * b, 44]])
  line([[12 * b, 30], [8 * b, 30]])
  line([[12 * b, 22], [8 * b, 22]])
  line([[11 * b, 14], [8 * b, 14]])

  // Cuts and bruises as the fight goes badly.
  const wounds = o.wounds ?? 0
  if (wounds > 0.2) {
    const seed = o.seed ?? 1
    const n = Math.min(4, Math.floor(wounds * 5))
    ctx.strokeStyle = 'rgba(170,20,24,0.85)'
    ctx.lineWidth = 2
    for (let i = 0; i < n; i++) {
      const s = Math.sin(seed * 31 + i * 17)
      const vv = (s * 0.5 + 0.2) * 14 * b
      const uu = 14 + ((Math.sin(seed * 7 + i * 5) + 1) / 2) * 46
      const a = pt(vv - 4, uu - 3)
      const z = pt(vv + 4, uu + 4)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(z.x, z.y)
      ctx.stroke()
    }
  }

  const body = kit.gear.body
  if (body) {
    const m = MATERIALS[body.tier]
    torsoPath(ctx, r, b, 2.5)
    ctx.save()
    ctx.clip()
    // Cover the chest, not the belly band, so the belt and skirt still show.
    const top = pt(0, 80)
    const lo = pt(0, 4)
    ctx.fillStyle = metal(ctx, m, pt(20, 60).x, pt(20, 60).y, pt(-16, 20).x, pt(-16, 20).y)
    ctx.fillRect(Math.min(top.x, lo.x) - 60, Math.min(top.y, lo.y) - 60, 120 + Math.abs(top.x - lo.x), 120 + Math.abs(top.y - lo.y))
    ctx.strokeStyle = m.dark
    ctx.lineWidth = 1.6
    const style = tierStyle(body.tier)
    if (style === 0) {
      // Stitched leather.
      ctx.setLineDash([3, 3])
      line([[14 * b, 64], [16 * b, 30], [10 * b, 8]])
      line([[-12 * b, 62], [-13 * b, 10]])
      ctx.setLineDash([])
    } else if (style === 2 || style === 3 || style === 5) {
      // Segmented plates.
      for (let u = 14; u < 64; u += 10) line([[-20 * b, u], [22 * b, u + 2]])
      ctx.strokeStyle = m.trim
      line([[-2, 74], [-2, 6]])
    } else {
      // Sculpted muscle cuirass.
      ctx.strokeStyle = m.dark
      line([[18 * b, 46], [10 * b, 40], [2 * b, 45]])
      line([[13 * b, 30], [6 * b, 29]])
      line([[13 * b, 20], [6 * b, 19]])
      ctx.strokeStyle = m.light
      line([[16 * b, 56], [8 * b, 60]])
    }
    if (isHalfTier(body.tier)) halfTierPattern(ctx, style, m, pt, b)
    if (m.glow) {
      ctx.strokeStyle = m.glow
      ctx.shadowColor = m.glow
      ctx.shadowBlur = 8
      ctx.lineWidth = 2
      line([[6, 54], [10, 44], [4, 36], [9, 26]])
      ctx.shadowBlur = 0
    }
    ctx.restore()
    torsoPath(ctx, r, b, 2.5)
    ctx.lineWidth = LINE
    ctx.strokeStyle = OUTLINE
    ctx.stroke()
    // Trim along the neckline and hem.
    ctx.strokeStyle = m.trim
    ctx.lineWidth = 2.2
    line([[13 * b, 70], [4, 76], [-8, 75], [-17 * b, 66]])
    line([[-14 * b, 6], [13 * b, 6]])
  }
}

function drawSkirt(ctx: CanvasRenderingContext2D, r: Rigged, look: Look, kit: Kit) {
  const u = dir(r.torsoAng)
  const v = dir(r.torsoAng + 90)
  const pt = (vv: number, uu: number) => ({ x: r.hip.x + u.x * uu + v.x * vv, y: r.hip.y + u.y * uu + v.y * vv })
  // A short tunic skirt, flared at the hem and following the front thigh a little.
  const thighDir = Math.atan2(r.kneeF.x - r.hip.x, -(r.kneeF.y - r.hip.y)) / D
  const flare = Math.max(-10, Math.min(18, (thighDir - 180 - r.torsoAng + 180) * 0.25))
  const a = pt(-15, 10)
  const b2 = pt(15, 10)
  const c = pt(17 + flare, -26)
  const d = pt(-18, -26)
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b2.x, b2.y)
  ctx.lineTo(c.x, c.y)
  const mid = pt(0, -30)
  ctx.quadraticCurveTo(mid.x, mid.y, d.x, d.y)
  ctx.closePath()
  paint(ctx, look.tunic)
  // Folds.
  ctx.strokeStyle = shade(look.tunic, -0.3)
  ctx.lineWidth = 1.4
  for (const vv of [-7, 2, 10]) {
    const s = pt(vv, 4)
    const e = pt(vv * 1.15, -24)
    ctx.beginPath()
    ctx.moveTo(s.x, s.y)
    ctx.lineTo(e.x, e.y)
    ctx.stroke()
  }
  // Pteruges: leather strips hanging below a cuirass.
  const body = kit.gear.body
  if (body && tierStyle(body.tier) > 0) {
    const m = MATERIALS[body.tier]
    for (let i = 0; i < 6; i++) {
      const vv = -14 + i * 6
      const s = pt(vv, 6)
      const e = pt(vv * 1.1 + (i > 3 ? flare * 0.5 : 0), -20)
      limb(ctx, s, e, 3, 3, i % 2 ? '#6e4424' : '#8a5a34', false)
      ctx.beginPath()
      ctx.arc(e.x, e.y, 1.6, 0, Math.PI * 2)
      ctx.fillStyle = m.base
      ctx.fill()
    }
  }
  // Belt.
  const l = pt(-15, 10)
  const rr = pt(15, 10)
  ctx.beginPath()
  ctx.moveTo(l.x, l.y)
  ctx.lineTo(rr.x, rr.y)
  ctx.lineWidth = 6
  ctx.strokeStyle = OUTLINE
  ctx.stroke()
  ctx.lineWidth = 3.6
  ctx.strokeStyle = body ? MATERIALS[body.tier].trim : '#5a381e'
  ctx.stroke()
}

function drawHead(ctx: CanvasRenderingContext2D, r: Rigged, look: Look, kit: Kit, face: Face, time: number) {
  // Neck.
  limb(ctx, r.neck, add(r.head, dir(r.headAng + 160), 10), 7.2, 6.8, look.skin, false)
  const helm = kit.gear.head
  const long = look.hair === 'long' || look.hair === 'ponytail'
  frame(ctx, r.head, r.headAng, () => {
    const hair = look.hairColour
    // Long hair and ponytails hang behind the head, even under a helmet.
    if (long) {
      const sway = Math.sin(time / 300) * 3
      ctx.beginPath()
      if (look.hair === 'long') {
        ctx.moveTo(-6, -20)
        ctx.quadraticCurveTo(-28, -10, -26 + sway, 30)
        ctx.lineTo(-12 + sway, 34)
        ctx.quadraticCurveTo(-8, 10, 2, 0)
      } else {
        ctx.moveTo(-18, -8)
        ctx.quadraticCurveTo(-36, -4, -34 + sway, 24)
        ctx.quadraticCurveTo(-30 + sway, 30, -26 + sway, 22)
        ctx.quadraticCurveTo(-26, 4, -14, -2)
      }
      ctx.closePath()
      paint(ctx, hair)
    }
    headPath(ctx)
    paint(ctx, look.skin)
    // Ear.
    ctx.beginPath()
    ctx.ellipse(-3, 3, 4.2, 6, 0.2, 0, Math.PI * 2)
    paint(ctx, shade(look.skin, -0.1), 1.6)
    drawFace(ctx, face, look)
    drawBeard(ctx, look)
    if (!helm) drawHair(ctx, look)
    else drawHelmet(ctx, helm.tier, time)
  })
}

function headPath(ctx: CanvasRenderingContext2D) {
  ctx.beginPath()
  ctx.moveTo(-4, -22)
  ctx.bezierCurveTo(8, -25, 20, -18, 20, -6)
  ctx.lineTo(21, -2)
  ctx.quadraticCurveTo(27, 3, 21, 6)
  ctx.lineTo(21, 10)
  ctx.quadraticCurveTo(22, 13, 19, 15)
  ctx.quadraticCurveTo(19, 21, 12, 22)
  ctx.quadraticCurveTo(2, 23, -4, 17)
  ctx.quadraticCurveTo(-14, 16, -18, 8)
  ctx.bezierCurveTo(-24, 0, -22, -18, -4, -22)
  ctx.closePath()
}

function drawFace(ctx: CanvasRenderingContext2D, face: Face, look: Look) {
  const dark = '#1a0f0a'
  ctx.lineCap = 'round'
  // Eye.
  if (face === 'ko') {
    ctx.strokeStyle = dark
    ctx.lineWidth = 1.8
    ctx.beginPath()
    ctx.moveTo(7, -6)
    ctx.lineTo(13, 0)
    ctx.moveTo(13, -6)
    ctx.lineTo(7, 0)
    ctx.stroke()
  } else if (face === 'hurt') {
    ctx.strokeStyle = dark
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(7, -4)
    ctx.lineTo(14, -2)
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.ellipse(11, -3, 4, 3.2, 0, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = dark
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(12.6, -3, 1.8, 0, Math.PI * 2)
    ctx.fillStyle = dark
    ctx.fill()
  }
  // Brow.
  ctx.strokeStyle = shade(look.hairColour, -0.2)
  ctx.lineWidth = 2.6
  ctx.beginPath()
  const angry = face === 'grit' || face === 'shout'
  ctx.moveTo(5, angry ? -11 : -9)
  ctx.lineTo(16, angry ? -6 : -8.5)
  ctx.stroke()
  // Mouth.
  ctx.strokeStyle = dark
  ctx.lineWidth = 1.6
  ctx.beginPath()
  if (face === 'shout') {
    ctx.ellipse(17, 11, 3.6, 4.2, 0, 0, Math.PI * 2)
    ctx.fillStyle = '#5a1010'
    ctx.fill()
    ctx.stroke()
  } else if (face === 'grit') {
    ctx.rect(13, 9, 7, 3.6)
    ctx.fillStyle = '#f4efe6'
    ctx.fill()
    ctx.stroke()
  } else if (face === 'smile') {
    ctx.moveTo(13, 9)
    ctx.quadraticCurveTo(17, 13, 20.5, 8.5)
    ctx.stroke()
  } else if (face === 'hurt' || face === 'ko') {
    ctx.moveTo(13, 12)
    ctx.quadraticCurveTo(15, 9, 17, 12)
    ctx.quadraticCurveTo(19, 14, 20.5, 11)
    ctx.stroke()
  } else {
    ctx.moveTo(14, 11)
    ctx.lineTo(20.5, 10.5)
    ctx.stroke()
  }
}

function drawBeard(ctx: CanvasRenderingContext2D, look: Look) {
  const c = look.hairColour
  if (look.beard === 'none') return
  if (look.beard === 'stubble') {
    ctx.beginPath()
    ctx.moveTo(-2, 6)
    ctx.quadraticCurveTo(4, 14, 12, 14)
    ctx.lineTo(20, 14)
    ctx.quadraticCurveTo(19, 21, 12, 22)
    ctx.quadraticCurveTo(2, 23, -4, 17)
    ctx.closePath()
    ctx.fillStyle = c
    ctx.globalAlpha = 0.35
    ctx.fill()
    ctx.globalAlpha = 1
    return
  }
  ctx.beginPath()
  if (look.beard === 'goatee') {
    ctx.moveTo(12, 14)
    ctx.lineTo(20, 14)
    ctx.quadraticCurveTo(22, 24, 15, 27)
    ctx.quadraticCurveTo(10, 24, 12, 14)
  } else {
    ctx.moveTo(-3, 2)
    ctx.quadraticCurveTo(2, 12, 12, 13.5)
    ctx.lineTo(21, 13.5)
    ctx.quadraticCurveTo(24, 26, 14, 29)
    ctx.quadraticCurveTo(0, 30, -5, 16)
    ctx.closePath()
  }
  paint(ctx, c, 2)
  if (look.beard === 'braided') {
    for (let i = 0; i < 3; i++) {
      ctx.beginPath()
      ctx.ellipse(14 - i * 1, 31 + i * 6, 3.2, 3.6, 0, 0, Math.PI * 2)
      paint(ctx, c, 1.6)
    }
  }
  // Moustache.
  ctx.beginPath()
  ctx.moveTo(14, 8)
  ctx.quadraticCurveTo(20, 6, 22, 9)
  ctx.quadraticCurveTo(18, 11, 13, 11)
  ctx.closePath()
  paint(ctx, c, 1.4)
}

function drawHair(ctx: CanvasRenderingContext2D, look: Look) {
  const c = look.hairColour
  switch (look.hair) {
    case 'bald':
      ctx.beginPath()
      ctx.ellipse(2, -16, 7, 3, -0.2, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.fill()
      return
    case 'mohawk':
      ctx.beginPath()
      ctx.moveTo(16, -14)
      for (let i = 0; i < 6; i++) {
        const a = -30 - i * 28
        const x = Math.cos(a * D) * 22
        const y = Math.sin(a * D) * 22
        const x2 = Math.cos((a - 14) * D) * 34
        const y2 = Math.sin((a - 14) * D) * 34
        ctx.lineTo(x2, y2)
        ctx.lineTo(x, y)
      }
      ctx.lineTo(-20, 2)
      ctx.quadraticCurveTo(-4, -16, 16, -14)
      ctx.closePath()
      paint(ctx, c, 2)
      return
    case 'curly':
      for (const [x, y, rr] of [[14, -18, 6], [6, -23, 7], [-4, -24, 7], [-13, -19, 7], [-19, -10, 6.5], [-20, 0, 6], [-16, 8, 5]] as const) {
        ctx.beginPath()
        ctx.arc(x, y, rr, 0, Math.PI * 2)
        paint(ctx, c, 2)
      }
      return
    default: {
      // Short cap of hair, also the base for long hair and ponytails.
      ctx.beginPath()
      ctx.moveTo(19, -10)
      ctx.bezierCurveTo(18, -26, -12, -30, -21, -10)
      ctx.bezierCurveTo(-24, 0, -20, 8, -16, 10)
      ctx.quadraticCurveTo(-10, 4, -8, -6)
      ctx.quadraticCurveTo(4, -12, 19, -10)
      ctx.closePath()
      paint(ctx, c, 2)
      ctx.strokeStyle = shade(c, 0.25)
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(10, -18)
      ctx.quadraticCurveTo(0, -22, -10, -16)
      ctx.stroke()
      if (look.hair === 'ponytail') {
        ctx.beginPath()
        ctx.arc(-18, -6, 4, 0, Math.PI * 2)
        paint(ctx, '#5a381e', 1.6)
      }
    }
  }
}

function drawHelmet(ctx: CanvasRenderingContext2D, t: number, time: number) {
  const m = MATERIALS[t]
  const tier = tierStyle(t)
  const fill = metal(ctx, m, 10, -26, -10, 10)
  // Crests and plumes first, so the dome overlaps their base.
  if (tier === 1 || tier === 3) {
    ctx.beginPath()
    ctx.moveTo(14, -22)
    ctx.quadraticCurveTo(4, -44, -22, -32)
    ctx.quadraticCurveTo(-30, -24, -26, -12)
    ctx.quadraticCurveTo(-10, -26, 14, -22)
    paint(ctx, tier === 1 ? '#b8342a' : '#2f5a8a', 2)
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'
    ctx.lineWidth = 1
    for (let i = 0; i < 5; i++) {
      ctx.beginPath()
      ctx.moveTo(10 - i * 7, -26 - (i < 3 ? 6 : 2))
      ctx.lineTo(6 - i * 7, -32 + i)
      ctx.stroke()
    }
  } else if (tier === 4) {
    const sway = Math.sin(time / 260) * 2
    for (let i = 0; i < 3; i++) {
      ctx.beginPath()
      ctx.moveTo(-4 + i * 4, -22)
      ctx.quadraticCurveTo(-16 + i * 6 + sway, -50, -30 + i * 8 + sway, -46 + i * 3)
      ctx.quadraticCurveTo(-18 + i * 6, -34, -6 + i * 4, -22)
      paint(ctx, i === 1 ? '#f4f1e6' : '#b0263a', 1.6)
    }
  } else if (tier === 5) {
    // Centurion's transverse crest, seen end-on as a fan.
    ctx.beginPath()
    ctx.moveTo(-12, -22)
    ctx.quadraticCurveTo(-2, -48, 10, -22)
    ctx.closePath()
    paint(ctx, '#6a2a8a', 2)
  }

  ctx.beginPath()
  if (tier === 0) {
    ctx.moveTo(19, -8)
    ctx.bezierCurveTo(18, -27, -14, -30, -22, -8)
    ctx.lineTo(-22, 4)
    ctx.lineTo(-14, 4)
    ctx.quadraticCurveTo(0, -8, 19, -8)
  } else {
    // Dome with brow ridge, cheek guard and neck guard.
    ctx.moveTo(22, -6)
    ctx.bezierCurveTo(22, -30, -16, -32, -23, -8)
    ctx.lineTo(-26, 8)
    ctx.lineTo(-14, 10)
    ctx.lineTo(-6, 2)
    ctx.lineTo(0, 2)
    ctx.lineTo(2, 18)
    ctx.lineTo(10, 18)
    ctx.lineTo(9, 2)
    ctx.quadraticCurveTo(14, -6, 22, -6)
  }
  ctx.closePath()
  paint(ctx, fill)
  ctx.strokeStyle = m.trim
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(21, -7)
  ctx.quadraticCurveTo(0, -10, -22, -4)
  ctx.stroke()
  if (tier >= 2) {
    // Rivets.
    ctx.fillStyle = m.light
    for (const [x, y] of [[-14, -14], [-4, -20], [8, -18]]) {
      ctx.beginPath()
      ctx.arc(x, y, 1.6, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  if (isHalfTier(t)) {
    // A half tier: a row of studs along the brow.
    ctx.fillStyle = m.trim
    for (let x = -18; x <= 18; x += 6) {
      ctx.beginPath()
      ctx.arc(x, -8 - Math.abs(x) * 0.06, 1.4, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  if (tier === 6) {
    // Wings.
    const flap = Math.sin(time / 400) * 4
    for (const s of [0, 1]) {
      ctx.beginPath()
      ctx.moveTo(-10, -14)
      ctx.quadraticCurveTo(-30, -36 - flap - s * 6, -44, -30 - flap - s * 4)
      ctx.quadraticCurveTo(-34, -24, -40, -18 - s * 2)
      ctx.quadraticCurveTo(-26, -16, -14, -8)
      ctx.closePath()
      paint(ctx, s ? '#e8f8ff' : '#bfe8f7', 1.6)
    }
    glowLine(ctx, { x: 18, y: -8 }, { x: -18, y: -6 }, m.glow!)
  }
}

function glowLine(ctx: CanvasRenderingContext2D, a: P, b: P, c: string) {
  ctx.save()
  ctx.strokeStyle = c
  ctx.shadowColor = c
  ctx.shadowBlur = 10
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
  ctx.restore()
}

function drawCape(ctx: CanvasRenderingContext2D, r: Rigged, tier: number, time: number) {
  const c = CAPE_COLOURS[tier]
  const u = dir(r.torsoAng)
  const v = dir(r.torsoAng + 90)
  const pt = (vv: number, uu: number) => ({ x: r.hip.x + u.x * uu + v.x * vv, y: r.hip.y + u.y * uu + v.y * vv })
  const w1 = Math.sin(time / 380) * 6
  const w2 = Math.sin(time / 300 + 1) * 5
  const top1 = pt(4, 74)
  const top2 = pt(-16, 68)
  const bot1 = pt(-30 + w1, -58)
  const bot2 = pt(-58 + w2, -52)
  ctx.beginPath()
  ctx.moveTo(top1.x, top1.y)
  ctx.quadraticCurveTo(pt(-10, 10).x, pt(-10, 10).y, bot1.x, bot1.y)
  const mid = pt(-44 + (w1 + w2) / 2, -62)
  ctx.quadraticCurveTo(mid.x, mid.y, bot2.x, bot2.y)
  ctx.quadraticCurveTo(pt(-40, 20).x, pt(-40, 20).y, top2.x, top2.y)
  ctx.closePath()
  const g = ctx.createLinearGradient(top1.x, top1.y, bot2.x, bot2.y)
  g.addColorStop(0, shade(c, -0.25))
  g.addColorStop(1, c)
  paint(ctx, g)
  if (tier === MATERIALS.length - 1) {
    // Stars on the cloak of stars.
    ctx.fillStyle = '#6fd8ff'
    for (let i = 0; i < 6; i++) {
      const p = pt(-12 - (i % 3) * 12 + w1 * 0.3, 50 - i * 18)
      ctx.beginPath()
      ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

export function drawShield(ctx: CanvasRenderingContext2D, hand: P, foreAng: number, it: Item) {
  const m = MATERIALS[it.tier]
  ctx.save()
  ctx.translate(hand.x + 2, hand.y)
  ctx.rotate(Math.max(-0.4, Math.min(0.4, (foreAng - 90) * D * 0.25)))
  // Face-on, squashed sideways to suggest it is angled towards the opponent.
  ctx.scale(0.62, 1)
  const st = tierStyle(it.tier)
  const faces = ['#8a5a34', '#a8342a', '#8a2a22', '#2f4f8a', '#e2b53e', '#4a2a5a', '#2f5f74']
  // Half tiers: the same shield in a deeper shade.
  const face = isHalfTier(it.tier) ? shade(faces[st], -0.22) : faces[st]
  ctx.beginPath()
  const shape = it.shape ?? 'parma'
  if (shape === 'buckler') ctx.arc(0, 0, 17, 0, Math.PI * 2)
  else if (shape === 'parma') ctx.arc(0, 0, 26, 0, Math.PI * 2)
  else if (shape === 'aspis') ctx.arc(0, 0, 33, 0, Math.PI * 2)
  else ctx.roundRect(-22, -38, 44, 76, 10)
  paint(ctx, face, LINE * 1.3)
  // Rim.
  ctx.lineWidth = 4
  ctx.strokeStyle = m.base
  ctx.stroke()
  ctx.lineWidth = 1.2
  ctx.strokeStyle = OUTLINE
  ctx.stroke()
  // Emblem: wings for the scutum, a star for round shields.
  ctx.fillStyle = st >= 4 ? m.trim : m.light
  if (shape === 'scutum') {
    for (const s of [-1, 1]) {
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.quadraticCurveTo(s * 16, -18, s * 18, -30)
      ctx.quadraticCurveTo(s * 10, -16, s * 4, -6)
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.quadraticCurveTo(s * 16, 18, s * 18, 30)
      ctx.quadraticCurveTo(s * 10, 16, s * 4, 6)
      ctx.fill()
    }
  } else if (shape !== 'buckler') {
    const rr = shape === 'aspis' ? 24 : 18
    ctx.beginPath()
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2
      const k = i % 2 ? rr * 0.45 : rr
      ctx.lineTo(Math.cos(a) * k, Math.sin(a) * k)
    }
    ctx.closePath()
    ctx.globalAlpha = 0.8
    ctx.fill()
    ctx.globalAlpha = 1
  }
  // Boss.
  ctx.beginPath()
  ctx.arc(0, 0, shape === 'buckler' ? 6 : 8, 0, Math.PI * 2)
  paint(ctx, metal(ctx, m, -6, -6, 6, 6), 1.6)
  if (m.glow) {
    ctx.shadowColor = m.glow
    ctx.shadowBlur = 14
    ctx.strokeStyle = m.glow
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(0, 0, 14, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

function mixHex(a: string, b: string) {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  return `rgb(${x.map((v, i) => Math.round((v + y[i]) / 2)).join(',')})`
}
const mixMetal = (a: (typeof WEAPON_METAL)[number], b: (typeof WEAPON_METAL)[number]) => ({ base: mixHex(a.base, b.base), light: mixHex(a.light, b.light), dark: mixHex(a.dark, b.dark) })

/**
 * What sets a half tier apart on the chest: studs on leather, overlapping scales on bronze, rings
 * of mail on iron, bluing bands on steel, chased lines on gold, a trimmed border on imperial.
 */
function halfTierPattern(ctx: CanvasRenderingContext2D, style: number, m: (typeof MATERIALS)[number], pt: (v: number, u: number) => P, b: number) {
  ctx.save()
  if (style === 0 || style === 5) {
    ctx.fillStyle = m.trim
    for (let u = 16; u <= 64; u += 12)
      for (let v = -12; v <= 16; v += 9) {
        const p = pt(v * b, u + (v % 2 ? 4 : 0))
        ctx.beginPath()
        ctx.arc(p.x, p.y, 1.7, 0, Math.PI * 2)
        ctx.fill()
      }
  } else if (style === 1 || style === 2) {
    // Scales (bronze) or rings (iron): little arcs in staggered rows.
    ctx.strokeStyle = style === 1 ? m.dark : m.light
    ctx.lineWidth = 1.1
    for (let u = 12; u <= 70; u += 6)
      for (let v = -16; v <= 20; v += 6) {
        const p = pt((v + (u % 12 ? 3 : 0)) * b, u)
        ctx.beginPath()
        if (style === 1) ctx.arc(p.x, p.y, 3, 0.1 * Math.PI, 0.9 * Math.PI)
        else ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2)
        ctx.stroke()
      }
  } else {
    // Bands of bluing or engraving across the plates.
    ctx.strokeStyle = m.trim
    ctx.lineWidth = 1.6
    for (let u = 20; u <= 60; u += 20) {
      const a = pt(-18 * b, u)
      const z = pt(20 * b, u + 3)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.quadraticCurveTo((a.x + z.x) / 2, (a.y + z.y) / 2 - 3, z.x, z.y)
      ctx.stroke()
    }
  }
  ctx.restore()
}

const GEM_COLOURS = ['#8fd8ff', '#ff8a3a', '#7aff9a', '#b48cff', '#ffe07a', '#ff5ad0', '#6fd8ff']

const WEAPON_METAL = [
  { base: '#9a7048', light: '#c09468', dark: '#6a4a2c' },
  { base: '#c0803a', light: '#efc07a', dark: '#7e4e1e' },
  { base: '#8a929b', light: '#c3c9cf', dark: '#555b62' },
  { base: '#c6d0da', light: '#ffffff', dark: '#7f8a96' },
  { base: '#7d8fa3', light: '#d4e0ee', dark: '#3f4b58' },
  { base: '#3a3442', light: '#8a7fa0', dark: '#1d1924' },
  { base: '#5fb8d8', light: '#e8fbff', dark: '#22566e' },
]

/** Draws a weapon held at `hand`, the blade pointing along `ang` (degrees, 0 = up). */
export function drawWeapon(ctx: CanvasRenderingContext2D, hand: P, ang: number, it: Item) {
  const kind = it.weapon!
  const st = tierStyle(it.tier)
  // Half tiers sit between two metals.
  const mt = isHalfTier(it.tier) ? mixMetal(WEAPON_METAL[st], WEAPON_METAL[st + 1]) : WEAPON_METAL[st]
  const wood = '#6e4424'
  const gold = '#e2b53e'
  ctx.save()
  ctx.translate(hand.x, hand.y)
  ctx.rotate(ang * D)
  const blade = (x0: number, y0: number, len: number, w: number, point = true) => {
    ctx.beginPath()
    ctx.moveTo(x0 - w / 2, y0)
    ctx.lineTo(x0 - w / 2, y0 - len + (point ? w : 0))
    if (point) ctx.lineTo(x0, y0 - len)
    ctx.lineTo(x0 + w / 2, y0 - len + (point ? w : 0))
    ctx.lineTo(x0 + w / 2, y0)
    ctx.closePath()
    const g = ctx.createLinearGradient(x0 - w / 2, 0, x0 + w / 2, 0)
    g.addColorStop(0, mt.light)
    g.addColorStop(0.5, mt.base)
    g.addColorStop(1, mt.dark)
    paint(ctx, g, 2)
    ctx.beginPath()
    ctx.moveTo(x0, y0 - 2)
    ctx.lineTo(x0, y0 - len + w + 2)
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 1
    ctx.stroke()
  }
  const haft = (y0: number, y1: number, w = 4.4) => {
    ctx.beginPath()
    ctx.roundRect(-w / 2, y1, w, y0 - y1, w / 2)
    paint(ctx, st === 5 ? '#2a2430' : wood, 2)
  }
  const guard = (y: number, w: number) => {
    ctx.beginPath()
    ctx.roundRect(-w / 2, y - 3, w, 6, 3)
    paint(ctx, st >= 4 ? gold : mt.dark, 2)
  }
  // A casting gem in the tier's colour, glowing softly.
  const gem = (x: number, y: number, r: number) => {
    const c = GEM_COLOURS[st]
    ctx.save()
    ctx.shadowColor = c
    ctx.shadowBlur = 12
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r)
    g.addColorStop(0, '#ffffff')
    g.addColorStop(0.35, c)
    g.addColorStop(1, shade(c, -0.45))
    paint(ctx, g, 1.6)
    ctx.restore()
  }
  const pommel = (y: number) => {
    ctx.beginPath()
    ctx.arc(0, y, 3.8, 0, Math.PI * 2)
    paint(ctx, st >= 4 ? gold : mt.dark, 1.8)
  }
  switch (kind) {
    case 'dagger':
      haft(10, -6, 5)
      pommel(11)
      guard(-6, 12)
      blade(0, -8, 30, 6)
      break
    case 'gladius':
      haft(11, -6, 5.4)
      pommel(12)
      guard(-7, 16)
      blade(0, -9, 52, 8)
      break
    case 'greatsword':
      haft(30, -6, 5.4)
      pommel(31)
      guard(-8, 30)
      blade(0, -10, 94, 11)
      break
    case 'axe':
      haft(16, -64)
      ctx.beginPath()
      ctx.moveTo(2, -62)
      ctx.quadraticCurveTo(14, -70, 22, -78)
      ctx.quadraticCurveTo(30, -62, 22, -44)
      ctx.quadraticCurveTo(14, -50, 2, -48)
      ctx.closePath()
      paint(ctx, metal(ctx, MATERIALS[it.tier], 2, -70, 26, -48), 2)
      ctx.beginPath()
      ctx.moveTo(-2, -60)
      ctx.lineTo(-10, -56)
      ctx.lineTo(-2, -52)
      paint(ctx, mt.dark, 1.6)
      break
    case 'mace':
      haft(14, -46)
      ctx.beginPath()
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2
        const k = i % 2 ? 9 : 13
        ctx.lineTo(Math.cos(a) * k, -54 + Math.sin(a) * k)
      }
      ctx.closePath()
      paint(ctx, metal(ctx, MATERIALS[it.tier], -10, -64, 10, -44), 2)
      break
    case 'warhammer':
      haft(26, -66, 5)
      ctx.beginPath()
      ctx.roundRect(-8, -84, 30, 20, 3)
      paint(ctx, metal(ctx, MATERIALS[it.tier], -8, -84, 22, -64), 2.2)
      ctx.beginPath()
      ctx.moveTo(-8, -80)
      ctx.lineTo(-22, -74)
      ctx.lineTo(-8, -68)
      paint(ctx, mt.dark, 1.8)
      break
    case 'spear':
      haft(56, -104, 4)
      ctx.beginPath()
      ctx.moveTo(0, -132)
      ctx.quadraticCurveTo(8, -118, 3.5, -104)
      ctx.lineTo(-3.5, -104)
      ctx.quadraticCurveTo(-8, -118, 0, -132)
      paint(ctx, metal(ctx, MATERIALS[it.tier], -6, -130, 6, -104), 2)
      break
    case 'trident':
      haft(50, -92, 4)
      ctx.beginPath()
      ctx.roundRect(-12, -96, 24, 5, 2)
      paint(ctx, mt.dark, 1.8)
      for (const x of [-10, 0, 10]) {
        ctx.beginPath()
        ctx.moveTo(x - 2, -94)
        ctx.lineTo(x - 2, -116 - (x === 0 ? 8 : 0))
        ctx.lineTo(x, -124 - (x === 0 ? 8 : 0))
        ctx.lineTo(x + 2, -116 - (x === 0 ? 8 : 0))
        ctx.lineTo(x + 2, -94)
        ctx.closePath()
        paint(ctx, mt.base, 1.6)
      }
      break
    case 'staff': {
      // A long shaft with claws holding a glowing gem.
      haft(42, -98, 4.6)
      ctx.beginPath()
      ctx.roundRect(-4, -100, 8, 6, 2)
      paint(ctx, mt.base, 1.6)
      for (const s of [-1, 1]) {
        ctx.beginPath()
        ctx.moveTo(s * 2, -100)
        ctx.quadraticCurveTo(s * 13, -108, s * 6, -122)
        ctx.lineWidth = 5
        ctx.strokeStyle = OUTLINE
        ctx.stroke()
        ctx.lineWidth = 3
        ctx.strokeStyle = mt.base
        ctx.stroke()
      }
      gem(0, -111, 7.5)
      break
    }
    case 'wand':
      // A slim rod tipped with a small gem.
      ctx.beginPath()
      ctx.moveTo(-2.2, 10)
      ctx.lineTo(-1.4, -34)
      ctx.lineTo(1.4, -34)
      ctx.lineTo(2.2, 10)
      ctx.closePath()
      paint(ctx, st === 5 ? '#2a2430' : '#5a3a20', 1.8)
      ctx.beginPath()
      ctx.roundRect(-3, -2, 6, 8, 2)
      paint(ctx, mt.base, 1.4)
      gem(0, -38, 4.6)
      break
    case 'scepter':
      // A short rod with a flanged metal head around a gem: half mace, half sceptre.
      haft(13, -40, 4.4)
      ctx.beginPath()
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2
        const k = i % 2 ? 7 : 11
        ctx.lineTo(Math.cos(a) * k, -48 + Math.sin(a) * k)
      }
      ctx.closePath()
      paint(ctx, metal(ctx, MATERIALS[it.tier], -10, -58, 10, -38), 2)
      gem(0, -48, 5)
      break
  }
  if (st === 6) {
    ctx.shadowColor = '#6fd8ff'
    ctx.shadowBlur = 16
    ctx.strokeStyle = 'rgba(140,230,255,0.7)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(0, -10)
    ctx.lineTo(0, kind === 'spear' ? -128 : kind === 'trident' ? -118 : kind === 'greatsword' ? -100 : -50)
    ctx.stroke()
  }
  ctx.restore()
}

function drawPotion(ctx: CanvasRenderingContext2D, hand: P, colour: string) {
  ctx.save()
  ctx.translate(hand.x + 4, hand.y - 8)
  ctx.beginPath()
  ctx.roundRect(-5, -10, 10, 16, 4)
  paint(ctx, colour, 2)
  ctx.beginPath()
  ctx.rect(-2.5, -15, 5, 6)
  paint(ctx, '#d8c8a8', 1.6)
  ctx.restore()
}

/** Where the weapon's business end is, for sparks and spell origins. */
export function tipOf(kit: Kit, pose: Pose): P {
  const r = rig(pose, weaponKind(kit))
  const len = { dagger: 34, gladius: 56, axe: 70, mace: 54, spear: 128, trident: 118, greatsword: 96, warhammer: 76, staff: 111, wand: 38, scepter: 48 }[weaponKind(kit) ?? 'dagger'] ?? 10
  return add(r.handF, dir(r.weaponAng), kit.gear.weapon ? len : 4)
}

export { rig as rigFor }
export type { P as Point }
