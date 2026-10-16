import { along, bevel, box, capsule, chamfer, circle, part, sym, treads } from '../kit.ts'
import type { GroundModels } from '../ground.ts'
import type { Pt } from '../types.ts'

// The Republic's ground units, seen from straight above, light from the top left: the Command
// Center (a white armoured block with red bands, a landing pad, a comms tower with its dish and blue
// lights, its door facing south) and the Mason field engineer (a tracked crane rig with a welding
// torch on the end of its arm). Same parts and palette as the fleet (models/republic/palette.ts).

export const GROUND: GroundModels = {
  'r-g-center': {
    w: 100,
    h: 100,
    spec: () => ({
      breakStyle: 'pie',
      parts: [
        // The apron the block stands on, grey plating with a border of panel lines.
        part('apron', chamfer(0, 2, 98, 96, 12), 'hull2', 1, {
          lift: 2,
          details: [
            { k: 'line', pts: chamfer(0, 2, 90, 88, 10) },
            { k: 'shape', pts: box(0, 45, 36, 4), tone: 'accent' },
            { k: 'lights', pts: [...along([-44, -30], [-44, 30], 4), ...along([44, -30], [44, 30], 4)], r: 1.3, tone: 'glow', minPx: 70 },
          ],
        }),
        // The armoured block: bevelled edges, red bands fore and aft.
        part('block', chamfer(0, -4, 84, 76, 8), 'hull', 2, {
          lift: 6,
          facets: bevel(0, -4, 84, 76, 6),
          details: [
            { k: 'shape', pts: box(0, -36, 66, 4), tone: 'accent' },
            { k: 'shape', pts: box(0, 25, 66, 4), tone: 'accent' },
            { k: 'line', pts: [[-36, -10], [-4, -10]], minPx: 60 },
            { k: 'line', pts: [[-36, 10], [36, 10]], minPx: 60 },
            { k: 'lights', pts: along([-32, 30], [32, 30], 7), r: 1.4, tone: 'glow' },
          ],
        }),
        // The landing pad on the west side of the roof, with its marking and edge lights.
        part('pad', circle(-17, -12, 17, 24), 'hull2', 3, {
          lift: 1.5,
          details: [
            { k: 'line', pts: circle(-17, -12, 14, 24) },
            { k: 'shape', pts: box(-22, -12, 3, 14), tone: 'hull' },
            { k: 'shape', pts: box(-12, -12, 3, 14), tone: 'hull' },
            { k: 'shape', pts: box(-17, -12, 10, 3), tone: 'hull' },
            { k: 'lights', pts: circle(-17, -12, 15.5, 8), r: 1.1, tone: 'glow', minPx: 60 },
          ],
        }),
        // The comms tower on the east side, windows to the south.
        part('tower', chamfer(21, -12, 26, 34, 5), 'hull', 3, {
          lift: 7,
          facets: bevel(21, -12, 26, 34, 5),
          details: [
            { k: 'shape', pts: box(21, 1, 18, 4), tone: 'glass' },
            { k: 'shape', pts: box(21, -26, 18, 3), tone: 'accent' },
          ],
        }),
        // Its dish, angled up to the sky, on an arm from the tower's roof.
        part('dishArm', capsule([21, -8], [27, -18], 1.6), 'metal', 4, { lift: 9 }),
        part('dish', circle(22, -18, 9, 20), 'hull2', 5, {
          lift: 10,
          sphere: true,
          details: [
            { k: 'line', pts: circle(22, -18, 5.5, 16) },
            { k: 'shape', pts: circle(22, -18, 2, 8), tone: 'dark' },
          ],
        }),
        // The door on the south face, under a strip of blue light.
        part('door', box(0, 34, 26, 8), 'dark', 3, {
          lift: 1,
          details: [
            { k: 'line', pts: [[-6, 30], [-6, 38]] },
            { k: 'line', pts: [[6, 30], [6, 38]] },
          ],
        }),
        // Vents on either side of the block.
        ...sym(part('vent', box(-36, 4, 6, 18), 'metal', 3, { lift: 2, details: treads(-39, -33, -5, 13, 4) })),
        // A small mast on the north-west corner.
        part('mast', capsule([-32, -34], [-36, -42], 1.4, 1), 'metal', 4, { lift: 14, details: [{ k: 'lights', pts: [[-36, -42]], r: 1.4, tone: 'accent' }] }),
      ],
    }),
  },
  'r-g-engineer': {
    w: 76,
    h: 100,
    spec: () => ({
      breakStyle: 'bands',
      parts: [
        // Two tracks, treads across them.
        ...sym(part('track', box(-30, 0, 15, 86), 'dark', 1, { lift: 2, details: treads(-37, -23, -42, 42, 12) })),
        // The rig's body: white armour, bevelled, a red band.
        part('body', chamfer(0, 4, 46, 70, 8), 'hull', 2, {
          lift: 5,
          facets: bevel(0, 4, 46, 70, 6),
          details: [
            { k: 'shape', pts: box(0, -6, 34, 5), tone: 'accent' },
            { k: 'line', pts: [[-16, 22], [16, 22]], minPx: 50 },
          ],
        }),
        // The cab at the front, windows facing forward.
        part('cab', chamfer(-8, -22, 24, 18, 4), 'hull2', 3, {
          lift: 3,
          details: [{ k: 'shape', pts: box(-8, -28, 18, 5), tone: 'glass' }],
        }),
        // The power pack at the back.
        part('pack', box(0, 34, 30, 10), 'metal', 3, { lift: 2, details: [{ k: 'lights', pts: [[-10, 38], [10, 38]], r: 1.6, tone: 'ember' }] }),
        // The crane: a turret on the right, its arm reaching past the nose.
        part('craneBase', circle(12, 12, 8, 16), 'metal', 4, { lift: 7, sphere: true }),
        part('arm', capsule([12, 12], [16, -44], 4, 3), 'hull2', 5, {
          lift: 12,
          details: [
            { k: 'line', pts: [[12, 4], [16, -38]] as Pt[] },
            { k: 'shape', pts: box(14, -20, 7, 4), tone: 'accent' },
          ],
        }),
        // The welding torch on its end: its light shows while it builds.
        part('torch', circle(16, -46, 4, 12), 'glow', 6, { lift: 12, glow: true }),
      ],
    }),
  },
}
