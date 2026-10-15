import { along, circle, halfHull, part, rect, sym, thick } from '../kit.ts'
import { hpAt, seat, type SeatLook } from '../proto.ts'
import type { BuildCtx, ModelDef, ModelSpec } from '../spec.ts'
import type { Detail, Part, Pt } from '../types.ts'
import { across, ambers, antenna, armour, block, bridge, cells, engineModule, mark, nacelle, recess, seam, spine, windows } from './parts.ts'

// The Confederacy's warships at their size (sizes.ts), each built round its weapons
// (refs/confederacy.webp): the Breaker destroyer round its spinal ion lance, the Lancer frigate's
// split bow, the Harrow cruiser's long spine between armoured gun pods, the Tyrant battleship's
// fire-control tower, and the Dominator dreadnought, a massive multi-section assault ship. Every
// gun sits on its own seat on a hardpoint where the faction's `layout` (data/droid.ts) puts it; the
// turrets themselves are drawn by mounts.ts. Engines are external modules with square cyan nozzles.

/** Confederacy seats: a dark charcoal pad, a gunmetal barbette with an orange band. */
export const CONFED_SEAT: SeatLook = { pad: 'metal', heavy: 'hull2', band: 'accent' }

/** The seat under hardpoint `i`, a little wider than its turret. */
const seatAt = (c: BuildCtx, i: number, z: number, heavy = false, k = 1.25) => seat(`seat${i}`, c, i, ((c.t.hardpoints[i].s ?? 0.05) * 100 * k) / 2, z, heavy, CONFED_SEAT)

/** Every gun hardpoint's seat (engines have none). */
const seats = (c: BuildCtx, z: number, heavy: (i: number) => boolean = () => false): Part[] =>
  c.t.hardpoints.flatMap((h, i) => (h.kind === 'engine' ? [] : [seatAt(c, i, z, heavy(i))]))

/** Orange capacitor bands across a lance or barrel at each y, `w` wide. */
const capacitors = (x: number, w: number, ys: number[]): Detail[] => ys.map((y) => mark(rect(x - w / 2, y - 0.8, w, 1.6)))

// --- Breaker destroyer --------------------------------------------------------------------------------

/**
 * Breaker destroyer: a long line ship built round its weapon. The spinal ion lance runs down the
 * keel from the bow, ringed with orange capacitor bands, between two short prongs and armoured
 * housings; its muzzle at the very bow is shot off with the lance's hardpoint. Behind it the dual
 * cannons and the shield generator sit down the spine, the flak aft between swept fins, two engine
 * modules at the stern. The lance's hardpoint is a collar (the lance is the hull, fixed along the
 * keel), showing a burnt stump once it is shot out.
 */
