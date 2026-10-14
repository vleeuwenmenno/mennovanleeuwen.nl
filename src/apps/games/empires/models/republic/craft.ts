import { along, box, capsule, chamfer, circle, halfHull, part, pod, rect, rounded, sym, turn } from '../kit.ts'
import type { ModelDef } from '../spec.ts'
import type { Detail, Part, Pt, Tone } from '../types.ts'

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
    part('engine', pod(0, 29, 45, 9.5), 'metal', 3, {
      lift: 1,
      engine: 0,
      facets: [{ pts: rect(-5, 28, 5, 18), slope: [-0.5, 0] }, { pts: rect(0, 28, 5, 18), slope: [0.5, 0] }],
      details: [
        { k: 'shape', pts: circle(0, 42.5, 3.4, 14), tone: 'dark' },
        { k: 'lights', pts: [[0, 42.6]], r: 1.6 },
        { k: 'shape', pts: box(0, 32, 9.5, 1.6), tone: 'accent' },
      ],
    }),
  ]
  return { parts, breakStyle: 'bands' }
}

/** The level-4 outer frame: a square with bastions at its corners, or an octagon with hard corners. */
export type StationFrame = 'square' | 'octagon'
export const STATION_FRAMES: StationFrame[] = ['square', 'octagon']
/** The frame the battle draws until one is picked for good. */
export const STATION_FRAME: StationFrame = 'square'

/**
 * Bastion station: the Republic shipyard, a chunky military platform built from plates and
 * girders that grows with its level. Level 1 is a compact core: an eight-sided deck of four plates
 * sloping down from a raised command block, red bands round it and a dark spire down the middle.
 * Level 2 adds four short arms with blocky docking pods and a square girder frame between them.
 * Level 3 runs the arms out long to big pods, with dry docks alongside. Level 4 puts a great
 * outer frame round it all on diagonal struts (square with corner bastions, or octagonal, by
 * `style`). Coordinates are frame pixels from the frame's centre, where data.ts places the modules.
 */
