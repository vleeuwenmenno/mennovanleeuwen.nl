import { arcBand, along, box, capsule, circle, ngon, part, rimFacets, sym, treads } from '../kit.ts'
import type { GroundModels } from '../ground.ts'
import type { Pt } from '../types.ts'

// The Confederacy's ground units, seen from straight above, light from the top left, in the space
// fleet's steel, gunmetal and burnt orange (plan D10: one look across modes). The Command Hub is an
// eight-sided industrial deck round a sphere core, as its space station is, with antenna spires, a
// cargo crane and its door to the south; the Forger builder droid hovers (its shadow falls further
// off) on a round body with two cutting arms and a rack of plates; the Supply Relay is a hexagonal
// power and parts deck round a humming mast, ringed by capacitor banks.

const OCT = Math.PI / 8

export const GROUND: GroundModels = {
  'd-g-center': {
    w: 100,
    h: 100,
    spec: () => {
      const rim = ngon(0, 0, 50, 8, OCT)
      return {
        breakStyle: 'ring',
        core: { x: 0, y: -2, r: 19 },
        parts: [
          // The deck's sloped rim, each of its eight sides lit for the way it faces.
          part('deck', rim, 'hull2', 1, { lift: 3, facets: rimFacets(rim, 0, 0, 0.86) }),
          // The deck plating, with panel lines and orange hazard markings on the diagonals.
          part('plates', ngon(0, 0, 43, 8, OCT), 'hull', 2, {
            lift: 1,
            details: [
              ...[0, 1, 2, 3].map((i) => ({ k: 'line' as const, pts: [ngon(0, 0, 43, 8, OCT + (i * Math.PI) / 4)[0], ngon(0, 0, 43, 8, OCT + (i * Math.PI) / 4)[4]], minPx: 60 })),
              ...[1, 3, 5, 7].map((i) => {
                const a = (i * Math.PI) / 4
                const c: Pt = [Math.cos(a) * 36, Math.sin(a) * 36]
                return { k: 'shape' as const, pts: ngon(c[0], c[1], 5, 4, a), tone: 'accent' as const }
              }),
              { k: 'lights', pts: ngon(0, 0, 40, 8, 0), r: 1.4, tone: 'glass', minPx: 60 },
            ],
          }),
          // The collar round the core and the core itself, a steel sphere with a teal sensor band.
          part('collar', circle(0, -2, 25, 24), 'metal', 3, { lift: 4, details: [{ k: 'line', pts: circle(0, -2, 22, 24) }] }),
          part('core', circle(0, -2, 19, 28), 'hull', 4, {
            lift: 12,
            sphere: true,
            details: [
              { k: 'line', pts: Array.from({ length: 13 }, (_, i) => [-19 + (38 * i) / 12, -2 + Math.sin((i / 12) * Math.PI) * 4] as Pt) },
              { k: 'lights', pts: [[-9, 2], [0, 4], [9, 2]], r: 1.6, tone: 'glass' },
              { k: 'shape', pts: box(0, -12, 10, 3), tone: 'accent' },
            ],
          }),
          // Antenna spires on the two north corners and the south-west one.
          ...sym(part('spire', capsule([-27, -27], [-34, -36], 2.6, 1.2), 'metal', 5, { lift: 18, details: [{ k: 'lights', pts: [[-34, -36]], r: 1.3, tone: 'trim' }] })),
          part('spireS', capsule([-27, 27], [-33, 34], 2.2, 1), 'metal', 5, { lift: 14 }),
          // The cargo crane on the east side, its jib over the deck, with a crate on the hook.
          part('craneBase', box(35, 12, 10, 18), 'metal', 3, { lift: 6, details: treads(31, 39, 4, 20, 3) }),
          part('jib', capsule([35, 6], [22, 28], 2.2, 1.6), 'hull2', 6, { lift: 16, details: [{ k: 'shape', pts: box(28, 18, 4, 3), tone: 'accent' }] }),
          part('crate', box(20, 31, 8, 7), 'accent', 3, { lift: 3, details: [{ k: 'line', pts: [[16, 31], [24, 31]] }] }),
          // The door on the south side, under its orange guide lights.
          part('door', box(0, 42, 24, 7), 'dark', 3, {
            lift: 1,
            details: [
              { k: 'line', pts: [[0, 39], [0, 45]] },
              { k: 'lights', pts: along([-10, 37], [10, 37], 4), r: 1.2, tone: 'trim' },
            ],
          }),
        ],
      }
    },
  },
  'd-g-engineer': {
    w: 84,
    h: 100,
    spec: () => ({
      breakStyle: 'bands',
      parts: [
        // Cutting arms, upper and fore, with glowing cutters at their tips.
        ...sym(part('armUpper', capsule([-16, -4], [-32, -26], 4, 3), 'metal', 1, { lift: 12 })),
        ...sym(part('armFore', capsule([-32, -26], [-22, -44], 3, 2), 'metal', 2, { lift: 12, details: [{ k: 'shape', pts: box(-28, -35, 3, 3), tone: 'accent' }] })),
        ...sym(part('cutter', [[-24, -44], [-18, -50], [-20, -42]] as Pt[], 'trim', 3, { lift: 12, glow: true })),
        // The plate rack slung behind the body.
        part('rack', box(0, 30, 32, 16), 'hull2', 2, {
          lift: 10,
          details: [...treads(-15, 15, 22, 38, 4), { k: 'shape', pts: box(0, 30, 32, 3), tone: 'accent' }],
        }),
        // Side thrusters that keep it up, their glow on the ground side.
        ...sym(part('thruster', circle(-25, 12, 7, 14), 'dark', 2, { lift: 12, details: [{ k: 'lights', pts: [[-25, 12]], r: 3, tone: 'glow' }] })),
        // The body: a round steel shell with orange markings and a teal sensor eye.
        part('body', circle(0, 4, 25, 28, 26), 'hull', 4, {
          lift: 14,
          sphere: true,
          details: [
            { k: 'line', pts: circle(0, 4, 18, 24, 19), minPx: 50 },
            { k: 'shape', pts: box(0, 18, 20, 4), tone: 'accent' },
          ],
        }),
        part('eye', circle(0, -14, 6, 14), 'glass', 5, { lift: 15, details: [{ k: 'lights', pts: [[0, -14]], r: 2.2, tone: 'glow' }] }),
        part('aerial', capsule([10, -8], [16, -22], 1.1, 0.8), 'metal', 5, { lift: 16 }),
      ],
    }),
  },
  'd-g-supply': {
    w: 100,
    h: 100,
    spec: () => {
      const rim = ngon(0, 0, 49, 6, Math.PI / 6)
      return {
        breakStyle: 'pie',
        parts: [
          // The six-sided deck's sloped rim, and the plating inside with orange hazard marks.
          part('deck', rim, 'hull2', 1, { lift: 3, facets: rimFacets(rim, 0, 0, 0.82) }),
          part('plates', ngon(0, 0, 40, 6, Math.PI / 6), 'hull', 2, {
            lift: 1,
            details: [
              ...[0, 2, 4].map((i) => {
                const a = Math.PI / 6 + (i * Math.PI) / 3 + Math.PI / 6
                return { k: 'shape' as const, pts: box(Math.cos(a) * 33, Math.sin(a) * 33, 8, 4), tone: 'accent' as const }
              }),
              { k: 'lights', pts: ngon(0, 0, 36, 6, 0), r: 1.3, tone: 'glass', minPx: 50 },
            ],
          }),
          // Capacitor banks on three sides, steel drums with orange caps.
          ...[-Math.PI * 0.83, -Math.PI * 0.17, Math.PI * 0.5 + 0.9].map((a, i) =>
            part(`bank${i}`, circle(Math.cos(a) * 26, Math.sin(a) * 26, 8, 18), 'metal', 3, {
              lift: 8,
              sphere: true,
              details: [{ k: 'shape', pts: circle(Math.cos(a) * 26, Math.sin(a) * 26, 3.2, 10), tone: 'accent' }],
            }),
          ),
          // The power coils round the mast, glowing teal.
          part('coil', arcBand(0, -2, 13, 17, -Math.PI * 0.9, Math.PI * 0.4, 14), 'glass', 3, { lift: 4, glow: true }),
          // The mast: a steel sphere with an antenna and sensor lights, humming.
          part('mast', circle(0, -2, 11, 22), 'hull', 4, {
            lift: 14,
            sphere: true,
            details: [{ k: 'lights', pts: [[-5, 1], [5, 1], [0, -7]], r: 1.4, tone: 'glass' }],
          }),
          part('antenna', capsule([0, -6], [8, -20], 1.4, 0.8), 'metal', 5, { lift: 18, details: [{ k: 'lights', pts: [[8, -20]], r: 1.4, tone: 'trim' }] }),
          // The door on the south side, under its orange guide lights.
          part('door', box(0, 37, 18, 6), 'dark', 3, { lift: 1, details: [{ k: 'lights', pts: along([-7, 33], [7, 33], 3), r: 1.1, tone: 'trim' }] }),
          ...sym(part('strut', box(-30, 24, 6, 12), 'metal', 2, { lift: 3, details: treads(-33, -27, 19, 29, 2) })),
        ],
      }
    },
  },
  // The probe droid: a dark round sensor head on its repulsors, a red photoreceptor, four thin arms
  // trailing behind and the pulse blaster slung under its front.
  'd-g-scout': {
    w: 64,
    h: 100,
    spec: () => ({
      breakStyle: 'bands',
      parts: [
        // The trailing arms, bent back and out.
        ...sym(part('armOut', capsule([-12, 10], [-30, 40], 2.4, 1.6), 'metal', 1, { lift: 6 })),
        ...sym(part('armIn', capsule([-6, 16], [-12, 46], 2, 1.4), 'metal', 1, { lift: 6 })),
        // The blaster under its chin.
        part('blaster', capsule([0, -18], [0, -46], 4, 3), 'dark', 2, { lift: 10, details: [{ k: 'shape', pts: box(0, -40, 5, 3), tone: 'accent' }] }),
        // The head: a sphere of dark plating with an orange band, its repulsor collar under it.
        part('collar', circle(0, 0, 27, 24), 'hull2', 3, { lift: 10 }),
        part('head', circle(0, -2, 22, 26), 'hull', 4, {
          lift: 14,
          sphere: true,
          details: [{ k: 'line', pts: circle(0, -2, 15, 20), minPx: 40 }, { k: 'shape', pts: box(0, 10, 22, 3), tone: 'accent' }],
        }),
        part('eye', circle(0, -14, 5, 14), 'glass', 5, { lift: 15, details: [{ k: 'lights', pts: [[0, -14]], r: 2, tone: 'ember' }] }),
        part('antenna', capsule([8, 4], [16, 18], 1, 0.7), 'metal', 5, { lift: 16 }),
      ],
    }),
  },
  // A Power Relay (2 × 2 tiles): a squat reactor stack, three heavy conduits fanning out to the
  // corners, orange hazard bands, and a teal glow at the top of the stack.
  'd-g-generator': {
    w: 100,
    h: 100,
    spec: () => {
      const rim = ngon(0, 0, 48, 8, Math.PI / 8)
      return {
        breakStyle: 'pie',
        parts: [
          part('deck', rim, 'hull2', 1, { lift: 3, facets: rimFacets(rim, 0, 0, 0.84) }),
          ...[-2.4, -0.7, 0.9, 2.5].map((a, i) => part(`conduit${i}`, capsule([Math.cos(a) * 14, Math.sin(a) * 14], [Math.cos(a) * 40, Math.sin(a) * 40], 6, 4), 'metal', 2, { lift: 5, details: [{ k: 'shape', pts: box(Math.cos(a) * 30, Math.sin(a) * 30, 6, 6), tone: 'accent' }] })),
          part('stack', ngon(0, -2, 24, 8, Math.PI / 8), 'hull', 3, { lift: 12, facets: rimFacets(ngon(0, -2, 24, 8, Math.PI / 8), 0, -2, 0.6) }),
          part('band', ngon(0, -2, 16, 8, Math.PI / 8), 'accent', 4, { lift: 14 }),
          part('glow', circle(0, -2, 9, 18), 'glass', 5, { lift: 15, glow: true, details: [{ k: 'lights', pts: [[0, -2]], r: 3, tone: 'glow' }] }),
          part('door', box(0, 40, 18, 6), 'dark', 3, { lift: 1, details: [{ k: 'lights', pts: along([-6, 36], [6, 36], 3), r: 1.1, tone: 'trim' }] }),
        ],
      }
    },
  },
  // A Data Core (3 × 3 tiles): a shielded computing block in steel plates round a glowing core,
  // server racks either side, antenna masts and orange markings.
  'd-g-research': {
    w: 100,
    h: 100,
    spec: () => ({
      breakStyle: 'pie',
      parts: [
        part('pad', box(0, 2, 96, 92), 'hull2', 1, { lift: 2, details: [{ k: 'line', pts: box(0, 2, 86, 82) }, { k: 'shape', pts: box(0, 44, 30, 3), tone: 'accent' }] }),
        ...sym(part('rack', box(-32, 2, 18, 60), 'metal', 2, { lift: 6, details: [...treads(-40, -24, -26, 30, 7), { k: 'lights', pts: along([-32, -24], [-32, 26], 5), r: 1.2, tone: 'glass', minPx: 50 }] })),
        part('block', ngon(0, 0, 30, 6, 0), 'hull', 3, { lift: 10, facets: rimFacets(ngon(0, 0, 30, 6, 0), 0, 0, 0.7), details: [{ k: 'shape', pts: box(0, 18, 20, 3), tone: 'accent' }] }),
        part('core', circle(0, 0, 13, 20), 'dark', 4, { lift: 12 }),
        part('glow', circle(0, 0, 9, 18), 'glass', 5, { lift: 13, glow: true, details: [{ k: 'lights', pts: [[0, 0]], r: 3, tone: 'glow' }] }),
        ...sym(part('mast', capsule([-20, -30], [-26, -42], 2.2, 1.1), 'metal', 5, { lift: 16, details: [{ k: 'lights', pts: [[-26, -42]], r: 1.3, tone: 'trim' }] })),
        part('door', box(0, 38, 20, 6), 'dark', 3, { lift: 1, details: [{ k: 'lights', pts: along([-7, 34], [7, 34], 3), r: 1.1, tone: 'trim' }] }),
      ],
    }),
  },
}