export const breaker: ModelDef = (c): ModelSpec => {
  const ex = (3.3 / 10 - 0.5) * c.w
  const parts: Part[] = [
    ...sym(part('hull', halfHull([[-40, 3], [-30, 6], [-12, 8], [6, 10], [22, 11.6], [36, 11.6], [44, 8]]), 'hull2', 1, { slope: [-0.5, 0], details: [seam([-6, -10], [-9.6, 20]), across(-11, 0, 22)] })),
    ...sym(part('fin', [[-10, 26], [-13, 36], [-13, 42], [-9.6, 40]], 'hull', 1.4, { slope: [-0.4, 0.1], detach: { hull: 0.4 }, details: [mark([[-11.4, 31], [-12.8, 36], [-12.8, 38], [-11, 34]])] }), { detach: { hull: 0.28 } }),
    ...sym(armour('pod', -9.4, 9, 4.6, 16, 1.6, { tone: 'hull', band: false, detach: { hull: 0.34 } }), { detach: { hull: 0.22 } }),
    spine('spine', 0, -6, 38, 4.4, 1.8),
    ...[0, 1].map((i) => engineModule(i ? 'engineR' : 'engineL', (i ? 1 : -1) * -ex, 38, 49.4, 6.6, i, 2)),
    // The lance: prongs either side, armoured housings, the barrel ringed with capacitors.
    ...sym(part('prong', [[-6.4, -26], [-5.6, -44], [-4.4, -48], [-3.4, -44], [-3, -26]], 'hull', 2.2, { lift: 0.8, slope: [-0.4, 0], details: [mark([[-5.4, -40], [-4.6, -43], [-4, -36], [-4.8, -34]])] })),
    ...sym(armour('housing', -5.4, -16, 5, 20, 2.4, { tone: 'hull', band: true })),
    part('lance', rect(-2, -46, 4, 42), 'dark', 2.6, { lift: 1, details: [...capacitors(0, 4, [-40, -34, -28, -22, -16, -10]), seam([0, -45], [0, -5]), ambers(along([0, -43], [0, -7], 7), 0.35)] }),
    part('muzzle', block(0, -48, 5.4, 4.4, 1.4, 0.6), 'metal', 2.8, { lift: 1.2, detach: { hp: 0 }, details: [{ k: 'lights', pts: [[0, -49]], r: 0.9, tone: 'glow' }] }),
    ...seats(c, 2.4, (i) => i === 1 || i === 2),
    antenna('mast', [3.4, 18], [8, 12], 1, 3, { detach: { hull: 0.5 } }),
  ]
  // The lance's hardpoint is drawn as the hull: a collar that shows only once it is shot out.
  return { parts, breakStyle: 'bands', mount: (i) => (i === 0 ? { design: 'collar' } : i === 4 ? { detach: true } : undefined) }
}

// --- Lancer frigate -----------------------------------------------------------------------------------

/**
 * Lancer frigate: a split bow. Two long armoured booms reach forward either side of the central
 * hull, a dual cannon on each boom's root; a cross brace joins them, the shield generator sits on
 * the spine behind, flak on sponsons aft, side nacelles outboard, the bridge core near the stern
 * and three engine modules. The boom tips come off as it is battered.
 */
export const lancer: ModelDef = (c): ModelSpec => {
  const boom: Pt[] = [[-15, -44], [-10.6, -42], [-8, -30], [-8, 6], [-10, 14], [-18, 14], [-19.4, -18], [-17.6, -38]]
  const parts: Part[] = [
    ...sym(nacelle('nacelle', -20.6, 14, 38, 6.6, -1, 0.8, { detach: { hull: 0.32 } }), { detach: { hull: 0.2 } }),
    ...sym(part('hull', halfHull([[-26, 3], [-14, 7.4], [0, 9], [20, 11], [34, 10.4], [42, 8]]), 'hull2', 1, { slope: [-0.5, 0], details: [seam([-4, -10], [-6, 30]), across(-10, 0, 30)] })),
    spine('spine', 0, -22, 30, 4, 1.2),
    ...sym(part('boom', boom, 'hull', 1.6, {
      lift: 1.4,
      facets: [{ pts: [[-15, -44], [-17.6, -38], [-19.4, -18], [-18, 14], [-14, 14], [-14, -44]], slope: [-0.5, 0] }],
      details: [mark([[-17.6, -2], [-19, -2], [-18.6, 10], [-17.2, 10]]), recess(rect(-15.6, -30, 4, 10)), seam([-8.6, 0], [-18.8, 0]), seam([-13, -40], [-13, 10])],
    })),
    ...sym(part('tip', [[-15, -50], [-10.4, -46], [-10.4, -42.6], [-15, -44], [-17.6, -38.6], [-17.2, -44]], 'hull', 2, { lift: 1.4, slope: [-0.3, -0.4], detach: { hull: 0.45 }, details: [mark([[-15, -48], [-12, -46], [-12, -44.4], [-15, -45.6]])] }), { detach: { hull: 0.3 } }),
    part('brace', block(0, -10, 20, 7, 2), 'metal', 1.8, { lift: 1, details: [ambers(along([-6, -10], [6, -10], 4), 0.45)] }),
    ...sym(armour('sponson', -14, 24, 9, 11, 1.8, { tone: 'hull', band: false })),
    engineModule('engine0', -7, 38, 49, 6.6, 0, 2.2),
    engineModule('engine1', 0, 39, 50, 7, 1, 2.2),
    engineModule('engine2', 7, 38, 49, 6.6, 2, 2.2),
    bridge('bridge', 0, 21, 10, 9, 2.4),
    ...seats(c, 2.4, (i) => i < 2),
    antenna('mast', [-3, 30], [-5, 37], 0.9, 3, { detach: { hull: 0.5 } }),
  ]
  return { parts, breakStyle: 'bands', mount: (i) => ({ detach: i >= 3 }) }
}

