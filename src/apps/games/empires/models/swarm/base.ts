import { CYARD_SOCKETS, YARD_SOCKETS, type ModuleId } from '../../data.ts'
import { at, type Expansion } from '../expansions.ts'
import { along, circle, part, sym } from '../kit.ts'
import type { ModelDef } from '../spec.ts'
import type { Detail, Part, Pt, Tone } from '../types.ts'
import { band, blade, blobby, core, glands, plate, sparks, tendril } from './craft.ts'

// The Swarm's structures: the Hive Nexus (its Command Station, grown through four stages), the
// Feeding Node on the ore, the three defense nodes, the Brood Nursery (its Frigate Yard), the
// Leviathan Spawning Pit (its Capital Yard), and the expansion modules that grow onto the Hive and
// the yards (`expansion`, placed by models/expansions.ts). Everything is a living growth: chitin
// plates over dark purple chitin and tissue, violet cores, acid-green glands and pools, tendrils.

const D = Math.PI / 180
/** A point at angle `a` (0 = right, clockwise on screen), `r` out from (cx, cy). */
const polar = (a: number, r: number, cx = 0, cy = 0): Pt => [cx + Math.cos(a) * r, cy + Math.sin(a) * r]

/**
 * A petal of chitin round a middle: the band between radii r0 and r1, `half` either side of angle
 * `a`, its outer edge swelling to a point (a claw tip) at `tip`.
 */
function petal(a: number, half: number, r0: number, r1: number, tip: number, n = 8): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const aa = a - half + half * 2 * t
    const swell = 1 - Math.pow(Math.abs(t - 0.5) * 2, 2) * 0.12
    out.push(polar(aa, r1 * swell))
  }
  out.splice(Math.floor(n / 2) + 1, 0, polar(a, tip))
  for (let i = n; i >= 0; i--) out.push(polar(a - half + (half * 2 * i) / n, r0))
  return out
}

/** A limb of the Hive: a tapering band from `a` to `b` by way of `mid`, plated in chitin, with dark
 * joints and green glands along it. */
function hiveLimb(id: string, pts: Pt[], w0: number, w1: number, tone: Tone, z: number, more: Partial<Part> = {}): Part {
  const joints = pts.slice(1, -1).map((p): Detail => ({ k: 'shape', pts: circle(p[0], p[1], Math.max(w0, w1) * 0.32, 10), tone: 'dark' }))
  return part(id, band(pts, w0, w1, 5), tone, z, { lift: 5, details: [...joints, glands(pts.slice(1).map(([x, y]) => [x * 0.98, y * 0.98] as Pt), Math.max(3, w1 * 0.09))], ...more })
}

// --- Hive Nexus ------------------------------------------------------------------------------------

/**
 * The Hive Nexus: a living orbital organism that grows through four stages, its modules on the
 * spots data/swarm.ts gives them (frame pixels from the frame's centre, where every stage is centred).
 *
 *   1 Hive Seed: a small unshielded nucleus, its violet core in a cup of six chitin petals.
 *   2 Brood Nest: limbs grow out to the sides, a stem up and down, and production sacs on the lower
 *     diagonals (brood chambers, the hangars).
 *   3 Hive Cluster: an armoured brood structure: a ring of chitin armour round the nucleus, the limbs
 *     run out to their gun knuckles, a spine up to the forward battery, the second sac grown.
 *   4 Hive Nexus: the mature fortified organism, towering spine array up and down, horns crowning it,
 *     lower limbs to the outer batteries and a fringe of tendrils, spawning broods of its own.
 *
 * Each research module (sensory stalk, digestive organ, regeneration pool) grows where it stands.
 */
