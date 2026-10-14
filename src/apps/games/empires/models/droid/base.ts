import { CYARD_SOCKETS, YARD_SOCKETS, type ModuleId } from '../../data.ts'
import { at, type Expansion } from '../expansions.ts'
import { along, box, chamfer, circle, part, rect, sym, thick } from '../kit.ts'
import { seat } from '../proto.ts'
import type { ModelDef } from '../spec.ts'
import type { Detail, Part, Pt, Tone } from '../types.ts'
import { dish, engineBlock, eyes, lamps, mast, rivets } from './craft.ts'
import { DROID_SEAT } from './warships.ts'

// The droid navy's hybrid bases: its constructor droids, the Frigate Yard and the Capital Yard, and
// the expansion modules that bolt onto them and the Command Station (`expansion`, placed by
// models/expansions.ts).
//
// The yards are drawn in the calm style of the Big warships (warships.ts): a few big plates, one seat
// per gun, lights placed sparingly. Each reads as a shipyard from above: an open berth a ship of its
// class fits in, spanned by arched ring frames with round hubs, a gate at the mouth where the ships
// leave (the bow, up), a foundry closing the stern. The droid foundries are tan plate over gunmetal
// trusses, a foundry sphere at the stern as on the Crucible station. Empty module sockets show as
// ringed ports.

/** An empty module port: a ringed plate with a dark well and four lights round it, in the
 * faction's trim, so it reads as a socket waiting for something. */
function port(id: string, [x, y]: Pt, r: number, z: number): Part {
  return part(id, circle(x, y, r, 20), 'metal', z, {
    lift: 1.2,
    details: [
      { k: 'shape', pts: circle(x, y, r * 0.8, 18), tone: 'trim' },
      { k: 'shape', pts: circle(x, y, r * 0.6, 16), tone: 'dark' },
      { k: 'line', pts: circle(x, y, r * 0.38, 12) },
      { k: 'lights', pts: [[x, y - r * 0.7], [x + r * 0.7, y], [x, y + r * 0.7], [x - r * 0.7, y]], r: r * 0.09, tone: 'glow' },
    ],
  })
}

// --- Engineers ---------------------------------------------------------------------------------------

/**
 * Rivet constructor droid: a spindly droid builder. A ball body with one wide amber eye, two long
 * cutting arms reaching forward with a saw disc each, two folded rear legs, rust hazard bands and an
 * engine block behind.
 */
