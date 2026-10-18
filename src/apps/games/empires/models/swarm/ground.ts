import { arcBand, capsule, circle, part, rimFacets, spline, sym, thick } from '../kit.ts'
import type { GroundModels } from '../ground.ts'
import type { Pt } from '../types.ts'

// The Swarm's ground units, seen from straight above, light from the top left. The Hive Nexus is a
// mound of dark chitin round a glowing violet core, ringed by pale plates, with tendrils spreading
// into the ground round it and a maw to the south (its door). The Shaper drone is a low crawler:
// three pairs of short legs, a pale thorax, mandibles, and a sac of resin glowing acid green. The
// Brood Cache is a cluster of resin pods full of glowing nutrient on a low mound, webbed together.

/** A lumpy ring of `n` points round (x, y): radius `r`, each point pushed in or out by up to `amp`
 * from a fixed pattern (no randomness: the same mound every time). */
function lumps(x: number, y: number, r: number, amp: number, n: number): Pt[] {
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    const k = r + amp * Math.sin(i * 2.7 + 0.6) * Math.cos(i * 1.3)
    return [x + Math.cos(a) * k, y + Math.sin(a) * k] as Pt
  })
  return spline(pts, 3, true)
}

export const GROUND: GroundModels = {
  's-g-center': {
    w: 100,
    h: 100,
    spec: () => {
      const mound = lumps(0, 0, 42, 3.5, 11)
      // Tendrils out into the ground, between the plates.
      const tendrils = [0.35, 1.25, 2.2, 3.0, 4.05, 5.2].map((a, i) => {
        const len = 49 - (i % 2) * 4
        const bend = i % 2 ? 0.25 : -0.25
        const p = (t: number): Pt => [Math.cos(a + bend * t * t) * (30 + (len - 30) * t), Math.sin(a + bend * t * t) * (30 + (len - 30) * t)]
        return part(`tendril${i}`, thick(spline([p(0), p(0.4), p(0.75), p(1)], 3), 7, 1.5), 'metal', 0.6, { lift: 1.5 })
      })
      // Six pale plates round the core, each sloping outwards.
      const plates = Array.from({ length: 6 }, (_, i) => {
        const a0 = (i / 6) * Math.PI * 2 - Math.PI / 2 + 0.12
        const a1 = a0 + Math.PI / 3 - 0.24
        const am = (a0 + a1) / 2
        return part(`plate${i}`, arcBand(0, 0, 21, 38, a0, a1, 6), i % 2 ? 'hull2' : 'hull', 2, {
          lift: 6,
          slope: [Math.cos(am) * 0.8, Math.sin(am) * 0.8],
          details: [{ k: 'line', pts: arcBand(0, 0, 25, 33, a0 + 0.08, a1 - 0.08, 4).slice(0, 5) }],
        })
      })
      return {
        breakStyle: 'pie',
        parts: [
          ...tendrils,
          // The mound, dark chitin, shaded round like a low cone.
          part('mound', mound, 'metal', 1, { lift: 4, facets: rimFacets(mound, 0, 0, 0.55, 0.7) }),
          ...plates,
          // Acid-green sacs on the mound between the plates.
          ...[0.5, 2.6, 4.7].map((a, i) => part(`sac${i}`, circle(Math.cos(a) * 34, Math.sin(a) * 34, 4.5, 12), 'aid', 3, { lift: 3, sphere: true })),
          // The maw on the south side, its door.
          part('maw', spline([[-12, 36], [0, 33], [12, 36], [9, 44], [0, 46], [-9, 44]] as Pt[], 3, true), 'dark', 3, {
            lift: 1,
            details: [{ k: 'lights', pts: [[-6, 41], [6, 41]], r: 1.4, tone: 'glow' }],
          }),
          // The core: a ring of tissue round a violet glow.
          part('coreRing', circle(0, 0, 18, 24), 'dark', 3, { lift: 2 }),
          part('core', circle(0, 0, 13, 24), 'glow', 4, { lift: 3, glow: true, details: [{ k: 'shape', pts: circle(-3, -3, 6, 16), tone: 'glass' }] }),
        ],
      }
    },
  },
  's-g-engineer': {
    w: 80,
    h: 100,
    spec: () => ({
      breakStyle: 'bands',
      parts: [
        // Three pairs of short legs.
        ...[-10, 6, 22].flatMap((y, i) =>
          sym(part(`leg${i}`, thick([[-12, y], [-28, y - 8 + i * 4], [-36, y + 4 + i * 3]], 5, 2), 'metal', 1, { lift: 2 })),
        ),
        // Mandibles at the front, violet tipped.
        ...sym(part('mandible', capsule([-6, -36], [-11, -48], 3, 1.5), 'accent', 2, { lift: 4 })),
        // The abdomen with its glowing resin sac, then the thorax and head, pale chitin over dark.
        part('abdomen', circle(0, 24, 18, 24, 22), 'hull2', 3, {
          lift: 4,
          sphere: true,
          details: [
            { k: 'line', pts: [[-15, 14], [15, 14]] },
            { k: 'line', pts: [[-16, 26], [16, 26]] },
          ],
        }),
        part('resin', circle(0, 34, 7, 14), 'aid', 4, { lift: 5, glow: true }),
        part('thorax', circle(0, -6, 15, 22, 14), 'hull', 4, { lift: 5, sphere: true, details: [{ k: 'shape', pts: circle(0, -6, 4, 10, 7), tone: 'accent' }] }),
        part('head', circle(0, -28, 10, 18, 9), 'metal', 5, {
          lift: 5,
          sphere: true,
          details: [{ k: 'lights', pts: [[-4, -31], [4, -31]], r: 1.8, tone: 'glass' }],
        }),
      ],
    }),
  },
  's-g-supply': {
    w: 100,
    h: 100,
    spec: () => {
      const mound = lumps(0, 2, 44, 3, 9)
      // The pods: middle (x, y), radius, and which shell.
      const pods: [number, number, number, 'hull' | 'hull2'][] = [[-15, -12, 17, 'hull'], [17, -15, 14, 'hull2'], [19, 15, 13, 'hull'], [-16, 18, 12, 'hull2'], [0, 2, 11, 'hull2']]
      return {
        breakStyle: 'pie',
        parts: [
          part('mound', mound, 'metal', 1, { lift: 2, facets: rimFacets(mound, 0, 2, 0.5, 0.7) }),
          // Strands of resin between the pods.
          ...pods.slice(0, 4).map(([x, y], i) => part(`web${i}`, thick([[x * 0.4, y * 0.4], [x, y]], 4, 2), 'dark', 2, { lift: 3 })),
          ...pods.map(([x, y, r, tone], i) =>
            part(`pod${i}`, circle(x, y, r, 20, r * 0.92), tone, 3 + i * 0.1, {
              lift: 5 + r * 0.25,
              sphere: true,
              details: [
                { k: 'shape', pts: circle(x - r * 0.15, y - r * 0.15, r * 0.45, 14), tone: 'aid' },
                { k: 'line', pts: arcBand(x, y, r * 0.7, r * 0.72, -2.4, -0.6, 6).slice(0, 7) },
              ],
            }),
          ),
          // The nutrient glowing through the middle pod's top, and violet nodes on the others.
          part('glow', circle(0, 2, 5, 12), 'aid', 4, { lift: 8, glow: true }),
          ...sym(part('node', circle(-24, -2, 2.6, 10), 'glass', 4, { lift: 6, glow: true })),
          // The maw on the south side, its door.
          part('maw', spline([[-10, 38], [0, 35], [10, 38], [7, 45], [0, 47], [-7, 45]] as Pt[], 3, true), 'dark', 3, {
            lift: 1,
            details: [{ k: 'lights', pts: [[-5, 42], [5, 42]], r: 1.3, tone: 'glow' }],
          }),
          part('stalk', capsule([26, -30], [32, -40], 2.2, 1.2), 'accent', 2, { lift: 6 }),
        ],
      }
    },
  },
  // The Skitterling: a quick six-legged bug, a low armoured back, long forelegs, and a glowing acid
  // gland at its mouth that it spits bolts from.
  's-g-scout': {
    w: 70,
    h: 100,
    spec: () => ({
      breakStyle: 'bands',
      parts: [
        // Six long, thin legs, the front pair reaching forward.
        ...[[-14, -26, -34, -33], [0, -30, -4, -33], [16, -28, 34, -33]].flatMap(([y, x1, y1, x2], i) =>
          sym(part(`leg${i}`, thick([[-8, y], [x1, y + y1 / 6], [x2, y + 14 + i * 4]], 3.5, 1.5), 'metal', 1, { lift: 2 })),
        ),
        // The abdomen, a pale plated back, then the head.
        part('abdomen', circle(0, 20, 18, 22, 26), 'hull2', 2, {
          lift: 4,
          sphere: true,
          details: [{ k: 'line', pts: [[-12, 12], [12, 12]] }, { k: 'line', pts: [[-12, 24], [12, 24]] }],
        }),
        part('back', circle(0, -8, 15, 20, 18), 'hull', 3, { lift: 5, sphere: true, details: [{ k: 'shape', pts: circle(0, -8, 3, 10, 6), tone: 'accent' }] }),
        part('head', circle(0, -30, 8, 16, 9), 'metal', 4, { lift: 5, sphere: true }),
        ...sym(part('mandible', capsule([-4, -36], [-8, -46], 2.4, 1.2), 'accent', 4, { lift: 5 })),
        part('gland', circle(0, -42, 4, 12), 'aid', 5, { lift: 6, glow: true }),
      ],
    }),
  },
  // A Bio-reactor (2 × 2 tiles): a pulsing sac of acid-green fluid digesting kyber, ribbed with dark
  // chitin, fed by veins, a violet node at its heart.
  's-g-generator': {
    w: 100,
    h: 100,
    spec: () => {
      const mound = lumps(0, 2, 44, 3, 9)
      return {
        breakStyle: 'pie',
        parts: [
          part('mound', mound, 'metal', 1, { lift: 2, facets: rimFacets(mound, 0, 2, 0.55, 0.7) }),
          ...[0.6, 2.2, 3.8, 5.3].map((a, i) => part(`vein${i}`, thick([[Math.cos(a) * 18, Math.sin(a) * 18], [Math.cos(a + 0.3) * 32, Math.sin(a + 0.3) * 32], [Math.cos(a + 0.2) * 44, Math.sin(a + 0.2) * 44]], 5, 1.5), 'dark', 2, { lift: 2 })),
          part('sac', circle(0, -2, 26, 26, 24), 'aid', 3, { lift: 10, sphere: true, details: [...[-12, 0, 12].map((x) => ({ k: 'line' as const, pts: [[x, -24], [x * 1.1, 20]] as Pt[] }))] }),
          part('glow', circle(-4, -8, 9, 16), 'aid', 4, { lift: 12, glow: true }),
          part('node', circle(6, 6, 5, 12), 'glass', 5, { lift: 12, glow: true }),
          part('maw', spline([[-9, 38], [0, 35], [9, 38], [6, 45], [0, 47], [-6, 45]] as Pt[], 3, true), 'dark', 3, { lift: 1 }),
        ],
      }
    },
  },
  // A Mind Node (3 × 3 tiles): a ganglion of nerve pods round a violet thinking core on a chitin
  // mound, linked by glowing strands.
  's-g-research': {
    w: 100,
    h: 100,
    spec: () => {
      const mound = lumps(0, 2, 45, 3.5, 10)
      const pods: [number, number, number][] = [[-24, -20, 11], [22, -22, 12], [28, 12, 10], [-26, 16, 10], [0, 28, 9]]
      return {
        breakStyle: 'pie',
        parts: [
          part('mound', mound, 'metal', 1, { lift: 3, facets: rimFacets(mound, 0, 2, 0.55, 0.7) }),
          ...pods.map(([x, y], i) => part(`strand${i}`, thick([[x * 0.3, y * 0.3], [x, y]], 3, 1.5), 'glow', 2, { lift: 4, glow: true })),
          ...pods.map(([x, y, r], i) => part(`pod${i}`, circle(x, y, r, 18), i % 2 ? 'hull2' : 'hull', 3, { lift: 7, sphere: true, details: [{ k: 'shape', pts: circle(x - r * 0.2, y - r * 0.2, r * 0.4, 10), tone: 'accent' }] })),
          part('coreRing', circle(0, 0, 17, 22), 'dark', 4, { lift: 8 }),
          part('core', circle(0, 0, 12, 22), 'glow', 5, { lift: 10, glow: true, details: [{ k: 'shape', pts: circle(-3, -3, 5, 12), tone: 'glass' }] }),
          part('maw', spline([[-10, 40], [0, 37], [10, 40], [7, 46], [0, 48], [-7, 46]] as Pt[], 3, true), 'dark', 3, { lift: 1 }),
        ],
      }
    },
  },
  // A swarmling, one bug of a pack (GroundSpec `squad`): a purple carapace over its abdomen, a pale
  // thorax and head, mandibles, six legs. It scuttles on alternate tripods (poses 1 and 2: one
  // front leg, the other side's middle one and the back one forward together).
  's-gm-swarmling': {
    w: 84,
    h: 96,
    spec: () => {
      // Each leg's hip (its y; x is 9 either side) and where its foot rests (left side), front to back.
      const legs: { hy: number; fx: number; fy: number }[] = [{ hy: -8, fx: -38, fy: -30 }, { hy: 0, fx: -42, fy: -2 }, { hy: 8, fx: -38, fy: 26 }]
      const parts = [0, 1, 2].flatMap((pose) =>
        [-1, 1].flatMap((side) =>
          legs.map((l, j) => {
            // Tripod A: left front, right middle, left back; tripod B the others.
            const a = (j === 1) === (side > 0)
            const shift = pose === 0 ? 0 : (pose === 1) === a ? -12 : 12
            return part(`leg${side < 0 ? 'L' : 'R'}${j}${pose}`, capsule([side * 9, l.hy], [-side * l.fx, l.fy + shift], 3.2, 2), 'metal', 1, { lift: 4, pose })
          }),
        ),
      )
      return {
        breakStyle: 'bands',
        walk: [1, 2],
        parts: [
          ...parts,
          part('abdomen', capsule([0, 12], [0, 34], 14, 11), 'accent', 3, { lift: 7, details: [{ k: 'line', pts: [[-11, 20], [11, 20]] }, { k: 'line', pts: [[-10, 28], [10, 28]], minPx: 40 }] }),
          part('thorax', circle(0, -2, 11, 14), 'hull2', 4, { lift: 8, sphere: true }),
          ...sym(part('mandible', capsule([-5, -28], [-8, -42], 2.6, 1.2), 'metal', 4, { lift: 6 })),
          part('head', capsule([0, -12], [0, -26], 8.5, 7), 'hull', 5, {
            lift: 9,
            details: [{ k: 'lights', pts: [[-4, -24], [4, -24]], r: 1.6, tone: 'aid' }],
          }),
        ],
      }
    },
  },
}
