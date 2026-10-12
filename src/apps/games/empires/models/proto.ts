import { along, box, chamfer, circle, halfHull, part, rect, sym } from './kit.ts'
import { edgeBand, nacelle } from './republic.ts'
import type { ModelDef, ModelSpec } from './spec.ts'
import type { Detail, Part, Pt } from './types.ts'

// Prototypes of bigger, more detailed warships (step A: the Republic's Warden frigate and Sovereign
// dreadnought), drawn at the size classes in sizes.ts and shown only in the Codex, next to the
// designs the battle uses. They keep the unit's box and every hardpoint where data.ts puts it (the
// battle aims at those), keep its guns about the size they were on the bigger hull, and add many
// smaller turrets for show (extraMounts), each standing for one of the real hardpoints.
//
// Built in layers, so a bigger hull has more to look at and more to lose: a lower hull with red
// edge bands, armour plates laid over it in rows, a raised deck, trenches and hangar bays, a
// stepped superstructure with its bridge, masts and dishes, engine banks with auxiliary nozzles,
// and greebles (vents, hatches, lights) all over.

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

/** An armour plate on the left side of a hull, laid along its edge between `in0` and `in1` in from
 * it, from y0 to y1, with a seam and a rivet row. */
function plate(id: string, rows: [number, number][], y0: number, y1: number, in0: number, in1: number, z: number, more: Partial<Part> = {}): Part {
  const e = (y: number, d: number): Pt => [-(widthAt(rows, y) - d), y]
  const pts: Pt[] = [e(y0, in0), e(y0 + 0.6, in1), e(y1 - 0.6, in1), e(y1, in0)]
  const mid = (y0 + y1) / 2
  return part(id, pts, 'hull2', z, {
    slope: [-0.55, 0.05],
    lift: 0.7,
    details: [
      { k: 'line', pts: [e(mid, in0 + 0.6), e(mid, in1 - 0.4)] },
      { k: 'lights', pts: along(e(y0 + 1.6, (in0 + in1) / 2), e(y1 - 1.6, (in0 + in1) / 2), 3), r: 0.28, tone: 'dark' },
    ],
    ...more,
  })
}

/** Greebles: small vents and hatches scattered down a strip on the left side, the same every time. */
function greebles(x0: number, x1: number, y0: number, y1: number, n: number, seed: number): Detail[] {
  const out: Detail[] = []
  let s = seed
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < n; i++) {
    const x = x0 + (x1 - x0) * r()
    const y = y0 + (y1 - y0) * r()
    const w = 0.8 + r() * 1.8
    const h = 0.6 + r() * 1.4
    out.push({ k: 'shape', pts: rect(x - w / 2, y - h / 2, w, h), tone: r() < 0.6 ? 'dark' : 'metal' })
  }
  return out
}

/** A left/right pair of parts, the right one with its own detach rule. */
const pair = (p: Part, right: Partial<Part> = {}): Part[] => sym(p, right)

/**
 * Warden frigate, prototype at 1.4×: the same escort dagger, built up. A lower hull with red edge
 * bands and detachable wing tips; four rows of armour plates down each flank (two of them blown off
 * as it is battered); a raised forward deck split by a docking trench, a heavy turret on a platform
 * behind it; a three-tier superstructure with the bridge, two masts, two dishes and an antenna; an
 * engine bank of three main engines and two auxiliary nozzles. Seven extra turrets: six small point-
 * defence mounts (standing for the four flak hardpoints) and a heavy turbolaser on the deck
 * (standing for the turbolaser).
 */
