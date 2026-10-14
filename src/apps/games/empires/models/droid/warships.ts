import { along, box, chamfer, circle, halfHull, part, rect, sym, turn } from '../kit.ts'
import * as classic from './craft.ts'
import { dish, ellBand, engineBlock, eyes, lamps, mast, rivets, sail } from './craft.ts'
import { calm, seat, type SeatLook } from '../proto.ts'
import type { BuildCtx, ModelDef, ModelSpec } from '../spec.ts'
import type { Detail, Part, Pt, Tone } from '../types.ts'

// The droid navy's warships at their size (sizes.ts), in the same calm style as the Republic's
// (models/republic/warships.ts): big quiet plates over the gunmetal frames, a single row of rivets,
// a few eyes and lamps, and one gun per hardpoint on its own seat, the hardpoints where its `layout`
// (data/droid.ts) puts them.

/** Droid seats: a gunmetal pad, a heavier sand-plated barbette with a rust band. */
export const DROID_SEAT: SeatLook = { pad: 'metal', heavy: 'hull2', band: 'accent' }

/** A long plate either side of a spine, from y0 to y1, `w` half-wide: one rivet row, one rust strip. */
function sidePlate(id: string, y0: number, y1: number, w: number, tone: Tone, z: number, more: Partial<Part> = {}): Part[] {
  return sym(part(id, [[0, y0], [-w * 0.8, y0], [-w, y0 + 2.4], [-w, y1 - 2.4], [-w * 0.8, y1], [0, y1]], tone, z, {
    slope: [-0.5, 0],
    lift: 1,
    details: [rivets([-w + 1.2, y0 + 3], [-w + 1.2, y1 - 3], 3), { k: 'shape', pts: rect(-w * 0.62, y0 + 2, w * 0.18, y1 - y0 - 4), tone: 'accent' }],
    ...more,
  }))
}

/** Triad gunship at 1.15×: the same three-armed droid, its surface quietened. */
export const gunship: ModelDef = (c) => calm(classic.gunship(c))

/**
 * Disruptor frigate at 1.4×: a slim gunmetal spine with three long plates strung along it, the ion
 * cannon on a heavy barbette on the forward one, the shield generator amidships and the flak aft,
 * well apart; the great emitter dish at the nose with the ion spike glowing in it, a short sail and
 * vanes aft, two engine blocks.
 */
