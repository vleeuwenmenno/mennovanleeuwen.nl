import { along, circle, part, rect, sym, thick } from '../kit.ts'
import type { ModelDef } from '../spec.ts'
import type { Detail, Part, Pt } from '../types.ts'
import { across, ambers, antenna, armour, block, cells, mark, recess, seam, spine, windows } from './parts.ts'

// The Confederacy's structures: the Dominion Command Hub at every level, the Extraction Rig and the
// three defense platforms (refs/confederacy.webp "Station modules", refs/overview-1.webp "Station
// progression"): weaponized industrial infrastructure, armoured cores with dock arms, production,
// defence and storage modules bolted on, growing more fortified at every step.

/** A truss arm: an open charcoal girder from x0 to x1 (left to right) at y, `hw` half-wide, its
 * bays cut out with a diagonal across each, and orange work lights down its spine. */
function truss(id: string, x0: number, x1: number, y: number, hw: number, z: number, more: Partial<Part> = {}): Part {
  const n = Math.max(2, Math.round((x1 - x0) / (hw * 2.2)))
  const step = (x1 - x0) / n
  const holes: Pt[][] = []
  const details: Detail[] = []
  const e = hw * 0.22
  for (let i = 0; i < n; i++) {
    const a = x0 + i * step + e
    const b = x0 + (i + 1) * step - e
    holes.push(rect(a, y - hw + e, b - a, hw * 2 - e * 2))
    details.push(seam([a, y - hw + e], [b, y + hw - e]))
  }
  return part(id, rect(x0, y - hw, x1 - x0, hw * 2), 'metal', z, { lift: 3, holes, details, ...more })
}

/** The same truss, standing: from y0 to y1 at x. */
function trussV(id: string, x: number, y0: number, y1: number, hw: number, z: number, more: Partial<Part> = {}): Part {
  const t = truss(id, y0, y1, x, hw, z, more)
  const flip = (pts: Pt[]) => pts.map(([a, b]) => [b, a] as Pt)
  return { ...t, pts: flip(t.pts), holes: t.holes?.map(flip), details: t.details?.map((d) => ({ ...d, pts: flip(d.pts) })) }
}

/** A storage module: a block of orange-capped resource tanks in a dark frame. */
const storage = (id: string, x: number, y: number, z: number, level: number): Part[] => [
  armour(`${id}Deck`, x, y, 160, 130, z, { tone: 'hull2', panel: false, cut: 30, lift: 4, level }),
  cells(`${id}Tanks`, x, y - 6, 4, 2, 26, z + 0.1, { level, lift: 3 }),
]

/** A production module: a heavy hall with three recessed bays glowing orange, an armoured roof. */
const production = (id: string, x: number, y: number, z: number, level: number): Part[] => [
  part(`${id}Hall`, block(x, y, 170, 160, 36, 20), 'hull2', z, {
    lift: 5,
    level,
    facets: [{ pts: rect(x - 85, y - 80, 85, 160), slope: [-0.5, 0] }],
    details: [
      ...[-50, 0, 50].map((dx): Detail => recess(rect(x + dx - 18, y + 20, 36, 44))),
      ambers([-50, 0, 50].map((dx) => [x + dx, y + 56] as Pt), 6),
      mark(rect(x - 70, y + 6, 140, 8)),
      across(x - 80, x + 80, y - 30),
    ],
  }),
]

/**
 * Dominion Command Hub: an armoured cross. Level 1, the Outpost, is the core hub: a chamfered
 * square around a reactor (orange ring, teal heart), with short arms on all four sides, the battery
 * on the north arm and the hangar in the south. Level 2, the Stronghold, runs truss dock arms out
 * east and west to defence modules carrying its guns, and caps the north and south arms. Level 3,
 * the Warbase, adds production halls on the forward diagonals with batteries on their roofs,
 * extends the arms to a sensor spire in the north and a shield block in the south. Level 4, the
 * Fortress, adds storage modules on the rear diagonals with guns, and armoured bastions on both
 * flanks. Drawn in frame pixels from the frame's middle, where data.ts places the modules.
 */
