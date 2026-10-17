import { arcBand, capsule, circle, part, rimFacets, spline, sym, thick } from '../kit.ts'
import type { GroundModels } from '../ground.ts'
import type { Pt } from '../types.ts'

// The Swarm's ground units, seen from straight above, light from the top left. The Hive Nexus is a
// mound of dark chitin round a glowing violet core, ringed by pale plates, with tendrils spreading
// into the ground round it and a maw to the south (its door). The Shaper drone is a low crawler:
// three pairs of short legs, a pale thorax, mandibles, and a sac of resin glowing acid green.

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
}
