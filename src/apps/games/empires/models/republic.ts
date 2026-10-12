import { arcBand, box, chamfer, circle, mirror, move, part, pod, rect, sym, turn } from './kit.ts'
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

/**
 * Bastion station: the Republic shipyard, grown in rings. A plated disc with red rings and a dark
 * command spire at level 1; arms with docking pods and an inner ring at level 2; long arms reaching
 * the far modules at level 3; at level 4 a great outer ring on eight struts. Coordinates are frame
 * pixels from the frame's centre, where data.ts places the station's modules.
 */
export const station: ModelDef = ({ level }) => {
  const parts: Part[] = []
  const lv = (n: number) => ({ level: n })
  const TAU = Math.PI * 2
  // Level 4: the outer ring on struts (drawn first, under everything).
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.PI / 8
    const strut = turn(rect(-20, 195, 40, 240), a - Math.PI / 2)
    parts.push(part(`strut${i}`, strut, 'metal', 0, { ...lv(4), details: [{ k: 'line', pts: turn([[0, 220], [0, 420]], a - Math.PI / 2) }] }))
  }
  for (let i = 0; i < 4; i++) {
    const a0 = (i / 4) * TAU + 0.21
    const a1 = ((i + 1) / 4) * TAU - 0.21
    const mid = (a0 + a1) / 2
    parts.push(part(`ring${i}`, arcBand(0, 0, 425, 515, a0, a1, 18), 'hull', 1, {
      ...lv(4),
      slope: [Math.cos(mid) * 0.45, Math.sin(mid) * 0.45],
      lift: 6,
      details: [
        { k: 'shape', pts: arcBand(0, 0, 455, 488, a0 + 0.06, a0 + 0.36, 6), tone: 'accent' },
        { k: 'shape', pts: arcBand(0, 0, 455, 488, a1 - 0.36, a1 - 0.06, 6), tone: 'accent' },
        { k: 'lights', pts: Array.from({ length: 7 }, (_, k) => { const a = a0 + 0.45 + ((a1 - a0 - 0.9) * k) / 6; return [Math.cos(a) * 432, Math.sin(a) * 432] as Pt }), r: 4 },
        { k: 'line', pts: Array.from({ length: 13 }, (_, k) => { const a = a0 + ((a1 - a0) * k) / 12; return [Math.cos(a) * 470, Math.sin(a) * 470] as Pt }) },
      ],
    }))
  }
  // Level 3: long arms up, down and to the sides, with pods at their ends.
  const arm = (id: string, len: number, w: number, podW: number, podH: number, at: number, vert: boolean) => {
    const out: Part[] = []
    const a = vert ? 0 : Math.PI / 2
    for (const s of [-1, 1]) {
      const r = (pts: Pt[]) => turn(pts.map(([x, y]) => [x, y * s] as Pt), a)
      out.push(part(`${id}${s}`, r(rect(-w / 2, 180, w, len - 180)), 'hull', 2, {
        ...lv(at),
        lift: 5,
        details: [
          { k: 'shape', pts: r(rect(-w * 0.16, 215, w * 0.32, len - 300)), tone: 'accent' },
          { k: 'line', pts: r([[-w / 2, 260], [w / 2, 260]]) },
          { k: 'line', pts: r([[-w / 2, len - 90], [w / 2, len - 90]]) },
          { k: 'lights', pts: [0.3, 0.45, 0.6, 0.75].map((k) => r([[-w / 2 + 8, 180 + (len - 180) * k]])[0]), r: 4 },
          { k: 'lights', pts: [0.3, 0.45, 0.6, 0.75].map((k) => r([[w / 2 - 8, 180 + (len - 180) * k]])[0]), r: 4 },
        ],
      }))
      out.push(part(`${id}pod${s}`, r(chamfer(0, len - podH / 2 + 8, podW, podH, podW * 0.22)), 'hull2', 3, {
        ...lv(at),
        lift: 7,
        details: [
          { k: 'shape', pts: r(box(0, len - podH / 2 + 8, podW * 0.32, podH * 0.6)), tone: 'accent' },
          { k: 'shape', pts: r(box(0, len - podH + 30, podW * 0.62, 14)), tone: 'dark' },
          { k: 'lights', pts: [-0.3, -0.1, 0.1, 0.3].map((k) => r([[podW * k, len - podH + 30]])[0]), r: 3 },
        ],
      }))
    }
    return out
  }
  // Level 4 reaches further out to the sides than level 3 does, so the side arms grow with it.
  parts.push(...arm('armV', 557, 130, 230, 150, 3, true))
  parts.push(...arm('armH', level >= 4 ? 574 : 483, 120, 150, 210, 3, false))
  // Level 2: short arms with docking pods, and an inner ring between them.
  for (let i = 0; i < 4; i++) {
    const a0 = (i / 4) * TAU + 0.32
    const a1 = ((i + 1) / 4) * TAU - 0.32
    const mid = (a0 + a1) / 2
    parts.push(part(`inner${i}`, arcBand(0, 0, 268, 318, a0, a1, 14), 'hull2', 1, {
      ...lv(2),
      slope: [Math.cos(mid) * 0.4, Math.sin(mid) * 0.4],
      lift: 4,
      details: [
        { k: 'line', pts: Array.from({ length: 9 }, (_, k) => { const a = a0 + ((a1 - a0) * k) / 8; return [Math.cos(a) * 293, Math.sin(a) * 293] as Pt }) },
        { k: 'shape', pts: arcBand(0, 0, 268, 318, mid - 0.08, mid + 0.08, 3), tone: 'dark' },
      ],
    }))
  }
  parts.push(...arm('stub', 340, 112, 140, 120, 2, true))
  parts.push(...arm('stubH', 340, 112, 120, 140, 2, false))
  // Level 1: the core disc, its red rings and the spire.
  parts.push(part('skirt', circle(0, 0, 214, 48), 'metal', 4, { lift: 3, details: Array.from({ length: 16 }, (_, k) => { const a = (k / 16) * TAU; return { k: 'shape' as const, pts: turn(box(0, 207, 22, 12), a), tone: 'dark' as const } }) }))
  for (let i = 0; i < 8; i++) {
    // The disc in eight facets, each sloping outward: lit on the side towards the light, shadowed
    // on the far side and plain between, so it reads as a shallow dome however it is turned.
    const a0 = (i / 8) * TAU - Math.PI / 8
    const a1 = a0 + TAU / 8
    const mid = (a0 + a1) / 2
    const q: Pt[] = [[0, 0], ...Array.from({ length: 9 }, (_, k) => { const a = a0 + ((a1 - a0) * k) / 8; return [Math.cos(a) * 200, Math.sin(a) * 200] as Pt })]
    parts.push(part(`disc${i}`, q, 'hull', 5, {
      slope: [Math.cos(mid) * 0.5, Math.sin(mid) * 0.5],
      lift: 2,
      noOutline: true,
      details: [
        { k: 'shape', pts: arcBand(0, 0, 118, 150, a0, a1, 6), tone: 'accent' },
        { k: 'shape', pts: arcBand(0, 0, 62, 86, a0, a1, 6), tone: 'accent' },
        { k: 'line', pts: [[Math.cos(mid) * 90, Math.sin(mid) * 90], [Math.cos(mid) * 200, Math.sin(mid) * 200]] },
        { k: 'line', pts: Array.from({ length: 7 }, (_, k) => { const a = a0 + ((a1 - a0) * k) / 6; return [Math.cos(a) * 172, Math.sin(a) * 172] as Pt }) },
        { k: 'lights', pts: [-0.2, -0.12, 0.12, 0.2].map((d) => [Math.cos(mid + d) * 186, Math.sin(mid + d) * 186] as Pt), r: 3.5 },
        ...(i % 2 ? [] : [{ k: 'shape' as const, pts: move(box(0, 0, 9, 9), Math.cos(mid + 0.2) * 158, Math.sin(mid + 0.2) * 158), tone: 'dark' as const }]),
      ],
    }))
  }
  // The disc's rim, outlined once round the whole (the facets themselves only meet in a crease).
  parts.push(part('rim', circle(0, 0, 200, 48), 'hull', 4.9, { noOutline: false }))
  parts.push(part('hub', circle(0, 0, 50, 28), 'hull2', 6, { lift: 4, details: [{ k: 'line', pts: circle(0, 0, 36, 20) }] }))
  // The command spire: a dark tower down the middle, finned, with a lit tip.
  const spire: Pt[] = [[0, -175], [-6, -150], [-9, -95], [-20, -70], [-20, -30], [-11, -18], [-11, 40], [-18, 70], [-12, 160], [0, 172]]
  parts.push(...sym(part('spire', spire, 'dark', 7, { slope: [-0.5, 0], lift: 9, details: [{ k: 'shape', pts: [[0, -120], [-3, -110], [-3, 120], [0, 130]], tone: 'metal' }, { k: 'line', pts: [[-11, 0], [0, 0]] }] })))
  parts.push(...sym(part('fin', [[-11, -60], [-38, -30], [-36, -18], [-11, -30]], 'dark', 6, { slope: [-0.4, 0], lift: 6 })))
  parts.push(part('crown', chamfer(0, 0, 30, 46, 9), 'metal', 8, { lift: 3, details: [{ k: 'lights', pts: [[0, -12], [0, 0], [0, 12]], r: 3.4 }] }))
  parts.push(part('beacon', box(0, -168, 4, 10), 'accent', 9, { glow: true, noOutline: true, detach: { hull: 0.3 } }))
  // Level-1 docking clamps either side of the spire's foot.
  parts.push(...sym(part('clamp', [[-30, 120], [-58, 120], [-64, 150], [-30, 150]], 'hull2', 6, { lift: 3, details: [{ k: 'shape', pts: rect(-52, 128, 16, 14), tone: 'dark' }] })))
  return { parts: parts.filter((p) => (p.level ?? 1) <= level), breakStyle: 'pie' }
}