export const frigate: ModelDef = (): ModelSpec => {
  const rows: [number, number][] = [[-50, 0.4], [-44, 4], [-34, 9.2], [-22, 14.8], [-8, 20.6], [6, 25.8], [18, 29.6]]
  const left: Pt[] = [...halfHull(rows).slice(0, -1), [-26.5, 26], [-26.5, 38], [-18, 42], [0, 42]]
  const tip: Pt[] = [[-29.6, 18], [-32.6, 28], [-33.5, 33], [-30, 37.5], [-26.5, 38], [-26.5, 26]]
  const hullDetails: Detail[] = [
    { k: 'shape', pts: edgeBand(rows.slice(1), 2.8), tone: 'accent' },
    { k: 'lights', pts: along([-11.6, -18], [-23.2, 14], 9), r: 0.4 },
    ...greebles(-22, -12, -10, 30, 14, 11),
    ...[-30, -16, -2, 10, 22].map((y): Detail => ({ k: 'line', pts: [[0, y], [-(widthAt(rows, y) - 1), y]] })),
    { k: 'shape', pts: [[-24, 30], [-15, 28], [-15, 34]], tone: 'accent' },
  ]
  const parts: Part[] = [
    ...pair(part('hull', left, 'hull', 0, { slope: [-0.55, 0.05], details: hullDetails })),
    ...pair(part('tip', tip, 'hull', 0, { slope: [-0.55, 0.05], detach: { hull: 0.32 }, details: [{ k: 'shape', pts: [[-29.6, 18], [-32.6, 28], [-33.5, 33], [-31.6, 33.4], [-29, 24]], tone: 'accent' }] }), { detach: { hull: 0.22 } }),
    // Rows of armour plates down each flank, the second and fourth blown off as it's battered.
    ...[[-30, -18], [-16, -4], [-2, 10], [12, 22]].flatMap(([y0, y1], k) =>
      pair(plate(`plate${k}`, rows, y0, y1, 4.2, 10, 0.8, k % 2 ? { detach: { hull: k === 1 ? 0.36 : 0.28 } } : {}), k % 2 ? { detach: { hull: k === 1 ? 0.3 : 0.22 } } : {}),
    ),
    // The raised forward deck, a docking trench down its middle.
    ...sym(part('deck', halfHull([[-45, 0.8], [-38, 3.2], [-26, 6.6], [-12, 9.6], [0, 11]]), 'hull2', 1.2, {
      slope: [-0.5, -0.05],
      lift: 1.6,
      details: [{ k: 'shape', pts: [[-3, -40], [-4.6, -40], [-6.8, -14], [-5, -14]], tone: 'accent' }, { k: 'line', pts: [[-1, -24], [-6.4, -24]] }, ...greebles(-9, -4, -10, -2, 4, 7)],
    })),
    part('trench', rect(-3, -38, 6, 26), 'dark', 1.4, {
      details: [{ k: 'shape', pts: rect(-1.8, -37, 3.6, 24), tone: 'metal' }, { k: 'lights', pts: along([0, -35], [0, -15], 5), r: 0.4, tone: 'ember' }, { k: 'lights', pts: [...along([-2.6, -36], [-2.6, -14], 6), ...along([2.6, -36], [2.6, -14], 6)], r: 0.25 }],
    }),
    part('platform', chamfer(0, -6, 10, 9, 2.4), 'metal', 1.6, { lift: 1, details: [{ k: 'shape', pts: rect(-5, -2.6, 10, 1.2), tone: 'accent' }] }),
    // Engine bank: a block, three main engines and two auxiliary nozzles.
    part('block', chamfer(0, 39, 36, 8, 2.5), 'metal', 1.5, { lift: 0.8, details: [{ k: 'line', pts: [[-17, 39], [17, 39]] }, ...greebles(-16, 16, 36, 42, 8, 5)] }),
    nacelle('pod0', -9.1, 34, 48.6, 7.4, 0, 2, { detach: { hull: 0.16 } }),
    nacelle('pod1', 0, 34, 49.2, 7.6, 1, 2),
    nacelle('pod2', 9.5, 34, 48.6, 7.4, 2, 2, { detach: { hull: 0.1 } }),
    ...pair(nacelle('aux', -15.8, 36, 45.6, 4.4, undefined, 1.8, { detach: { hull: 0.2 } }, 'hull2'), { detach: { hull: 0.14 } }),
    // The superstructure: a plated base, a second tier, the bridge with its windows, a crown.
    part('base', chamfer(0, 17, 26, 26, 6), 'hull', 3, {
      lift: 2.6,
      facets: [{ pts: [[-13, 10], [-7, 4], [-7, 30], [-13, 24]], slope: [-0.5, 0] }, { pts: [[13, 10], [7, 4], [7, 30], [13, 24]], slope: [0.5, 0] }],
      details: [{ k: 'shape', pts: rect(-13, 26, 26, 1.8), tone: 'accent' }, { k: 'lights', pts: [...along([-11, 9], [-11, 25], 5), ...along([11, 9], [11, 25], 5)], r: 0.4 }, ...greebles(-11, -5, 12, 28, 5, 3)],
    }),
    part('tier', chamfer(0, 18.5, 17, 17, 4), 'hull2', 3.5, { lift: 2, details: [{ k: 'shape', pts: [[-8.5, 21], [0, 18.6], [8.5, 21], [8.5, 22.8], [0, 20.4], [-8.5, 22.8]], tone: 'accent' }] }),
    part('bridge', chamfer(0, 12.6, 11, 6, 2), 'hull', 4, { lift: 1.6, details: [{ k: 'lights', pts: along([-4, 11.6], [4, 11.6], 5), r: 0.5, tone: 'glass' }, { k: 'shape', pts: rect(-5.5, 14, 11, 0.9), tone: 'accent' }] }),
    part('crown', chamfer(0, 20.5, 7, 7, 1.8), 'metal', 4.2, { lift: 1.2, details: [{ k: 'lights', pts: [[0, 20.5]], r: 0.6, tone: 'accent' }] }),
    part('mastL', box(-4, 26.5, 0.8, 8), 'dark', 4.6, { detach: { hull: 0.5 }, details: [{ k: 'lights', pts: [[-4, 22.8]], r: 0.45, tone: 'accent' }] }),
    part('mastR', box(4.6, 25.2, 0.7, 6), 'dark', 4.6, { detach: { hull: 0.42 }, details: [{ k: 'lights', pts: [[4.6, 22.4]], r: 0.4, tone: 'accent' }] }),
    part('antenna', box(0, 4.6, 0.6, 5.4), 'dark', 4.6, { detach: { hull: 0.55 } }),
    part('dishL', circle(-8.6, 24.6, 2.2, 14), 'metal', 4.4, { lift: 1, slope: [-0.3, 0.3], detach: { hull: 0.36 }, details: [{ k: 'shape', pts: circle(-8.6, 24.6, 0.7, 8), tone: 'dark' }] }),
    part('dishR', circle(9, 9.4, 1.7, 12), 'metal', 4.4, { lift: 0.8, slope: [0.3, 0.3], detach: { hull: 0.3 }, details: [{ k: 'shape', pts: circle(9, 9.4, 0.5, 8), tone: 'dark' }] }),
  ]
  return {
    parts,
    breakStyle: 'bands',
    // The real guns keep about the size they had on the smaller hull; flak still blows off.
    mount: (i) => ({ detach: i < 4, scale: 0.82 }),
    extraMounts: [
      { x: -8.6, y: -30, r: 2.2, design: 'flak', maps: 0 },
      { x: 8.6, y: -30, r: 2.2, design: 'flak', maps: 1 },
      { x: -20.6, y: 9, r: 2.3, design: 'flak', maps: 2 },
      { x: 20.6, y: 9, r: 2.3, design: 'flak', maps: 3 },
      { x: -23.6, y: 16.6, r: 2.3, design: 'flak', maps: 2 },
      { x: 23.6, y: 16.6, r: 2.3, design: 'flak', maps: 3 },
      { x: 0, y: -6, r: 3.9, design: 'turbo', maps: 4 },
    ],
  }
}

