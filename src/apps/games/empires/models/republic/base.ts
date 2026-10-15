import { CYARD_SOCKETS, YARD_SOCKETS, type ModuleId } from '../../data.ts'
import { at, type Expansion } from '../expansions.ts'
import { along, box, capsule, chamfer, circle, part, rect, sym, thick } from '../kit.ts'
import { seat } from '../proto.ts'
import type { ModelDef } from '../spec.ts'
import type { Detail, Part, Pt, Tone } from '../types.ts'
import { enginePod } from './style.ts'

// The Republic's hybrid bases: its engineer squadron, the Frigate Yard and the Capital Yard, and the
// expansion modules that bolt onto them and the Command Station (`expansion`, placed by
// models/expansions.ts).
//
// The yards are drawn in the calm style of the Big warships (warships.ts): a few big plates with long
// trenches and a band or two of colour, one seat per gun, lights placed sparingly. Each reads as a
// shipyard from above: an open berth a ship of its class fits in, gantry cranes spanning it, a gate
// at the mouth where the ships leave (the bow, up), a hall closing the stern with the yard's control
// tower on it, in white and red plate. Empty module sockets show as ringed ports.

/** An empty module port: a ringed plate with a dark well and four lights round it, in the
 * faction's trim, so it reads as a socket waiting for something. */