export const station: ModelDef = ({ level }) => {
  const parts: Part[] = []

  // --- Level 4: bastions on the flanks, storage modules aft ---------------------------------------
  if (level >= 4) {
    for (const s of [-1, 1]) {
      const id = s < 0 ? 'L' : 'R'
      parts.push(
        part(`bastion${id}`, block(s * 480, 0, 112, 470, 44, 30), 'hull', 1.6, {
          lift: 6,
          facets: [{ pts: rect(s * 480 - 56, -235, 56, 470), slope: [-0.5, 0] }],
          details: [mark(rect(s * 480 - 50, -20, 100, 12)), recess(rect(s * 480 - 30, -70, 60, 34)), recess(rect(s * 480 - 30, 40, 60, 34)), across(s * 480 - 56, s * 480 + 56, -110), across(s * 480 - 56, s * 480 + 56, 110)],
        }),
        part(`bastionLink${id}`, rect(s < 0 ? -430 : 380, -40, 50, 80), 'metal', 1.4, { lift: 4 }),
        ...storage(`store${id}`, s * 290, 330, 2, 4),
        part(`storeStrut${id}`, thick([[s * 130, 170], [s * 230, 270]], 54), 'metal', 1.2, { lift: 3 }),
        antenna(`spike${id}`, [s * 480, -230], [s * 480, -280], 16, 3, { detach: { hull: s < 0 ? 0.3 : 0.24 } }),
      )
    }
  }

  // --- Level 3: production halls, the spire and the shield block ------------------------------------
  if (level >= 3) {
    for (const s of [-1, 1]) {
      const id = s < 0 ? 'L' : 'R'
      parts.push(...production(`prod${id}`, s * 290, -290, 2.2, 3), part(`prodStrut${id}`, thick([[s * 130, -150], [s * 230, -230]], 60), 'metal', 1.2, { lift: 3 }))
    }
    parts.push(
      trussV('spireTruss', 0, -520, -380, 34, 1.4),
      part('spire', block(0, -470, 110, 100, 30, 16), 'hull', 2.4, { lift: 5, details: [mark(rect(-40, -430, 80, 8)), windows(along([-30, -505], [30, -505], 4), 5)] }),
      armour('southBlock', 0, 440, 170, 130, 2.4, { tone: 'hull', cut: 34, lift: 5 }),
      trussV('southTruss', 0, 300, 380, 40, 1.4),
    )
  }

  // --- Level 2: dock arms to the defence modules, the caps ------------------------------------------
  if (level >= 2) {
    for (const s of [-1, 1]) {
      const id = s < 0 ? 'L' : 'R'
      parts.push(
        truss(`dockArm${id}`, s < 0 ? -400 : 160, s < 0 ? -160 : 400, -52, 30, 1.2),
        truss(`dockArm2${id}`, s < 0 ? -400 : 160, s < 0 ? -160 : 400, 52, 30, 1.2),
        part(`gantry${id}`, rect(s * 240 - 12, -90, 24, 180), 'hull2', 1.6, { lift: 4.2, details: [ambers([[s * 240, -80], [s * 240, 80]], 6), seam([s * 240, -90], [s * 240, 90])] }),
        part(`defence${id}`, block(s * 330, 0, 130, 150, 34, 20), 'hull', 2, {
          lift: 5,
          facets: [{ pts: rect(s * 330 - 65, -75, 65, 150), slope: [-0.5, 0] }],
          details: [mark(rect(s * 330 - 55, 52, 110, 9)), recess(rect(s * 330 + s * 30 - 12, -58, 24, 22)), windows([[s * 330 - s * 44, -50]], 5)],
        }),
      )
    }
    parts.push(
      armour('capN', 0, -330, 130, 90, 2, { tone: 'hull2', cut: 26, lift: 4 }),
      armour('capS', 0, 325, 140, 80, 2, { tone: 'hull2', cut: 24, lift: 4 }),
    )
  }

  // --- Level 1: the core hub ----------------------------------------------------------------------
  parts.push(
    part('armN', block(0, -215, 150, 150, 34, 12), 'hull', 2.6, {
      lift: 4,
      facets: [{ pts: rect(-75, -290, 75, 150), slope: [-0.5, 0] }],
      details: [mark(rect(-60, -284, 120, 9)), across(-75, 75, -230)],
    }),
    part('armS', block(0, 215, 150, 150, 12, 34), 'hull', 2.6, {
      lift: 4,
      facets: [{ pts: rect(-75, 140, 75, 150), slope: [-0.5, 0] }],
      details: [mark(rect(-60, 275, 120, 9)), across(-75, 75, 160)],
    }),
    ...sym(part('armW', block(-188, 0, 84, 150, 18, 18), 'hull', 2.6, {
      lift: 4,
      facets: [{ pts: rect(-230, -75, 42, 150), slope: [-0.5, 0] }],
      details: [mark(rect(-226, -50, 8, 100)), windows(along([-206, -40], [-206, 40], 4), 4.6)],
    })),
    part('core', block(0, 0, 320, 320, 90, 90), 'hull2', 3, {
      lift: 5,
      facets: [{ pts: [[-160, -70], [-70, -160], [70, -160], [160, -70], [0, 0]], slope: [0, -0.4] }],
      details: [
        across(-160, 160, 0),
        seam([0, -160], [0, 160]),
        ...[0, 1, 2, 3].map((k): Detail => {
          const [sx, sy] = [k % 2 ? 1 : -1, k < 2 ? -1 : 1]
          return mark([[sx * 112, sy * 46], [sx * 146, sy * 46], [sx * 146, sy * 80], [sx * 112, sy * 80]].map(([x, y]) => [x, y] as Pt))
        }),
      ],
    }),
    // The reactor: an orange ring with a teal heart, under the Stronghold's shield generator.
    part('reactor', circle(0, 0, 76, 32), 'metal', 3.6, {
      lift: 2,
      details: [{ k: 'shape', pts: circle(0, 0, 64, 30), tone: 'accent' }, { k: 'shape', pts: circle(0, 0, 52, 28), tone: 'dark' }, windows([[0, 0]], 18), ambers(along([-40, 0], [40, 0], 2), 5)],
    }),
    spine('spineN', 0, -150, -100, 28, 3.4),
    spine('spineS', 0, 100, 150, 28, 3.4),
    antenna('mast', [-150, -30], [-206, -110], 12, 4, { detach: { hull: 0.3 } }),
  )
  return { parts, breakStyle: 'pie' }
}