export const ion: ModelDef = (c): ModelSpec => {
  const parts: Part[] = [
    part('spine', rect(-3, -40, 6, 80), 'metal', 1, { details: [...[-12, 10, 32].map((y): Detail => ({ k: 'line', pts: [[-3, y], [3, y]] }))] }),
    ...sidePlate('plateA', -37, -15, 10.4, 'hull', 2),
    ...sidePlate('plateB', -11, 6, 7.8, 'hull2', 2),
    ...sidePlate('plateC', 10, 31, 7, 'hull', 2),
    ...sym(part('vane', [[-6.6, 24], [-11, 28], [-11, 32], [-6.6, 31]], 'hull', 1.6, { slope: [-0.4, 0], detach: { hull: 0.4 } }), { slope: [0.4, 0], detach: { hull: 0.28 } }),
    sail('sail', 0, 23, 36, 1.8, 3, 5, { detach: { hull: 0.34 } }),
    engineBlock('podL', -6, 35, 49, 5.4, 0, 2, { detach: { hull: 0.16 } }),
    engineBlock('podR', 5.7, 35, 49, 5.4, 1, 2, { detach: { hull: 0.1 } }),
    part('dish', circle(0, -42.5, 11, 28, 6.6), 'hull2', 3, {
      lift: 1.6,
      facets: [{ pts: circle(0, -42.5, 11, 28, 6.6).filter(([, y]) => y <= -42.5), slope: [0, 0.4] }],
      details: [{ k: 'shape', pts: circle(0, -42, 8.4, 24, 4.6), tone: 'metal' }, { k: 'shape', pts: circle(0, -41.5, 5, 18, 2.6), tone: 'dark' }],
    }),
    part('spike', [[0, -49.6], [1.2, -44], [0, -40.4], [-1.2, -44]], 'glow', 3.4, { glow: true, details: [lamps([[0, -44.5]], 1.1)] }),
    seat('barbette', c, 0, 7.4, 2.4, true, DROID_SEAT),
    seat('seat', c, 1, 4.4, 2.4, false, DROID_SEAT),
    seat('seatAft', c, 2, 3.6, 2.4, false, DROID_SEAT),
    mast('mast', [3.4, -5], [9.4, -9], 1, 3.6, { detach: { hull: 0.5 } }),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Bulwark frigate at 1.4×: the line frigate. A long blue-grey spine with the heavy armoured bulb at
 * the front, its twin cannons on barbettes either side of its crown, the shield generator on the
 * spine behind it, a tall sail aft, the flak on its sponsons, a boxy engine block of three. A mast
 * and a dish bolted on one side of the bulb only.
 */
export const frigate: ModelDef = (c): ModelSpec => {
  const parts: Part[] = [
    ...sym(part('spine', halfHull([[-18, 7.4], [-4, 7], [10, 7.6], [24, 8.6], [34, 10]]), 'hull2', 1, {
      slope: [-0.5, 0],
      details: [rivets([-6.4, -2], [-7.6, 30], 5), { k: 'line', pts: [[0, 6], [-7.6, 6]] }, { k: 'shape', pts: rect(-5, 8, 1.8, 18), tone: 'accent' }],
    })),
    ...sym(part('sponson', chamfer(-10.6, 17.3, 9.6, 11, 2.4), 'metal', 1.4, { lift: 1.2, details: [{ k: 'shape', pts: rect(-15.4, 21.4, 9.6, 1.4), tone: 'accent' }] })),
    ...sym(part('fin', [[-10, 26], [-18.6, 30], [-19.4, 36], [-10.6, 34]], 'hull', 1.2, { slope: [-0.4, 0.1], detach: { hull: 0.3 }, details: [{ k: 'shape', pts: [[-12, 27.5], [-18, 30.4], [-18.4, 32.4], [-12.2, 30]], tone: 'accent' }] }), { slope: [0.4, 0.1], detach: { hull: 0.2 } }),
    engineBlock('block', 0, 34, 41, 24, undefined, 1.5),
    engineBlock('pod0', -9.1, 37, 49.4, 7.2, 0, 2, { detach: { hull: 0.16 } }),
    engineBlock('pod1', -0.2, 37, 50, 7.4, 1, 2),
    engineBlock('pod2', 8.4, 37, 49.4, 7.2, 2, 2, { detach: { hull: 0.1 } }),
    sail('sail', 0, -2, 30, 2.6, 3, 7, { detach: { hull: 0.28 } }),
    // The forward bulb: a heavy armoured ball with a rust band at its waist and one seam round it.
    part('bulb', circle(0, -31.5, 18.6, 40), 'hull', 2, {
      sphere: true,
      lift: 2,
      details: [{ k: 'shape', pts: rect(-18.6, -22.4, 37.2, 2.4), tone: 'accent' }, { k: 'line', pts: [...circle(0, -31.5, 14.4, 32), circle(0, -31.5, 14.4, 32)[0]] }, eyes([[-3.4, -48.4], [3.4, -48.4]], 0.9)],
    }),
    ...sym(seat('barbette', c, 0, 3.7, 2.4, true, DROID_SEAT)),
    seat('seat', c, 2, 4, 1.6, false, DROID_SEAT),
    ...sym(seat('seatAft', c, 3, 3.1, 1.6, false, DROID_SEAT)),
    mast('mast', [-12, -41], [-17.4, -47.4], 1.4, 3, { detach: { hull: 0.5 } }),
    dish('dish', 14, -20, 3.2, 3, { detach: { hull: 0.38 } }),
  ]
  return { parts, breakStyle: 'bands', mount: (i) => ({ detach: i >= 3 }) }
}

/**
 * Anvil cruiser at 1.7×: a tall narrow warship with a towering sail down its spine and, either side,
 * a long swept gun gallery: one recessed gun trench along its trailing edge instead of rows of
 * ports, and on it from the root out its light gun, its shield generator and its heavy cannon, well
 * apart; a fin standing at each tip. The bridge rises aft between two engine blocks, which are shot
 * off with their hardpoints.
 */
export const cruiser: ModelDef = (c): ModelSpec => {
  const H = c.h / 2
  const gallery: Pt[] = [[-6, -17], [-20, -12.6], [-31, -6.6], [-39, -1], [-47.6, 6.4], [-47.6, 15.6], [-40.6, 14], [-30, 6], [-18, 2.4], [-6, 2.6]]
  const parts: Part[] = [
    ...sym(part('gallery', gallery, 'hull', 1, {
      slope: [-0.25, -0.35],
      lift: 1.6,
      details: [
        { k: 'shape', pts: [[-8, -15], [-20, -11], [-31, -5], [-39, 0.5], [-45, 6.4], [-44.6, 8.6], [-38, 3], [-30, -2.2], [-19.6, -8], [-8, -12]], tone: 'accent' },
        // The gun trench along the trailing edge, a few lamps in it.
        { k: 'shape', pts: [[-9, 0.4], [-18, 0.2], [-30, 3.6], [-35, 7], [-36, 9], [-29.6, 5.8], [-18, 2], [-9, 2]], tone: 'dark' },
        { k: 'lights', pts: [[-13, 1.2], [-22, 1.8], [-32, 6]], r: 0.4 },
        rivets([-10, -14], [-42, 2.4], 5),
      ],
    }), { slope: [0.25, -0.35] }),
    ...sym(sail('tipFin', -46, 3, 19, 1.6, 2, 5, { detach: { hull: 0.3 } }), { detach: { hull: 0.2 } }),
    engineBlock('podL', -5.3, 18, H - 0.2, 7, 0, 1.6, { detach: { hp: 6 } }),
    engineBlock('podR', 5.2, 18, H - 0.2, 7, 1, 1.6, { detach: { hp: 7 } }),
    ...sym(part('spine', halfHull([[-H, 1], [-28, 3.8], [-18, 6], [0, 6.6], [16, 6.4], [24, 4.6]]), 'hull2', 2, {
      slope: [-0.5, 0],
      details: [{ k: 'shape', pts: [[-1.6, -28], [-3, -28], [-4, -12], [-1.6, -12]], tone: 'accent' }, { k: 'line', pts: [[0, 2], [-6.6, 2]] }, rivets([-5.2, -20], [-5.6, 18], 4)],
    })),
    sail('sail', 0, -26, 14, 2.4, 3, 7),
    ...sym(seat('barbette', c, 0, 3.4, 1.8, true, DROID_SEAT)),
    ...sym(seat('seat', c, 2, 2.8, 1.8, false, DROID_SEAT)),
    ...sym(seat('seatMid', c, 4, 3.1, 1.8, false, DROID_SEAT)),
    part('bridge', chamfer(0, 15.6, 10, 9, 2.2), 'hull', 3.5, { lift: 2.4, facets: [{ pts: rect(-5, 11, 5, 9), slope: [-0.5, 0] }], details: [eyes(along([-2.4, 12.4], [2.4, 12.4], 3), 0.6), { k: 'shape', pts: rect(-5, 17, 10, 1.4), tone: 'accent' }] }),
    mast('mast', [2, 12], [6, 5], 1, 4, { detach: { hull: 0.5 } }),
    dish('dish', -12, -11, 2.4, 2.2, { detach: { hull: 0.4 } }),
  ]
  // The two lighter guns on the galleries are flak-sized: they blow off like flak.
  return { parts, breakStyle: 'bands', mount: (i) => ({ detach: i === 2 || i === 3 }) }
}

/** The flagship at 2.5×, in both designs (the battle's ring, and the Codex's carrier). */
export const capital: ModelDef = (c) => (c.style === 'carrier' ? carrierDesign(c) : ringDesign(c))

/**
 * Gyre battleship, ring design: a great ring hull open at the front, broad plain segments with two
 * hangar slots each on its inner face and one rust band, the flak and the hangars round it and two
 * heavy guns out on its flanks; in its middle the core sphere with the other two heavy guns and the
 * shield generators on its crown, joined to the ring by spokes; four engine blocks at the back. When
 * it dies the core comes away whole and the ring breaks into segments.
 */
function ringDesign(c: BuildCtx): ModelSpec {
  const cx = 0
  const cy = -2
  const [rxo, ryo, rxi, ryi] = [36.4, 45.4, 19, 25]
  const D = Math.PI / 180
  const gap = 11 * D
  const top = -90 * D
  const span = (Math.PI * 2 - gap * 2) / 6
  const parts: Part[] = []
  for (let i = 0; i < 6; i++) {
    const a0 = top + gap + span * i
    const a1 = a0 + span
    const mid = (a0 + a1) / 2
    const slots: Detail[] = [0.3, 0.7].map((t) => {
      const a = a0 + span * t
      const x = cx + Math.cos(a) * (rxi + 2.4)
      const y = cy + Math.sin(a) * (ryi + 2.4)
      return { k: 'shape', pts: turn(box(x, y, 5, 2), a + Math.PI / 2, x, y), tone: 'dark' }
    })
    parts.push(part(`ring${i}`, ellBand(cx, cy, rxo, ryo, rxi, ryi, a0, a1, 10), i % 2 ? 'hull' : 'hull2', 1, {
      lift: 2.4,
      slope: [Math.cos(mid) * 0.42, Math.sin(mid) * 0.42],
      details: [
        ...slots,
        { k: 'lights', pts: [0.3, 0.7].map((t) => { const a = a0 + span * t; return [cx + Math.cos(a) * (rxi + 2.4), cy + Math.sin(a) * (ryi + 2.4)] as Pt }), r: 0.5 },
        { k: 'shape', pts: ellBand(cx, cy, rxo - 2, ryo - 2, rxo - 3.8, ryo - 3.8, a0 + span * 0.12, a1 - span * 0.12, 8), tone: 'accent' },
        { k: 'line', pts: [[cx + Math.cos(a1) * rxi, cy + Math.sin(a1) * ryi], [cx + Math.cos(a1) * rxo, cy + Math.sin(a1) * ryo]] },
      ],
    }))
  }
  for (const s of [-1, 1]) {
    const a = top - s * gap
    const x = cx + Math.cos(a) * (rxo + rxi) * 0.5
    const y = cy + Math.sin(a) * (ryo + ryi) * 0.5
    parts.push(part(s < 0 ? 'jawL' : 'jawR', turn(chamfer(x, y - 2, 9, 8, 2), s * 0.25, x, y), 'metal', 1.6, { lift: 1.4, detach: { hull: s < 0 ? 0.3 : 0.2 }, details: [eyes([[x + s * 2, y - 4]], 0.6)] }))
  }
  // Seats round the ring: barbettes for the flank guns, pads for the flak and the hangars.
  parts.push(
    ...sym(seat('barbetteRing', c, 2, 3.3, 2.5, true, DROID_SEAT)),
    ...sym(seat('seatFore', c, 4, 2.7, 2.5, false, DROID_SEAT)),
    ...sym(seat('seatFlank', c, 6, 2.7, 2.5, false, DROID_SEAT)),
    ...sym(seat('launchPad', c, 11, 4.6, 2.5, false, DROID_SEAT)),
  )
  parts.push(
    part('spokeL', rect(-21, 2, 8, 6), 'metal', 0.8, { details: [{ k: 'line', pts: [[-21, 5], [-13, 5]] }] }),
    part('spokeR', rect(13, 2, 8, 6), 'metal', 0.8, { details: [{ k: 'line', pts: [[13, 5], [21, 5]] }] }),
    part('spokeB', rect(-4, 18, 8, 7), 'metal', 0.8),
    engineBlock('block', 0, 38, 45, 30, undefined, 1.2),
    engineBlock('pod0', -9.9, 39, 49, 5.6, 0, 1.4, { detach: { hull: 0.16 } }),
    engineBlock('pod1', -3.6, 40, 50, 5.6, 1, 1.4),
    engineBlock('pod2', 3.2, 40, 50, 5.6, 2, 1.4),
    engineBlock('pod3', 9.7, 39, 49, 5.6, 3, 1.4, { detach: { hull: 0.1 } }),
    // The core sphere: a rust equator, one seam, a few red eyes round its crown.
    part('core', circle(0, 5, 14.6, 40), 'hull', 2, {
      sphere: true,
      details: [{ k: 'shape', pts: rect(-14.6, 13.6, 29.2, 2), tone: 'accent' }, { k: 'line', pts: [...circle(0, 5, 11.6, 32), circle(0, 5, 11.6, 32)[0]] }, eyes(along([-3.4, -8.4], [3.4, -8.4], 3), 0.6)],
    }),
    ...sym(seat('barbette', c, 0, 3.3, 2.6, true, DROID_SEAT)),
    ...sym(seat('seat', c, 8, 3.5, 2.6, false, DROID_SEAT)),
    mast('mastC', [0, -9], [0, -16], 0.9, 2.8, { detach: { hull: 0.55 } }),
    mast('mastL', [-33, 18], [-37.4, 12], 1.2, 2.8, { detach: { hull: 0.45 } }),
    dish('dish', 30, 24, 2.8, 2.8, { detach: { hull: 0.38 } }),
  )
  return { parts, breakStyle: 'ring', core: { x: 0, y: 5, r: 16.5 } }
}

/**
 * Gyre battleship, carrier design: a broad carrier hull with one row of hangar slots down each flank
 * aft, a raised deck carrying the heavy guns and shield generators, the flank guns, flak and hangars
 * on the hull round it, a bulbous forward pod and a tall sail with the bridge on it.
 */
function carrierDesign(c: BuildCtx): ModelSpec {
  const rows: [number, number][] = [[-50, 3], [-46, 9], [-40, 16.6], [-30, 23.6], [-18, 29.6], [-6, 32.4], [10, 32.4], [26, 30.6], [38, 27], [44, 20]]
  const slots = (x0: number, x1: number, y0: number, y1: number, n: number): Detail[] =>
    along([0, y0], [0, y1], n).flatMap(([, y]) => [{ k: 'shape' as const, pts: rect(x0, y - 1.2, x1 - x0, 2.4), tone: 'dark' as const }, { k: 'lights' as const, pts: [[(x0 + x1) / 2, y] as Pt], r: 0.45 }])
  const parts: Part[] = [
    ...sym(part('hull', halfHull(rows), 'hull', 0, {
      slope: [-0.5, 0.05],
      details: [
        { k: 'shape', pts: [...rows.slice(2, 9).map(([y, w]) => [-w, y] as Pt), ...rows.slice(2, 9).map(([y, w]) => [-w + 2.4, y + 0.4] as Pt).reverse()], tone: 'accent' },
        ...slots(-28, -20, 16, 32, 4),
        rivets([-14, -30], [-26, -8], 4),
      ],
    })),
    ...sym(part('deck', halfHull([[-30, 4], [-20, 9], [0, 11.6], [22, 11], [32, 8]]), 'hull2', 1, { slope: [-0.45, 0], lift: 2, details: [{ k: 'line', pts: [[0, 20], [-11, 20]] }] })),
    ...sym(part('fin', [[-27, 34], [-35.4, 36], [-35.6, 44], [-25, 42]], 'hull2', 0.8, { slope: [-0.4, 0.1], detach: { hull: 0.3 } }), { slope: [0.4, 0.1], detach: { hull: 0.2 } }),
    engineBlock('block', 0, 37, 45, 30, undefined, 1.2),
    engineBlock('pod0', -9.9, 38, 49, 5.6, 0, 1.4, { detach: { hull: 0.16 } }),
    engineBlock('pod1', -3.6, 39, 50, 5.6, 1, 1.4),
    engineBlock('pod2', 3.2, 39, 50, 5.6, 2, 1.4),
    engineBlock('pod3', 9.7, 38, 49, 5.6, 3, 1.4, { detach: { hull: 0.1 } }),
    part('pod', circle(0, -41.6, 8.4, 24), 'hull2', 2, { sphere: true, details: [{ k: 'shape', pts: rect(-8.4, -40, 16.8, 1.8), tone: 'accent' }, eyes(along([-3, -47], [3, -47], 3), 0.6)] }),
    ...sym(seat('barbette', c, 0, 3.3, 2.2, true, DROID_SEAT)),
    ...sym(seat('barbetteFlank', c, 2, 3.3, 1.2, true, DROID_SEAT)),
    ...sym(seat('seat', c, 8, 3.5, 2.2, false, DROID_SEAT)),
    ...sym(seat('seatFore', c, 4, 2.7, 1.2, false, DROID_SEAT)),
    ...sym(seat('seatFlank', c, 6, 2.7, 1.2, false, DROID_SEAT)),
    ...sym(seat('launchPad', c, 11, 4.6, 1.2, false, DROID_SEAT)),
    sail('sail', 0, 12, 34, 2.6, 3, 7, { detach: { hull: 0.3 } }),
    part('bridge', chamfer(0, 30, 9, 8, 2), 'hull', 3.5, { lift: 2.4, details: [eyes(along([-2.6, 27.6], [2.6, 27.6], 3), 0.6)] }),
    mast('mast', [-4, 26], [-9, 19], 1, 3.6, { detach: { hull: 0.5 } }),
    dish('dish', 22, -30, 3, 2, { detach: { hull: 0.38 } }),
  ]
  return { parts, breakStyle: 'bands', cuts: 3 }
}
