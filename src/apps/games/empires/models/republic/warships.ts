import { along, box, capsule, chamfer, circle, halfHull, part, rect, sym } from '../kit.ts'
import { edgeAt, edgeLine, plate, widthAt } from '../proto.ts'
import type { BuildCtx, ModelDef, ModelSpec } from '../spec.ts'
import type { Detail, Part, Pt } from '../types.ts'
import { ballTurret } from './craft.ts'
import { block, dish, edgeBand, enginePod, hpAt, mast, seat, windows } from './style.ts'

// The Republic's warships at their size (sizes.ts), redrawn from the Republic sheet: wedge and
// dagger hulls in warm off-white with red edge bands, grey deck plates, raised blue bridges at the
// nose, spines of raised blocks, every gun on its own seat on a hardpoint, and engine pods that are
// parts of their own (a pod on an engine hardpoint is shot off with it, its glow going dark).
//
// Built in the sheet's layers: the structure under the hull (the pod pylons), the hull and its deck,
// armour plates and raised blocks, the bridge and shield bulbs, the turret seats (the turrets
// themselves are mounts, models/republic/mounts.ts), then markings, windows and lights. Panel lines
// are 'line' details, which only show on bitmaps big enough to carry them.

/** Engine pods on the engine hardpoints `hps` (in glow order), `w` wide from y0 to y1, each shot
 * off with its hardpoint. A hardpoint the unit type lacks (an older saved type) leaves its pod on
 * for good. */
function pods(c: BuildCtx, hps: number[], y0: number, y1: number | number[], w: number, z: number): Part[] {
  return hps.flatMap((hp, i) => {
    const at = hpAt(c, hp)
    if (!at) return []
    const end = Array.isArray(y1) ? y1[i] : y1
    return [enginePod(`pod${i}`, at[0], y0, end, w, i, z, c.t.hardpoints[hp].kind === 'engine' ? { detach: { hp } } : {})]
  })
}

// --- Gunship and corvette ------------------------------------------------------------------------------

/**
 * Halberd gunship at 1.15×: the sheet's compact delta. A broad arrowhead hull with red edge bands
 * and a notched trailing edge, grey deck plates, a raised fuselage down the middle with the blue
 * canopy forward and the flak ball turret behind it, a torpedo rack on each wing root (its two
 * hardpoints, fixed forward), swept fins and three engine pods.
 */