// --- Structures on the ore ---------------------------------------------------------------------------

/** Four clamp legs bitten into the asteroid at the corners: charcoal girders with an orange-tipped
 * claw each. */
function clamps(x0: number, y0: number, x1: number, y1: number, z: number): Part[] {
  const out: Part[] = []
  for (const [sx, sy, n] of [[1, 1, 0], [-1, 1, 1], [1, -1, 2], [-1, -1, 3]] as const) {
    const a: Pt = [x0 * sx, y0 * sy]
    const b: Pt = [x1 * sx, y1 * sy]
    out.push(part(`leg${n}`, thick([a, b], 6, 4.6), 'metal', z, { lift: 1.2 }))
    out.push(part(`claw${n}`, [[b[0] - 4 * sx, b[1]], [b[0], b[1] - 4 * sy], [b[0] + 3.4 * sx, b[1] + 1.4 * sy], [b[0] + 1.4 * sx, b[1] + 3.4 * sy]], 'accent', z + 0.1, { lift: 0.6 }))
  }
  return out
}

/**
 * Extraction Rig: an industrial rig. Two angular drill housings on a gunmetal frame, a conveyor
 * spine between them through the ore silo hub, a landing block on top (where the shield dome goes)
 * and a gun block below, a loading crane and a mast bolted on, clamped to its asteroid at the corners.
 */
