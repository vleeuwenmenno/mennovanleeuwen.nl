import { CYARD_SOCKETS, YARD_SOCKETS, type FactionId, type ModuleId, type UnitType } from '../data.ts'
import { engineBlock, eyes, lamps, mast, rivets, dish } from './droid.ts'
import { along, box, capsule, chamfer, circle, move, part, rect, sym, thick, turnPart } from './kit.ts'
import { nacelle } from './republic.ts'
import type { ModelDef } from './spec.ts'
import type { Detail, Part, Pt, Tone } from './types.ts'

// Hybrid bases: the engineer squadrons, the Frigate Yards and the Capital Yards, for both sides, in
// each faction's own style kit, and the expansion modules that bolt onto the yards and the Command
// Station (expansionParts). The yards are working models for now (step 4 brings the final ones),
// their module sockets (data.ts YARD_SOCKETS, CYARD_SOCKETS) marked out as ringed ports.

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

// --- Capital Yards -----------------------------------------------------------------------------------

/**
 * Citadel capital yard: a great enclosed Republic dock, a third longer than the Frigate Yard. Two
 * massive armoured walls in white and red flank a deep slip bed, roofed by four heavy gantries (the
 * second carries the yard's construction crane, its hardpoint); square bow towers carry the
 * turbolasers, a command block with its bridge windows closes the stern under the shield generator,
 * point defence on its corners. The side ports sit in the walls, the spare one in the stern.
 */
