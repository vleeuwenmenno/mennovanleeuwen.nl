import { along, capsule, circle, halfHull, part, spline, sym, thick, turn, turnPart } from './kit.ts'
import type { ModelDef } from './spec.ts'
import type { Detail, Part, Pt, Tone } from './types.ts'

// The Swarm: a concept for a future third faction, not used in battle. Organic, insect-like curves
// instead of plates, bone-tan shells with violet accents, a glowing sensor eye and violet engine
// light, built from arcs and tapering segments rather than wedges. These were the Confederacy's
// first designs; they are kept here as they were, one for each droid unit (same ids, same box and
// hardpoints), and the Codex shows them under "Swarm (concept)".

/**
 * A crescent: points along an elliptical arc (centre cx, cy, radii rx, ry) from angle a0 to a1, and
 * back along a thinner arc inside it, the band tapering from `t0` of the radius at the start to
 * `t1` at the end.
 */
function crescent(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, t0: number, t1: number, n = 14): Pt[] {
  const outer: Pt[] = []
  const inner: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const a = a0 + (a1 - a0) * t
    const k = 1 - (t0 + (t1 - t0) * t)
    outer.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry])
    inner.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k])
  }
  return [...outer, ...inner.reverse()]
}

const deg = (d: number) => (d * Math.PI) / 180

/**
 * Mantis droid fighter: a beaked head with one violet eye, a segmented tail and two hooked claw
 * wings that sweep forward and down. The lower claws snap off as it is shot up.
 */
