import type { GroundMapDef } from './types.ts'

// The hand-made ground maps. Each is a coarse sketch of heights for one side, filled in for the
// others by its symmetry (see GroundMapDef in types.ts and buildGroundMap in terrain.ts). One sketch
// character covers `cell` × `cell` tiles: `0` `1` `2` heights, `/` a ramp, `~` water, `S` a spawn on
// the plateau, `d` a deposit on low ground, `.` (or a missing row) taken from the mirror copy.

export const GROUND_MAPS: GroundMapDef[] = [
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
