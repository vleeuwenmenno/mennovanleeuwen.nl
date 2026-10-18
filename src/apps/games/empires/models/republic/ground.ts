import { along, arcBand, bevel, box, capsule, chamfer, circle, part, stride, sym, treads } from '../kit.ts'
import type { GroundModels } from '../ground.ts'
import type { Pt } from '../types.ts'

// The Republic's ground units, seen from straight above, light from the top left: the Command
// Center (a white armoured block with red bands, a landing pad, a comms tower with its dish and blue
// lights, its door facing south), the Mason field engineer (a tracked crane rig with a welding
// torch on the end of its arm) and the Supply Depot (armoured stores and a fuel tank behind blast
// walls). Same parts and palette as the fleet (models/republic/palette.ts).

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
  'r-g-supply': {
    w: 100,
    h: 100,
    spec: () => ({
      breakStyle: 'pie',
      parts: [
        // The pad, grey plating with a red stripe by the door.
        part('pad', chamfer(0, 2, 96, 94, 10), 'hull2', 1, {
          lift: 2,
          details: [
            { k: 'line', pts: chamfer(0, 2, 88, 86, 8) },
            { k: 'shape', pts: box(-12, 44, 30, 3), tone: 'accent' },
            { k: 'lights', pts: [[-43, -40], [43, -40], [-43, 44], [43, 44]], r: 1.4, tone: 'glow', minPx: 50 },
          ],
        }),
        // Blast walls round the north, west and east sides, bevelled white armour.
        part('wallN', box(0, -40, 80, 9), 'hull', 2, { lift: 7, facets: bevel(0, -40, 80, 9, 3) }),
        ...sym(part('wall', box(-40, -2, 9, 66), 'hull', 2, { lift: 7, facets: bevel(-40, -2, 9, 66, 3), details: [{ k: 'shape', pts: box(-40, 6, 9, 4), tone: 'accent' }] })),
        // The store: an armoured block with a red band and a roof hatch.
        part('store', chamfer(-11, -8, 42, 40, 6), 'hull', 3, {
          lift: 9,
          facets: bevel(-11, -8, 42, 40, 5),
          details: [
            { k: 'shape', pts: box(-11, -20, 32, 4), tone: 'accent' },
            { k: 'line', pts: [[-26, 2], [4, 2]], minPx: 40 },
            { k: 'shape', pts: box(-11, -4, 12, 8), tone: 'dark' },
          ],
        }),
        // The fuel tank on the east side, piped to the store.
        part('pipe', capsule([8, -10], [17, -12], 2), 'metal', 3, { lift: 8 }),
        part('tank', circle(22, -12, 13, 24), 'hull2', 4, {
          lift: 11,
          sphere: true,
          details: [
            { k: 'line', pts: circle(22, -12, 9, 20) },
            { k: 'shape', pts: box(22, -12, 22, 3), tone: 'accent' },
          ],
        }),
        // Crates stacked by the door, ready to go out.
        part('crates', box(22, 20, 18, 14), 'metal', 3, { lift: 4, details: [{ k: 'line', pts: [[13, 20], [31, 20]] }, { k: 'line', pts: [[22, 13], [22, 27]] }] }),
        part('crate', box(-30, 24, 10, 10), 'hull2', 3, { lift: 4, details: [{ k: 'shape', pts: box(-30, 24, 10, 2), tone: 'accent' }] }),
        // The door on the south face of the store, under a strip of blue light.
        part('door', box(-11, 15, 20, 6), 'dark', 4, {
          lift: 1,
          details: [{ k: 'lights', pts: along([-18, 11], [-4, 11], 4), r: 1.1, tone: 'glow' }],
        }),
      ],
    }),
  },
  // The Pathfinder speeder: a slim white repulsor sled, a red stripe down its nose, the pilot's
  // canopy behind it, twin pulse laser barrels along the nose and two engine pods aft.
  'r-g-scout': {
    w: 62,
    h: 100,
    spec: () => ({
      breakStyle: 'bands',
      parts: [
        // The engine pods on short pylons.
        ...sym(part('pylon', box(-12, 26, 12, 6), 'metal', 1, { lift: 8 })),
        ...sym(part('pod', capsule([-20, 14], [-20, 42], 7, 6), 'hull2', 2, { lift: 9, details: [{ k: 'lights', pts: [[-20, 44]], r: 2.4, tone: 'glow' }] })),
        // The laser barrels, under the nose's sides.
        ...sym(part('barrel', capsule([-7, -30], [-7, -50], 2.2, 1.6), 'dark', 2, { lift: 7 })),
        // The hull: a narrow wedge, bevelled.
        part('hull', [[0, -46], [10, -30], [13, 10], [10, 34], [-10, 34], [-13, 10], [-10, -30]], 'hull', 3, {
          lift: 9,
          facets: [{ pts: [[0, -46], [10, -30], [0, -24]], slope: [0.6, -0.8] }, { pts: [[0, -46], [-10, -30], [0, -24]], slope: [-0.6, -0.8] }],
          details: [
            { k: 'shape', pts: [[-3, -40], [3, -40], [3, 2], [-3, 2]], tone: 'accent' },
            { k: 'line', pts: [[-11, 22], [11, 22]], minPx: 40 },
          ],
        }),
        // The canopy.
        part('canopy', capsule([0, -6], [0, 12], 6, 6), 'glass', 4, { lift: 11 }),
      ],
    }),
  },
  // A compact fusion plant (2 × 2 tiles): a bevelled white housing with red bands, cooling fins
  // down both sides, and a glowing blue reactor core under a ringed cap.
  'r-g-generator': {
    w: 100,
    h: 100,
    spec: () => ({
      breakStyle: 'pie',
      parts: [
        part('pad', chamfer(0, 2, 96, 94, 12), 'hull2', 1, { lift: 2, details: [{ k: 'line', pts: chamfer(0, 2, 86, 84, 10) }, { k: 'shape', pts: box(0, 44, 30, 4), tone: 'accent' }] }),
        ...sym(part('fins', box(-36, 0, 14, 64), 'metal', 2, { lift: 5, details: treads(-43, -29, -30, 30, 8) })),
        part('housing', chamfer(0, 0, 56, 72, 10), 'hull', 3, {
          lift: 9,
          facets: bevel(0, 0, 56, 72, 7),
          details: [
            { k: 'shape', pts: box(0, -28, 40, 4), tone: 'accent' },
            { k: 'shape', pts: box(0, 26, 40, 4), tone: 'accent' },
          ],
        }),
        part('cap', circle(0, -2, 19, 24), 'hull2', 4, { lift: 12, details: [{ k: 'line', pts: circle(0, -2, 15, 22) }] }),
        part('core', circle(0, -2, 11, 20), 'glow', 5, { lift: 13, glow: true, details: [{ k: 'shape', pts: circle(-3, -5, 4, 10), tone: 'glass' }] }),
        part('coil', arcBand(0, -2, 13, 16, -2.6, -0.5, 8), 'accent', 6, { lift: 13 }),
        part('door', box(0, 38, 22, 6), 'dark', 4, { lift: 1, details: [{ k: 'lights', pts: along([-8, 34], [8, 34], 3), r: 1.1, tone: 'glow' }] }),
      ],
    }),
  },
  // A research station (3 × 3 tiles): a lab dome and a data spire on a bevelled block, two sensor
  // dishes turned to the sky, blue window strips and red markings.
  'r-g-research': {
    w: 100,
    h: 100,
    spec: () => ({
      breakStyle: 'pie',
      parts: [
        part('pad', chamfer(0, 2, 96, 94, 10), 'hull2', 1, {
          lift: 2,
          details: [{ k: 'line', pts: chamfer(0, 2, 88, 86, 8) }, { k: 'lights', pts: [[-43, -40], [43, -40], [-43, 44], [43, 44]], r: 1.4, tone: 'glow', minPx: 50 }],
        }),
        part('block', chamfer(0, 4, 78, 64, 8), 'hull', 2, {
          lift: 7,
          facets: bevel(0, 4, 78, 64, 6),
          details: [
            { k: 'shape', pts: box(0, 30, 60, 3), tone: 'accent' },
            { k: 'shape', pts: box(-20, 22, 26, 4), tone: 'glass' },
            { k: 'shape', pts: box(20, 22, 26, 4), tone: 'glass' },
          ],
        }),
        part('dome', circle(-14, 0, 20, 28), 'hull', 3, { lift: 12, sphere: true, details: [{ k: 'line', pts: circle(-14, 0, 13, 22) }, { k: 'shape', pts: box(-14, -6, 22, 3), tone: 'glass' }] }),
        part('spire', circle(20, -8, 8, 16), 'hull2', 4, { lift: 20, sphere: true, details: [{ k: 'lights', pts: [[20, -8]], r: 2, tone: 'glow' }] }),
        ...[[-30, -30], [32, 18]].flatMap(([x, y], i) => [
          part(`dishArm${i}`, capsule([x * 0.8, y * 0.8], [x, y], 1.5), 'metal', 4, { lift: 9 }),
          part(`dish${i}`, circle(x, y, 9, 18), 'hull2', 5, { lift: 12, sphere: true, details: [{ k: 'line', pts: circle(x, y, 5.5, 14) }, { k: 'shape', pts: circle(x, y, 2, 8), tone: 'dark' }] }),
        ]),
        part('door', box(0, 38, 22, 6), 'dark', 4, { lift: 1, details: [{ k: 'line', pts: [[0, 35], [0, 41]] }] }),
      ],
    }),
  },

  // The Barracks (4 × 4 tiles): a white blast-walled hall with red bands, an armoury on its roof
  // (vents and a weapons rack), a comms mast, and a wide drop door on its south side, striped red,
  // that the trooper squads march out of.
  'r-g-barracks': {
    w: 100,
    h: 100,
    spec: () => ({
      breakStyle: 'pie',
      parts: [
        part('apron', chamfer(0, 2, 98, 96, 12), 'hull2', 1, {
          lift: 2,
          details: [
            { k: 'line', pts: chamfer(0, 2, 90, 88, 10) },
            { k: 'lights', pts: [...along([-44, -34], [-44, 30], 4), ...along([44, -34], [44, 30], 4)], r: 1.3, tone: 'glow', minPx: 70 },
          ],
        }),
        // Blast walls either side of the door.
        ...sym(part('wall', chamfer(-33, 34, 18, 16, 3), 'hull', 2, { lift: 4, facets: bevel(-33, 34, 18, 16, 3), details: [{ k: 'shape', pts: box(-33, 38, 14, 3), tone: 'accent' }] })),
        // The hall: bevelled edges, red bands, blue window strips down its sides.
        part('hall', chamfer(0, -8, 84, 62, 8), 'hull', 2, {
          lift: 7,
          facets: bevel(0, -8, 84, 62, 6),
          details: [
            { k: 'shape', pts: box(0, -34, 66, 4), tone: 'accent' },
            { k: 'shape', pts: box(0, 18, 66, 4), tone: 'accent' },
            { k: 'shape', pts: box(-36, -8, 3, 34), tone: 'glass' },
            { k: 'shape', pts: box(36, -8, 3, 34), tone: 'glass' },
            { k: 'line', pts: [[-30, -8], [30, -8]], minPx: 60 },
          ],
        }),
        // The armoury on the roof: a raised block with vents and a rack of rifles.
        part('armoury', chamfer(-12, -12, 40, 30, 5), 'hull2', 3, {
          lift: 10,
          facets: bevel(-12, -12, 40, 30, 4),
          details: [...treads(-28, -8, -24, 0, 5), { k: 'shape', pts: box(4, -12, 6, 22), tone: 'metal' }],
        }),
        part('rack', box(20, -16, 14, 22), 'metal', 3, { lift: 8, details: treads(14, 26, -26, -6, 6) }),
        // A comms mast on the north-east corner, a blue light on its tip.
        part('mast', capsule([30, -26], [36, -38], 1.6, 1), 'metal', 4, { lift: 16, details: [{ k: 'lights', pts: [[36, -38]], r: 1.4, tone: 'glow' }] }),
        // The wide drop door: dark, its shutter slats, red hazard stripes and a strip of blue light.
        part('door', box(0, 32, 46, 14), 'dark', 3, {
          lift: 1,
          details: [
            ...treads(-21, 21, 26, 38, 4),
            { k: 'shape', pts: box(-21, 32, 3, 14), tone: 'accent' },
            { k: 'shape', pts: box(21, 32, 3, 14), tone: 'accent' },
            { k: 'lights', pts: along([-18, 23], [18, 23], 6), r: 1.2, tone: 'glow' },
          ],
        }),
      ],
    }),
  },
  // The Vehicle Factory (5 × 5 tiles): a long assembly hangar, its ribbed roof under a gantry crane
  // on two rails, fuel tanks on its east side, vents on its west, and a wide armoured gate on its
  // south side that the vehicles roll out of, lit along its top.
  'r-g-vfactory': {
    w: 100,
    h: 100,
    spec: () => ({
      breakStyle: 'pie',
      parts: [
        part('apron', chamfer(0, 1, 98, 98, 12), 'hull2', 1, {
          lift: 2,
          details: [
            { k: 'line', pts: chamfer(0, 1, 90, 90, 10) },
            // Guide lines out of the gate.
            { k: 'line', pts: [[-16, 42], [-16, 50]] },
            { k: 'line', pts: [[16, 42], [16, 50]] },
            { k: 'lights', pts: [...along([-46, -36], [-46, 34], 5), ...along([46, -36], [46, 34], 5)], r: 1.3, tone: 'glow', minPx: 70 },
          ],
        }),
        // Fuel tanks on the east side, vents on the west.
        ...[-24, -4].map((y, i) => part(`tank${i}`, circle(37, y, 8, 18), 'hull', 2, { lift: 7, sphere: true, details: [{ k: 'shape', pts: box(37, y, 10, 2), tone: 'accent' }] })),
        part('vents', box(-38, -14, 10, 34), 'metal', 2, { lift: 4, details: treads(-42, -34, -30, 2, 7) }),
        // The hangar: bevelled, red bands, its roof ribbed.
        part('hangar', chamfer(-1, -4, 66, 80, 8), 'hull', 3, {
          lift: 9,
          facets: bevel(-1, -4, 66, 80, 6),
          details: [
            { k: 'shape', pts: box(-1, -40, 52, 4), tone: 'accent' },
            ...treads(-26, 24, -34, 26, 8),
            { k: 'shape', pts: box(-1, 30, 52, 3), tone: 'glass' },
          ],
        }),
        // The gantry crane: two rails along the hangar and a bridge across with its hoist.
        ...sym(part('rail', box(-30, -4, 4, 78), 'metal', 4, { lift: 12 })),
        part('bridge', box(0, -14, 66, 7), 'hull2', 5, { lift: 15, details: [{ k: 'shape', pts: box(-24, -14, 8, 4), tone: 'accent' }, { k: 'shape', pts: box(24, -14, 8, 4), tone: 'accent' }] }),
        part('hoist', box(6, -14, 12, 11), 'metal', 6, { lift: 16, details: [{ k: 'lights', pts: [[6, -14]], r: 1.6, tone: 'glow' }] }),
        // The wide armoured gate.
        part('gate', box(-1, 40, 54, 10), 'dark', 4, {
          lift: 1,
          details: [
            ...treads(-26, 24, 36, 45, 3),
            { k: 'shape', pts: box(-27, 40, 3, 10), tone: 'accent' },
            { k: 'shape', pts: box(25, 40, 3, 10), tone: 'accent' },
            { k: 'lights', pts: along([-22, 34], [20, 34], 7), r: 1.2, tone: 'glow' },
          ],
        }),
      ],
    }),
  },

  // A heavy trooper, one member of a Repeater squad (tier 2): bulkier armour with red shoulder
  // bands, an ammunition drum on the back and a rapid-fire pulse cannon held at the hip.
  'r-gm-repeater': {
    w: 84,
    h: 100,
    spec: () => ({
      breakStyle: 'bands',
      walk: [1, 0, 2, 0],
      parts: [
        ...stride('leg', 11, 2, [-20, -20], [-40, 28], 8, 'hull2', 'dark'),
        part('torso', chamfer(0, 2, 54, 36, 9), 'hull', 3, { lift: 6, details: [{ k: 'shape', pts: box(0, -8, 36, 4), tone: 'accent' }, { k: 'line', pts: [[-18, 10], [18, 10]], minPx: 50 }] }),
        part('drum', circle(0, 22, 12, 16), 'metal', 4, { lift: 8, details: [{ k: 'line', pts: circle(0, 22, 7, 12) }] }),
        ...sym(part('shoulder', circle(-27, -2, 11, 14), 'hull', 4, { lift: 8, sphere: true, details: [{ k: 'shape', pts: box(-27, -2, 14, 4), tone: 'accent' }] })),
        part('armL', capsule([-24, -6], [2, -28], 5.5, 4.5), 'hull', 5, { lift: 9 }),
        part('armR', capsule([24, -6], [14, -26], 5.5, 4.5), 'hull', 5, { lift: 9 }),
        part('cannon', capsule([9, -6], [9, -48], 5.5, 4), 'dark', 6, { lift: 10, details: [{ k: 'line', pts: [[4, -36], [14, -36]] }, { k: 'line', pts: [[4, -42], [14, -42]], minPx: 50 }] }),
        part('helmet', circle(0, -2, 15, 18), 'hull', 7, {
          lift: 12,
          sphere: true,
          details: [{ k: 'shape', pts: [[-9, -14], [9, -14], [9, -10], [2, -10], [2, -3], [-2, -3], [-2, -10], [-9, -10]], tone: 'dark' }],
        }),
      ],
    }),
  },
  // The Hailstorm carrier (tier 2, Vehicle Factory): a white tracked hull with a sloped glacis, red
  // bands, ammunition lockers and a rear engine deck; its airburst artillery turret sits in a socket
  // in the middle and turns on its own.
  'r-g-hailstorm': {
    w: 80,
    h: 100,
    spec: () => ({
      breakStyle: 'bands',
      parts: [
        ...sym(part('track', box(-31, 0, 16, 94), 'dark', 1, { lift: 2, details: treads(-38, -24, -44, 44, 14) })),
        part('hull', chamfer(0, 0, 50, 92, 10), 'hull', 2, {
          lift: 9,
          facets: bevel(0, 0, 50, 92, 7),
          details: [
            { k: 'shape', pts: box(0, -30, 40, 4), tone: 'accent' },
            { k: 'shape', pts: box(0, 26, 40, 4), tone: 'accent' },
            { k: 'line', pts: [[-18, -38], [18, -38]], minPx: 60 },
          ],
        }),
        ...sym(part('locker', box(-17, 34, 12, 12), 'hull2', 3, { lift: 10, details: [{ k: 'line', pts: [[-21, 34], [-13, 34]], minPx: 60 }] })),
        part('deck', box(0, 40, 14, 10), 'metal', 3, { lift: 10, details: treads(-6, 6, 36, 44, 3) }),
        part('hatch', circle(-14, -32, 5, 10), 'hull2', 3, { lift: 10 }),
      ],
    }),
  },
  // A trooper, one member of a squad (GroundSpec `squad`): white armour, the T visor of the helmet,
  // a backpack, a rifle held forward in both hands. It walks: standing, its boots show under it;
  // mid-stride one leg is out in front and the other behind (poses 1 and 2).
  'r-gm-trooper': {
    w: 76,
    h: 100,
    spec: () => ({
      breakStyle: 'bands',
      walk: [1, 0, 2, 0],
      parts: [
        ...stride('leg', 10, 0, [-20, -20], [-42, 26], 7, 'hull2', 'dark'),
        part('torso', chamfer(0, 0, 46, 32, 8), 'hull', 3, { lift: 6, details: [{ k: 'shape', pts: box(0, -8, 30, 4), tone: 'accent' }] }),
        part('pack', box(0, 17, 28, 14), 'hull2', 4, { lift: 7, details: [{ k: 'line', pts: [[-10, 17], [10, 17]], minPx: 40 }] }),
        ...sym(part('shoulder', circle(-23, -2, 10, 14), 'hull', 4, { lift: 7, sphere: true })),
        part('armL', capsule([-20, -6], [0, -30], 5, 4), 'hull', 5, { lift: 8 }),
        part('armR', capsule([20, -6], [10, -28], 5, 4), 'hull', 5, { lift: 8 }),
        part('rifle', capsule([7, -12], [7, -48], 3.4, 2.6), 'dark', 6, { lift: 9 }),
        part('helmet', circle(0, -2, 14, 18), 'hull', 7, {
          lift: 11,
          sphere: true,
          details: [{ k: 'shape', pts: [[-8, -13], [8, -13], [8, -9], [2, -9], [2, -3], [-2, -3], [-2, -9], [-8, -9]], tone: 'dark' }],
        }),
      ],
    }),
  },
  // The Raider hover tank (tier 1, Vehicle Factory): a low white wedge on a dark repulsor skirt
  // with glowing pads at its corners, red bands, side panels and a rear deck; its pulse cannon
  // turret sits in a socket in the middle and turns on its own.
  'r-g-raider': {
    w: 70,
    h: 100,
    spec: () => ({
      breakStyle: 'bands',
      parts: [
        part('skirt', chamfer(0, 2, 66, 92, 14), 'metal', 1, {
          lift: 3,
          details: [{ k: 'lights', pts: [[-27, -32], [27, -32], [-27, 36], [27, 36]], r: 2.6, tone: 'glow' }],
        }),
        part('hull', [[0, -48], [22, -36], [28, -8], [28, 36], [18, 46], [-18, 46], [-28, 36], [-28, -8], [-22, -36]], 'hull', 2, {
          lift: 8,
          facets: [{ pts: [[0, -48], [22, -36], [0, -28]], slope: [0.6, -0.8] }, { pts: [[0, -48], [-22, -36], [0, -28]], slope: [-0.6, -0.8] }],
          details: [
            { k: 'shape', pts: box(0, 30, 44, 4), tone: 'accent' },
            { k: 'shape', pts: [[-3, -44], [3, -44], [3, -30], [-3, -30]], tone: 'accent' },
            { k: 'line', pts: [[-24, 20], [24, 20]], minPx: 50 },
          ],
        }),
        ...sym(part('panel', box(-23, 12, 7, 34), 'hull2', 3, { lift: 9, details: [{ k: 'line', pts: [[-23, 0], [-23, 24]], minPx: 60 }] })),
        part('deck', box(0, 40, 32, 9), 'hull2', 3, { lift: 9, details: [{ k: 'lights', pts: along([-10, 42], [10, 42], 3), r: 1.4, tone: 'glow', minPx: 40 }] }),
      ],
    }),
  },
  // The dev walker test (ground/testWeapons.ts): a two-legged scout walker, its cockpit on two long
  // legs with broad feet, a turret on its back; its feet step out in turn as it walks.
  'r-gt-walker': {
    w: 80,
    h: 100,
    spec: () => ({
      breakStyle: 'bands',
      walk: [1, 0, 2, 0],
      parts: [
        ...[0, 1, 2].flatMap((pose) => {
          const fy = (side: number) => (pose === 0 ? 4 : pose === 1 ? (side < 0 ? -30 : 32) : side < 0 ? 32 : -30)
          return [-1, 1].flatMap((side) => [
            part(`foot${side < 0 ? 'L' : 'R'}${pose}`, chamfer(side * 28, fy(side), 20, 24, 6), 'hull2', 1, { lift: 2, pose, details: [{ k: 'line', pts: [[side * 28 - 6, fy(side) - 6], [side * 28 + 6, fy(side) - 6]], minPx: 50 }] }),
            part(`strut${side < 0 ? 'L' : 'R'}${pose}`, capsule([side * 24, 0], [side * 28, fy(side)], 4.5, 3.5), 'metal', 2, { lift: 8, pose }),
          ])
        }),
        ...sym(part('hip', circle(-24, 0, 8, 14), 'hull2', 3, { lift: 12, sphere: true })),
        part('body', chamfer(0, -2, 40, 50, 10), 'hull', 4, {
          lift: 14,
          facets: bevel(0, -2, 40, 50, 6),
          details: [
            { k: 'shape', pts: box(0, -20, 26, 5), tone: 'accent' },
            { k: 'shape', pts: box(0, -27, 18, 4), tone: 'glass' },
          ],
        }),
      ],
    }),
  },
  // A Lancer, one heavy trooper of a Lancer team (tier 3, Barracks): bulky white armour, a red
  // pauldron, a long rocket launcher on its right shoulder and a rack of rockets on its back.
  'r-gm-lancer': {
    w: 80,
    h: 100,
    spec: () => ({
      breakStyle: 'bands',
      walk: [1, 0, 2, 0],
      parts: [
        ...stride('leg', 12, 4, [-18, -18], [-40, 32], 8, 'hull2', 'dark'),
        part('pack', chamfer(0, 22, 38, 18, 5), 'hull2', 3, { lift: 6, details: [{ k: 'lights', pts: along([-12, 26], [12, 26], 4), r: 2.4, tone: 'accent' }] }),
        part('torso', chamfer(0, 2, 54, 34, 9), 'hull', 4, { lift: 7, facets: bevel(0, 2, 54, 34, 6), details: [{ k: 'shape', pts: box(0, -8, 34, 4), tone: 'accent' }] }),
        part('pauldronL', circle(-27, 0, 12, 16), 'accent', 5, { lift: 9, sphere: true }),
        part('pauldronR', circle(27, 0, 11, 16), 'hull', 5, { lift: 9, sphere: true }),
        part('armL', capsule([-24, -4], [6, -26], 6, 5), 'hull', 6, { lift: 10 }),
        // The launcher on the right shoulder: a long tube with a red band, a sight and a dark muzzle.
        part('launcher', capsule([21, 24], [21, -46], 7, 7), 'hull2', 7, {
          lift: 14,
          details: [{ k: 'shape', pts: box(21, -32, 14, 4), tone: 'accent' }, { k: 'line', pts: [[15, 8], [27, 8]], minPx: 40 }],
        }),
        part('muzzle', circle(21, -46, 5.5, 12), 'dark', 8, { lift: 14 }),
        part('sight', box(12, -14, 5, 10), 'metal', 8, { lift: 15, minPx: 30 }),
        part('helmet', circle(-3, -2, 14, 18), 'hull', 9, {
          lift: 12,
          sphere: true,
          details: [{ k: 'shape', pts: [[-12, -13], [6, -13], [6, -9], [-12, -9]], tone: 'glass' }, { k: 'shape', pts: box(-3, 0, 3, 12), tone: 'accent' }],
        }),
      ],
    }),
  },
  // The Bastion walker tank (tier 3, Vehicle Factory): a great armoured hull on six splayed legs,
  // red bands and a cockpit slit across its nose, a heavy shell cannon in its main turret forward
  // and a pulse gun turret on its back deck. Its legs step on alternate tripods (poses 1 and 2).
  'r-g-bastion': {
    w: 100,
    h: 94,
    spec: () => {
      // Each leg's hip (y), knee (x, out from the hull) and where its foot rests (y).
      const legs = [{ hy: -22, kx: 38, fy: -30 }, { hy: 2, kx: 41, fy: 3 }, { hy: 24, kx: 38, fy: 31 }]
      const legParts = [0, 1, 2].flatMap((pose) =>
        [-1, 1].flatMap((side) =>
          legs.flatMap((l, j) => {
            // Tripod A: left front, right middle, left back; tripod B the others.
            const a = (j === 1) === (side > 0)
            const fy = l.fy + (pose === 0 ? 0 : (pose === 1) === a ? -8 : 8)
            const ky = l.hy + (fy - l.hy) * 0.45
            const kx = side * l.kx
            const fx = side * 44
            const n = `${side < 0 ? 'L' : 'R'}${j}${pose}`
            return [
              part(`foot${n}`, chamfer(fx, fy, 11, 14, 4), 'hull2', 1, { lift: 3, pose, details: [{ k: 'line', pts: [[fx - 4, fy - 3], [fx + 4, fy - 3]], minPx: 60 }] }),
              part(`shin${n}`, capsule([kx, ky], [fx, fy], 4.2, 3.6), 'metal', 1.2, { lift: 7, pose }),
              part(`thigh${n}`, capsule([side * 22, l.hy], [kx, ky], 7, 5.4), 'hull', 1.4, { lift: 12, pose, details: [{ k: 'line', pts: [[side * 26, l.hy + (ky - l.hy) * 0.2], [side * 34, l.hy + (ky - l.hy) * 0.8]], minPx: 60 }] }),
              part(`knee${n}`, circle(kx, ky, 4.2, 10), 'metal', 1.6, { lift: 13, pose, sphere: true }),
            ]
          }),
        ),
      )
      return {
        breakStyle: 'bands',
        walk: [1, 0, 2, 0],
        parts: [
          ...legParts,
          // The hip housings the legs hang from, down both sides.
          ...sym(part('hipsL', chamfer(-22, 2, 12, 60, 4), 'metal', 2, { lift: 12 })),
          part('hull', [[-14, -44], [14, -44], [26, -31], [28, 20], [22, 40], [-22, 40], [-28, 20], [-26, -31]], 'hull', 3, {
            lift: 16,
            facets: [
              { pts: [[-14, -44], [14, -44], [24, -33], [-24, -33]], slope: [0, -0.8] },
              { pts: [[-28, 20], [28, 20], [22, 40], [-22, 40]], slope: [0, 0.75] },
            ],
            details: [
              { k: 'shape', pts: [[-9, -43], [9, -43], [7, -39], [-7, -39]], tone: 'glass' },
              { k: 'shape', pts: box(0, -30, 44, 4), tone: 'accent' },
              { k: 'line', pts: [[-26, 8], [26, 8]], minPx: 50 },
              { k: 'line', pts: [[-27, 18], [27, 18]], minPx: 60 },
            ],
          }),
          // Armour skirts over the hips, red-tipped at the back.
          ...sym(part('skirtL', [[-29, -26], [-20, -28], [-20, 30], [-27, 32]], 'hull2', 4, { lift: 17, slope: [-0.7, 0], details: [{ k: 'shape', pts: box(-24, 27, 6, 4), tone: 'accent' }, { k: 'line', pts: [[-28, 0], [-21, 0]], minPx: 50 }] })),
          part('deck', chamfer(0, 32, 30, 14, 4), 'hull2', 4, { lift: 17, details: [{ k: 'lights', pts: along([-9, 37], [9, 37], 4), r: 1.5, tone: 'glow', minPx: 40 }] }),
        ],
      }
    },
  },
}
