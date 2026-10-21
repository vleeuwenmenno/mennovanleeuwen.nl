import type { FactionId, TechEffect } from './kit.ts'

// Ground battles' research, done at the factories (ground/jobs.ts): each factory has a short list
// for the units it trains (better weapons, armour, speed), paid with research points (which the
// research stations make) and kyber, taking time and drawing power while it runs. A piece of
// research done is the side's (Player `techs`, as space research is), and works through the space
// game's research path: techBonus adds it to every unit type the factory trains (sim.ts modsFor),
// so units already out and those trained later have it alike.

/** A piece of ground research: done at factory `for`, for the units it trains. */
export type GroundTech = {
  id: string
  faction: FactionId
  /** The factory (unit type id) it is done at; it works on what that factory trains. */
  for: string
  name: string
  blurb: string
  /** Research points and kyber it costs, seconds it takes and power it draws while it runs. */
  rp: number
  cost: number
  time: number
  draw: number
  /** The tier the factory must stand at to start it. */
  tier: number
  effect: TechEffect
}

/** Power a factory draws while it researches (an upgrade to the next tier draws its own, GroundSpec
 * `tierUp`). */
export const RESEARCH_DRAW = 3

type Line = { key: 'weapons' | 'armour' | 'speed'; name: string; blurb: string }
const LINES: Record<string, { faction: FactionId; lines: [string, string, string] }> = {
  'r-g-barracks': { faction: 'republic', lines: ['Marksman drills', 'Phase II armour', 'Forced march'] },
  'r-g-vfactory': { faction: 'republic', lines: ['Heavy blaster cells', 'Durasteel plating', 'Uprated repulsors'] },
  'd-g-botfactory': { faction: 'droid', lines: ['Targeting firmware', 'Reinforced chassis', 'Actuator overdrive'] },
  'd-g-foundry': { faction: 'droid', lines: ['Overcharged cannons', 'Laminate armour', 'Turbine boost'] },
  's-g-brood': { faction: 'swarm', lines: ['Acid glands', 'Thick carapace', 'Swift legs'] },
  's-g-nest': { faction: 'swarm', lines: ['Venom sacs', 'Bone plating', 'Muscle grafts'] },
}

/** Each factory's three: weapons and armour from tier 1, speed once it stands at tier 2. */
const KINDS: (Omit<Line, 'name'> & { rp: number; cost: number; time: number; tier: number; effect: TechEffect })[] = [
  { key: 'weapons', blurb: 'Its units deal 15% more damage.', rp: 80, cost: 150, time: 30, tier: 1, effect: { damage: 0.15 } },
  { key: 'armour', blurb: 'Its units have 15% more hull.', rp: 80, cost: 150, time: 30, tier: 1, effect: { hull: 0.15 } },
  { key: 'speed', blurb: 'Its units move 10% faster.', rp: 100, cost: 200, time: 35, tier: 2, effect: { speed: 0.1 } },
]

export const GROUND_TECHS: GroundTech[] = Object.entries(LINES).flatMap(([factory, { faction, lines }]) =>
  KINDS.map((k, i) => ({ id: `${factory}-${k.key}`, faction, for: factory, name: lines[i], blurb: k.blurb, rp: k.rp, cost: k.cost, time: k.time, draw: RESEARCH_DRAW, tier: k.tier, effect: k.effect })),
)
export const GROUND_TECH: Record<string, GroundTech> = Object.fromEntries(GROUND_TECHS.map((t) => [t.id, t]))
/** The research done at factory type `factory`, in card order. */
export const groundTechsFor = (factory: string) => GROUND_TECHS.filter((t) => t.for === factory)