export const station: ModelDef = ({ level }) => {
  const parts: Part[] = []
  const tip = (a: number, r: number, w: number, z: number, id: string, tone: Tone = 'hull') => part(id, band([polar(a, r - w * 0.6), polar(a + 2 * D, r + w * 0.8), polar(a - 1 * D, r + w * 1.6)], w, w * 0.15, 3), tone, z, { lift: 3, slope: [Math.cos(a) * 0.4, Math.sin(a) * 0.4] })

  // --- Level 4: the towering spine array, lower limbs and the fringe of tendrils -------------------
  if (level >= 4) {
    for (const s of [-1, 1]) {
      const side = s < 0 ? 'L' : 'R'
      // Tendrils fringing the organism.
      for (const [k, [a, b, c2]] of ([
        [[200, 330], [300, 470], [270, 560]],
        [[330, 120], [460, 300], [500, 470]],
        [[120, 360], [170, 470], [130, 560]],
        [[380, -40], [500, -120], [520, -260]],
      ] as [Pt, Pt, Pt][]).entries())
        parts.push(tendril(`fringe${side}${k}`, [[s * a[0], a[1]], [s * b[0], b[1]], [s * c2[0], c2[1]]], 34, 0.5))
      // Lower limbs out to the outer batteries, and the hind limbs to the stern pair.
      parts.push(hiveLimb(`lowLimb${side}`, [[s * 220, 120], [s * 360, 150], [s * 470, 190]], 120, 84, 'hull2', 1.5, { slope: [s * 0.4, 0.2] }))
      parts.push(hiveLimb(`hindLimb${side}`, [[s * 150, 280], [s * 210, 360], [s * 260, 430]], 110, 84, 'hull2', 1.5, { slope: [s * 0.3, 0.4] }))
      parts.push(part(`lowKnuckle${side}`, circle(s * 470, 190, 64, 22), 'hull', 1.8, { lift: 5, sphere: true }))
      parts.push(part(`hindKnuckle${side}`, circle(s * 260, 430, 62, 22), 'hull', 1.8, { lift: 5, sphere: true }))
      // Horns crowning the upper flanks, where the forward acid batteries sit.
      parts.push(plate(`crownHorn${side}`, band([[s * 150, -250], [s * 230, -400], [s * 210, -530]], 110, 16, 4), 'hull', 1.6, [s * 0.4, -0.3], { lift: 5 }))
    }
    // The spine array: up to a great crowning spike, down to the tail.
    parts.push(plate('spineUp', [[0, -574], [40, -470], [64, -330], [60, -250], [-60, -250], [-64, -330], [-40, -470]], 'hull', 1.7, [0, -0.4], {
      lift: 5,
      facets: [{ pts: [[0, -574], [0, -250], [-60, -250], [-64, -330], [-40, -470]], slope: [-0.5, 0] }],
      details: [...[-500, -440, -380, -320].map((y): Detail => ({ k: 'line', pts: [[-50 + (y + 500) * -0.08, y], [50 - (y + 500) * -0.08, y]] })), sparks(along([0, -520], [0, -300], 4), 7)],
    }))
    parts.push(plate('spineDown', [[0, 572], [44, 480], [66, 360], [62, 300], [-62, 300], [-66, 360], [-44, 480]], 'hull2', 1.7, [0, 0.4], {
      lift: 5,
      facets: [{ pts: [[0, 572], [0, 300], [-62, 300], [-66, 360], [-44, 480]], slope: [-0.5, 0] }],
      details: [...[340, 400, 460, 520].map((y): Detail => ({ k: 'line', pts: [[-60, y], [60, y]] })), glands(along([0, 340], [0, 520], 4), 7)],
    }))
  }

  // --- Level 3: armoured brood structure -------------------------------------------------------------
  if (level >= 3) {
    for (const s of [-1, 1]) {
      const side = s < 0 ? 'L' : 'R'
      // The side limbs run out to their gun knuckles.
      parts.push(hiveLimb(`armOut${side}`, [[s * 280, -90], [s * 340, -140], [s * 400, -170]], 120, 100, 'hull', 2.2, { slope: [s * 0.4, -0.2] }))
      parts.push(part(`knuckle${side}`, circle(s * 400, -170, 70, 22), 'hull2', 2.4, { lift: 6, sphere: true, details: [{ k: 'shape', pts: circle(s * 400, -170, 56, 18), tone: 'accent' }] }))
      parts.push(tip(s < 0 ? 200 * D : -20 * D, 455, 40, 2.3, `armSpike${side}`))
    }
    // The spine up to the forward battery.
    parts.push(plate('spineMid', blobby([[0, -460], [56, -400], [70, -300], [52, -200], [-52, -200], [-70, -300], [-56, -400]], 3), 'hull2', 2.2, [0, -0.4], {
      lift: 5,
      details: [{ k: 'line', pts: [[-56, -330], [56, -330]] }, { k: 'line', pts: [[-50, -260], [50, -260]] }, glands([[-40, -290], [40, -290]], 6)],
    }))
    // A ring of chitin armour round the nucleus, in eight plates.
    for (let i = 0; i < 8; i++) {
      const a = -90 * D + i * 45 * D + 22.5 * D
      parts.push(plate(`armour${i}`, petal(a, 19 * D, 170, 250, 268, 6), i % 2 ? 'hull' : 'hull2', 4.2, [Math.cos(a) * 0.45, Math.sin(a) * 0.45], {
        lift: 5,
        details: [{ k: 'line', pts: [polar(a - 12 * D, 214), polar(a + 12 * D, 214)] }, glands([polar(a, 236)], 5)],
      }))
    }
  }

  // --- Level 2: brood nest ----------------------------------------------------------------------------
  if (level >= 2) {
    // Tissue web that ties the limbs to the nucleus.
    parts.push(part('web', blobby([[0, -230], [150, -150], [235, -95], [225, 40], [190, 190], [0, 240], [-190, 190], [-225, 40], [-235, -95], [-150, -150]], 4), 'dark', 2, { lift: 2 }))
    for (const s of [-1, 1]) {
      const side = s < 0 ? 'L' : 'R'
      // The side limbs, out to the level-2 guns.
      parts.push(hiveLimb(`arm${side}`, [[s * 120, -20], [s * 190, -60], [s * 260, -72]], 130, 108, 'hull', 2.6, { slope: [s * 0.4, -0.2] }))
      parts.push(part(`armPad${side}`, circle(s * 250, -70, 62, 20), 'hull2', 2.8, { lift: 5, sphere: true }))
      // The production sacs on the lower diagonals: a pod of chitin round a brood sac, the left one
      // a brood chamber from level 2, the right one grown into one at level 3.
      parts.push(hiveLimb(`sacStem${side}`, [[s * 80, 120], [s * 150, 170], [s * 200, 200]], 90, 80, 'hull2', 2.4, { slope: [s * 0.3, 0.3] }))
      parts.push(part(`sacPod${side}`, circle(s * 205, 205, 82, 22), 'hull', 2.7, {
        lift: 6,
        facets: [{ pts: circle(s * 205, 205, 82, 22).filter(([x]) => x * s >= 205), slope: [s * 0.4, 0.2] }],
        details: [{ k: 'shape', pts: circle(s * 205, 205, 66, 20), tone: 'metal' }, ...(level < 3 && s > 0 ? [{ k: 'shape' as const, pts: circle(205, 205, 40, 14), tone: 'glow' as const }] : [])],
      }))
    }
    // A stem up and down: the regeneration pool's stalk below, a feeler above.
    parts.push(hiveLimb('stemDown', [[0, 140], [0, 200], [0, 290]], 120, 100, 'hull2', 2.5, { slope: [0, 0.4] }))
    parts.push(hiveLimb('stemUp', [[0, -150], [0, -220], [6, -300]], 90, 30, 'hull', 2.5, { slope: [0, -0.4] }))
  }

  // --- Level 1: the Hive Seed, a nucleus in a cup of chitin petals -----------------------------------
  parts.push(part('flesh', circle(0, 0, 176, 36), 'dark', 5, { lift: 3, details: [glands(Array.from({ length: 6 }, (_, i) => polar(-60 * D + i * 60 * D, 158)), 5)] }))
  for (let i = 0; i < 6; i++) {
    const a = -90 * D + i * 60 * D
    parts.push(plate(`petal${i}`, petal(a, 24 * D, 92, 178, level >= 2 ? 190 : 205, 8), i % 2 ? 'hull2' : 'hull', 6, [Math.cos(a) * 0.45, Math.sin(a) * 0.45], {
      lift: 4,
      details: [{ k: 'line', pts: [polar(a - 16 * D, 140), polar(a, 132), polar(a + 16 * D, 140)] }, { k: 'shape', pts: petal(a, 6 * D, 112, 160, 166, 4), tone: 'accent' }],
    }))
  }
  parts.push(part('nucleus', circle(0, 0, 96, 32), 'metal', 6.5, { lift: 4, details: [{ k: 'shape', pts: circle(0, 0, 84, 30), tone: 'aid' }] }))
  parts.push(part('core', circle(0, 0, 72, 32), 'glow', 7, {
    glow: true,
    details: [
      { k: 'shape', pts: circle(-12, -14, 44, 24), tone: 'glass' },
      { k: 'shape', pts: circle(16, 18, 14, 10), tone: 'glass' },
      { k: 'lights', pts: [[-16, -20]], r: 10, tone: 'glass' },
    ],
  }))
  return { parts, breakStyle: 'pie' }
}

