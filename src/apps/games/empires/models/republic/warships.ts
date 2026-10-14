import { along, box, capsule, chamfer, circle, halfHull, part, rect, sym } from '../kit.ts'
import { calm, edgeAt, edgeLine, plate, seat, widthAt } from '../proto.ts'
import type { ModelDef, ModelSpec } from '../spec.ts'
import type { Detail, Part, Pt } from '../types.ts'
import * as classic from './craft.ts'
import { edgeBand, nacelle } from './craft.ts'

// The Republic's warships at their size (sizes.ts), their hardpoints where its `layout` (data/
// republic.ts) puts them: one turret per gun, spread over the hull with room between them, each on
// its own pad or barbette, built with the shared helpers in models/proto.ts (plates, seats, calm).
//
// The look is meant to read as big and slow: large, quiet surfaces with a few crisp details. Long
// armour plates down the flanks, a raised deck, a trench, a strong stepped superstructure with its
// bridge, a few masts and dishes, an engine bank, and lights placed sparingly.

/**
 * Warden frigate, redesigned at 1.4×: the same escort dagger, built up in a few big pieces. A lower
 * hull with red edge bands and detachable wing tips; three long armour plates down each flank (the
 * middle and aft ones blown off as it is battered); a raised forward deck with a short docking
 * trench in its bow; the turbolaser on a barbette ahead of a stepped superstructure that carries
 * the bridge, two masts, a dish and the shield dome; an engine bank of three main engines and two
 * auxiliary nozzles. Its four flak turrets sit in pairs: forward on the deck, aft on the flanks.
 */
