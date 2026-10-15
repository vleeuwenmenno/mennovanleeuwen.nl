import { circle, halfHull, part, spline, sym, thick, turn } from '../kit.ts'
import { hpAt } from '../proto.ts'
import type { BuildCtx, ModelDef } from '../spec.ts'
import type { Detail, Part, Pt, Tone } from '../types.ts'
import { engineSac } from './mounts.ts'

// The Swarm's style kit and its small organisms: strike craft, the Ravager gunship and the Leech
// corvette. Swarm vessels are grown, not built: a segmented central spine, pale chitin plates over
// dark purple chitin and darker tissue, a violet glowing core as the focal point, acid-green vents
// and engine sacs, tendrils, and claw-like silhouettes, organic and a little asymmetric but always
// readable from above. Small craft keep to silhouette and colour; fine detail (panel lines, rows of
// glands) is for the big ones, and panel lines only show on big bitmaps anyway (paint.ts `fine`).

// --- The Swarm's parts ---------------------------------------------------------------------------------

/** A smooth band along a curve through `pts`, `w0` thick at its start tapering to `w1`: a claw, a
 * limb, a tendril, a blade. */
export const band = (pts: Pt[], w0: number, w1: number, n = 3): Pt[] => thick(spline(pts, n), w0, w1)

/** A closed organic outline through control points. */
export const blobby = (pts: Pt[], n = 3) => spline(pts, n, true)

/** A chitin plate: a raised part lit as it faces, with its outline. */
export const plate = (id: string, pts: Pt[], tone: Tone, z: number, slope: Pt, more: Partial<Part> = {}): Part =>
  part(id, pts, tone, z, { lift: 1, slope, ...more })

/**
 * A chitin blade: one overlapping armour segment, a plate that grows from its root at `pts[0]` along
 * the curve and tapers to a claw point at its end, `w` wide at the root. Lit on its own facing
 * (`slope`), a seam down its length and a violet edge along it (`edge`). Laid one over another, they
 * make the Swarm's layered, claw-like silhouettes.
 */
export function blade(id: string, pts: Pt[], w: number, tone: Tone, z: number, slope: Pt, more: Partial<Part> = {}, edge = true): Part {
  const curve = spline(pts, 3)
  const seam = curve.slice(1, Math.ceil(curve.length * 0.75))
  const details: Detail[] = [{ k: 'line', pts: seam, minPx: 120 }]
  if (edge) details.push({ k: 'shape', pts: thick(curve.slice(0, Math.ceil(curve.length * 0.85)).map(([x, y]) => [x + slope[0] * w * 0.42, y + slope[1] * w * 0.42] as Pt), w * 0.16, w * 0.03), tone: 'accent', minPx: 70 })
  return part(id, thick(curve, w, w * 0.06), tone, z, { lift: 1.1, slope, ...more, details: [...details, ...(more.details ?? [])] })
}

/**
 * A violet core: the focal point of every Swarm vessel. A dark socket of tissue, an acid-green ring
 * of membrane round it (on bigger ones), and the core itself glowing violet, a brighter heart in it.
 * `rx`, `ry` its radii; `ring` adds the green membrane.
 */
export function core(id: string, x: number, y: number, rx: number, ry: number, z: number, ring = true): Part[] {
  const out: Part[] = [part(`${id}Socket`, circle(x, y, rx * 1.35, 18, ry * 1.25), 'dark', z, { lift: 0.4, details: ring ? [{ k: 'shape', pts: circle(x, y, rx * 1.18, 18, ry * 1.12), tone: 'aid' }] : [] })]
  out.push(part(id, circle(x, y, rx, 18, ry), 'glow', z + 0.05, {
    glow: true,
    details: [
      { k: 'shape', pts: circle(x - rx * 0.18, y - ry * 0.2, rx * 0.55, 12, ry * 0.55), tone: 'glass' },
      { k: 'lights', pts: [[x - rx * 0.2, y - ry * 0.25]], r: Math.min(rx, ry) * 0.22, tone: 'glass' },
    ],
  }))
  return out
}

/** Acid-green glands: small glowing spots in the tissue, the Swarm's secondary light (only on bitmaps
 * big enough to show them). */
export const glands = (pts: Pt[], r: number): Detail => ({ k: 'lights', pts, r, tone: 'aid', minPx: 140 })
/** Violet lights. */
export const sparks = (pts: Pt[], r: number): Detail => ({ k: 'lights', pts, r, tone: 'glow', minPx: 140 })