// --- Structures on the ore ---------------------------------------------------------------------------

/** Root tendrils holding a structure to its asteroid, one to each corner. */
function roots(x0: number, y0: number, k: Pt, f: Pt, w: number, z: number): Part[] {
  const out: Part[] = []
  for (const [sx, sy, n] of [[1, 1, 0], [-1, 1, 1], [1, -1, 2], [-1, -1, 3]] as const) {
    const m = (p: Pt): Pt => [p[0] * sx, p[1] * sy]
    out.push(part(`root${n}`, band([m([x0, y0]), m(k), m(f)], w, w * 0.3, 3), 'metal', z, { lift: 1, details: [{ k: 'shape', pts: circle(m(k)[0], m(k)[1], w * 0.36, 8), tone: 'dark' }] }))
  }
  return out
}

/**
 * Feeding Node: a digestive body sunk into the ore on four root tendrils, a feeding maw on a fleshy
 * pod either side (the drill hardpoints), the digestive sac in the middle (the silo), a violet core
 * up front and the acid sprayer on a knob behind.
 */
export const mine: ModelDef = ({ h }) => {
  const y = (g: number) => (g / 10 - 0.5) * h
  const wy = y(5.1)
  const parts: Part[] = [
    ...roots(-10, -14, [-28, -34], [-46, -42], 7, 0),
    ...sym(part('bridge', band([[-12, wy], [-22, wy - 3], [-30, wy]], 12, 11), 'metal', 1, { lift: 1.2 })),
    ...sym(part('pod', circle(-32, wy, 19, 22), 'hull2', 2, { lift: 2.2, facets: [{ pts: circle(-32, wy, 19, 22).filter(([x]) => x <= -32), slope: [-0.35, 0] }], details: [glands([[-32, wy - 17], [-48, wy]], 1.1)] })),
    part('body', blobby([[0, -36], [-16, -26], [-22, -4], [-18, 20], [0, 32], [18, 20], [22, -4], [16, -26]], 3), 'hull2', 2, {
      lift: 2.6,
      facets: [{ pts: [[0, -36], [-16, -26], [-22, -4], [-18, 20], [0, 32]], slope: [-0.4, 0] }],
    }),
    ...sym(plate('shell', blobby([[-3, -30], [-14, -22], [-18, -6], [-12, -10], [-3, -14]], 3), 'hull', 2.4, [-0.4, -0.3])),
    ...sym(plate('shellLow', blobby([[-3, 14], [-15, 10], [-16, 20], [-6, 28], [-3, 26]], 3), 'hull', 2.4, [-0.4, 0.3])),
    ...core('eye', 0, y(1.7), 4.2, 4.2, 2.6, false),
    part('knob', circle(0, y(8), 8.6, 16), 'metal', 2.6, { lift: 1.2 }),
  ]
  return { parts, breakStyle: 'pie' }
}