export const station: ModelDef = ({ level, style }) => {
  const frame: StationFrame = style === 'octagon' ? 'octagon' : STATION_FRAME
  const parts: Part[] = []
  const Q = Math.PI / 2
  // Each side's parts are drawn for the top side (negative y) and turned round to the other three.
  const sides = (id: string, make: (s: number) => Part) => {
    for (let s = 0; s < 4; s++) parts.push({ ...make(s), id: `${id}${s}` })
  }
  /** A part drawn for the top side, turned to side `s` (0 top, 1 right, 2 bottom, 3 left), its
   * facet and details turned with it. */
  const onSide = (s: number, p: Part): Part => {
    const a = s * Q
    const tp = (pts: Pt[]) => turn(pts, a)
    const c = Math.cos(a)
    const n = Math.sin(a)
    return {
      ...p,
      pts: tp(p.pts),
      holes: p.holes?.map(tp),
      slope: p.slope ? [p.slope[0] * c - p.slope[1] * n, p.slope[0] * n + p.slope[1] * c] : undefined,
      facets: p.facets?.map((f) => ({ pts: tp(f.pts), slope: [f.slope[0] * c - f.slope[1] * n, f.slope[0] * n + f.slope[1] * c] as Pt })),
      details: p.details?.map((d) => ({ ...d, pts: tp(d.pts) })),
    }
  }
  const lights = (pts: Pt[], r = 4) => ({ k: 'lights' as const, pts, r })
  const row = (x0: number, x1: number, y: number, n: number): Pt[] => Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * i) / Math.max(1, n - 1), y] as Pt)

  // --- Level 4: the outer frame on struts, under everything else -------------------------------
  if (level >= 4) {
    // Diagonal struts from the core's corners out to the frame's corners.
    for (let s = 0; s < 4; s++) {
      const a = s * Q + Math.PI / 4
      parts.push(part(`strut${s}`, turn(rect(-17, -390, 34, 250), a), 'metal', 0, { lift: 3, details: [{ k: 'line', pts: turn([[0, -385], [0, -150]], a) }] }))
    }
    if (frame === 'square') {
      // Four straight bars, each a plate sloping outward, red bands and running lights on them,
      // and a heavy bastion block at each corner.
      sides('bar', (s) =>
        onSide(s, part('', rect(-350, -440, 700, 80), 'hull', 1, {
          slope: [0, -0.45],
          lift: 6,
          details: [
            { k: 'shape', pts: rect(-300, -428, 120, 22), tone: 'accent' },
            { k: 'shape', pts: rect(180, -428, 120, 22), tone: 'accent' },
            { k: 'line', pts: [[-350, -400], [350, -400]] },
            ...[-160, -80, 80, 160].map((x) => ({ k: 'line' as const, pts: [[x, -440], [x, -360]] as Pt[] })),
            lights(row(-320, 320, -367, 9)),
          ],
        })),
      )
      sides('bastion', (s) =>
        onSide(s, part('', chamfer(-400, -400, 130, 130, 26), 'hull2', 2, {
          lift: 9,
          facets: [{ pts: [[-465, -465], [-335, -465], [-400, -400]], slope: [0, -0.45] }, { pts: [[-465, -465], [-465, -335], [-400, -400]], slope: [-0.45, 0] }],
          details: [{ k: 'shape', pts: rect(-425, -425, 50, 50), tone: 'accent' }, { k: 'shape', pts: rect(-412, -412, 24, 24), tone: 'dark' }, lights([[-452, -400], [-400, -452]])],
        })),
      )
    } else {
      // Eight bars round an octagon with hard corners, each sloping outward its own way.
      const oct = (half: number, c: number): Pt[] => [[-half + c, -half], [half - c, -half], [half, -half + c], [half, half - c], [half - c, half], [-half + c, half], [-half, half - c], [-half, -half + c]]
      const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      const outer = oct(440, 170)
      const inner = oct(360, 137)
      for (let i = 0; i < 8; i++) {
        const j = (i + 1) % 8
        const mx = (outer[i][0] + outer[j][0]) / 2
        const my = (outer[i][1] + outer[j][1]) / 2
        const l = Math.hypot(mx, my)
        const straight = i % 2 === 0
        parts.push(part(`bar${i}`, [outer[i], outer[j], inner[j], inner[i]], straight ? 'hull' : 'hull2', 1, {
          slope: [(mx / l) * 0.45, (my / l) * 0.45],
          lift: 6,
          details: [
            { k: 'line', pts: [[(outer[i][0] + inner[i][0]) / 2, (outer[i][1] + inner[i][1]) / 2], [(outer[j][0] + inner[j][0]) / 2, (outer[j][1] + inner[j][1]) / 2]] },
            ...(straight
              ? [{ k: 'shape' as const, pts: [lerp(outer[i], outer[j], 0.36), lerp(outer[i], outer[j], 0.64), lerp(inner[i], inner[j], 0.64), lerp(inner[i], inner[j], 0.36)], tone: 'accent' as const }]
              : [lights([[mx * 0.92, my * 0.92]], 5)]),
          ],
        }))
      }
    }
  }

  // --- Levels 2 and 3: arms, pods, the girder frame and the dry docks ---------------------------
  if (level >= 2) {
    // The square girder frame between the pods, and a block at each of its corners.
    sides('girder', (s) => onSide(s, part('', rect(-300, -311, 600, 22), 'metal', 1.5, { lift: 2, details: [{ k: 'line', pts: [[-300, -300], [300, -300]] }] })))
    sides('brace', (s) => onSide(s, part('', turn(rect(-13, -290, 26, 150), Math.PI / 4), 'metal', 1.5, { lift: 2 })))
    sides('block', (s) => onSide(s, part('', chamfer(-300, -300, 64, 64, 12), 'hull2', 2.5, { lift: 5, details: [{ k: 'shape', pts: rect(-312, -312, 24, 24), tone: 'accent' }] })))
  }
  // An arm out of side s, from the core to `len`, `w` wide; vertical arms are 0 and 2.
  const vertical = (s: number) => s % 2 === 0
  if (level >= 2) {
    sides('arm', (s) => {
      const len = level >= 3 ? (vertical(s) ? 470 : level >= 4 ? 470 : 400) : 230
      const w = vertical(s) ? 130 : 120
      return onSide(s, part('', rect(-w / 2, -len, w, len - 180), 'hull', 3, {
        lift: 4,
        facets: [{ pts: rect(-w / 2, -len, w * 0.3, len - 180), slope: [-0.45, 0] }, { pts: rect(w * 0.2, -len, w * 0.3, len - 180), slope: [0.45, 0] }],
        details: [
          { k: 'shape', pts: rect(-w * 0.12, -len + 10, w * 0.24, len - 200), tone: 'accent' },
          ...(len > 300 ? [{ k: 'line' as const, pts: [[-w / 2, -330], [w / 2, -330]] as Pt[] }] : []),
          lights(row(-len + 20, -200, 0, Math.max(2, Math.round((len - 220) / 45))).map(([y]) => [-w / 2 + 8, y] as Pt)),
          lights(row(-len + 20, -200, 0, Math.max(2, Math.round((len - 220) / 45))).map(([y]) => [w / 2 - 8, y] as Pt)),
        ],
      }))
    })
    // Level-2 docking pods: blocky, with a red block and a dark loading slot.
    sides('pod', (s) =>
      onSide(s, part('', chamfer(0, -283, vertical(s) ? 150 : 130, 130, 18), 'hull2', 5, {
        lift: 7,
        facets: [{ pts: rect(-80, -348, 18, 130), slope: [-0.45, 0] }, { pts: rect(62, -348, 18, 130), slope: [0.45, 0] }],
        details: [{ k: 'shape', pts: rect(-30, -340, 60, 26), tone: 'accent' }, { k: 'shape', pts: rect(-44, -236, 88, 12), tone: 'dark' }, lights(row(-36, 36, -230, 4), 3)],
      })),
    )
  }
  if (level >= 3) {
    // The far pods: big on the vertical arms (where the level-3 modules sit), smaller on the sides.
    sides('far', (s) => {
      const v = vertical(s)
      const out = v ? 565 : level >= 4 ? 574 : 491
      const along = v ? 150 : 150
      const across = v ? 230 : 200
      return onSide(s, part('', chamfer(0, -out + along / 2, across, along, 28), 'hull2', 5, {
        lift: 8,
        facets: [{ pts: rect(-across / 2, -out, across * 0.18, along), slope: [-0.45, 0] }, { pts: rect(across * 0.32, -out, across * 0.18, along), slope: [0.45, 0] }],
        details: [
          { k: 'shape', pts: rect(-22, -out + 10, 44, along - 20), tone: 'accent' },
          { k: 'shape', pts: rect(-across / 2 + 14, -out + along - 26, across - 28, 12), tone: 'dark' },
          lights(row(-across / 2 + 20, across / 2 - 20, -out + along - 20, 6), 3),
        ],
      }))
    })
    // Dry docks either side of the vertical arms: open girder frames with lights down them.
    for (const s of [0, 2])
      for (const x of [-1, 1]) {
        const p = part(`dock${s}${x}`, rect(x < 0 ? -150 : 80, -400, 70, 150), 'metal', 2, {
          lift: 3,
          details: [{ k: 'shape', pts: rect(x < 0 ? -138 : 92, -388, 46, 126), tone: 'dark' }, lights(row(-380, -270, 0, 4).map(([y]) => [x < 0 ? -115 : 115, y] as Pt), 3)],
        })
        parts.push(onSide(s, p))
      }
  }

  // --- Level 1: the core ------------------------------------------------------------------------
  parts.push(part('skirt', chamfer(0, 0, 420, 420, 92), 'metal', 6, {
    lift: 3,
    details: [0, 1, 2, 3].flatMap((s) => [-120, -40, 40, 120].map((x) => ({ k: 'shape' as const, pts: turn(rect(x - 12, -209, 24, 10), s * Q), tone: 'dark' as const }))),
  }))
  // The deck: four plates sloping down from the command block, so one or two catch the light.
  const deck: Pt[] = [[-152.5, -152.5], [-115, -190], [115, -190], [152.5, -152.5], [85, -85], [-85, -85]]
  sides('deck', (s) =>
    onSide(s, part('', deck, 'hull', 7, {
      slope: [0, -0.45],
      lift: 2,
      details: [
        { k: 'shape', pts: rect(-150, -176, 300, 22), tone: 'accent' },
        { k: 'shape', pts: rect(-62, -132, 124, 14), tone: 'accent' },
        { k: 'line', pts: [[-118, -150], [118, -150]] },
        { k: 'shape', pts: rect(-100, -118, 18, 10), tone: 'dark' },
        { k: 'shape', pts: rect(82, -118, 18, 10), tone: 'dark' },
        lights(row(-96, 96, -183, 7), 3.5),
      ],
    })),
  )
  parts.push(part('block', chamfer(0, 0, 170, 170, 34), 'hull2', 8, {
    lift: 5,
    details: [{ k: 'shape', pts: rect(-62, -62, 22, 22), tone: 'dark' }, { k: 'shape', pts: rect(40, 40, 22, 22), tone: 'dark' }, lights([[-70, 0], [70, 0], [0, -70], [0, 70]], 3.5)],
  }))
  // The command spire: a dark tower down the middle, finned, with a lit tip.
  const spire: Pt[] = [[0, -175], [-6, -150], [-9, -95], [-20, -70], [-20, -30], [-11, -18], [-11, 40], [-18, 70], [-12, 160], [0, 172]]
  parts.push(...sym(part('spire', spire, 'dark', 9, { slope: [-0.5, 0], lift: 9, details: [{ k: 'shape', pts: [[0, -120], [-3, -110], [-3, 120], [0, 130]], tone: 'metal' }, { k: 'line', pts: [[-11, 0], [0, 0]] }] })))
  parts.push(...sym(part('fin', [[-11, -60], [-38, -30], [-36, -18], [-11, -30]], 'dark', 8.5, { slope: [-0.4, 0], lift: 6 })))
  parts.push(part('crown', chamfer(0, 0, 30, 46, 9), 'metal', 10, { lift: 3, details: [{ k: 'lights', pts: [[0, -12], [0, 0], [0, 12]], r: 3.4 }] }))
  parts.push(part('beacon', box(0, -168, 4, 10), 'accent', 11, { glow: true, noOutline: true, detach: { hull: 0.3 } }))
  return { parts, breakStyle: 'pie' }
}

