import { along, box, capsule, chamfer, circle, halfHull, part, rect, rounded, sym } from '../kit.ts'
import type { ModelDef } from '../spec.ts'
import type { Part, Pt } from '../types.ts'
import { coreModule, defensePod, enginePod, habitat, mast, truss } from './style.ts'

// The Republic's style kit: angular wedges and chamfered blocks, off-white plating with deep red
// bands, grey machinery, blue windows and engine light. Hulls are split down the middle into two
// facets, so one side catches the light while the other falls into shadow as the ship turns.

/**
 * Lance interceptor: a needle-nosed clone fighter with cranked delta wings, red wing edges,
 * cannons on the tips and one big engine. The outer wing panels break off as it takes damage,
 * and the hull comes apart in three when it dies.
 */
export const fighter: ModelDef = () => {
  const fuse: Pt[] = [[0, -50], [-2.6, -40], [-5, -24], [-7, -6], [-7.6, 10], [-7, 28], [-5.5, 38], [0, 39]]
  const wingIn: Pt[] = [[-5.5, -9], [-14, 9], [-25, 19.5], [-26, 34], [-6.5, 39]]
  const tip: Pt[] = [[-25, 19.5], [-33.5, 27.5], [-35, 34], [-26, 34]]
  const parts: Part[] = [
    ...sym(part('wing', wingIn, 'hull', 1, {
      slope: [-0.35, 0.1],
      details: [
        { k: 'shape', pts: [[-14, 9], [-25, 19.5], [-25.3, 23], [-14.5, 13.5], [-7, 3]], tone: 'accent' },
        { k: 'shape', pts: [[-11, 20], [-20, 26], [-19, 31], [-10, 27]], tone: 'metal' },
        { k: 'line', pts: [[-8, 2], [-25, 28]] },
        { k: 'line', pts: [[-7, 33], [-25, 31]] },
      ],
    }), { slope: [0.35, 0.1] }),
    ...sym(part('tip', tip, 'hull', 1, {
      slope: [-0.35, 0.1],
      detach: { hull: 0.42 },
      details: [{ k: 'shape', pts: [[-25, 19.5], [-33.5, 27.5], [-34, 30], [-25.3, 23]], tone: 'accent' }],
    }), { slope: [0.35, 0.1], detach: { hull: 0.26 } }),
    // Wing-tip cannons, riding on the tips (and lost with them).
    ...sym(part('gun', [[-31.6, 14], [-30.4, 14], [-30.2, 31], [-31.8, 31]], 'dark', 2, { detach: { hull: 0.42 }, details: [{ k: 'shape', pts: box(-31, 15, 1.6, 2), tone: 'metal' }] }), { detach: { hull: 0.26 } }),
    ...sym(part('strake', [[-5, -27], [-12.5, -14], [-12, -10], [-6, -13]], 'hull2', 1, { slope: [-0.3, 0], detach: { death: true } })),
    ...sym(part('fuse', fuse, 'hull', 2, {
      slope: [-0.5, 0],
      details: [
        { k: 'shape', pts: [[0, -50], [-1.4, -42], [-1.6, -29], [0, -27]], tone: 'accent' },
        { k: 'shape', pts: [[-5.5, 2], [-7.2, 2], [-7.2, 16], [-5.5, 16]], tone: 'dark' },
        { k: 'line', pts: [[-3.5, -32], [-6.8, -2]] },
        { k: 'line', pts: [[0, 22], [-7.2, 22]] },
      ],
    })),
    // The dorsal spine with the astromech socket behind the cockpit.
    ...sym(part('spine', [[0, -7], [-2.4, -6], [-3.2, 28], [0, 29]], 'hull2', 3, {
      slope: [-0.4, 0],
      lift: 0.8,
      details: [
        { k: 'shape', pts: [[0, 14], [-1, 14], [-1, 27], [0, 27]], tone: 'accent' },
        { k: 'line', pts: [[-3, 20], [0, 20]] },
      ],
    })),
    part('droid', circle(0, 5, 2.5, 14), 'metal', 4, { sphere: true, details: [{ k: 'lights', pts: [[0.4, 4.4]], r: 0.7 }] }),
    part('cockpit', [[0, -27], [2.9, -21], [3.3, -13], [2, -7.5], [-2, -7.5], [-3.3, -13], [-2.9, -21]], 'glass', 4, {
      lift: 0.9,
      details: [{ k: 'shape', pts: [[-0.6, -24], [-2.2, -19], [-2.4, -14], [-1.4, -14], [-1, -20]], tone: 'glow' }],
    }),
    enginePod('engine', 0, 28, 46, 10, 0, 3),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Shared Republic parts ---------------------------------------------------------------------------

/** A painted ball turret (strike craft and gunships carry their guns on the hull, not on hardpoints):
 * a ball with twin barrels pointing forward. */
export function ballTurret(id: string, x: number, y: number, r: number, z: number, more: Partial<Part> = {}): Part[] {
  return [
    part(`${id}Gun`, box(x - r * 0.32, y - r * 1.25, r * 0.26, r * 1.6), 'dark', z, more),
    part(`${id}Gun2`, box(x + r * 0.32, y - r * 1.25, r * 0.26, r * 1.6), 'dark', z, more),
    part(id, circle(x, y, r, 18), 'hull2', z + 0.1, { sphere: true, details: [{ k: 'shape', pts: box(x, y, r * 2, r * 0.36), tone: 'accent' }, { k: 'lights', pts: [[x, y - r * 0.45]], r: r * 0.16, tone: 'glass' }], ...more }),
  ]
}

// --- Strike craft ------------------------------------------------------------------------------------

/**
 * Hammer bomber: a blunt, armoured twin-engine bomber. A wide fuselage with a long dark bomb bay down
 * its back edged in hazard lights, a broad canopy, two heavy engine nacelles and short straight wings
 * carrying torpedo racks. Wide and slow-looking where the Lance is a needle.
 */
export const bomber: ModelDef = () => {
  const fuse = halfHull([[-48, 3], [-45, 6.5], [-38, 9], [-26, 10.5], [-8, 11], [10, 10.5], [28, 8], [40, 5.5], [44, 3]])
  const parts: Part[] = [
    ...sym(part('wing', [[-9, -9], [-30, -5], [-35.5, 0], [-35.5, 16], [-9, 21]], 'hull', 1, {
      slope: [-0.35, 0.05],
      details: [
        { k: 'shape', pts: [[-9, -9], [-30, -5], [-33.5, -1.5], [-9, -5]], tone: 'accent' },
        { k: 'shape', pts: [[-18, 12], [-35.5, 12], [-35.5, 16], [-18, 18.6]], tone: 'hull2' },
        { k: 'line', pts: [[-18, -6], [-18, 19]] },
      ],
    }), { slope: [0.35, 0.05] }),
    // Torpedo racks under the wing tips: three warheads each, red-nosed.
    ...sym(part('rack', rounded(-29, 7, 9, 19, 1.8), 'dark', 2, {
      lift: 0.6,
      detach: { hull: 0.38 },
      details: [
        ...[-31.8, -29, -26.2].map((x) => ({ k: 'shape' as const, pts: rounded(x, 0.4, 2.2, 5, 1), tone: 'accent' as const })),
        ...[-31.8, -29, -26.2].map((x) => ({ k: 'shape' as const, pts: rect(x - 1.1, 3, 2.2, 11), tone: 'metal' as const })),
      ],
    }), { detach: { hull: 0.24 } }),
    ...sym(part('fuse', fuse, 'hull', 2, {
      slope: [-0.5, 0],
      details: [
        { k: 'shape', pts: [[-4.2, -44], [-6, -44], [-7.2, -30], [-5.4, -30]], tone: 'accent' },
        { k: 'shape', pts: [[-8.5, 26], [-10, 22], [-10.4, 6], [-8.5, 6]], tone: 'accent' },
        { k: 'line', pts: [[-10.6, -12], [-6.5, -12]] },
        { k: 'line', pts: [[-9, 30], [-4, 34]] },
      ],
    })),
    // The bomb bay: a long dark well, two rows of red-capped proton bombs in it and hazard lights
    // round its edge.
    part('bay', rect(-6, -20, 12, 44), 'dark', 3, {
      details: [
        ...[-2.8, 2.8].flatMap((x) => [-14, -5, 4, 13].map((y) => ({ k: 'shape' as const, pts: rounded(x, y, 4, 7.4, 1.8), tone: 'metal' as const }))),
        ...[-2.8, 2.8].flatMap((x) => [-14, -5, 4, 13].map((y) => ({ k: 'shape' as const, pts: rounded(x, y - 2.4, 3, 2.4, 1), tone: 'accent' as const }))),
        { k: 'lights', pts: [...along([-6, -19], [-6, 23], 7), ...along([6, -19], [6, 23], 7)], r: 0.55, tone: 'ember' },
      ],
    }),
    part('cockpit', [[0, -46], [4.6, -43], [6.4, -35], [5.4, -28], [-5.4, -28], [-6.4, -35], [-4.6, -43]], 'glass', 4, {
      lift: 0.9,
      details: [{ k: 'shape', pts: [[-1.2, -44], [-4.4, -38], [-4.6, -32], [-3, -32], [-2.4, -38]], tone: 'glow' }, { k: 'line', pts: [[-6, -34], [6, -34]] }],
    }),
    enginePod('engineL', -12.5, 4, 49, 11, 0, 3, { detach: { death: true } }),
    enginePod('engineR', 12.5, 4, 49, 11, 1, 3, { detach: { death: true } }),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Suture repair fighter: an engineer craft with two jointed manipulator arms reaching out past its
 * nose, welding tips glowing, a green-ringed repair hub on its back and two engines. The arms say
 * what it does before the colours do.
 */
export const repair: ModelDef = () => {
  const fuse = halfHull([[-36, 1.2], [-32, 4], [-24, 6.8], [-12, 8.6], [0, 9.6], [14, 9.6], [26, 8.2], [32, 5.5]])
  // One arm, for the left side: shoulder, upper arm, elbow, forearm and a two-fingered claw.
  const sh: Pt = [-8, -16]
  const el: Pt = [-21, -31]
  const wr: Pt = [-15.5, -44]
  const parts: Part[] = [
    ...sym(part('wing', [[-9, 2], [-28, 12], [-38, 19], [-37.5, 24.5], [-9.5, 24]], 'hull', 1, {
      slope: [-0.35, 0.05],
      details: [
        { k: 'shape', pts: [[-9, 2], [-28, 12], [-38, 19], [-37.6, 21.4], [-27.5, 15], [-9.2, 6]], tone: 'accent' },
        { k: 'shape', pts: [[-22, 17.5], [-30, 21], [-30, 24.4], [-22, 24.2]], tone: 'aid' },
        { k: 'line', pts: [[-18, 9], [-18, 24]] },
      ],
    }), { slope: [0.35, 0.05] }),
    ...sym(part('arm', capsule(sh, el, 2.4, 2), 'metal', 2, { lift: 0.7, detach: { hull: 0.3 }, details: [{ k: 'shape', pts: circle(el[0], el[1], 1.6, 8), tone: 'dark' }] }), { detach: { hull: 0.2 } }),
    ...sym(part('fore', capsule(el, wr, 1.9, 1.5), 'hull2', 2.2, { lift: 0.7, detach: { hull: 0.3 }, details: [{ k: 'shape', pts: capsule([-19.6, -34], [-17.6, -39], 0.7), tone: 'aid' }] }), { detach: { hull: 0.2 } }),
    ...sym(part('claw', [[-14.6, -44], [-12.6, -49.5], [-14.4, -48.6], [-15.6, -45.6], [-17.2, -49.2], [-18.6, -48], [-16.6, -43]], 'dark', 2.4, {
      detach: { hull: 0.3 },
      details: [{ k: 'lights', pts: [[-15.4, -48.2]], r: 0.9, tone: 'ember' }],
    }), { detach: { hull: 0.2 } }),
    enginePod('engineL', -13.75, 6, 35.5, 8.4, 0, 2, { detach: { death: true } }),
    enginePod('engineR', 13.75, 6, 35.5, 8.4, 1, 2, { detach: { death: true } }),
    ...sym(part('fuse', fuse, 'hull', 3, {
      slope: [-0.5, 0],
      details: [
        { k: 'shape', pts: [[0, -36], [-1.3, -33], [-1.6, -24], [0, -24]], tone: 'accent' },
        { k: 'shape', pts: [[-6.2, 14], [-9.6, 14], [-9.4, 22], [-6.6, 22]], tone: 'accent' },
        { k: 'line', pts: [[-8.6, -10], [-4, -10]] },
        { k: 'line', pts: [[0, 28], [-8, 28]] },
      ],
    })),
    part('cockpit', [[0, -31], [2.8, -27], [3.2, -19], [2, -15], [-2, -15], [-3.2, -19], [-2.8, -27]], 'glass', 4, {
      lift: 0.9,
      details: [{ k: 'shape', pts: [[-0.6, -29], [-2.2, -24], [-2.3, -20], [-1.3, -20], [-1, -25]], tone: 'glow' }],
    }),
    // The repair hub: a raised disc ringed in green with the aid cross on it.
    part('hub', circle(0, 4, 6.4, 20), 'hull2', 4, {
      lift: 1,
      details: [
        { k: 'shape', pts: circle(0, 4, 5.2, 18), tone: 'aid' },
        { k: 'shape', pts: circle(0, 4, 4, 16), tone: 'hull' },
        { k: 'shape', pts: box(0, 4, 5, 1.6), tone: 'aid' },
        { k: 'shape', pts: box(0, 4, 1.6, 5), tone: 'aid' },
      ],
    }),
  ]
  return { parts, breakStyle: 'bands' }
}

/**
 * Aegis picket: the station's own defense wing. A small, sharp delta with gold home-guard bands on
 * its wings (no other Republic craft wears them), a red nose and one engine.
 */
export const picket: ModelDef = () => {
  const fuse = halfHull([[-50, 0.4], [-44, 2.2], [-30, 4.6], [-12, 6.6], [10, 7.2], [26, 6.4], [33, 4.8]])
  const parts: Part[] = [
    ...sym(part('wing', [[-5, -20], [-36.5, 26.5], [-37.8, 30], [-33, 31.5], [-6, 28.5]], 'hull', 1, {
      slope: [-0.35, 0.05],
      details: [
        { k: 'shape', pts: [[-5, -20], [-36.5, 26.5], [-35.6, 29.4], [-6, -13]], tone: 'accent' },
        { k: 'shape', pts: [[-12, 4], [-27, 22], [-26, 26], [-12, 12]], tone: 'trim' },
        { k: 'line', pts: [[-8, 20], [-30, 30]] },
      ],
    }), { slope: [0.35, 0.05] }),
    ...sym(part('gun', [[-36.8, 12], [-35.6, 12], [-35.4, 31], [-37, 31]], 'dark', 2, { detach: { death: true } })),
    enginePod('engine', 0, 22, 41.5, 9, 0, 2),
    ...sym(part('fuse', fuse, 'hull', 3, {
      slope: [-0.5, 0],
      details: [
        { k: 'shape', pts: [[0, -50], [-1.6, -42], [-2.4, -32], [0, -31]], tone: 'accent' },
        { k: 'shape', pts: [[-5.6, 8], [-7.1, 8], [-7, 18], [-5.6, 18]], tone: 'trim' },
        { k: 'line', pts: [[-6.8, -4], [0, -4]] },
      ],
    })),
    part('cockpit', [[0, -31], [2.8, -26], [3.1, -17], [2, -12], [-2, -12], [-3.1, -17], [-2.8, -26]], 'glass', 4, {
      lift: 0.8,
      details: [{ k: 'shape', pts: [[-0.6, -29], [-2.2, -24], [-2.3, -18], [-1.3, -18], [-1, -24]], tone: 'glow' }],
    }),
  ]
  return { parts, breakStyle: 'bands' }
}

// --- Structures on the ore ---------------------------------------------------------------------------

/** An anchor clamp at a platform's corner, for the left-top corner and turned to the others: a leg out
 * from the deck to a three-toed foot bitten into the asteroid under it. */
function clamps(x: number, y: number, z: number): Part[] {
  const out: Part[] = []
  const one: Part[] = [
    part('leg', capsule([x * 0.62, y * 0.62], [x, y], 3, 2.4), 'metal', z, { lift: 1.2, details: [{ k: 'line', pts: [[x * 0.7, y * 0.7], [x * 0.94, y * 0.94]] }] }),
    part('foot', [[x - 4, y - 1], [x - 1, y - 4.5], [x + 3, y - 4], [x + 1.5, y], [x + 4, y + 3], [x, y + 1.5], [x - 4, y + 4], [x - 1.5, y + 0.5]], 'dark', z + 0.1, { lift: 0.6 }),
  ]
  for (const [sx, sy, n] of [[1, 1, 0], [-1, 1, 1], [1, -1, 2], [-1, -1, 3]] as const)
    for (const p of one) {
      const f = (pts: Pt[]) => pts.map(([px, py]) => [px * sx, py * sy] as Pt)
      const pts = sx * sy < 0 ? f(p.pts).reverse() : f(p.pts)
      out.push({ ...p, id: `${p.id}${n}`, pts, details: p.details?.map((d) => ({ ...d, pts: f(d.pts) })) })
    }
  return out
}

/**
 * Republic mining platform, built from the station's standard modules: a core module in the middle
 * holding the ore silo, two drill rigs either side on truss arms with ore conveyors running in, a
 * landing pad habitat on top (where the shield dome goes when it is fitted) and a defense module
 * below with the point-defence turret, the whole held to the asteroid by four clamp legs.
 */
export const mine: ModelDef = ({ h }) => {
  const cy = (5.2 / 10 - 0.5) * h
  const padY = (1.5 / 10 - 0.5) * h
  const pdY = (8.3 / 10 - 0.5) * h
  const parts: Part[] = [
    ...clamps(-44, -40, 0),
    ...sym(truss('arm', [-12, cy], [-24, cy], 11, 1)),
    truss('neckN', [0, cy - 12], [0, padY + 9], 8, 1),
    truss('neckS', [0, cy + 12], [0, pdY - 6], 8, 1),
    // The drill rigs: heavy octagonal frames round the wells, hazard-lit, banded in red.
    ...sym(part('rig', chamfer(-31, cy, 38, 38, 11), 'hull', 2, {
      lift: 2.4,
      facets: [{ pts: [[-50, cy - 8], [-39, cy - 19], [-35, cy - 19], [-35, cy + 19], [-39, cy + 19], [-50, cy + 8]], slope: [-0.4, 0] }],
      details: [
        { k: 'shape', pts: rect(-50, cy - 2, 4, 4), tone: 'accent' },
        { k: 'shape', pts: rect(-33, cy - 19, 4, 3.2), tone: 'accent' },
        { k: 'shape', pts: rect(-33, cy + 15.8, 4, 3.2), tone: 'accent' },
        { k: 'line', pts: chamfer(-31, cy, 33, 33, 9.4) },
        { k: 'lights', pts: [[-45, cy - 13], [-45, cy + 13], [-17, cy - 13], [-17, cy + 13]], r: 0.8, tone: 'ember' },
      ],
    })),
    // Conveyors bringing the ore in from the rigs.
    ...sym(part('belt', rect(-13, cy - 10.6, 6, 3.2), 'dark', 3.2, { details: [{ k: 'lights', pts: along([-12.2, cy - 9], [-7.8, cy - 9], 3), r: 0.5, tone: 'ember' }] })),
    habitat('pad', 0, padY + 1, 26, 22, 2, {
      details: [
        { k: 'shape', pts: chamfer(0, padY + 1, 18, 14, 3.4), tone: 'dark' },
        ...[-1, 1].flatMap((s) => [{ k: 'shape' as const, pts: [[s * 8.4, padY - 5.4], [s * 5.6, padY - 5.4], [s * 8.4, padY - 2.6]] as Pt[], tone: 'trim' as const }, { k: 'shape' as const, pts: [[s * 8.4, padY + 7.4], [s * 5.6, padY + 7.4], [s * 8.4, padY + 4.6]] as Pt[], tone: 'trim' as const }]),
        { k: 'lights', pts: [[-11, padY - 8.4], [11, padY - 8.4], [-11, padY + 10.4], [11, padY + 10.4]], r: 0.8, tone: 'glow' },
      ],
    }),
    defensePod('pdPod', 0, pdY, 8.4, 2),
    ...coreModule('hub', 0, cy, 13, 3, false),
    mast('mast', -10, cy + 18, 7, 4, 0.5, 1),
  ]
  return { parts, breakStyle: 'pie' }
}

/**
 * Republic defense platforms (balanced, flak and gun share one deck), built from the station's
 * standard modules: an octagonal truss frame on four clamp legs, a core module in the middle under
 * the big gun, defense modules in its corners on diagonal trusses and smaller ones on its sides. The
 * flak platform carries ammunition hoppers by its corner modules; the gun platform heavy capacitor
 * banks on its frame; the balanced one a sensor mast.
 */
export const defense: ModelDef = ({ t }) => {
  const kind = t.id.endsWith('flak') ? 'flak' : t.id.endsWith('gun') ? 'gun' : 'balanced'
  const corners: Pt[] = [[-25, -24], [25, -24], [-25, 24], [25, 24]]
  const oct: Pt[] = [[-27, -42], [27, -42], [42, -27], [42, 27], [27, 42], [-27, 42], [-42, 27], [-42, -27]]
  const parts: Part[] = [
    ...clamps(-45, -45, 0),
    ...oct.map((p, i) => truss(`frame${i}`, p, oct[(i + 1) % 8], 7, 1)),
    ...corners.map(([x, y], i) => truss(`spoke${i}`, [x * 0.5, y * 0.5], [x, y], 6, 1.2)),
    ...(kind === 'flak' ? sym(truss('outArm', [-18, 0], [-38, 0], 6, 1.2)) : []),
    // Red marker plates on the frame's four straight sides.
    ...[[0, -42], [42, 0], [0, 42], [-42, 0]].map(([x, y], i) => part(`marker${i}`, box(x, y, x ? 4.4 : 14, x ? 14 : 4.4), 'accent', 1.6, { lift: 0.8 })),
    ...corners.map(([x, y], i) => defensePod(`pod${i}`, x, y, 10.4, 2.5)),
    // Only the flak platform has guns on its sides.
    ...(kind === 'flak' ? sym(defensePod('side', -41, 0, 7.6, 2.6)) : []),
    ...coreModule('hub', 0, 0, 18, 3, false),
  ]
  if (kind === 'flak')
    for (const [i, [x, y]] of corners.entries()) parts.push(part(`hopper${i}`, rect(x + (x < 0 ? 8 : -13), y + (y < 0 ? 8 : -13), 5, 5), 'trim', 3, { lift: 1, details: [{ k: 'line', pts: [[x + (x < 0 ? 8 : -13), y + (y < 0 ? 8 : -13)], [x + (x < 0 ? 13 : -8), y + (y < 0 ? 13 : -8)]] }] }))
  if (kind === 'gun')
    for (const s of [-1, 1]) parts.push(part(`cap${s < 0 ? 'T' : 'B'}`, rect(-12, s * 42 - 3, 24, 6), 'dark', 3, { lift: 1.6, details: [{ k: 'lights', pts: along([-9, s * 42], [9, s * 42], 4), r: 0.9, tone: 'glow' }] }))
  if (kind === 'balanced') parts.push(mast('mast', 0, -45.5, 7, 3, 0.5, 1.2))
  return { parts, breakStyle: 'pie' }
}
