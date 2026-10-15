import { STATIONS } from '../../data.ts'
import { box, chamfer, circle, part } from '../kit.ts'
import type { ModelDef } from '../spec.ts'
import type { Part, Pt } from '../types.ts'
import { coreModule, defensePod, dockingModule, habitat, truss } from './style.ts'

// The Bastion Command Station: the Republic's orbital naval base, a cross-shaped frame that grows
// with every level, assembled from the sheet's five standard modules (models/republic/style.ts):
// the core (command module) in the middle, trusses for its arms and frames, habitats for crew and
// services, docking modules for its hangar and repair dock, and a defense module under every
// turret. Coordinates are frame pixels from the frame's centre (every stage of the frame is
// centred on the same point), where data/republic.ts places the modules.

/** The level-4 outer frame: square with blocky corner nodes, or an octagon with its corners cut. */
export type StationFrame = 'square' | 'octagon'
export const STATION_FRAMES: StationFrame[] = ['square', 'octagon']
/** The frame the battle draws until one is picked for good. */
export const STATION_FRAME: StationFrame = 'square'

/**
 * The station at its level: what each level adds, from the core out.
 *
 * - Level 1, Bastion Outpost: the core command module, four short truss stubs, and round it its
 *   first modules: a docking module with the hangar, a defense module with a turbolaser, and a
 *   habitat for each station research built (the targeting array, the refinery).
 * - Level 2, Bastion Command Post: the arms reach out to a defense module on each side, a habitat
 *   with the shield generator to the north and a docking module (the repair dock) to the south; a
 *   square truss frame ties them together, with crew nodes at its corners on diagonal struts.
 * - Level 3, Bastion Command Station: the arms run on to a long battery deck north and a docking
 *   module south, each with a turret pair, and habitats on the east and west arms; a truss ring
 *   round the core.
 * - Level 4, Bastion Citadel: a great outer truss frame (square or octagonal, `style`) on struts
 *   from the corners, carrying four turbolaser and two flak defense modules.
 *
 * A research module (targeting array, refinery, repair dock) brings the habitat or dock it stands on
 * with it, so research shows on the station as well as in the menus.
 */