export const republicCapitalYard: ModelDef = ({ w, h }) => {
  const sockets = CYARD_SOCKETS.republic.map((g) => at(g, w, h))
  const wall = part('wall', [[-35, -38], [-31, -44], [-19, -44], [-19, 34], [-35, 34]], 'hull', 2, {
    lift: 3.6,
    facets: [{ pts: [[-35, -38], [-31, -44], [-27, -44], [-27, 34], [-35, 34]], slope: [-0.45, 0] }],
    details: [
      ...[-30, -6, 18].map((y): Detail => ({ k: 'shape', pts: rect(-35, y, 16, 3.2), tone: 'accent' })),
      { k: 'line', pts: [[-23, -42], [-23, 32]] },
      { k: 'lights', pts: along([-20.4, -40], [-20.4, 30], 11), r: 0.7, tone: 'glow' },
      { k: 'lights', pts: along([-33, -34], [-33, 30], 9), r: 0.55, tone: 'glass' },
    ],
  })
  const gantry = (id: string, y: number, wide: number, z: number): Part =>
    part(id, rect(-27, y - wide / 2, 54, wide), 'metal', z, {
      lift: 2.6,
      details: [{ k: 'line', pts: [[-27, y], [27, y]] }, ...[-21, -12, -3, 6, 15, 24].map((x): Detail => ({ k: 'line', pts: [[x - 3, y - wide / 2], [x + 3, y + wide / 2]] })), { k: 'lights', pts: [[-25.5, y], [25.5, y]], r: 0.9, tone: 'accent' }],
    })
  const parts: Part[] = [
    part('bed', rect(-19, -44, 38, 78), 'dark', 0.6, {
      details: [
        ...[-36, -22, -8, 6, 20].map((y): Detail => ({ k: 'shape', pts: rect(-5, y, 10, 4.5), tone: 'metal' })),
        { k: 'lights', pts: [...along([-16, -42], [-16, 32], 12), ...along([16, -42], [16, 32], 12)], r: 0.6, tone: 'glow' },
        { k: 'line', pts: [[0, -44], [0, 34]] },
      ],
    }),
    ...sym(wall, { facets: [{ pts: [[35, -38], [31, -44], [27, -44], [27, 34], [35, 34]], slope: [0.45, 0] }] }),
    ...sym(part('tower', chamfer(-23, -37, 15, 15, 3), 'hull2', 3, { lift: 3, details: [{ k: 'shape', pts: rect(-30.5, -31.5, 15, 2.2), tone: 'accent' }, { k: 'line', pts: circle(-23, -37, 5.4, 12) }] })),
    gantry('gantryF', -28, 5, 3.4),
    gantry('gantryM', -8, 8, 3.5),
    gantry('gantryA', 12, 5, 3.4),
    gantry('gantryS', 26, 4, 3.4),
    part('stern', chamfer(0, 41, 70, 18, 6), 'hull2', 3, {
      lift: 3.4,
      facets: [{ pts: [[-35, 38], [-29, 32], [29, 32], [35, 38], [0, 41]], slope: [0, -0.4] }],
      details: [
        { k: 'shape', pts: rect(-35, 45.5, 70, 2.4), tone: 'accent' },
        { k: 'lights', pts: [...along([-29, 35], [-12, 35], 6), ...along([12, 35], [29, 35], 6)], r: 0.7, tone: 'glass' },
      ],
    }),
    part('bridge', chamfer(0, 31, 22, 7, 2.5), 'hull', 3.8, { lift: 2.2, details: [{ k: 'lights', pts: along([-8, 31], [8, 31], 7), r: 0.7, tone: 'glass' }] }),
    port('portL', sockets[0], 5.6, 3.9, 'republic'),
    port('portR', sockets[1], 5.6, 3.9, 'republic'),
    port('portS', sockets[2], 4.4, 3.9, 'republic'),
    part('mast', box(-12, 41, 1.2, 10), 'dark', 4.2, { detach: { hull: 0.5 }, details: [{ k: 'lights', pts: [[-12, 36]], r: 0.8, tone: 'accent' }] }),
    part('beacon', box(12, 41, 1.2, 10), 'dark', 4.2, { detach: { hull: 0.4 }, details: [{ k: 'lights', pts: [[12, 36]], r: 0.8, tone: 'glow' }] }),
    part('antenna', box(0, -46, 1, 5), 'dark', 4.2, { detach: { hull: 0.6 }, details: [{ k: 'lights', pts: [[0, -48.2]], r: 0.7, tone: 'accent' }] }),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Leviathan capital foundry: a cavernous droid foundry. Two heavy claw walls curl round a slip bed
 * glowing with molten metal, bound by three crane bridges (the middle one is the yard's hardpoint);
 * gun towers at the bow claws carry the cannons, a furnace dome and foundry block close the stern
 * under the shield generator, point defence on its corners, and a sensor spire and a dish are bolted
 * on. The side ports sit in the claw walls, the spare one in the stern.
 */
export const droidCapitalYard: ModelDef = ({ w, h }) => {
  const sockets = CYARD_SOCKETS.droid.map((g) => at(g, w, h))
  const claw = part('claw', [[-24, -48], [-31, -44], [-36, -34], [-37, 34], [-20, 34], [-20, -36], [-18, -44]], 'hull', 2, {
    lift: 3.6,
    facets: [{ pts: [[-31, -44], [-36, -34], [-37, 34], [-29, 34], [-29, -40]], slope: [-0.45, 0] }],
    details: [
      ...[-28, -4, 20].map((y): Detail => ({ k: 'shape', pts: [[-37, y], [-20, y], [-20, y + 3.2], [-37, y + 3.2]], tone: 'accent' })),
      rivets([-33, -36], [-33, 30], 12),
      rivets([-23, -34], [-23, 30], 11),
      eyes([[-26, -42]], 1.1),
    ],
  })
  const crane = (id: string, y: number, wide: number, z: number, heavy: boolean): Part =>
    part(id, thick([[-30, y], [30, y]], wide), heavy ? 'hull2' : 'metal', z, {
      lift: heavy ? 3 : 2.3,
      details: [rivets([-26, y], [26, y], 10), ...(heavy ? [{ k: 'shape' as const, pts: rect(-30, y - wide / 2, 60, 1.6), tone: 'accent' as const }, lamps([[-28, y], [28, y]], 1)] : [])],
    })
  const parts: Part[] = [
    part('bed', rect(-20, -42, 40, 76), 'dark', 0.6, {
      details: [
        { k: 'shape', pts: rect(-3.5, -36, 7, 66), tone: 'char' },
        { k: 'lights', pts: along([0, -34], [0, 28], 10), r: 1.2, tone: 'ember' },
        rivets([-17, -40], [-17, 30], 11),
        rivets([17, -40], [17, 30], 11),
      ],
    }),
    ...sym(claw, { facets: [{ pts: [[31, -44], [36, -34], [37, 34], [29, 34], [29, -40]], slope: [0.45, 0] }] }),
    ...sym(part('gunTower', circle(-23.5, -36.5, 6.6, 16), 'hull2', 3, { sphere: true, lift: 2.4, details: [rivets([-28, -36.5], [-19, -36.5], 4)] })),
    crane('craneF', -26, 5, 3.4, false),
    crane('craneM', -6, 9, 3.6, true),
    crane('craneA', 14, 5, 3.4, false),
    part('foundry', chamfer(0, 42, 74, 18, 5), 'metal', 3, { lift: 3, details: [rivets([-32, 36], [32, 36], 14), { k: 'shape', pts: rect(-37, 46, 74, 2.4), tone: 'accent' }] }),
    part('furnace', circle(0, 36, 13, 26), 'hull2', 3.5, { sphere: true, lift: 2.2, details: [{ k: 'shape', pts: box(0, 36, 26, 2.8), tone: 'accent' }, lamps(along([-9, 41], [9, 41], 4), 0.9)] }),
    port('portL', sockets[0], 5.6, 3.9, 'droid'),
    port('portR', sockets[1], 5.6, 3.9, 'droid'),
    port('portS', sockets[2], 4.4, 3.9, 'droid'),
    mast('spire', [-30, 38], [-33, 26], 2.2, 4.2, { detach: { hull: 0.5 } }),
    dish('dish', 29, 40, 4.4, 4.2, { detach: { hull: 0.4 } }),
    part('prong', thick([[0, -42], [0, -48]], 2.4, 1), 'metal', 4.2, { detach: { hull: 0.6 }, details: [eyes([[0, -46]], 0.8)] }),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Expansion modules -------------------------------------------------------------------------------

/**
 * The expansions on a unit (its hardpoints with `exp`), as parts of its structure: each a module
 * bolted onto its socket (a slipway frame, a repair cradle, a plate works, a hangar block, a sensor
 * mast, a shield reactor), tied to the hull by a girder, in the faction's colours. Every part of one
 * comes off when its hardpoint is shot off, so a lost module is plain to see; the mount for its
 * hardpoint sits on top. Drawn on the unit's box in model units (a station's on its frame pixels).
 */
export function expansionParts(t: UnitType, w: number, h: number): Part[] {
  const out: Part[] = []
  const long = Math.max(w, h)
  const station = t.tier === 'station'
  const rep = t.faction === 'republic'
  // Dark gunmetal frames with the faction's colours on them, so they read as fitted add-ons
  // against the hull; their working parts light against the frame.
  const body: Tone = 'metal'
  const frame: Tone = 'metal'
  t.hardpoints.forEach((hp, i) => {
    if (!hp.exp) return
    const [x, y] = at([hp.x, hp.y], w, h)
    const R = ((hp.s ?? 0.1) * long) / 2
    const dist = Math.hypot(x, y) || 1
    // Drawn facing up (-y), turned so up points away from the middle of the building.
    const turnTo = Math.atan2(y, x) + Math.PI / 2
    const place = (p: Part): Part => {
      const q = turnPart(p, turnTo)
      return { ...q, pts: move(q.pts, x, y), holes: q.holes?.map((hh) => move(hh, x, y)), facets: q.facets?.map((f) => ({ ...f, pts: move(f.pts, x, y) })), details: q.details?.map((d) => ({ ...d, pts: move(d.pts, x, y) })) }
    }
    const off = { detach: { hp: i } }
    const id = (s: string) => `${s}${hp.exp}`
    // The girder back to the hull: a long one across a station's open corner, a short one on a yard.
    const reach = station ? dist * 0.5 : R * 1.1
    const strut = part(id('strut'), rect(-R * 0.22, R * 0.4, R * 0.44, reach), 'metal', 7.4, {
      lift: 1.4,
      ...off,
      details: [{ k: 'line', pts: [[0, R * 0.45], [0, R * 0.4 + reach]] }, ...(rep ? [] : [rivets([-R * 0.12, R * 0.6], [-R * 0.12, R * 0.4 + reach * 0.9], Math.max(3, Math.round(reach / (R * 0.35))))])],
    })
    out.push(place(strut), ...modulePod(hp.exp, R, rep, body, frame).map((p) => place({ ...p, id: id(p.id), z: 7.6 + (p.z - 1) * 0.1, ...off })))
  })
  return out
}

/** One expansion's own structure, in its local frame (up is away from the building), `R` its size. */
function modulePod(exp: ModuleId, R: number, rep: boolean, body: Tone, frame: Tone): Part[] {
  const inner: Tone = rep ? 'hull' : 'hull2'
  const accent: Tone = 'accent'
  switch (exp) {
    case 'secondSlip':
    case 'capitalSlip': {
      // A slipway frame lying along the hull: rails either side of a dark bed, gantries across it.
      const L = R * (exp === 'capitalSlip' ? 1.45 : 1.3)
      const W = R * 0.66
      return [
        part('Slip', rect(-L, -W, L * 2, W * 2), frame, 1, {
          lift: 2.2,
          details: [
            { k: 'shape', pts: rect(-L * 0.9, -W * 0.55, L * 1.8, W * 1.1), tone: 'dark' },
            { k: 'shape', pts: rect(-L, -W, L * 2, W * 0.22), tone: accent },
            { k: 'lights', pts: [...along([-L * 0.85, -W * 0.45], [L * 0.85, -W * 0.45], 7), ...along([-L * 0.85, W * 0.45], [L * 0.85, W * 0.45], 7)], r: R * 0.05, tone: 'glow' },
          ],
        }),
        part('Gantry', rect(-L * 0.12, -W * 1.05, L * 0.24, W * 2.1), inner, 2, { lift: 1.6, details: [{ k: 'line', pts: [[0, -W], [0, W]] }, ...(rep ? [] : [rivets([0, -W * 0.9], [0, W * 0.9], 5)])] }),
        part('GantryB', rect(-L * 0.78, -W * 1.05, L * 0.16, W * 2.1), inner, 2, { lift: 1.4 }),
        part('GantryC', rect(L * 0.62, -W * 1.05, L * 0.16, W * 2.1), inner, 2, { lift: 1.4 }),
      ]
    }
    case 'drydock': {
      // A repair cradle open to the outside, its arms reaching in, work lights round the bay.
      const A = R * 1.15
      return [
        part('Cradle', [[-A, -A * 0.75], [-A * 0.6, -A * 0.75], [-A * 0.6, A * 0.3], [A * 0.6, A * 0.3], [A * 0.6, -A * 0.75], [A, -A * 0.75], [A, A * 0.7], [-A, A * 0.7]], frame, 1, {
          lift: 2.2,
          details: [{ k: 'shape', pts: rect(-A, A * 0.45, A * 2, A * 0.18), tone: accent }, { k: 'lights', pts: [[-A * 0.8, -A * 0.6], [A * 0.8, -A * 0.6], [-A * 0.8, 0], [A * 0.8, 0]], r: R * 0.07, tone: 'aid' }],
        }),
        part('Bay', rect(-A * 0.6, -A * 0.75, A * 1.2, A * 1.05), 'dark', 0.8, { details: [{ k: 'lights', pts: along([-A * 0.45, -A * 0.65], [A * 0.45, -A * 0.65], 5), r: R * 0.05, tone: 'aid' }] }),
        ...[-1, 1].map((s) => part(s < 0 ? 'ArmL' : 'ArmR', thick([[s * A * 0.6, -A * 0.45], [s * A * 0.25, -A * 0.2]], R * 0.14), inner, 2, { lift: 1 })),
      ]
    }
    case 'armourWorks': {
      // A plate works: a heavy block with a press on it and stacks of armour plate.
      const W = R * 1.25
      const H = R * 0.85
      return [
        part('Works', chamfer(0, 0, W * 2, H * 2, R * 0.25), body, 1, {
          lift: 2.4,
          details: [...[-0.55, 0, 0.55].map((k): Detail => ({ k: 'shape', pts: rect(-W * 0.92, H * k - H * 0.12, W * 0.42, H * 0.24), tone: accent })), ...(rep ? [{ k: 'line' as const, pts: [[-W, -H * 0.85], [W, -H * 0.85]] as Pt[] }] : [rivets([-W * 0.8, -H * 0.8], [W * 0.8, -H * 0.8], 7)])],
        }),
        part('Stack', rect(W * 0.45, -H * 0.75, W * 0.45, H * 1.5), inner, 2, { lift: 1.6, details: [0, 1, 2, 3].map((k): Detail => ({ k: 'line', pts: [[W * 0.45, -H * 0.75 + k * H * 0.4], [W * 0.9, -H * 0.75 + k * H * 0.4]] })) }),
        part('Press', circle(0, 0, R * 0.75, 16), frame, 2, { lift: 1.2, details: [{ k: 'lights', pts: [[0, -R * 0.55]], r: R * 0.08, tone: 'ember' }] }),
      ]
    }
    case 'strikeHangar':
    case 'fighterWing': {
      // A hangar block, its launch slots opening outward with runway lights down them.
      const W = R * 1.08
      const H = R * 0.98
      const slots = exp === 'fighterWing' ? [-0.45, 0.45] : [0]
      return [
        part('Hangar', chamfer(0, 0, W * 2, H * 2, R * 0.3), body, 1, {
          lift: 2.4,
          details: [{ k: 'shape', pts: rect(-W, H * 0.55, W * 2, H * 0.2), tone: accent }, ...(rep ? [] : [rivets([-W * 0.8, H * 0.85], [W * 0.8, H * 0.85], 6)])],
        }),
        ...slots.map((k, j) =>
          part(`Slot${j}`, rect(W * k - W * (slots.length > 1 ? 0.28 : 0.5), -H * 1.02, W * (slots.length > 1 ? 0.56 : 1), H * 0.95), 'dark', 2, {
            details: [{ k: 'lights', pts: along([W * k, -H * 0.95], [W * k, -H * 0.15], 5), r: R * 0.05, tone: 'glow' }],
          }),
        ),
      ]
    }
    case 'sensorArray':
      // A lattice deck with a tall mast and a big dish turned outward.
      return [
        part('Deck', circle(0, 0, R * 1.05, 8), frame, 1, { lift: 2, details: [{ k: 'line', pts: circle(0, 0, R * 0.8, 8) }, { k: 'shape', pts: rect(-R * 1.05, -R * 0.1, R * 2.1, R * 0.2), tone: accent }] }),
        part('Dish', circle(0, -R * 0.95, R * 0.55, 14, R * 0.32), inner, 2, { lift: 1.8, details: [{ k: 'line', pts: [[0, -R * 0.95], [0, -R * 0.55]] }, { k: 'lights', pts: [[0, -R * 1.05]], r: R * 0.08, tone: 'glow' }] }),
      ]
    case 'shieldCore':
      // A round reactor on a ring deck, conduits running back to the station.
      return [
        part('Reactor', circle(0, 0, R * 1.08, 20), frame, 1, {
          lift: 2.4,
          details: [{ k: 'line', pts: circle(0, 0, R * 0.85, 18) }, { k: 'lights', pts: circle(0, 0, R * 0.95, 10), r: R * 0.05, tone: 'glow' }],
        }),
        ...[-1, 1].map((s) => part(s < 0 ? 'ConduitL' : 'ConduitR', rect(s * R * 0.55 - R * 0.09, R * 0.6, R * 0.18, R * 0.75), accent, 2, { lift: 1 })),
      ]
  }
}