// --- Harrow cruiser -----------------------------------------------------------------------------------

/**
 * Harrow cruiser: a long central spine, exposed and ribbed, with two big armoured gun pods either
 * side of it on struts, a heavy triple battery on each pod with a missile-cell array and flak
 * behind it. The fore and aft batteries and the shield generator sit down the spine; two prongs at
 * the bow, the bridge core aft, two engine modules (shot off with their hardpoints).
 */
export const harrow: ModelDef = (c): ModelSpec => {
  const pod = (s: number): Part[] => {
    const x = s * 18
    const id = s < 0 ? 'L' : 'R'
    return [
      part(`pod${id}`, block(x, 1, 12, 46, 3, 2), 'hull', 1.6, {
        lift: 1.6,
        facets: [{ pts: rect(x - 6, -22, 6, 46), slope: [-0.5, 0] }],
        details: [mark(rect(x + s * 4.4 - 0.7, -18, 1.4, 34)), seam([x - 6, -14], [x + 6, -14]), seam([x - 6, 20], [x + 6, 20]), recess(rect(x - 3, 18, 6, 4))],
      }),
      part(`podNose${id}`, [[x - 6, -21], [x - 3, -29], [x + 3, -29], [x + 6, -21]], 'hull2', 1.8, { lift: 1.4, slope: [0, -0.5], detach: { hull: s < 0 ? 0.4 : 0.3 }, details: [mark([[x - 2.4, -27], [x + 2.4, -27], [x + 3.6, -24], [x - 3.6, -24]])] }),
      part(`strutF${id}`, rect(s < 0 ? x + 5 : x - 10, -14, 5, 5), 'metal', 1.2),
      part(`strutA${id}`, rect(s < 0 ? x + 5 : x - 10, 12, 5, 5), 'metal', 1.2),
      cells(`cells${id}`, x, 5, 2, 2, 2, 2.2),
    ]
  }
  const parts: Part[] = [
    ...sym(part('hull', halfHull([[-48, 2], [-44, 5], [-30, 7], [0, 8], [30, 8], [42, 7], [46, 5]]), 'hull2', 1, { slope: [-0.5, 0], details: [seam([-5.6, -30], [-5.6, 30])] })),
    spine('spine', 0, -38, 34, 4.4, 1.4),
    ...pod(-1),
    ...pod(1),
    ...sym(part('prong', [[-5, -30], [-4, -50], [-2.4, -47], [-1.6, -30]], 'hull', 1.8, { lift: 0.8, slope: [-0.4, 0], details: [mark([[-4, -42], [-3, -45], [-2.4, -40], [-3.4, -38]])] })),
    engineModule('engineL', -7.1, 36, 49, 7, 0, 2, { detach: { hp: 7 } }),
    engineModule('engineR', 7.1, 36, 49, 7, 1, 2, { detach: { hp: 8 } }),
    bridge('bridge', 0, 30, 10, 8, 2.4),
    ...seats(c, 2.4, (i) => i < 2),
    antenna('mast', [3, 33], [7, 27], 0.9, 3, { detach: { hull: 0.5 } }),
    antenna('mast2', [-3, -38], [-3, -44], 0.8, 2.6, { detach: { hull: 0.6 } }),
  ]
  return { parts, breakStyle: 'bands', mount: (i) => ({ detach: i === 4 || i === 5 }) }
}

