import { memberModel } from '../models/ground.ts'
import { drawHull } from '../models/paint.ts'
import type { HullState, Model } from '../models/types.ts'
import type { Unit } from '../sim.ts'
import { memberPos, squadReach } from './squad.ts'

// How squads and walkers look on the battle screen (groundKit's squad, ring, pose, fell and bodies):
// a squad's members, each its member model where it stands in the sim (ground/squad.ts), turned the
// way it faces, stepping through its own walk cycle as it goes, with a shadow and a rim in its side's
// colour at its feet; a walker's legs the same way; and the members that fell, lying where they
// fell and fading. All on screen only: how far each has walked is kept here, from where it was drawn
// last.

/** A squad is drawn at least this many CSS pixels across, however far out the view is: its members
 * grow and spread with it, as a far-off vehicle keeps a size (render.ts GROUND_MIN_PX). */
const SQUAD_MIN_PX = 24
/** Seconds a fallen member lies before it starts fading, and how long the fading takes. */
const LIE = 4
const FADE = 2
/** Below this speed (world units a second) a unit stands, in its rest pose. */
const STILL = 4

/** How far each unit has walked, from where it was drawn: a unit's step follows its own pace. */
const walked = new Map<number, { x: number; y: number; d: number; at: number }>()
function odometer(u: Unit, clock: number) {
  let o = walked.get(u.id)
  if (!o) walked.set(u.id, (o = { x: u.x, y: u.y, d: 0, at: clock }))
  o.d += Math.hypot(u.x - o.x, u.y - o.y)
  o.x = u.x
  o.y = u.y
  o.at = clock
  if (walked.size > 4000) for (const [id, q] of walked) if (clock - q.at > 5) walked.delete(id)
  return o.d
}

/** The pose a walking model is in after walking `d` world units in strides of `stride`, `off` steps
 * out of step with the others; its rest pose standing. */
function poseAt(m: Model, moving: boolean, d: number, stride: number, off: number) {
  const walk = m.walk
  if (!walk || !moving) return 0
  return walk[(Math.floor(d / stride) + off) % walk.length]
}

/** A walker's pose now (a vehicle whose model walks). */
export function walkerPose(u: Unit, m: Model, clock: number) {
  return poseAt(m, u.v > STILL, odometer(u, clock), u.t.size * 0.32, 0)
}

type Body = { x: number; y: number; rot: number; m: Model; size: number; at: number }
const bodies: Body[] = []
/** Where each squad's members stood when last drawn, by their number, to see one fall. */
const seen = new Map<number, Map<number, { x: number; y: number; a: number }>>()
/** How far each member has walked (by squad and member), and when it last moved: each steps at its
 * own pace, out of step with the others. */
const steps = new Map<string, { x: number; y: number; d: number; moved: number }>()

const FALLEN: HullState = { detached: 0, scorch: 3, variant: 0, pose: 0 }

/** Squad `u`'s members where they stand, each with a small shadow and a rim in `rim` (the side's
 * colour) at its feet; `alpha` see-through; `zdpr` device pixels per world unit. */
