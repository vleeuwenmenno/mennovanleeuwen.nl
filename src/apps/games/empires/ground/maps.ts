import type { GroundMapDef } from './types.ts'

// The hand-made ground maps. Round 1 maps are coarse sketches of heights for one side, filled in for
// the others by their symmetry; round 2 maps are drawn with shapes (GroundFeatures in types.ts:
// plateaus, ramps, rivers, bridges, fords, roads, forests, crystal fields) in tile units. See
// buildGroundMap in terrain.ts. Sketch characters cover `cell` × `cell` tiles: `0` `1` `2` heights,
// `/` a ramp, `~` water, `S` a spawn on the plateau, `d` a deposit on low ground, `.` (or a missing
// row) taken from the mirror copy.

export const GROUND_MAPS: GroundMapDef[] = [
  {
    // After a Star Wars: Empire at War ground map: a river runs corner to corner between two bases
    // on plateaus, with one bridge and one ford as the only crossings. A dirt road leads from each
    // base down its ramp and over the bridge. Big woods, two bare rocky ridges a side, and calm
    // grass and dirt everywhere else. Each base has a crystal field on its plateau and one below
    // it; the third field lies in the ford's shallows, between the two.
    //
    // Mirrored across the river (the line from the top right corner to the bottom left), so the
    // bridge and the ford, which lie on that line, are shared. The shapes below are drawn for the
    // top left side; the other side is its mirror image.
    id: 'ashwater-crossing',
    name: 'Ashwater Crossing',
    blurb: 'A river between two plateau bases, crossed by one bridge and one ford.',
    cols: 96,
    rows: 96,
    cell: 1,
    sym: 'none',
    mirror: 'diagonal',
    seed: 2718,
    biome: 'temperate',
    sketch: [],
    features: {
      plateaus: [
        { level: 1, pts: [[-2, -2], [35, -2], [37, 7], [33, 19], [29, 27], [19, 32], [8, 32], [-2, 29]] },
        // Bare rocky ridges, no way up.
        { level: 1, pts: [[58, 2], [68, 3], [72, 8], [66, 11], [59, 8]] },
        { level: 1, pts: [[2, 60], [6, 58], [10, 64], [10, 72], [5, 76], [2, 70]] },
      ],
      ramps: [{ from: [28, 37], to: [24, 27], width: 6 }],
      rivers: [{ pts: [[100, -4], [48, 48], [-4, 100]], width: 9 }],
      bridges: [{ from: [29, 53], to: [43, 67], width: 5 }],
      fords: [{ at: [62, 34], radius: 6 }],
      roads: [{ pts: [[16, 15], [20, 22], [24, 27], [28, 37], [30, 44], [31, 51], [36, 60]], width: 2.6 }],
      forests: [
        [[40, 6], [50, 4], [54, 10], [52, 19], [45, 23], [40, 19], [38, 12]],
        [[4, 40], [14, 36], [21, 40], [22, 49], [16, 55], [6, 54], [3, 47]],
      ],
      deposits: [[27, 9], [44, 31], [62, 34]],
      spawns: [[16, 15]],
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

export const GROUND_MAP: Record<string, GroundMapDef> = Object.fromEntries(GROUND_MAPS.map((m) => [m.id, m]))