// --- Tyrant battleship --------------------------------------------------------------------------------

/**
 * Tyrant battleship: fleet support, between the Harrow and the Dominator in size. A broad armoured
 * hull with heavy side pods, and in its middle the fire-control tower that gives it its job: a tall
 * stepped block banked with teal sensor windows, two dishes and an antenna array on top, a
 * missile-cell array behind it. Four heavy batteries on the hull and pods, flak at the bow, two
 * shield generators aft and two engine modules (shot off with their hardpoints).
 */
export const tyrant: ModelDef = (c): ModelSpec => {
  const parts: Part[] = [
    ...sym(part('hull', halfHull([[-48, 4], [-40, 10], [-24, 14], [0, 16], [24, 16], [38, 14], [46, 10]]), 'hull2', 1, { slope: [-0.5, 0], details: [seam([-10, -30], [-12, 30]), across(-16, 0, 18)] })),
    ...sym(part('pod', block(-19, 6, 10, 42, 3, 2), 'hull', 1.6, {
      lift: 1.6,
      facets: [{ pts: rect(-24, -15, 5, 42), slope: [-0.5, 0] }],
      details: [mark(rect(-23.2, -10, 1.4, 12)), seam([-24, 20], [-14, 20]), recess(rect(-21, 22, 4, 4))],
    })),
    ...sym(part('podNose', [[-24, -14], [-21, -22], [-17, -22], [-14, -14]], 'hull2', 1.8, { lift: 1.4, slope: [0, -0.5], detach: { hull: 0.38 } }), { detach: { hull: 0.28 } }),
    ...sym(armour('bow', -7, -40, 6, 10, 1.6, { tone: 'hull', band: false })),
    spine('spine', 0, -34, 40, 4, 1.4),
    // The fire-control tower: a stepped block, banks of sensor windows, dishes and an array.
    part('tower', block(0, -2, 15, 22, 4, 2), 'hull', 2.6, {
      lift: 2.4,
      facets: [{ pts: rect(-7.5, -13, 7.5, 22), slope: [-0.5, 0] }, { pts: rect(-3.5, -13, 7, 4), slope: [0, -0.5] }],
      details: [recess(rect(-5, -9, 10, 3)), windows(along([-4, -7.5], [4, -7.5], 5), 0.4), mark(rect(-6, 5, 12, 1.4)), recess(rect(-4, 1, 8, 2.4)), windows(along([-3, 2.2], [3, 2.2], 4), 0.35)],
    }),
    part('crown', block(0, -4, 8, 8, 2), 'hull2', 2.9, { lift: 3, details: [windows([[0, -4]], 0.6), seam([-4, -4], [4, -4])] }),
    ...sym(part('dish', circle(-5.4, -12, 2.4, 14), 'hull2', 3, { lift: 2.6, slope: [0.3, 0.3], detach: { hull: 0.5 }, details: [recess(circle(-5, -11.6, 1.2, 10))] }), { detach: { hull: 0.42 } }),
    cells('cells', 0, 16, 3, 2, 2.2, 2.2),
    engineModule('engineL', -7, 36, 49, 8, 0, 2, { detach: { hp: 8 } }),
    engineModule('engineR', 7, 36, 49, 8, 1, 2, { detach: { hp: 9 } }),
    bridge('bridge', 0, 32, 10, 7, 2.4),
    ...seats(c, 2.4, (i) => i < 4),
    antenna('array', [0, -8], [0, -16], 1, 3.2, { detach: { hull: 0.55 } }),
  ]
  return { parts, breakStyle: 'bands', cuts: 3, mount: (i) => ({ detach: i === 4 || i === 5 }) }
}

// --- Dominator dreadnought ----------------------------------------------------------------------------

