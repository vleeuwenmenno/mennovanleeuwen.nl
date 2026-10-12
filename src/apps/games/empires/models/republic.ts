import { box, chamfer, circle, mirror, part, pod, rect, sym, turn } from './kit.ts'
import type { ModelDef } from './spec.ts'
import type { Part, Pt } from './types.ts'

// The Republic's style kit: angular wedges and chamfered blocks, off-white plating with deep red
// bands, grey machinery, blue windows and engine light. Hulls are split down the middle into two
// facets, so one side catches the light while the other falls into shadow as the ship turns.

/** Points along a bowed edge from (x0, y0) to (x1, y1), as wedgeHalves bows it. */
function edge(x0: number, y0: number, x1: number, y1: number, bow: number, n: number, from = 0, to = n): Pt[] {
  const out: Pt[] = []
  for (let i = from; i <= to; i++) {
    const t = i / n
    out.push([x0 + (x1 - x0) * Math.pow(t, 1 - bow), y0 + (y1 - y0) * t])
  }
  return out
}

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

/**
 * Warden frigate: the escort dagger. A wedge hull with red edge bands over a long flight deck, a
 * stepped bridge tower aft and three engine pods. Its flak turrets are blown clean off when shot
 * out; the turbolaser and shield generator stay on the hull, wrecked. The wing tips, mast, sensor
 * dish and outer engine pods come away as the hull is battered.
 */