export const droidEngineer: ModelDef = () => {
  const saw = (x: number, y: number): Detail[] => [
    { k: 'shape', pts: circle(x, y, 3.2, 12), tone: 'metal' },
    { k: 'lights', pts: circle(x, y, 3.6, 8), r: 0.5, tone: 'ember' },
  ]
  const parts: Part[] = [
    ...sym(part('leg', thick([[-8, 10], [-26, 20], [-36, 38]], 4.2, 2.6), 'metal', 1, { lift: 0.8, details: [rivets([-10, 11], [-26, 20], 4), { k: 'shape', pts: circle(-26, 20, 2.1, 10), tone: 'dark' }] })),
    ...sym(part('arm', thick([[-8, -8], [-26, -20], [-20, -42]], 4.6, 3), 'hull2', 1.4, {
      lift: 0.9,
      detach: { hull: 0.3 },
      details: [{ k: 'shape', pts: thick([[-10, -9], [-22, -17]], 1.4), tone: 'accent' }, { k: 'shape', pts: circle(-26, -20, 2.4, 10), tone: 'dark' }],
    }), { detach: { hull: 0.2 } }),
    ...sym(part('saw', circle(-20, -44, 4.6, 16), 'dark', 1.6, { detach: { hull: 0.3 }, details: saw(-20, -44) }), { detach: { hull: 0.2 } }),
    engineBlock('engine', 0, 26, 45, 14, 0, 1.6),
    part('collar', chamfer(0, 14, 20, 16, 4), 'hull', 1.8, { lift: 1, details: [...[-8, -2, 4].map((x): Detail => ({ k: 'shape', pts: [[x, 7], [x + 3, 7], [x + 6, 21], [x + 3, 21]], tone: 'accent' })), rivets([-8, 19], [8, 19], 5)] }),
    part('ball', circle(0, -4, 15, 24), 'hull', 2.2, { sphere: true, details: [{ k: 'shape', pts: box(0, -4, 30, 3), tone: 'accent' }, rivets([-11, 4], [11, 4], 6)] }),
    part('visor', box(0, -9, 18, 6), 'dark', 2.6, { details: [eyes(along([-5.5, -9], [5.5, -9], 3), 1.3), lamps([[0, -9]], 1.8)] }),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Yard parts --------------------------------------------------------------------------------------

/**
 * A berth: the dark bed a ship is built in, `hw` half-wide from y0 (the mouth) to y1, a channel of
 * molten metal down the keel and rivets down the edges.
 */
function berth(id: string, hw: number, y0: number, y1: number, z: number): Part {
  const n = Math.max(4, Math.round((y1 - y0) / 11))
  const edge = hw - 1.6
  return part(id, rect(-hw, y0, hw * 2, y1 - y0), 'dark', z, {
    details: [
      { k: 'shape', pts: rect(-2.6, y0 + 3, 5.2, y1 - y0 - 6), tone: 'char' },
      { k: 'lights', pts: along([0, y0 + 5], [0, y1 - 5], n + 1), r: 0.9, tone: 'ember' },
      rivets([-edge, y0 + 3], [-edge, y1 - 3], n + 2),
      rivets([edge, y0 + 3], [edge, y1 - 3], n + 2),
    ],
  })
}

/**
 * A droid ring frame: an arched hoop spanning a berth at `y`, `wd` wide, out to x1, seen from above
 * as a band whose two ends slope away (lit on one side, in shadow on the other as the yard turns),
 * riveted. A heavy one carries the yard's construction crane (its hardpoint) and a rust band, and
 * has a round hub where each end meets the wall.
 */
function hoop(id: string, y: number, wd: number, x1: number, z: number, heavy: boolean, hub = 4.6): Part[] {
  const t = y - wd / 2
  const k = x1 * 0.42
  const out: Part[] = [
    part(id, rect(-x1, t, x1 * 2, wd), heavy ? 'hull' : 'hull2', z, {
      lift: heavy ? 3.6 : 3,
      facets: [{ pts: rect(-x1, t, x1 - k, wd), slope: [-0.5, 0] }, { pts: rect(k, t, x1 - k, wd), slope: [0.5, 0] }],
      details: [rivets([-x1 + 2, y], [x1 - 2, y], heavy ? 13 : 9), ...(heavy ? [{ k: 'shape' as const, pts: rect(-x1, t + 0.8, x1 * 2, 1.4), tone: 'accent' as const }] : [])],
    }),
  ]
  for (const s of heavy ? [-1, 1] : []) {
    const c: Pt = [s * (x1 - hub * 0.4), y]
    out.push(part(`${id}${s < 0 ? 'L' : 'R'}`, circle(c[0], c[1], hub, 18), 'hull2', z + 0.1, {
      lift: 3.4,
      facets: [{ pts: circle(c[0], c[1], hub, 18).filter(([x]) => x <= c[0]), slope: [-0.4, 0] }],
      details: [{ k: 'shape', pts: circle(c[0], c[1], hub * 0.8, 16), tone: 'accent' }, { k: 'shape', pts: circle(c[0], c[1], hub * 0.62, 14), tone: 'hull2' }, eyes([c], hub * 0.13)],
    }))
  }
  return out
}

/** A droid gun pod: a round sand-and-rust pod with a riveted rim, as on the Crucible station. */
function gunPod(id: string, [x, y]: Pt, r: number, z: number): Part {
  return part(id, circle(x, y, r, 22), 'hull2', z, {
    lift: 3.2,
    facets: [{ pts: circle(x, y, r, 22).filter(([px]) => px <= x), slope: [-0.4, 0] }],
    details: [{ k: 'shape', pts: circle(x, y, r * 0.86, 20), tone: 'accent' }, { k: 'shape', pts: circle(x, y, r * 0.74, 18), tone: 'hull2' }, rivets([x - r * 0.55, y + r * 0.6], [x + r * 0.55, y + r * 0.6], 4)],
  })
}

/** A droid truss: an open gunmetal girder from y0 to y1 between x0 and x1, its bays cut out with a
 * diagonal across each, rivets down one edge. */
function truss(id: string, x0: number, x1: number, y0: number, y1: number, z: number): Part {
  const n = Math.max(2, Math.round((y1 - y0) / 11))
  const step = (y1 - y0) / n
  const holes: Pt[][] = []
  const details: Detail[] = [rivets([x0 + 0.9, y0 + 2], [x0 + 0.9, y1 - 2], n * 2)]
  for (let i = 0; i < n; i++) {
    const a = y0 + i * step + 1.4
    const b = y0 + (i + 1) * step - 1.4
    holes.push(rect(x0 + 1.4, a, x1 - x0 - 2.8, b - a))
    details.push({ k: 'line', pts: [[x0 + 1.4, a], [x1 - 1.4, b]] })
  }
  return part(id, rect(x0, y0, x1 - x0, y1 - y0), 'metal', z, { lift: 2.2, holes, details })
}

// --- Frigate Yard ------------------------------------------------------------------------------------

/**
 * Crucible frigate yard: a droid foundry slip. Tan plate walls over open gunmetal trusses line a
 * berth glowing with molten metal down its keel; three arched ring frames span it (the middle one
 * carries the construction crane, the yard's hardpoint), a round hub where each meets the wall.
 * Round gun pods with the point defence stand at the mouth behind gunmetal jaws. At the stern an
 * octagonal foundry deck carries the foundry sphere, its red eyes round its crown and the shield
 * generator on top, the droid control tower beside it and a furnace stack on the other side. The
 * flank sockets sit on the walls, the third on the deck's back.
 */
export const droidYard: ModelDef = (c) => {
  const [sL, , sS] = YARD_SOCKETS.droid.map((g) => at(g, c.w, c.h))
  const parts: Part[] = [
    berth('bed', 21, -46, 27, 0.4),
    ...sym(part('wall', [[-31.5, -36], [-27, -44], [-21, -44], [-21, 27], [-31.5, 27]], 'hull', 1.2, {
      lift: 3,
      facets: [{ pts: [[-31.5, -36], [-27, -44], [-26, -44], [-26, 27], [-31.5, 27]], slope: [-0.5, 0] }],
      details: [
        { k: 'shape', pts: rect(-31.5, -16, 10.5, 2.4), tone: 'accent' },
        { k: 'shape', pts: rect(-31.5, 20.5, 10.5, 2.4), tone: 'accent' },
        rivets([-29.6, -30], [-29.6, 2], 5),
      ],
    })),
    ...sym(truss('truss', -21, -16, -44, 27, 1)),
    // The mouth: gunmetal jaws, the point defence on round pods behind them.
    ...sym(part('jaw', [[-30.5, -38], [-27.5, -46.5], [-21.5, -50.5], [-16.5, -49], [-19, -44.5], [-24, -41.5]], 'metal', 2, { lift: 2.4, details: [eyes([[-21.5, -48.4]], 0.7)] })),
    ...sym(gunPod('pod', at([1.7, 1.6], c.w, c.h), 5.6, 3)),
    ...sym(seat('pd', c, 2, 3.5, 3.3, false, DROID_SEAT)),
    // Ring frames across the berth.
    ...hoop('hoopF', -25, 4.6, 30, 3.4, false),
    ...hoop('hoopM', -2, 7.4, 30.6, 3.5, true, 5),
    ...hoop('hoopA', 22, 4.6, 30, 3.4, false),
    // The foundry deck at the stern, the foundry sphere on it, the tower and the furnace stack.
    part('deck', chamfer(0, 37.5, 63, 21, 7), 'hull2', 2, {
      lift: 3,
      facets: [{ pts: [[-31.5, 34], [-24.5, 27], [24.5, 27], [31.5, 34]], slope: [0, -0.45] }],
      details: [{ k: 'shape', pts: rect(-31.5, 42.4, 63, 2), tone: 'accent' }, rivets([-27, 39.4], [-12, 39.4], 4), rivets([12, 39.4], [27, 39.4], 4)],
    }),
    part('sphere', circle(0, 34.4, 9.6, 32), 'hull', 3, {
      sphere: true,
      details: [{ k: 'shape', pts: rect(-9.6, 37.6, 19.2, 1.8), tone: 'accent' }, { k: 'line', pts: [...circle(0, 34.4, 7.4, 24), circle(0, 34.4, 7.4, 24)[0]] }, eyes(along([-5.2, 27.4], [5.2, 27.4], 4), 0.7)],
    }),
    part('tower', chamfer(-21, 38, 8.4, 11, 2.2), 'metal', 3.2, { lift: 4, details: [{ k: 'shape', pts: rect(-25.2, 40.6, 8.4, 1.4), tone: 'accent' }, rivets([-23.6, 42.4], [-18.4, 42.4], 3)] }),
    part('head', circle(-21, 35, 3.6, 16), 'hull', 3.6, { sphere: true, details: [{ k: 'shape', pts: rect(-24, 33, 6, 1.6), tone: 'dark' }, eyes(along([-22.6, 33.8], [-19.4, 33.8], 3), 0.5)] }),
    part('stack', circle(21, 36.5, 4.4, 16), 'metal', 3.2, { lift: 3.4, details: [{ k: 'shape', pts: circle(21, 36.5, 3, 14), tone: 'dark' }, lamps(circle(21, 36.5, 1.6, 4), 0.55), { k: 'lights', pts: [[21, 36.5]], r: 0.9, tone: 'ember' }] }),
    port('portL', sL, 5.2, 3.6),
    port('portR', [-sL[0], sL[1]], 5.2, 3.6),
    port('portS', sS, 4.6, 3.8),
    mast('mast', [-24, 41], [-27.4, 46.6], 1.4, 4, { detach: { hull: 0.5 } }),
    dish('dish', 25.6, 43, 3, 4, { detach: { hull: 0.4 } }),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Capital Yard ------------------------------------------------------------------------------------

/**
 * Leviathan capital foundry: the droid navy's great dock. Massive tan walls over gunmetal trusses
 * line a long berth glowing with molten metal, spanned by four arched ring frames (the second is
 * the heavy one with the construction crane, the yard's hardpoint). Big round gun towers with the
 * cannons stand at the mouth behind gunmetal jaws; at the stern the foundry deck carries a bigger
 * foundry sphere under the shield generator, point defence pods on its corners, a sensor spire and
 * a dish. The flank sockets sit in the walls.
 */
export const droidCapitalYard: ModelDef = (c) => {
  const [sL] = CYARD_SOCKETS.droid.map((g) => at(g, c.w, c.h))
  const parts: Part[] = [
    berth('bed', 23, -47, 33, 0.4),
    ...sym(part('wall', [[-36, -35], [-31, -43], [-23, -43], [-23, 33], [-36, 33]], 'hull', 1.2, {
      lift: 3.4,
      facets: [{ pts: [[-36, -35], [-31, -43], [-30, -43], [-30, 33], [-36, 33]], slope: [-0.5, 0] }],
      details: [
        { k: 'shape', pts: rect(-36, -17, 13, 2.6), tone: 'accent' },
        { k: 'shape', pts: rect(-36, 24.4, 13, 2.6), tone: 'accent' },
        rivets([-33.4, -30], [-33.4, -6], 4),
        rivets([-33.4, 14], [-33.4, 30], 3),
      ],
    })),
    ...sym(truss('truss', -23, -18, -43, 33, 1)),
    ...sym(part('jaw', [[-35, -38], [-31.5, -47.5], [-24, -51.5], [-18, -50], [-21, -45], [-27, -42]], 'metal', 2, { lift: 2.6, details: [eyes([[-24, -49.4]], 0.8)] })),
    ...sym(gunPod('tower', at([1.75, 1.35], c.w, c.h), 7, 3)),
    ...sym(seat('tl', c, 2, 4.4, 3.3, true, DROID_SEAT)),
    ...hoop('hoopF', -24, 4.8, 34, 3.4, false, 5),
    ...hoop('hoopM', -6, 8, 34.6, 3.5, true, 5.4),
    ...hoop('hoopA', 15, 4.8, 34, 3.4, false, 5),
    ...hoop('hoopS', 28.4, 4.4, 34, 3.4, false, 4.6),
    part('deck', chamfer(0, 41, 72, 17, 6), 'hull2', 2, {
      lift: 3,
      facets: [{ pts: [[-36, 38.5], [-30, 32.5], [30, 32.5], [36, 38.5]], slope: [0, -0.45] }],
      details: [{ k: 'shape', pts: rect(-36, 46, 72, 1.8), tone: 'accent' }, rivets([-33, 43.6], [-28, 43.6], 3), rivets([28, 43.6], [33, 43.6], 3)],
    }),
    part('sphere', circle(0, 38.6, 10.4, 34), 'hull', 3, {
      sphere: true,
      details: [{ k: 'shape', pts: rect(-10.4, 41.8, 20.8, 2), tone: 'accent' }, { k: 'line', pts: [...circle(0, 38.6, 8, 26), circle(0, 38.6, 8, 26)[0]] }, eyes(along([-6, 31], [6, 31], 5), 0.75)],
    }),
    ...sym(gunPod('pdPod', at([1.9, 9.1], c.w, c.h), 4, 3.1)),
    ...sym(seat('pd', c, 4, 3, 3.3, false, DROID_SEAT)),
    mast('spire', [-14, 39], [-16.6, 47.6], 1.8, 4, { detach: { hull: 0.5 } }),
    dish('dish', 14.6, 43, 3.2, 4, { detach: { hull: 0.4 } }),
    part('prong', thick([[0, -45], [0, -50.5]], 2.2, 1), 'metal', 4.2, { detach: { hull: 0.6 }, details: [eyes([[0, -49.4]], 0.7)] }),
    port('portL', sL, 5.6, 3.9),
    port('portR', [-sL[0], sL[1]], 5.6, 3.9),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Expansion modules -------------------------------------------------------------------------------

/** The girder back to the hull's details: rivets down it. */
const strut = (R: number, reach: number): Detail[] => [rivets([-R * 0.13, R * 0.4], [-R * 0.13, R * 0.2 + reach * 0.9], Math.max(3, Math.round(reach / (R * 0.35))))]

/** A running light for a module: the droids' red eyes. */
const beacon = (pts: Pt[], r: number, _rep: boolean): Detail => eyes(pts, r)

/**
 * One expansion's own structure, in its local frame: up (-y) is away from the building, +x towards
 * the yard's bow, the socket at the origin; `R` is its size (half its socket's share of the
 * building). Kept within about 1.2 R outward, so it stays inside the building's bitmap.
 */
function modulePod(exp: ModuleId, R: number): Part[] {
  // Droid modules (the code below once drew both sides' and still reads `rep`).
  const rep: boolean = false
  // Sand plate over gunmetal, rust bands, rivets, red eyes.
  const plate: Tone = 'hull'
  const plate2: Tone = 'hull2'
  const frame: Tone = 'metal'
  const band: Tone = 'accent'
  const studs = (a: Pt, b: Pt, n: number): Detail[] => [rivets(a, b, n)]
  switch (exp) {
    case 'secondSlip':
    case 'capitalSlip': {
      // A berth arm along the side: an outer rail and an inner one either side of a dark bed with
      // guide lights, gantries across it, and the mouth at its front end with a gate beam over it.
      const big = exp === 'capitalSlip'
      const x0 = -R * (big ? 2.5 : 1.9)
      const x1 = R * (big ? 4 : 4.2)
      const L = x1 - x0
      const yo = -R * 1.18
      const yi = R * 0.1
      const gantries = (big ? [0.14, 0.38, 0.62, 0.86] : [0.18, 0.5, 0.82]).map((k) => x0 + L * k)
      const n = Math.round(L / (R * 0.9))
      return [
        part('Bed', rect(x0, yo + R * 0.3, L, yi - yo - R * 0.3), 'dark', 1, {
          details: [
            { k: 'shape', pts: rect(x0 + R * 0.4, (yo + yi) / 2 + R * 0.05, L - R * 0.8, R * 0.2), tone: rep ? 'metal' : 'char' },
            rep
              ? { k: 'lights', pts: [...along([x0 + R * 0.4, yo + R * 0.45], [x1 - R * 0.4, yo + R * 0.45], n), ...along([x0 + R * 0.4, yi - R * 0.15], [x1 - R * 0.4, yi - R * 0.15], n)], r: R * 0.06, tone: 'glow' }
              : { k: 'lights', pts: along([x0 + R * 0.5, (yo + yi) / 2 + R * 0.15], [x1 - R * 0.5, (yo + yi) / 2 + R * 0.15], n), r: R * 0.09, tone: 'ember' },
          ],
        }),
        part('Rail', rect(x0, yo, L, R * 0.34), plate, 2, {
          lift: 2.2,
          slope: [0, -0.45],
          details: [{ k: 'shape', pts: rect(x1 - R * 0.75, yo, R * 0.4, R * 0.34), tone: band }, { k: 'shape', pts: rect(x0 + R * 0.3, yo, R * 0.4, R * 0.34), tone: band }, ...studs([x0 + R, yo + R * 0.17], [x1 - R, yo + R * 0.17], n)],
        }),
        part('RailIn', rect(x0, yi - R * 0.12, L, R * 0.3), plate2, 2, { lift: 1.8, details: studs([x0 + R * 0.5, yi + R * 0.03], [x1 - R * 0.5, yi + R * 0.03], n + 1) }),
        ...gantries.map((gx, j) =>
          part(`Gantry${j}`, rect(gx - R * 0.13, yo - R * 0.06, R * 0.26, yi - yo + R * 0.3), frame, 3, {
            lift: 2.8,
            details: [{ k: 'line', pts: [[gx, yo], [gx, yi + R * 0.1]] }, beacon([[gx, yo + R * 0.06]], R * 0.06, rep)],
          }),
        ),
        part('Gate', rect(x1 - R * 0.22, yo - R * 0.04, R * 0.22, yi - yo + R * 0.22), plate2, 3, { lift: 3.2, details: [{ k: 'shape', pts: rect(x1 - R * 0.22, yo - R * 0.04, R * 0.22, R * 0.3), tone: band }, beacon(along([x1 - R * 0.11, yo + R * 0.45], [x1 - R * 0.11, yi - R * 0.15], 3), R * 0.06, rep)] }),
      ]
    }
    case 'drydock': {
      // A repair gantry: a long frame open to the outside round a dark bay, a crossbar along its
      // outer side, and three jointed repair arms hanging from it into the bay, green work lights at
      // their tips and round the bay.
      const A = R * 1.9
      const top = -R * 1.15
      const base = R * 0.35
      // Each arm: a boom from the crossbar, a joint, a forearm reaching in, a tool head at its end.
      const arm = (x: number, j: number): Part[] => {
        const s = j % 2 ? 1 : -1
        const knee: Pt = [x + s * R * 0.42, top + R * 0.62]
        const tip: Pt = [x - s * R * 0.08, -R * 0.12]
        return [
          part(`Arm${j}`, thick([[x, top + R * 0.12], knee, tip], R * 0.18, R * 0.12), plate2, 3, { lift: 1.8, details: [{ k: 'shape', pts: circle(knee[0], knee[1], R * 0.13, 10), tone: 'dark' }] }),
          part(`Tool${j}`, chamfer(tip[0], tip[1], R * 0.3, R * 0.24, R * 0.06), frame, 3.2, { lift: 1.2, details: [{ k: 'lights', pts: [[tip[0], tip[1] + R * 0.02]], r: R * 0.07, tone: 'aid' }] }),
        ]
      }
      return [
        part('Bay', rect(-A + R * 0.3, top + R * 0.15, (A - R * 0.3) * 2, base - top - R * 0.15), 'dark', 1, {
          details: [{ k: 'lights', pts: along([-A + R * 0.55, base - R * 0.2], [A - R * 0.55, base - R * 0.2], 7), r: R * 0.05, tone: 'aid' }],
        }),
        part('Cradle', [[-A, top], [-A + R * 0.32, top], [-A + R * 0.32, base - R * 0.3], [A - R * 0.32, base - R * 0.3], [A - R * 0.32, top], [A, top], [A, base + R * 0.12], [-A, base + R * 0.12]], plate, 2, {
          lift: 2.2,
          details: [{ k: 'shape', pts: rect(-A, base - R * 0.06, A * 2, R * 0.16), tone: band }, ...studs([-A + R * 0.16, top + R * 0.3], [-A + R * 0.16, base - R * 0.1], 4), ...studs([A - R * 0.16, top + R * 0.3], [A - R * 0.16, base - R * 0.1], 4)],
        }),
        part('Crossbar', rect(-A - R * 0.05, top - R * 0.06, (A + R * 0.05) * 2, R * 0.28), frame, 3.4, {
          lift: 3.2,
          details: [{ k: 'line', pts: [[-A, top + R * 0.08], [A, top + R * 0.08]] }, { k: 'lights', pts: [[-A + R * 0.1, top + R * 0.08], [A - R * 0.1, top + R * 0.08]], r: R * 0.07, tone: 'aid' }],
        }),
        ...[-R * 1.1, 0, R * 1.1].flatMap(arm),
      ]
    }
    case 'armourWorks': {
      // A plate works: a heavy foundry block with a press on it (its ram striped in hazard bands), a
      // furnace slot glowing along its outer face, stacks of fresh plate and a vent stack.
      const W = R * 1.3
      const top = -R * 1.1
      const bot = R * 0.55
      const hazard: Detail[] = [0, 1, 2].map((k): Detail => {
        const x = -R * 0.98 + k * R * 0.34
        return { k: 'shape', pts: [[x, -R * 0.78], [x + R * 0.16, -R * 0.78], [x + R * 0.36, -R * 0.12], [x + R * 0.2, -R * 0.12]], tone: band }
      })
      return [
        part('Works', chamfer(0, (top + bot) / 2, W * 2, bot - top, R * 0.24), rep ? plate2 : frame, 1, {
          lift: 2.4,
          facets: [{ pts: [[-W, top + R * 0.24], [-W + R * 0.24, top], [W - R * 0.24, top], [W, top + R * 0.24], [W, top + R * 0.42], [-W, top + R * 0.42]], slope: [0, -0.45] }],
          details: [{ k: 'shape', pts: rect(-W, bot - R * 0.3, W * 2, R * 0.14), tone: band }, ...studs([-W + R * 0.2, bot - R * 0.1], [W - R * 0.2, bot - R * 0.1], 7)],
        }),
        part('Furnace', rect(R * 0.05, top + R * 0.08, W - R * 0.25, R * 0.26), 'dark', 2, { details: [{ k: 'lights', pts: along([R * 0.2, top + R * 0.21], [W - R * 0.35, top + R * 0.21], 4), r: R * 0.07, tone: 'ember' }] }),
        part('Press', chamfer(-R * 0.62, -R * 0.45, R * 1.05, R * 0.95, R * 0.12), plate, 3, { lift: 3, details: [...hazard, { k: 'shape', pts: rect(-R * 0.9, -R * 0.08, R * 0.56, R * 0.12), tone: 'dark' }] }),
        part('Plates', rect(R * 0.15, -R * 0.62, R * 0.95, R * 0.9), plate, 2.4, {
          lift: 1.2,
          details: [0, 1, 2].map((k): Detail => ({ k: 'line', pts: [[R * 0.15, -R * 0.4 + k * R * 0.24], [R * 1.1, -R * 0.4 + k * R * 0.24]] })),
        }),
        part('Vent', circle(R * 0.9, R * 0.28, R * 0.2, 12), 'dark', 2.6, { lift: 2.2, details: [{ k: 'lights', pts: [[R * 0.9, R * 0.28]], r: R * 0.08, tone: 'ember' }] }),
      ]
    }
    case 'strikeHangar': {
      // A hangar block, seen from above: its roof doors slid apart over a dark bay, hazard stripes on
      // their edges, runway lights leading out of the bay to the launch lip, a control blister on top.
      const W = R * 1.25
      const top = -R * 1.2
      const bot = R * 0.5
      return [
        part('Hangar', chamfer(0, (top + bot) / 2, W * 2, bot - top, R * 0.3), plate, 1, {
          lift: 2.6,
          details: [{ k: 'shape', pts: rect(-W, bot - R * 0.32, W * 2, R * 0.14), tone: band }, ...studs([-W + R * 0.2, bot - R * 0.1], [W - R * 0.2, bot - R * 0.1], 7)],
        }),
        part('Bay', rect(-R * 0.48, top + R * 0.02, R * 0.96, R * 1.25), 'dark', 2, {
          details: [{ k: 'lights', pts: [...along([-R * 0.3, top + R * 0.12], [-R * 0.3, top + R * 1.1], 4), ...along([R * 0.3, top + R * 0.12], [R * 0.3, top + R * 1.1], 4)], r: R * 0.05, tone: rep ? 'glow' : 'ember' }],
        }),
        ...[-1, 1].map((s) =>
          part(s < 0 ? 'DoorL' : 'DoorR', rect(s < 0 ? -W + R * 0.18 : R * 0.48, top + R * 0.18, W - R * 0.66, R * 1.05), plate2, 3, {
            lift: 1.8,
            slope: [0, -0.3],
            details: [{ k: 'shape', pts: rect(s < 0 ? -R * 0.66 : R * 0.48, top + R * 0.18, R * 0.18, R * 1.05), tone: band }, { k: 'line', pts: [[s * (W - R * 0.4), top + R * 0.7], [s * R * 0.7, top + R * 0.7]] }],
          }),
        ),
        part('Blister', chamfer(-W + R * 0.45, bot - R * 0.55, R * 0.5, R * 0.36, R * 0.1), plate, 3.4, { lift: 1.4, details: [beacon([[-W + R * 0.45, bot - R * 0.6]], R * 0.06, rep)] }),
      ]
    }
    case 'fighterWing': {
      // A launch rack: a hangar block along the side with three launch rails reaching out from it,
      // a wing fighter waiting on each, runway lights down the rails.
      const W = R * 1.6
      const xs = [-R * 0.95, 0, R * 0.95]
      const fighter = (x: number, j: number): Part =>
        part(`Craft${j}`, [[x, -R * 1.05], [x + R * 0.22, -R * 0.62], [x + R * 0.34, -R * 0.42], [x, -R * 0.5], [x - R * 0.34, -R * 0.42], [x - R * 0.22, -R * 0.62]], rep ? 'hull' : 'hull2', 3, {
          lift: 1,
          details: [{ k: 'shape', pts: [[x, -R * 0.98], [x + R * 0.07, -R * 0.74], [x - R * 0.07, -R * 0.74]], tone: rep ? 'glass' : 'accent' }, { k: 'lights', pts: [[x, -R * 0.52]], r: R * 0.06, tone: 'glow' }],
        })
      return [
        part('Rack', chamfer(0, R * 0.05, W * 2, R * 0.75, R * 0.2), plate, 1, {
          lift: 2.4,
          details: [{ k: 'shape', pts: rect(-W, R * 0.22, W * 2, R * 0.13), tone: band }, ...xs.map((x): Detail => ({ k: 'shape', pts: rect(x - R * 0.3, -R * 0.32, R * 0.6, R * 0.3), tone: 'dark' })), ...studs([-W + R * 0.2, R * 0.3], [W - R * 0.2, R * 0.3], 7)],
        }),
        ...xs.map((x, j) =>
          part(`Rail${j}`, rect(x - R * 0.12, -R * 1.18, R * 0.24, R * 0.9), frame, 2, { lift: 1.6, details: [{ k: 'lights', pts: along([x, -R * 1.12], [x, -R * 0.35], 3), r: R * 0.045, tone: 'glow' }] }),
        ),
        ...xs.map(fighter),
      ]
    }
    case 'sensorArray': {
      // A sensor mast: a deck with a big dish turned outward on it and a tall antenna mast rising
      // past it, two crossbars with lights on it and a beacon at its tip, throwing a long shadow.
      const D = R * 0.85
      return [
        part('Deck', chamfer(0, -R * 0.1, R * 1.5, R * 1.3, R * 0.3), frame, 1, { lift: 1.6, details: [{ k: 'shape', pts: rect(-R * 0.75, R * 0.25, R * 1.5, R * 0.14), tone: band }, ...studs([-R * 0.55, R * 0.42], [R * 0.55, R * 0.42], 4)] }),
        part('Mast', thick([[0, -R * 0.3], [0, -R * 2.1]], R * 0.32, R * 0.18), frame, 2.4, { lift: 6, details: [{ k: 'line', pts: [[0, -R * 0.4], [0, -R * 2]] }, beacon([[0, -R * 2.02]], R * 0.11, rep)] }),
        ...[-1.45, -1.85].map((y, j) => part(`Yard${j}`, box(0, R * y, R * (1.15 - j * 0.35), R * 0.13), 'dark', 2.6, { lift: 6, details: [beacon([[-R * (0.55 - j * 0.17), R * y], [R * (0.55 - j * 0.17), R * y]], R * 0.06, rep)] })),
        part('Dish', circle(0, -R * 0.42, D, 22), plate2, 3, {
          lift: 2.6,
          slope: [0.25, -0.35],
          details: [{ k: 'shape', pts: circle(R * 0.08, -R * 0.5, D * 0.72, 20), tone: frame }, { k: 'line', pts: circle(R * 0.08, -R * 0.5, D * 0.45, 16) }, { k: 'shape', pts: circle(0, -R * 0.42, D * 0.16, 10), tone: 'dark' }, beacon([[0, -R * 0.42]], R * 0.06, rep)],
        }),
      ]
    }
    case 'shieldCore': {
      // A shield generator: a great dome on a ring deck, emitter pylons round it with their tips
      // glowing, a ring of lights round its foot and two conduits running back to the station.
      const cy = -R * 0.4
      return [
        part('Ring', circle(0, cy, R * 1.12, 28), frame, 1, {
          lift: 1.8,
          details: [{ k: 'shape', pts: circle(0, cy, R * 0.98, 26), tone: band }, { k: 'shape', pts: circle(0, cy, R * 0.9, 26), tone: frame }, { k: 'lights', pts: circle(0, cy, R * 1.03, 12), r: R * 0.045, tone: 'glow' }],
        }),
        ...[-1, 1].map((s) => part(s < 0 ? 'ConduitL' : 'ConduitR', rect(s * R * 0.42 - R * 0.11, R * 0.25, R * 0.22, R * 0.6), band, 1.4, { lift: 0.8 })),
        part('Dome', circle(0, cy, R * 0.8, 30), rep ? 'glass' : plate2, 2, {
          sphere: true,
          details: [{ k: 'shape', pts: rect(-R * 0.8, cy + R * 0.06, R * 1.6, R * 0.1), tone: rep ? 'hull' : band }, { k: 'lights', pts: along([-R * 0.5, cy + R * 0.11], [R * 0.5, cy + R * 0.11], 5), r: R * 0.04, tone: 'glow' }],
        }),
        ...[0, 1, 2, 3].map((k) => {
          const a = (k / 4) * Math.PI * 2 + Math.PI / 4
          const [px, py]: Pt = [Math.cos(a) * R * 0.98, cy + Math.sin(a) * R * 0.98]
          return part(`Pylon${k}`, chamfer(px, py, R * 0.3, R * 0.3, R * 0.08), plate, 3, { lift: 2, details: [{ k: 'lights', pts: [[px, py]], r: R * 0.07, tone: 'glow' }] })
        }),
      ]
    }
  }
}

/** Its expansion modules' own structures, for models/expansions.ts. */
export const expansion: Expansion = { pod: modulePod, strut }
