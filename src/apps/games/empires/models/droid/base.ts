import { CYARD_SOCKETS, YARD_SOCKETS, type ModuleId } from '../../data.ts'
import { at, type Expansion } from '../expansions.ts'
import { along, box, chamfer, circle, part, rect, sym, thick } from '../kit.ts'
import { seat } from '../proto.ts'
import type { ModelDef } from '../spec.ts'
import type { Detail, Part, Pt, Tone } from '../types.ts'
import { across, ambers, antenna, armour, bridge, cells, mark, recess, seam, windows } from './parts.ts'
import { CONFED_SEAT } from './warships.ts'

// The Confederacy's hybrid bases: the Forge Shipyard and the Dominion Shipworks, and the expansion
// modules that bolt onto them and the Command Hub (`expansion`, placed by models/expansions.ts).
//
// The yards are armed private dockyards (refs/confederacy.webp, "Dock arm"): an open berth a ship of
// its class fits in, walled by angular armour blocks over open charcoal trusses, spanned by box
// gantry frames with orange work lights (the heavy one carries the construction crane, the yard's
// hardpoint), angular jaws with gun blocks at the mouth where the ships leave (the bow, up), and a
// production block closing the stern with the yard's bridge core on it. Empty module sockets show
// as ringed ports.

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

// --- Yard parts --------------------------------------------------------------------------------------

/** A berth: the dark bed a ship is built in, `hw` half-wide from y0 (the mouth) to y1, with orange
 * guide lights down its keel and seams down its edges. */
function berth(id: string, hw: number, y0: number, y1: number, z: number): Part {
  const n = Math.max(4, Math.round((y1 - y0) / 11))
  const edge = hw - 1.6
  return part(id, rect(-hw, y0, hw * 2, y1 - y0), 'dark', z, {
    details: [
      { k: 'shape', pts: rect(-2.4, y0 + 3, 4.8, y1 - y0 - 6), tone: 'metal' },
      ambers(along([0, y0 + 5], [0, y1 - 5], n + 1), 0.8),
      seam([-edge, y0 + 3], [-edge, y1 - 3]),
      seam([edge, y0 + 3], [edge, y1 - 3]),
    ],
  })
}

/**
 * A gantry frame spanning a berth at `y`, `wd` deep, out to x1 either side: a box girder seen from
 * above, lit as two faces, with orange work lights along it. A heavy one carries the yard's
 * construction crane (its hardpoint), an orange band and an armoured block at each end.
 */
function gantry(id: string, y: number, wd: number, x1: number, z: number, heavy: boolean): Part[] {
  const t = y - wd / 2
  const k = x1 * 0.42
  const out: Part[] = [
    part(id, rect(-x1, t, x1 * 2, wd), heavy ? 'hull' : 'hull2', z, {
      lift: heavy ? 3.6 : 3,
      facets: [{ pts: rect(-x1, t, x1 - k, wd), slope: [-0.5, 0] }, { pts: rect(k, t, x1 - k, wd), slope: [0.5, 0] }],
      details: [ambers(along([-x1 + 3, y], [x1 - 3, y], heavy ? 7 : 5), 0.55), ...(heavy ? [mark(rect(-x1, t + 0.8, x1 * 2, 1.2))] : [seam([-x1, y], [x1, y])])],
    }),
  ]
  if (heavy) out.push(...sym(armour(`${id}End`, -(x1 - 2.6), y, 6.4, wd + 3.6, z + 0.1, { tone: 'hull2', band: false, lift: 3.4 })))
  return out
}

/** A truss: an open charcoal girder from y0 to y1 between x0 and x1, its bays cut out with a
 * diagonal across each. */
function truss(id: string, x0: number, x1: number, y0: number, y1: number, z: number): Part {
  const n = Math.max(2, Math.round((y1 - y0) / 11))
  const step = (y1 - y0) / n
  const holes: Pt[][] = []
  const details: Detail[] = []
  for (let i = 0; i < n; i++) {
    const a = y0 + i * step + 1.4
    const b = y0 + (i + 1) * step - 1.4
    holes.push(rect(x0 + 1.4, a, x1 - x0 - 2.8, b - a))
    details.push(seam([x0 + 1.4, a], [x1 - 1.4, b]))
  }
  return part(id, rect(x0, y0, x1 - x0, y1 - y0), 'metal', z, { lift: 2.2, holes, details })
}