/**
 * The defense nodes (Guardian Node, Spore Battery, Spine Battery share one deck): a lobed rim of six
 * chitin plates on root tendrils, ribs from a domed hub out to the corner cradles, nodes on its sides.
 * The Spore Battery carries clusters of acid-green spore sacs between its sprayers; the Spine Battery
 * long violet spines either side of its great lance; the Guardian Node a sensory stalk.
 */
export const defense: ModelDef = ({ t, h }) => {
  const kind = t.id.endsWith('flak') ? 'flak' : t.id.endsWith('gun') ? 'gun' : 'balanced'
  const y = (g: number) => (g / 10 - 0.5) * h
  // The corner cradles that carry a weapon node (the gun deck leaves its forward pair bare, the
  // guardian its hind pair).
  const used = (p: Pt) => t.hardpoints.some((hp) => Math.hypot((hp.x / 10 - 0.5) * 100 - p[0], y(hp.y) - p[1]) < 3)
  const corners: Pt[] = ([[-24, y(2.9)], [24, y(2.9)], [-24, y(7.2)], [24, y(7.2)]] as Pt[]).filter(used)
  const parts: Part[] = [
    ...roots(-26, -30, [-40, -38], [-47, -47], 8, 0),
    part('rim', blobby(Array.from({ length: 12 }, (_, i) => polar((i / 12) * Math.PI * 2, i % 2 ? 41 : 46)), 3), 'metal', 1, { lift: 2.2, holes: [circle(0, 0, 34, 24)] }),
    ...Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2
      return plate(`plate${i}`, petal(a, 24 * D, 35, 45, 49, 6), i % 2 ? 'hull2' : 'hull', 1.4, [Math.cos(a) * 0.4, Math.sin(a) * 0.4], { lift: 2.4, details: [glands([polar(a, 41)], 0.9)] })
    }),
    part('floor', circle(0, 0, 36, 24), 'dark', 1.2),
    ...corners.map(([x, cy], i) => part(`rib${i}`, band([[x * 0.2, cy * 0.2], [x * 0.7, cy * 0.7], [x, cy]], 7, 5, 3), 'hull2', 1.6, { lift: 1.4 })),
    ...corners.map(([x, cy], i) => part(`cradle${i}`, circle(x, cy, 11, 18), 'hull', 2, { lift: 2.6, facets: [{ pts: circle(x, cy, 11, 18).filter(([px]) => px <= x), slope: [-0.4, 0] }] })),
    ...sym(part('side', circle(-41, 0, 7.6, 16), 'hull2', 2.6, { lift: 2.4, details: [glands([[-45, 0]], 1)] })),
    part('hub', circle(0, 0, 19, 26), 'hull', 2.2, { lift: 3, facets: [{ pts: circle(0, 0, 19, 26).filter(([, py]) => py >= 0), slope: [0, 0.4] }], details: [{ k: 'shape', pts: circle(0, 0, 15, 22), tone: 'metal' }] }),
  ]
  if (kind === 'flak') {
    parts.push(...core('core', 0, 0, 7, 7, 2.6))
    for (const [x, cy] of corners) parts.push(part(`spores${x}${cy}`, blobby([[x * 0.4, cy * 0.4 - 5], [x * 0.55 - 4, cy * 0.5], [x * 0.4, cy * 0.4 + 5], [x * 0.3 + 3, cy * 0.45]], 3), 'aid', 2.4, { sphere: true }))
  }
  if (kind === 'gun')
    for (const s of [-1, 1]) parts.push(part(`spike${s < 0 ? 'T' : 'B'}`, band([[0, s * 18], [s * 2, s * 30], [0, s * 42]], 6, 1.4, 3), 'glass', 2.4, { lift: 1.6, details: [sparks([[0, s * 28]], 1)] }))
  if (kind === 'balanced') parts.push(part('stalk', band([[0, 18], [-3, 30], [0, 40]], 4, 2, 3), 'metal', 2.4, { lift: 1.6, detach: { hull: 0.5 }, details: [sparks([[0, 40]], 1.6)] }))
  return { parts, breakStyle: 'pie' }
}

