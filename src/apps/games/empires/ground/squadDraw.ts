import { memberModel } from '../models/ground.ts'
import { drawHull } from '../models/paint.ts'
import type { HullState, Model } from '../models/types.ts'
import type { Unit } from '../sim.ts'
import { memberAt, membersLeft } from './squad.ts'

// How squads and walkers look on the battle screen (groundKit's squad, pose, fell and bodies): a
// squad's members, each its member model at its place in the formation, turned to where the squad
// faces (to its target while it fights), stepping through their walk poses as the squad goes; a
// walker's legs the same way; and the members that fell, lying where they fell and fading. All on
// screen only: how far a unit has walked is kept here, from where it was drawn last.

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
/** How many members each squad had when last drawn, to see one fall. */
const standing = new Map<number, number>()

const FALLEN: HullState = { detached: 0, scorch: 3, variant: 0, pose: 0 }

/** Squad `u`'s members, `alpha` see-through; `zdpr` device pixels per world unit. */
export function drawSquad(ctx: CanvasRenderingContext2D, u: Unit, z: number, zdpr: number, alpha: number, clock: number) {
  const sq = u.t.ground!.squad!
  const m = memberModel(sq.member)
  if (!m) return
  const k = Math.max(1, SQUAD_MIN_PX / (u.t.size * z))
  const size = sq.size * k
  const left = membersLeft(u)
  const d = odometer(u, clock)
  const moving = u.v > STILL
  // Turned to its target while it fights, else the way it goes.
  const g = u.guns.find((q) => q.target)
  const face = (g ? g.aim : u.a) + Math.PI / 2
  const was = standing.get(u.id) ?? left
  for (let i = left; i < was; i++) {
    const p = memberAt(u, i, k)
    bodies.push({ x: p.x, y: p.y, rot: face + (i % 2 ? 0.6 : -0.5), m, size, at: clock })
  }
  standing.set(u.id, left)
  for (let i = 0; i < left; i++) {
    const p = memberAt(u, i, k)
    // A little sway each, so they don't stand like posts.
    const rot = face + (moving ? 0 : Math.sin(clock * 0.9 + i * 1.7) * 0.12)
    const st: HullState = { detached: 0, scorch: 0, variant: 0, pose: poseAt(m, moving, d, sq.size * 0.55, i) }
    drawHull(ctx, m, p.x, p.y, rot, size, zdpr, st, { alpha })
  }
}

/** Squad `u` is destroyed: its last members fall where they stood. */
export function squadFell(u: Unit, clock: number) {
  const sq = u.t.ground?.squad
  const m = sq && memberModel(sq.member)
  if (!sq || !m) return
  for (let i = 0; i < membersLeft(u); i++) {
    const p = memberAt(u, i)
    bodies.push({ x: p.x, y: p.y, rot: u.a + Math.PI / 2 + (i % 2 ? 0.6 : -0.5), m, size: sq.size, at: clock })
  }
  standing.delete(u.id)
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