export const station: ModelDef = ({ t, level, style }) => {
  const frame: StationFrame = style === 'octagon' ? 'octagon' : STATION_FRAME
  const parts: Part[] = []
  // A module's place, by its key, if the station has it now.
  const at = (key: string): Pt | null => {
    const i = t.hardpoints.findIndex((h) => h.key === key)
    if (i < 0) return null
    const h = t.hardpoints[i]
    const [x0, y0, x1, y1] = STATIONS.republic.stages[level - 1].box
    return [(h.x / 10 - 0.5) * (x1 - x0), (h.y / 10 - 0.5) * (y1 - y0)]
  }
  const has = (key: string) => !!at(key)

  // --- Level 4: the outer frame on struts, under everything else -----------------------------------
  if (level >= 4) {
    const X = 384
    const Y = 401
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) parts.push(truss(`strut${sx}${sy}`, [sx * 250, sy * 250], [sx * (X - 30), sy * (Y - 30)], 32, 0.6))
    const corners: Pt[] =
      frame === 'square'
        ? [[-X, -Y], [X, -Y], [X, Y], [-X, Y]]
        : [[-X + 110, -Y], [X - 110, -Y], [X, -Y + 110], [X, Y - 110], [X - 110, Y], [-X + 110, Y], [-X, Y - 110], [-X, -Y + 110]]
    corners.forEach((p, i) => parts.push(truss(`frame${i}`, p, corners[(i + 1) % corners.length], 40, 1)))
    if (frame === 'square') corners.forEach(([x, y], i) => parts.push(habitat(`node${i}`, x, y, 92, 92, 2.2)))
    else
      for (let i = 0; i < 8; i += 2) {
        const [ax, ay] = corners[(i + 1) % 8]
        const [bx, by] = corners[(i + 2) % 8]
        parts.push(habitat(`node${i}`, (ax + bx) / 2, (ay + by) / 2, 74, 74, 2.2))
      }
    // Defense modules on the frame, under its six guns.
    for (const k of ['t5', 't6', 't7', 't8']) {
      const p = at(k)
      if (p) parts.push(defensePod(`pod${k}`, p[0], p[1], 70, 3))
    }
    for (const k of ['f3', 'f4']) {
      const p = at(k)
      if (p) parts.push(defensePod(`pod${k}`, p[0], p[1], 58, 3))
    }
  }

  // --- The arms ---------------------------------------------------------------------------------
  const north = level >= 3 ? 470 : level >= 2 ? 255 : 186
  const south = level >= 3 ? 420 : level >= 2 ? 240 : 186
  const side = level >= 3 ? 400 : level >= 2 ? 215 : 186
  parts.push(
    truss('armN', [0, -70], [0, -north], 48, 1.6),
    truss('armS', [0, 70], [0, south], 48, 1.6),
    truss('armW', [-70, 0], [-side, 0], 44, 1.6),
    truss('armE', [70, 0], [side, 0], 44, 1.6),
  )
  if (level === 1)
    // The stubs end in small docking collars, ready for the arms to come.
    for (const [x, y, across] of [[0, -182, true], [0, 182, true], [-182, 0, false], [182, 0, false]] as const)
      parts.push(part(`stubEnd${x}${y}`, across ? box(x, y, 70, 20) : box(x, y, 20, 70), 'hull2', 2, { lift: 4, details: [{ k: 'shape', pts: across ? box(x, y, 16, 20) : box(x, y, 20, 16), tone: 'accent' }] }))

  // --- Level 2: the square frame, its corner nodes and the arms' end modules ----------------------
  if (level >= 2) {
    const F = 250
    const sq: Pt[] = [[-F, -F], [F, -F], [F, F], [-F, F]]
    sq.forEach((p, i) => parts.push(truss(`square${i}`, p, sq[(i + 1) % 4], 30, 1.2)))
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) parts.push(truss(`brace${sx}${sy}`, [sx * 100, sy * 100], [sx * (F - 30), sy * (F - 30)], 26, 1.1))
    sq.forEach(([x, y], i) => parts.push(habitat(`corner${i}`, x, y, 70, 70, 2)))
    // North: the shield deck under the generator.
    const s1 = at('s1')
    if (s1) parts.push(habitat('shieldDeck', s1[0], s1[1], 150, 104, 3))
    // East and west: defense modules.
    for (const k of ['t2', 'f1']) {
      const p = at(k)
      if (p) parts.push(defensePod(`pod${k}`, p[0], p[1], k === 't2' ? 70 : 60, 3))
    }
    // South: a docking module, with the repair dock on it once researched.
    parts.push(...dockingModule('southDock', 0, 290, has('dock') ? 230 : 190, 96, 3))
  }

  // --- Level 3: the battery deck, the south docks, the side habitats and the core's ring ---------
  if (level >= 3) {
    parts.push(habitat('batteryDeck', 0, -508, 290, 104, 3.4))
    for (const k of ['t3', 't4']) {
      const p = at(k)
      if (p) parts.push(defensePod(`pod${k}`, p[0], p[1], 66, 4))
    }
    const s2 = at('s2')
    if (s2) parts.push(part('shieldRing', circle(s2[0], s2[1], 60, 22), 'hull2', 4, { lift: 4, details: [{ k: 'shape', pts: circle(s2[0], s2[1], 54, 22), tone: 'accent' }, { k: 'shape', pts: circle(s2[0], s2[1], 48, 22), tone: 'hull2' }] }))
    parts.push(...dockingModule('southBar', 0, 458, 300, 100, 3.4))
    const f2 = at('f2')
    if (f2) parts.push(defensePod('podf2', f2[0], f2[1], 56, 4))
    for (const s of [-1, 1]) parts.push(habitat(`wing${s < 0 ? 'W' : 'E'}`, s * 438, 0, 92, 176, 3))
    parts.push(part('coreRing', circle(0, 0, 140, 32), 'metal', 5, { holes: [circle(0, 0, 112, 30)], lift: 4, details: [{ k: 'lights', pts: circle(0, 0, 126, 8), r: 4, tone: 'glass' }, { k: 'line', pts: circle(0, 0, 126, 32) }] }))
  }

  // --- Level 1: the core and its first modules ---------------------------------------------------
  const t1 = at('t1')
  if (t1) parts.push(defensePod('podt1', t1[0], t1[1], 70, 5))
  const h1 = at('h1')
  if (h1) parts.push(...dockingModule('hangarDock', h1[0], h1[1], 156, 104, 5))
  const sensor = at('sensor')
  if (sensor) parts.push(habitat('arrayDeck', sensor[0], sensor[1], 124, 112, 5))
  const refinery = at('refinery')
  if (refinery) parts.push(habitat('refineryDeck', refinery[0], refinery[1], 124, 112, 5))
  parts.push(...coreModule('core', 0, 0, level >= 3 ? 100 : 88, 7))
  // The command spire's beacon, lost as the station is battered.
  parts.push(part('beacon', box(0, level >= 3 ? -116 : -102, 8, 14), 'accent', 9, { glow: true, noOutline: true, detach: { hull: 0.3 } }))
  parts.push(part('antenna', chamfer(0, level >= 3 ? 116 : 102, 16, 22, 4), 'dark', 8, { lift: 3, detach: { hull: 0.45 }, details: [{ k: 'lights', pts: [[0, level >= 3 ? 110 : 96]], r: 3, tone: 'accent' }] }))
  return { parts, breakStyle: 'pie' }
}