// --- Yards -------------------------------------------------------------------------------------------

/** A birthing pool: the dark bed a ship grows in, `hw` half-wide from y0 (the mouth) to y1, acid-
 * green fluid glowing down its middle and glands along its edges. */
function pool(id: string, hw: number, y0: number, y1: number, z: number): Part {
  const n = Math.max(4, Math.round((y1 - y0) / 11))
  return part(id, blobby([[-hw, y0 + 4], [-hw * 0.6, y0], [hw * 0.6, y0], [hw, y0 + 4], [hw, y1 - 4], [hw * 0.7, y1], [-hw * 0.7, y1], [-hw, y1 - 4]], 2), 'dark', z, {
    details: [
      { k: 'shape', pts: blobby([[-hw * 0.4, y0 + 6], [hw * 0.4, y0 + 6], [hw * 0.5, (y0 + y1) / 2], [hw * 0.4, y1 - 6], [-hw * 0.4, y1 - 6], [-hw * 0.5, (y0 + y1) / 2]], 3), tone: 'metal' },
      glands(along([0, y0 + 6], [0, y1 - 6], n + 1), 0.9),
      sparks([...along([-hw + 1.6, y0 + 5], [-hw + 1.6, y1 - 5], n), ...along([hw - 1.6, y0 + 5], [hw - 1.6, y1 - 5], n)], 0.5),
    ],
  })
}

/** A brood rib arching over a pool at `y`, out to x1 either side: a pale chitin band, lit on one side
 * and in shadow on the other, a knot of tissue where it meets each wall. */
function rib(id: string, y: number, wd: number, x1: number, z: number): Part[] {
  const pts: Pt[] = [[-x1, y + wd * 0.2], [-x1 * 0.5, y - wd * 0.5], [0, y - wd * 0.7], [x1 * 0.5, y - wd * 0.5], [x1, y + wd * 0.2]]
  return [
    part(id, band(pts, wd, wd * 0.8, 3), 'hull', z, { lift: 3, facets: [{ pts: band(pts.slice(0, 3), wd, wd * 0.9, 3), slope: [-0.5, 0] }] }),
    ...[-1, 1].map((s) => part(`${id}${s < 0 ? 'L' : 'R'}`, circle(s * x1, y + wd * 0.2, wd * 0.9, 12), 'metal', z + 0.1, { lift: 3.2, details: [glands([[s * x1, y + wd * 0.2]], wd * 0.2)] })),
  ]
}

/** A bud where an expansion module grows: a ring of chitin round a dark pit with green glands. */
function bud(id: string, [x, y]: Pt, r: number, z: number): Part {
  return part(id, circle(x, y, r, 18), 'hull2', z, {
    lift: 1.2,
    details: [{ k: 'shape', pts: circle(x, y, r * 0.7, 16), tone: 'dark' }, glands([[x, y - r * 0.55], [x + r * 0.55, y], [x, y + r * 0.55], [x - r * 0.55, y]], r * 0.1)],
  })
}

/** A yard's chitin wall down one side (the left), from `y0` at the bow horn to `y1`, `x0` to `x1`. */
function wall(id: string, x0: number, x1: number, y0: number, y1: number, z: number): Part {
  const pts: Pt[] = [[x1, y0 + 6], [x0 + 3, y0 + 2], [x0, y0 + 10], [x0 - 1, (y0 + y1) / 2], [x0, y1 - 4], [x1, y1]]
  return plate(id, blobby(pts, 3), 'hull', z, [-0.5, 0], {
    lift: 3,
    details: [...along([0, y0 + 14], [0, y1 - 8], 4).map(([, yy]): Detail => ({ k: 'line', pts: [[x0 + 1, yy], [x1 - 1, yy + 3]] })), glands(along([(x0 + x1) / 2, y0 + 18], [(x0 + x1) / 2, y1 - 10], 4), 0.8)],
  })
}

