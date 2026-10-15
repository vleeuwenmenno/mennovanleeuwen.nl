import { ORBITAL_FRAME } from '../../data.ts'
import { circle, part } from '../kit.ts'
import type { ModelDef } from '../spec.ts'
import type { Part, Pt } from '../types.ts'
import { band, blobby, core, glands, plate, sparks, tendril } from './craft.ts'

// The Guardian (Galactic conquest): a living defense organism, on the shared defense station frame
// (ORBITAL_FRAME, frame units round the middle). Level 1, the Guardian Spore, is a chitin bulb round
// a violet core with a weapon organ growing from its crown; level 2, the Bloom, buds a lobe to its
// west on a tissue bridge and a glowing gland sac to its east; level 3, the Hive, grows a ring of
// chitin petals round it all, lobes north and east, a brood sac to the south and trailing tendrils.
// Each slot is a lobe of chitin; an empty one shows its open bud, a pit with acid-green glands.

const polar = (a: number, r: number, cx = 0, cy = 0): Pt => [cx + Math.cos(a) * r, cy + Math.sin(a) * r]

/** An empty bud where an organ will grow: a ring of chitin round a dark pit with green glands. */
function bud(id: string, [x, y]: Pt, r: number, z: number): Part {
  return part(id, circle(x, y, r, 18), 'hull2', z, {
    lift: 0.8,
    details: [
      { k: 'shape', pts: circle(x, y, r * 0.72, 16), tone: 'dark' },
      { k: 'shape', pts: circle(x, y, r * 0.38, 12), tone: 'metal' },
      { k: 'lights', pts: [0, 1, 2, 3, 4].map((i) => polar((i / 5) * Math.PI * 2, r * 0.56, x, y)), r: r * 0.08, tone: 'aid' },
    ],
  })
}

/** A lobe of chitin where an organ grows: a swollen pad, lit on one side, a seam round it. */
const lobe = (id: string, [x, y]: Pt, r: number, z: number): Part =>
  part(id, blobby([polar(-1.4, r, x, y), polar(-0.3, r * 1.08, x, y), polar(0.9, r * 0.96, x, y), polar(2, r * 1.06, x, y), polar(3.1, r * 0.98, x, y), polar(4.2, r * 1.04, x, y)], 3), 'hull', z, {
    lift: 2.4,
    facets: [{ pts: circle(x, y, r, 16).filter(([px]) => px <= x), slope: [-0.4, 0] }],
    details: [{ k: 'line', pts: circle(x, y, r * 0.8, 16) }, glands([polar(0.6, r * 0.9, x, y), polar(3.6, r * 0.9, x, y)], 0.9)],
  })

export const orbital: ModelDef = ({ t, level }) => {
  const S = ORBITAL_FRAME.slots
  const filled = t.orbital?.slots ?? []
  const parts: Part[] = []
  if (level >= 3) {
    // The ring of petals round the whole organism, and tendrils trailing from it.
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2
      const pts: Pt[] = [polar(a - 0.3, 38), polar(a - 0.12, 47), polar(a, 49.5), polar(a + 0.14, 46), polar(a + 0.3, 38), polar(a, 35)]
      parts.push(plate(`petal${i}`, blobby(pts, 2), i % 2 ? 'hull2' : 'hull', 0.8, [Math.cos(a) * 0.4, Math.sin(a) * 0.4], { lift: 1.8, details: [glands([polar(a, 43)], 0.8)] }))
    }
    parts.push(part('web', circle(0, 0, 38, 30), 'metal', 0.6, { holes: [circle(0, 0, 22, 24)] }))
    for (const [i, a] of [0.8, 2.35, 3.95, 5.5].entries()) parts.push(tendril(`tendril${i}`, [polar(a, 40), polar(a + 0.15, 45), polar(a + 0.05, 49)], 2.6, 0.5))
    parts.push(part('bridgeN', band([[0, -16], [2, -22], [0, S[3][1] + 9]], 9, 8), 'metal', 1.1, { lift: 1.2 }))
    parts.push(part('bridgeE', band([[16, 0], [22, -2], [S[2][0] - 9, 0]], 9, 8), 'metal', 1.1, { lift: 1.2 }))
    // The brood sac to the south: a swollen bladder with a violet heart.
    parts.push(part('bridgeS', band([[0, 16], [-2, 22], [0, 27]], 9, 8), 'metal', 1.1, { lift: 1.2 }))
    parts.push(part('sacPod', blobby([[0, 26], [-12, 30], [-13, 38], [0, 44], [13, 38], [12, 30]], 3), 'aid', 1.8, { sphere: true, lift: 1.6, details: [sparks([[0, 35]], 1.4)] }))
  }
  if (level >= 2) {
    parts.push(part('bridgeW', band([[-16, 0], [-22, 2], [S[1][0] + 9, 0]], 9, 8), 'metal', 1.1, { lift: 1.2 }))
    if (level === 2) {
      // The gland sac to the east: the Bloom's counterweight, glowing acid green.
      parts.push(part('bridgeE', band([[16, 0], [22, -2], [28, 0]], 9, 8), 'metal', 1.1, { lift: 1.2 }))
      parts.push(part('sacs', blobby([[28, -10], [40, -12], [45, 0], [40, 12], [28, 10], [26, 0]], 3), 'aid', 1.8, { sphere: true, lift: 1.4, details: [glands([[36, -4], [38, 5]], 1.2)] }))
      parts.push(tendril('tendrilE', [[44, 4], [48, 12], [46, 22]], 2.4, 0.5))
    }
  }
  // The bulb: six chitin plates over a dark body round the violet core.
  parts.push(part('body', circle(0, 0, 20, 28), 'metal', 1.6, { lift: 1 }))
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2
    const pts: Pt[] = [polar(a - 0.48, 12), polar(a - 0.4, 20.5), polar(a, 22.5), polar(a + 0.4, 20.5), polar(a + 0.48, 12)]
    parts.push(plate(`shell${i}`, blobby(pts, 2), i % 2 ? 'hull2' : 'hull', 2, [Math.cos(a) * 0.4, Math.sin(a) * 0.4], { lift: 2, details: [glands([polar(a, 18)], 0.8)] }))
  }
  parts.push(...core('core', 0, 0, 9, 9, 2.3))
  // Each slot: its lobe, and an open bud where no organ is grown yet.
  for (let s = 0; s < ORBITAL_FRAME.counts[level - 1]; s++) {
    const [x, y] = S[s]
    if (s > 0) parts.push(lobe(`lobe${s}`, [x, y], 11.5, 2.5))
    if (!filled[s]) parts.push(bud(`bud${s}`, [x, y], s ? 8.6 : 9, 3))
  }
  return { parts, breakStyle: 'pie' }
}