export const fighter: ModelDef = () => {
  const cx = -3
  const cy = 10
  const R = 41
  const upper = crescent(cx, cy, R, R, deg(-99), deg(-172), 0.34, 0.2, 12)
  const lower = crescent(cx, cy, R, R, deg(-172), deg(-230), 0.2, 0.02, 9)
  // A joint across the claw at angle a: a dark band, as the droids' segmented limbs have.
  const joint = (a: number, k0: number, k1: number): Pt[] => {
    const at = (r: number, d: number): Pt => [cx + Math.cos(deg(a + d)) * r, cy + Math.sin(deg(a + d)) * r]
    return [at(R * 1.01, -1.6), at(R * 1.01, 1.6), at(R * k1, 1.6), at(R * k0, -1.6)]
  }
  const parts: Part[] = [
    ...sym(part('claw', upper, 'hull', 1, {
      slope: [-0.4, -0.1],
      lift: 0.8,
      details: [
        { k: 'shape', pts: crescent(cx, cy, R * 0.88, R * 0.88, deg(-108), deg(-168), 0.05, 0.05, 10), tone: 'accent' },
        { k: 'shape', pts: joint(-128, 0.7, 0.7), tone: 'dark' },
        { k: 'shape', pts: joint(-152, 0.74, 0.74), tone: 'dark' },
      ],
    }), { slope: [0.4, -0.1] }),
    ...sym(part('hook', lower, 'hull2', 1, {
      slope: [-0.4, 0.1],
      lift: 0.8,
      detach: { hull: 0.4 },
      details: [{ k: 'shape', pts: joint(-196, 0.8, 0.8), tone: 'dark' }, { k: 'shape', pts: crescent(cx, cy, R * 0.9, R * 0.9, deg(-176), deg(-212), 0.05, 0.03, 6), tone: 'accent' }],
    }), { slope: [0.4, 0.1], detach: { hull: 0.24 } }),
    // Blaster barrels at the crest of each claw.
    ...sym(part('gun', [[-28.8, -30], [-27.2, -30], [-26.4, -20], [-29.6, -21]], 'dark', 2, { detach: { death: true } })),
    // The shoulder that carries the claws, behind the head.
    ...sym(part('shoulder', [[0, -26], [-11, -30], [-14, -24], [-10, -13], [0, -11]], 'metal', 1.5, { slope: [-0.4, 0], lift: 0.6, details: [{ k: 'line', pts: [[-6, -28], [-6, -12]] }] })),
    ...sym(part('tail', [[0, -6], [-6.5, -4], [-5.2, 12], [-3.4, 26], [-2.2, 33], [0, 34]], 'hull', 2, {
      slope: [-0.5, 0],
      details: [
        { k: 'line', pts: [[0, 4], [-6, 4]] },
        { k: 'line', pts: [[0, 13], [-5.2, 13]] },
        { k: 'line', pts: [[0, 22], [-4, 22]] },
        { k: 'shape', pts: [[-1, 6], [-3, 6], [-2.6, 11], [-1, 11]], tone: 'accent' },
      ],
    })),
    ...sym(part('head', [[0, -50], [-2.6, -41], [-5.6, -28], [-8.5, -17], [-7, -8], [0, -6]], 'hull', 3, {
      slope: [-0.5, 0],
      lift: 1,
      details: [
        { k: 'line', pts: [[-2.4, -38], [-6.5, -20]] },
        { k: 'shape', pts: [[0, -47], [-1.2, -41], [-1.2, -33], [0, -32]], tone: 'hull2' },
      ],
    })),
    part('eye', circle(0, -15, 4, 16), 'glass', 4, { lift: 0.6, details: [{ k: 'lights', pts: [[0, -15]], r: 2 }] }),
    part('engine', circle(0, 33, 3.2, 12), 'dark', 3, { engine: 0, details: [{ k: 'lights', pts: [[0, 33.4]], r: 1.6 }] }),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Shared droid parts ------------------------------------------------------------------------------

/** A sensor eye: a violet lens with a glowing pupil. */
const eye = (id: string, x: number, y: number, r: number, z: number, more: Partial<Part> = {}): Part =>
  part(id, circle(x, y, r, 16), 'glass', z, { lift: 0.6, details: [{ k: 'lights', pts: [[x, y]], r: r * 0.48 }], ...more })

/**
 * One vertebra of a segmented body, centred on (0, y), `h` long and `w` half-wide: a left and a right
 * shell (each lit on its own) with a violet seam down its side.
 */
function vertebra(id: string, y: number, h: number, w: number, tone: Tone, z: number, more: Partial<Part> = {}, stripe = true): Part[] {
  const rows: [number, number][] = [[y - h / 2, w * 0.56], [y - h * 0.32, w * 0.93], [y, w], [y + h * 0.32, w * 0.93], [y + h / 2, w * 0.56]]
  const details: Detail[] = stripe ? [{ k: 'shape', pts: [[-w * 0.5, y - h * 0.28], [-w * 0.72, y - h * 0.24], [-w * 0.72, y + h * 0.24], [-w * 0.5, y + h * 0.28]], tone: 'accent' }] : []
  return sym(part(id, halfHull(rows), tone, z, { slope: [-0.5, 0], lift: 1, details, ...more }))
}

/**
 * A droid engine pod: a rounded casing with a violet nozzle at the back, shaded as a cylinder.
 */
function thruster(id: string, x: number, y0: number, y1: number, w: number, engine: number | undefined, z: number, more: Partial<Part> = {}): Part {
  const h = w / 2
  const half = (s: number): Pt[] => [[x, y0], [x + s * h * 0.55, y0 + h * 0.15], [x + s * h, y0 + h], [x + s * h * 0.95, y1 - h * 0.6], [x + s * h * 0.6, y1], [x, y1]]
  const r = h * 0.62
  const details: Detail[] = [
    { k: 'shape', pts: [[x - h, y0 + (y1 - y0) * 0.35], [x + h, y0 + (y1 - y0) * 0.35], [x + h, y0 + (y1 - y0) * 0.45], [x - h, y0 + (y1 - y0) * 0.45]], tone: 'dark' },
    { k: 'shape', pts: circle(x, y1 - r - 0.3, r, 12), tone: 'dark' },
  ]
  if (engine !== undefined) details.push({ k: 'lights', pts: [[x, y1 - r - 0.2]], r: r * 0.55 })
  return part(id, [...half(-1), ...half(1).reverse()], 'hull2', z, { lift: 0.8, engine, facets: [{ pts: half(-1), slope: [-0.5, 0] }, { pts: half(1), slope: [0.5, 0] }], details, ...more })
}

/** A jointed limb along `pts` (shoulder, knees, tip), tapering: the joints dark. */
function limb(id: string, pts: Pt[], w0: number, w1: number, tone: Tone, z: number, more: Partial<Part> = {}): Part {
  const joints: Detail[] = pts.slice(1, -1).map(([x, y]) => ({ k: 'shape', pts: circle(x, y, Math.max(w0, w1) * 0.42, 8), tone: 'dark' }))
  return part(id, thick(pts, w0, w1), tone, z, { lift: 0.8, ...more, details: [...joints, ...(more.details ?? [])] })
}

/** A closed organic outline through control points. */
const blobby = (pts: Pt[], n = 4) => spline(pts, n, true)

// --- Strike craft ------------------------------------------------------------------------------------

/**
 * Gnat guard droid: the foundry's own defense wing. A tiny teardrop head ringed in gold round its eye
 * (only the defense wing wears it) and two sickle wings hanging down, a blaster at each tip.
 */
export const picket: ModelDef = () => {
  const parts: Part[] = [
    ...sym(part('wing', crescent(-2, 2, 42, 40, deg(-146), deg(-218), 0.3, 0.04, 12), 'hull', 1, {
      slope: [-0.4, 0.05],
      lift: 0.8,
      details: [{ k: 'shape', pts: crescent(-2, 2, 39, 37, deg(-156), deg(-205), 0.08, 0.04, 8), tone: 'accent' }, { k: 'shape', pts: crescent(-2, 2, 42.5, 40.5, deg(-176), deg(-183), 0.3, 0.3, 2), tone: 'dark' }],
    }), { slope: [0.4, 0.05] }),
    ...sym(part('gun', [[-34.6, 26], [-33, 25], [-31.6, 36], [-33.6, 36.6]], 'dark', 1.6, { detach: { death: true } })),
    ...sym(part('shoulder', capsule([-6, -12], [-32, -20], 4, 3), 'metal', 1.4, { lift: 0.6 })),
    ...sym(part('head', halfHull([[-46, 0.5], [-40, 4.5], [-30, 8], [-18, 10.5], [-4, 11], [10, 9], [22, 5.5], [30, 2]]), 'hull', 2, {
      slope: [-0.5, 0],
      lift: 1,
      details: [{ k: 'shape', pts: [[0, -44], [-1.6, -38], [-2, -28], [0, -27]], tone: 'accent' }, { k: 'line', pts: [[-9, 10], [0, 14]] }, { k: 'line', pts: [[-6, 20], [0, 22]] }],
    })),
    part('ring', circle(0, -8, 9.6, 22), 'trim', 3, { holes: [circle(0, -8, 6.4, 18)], lift: 0.9 }),
    eye('eye', 0, -8, 5.4, 3.2),
    part('engine', circle(0, 30, 3.6, 12), 'dark', 2.5, { engine: 0, details: [{ k: 'lights', pts: [[0, 30.4]], r: 1.8 }] }),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Locust bomber: a segmented body with a beaked head, swept leaf wings and, slung either side of it,
 * two fat bomb pods with violet warheads glowing at their tails. The pods are what makes it a bomber.
 */
export const bomber: ModelDef = () => {
  const parts: Part[] = [
    ...sym(part('wing', blobby([[-8, -24], [-24, -21], [-41, -9], [-47, 4], [-42, 9], [-26, 3], [-10, -6]]), 'hull', 1, {
      slope: [-0.35, -0.1],
      lift: 0.8,
      details: [
        { k: 'shape', pts: blobby([[-14, -19], [-27, -16], [-40, -6], [-41, -3], [-28, -10], [-14, -15]]), tone: 'accent' },
        { k: 'shape', pts: thick([[-30, -16], [-27, -3]], 2), tone: 'dark' },
      ],
    }), { slope: [0.35, -0.1] }),
    ...sym(part('strut', capsule([-6, 8], [-12, 10], 2.6), 'dark', 1.5)),
    ...sym(part('pod', blobby([[-17, -6], [-24, 0], [-26, 14], [-23, 28], [-17, 33], [-11, 28], [-8.6, 14], [-10, 0]]), 'hull2', 2, {
      lift: 1.2,
      detach: { hull: 0.36 },
      facets: [{ pts: [[-17, -6], [-24, 0], [-26, 14], [-23, 28], [-17, 33]], slope: [-0.5, 0] }],
      details: [
        { k: 'shape', pts: thick([[-25.6, 8], [-17, 9], [-9, 8]], 2), tone: 'dark' },
        { k: 'shape', pts: thick([[-25, 20], [-17, 21], [-10, 20]], 2), tone: 'dark' },
        { k: 'shape', pts: blobby([[-17, 25], [-21, 28], [-17, 32], [-13, 28]]), tone: 'glass' },
        { k: 'lights', pts: [[-17, 28.6]], r: 1.4 },
        { k: 'shape', pts: [[-12, 0], [-10.6, 1], [-10, 6], [-11.6, 6]], tone: 'accent' },
      ],
    }), { detach: { hull: 0.22 }, facets: [{ pts: [[17, -6], [24, 0], [26, 14], [23, 28], [17, 33]], slope: [0.5, 0] }] }),
    ...sym(part('body', halfHull([[-44, 1], [-38, 4], [-28, 7], [-16, 8.6], [-4, 8.8], [10, 8], [22, 6], [32, 3.6], [38, 1.6]]), 'hull', 3, {
      slope: [-0.5, 0],
      details: [
        { k: 'line', pts: [[0, -8], [-8.8, -8]] },
        { k: 'line', pts: [[0, 4], [-8.6, 4]] },
        { k: 'line', pts: [[0, 16], [-7.4, 16]] },
        { k: 'line', pts: [[0, 27], [-4.8, 27]] },
        { k: 'shape', pts: [[-2.4, -6], [-5, -6], [-5, 2], [-2.4, 2]], tone: 'accent' },
        { k: 'shape', pts: [[-2.4, 6], [-4.6, 6], [-4.4, 14], [-2.4, 14]], tone: 'accent' },
      ],
    })),
    ...sym(part('head', [[0, -50], [-3, -44], [-6.8, -32], [-6.4, -22], [0, -20]], 'hull2', 4, { slope: [-0.5, -0.05], lift: 1, details: [{ k: 'line', pts: [[-2.6, -42], [-5.6, -28]] }] })),
    eye('eye', 0, -29, 3.2, 5),
    part('engine', circle(0, 37, 3.4, 12), 'dark', 2.5, { engine: 0, details: [{ k: 'lights', pts: [[0, 37.4]], r: 1.7 }] }),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Weaver repair droid: a spindly spider of a welder. A ribbed abdomen, a small head with its eye, and
 * three thin jointed legs a side; the front pair reach forward with welding torches glowing at their
 * tips.
 */
export const repair: ModelDef = () => {
  const torch = (x: number, y: number): Detail => ({ k: 'lights', pts: [[x, y]], r: 1.1, tone: 'ember' })
  const parts: Part[] = [
    ...sym(limb('legF', [[-5, -18], [-23, -30], [-19.5, -46]], 4.4, 2.2, 'metal', 1, { detach: { hull: 0.3 }, details: [torch(-19.4, -47)] }), { detach: { hull: 0.18 } }),
    ...sym(limb('legM', [[-7, -4], [-29, -12], [-36.5, 4]], 4, 2, 'metal', 1, { detach: { death: true }, details: [torch(-36.6, 5)] })),
    ...sym(limb('legB', [[-7, 12], [-27, 21], [-28, 39]], 4, 2, 'metal', 1, { detach: { death: true } })),
    ...sym(part('plate', thick([[-6.5, -17], [-20, -27.6]], 4.2, 3), 'hull', 1.5, { lift: 0.6, details: [{ k: 'shape', pts: thick([[-9, -18.6], [-18, -25.6]], 1.2), tone: 'accent' }] })),
    ...sym(part('abdomen', halfHull([[-6, 3], [-2, 7.6], [6, 10], [16, 10.6], [26, 8.6], [32, 5.2], [36, 1.6]]), 'hull', 2, {
      slope: [-0.5, 0.05],
      lift: 1,
      details: [
        { k: 'line', pts: [[0, 4], [-9.6, 4]] },
        { k: 'line', pts: [[0, 14], [-10.6, 14]] },
        { k: 'line', pts: [[0, 24], [-9, 24]] },
        { k: 'shape', pts: [[-3, 6], [-6.4, 6], [-6.6, 12], [-3, 12]], tone: 'accent' },
        { k: 'shape', pts: [[-3, 16], [-6.6, 16], [-6, 22], [-3, 22]], tone: 'accent' },
      ],
    })),
    ...sym(part('head', halfHull([[-34, 1], [-30, 5], [-22, 7.6], [-14, 7], [-8, 4.6], [-4, 3]]), 'hull2', 3, { slope: [-0.5, -0.05], lift: 1.2, details: [{ k: 'line', pts: [[-5, -30], [-7, -18]] }] })),
    eye('eye', 0, -22, 3.6, 4),
    part('engine', circle(0, 39, 3.4, 12), 'dark', 1.8, { engine: 0, details: [{ k: 'lights', pts: [[0, 39.4]], r: 1.7 }] }),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Gunship -----------------------------------------------------------------------------------------

/**
 * Trident gunship: a round armoured thorax with its eye, and three segmented blaster arms, one
 * forward and two raking back, each ending in a twin-barrelled gun pod. A three-pointed star where
 * every other droid ship is long.
 */
export const gunship: ModelDef = ({ h }) => {
  const parts: Part[] = []
  // The two rear arms, drawn for the left one.
  const arm: Pt[] = [[-9, 6], [-24, 14.6], [-39, 23.4]]
  parts.push(
    ...sym(limb('arm', arm, 8, 6, 'hull', 1, { slope: [-0.3, 0.2], details: [{ k: 'shape', pts: thick([[-12, 9.4], [-21.4, 14.4]], 2.2), tone: 'accent' }, { k: 'shape', pts: thick([[-27, 18.4], [-36, 23.4]], 1.8), tone: 'accent' }] }), { slope: [0.3, 0.2] }),
    ...sym(part('podGun', thick([[-41, 25.6], [-49, 30.4]], 1.4), 'dark', 1.6, { detach: { death: true } })),
    ...sym(part('podGun2', thick([[-38.8, 27.8], [-46.6, 32.6]], 1.4), 'dark', 1.6, { detach: { death: true } })),
    ...sym(part('pod', blobby([[-35, 19], [-41, 21.4], [-44, 27], [-40, 30], [-35, 27]]), 'hull2', 2, { lift: 0.8, detach: { hull: 0.36 }, details: [{ k: 'lights', pts: [[-39.4, 25]], r: 0.9, tone: 'glow' }] }), { detach: { hull: 0.22 } }),
    ...sym(part('neck', [[0, -10], [-4.6, -12], [-4, -30], [-2.6, -38], [0, -39]], 'hull', 1, { slope: [-0.5, 0], lift: 0.8, details: [{ k: 'shape', pts: [[-1, -16], [-2.8, -16], [-2.4, -30], [-1, -30]], tone: 'accent' }, { k: 'line', pts: [[0, -24], [-4.2, -24]] }] })),
    part('gunF', thick([[-1.8, -36], [-1.8, -h / 2 + 0.6]], 1.6), 'dark', 1.8, { detach: { death: true } }),
    part('gunF2', thick([[1.8, -36], [1.8, -h / 2 + 0.6]], 1.6), 'dark', 1.8, { detach: { death: true } }),
    part('collar', blobby([[0, -40], [-5.4, -37], [-5, -32], [0, -31], [5, -32], [5.4, -37]]), 'hull2', 2, { lift: 0.6, details: [{ k: 'lights', pts: [[0, -36]], r: 0.9, tone: 'glow' }] }),
    part('engine', circle(0, 15.4, 3.6, 12), 'dark', 2.2, { engine: 0, details: [{ k: 'lights', pts: [[0, 15.8]], r: 1.8 }] }),
    part('thorax', circle(0, 0, 14.5, 26), 'hull', 3, {
      sphere: true,
      details: [
        { k: 'shape', pts: circle(0, 0, 11.2, 22), tone: 'hull2' },
        { k: 'shape', pts: circle(0, 0, 9.6, 20), tone: 'hull' },
        ...[0, 1, 2].map((i): Detail => ({ k: 'shape', pts: turn(thick([[0, -9.6], [0, -13.6]], 2.6), (i * 2 * Math.PI) / 3 + Math.PI / 3), tone: 'accent' })),
      ],
    }),
    eye('eye', 0, -1, 5, 4),
  )
  return { parts, breakStyle: 'bands' }
}

// --- Frigates ----------------------------------------------------------------------------------------

/**
 * Disruptor frigate: a centipede of a lance. A chain of armoured vertebrae with short spines down its
 * sides, its great ion projector between two mandible prongs at the nose (violet light gathering
 * between them) and two engines at the tail. The thinnest silhouette in the fleet.
 */
export const ion: ModelDef = () => {
  const parts: Part[] = [
    part('cord', [[-3.6, -36], [3.6, -36], [3.2, 42], [-3.2, 42]], 'dark', 0),
    ...sym(part('prong', [[-2, -33], [-8.2, -36], [-8.6, -44], [-5.4, -50], [-4.2, -44.6], [-3, -38]], 'hull2', 1, {
      slope: [-0.45, -0.1],
      lift: 1.2,
      details: [{ k: 'shape', pts: [[-6.6, -38], [-7.6, -43], [-5.6, -47.4], [-5, -44.6], [-5.6, -39]], tone: 'accent' }],
    })),
    part('focus', [[0, -36], [1.6, -40], [0, -48], [-1.6, -40]], 'glow', 1.1, { glow: true, noOutline: true, details: [{ k: 'lights', pts: [[0, -41], [0, -45]], r: 0.9 }] }),
  ]
  // The vertebrae, nose to tail: (centre y, half-width, tone).
  const segs: [number, number][] = [[-31, 7.4], [-23, 10.8], [-15, 9.2], [-7.4, 9.8], [0.4, 8.6], [8.2, 9.2], [16, 8], [23.6, 8.6], [31, 7.2]]
  segs.forEach(([y, w], i) => parts.push(...vertebra(`seg${i}`, y, 8.6, w, i % 2 ? 'hull2' : 'hull', 2 + (i % 2) * 0.1)))
  // Short spines down its sides: they snap off as it is battered.
  for (const [j, y] of [-11, 4.4, 19.8].entries())
    parts.push(...sym(part(`spine${j}`, [[-7.8, y - 1.4], [-11.3, y + 1.4], [-11, y + 3], [-7.8, y + 1.6]], 'dark', 1.5, { detach: { hull: 0.5 - j * 0.12 } }), { detach: { hull: 0.44 - j * 0.12 } }))
  parts.push(
    thruster('podL', -6, 34, 48.6, 5.6, 0, 1.6, { detach: { hull: 0.16 } }),
    thruster('podR', 5.7, 34, 48.6, 5.6, 1, 1.6, { detach: { hull: 0.1 } }),
    eye('eye', 0, -31, 2.4, 3),
  )
  return { parts, breakStyle: 'bands' }
}

/**
 * Scarab frigate: a beetle. Two great shell cases split down the middle, banded in violet and dotted
 * with the cradles of its repair droids, a thorax shield carrying the shield generator, a horned head
 * with its prong cannons, short legs under the shell and three engines. Antennae, legs, horn tips and
 * the outer engines come away as it is battered.
 */
export const frigate: ModelDef = () => {
  const elytron = blobby([[-1.3, -16], [-11, -17.6], [-18.6, -9], [-20.8, 6], [-20, 22], [-16, 34], [-8.6, 41], [-1.3, 40.4], [-1.3, 12]], 5)
  const parts: Part[] = [
    ...[-10, 5, 21].flatMap((y, j) => sym(part(`leg${j}`, thick([[-14, y], [-20.4, y - 4], [-21, y - 9]], 2.6, 1.4), 'dark', 0.5, { detach: { hull: 0.55 - j * 0.12 } }), { detach: { hull: 0.48 - j * 0.12 } })),
    ...sym(part('antenna', thick([[-3, -42], [-8, -47], [-13.4, -48]], 1.1, 0.6), 'dark', 0.6, { detach: { hull: 0.62 } }), { detach: { hull: 0.5 } }),
    part('seam', [[-1.6, -17], [1.6, -17], [1.6, 41], [-1.6, 41]], 'dark', 0.8),
    thruster('pod0', -9.1, 36, 48.4, 6.4, 0, 1, { detach: { hull: 0.16 } }),
    thruster('pod1', -0.2, 37, 49.6, 6.4, 1, 1),
    thruster('pod2', 8.4, 36, 48.4, 6.4, 2, 1, { detach: { hull: 0.1 } }),
    ...sym(part('shell', elytron, 'hull', 2, {
      slope: [-0.5, 0.05],
      lift: 2,
      details: [
        { k: 'shape', pts: thick(spline([[-6, -13], [-14.6, -6], [-17, 10], [-15, 26], [-9, 36]], 4), 2.2, 1.4), tone: 'accent' },
        { k: 'shape', pts: thick(spline([[-4, -10], [-8.6, 0], [-10, 16], [-8.8, 30], [-5, 37]], 4), 1.4, 1), tone: 'accent' },
        { k: 'line', pts: spline([[-2, -2], [-12, 2], [-19.6, 0]], 3) },
        { k: 'line', pts: spline([[-2, 28], [-11, 30], [-17, 26]], 3) },
        { k: 'shape', pts: circle(-14.4, 25, 2, 10), tone: 'dark' },
        { k: 'shape', pts: circle(-16.6, 4, 2, 10), tone: 'dark' },
        { k: 'lights', pts: [[-14.4, 25], [-16.6, 4]], r: 0.7, tone: 'glow' },
      ],
    }), { slope: [0.5, 0.05] }),
    ...sym(part('thorax', halfHull([[-31, 7], [-28, 11.4], [-22, 14.6], [-16, 14.8], [-12, 12]]), 'hull2', 3, {
      slope: [-0.4, -0.2],
      lift: 1.6,
      details: [{ k: 'shape', pts: [[-9, -29.6], [-12.6, -26], [-13.6, -18], [-11, -15]], tone: 'accent' }, { k: 'line', pts: [[0, -16], [-12, -16]] }],
    })),
    ...sym(part('head', halfHull([[-44, 1], [-41, 4.4], [-36, 9], [-32, 9.8], [-29, 8]]), 'hull', 3.5, { slope: [-0.4, -0.3], lift: 1.2, details: [{ k: 'line', pts: [[-2, -40], [-6, -33]] }] })),
    ...sym(part('horn', [[-3.6, -41], [-5.2, -50], [-7, -48.4], [-8.8, -40]], 'hull2', 3.6, { slope: [-0.4, -0.2], lift: 1, detach: { hull: 0.28 }, details: [{ k: 'shape', pts: [[-4.8, -44], [-5.2, -49], [-6.6, -47.6], [-7.4, -43]], tone: 'accent' }] }), { slope: [0.4, -0.2], detach: { hull: 0.2 } }),
    eye('eye', 0, -42.4, 2.2, 4),
  ]
  return { parts, breakStyle: 'bands', mount: (i) => ({ detach: i >= 3 }) }
}

// --- Cruiser -----------------------------------------------------------------------------------------

/**
 * Manta cruiser: a manta ray. Broad crescent wings, each a heavy leading spar with its guns and
 * shield generators on it, ribs back to the body and a dark membrane between them; a segmented body
 * with the tractor projector glowing on its head; the wing tips curl back into hooks. The two
 * engines at its tail are shot off with their hardpoints.
 */
export const cruiser: ModelDef = ({ h }) => {
  const H = h / 2
  const spar: Pt[] = [[-7, -18.5], [-18, -12.6], [-26.7, -7], [-34.2, 0.2], [-41.7, 9.6], [-46.6, 18.4]]
  const parts: Part[] = [
    ...sym(part('web', [[-8, -14], [-20, -8], [-30, -0.6], [-38, 8.4], [-44.6, 18.6], [-40, 20.6], [-31, 17.2], [-20, 15.6], [-9, 18]], 'dark', 0, {
      details: [
        { k: 'line', pts: [[-12, -6], [-26, 4]] },
        { k: 'line', pts: [[-12, 6], [-34, 12]] },
        { k: 'line', pts: [[-14, 15], [-40, 18]] },
        { k: 'lights', pts: [[-24, 8], [-31, 12], [-18, 12]], r: 0.5, tone: 'glow' },
      ],
    })),
    ...sym(part('rib', thick([[-9, -4], [-20, 0], [-31, 4]], 2.4, 1.6), 'hull2', 0.6, { lift: 0.6 })),
    ...sym(part('rib2', thick([[-9, 7], [-24, 9], [-38, 12.6]], 2.4, 1.6), 'hull2', 0.6, { lift: 0.6 })),
    ...sym(part('trail', thick([[-9, 17], [-22, 15.2], [-33, 17.4], [-43, 20]], 3, 2), 'hull2', 0.7, { lift: 0.6 })),
    ...sym(part('spar', thick(spar, 12.6, 6.4), 'hull', 1, {
      slope: [-0.35, -0.35],
      lift: 2,
      details: [
        { k: 'shape', pts: thick([[-12, -18.6], [-22, -13.2], [-30, -8], [-37.4, -0.6], [-44, 8.6]], 2.2, 1.2), tone: 'accent' },
        { k: 'shape', pts: thick([[-22.6, -13.6], [-21, -7.6]], 1.6), tone: 'dark' },
        { k: 'shape', pts: thick([[-38.6, 0.2], [-35.6, 5.4]], 1.6), tone: 'dark' },
      ],
    }), { slope: [0.35, -0.35] }),
    ...sym(part('hook', thick([[-45.6, 16], [-49.4, 24.6], [-47.6, 31.6], [-44, H - 0.6]], 5, 1.4), 'hull2', 1.2, { lift: 1, detach: { hull: 0.3 }, details: [{ k: 'shape', pts: thick([[-47.6, 21], [-48.4, 27]], 1), tone: 'accent' }] }), { detach: { hull: 0.2 } }),
    thruster('podL', -5.3, 18, H - 0.4, 6.4, 0, 1.4, { detach: { hp: 6 } }),
    thruster('podR', 5.2, 18, H - 0.4, 6.4, 1, 1.4, { detach: { hp: 7 } }),
    ...sym(part('body', halfHull([[-30, 1], [-26, 5.6], [-18, 9], [-8, 10.2], [4, 9.6], [14, 8], [22, 5.6], [28, 3]]), 'hull', 2, {
      slope: [-0.5, 0],
      lift: 1.4,
      details: [
        { k: 'line', pts: [[0, -10], [-9.8, -10]] },
        { k: 'line', pts: [[0, 0], [-10, 0]] },
        { k: 'line', pts: [[0, 10], [-9, 10]] },
        { k: 'shape', pts: [[-3, -8], [-7, -8], [-7.4, -2], [-3, -2]], tone: 'accent' },
        { k: 'shape', pts: [[-3, 2], [-7.2, 2], [-6.8, 8], [-3, 8]], tone: 'accent' },
        { k: 'shape', pts: [[-2.4, 13], [-5.6, 13], [-4.6, 20], [-2.4, 20]], tone: 'accent' },
      ],
    })),
    ...sym(part('head', [[0, -H], [-2.6, -31], [-6.6, -24], [-6.4, -17], [0, -15]], 'hull2', 3, { slope: [-0.45, -0.15], lift: 1.4, details: [{ k: 'line', pts: [[-2.6, -29], [-5.4, -19]] }] })),
    // The tractor projector on the head: a violet lens over the eye.
    part('tractor', circle(0, -27.6, 2.6, 14), 'glow', 3.2, { glow: true, details: [{ k: 'lights', pts: [[0, -27.6]], r: 1.3 }] }),
    eye('eye', 0, -20.6, 2.6, 3.4),
    ...sym(part('fin', [[-1.2, 20], [-3.6, 22], [-2.6, 30], [-1.2, 29]], 'hull2', 2.4, { detach: { hull: 0.45 } }), { detach: { hull: 0.35 } }),
  ]
  // The two lighter guns on the spars are flak-sized: they blow off like flak.
  return { parts, breakStyle: 'bands', mount: (i) => ({ detach: i === 2 || i === 3 }) }
}

// --- Flagship ----------------------------------------------------------------------------------------

/**
 * Hive carrier: a flying foundry. A segmented spine with its turbolasers and shield generators, a
 * beaked head, a swollen abdomen over four engines, and two great curved hangar arms like a mantis's
 * forelegs, lined with launch slots, with honeycomb hive sacs between them and the spine that carry
 * the hangars. The arm tips, antennae and outer engines come away as it is battered.
 */
export const capital: ModelDef = () => {
  // The arm's spine: from its root on the body out round its elbow and in to the tip, as a mantis's
  // foreleg folds.
  const bone = spline([[-11, 1], [-23, -3.4], [-30.4, -14], [-30.6, -27], [-25.4, -35.6], [-17.4, -39.6], [-10.6, -44.6]], 4)
  const arm = thick(bone, 9.4, 4.6)
  const comb = (x: number, y: number): Detail[] => {
    // Honeycomb cells over a hive sac.
    const out: Detail[] = []
    for (const [dx, dy] of [[-3.2, -6], [3.2, -6], [-6.2, 0], [0, 0], [6.2, 0], [-3.2, 6], [3.2, 6], [0, 11.6], [0, -11.6]])
      out.push({ k: 'shape', pts: circle(x + dx, y + dy, 2.6, 6), tone: 'hull' })
    return out
  }
  const parts: Part[] = [
    ...sym(part('sac', blobby([[-14.8, -30.6], [-21.4, -26], [-22, -16.6], [-17.6, -11], [-10.6, -12], [-9.4, -24]]), 'hull2', 0.8, { lift: 1.4, details: comb(-15.6, -20.6) })),
    ...sym(part('stalk', thick([[-11, -18], [-15, -16], [-24, -8]], 2.6, 2), 'dark', 0.7)),
    ...sym(part('arm', arm, 'hull', 1, {
      slope: [-0.4, -0.15],
      lift: 2.4,
      details: [
        { k: 'shape', pts: thick(spline([[-14, -1.4], [-25, -7], [-32.6, -17], [-32.8, -27], [-28, -36.4]], 3), 2, 1.4), tone: 'accent' },
        // Launch slots down its inner edge, violet light in each.
        ...along([-20, -3.2], [-26.4, -11.6], 3).map(([x, y]): Detail => ({ k: 'shape', pts: thick([[x + 1, y - 1.2], [x - 1, y + 1.2]], 2.2), tone: 'dark' })),
        ...along([-27.4, -20.6], [-24.4, -31.6], 3).map(([x, y]): Detail => ({ k: 'shape', pts: thick([[x + 1.4, y], [x - 1.4, y]], 2), tone: 'dark' })),
        { k: 'lights', pts: [...along([-20, -3.2], [-26.4, -11.6], 3), ...along([-27.4, -20.6], [-24.4, -31.6], 3)], r: 0.5, tone: 'glow' },
      ],
    }), { slope: [0.4, -0.15] }),
    ...sym(part('claw', blobby([[-12.6, -45.6], [-9.6, -49.6], [-5, -49], [-8.6, -44.2]]), 'hull2', 1.2, { lift: 1.2, detach: { hull: 0.3 } }), { detach: { hull: 0.2 } }),
    thruster('pod0', -9.9, 37, 47.6, 5.6, 0, 1, { detach: { hull: 0.16 } }),
    thruster('pod1', -3.6, 39, 49.8, 5.6, 1, 1),
    thruster('pod2', 3.2, 39, 49.8, 5.6, 2, 1),
    thruster('pod3', 9.7, 37, 47.6, 5.6, 3, 1, { detach: { hull: 0.1 } }),
    ...sym(part('abdomen', halfHull([[18, 9], [24, 14], [30, 16.4], [36, 15.4], [41, 11.4], [44, 5]]), 'hull', 2, {
      slope: [-0.5, 0.1],
      lift: 1.6,
      details: [
        { k: 'shape', pts: thick(spline([[-4, 22], [-11, 26], [-13.6, 33], [-11, 39]], 3), 2), tone: 'accent' },
        { k: 'line', pts: spline([[0, 31], [-8, 30], [-16, 32]], 3) },
        { k: 'line', pts: spline([[0, 38], [-8, 38], [-13, 40]], 3) },
      ],
    })),
    ...sym(part('fin', [[-11, 33], [-17.6, 31], [-19.6, 36], [-13, 38]], 'hull2', 2.2, { detach: { hull: 0.4 } }), { detach: { hull: 0.32 } }),
  ]
  // The spine's vertebrae, nose to tail.
  const segs: [number, number][] = [[-38.6, 7.6], [-29.6, 9.6], [-19.6, 11.2], [-8.4, 12.6], [2, 12.6], [12, 12], [21.4, 11]]
  segs.forEach(([y, w], i) => parts.push(...vertebra(`seg${i}`, y, 10.4, w, i % 2 ? 'hull2' : 'hull', 3 + (i % 2) * 0.1)))
  parts.push(
    ...sym(part('head', [[0, -50], [-3.4, -46.4], [-7, -40], [-6.4, -34], [0, -32.6]], 'hull2', 4, { slope: [-0.45, -0.2], lift: 1.6, details: [{ k: 'line', pts: [[-3, -45], [-5.6, -37]] }] })),
    ...sym(part('antenna', thick([[-4, -44], [-8, -48.6], [-12, -49.4]], 1.1, 0.6), 'dark', 4.2, { detach: { hull: 0.6 } }), { detach: { hull: 0.48 } }),
    eye('eye', 0, -41, 2.8, 4.4),
  )
  return { parts, breakStyle: 'bands' }
}

// --- Station -----------------------------------------------------------------------------------------

/**
 * Foundry station: a hive. Level 1 is its core, an egg-shaped carapace of six shell plates round a
 * domed iris, violet light in the seams between them and short horns where the arms will grow. Level
 * 2 rings it with a collar and grows six segmented arms; level 3 runs them out full length to knuckle
 * pods where the long-range guns sit; level 4 spins a web between the arm tips, its strands carrying
 * the outer guns. Coordinates are frame pixels from the frame's centre, where data.ts places the
 * modules (every stage is cut round the same centre).
 */
export const station: ModelDef = ({ level }) => {
  const parts: Part[] = []
  const RX = 205
  const RY = 262
  const at = (a: number, k: number): Pt => [Math.cos(a) * RX * k, Math.sin(a) * RY * k]
  /** A band of the egg between k0 and k1 of its radius, from angle a0 to a1. */
  const eggBand = (k0: number, k1: number, a0: number, a1: number, n = 10): Pt[] => {
    const out: Pt[] = []
    for (let i = 0; i <= n; i++) out.push(at(a0 + ((a1 - a0) * i) / n, k1))
    for (let i = n; i >= 0; i--) out.push(at(a0 + ((a1 - a0) * i) / n, k0))
    return out
  }
  const D = Math.PI / 180
  // The six arms, by their tips at full length: up, upper right, lower right, down, lower left, upper
  // left, where data.ts puts the level-3 and level-4 guns.
  const tips: Pt[] = [[0, -457], [473, -222], [481, 233], [0, 463], [-481, 233], [-473, -222]]

  // --- Level 4: the web between the arm tips, under everything else -----------------------------
  if (level >= 4) {
    for (let i = 0; i < 6; i++) {
      const a = tips[i]
      const b = tips[(i + 1) % 6]
      // The strands bow outward a little, more on the lower ones, so they pass under their guns.
      const bow = i === 2 || i === 3 ? 1.12 : i === 1 || i === 4 ? 1.03 : 1.03
      const mid: Pt = [((a[0] + b[0]) / 2) * bow, ((a[1] + b[1]) / 2) * bow]
      const line = spline([a, mid, b], 8)
      parts.push(part(`web${i}`, thick(line, 72), 'hull', 1, {
        lift: 5,
        slope: [mid[0] / Math.hypot(...mid) * 0.4, mid[1] / Math.hypot(...mid) * 0.4],
        details: [
          { k: 'shape', pts: thick(line.slice(3, -3), 14), tone: 'accent' },
          ...line.filter((_, j) => j % 4 === 2).map(([x, y]): Detail => ({ k: 'shape', pts: circle(x, y, 13, 8), tone: 'dark' })),
          { k: 'lights', pts: line.filter((_, j) => j % 4 === 2), r: 5, tone: 'glow' },
        ],
      }))
      // Threads of silk from the strand's middle back towards the hive.
      parts.push(part(`thread${i}`, thick([mid, [mid[0] * 0.45, mid[1] * 0.45]], 9, 6), 'dark', 0.5, { noOutline: true }))
    }
  }

  // --- Levels 2 and 3: the arms -------------------------------------------------------------------
  if (level >= 2) {
    const full = level >= 3
    tips.forEach(([tx, ty], i) => {
      const a = Math.atan2(ty, tx) + Math.PI / 2
      // Growing: at level 2 the up and down arms reach most of the way already, the side ones less.
      const len = full ? Math.hypot(tx, ty) : tx === 0 ? 420 : Math.hypot(tx, ty) * 0.74
      // Drawn pointing up (negative y) and turned to its own direction: tapering shell segments, each
      // overlapping the next like an insect's leg, dark joints showing between them.
      const segs = full ? 4 : 3
      const r0 = 196
      const step = (len - r0) / segs
      for (let s = 0; s < segs; s++) {
        const y0 = -(r0 + step * s) + 16
        const y1 = -(r0 + step * (s + 1)) + 4
        const w = 132 - s * 15
        const shell = blobby([[-w * 0.4, y0], [-w * 0.52, y0 - (y0 - y1) * 0.35], [-w * 0.44, y1 + 12], [-w * 0.28, y1], [w * 0.28, y1], [w * 0.44, y1 + 12], [w * 0.52, y0 - (y0 - y1) * 0.35], [w * 0.4, y0]], 3)
        parts.push(turnPart(part(`arm${i}.${s}`, shell, s % 2 ? 'hull2' : 'hull', 3 - s * 0.01, {
          lift: 4,
          facets: [{ pts: [[0, y0 + 2], [-w, y0 + 2], [-w, y1 - 2], [0, y1 - 2]], slope: [-0.45, 0] }],
          details: [
            { k: 'shape', pts: [[-w * 0.1, y0 - 18], [-w * 0.22, y0 - 18], [-w * 0.2, y1 + 20], [-w * 0.1, y1 + 20]], tone: 'accent' },
            { k: 'shape', pts: [[w * 0.1, y0 - 18], [w * 0.22, y0 - 18], [w * 0.2, y1 + 20], [w * 0.1, y1 + 20]], tone: 'accent' },
            { k: 'line', pts: [[-w * 0.44, y1 + 22], [0, y1 + 14], [w * 0.44, y1 + 22]] },
            { k: 'lights', pts: [[-w * 0.36, (y0 + y1) / 2], [w * 0.36, (y0 + y1) / 2]], r: 4, tone: 'glow' },
          ],
        }), a))
        // A dark joint under the overlap.
        parts.push(turnPart(part(`joint${i}.${s}`, [[-w * 0.3, y1 + 12], [w * 0.3, y1 + 12], [w * 0.26, y1 - 16], [-w * 0.26, y1 - 16]], 'dark', 2.8), a))
      }
      // The tip: a claw pod at level 2, a big knuckle pod where the guns sit at level 3.
      const tip: Pt = [0, -len]
      parts.push(turnPart(part(`knuckle${i}`, full ? circle(0, -len, 64, 24) : blobby([[0, -len - 34], [-36, -len - 12], [-40, -len + 26], [0, -len + 40], [40, -len + 26], [36, -len - 12]]), 'hull2', 4, {
        lift: 6,
        facets: full ? [{ pts: circle(0, -len, 64, 24).filter(([x]) => x <= 0), slope: [-0.4, 0] }] : undefined,
        details: full
          ? [{ k: 'shape', pts: circle(tip[0], tip[1], 54, 22), tone: 'accent' }, { k: 'shape', pts: circle(tip[0], tip[1], 46, 20), tone: 'hull2' }, { k: 'lights', pts: [[-40, -len], [40, -len]], r: 5, tone: 'glow' }]
          : [{ k: 'shape', pts: [[-10, -len - 26], [10, -len - 26], [8, -len + 20], [-8, -len + 20]], tone: 'accent' }, { k: 'lights', pts: [[0, -len + 30]], r: 5, tone: 'glow' }],
      }), a))
    })
    // The collar round the core: a dark ring of ribs, lit violet between them.
    const collarOut = Array.from({ length: 48 }, (_, i) => at((i / 48) * Math.PI * 2, 1.09))
    const collarIn = Array.from({ length: 48 }, (_, i) => at((i / 48) * Math.PI * 2, 0.97))
    parts.push(part('collar', collarOut, 'metal', 5, {
      holes: [collarIn],
      lift: 3,
      details: [{ k: 'lights', pts: Array.from({ length: 12 }, (_, i) => at((i / 12) * Math.PI * 2 + 15 * D, 1.03)), r: 5, tone: 'glow' }],
    }))
  }

  // --- Level 1: the core --------------------------------------------------------------------------
  parts.push(part('core', Array.from({ length: 48 }, (_, i) => at((i / 48) * Math.PI * 2, 1.0)), 'dark', 6, {
    lift: 3,
    details: [{ k: 'lights', pts: Array.from({ length: 6 }, (_, i) => at(-90 * D + 30 * D + i * 60 * D, 0.72)), r: 7, tone: 'glow' }],
  }))
  for (let i = 0; i < 6; i++) {
    const c = -90 * D + i * 60 * D
    const slope: Pt = [Math.cos(c) * 0.45, Math.sin(c) * 0.45]
    parts.push(part(`plate${i}`, eggBand(0.4, 0.98, c - 26 * D, c + 26 * D), i % 2 ? 'hull2' : 'hull', 7, {
      lift: 4,
      slope,
      details: [
        { k: 'shape', pts: eggBand(0.78, 0.88, c - 15 * D, c + 15 * D, 6), tone: 'accent' },
        { k: 'line', pts: [at(c - 20 * D, 0.62), at(c, 0.6), at(c + 20 * D, 0.62)] },
        { k: 'shape', pts: eggBand(0.44, 0.5, c - 8 * D, c + 8 * D, 4), tone: 'dark' },
      ],
    }))
    // Short horns between the plates at level 1, where the arms will grow from.
    if (level < 2) {
      const h = c + 30 * D
      parts.push(part(`horn${i}`, thick([at(h, 0.92), at(h + 4 * D, 1.06), at(h + 2 * D, 1.12)], 26, 8), 'hull2', 6.5, { lift: 2 }))
    }
  }
  parts.push(part('dome', Array.from({ length: 36 }, (_, i) => at((i / 36) * Math.PI * 2, 0.4)), 'hull2', 8, {
    lift: 5,
    facets: [{ pts: Array.from({ length: 19 }, (_, i) => at(Math.PI / 2 + (i / 18) * Math.PI, 0.4)), slope: [-0.4, 0] }],
    details: [{ k: 'shape', pts: Array.from({ length: 36 }, (_, i) => at((i / 36) * Math.PI * 2, 0.3)), tone: 'accent' }, { k: 'shape', pts: Array.from({ length: 36 }, (_, i) => at((i / 36) * Math.PI * 2, 0.25)), tone: 'dark' }],
  }))
  parts.push(eye('iris', 0, 0, 34, 9))
  return { parts, breakStyle: 'pie' }
}

// --- Structures on the ore ---------------------------------------------------------------------------

/** Four jointed insect legs holding a structure to its asteroid, from (x0, y0) by way of the knee
 * (kx, ky) to the foot (fx, fy), drawn for the top-left one and mirrored to the others. */
function anchorLegs(x0: number, y0: number, kx: number, ky: number, fx: number, fy: number, z: number): Part[] {
  const out: Part[] = []
  for (const [sx, sy, n] of [[1, 1, 0], [-1, 1, 1], [1, -1, 2], [-1, -1, 3]] as const) {
    const f = (p: Pt): Pt => [p[0] * sx, p[1] * sy]
    out.push(limb(`leg${n}`, [f([x0, y0]), f([kx, ky]), f([fx, fy])], 5, 3, 'metal', z))
    out.push(part(`claw${n}`, [f([fx - 3, fy - 2]), f([fx + 1, fy - 4]), f([fx + 4, fy - 1]), f([fx + 1, fy + 3.4]), f([fx - 2.4, fy + 2])], 'dark', z + 0.1))
  }
  return out
}

/**
 * Droid ore harvester: a domed carapace over the ore silo, two drill wells either side in ribbed
 * shell rings, a landing shell on top (where the shield dome goes) and a gun bulb below, held to the
 * asteroid by four jointed insect legs.
 */
export const mine: ModelDef = ({ h }) => {
  const H = h / 2
  const ring = (x: number): Pt[] => Array.from({ length: 20 }, (_, i) => {
    const a = (i / 20) * Math.PI * 2
    const r = i % 2 ? 19.6 : 21
    return [x + Math.cos(a) * r, Math.sin(a) * r] as Pt
  })
  const padY = (1.6 / 10 - 0.5) * h
  const pdY = (7.9 / 10 - 0.5) * h
  const parts: Part[] = [
    ...anchorLegs(-12, -12, -22, -34, -44, -H + 4, 0),
    ...sym(part('link', thick([[-13, 0], [-20, -1.2], [-26, 0]], 9, 8), 'metal', 1, { lift: 1.2, details: [{ k: 'line', pts: [[-17, -4], [-17, 4]] }] })),
    ...sym(part('well', ring(-32), 'hull', 2, {
      lift: 2.2,
      facets: [{ pts: ring(-32).filter(([x]) => x <= -32), slope: [-0.35, 0] }],
      details: [
        ...[0, 1, 2, 3, 4, 5].map((i): Detail => ({ k: 'shape', pts: turn(thick([[-32, -21], [-32, -16.6]], 2.4), (i * Math.PI) / 3, -32, 0), tone: 'dark' })),
        ...[0, 1, 2].map((i): Detail => ({ k: 'shape', pts: turn(thick([[-32, -20.4], [-32, -17.4]], 3.4), (i * 2 * Math.PI) / 3 + Math.PI / 6, -32, 0), tone: 'accent' })),
      ],
    })),
    part('pad', blobby([[0, padY - 11], [-13, padY - 7], [-16, padY + 3], [-8, padY + 11], [8, padY + 11], [16, padY + 3], [13, padY - 7]]), 'hull', 2, {
      lift: 1.8,
      details: [{ k: 'shape', pts: circle(0, padY, 7.6, 6), tone: 'dark' }, { k: 'shape', pts: thick([[-10, padY - 7], [10, padY - 7]], 1.6), tone: 'accent' }, { k: 'lights', pts: [[-12, padY + 2], [12, padY + 2]], r: 0.8, tone: 'glow' }],
    }),
    part('neck', [[-5, padY + 8], [5, padY + 8], [6, -10], [-6, -10]], 'metal', 1.6, { lift: 1 }),
    part('bulb', circle(0, pdY, 9.6, 18), 'hull2', 2, { lift: 2, details: [{ k: 'shape', pts: thick([[-9, pdY + 3], [9, pdY + 3]], 1.6), tone: 'accent' }] }),
    part('dome', circle(0, 0, 16, 24), 'hull2', 3, {
      lift: 2.8,
      facets: [{ pts: [...circle(0, 0, 16, 24).filter(([, y]) => y >= 0)], slope: [0, 0.4] }],
      details: [
        ...[0, 1, 2, 3, 4, 5].map((i): Detail => ({ k: 'shape', pts: turn(thick([[0, -15.6], [0, -9]], 2.6, 1.6), (i * Math.PI) / 3 + Math.PI / 6), tone: 'accent' })),
        { k: 'shape', pts: circle(0, 0, 8.6, 6), tone: 'dark' },
      ],
    }),
    part('antenna', thick([[36, -17], [40, -26], [38.6, -33]], 2.2, 1.2), 'dark', 3.4, { detach: { hull: 0.5 }, details: [{ k: 'lights', pts: [[38.6, -33]], r: 1, tone: 'glow' }] }),
  ]
  return { parts, breakStyle: 'pie' }
}

/**
 * Droid defense platforms (balanced, flak and gun share one deck): a round carapace rim of six shell
 * plates, ribs from a domed hub out to four gun cradles, nodes on its sides, held down by four insect
 * legs. The flak platform carries gold ammunition sacs; the gun platform glowing capacitor spines.
 */
export const defense: ModelDef = ({ t, h }) => {
  const kind = t.id.endsWith('flak') ? 'flak' : t.id.endsWith('gun') ? 'gun' : 'balanced'
  const cy = (5.1 / 10 - 0.5) * h
  const corners: Pt[] = [[-24, (3 / 10 - 0.5) * h], [24, (3 / 10 - 0.5) * h], [-24, (7.3 / 10 - 0.5) * h], [24, (7.3 / 10 - 0.5) * h]]
  // The rim: a round ring, slightly lobed, cut into six plates by dark joints.
  const rimOut = Array.from({ length: 36 }, (_, i) => {
    const a = (i / 36) * Math.PI * 2
    return [Math.cos(a) * 46.6, Math.sin(a) * 46.6 * 0.99] as Pt
  })
  const rimIn = Array.from({ length: 36 }, (_, i) => {
    const a = (i / 36) * Math.PI * 2
    return [Math.cos(a) * 37.4, Math.sin(a) * 37.4] as Pt
  })
  const parts: Part[] = [
    ...anchorLegs(-26, -30, -40, -36, -46, -46, 0),
    part('rim', rimOut, 'hull', 1, {
      holes: [rimIn],
      lift: 2.4,
      details: [
        ...[0, 1, 2, 3, 4, 5].map((i): Detail => ({ k: 'shape', pts: turn(thick([[0, -46.6], [0, -37.4]], 3.4), (i * Math.PI) / 3 + Math.PI / 6), tone: 'dark' })),
        ...[0, 1, 2, 3, 4, 5].map((i): Detail => ({ k: 'shape', pts: turn(thick([[-6, -44], [6, -44]], 3.2), (i * Math.PI) / 3), tone: 'accent' })),
        { k: 'lights', pts: [0, 1, 2, 3, 4, 5].map((i) => [Math.cos((i * Math.PI) / 3 + Math.PI / 6) * 42, Math.sin((i * Math.PI) / 3 + Math.PI / 6) * 42] as Pt), r: 0.9, tone: 'glow' },
      ],
    }),
    ...corners.map(([x, y], i) => part(`rib${i}`, thick([[x * 0.3, cy + (y - cy) * 0.3], [x * 0.75, cy + (y - cy) * 0.75], [x * 1.42, y * 1.42 + cy * 0.4]], 6.4, 4.4), 'hull2', 1.6, { lift: 1.4 })),
    ...sym(part('node', circle(-41, 0, 7.6, 16), 'hull2', 2.6, { lift: 2.6, details: [{ k: 'shape', pts: thick([[-46, 0], [-44, 0]], 4), tone: 'accent' }] })),
    ...corners.map(([x, y], i) => part(`cradle${i}`, circle(x, y, 10.4, 18), 'hull2', 2.5, {
      lift: 3,
      details: [{ k: 'shape', pts: turn(thick([[x, y - 10.2], [x, y - 7.6]], 5), Math.atan2(y - cy, x) + Math.PI / 2, x, y), tone: 'accent' }],
    })),
    part('hub', circle(0, cy, 20, 28), 'hull', 3, {
      lift: 3.4,
      facets: [{ pts: circle(0, cy, 20, 28).filter(([, y]) => y >= cy), slope: [0, 0.4] }],
      details: [{ k: 'shape', pts: circle(0, cy, 18.4, 26), tone: 'accent' }, { k: 'shape', pts: circle(0, cy, 16.6, 24), tone: 'hull' }],
    }),
  ]
  if (kind === 'flak')
    corners.forEach(([x, y], i) => parts.push(part(`sac${i}`, circle(x * 0.55, cy + (y - cy) * 0.55 + (y < cy ? -4 : 4), 3.6, 10), 'trim', 3.2, { lift: 0.8, sphere: true })))
  if (kind === 'gun')
    for (const s of [-1, 1]) parts.push(part(`spike${s < 0 ? 'T' : 'B'}`, thick([[0, cy + s * 22], [0, cy + s * 40]], 5, 2), 'dark', 3, { lift: 1.6, details: [{ k: 'lights', pts: along([0, cy + s * 25], [0, cy + s * 37], 3), r: 1, tone: 'glow' }] }))
  if (kind === 'balanced') parts.push(part('antenna', thick([[0, cy - 20], [-2.4, cy - 30], [0, cy - 40]], 3, 1.6), 'dark', 3.2, { lift: 1, detach: { hull: 0.5 }, details: [{ k: 'lights', pts: [[0, cy - 40]], r: 1.1, tone: 'glow' }] }))
  return { parts, breakStyle: 'pie' }
}
