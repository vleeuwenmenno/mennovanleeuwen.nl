import { along, box, chamfer, circle, fullHull, halfHull, part, rect, sym, thick, turn, turnPart } from './kit.ts'
import type { ModelDef } from './spec.ts'
import type { Detail, Part, Pt, Tone } from './types.ts'

// The droid navy's style kit: an industrial, mass-produced fleet. Weathered sand and bone plating
// over dark gunmetal frames, rust-brown and dull blue-grey panels, riveted, a little lopsided
// where a mast or a dish was bolted on one side only. Long narrow spines with a heavy forward bulb,
// tall sails, boxy engine blocks at the back, rings and spheres for the biggest hulls, hangar bays as
// dark slots, and red and amber sensor eyes on the droids' heads. Original designs in the spirit
// of a clone-war droid army, not copies of any ship.

// --- Shared parts ------------------------------------------------------------------------------------

/** Sensor eyes: red lights with an amber core, glowing on their own. */
const eyes = (pts: Pt[], r: number): Detail => ({ k: 'lights', pts, r, tone: 'glass' })
/** A row of rivets: tiny dark dots, only drawn where the bitmap is big enough to show them. */
const rivets = (a: Pt, b: Pt, n: number): Detail => ({ k: 'lights', pts: along(a, b, n), r: 0.32, tone: 'dark' })
/** Running lights in the engine colour. */
const lamps = (pts: Pt[], r: number): Detail => ({ k: 'lights', pts, r })

/**
 * A boxy engine block seen from above: a chamfered gunmetal box, lit as two faces, a rust band
 * across it, and a dark nozzle at the back with the engine's blue-white light in it.
 */
function engineBlock(id: string, x: number, y0: number, y1: number, w: number, engine: number | undefined, z: number, more: Partial<Part> = {}): Part {
  const h = w / 2
  const l = y1 - y0
  const details: Detail[] = [
    { k: 'shape', pts: rect(x - h, y0 + l * 0.18, w, Math.max(0.8, l * 0.1)), tone: 'accent' },
    { k: 'line', pts: [[x - h, y0 + l * 0.5], [x + h, y0 + l * 0.5]] },
    { k: 'shape', pts: rect(x - h * 0.72, y1 - l * 0.3, h * 1.44, l * 0.24), tone: 'dark' },
  ]
  if (engine !== undefined) details.push(lamps(along([x - h * 0.4, y1 - l * 0.18], [x + h * 0.4, y1 - l * 0.18], w > 6 ? 2 : 1), Math.min(h * 0.32, l * 0.1)))
  return part(id, chamfer(x, (y0 + y1) / 2, w, l, Math.min(h * 0.35, 1.6)), 'metal', z, {
    lift: 1,
    engine,
    facets: [{ pts: rect(x - h, y0, h, l), slope: [-0.5, 0] }],
    details,
    ...more,
  })
}

/**
 * A tall sail fin seen from above: a narrow blade down the line it stands on. Its height shows in
 * the long hard shadow it throws and in its two faces either side of the ridge, one lit and one in
 * shadow; a rust stripe runs along the top.
 */
function sail(id: string, x: number, y0: number, y1: number, w: number, z: number, lift = 6, more: Partial<Part> = {}): Part {
  const l = y1 - y0
  const half = (s: number): Pt[] => [[x, y0], [x + s * w * 0.55, y0 + l * 0.12], [x + s * w, y0 + l * 0.45], [x + s * w * 0.8, y1 - l * 0.06], [x, y1]]
  return part(id, [...half(-1), ...half(1).reverse()], 'hull', z, {
    lift,
    facets: [{ pts: half(-1), slope: [-0.6, 0] }, { pts: half(1), slope: [0.6, 0] }],
    details: [{ k: 'shape', pts: rect(x - w * 0.18, y0 + l * 0.2, w * 0.36, l * 0.62), tone: 'accent' }, { k: 'line', pts: [[x, y0 + l * 0.08], [x, y1 - l * 0.04]] }],
    ...more,
  })
}

/** An antenna mast with a red tip light. */
const mast = (id: string, a: Pt, b: Pt, w: number, z: number, more: Partial<Part> = {}): Part =>
  part(id, thick([a, b], w, w * 0.55), 'dark', z, { lift: 1.4, details: [eyes([b], w * 0.55)], ...more })

/** A small sensor dish, its bowl shaded as if tipped towards the light. */
const dish = (id: string, x: number, y: number, r: number, z: number, more: Partial<Part> = {}): Part =>
  part(id, circle(x, y, r, 16), 'hull2', z, { lift: 1, slope: [0.3, 0.3], details: [{ k: 'shape', pts: circle(x + r * 0.15, y + r * 0.15, r * 0.6, 12), tone: 'metal' }, { k: 'shape', pts: circle(x, y, r * 0.22, 8), tone: 'dark' }], ...more })

/** A droid's wing-leg, for the left side: an upper segment, a knee joint and a lower segment out to
 * a blaster at its tip; both segments are plates over a gunmetal frame. */
function wingLeg(id: string, root: Pt, knee: Pt, tip: Pt, w0: number, w1: number, z: number, gun: boolean, more: Partial<Part> = {}): Part[] {
  const out: Part[] = [
    part(`${id}`, thick([root, knee], w0, w0 * 0.85), 'hull', z, { lift: 0.8, slope: [-0.3, -0.2], details: [{ k: 'shape', pts: thick([[root[0] * 0.8 + knee[0] * 0.2, root[1] * 0.8 + knee[1] * 0.2], [root[0] * 0.25 + knee[0] * 0.75, root[1] * 0.25 + knee[1] * 0.75]], w0 * 0.28), tone: 'accent' }] }),
    part(`${id}Low`, thick([knee, tip], w0 * 0.8, w1), 'hull2', z + 0.05, { lift: 0.8, slope: [-0.3, 0.1], details: [rivets(knee, tip, 4)], ...more }),
    part(`${id}Knee`, circle(knee[0], knee[1], w0 * 0.5, 12), 'dark', z + 0.1, { details: [{ k: 'shape', pts: circle(knee[0], knee[1], w0 * 0.22, 8), tone: 'metal' }] }),
  ]
  if (gun) out.push(part(`${id}Gun`, thick([[tip[0], tip[1] + 2], [tip[0], tip[1] - 12]], 1.6, 1.2), 'dark', z + 0.15, { details: [eyes([[tip[0], tip[1] - 12]], 0.6)], ...more }))
  return out
}

// --- Strike craft ------------------------------------------------------------------------------------

/**
 * Droid starfighter: a fighting droid that flies. A wedge head with a row of red eyes, a narrow
 * gunmetal neck and body, and two pairs of folding wing-legs bent at the knee, the front pair
 * carrying a blaster at each tip; one engine block at the tail.
 */