function port(id: string, [x, y]: Pt, r: number, z: number): Part {
  return part(id, circle(x, y, r, 20), 'hull2', z, {
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
 * Mason engineer: a squat clone utility craft. A boxy body with the cockpit up front, two welding
 * booms reaching past the nose with glowing tips, a pallet of girder sections strapped on its back,
 * stubby wings in gold and black hazard stripes, and two short engine pods.
 */
export const republicEngineer: ModelDef = () => {
  const hazard = (x0: number, y0: number, n: number): Detail[] =>
    Array.from({ length: n }, (_, i) => ({ k: 'shape' as const, pts: [[x0 - i * 4.2, y0], [x0 - i * 4.2 - 2.2, y0], [x0 - i * 4.2 - 4.4, y0 + 5], [x0 - i * 4.2 - 2.2, y0 + 5]] as Pt[], tone: 'dark' as const }))
  const parts: Part[] = [
    ...sym(part('wing', [[-9, 2], [-33, 9], [-36, 15], [-35, 27], [-9, 26]], 'hull', 1, {
      slope: [-0.35, 0.05],
      details: [{ k: 'shape', pts: [[-12, 15], [-35.5, 15], [-35, 21], [-12, 21]], tone: 'trim' }, ...hazard(-15, 15.5, 5), { k: 'line', pts: [[-22, 4], [-22, 26]] }],
    }), { slope: [0.35, 0.05] }),
    ...sym(part('boom', capsule([-7, -20], [-11, -45], 2, 1.5), 'metal', 2, { lift: 0.8, detach: { hull: 0.3 }, details: [{ k: 'lights', pts: [[-11, -45.5]], r: 1.4, tone: 'ember' }] }), { detach: { hull: 0.22 } }),
    enginePod('engineL', -13.9, 12, 47, 10, 0, 2, { detach: { death: true } }, 'trim'),
    enginePod('engineR', 13.9, 12, 47, 10, 1, 2, { detach: { death: true } }, 'trim'),
    ...sym(part('body', [[0, -36], [-6, -35], [-11, -28], [-12, 8], [-10, 34], [0, 36]], 'hull', 3, {
      slope: [-0.5, 0],
      details: [{ k: 'shape', pts: [[-11.6, -10], [-12, -4], [0, -4], [0, -10]], tone: 'accent' }, { k: 'line', pts: [[-11, 20], [0, 20]] }],
    })),
    part('cockpit', [[0, -35], [4.4, -32], [5.4, -24], [4, -19], [-4, -19], [-5.4, -24], [-4.4, -32]], 'glass', 4, {
      lift: 0.9,
      details: [{ k: 'shape', pts: [[-0.8, -33], [-3, -27], [-3, -23], [-1.6, -23], [-1.2, -28]], tone: 'glow' }],
    }),
    // The pallet of girder sections: a dark frame with three beams across it.
    part('pallet', rect(-9, -2, 18, 24), 'metal', 4, {
      lift: 1.2,
      details: [
        { k: 'shape', pts: rect(-7.5, 0, 15, 4), tone: 'hull2' },
        { k: 'shape', pts: rect(-7.5, 7.5, 15, 4), tone: 'hull2' },
        { k: 'shape', pts: rect(-7.5, 15, 15, 4), tone: 'hull2' },
        { k: 'line', pts: [[-7.5, 2], [7.5, 2]] },
        { k: 'line', pts: [[-7.5, 9.5], [7.5, 9.5]] },
        { k: 'line', pts: [[-7.5, 17], [7.5, 17]] },
      ],
    }),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Yard parts --------------------------------------------------------------------------------------

/**
 * A berth: the dark bed a ship is built in, `hw` half-wide from y0 (the mouth) to y1, keel blocks
 * across its middle at `blocks` and guide lights down both edges.
 */
function berth(id: string, hw: number, y0: number, y1: number, z: number, blocks: number[]): Part {
  const n = Math.max(4, Math.round((y1 - y0) / 11))
  const edge = hw - 1.6
  return part(id, rect(-hw, y0, hw * 2, y1 - y0), 'dark', z, {
    details: [
      ...blocks.map((y): Detail => ({ k: 'shape', pts: rect(-5.5, y, 11, 2.2), tone: 'metal' })),
      { k: 'line', pts: [[0, y0 + 3], [0, y1 - 3]] },
      { k: 'lights', pts: [...along([-edge, y0 + 4], [-edge, y1 - 4], n), ...along([edge, y0 + 4], [edge, y1 - 4], n)], r: 0.55, tone: 'glow' },
    ],
  })
}

/** A Republic gantry crane spanning a berth at `y`, `wd` wide, from -x1 to x1: a girder with a
 * trolley in the middle and a red lamp at each end; a heavy one has a red band and no trolley of its
 * own (the yard's construction crane, its hardpoint, sits there). */
function gantry(id: string, y: number, wd: number, x1: number, z: number, heavy: boolean): Part[] {
  const out: Part[] = [
    part(id, rect(-x1, y - wd / 2, x1 * 2, wd), 'metal', z, {
      lift: heavy ? 3.4 : 2.8,
      details: [
        { k: 'line', pts: [[-x1 + 1, y], [x1 - 1, y]] },
        ...(heavy ? [{ k: 'shape' as const, pts: rect(-x1, y - wd / 2, x1 * 2, 1.3), tone: 'accent' as const }] : []),
        { k: 'lights', pts: [[-x1 + 1.1, y], [x1 - 1.1, y]], r: 0.7, tone: 'accent' },
      ],
    }),
  ]
  if (!heavy) out.push(part(`${id}Trolley`, chamfer(0, y, 7, wd + 2.4, 1.2), 'hull2', z + 0.1, { lift: 1, details: [{ k: 'shape', pts: rect(-3.5, y - 0.5, 7, 1), tone: 'dark' }] }))
  return out
}

// --- Frigate Yard ------------------------------------------------------------------------------------

/**
 * Bastion frigate yard: an open Republic slipway. A berth a Warden fits in lies between two long
 * white side frames, a red band across each; square bow towers at the mouth carry the point
 * defence, a gate beam with docking lights strung between them. Three gantry cranes span the berth
 * (the middle one carries the construction crane, the yard's hardpoint). A plated hall closes the
 * stern under the shield generator, with the control tower on one side, its bridge windows looking
 * down the berth, and the assembly hangar's mouth facing it on the other. The flank sockets sit on
 * collars on the frames, the third on the hall's back.
 */
export const republicYard: ModelDef = (c) => {
  const [sL, , sS] = YARD_SOCKETS.republic.map((g) => at(g, c.w, c.h))
  const parts: Part[] = [
    berth('bed', 15.5, -47, 27, 0.4, [-36, -16, 4, 18]),
    ...sym(part('frame', [[-27, -41], [-23, -47], [-15, -47], [-15, 27], [-27, 27]], 'hull', 1.2, {
      lift: 2.6,
      facets: [{ pts: [[-27, -41], [-23, -47], [-22, -47], [-22, 27], [-27, 27]], slope: [-0.5, 0] }],
      details: [
        { k: 'shape', pts: rect(-27, -29.6, 12, 2.2), tone: 'accent' },
        { k: 'shape', pts: rect(-27, 21.6, 12, 2.2), tone: 'accent' },
        { k: 'lights', pts: along([-16.2, -24], [-16.2, 20], 5), r: 0.55, tone: 'glow' },
      ],
    })),
    ...sym(part('collar', chamfer(sL[0] - 0.6, sL[1], 12, 14, 3), 'hull2', 2.4, { lift: 2.4, details: [{ k: 'shape', pts: rect(sL[0] - 6.6, sL[1] + 5.4, 12, 1.4), tone: 'accent' }] })),
    // The bow towers with the point defence, and the gate between them over the mouth.
    ...sym(part('tower', chamfer(-21.4, -35, 12, 13, 3), 'hull', 3, {
      lift: 3.2,
      facets: [{ pts: [[-27.4, -38.5], [-24.4, -41.5], [-22.4, -41.5], [-22.4, -28.5], [-24.4, -28.5], [-27.4, -31.5]], slope: [-0.5, 0] }],
      details: [{ k: 'shape', pts: rect(-27.4, -40.2, 12, 1.6), tone: 'accent' }],
    })),
    ...sym(seat('pd', c, 2, 3.7, 3.4, false)),
    part('gate', rect(-15.6, -46.4, 31.2, 2.6), 'metal', 4.2, {
      lift: 5,
      details: [{ k: 'shape', pts: rect(-15.6, -46.4, 3, 2.6), tone: 'accent' }, { k: 'shape', pts: rect(12.6, -46.4, 3, 2.6), tone: 'accent' }, { k: 'lights', pts: along([-10, -45.1], [10, -45.1], 5), r: 0.6, tone: 'glow' }],
    }),
    // Gantry cranes across the berth.
    ...gantry('gantryF', -22, 4.4, 28.4, 3.4, false),
    ...gantry('gantryM', -4, 7, 28.6, 3.5, true),
    ...gantry('gantryA', 16, 4.4, 28.4, 3.4, false),
    // The stern hall, the shield generator on it, the control tower and the assembly hangar.
    part('hall', chamfer(0, 37, 60, 20, 5.5), 'hull', 2, {
      lift: 3.2,
      facets: [{ pts: [[-30, 32.5], [-24.5, 27], [24.5, 27], [30, 32.5], [30, 34], [-30, 34]], slope: [0, -0.45] }],
      details: [{ k: 'shape', pts: rect(-30, 41, 60, 1.8), tone: 'accent' }, { k: 'line', pts: [[-30, 34], [30, 34]] }, { k: 'lights', pts: [[-28.6, 33.2], [28.6, 33.2]], r: 0.7, tone: 'accent' }],
    }),
    seat('shieldSeat', c, 1, 5.6, 3.3, true),
    part('tower', chamfer(-18, 37.5, 12, 12, 3), 'hull2', 3.2, { lift: 4.6, details: [{ k: 'shape', pts: rect(-24, 40.6, 12, 1.4), tone: 'accent' }] }),
    part('bridge', chamfer(-18, 35.4, 8, 6.6, 2), 'hull', 3.6, { lift: 2, details: [{ k: 'lights', pts: along([-20.6, 32.9], [-15.4, 32.9], 3), r: 0.55, tone: 'glass' }] }),
    part('hangar', chamfer(18, 37.5, 12, 12, 3), 'hull2', 3.2, {
      lift: 3,
      details: [{ k: 'shape', pts: rect(13.4, 31.5, 9.2, 4), tone: 'dark' }, { k: 'lights', pts: along([14.6, 34.6], [21.4, 34.6], 3), r: 0.45, tone: 'glow' }, { k: 'shape', pts: rect(12, 40.6, 12, 1.4), tone: 'accent' }],
    }),
    port('portL', sL, 5.2, 3.6),
    port('portR', [-sL[0], sL[1]], 5.2, 3.6),
    port('portS', sS, 4.6, 3.8),
    part('mast', box(-22.4, 41.4, 0.9, 7), 'dark', 4, { lift: 2, detach: { hull: 0.5 }, details: [{ k: 'lights', pts: [[-22.4, 38.2]], r: 0.7, tone: 'accent' }] }),
    part('dish', circle(22, 42.2, 2.6, 14), 'metal', 4, { lift: 1.4, slope: [0.3, 0.3], detach: { hull: 0.4 }, details: [{ k: 'shape', pts: circle(22, 42.2, 0.8, 8), tone: 'dark' }] }),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Capital Yard ------------------------------------------------------------------------------------

/**
 * Citadel capital yard: a great Republic dry dock, the Frigate Yard's bigger, grander sister. A long
 * deep berth for the line's heaviest hulls between tall inner walls and lower outer buttresses,
 * spanned by four gantries (the second is the heavy one with the construction crane, the yard's
 * hardpoint). Square bow towers carry the turbolasers either side of the gate. The stern hall
 * carries a stepped superstructure under the shield generator, its long bridge looking down the
 * dock, with masts either side and point defence on the corners. The flank sockets sit on collars
 * in the buttresses.
 */
export const republicCapitalYard: ModelDef = (c) => {
  const [sL] = CYARD_SOCKETS.republic.map((g) => at(g, c.w, c.h))
  const parts: Part[] = [
    berth('bed', 18, -48, 32, 0.4, [-40, -26, -12, 2, 16]),
    ...sym(part('buttress', [[-34.5, -34], [-30.5, -41], [-25, -41], [-25, 32], [-34.5, 32]], 'hull2', 1, {
      lift: 2,
      facets: [{ pts: [[-34.5, -34], [-30.5, -41], [-30, -41], [-30, 32], [-34.5, 32]], slope: [-0.5, 0] }],
      details: [{ k: 'line', pts: [[-34.5, -16], [-25, -16]] }, { k: 'line', pts: [[-34.5, 22], [-25, 22]] }, { k: 'lights', pts: [[-32.2, -24], [-32.2, 27]], r: 0.6, tone: 'glass' }],
    })),
    ...sym(part('wall', [[-25.5, -44], [-21.5, -48], [-18, -48], [-18, 32], [-25.5, 32]], 'hull', 1.4, {
      lift: 3.8,
      facets: [{ pts: [[-25.5, -44], [-21.5, -48], [-21, -48], [-21, 32], [-25.5, 32]], slope: [-0.5, 0] }],
      details: [
        { k: 'shape', pts: rect(-25.5, -31, 7.5, 2.2), tone: 'accent' },
        { k: 'shape', pts: rect(-25.5, 26.4, 7.5, 2.2), tone: 'accent' },
        { k: 'lights', pts: along([-18.9, -26], [-18.9, 22], 6), r: 0.55, tone: 'glow' },
      ],
    })),
    ...sym(part('collar', chamfer(sL[0] - 0.4, sL[1], 13, 15, 3.2), 'hull', 2.4, { lift: 2.8, details: [{ k: 'shape', pts: rect(sL[0] - 6.9, sL[1] + 5.6, 13, 1.5), tone: 'accent' }] })),
    // The bow towers with the turbolasers, the gate between them.
    ...sym(part('tower', chamfer(-24, -37.6, 15, 15, 3.4), 'hull', 3, {
      lift: 4,
      facets: [{ pts: [[-31.5, -41.6], [-27.9, -45.1], [-26, -45.1], [-26, -30.1], [-27.9, -30.1], [-31.5, -33.6]], slope: [-0.5, 0] }],
      details: [{ k: 'shape', pts: rect(-31.5, -32.4, 15, 1.8), tone: 'accent' }, { k: 'lights', pts: [[-30.4, -43.4], [-17.6, -43.4]], r: 0.6, tone: 'accent' }],
    })),
    ...sym(seat('tl', c, 2, 4.6, 3.4, true)),
    part('gate', rect(-16.6, -47.6, 33.2, 3), 'metal', 4.2, {
      lift: 5.6,
      details: [{ k: 'shape', pts: rect(-16.6, -47.6, 3, 3), tone: 'accent' }, { k: 'shape', pts: rect(13.6, -47.6, 3, 3), tone: 'accent' }, { k: 'lights', pts: along([-11, -46.1], [11, -46.1], 6), r: 0.6, tone: 'glow' }],
    }),
    part('antenna', box(0, -49.6, 0.8, 4.6), 'dark', 4.4, { detach: { hull: 0.6 }, details: [{ k: 'lights', pts: [[0, -51.6]], r: 0.6, tone: 'accent' }] }),
    // Four gantries across the dock.
    ...gantry('gantryF', -27, 4.6, 33, 3.4, false),
    ...gantry('gantryM', -8, 8, 33.4, 3.5, true),
    ...gantry('gantryA', 11, 4.6, 33, 3.4, false),
    ...gantry('gantryS', 25, 4.6, 33, 3.4, false),
    // The stern hall and its superstructure, the shield generator on it.
    part('hall', chamfer(0, 40.5, 70, 17, 6), 'hull2', 2, {
      lift: 3,
      facets: [{ pts: [[-35, 38], [-29, 32], [29, 32], [35, 38], [35, 39], [-35, 39]], slope: [0, -0.45] }],
      details: [{ k: 'shape', pts: rect(-35, 45.4, 70, 1.6), tone: 'accent' }, { k: 'line', pts: [[-35, 39], [35, 39]] }],
    }),
    part('super', chamfer(0, 39.5, 26, 14, 4), 'hull', 3, {
      lift: 3,
      facets: [{ pts: [[-13, 36.5], [-9, 32.5], [-9, 46.5], [-13, 42.5]], slope: [-0.5, 0] }, { pts: [[13, 36.5], [9, 32.5], [9, 46.5], [13, 42.5]], slope: [0.5, 0] }],
      details: [{ k: 'shape', pts: rect(-13, 43.6, 26, 1.6), tone: 'accent' }],
    }),
    part('bridge', chamfer(0, 31.6, 20, 4.6, 1.6), 'hull', 3.4, { lift: 2, details: [{ k: 'lights', pts: along([-7.6, 31.6], [7.6, 31.6], 7), r: 0.5, tone: 'glass' }, { k: 'shape', pts: rect(-10, 33, 20, 0.9), tone: 'accent' }] }),
    seat('shieldSeat', c, 1, 5.6, 3.6, true),
    ...sym(seat('pd', c, 4, 3.3, 3.3, false)),
    ...sym(part('mast', box(-12.6, 42, 0.9, 7.4), 'dark', 4, { lift: 2, detach: { hull: 0.5 }, details: [{ k: 'lights', pts: [[-12.6, 38.6]], r: 0.7, tone: 'accent' }] }), { detach: { hull: 0.42 } }),
    port('portL', sL, 5.6, 3.9),
    port('portR', [-sL[0], sL[1]], 5.6, 3.9),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Expansion modules -------------------------------------------------------------------------------

/** The girder back to the hull's details: a plain girder. */
const strut = (_R: number, _reach: number): Detail[] => []

/** A running light for a module: the Republic's blue. */
const beacon = (pts: Pt[], r: number, _rep: boolean): Detail => ({ k: 'lights', pts, r, tone: 'glow' })

/**
 * One expansion's own structure, in its local frame: up (-y) is away from the building, +x towards
 * the yard's bow, the socket at the origin; `R` is its size (half its socket's share of the
 * building). Kept within about 1.2 R outward, so it stays inside the building's bitmap.
 */
function modulePod(exp: ModuleId, R: number): Part[] {
  // Republic modules (the code below once drew both sides' and still reads `rep`).
  const rep: boolean = true
  // White plate, grey frames, red bands, blue lights.
  const plate: Tone = 'hull'
  const plate2: Tone = 'hull2'
  const frame: Tone = 'metal'
  const band: Tone = 'accent'
  const studs = (_a: Pt, _b: Pt, _n: number): Detail[] => []
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
