import { along, arcBand, box, capsule, circle, gait, part, rimFacets, spline, sym, thick } from '../kit.ts'
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
  // The Brood Chamber (4 × 4 tiles): a ribbed mound of resin round a warm brood pit of eggs, green
  // nutrient sacs, tendrils into the ground and a wide maw to the south that the packs crawl out of.
  's-g-brood': {
    w: 100,
    h: 100,
    spec: ({ tier }) => {
      const mound = lumps(0, -2, 44, 3.5, 12)
      const ribs = [-2.6, -2.05, -1.5, -1.0, -0.5, 0.0, 0.5].map((a, i) => {
        const p = (r: number): Pt => [Math.cos(a - 0.55) * r, -2 + Math.sin(a - 0.55) * r]
        return part(`rib${i}`, thick(spline([p(20), p(30), p(41)], 3), 6, 3), i % 2 ? 'hull2' : 'hull', 2, { lift: 6, slope: [Math.cos(a - 0.55) * 0.7, Math.sin(a - 0.55) * 0.7] })
      })
      const eggs: Pt[] = [[-6, -8], [5, -9], [-9, 2], [8, 1], [0, -1], [-2, 9], [7, 9]]
      return {
        breakStyle: 'pie',
        parts: [
          ...[0.9, 2.3, 3.9, 5.4].map((a, i) => part(`tendril${i}`, thick(spline([[Math.cos(a) * 34, Math.sin(a) * 34], [Math.cos(a + 0.12) * 42, Math.sin(a + 0.12) * 42], [Math.cos(a + 0.2) * 49, Math.sin(a + 0.2) * 49]], 3), 6, 1.5), 'metal', 0.6, { lift: 1.5 })),
          part('mound', mound, 'metal', 1, { lift: 4, facets: rimFacets(mound, 0, -2, 0.55, 0.7) }),
          ...ribs,
          ...[1.0, 2.2, 0.3].map((a, i) => part(`sac${i}`, circle(Math.cos(a + 1.6) * 33, Math.sin(a + 1.6) * 33, 4.5, 12), 'aid', 3, { lift: 4, sphere: true })),
          // The brood pit and its eggs.
          part('pit', circle(0, 0, 20, 24), 'dark', 3, { lift: 3, details: [{ k: 'line', pts: circle(0, 0, 17, 22) }] }),
          part('pool', circle(0, 0, 15, 22), 'aid', 4, { lift: 3.5, glow: true }),
          ...eggs.map(([x, y], i) => part(`egg${i}`, circle(x, y, 4, 12, 4.8), i % 2 ? 'hull2' : 'hull', 5, { lift: 5, sphere: true, details: [{ k: 'shape', pts: circle(x - 1, y - 1.4, 1.4, 8), tone: 'glow' }] })),
          // The wide maw to the south.
          part('maw', spline([[-22, 34], [0, 30], [22, 34], [18, 44], [0, 47], [-18, 44]] as Pt[], 3, true), 'dark', 3, {
            lift: 1,
            details: [{ k: 'lights', pts: [[-12, 40], [0, 42], [12, 40]], r: 1.4, tone: 'glow' }],
          }),
          // Tier 2: more nutrient sacs and a maw grown wider; tier 3: horns round the rim and a ring
          // of glowing eggs in a second pit.
          ...(tier >= 2
            ? [
                ...[3.6, 4.4, 5.6].map((a, i) => part(`sacT${i}`, circle(Math.cos(a) * 36, Math.sin(a) * 36 - 2, 4, 12), 'aid', 3.2, { lift: 5, sphere: true })),
                // Two side chambers swelling out of the mound, glowing through their skin.
                ...[-1, 1].flatMap((side) => [
                  part(`chamber${side < 0 ? 'L' : 'R'}`, circle(side * 36, 16, 10, 18), 'hull', 3.3, { lift: 6, sphere: true, details: [{ k: 'line', pts: circle(side * 36, 16, 7, 14) }] }),
                  part(`chamberGlow${side < 0 ? 'L' : 'R'}`, circle(side * 36, 16, 4, 12), 'aid', 3.4, { lift: 6.5, glow: true }),
                ]),
                part('mawWide', spline([[tier >= 3 ? -34 : -28, 33], [0, 28], [tier >= 3 ? 34 : 28, 33], [tier >= 3 ? 28 : 23, 45], [0, 48], [tier >= 3 ? -28 : -23, 45]] as Pt[], 3, true), 'dark', 2.95, { lift: 1 }),
              ]
            : []),
          ...(tier >= 3
            ? [
                ...[-2.7, -2.0, -1.3, -0.6, 0.1].map((a, i) => part(`horn${i}`, capsule([Math.cos(a) * 38, -2 + Math.sin(a) * 38], [Math.cos(a) * 50, -2 + Math.sin(a) * 50], 3, 0.8), 'accent', 3, { lift: 9 })),
                part('pit2', circle(0, -26, 8, 18), 'dark', 4, { lift: 6 }),
                part('pool2', circle(0, -26, 6, 16), 'glow', 5, { lift: 6.5, glow: true }),
              ]
            : []),
        ],
      }
    },
  },
  // The Vehicle Nest (5 × 5 tiles): a great shell of chitin plates round a violet birthing pool, a
  // half-grown beast curled in it, spines along the shell's rim, tendrils into the ground, and a maw
  // to the south wide enough for the beasts it grows.
  's-g-nest': {
    w: 100,
    h: 100,
    spec: ({ tier }) => {
      const mound = lumps(0, 0, 46, 3, 13)
      const plates = Array.from({ length: 8 }, (_, i) => {
        const a0 = (i / 8) * Math.PI * 2 - Math.PI / 2 + 0.1 + Math.PI / 8
        const a1 = a0 + Math.PI / 4 - 0.2
        const am = (a0 + a1) / 2
        return part(`plate${i}`, arcBand(0, 0, 24, 41, a0, a1, 6), i % 2 ? 'hull2' : 'hull', 2, {
          lift: 7,
          slope: [Math.cos(am) * 0.8, Math.sin(am) * 0.8],
          details: [{ k: 'line', pts: arcBand(0, 0, 28, 37, a0 + 0.07, a1 - 0.07, 4).slice(0, 5) }],
        })
      })
      // The plates leave the south open: the maw.
      const shell = plates.filter((_, i) => i !== 3)
      const spines = [-2.4, -1.9, -1.2, -0.7, 0.1, 0.6, 2.6, 3.1].map((a, i) => part(`spine${i}`, capsule([Math.cos(a) * 40, Math.sin(a) * 40], [Math.cos(a) * 49, Math.sin(a) * 49], 2.6, 0.8), 'accent', 3, { lift: 9 }))
      return {
        breakStyle: 'pie',
        parts: [
          ...[0.2, 1.1, 2.0, 3.4, 4.3, 5.3].map((a, i) => part(`tendril${i}`, thick(spline([[Math.cos(a) * 36, Math.sin(a) * 36], [Math.cos(a - 0.15) * 44, Math.sin(a - 0.15) * 44], [Math.cos(a - 0.22) * 50, Math.sin(a - 0.22) * 50]], 3), 7, 1.5), 'metal', 0.6, { lift: 1.5 })),
          part('mound', mound, 'metal', 1, { lift: 4, facets: rimFacets(mound, 0, 0, 0.6, 0.7) }),
          ...shell,
          ...spines,
          // The birthing pool, violet, with a half-grown beast curled in it.
          part('poolRing', circle(0, 0, 22, 26), 'dark', 3, { lift: 3 }),
          part('pool', circle(0, 0, 18, 26), 'glow', 4, { lift: 3.5, glow: true }),
          part('beast', thick(spline([[-9, -6], [2, -11], [10, -2], [6, 8], [-4, 7]], 4), 9, 4), 'hull2', 5, { lift: 6, details: [{ k: 'line', pts: [[-2, -9], [9, 1]] }] }),
          ...[0.6, 2.5, 4.0].map((a, i) => part(`sac${i}`, circle(Math.cos(a) * 31, Math.sin(a) * 31 - 8, 4.5, 12), 'aid', 3, { lift: 8, sphere: true })),
          // The wide maw to the south.
          part('maw', spline([[-26, 32], [0, 27], [26, 32], [22, 44], [0, 48], [-22, 44]] as Pt[], 3, true), 'dark', 3, {
            lift: 1,
            details: [{ k: 'lights', pts: [[-14, 39], [0, 41], [14, 39]], r: 1.5, tone: 'glow' }],
          }),
          // Tier 2: the maw grown wider and spines on the plates; tier 3: a crown of great horns and
          // a second beast stirring in the pool.
          ...(tier >= 2
            ? [
                part('mawWide', spline([[tier >= 3 ? -38 : -32, 31], [0, 25], [tier >= 3 ? 38 : 32, 31], [tier >= 3 ? 32 : 27, 45], [0, 49], [tier >= 3 ? -32 : -27, 45]] as Pt[], 3, true), 'dark', 2.95, { lift: 1 }),
                ...[-2.05, -1.0, 0.35, 2.85].map((a, i) => part(`spineT${i}`, capsule([Math.cos(a) * 30, Math.sin(a) * 30], [Math.cos(a) * 42, Math.sin(a) * 42], 2.4, 0.7), 'accent', 3.5, { lift: 10 })),
              ]
            : []),
          ...(tier >= 3
            ? [
                ...[-2.6, -1.6, -0.55, 0.45].map((a, i) => part(`crown${i}`, capsule([Math.cos(a) * 36, Math.sin(a) * 36], [Math.cos(a) * 52, Math.sin(a) * 52], 4.5, 1), 'hull2', 4, { lift: 12 })),
                part('beast2', thick(spline([[8, 8], [-2, 12], [-10, 6], [-8, -2]], 4), 6, 3), 'hull', 5.5, { lift: 6.5 }),
              ]
            : []),
        ],
      }
    },
  },
  // The Racer beast (tier 1, Vehicle Nest): a long-legged runner, its back plated in purple with a
  // double row of barbed spine darts, a narrow head with jaws, a whip of a tail. It trots on four
  // legs (poses 1 and 2: a front leg and the other side's back leg forward together).
  's-g-racer': {
    w: 72,
    h: 100,
    spec: () => {
      // Each leg's hip (its y; x is 10 either side) and where its foot rests (left side).
      const legs = [{ hy: -14, fx: -30, fy: -34 }, { hy: 16, fx: -30, fy: 36 }]
      const parts = [0, 1, 2].flatMap((pose) =>
        [-1, 1].flatMap((side) =>
          legs.flatMap((l, j) => {
            // Diagonal pairs: left front with right back, right front with left back.
            const a = (j === 0) === (side < 0)
            const fy = l.fy + (pose === 0 ? 0 : (pose === 1) === a ? -14 : 14)
            const fx = -side * l.fx
            const name = `${side < 0 ? 'L' : 'R'}${j}${pose}`
            return [
              part(`leg${name}`, capsule([side * 10, l.hy], [fx, fy], 4.2, 2.4), 'metal', 1, { lift: 5, pose }),
              part(`claw${name}`, circle(fx, fy, 3.2, 8), 'dark', 2, { lift: 5, pose }),
            ]
          }),
        ),
      )
      return {
        breakStyle: 'bands',
        walk: [1, 2],
        parts: [
          ...parts,
          part('tail', capsule([0, 24], [0, 48], 4.5, 1.5), 'hull2', 2, { lift: 6 }),
          part('body', capsule([0, -18], [0, 24], 13, 10), 'hull2', 3, { lift: 8 }),
          part('back', capsule([0, -10], [0, 22], 10, 8), 'accent', 4, {
            lift: 10,
            details: [{ k: 'line', pts: [[-9, 0], [9, 0]] }, { k: 'line', pts: [[-8, 12], [8, 12]], minPx: 40 }],
          }),
          ...sym(part('spineA', capsule([-5, -6], [-10, 6], 2.4, 1), 'trim', 5, { lift: 12 })),
          ...sym(part('spineB', capsule([-5, 6], [-10, 18], 2.4, 1), 'trim', 5, { lift: 12 })),
          ...sym(part('jaw', capsule([-4, -40], [-7, -49], 2.2, 1), 'metal', 4, { lift: 8 })),
          part('head', capsule([0, -22], [0, -42], 8, 5), 'hull', 5, {
            lift: 10,
            details: [{ k: 'lights', pts: [[-4, -36], [4, -36]], r: 1.5, tone: 'aid' }],
          }),
        ],
      }
    },
  },
  // The Spewer (tier 2, Brood Chamber): a squat six-legged beast with a heavy purple carapace, a
  // wide maw at the front glowing with acid, and acid glands on its sides. Tripod gait.
  's-g-spewer': {
    w: 96,
    h: 100,
    spec: () => ({
      breakStyle: 'bands',
      walk: [1, 2],
      parts: [
        ...gait('leg', [{ hx: 14, hy: -14, fx: -42, fy: -32 }, { hx: 16, hy: 2, fx: -46, fy: 2 }, { hx: 14, hy: 18, fx: -42, fy: 34 }], 10, 5, 'metal', 'dark'),
        part('body', capsule([0, -16], [0, 30], 22, 18), 'hull2', 3, { lift: 8 }),
        part('shell', capsule([0, -6], [0, 30], 18, 15), 'accent', 4, {
          lift: 11,
          details: [{ k: 'line', pts: [[-16, 6], [16, 6]] }, { k: 'line', pts: [[-15, 18], [15, 18]] }, { k: 'line', pts: [[0, -6], [0, 40]], minPx: 50 }],
        }),
        ...sym(part('gland', circle(-19, 0, 6, 12), 'hull', 5, { lift: 12, sphere: true, details: [{ k: 'lights', pts: [[-19, 0]], r: 2.4, tone: 'aid' }] })),
        part('head', capsule([0, -22], [0, -36], 14, 11), 'hull', 5, { lift: 10 }),
        part('maw', [[-11, -38], [11, -38], [8, -47], [-8, -47]], 'dark', 6, { lift: 10, details: [{ k: 'lights', pts: [[-4, -43], [0, -44], [4, -43]], r: 1.8, tone: 'aid' }] }),
      ],
    }),
  },
  // The Spore carrier (tier 2, Vehicle Nest): a lumbering four-legged beast with a broad plated back
  // and a spore sac turret on it that turns on its own; a small head low at the front. It trots.
  's-g-spores': {
    w: 90,
    h: 100,
    spec: () => ({
      breakStyle: 'bands',
      walk: [1, 2],
      parts: [
        ...gait('leg', [{ hx: 16, hy: -18, fx: -40, fy: -32 }, { hx: 16, hy: 22, fx: -40, fy: 32 }], 10, 6, 'metal', 'dark'),
        part('tail', capsule([0, 30], [0, 48], 6, 2), 'hull2', 2, { lift: 6 }),
        part('body', capsule([0, -22], [0, 30], 26, 22), 'hull2', 3, { lift: 9 }),
        part('back', capsule([0, -14], [0, 28], 22, 18), 'accent', 4, {
          lift: 12,
          details: [{ k: 'line', pts: [[-20, -12], [20, -12]] }, { k: 'line', pts: [[-20, 18], [20, 18]] }],
        }),
        ...sym(part('vent', circle(-17, 22, 4, 10), 'hull', 5, { lift: 13, details: [{ k: 'lights', pts: [[-17, 22]], r: 1.6, tone: 'aid' }] })),
        part('head', capsule([0, -30], [0, -46], 9, 6), 'hull', 5, { lift: 10, details: [{ k: 'lights', pts: [[-4, -42], [4, -42]], r: 1.5, tone: 'aid' }] }),
      ],
    }),
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
  // The Ravager (tier 3, Brood Chamber): a great beast of pale armour plates over dark chitin on four
  // thick legs, glowing bile sacs either side of its throat, a heavy head with tusks, spines down its
  // back. It lumbers on diagonal pairs (poses 1 and 2).
  's-g-ravager': {
    w: 80,
    h: 100,
    spec: () => {
      const legs = [{ hy: -14, fx: 35, fy: -30, kx: 30 }, { hy: 18, fx: 33, fy: 36, kx: 30 }]
      const legParts = [0, 1, 2].flatMap((pose) =>
        [-1, 1].flatMap((side) =>
          legs.flatMap((l, j) => {
            // Diagonal pairs: left front with right back, right front with left back.
            const a = (j === 0) === (side < 0)
            const fy = l.fy + (pose === 0 ? 0 : (pose === 1) === a ? -11 : 11)
            const ky = (l.hy + fy) / 2
            const n = `${side < 0 ? 'L' : 'R'}${j}${pose}`
            return [
              part(`claw${n}`, circle(side * l.fx, fy, 5, 9), 'dark', 1, { lift: 3, pose }),
              part(`lower${n}`, capsule([side * l.kx, ky], [side * l.fx, fy], 5.4, 4), 'metal', 1.2, { lift: 6, pose }),
              part(`upper${n}`, capsule([side * 14, l.hy], [side * l.kx, ky], 8, 6.4), 'hull2', 1.4, { lift: 11, pose }),
            ]
          }),
        ),
      )
      return {
        breakStyle: 'bands',
        walk: [1, 0, 2, 0],
        parts: [
          ...legParts,
          part('tail', thick([[0, 28], [2, 40], [0, 49]], 16, 3), 'metal', 2, { lift: 8 }),
          part('body', capsule([0, -18], [0, 30], 22, 18), 'metal', 3, { lift: 12 }),
          ...plates([[-12, 22, 12], [2, 24, 12], [16, 21, 11], [29, 15, 9]], 4),
          ...sym(part('spineL', capsule([-6, -2], [-11, 10], 2.6, 1), 'accent', 5, { lift: 17 })),
          ...sym(part('spine2L', capsule([-6, 12], [-11, 24], 2.6, 1), 'accent', 5, { lift: 17 })),
          ...sym(part('sacL', circle(-13, -24, 7, 14), 'aid', 5, { lift: 13, sphere: true })),
          ...sym(part('tuskL', capsule([-9, -40], [-15, -50], 3.6, 1.2), 'hull', 5, { lift: 13 })),
          part('head', capsule([0, -26], [0, -44], 13, 9), 'hull', 6, {
            lift: 15,
            facets: [{ pts: [[-13, -26], [0, -26], [0, -44], [-9, -44]], slope: [-0.5, -0.2] }, { pts: [[13, -26], [0, -26], [0, -44], [9, -44]], slope: [0.5, -0.2] }],
            details: [{ k: 'lights', pts: [[-6, -38], [6, -38], [-8, -33], [8, -33]], r: 1.6, tone: 'glass' }, { k: 'shape', pts: box(0, -30, 4, 8), tone: 'accent' }],
          }),
        ],
      }
    },
  },
  // The Behemoth (tier 3, Vehicle Nest): a huge, slow beast, overlapping armour plates over a broad
  // dark body, six stubby legs, a small horned head, rows of glowing acid-green glands down its
  // flanks; the living bile mortar on its back is its turret and turns on its own. It plods on
  // alternate tripods (poses 1 and 2).
  's-g-behemoth': {
    w: 94,
    h: 100,
    spec: () => {
      const legs = [{ hy: -18, fy: -28 }, { hy: 6, fy: 6 }, { hy: 28, fy: 38 }]
      const legParts = [0, 1, 2].flatMap((pose) =>
        [-1, 1].flatMap((side) =>
          legs.flatMap((l, j) => {
            const a = (j === 1) === (side > 0)
            const fy = l.fy + (pose === 0 ? 0 : (pose === 1) === a ? -8 : 8)
            const n = `${side < 0 ? 'L' : 'R'}${j}${pose}`
            return [
              part(`foot${n}`, circle(side * 39, fy, 7.5, 12), 'hull2', 1, { lift: 3, pose, details: [{ k: 'lights', pts: [[side * 39 - 3.5, fy - 6], [side * 39 + 3.5, fy - 6], [side * 43, fy - 3]], r: 1.4, tone: 'dark', minPx: 50 }] }),
              part(`leg${n}`, capsule([side * 18, l.hy], [side * 39, fy], 9.5, 7), 'metal', 1.3, { lift: 9, pose }),
              part(`plateLeg${n}`, capsule([side * 22, l.hy], [side * 32, l.hy + (fy - l.hy) * 0.7], 6, 4.5), 'hull2', 1.5, { lift: 11, pose }),
            ]
          }),
        ),
      )
      return {
        breakStyle: 'bands',
        walk: [1, 0, 2, 0],
        parts: [
          ...legParts,
          part('tail', thick([[0, 36], [-2, 44], [0, 50]], 18, 4), 'metal', 2, { lift: 8 }),
          part('body', capsule([0, -22], [0, 32], 26, 22), 'metal', 3, {
            lift: 12,
            details: [
              { k: 'lights', pts: along([-23, -12], [-21, 26], 5), r: 2, tone: 'aid' },
              { k: 'lights', pts: along([23, -12], [21, 26], 5), r: 2, tone: 'aid' },
            ],
          }),
          ...plates([[-21, 22, 12], [-9, 24, 10], [21, 23, 12], [33, 18, 10]], 4),
          // The collar the mortar is grown into.
          part('collar', circle(0, 6, 21, 22), 'hull2', 4.5, { lift: 14, details: [{ k: 'lights', pts: [[-17, 6], [17, 6], [0, -11], [0, 23]], r: 1.8, tone: 'accent' }] }),
          ...sym(part('hornL', capsule([-7, -40], [-14, -48], 3.2, 1), 'hull', 5, { lift: 13 })),
          part('head', capsule([0, -30], [0, -44], 12, 8), 'hull', 6, {
            lift: 14,
            facets: [{ pts: [[-12, -30], [0, -30], [0, -44], [-8, -44]], slope: [-0.5, -0.2] }, { pts: [[12, -30], [0, -30], [0, -44], [8, -44]], slope: [0.5, -0.2] }],
            details: [{ k: 'lights', pts: [[-5, -39], [5, -39]], r: 1.6, tone: 'glass' }],
          }),
        ],
      }
    },
  },
}

/** Armour plates across a beast's back, front to back: each [y, half width, depth], a pale arched
 * plate in two halves (each lit on its own) with a violet band, lifted over the one in front. */
function plates(rows: [number, number, number][], z: number) {
  return rows.flatMap(([y, hw, d], i) =>
    sym(
      part(`plate${i}L`, [[0, y - d / 2 - 2], [-hw * 0.6, y - d / 2], [-hw, y + d / 4], [-hw * 0.82, y + d / 2], [0, y + d / 2 + 2]], 'hull', z + i * 0.1, {
        lift: 14 + i,
        slope: [-0.5, -0.25],
        details: [{ k: 'shape', pts: [[0, y + d / 2 - 1], [-hw * 0.75, y + d / 2 - 2], [-hw * 0.82, y + d / 2], [0, y + d / 2 + 2]], tone: 'accent' }],
      }),
    ),
  )
}
