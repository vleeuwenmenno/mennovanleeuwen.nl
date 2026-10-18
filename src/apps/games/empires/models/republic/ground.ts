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
}