/** A wall along the left of the berth from y0 to y1, x0 to x1 (x0 the outer edge): an armour block
 * run with its bow corner cut, orange markings at both ends. */
function wall(id: string, x0: number, x1: number, y0: number, y1: number, z: number): Part[] {
  const w = x1 - x0
  return sym(part(id, [[x0, y0 + w * 0.7], [x0 + w * 0.45, y0], [x1, y0], [x1, y1], [x0, y1]], 'hull', z, {
    lift: 3,
    facets: [{ pts: [[x0, y0 + w * 0.7], [x0 + w * 0.45, y0], [x0 + w * 0.5, y0], [x0 + w * 0.5, y1], [x0, y1]], slope: [-0.5, 0] }],
    details: [mark(rect(x0, y0 + (y1 - y0) * 0.3, w, 2.2)), mark(rect(x0, y1 - 6, w, 2.2)), recess(rect(x0 + w * 0.25, y0 + (y1 - y0) * 0.45, w * 0.5, (y1 - y0) * 0.2)), across(x0, x1, (y0 + y1) / 2)],
  }))
}

/** A gun block at the mouth: an angular armour block under a point-defence seat. */
const gunBlock = (id: string, [x, y]: Pt, r: number, z: number): Part => armour(id, x, y, r * 2.1, r * 2.1, z, { tone: 'hull2', band: true, lift: 3.2, cut: r * 0.5 })

// --- Forge Shipyard ----------------------------------------------------------------------------------

/**
 * Forge Shipyard: a private-yard slip. Armour-block walls over open charcoal trusses line a berth
 * lit with orange guide lights down its keel; three gantry frames span it (the middle one heavy,
 * with the construction crane, the yard's hardpoint). Angular jaws at the mouth, gun blocks with the
 * point defence behind them. At the stern a production block with three glowing bays carries the
 * bridge core and the shield generator, a missile-cell rack on one side and a sensor mast on the
 * other. The flank sockets sit on the walls, the third on the block's back.
 */