// --- Shared Republic parts ---------------------------------------------------------------------------

/**
 * An engine pod seen from above, shaded as a cylinder (two facets, so its shadow side turns with the
 * ship), a band round it and a glowing nozzle at the back. `engine` is the engine glow it carries.
 */
export function nacelle(id: string, x: number, y0: number, y1: number, w: number, engine: number | undefined, z: number, more: Partial<Part> = {}, band: Tone = 'accent'): Part {
  const h = w / 2
  const half = (s: number): Pt[] => [[x, y0], [x + s * h * 0.6, y0], [x + s * h, y0 + h * 0.8], [x + s * h, y1 - h * 0.35], [x + s * h * 0.7, y1], [x, y1]]
  const r = h * 0.72
  const details: Detail[] = [
    { k: 'shape', pts: box(x, y0 + (y1 - y0) * 0.28, w, Math.max(1, (y1 - y0) * 0.1)), tone: band },
    { k: 'line', pts: [[x - h, y0 + (y1 - y0) * 0.55], [x + h, y0 + (y1 - y0) * 0.55]] },
    { k: 'shape', pts: circle(x, y1 - r - 0.4, r, 14), tone: 'dark' },
  ]
  if (engine !== undefined) details.push({ k: 'lights', pts: [[x, y1 - r - 0.3]], r: r * 0.5 })
  return part(id, [...half(-1), ...half(1).reverse()], 'metal', z, { lift: 1, engine, facets: [{ pts: half(-1), slope: [-0.5, 0] }, { pts: half(1), slope: [0.5, 0] }], details, ...more })
}

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
    nacelle('engineL', -12.4, 4, 49, 11, 0, 3, { detach: { death: true } }),
    nacelle('engineR', 12.6, 4, 49, 11, 1, 3, { detach: { death: true } }),
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
    nacelle('engineL', -13.6, 6, 35.5, 8.4, 0, 2, { detach: { death: true } }),
    nacelle('engineR', 13.9, 6, 35.5, 8.4, 1, 2, { detach: { death: true } }),
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
    nacelle('engine', 0, 22, 41.5, 9, 0, 2),
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