export const frigate: ModelDef = (c): ModelSpec => {
  const rows: [number, number][] = [[-50, 0.4], [-44, 4], [-34, 9.2], [-22, 14.8], [-8, 20.6], [6, 25.8], [18, 29.6]]
  const left: Pt[] = [...halfHull(rows).slice(0, -1), [-26.5, 26], [-26.5, 38], [-18, 42], [0, 42]]
  const tip: Pt[] = [[-29.6, 18], [-32.6, 28], [-33.5, 33], [-30, 37.5], [-26.5, 38], [-26.5, 26]]
  const deckRows: [number, number][] = [[-45, 0.8], [-38, 3.6], [-26, 8.4], [-12, 11.4], [0, 12.4]]
  const hullDetails: Detail[] = [
    { k: 'shape', pts: edgeBand(rows.slice(1), 2.8), tone: 'accent' },
    { k: 'lights', pts: [-26, -14, -2].map((y) => edgeAt(rows, y, 5.6)), r: 0.42 },
    edgeLine(rows, -30, 20, 11.5),
    ...[-16, 2].map((y): Detail => ({ k: 'line', pts: [edgeAt(rows, y, 2.8), edgeAt(rows, y, 11.5)] })),
    { k: 'shape', pts: [[-24, 30], [-15, 28], [-15, 34]], tone: 'accent' },
  ]
  const parts: Part[] = [
    ...sym(part('hull', left, 'hull', 0, { slope: [-0.55, 0.05], details: hullDetails })),
    ...sym(part('tip', tip, 'hull', 0, { slope: [-0.55, 0.05], detach: { hull: 0.32 }, details: [{ k: 'shape', pts: [[-29.6, 18], [-32.6, 28], [-33.5, 33], [-31.6, 33.4], [-29, 24]], tone: 'accent' }] }), { detach: { hull: 0.22 } }),
    // Three long plates down each flank, the middle and aft ones blown off as it's battered. The aft
    // flak sits in the gap between them.
    ...sym(plate('armourA', rows, -32, -14, 4.2, 10, 0.8)),
    ...sym(plate('armourB', rows, -10, 6, 4.2, 10, 0.8, { detach: { hull: 0.36 } }), { detach: { hull: 0.3 } }),
    ...sym(plate('armourC', rows, 17, 25, 4.2, 10, 0.8, { detach: { hull: 0.28 } }), { detach: { hull: 0.22 } }),
    // The raised forward deck, a short docking trench in its bow.
    ...sym(part('deck', halfHull(deckRows), 'hull2', 1.2, {
      slope: [-0.5, -0.05],
      lift: 1.6,
      details: [{ k: 'shape', pts: [[-3.4, -38], [-4.8, -38], [-8.6, -12], [-7.2, -12]], tone: 'accent' }, { k: 'line', pts: [[-1, -16], [-9.6, -16]] }],
    })),
    part('trench', rect(-2.6, -42, 5.2, 14), 'dark', 1.4, {
      details: [{ k: 'shape', pts: rect(-1.5, -41, 3, 12), tone: 'metal' }, { k: 'lights', pts: along([0, -39], [0, -31], 3), r: 0.42, tone: 'ember' }],
    }),
    // The turret seats: a barbette for the turbolaser, pads for the flak.
    seat('barbette', c, 4, 5, 1.6, true),
    ...sym(seat('seat', c, 0, 3.3, 1.45, false)),
    ...sym(seat('seatAft', c, 2, 3.3, 0.9, false)),
    // Engine bank: a block, three main engines and two auxiliary nozzles.
    part('block', chamfer(0, 39, 36, 8, 2.5), 'metal', 1.5, { lift: 0.8, details: [{ k: 'line', pts: [[-17, 39], [17, 39]] }, { k: 'lights', pts: [[-15.5, 37.4], [15.5, 37.4]], r: 0.4, tone: 'accent' }] }),
    nacelle('pod0', -9.1, 34, 48.6, 7.4, 0, 2, { detach: { hull: 0.16 } }),
    nacelle('pod1', 0, 34, 49.2, 7.6, 1, 2),
    nacelle('pod2', 9.5, 34, 48.6, 7.4, 2, 2, { detach: { hull: 0.1 } }),
    ...sym(nacelle('aux', -15.8, 36, 45.6, 4.4, undefined, 1.8, { detach: { hull: 0.2 } }, 'hull2'), { detach: { hull: 0.14 } }),
    // The superstructure: a plated base, a second tier carrying the shield dome, the bridge forward.
    part('superBase', chamfer(0, 17, 26, 26, 6), 'hull', 3, {
      lift: 2.6,
      facets: [{ pts: [[-13, 10], [-7, 4], [-7, 30], [-13, 24]], slope: [-0.5, 0] }, { pts: [[13, 10], [7, 4], [7, 30], [13, 24]], slope: [0.5, 0] }],
      details: [{ k: 'shape', pts: rect(-13, 26, 26, 1.8), tone: 'accent' }, { k: 'lights', pts: [...along([-11, 12], [-11, 22], 3), ...along([11, 12], [11, 22], 3)], r: 0.42 }],
    }),
    part('tier', chamfer(0, 19, 17, 17, 4), 'hull2', 3.5, { lift: 2, details: [{ k: 'shape', pts: [[-8.5, 14.6], [0, 12.4], [8.5, 14.6], [8.5, 16.2], [0, 14], [-8.5, 16.2]], tone: 'accent' }] }),
    part('bridge', chamfer(0, 9.4, 11, 5, 2), 'hull', 4, { lift: 1.6, details: [{ k: 'lights', pts: along([-3.6, 8.6], [3.6, 8.6], 4), r: 0.52, tone: 'glass' }, { k: 'shape', pts: rect(-5.5, 10.6, 11, 0.9), tone: 'accent' }] }),
    ...sym(part('mast', box(-7.4, 25.6, 0.8, 7), 'dark', 4.6, { detach: { hull: 0.5 }, details: [{ k: 'lights', pts: [[-7.4, 22.4]], r: 0.45, tone: 'accent' }] }), { detach: { hull: 0.42 } }),
    part('antenna', box(0, 4.6, 0.6, 5.4), 'dark', 4.6, { detach: { hull: 0.55 } }),
    part('dish', circle(-10, 8.4, 2, 14), 'metal', 4.4, { lift: 1, slope: [-0.3, 0.3], detach: { hull: 0.36 }, details: [{ k: 'shape', pts: circle(-10, 8.4, 0.6, 8), tone: 'dark' }] }),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Sovereign dreadnought, redesigned at 2.5×: the flagship as a real capital ship. A great dagger
 * hull with red edge bands and detachable wing tips; long armour plates down each flank, with a
 * hangar gallery opening amidships; a raised upper deck carrying the four turbolasers on barbettes
 * in two pairs, split by the flight-deck trench with the hangar in it; the flak forward on the deck
 * and aft on the flanks; twin bridge towers under the shield domes and a three-tier command tower
 * between them, with masts, dishes and an antenna array; an engine bank of five main engines and two
 * auxiliary nozzles. It breaks into four chunks.
 */
export const capital: ModelDef = (c): ModelSpec => {
  const rows: [number, number][] = [[-50, 0.4], [-44, 3.4], [-34, 7.6], [-22, 12.4], [-8, 17.4], [6, 22.2], [20, 26.6]]
  const left: Pt[] = [...halfHull(rows).slice(0, -1), [-24, 30], [-24, 40], [-20, 42.5], [0, 42.5]]
  const tip: Pt[] = [[-26.6, 20], [-29.6, 29], [-31.4, 34], [-28, 37.5], [-24, 40], [-24, 30]]
  const deckRows: [number, number][] = [[-41, 1.2], [-32, 4], [-20, 8.8], [-8, 12.8], [6, 15.6], [18, 15.8], [25, 13]]
  const e = (y: number, d: number) => edgeAt(rows, y, d)
  const hullDetails: Detail[] = [
    { k: 'shape', pts: edgeBand(rows.slice(1), 2.4), tone: 'accent' },
    { k: 'lights', pts: [-30, -20, -10, 0, 10].map((y) => e(y, 4.6)), r: 0.36 },
    edgeLine(rows, -36, 20, 7.6),
    { k: 'shape', pts: [[-22, 33], [-14, 31], [-14, 37]], tone: 'accent' },
  ]
  const parts: Part[] = [
    ...sym(part('hull', left, 'hull', 0, { slope: [-0.55, 0.05], details: hullDetails })),
    ...sym(part('tip', tip, 'hull', 0, { slope: [-0.55, 0.05], detach: { hull: 0.32 }, details: [{ k: 'shape', pts: [[-26.6, 20], [-29.6, 29], [-31.4, 34], [-29.6, 34.6], [-26.2, 26]], tone: 'accent' }] }), { detach: { hull: 0.22 } }),
    // Long armour plates down each flank between the red band and the deck: the second and the
    // last are shot off as it's battered. The hangar gallery opens between them, and the aft flak
    // sits in the gap behind it.
    ...sym(plate('armourA', rows, -38, -24, 3, 7.6, 0.8)),
    ...sym(plate('armourB', rows, -21, -3, 3, 7.6, 0.8, { detach: { hull: 0.38 } }), { detach: { hull: 0.34 } }),
    ...sym(plate('armourD', rows, 18, 26, 3, 7.6, 0.8, { detach: { hull: 0.3 } }), { detach: { hull: 0.26 } }),
    ...sym(part('gallery', [e(0, 3), e(0.6, 7.6), e(9.4, 7.6), e(10, 3)], 'dark', 0.9, {
      details: [
        ...[3.3, 6.7].map((y): Detail => ({ k: 'line', pts: [e(y, 3.4), e(y, 7.2)] })),
        { k: 'lights', pts: along(e(1.4, 5.3), e(8.6, 5.3), 3), r: 0.36 },
        { k: 'lights', pts: [e(0.9, 3.4), e(9.1, 3.4)], r: 0.3, tone: 'ember' },
      ],
    })),
    // The upper deck, red trim down its edges, carrying the turbolaser barbettes.
    ...sym(part('deck', halfHull(deckRows), 'hull2', 1.2, {
      slope: [-0.45, 0],
      lift: 2.4,
      details: [
        { k: 'shape', pts: edgeBand(deckRows.slice(1, 6), 1.1), tone: 'accent' },
        { k: 'lights', pts: along([-11.6, -2], [-14.2, 14], 3), r: 0.34 },
        ...[-28, 16].map((y): Detail => ({ k: 'line', pts: [[-3.6, y], [-(widthAt(deckRows, y) - 1.4), y]] })),
      ],
    })),
    // The flight deck: a trench with bay doors and guide lights, the hangar set into it.
    part('trench', rect(-3, -18, 6, 34), 'dark', 2, {
      details: [
        { k: 'shape', pts: rect(-1.9, -17, 3.8, 32), tone: 'metal' },
        ...[-12, 10].map((y): Detail => ({ k: 'shape', pts: rect(-1.9, y, 3.8, 0.9), tone: 'dark' })),
        { k: 'lights', pts: along([0, -16], [0, -8], 3), r: 0.44, tone: 'ember' },
        { k: 'lights', pts: [...along([-2.5, -16], [-2.5, 14], 5), ...along([2.5, -16], [2.5, 14], 5)], r: 0.28 },
      ],
    }),
    ...sym(part('spine', [[0, -47], [-1.6, -43], [-3.4, -37], [0, -37]], 'hull2', 2, { slope: [-0.45, -0.1], lift: 1.2, details: [{ k: 'shape', pts: [[0, -46], [-0.8, -43], [-1.2, -38], [0, -38]], tone: 'accent' }] })),
    part('antennaF', box(0, -42.5, 0.6, 5), 'dark', 3, { detach: { hull: 0.45 } }),
    // The turret seats: barbettes for the turbolasers, pads for the flak.
    ...sym(seat('barbette', c, 0, 3.9, 2.4, true)),
    ...sym(seat('barbetteAft', c, 2, 3.9, 2.4, true)),
    ...sym(seat('seat', c, 4, 2.6, 2.3, false)),
    ...sym(seat('seatAft', c, 6, 2.6, 0.95, false)),
    // Engine bank: a block, five main engines, two auxiliary nozzles.
    part('block', chamfer(0, 41.5, 44, 10, 3), 'metal', 1, { lift: 0.8, details: [{ k: 'line', pts: [[-20, 41], [20, 41]] }, { k: 'lights', pts: [[-19, 38.6], [19, 38.6]], r: 0.4, tone: 'accent' }] }),
    ...[-14.5, -7.9, -0.3, 7.7, 14.3].map((x, i) => nacelle(`pod${i}`, x, 36, i === 2 ? 49.6 : i === 1 || i === 3 ? 48.4 : 47.4, 6.2, i, 2, i === 0 ? { detach: { hull: 0.16 } } : i === 4 ? { detach: { hull: 0.1 } } : {}, i === 2 ? 'accent' : 'hull2')),
    ...sym(nacelle('aux', -20.8, 37, 45.4, 3.6, undefined, 1.8, { detach: { hull: 0.24 } }, 'hull2'), { detach: { hull: 0.18 } }),
    // Twin bridge towers carrying the shield domes, the command tower between them.
    ...sym(part('tower', chamfer(-14.2, 30.5, 17, 20, 4.2), 'hull', 3, {
      lift: 3,
      facets: [{ pts: [[-22.7, 24.7], [-18.5, 20.5], [-18.5, 40.5], [-22.7, 36.3]], slope: [-0.5, 0] }],
      details: [{ k: 'shape', pts: rect(-22.7, 22.6, 17, 1.4), tone: 'accent' }, { k: 'lights', pts: along([-21.6, 27], [-21.6, 35], 3), r: 0.36 }],
    })),
    part('command', chamfer(0, 27.5, 16, 15, 3.6), 'hull2', 3.5, { lift: 3.4, details: [{ k: 'shape', pts: [[-8, 30], [0, 27.6], [8, 30], [8, 31.6], [0, 29.2], [-8, 31.6]], tone: 'accent' }] }),
    part('tier', chamfer(0, 27.5, 10.6, 9.4, 2.6), 'hull', 3.8, { lift: 2, details: [{ k: 'lights', pts: along([-3.4, 23.6], [3.4, 23.6], 4), r: 0.4, tone: 'glass' }] }),
    part('bridge', chamfer(0, 22.4, 9, 3.6, 1.2), 'hull2', 4, { lift: 1.2, details: [{ k: 'lights', pts: along([-3.4, 22.4], [3.4, 22.4], 5), r: 0.36, tone: 'glass' }] }),
    part('crown', chamfer(0, 28.6, 5.6, 5, 1.4), 'metal', 4.2, { lift: 1.2, details: [{ k: 'lights', pts: [[0, 28.6]], r: 0.5, tone: 'accent' }] }),
    ...sym(part('mast', box(-5, 35.6, 0.8, 7), 'dark', 4.5, { detach: { hull: 0.55 }, details: [{ k: 'lights', pts: [[-5, 32.4]], r: 0.42, tone: 'accent' }] }), { detach: { hull: 0.48 } }),
    ...sym(part('spire', box(-14.2, 20.4, 0.7, 5.6), 'dark', 4.5, { detach: { hull: 0.5 }, details: [{ k: 'lights', pts: [[-14.2, 17.8]], r: 0.36, tone: 'accent' }] }), { detach: { hull: 0.44 } }),
    ...sym(part('dish', circle(-19.4, 37.4, 1.9, 14), 'metal', 3.6, { lift: 0.8, slope: [-0.3, 0.3], detach: { hull: 0.4 }, details: [{ k: 'shape', pts: circle(-19.4, 37.4, 0.6, 8), tone: 'dark' }] }), { detach: { hull: 0.3 } }),
    part('array', rect(-6.4, 18.6, 12.8, 0.9), 'dark', 4.3, { detach: { hull: 0.58 }, details: [{ k: 'lights', pts: along([-5.6, 19], [5.6, 19], 3), r: 0.32, tone: 'accent' }] }),
  ]
  return { parts, breakStyle: 'bands', cuts: 3 }
}

// --- The smaller ships ---------------------------------------------------------------------------------

/** Halberd gunship at 1.15×: the same heavy fighter-hunter, its surface quietened. */
export const gunship: ModelDef = (c) => calm(classic.gunship(c))

/**
 * Mercy corvette at 1.15×: the repair tender, calmer. The same blunt arrowhead with its green-ringed
 * repair bay, but one long plate down each flank instead of patchwork, a single crane boom each side,
 * a tower with its mast aft, two dishes and three engines; the painted flak turret on the nose.
 */
export const corvette: ModelDef = (): ModelSpec => {
  const rows: [number, number][] = [[-50, 0.5], [-44, 4], [-34, 8.6], [-20, 14], [-4, 20], [12, 25.5], [24, 30.5], [29, 32.4], [33, 27], [37, 17]]
  const parts: Part[] = [
    ...sym(part('hull', halfHull(rows), 'hull', 0, {
      slope: [-0.55, 0.05],
      details: [
        { k: 'shape', pts: edgeBand(rows.slice(1, 8), 3), tone: 'accent' },
        { k: 'lights', pts: [-14, 4, 20].map((y) => edgeAt(rows, y, 6)), r: 0.5 },
        edgeLine(rows, -28, 22, 9),
        { k: 'shape', pts: [[-24, 28], [-14, 27], [-14, 32]], tone: 'accent' },
      ],
    })),
    ...sym(plate('armour', rows, -26, -8, 3.6, 8.6, 0.8)),
    ...sym(plate('armourAft', rows, 14, 26, 3.6, 9.6, 0.8, { detach: { hull: 0.34 } }), { detach: { hull: 0.24 } }),
    ...sym(part('spine', [[0, -45], [-1.8, -40], [-4.4, -16], [0, -15]], 'hull2', 1, { slope: [-0.5, -0.05], lift: 1.2, details: [{ k: 'shape', pts: [[0, -42], [-0.9, -39], [-1.4, -30], [0, -30]], tone: 'accent' }] })),
    part('block', chamfer(0, 40, 31, 9, 3), 'metal', 1, { lift: 0.6, details: [{ k: 'line', pts: [[-14, 40], [14, 40]] }] }),
    nacelle('pod0', -9.8, 34, 48.5, 7.6, 0, 2, { detach: { hull: 0.16 } }),
    nacelle('pod1', 0, 34, 49, 7.6, 1, 2),
    nacelle('pod2', 10.4, 34, 48.5, 7.6, 2, 2, { detach: { hull: 0.1 } }),
    // The repair bay: a raised ring round a dark well, the aid cross in it.
    part('ring', circle(0, 2, 12.5, 32), 'hull2', 2, {
      holes: [circle(0, 2, 8.4, 28)],
      lift: 1.6,
      details: [{ k: 'shape', pts: circle(0, 2, 11.2, 32), tone: 'aid' }, { k: 'shape', pts: circle(0, 2, 9.8, 28), tone: 'hull2' }, { k: 'lights', pts: circle(0, 2, 10.5, 4), r: 0.6, tone: 'aid' }],
    }),
    part('well', circle(0, 2, 8.6, 28), 'dark', 1.8, { details: [{ k: 'shape', pts: box(0, 2, 9, 2.8), tone: 'aid' }, { k: 'shape', pts: box(0, 2, 2.8, 9), tone: 'aid' }] }),
    part('tower', chamfer(0, 23, 14, 12, 3), 'hull', 3, {
      lift: 2.2,
      facets: [{ pts: [[-7, 20], [-4, 17], [-4, 29], [-7, 26]], slope: [-0.5, 0] }],
      details: [{ k: 'shape', pts: rect(-7, 25.4, 14, 1.8), tone: 'accent' }, { k: 'lights', pts: along([-3, 19], [3, 19], 3), r: 0.55, tone: 'glass' }],
    }),
    part('mast', box(0, 15.5, 1, 7), 'dark', 4, { detach: { hull: 0.5 }, details: [{ k: 'lights', pts: [[0, 12.6]], r: 0.5, tone: 'accent' }] }),
    ...sym(part('crane', capsule([-8, -8], [-13, -26], 1.6, 1.2), 'metal', 3, { lift: 2.2, detach: { hull: 0.42 } }), { detach: { hull: 0.3 } }),
    ...sym(part('dish', circle(-16, 16, 3, 14), 'metal', 3, { lift: 1, slope: [-0.3, 0.3], detach: { hull: 0.36 }, details: [{ k: 'shape', pts: circle(-16, 16, 1, 8), tone: 'dark' }] }), { slope: [0.3, 0.3], detach: { hull: 0.24 } }),
    ...classic.ballTurret('flak', 0, -25, 3.2, 3),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Line ships ----------------------------------------------------------------------------------------

/**
 * Paladin cruiser at 1.7×: the line warship as a long, quiet hull. A needle prow with red edge bands;
 * a narrow raised spine carrying two turbolasers on barbettes, the other two on the shoulders either
 * side of it; shield sponsons standing out from the hull, a single band across each; a long armour
 * belt aft down each flank with the flak on pads on it; swept
 * stabilisers, a stepped bridge and two big engine nacelles, shot off with their engines.
 */
export const cruiser: ModelDef = (c): ModelSpec => {
  const rows: [number, number][] = [[-50, 0.4], [-46, 2], [-38, 4.2], [-28, 6.2], [-18, 7.6], [-8, 8.8], [4, 9.8], [16, 10.4], [26, 11.6], [34, 12.2], [40, 11], [43, 8]]
  const parts: Part[] = [
    ...sym(part('wing', [[-11, 22], [-17, 29], [-18.6, 36], [-12, 37]], 'hull', 0, {
      slope: [-0.45, 0.05],
      details: [{ k: 'shape', pts: [[-11, 22], [-17, 29], [-17.6, 31.5], [-11.4, 25.5]], tone: 'accent' }],
    }), { slope: [0.45, 0.05] }),
    ...sym(part('tip', [[-17, 29], [-18.8, 26], [-18.8, 36.5], [-18.6, 36]], 'hull', 0.2, { slope: [-0.45, 0], detach: { hull: 0.26 } }), { slope: [0.45, 0], detach: { hull: 0.18 } }),
    ...sym(part('hull', halfHull(rows), 'hull', 1, {
      slope: [-0.55, 0.03],
      details: [
        { k: 'shape', pts: edgeBand(rows.slice(1, 9), 1.5), tone: 'accent' },
        { k: 'lights', pts: [-24, -12, 2].map((y) => edgeAt(rows, y, 2.6)), r: 0.42 },
        edgeLine(rows, -36, 12, 2.4),
        { k: 'shape', pts: [[0, -37], [-4, -37], [-4.4, -35], [0, -35]], tone: 'accent' },
      ],
    })),
    // The armour belt aft down each flank, the flak on it.
    ...sym(plate('armour', rows, 14, 31, 1.4, 4.4, 1.2)),
    ...sym(part('fin', [[-3.6, -33], [-8.6, -25], [-8.6, -22.5], [-4.6, -24]], 'hull2', 1.4, { slope: [-0.4, 0], lift: 0.6, detach: { hull: 0.3 }, details: [{ k: 'shape', pts: [[-3.6, -33], [-8.6, -25], [-8.6, -23.8], [-4, -30]], tone: 'accent' }] }), { slope: [0.4, 0], detach: { hull: 0.22 } }),
    // The spine, narrow and raised, with the forward turbolasers on it.
    ...sym(part('spine', [[0, -44], [-1.6, -40], [-3.4, -32], [-3.6, 25], [0, 26]], 'hull2', 2, {
      slope: [-0.45, 0],
      lift: 1.6,
      details: [
        { k: 'shape', pts: [[0, -43], [-0.8, -40], [-1.1, -37], [0, -37]], tone: 'accent' },
        { k: 'shape', pts: rect(-3.6, -11.6, 3.6, 1.6), tone: 'accent' },
        { k: 'line', pts: [[-2.4, -6], [-2.4, 22]] },
      ],
    })),
    // Shield sponsons on the shoulders, standing out from the hull.
    ...sym(part('sponson', chamfer(-12.4, 6, 11.6, 17, 3.4), 'hull2', 2.2, {
      lift: 2.2,
      facets: [{ pts: [[-18.2, 0.6], [-15.2, -2.5], [-15.2, 14.5], [-18.2, 11.4]], slope: [-0.5, 0] }],
      details: [{ k: 'shape', pts: rect(-18.2, 12, 11.6, 1.6), tone: 'accent' }, { k: 'lights', pts: [[-17, 1], [-17, 10]], r: 0.4 }],
    })),
    seat('barbette', c, 0, 3.2, 2.4, true),
    seat('barbetteMid', c, 1, 3.2, 2.4, true),
    ...sym(seat('barbetteAft', c, 2, 3.2, 1.4, true)),
    ...sym(seat('seat', c, 4, 2.6, 1.3, false)),
    part('block', chamfer(0, 39, 11, 13, 2.5), 'metal', 2, { lift: 0.8 }),
    nacelle('podL', -9.55, 28, 49.6, 8.4, 0, 3, { detach: { hp: 8 } }),
    nacelle('podR', 9.55, 28, 49.6, 8.4, 1, 3, { detach: { hp: 9 } }),
    // The bridge: a stepped block aft, windows across its face.
    part('bridge', chamfer(0, 30, 11, 10, 2.6), 'hull', 3, {
      lift: 2.4,
      facets: [{ pts: [[-5.5, 27.4], [-3, 25], [-3, 35], [-5.5, 32.6]], slope: [-0.5, 0] }],
      details: [{ k: 'shape', pts: rect(-5.5, 31.6, 11, 1.6), tone: 'accent' }, { k: 'lights', pts: along([-2.4, 26.2], [2.4, 26.2], 3), r: 0.5, tone: 'glass' }],
    }),
    part('tower', chamfer(0, 31, 5.6, 5, 1.4), 'hull2', 4, { lift: 1.4, details: [{ k: 'lights', pts: [[0, 31]], r: 0.5, tone: 'accent' }] }),
    part('mast', box(-3.4, 36, 0.8, 6), 'dark', 5, { detach: { hull: 0.5 }, details: [{ k: 'lights', pts: [[-3.4, 33.4]], r: 0.45, tone: 'accent' }] }),
    part('dish', circle(3.8, 36, 1.8, 12), 'metal', 5, { lift: 0.8, slope: [0.3, 0.3], detach: { hull: 0.36 }, details: [{ k: 'shape', pts: circle(3.8, 36, 0.6, 8), tone: 'dark' }] }),
  ]
  return {
    parts,
    breakStyle: 'bands',
    // Its flak turrets blow off; the turbolasers and shield bulbs stay on, wrecked.
    mount: (i) => ({ detach: i === 4 || i === 5 }),
  }
}