/**
 * A segmented spine down the middle: one vertebra per [y, half-width, length] row, each a left and a
 * right chitin shell lit on its own, dark tissue showing at the joints between them and a violet
 * node on every other one.
 */
export function spine(id: string, segs: [number, number, number][], tone: Tone, z: number, nodes = true): Part[] {
  const out: Part[] = []
  segs.forEach(([y, w, h], i) => {
    const rows: [number, number][] = [[y - h / 2, w * 0.5], [y - h * 0.3, w * 0.95], [y + h * 0.15, w], [y + h / 2, w * 0.62]]
    const details: Detail[] = [{ k: 'line', pts: [[-w * 0.4, y - h * 0.1], [-w * 0.85, y + h * 0.15]] }]
    if (nodes && i % 2 === 1) details.push({ k: 'shape', pts: circle(-w * 0.18, y, Math.min(w * 0.3, h * 0.22), 8), tone: 'accent', minPx: 90 })
    out.push(...sym(part(`${id}${i}`, halfHull(rows), i % 2 ? tone : tone === 'hull' ? 'hull2' : 'hull', z + i * 0.01, { lift: 0.9, slope: [-0.5, 0], details })))
  })
  return out
}

/** A tendril of dark tissue: a long thin band that tapers to a point, fluttering off the hull. */
export const tendril = (id: string, pts: Pt[], w: number, z = 0.6, more: Partial<Part> = {}): Part =>
  part(id, band(pts, w, w * 0.18, 3), 'metal', z, { lift: 0.6, ...more })

/**
 * The seat a weapon node grows from on a warship's hardpoint `i`: a raised collar of dark chitin
 * round it, a little wider than the node, with a violet band on its back (the node's mount sits on
 * top, see mounts.ts).
 */
export function nodeSeat(id: string, c: BuildCtx, i: number, r: number, z: number): Part {
  const [x, y] = hpAt(c, i)
  return part(id, circle(x, y, r, 16), 'metal', z, {
    lift: 0.8,
    details: [{ k: 'line', pts: [...circle(x, y, r * 0.84, 16), circle(x, y, r * 0.84, 16)[0]] }, { k: 'shape', pts: circle(x, y + r * 0.72, r * 0.32, 8, r * 0.16), tone: 'accent' }],
  })
}

/** A small weapon organ grown into a hull (no hardpoint, for strike craft and gunships, whose guns are
 * fixed): an acid sprayer, its green organ cupped in a claw, the nozzle pointing forward. */
export function acidOrgan(id: string, x: number, y: number, r: number, z: number, more: Partial<Part> = {}): Part[] {
  return [
    part(`${id}Cup`, band([[x - r * 0.9, y + r * 0.6], [x - r, y - r * 0.3], [x - r * 0.4, y - r * 1.1]], r * 0.5, r * 0.15), 'hull', z, { lift: 0.5, slope: [-0.4, 0], ...more }),
    part(`${id}CupR`, band([[x + r * 0.9, y + r * 0.6], [x + r, y - r * 0.3], [x + r * 0.4, y - r * 1.1]], r * 0.5, r * 0.15), 'hull', z, { lift: 0.5, slope: [0.4, 0], ...more }),
    part(id, circle(x, y, r * 0.62, 12, r * 0.72), 'aid', z + 0.05, { sphere: true, ...more, details: [{ k: 'lights', pts: [[x, y - r * 0.9]], r: r * 0.16, tone: 'aid' }] }),
  ]
}

/** A bio-turret: a green core ringed with spines, the Swarm's rapid-fire point defence. */
export function bioTurret(id: string, x: number, y: number, r: number, z: number, spines = 6): Part[] {
  const out: Part[] = []
  for (let i = 0; i < spines; i++) {
    const a = (i / spines) * Math.PI * 2 - Math.PI / 2
    out.push(part(`${id}Spine${i}`, turn([[-r * 0.2, -r * 0.55], [r * 0.2, -r * 0.55], [0, -r * 1.25]], a + Math.PI / 2, 0, 0).map(([px, py]) => [px + x, py + y] as Pt), 'hull', z, { slope: [Math.cos(a) * 0.4, Math.sin(a) * 0.4] }))
  }
  out.push(part(`${id}Ring`, circle(x, y, r * 0.7, 14), 'metal', z + 0.02, { lift: 0.5 }))
  out.push(part(id, circle(x, y, r * 0.48, 12), 'aid', z + 0.04, { sphere: true }))
  return out
}

// --- Strike craft ------------------------------------------------------------------------------------

/**
 * Stinger interceptor: a small predatory dart. A narrow segmented body with a violet core, two
 * hooked bat wings swept back, mandibles at the nose and one green engine sac at the tail.
 */