/**
 * Halberd gunship: a heavy fighter-hunter. A long armoured fuselage, forward canards, broad wings with
 * a ball turret on each (its flak) and a missile rack at each tip, swept tail fins and four engines
 * in a row. Twice a fighter's size and built like a brick.
 */
export const gunship: ModelDef = () => {
  const fuse = halfHull([[-50, 0.5], [-46, 2.4], [-38, 4.4], [-28, 6.4], [-16, 8], [-4, 8.8], [10, 9.2], [24, 9.6], [33, 11], [38, 12.5]])
  const parts: Part[] = [
    ...sym(part('fin', [[-9, 17], [-27.5, 29], [-33.5, 38], [-29.5, 40.5], [-10, 34]], 'hull', 0.8, {
      slope: [-0.35, 0.1],
      detach: { death: true },
      details: [{ k: 'shape', pts: [[-9, 17], [-27.5, 29], [-29.4, 32.4], [-9, 21.5]], tone: 'accent' }, { k: 'line', pts: [[-12, 31], [-28, 37]] }],
    }), { slope: [0.35, 0.1] }),
    ...sym(part('wing', [[-8, -9], [-27, -5], [-31, -2], [-31, 9], [-8, 14]], 'hull', 1, {
      slope: [-0.35, 0.05],
      details: [
        { k: 'shape', pts: [[-8, -9], [-27, -5], [-29, -2], [-8, -5]], tone: 'accent' },
        { k: 'shape', pts: [[-12, 6], [-26, 6.5], [-26, 9.6], [-12, 12]], tone: 'hull2' },
        { k: 'line', pts: [[-13, -7], [-13, 13]] },
      ],
    }), { slope: [0.35, 0.05] }),
    ...sym(part('tip', [[-31, -2], [-35.6, 0], [-35.6, 10], [-31, 9]], 'hull2', 1.2, {
      slope: [-0.35, 0],
      detach: { hull: 0.4 },
      details: [{ k: 'shape', pts: [[-31, -2], [-35.6, 0], [-35.6, 2.4], [-31, 0.6]], tone: 'accent' }],
    }), { slope: [0.35, 0], detach: { hull: 0.26 } }),
    ...sym(part('rack', rounded(-27, -4.5, 4.4, 12, 1.4), 'dark', 2.4, {
      lift: 0.5,
      detach: { hull: 0.4 },
      details: [{ k: 'shape', pts: rounded(-28.1, -9.4, 1.6, 2.6, 0.7), tone: 'accent' }, { k: 'shape', pts: rounded(-25.9, -9.4, 1.6, 2.6, 0.7), tone: 'accent' }],
    }), { detach: { hull: 0.26 } }),
    ...sym(part('strake', [[-6.5, -27], [-17, -19], [-17.5, -14.5], [-7.5, -15.5]], 'hull2', 1, { slope: [-0.3, 0], detach: { death: true }, details: [{ k: 'shape', pts: [[-6.5, -27], [-17, -19], [-17.2, -17], [-6.8, -23.5]], tone: 'accent' }] })),
    part('block', chamfer(0, 39, 28, 10, 3), 'metal', 1.5, { lift: 0.6 }),
    ...[-10, -2.86, 3.58, 10].map((x, i) => nacelle(`engine${i}`, x, 33, 49, 6.2, i, 2, i === 0 || i === 3 ? { detach: { death: true } } : {}, 'hull2')),
    ...sym(part('fuse', fuse, 'hull', 3, {
      slope: [-0.5, 0],
      details: [
        { k: 'shape', pts: [[0, -50], [-1.5, -43], [-1.8, -34], [0, -33]], tone: 'accent' },
        { k: 'shape', pts: [[-6.6, -2], [-8.8, -2], [-9, 8], [-6.8, 8]], tone: 'dark' },
        { k: 'shape', pts: [[-7.2, 16], [-9.4, 16], [-9.6, 26], [-7.4, 26]], tone: 'accent' },
        { k: 'line', pts: [[-4.4, -30], [-8.6, -8]] },
        { k: 'line', pts: [[0, 12], [-9.2, 12]] },
      ],
    })),
    ...sym(part('spine', [[0, -21], [-3, -20], [-3.8, 30], [0, 31]], 'hull2', 4, { slope: [-0.45, 0], lift: 0.8, details: [{ k: 'shape', pts: [[0, -6], [-1.2, -6], [-1.2, 26], [0, 26]], tone: 'accent' }] })),
    part('cockpit', [[0, -41], [2.7, -36], [3.1, -27], [2, -22], [-2, -22], [-3.1, -27], [-2.7, -36]], 'glass', 5, {
      lift: 0.9,
      details: [{ k: 'shape', pts: [[-0.6, -39], [-2.2, -34], [-2.3, -28], [-1.3, -28], [-1, -34]], tone: 'glow' }],
    }),
    ...ballTurret('ballL', -19, 2.5, 4.6, 3),
    ...ballTurret('ballR', 19, 2.5, 4.6, 3),
  ]
  return { parts, breakStyle: 'bands' }
}