export const mine: ModelDef = ({ h }) => {
  const padY = (1.6 / 10 - 0.5) * h
  const pdY = (7.9 / 10 - 0.5) * h
  const parts: Part[] = [
    ...clamps(-20, -14, -44, -40, 0),
    part('frame', block(0, 0, 96, 24, 6), 'metal', 1, { lift: 1.4, details: [across(-46, 46, 0)] }),
    spine('conveyor', 0, padY + 8, pdY - 6, 12, 1.2),
    ...sym(part('housing', block(-32, 0, 38, 42, 9, 5), 'hull', 2, {
      lift: 2.6,
      facets: [{ pts: rect(-51, -21, 19, 42), slope: [-0.5, 0] }],
      details: [mark([[-51, 16], [-13, 16], [-13, 19], [-51, 19]]), recess(rect(-44, -18, 24, 6)), windows([[-48, -12]], 1)],
    })),
    armour('pad', 0, padY, 30, 22, 2, { tone: 'hull2', band: true }),
    armour('gunbox', 0, pdY, 18, 15, 2, { tone: 'hull', band: false }),
    part('hub', block(0, 0, 22, 22, 6), 'hull2', 3, { lift: 2.6, details: [mark(rect(-11, 7, 22, 2))] }),
    part('crane', thick([[12, 10], [22, 24], [16, 32]], 3, 2), 'metal', 3.2, { lift: 2, detach: { hull: 0.45 }, details: [ambers([[16, 32]], 0.9)] }),
    antenna('mast', [-12, -10], [-20, -30], 2.2, 3.4, { detach: { hull: 0.5 } }),
  ]
  return { parts, breakStyle: 'pie' }
}

/**
 * The defense platforms (the Bulwark Platform, the Shredder Battery and the Siege Battery share one
 * deck): a cross-shaped armoured deck on charcoal girders, angular gun blocks at its corners, side
 * blocks and a heavy central hub, clamped to the asteroid. The Shredder stacks orange ammunition
 * racks by its guns; the Siege carries capacitor banks fore and aft; the Bulwark a sensor mast.
 */
export const defense: ModelDef = ({ t, h }) => {
  const kind = t.id.endsWith('flak') ? 'flak' : t.id.endsWith('gun') ? 'gun' : 'balanced'
  const cy = (5.1 / 10 - 0.5) * h
  const corners: Pt[] = [[-24, (3 / 10 - 0.5) * h], [24, (3 / 10 - 0.5) * h], [-24, (7.3 / 10 - 0.5) * h], [24, (7.3 / 10 - 0.5) * h]]
  const parts: Part[] = [
    ...clamps(-30, -30, -46, -46, 0),
    part('deckV', block(0, cy, 40, 90, 10), 'hull2', 1, { lift: 2, details: [across(-20, 20, cy - 30), across(-20, 20, cy + 30)] }),
    part('deckH', block(0, cy, 90, 40, 10), 'hull2', 1.1, { lift: 2, details: [seam([-30, cy - 20], [-30, cy + 20]), seam([30, cy - 20], [30, cy + 20])] }),
    ...corners.map(([x, y], i) => part(`girder${i}`, thick([[x * 0.3, cy + (y - cy) * 0.3], [x, y]], 7), 'metal', 1.5, { lift: 1.4 })),
    ...corners.map(([x, y], i) => armour(`pod${i}`, x, y, 20, 20, 2.5, { tone: 'hull', cut: 5, lift: 3 })),
    ...sym(armour('side', -41, 0, 12, 18, 2.6, { tone: 'hull', cut: 3, lift: 3, band: false })),
    part('hub', block(0, cy, 38, 38, 10, 6), 'hull', 3, {
      lift: 3.4,
      facets: [{ pts: rect(-19, cy - 19, 19, 38), slope: [-0.5, 0] }],
      details: [mark(rect(-15, cy + 13, 30, 2.6)), recess(block(0, cy, 24, 24, 6))],
    }),
  ]
  if (kind === 'flak') corners.forEach(([x, y], i) => parts.push(part(`rack${i}`, rect(x + (x < 0 ? 9 : -14), y + (y < cy ? 9 : -14), 5, 5), 'accent', 3, { lift: 1, details: [across(x + (x < 0 ? 9 : -14), x + (x < 0 ? 14 : -9), y + (y < cy ? 11.5 : -11.5))] })))
  if (kind === 'gun') for (const s of [-1, 1]) parts.push(part(`cap${s < 0 ? 'T' : 'B'}`, block(0, cy + s * 37, 18, 8, 2), 'dark', 3, { lift: 2.4, details: [ambers(along([-6, cy + s * 37], [6, cy + s * 37], 3), 1)] }))
  if (kind === 'balanced') parts.push(antenna('mast', [-34, cy + 26], [-40, cy + 40], 2.4, 3.2, { detach: { hull: 0.4 } }))
  parts.push(antenna('mastA', [34, cy - 30], [40, cy - 44], 2, 3.2, { detach: { hull: 0.5 } }))
  return { parts, breakStyle: 'pie' }
}