export const fighter: ModelDef = () => {
  const parts: Part[] = [
    ...sym(part('body', halfHull([[-26, 3.6], [-14, 5], [4, 5.2], [20, 5.6], [27, 5]]), 'metal', 1, { slope: [-0.5, 0], details: [{ k: 'line', pts: [[0, -8], [-5, -8]] }, { k: 'line', pts: [[0, 6], [-5.2, 6]] }] })),
    ...wingLeg('wingL', [-4, -10], [-25, -15], [-45, -9], 7, 4, 1.5, true),
    ...wingLeg('wingR', [4, -10], [25, -15], [45, -9], 7, 4, 1.5, true).map((p) => ({ ...p, pts: p.pts, slope: p.slope ? ([-p.slope[0], p.slope[1]] as Pt) : undefined })),
    ...wingLeg('legL', [-4, 8], [-23, 15], [-40, 24], 6, 3.2, 1.2, false, { detach: { death: true } }),
    ...wingLeg('legR', [4, 8], [23, 15], [40, 24], 6, 3.2, 1.2, false, { detach: { death: true } }).map((p) => ({ ...p, slope: p.slope ? ([-p.slope[0], p.slope[1]] as Pt) : undefined })),
    engineBlock('engine', 0, 24, 39, 11, 0, 2),
    ...sym(part('head', halfHull([[-49, 1.5], [-46, 5], [-38, 8.4], [-28, 9], [-22, 6.6]]), 'hull', 3, {
      slope: [-0.45, -0.1],
      lift: 1,
      details: [{ k: 'shape', pts: [[-6.5, -30], [-8.6, -30], [-8.4, -25], [-6, -24]], tone: 'accent' }, { k: 'line', pts: [[-2, -47], [-6, -30]] }],
    })),
    part('visor', box(0, -38, 11, 3.2), 'dark', 3.2, { details: [eyes(along([-3.6, -38], [3.6, -38], 3), 1)] }),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Droid bomber: the fighter's heavier cousin. Two armoured hulls side by side with a bomb bay of
 * rust-capped bombs between them, a sensor head with its eyes up front, short wing-legs with
 * blasters and a broad engine block.
 */
export const bomber: ModelDef = () => {
  // One hull's outline, centred on x = 0; the two hulls stand at x = ±17.
  const hull = fullHull([[-40, 3], [-34, 7], [-20, 8.4], [10, 8.6], [28, 7.4], [36, 4.6]])
  const left = halfHull([[-40, 3], [-34, 7], [-20, 8.4], [10, 8.6], [28, 7.4], [36, 4.6]])
  const parts: Part[] = [
    ...wingLeg('legL', [-24, -2], [-36, -8], [-46, -1], 6.4, 3.4, 0.8, true, { detach: { death: true } }),
    ...wingLeg('legR', [24, -2], [36, -8], [46, -1], 6.4, 3.4, 0.8, true, { detach: { death: true } }).map((p) => ({ ...p, slope: p.slope ? ([-p.slope[0], p.slope[1]] as Pt) : undefined })),
    part('frame', rect(-17, -26, 34, 52), 'metal', 1, { details: [{ k: 'line', pts: [[-17, -10], [17, -10]] }, { k: 'line', pts: [[-17, 14], [17, 14]] }] }),
    // The bomb bay between the hulls: a dark well of rust-capped bombs.
    part('bay', rect(-8.6, -22, 17.2, 44), 'dark', 1.5, {
      details: [
        ...[-4.2, 4.2].flatMap((x) => [-15, -5, 5, 15].map((y): Detail => ({ k: 'shape', pts: circle(x, y, 3.2, 10), tone: 'metal' }))),
        ...[-4.2, 4.2].flatMap((x) => [-15, -5, 5, 15].map((y): Detail => ({ k: 'shape', pts: circle(x, y - 0.6, 1.6, 8), tone: 'accent' }))),
        lamps([[-7.6, -20], [7.6, -20], [-7.6, 20], [7.6, 20]], 0.6),
      ],
    }),
    ...[-1, 1].map((s) =>
      part(s < 0 ? 'hullL' : 'hullR', hull.map(([x, y]) => [x + s * 17, y] as Pt), 'hull', 2, {
        lift: 1.4,
        facets: [{ pts: left.map(([x, y]) => [x + s * 17, y] as Pt), slope: [-0.5, 0] }],
        details: [
          { k: 'shape', pts: rect(s * 17 - 8.6, -20, 17.2, 2.4), tone: 'accent' },
          { k: 'shape', pts: rect(s * 17 - 2, 2, 4, 24), tone: s < 0 ? 'hull2' : 'accent' },
          rivets([s * 17 - 6, -12], [s * 17 - 6, 24], 6),
          { k: 'line', pts: [[s * 17 - 8.6, 0], [s * 17 + 8.6, 0]] },
        ],
      }),
    ),
    engineBlock('engine', 0, 26, 44, 22, 0, 2.5),
    part('head', chamfer(0, -34, 16, 16, 4), 'hull2', 3, { lift: 1.2, facets: [{ pts: rect(-8, -42, 8, 16), slope: [-0.45, 0] }], details: [{ k: 'shape', pts: rect(-8, -31, 16, 2), tone: 'accent' }] }),
    part('visor', box(0, -38, 11, 3), 'dark', 3.3, { details: [eyes(along([-3.6, -38], [3.6, -38], 3), 1)] }),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Utility droid: the welder. A blocky blue-grey body in rust hazard stripes, a sensor head with
 * one amber eye, two long manipulator arms reaching forward with welding torches burning at their
 * claws, tool pods on its flanks and an engine block behind.
 */
export const repair: ModelDef = () => {
  const torch = (x: number, y: number): Detail => ({ k: 'lights', pts: [[x, y]], r: 1.1, tone: 'ember' })
  const parts: Part[] = [
    ...sym(part('arm', thick([[-8, -10], [-23, -26], [-18, -44]], 4.2, 2.6), 'metal', 1, { lift: 0.9, detach: { hull: 0.32 }, details: [{ k: 'shape', pts: circle(-23, -26, 2.2, 10), tone: 'dark' }, { k: 'shape', pts: thick([[-10, -12], [-20, -23]], 1.4), tone: 'accent' }] }), { detach: { hull: 0.2 } }),
    ...sym(part('claw', [[-16, -43], [-14.6, -49.6], [-16.8, -47.6], [-18.2, -45], [-20.4, -49], [-21.6, -46.6], [-19.6, -42]], 'dark', 1.2, { detach: { hull: 0.32 }, details: [torch(-18, -47.6)] }), { detach: { hull: 0.2 } }),
    ...sym(part('pod', chamfer(-16, 14, 9, 16, 2.2), 'hull', 1.4, { lift: 1, details: [{ k: 'shape', pts: rect(-20.5, 12, 9, 2), tone: 'accent' }, rivets([-18.4, 8], [-18.4, 20], 4)] })),
    engineBlock('engine', 0, 30, 46, 13, 0, 1.6),
    part('body', chamfer(0, 6, 24, 46, 6), 'hull2', 2, {
      lift: 1.4,
      facets: [{ pts: rect(-12, -17, 12, 46), slope: [-0.45, 0] }],
      details: [
        ...[-10, -2, 6, 14].map((y): Detail => ({ k: 'shape', pts: [[-12, y], [-12, y + 3], [-9, y + 6], [-6, y + 6]], tone: 'accent' })),
        { k: 'shape', pts: rect(-4, -4, 8, 22), tone: 'dark' },
        lamps(along([0, -2], [0, 16], 4), 0.6),
        rivets([8, -12], [8, 24], 7),
      ],
    }),
    part('head', circle(0, -22, 7, 18), 'hull', 3, { sphere: true, details: [{ k: 'shape', pts: box(0, -22, 14, 2.2), tone: 'accent' }] }),
    part('eye', circle(0.8, -24.5, 2.6, 12), 'dark', 3.2, { details: [eyes([[0.8, -24.5]], 1.4)] }),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Guard droid: the foundry's own defense wing. A small three-bladed droid, one blade forward and
 * two raked back, round a ball body with its eye, the blades banded in the defense wing's gold.
 */
export const picket: ModelDef = () => {
  const blade = (id: string, a: Pt, b: Pt, w: number, slope: Pt): Part =>
    part(id, thick([a, b], w, w * 0.32), 'hull', 1, { lift: 0.8, slope, details: [{ k: 'shape', pts: thick([[a[0] * 0.6 + b[0] * 0.4, a[1] * 0.6 + b[1] * 0.4], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]], w * 0.42), tone: 'trim' }, rivets(a, b, 4)] })
  const parts: Part[] = [
    blade('bladeF', [0, -8], [0, -48], 10, [0, -0.3]),
    blade('bladeL', [-6, 4], [-42, 26], 10, [-0.3, 0.1]),
    blade('bladeR', [6, 4], [42, 26], 10, [0.3, 0.1]),
    ...sym(part('gun', thick([[-41, 23], [-41, 10]], 1.8, 1.4), 'dark', 1.4, { detach: { death: true } })),
    engineBlock('engine', 0, 16, 31, 10, 0, 1.5),
    part('ball', circle(0, -2, 11, 22), 'hull2', 2, { sphere: true, details: [{ k: 'shape', pts: box(0, -2, 22, 2.6), tone: 'trim' }] }),
    part('eye', circle(0, -6, 4, 14), 'dark', 2.2, { details: [eyes([[0, -6]], 2)] }),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Gunship -----------------------------------------------------------------------------------------

/**
 * Tri-arm gunship: a heavy droid gunship. A big ball head with one great red eye in a dark visor
 * ring, and three long gunmetal arms at thirds round it, plated and riveted, each ending in a
 * cannon pod with twin barrels. The engine burns behind the head.
 */
export const gunship: ModelDef = ({ h }) => {
  const H = h / 2
  const parts: Part[] = []
  const arms: [Pt, Pt][] = [[[0, -12], [0, -H + 9]], [[-10, 6], [-38.5, 22.4]], [[10, 6], [38.5, 22.4]]]
  arms.forEach(([a, b], i) => {
    const id = ['F', 'L', 'R'][i]
    const dir = Math.atan2(b[1] - a[1], b[0] - a[0])
    const nx = Math.cos(dir)
    const ny = Math.sin(dir)
    parts.push(
      part(`arm${id}`, thick([a, b], 6.6, 5), 'metal', 1, { lift: 0.8, details: [{ k: 'shape', pts: thick([[a[0] + nx * 5, a[1] + ny * 5], [b[0] - nx * 6, b[1] - ny * 6]], 3.6), tone: i === 1 ? 'hull2' : 'hull' }, rivets([a[0] + nx * 6, a[1] + ny * 6], [b[0] - nx * 6, b[1] - ny * 6], 5)] }),
      part(`pod${id}`, turn(box(b[0], b[1], 9, 11), dir + Math.PI / 2, b[0], b[1]), 'hull', 1.5, { lift: 1, detach: { hull: 0.3 }, details: [{ k: 'shape', pts: turn(box(b[0], b[1] + 1, 9, 2), dir + Math.PI / 2, b[0], b[1]), tone: 'accent' }] }),
      part(`podGun${id}`, thick([[b[0] + nx * 3 - ny * 2.2, b[1] + ny * 3 + nx * 2.2], [b[0] + nx * 11 - ny * 2.2, b[1] + ny * 11 + nx * 2.2]], 1.5), 'dark', 1.6, { detach: { death: true } }),
      part(`podGun${id}2`, thick([[b[0] + nx * 3 + ny * 2.2, b[1] + ny * 3 - nx * 2.2], [b[0] + nx * 11 + ny * 2.2, b[1] + ny * 11 - nx * 2.2]], 1.5), 'dark', 1.6, { detach: { death: true } }),
    )
  })
  parts.push(
    engineBlock('engine', 0, 8, 19, 9, 0, 1.8),
    part('head', circle(0, 0, 14, 28), 'hull', 3, { sphere: true, details: [{ k: 'shape', pts: box(0, 4, 28, 2.6), tone: 'accent' }, rivets([-10, 8], [10, 8], 6)] }),
    part('visor', circle(0, -3, 6.6, 18), 'dark', 3.2, { lift: 0.6, details: [{ k: 'shape', pts: circle(0, -3, 4.4, 16), tone: 'metal' }, eyes([[0, -3]], 2.6)] }),
  )
  return { parts, breakStyle: 'bands' }
}

// --- Frigates ----------------------------------------------------------------------------------------

/**
 * Ion frigate: a slim gunmetal spine with plated sections strung along it, and at its nose a great
 * emitter dish with the ion spike glowing in it; the ion cannon sits on a collar just behind. A
 * short sail aft, side vanes, and two engine blocks at the tail.
 */
export const ion: ModelDef = () => {
  const plate = (id: string, y0: number, y1: number, w: number, tone: Tone, z = 2): Part[] =>
    sym(part(id, [[0, y0], [-w * 0.8, y0], [-w, y0 + 2], [-w, y1 - 2], [-w * 0.8, y1], [0, y1]], tone, z, { slope: [-0.5, 0], lift: 1, details: [rivets([-w + 1.2, y0 + 2], [-w + 1.2, y1 - 2], 3), { k: 'shape', pts: rect(-w * 0.62, y0 + 1.5, w * 0.22, y1 - y0 - 3), tone: 'accent' }] }))
  const parts: Part[] = [
    part('spine', rect(-3.4, -40, 6.8, 80), 'metal', 1, { details: [...[-30, -20, -10, 0, 10, 20, 30].map((y): Detail => ({ k: 'line', pts: [[-3.4, y], [3.4, y]] }))] }),
    ...plate('plateA', -34, -17, 10.6, 'hull'),
    ...plate('plateB', -14, -2, 8.4, 'hull2'),
    ...plate('plateC', 3, 17, 7.6, 'hull'),
    ...plate('plateD', 20, 33, 6.8, 'hull2'),
    ...sym(part('vane', [[-6.6, 22], [-11.3, 26], [-11.3, 30], [-6.6, 29]], 'hull', 1.6, { slope: [-0.4, 0], detach: { hull: 0.4 } }), { slope: [0.4, 0], detach: { hull: 0.28 } }),
    sail('sail', 0, 18, 36, 1.8, 3, 5, { detach: { hull: 0.34 } }),
    engineBlock('podL', -6, 35, 49, 5.4, 0, 2, { detach: { hull: 0.16 } }),
    engineBlock('podR', 5.7, 35, 49, 5.4, 1, 2, { detach: { hull: 0.1 } }),
    // The emitter dish: a broad bowl, darker inside, its rim riveted, the ion spike glowing in it.
    part('dish', circle(0, -42.5, 11.3, 28, 6.8), 'hull2', 3, {
      lift: 1.6,
      facets: [{ pts: circle(0, -42.5, 11.3, 28, 6.8).filter(([, y]) => y <= -42.5), slope: [0, 0.4] }],
      details: [{ k: 'shape', pts: circle(0, -42, 8.6, 24, 4.8), tone: 'metal' }, { k: 'shape', pts: circle(0, -41.5, 5, 18, 2.6), tone: 'dark' }, rivets([-10.4, -42.5], [10.4, -42.5], 7)],
    }),
    part('spike', [[0, -49.6], [1.2, -44], [0, -40.4], [-1.2, -44]], 'glow', 3.4, { glow: true, details: [lamps([[0, -44.5]], 1.1)] }),
    mast('mast', [3.4, -12], [8.6, -16], 1, 3.6, { detach: { hull: 0.5 } }),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Bulb frigate: the line frigate. A long blue-grey spine with a big round armoured bulb at the
 * front carrying its prong cannons and shield generator, a tall sail standing down the spine,
 * gun sponsons for the flak, and a boxy engine block of three. A mast and a dish are bolted on one
 * side of the bulb only.
 */
export const frigate: ModelDef = () => {
  const parts: Part[] = [
    ...sym(part('spine', halfHull([[-18, 7.4], [-4, 7], [10, 7.6], [24, 8.6], [34, 10]]), 'hull2', 1, {
      slope: [-0.5, 0],
      details: [rivets([-6.4, -12], [-7.6, 30], 9), ...[-6, 6, 18, 28].map((y): Detail => ({ k: 'line', pts: [[0, y], [-7.8, y]] })), { k: 'shape', pts: rect(-5, 0, 2.2, 10), tone: 'accent' }],
    })),
    ...sym(part('sponson', chamfer(-10.6, 17.3, 9.6, 11, 2.4), 'metal', 1.4, { lift: 1.2, details: [{ k: 'shape', pts: rect(-15.4, 21, 9.6, 1.6), tone: 'accent' }] })),
    ...sym(part('fin', [[-10, 26], [-18.6, 30], [-19.4, 36], [-10.6, 34]], 'hull', 1.2, { slope: [-0.4, 0.1], detach: { hull: 0.3 }, details: [{ k: 'shape', pts: [[-12, 27.5], [-18, 30.4], [-18.4, 32.4], [-12.2, 30]], tone: 'accent' }] }), { slope: [0.4, 0.1], detach: { hull: 0.2 } }),
    engineBlock('block', 0, 34, 41, 24, undefined, 1.5),
    engineBlock('pod0', -9.1, 37, 49.4, 7.2, 0, 2, { detach: { hull: 0.16 } }),
    engineBlock('pod1', -0.2, 37, 50, 7.4, 1, 2),
    engineBlock('pod2', 8.4, 37, 49.4, 7.2, 2, 2, { detach: { hull: 0.1 } }),
    sail('sail', 0, -14, 30, 2.6, 3, 7, { detach: { hull: 0.28 } }),
    // The forward bulb: a heavy armoured ball, its armour bands round it, a rust band at its waist.
    part('bulb', circle(0, -31.5, 18.6, 36), 'hull', 2, {
      sphere: true,
      lift: 2,
      details: [
        { k: 'shape', pts: rect(-18.6, -24, 37.2, 2.6), tone: 'accent' },
        { k: 'line', pts: circle(0, -31.5, 13.6, 30) },
        rivets([-14, -44], [14, -44], 8),
        rivets([-16, -18.4], [16, -18.4], 9),
        eyes([[-3.6, -48.6], [3.6, -48.6]], 0.9),
      ],
    }),
    mast('mast', [-11, -40], [-17.4, -47.4], 1.4, 3, { detach: { hull: 0.5 } }),
    dish('dish', 13.2, -21.6, 3.4, 3, { detach: { hull: 0.38 } }),
  ]
  return { parts, breakStyle: 'bands', mount: (i) => ({ detach: i >= 3 }) }
}

// --- Cruiser -----------------------------------------------------------------------------------------

/**
 * Gun-rank destroyer: a tall narrow warship with a towering sail down its spine and, either side,
 * a long swept gallery of guns, ranks of dark gun ports along it, its heavy cannons and shield
 * generators on the galleries and a fin standing at each tip. The bridge rises aft between two
 * engine blocks, which are shot off with their hardpoints.
 */
export const cruiser: ModelDef = ({ h }) => {
  const H = h / 2
  const gallery: Pt[] = [[-6, -17], [-20, -12.6], [-31, -6.6], [-39, -1], [-47.6, 6.4], [-47.6, 15.6], [-40.6, 14], [-30, 6], [-18, 2.4], [-6, 2.6]]
  const parts: Part[] = [
    ...sym(part('gallery', gallery, 'hull', 1, {
      slope: [-0.25, -0.35],
      lift: 1.6,
      details: [
        { k: 'shape', pts: [[-8, -15], [-20, -11], [-31, -5], [-39, 0.5], [-45, 6.4], [-44.6, 8.6], [-38, 3], [-30, -2.2], [-19.6, -8], [-8, -12]], tone: 'accent' },
        // The gun ranks: rows of dark ports down the gallery.
        ...along([-10, -6], [-26, -1], 5).map(([x, y]): Detail => ({ k: 'shape', pts: rect(x - 1.1, y - 0.7, 2.2, 1.4), tone: 'dark' })),
        ...along([-16, 1], [-36, 8], 6).map(([x, y]): Detail => ({ k: 'shape', pts: rect(x - 1.1, y - 0.7, 2.2, 1.4), tone: 'dark' })),
        rivets([-9, -13], [-44, 4], 9),
      ],
    }), { slope: [0.25, -0.35] }),
    ...sym(sail('tipFin', -46, 3, 19, 1.6, 2, 5, { detach: { hull: 0.3 } }), { detach: { hull: 0.2 } }),
    engineBlock('podL', -5.3, 18, H - 0.2, 7, 0, 1.6, { detach: { hp: 6 } }),
    engineBlock('podR', 5.2, 18, H - 0.2, 7, 1, 1.6, { detach: { hp: 7 } }),
    ...sym(part('spine', halfHull([[-H, 1], [-28, 3.8], [-18, 6], [0, 6.6], [16, 6.4], [24, 4.6]]), 'hull2', 2, {
      slope: [-0.5, 0],
      details: [{ k: 'shape', pts: [[-1.6, -28], [-3, -28], [-4, -12], [-1.6, -12]], tone: 'accent' }, ...[-20, -6, 8].map((y): Detail => ({ k: 'line', pts: [[0, y], [-6.4, y]] })), rivets([-5, -24], [-5.6, 20], 7)],
    })),
    sail('sail', 0, -26, 16, 2.4, 3, 7),
    part('bridge', chamfer(0, 15.6, 10, 9, 2.2), 'hull', 3.5, { lift: 2.4, facets: [{ pts: rect(-5, 11, 5, 9), slope: [-0.5, 0] }], details: [eyes(along([-3, 12.4], [3, 12.4], 4), 0.6), { k: 'shape', pts: rect(-5, 17, 10, 1.4), tone: 'accent' }] }),
    mast('mast', [2, 12], [6, 5], 1, 4, { detach: { hull: 0.5 } }),
    dish('dish', -16, -9, 2.6, 2.2, { detach: { hull: 0.4 } }),
  ]
  // The two lighter guns on the galleries are flak-sized: they blow off like flak.
  return { parts, breakStyle: 'bands', mount: (i) => ({ detach: i === 2 || i === 3 }) }
}

// --- Flagship ----------------------------------------------------------------------------------------

/** The flagship's two designs: the battle uses CAPITAL_DESIGN; the Codex shows both. */
export type CapitalDesign = 'ring' | 'carrier'
export const CAPITAL_DESIGNS: CapitalDesign[] = ['ring', 'carrier']
export const CAPITAL_DESIGN: CapitalDesign = 'ring'

/** A band of an ellipse between an outer and an inner one, from angle a0 to a1 (radians, y down). */
function ellBand(cx: number, cy: number, rxo: number, ryo: number, rxi: number, ryi: number, a0: number, a1: number, n = 10): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    out.push([cx + Math.cos(a) * rxo, cy + Math.sin(a) * ryo])
  }
  for (let i = n; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / n
    out.push([cx + Math.cos(a) * rxi, cy + Math.sin(a) * ryi])
  }
  return out
}

/**
 * The droid flagship and carrier, in two designs on the same hardpoints. `ring` (the battle's): a
 * great ring hull open at the front, hangar bays as dark slots all round its inner face, and in its
 * middle a core sphere carrying the heavy guns and shield generators, joined to the ring by spokes,
 * docking-bay gaps between them; four engine blocks at the back. When it dies the core comes away
 * whole and the ring breaks into segments. `carrier`: a broad carrier with rows of hangar slots
 * down its flanks, a bulbous forward pod and a tall sail with the bridge on it.
 */
export const capital: ModelDef = ({ style }) => (style === 'carrier' ? carrierDesign() : ringDesign())

function ringDesign() {
  const cx = 0
  const cy = -2
  const [rxo, ryo, rxi, ryi] = [36.4, 45.4, 19, 25]
  const D = Math.PI / 180
  const gap = 11 * D
  const top = -90 * D
  // Six segments of the ring from one side of the front gap round to the other, each lit as it
  // faces (its plating slopes outward).
  const span = (Math.PI * 2 - gap * 2) / 6
  const parts: Part[] = []
  for (let i = 0; i < 6; i++) {
    const a0 = top + gap + span * i
    const a1 = a0 + span
    const mid = (a0 + a1) / 2
    const slots: Detail[] = []
    for (let k = 0; k < 3; k++) {
      const a = a0 + (span * (k + 0.5)) / 3
      const x = cx + Math.cos(a) * (rxi + 2.6)
      const y = cy + Math.sin(a) * (ryi + 2.6)
      slots.push({ k: 'shape', pts: turn(box(x, y, 4.6, 2.2), a + Math.PI / 2, x, y), tone: 'dark' })
    }
    parts.push(part(`ring${i}`, ellBand(cx, cy, rxo, ryo, rxi, ryi, a0, a1, 8), i % 2 ? 'hull' : 'hull2', 1, {
      lift: 2.4,
      slope: [Math.cos(mid) * 0.42, Math.sin(mid) * 0.42],
      details: [
        ...slots,
        { k: 'lights', pts: [0.2, 0.5, 0.8].map((t) => { const a = a0 + span * t; return [cx + Math.cos(a) * (rxi + 2.6), cy + Math.sin(a) * (ryi + 2.6)] as Pt }), r: 0.5 },
        { k: 'shape', pts: ellBand(cx, cy, rxo - 2.4, ryo - 2.4, rxo - 5, ryo - 5, a0 + span * 0.15, a1 - span * 0.15, 6), tone: 'accent' },
        { k: 'line', pts: [[cx + Math.cos(a1) * rxi, cy + Math.sin(a1) * ryi], [cx + Math.cos(a1) * rxo, cy + Math.sin(a1) * ryo]] },
      ],
    }))
  }
  // The jaws either side of the front gap: heavy blocks with docking lights, shot off as it dies.
  for (const s of [-1, 1]) {
    const a = top - s * gap
    const x = cx + Math.cos(a) * (rxo + rxi) * 0.5
    const y = cy + Math.sin(a) * (ryo + ryi) * 0.5
    parts.push(part(s < 0 ? 'jawL' : 'jawR', turn(chamfer(x, y - 2, 10, 9, 2), s * 0.25, x, y), 'metal', 1.6, { lift: 1.4, detach: { hull: s < 0 ? 0.3 : 0.2 }, details: [lamps([[x, y - 5]], 0.6), eyes([[x + s * 2.4, y - 4]], 0.6)] }))
  }
  parts.push(
    // Spokes from the core out to the ring: left, right and back, docking bays between them.
    part('spokeL', rect(-21, 2, 8, 6), 'metal', 0.8, { details: [{ k: 'line', pts: [[-21, 5], [-13, 5]] }] }),
    part('spokeR', rect(13, 2, 8, 6), 'metal', 0.8, { details: [{ k: 'line', pts: [[13, 5], [21, 5]] }] }),
    part('spokeB', rect(-4, 18, 8, 7), 'metal', 0.8),
    engineBlock('block', 0, 38, 45, 30, undefined, 1.2),
    engineBlock('pod0', -9.9, 39, 49, 5.6, 0, 1.4, { detach: { hull: 0.16 } }),
    engineBlock('pod1', -3.6, 40, 50, 5.6, 1, 1.4),
    engineBlock('pod2', 3.2, 40, 50, 5.6, 2, 1.4),
    engineBlock('pod3', 9.7, 39, 49, 5.6, 3, 1.4, { detach: { hull: 0.1 } }),
    // The core sphere, its armour seams and rust equator, red eyes round its crown.
    part('core', circle(0, 5, 14.6, 36), 'hull', 2, {
      sphere: true,
      details: [{ k: 'shape', pts: rect(-14.6, 9.6, 29.2, 2.2), tone: 'accent' }, { k: 'line', pts: circle(0, 5, 10.4, 28) }, rivets([-11, 0], [11, 0], 7), eyes(along([-5, -8.2], [5, -8.2], 4), 0.6)],
    }),
    part('tower', chamfer(0, -6.5, 6, 6, 1.4), 'hull2', 2.6, { lift: 1.2, details: [eyes([[0, -8]], 0.7)] }),
    mast('mastC', [0, -9], [0, -16], 0.9, 2.8, { detach: { hull: 0.55 } }),
    mast('mastL', [-34, 6], [-37, -2], 1.2, 2.8, { detach: { hull: 0.45 } }),
    dish('dish', 31, 22, 3, 2.8, { detach: { hull: 0.38 } }),
  )
  return { parts, breakStyle: 'ring' as const, core: { x: 0, y: 5, r: 16.5 } }
}

function carrierDesign() {
  const rows: [number, number][] = [[-50, 3], [-46, 9], [-40, 16.6], [-30, 23.6], [-18, 29.6], [-6, 32.4], [10, 32.4], [26, 30.6], [38, 27], [44, 20]]
  const slots = (x0: number, x1: number, y0: number, y1: number, n: number): Detail[] =>
    along([0, y0], [0, y1], n).flatMap(([, y]) => [{ k: 'shape' as const, pts: rect(x0, y - 1.2, x1 - x0, 2.4), tone: 'dark' as const }, { k: 'lights' as const, pts: [[(x0 + x1) / 2, y] as Pt], r: 0.45 }])
  const parts: Part[] = [
    ...sym(part('hull', halfHull(rows), 'hull', 0, {
      slope: [-0.5, 0.05],
      details: [
        { k: 'shape', pts: [...rows.slice(2, 9).map(([y, w]) => [-w, y] as Pt), ...rows.slice(2, 9).map(([y, w]) => [-w + 2.4, y + 0.4] as Pt).reverse()], tone: 'accent' },
        // Rows of hangar slots down each flank.
        ...slots(-28, -20, -8, 32, 8),
        ...slots(-17.6, -11, 22, 34, 3),
        rivets([-12, -30], [-29, 22], 10),
      ],
    })),
    ...sym(part('deck', halfHull([[-30, 4], [-20, 9], [0, 11.6], [22, 11], [32, 8]]), 'hull2', 1, { slope: [-0.45, 0], lift: 2, details: [rivets([-8, -18], [-10, 26], 8), { k: 'line', pts: [[0, 6], [-11, 6]] }] })),
    ...sym(part('fin', [[-27, 34], [-35.4, 36], [-35.6, 44], [-25, 42]], 'hull2', 0.8, { slope: [-0.4, 0.1], detach: { hull: 0.3 } }), { slope: [0.4, 0.1], detach: { hull: 0.2 } }),
    engineBlock('block', 0, 37, 45, 30, undefined, 1.2),
    engineBlock('pod0', -9.9, 38, 49, 5.6, 0, 1.4, { detach: { hull: 0.16 } }),
    engineBlock('pod1', -3.6, 39, 50, 5.6, 1, 1.4),
    engineBlock('pod2', 3.2, 39, 50, 5.6, 2, 1.4),
    engineBlock('pod3', 9.7, 38, 49, 5.6, 3, 1.4, { detach: { hull: 0.1 } }),
    part('pod', circle(0, -41.6, 8.4, 24), 'hull2', 2, { sphere: true, details: [{ k: 'shape', pts: rect(-8.4, -40, 16.8, 1.8), tone: 'accent' }, eyes(along([-3, -47], [3, -47], 3), 0.6)] }),
    sail('sail', 0, -2, 32, 2.6, 3, 7, { detach: { hull: 0.3 } }),
    part('bridge', chamfer(0, 28, 9, 8, 2), 'hull', 3.5, { lift: 2.4, details: [eyes(along([-2.6, 25.6], [2.6, 25.6], 3), 0.6)] }),
    mast('mast', [-4, 24], [-9, 17], 1, 3.6, { detach: { hull: 0.5 } }),
    dish('dish', 22, -26, 3, 2, { detach: { hull: 0.38 } }),
  ]
  return { parts, breakStyle: 'bands' as const }
}

// --- Station -----------------------------------------------------------------------------------------

/**
 * Droid control station: built round a central sphere. Level 1 is the sphere core on an octagonal
 * deck plate, its red eyes round its crown. Level 2 adds two arcs of a ring above and below and
 * docking arms out to the sides, the repair dock on the lower arm. Level 3 closes the ring, hangs four
 * hangar segments on it, and runs struts out to gun pods. Level 4 puts an outer frame round it all
 * joining every gun tower, with antenna spires at its top and bottom. Coordinates are frame pixels
 * from the frame's centre, where data.ts places the modules.
 */
export const station: ModelDef = ({ level }) => {
  const parts: Part[] = []
  const D = Math.PI / 180
  const R = 380
  const BAND = 64
  const arc = (a0: number, a1: number) => ellBand(0, 0, R + BAND / 2, R + BAND / 2, R - BAND / 2, R - BAND / 2, a0, a1, 14)
  /** A round gun pod on a strut out from the ring (from `from`), where a module sits. */
  const pod = (id: string, at: Pt, r: number, from: Pt | null, z: number) => {
    if (from) parts.push(part(`${id}Strut`, thick([from, at], 34, 28), 'metal', z - 0.2, { lift: 2, details: [{ k: 'line', pts: [from, at] }] }))
    parts.push(part(id, circle(at[0], at[1], r, 24), 'hull2', z, {
      lift: 4,
      facets: [{ pts: circle(at[0], at[1], r, 24).filter(([x]) => x <= at[0]), slope: [-0.4, 0] }],
      details: [{ k: 'shape', pts: circle(at[0], at[1], r * 0.86, 22), tone: 'accent' }, { k: 'shape', pts: circle(at[0], at[1], r * 0.76, 20), tone: 'hull2' }, rivets([at[0] - r * 0.6, at[1] + r * 0.62], [at[0] + r * 0.6, at[1] + r * 0.62], 5)],
    }))
  }
  const onRing = (p: Pt): Pt => {
    const l = Math.hypot(p[0], p[1])
    return [(p[0] / l) * R, (p[1] / l) * R]
  }

  // --- Level 4: the outer frame joining the gun towers, and the spires ------------------------
  if (level >= 4) {
    const towers: Pt[] = [[0, -457], [226, -352], [473, -222], [481, 233], [229, 401], [0, 463], [-229, 401], [-481, 233], [-473, -222], [-226, -352]]
    for (let i = 0; i < towers.length; i++) {
      const a = towers[i]
      const b = towers[(i + 1) % towers.length]
      parts.push(part(`frame${i}`, thick([a, b], 40), 'hull2', 0.6, { lift: 3, slope: [((a[0] + b[0]) / Math.hypot(a[0] + b[0], a[1] + b[1])) * 0.4, ((a[1] + b[1]) / Math.hypot(a[0] + b[0], a[1] + b[1])) * 0.4], details: [{ k: 'line', pts: [a, b] }, rivets([a[0] * 0.8 + b[0] * 0.2, a[1] * 0.8 + b[1] * 0.2], [a[0] * 0.2 + b[0] * 0.8, a[1] * 0.2 + b[1] * 0.8], 5)] }))
    }
    for (const s of [-1, 1]) parts.push(part(s < 0 ? 'spireT' : 'spireB', thick([[0, s * 500], [0, s * 562]], 22, 8), 'dark', 4.5, { lift: 3, details: [eyes([[0, s * 560]], 7), eyes([[0, s * 528]], 5)] }))
    for (const [i, p] of ([[226, -352], [-226, -352], [229, 401], [-229, 401], [481, 233], [-481, 233]] as Pt[]).entries()) pod(`tower${i}`, p, i < 2 ? 54 : 62, onRing(p), 3.2)
  }

  // --- Level 3: the ring closed, hangar segments, struts to the gun pods ---------------------
  if (level >= 3) {
    parts.push(part('ringS', arc(-40 * D, 40 * D), 'hull', 1, { lift: 4, slope: [0.4, 0], details: [{ k: 'shape', pts: ellBand(0, 0, R + 8, R + 8, R - 8, R - 8, -30 * D, 30 * D, 10), tone: 'accent' }] }))
    parts.push(part('ringN', arc(140 * D, 220 * D), 'hull', 1, { lift: 4, slope: [-0.4, 0], details: [{ k: 'shape', pts: ellBand(0, 0, R + 8, R + 8, R - 8, R - 8, 150 * D, 210 * D, 10), tone: 'accent' }] }))
    for (const [i, a] of [45, 135, 225, 315].entries()) {
      const c: Pt = [Math.cos(a * D) * R, Math.sin(a * D) * R]
      const seg = turnPart(part(`hangar${i}`, chamfer(c[0], c[1], 150, 110, 18), 'hull2', 2, {
        lift: 5,
        facets: [{ pts: rect(c[0] - 75, c[1] - 55, 150, 22), slope: [0, -0.45] }],
        details: [...[-48, -16, 16, 48].map((x): Detail => ({ k: 'shape', pts: rect(c[0] + x - 12, c[1] - 8, 24, 30), tone: 'dark' })), { k: 'lights', pts: [-48, -16, 16, 48].map((x) => [c[0] + x, c[1] + 18] as Pt), r: 4 }, rivets([c[0] - 64, c[1] - 40], [c[0] + 64, c[1] - 40], 9)],
      }), (a + 90) * D, c[0], c[1])
      parts.push(seg)
    }
    for (const [i, p] of ([[0, -457], [0, 463], [473, -222], [-473, -222], [-481, 233], [481, 233]] as Pt[]).entries()) {
      if (i >= 4 && level >= 4) continue
      pod(`pod${i}`, p, i < 2 ? 56 : 62, onRing(p), 3)
    }
  }

  // --- Level 2: the ring's upper and lower arcs, docking arms to the sides --------------------
  if (level >= 2) {
    parts.push(part('ringT', arc(-140 * D, -40 * D), 'hull', 1, { lift: 4, slope: [0, -0.4], details: [{ k: 'shape', pts: ellBand(0, 0, R + 8, R + 8, R - 8, R - 8, -128 * D, -52 * D, 12), tone: 'accent' }, { k: 'lights', pts: [-120, -105, -90, -75, -60].map((a) => [Math.cos(a * D) * (R - 22), Math.sin(a * D) * (R - 22)] as Pt), r: 5 }] }))
    parts.push(part('ringB', arc(40 * D, 140 * D), 'hull', 1, { lift: 4, slope: [0, 0.4], details: [{ k: 'shape', pts: ellBand(0, 0, R + 8, R + 8, R - 8, R - 8, 52 * D, 128 * D, 12), tone: 'accent' }, { k: 'lights', pts: [120, 105, 90, 75, 60].map((a) => [Math.cos(a * D) * (R - 22), Math.sin(a * D) * (R - 22)] as Pt), r: 5 }] }))
    // Arms: up and down to the ring (the lower one carries the repair dock), and out to the sides
    // to docking clamps where the ring will close.
    parts.push(part('armT', rect(-46, -R, 92, R - 230), 'metal', 1.5, { lift: 3, details: [{ k: 'line', pts: [[0, -R], [0, -230]] }, rivets([-34, -360], [-34, -250], 5)] }))
    parts.push(part('armB', rect(-62, 230, 124, R - 230), 'metal', 1.5, { lift: 3, details: [{ k: 'line', pts: [[0, 230], [0, R]] }, rivets([48, 250], [48, 360], 5)] }))
    for (const s of [-1, 1]) {
      parts.push(part(s < 0 ? 'armL' : 'armR', rect(s < 0 ? -400 : 200, -30, 200, 60), 'metal', 1.5, { lift: 3, details: [{ k: 'line', pts: [[s * 200, 0], [s * 400, 0]] }] }))
      parts.push(part(s < 0 ? 'clampL' : 'clampR', chamfer(s * 380, 0, 56, 120, 14), 'hull2', 2.2, { lift: 5, details: [{ k: 'shape', pts: rect(s * 380 - 28, -10, 56, 20), tone: 'accent' }, eyes([[s * 380, -46], [s * 380, 46]], 5)] }))
    }
    parts.push(part('collar', circle(0, 0, 186, 48), 'metal', 3.6, { holes: [circle(0, 0, 156, 48)], lift: 3, details: [{ k: 'lights', pts: Array.from({ length: 12 }, (_, i) => [Math.cos((i * 30 + 15) * D) * 171, Math.sin((i * 30 + 15) * D) * 171] as Pt), r: 5 }] }))
  }

  // --- Level 1: the sphere core on its deck plate -----------------------------------------------
  const oct = (hw: number, hh: number, c: number): Pt[] => [[-hw + c, -hh], [hw - c, -hh], [hw, -hh + c], [hw, hh - c], [hw - c, hh], [-hw + c, hh], [-hw, hh - c], [-hw, -hh + c]]
  parts.push(part('plate', oct(212, 272, 76), 'hull2', 3, {
    lift: 3,
    facets: [{ pts: [[-212, -196], [-136, -272], [136, -272], [212, -196], [0, 0]], slope: [0, -0.35] }],
    details: [
      { k: 'shape', pts: oct(196, 256, 70), tone: 'metal' },
      { k: 'shape', pts: oct(180, 240, 64), tone: 'hull2' },
      ...[-1, 1].flatMap((s): Detail[] => [{ k: 'shape', pts: [[s * 150, -40], [s * 180, -40], [s * 180, 40], [s * 150, 40]], tone: 'accent' }, { k: 'shape', pts: rect(-30, s * 222 - 6, 60, 12), tone: 'accent' }]),
      rivets([-170, -150], [-170, 150], 9),
      rivets([170, -150], [170, 150], 9),
      { k: 'line', pts: [[-212, 0], [212, 0]] },
      { k: 'line', pts: [[0, -272], [0, 272]] },
    ],
  }))
  parts.push(part('sphere', circle(0, 0, 150, 56), 'hull', 4, {
    sphere: true,
    details: [
      { k: 'shape', pts: rect(-150, 26, 300, 18), tone: 'accent' },
      { k: 'line', pts: circle(0, 0, 108, 44) },
      { k: 'line', pts: [[-150, -28], [150, -28]] },
      { k: 'line', pts: [[0, -150], [0, -28]] },
      rivets([-104, 64], [104, 64], 13),
      eyes(Array.from({ length: 9 }, (_, i) => [Math.cos((-170 + i * 20) * D) * 128, Math.sin((-170 + i * 20) * D) * 128] as Pt), 7),
    ],
  }))
  parts.push(mast('mast', [-96, -110], [-150, -200], 14, 5, { detach: { hull: 0.3 } }))
  return { parts, breakStyle: 'ring', core: { x: 0, y: 0, r: 158 } }
}

// --- Structures on the ore ---------------------------------------------------------------------------

/** Four clamp legs bitten into the asteroid at the corners: gunmetal girders with a dark claw each,
 * drawn for the top-left one and mirrored to the others. */
function clamps(x0: number, y0: number, x1: number, y1: number, z: number): Part[] {
  const out: Part[] = []
  for (const [sx, sy, n] of [[1, 1, 0], [-1, 1, 1], [1, -1, 2], [-1, -1, 3]] as const) {
    const a: Pt = [x0 * sx, y0 * sy]
    const b: Pt = [x1 * sx, y1 * sy]
    out.push(part(`leg${n}`, thick([a, b], 6, 4.6), 'metal', z, { lift: 1.2, details: [rivets(a, b, 3)] }))
    out.push(part(`claw${n}`, [[b[0] - 4 * sx, b[1]], [b[0], b[1] - 4 * sy], [b[0] + 3.4 * sx, b[1] + 1.4 * sy], [b[0] + 1.4 * sx, b[1] + 3.4 * sy]], 'dark', z + 0.1, { lift: 0.6 }))
  }
  return out
}

/**
 * Droid ore extractor: an industrial rig. Two drill housings on a gunmetal girder deck, a hub with
 * the ore silo, a landing block on top (where the shield dome goes) and a gun box below, an
 * antenna mast and a loading crane bolted on, clamped to its asteroid at the corners.
 */
export const mine: ModelDef = ({ h }) => {
  const padY = (1.6 / 10 - 0.5) * h
  const pdY = (7.9 / 10 - 0.5) * h
  const parts: Part[] = [
    ...clamps(-20, -14, -44, -40, 0),
    part('deck', chamfer(0, 0, 96, 26, 6), 'metal', 1, { lift: 1.4, details: [{ k: 'line', pts: [[-46, 0], [46, 0]] }, rivets([-40, -9], [40, -9], 12), rivets([-40, 9], [40, 9], 12)] }),
    part('neck', rect(-7, padY + 8, 14, -padY - 8 + pdY - 6), 'metal', 1, { lift: 1.2 }),
    ...sym(part('housing', chamfer(-32, 0, 40, 40, 9), 'hull', 2, {
      lift: 2.6,
      facets: [{ pts: rect(-52, -20, 40, 10), slope: [0, -0.4] }],
      details: [
        ...[0, 1, 2, 3].map((k): Detail => ({ k: 'shape', pts: [[-52 + k * 10, 20], [-46 + k * 10, 20], [-42 + k * 10, 16], [-48 + k * 10, 16]], tone: 'accent' })),
        rivets([-48, -16], [-16, -16], 7),
        eyes([[-50, 0]], 1),
      ],
    })),
    part('pad', chamfer(0, padY, 30, 22, 5), 'hull2', 2, { lift: 2, details: [{ k: 'shape', pts: chamfer(0, padY, 22, 14, 3), tone: 'dark' }, ...[-1, 1].map((s): Detail => ({ k: 'shape', pts: rect(s * 9 - 1.5, padY - 5, 3, 10), tone: 'accent' })), { k: 'lights', pts: [[-13, padY - 9], [13, padY - 9]], r: 0.8 }] }),
    part('gunbox', chamfer(0, pdY, 18, 15, 3), 'hull', 2, { lift: 2, details: [{ k: 'shape', pts: rect(-9, pdY + 4, 18, 2), tone: 'accent' }] }),
    part('hub', chamfer(0, 0, 22, 22, 5), 'hull2', 3, { lift: 2.6, details: [{ k: 'line', pts: chamfer(0, 0, 16, 16, 3.6) }] }),
    part('crane', thick([[12, 10], [22, 24], [16, 32]], 3, 2), 'dark', 3.2, { lift: 2, detach: { hull: 0.45 } }),
    mast('mast', [-12, -10], [-20, -30], 2.2, 3.4, { detach: { hull: 0.5 } }),
  ]
  return { parts, breakStyle: 'pie' }
}

/**
 * Droid defense platforms (balanced, flak and gun share one deck): an octagonal gunmetal deck in
 * rust hazard bands, box pods at its corners on girders, side pods and a heavy central hub, antenna
 * masts bolted on at odd corners, clamped to the asteroid. The flak platform stacks ammunition
 * crates by its pods; the gun platform carries capacitor towers.
 */
export const defense: ModelDef = ({ t, h }) => {
  const kind = t.id.endsWith('flak') ? 'flak' : t.id.endsWith('gun') ? 'gun' : 'balanced'
  const cy = (5.1 / 10 - 0.5) * h
  const corners: Pt[] = [[-24, (3 / 10 - 0.5) * h], [24, (3 / 10 - 0.5) * h], [-24, (7.3 / 10 - 0.5) * h], [24, (7.3 / 10 - 0.5) * h]]
  const oct = (r: number, c: number, y = cy): Pt[] => [[-r + c, y - r], [r - c, y - r], [r, y - r + c], [r, y + r - c], [r - c, y + r], [-r + c, y + r], [-r, y + r - c], [-r, y - r + c]]
  const parts: Part[] = [
    ...clamps(-30, -30, -46, -46, 0),
    part('deck', oct(45, 15), 'metal', 1, {
      lift: 2,
      details: [
        { k: 'shape', pts: oct(40, 13), tone: 'hull2' },
        ...[0, 1, 2, 3].map((s): Detail => ({ k: 'shape', pts: turn(rect(-12, -42, 24, 3.4), (s * Math.PI) / 2, 0, cy).map(([x, y]) => [x, y + cy] as Pt), tone: 'accent' })),
        rivets([-30, cy - 36], [30, cy - 36], 10),
        rivets([-30, cy + 36], [30, cy + 36], 10),
      ],
    }),
    ...corners.map(([x, y], i) => part(`girder${i}`, thick([[x * 0.4, cy + (y - cy) * 0.4], [x, y]], 7), 'metal', 1.5, { lift: 1.4 })),
    ...corners.map(([x, y], i) => part(`pod${i}`, chamfer(x, y, 19, 19, 3.6), 'hull', 2.5, { lift: 3, facets: [{ pts: rect(x - 9.5, y - 9.5, 19, 5), slope: [0, -0.4] }], details: [{ k: 'shape', pts: rect(x - 9.5, y + (y < cy ? 7 : -9), 19, 2), tone: 'accent' }] })),
    ...sym(part('side', chamfer(-41, 0, 12, 18, 3), 'hull2', 2.6, { lift: 3, details: [{ k: 'shape', pts: rect(-47, -1, 3, 2), tone: 'accent' }] })),
    part('hub', chamfer(0, cy, 38, 38, 9), 'hull', 3, {
      lift: 3.4,
      facets: [{ pts: [[-19, cy - 10], [-10, cy - 19], [10, cy - 19], [19, cy - 10], [0, cy]], slope: [0, -0.4] }],
      details: [{ k: 'shape', pts: chamfer(0, cy, 34, 34, 8), tone: 'accent' }, { k: 'shape', pts: chamfer(0, cy, 30, 30, 7), tone: 'hull' }],
    }),
    mast('mastA', [33, cy - 33], [40, cy - 46], 2, 3.2, { detach: { hull: 0.5 } }),
  ]
  if (kind === 'flak')
    corners.forEach(([x, y], i) => parts.push(part(`crate${i}`, rect(x + (x < 0 ? 8 : -13), y + (y < cy ? 8 : -13), 5, 5), 'accent', 3, { lift: 1, details: [{ k: 'line', pts: [[x + (x < 0 ? 8 : -13), y + (y < cy ? 10.5 : -10.5)], [x + (x < 0 ? 13 : -8), y + (y < cy ? 10.5 : -10.5)]] }] })))
  if (kind === 'gun')
    for (const s of [-1, 1]) parts.push(part(`cap${s < 0 ? 'T' : 'B'}`, chamfer(0, cy + s * 37, 16, 8, 2), 'dark', 3, { lift: 2.4, details: [lamps(along([-5, cy + s * 37], [5, cy + s * 37], 3), 1)] }))
  if (kind === 'balanced') parts.push(dish('dish', -34, cy + 30, 4, 3.2, { detach: { hull: 0.4 } }))
  return { parts, breakStyle: 'pie' }
}