/** A red band along a hull's edge: the edge points, then the same points pulled `d` in. */
export const edgeBand = (rows: [number, number][], d: number): Pt[] => [...rows.map(([y, w]) => [-w, y] as Pt), ...rows.map(([y, w]) => [-w + d, y + d * 0.2] as Pt).reverse()]

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
 * Republic mining platform: an octagonal hub with the ore silo, two big drill wells either side on
 * girder arms, ore conveyors into the hub, a landing pad on top (where the shield dome goes when it is
 * fitted) and a flak turret below, held to the asteroid by four clamp legs.
 */
export const mine: ModelDef = ({ h }) => {
  const cy = (5.2 / 10 - 0.5) * h
  const padY = (1.5 / 10 - 0.5) * h
  const pdY = (8.3 / 10 - 0.5) * h
  const parts: Part[] = [
    ...clamps(-44, -40, 0),
    ...sym(part('arm', rect(-24, cy - 6, 14, 12), 'metal', 1, { lift: 1.4, details: [{ k: 'line', pts: [[-24, cy], [-10, cy]] }, { k: 'shape', pts: rect(-22, cy - 4.2, 10, 2), tone: 'dark' }, { k: 'shape', pts: rect(-22, cy + 2.2, 10, 2), tone: 'dark' }] })),
    ...sym(part('well', chamfer(-31, cy, 40, 40, 11), 'hull', 2, {
      lift: 2.4,
      facets: [{ pts: [[-51, cy - 9], [-40, cy - 20], [-31, cy - 20], [-31, cy + 20], [-40, cy + 20], [-51, cy + 9]], slope: [-0.35, 0] }],
      details: [
        { k: 'shape', pts: rect(-51, cy - 2, 4, 4), tone: 'accent' },
        { k: 'shape', pts: rect(-33, cy - 20, 4, 3.4), tone: 'accent' },
        { k: 'shape', pts: rect(-33, cy + 16.6, 4, 3.4), tone: 'accent' },
        { k: 'lights', pts: [[-46, cy - 14], [-46, cy + 14], [-16, cy - 14], [-16, cy + 14]], r: 0.9, tone: 'ember' },
      ],
    })),
    part('pad', chamfer(0, padY + 1, 28, 24, 6), 'hull', 2, {
      lift: 2,
      details: [
        { k: 'shape', pts: chamfer(0, padY + 1, 20, 16, 4), tone: 'dark' },
        ...[-1, 1].flatMap((s) => [{ k: 'shape' as const, pts: [[s * 9, padY - 6], [s * 6, padY - 6], [s * 9, padY - 3]] as Pt[], tone: 'trim' as const }, { k: 'shape' as const, pts: [[s * 9, padY + 8], [s * 6, padY + 8], [s * 9, padY + 5]] as Pt[], tone: 'trim' as const }]),
        { k: 'lights', pts: [[-12, padY - 9], [12, padY - 9], [-12, padY + 11], [12, padY + 11]], r: 0.8 },
      ],
    }),
    part('neck', rect(-6, padY + 12, 12, cy - padY - 20), 'metal', 1.8, { lift: 1.2 }),
    part('base', chamfer(0, pdY - 1, 18, 16, 4.5), 'hull2', 2, { lift: 2, details: [{ k: 'shape', pts: rect(-9, pdY - 8, 18, 2), tone: 'accent' }] }),
    part('hub', chamfer(0, cy, 32, 32, 9), 'hull2', 3, {
      lift: 3,
      details: [
        { k: 'shape', pts: chamfer(0, cy, 26, 26, 7.4), tone: 'accent' },
        { k: 'shape', pts: chamfer(0, cy, 22, 22, 6.2), tone: 'hull2' },
        { k: 'lights', pts: [[-11, cy], [11, cy], [0, cy - 11], [0, cy + 11]], r: 0.8 },
      ],
    }),
    // Conveyors bringing the ore in from the wells.
    ...sym(part('belt', rect(-15, cy - 13, 7, 3.4), 'dark', 3.2, { details: [{ k: 'lights', pts: along([-14, cy - 11.3], [-9, cy - 11.3], 3), r: 0.5, tone: 'ember' }] })),
    part('mast', box(-12, cy + 15, 1, 8), 'dark', 4, { detach: { hull: 0.5 }, details: [{ k: 'lights', pts: [[-12, cy + 11.4]], r: 0.6, tone: 'accent' }] }),
  ]
  return { parts, breakStyle: 'pie' }
}