/**
 * Sovereign dreadnought, prototype at 2.5×: the flagship as a real capital ship. A great dagger hull
 * with red edge bands and detachable wing tips; two rows of armour plates down each flank, the inner
 * row opening into hangar galleries amidships; a raised upper deck carrying turbolaser batteries; the
 * flight-deck trench with its bay doors; twin bridge towers under the shield domes and a three-tier
 * command tower between them, with four masts, three dishes and antenna arrays; an engine bank of
 * five main engines and four auxiliary nozzles. Twenty-one extra turrets: ten medium turbolasers and a
 * heavy one on the spine (standing for the four turbolaser hardpoints) and ten point-defence mounts
 * (for the four flak hardpoints). It breaks into four chunks.
 */
export const capital: ModelDef = (): ModelSpec => {
  const rows: [number, number][] = [[-50, 0.4], [-44, 3.4], [-34, 7.6], [-22, 12.4], [-8, 17.4], [6, 22.2], [20, 26.6]]
  const left: Pt[] = [...halfHull(rows).slice(0, -1), [-24, 30], [-24, 40], [-20, 42.5], [0, 42.5]]
  const tip: Pt[] = [[-26.6, 20], [-29.6, 29], [-31.4, 34], [-28, 37.5], [-24, 40], [-24, 30]]
  const deckRows: [number, number][] = [[-41, 1.2], [-32, 4], [-20, 8.8], [-8, 12.8], [6, 15.6], [18, 15.8], [25, 13]]
  const hullDetails: Detail[] = [
    { k: 'shape', pts: edgeBand(rows.slice(1), 2.4), tone: 'accent' },
    { k: 'lights', pts: along([-9, -28], [-23.8, 18], 16), r: 0.32 },
    ...greebles(-23, -14, 18, 38, 16, 21),
    ...[-36, -26, -14, -2, 10, 22].map((y): Detail => ({ k: 'line', pts: [[-(widthAt(rows, y) - 2.6), y], [-(widthAt(rows, y) - 15), y]] })),
    { k: 'shape', pts: [[-22, 33], [-14, 31], [-14, 37]], tone: 'accent' },
  ]
  const segs: [number, number][] = [[-34, -24.4], [-23.4, -12.4], [-11.4, -0.4], [0.6, 11.6], [12.6, 21]]
  const parts: Part[] = [
    ...pair(part('hull', left, 'hull', 0, { slope: [-0.55, 0.05], details: hullDetails })),
    ...pair(part('tip', tip, 'hull', 0, { slope: [-0.55, 0.05], detach: { hull: 0.32 }, details: [{ k: 'shape', pts: [[-26.6, 20], [-29.6, 29], [-31.4, 34], [-29.6, 34.6], [-26.2, 26]], tone: 'accent' }] }), { detach: { hull: 0.22 } }),
    // Two rows of armour plates down each flank: the outer row's second and fourth are shot off as
    // it is battered; the inner row opens into hangar galleries amidships.
    ...segs.flatMap(([y0, y1], k) => pair(plate(`belt${k}`, rows, y0, y1, 3.4, 8, 0.8, k === 1 || k === 3 ? { detach: { hull: k === 1 ? 0.38 : 0.3 } } : {}), k === 1 || k === 3 ? { detach: { hull: k === 1 ? 0.34 : 0.26 } } : {})),
    ...segs.flatMap(([y0, y1], k) => (k === 2 || k === 3 ? [] : pair(plate(`inner${k}`, rows, y0, y1, 8.8, 13.6, 0.85)))),
    ...[2, 3].flatMap((k) => {
      const [y0, y1] = segs[k]
      const e = (y: number, d: number): Pt => [-(widthAt(rows, y) - d), y]
      return pair(part(`bay${k}`, [e(y0, 8.8), e(y0 + 0.6, 13.6), e(y1 - 0.6, 13.6), e(y1, 8.8)], 'dark', 0.9, {
        details: [
          ...[0.25, 0.5, 0.75].map((f): Detail => ({ k: 'line', pts: [e(y0 + (y1 - y0) * f, 9.2), e(y0 + (y1 - y0) * f, 13.2)] })),
          { k: 'lights', pts: along(e(y0 + 1, 11.2), e(y1 - 1, 11.2), 5), r: 0.36 },
          { k: 'lights', pts: [e(y0 + 0.8, 9.4), e(y1 - 0.8, 9.4)], r: 0.3, tone: 'ember' },
        ],
      }))
    }),
    // The upper deck with its turbolaser batteries, red trim down its edges.
    ...sym(part('deck', halfHull(deckRows), 'hull2', 1.2, {
      slope: [-0.45, 0],
      lift: 2.4,
      details: [
        { k: 'shape', pts: edgeBand(deckRows.slice(1, 6), 1.1), tone: 'accent' },
        { k: 'lights', pts: along([-10, -4], [-14.2, 16], 6), r: 0.32 },
        ...greebles(-13, -6, -10, 22, 12, 4),
        ...[-18, -6, 6, 16].map((y): Detail => ({ k: 'line', pts: [[-4.6, y], [-(widthAt(deckRows, y) - 1.2), y]] })),
      ],
    })),
    // The flight deck: a trench with bay doors and guide lights, where the fighter wing launches.
    part('trench', rect(-4.4, -37, 8.8, 52), 'dark', 2, {
      details: [
        { k: 'shape', pts: rect(-2.8, -35.5, 5.6, 49), tone: 'metal' },
        ...[-30, -20, 4, 10].map((y): Detail => ({ k: 'shape', pts: rect(-2.8, y, 5.6, 0.9), tone: 'dark' })),
        { k: 'lights', pts: [...along([0, -33], [0, -15], 7), ...along([0, 3], [0, 12], 3)], r: 0.42, tone: 'ember' },
        { k: 'lights', pts: [...along([-3.6, -34], [-3.6, 13], 12), ...along([3.6, -34], [3.6, 13], 12)], r: 0.26 },
      ],
    }),
    ...sym(part('spine', [[0, -47], [-1.6, -43], [-3.4, -37], [0, -37]], 'hull2', 2, { slope: [-0.45, -0.1], lift: 1.2, details: [{ k: 'shape', pts: [[0, -46], [-0.8, -43], [-1.2, -38], [0, -38]], tone: 'accent' }] })),
    part('antennaF', box(0, -45.5, 0.6, 5), 'dark', 3, { detach: { hull: 0.45 } }),
    // Engine bank: a block, five main engines, four auxiliary nozzles.
    part('block', chamfer(0, 41.5, 44, 10, 3), 'metal', 1, { lift: 0.8, details: [{ k: 'line', pts: [[-20, 41], [20, 41]] }, ...greebles(-20, 20, 37.5, 45.5, 14, 9)] }),
    ...[-14.5, -7.9, -0.3, 7.7, 14.3].map((x, i) => nacelle(`pod${i}`, x, 36, i === 2 ? 49.6 : i === 1 || i === 3 ? 48.4 : 47.4, 6.2, i, 2, i === 0 ? { detach: { hull: 0.16 } } : i === 4 ? { detach: { hull: 0.1 } } : {}, i === 2 ? 'accent' : 'hull2')),
    ...pair(nacelle('auxA', -20.6, 37, 45.4, 3.6, undefined, 1.8, { detach: { hull: 0.24 } }, 'hull2'), { detach: { hull: 0.18 } }),
    ...pair(nacelle('auxB', -24.4, 36, 43.4, 3, undefined, 1.8, { detach: { hull: 0.2 } }, 'hull2'), { detach: { hull: 0.14 } }),
    // Twin bridge towers carrying the shield domes, the command tower between them.
    ...pair(part('tower', chamfer(-14.2, 30.5, 17, 20, 4.2), 'hull', 3, {
      lift: 3,
      facets: [{ pts: [[-22.7, 24.7], [-18.5, 20.5], [-18.5, 40.5], [-22.7, 36.3]], slope: [-0.5, 0] }],
      details: [{ k: 'shape', pts: rect(-22.7, 22.6, 17, 1.4), tone: 'accent' }, { k: 'lights', pts: along([-21.6, 25], [-21.6, 37], 5), r: 0.34 }, ...greebles(-21, -17, 34, 39, 4, 13)],
    })),
    part('command', chamfer(0, 27.5, 16, 15, 3.6), 'hull2', 3.5, { lift: 3.4, details: [{ k: 'shape', pts: [[-8, 30], [0, 27.6], [8, 30], [8, 31.6], [0, 29.2], [-8, 31.6]], tone: 'accent' }, ...greebles(-7, 7, 31, 34, 5, 17)] }),
    part('tier', chamfer(0, 27.5, 10.6, 9.4, 2.6), 'hull', 3.8, { lift: 2, details: [{ k: 'lights', pts: along([-3.6, 23.6], [3.6, 23.6], 5), r: 0.38, tone: 'glass' }] }),
    part('bridge', chamfer(0, 22.4, 9, 3.6, 1.2), 'hull2', 4, { lift: 1.2, details: [{ k: 'lights', pts: along([-3.6, 22.4], [3.6, 22.4], 7), r: 0.34, tone: 'glass' }] }),
    part('crown', chamfer(0, 28.6, 5.6, 5, 1.4), 'metal', 4.2, { lift: 1.2, details: [{ k: 'lights', pts: [[0, 28.6]], r: 0.5, tone: 'accent' }] }),
    ...pair(part('mast', box(-5, 35.6, 0.8, 7), 'dark', 4.5, { detach: { hull: 0.55 }, details: [{ k: 'lights', pts: [[-5, 32.4]], r: 0.4, tone: 'accent' }] }), { detach: { hull: 0.48 } }),
    ...pair(part('spire', box(-14.2, 20.4, 0.7, 5.6), 'dark', 4.5, { detach: { hull: 0.5 }, details: [{ k: 'lights', pts: [[-14.2, 17.8]], r: 0.35, tone: 'accent' }] }), { detach: { hull: 0.44 } }),
    ...pair(part('dish', circle(-24, 15, 2.6, 14), 'metal', 3, { lift: 1, slope: [-0.3, 0.3], detach: { hull: 0.4 }, details: [{ k: 'shape', pts: circle(-24, 15, 0.8, 8), tone: 'dark' }] }), { detach: { hull: 0.3 } }),
    part('dishC', circle(4.4, 33.8, 1.8, 12), 'metal', 4.4, { lift: 0.8, slope: [0.3, 0.3], detach: { hull: 0.35 }, details: [{ k: 'shape', pts: circle(4.4, 33.8, 0.6, 8), tone: 'dark' }] }),
    part('array', rect(-6.4, 18.6, 12.8, 0.9), 'dark', 4.3, { detach: { hull: 0.58 }, details: [{ k: 'lights', pts: along([-6, 19], [6, 19], 5), r: 0.3, tone: 'accent' }] }),
  ]
  // Point-defence mounts along the hull's edge, inside its red band.
  const edge = (y: number): Pt => [-(widthAt(rows, y) - 5.6), y]
  const pd = [-30, -18, -6, 6, 16].flatMap((y, k) => {
    const [x] = edge(y)
    const maps = k < 2 ? 4 : k < 4 ? 6 : 6
    return [
      { x, y, r: 1.45, design: 'flak' as const, maps },
      { x: -x, y, r: 1.45, design: 'flak' as const, maps: maps + 1 },
    ]
  })
  const battery = ([[-5.4, -29, 0], [-7.8, -23.4, 0], [-14.6, 1.4, 2], [-13.6, 14, 2], [-10.6, 19, 2]] as const).flatMap(([x, y, maps]) => [
    { x, y, r: 2.4, design: 'turbo' as const, maps },
    { x: -x, y, r: 2.4, design: 'turbo' as const, maps: maps + 1 },
  ])
  return {
    parts,
    breakStyle: 'bands',
    cuts: 3,
    // The real guns keep about the size they had on the smaller hull (the shield domes a little
    // bigger, as they crown the towers); flak still blows off.
    mount: (i) => ({ scale: i === 8 || i === 9 ? 0.64 : i === 11 ? 0.72 : 0.6 }),
    extraMounts: [...battery, ...pd, { x: 0, y: -41.6, r: 2.4, design: 'turbo', maps: 0 }],
  }
}