/**
 * Dominator dreadnought: a massive multi-section assault vessel, the sheet's capital ship. Twin
 * prongs at the bow with flak on them and the bridge core between their roots; forward armour
 * wings carrying the mid batteries; a central hull of armour blocks with a missile-cell array down
 * its middle, the shield generators either side of it; side nacelles with orange light strips and
 * flak; the aft batteries, the hangar module and a cluster of five engine modules at the stern.
 */
export const dominator: ModelDef = (c): ModelSpec => {
  const ex = [3, 4, 5, 6, 7].map((g) => (g / 10 - 0.5) * c.w)
  const parts: Part[] = [
    ...sym(part('hull', halfHull([[-34, 8], [-24, 14], [-8, 18], [10, 20], [28, 19.4], [40, 16.4], [47, 12]]), 'hull2', 1, { slope: [-0.5, 0], details: [seam([-12, -20], [-16, 34]), across(-19, 0, 10), across(-19, 0, 30)] })),
    ...sym(part('wing', [[-14, -24], [-28, -15], [-29, -3], [-16, 0]], 'hull', 1.4, {
      lift: 1.4,
      slope: [-0.4, -0.3],
      details: [mark([[-26.4, -14], [-28.4, -12.6], [-28.6, -5], [-26.6, -4]]), seam([-16, -20], [-26, -6])],
    })),
    ...sym(nacelle('nacelle', -27, -2, 30, 8, -1, 1.2)),
    ...sym(part('nacelleTip', [[-30.4, 30], [-23.6, 30], [-24.4, 36], [-29.6, 36]], 'hull2', 1.3, { lift: 1, detach: { hull: 0.36 }, details: [{ k: 'lights', pts: [[-27, 34]], r: 1, tone: 'glow' }] }), { detach: { hull: 0.26 } }),
    spine('spine', 0, -22, 40, 5, 1.6),
    // The bow: twin prongs and the bridge core between their roots.
    ...sym(part('prong', [[-10.6, -26], [-8, -48], [-6, -50], [-3.4, -44], [-3, -26]], 'hull', 2, {
      lift: 1.4,
      facets: [{ pts: [[-10.6, -26], [-8, -48], [-6.6, -49.4], [-6.8, -26]], slope: [-0.5, 0] }],
      details: [mark([[-8.6, -34], [-7.4, -44], [-6.2, -44], [-6.8, -32]])],
    })),
    bridge('bridge', 0, -30, 8, 10, 2.4),
    // Armour blocks down the flanks, the aft ones shot off as it is battered.
    ...sym(armour('blockF', -16, 6, 7, 10, 2, { tone: 'hull' })),
    ...sym(armour('blockA', -20, 13.6, 6, 8, 2, { tone: 'hull', band: false, detach: { hull: 0.3 } }), { detach: { hull: 0.2 } }),
    ...sym(armour('blockS', -17, 34, 8, 9, 2, { tone: 'hull' })),
    cells('cells', 0, -9, 2, 3, 2.4, 2.4),
    ...ex.map((x, i) => engineModule(`engine${i}`, x, i === 2 ? 39 : i % 4 ? 38.4 : 37.6, i === 2 ? 50 : i % 4 ? 49.4 : 48.6, 5.4, i, 2.2, i === 2 ? { detach: { hp: 12 } } : i === 0 ? { detach: { hull: 0.16 } } : i === 4 ? { detach: { hull: 0.1 } } : {})),
    ...seats(c, 2.6, (i) => i < 6),
    ...sym(antenna('mast', [-4, -22], [-6, -28], 0.9, 3, { detach: { hull: 0.55 } }), { detach: { hull: 0.48 } }),
  ]
  return { parts, breakStyle: 'bands', cuts: 3, mount: (i) => ({ detach: i >= 6 && i < 10 }) }
}

/** Where hardpoint `i` sits (for the seats of designs that place more by it). */
export const at = hpAt
/** A thin girder between two points. */
export const girder = (id: string, a: Pt, b: Pt, w: number, z: number): Part => part(id, thick([a, b], w), 'metal', z, { lift: 1 })