export const frigate: ModelDef = () => {
  const W = 33.5
  const nose = -50
  const wide = 33
  const bow = 0.22
  const n = 12
  // The hull's left half, with the wing tip cut away (it breaks off on its own).
  const side = edge(0, nose, -W, wide, bow, n)
  const cut = 10 // side point where the wing tip starts
  const tipAt = side[cut]
  const tailY = 40
  const trail = (x: number): Pt => [x, wide + ((W + x) / (W - 17)) * (tailY - wide)]
  const left: Pt[] = [...side.slice(0, cut + 1), [-25.5, 27], trail(-24), [-17, tailY], [0, tailY]]
  const tip: Pt[] = [tipAt, ...side.slice(cut + 1), trail(-24), [-25.5, 27]]
  // The red band along the hull's edge: the edge itself, then the same points pulled 3.4 in.
  const band = side.slice(1, cut + 1)
  const bandIn = band.map(([x, y]) => [x + 3.6, y + 0.6] as Pt).reverse()
  // A band of darker plating down each side, between the red edge and the deck.
  const plate = side.slice(3, 10)
  const plating: Pt[] = [...plate.map(([x, y]) => [x * 0.66, y] as Pt), ...plate.map(([x, y]) => [x * 0.47, y] as Pt).reverse()]
  const ports = side.slice(3, 10).map(([x, y]) => [x * 0.8 + 0.6, y + 1] as Pt)
  const hullDetails = [
    { k: 'shape' as const, pts: [...band, ...bandIn], tone: 'accent' as const },
    { k: 'shape' as const, pts: plating, tone: 'hull2' as const },
    { k: 'lights' as const, pts: ports, r: 0.42 },
    { k: 'shape' as const, pts: [[-10.6, -9], [-12.2, -9], [-13, -4], [-11.4, -4]] as Pt[], tone: 'dark' as const },
    { k: 'shape' as const, pts: [[-15, 17], [-17.5, 17], [-18, 21], [-15.5, 21]] as Pt[], tone: 'dark' as const },
    { k: 'line' as const, pts: [[0, -30], [-9.2, -30]] as Pt[] },
    { k: 'line' as const, pts: [[-5, -14], [-15, -14]] as Pt[] },
    { k: 'line' as const, pts: [[-8, 3], [-21, 3]] as Pt[] },
    { k: 'line' as const, pts: [[-11, 14], [-24.5, 14]] as Pt[] },
    { k: 'line' as const, pts: [[-4.6, -38], [-20, 22], [-21, 32]] as Pt[] },
    { k: 'shape' as const, pts: [[-12.5, 6], [-14.5, 6], [-14.5, 11], [-12.5, 11]] as Pt[], tone: 'dark' as const },
    { k: 'shape' as const, pts: [[-6.5, -26], [-8, -26], [-8, -22], [-6.5, -22]] as Pt[], tone: 'dark' as const },
    { k: 'shape' as const, pts: [[-21, 30], [-12, 26], [-12, 33]] as Pt[], tone: 'accent' as const },
  ]
  const parts: Part[] = [
    part('hullL', left, 'hull', 0, { slope: [-0.55, 0.05], details: hullDetails }),
    mirror(part('hullL', left, 'hull', 0, { slope: [-0.55, 0.05], details: hullDetails }), 'hullR'),
    part('tipL', tip, 'hull', 0, { slope: [-0.55, 0.05], detach: { hull: 0.32 }, details: [{ k: 'shape', pts: [[-27, 22.5], [-31.5, 30.5], [-26.5, 33]], tone: 'accent' }] }),
    mirror(part('tipL', tip, 'hull', 0, { slope: [-0.55, 0.05], detach: { hull: 0.22 }, details: [{ k: 'shape', pts: [[-27, 22.5], [-31.5, 30.5], [-26.5, 33]], tone: 'accent' }] }), 'tipR'),
    // The flight deck: a recessed strip down the middle with amber guide lights.
    part('deck', rect(-4.2, -15, 8.4, 27), 'dark', 1, {
      details: [
        { k: 'shape', pts: rect(-2.6, -14, 5.2, 25), tone: 'metal' },
        { k: 'lights', pts: [-11, -6, -1, 4, 9].map((y) => [0, y] as Pt), r: 0.45, tone: 'ember' },
      ],
    }),
    ...sym(part('rail', rect(-7.6, -13, 2.6, 24), 'metal', 2, { lift: 0.9, details: [{ k: 'line', pts: [[-6.3, -6], [-6.3, 4]] }] })),
    // The forward spine: a raised ridge from the nose to the deck, red down its middle.
    ...sym(part('spine', [[0, -45], [-1.6, -40], [-5, -16], [0, -16]], 'hull2', 2, {
      slope: [-0.5, -0.05],
      lift: 1.2,
      details: [{ k: 'shape', pts: [[0, -45], [-0.9, -41], [-2.2, -17], [0, -17]], tone: 'accent' }],
    })),
    // The engine block and its three pods: the outer two shear off when the hull is nearly gone.
    part('block', chamfer(0, 36.5, 31, 10, 3), 'metal', 1, { lift: 0.6, details: [{ k: 'line', pts: [[-14, 36], [14, 36]] }] }),
    ...[-9.1, 0, 9.5].flatMap((x, i) => {
      // Each pod is a cylinder: two facets, so its shadow side turns with the ship. The outer
      // pods are one part each so they break off whole.
      const half = (s: number): Pt[] => [[x, 30.5], [x + s * 2.6, 30.5], [x + s * 4.3, 32.5], [x + s * 4.3, 45], [x + s * 3, 46.5], [x, 46.5]]
      const nozzle = [
        { k: 'shape' as const, pts: box(x, 34, 8.6, 1.8), tone: (i === 1 ? 'accent' : 'hull2') as 'accent' | 'hull2' },
        { k: 'shape' as const, pts: circle(x, 43.6, 3.3, 14), tone: 'dark' as const },
        { k: 'lights' as const, pts: [[x, 43.7]] as Pt[], r: 1.8 },
      ]
      const det = i === 1 ? undefined : { hull: i === 0 ? 0.17 : 0.11 }
      return [part(`pod${i}`, [...half(-1), ...half(1).reverse()], 'metal', 2, { lift: 1.2, engine: i, detach: det, details: nozzle, facets: [{ pts: half(-1), slope: [-0.5, 0] }, { pts: half(1), slope: [0.5, 0] }] })]
    }),
    // The bridge: a chamfered base, then a smaller tower on it with a row of windows.
    ...sym(part('bridge', [[0, 6], [-5, 6], [-9.5, 10.5], [-9.5, 29], [-6, 32.5], [0, 32.5]], 'hull', 3, {
      slope: [-0.45, 0],
      lift: 2.2,
      details: [
        { k: 'shape', pts: [[0, 7], [-2.4, 7], [-2.4, 24], [0, 24]], tone: 'accent' },
        { k: 'shape', pts: [[-7.5, 26], [-9.5, 26], [-9.5, 29], [-7.5, 29]], tone: 'dark' },
        { k: 'line', pts: [[-9.5, 20], [-3, 20]] },
      ],
    })),
    part('tower', chamfer(0, 14.5, 12, 12, 3.2), 'hull2', 4, {
      lift: 1.8,
      details: [
        { k: 'shape', pts: [[-6, 17.5], [0, 15.2], [6, 17.5], [6, 19.3], [0, 17], [-6, 19.3]], tone: 'accent' },
        { k: 'lights', pts: [-3.6, -1.8, 0, 1.8, 3.6].map((x) => [x, 10.6] as Pt), r: 0.55 },
      ],
    }),
    part('mast', box(0, 6.5, 1, 9), 'dark', 5, { detach: { hull: 0.5 }, details: [{ k: 'lights', pts: [[0, 2.4]], r: 0.5, tone: 'accent' }] }),
    part('dish', circle(4.2, 25.5, 2.4, 14), 'metal', 5, { lift: 1, slope: [0.3, 0.3], detach: { hull: 0.36 }, details: [{ k: 'shape', pts: circle(4.2, 25.5, 0.7, 8), tone: 'dark' }] }),
  ]
  return {
    parts,
    breakStyle: 'bands',
    // Flak turrets fly off; the turbolaser and the shield generator stay on, wrecked.
    mount: (i) => ({ detach: i < 4 }),
  }
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
