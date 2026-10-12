import { along, box, chamfer, circle, halfHull, part, rect, sym } from './kit.ts'
import { edgeBand, nacelle } from './republic.ts'
import type { BuildCtx, ModelDef, ModelSpec } from './spec.ts'
import type { Detail, Part, Pt } from './types.ts'

// The bigger redesigns of the Republic's Warden frigate and Sovereign dreadnought: what they look
// like under Big ship sizes (sizes.ts), and in the Codex's "New" view. They are built on the Big
// unit type, whose hardpoints sit where BIG_LAYOUT in sizes.ts puts them: one turret per gun,
// spread over the bigger hull with room between them, each on its own pad or barbette.
//
// The look is meant to read as big and slow: large, quiet surfaces with a few crisp details. Long
// armour plates down the flanks, a raised deck, a trench, a strong stepped superstructure with its
// bridge, a few masts and dishes, an engine bank, and lights placed sparingly.

/** Half-width of a hull at `y`, from its (y, half-width) rows. */
function widthAt(rows: [number, number][], y: number) {
  if (y <= rows[0][0]) return rows[0][1]
  for (let i = 1; i < rows.length; i++) {
    const [y0, w0] = rows[i - 1]
    const [y1, w1] = rows[i]
    if (y <= y1) return w0 + ((w1 - w0) * (y - y0)) / (y1 - y0)
  }
  return rows[rows.length - 1][1]
}

/** A point `d` in from the left edge of a hull at `y`. */
const edgeAt = (rows: [number, number][], y: number, d: number): Pt => [-(widthAt(rows, y) - d), y]

/** A long armour plate on the left side of a hull, laid along its edge between `in0` and `in1` in
 * from it, from y0 to y1: one seam across the middle and a pair of running lights. */
function plate(id: string, rows: [number, number][], y0: number, y1: number, in0: number, in1: number, z: number, more: Partial<Part> = {}): Part {
  const e = (y: number, d: number) => edgeAt(rows, y, d)
  const pts: Pt[] = [e(y0, in0), e(y0 + 0.8, in1), e(y1 - 0.8, in1), e(y1, in0)]
  const mid = (y0 + y1) / 2
  const c = (in0 + in1) / 2
  return part(id, pts, 'hull2', z, {
    slope: [-0.55, 0.05],
    lift: 0.7,
    details: [
      { k: 'line', pts: [e(mid, in0 + 0.6), e(mid, in1 - 0.4)] },
      { k: 'lights', pts: [e(y0 + 2, c), e(y1 - 2, c)], r: 0.3, tone: 'dark' },
    ],
    ...more,
  })
}

/** A panel line following the left edge of a hull `d` in from it, from y0 to y1. */
const edgeLine = (rows: [number, number][], y0: number, y1: number, d: number): Detail => ({ k: 'line', pts: along([0, y0], [0, y1], 6).map(([, y]) => edgeAt(rows, y, d)) })

/** Where hardpoint `i` sits in model units. */
const hpAt = (c: BuildCtx, i: number): Pt => [(c.t.hardpoints[i].x / 10 - 0.5) * c.w, (c.t.hardpoints[i].y / 10 - 0.5) * c.h]

/** A turret's seat: a raised round pad (a barbette for a heavy gun) under hardpoint `i`, a little
 * wider than the turret, with a ring scribed round it. Left side only; the right one is mirrored. */
function seat(id: string, c: BuildCtx, i: number, r: number, z: number, heavy: boolean): Part {
  const [x, y] = hpAt(c, i)
  return part(id, circle(x, y, r, heavy ? 20 : 16), heavy ? 'metal' : 'hull2', z, {
    lift: heavy ? 0.9 : 0.5,
    details: [{ k: 'line', pts: [...circle(x, y, r * 0.86, 18), circle(x, y, r * 0.86, 18)[0]] }, ...(heavy ? [{ k: 'shape' as const, pts: box(x, y + r * 0.78, r * 0.9, r * 0.22), tone: 'accent' as const }] : [])],
  })
}

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
