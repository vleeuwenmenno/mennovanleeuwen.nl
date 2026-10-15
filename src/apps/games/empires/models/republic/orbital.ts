import { ORBITAL_FRAME } from '../../data.ts'
import { along, box, chamfer, circle, part, rect } from '../kit.ts'
import type { ModelDef } from '../spec.ts'
import type { Part, Pt } from '../types.ts'
import { coreModule, defensePod, dockingModule, habitat, mast, truss } from './style.ts'

// The Bastion defense station (Galactic conquest): built from the Bastion's standard modules, on the
// shared defense station frame (ORBITAL_FRAME, in frame units round the middle). Level 1 is an
// armoured octagonal hub with one gun deck; level 2 grows a truss arm west to a second deck and one
// east to a crew habitat; level 3 closes an octagonal truss ring round it all, with decks to the
// north and east (the habitat moves south onto a docking module). Every slot is a red-ringed gun
// deck; an empty one shows its open port, waiting for a module.

/** An empty module port: a dark well in a ringed plate, four guide lights round it. */
function port(id: string, [x, y]: Pt, r: number, z: number): Part {
  return part(id, circle(x, y, r, 20), 'hull2', z, {
    lift: 0.8,
    details: [
      { k: 'shape', pts: circle(x, y, r * 0.78, 18), tone: 'trim' },
      { k: 'shape', pts: circle(x, y, r * 0.58, 16), tone: 'dark' },
      { k: 'line', pts: circle(x, y, r * 0.36, 12) },
      { k: 'lights', pts: [[x, y - r * 0.68], [x + r * 0.68, y], [x, y + r * 0.68], [x - r * 0.68, y]], r: r * 0.09, tone: 'glow' },
    ],
  })
}

export const orbital: ModelDef = ({ t, level }) => {
  const S = ORBITAL_FRAME.slots
  const filled = t.orbital?.slots ?? []
  const parts: Part[] = []
  if (level >= 3) {
    // The outer ring: eight truss segments round the whole station, red marker plates on its sides.
    const R = 45
    const oct: Pt[] = Array.from({ length: 8 }, (_, i) => [Math.cos(((i + 0.5) / 8) * Math.PI * 2) * R, Math.sin(((i + 0.5) / 8) * Math.PI * 2) * R])
    oct.forEach((p, i) => parts.push(truss(`orbRing${i}`, p, oct[(i + 1) % 8], 5, 0.8)))
    for (const [i, a] of [0.25, 0.75].entries()) parts.push(part(`marker${i}`, box(Math.cos(a * Math.PI * 2 + Math.PI / 4) * R * 0.92, Math.sin(a * Math.PI * 2 + Math.PI / 4) * R * 0.92, 5, 5), 'accent', 1.2, { lift: 0.6 }))
    // Diagonal braces from the hub out to the ring.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4
      parts.push(truss(`brace${i}`, [Math.cos(a) * 18, Math.sin(a) * 18], [Math.cos(a) * 41, Math.sin(a) * 41], 3.6, 0.9))
    }
    // North and east gun decks on their arms; the habitat moves south, onto a docking module.
    parts.push(truss('armN', [0, -16], [0, S[3][1] + 9], 7, 1.1), truss('armE', [16, 0], [S[2][0] - 9, 0], 7, 1.1), truss('armS', [0, 16], [0, 30], 7, 1.1))
    parts.push(...dockingModule('dockS', 0, 36, 30, 11, 1.6))
    parts.push(habitat('habitatS', 0, 36, 14, 10, 2.2))
    parts.push(mast('mast', 20, 38, 9, 2.4, 0.5, 1.2))
  }
  if (level >= 2) {
    parts.push(truss('armW', [-16, 0], [S[1][0] + 9, 0], 7, 1.1))
    if (level === 2) {
      // The east arm: a crew habitat with its sensor mast, the station's counterweight.
      parts.push(truss('armE', [16, 0], [27, 0], 7, 1.1), habitat('habitatE', 34, 0, 16, 18, 2.2), mast('mast', 34, -12, 10, 2.4, 0.5, 1.2))
    }
    // Radiator fins off the hub (the ring's arms take their place at level 3).
    if (level === 2) for (const s of [-1, 1]) parts.push(part(`radFin${s < 0 ? 'N' : 'S'}`, rect(-9, s * 19 - (s < 0 ? 6 : 0), 18, 6), 'metal', 1.3, { lift: 0.6, details: [{ k: 'line', pts: [[-7, s * 21], [7, s * 21]] }] }))
  }
  // The hub: an armoured octagon with docking collars on its four sides and a core module under its
  // own gun deck.
  for (const [i, [x, y]] of ([[0, -20], [20, 0], [0, 20], [-20, 0]] as Pt[]).entries())
    if (level === 1) parts.push(part(`collar${i}`, box(x, y, x ? 4 : 9, x ? 9 : 4), 'hull2', 1.9, { lift: 0.8, details: [{ k: 'lights', pts: [[x, y]], r: 0.9, tone: 'glow' }] }))
  parts.push(part('hub', chamfer(0, 0, 38, 38, 11), 'hull', 2, {
    lift: 2,
    facets: [{ pts: [[-19, -8], [-8, -19], [-4, -19], [-4, 19], [-8, 19], [-19, 8]], slope: [-0.5, 0] }],
    details: [
      { k: 'shape', pts: rect(-19, -2.2, 38, 4.4), tone: 'accent' },
      { k: 'line', pts: chamfer(0, 0, 32, 32, 9) },
      { k: 'lights', pts: [...along([-11, -14], [11, -14], 4), ...along([-11, 14], [11, 14], 4)], r: 0.7, tone: 'glass', minPx: 140 },
    ],
  }))
  parts.push(...coreModule('core', 0, 0, 10, 2.4, false))
  // Each slot: its gun deck, and an open port where no module is fitted yet.
  for (let s = 0; s < ORBITAL_FRAME.counts[level - 1]; s++) {
    const [x, y] = S[s]
    if (s > 0) parts.push(defensePod(`gunDeck${s}`, x, y, 11.5, 2.5))
    if (!filled[s]) parts.push(port(`slotPort${s}`, [x, y], s ? 8.6 : 9.4, 3))
  }
  return { parts, breakStyle: 'pie' }
}
