import { YARD_SOCKETS, type FactionId } from '../data.ts'
import { engineBlock, eyes, lamps, mast, rivets, dish } from './droid.ts'
import { along, box, capsule, chamfer, circle, part, rect, sym, thick } from './kit.ts'
import { nacelle } from './republic.ts'
import type { ModelDef } from './spec.ts'
import type { Detail, Part, Pt } from './types.ts'

// Hybrid bases (step 1): the engineer squadrons and the Frigate Yards, for both sides, in each
// faction's own style kit. The yards are working models for now (step 4 brings the final ones), with
// their empty module sockets (data.ts YARD_SOCKETS) marked out as ringed ports where the expansions
// will attach.

/** A grid point (0-10, as hardpoints) on a model box w x h. */
const at = (g: [number, number], w: number, h: number): Pt => [(g[0] / 10 - 0.5) * w, (g[1] / 10 - 0.5) * h]

/** An empty module port: a ringed plate with a dark well and four lights round it, in the
 * faction's trim, so it reads as a socket waiting for something. */
function port(id: string, [x, y]: Pt, r: number, z: number, faction: FactionId): Part {
  return part(id, circle(x, y, r, 20), faction === 'republic' ? 'hull2' : 'metal', z, {
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
    nacelle('engineL', -13.9, 12, 47, 10, 0, 2, { detach: { death: true } }, 'trim'),
    nacelle('engineR', 13.9, 12, 47, 10, 1, 2, { detach: { death: true } }, 'trim'),
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

// --- Frigate Yards -----------------------------------------------------------------------------------

/**
 * Bastion frigate yard: an open Republic slipway. Two long armoured rails in white and red run down
 * either side of a dark slip bed lined with guide lights; three gantries span them (the middle one
 * carries the yard's construction crane, its hardpoint), a command and assembly block closes the
 * stern under the shield generator, and the point-defence turrets stand on the rail tips at the bow.
 * Ringed ports on the rails' outriggers and the stern block wait for the yard's expansions.
 */
export const republicYard: ModelDef = ({ w, h }) => {
  const sockets = YARD_SOCKETS.republic.map((g) => at(g, w, h))
  // A rail, for the left side.
  const rail = part('rail', [[-27, -44], [-19, -48], [-16, -42], [-16, 30], [-28, 30], [-28, -40]], 'hull', 2, {
    lift: 3,
    slope: [-0.4, 0],
    details: [
      { k: 'shape', pts: rect(-28, -26, 12, 3.4), tone: 'accent' },
      { k: 'shape', pts: rect(-28, 22, 12, 3.4), tone: 'accent' },
      { k: 'line', pts: [[-22, -40], [-22, 28]] },
      { k: 'lights', pts: along([-17.6, -38], [-17.6, 26], 8), r: 0.7, tone: 'glow' },
    ],
  })
  const gantry = (id: string, y: number, wide: number): Part =>
    part(id, rect(-25, y - wide / 2, 50, wide), 'metal', 3.4, {
      lift: 2.4,
      details: [{ k: 'line', pts: [[-25, y], [25, y]] }, ...[-20, -10, 10, 20].map((x): Detail => ({ k: 'line', pts: [[x - 3, y - wide / 2], [x + 3, y + wide / 2]] })), { k: 'lights', pts: [[-24, y], [24, y]], r: 0.8, tone: 'accent' }],
    })
  const parts: Part[] = [
    // The slip bed: recessed, its keel blocks waiting for a hull, guide lights down both sides.
    part('bed', rect(-17, -42, 34, 70), 'dark', 0.6, {
      details: [
        ...[-30, -16, -2, 12].map((y): Detail => ({ k: 'shape', pts: rect(-4, y, 8, 4), tone: 'metal' })),
        { k: 'lights', pts: [...along([-14, -40], [-14, 26], 9), ...along([14, -40], [14, 26], 9)], r: 0.6, tone: 'glow' },
        { k: 'line', pts: [[0, -42], [0, 28]] },
      ],
    }),
    // Outriggers on the rails carrying the side ports.
    ...sym(part('rigger', chamfer(sockets[0][0], sockets[0][1], 12, 20, 3), 'hull2', 2.2, { lift: 2.6, details: [{ k: 'shape', pts: rect(sockets[0][0] - 6, sockets[0][1] + 7, 12, 2), tone: 'accent' }] })),
    ...sym(rail, { slope: [0.4, 0] }),
    gantry('gantryF', -24, 5),
    gantry('gantryM', -4, 7),
    gantry('gantryA', 14, 5),
    part('stern', chamfer(0, 38, 60, 22, 7), 'hull2', 3, {
      lift: 3.2,
      facets: [{ pts: [[-30, 34], [-23, 27], [23, 27], [30, 34], [0, 38]], slope: [0, -0.4] }],
      details: [
        { k: 'shape', pts: rect(-30, 41.5, 60, 2.6), tone: 'accent' },
        { k: 'lights', pts: [...along([-24, 30.5], [-12, 30.5], 4), ...along([12, 30.5], [24, 30.5], 4)], r: 0.7, tone: 'glass' },
      ],
    }),
    port('portL', sockets[0], 5.2, 3.6, 'republic'),
    port('portR', sockets[1], 5.2, 3.6, 'republic'),
    port('portS', sockets[2], 4.6, 3.8, 'republic'),
    part('mast', box(-22, 36, 1.2, 9), 'dark', 4, { detach: { hull: 0.5 }, details: [{ k: 'lights', pts: [[-22, 31.6]], r: 0.8, tone: 'accent' }] }),
    part('beacon', box(22, 36, 1.2, 9), 'dark', 4, { detach: { hull: 0.4 }, details: [{ k: 'lights', pts: [[22, 31.6]], r: 0.8, tone: 'glow' }] }),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Crucible frigate yard: a lopsided droid foundry slip. A heavy plated wall down the left side, an
 * open gunmetal truss down the right, a slip bed glowing with molten metal between them, two
 * gantry cranes across it (the big one is the yard's hardpoint), a round furnace dome at the stern
 * under the shield generator, claws at the bow carrying the point defence, and a mast and a dish
 * bolted on. Ringed ports on the wall, the truss and the stern wait for the yard's expansions.
 */
export const droidYard: ModelDef = ({ w, h }) => {
  const sockets = YARD_SOCKETS.droid.map((g) => at(g, w, h))
  const parts: Part[] = [
    part('bed', rect(-18, -40, 36, 70), 'dark', 0.6, {
      details: [
        { k: 'shape', pts: rect(-3, -34, 6, 58), tone: 'char' },
        { k: 'lights', pts: along([0, -32], [0, 22], 8), r: 1.1, tone: 'ember' },
        rivets([-15, -38], [-15, 26], 9),
        rivets([15, -38], [15, 26], 9),
      ],
    }),
    // The left wall: heavy plates, rust bands, rivets.
    part('wall', [[-33, -38], [-27, -47], [-17, -47], [-17, 30], [-33, 30]], 'hull', 2, {
      lift: 3.4,
      facets: [{ pts: [[-33, -38], [-27, -47], [-25, -47], [-25, 30], [-33, 30]], slope: [-0.45, 0] }],
      details: [
        ...[-30, -6, 18].map((y): Detail => ({ k: 'shape', pts: [[-33, y], [-17, y], [-17, y + 3], [-33, y + 3]], tone: 'accent' })),
        rivets([-29, -40], [-29, 26], 10),
        eyes([[-21, -44]], 1),
      ],
    }),
    // The right side: an open truss of girders, diagonals across it.
    part('truss', [[17, -47], [24, -47], [31, -38], [31, 30], [17, 30]], 'metal', 2, {
      lift: 2.4,
      holes: [rect(21, -30, 7, 14), rect(21, -8, 7, 14)],
      details: [{ k: 'line', pts: [[21, -30], [28, -16]] }, { k: 'line', pts: [[21, -8], [28, 6]] }, rivets([18.5, -44], [18.5, 28], 10)],
    }),
    // The bow claws, the point defence on them.
    part('clawL', [[-27, -47], [-22, -50], [-16, -47], [-17, -40], [-26, -40]], 'dark', 2.4, { lift: 1.6 }),
    part('clawR', [[17, -47], [22, -50], [27, -47], [26, -40], [17, -40]], 'dark', 2.4, { lift: 1.6 }),
    // Gantry cranes across the slip: the forward one light, the big one the yard's hardpoint.
    part('craneF', thick([[-26, -22], [26, -22]], 4.6), 'metal', 3.4, { lift: 2.2, details: [rivets([-22, -22], [22, -22], 8)] }),
    part('craneM', thick([[-28, -2], [28, -2]], 8), 'hull2', 3.6, {
      lift: 2.8,
      details: [{ k: 'shape', pts: rect(-28, -4, 56, 1.6), tone: 'accent' }, rivets([-24, 1], [24, 1], 9), lamps([[-26, -2], [26, -2]], 0.9)],
    }),
    part('craneA', thick([[-26, 18], [26, 18]], 4.6), 'metal', 3.4, { lift: 2.2, details: [rivets([-22, 18], [22, 18], 8)] }),
    // The stern: a foundry block with the furnace dome on it.
    part('foundry', chamfer(0, 40, 64, 20, 5), 'metal', 3, { lift: 2.8, details: [rivets([-28, 34], [28, 34], 12), { k: 'shape', pts: rect(-32, 44, 64, 2.4), tone: 'accent' }] }),
    part('furnace', circle(0, 35, 12, 24), 'hull2', 3.4, { sphere: true, lift: 2, details: [{ k: 'shape', pts: box(0, 35, 24, 2.6), tone: 'accent' }, lamps(along([-8, 39], [8, 39], 3), 0.9)] }),
    port('portL', sockets[0], 5.2, 3.6, 'droid'),
    port('portR', sockets[1], 5.2, 3.6, 'droid'),
    port('portS', sockets[2], 4.6, 3.8, 'droid'),
    mast('mast', [-28, 34], [-30, 22], 2, 4, { detach: { hull: 0.5 } }),
    dish('dish', 25, 38, 4, 4, { detach: { hull: 0.4 } }),
  ]
  return { parts, breakStyle: 'bands' }
}
