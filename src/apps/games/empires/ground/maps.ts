import { generateGroundDef, parseGenId } from './generate.ts'
import type { GroundMapDef } from './types.ts'

// The hand-made ground maps. Round 1 maps are coarse sketches of heights for one side, filled in for
// the others by their symmetry; round 2 maps are drawn with shapes (GroundFeatures in types.ts:
// plateaus, ramps, rivers, bridges, fords, roads, forests, crystal fields) in tile units. See
// buildGroundMap in terrain.ts. Sketch characters cover `cell` × `cell` tiles: `0` `1` `2` heights,
// `/` a ramp, `~` water, `S` a spawn on the plateau, `d` a deposit on low ground, `.` (or a missing
// row) taken from the mirror copy.

export const GROUND_MAPS: GroundMapDef[] = [
  {
    // After a Star Wars: Empire at War ground map (the look Menno picked): a river runs corner to
    // corner between two bases on open ground, crossed only by a metal bridge and a rocky ford. A
    // dirt road joins the bases over the bridge, past old ruins. Each side has a rocky mesa with
    // one ramp and a crystal field on top, solid woods round the edges, and calm grass and dirt
    // everywhere else. Crystal fields: one by each base, one on each mesa, and one shared in the
    // ford's shallows.
    //
    // Mirrored across the river (the line from the top right corner to the bottom left), so the
    // bridge and the ford, which lie on that line, are shared. The shapes below are drawn for the
    // top left side; the other side is its mirror image.
    id: 'ashwater-crossing',
    name: 'Ashwater Crossing',
    blurb: 'Two bases either side of a river, crossed by one bridge and one ford, with a mesa each.',
    cols: 96,
    rows: 96,
    cell: 1,
    sym: 'none',
    mirror: 'diagonal',
    seed: 2718,
    biome: 'temperate',
    sketch: [],
    features: {
      plateaus: [{ level: 1, pts: [[46, 8], [56, 4], [64, 8], [66, 16], [60, 22], [50, 22], [45, 16]] }],
      ramps: [{ from: [53, 28], to: [54, 19], width: 5 }],
      rivers: [{ pts: [[100, -4], [48, 48], [-4, 100]], width: 9 }],
      bridges: [{ from: [29, 53], to: [43, 67], width: 5 }],
      fords: [{ at: [62, 34], radius: 6 }],
      roads: [{ pts: [[16, 15], [19, 24], [24, 34], [30, 44], [32, 51], [36, 60]], width: 2.8 }],
      forests: [
        [[-1, 30], [8, 28], [14, 34], [13, 44], [6, 48], [-1, 47]],
        [[26, -1], [38, -1], [40, 5], [34, 9], [27, 7]],
        [[4, 58], [14, 54], [20, 60], [18, 66], [10, 70], [4, 66]],
        [[70, -1], [80, -1], [82, 3], [76, 6], [70, 4]],
        [[33, 12], [41, 10], [43, 16], [40, 24], [34, 25], [31, 19]],
      ],
      deposits: [[27, 22], [56, 12], [62, 34]],
      ruins: [[31.5, 37]],
      spawns: [[16, 15]],
    },
  },
  {
    // Three players: a river forks in a lake in the middle, its arms running out between the bases;
    // each arm has a bridge and a ford, so every pair of neighbours shares two crossings. A mesa
    // with crystals and woods in each sector. Laid out by the generator (Rivers, three players,
    // large, seed 2) and kept as a map of its own.
    id: 'forkwater',
    name: 'Forkwater',
    blurb: 'Three bases between the arms of a forked river, each arm crossed by a bridge and a ford.',
    cols: 140,
    rows: 140,
    cell: 1,
    sym: 'tri',
    seed: 262,
    biome: 'temperate',
    sketch: [],
    features: {
      plateaus: [
        { level: 1, pts: [[95, 45], [91.5, 46.5], [87, 47], [82.5, 44.5], [80, 40.5], [81, 37], [83, 33.5], [87.5, 33.5], [91.5, 33.5], [95.5, 35.5], [99, 39], [98.5, 43]] },
      ],
      ramps: [
        { from: [80, 48.5], to: [86.5, 42.5], width: 5 },
      ],
      rivers: [
        { pts: [[70, 70], [70, 70]], width: 18.5 },
        { pts: [[70, 70], [191, 0]], width: 8 },
        { pts: [[70, 70], [-51, 0]], width: 8 },
      ],
      bridges: [
        { from: [90, 49.5], to: [98, 63], width: 5 },
      ],
      fords: [
        { at: [115, 44], radius: 6 },
      ],
      roads: [
        { pts: [[70, 15], [68, 31.5], [90, 49.5], [94, 56.5]], width: 2.5 },
      ],
      forests: [
        [[25, 2.5], [28, 4], [30.5, 6], [31.5, 8.5], [31.5, 11.5], [29, 12.5], [26.5, 12.5], [23.5, 11.5], [21, 9], [21, 6], [22.5, 3.5]],
        [[40.5, 30.5], [36, 29.5], [33, 25.5], [31, 21.5], [32.5, 18.5], [35, 15.5], [39.5, 15], [42.5, 19], [46, 22], [45.5, 25.5], [44, 29]],
        [[116, 4], [118.5, 1.5], [122, 0], [125.5, 2], [126, 5.5], [125.5, 9], [122.5, 11.5], [118.5, 10.5], [115, 8]],
        [[15, 15.5], [16, 18.5], [13, 19], [10, 19.5], [7, 17], [6.5, 13.5], [7.5, 11], [11, 10.5], [13.5, 13]],
      ],
      deposits: [[56.5, 19], [115, 44], [89.5, 40]],
      ruins: [[64, 31]],
      spawns: [[70, 15]],
    },
  },
  {
    // Four players: each base on a plateau in a corner with one ramp down, a central mesa with
    // crystals and a ramp from every side, and rocky ridges between the sectors with a pass and a
    // crystal field in each. Laid out by the generator (Highlands, four players, medium, seed 2) and
    // kept as a map of its own.
    id: 'highcairn',
    name: 'Highcairn',
    blurb: 'Four plateau bases round a central mesa, rocky ridges between them with a pass each.',
    cols: 112,
    rows: 112,
    cell: 1,
    sym: 'quad',
    seed: 262,
    biome: 'temperate',
    sketch: [],
    features: {
      plateaus: [
        { level: 1, pts: [[6.5, 31], [-1.5, 22], [-2.5, 9.5], [5, -1], [17.5, -4], [29, 2], [33.5, 14], [29.5, 26.5], [19, 33]] },
        { level: 1, pts: [[61.5, 48], [64.5, 52], [66.5, 57], [65, 62], [60.5, 66], [55, 66], [50.5, 64], [46, 60.5], [45.5, 55], [48, 50.5], [51.5, 46.5], [57, 45.5]] },
        { level: 1, pts: [[58.5, 35], [57.5, 38.5], [56.5, 40], [55, 39], [54, 36], [53.5, 32.5], [54, 29], [54.5, 25], [55.5, 23.5], [57, 25], [58, 27.5], [58.5, 31]] },
        { level: 1, pts: [[54, -22.5], [55.5, -26], [57, -27], [58, -20], [58.5, -8], [58.5, 3.5], [57.5, 13.5], [56, 18], [54.5, 12.5], [53.5, 2], [53.5, -9.5]] },
        { level: 1, pts: [[30.5, 53.5], [34.5, 53.5], [38, 54.5], [40.5, 55.5], [39.5, 57], [37, 58], [33, 58.5], [29.5, 58.5], [25.5, 58], [24.5, 56.5], [24, 55], [27, 54]] },
        { level: 1, pts: [[14.5, 56.5], [8.5, 58], [-5.5, 59], [-19.5, 58], [-28.5, 56.5], [-26, 54.5], [-14.5, 53.5], [1, 53.5], [13.5, 54.5]] },
      ],
      ramps: [
        { from: [32, 32], to: [25.5, 25.5], width: 6 },
        { from: [44.5, 44.5], to: [51, 51], width: 5 },
      ],
      roads: [
        { pts: [[15, 15], [25.5, 25.5], [32, 32], [44, 44]], width: 2.5 },
      ],
      forests: [
        [[27, 54], [27, 51], [28, 47.5], [31.5, 46.5], [34, 47], [35.5, 49.5], [36.5, 52.5], [34, 55], [31.5, 57], [28, 57]],
        [[61.5, 30.5], [62.5, 33], [62, 35.5], [59.5, 37], [57, 38.5], [54.5, 37], [53.5, 34.5], [53.5, 31.5], [56, 29.5], [59, 30]],
        [[49, 5], [50, 2.5], [52.5, 1.5], [55, 1.5], [57, 3], [57, 5.5], [57.5, 8], [55.5, 9.5], [53.5, 10], [51.5, 9], [49.5, 7.5]],
      ],
      deposits: [[8.5, 27.5], [56, 56], [56, 20], [20, 56]],
      ruins: [[32.5, 42.5]],
      spawns: [[15, 15]],
    },
  },
  {
    // Each base sits on a plateau in a corner, with one ramp down to a shelf of mid ground that
    // wraps round it. The shelf has two ramps to the low ground: one east towards the deposit in the
    // north, one south towards the middle. The middle holds a mid-level hill with a ramp on its
    // south side and a pond, so the straight line between the bases is broken.
    id: 'dustfall-ridge',
    name: 'Dustfall Ridge',
    blurb: 'Two plateau bases above a dusty basin, a pond and a lone hill between them.',
    cols: 128,
    rows: 96,
    cell: 4,
    sym: 'point',
    seed: 4711,
    biome: 'temperate',
    sketch: [
      '22222222211110000000000000000000',
      '222222222111100000d0000000000000',
      '22222222211110000000000000000000',
      '222S2222211111/00000000011110000',
      '22222222211111/00000000011111000',
      '22222222211110000000000011111000',
      '2222222221111000d000000011110000',
      '2222222221111000000000000//00000',
      '111111//111110000000000000000000',
      '11111111111110000000000000000000',
      '111111111111000000000000000d0000',
      '00//1111110000~~~~00000000000000',
      // The bottom half is the top half turned round (point symmetry).
    ],
  },
]

const HAND_MADE: Record<string, GroundMapDef> = Object.fromEntries(GROUND_MAPS.map((m) => [m.id, m]))
const generated = new Map<string, GroundMapDef>()

/**
 * The ground maps by id: the hand-made ones above, and any generated one, by its id
 * (`gen:<recipe>:<players>:<size>:<seed>`, see generate.ts), built the first time it is asked for.
 * Listing it (Object.keys) gives the hand-made maps only.
 */
export const GROUND_MAP: Record<string, GroundMapDef> = new Proxy(HAND_MADE, {
  get(target, key) {
    if (typeof key !== 'string') return undefined
    if (key in target) return target[key]
    const rules = parseGenId(key)
    if (!rules) return undefined
    let def = generated.get(key)
    if (!def) generated.set(key, (def = generateGroundDef(rules)))
    return def
  },
})