/**
 * Brood Nursery: a birthing pool cupped between two chitin walls, three brood ribs arched over it (the
 * brood cord, the yard's hardpoint, over the middle), hooked bow horns at its mouth carrying the acid
 * sprayers, and a womb at the stern: a swollen sac round a violet core, its buds for expansions.
 */
export const yard: ModelDef = (c) => {
  const [sL, , sS] = YARD_SOCKETS.swarm.map((g) => at(g, c.w, c.h))
  const pd = at([1.7, 1.6], c.w, c.h)
  const parts: Part[] = [
    pool('bed', 17, -46, 28, 0.4),
    ...sym(tendril('root', [[-24, 30], [-30, 40], [-32, 50]], 4), { detach: { hull: 0.4 } }),
    ...sym(wall('wall', -31, -17, -42, 30, 1.2)),
    ...[-24, -4, 16].flatMap((y0, j) => sym(blade(`spur${j}`, [[-29, y0], [-33, y0 + 8], [-34, y0 + 18]], 6, 'hull2', 1.1, [-0.45, 0.1], {}, false))),
    ...sym(plate('horn', band([[-24, -36], [pd[0] - 2, pd[1] - 6], [-16, -50]], 9, 2, 3), 'hull2', 2, [-0.4, -0.3], { lift: 2.6 })),
    ...sym(part('hornPad', circle(pd[0], pd[1], 5.4, 16), 'metal', 2.2, { lift: 2.6 })),
    ...rib('ribF', -25, 4.4, 26, 3.4),
    ...rib('ribM', -2, 6, 27, 3.5),
    ...rib('ribA', 20, 4.4, 26, 3.4),
    part('womb', blobby([[0, 26], [-26, 30], [-30, 40], [-20, 49], [0, 50], [20, 49], [30, 40], [26, 30]], 3), 'hull2', 2, {
      lift: 3,
      facets: [{ pts: [[0, 26], [-26, 30], [-30, 40], [-20, 49], [0, 50]], slope: [-0.4, 0.2] }],
      details: [{ k: 'line', pts: [[-24, 36], [0, 33], [24, 36]] }, glands([[-22, 44], [22, 44]], 1)],
    }),
    ...core('core', 0, 39, 6, 5, 3),
    bud('budL', sL, 5, 3.6),
    bud('budR', [-sL[0], sL[1]], 5, 3.6),
    bud('budS', sS, 4.4, 3.8),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Leviathan Spawning Pit: the Swarm's great birthing trench. A long pool between heavy chitin walls,
 * four brood ribs over it (the second the brood cord), tendril lances on armoured knuckles at the bow
 * horns, acid sprayers at the stern corners, and at the stern a great womb round a violet core,
 * crowned with a spike.
 */
export const capitalYard: ModelDef = (c) => {
  const [sL] = CYARD_SOCKETS.swarm.map((g) => at(g, c.w, c.h))
  const tl = at([1.75, 1.35], c.w, c.h)
  const pd = at([1.9, 9.1], c.w, c.h)
  const parts: Part[] = [
    pool('bed', 19, -47, 34, 0.4),
    ...sym(tendril('root', [[-30, 38], [-34, 46], [-36, 53]], 4), { detach: { hull: 0.4 } }),
    ...sym(wall('wall', -36, -19, -42, 36, 1.2)),
    ...[-26, -6, 14].flatMap((y0, j) => sym(blade(`spur${j}`, [[-34, y0], [-38, y0 + 8], [-39, y0 + 19]], 6.4, 'hull2', 1.1, [-0.45, 0.1], {}, false))),
    ...sym(plate('horn', band([[-28, -32], [tl[0], tl[1] - 4], [-20, -51]], 11, 2, 3), 'hull2', 2, [-0.4, -0.3], { lift: 2.6 })),
    ...sym(part('knuckle', circle(tl[0], tl[1], 6.6, 18), 'hull', 2.2, { lift: 2.8, sphere: true })),
    ...rib('ribF', -26, 4.6, 30, 3.4),
    ...rib('ribM', -6, 6.4, 31, 3.5),
    ...rib('ribA', 14, 4.6, 30, 3.4),
    ...rib('ribS', 28, 4.2, 30, 3.4),
    part('womb', blobby([[0, 32], [-30, 35], [-35, 43], [-26, 50], [0, 51], [26, 50], [35, 43], [30, 35]], 3), 'hull2', 2, {
      lift: 3,
      facets: [{ pts: [[0, 32], [-30, 35], [-35, 43], [-26, 50], [0, 51]], slope: [-0.4, 0.2] }],
      details: [{ k: 'line', pts: [[-28, 40], [0, 37], [28, 40]] }, glands([[-14, 47], [14, 47]], 1)],
    }),
    ...sym(part('sternPad', circle(pd[0], pd[1], 4.6, 16), 'metal', 2.4, { lift: 2.4 })),
    ...core('core', 0, 43, 6.4, 4.6, 3),
    part('spike', band([[0, -42], [0, -48], [0, -52]], 3, 0.8, 2), 'hull', 4.2, { detach: { hull: 0.6 } }),
    bud('budL', sL, 5.6, 3.9),
    bud('budR', [-sL[0], sL[1]], 5.6, 3.9),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Expansion modules -------------------------------------------------------------------------------

/** The stalk back to the hull's details: glands down it. */
const strut = (R: number, reach: number): Detail[] => [glands(along([0, R * 0.4], [0, R * 0.2 + reach * 0.9], Math.max(2, Math.round(reach / (R * 0.5)))), R * 0.05)]

/**
 * One expansion's own growth, in its local frame: up (-y) is away from the building, +x towards the
 * yard's bow, the socket at the origin; `R` is its size (half its socket's share of the building).
 * Kept within about 1.2 R outward, so it stays inside the building's bitmap.
 */
function modulePod(exp: ModuleId, R: number): Part[] {
  switch (exp) {
    case 'secondSlip':
    case 'capitalSlip': {
      // A second birthing pool along the side: a pale chitin lip outside, a dark pool with green
      // fluid down it, brood ribs across it and a hooked horn at its mouth.
      const big = exp === 'capitalSlip'
      const x0 = -R * (big ? 2.5 : 1.9)
      const x1 = R * (big ? 4 : 4.2)
      const L = x1 - x0
      const yo = -R * 1.18
      const yi = R * 0.1
      const n = Math.round(L / (R * 0.9))
      return [
        part('Bed', blobby([[x0, yo + R * 0.3], [x1, yo + R * 0.3], [x1, yi], [x0, yi]], 2), 'dark', 1, {
          details: [glands(along([x0 + R * 0.5, (yo + yi) / 2 + R * 0.15], [x1 - R * 0.5, (yo + yi) / 2 + R * 0.15], n), R * 0.08)],
        }),
        part('Lip', band([[x0, yo + R * 0.2], [(x0 + x1) / 2, yo + R * 0.14], [x1, yo + R * 0.2]], R * 0.34, R * 0.3, 3), 'hull', 2, { lift: 2.2, slope: [0, -0.45] }),
        part('LipIn', band([[x0, yi], [x1, yi]], R * 0.28, R * 0.28, 2), 'hull2', 2, { lift: 1.8 }),
        ...(big ? [0.2, 0.45, 0.7] : [0.25, 0.6]).map((k, j) => part(`Rib${j}`, band([[x0 + L * k, yi + R * 0.1], [x0 + L * k + R * 0.15, (yo + yi) / 2], [x0 + L * k, yo]], R * 0.24, R * 0.2, 2), 'hull', 3, { lift: 2.8 })),
        part('Horn', band([[x1 - R * 0.1, yi], [x1 + R * 0.25, (yo + yi) / 2], [x1 - R * 0.05, yo - R * 0.05]], R * 0.32, R * 0.08, 3), 'hull2', 3, { lift: 3 }),
      ]
    }
    case 'drydock': {
      // A regeneration pool: a chitin-rimmed basin of green fluid with three feeding tendrils
      // reaching in, green glands at their tips.
      const cy = -R * 0.38
      return [
        part('Basin', circle(0, cy, R * 1.15, 24, R * 0.74), 'hull', 1, { lift: 2.2, holes: [circle(0, cy, R * 0.9, 22, R * 0.54)] }),
        part('Pool', circle(0, cy, R * 0.92, 22, R * 0.56), 'aid', 1.2, { glow: true, noOutline: true, details: [{ k: 'shape', pts: circle(R * 0.12, cy + R * 0.1, R * 0.5, 14, R * 0.34), tone: 'aid' }] }),
        ...[-0.7, 0, 0.7].map((k, j) => part(`Tendril${j}`, band([[R * k, cy - R * 0.66], [R * k * 0.8 + R * 0.15, cy - R * 0.34], [R * k * 0.6, cy - R * 0.05]], R * 0.16, R * 0.05, 3), 'metal', 3, { details: [glands([[R * k * 0.6, cy - R * 0.05]], R * 0.06)] })),
        part('Heart', circle(0, cy, R * 0.26, 12), 'glow', 2, { sphere: true }),
      ]
    }
    case 'armourWorks': {
      // A carapace gland: a swollen organ budding fresh chitin plates, stacked like scales.
      return [
        part('Gland', blobby([[-R * 1.2, R * 0.4], [-R * 1.1, -R * 0.6], [0, -R * 1.15], [R * 1.1, -R * 0.6], [R * 1.2, R * 0.4]], 3), 'metal', 1, { lift: 2.4, details: [glands([[-R * 0.7, -R * 0.2], [R * 0.7, -R * 0.2]], R * 0.07)] }),
        ...[0, 1, 2].map((k) => part(`Scale${k}`, blobby([[-R * (0.9 - k * 0.2), -R * (0.1 + k * 0.32)], [0, -R * (0.42 + k * 0.32)], [R * (0.9 - k * 0.2), -R * (0.1 + k * 0.32)], [0, -R * (0.05 + k * 0.3)]], 3), k % 2 ? 'hull2' : 'hull', 2 + k * 0.1, { lift: 1.6, slope: [0, -0.4] })),
      ]
    }
    case 'strikeHangar': {
      // A brood pod: an open chitin pod lined with violet eggs, its mouth turned outward.
      return [
        part('Pod', blobby([[-R * 1.2, R * 0.4], [-R * 1.15, -R * 0.7], [-R * 0.4, -R * 1.2], [R * 0.4, -R * 1.2], [R * 1.15, -R * 0.7], [R * 1.2, R * 0.4]], 3), 'hull', 1, { lift: 2.6, slope: [0, -0.3] }),
        part('Bay', circle(0, -R * 0.45, R * 0.75, 18, R * 0.55), 'dark', 2),
        ...([[-0.4, -0.45], [0, -0.7], [0.4, -0.45], [0, -0.25]] as Pt[]).map(([x, y], j) => part(`Egg${j}`, circle(R * x, R * y, R * 0.24, 10), 'glow', 2.2 + j * 0.01, { sphere: true })),
      ]
    }
    case 'fighterWing': {
      // A brood rack: a ridge of tissue with three egg sacs on stalks, a Stinger curled in each.
      const xs = [-R * 0.95, 0, R * 0.95]
      return [
        part('Ridge', blobby([[-R * 1.6, R * 0.35], [-R * 1.5, -R * 0.3], [R * 1.5, -R * 0.3], [R * 1.6, R * 0.35]], 2), 'metal', 1, { lift: 2.4 }),
        ...xs.map((x, j) => part(`Stalk${j}`, band([[x, -R * 0.2], [x, -R * 0.6]], R * 0.2, R * 0.14, 2), 'hull2', 2, { lift: 1.4 })),
        ...xs.map((x, j) => part(`Sac${j}`, circle(x, -R * 0.82, R * 0.32, 14, R * 0.38), 'hull', 3, { lift: 1.2, details: [{ k: 'shape', pts: circle(x, -R * 0.82, R * 0.18, 10, R * 0.22), tone: 'glow' }] })),
      ]
    }
    case 'sensorArray': {
      // A sensory stalk: a tall stalk throwing a long shadow, a cluster of eye bulbs at its top and a
      // great violet eye on a fleshy base below it.
      return [
        part('Base', circle(0, -R * 0.1, R * 0.8, 16), 'metal', 1, { lift: 1.6 }),
        part('Stalk', band([[0, -R * 0.3], [R * 0.15, -R * 1.2], [0, -R * 2.0]], R * 0.32, R * 0.16, 3), 'hull2', 2.4, { lift: 6 }),
        ...([[-0.25, -2.05], [0.22, -2.1], [0, -1.8]] as Pt[]).map(([x, y], j) => part(`Bulb${j}`, circle(R * x, R * y, R * 0.18, 10), 'glow', 2.6 + j * 0.01, { lift: 6, sphere: true })),
        part('Eye', circle(0, -R * 0.2, R * 0.48, 16), 'glass', 3, { sphere: true, details: [{ k: 'shape', pts: circle(0, -R * 0.2, R * 0.14, 8, R * 0.26), tone: 'dark' }] }),
      ]
    }
    case 'shieldCore': {
      // The Swarm grows no shields; its shield core is a membrane bladder, a great violet-veined
      // bulb on a ring of chitin, glands round its foot.
      const cy = -R * 0.4
      return [
        part('Ring', circle(0, cy, R * 1.12, 26), 'metal', 1, { lift: 1.8, details: [glands(circle(0, cy, R * 1.02, 10), R * 0.05)] }),
        part('Bladder', circle(0, cy, R * 0.82, 26), 'hull2', 2, { sphere: true, details: [{ k: 'line', pts: [[-R * 0.5, cy - R * 0.3], [0, cy], [R * 0.4, cy - R * 0.4]] }, { k: 'line', pts: [[-R * 0.3, cy + R * 0.5], [0, cy], [R * 0.5, cy + R * 0.3]] }] }),
        part('Heart', circle(0, cy, R * 0.3, 14), 'glow', 3, { glow: true }),
      ]
    }
  }
}

/** Its expansion modules' own growths, for models/expansions.ts. */
export const expansion: Expansion = { pod: modulePod, strut }
