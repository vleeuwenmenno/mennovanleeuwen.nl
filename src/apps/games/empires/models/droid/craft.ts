import { along, circle, fullHull, halfHull, move, part, rect, sym, thick } from '../kit.ts'
import type { ModelDef } from '../spec.ts'
import type { Detail, Part } from '../types.ts'
import { across, ambers, armour, block, bridge, cells, engineModule, lamps, mark, nacelle, recess, seam, windows } from './parts.ts'

// The Confederacy's strike craft, gunship and corvette (refs/confederacy.webp, "Ship lineup"):
// narrow forks and sharp swept wings for the fighters, twin fuselages with external ordnance for
// the bomber, a forward-facing weapon platform for the gunship, a compact segmented hull for the
// corvette. Small craft keep to silhouette and colour: a few big plates, one orange marking, cyan
// engines; their seams are lines, which only show when they are drawn big.

// --- Strike craft ------------------------------------------------------------------------------------

/**
 * Talon interceptor: a fork-nosed dart. Two prongs reach forward either side of a short cockpit
 * nose, sharp swept wings with orange tips, one square engine module at the tail.
 */
export const fighter: ModelDef = () => {
  const parts: Part[] = [
    ...sym(part('wing', [[-6, -2], [-37, 24], [-38, 33], [-30, 33], [-7, 21]], 'hull', 1, {
      slope: [-0.3, -0.3],
      lift: 0.6,
      detach: { death: true },
      details: [mark([[-29, 18], [-37, 25], [-37.6, 29.5], [-30, 23]]), seam([-10, 4], [-30, 26])],
    })),
    ...sym(part('fuselage', halfHull([[-26, 4], [-14, 8], [2, 9.4], [20, 8.4], [33, 6.4]]), 'hull2', 2, { slope: [-0.5, 0], details: [across(-8.4, 0, 8)] })),
    ...sym(part('prong', [[-12, -16], [-9.4, -46], [-7.4, -50], [-5.4, -46], [-4, -16]], 'hull', 2.4, {
      lift: 0.8,
      slope: [-0.4, -0.1],
      details: [mark([[-9.2, -40], [-7.6, -44], [-6.6, -30], [-8.4, -28]])],
    })),
    ...sym(part('cannon', rect(-4.2, -34, 1.8, 18), 'dark', 2.2, { details: [mark(rect(-4.2, -24, 1.8, 1.2))] })),
    engineModule('engine', 0, 28, 47, 12, 0, 2.6),
    part('spine', block(0, 8, 5, 30, 1.4, 0.8), 'metal', 2.4, { lift: 0.5, details: [{ k: 'shape', pts: rect(-0.6, -4, 1.2, 24), tone: 'trim' }] }),
    part('canopy', block(0, -12, 6.4, 13, 2.6, 1), 'glass', 3, { lift: 0.8, details: [seam([0, -17], [0, -7])] }),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Havoc bomber: two armoured fuselages side by side joined by a centre wing, a cockpit in each,
 * stub wings outboard with ordnance slung under them (orange-tipped shaped charges) and a recessed
 * bomb rack between the hulls; an engine module at the back of each fuselage.
 */
export const bomber: ModelDef = () => {
  const rows: [number, number][] = [[-46, 3], [-38, 6.4], [-14, 7.6], [22, 7.6], [36, 5.6]]
  const hull = fullHull(rows)
  const left = halfHull(rows)
  const charge = (x: number, y0: number, y1: number, id: string): Part =>
    part(id, [...thick([[x, y1], [x, y0]], 3.4, 3.4)], 'metal', 1.4, { lift: 0.6, detach: { death: true }, details: [mark(rect(x - 1.7, y0 - 1.6, 3.4, 3.2))] })
  const parts: Part[] = [
    ...sym(part('stub', [[-22, -6], [-44, 6], [-44, 16], [-22, 18]], 'hull2', 1, { slope: [-0.3, -0.2], detach: { death: true }, details: [mark([[-40, 7], [-44, 8], [-44, 11], [-40, 10]])] })),
    charge(-34, -14, 14, 'chargeL'),
    charge(34, -14, 14, 'chargeR'),
    part('wing', block(0, 2, 34, 30, 6, 3), 'hull2', 1.2, {
      lift: 0.6,
      details: [recess(rect(-8, -8, 16, 22)), ...[-4, 4].flatMap((x) => [-4, 4, 12].map((y): Detail => mark(rect(x - 1.6, y - 1.6, 3.2, 3.2)))), across(-17, 17, -10)],
    }),
    ...[-1, 1].map((s) =>
      part(s < 0 ? 'hullL' : 'hullR', move(hull, s * 16, 0), 'hull', 2, {
        lift: 1,
        facets: [{ pts: move(left, s * 16, 0), slope: [-0.5, 0] }],
        details: [mark(rect(s * 16 - 7.6, 16, 15.2, 2.4)), across(s * 16 - 7, s * 16 + 7, -20)],
      }),
    ),
    ...[-1, 1].map((s, i) => engineModule(s < 0 ? 'engineL' : 'engineR', s * 16.2, 30, 47, 10, i, 2.6)),
    ...[-1, 1].map((s) => part(s < 0 ? 'canopyL' : 'canopyR', block(s * 16, -28, 5.6, 10, 2.4, 1), 'glass', 3, { lift: 0.6 })),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Patchwork repair fighter: a salvage craft bolted together from spares, lopsided on purpose: a
 * gunmetal core with mismatched armour blocks either side (one still in orange primer), a long
 * welding arm reaching forward on the right with a torch at its claw, a short clamp arm on the
 * left, a teal-green work light on top and one engine module.
 */
export const repair: ModelDef = () => {
  const torch = (x: number, y: number): Detail => ({ k: 'lights', pts: [[x, y]], r: 1.2, tone: 'ember' })
  const parts: Part[] = [
    part('armR', thick([[8, -8], [21, -26], [15, -44]], 4.4, 2.8), 'metal', 1, { lift: 0.8, detach: { hull: 0.3 }, details: [{ k: 'shape', pts: circle(21, -26, 2.2, 10), tone: 'dark' }] }),
    part('claw', [[13, -43], [14, -49], [16.4, -47], [17, -44.6], [19.6, -48.6], [20.4, -45.4], [17, -41]], 'dark', 1.2, { detach: { hull: 0.3 }, details: [torch(16.6, -47.4)] }),
    part('armL', thick([[-8, -10], [-17, -24], [-15, -32]], 4, 3), 'metal', 1, { lift: 0.8, detach: { hull: 0.2 } }),
    part('clamp', block(-15, -34, 7, 4, 1), 'hull2', 1.2, { detach: { hull: 0.2 } }),
    engineModule('engine', 0, 28, 46, 13, 0, 1.6),
    part('core', block(0, 4, 24, 40, 6, 3), 'hull2', 2, {
      lift: 1,
      facets: [{ pts: rect(-12, -16, 12, 40), slope: [-0.5, 0] }],
      details: [recess(rect(-5, -8, 10, 18)), { k: 'lights', pts: [[0, 2]], r: 1.4, tone: 'aid' }, across(-12, 12, 14)],
    }),
    armour('blockL', -15, 0, 11, 22, 2.4, { tone: 'hull' }),
    armour('blockR', 15, 8, 10, 16, 2.4, { tone: 'accent', band: false }),
    part('dome', circle(-3, -14, 4.6, 14), 'glass', 2.8, { sphere: true }),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Spectre picket: the Command Hub's defense wing. A slim arrowhead in steel with orange-plasma
 * bands, a forked tail either side of its engine and a teal canopy.
 */
export const picket: ModelDef = () => {
  const parts: Part[] = [
    ...sym(part('tail', [[-7, 14], [-15, 30], [-18, 42], [-13, 42], [-4, 24]], 'hull2', 1, { slope: [-0.3, 0.2], detach: { death: true }, details: [{ k: 'shape', pts: [[-14, 33], [-17, 40], [-14.6, 40], [-12, 33]], tone: 'trim' }] })),
    engineModule('engine', 0, 24, 45, 9, 0, 1.5),
    ...sym(part('body', halfHull([[-48, 1.2], [-36, 6], [-12, 13], [10, 18], [20, 17], [27, 9]]), 'hull', 2, {
      slope: [-0.5, -0.1],
      lift: 0.6,
      details: [{ k: 'shape', pts: [[-6, -22], [-10.6, -12], [-12.4, -8], [-8, -16]], tone: 'trim' }, seam([-3, -30], [-14, 10])],
    })),
    part('keel', block(0, 0, 6, 30, 2, 1), 'hull2', 2.4, { lift: 0.4, details: [recess(rect(-1.4, -8, 2.8, 18))] }),
    ...sym(part('blade', [[-9, -14], [-14, 4], [-13, 10], [-8, -2]], 'hull2', 2.2, { lift: 0.6, slope: [-0.5, 0], details: [{ k: 'shape', pts: [[-10, -8], [-13, 3], [-12.4, 6], [-9.6, -2]], tone: 'trim' }] })),
    part('canopy', block(0, -18, 5, 12, 2.2, 1), 'glass', 2.6, { lift: 0.6 }),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Forger engineer: a yard tug. A boxy gunmetal hull with a cab up front, fresh hull plate racked
 * on both flanks, two jointed cutting arms reaching forward with torches burning at their tips, and
 * two engine modules.
 */
export const engineer: ModelDef = ({ w }) => {
  const ex = (3.5 / 10 - 0.5) * w
  const parts: Part[] = [
    ...sym(part('arm', thick([[-8, -12], [-20, -26], [-13, -44]], 4.2, 2.6), 'metal', 1, {
      lift: 0.8,
      detach: { hull: 0.3 },
      details: [{ k: 'shape', pts: circle(-20, -26, 2.2, 10), tone: 'dark' }, { k: 'lights', pts: [[-13, -44.4]], r: 1.3, tone: 'ember' }],
    }), { detach: { hull: 0.2 } }),
    ...[-1, 1].map((s, i) => engineModule(s < 0 ? 'engineL' : 'engineR', s * -ex, 28, 46, 9, i, 1.6)),
    part('hull', block(0, 2, 26, 44, 5, 3), 'hull2', 2, {
      lift: 1,
      facets: [{ pts: rect(-13, -20, 13, 44), slope: [-0.5, 0] }],
      details: [recess(rect(-6, 0, 12, 16)), across(-13, 13, 18), mark([[-13, 20], [-9, 20], [-5, 24], [-9, 24]]), mark([[13, 20], [9, 20], [5, 24], [9, 24]])],
    }),
    ...sym(part('rack', block(-19, 4, 9, 26, 2, 1), 'hull', 2.2, { lift: 1.2, details: [across(-23.5, -14.5, -2), across(-23.5, -14.5, 4), across(-23.5, -14.5, 10), mark(rect(-23.5, 14, 9, 2))] })),
    bridge('cab', 0, -14, 15, 9, 2.6),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Gunship and corvette ----------------------------------------------------------------------------

/**
 * Raptor gunship: a forward-facing weapon platform. A broad gun deck across the bow carries two
 * heavy cannon barrels and a missile rack between them, all pointing ahead; behind it a short
 * fuselage with the bridge, sharp swept wings carrying side nacelles, and two engine modules.
 */
export const gunship: ModelDef = ({ w }) => {
  const ex = (3.6 / 10 - 0.5) * w
  const parts: Part[] = [
    ...sym(part('wing', [[-10, -8], [-44, 14], [-46, 24], [-12, 22]], 'hull2', 1, {
      slope: [-0.3, -0.3],
      lift: 0.6,
      detach: { hull: 0.35 },
      details: [mark([[-38, 13], [-45, 17], [-45.6, 20.6], [-38, 17]]), seam([-14, 0], [-40, 16])],
    }), { detach: { hull: 0.2 } }),
    ...sym(nacelle('nacelle', -29, 2, 26, 7, -1, 1.6, { detach: { death: true } })),
    ...sym(part('fuselage', halfHull([[-36, 7], [-24, 11], [0, 12.4], [22, 11.4], [36, 8]]), 'hull', 2, {
      slope: [-0.5, 0],
      lift: 0.8,
      details: [across(-11, 0, 4), mark(rect(-10.4, 24, 6, 2))],
    })),
    ...[-1, 1].map((s, i) => engineModule(s < 0 ? 'engineL' : 'engineR', s * -ex, 28, 47, 11, i, 2.2)),
    // The gun deck across the bow: two heavy barrels and the missile rack, all firing forward.
    ...sym(part('barrel', rect(-17, -50, 4, 18), 'dark', 2.6, { details: [seam([-15, -49], [-15, -33]), mark(rect(-17, -40, 4, 1.6))] })),
    part('deck', block(0, -30, 50, 12, 4, 2), 'hull2', 3, {
      lift: 1.4,
      facets: [{ pts: rect(-25, -36, 25, 12), slope: [-0.5, 0] }],
      details: [mark(rect(-25, -26.2, 50, 1.4)), across(-24, 24, -33)],
    }),
    cells('rack', 0, -31, 3, 1, 3.2, 3.4),
    bridge('bridge', 0, -12, 12, 10, 3.2),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Reclaimer corvette: a compact, heavily segmented salvage tender. Three armour segments down a
 * gunmetal keel, a pair of salvage pincers at the bow, a crane arm over the forward segment, a
 * repair bay in the middle with green work lights, a flak tub aft and two engine modules.
 */
export const corvette: ModelDef = ({ w }) => {
  const ex = (3.3 / 10 - 0.5) * w
  const parts: Part[] = [
    ...sym(part('pincer', thick([[-8, -36], [-14, -44], [-9, -50]], 4, 2.4), 'metal', 1, { lift: 0.8, detach: { hull: 0.35 }, details: [mark(circle(-14, -44, 1.6, 8))] }), { detach: { hull: 0.25 } }),
    part('keel', rect(-6, -40, 12, 82), 'metal', 1.2, { details: along([0, -36], [0, 38], 8).map(([, y]) => across(-6, 6, y)) }),
    ...[-1, 1].map((s, i) => engineModule(s < 0 ? 'engineL' : 'engineR', s * -ex, 30, 48, 10, i, 1.6)),
    armour('bow', 0, -32, 24, 18, 2, { tone: 'hull' }),
    part('mid', block(0, -6, 34, 28, 5, 3), 'hull2', 2, {
      lift: 1.2,
      facets: [{ pts: rect(-17, -20, 17, 28), slope: [-0.5, 0] }],
      details: [recess(rect(-9, -14, 18, 16)), { k: 'lights', pts: along([-6, -6], [6, -6], 3), r: 1, tone: 'aid' }, across(-17, 17, 4)],
    }),
    ...sym(armour('side', -18, -6, 6, 20, 2.2, { tone: 'hull', band: false, detach: { hull: 0.4 } }), { detach: { hull: 0.3 } }),
    armour('aft', 0, 19, 30, 20, 2, { tone: 'hull' }),
    part('tub', circle(0, 17, 4.6, 14), 'hull2', 2.6, { lift: 0.8, details: [recess(circle(0, 17, 2.6, 10)), ...[-1.4, 0, 1.4].map((x): Detail => ({ k: 'shape', pts: rect(x - 0.4, 9, 0.8, 5), tone: 'dark' }))] }),
    part('crane', thick([[-8, -16], [10, -30], [14, -26]], 3, 2), 'metal', 3, { lift: 2, detach: { hull: 0.5 }, details: [ambers([[14, -26]], 0.8)] }),
    bridge('bridge', 0, 32, 12, 7, 2.6),
    part('lamp', [], 'glow', 4, { glow: true, noOutline: true, details: [lamps([[-15, -22], [15, -22]], 0.7), windows([[0, -40]], 0.7)] }),
  ]
  return { parts, breakStyle: 'bands' }
}
