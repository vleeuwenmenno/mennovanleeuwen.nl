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