export const confedYard: ModelDef = (c) => {
  const [sL, , sS] = YARD_SOCKETS.droid.map((g) => at(g, c.w, c.h))
  const parts: Part[] = [
    berth('bed', 21, -46, 27, 0.4),
    ...wall('wall', -31.5, -21, -44, 27, 1.2),
    ...sym(truss('truss', -21, -16, -44, 27, 1)),
    ...sym(part('jaw', [[-31, -38], [-27, -47], [-21, -51], [-16.5, -49.4], [-19.6, -44.6], [-25, -41.4]], 'hull2', 2, { lift: 2.4, details: [mark([[-26.6, -45], [-21.6, -48.8], [-20.4, -47.6], [-25, -43.6]])] })),
    ...sym(gunBlock('pod', at([1.7, 1.6], c.w, c.h), 4.6, 3)),
    ...sym(seat('pd', c, 2, 3.5, 3.3, false, CONFED_SEAT)),
    ...gantry('frameF', -25, 4.6, 30, 3.4, false),
    ...gantry('frameM', -2, 7.4, 30.6, 3.5, true),
    ...gantry('frameA', 22, 4.6, 30, 3.4, false),
    part('block', chamfer(0, 37.5, 63, 21, 6), 'hull2', 2, {
      lift: 3,
      facets: [{ pts: [[-31.5, 34], [-25.5, 27], [25.5, 27], [31.5, 34]], slope: [0, -0.45] }],
      details: [mark(rect(-31.5, 42.4, 63, 1.8)), ...[-18, 18].map((x): Detail => recess(rect(x - 4, 36, 8, 5))), ambers([[-18, 39.6], [18, 39.6]], 0.8)],
    }),
    bridge('bridge', 0, 34.4, 15, 9, 3),
    cells('cells', -22, 36.6, 2, 2, 2.2, 3.2),
    port('portL', sL, 5.2, 3.6),
    port('portR', [-sL[0], sL[1]], 5.2, 3.6),
    port('portS', sS, 4.6, 3.8),
    antenna('mast', [22, 40], [26, 46.6], 1.4, 4, { detach: { hull: 0.5 } }),
    antenna('mast2', [-26, 41], [-28.4, 46.4], 1.2, 4, { detach: { hull: 0.4 } }),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Dominion Shipworks ------------------------------------------------------------------------------

/**
 * Dominion Shipworks: the Confederacy's armoured war dock. Massive armour-block walls over
 * trusses line a long berth, spanned by four gantry frames (the second is the heavy one with the
 * construction crane, the yard's hardpoint). Gun blocks with heavy batteries stand at the mouth
 * behind angular jaws and a forward prong; at the stern a production block carries the bridge core
 * under the shield generator, flak blocks on its corners, missile cells and two masts. The flank
 * sockets sit in the walls.
 */
export const confedCapitalYard: ModelDef = (c) => {
  const [sL] = CYARD_SOCKETS.droid.map((g) => at(g, c.w, c.h))
  const parts: Part[] = [
    berth('bed', 23, -47, 33, 0.4),
    ...wall('wall', -36, -23, -43, 33, 1.2),
    ...sym(truss('truss', -23, -18, -43, 33, 1)),
    ...sym(part('jaw', [[-35.4, -38], [-31.6, -48], [-24, -52], [-18, -50.4], [-21, -45.4], [-27, -42]], 'hull2', 2, { lift: 2.6, details: [mark([[-30.4, -46], [-24.4, -50], [-23, -48.6], [-28.6, -44.6]])] })),
    ...sym(gunBlock('tower', at([1.75, 1.35], c.w, c.h), 5.6, 3)),
    ...sym(seat('tl', c, 2, 4.4, 3.3, true, CONFED_SEAT)),
    ...gantry('frameF', -24, 4.8, 34, 3.4, false),
    ...gantry('frameM', -6, 8, 34.6, 3.5, true),
    ...gantry('frameA', 15, 4.8, 34, 3.4, false),
    ...gantry('frameS', 28.4, 4.4, 34, 3.4, false),
    part('block', chamfer(0, 41, 72, 17, 6), 'hull2', 2, {
      lift: 3,
      facets: [{ pts: [[-36, 38.5], [-30, 32.5], [30, 32.5], [36, 38.5]], slope: [0, -0.45] }],
      details: [mark(rect(-36, 46, 72, 1.8)), ...[-24, 24].map((x): Detail => recess(rect(x - 4, 39, 8, 5))), ambers([[-24, 42.6], [24, 42.6]], 0.8)],
    }),
    bridge('bridge', 0, 38.6, 16, 9, 3),
    ...sym(gunBlock('pdPod', at([1.9, 9.1], c.w, c.h), 3.4, 3.1)),
    ...sym(seat('pd', c, 4, 3, 3.3, false, CONFED_SEAT)),
    cells('cells', 14.6, 41.6, 2, 2, 2.2, 3.2),
    antenna('spire', [-14, 39], [-16.6, 47.6], 1.8, 4, { detach: { hull: 0.5 } }),
    part('prong', [[-1.6, -45], [-1, -51], [1, -51], [1.6, -45]], 'hull2', 4.2, { detach: { hull: 0.6 }, details: [windows([[0, -49.6]], 0.6)] }),
    port('portL', sL, 5.6, 3.9),
    port('portR', [-sL[0], sL[1]], 5.6, 3.9),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Expansion modules -------------------------------------------------------------------------------

/** The girder back to the hull's details: a seam down it. */
const strut = (R: number, reach: number): Detail[] => [seam([-R * 0.13, R * 0.4], [-R * 0.13, R * 0.2 + reach * 0.9])]

/** A running light for a module: teal. */
const beacon = (pts: Pt[], r: number, _rep: boolean): Detail => windows(pts, r)

/**
 * One expansion's own structure, in its local frame: up (-y) is away from the building, +x towards
 * the yard's bow, the socket at the origin; `R` is its size (half its socket's share of the
 * building). Kept within about 1.2 R outward, so it stays inside the building's bitmap.
 */
function modulePod(exp: ModuleId, R: number): Part[] {
  // Confederacy modules (the code below once drew both sides' and still reads `rep`).
  const rep: boolean = false
  // Steel plate over gunmetal frames, orange bands and teal lights.
  const plate: Tone = 'hull'
  const plate2: Tone = 'hull2'
  const frame: Tone = 'metal'
  const band: Tone = 'accent'
  const studs = (a: Pt, b: Pt, _n: number): Detail[] => [seam(a, b)]
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