export const gunship: ModelDef = (c): ModelSpec => {
  const rows: [number, number][] = [[-50, 0.4], [-40, 5], [-25, 12.2], [-10, 19.6], [5, 26.4], [20, 32.4], [28, 34.6]]
  const left: Pt[] = [...halfHull(rows).slice(0, -1), [-34, 32], [-26, 33], [-15, 29.5], [0, 29.5]]
  const fuse: [number, number][] = [[-49, 0.6], [-44, 2.8], [-34, 4.8], [-18, 6], [6, 6.4], [24, 6.2], [32, 5]]
  const parts: Part[] = [
    ...sym(part('hull', left, 'hull', 0, {
      slope: [-0.5, 0.05],
      details: [
        { k: 'shape', pts: edgeBand(rows.slice(1), 2.6), tone: 'accent' },
        { k: 'shape', pts: [[-27, 26], [-17, 23.5], [-17, 28.5]], tone: 'accent' },
        edgeLine(rows, -32, 22, 7),
        { k: 'line', pts: [edgeAt(rows, 0, 2.6), [-8, 0]] },
        { k: 'lights', pts: [edgeAt(rows, -16, 4.4), edgeAt(rows, 14, 4.4)], r: 0.45, tone: 'glass' },
      ],
    })),
    // Wing tips, lost as it's battered.
    ...sym(part('tip', [[-34.6, 28], [-35.6, 31], [-34, 32], [-29, 32.6], [-29, 28.6]], 'hull', 0.1, { slope: [-0.5, 0.05], detach: { hull: 0.35 }, details: [{ k: 'shape', pts: [[-34.6, 28], [-35.6, 31], [-34, 32], [-33, 28.3]], tone: 'accent' }] }), { detach: { hull: 0.25 } }),
    ...sym(plate('plate', rows, -18, 0, 3.4, 8.6, 0.6)),
    ...sym(plate('plateAft', rows, 12, 24, 3.4, 8, 0.6, { detach: { death: true } })),
    // The fuselage, raised, a red stripe down its spine.
    ...sym(part('fuse', halfHull(fuse), 'hull', 1.5, {
      slope: [-0.45, 0],
      lift: 1.4,
      details: [{ k: 'shape', pts: [[0, -6], [-1.2, -6], [-1.2, 26], [0, 26]], tone: 'accent' }, { k: 'line', pts: [[-6, 10], [0, 10]] }, { k: 'line', pts: [[-6.2, 20], [0, 20]] }],
    })),
    part('canopyFrame', [[0, -40], [3.4, -33], [3.8, -24], [2.8, -19], [-2.8, -19], [-3.8, -24], [-3.4, -33]], 'hull2', 2, { lift: 0.6 }),
    part('canopy', [[0, -38], [2.5, -32], [2.8, -24.5], [2, -21], [-2, -21], [-2.8, -24.5], [-2.5, -32]], 'glass', 2.2, { lift: 0.6, details: [{ k: 'shape', pts: [[-0.6, -36], [-1.8, -31], [-1.9, -26], [-1, -26], [-0.8, -31]], tone: 'glow' }] }),
    // Swept fins either side of the engines.
    ...sym(part('fin', [[-8, 20], [-14, 30], [-14, 36], [-9.4, 36], [-7, 26]], 'hull2', 1.2, { slope: [-0.4, 0], lift: 0.8, detach: { death: true }, details: [{ k: 'shape', pts: [[-8, 20], [-14, 30], [-14, 31.6], [-7.6, 23]], tone: 'accent' }] })),
    part('pylon', chamfer(0, 31.5, 26, 5, 1.6), 'metal', 0.4, { lift: 0.6 }),
    enginePod('pod0', -8.94, 29.5, 48.6, 7.4, 0, 1.6, { detach: { death: true } }),
    enginePod('pod1', 0, 30, 49.6, 7.8, 1, 1.7),
    enginePod('pod2', 8.94, 29.5, 48.6, 7.4, 2, 1.6, { detach: { death: true } }),
    // The torpedo racks' seats on the wing roots.
    ...seat('rackSeatL', c, 0, 1.18, 1.2, 'oct'),
    ...seat('rackSeatR', c, 1, 1.18, 1.2, 'oct'),
    ...ballTurret('flak', 0, -10, 3.4, 3),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Mercy corvette at 1.15×: the repair tender, after the sheet's corvette. A slim fuselage with the
 * blue canopy forward, small canards, mid wings carrying the work cranes, broad swept aft wings
 * banded in red and three engine pods. On its back the repair bay: a raised ring round a dark well
 * with the green aid cross in it (only Republic repair craft wear it). The painted flak turret
 * rides on the nose.
 */
export const corvette: ModelDef = (): ModelSpec => {
  const fuse: [number, number][] = [[-50, 0.5], [-44, 3], [-34, 5.4], [-20, 7], [0, 8.2], [20, 8.6], [34, 8], [38, 6.6]]
  const parts: Part[] = [
    // The aft wings: broad and swept, banded in red, their tips lost as it's battered.
    ...sym(part('wing', [[-7.6, 6], [-26, 24], [-31, 34], [-28, 36], [-8, 33]], 'hull', 0.5, {
      slope: [-0.4, 0.05],
      details: [
        { k: 'shape', pts: [[-7.6, 6], [-26, 24], [-27.6, 27], [-8, 11.4]], tone: 'accent' },
        { k: 'shape', pts: [[-12, 26], [-22, 28.6], [-22, 31.4], [-12, 30]], tone: 'accent' },
        { k: 'line', pts: [[-10, 20], [-26, 31]] },
        { k: 'lights', pts: [[-27.5, 33.5]], r: 0.6, tone: 'accent' },
      ],
    })),
    ...sym(part('tip', [[-28.4, 29.6], [-32.6, 35.5], [-30.6, 37.4], [-27.4, 36.4], [-26.4, 31.6]], 'hull', 0.6, { slope: [-0.4, 0.05], detach: { hull: 0.32 } }), { slope: [0.4, 0.05], detach: { hull: 0.22 } }),
    // The mid wings carrying the work cranes, and the canards.
    ...sym(part('midWing', [[-7, -10], [-20, -4], [-21, 1], [-7.6, 4]], 'hull', 0.8, { slope: [-0.4, 0], details: [{ k: 'shape', pts: [[-7, -10], [-20, -4], [-20.4, -2], [-7.2, -7]], tone: 'accent' }, { k: 'line', pts: [[-14, -6.5], [-14, 2.5]] }] })),
    ...sym(part('canard', [[-5, -32], [-13, -27], [-13.4, -24], [-5.4, -25]], 'hull', 0.8, { slope: [-0.4, 0], detach: { hull: 0.4 }, details: [{ k: 'shape', pts: [[-5, -32], [-13, -27], [-13.2, -25.6], [-5.2, -29]], tone: 'accent' }] }), { detach: { hull: 0.28 } }),
    ...sym(part('crane', capsule([-17, -2], [-24, -18], 1.6, 1.1), 'hull2', 1.2, { lift: 1.6, detach: { hull: 0.42 }, details: [{ k: 'lights', pts: [[-24, -18.6]], r: 0.8, tone: 'aid' }] }), { detach: { hull: 0.3 } }),
    ...sym(part('fuse', halfHull(fuse), 'hull', 1.5, {
      slope: [-0.45, 0],
      lift: 1.2,
      details: [
        { k: 'shape', pts: [[0, -50], [-1.2, -44], [-1.5, -38], [0, -38]], tone: 'accent' },
        { k: 'shape', pts: [[0, 12], [-1.4, 12], [-1.4, 30], [0, 30]], tone: 'accent' },
        { k: 'line', pts: [[-7.6, -14], [0, -14]] },
        { k: 'line', pts: [[-8.4, 24], [0, 24]] },
      ],
    })),
    part('canopyFrame', [[0, -40], [3.6, -34], [4, -24], [3, -19], [-3, -19], [-4, -24], [-3.6, -34]], 'hull2', 2, { lift: 0.6 }),
    part('canopy', [[0, -38], [2.6, -33], [3, -25], [2.2, -21], [-2.2, -21], [-3, -25], [-2.6, -33]], 'glass', 2.2, { lift: 0.6, details: [{ k: 'shape', pts: [[-0.6, -36], [-1.9, -31], [-2, -26], [-1, -26], [-0.8, -31]], tone: 'glow' }] }),
    // The repair bay: a raised ring round a dark well, the aid cross in it.
    part('ring', circle(0, 1, 8.6, 28), 'hull2', 2.4, {
      holes: [circle(0, 1, 5.8, 24)],
      lift: 1.4,
      details: [{ k: 'shape', pts: circle(0, 1, 7.6, 28), tone: 'aid' }, { k: 'shape', pts: circle(0, 1, 6.6, 24), tone: 'hull2' }, { k: 'lights', pts: circle(0, 1, 7.1, 4), r: 0.55, tone: 'aid' }],
    }),
    part('well', circle(0, 1, 6, 24), 'dark', 2.2, { details: [{ k: 'shape', pts: box(0, 1, 7.4, 2.4), tone: 'aid' }, { k: 'shape', pts: box(0, 1, 2.4, 7.4), tone: 'aid' }] }),
    block('tower', 0, 18, 9, 9, 2.6),
    mast('mast', 0, 26, 6, 3, 0.5),
    ...sym(dish('dish', -5.6, 28, 2.2, 2.8, 0.36)),
    part('pylon', chamfer(0, 34, 24, 5, 1.6), 'metal', 0.4, { lift: 0.6 }),
    enginePod('pod0', -8.4, 32, 48.6, 7.2, 0, 1.6, { detach: { hull: 0.16 } }),
    enginePod('pod1', 0, 32.5, 49.6, 7.6, 1, 1.7),
    enginePod('pod2', 8.4, 32, 48.6, 7.2, 2, 1.6, { detach: { hull: 0.1 } }),
    ...ballTurret('flak', 0, -13.4, 2.8, 3),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Warden frigate -----------------------------------------------------------------------------------

/**
 * Warden frigate at 1.4×, after the sheet's capital ship anatomy: a broad triangular hull, red edge
 * bands and red chevrons aft, grey deck plates down its flanks (the forward and aft ones shot off as
 * it is battered). A raised deck down the middle carries the blue bridge at the nose and a spine of
 * raised blocks; six turrets in three pairs (the turbolasers forward, flak amidships, point defence aft) and two
 * shield bulbs stand on their seats either side; three engine pods at the stern, each shot off with
 * its hardpoint.
 */
export const frigate: ModelDef = (c): ModelSpec => {
  const rows: [number, number][] = [[-50, 0.3], [-42, 4.6], [-30, 10.6], [-15, 17.2], [0, 22.8], [15, 27.8], [30, 32.6]]
  const left: Pt[] = [...halfHull(rows).slice(0, -1), [-31.6, 34.6], [-27, 36], [-17, 35], [0, 35]]
  const deckRows: [number, number][] = [[-44, 0.8], [-34, 2.6], [-20, 4.4], [-6, 5.8], [10, 6.8], [26, 7.4], [33, 7]]
  const e = (y: number, d: number) => edgeAt(rows, y, d)
  const parts: Part[] = [
    ...sym(part('hull', left, 'hull', 0, {
      slope: [-0.55, 0.05],
      details: [
        { k: 'shape', pts: edgeBand(rows.slice(1), 2.6), tone: 'accent' },
        // An inner red stripe running back from the nose, and the chevron aft (the sheet's arrows).
        { k: 'shape', pts: [e(-38, 4.6), e(-36, 5.8), e(-14, 7.6), e(-16, 6.4)], tone: 'accent' },
        { k: 'shape', pts: [[-25, 27], [-16, 24.6], [-16, 29.6]], tone: 'accent' },
        edgeLine(rows, -34, 26, 12.4),
        ...[-22, -4, 12].map((y): Detail => ({ k: 'line', pts: [e(y, 2.6), e(y, 12.4)] })),
        { k: 'lights', pts: [-24, -6, 10, 24].map((y) => e(y, 4)), r: 0.42, tone: 'glass' },
      ],
    })),
    // The aft corners, lost as it's battered.
    ...sym(part('tip', [[-32.6, 30], [-33.4, 33], [-31.6, 34.6], [-27.6, 35.4], [-27.6, 30.6]], 'hull', 0.1, { slope: [-0.55, 0.05], detach: { hull: 0.3 }, details: [{ k: 'shape', pts: [[-32.6, 30], [-33.4, 33], [-31.6, 34.6], [-30.2, 30.4]], tone: 'accent' }] }), { detach: { hull: 0.22 } }),
    // Grey deck plates down each flank: the forward and aft ones shot off as it's battered, the
    // middle one (the shield bulb stands on it) stays.
    ...sym(plate('plateA', rows, -30, -17, 3.6, 8.6, 0.8, { detach: { hull: 0.4 } }), { detach: { hull: 0.34 } }),
    ...sym(plate('plateB', rows, -9, 8, 3.6, 11, 0.8)),
    ...sym(plate('plateC', rows, 16, 27, 3.6, 9.4, 0.8, { detach: { hull: 0.3 } }), { detach: { hull: 0.26 } }),
    // Small grey boxes on the aft deck.
    ...sym(part('box', chamfer(-25, 20.5, 5.4, 5, 1.2), 'hull2', 1, { lift: 0.8, details: [{ k: 'lights', pts: [[-25, 19.6]], r: 0.4, tone: 'glass' }] })),
    // The raised deck down the middle.
    ...sym(part('deck', halfHull(deckRows), 'hull', 1.4, {
      slope: [-0.45, -0.05],
      lift: 1.8,
      details: [{ k: 'line', pts: [[-4.8, -12], [0, -12]] }, { k: 'line', pts: [[-6.6, 30], [0, 30]] }, { k: 'shape', pts: [[-1.3, 30], [-3.2, 30], [-3.2, 33], [-1.3, 33]], tone: 'accent' }],
    })),
    // The bridge: a long blue canopy on a grey frame at the nose.
    part('bridgeFrame', [[0, -46], [2.6, -40], [3.6, -30], [3.6, -22], [-3.6, -22], [-3.6, -30], [-2.6, -40]], 'hull2', 2, { lift: 1.2 }),
    part('bridge', [[0, -44], [1.8, -39], [2.6, -30], [2.4, -24.6], [-2.4, -24.6], [-2.6, -30], [-1.8, -39]], 'glass', 2.2, { lift: 0.8, details: [{ k: 'shape', pts: [[-0.5, -41], [-1.4, -36], [-1.6, -29], [-0.8, -29], [-0.5, -36]], tone: 'glow' }] }),
    // The spine: raised blocks down the deck, each banded and lit.
    block('spine0', 0, -12, 7, 9, 2.4),
    block('spine1', 0, 0, 8, 10, 2.4),
    block('spine2', 0, 12.5, 8.6, 10, 2.4),
    block('spine3', 0, 24, 9.4, 8, 2.4, {}, 'hull'),
    mast('mast', 2.6, 30, 5, 3, 0.5),
    dish('dish', -2.6, 30.4, 1.8, 3, 0.4),
    // Seats: pads for the guns, rings under the shield bulbs.
    ...seat('seatT0', c, 0, 1.24, 1.6),
    ...seat('seatT1', c, 1, 1.24, 1.6),
    ...[2, 3].flatMap((i) => seat(`seatF${i}`, c, i, 1.26, 1.6)),
    ...[4, 5].flatMap((i) => seat(`seatF${i}`, c, i, 1.26, 1.6, 'oct')),
    ...seat('seatS0', c, 6, 1.2, 1.6, 'heavy'),
    ...seat('seatS1', c, 7, 1.2, 1.6, 'heavy'),
    // The pods' pylon under the stern, and the pods.
    part('pylon', chamfer(0, 34.5, 34, 5, 1.6), 'metal', 0.4, { lift: 0.6, details: [{ k: 'line', pts: [[-16, 34.5], [16, 34.5]] }] }),
    ...pods(c, [8, 9, 10], 31, [48.6, 49.4, 48.6], 9.6, 1.7),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Paladin cruiser ----------------------------------------------------------------------------------

/**
 * Paladin cruiser at 1.7×: the sheet's long, narrow naval hull. A needle prow with the blue bridge
 * canopy, red edge bands, a raised spine down the middle carrying the two shield bulbs, broad side
 * wings aft of amidships banded in red (the heavy turbolasers on their roots, flak further aft, the
 * wing tips lost as it is battered), a stepped command tower aft and three engine pods, each shot
 * off with its hardpoint.
 */
export const cruiser: ModelDef = (c): ModelSpec => {
  const rows: [number, number][] = [[-50, 0.3], [-42, 2.6], [-30, 5], [-15, 7.4], [0, 9.2], [16, 10.2], [34, 10.4], [38, 9.6]]
  const wing: Pt[] = [[-8, -10], [-17.6, 6], [-18.6, 14], [-18.6, 22], [-10.4, 30], [-9.6, 10]]
  const e = (y: number, d: number) => edgeAt(rows, y, d)
  const parts: Part[] = [
    // The side wings, banded in red.
    ...sym(part('wing', wing, 'hull', 0, {
      slope: [-0.45, 0.05],
      details: [
        { k: 'shape', pts: [[-8, -10], [-17.6, 6], [-18.2, 9], [-8.6, -5]], tone: 'accent' },
        { k: 'shape', pts: [[-12, 20], [-16.6, 21], [-16.6, 23.6], [-12, 24.4]], tone: 'accent' },
        { k: 'line', pts: [[-12, 0], [-12, 26]] },
        { k: 'lights', pts: [[-17.4, 8], [-17.4, 20]], r: 0.4, tone: 'glass' },
      ],
    }), { slope: [0.45, 0.05] }),
    ...sym(part('tip', [[-18.6, 14], [-18.8, 22.4], [-15.4, 25.6], [-15.4, 14]], 'hull', 0.2, { slope: [-0.45, 0.05], detach: { hull: 0.3 }, details: [{ k: 'shape', pts: [[-18.6, 14], [-18.8, 22.4], [-17.8, 23.4], [-17.6, 14]], tone: 'accent' }] }), { slope: [0.45, 0.05], detach: { hull: 0.22 } }),
    ...sym(part('hull', halfHull(rows), 'hull', 1, {
      slope: [-0.55, 0.03],
      details: [
        { k: 'shape', pts: edgeBand(rows.slice(1, 6), 1.6), tone: 'accent' },
        edgeLine(rows, -34, 30, 3.6),
        ...[-20, -2, 32].map((y): Detail => ({ k: 'line', pts: [e(y, 1.6), e(y, 3.6)] })),
        { k: 'lights', pts: [-26, -8, 26].map((y) => e(y, 2.6)), r: 0.4, tone: 'glass' },
      ],
    })),
    // Grey plates along the forward hull, and a long one aft (shot off as it's battered).
    ...sym(plate('plate', rows, -28, -18, 1.2, 4, 1.2)),
    ...sym(plate('plateAft', rows, 18, 30, 1.6, 5.6, 1.2, { detach: { hull: 0.34 } }), { detach: { hull: 0.28 } }),
    // The spine, raised, a red stripe down it and windows either side.
    ...sym(part('spine', [[0, -44], [-1.4, -40], [-3, -30], [-3.6, -10], [-3.8, 22], [0, 23]], 'hull', 2, {
      slope: [-0.45, 0],
      lift: 1.8,
      details: [
        { k: 'shape', pts: [[0, -26], [-0.8, -26], [-0.8, 22], [0, 22]], tone: 'accent' },
        windows([-2.6, -24], [-2.8, -6], 4, 0.32),
        { k: 'line', pts: [[-3.6, -8], [0, -8]] },
      ],
    })),
    part('bridgeFrame', [[0, -46], [2.2, -41], [2.8, -32], [2.8, -26], [-2.8, -26], [-2.8, -32], [-2.2, -41]], 'hull2', 2.4, { lift: 1 }),
    part('bridge', [[0, -44], [1.4, -40], [2, -32], [1.8, -28], [-1.8, -28], [-2, -32], [-1.4, -40]], 'glass', 2.6, { lift: 0.6, details: [{ k: 'shape', pts: [[-0.4, -41.5], [-1.1, -37], [-1.2, -32], [-0.6, -32], [-0.4, -37]], tone: 'glow' }] }),
    // The command tower aft: two stepped blocks, a mast and a dish.
    block('tower', 0, 25.5, 9.4, 8, 2.6, {}, 'hull'),
    block('towerTop', 0, 25, 5.4, 4.6, 3),
    mast('mast', -3.4, 31, 5, 3.2, 0.5),
    dish('dish', 3.6, 31.2, 1.7, 3.2, 0.4, [0.3, 0.3]),
    // Seats: barbettes under the turbolasers, pads under the flak, rings under the shield bulbs.
    ...[0, 1, 2, 3].flatMap((i) => seat(`barbette${i}`, c, i, 1.26, 2.2, 'heavy')),
    ...seat('seatF0', c, 4, 1.3, 2.2, 'oct'),
    ...seat('seatF1', c, 5, 1.3, 2.2, 'oct'),
    ...seat('seatS0', c, 6, 1.18, 2.8),
    ...seat('seatS1', c, 7, 1.18, 2.8),
    part('pylon', chamfer(0, 35, 22, 5, 1.4), 'metal', 0.6, { lift: 0.6 }),
    ...pods(c, [8, 9, 10], 32.5, [48.4, 49.4, 48.4], 6.2, 2),
  ]
  return {
    parts,
    breakStyle: 'bands',
    // Its point-defence turrets blow off; the turbolasers and shield bulbs stay on, wrecked.
    mount: (i) => ({ detach: i === 4 || i === 5 }),
  }
}

// --- Sovereign dreadnought ----------------------------------------------------------------------------

/**
 * Sovereign dreadnought at 2.5×: the sheet's massive dagger-shaped flagship. A great wedge hull with
 * thick red edge bands, red chevrons aft and grey armour plates down the flanks (some shot off as it
 * is battered); a raised upper deck split by the flight deck, the hangar in it; a central spine with
 * a red stripe from the blue bridge at the nose back to a stepped command tower aft, with masts,
 * dishes and a sensor array; four heavy turbolaser batteries on barbettes, flak forward and on the
 * flanks, shield bulbs aft, and six engine pods across the stern, each shot off with its hardpoint.
 * It breaks into four chunks.
 */
export const capital: ModelDef = (c): ModelSpec => {
  const rows: [number, number][] = [[-50, 0.3], [-40, 4.6], [-25, 10.8], [-10, 16.8], [5, 22.6], [20, 27.8], [31, 31]]
  const left: Pt[] = [...halfHull(rows).slice(0, -1), [-30.4, 35], [-24, 37], [-12, 36.4], [0, 36.4]]
  const deckRows: [number, number][] = [[-42, 1], [-32, 3.6], [-18, 7.4], [-4, 10.6], [10, 12.6], [22, 13.2], [30, 12]]
  const e = (y: number, d: number) => edgeAt(rows, y, d)
  const parts: Part[] = [
    ...sym(part('hull', left, 'hull', 0, {
      slope: [-0.55, 0.05],
      details: [
        { k: 'shape', pts: edgeBand(rows.slice(1), 2.8), tone: 'accent' },
        { k: 'shape', pts: [e(-36, 4.4), e(-34, 5.6), e(-6, 7.4), e(-8, 6.2)], tone: 'accent' },
        { k: 'shape', pts: [[-25, 28], [-17, 25.6], [-17, 30.4]], tone: 'accent' },
        edgeLine(rows, -38, 28, 8.6),
        ...[-28, -14, 2, 16].map((y): Detail => ({ k: 'line', pts: [e(y, 2.8), e(y, 8.6)] })),
        { k: 'lights', pts: [-30, -18, -6, 6, 18].map((y) => e(y, 4.2)), r: 0.34, tone: 'glass' },
      ],
    })),
    ...sym(part('tip', [[-31, 31], [-31.6, 33.6], [-30.4, 35], [-26.6, 36.2], [-26.6, 31.6]], 'hull', 0.1, { slope: [-0.55, 0.05], detach: { hull: 0.32 }, details: [{ k: 'shape', pts: [[-31, 31], [-31.6, 33.6], [-30.4, 35], [-29.2, 31.3]], tone: 'accent' }] }), { detach: { hull: 0.24 } }),
    // Armour plates down the flanks, the forward and aft ones shot off as it's battered.
    ...sym(plate('plateA', rows, -39, -30, 2.8, 6.4, 0.8, { detach: { hull: 0.42 } }), { detach: { hull: 0.36 } }),
    ...sym(plate('plateB', rows, -18, 0, 3, 8.4, 0.8)),
    ...sym(plate('plateC', rows, 4, 15, 3, 8.4, 0.8, { detach: { hull: 0.3 } }), { detach: { hull: 0.27 } }),
    // The upper deck, red trim down its edges.
    ...sym(part('deck', halfHull(deckRows), 'hull', 1.2, {
      slope: [-0.45, 0],
      lift: 2.4,
      details: [
        { k: 'shape', pts: edgeBand(deckRows.slice(1, 6), 1), tone: 'accent' },
        ...[-26, -6, 18].map((y): Detail => ({ k: 'line', pts: [[-4, y], [-(widthAt(deckRows, y) - 1.2), y]] })),
        windows([-9, 2], [-11.2, 14], 3, 0.3),
      ],
    })),
    // The flight deck: a trench down the middle with the hangar in it, guide lights along it.
    part('trench', rect(-3.2, -16, 6.4, 30), 'dark', 2, {
      details: [
        { k: 'shape', pts: rect(-2.2, -15, 4.4, 28), tone: 'metal' },
        { k: 'lights', pts: [...along([-2.6, -14], [-2.6, 12], 5), ...along([2.6, -14], [2.6, 12], 5)], r: 0.26, tone: 'glow' },
      ],
    }),
    // The spine forward of it to the bridge, a red stripe down it.
    ...sym(part('spine', [[0, -45], [-1.4, -41], [-2.8, -32], [-3, -16], [0, -16]], 'hull', 2.2, {
      slope: [-0.45, -0.05],
      lift: 1.4,
      details: [{ k: 'shape', pts: [[0, -32], [-0.8, -32], [-0.8, -17], [0, -17]], tone: 'accent' }, windows([-2, -30], [-2.2, -19], 3, 0.28)],
    })),
    part('bridgeFrame', [[0, -47], [2.2, -43], [2.8, -36], [2.8, -32], [-2.8, -32], [-2.8, -36], [-2.2, -43]], 'hull2', 2.6, { lift: 1 }),
    part('bridge', [[0, -45.6], [1.4, -42.4], [2, -36.6], [1.8, -33.6], [-1.8, -33.6], [-2, -36.6], [-1.4, -42.4]], 'glass', 2.8, { lift: 0.6, details: [{ k: 'shape', pts: [[-0.4, -43.6], [-1.1, -40], [-1.2, -36], [-0.6, -36], [-0.4, -40]], tone: 'glow' }] }),
    // The command tower aft: a broad block, a second tier with its bridge, masts, dishes, an array.
    part('command', chamfer(0, 22, 18, 12, 3), 'hull2', 3, {
      lift: 2.6,
      facets: [{ pts: [[-9, 19], [-6, 16], [-6, 28], [-9, 25]], slope: [-0.5, 0] }, { pts: [[9, 19], [6, 16], [6, 28], [9, 25]], slope: [0.5, 0] }],
      details: [{ k: 'shape', pts: rect(-9, 24.6, 18, 1.6), tone: 'accent' }, windows([-6.4, 20.2], [6.4, 20.2], 6, 0.32), { k: 'line', pts: [[-9, 22.6], [9, 22.6]] }],
    }),
    part('tier', chamfer(0, 21.4, 10, 6.4, 1.8), 'hull', 3.4, { lift: 1.6, details: [windows([-3.2, 19.6], [3.2, 19.6], 4, 0.36), { k: 'shape', pts: rect(-5, 23, 10, 0.9), tone: 'accent' }] }),
    part('array', rect(-5.6, 15.2, 11.2, 0.9), 'dark', 3.6, { detach: { hull: 0.58 }, details: [{ k: 'lights', pts: along([-4.8, 15.6], [4.8, 15.6], 3), r: 0.3, tone: 'accent' }] }),
    ...sym(mast('mast', -4.6, 29.6, 5, 3.6, 0.55), { detach: { hull: 0.48 } }),
    ...sym(dish('dish', -7.4, 32.6, 1.8, 3.4, 0.4), { detach: { hull: 0.3 } }),
    // Seats: armoured barbettes under the heavy batteries, pads under the flak, rings under the
    // shield bulbs, and the hangar's frame.
    ...[0, 1, 2, 3].flatMap((i) => seat(`barbette${i}`, c, i, 1.3, 2.4, 'heavy')),
    ...[4, 5, 6, 7].flatMap((i) => seat(`seatF${i}`, c, i, 1.3, 2.4, 'oct')),
    ...seat('seatS0', c, 8, 1.18, 2.4, 'heavy'),
    ...seat('seatS1', c, 9, 1.18, 2.4, 'heavy'),
    part('pylon', chamfer(0, 35, 42, 5, 1.6), 'metal', 0.5, { lift: 0.6, details: [{ k: 'line', pts: [[-20, 35], [20, 35]] }] }),
    ...pods(c, [12, 13, 10, 14, 15, 16], 32.5, [47.2, 48.6, 49.6, 49.6, 48.6, 47.2], 6.4, 1.8),
  ]
  return { parts, breakStyle: 'bands', cuts: 3 }
}

// --- Sentinel destroyer ---------------------------------------------------------------------------------

/**
 * Sentinel destroyer at 1.4×: the fleet's shield escort, a slim dagger smaller than the Paladin. Red
 * edge bands and an aft chevron, grey plates down the flanks; a raised spine from the blue bridge at
 * the nose back past the bow turbolaser to the great projector dome amidships. Its signature is the
 * three shield projectors (Republic `projector` mounts): two on armoured sponsons on the flanks and
 * the big one on the spine, joined by glowing power conduits across the deck. Four point-defence
 * turrets on octagonal pads, a small command block aft and two engine pods.
 */
export const sentinel: ModelDef = (c): ModelSpec => {
  const rows: [number, number][] = [[-50, 0.3], [-42, 3.2], [-30, 7.2], [-15, 11.8], [0, 16.6], [12, 19.6], [24, 22.4], [31, 23.6]]
  const left: Pt[] = [...halfHull(rows).slice(0, -1), [-24.6, 34], [-20, 35.6], [-11, 35], [0, 35]]
  const deckRows: [number, number][] = [[-45, 0.8], [-36, 2.4], [-22, 3.6], [-6, 4.4], [10, 5.4], [24, 5.6], [31, 5]]
  const e = (y: number, d: number) => edgeAt(rows, y, d)
  const [lx, ly] = hpAt(c, 1) ?? [-10.25, 3]
  const [, cy] = hpAt(c, 3) ?? [0, 16.5]
  const parts: Part[] = [
    ...sym(part('hull', left, 'hull', 0, {
      slope: [-0.55, 0.05],
      details: [
        { k: 'shape', pts: edgeBand(rows.slice(1), 2.2), tone: 'accent' },
        { k: 'shape', pts: [e(-36, 3.8), e(-34, 4.8), e(-18, 6.4), e(-20, 5.4)], tone: 'accent' },
        { k: 'shape', pts: [[-20, 28], [-13, 25.6], [-13, 30.4]], tone: 'accent' },
        edgeLine(rows, -32, 28, 9),
        ...[-20, 12].map((y): Detail => ({ k: 'line', pts: [e(y, 2.2), e(y, 9)] })),
        { k: 'lights', pts: [-26, -8, 18].map((y) => e(y, 3.4)), r: 0.38, tone: 'glass' },
      ],
    })),
    // The aft corners, lost as it's battered.
    ...sym(part('tip', [[-23.6, 29], [-24.4, 32.6], [-23, 34.4], [-20.4, 35.2], [-20.4, 29.6]], 'hull', 0.1, { slope: [-0.55, 0.05], detach: { hull: 0.32 }, details: [{ k: 'shape', pts: [[-23.6, 29], [-24.4, 32.6], [-23, 34.4], [-22.2, 29.4]], tone: 'accent' }] }), { detach: { hull: 0.24 } }),
    ...sym(plate('plateA', rows, -28, -17, 2.8, 6.4, 0.8, { detach: { hull: 0.4 } }), { detach: { hull: 0.34 } }),
    ...sym(plate('plateC', rows, 14, 23, 2.8, 6.6, 0.8, { detach: { hull: 0.3 } }), { detach: { hull: 0.26 } }),
    // The projector sponsons: armoured blocks on the flanks the side domes stand on, banded in red,
    // a light at each end.
    ...sym(part('sponson', chamfer(lx, ly, 10.4, 13, 2.6), 'hull2', 1.2, {
      lift: 1.4,
      facets: [{ pts: [[lx - 5.2, ly - 3.9], [lx - 2.6, ly - 6.5], [lx - 1.6, ly - 6.5], [lx - 1.6, ly + 6.5], [lx - 2.6, ly + 6.5], [lx - 5.2, ly + 3.9]], slope: [-0.5, 0] }],
      details: [{ k: 'shape', pts: box(lx, ly + 5.2, 10.4, 1.2), tone: 'accent' }, { k: 'lights', pts: [[lx - 3.8, ly - 4.6], [lx - 3.8, ly + 3.6]], r: 0.35, tone: 'glass' }],
    })),
    // The raised spine down the middle.
    ...sym(part('deck', halfHull(deckRows), 'hull', 1.4, {
      slope: [-0.45, -0.05],
      lift: 1.8,
      details: [{ k: 'shape', pts: [[0, -18], [-0.8, -18], [-0.8, 8], [0, 8]], tone: 'accent' }, { k: 'line', pts: [[-4.4, -4], [0, -4]] }, windows([-2.6, -20], [-3.2, -6], 3, 0.28)],
    })),
    // The power conduits: from the spine dome out to each sponson, glowing along their length.
    ...sym(part('conduit', [[-2, cy - 3], [lx + 2.6, ly + 3.6], [lx + 3.6, ly + 5.4], [-2, cy - 0.6]], 'metal', 1.6, {
      lift: 0.8,
      details: [{ k: 'lights', pts: along([-2.6, cy - 2], [lx + 3.4, ly + 4.4], 4), r: 0.4, tone: 'glow' }],
    })),
    part('bridgeFrame', [[0, -47], [2.2, -42], [3, -36], [3, -31], [-3, -31], [-3, -36], [-2.2, -42]], 'hull2', 2, { lift: 1.2 }),
    part('bridge', [[0, -45.4], [1.5, -41.6], [2.1, -36], [2, -33], [-2, -33], [-2.1, -36], [-1.5, -41.6]], 'glass', 2.2, { lift: 0.6, details: [{ k: 'shape', pts: [[-0.4, -43], [-1.1, -39], [-1.3, -35], [-0.6, -35], [-0.4, -39]], tone: 'glow' }] }),
    block('spine0', 0, -4, 6.4, 7, 2.4),
    // The command block aft of the big dome, a mast and a dish on it.
    block('tower', 0, 27, 8.4, 7, 2.6, {}, 'hull'),
    mast('mast', 2.4, 31.2, 4.4, 3, 0.5),
    dish('dish', -2.4, 31.4, 1.6, 3, 0.4),
    // Seats: a pad under the turbolaser, octagonal pads under the point defence, heavy rings under
    // the projectors.
    ...seat('seatT0', c, 0, 1.26, 2.6),
    ...[4, 5, 6, 7].flatMap((i) => seat(`seatF${i}`, c, i, 1.3, 1.6, 'oct')),
    ...seat('seatS0', c, 1, 1.2, 1.8, 'heavy'),
    ...seat('seatS1', c, 2, 1.2, 1.8, 'heavy'),
    ...seat('seatS2', c, 3, 1.2, 2.6, 'heavy'),
    part('pylon', chamfer(0, 34.4, 22, 4.6, 1.4), 'metal', 0.4, { lift: 0.6 }),
    ...pods(c, [8, 9], 31, 48.6, 8.4, 1.7),
  ]
  return {
    parts,
    breakStyle: 'bands',
    // Its point-defence turrets blow off; the projectors stay on, wrecked.
    mount: (i) => ({ detach: i >= 4 && i <= 7 }),
  }
}

// --- Resolute battleship ------------------------------------------------------------------------------

/**
 * Resolute battleship at 2.5×: the command carrier, a broad Republic dagger. Red edge bands and
 * chevrons, grey armour plates down the flanks; down the middle a sunken flight deck with its two
 * hangar bays, runway lights and red-and-white deck markings, and either side of it an armoured
 * flight-bay sponson with a dark launch mouth facing forward. A small observation bridge at the nose;
 * aft, the raised command bridge tower in two tiers, its long blue bridge windows, masts, dishes and
 * a sensor array. Fewer guns than the Sovereign: two heavy batteries forward, two lighter turbolasers
 * aft, point defence at the bow and stern, two shield bulbs and four engine pods. It breaks into
 * three chunks.
 */
export const resolute: ModelDef = (c): ModelSpec => {
  const rows: [number, number][] = [[-50, 0.4], [-40, 5], [-28, 10.5], [-14, 15.6], [0, 20.2], [14, 24], [26, 26.6], [32, 27.4]]
  const left: Pt[] = [...halfHull(rows).slice(0, -1), [-28, 35.5], [-22, 37], [-12, 36.5], [0, 36.5]]
  const e = (y: number, d: number) => edgeAt(rows, y, d)
  // The flight deck, between the batteries and the command tower.
  const fy0 = -17
  const fy1 = 13
  const parts: Part[] = [
    ...sym(part('hull', left, 'hull', 0, {
      slope: [-0.55, 0.05],
      details: [
        { k: 'shape', pts: edgeBand(rows.slice(1), 2.6), tone: 'accent' },
        { k: 'shape', pts: [e(-36, 4.2), e(-34, 5.4), e(-10, 7.2), e(-12, 6)], tone: 'accent' },
        { k: 'shape', pts: [[-24, 29.4], [-15, 26.8], [-15, 32]], tone: 'accent' },
        edgeLine(rows, -36, 30, 8.6),
        ...[-24, -8, 20].map((y): Detail => ({ k: 'line', pts: [e(y, 2.6), e(y, 8.6)] })),
        { k: 'lights', pts: [-28, -16, 0, 14, 26].map((y) => e(y, 4)), r: 0.34, tone: 'glass' },
      ],
    })),
    ...sym(part('tip', [[-27.6, 31], [-28.2, 34], [-27.4, 35.6], [-23.6, 36.6], [-23.6, 31.6]], 'hull', 0.1, { slope: [-0.55, 0.05], detach: { hull: 0.32 }, details: [{ k: 'shape', pts: [[-27.6, 31], [-28.2, 34], [-27.4, 35.6], [-26.2, 31.3]], tone: 'accent' }] }), { detach: { hull: 0.24 } }),
    ...sym(plate('plateA', rows, -33, -25, 2.8, 5.6, 0.8)),
    ...sym(plate('plateC', rows, 18, 26, 3, 7.4, 0.8, { detach: { hull: 0.3 } }), { detach: { hull: 0.27 } }),
    // The flight-bay sponsons: armoured blocks either side of the flight deck, a dark launch mouth
    // at the front of each with guide lights, a red band across the back.
    ...sym(part('baySponson', [[-17.6, -12], [-14.2, -15], [-9.6, -15], [-9.6, 11], [-12, 13.4], [-18.6, 13.4], [-19.4, 6]], 'hull2', 1.2, {
      lift: 1.6,
      facets: [{ pts: [[-17.6, -12], [-14.2, -15], [-13.2, -15], [-13.2, 13.4], [-18.6, 13.4], [-19.4, 6]], slope: [-0.5, 0] }],
      details: [
        { k: 'shape', pts: rect(-18.8, 9.4, 9.2, 1.4), tone: 'accent' },
        { k: 'line', pts: [[-19, -2], [-9.6, -2]] },
        windows([-16.6, 1], [-16.6, 7], 3, 0.3),
      ],
    })),
    ...sym(part('bayMouth', [[-16.6, -11.6], [-14.4, -13.6], [-11, -13.6], [-11, -7], [-16.6, -7]], 'dark', 1.4, {
      details: [{ k: 'lights', pts: along([-15.6, -7.8], [-11.8, -7.8], 3), r: 0.32, tone: 'glow' }, { k: 'lights', pts: [[-13.6, -12.6]], r: 0.3, tone: 'accent' }],
    })),
    // The flight deck: sunk between the sponsons, runway lights down both sides, a red-and-white
    // centre line between the hangar bays.
    part('flightDeck', rect(-9.6, fy0, 19.2, fy1 - fy0), 'metal', 1, {
      details: [
        { k: 'shape', pts: rect(-8.4, fy0 + 1, 16.8, fy1 - fy0 - 2), tone: 'dark' },
        { k: 'lights', pts: [...along([-8, fy0 + 2], [-8, fy1 - 2], 6), ...along([8, fy0 + 2], [8, fy1 - 2], 6)], r: 0.3, tone: 'glow' },
        ...[-3.4, -1.6].map((y): Detail => ({ k: 'shape', pts: box(0, y, 1, 1), tone: 'hull' })),
        { k: 'shape', pts: box(0, -2.5, 0.5, 2.8), tone: 'accent' },
        { k: 'shape', pts: rect(-8.4, fy1 - 2.2, 16.8, 0.8), tone: 'accent' },
      ],
    }),
    // The bow: a spine from the observation bridge back to the batteries, a red stripe down it.
    ...sym(part('spine', [[0, -45], [-1.6, -40], [-3.2, -30], [-3.6, fy0], [0, fy0]], 'hull', 2, {
      slope: [-0.45, -0.05],
      lift: 1.6,
      details: [{ k: 'shape', pts: [[0, -30], [-0.8, -30], [-0.8, fy0 - 1], [0, fy0 - 1]], tone: 'accent' }, windows([-2.2, -28], [-2.6, -20], 3, 0.28)],
    })),
    part('bridgeFrame', [[0, -47.4], [2, -43.4], [2.6, -38.4], [2.6, -36], [-2.6, -36], [-2.6, -38.4], [-2, -43.4]], 'hull2', 2.4, { lift: 1 }),
    part('bridge', [[0, -46], [1.3, -43], [1.8, -38.8], [1.6, -37.2], [-1.6, -37.2], [-1.8, -38.8], [-1.3, -43]], 'glass', 2.6, { lift: 0.6, details: [{ k: 'shape', pts: [[-0.4, -44.4], [-1, -41.6], [-1.1, -39], [-0.5, -39], [-0.4, -41.6]], tone: 'glow' }] }),
    // The aft deck the command tower stands on.
    part('aftDeck', chamfer(0, 24.4, 22, 20, 4), 'hull', 1.2, {
      lift: 1.2,
      facets: [{ pts: [[-11, 18.4], [-7, 14.4], [-5, 14.4], [-5, 34.4], [-7, 34.4], [-11, 30.4]], slope: [-0.5, 0] }, { pts: [[11, 18.4], [7, 14.4], [5, 14.4], [5, 34.4], [7, 34.4], [11, 30.4]], slope: [0.5, 0] }],
      details: [{ k: 'shape', pts: rect(-11, 31.6, 22, 1.2), tone: 'accent' }, { k: 'line', pts: [[-11, 26], [-5.6, 26]] }, { k: 'line', pts: [[5.6, 26], [11, 26]] }],
    }),
    // The command bridge tower: a broad base, a second tier with the long bridge windows, a sensor
    // array across its front, masts and dishes.
    part('command', chamfer(0, 22, 12.4, 12, 2.8), 'hull2', 3, {
      lift: 2.8,
      facets: [{ pts: [[-6.2, 18.8], [-3.4, 16], [-3.4, 28], [-6.2, 25.2]], slope: [-0.5, 0] }, { pts: [[6.2, 18.8], [3.4, 16], [3.4, 28], [6.2, 25.2]], slope: [0.5, 0] }],
      details: [{ k: 'shape', pts: rect(-6.2, 24.6, 12.4, 1.4), tone: 'accent' }, windows([-4.4, 19.6], [4.4, 19.6], 5, 0.3), { k: 'line', pts: [[-6.2, 22.4], [6.2, 22.4]] }],
    }),
    part('tier', chamfer(0, 21, 8, 6.4, 1.6), 'hull', 3.4, {
      lift: 1.8,
      details: [{ k: 'shape', pts: rect(-3.4, 18.6, 6.8, 1.4), tone: 'glass' }, { k: 'lights', pts: along([-2.8, 19.3], [2.8, 19.3], 4), r: 0.3, tone: 'glow' }, { k: 'shape', pts: rect(-4, 23, 8, 0.8), tone: 'accent' }],
    }),
    part('array', rect(-4.6, 15.2, 9.2, 0.9), 'dark', 3.6, { detach: { hull: 0.58 }, details: [{ k: 'lights', pts: along([-3.8, 15.6], [3.8, 15.6], 3), r: 0.3, tone: 'accent' }] }),
    ...sym(mast('mast', -3.2, 29.2, 4.6, 3.6, 0.55), { detach: { hull: 0.48 } }),
    ...sym(dish('dish', -5.6, 30.4, 1.6, 3.4, 0.4), { detach: { hull: 0.3 } }),
    // Seats: barbettes under the batteries, pads under the point defence, rings under the shield
    // bulbs; the hangars sit in the flight deck.
    ...[0, 1].flatMap((i) => seat(`barbette${i}`, c, i, 1.3, 2.4, 'heavy')),
    ...[2, 3].flatMap((i) => seat(`barbette${i}`, c, i, 1.3, 2.2, 'heavy')),
    ...[4, 5, 6, 7].flatMap((i) => seat(`seatF${i}`, c, i, 1.3, 2.2, 'oct')),
    ...seat('seatS0', c, 8, 1.18, 2.2, 'heavy'),
    ...seat('seatS1', c, 9, 1.18, 2.2, 'heavy'),
    part('pylon', chamfer(0, 35.6, 32, 5, 1.6), 'metal', 0.5, { lift: 0.6, details: [{ k: 'line', pts: [[-15, 35.6], [15, 35.6]] }] }),
    ...pods(c, [12, 13, 14, 15], 32.5, [48.4, 49.4, 49.4, 48.4], 6.8, 1.8),
  ]
  return { parts, breakStyle: 'bands', cuts: 2, mount: (i) => ({ detach: i >= 4 && i <= 7 }) }
}