export const fighter: ModelDef = () => {
  const parts: Part[] = [
    ...sym(part('membrane', [[-5, -8], [-27, 10], [-24, 24], [-5, 18]], 'metal', 0.5, { lift: 0.3 })),
    ...sym(blade('wing', [[-5, -16], [-20, -8], [-34, 10], [-33, 34]], 13, 'hull', 1, [-0.4, -0.1])),
    ...sym(blade('hook', [[-6, 4], [-16, 12], [-20, 26]], 7, 'hull2', 0.9, [-0.4, 0.2], {}, false)),
    engineSac('sac', 0, 30, 47, 10, 0, 1.2, {}, false),
    ...sym(plate('body', halfHull([[-48, 0.5], [-40, 3.4], [-26, 6.4], [-10, 8.4], [6, 7.2], [20, 5.4], [33, 3]]), 'hull2', 2, [-0.5, 0], {
      details: [{ k: 'line', pts: [[0, -18], [-6.6, -14]] }],
    })),
    ...sym(plate('carapace', halfHull([[-44, 1], [-34, 4], [-20, 5.6], [-12, 4.6]]), 'hull', 2.4, [-0.5, -0.2])),
    ...sym(plate('jaw', band([[-2.6, -40], [-6, -46], [-4, -51]], 3, 1), 'hull', 2.2, [-0.4, -0.3])),
    ...core('core', 0, -2, 3.4, 5, 3, false),
    ...sym(part('barb', [[-4.6, 14], [-3, 14], [-2.4, 26], [-4, 24]], 'dark', 2.6)),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Seeker picket: the Hive's sentinel. A tiny round body all eye, ringed in gold (only the defense
 * wing wears it), feelers forward, two short hooked fins and a green engine sac.
 */
export const picket: ModelDef = () => {
  const parts: Part[] = [
    ...sym(plate('fin', band([[-10, -2], [-30, 10], [-40, 26], [-34, 36]], 12, 2.6), 'hull2', 1, [-0.4, 0])),
    ...sym(part('feeler', band([[-6, -20], [-12, -38], [-8, -49]], 3, 1), 'metal', 1.2)),
    engineSac('sac', 0, 22, 46, 13, 0, 1.4, {}, false),
    part('body', circle(0, -6, 19, 22, 21), 'hull', 2, { lift: 1, sphere: true }),
    part('ring', circle(0, -6, 14.6, 20), 'trim', 2.4, { lift: 0.6, holes: [circle(0, -6, 11.6, 18)] }),
    ...core('eye', 0, -6, 9, 9, 2.6, false),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Brood bomber: a bloated spore carrier. A bulbous body under overlapping chitin plates round a
 * violet core, a cluster of acid-green spore sacs held out on each side in claws, mandibles at the
 * front and a green engine sac behind.
 */
export const bomber: ModelDef = () => {
  const parts: Part[] = [
    ...sym(part('arm', band([[-14, 4], [-30, 2], [-40, 12]], 7, 4), 'metal', 0.6, { lift: 0.6 })),
    ...sym(part('sacs', blobby([[-30, -8], [-44, -2], [-46, 14], [-38, 24], [-26, 20], [-24, 6]]), 'aid', 1, {
      sphere: true,
      details: [{ k: 'line', pts: [[-36, -4], [-34, 20]] }, { k: 'shape', pts: circle(-41, 6, 3, 8), tone: 'dark' }, { k: 'shape', pts: circle(-33, 14, 2.4, 8), tone: 'dark' }],
    })),
    ...sym(plate('claw', band([[-20, -16], [-34, -14], [-44, -4]], 6, 1.6), 'hull', 1.4, [-0.4, -0.2])),
    engineSac('sac', 0, 30, 48, 12, 0, 1.2, {}, false),
    ...sym(plate('belly', halfHull([[-40, 3], [-32, 12], [-18, 20], [0, 22], [16, 18], [30, 10], [36, 4]]), 'hull2', 2, [-0.5, 0])),
    ...sym(plate('shellA', halfHull([[-36, 3], [-28, 10], [-16, 14], [-8, 12]]), 'hull', 2.4, [-0.5, -0.3])),
    ...sym(plate('shellB', halfHull([[2, 12], [12, 15], [24, 10], [30, 5]]), 'hull', 2.4, [-0.5, 0.3])),
    ...sym(plate('jaw', band([[-4, -38], [-9, -46], [-6, -50]], 4, 1.2), 'hull', 2.2, [-0.4, -0.3])),
    ...core('core', 0, -3, 6, 7, 3),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Mender repair organism: a healer in a leaf-shaped shell. Two pale leaf halves cupped round a
 * glowing acid-green core, two little tendril arms reaching forward with green tips, and an engine sac.
 */
export const repair: ModelDef = () => {
  const leaf: Pt[] = [[0, -44], [-14, -36], [-30, -14], [-34, 8], [-24, 26], [-8, 32], [-4, 10], [-6, -20]]
  const parts: Part[] = [
    ...sym(part('arm', band([[-8, -24], [-16, -40], [-12, -50]], 3.2, 1.2), 'metal', 0.6, { details: [glands([[-12, -48]], 1.6)] })),
    engineSac('sac', 0, 26, 47, 12, 0, 1, {}, false),
    ...sym(plate('leaf', blobby(leaf, 3), 'hull', 1.4, [-0.45, 0], {
      details: [{ k: 'line', pts: [[-6, -30], [-20, -8], [-22, 14]] }, { k: 'shape', pts: band([[-10, -34], [-24, -10], [-24, 14]], 2.2, 1), tone: 'accent' }],
    })),
    part('heartSocket', circle(0, -2, 10, 18, 13), 'dark', 2, { lift: 0.4 }),
    part('heart', circle(0, -2, 7.6, 18, 10), 'aid', 2.1, { glow: true, details: [{ k: 'lights', pts: [[-1.4, -4]], r: 1.8, tone: 'aid' }] }),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Weaver engineer: a spinner organism. A round abdomen of dark chitin with an acid-green spinneret at
 * its back, a pale head with a violet eye, and three jointed legs a side folded round it; the legs
 * hold the silk it weaves structures from.
 */
export const engineer: ModelDef = () => {
  const legs: Pt[][] = [
    [[-8, -18], [-26, -30], [-34, -46]],
    [[-12, -4], [-32, -10], [-44, -4]],
    [[-12, 10], [-30, 18], [-38, 34]],
  ]
  const parts: Part[] = [
    ...legs.flatMap((pts, i) => sym(part(`leg${i}`, band(pts, 4, 2, 3), i === 1 ? 'hull2' : 'metal', 0.6 + i * 0.01, { lift: 0.6, details: [{ k: 'shape', pts: circle(pts[1][0], pts[1][1], 2.2, 8), tone: 'dark' }] }))),
    engineSac('sac', 0, 30, 47, 10, 0, 1, {}, false),
    part('abdomen', circle(0, 12, 17, 22, 19), 'metal', 2, {
      sphere: true,
      details: [{ k: 'shape', pts: band([[-8, 2], [0, 6], [8, 2]], 2.4, 2.4), tone: 'accent' }, { k: 'shape', pts: band([[-10, 14], [0, 18], [10, 14]], 2.4, 2.4), tone: 'accent' }],
    }),
    part('spinneret', circle(0, 28, 4.4, 12), 'aid', 2.4, { glow: true }),
    part('head', blobby([[0, -36], [-11, -28], [-12, -12], [0, -6], [12, -12], [11, -28]], 3), 'hull', 2.6, { lift: 1, facets: [{ pts: [[0, -36], [-11, -28], [-12, -12], [0, -6]], slope: [-0.5, 0] }] }),
    ...core('eye', 0, -22, 4, 4.6, 2.8, false),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Gunship and corvette -----------------------------------------------------------------------------

/**
 * Ravager gunship: an elongated hunter. A segmented spine from a clawed head to two engine sacs, two
 * forelimbs carrying acid sprayers, a bio-turret of spines on its back, chitin plates down its flanks,
 * a violet core and trailing tendrils.
 */
export const gunship: ModelDef = () => {
  const parts: Part[] = [
    part('under', blobby([[0, -46], [-10, -30], [-18, -8], [-20, 14], [-12, 34], [0, 40], [12, 34], [20, 14], [18, -8], [10, -30]], 3), 'metal', 0.3, { lift: 0.5 }),
    ...sym(tendril('tendril', [[-6, 26], [-12, 38], [-10, 48]], 3.2, 0.4)),
    ...sym(part('limb', band([[-6, -14], [-20, -18], [-26, -28]], 6, 4), 'metal', 0.8, { lift: 0.8 })),
    ...sym(blade('aft', [[-6, 16], [-16, 26], [-20, 40]], 10, 'hull', 1, [-0.4, 0.3])),
    ...sym(blade('flank', [[-7, -4], [-22, 4], [-33, 18], [-33, 32]], 12, 'hull2', 1.1, [-0.45, 0.05])),
    engineSac('sacL', -8.25, 32, 49, 9, 0, 1.2),
    engineSac('sacR', 8.25, 32, 49, 9, 1, 1.2),
    ...sym(blade('shoulder', [[-5, -26], [-14, -18], [-18, -6]], 9, 'hull', 1.4, [-0.45, -0.1])),
    ...spine('seg', [[-30, 5.6, 12], [-17, 7, 13], [-3, 7.6, 13], [11, 7, 13], [24, 5.6, 11]], 'hull', 2),
    ...sym(blade('head', [[-2, -50], [-6, -42], [-8, -30]], 7, 'hull', 2.3, [-0.4, -0.3], {}, false)),
    ...sym(blade('jaw', [[-4, -42], [-10, -48], [-7, -52]], 3.4, 'hull2', 2.2, [-0.4, -0.3], {}, false)),
    ...acidOrgan('acidL', -25, -27, 6, 2.5),
    ...acidOrgan('acidR', 25, -27, 6, 2.5),
    ...core('core', 0, -18, 3.4, 4.4, 2.6, false),
    ...bioTurret('turret', 0, 4, 7, 2.7),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Leech corvette: a segmented armoured hunter that feeds. A round sucker mouth ringed in teeth at its
 * front with a violet glow in its gullet, feeding tendrils reaching forward either side with green
 * hooks, armoured segments down its body, a regen node (green core in a leaf shell) on its back that
 * passes the drained biomass on, and two engine sacs.
 */
export const corvette: ModelDef = () => {
  const parts: Part[] = [
    part('under', blobby([[0, -40], [-14, -30], [-20, -6], [-18, 20], [-10, 36], [0, 40], [10, 36], [18, 20], [20, -6], [14, -30]], 3), 'metal', 0.3, { lift: 0.5 }),
    ...sym(part('feeder', band([[-10, -24], [-24, -28], [-31, -38]], 4, 1.4), 'metal', 0.6, { lift: 0.6, details: [glands([[-31, -37]], 1.4)] })),
    ...sym(tendril('tail', [[-5, 30], [-14, 40], [-18, 50]], 3, 0.4)),
    // Pincers round the sucker mouth, then blades swept back down the flanks.
    ...sym(blade('pincer', [[-8, -30], [-17, -38], [-16, -47], [-9, -52]], 7, 'hull', 1, [-0.4, -0.3], {}, false)),
    ...sym(blade('hind', [[-7, 16], [-15, 26], [-18, 40]], 8, 'hull2', 1.05, [-0.4, 0.3])),
    ...sym(blade('flank', [[-8, 0], [-22, 8], [-30, 24]], 10, 'hull', 1.1, [-0.45, 0.05], { details: [glands([[-20, 10]], 0.9)] })),
    ...sym(blade('fore', [[-8, -18], [-22, -12], [-31, 0]], 10, 'hull2', 1.15, [-0.45, -0.05])),
    engineSac('sacL', -7.7, 32, 48, 8, 0, 1.2),
    engineSac('sacR', 7.7, 32, 48, 8, 1, 1.2),
    ...spine('seg', [[-30, 9, 12], [-18, 10.4, 13], [-5, 11, 14], [9, 10.4, 14], [22, 8.6, 12]], 'hull', 2),
    part('mouth', circle(0, -41, 9.6, 20), 'hull', 2.4, { lift: 1, slope: [0, -0.4], holes: [circle(0, -41, 6, 16)] }),
    part('gullet', circle(0, -41, 6.4, 16), 'dark', 2.3, { details: [{ k: 'shape', pts: circle(0, -41, 3.4, 10), tone: 'glow' }, ...Array.from({ length: 6 }, (_, i): Detail => ({ k: 'shape', pts: turn([[-1, -6.2], [1, -6.2], [0, -3.8]], (i / 6) * Math.PI * 2, 0, 0).map(([x, y]) => [x, y - 41] as Pt), tone: 'hull' }))] }),
    ...sym(plate('leaf', blobby([[0, -2], [-9, 2], [-11, 12], [-6, 20], [0, 22]], 3), 'hull', 2.6, [-0.45, 0])),
    part('nodeSocket', circle(0, 10, 5.2, 14, 7), 'dark', 2.7, { lift: 0.3 }),
    part('node', circle(0, 10, 3.8, 14, 5.4), 'aid', 2.8, { glow: true, details: [{ k: 'lights', pts: [[-0.8, 8.6]], r: 1, tone: 'aid' }] }),
    ...core('core', 0, -22, 3, 3.6, 2.7, false),
  ]
  return { parts, breakStyle: 'bands' }
}