export function drawSquad(ctx: CanvasRenderingContext2D, u: Unit, z: number, zdpr: number, alpha: number, clock: number, rim: string) {
  const sq = u.t.ground!.squad!
  const m = memberModel(sq.member)
  if (!m || !u.crew) return
  // Far out, the squad spreads and its members grow, so it stays readable.
  const k = Math.max(1, SQUAD_MIN_PX / (u.t.size * z))
  const size = sq.size * k
  const was = seen.get(u.id)
  const now = new Map<number, { x: number; y: number; a: number }>()
  for (const q of u.crew) {
    const p = memberPos(u, q, k)
    now.set(q.k, { x: p.x, y: p.y, a: q.a })
  }
  // Members gone since the last frame fell where they stood.
  if (was) for (const [key, p] of was) if (!now.has(key)) bodies.push({ x: p.x, y: p.y, rot: p.a + Math.PI / 2 + (key % 2 ? 0.6 : -0.5), m, size, at: clock })
  seen.set(u.id, now)
  // Shadows and rims at their feet.
  ctx.save()
  ctx.globalAlpha *= alpha
  ctx.fillStyle = 'rgba(8, 10, 14, 0.35)'
  ctx.beginPath()
  for (const p of now.values()) {
    ctx.moveTo(p.x + size * 0.42, p.y + 1.5 / z)
    ctx.ellipse(p.x, p.y + 1.5 / z, size * 0.42, size * 0.36, 0, 0, Math.PI * 2)
  }
  ctx.fill()
  ctx.strokeStyle = rim
  ctx.globalAlpha *= 0.55
  ctx.lineWidth = Math.max(1 / z, 1)
  ctx.beginPath()
  for (const p of now.values()) {
    ctx.moveTo(p.x + size * 0.46, p.y)
    ctx.ellipse(p.x, p.y, size * 0.46, size * 0.4, 0, 0, Math.PI * 2)
  }
  ctx.stroke()
  ctx.restore()
  for (const q of u.crew) {
    const p = now.get(q.k)!
    // Each its own walk: by how far it has gone, standing once it stops.
    const key = `${u.id}:${q.k}`
    let st = steps.get(key)
    if (!st) steps.set(key, (st = { x: q.x, y: q.y, d: q.k * sq.size * 0.3, moved: -1 }))
    const dd = Math.hypot(q.x - st.x, q.y - st.y)
    if (dd > 0.05) st.moved = clock
    st.d += dd
    st.x = q.x
    st.y = q.y
    const moving = clock - st.moved < 0.2
    const pose = poseAt(m, moving, st.d, sq.size * 0.55, 0)
    // Standing, a little sway each, so they don't stand like posts.
    const rot = q.a + Math.PI / 2 + (moving ? 0 : Math.sin(clock * 0.9 + q.k * 1.7) * 0.1)
    drawHull(ctx, m, p.x, p.y, rot, size, zdpr, { detached: 0, scorch: 0, variant: 0, pose }, { alpha })
  }
  if (steps.size > 4000) steps.clear()
}

/** How far squad `u` reaches from its middle as drawn (world units), for its selection ring. */
export function squadRing(u: Unit, z: number) {
  const sq = u.t.ground!.squad!
  const k = Math.max(1, SQUAD_MIN_PX / (u.t.size * z))
  return squadReach(u) * k + sq.size * k * 0.5
}

/** Squad `u` is destroyed: its last members fall where they stood. */
export function squadFell(u: Unit, clock: number) {
  const sq = u.t.ground?.squad
  const m = sq && memberModel(sq.member)
  if (!sq || !m) return
  for (const q of u.crew ?? []) bodies.push({ x: q.x, y: q.y, rot: q.a + Math.PI / 2 + (q.k % 2 ? 0.6 : -0.5), m, size: sq.size, at: clock })
  seen.delete(u.id)
}

/** The fallen members, under the units: a puff of dust as each drops, then the body, dark, fading. */
export function drawBodies(ctx: CanvasRenderingContext2D, zdpr: number, clock: number, box: { x0: number; y0: number; x1: number; y1: number }) {
  let gone = 0
  for (const b of bodies) {
    const age = clock - b.at
    if (age > LIE + FADE || age < 0) {
      gone++
      continue
    }
    if (b.x < box.x0 - 20 || b.x > box.x1 + 20 || b.y < box.y0 - 20 || b.y > box.y1 + 20) continue
    const alpha = age < LIE ? 1 : 1 - (age - LIE) / FADE
    drawHull(ctx, b.m, b.x, b.y, b.rot, b.size * 0.95, zdpr, FALLEN, { wreck: true, alpha: alpha * 0.85 })
    if (age < 0.4) {
      const t = age / 0.4
      ctx.strokeStyle = `rgba(214,196,168,${0.6 * (1 - t)})`
      ctx.lineWidth = b.size * 0.18
      ctx.beginPath()
      ctx.arc(b.x, b.y, b.size * (0.3 + t * 0.8), 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  if (gone > 32) {
    const keep = bodies.filter((b) => clock - b.at <= LIE + FADE && clock >= b.at)
    bodies.length = 0
    bodies.push(...keep)
  }
}