/**
 * Republic defense platforms (balanced, flak and gun share one deck): a heavy octagonal frame on four
 * clamp legs, gun pods in its corners on diagonal spokes, outriggers on its sides and a big central
 * hub. The flak platform carries ammunition hoppers by its corner pods; the gun platform heavy
 * capacitor banks on its frame.
 */
export const defense: ModelDef = ({ t }) => {
  const oct = (half: number, c: number): Pt[] => [[-half + c, -half], [half - c, -half], [half, -half + c], [half, half - c], [half - c, half], [-half + c, half], [-half, half - c], [-half, -half + c]]
  const kind = t.id.endsWith('flak') ? 'flak' : t.id.endsWith('gun') ? 'gun' : 'balanced'
  const corners: Pt[] = [[-25, -24], [25, -24], [-25, 24], [25, 24]]
  const parts: Part[] = [
    ...clamps(-45, -45, 0),
    part('frame', oct(46, 17), 'hull', 1, {
      holes: [oct(37, 13.5)],
      lift: 2.4,
      details: [
        ...[0, 1, 2, 3].map((s) => ({ k: 'shape' as const, pts: turn(rect(-10, -46, 20, 3.4), (s * Math.PI) / 2), tone: 'accent' as const })),
        { k: 'lights', pts: [...oct(41.5, 15.2)], r: 0.8 },
      ],
    }),
    ...[0, 1, 2, 3].map((s) => part(`spoke${s}`, turn(rect(-3.2, -36, 6.4, 26), Math.PI / 4 + (s * Math.PI) / 2), 'metal', 1.5, { lift: 1.4 })),
    ...corners.map(([x, y], i) => part(`pod${i}`, chamfer(x, y, 19, 19, 5.2), 'hull2', 2.5, {
      lift: 3,
      details: [{ k: 'shape', pts: rect(x - 9.5, y + (y < 0 ? -9.5 : 7.5), 19, 2), tone: 'accent' }],
    })),
    ...sym(part('outrigger', chamfer(-41, 0, 12, 18, 3.4), 'hull2', 2.6, { lift: 3, details: [{ k: 'shape', pts: rect(-47, -1, 3, 2), tone: 'accent' }] })),
    part('hub', chamfer(0, 0, 38, 38, 11), 'hull', 3, {
      lift: 3.4,
      facets: [
        { pts: [[-19, -8], [-8, -19], [8, -19], [19, -8], [0, 0]], slope: [0, -0.4] },
        { pts: [[-19, 8], [-8, 19], [8, 19], [19, 8], [0, 0]], slope: [0, 0.4] },
      ],
      details: [{ k: 'shape', pts: chamfer(0, 0, 34, 34, 9.8), tone: 'accent' }, { k: 'shape', pts: chamfer(0, 0, 30, 30, 8.6), tone: 'hull2' }],
    }),
  ]
  if (kind === 'flak')
    for (const [i, [x, y]] of corners.entries()) parts.push(part(`hopper${i}`, rect(x + (x < 0 ? 8 : -13), y + (y < 0 ? 8 : -13), 5, 5), 'trim', 3, { lift: 1, details: [{ k: 'line', pts: [[x + (x < 0 ? 8 : -13), y + (y < 0 ? 8 : -13)], [x + (x < 0 ? 13 : -8), y + (y < 0 ? 13 : -8)]] }] }))
  if (kind === 'gun')
    for (const s of [-1, 1]) parts.push(part(`cap${s < 0 ? 'T' : 'B'}`, rect(-9, s * 41.5 - 3, 18, 6), 'dark', 3, { lift: 1.6, details: [{ k: 'lights', pts: along([-6, s * 41.5], [6, s * 41.5], 4), r: 0.9, tone: 'glow' }] }))
  if (kind === 'balanced') parts.push(part('mast', box(0, -41.5, 1.2, 7), 'dark', 3, { detach: { hull: 0.5 }, details: [{ k: 'lights', pts: [[0, -44.5]], r: 0.7, tone: 'accent' }] }))
  return { parts, breakStyle: 'pie' }
}
