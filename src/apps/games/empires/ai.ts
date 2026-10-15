import { ABILITIES, BUILD_RADIUS, LEVEL_UP, MAX_LEVEL, MODULE, REBUILD, RUSH_TECH, worksOf, type ModuleId, type Works, SURVEY_RADIUS, TECH, TECHS, UNIT, UPGRADES, buildable, builtAt, isEngineer, isShip, prefixOf, unitOf, yardOf, type FactionId, type Tech, type Tier, type UnitType } from './data.ts'
import { inside } from './maps.ts'
import { mapDist, rangeDist } from './scale.ts'
import {
  allQueued, building, canRetreat, cantBuild, cantExpand, cantRush, cmdExpand, cmdRush, moduleRebuildCost, cantMend, cantRepair, cantResearch, cantSite, cantUpgradeSite, cmdUpgradeSite, cmdAbility, cmdAttack, cmdBuild, cmdConstruct, cmdDeploy, cmdGuard, cmdMove, cmdPlace, cmdRally, cmdRepair, cmdResearch, cmdRetreat, cmdSite, cmdGive,
  canSee, cantReinforce, dpsVs, fleet, shipPrice, foes, moduleUp, near, placement, radius, rand, researchLock, sees, shieldMax, type Owner, type Unit, type World,
} from './sim.ts'
import * as M from './detmath.ts'
import { sq } from './detmath.ts'

// The enemy admiral. Every second or two it looks at the battle and decides: claim ore and build
// mines, upgrade the station on time, research what it flies, build up through the ship classes with
// a mix that counters what it has seen, put up gun platforms, defend what's under attack, pull its
// battered heavy ships back to mend, and once its fleet has gathered, go after the enemy's mines and
// station together, guns focused. The headless sims run one on each side. It has a person's hands:
// only so many actions a minute (each command is one, a move for a whole group included), and it
// notices an attack on its base a moment late. It reads only what its side can see (and remembers
// what it saw). All of it runs on the world's clock and dice, so every copy of a multiplayer battle
// makes the same choices.
//
// How hard it plays is its difficulty (DIFFICULTY); how it plays is its profile (PROFILES):
// defensive, balanced or offensive.

export type Difficulty = 'veryEasy' | 'easy' | 'medium' | 'hard'

type Level = {
  name: string
  blurb: string
  /** Income multiplier. */
  income: number
  /** Seconds between decisions. */
  think: number
  /** Fleet value it waits for before its first attack. */
  wave: number
  mines: number
  /** Focuses its fleet's fire, and aims heavy guns at shield generators. */
  focus: boolean
  /** Seconds before it attacks anything of ours; its scouts only take neutral ore and beacons until then. */
  calm: number
  research: boolean
  abilities: boolean
  defenses: boolean
  /** Actions a minute at most (commands: a move for a group of ships is one). */
  apm: number
  /** Seconds before it notices something attacking its station or platforms. */
  react: number
  /** How keen it is on repair craft once it has warships to mend (0: never). */
  menders: number
  /** How late it upgrades its station, against its profile's timetable (1: on time). */
  pace: number
}

export const DIFFICULTY: Record<Difficulty, Level> = {
  veryEasy: {
    name: 'Very easy', blurb: 'A sleepy recruit: earns little, never researches, and leaves you alone for the first ten minutes.',
    income: 0.55, think: 3.5, wave: 5000, mines: 2, focus: false, calm: 600, research: false, abilities: false, defenses: false, apm: 25, react: 6, menders: 0, pace: 1.8,
  },
  easy: {
    name: 'Easy', blurb: 'Slow to react and slow to grow. No attacks for the first six minutes.',
    income: 0.68, think: 3, wave: 4200, mines: 3, focus: false, calm: 360, research: true, abilities: false, defenses: false, apm: 35, react: 4, menders: 0.03, pace: 1.35,
  },
  medium: {
    name: 'Medium', blurb: 'A fair fight. It leaves you about two and a half minutes to settle in (a minute and a half if it plays offensively).',
    income: 1, think: 1.5, wave: 2500, mines: 4, focus: true, calm: 150, research: true, abilities: true, defenses: true, apm: 60, react: 2, menders: 0.08, pace: 1,
  },
  hard: {
    name: 'Hard', blurb: 'Quick, greedy, aggressive from the start, and it goes for your shield generators.',
    income: 1.25, think: 0.8, wave: 2000, mines: 5, focus: true, calm: 0, research: true, abilities: true, defenses: true, apm: 100, react: 1, menders: 0.16, pace: 0.85,
  },
}

/** How an AI admiral plays, picked per AI seat next to its difficulty (part of the match config,
 * so every copy of a multiplayer battle runs the same admirals). */
export type Profile = 'defensive' | 'balanced' | 'offensive'
export const PROFILE_IDS: Profile[] = ['defensive', 'balanced', 'offensive']

type Style = {
  name: string
  blurb: string
  /** The fleet value it gathers before its first attack, as a share of its difficulty's. */
  wave: number
  /** The quiet start before it attacks anything of ours, as a share of its difficulty's. */
  calm: number
  /** Seconds after a wave comes home before the next may set out. */
  rest: number
  /** A wave turns back once it is down to this share of what it set out with... */
  regroup: number
  /** ...or once what it sees round it is this many times stronger than it. */
  outgunned: number
  /** It calls a wave home when what attacks its base is worth this share of the wave. */
  recall: number
  /** How much stronger than the enemy fleet it has seen its own must be before a wave goes out. */
  edge: number
  /** How far from its station a beacon on its side may be for its fleet to wait on it. */
  beaconReach: number
  /** Against an attack on an outlying mine or platform it goes out to fight only with this share
   * of the attackers' strength (counting its structures' guns there); otherwise it waits under
   * the station's guns. */
  hold: number
  /** A turtle: it builds its platforms even while saving for the station, cheaper, shields and
   * armours its mines sooner, and strikes whenever what it has seen of the enemy fleet is small. */
  turtle: boolean
  /** Defense platforms it keeps at station level 1 and 2, more per level above that, at most. */
  platforms: number
  platPerLevel: number
  platMax: number
  /** When it upgrades the station to level 2, 3 and 4 (seconds into the battle, at its pace), and
   * the fleet value per station level it wants to have before it does. */
  levels: [number, number, number]
  levelArmy: number
  /** Mining platforms on top of its difficulty's (and one more from station level 3). */
  mines: number
  /** Fast ships it keeps raiding the enemy's mines (0: none). */
  raiders: number
  /** It strikes back as soon as an attack on its base has been beaten off, or when what it has
   * seen of the enemy's fleet is small next to its own. */
  counter: boolean
  /** How much it wants the station's guns researched, against the other research. */
  fortify: number
  /** Credits it keeps in hand when it buys research. */
  keep: number
  /** Cruisers and flagships below this share of their hull go home to be mended. */
  mendAt: number
  /** How much it likes each ship class, on top of its counters (see pickShip). */
  tiers: Partial<Record<Tier, number>>
  /** Hybrid bases: seconds after reaching station level 2 before it puts up its Frigate Yard (an
   * offensive admiral has its engineers bought by then and places it at once), and the warships
   * it keeps guarding the yard once it stands. */
  yardDelay: number
  yardGuards: number
  /** Seconds after reaching station level 3 before it puts up its Capital Yard. */
  cyardDelay: number
  /** The expansions it wants, most wanted first (the Capital slip always comes first once it can:
   * that's the way to the flagships). */
  modules: ModuleId[]
  /** Fleet battles: an attacker pulls out below this share of the defender's strength... */
  bail: number
  /** ...and a holder goes out to meet attackers this much further from its station. */
  sally: number
}

export const PROFILES: Record<Profile, Style> = {
  defensive: {
    name: 'Defensive',
    blurb: 'Turtles: more gun platforms and a fortified station, strikes late with a big fleet, and counter-attacks as soon as your attack fails.',
    wave: 1.6, calm: 1.3, rest: 60, regroup: 0.5, outgunned: 1.2, recall: 0.35, edge: 1.25, beaconReach: 3800, hold: 0.85, turtle: true, platforms: 1, platPerLevel: 1, platMax: 3, levels: [170, 400, 680], levelArmy: 900, mines: 0, raiders: 0, counter: true, fortify: 3, keep: 300, mendAt: 0.5,
    tiers: { capital: 1.25, cruiser: 1.1, frigate: 1.1, fighter: 0.8 }, yardDelay: 45, yardGuards: 2, cyardDelay: 20, modules: ['shieldCore', 'drydock', 'armourWorks', 'sensorArray', 'fighterWing', 'secondSlip', 'strikeHangar'], bail: 0.4, sally: 0.8,
  },
  balanced: {
    name: 'Balanced',
    blurb: 'A steady mix: expands, upgrades and researches as it goes, and attacks once it has gathered a fleet.',
    wave: 1, calm: 1, rest: 45, regroup: 0.4, outgunned: 1.5, recall: 0.6, edge: 1.25, beaconReach: 4300, hold: 0.85, turtle: false, platforms: 0, platPerLevel: 1, platMax: 1, levels: [170, 400, 680], levelArmy: 900, mines: 1, raiders: 0, counter: true, fortify: 1.2, keep: 200, mendAt: 0.35,
    tiers: {}, yardDelay: 10, yardGuards: 2, cyardDelay: 40, modules: ['secondSlip', 'shieldCore', 'drydock', 'strikeHangar', 'armourWorks', 'sensorArray', 'fighterWing'], bail: 0.3, sally: 1,
  },
  offensive: {
    name: 'Offensive',
    blurb: 'Early pressure: raids your mines, attacks often and takes risks. Few platforms, later upgrades.',
    wave: 0.7, calm: 0.6, rest: 15, regroup: 0.25, outgunned: 2, recall: 1.2, edge: 0.9, beaconReach: 4800, hold: 0.6, turtle: false, platforms: 0, platPerLevel: 0.5, platMax: 1, levels: [200, 460, 800], levelArmy: 1000, mines: 1, raiders: 2, counter: false, fortify: 0.5, keep: 100, mendAt: 0.25,
    tiers: { gunship: 1.25, fighter: 1.2, capital: 0.85 }, yardDelay: 0, yardGuards: 1, cyardDelay: 75, modules: ['secondSlip', 'strikeHangar', 'sensorArray', 'drydock', 'armourWorks', 'fighterWing', 'shieldCore'], bail: 0.2, sally: 1.6,
  },
}
/**
 * How each faction fights, on top of its admiral's profile (PROFILES):
 * - the Republic as the profiles say;
 * - the Confederacy concentrates its fire harder (its warships join a focus from further off, see
 *   focusFire) and sends its fast warships round the flank of a goal (see waves), and likes its heavy
 *   classes a little more;
 * - the Swarm favours numbers and fast production (small, quickly grown ships; build-time research
 *   worth twice as much) and goes out with smaller waves.
 * `tiers` multiplies the profile's taste for each class, `wave` the fleet value it waits for before a
 * wave, `quick` how much it favours ships that are quick to build, `focus` the reach of its focus
 * fire, `flank` whether fast ships go round the side, `build` the worth of build-time research.
 */
type Doctrine = { tiers: Partial<Record<Tier, number>>; wave: number; quick: number; focus: number; flank: boolean; build: number }
export const DOCTRINE: Record<FactionId, Doctrine> = {
  republic: { tiers: {}, wave: 1, quick: 0, focus: 1, flank: false, build: 1 },
  droid: { tiers: { cruiser: 1.1, capital: 1.15 }, wave: 1, quick: 0, focus: 1.3, flank: true, build: 1 },
  swarm: { tiers: { fighter: 1.15, gunship: 1.15 }, wave: 1, quick: 0.25, focus: 1, flank: false, build: 2 },
}
const doctrineOf = (w: World, b: Brain) => DOCTRINE[w.players[b.o].faction] ?? DOCTRINE.republic

/** The profile for a stored value: anything unknown (or missing, from before profiles) is Balanced. */
export const profileOf = (v: unknown): Profile => (typeof v === 'string' && (PROFILE_IDS as string[]).includes(v) ? (v as Profile) : 'balanced')

export type Brain = {
  o: Owner
  diff: Difficulty
  /** How it plays (see PROFILES). Brains saved before profiles play Balanced. */
  profile: Profile
  t: number
  /** The fleet value it gathers before it attacks (it grows after a wave that failed). */
  wave: number
  attacking: boolean
  peak: number
  scouts: Set<number>
  want: string | null
  lastWave: number
  /** Actions it can take right now (refilling at its APM, a few seconds' worth at most), and how
   * many it has taken. */
  hands: number
  acts: number
  /** When it first saw something attacking its base (-1: nothing is). */
  alarm: number
  /** When it started gathering a wave at the rally point (-1: it isn't). */
  muster: number
  /** When the last wave came home. */
  home: number
  /** The ships of the wave out now; ships built since wait and follow in batches. */
  troops: number[]
  /** Ships raiding the enemy's mines (offensive), and the ore it sent them to last. */
  raid: number[]
  raidAt: number
  /** Heavy ships sent home to be mended. */
  mending: number[]
  /** The enemy the wave's guns are on. */
  focus: number
  /** When the wave out now went for the enemy station (-1: it hasn't; it keeps to it until it turns
   * back), and whether it has gathered and gone in. */
  siege: number
  storm: boolean
  /** The wave out now set out with the fleet at its limit: with nothing more to wait for, it
   * fights on longer before it turns back (see ALL_IN). */
  allIn: boolean
  /** The enemy ships it has seen, by type: the most of each it has seen at once, fading. */
  foes: Record<string, number>
  /** The enemy structures with guns it has seen, by id: where they stand and what their guns are
   * worth (see guns), kept while it can't see them, until it sees the spot without them. */
  walls: Record<number, [number, number, number]>
  /** The most it has seen attacking its base during the alarm now, and when an attack on its base
   * was last beaten off (-1: never). */
  threatPeak: number
  beaten: number
  /** How big the attack it beat off last was. */
  threatPeakLast: number
  /** No new scouts before this (one was just lost). */
  scoutWait: number
  /** Hybrid bases: when it reached station level 2 (-1: not yet), and the ships guarding its yard.
   * `engSeen`: its engineer craft at the last look; `engWait`: no new engineers before this (some
   * were just lost). */
  lv2: number
  /** When it reached station level 3 (-1: not yet), for the Capital Yard. */
  lv3: number
  guards: number[]
  /** The ships escorting its flagship (see escort). */
  escort: number[]
  engSeen: number
  engWait: number
  /** No reinforcement bought before this (see reinforcements); absent in brains saved before them. */
  reinfAt?: number
  /** The flagship it has settled on saving for, where its side has more than one (see flagshipFor);
   * absent until it first wants one. */
  flag?: string
}

/** How far from home something has to be before the AI calls a reinforcement in from hyperspace
 * rather than wait for a ship to fly out to it; and the least time between two it buys. */
export const REINFORCE_AI = { far: mapDist(3200), every: 60 }

/**
 * Where a reinforcement would help, or null: one of our mines or platforms, or a beacon we hold, far
 * from home with enemy ships at it; or the wave out now, far from home and fighting something about
 * its match or more. The spot is a little back from the fight, towards home, where our side sees.
 */
function reinforceSpot(w: World, b: Brain, st: Unit, army: Unit[]): { x: number; y: number; face: number } | null {
  const o = b.o
  const team = w.players[o].team
  const far = (x: number, y: number) => sq(x - st.x) + sq(y - st.y) > sq(REINFORCE_AI.far)
  const back = (x: number, y: number, by: number) => {
    const a = M.atan2(st.y - y, st.x - x)
    return { x: x + M.cos(a) * by, y: y + M.sin(a) * by, face: a + Math.PI }
  }
  for (const u of w.units) {
    if (u.dead || u.owner !== o || (u.t.tier !== 'mine' && u.t.tier !== 'defense') || !far(u.x, u.y)) continue
    if (threatAt(w, o, u.x, u.y) >= 600) return back(u.x, u.y, radius(u.t) + 300)
  }
  for (const bc of w.beacons) {
    if (bc.owner !== team || !far(bc.x, bc.y)) continue
    if (threatAt(w, o, bc.x, bc.y) >= 600) return back(bc.x, bc.y, 350)
  }
  const wave = b.attacking ? army.filter((u) => b.troops.includes(u.id)) : []
  if (wave.length) {
    const c = centre(wave)
    const there = threatAt(w, o, c.x, c.y, rangeDist(1200))
    if (far(c.x, c.y) && there > 0 && there >= value(wave) * 0.7) return back(c.x, c.y, rangeDist(500))
  }
  return null
}

/**
 * Reinforcements (a battle with the lobby's reinforcement rules): ships fly out of the yards as a
 * rule, and only where that is too slow (see reinforceSpot) does the admiral pay the surcharge for
 * one called in from hyperspace: a medium or harder one, at most one a minute, with credits to spare,
 * a warship off its usual list (no flagships). Whatever waits in the reserve is called in at once,
 * to where it is needed, or failing that next to the rally point.
 */
function reinforcements(w: World, b: Brain, st: Unit, army: Unit[]) {
  const R = w.reinforce
  if (!R || !w.hybrid || w.fleet) return
  const o = b.o
  const p = w.players[o]
  const spot = reinforceSpot(w, b, st, army)
  for (const id of p.reserve.slice(0, 2)) {
    const at = spot ?? { x: p.rally.x, y: p.rally.y, face: M.atan2(w.h / 2 - p.rally.y, w.w / 2 - p.rally.x) }
    for (let i = 0; i < 8; i++) {
      const a = rand(w) * Math.PI * 2
      const d = 120 + rand(w) * 380
      if (act(b, () => cmdDeploy(w, o, id, at.x + M.cos(a) * d, at.y + M.sin(a) * d, at.face))) break
      if (b.hands < 1) break
    }
  }
  if (!spot || !R.ships || b.diff === 'veryEasy' || b.diff === 'easy' || p.reserve.length) return
  if (w.time < (b.reinfAt ?? 0) || allQueued(w, o).some((q) => q.reserve)) return
  const id = pickShip(w, b, (t) => t.tier !== 'fighter' && t.tier !== 'capital' && !cantReinforce(w, t.id))
  if (!id || cantBuild(w, o, id, true) || p.credits < shipPrice(w, id, true) + PROFILES[b.profile].keep) return
  if (act(b, () => cmdBuild(w, o, id, true), true)) b.reinfAt = w.time + REINFORCE_AI.every
}

/** The quiet start before it attacks anything of ours: its difficulty's, stretched or shortened
 * by its profile; never shorter than the easy levels promise. */
const calmOf = (b: Brain) => {
  const D = DIFFICULTY[b.diff]
  const c = D.calm * PROFILES[b.profile].calm
  return b.diff === 'easy' || b.diff === 'veryEasy' ? Math.max(D.calm, c) : c
}

/** The most actions it can save up: a few seconds' worth. */
const handsMax = (D: Level) => Math.max(3, D.apm / 12)

export const newBrain = (o: Owner, diff: Difficulty, profile: Profile = 'balanced'): Brain => ({
  o, diff, profile, t: 2, wave: DIFFICULTY[diff].wave * PROFILES[profile].wave, attacking: false, peak: 0, scouts: new Set(), want: null, lastWave: 0, hands: handsMax(DIFFICULTY[diff]), acts: 0, alarm: -1,
  muster: -1, home: 0, troops: [], raid: [], raidAt: -1, mending: [], focus: 0, siege: -1, storm: false, allIn: false, foes: {}, walls: {}, threatPeak: 0, beaten: -1, threatPeakLast: 0, scoutWait: 0, lv2: -1, lv3: -1, guards: [], escort: [], engSeen: 0, engWait: 0,
})

/** Its hands free up again with time (every tick, thinking or not). A brain saved before any of
 * its fields existed gets them here. */
function rest(b: Brain, dt: number) {
  const D = DIFFICULTY[b.diff]
  // A brain saved before it had hands starts with them free.
  b.hands = Math.min(handsMax(D), (b.hands ?? handsMax(D)) + (dt * D.apm) / 60)
  b.acts ??= 0
  b.alarm ??= -1
  if (b.profile === undefined) b.profile = 'balanced'
  b.muster ??= -1
  b.home ??= 0
  b.troops ??= []
  b.raid ??= []
  b.raidAt ??= -1
  b.mending ??= []
  b.focus ??= 0
  if (typeof b.siege !== 'number') b.siege = -1
  b.storm ??= false
  b.allIn ??= false
  b.foes ??= {}
  b.walls ??= {}
  b.threatPeak ??= 0
  b.beaten ??= -1
  b.threatPeakLast ??= 0
  b.scoutWait ??= 0
  b.lv2 ??= -1
  b.lv3 ??= -1
  b.guards ??= []
  b.escort ??= []
  b.engSeen ??= 0
  b.engWait ??= 0
}
/** Take an action if its hands are free; it counts only when the command went through (a refusal,
 * which comes back as a string, costs nothing). A `spare` action (the economy) leaves one free for
 * the fighting. */
function act(b: Brain, command: () => unknown, spare = false) {
  if (b.hands < (spare ? 2 : 1)) return false
  if (typeof command() === 'string') return false
  b.hands--
  b.acts++
  return true
}

const value = (us: Unit[]) => us.reduce((s, u) => s + (u.t.cost / u.t.squad) * (0.3 + 0.7 * (u.hull / u.hullMax)), 0)
const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => sq(a.x - b.x) + sq(a.y - b.y)
const centre = (us: Unit[]) => ({ x: us.reduce((s, u) => s + u.x, 0) / Math.max(1, us.length), y: us.reduce((s, u) => s + u.y, 0) / Math.max(1, us.length) })
const warship = (u: Unit) => u.t.tier === 'frigate' || u.t.tier === 'cruiser' || u.t.tier === 'capital'
/** Repair craft and engineers: they keep to their own work, out of the fighting. */
const worker = (u: Unit) => u.t.kind === 'repair' || isEngineer(u.t)
/** Whether a ship type carries a spinal gun (Weapon spinal): the whole ship turns to aim it. */
const spinalOn = (t: UnitType) => t.weapons.some((x) => x.spinal) || t.hardpoints.some((h) => h.weapon?.spinal)

/**
 * The flagship it saves for. Most sides have one; where a side has more (the Confederacy's carrier
 * battleship and its fire-control Tyrant), it settles on one when it first wants a flagship, drawn
 * by what suits its fleet (a fire-control ship the more warships it has, a carrier a little more,
 * the cheaper a little more), and keeps to it until one is out. Saving for its side's first
 * flagship alone, the Confederacy never built a Tyrant.
 */
function flagshipFor(w: World, b: Brain): UnitType {
  const p = w.players[b.o]
  const all = buildable(p.faction).filter((t) => t.tier === 'capital' && (!t.tech || p.techs.includes(t.tech)))
  if (all.length <= 1) return all[0] ?? unitOf(p.faction, 'capital')
  const army = fleet(w, b.o).filter((u) => !u.parent)
  // One flying or on order: nothing to settle until it's gone.
  if (army.some((u) => u.t.tier === 'capital') || allQueued(w, b.o).some((q) => UNIT[q.unit].tier === 'capital')) {
    b.flag = undefined
    return all[0]
  }
  const kept = b.flag ? all.find((t) => t.id === b.flag) : undefined
  if (kept) return kept
  const warships = army.filter(warship).length
  const weights = all.map((t) => (t.fireControl ? 1 + Math.min(1.5, warships / 5) : 1) * (t.carrier ? 1.2 : 1) * Math.sqrt(4000 / Math.max(1000, t.cost)))
  // Drawn from a hash of the side and the clock, not the battle's dice: settling on a flagship
  // leaves every other roll of the battle as it was.
  const roll = ((Math.imul(b.o + 1, 2654435761) ^ Math.imul(Math.floor(w.time), 40503)) >>> 0) / 4294967296
  let r = roll * weights.reduce((s, v) => s + v, 0)
  let pick = all[all.length - 1]
  for (let i = 0; i < all.length; i++) {
    r -= weights[i]
    if (r <= 0) {
      pick = all[i]
      break
    }
  }
  b.flag = pick.id
  return pick
}

function visibleEnemies(w: World, o: Owner, x: number, y: number, r: number) {
  const out: Unit[] = []
  near(w, x, y, r, (u) => {
    if (foes(w, u.owner, o) && sees(w, o, u) && isShip(u.t)) out.push(u)
  })
  return out
}

/**
 * A spot near (x, y) at about the same distance from the station, clear of nebulas and asteroid
 * fields: a fleet gathering inside a nebula would sit there without shields and half blind, and
 * one in a field would grind on rocks every time it shuffles about. The map is no secret, so this
 * doesn't peek at anything the player can't see.
 */
function clearSpot(w: World, st: Unit, x: number, y: number) {
  const bad = (px: number, py: number) => inside(w.map.nebulas, px, py, 250) || inside(w.map.fields, px, py, 200)
  if (!bad(x, y)) return { x, y }
  const a0 = M.atan2(y - st.y, x - st.x)
  const d0 = M.hypot(x - st.x, y - st.y)
  for (const d of [d0, d0 * 0.7, d0 * 1.4])
    for (const da of [0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4]) {
      const px = Math.min(w.w - 80, Math.max(80, st.x + M.cos(a0 + da) * d))
      const py = Math.min(w.h - 80, Math.max(80, st.y + M.sin(a0 + da) * d))
      if (!bad(px, py)) return { x: px, y: py }
    }
  return { x, y }
}

/** What the enemy has (that we can see) around a spot. */
const threatAt = (w: World, o: Owner, x: number, y: number, r = rangeDist(900)) => value(visibleEnemies(w, o, x, y, r))

/** What a structure's guns are worth in a fight, in credits of ships: about a frigate for each
 * working heavy gun, less for flak, and nothing for a mine's point defence. */
function guns(u: Unit) {
  if (u.t.tier === 'mine') return 0
  let v = 0
  u.t.hardpoints.forEach((h, i) => {
    if (h.weapon && u.hps[i].hp > 0) v += h.weapon.kind === 'flak' ? 150 : 650
  })
  return v * (0.4 + 0.6 * (u.hull / u.hullMax))
}

/** What a fleet would run into round a spot: the enemy ships we can see and the guns of the
 * stations and platforms there (which everyone can see once they've been found). */
function forceAt(w: World, o: Owner, x: number, y: number, r: number) {
  let v = 0
  near(w, x, y, r, (u) => {
    if (!foes(w, u.owner, o) || !sees(w, o, u)) return
    v += isShip(u.t) ? (u.t.cost / u.t.squad) * (0.3 + 0.7 * (u.hull / u.hullMax)) : guns(u)
  })
  return v
}

/** Keeps its picture of the enemy's fleet: for each type, the most of it seen at once, fading
 * slowly (half in about two minutes) once it's out of sight. Only what its side can see. */
function remember(w: World, b: Brain) {
  const now: Record<string, number> = {}
  for (const u of w.units) if (!u.dead && foes(w, u.owner, b.o) && sees(w, b.o, u) && isShip(u.t) && u.t.kind !== 'wing') now[u.t.id] = (now[u.t.id] ?? 0) + u.t.cost / u.t.squad
  for (const id of Object.keys(b.foes)) {
    b.foes[id] *= 0.99
    if (b.foes[id] < 30 && !now[id]) delete b.foes[id]
  }
  for (const [id, v] of Object.entries(now)) b.foes[id] = Math.max(b.foes[id] ?? 0, v)
  // The structures with guns: as last seen, until the spot is in sight with nothing there.
  const team = w.players[b.o].team
  for (const u of w.units) if (!u.dead && foes(w, u.owner, b.o) && !isShip(u.t) && sees(w, b.o, u) && u.t.tier !== 'mine') b.walls[u.id] = [u.x, u.y, guns(u)]
  for (const [id, [x, y]] of Object.entries(b.walls)) {
    const u = w.byId.get(Number(id))
    if ((!u || u.dead || !sees(w, b.o, u)) && canSee(w, team, x, y)) delete b.walls[Number(id)]
  }
}

/** What it believes guards a spot: what it sees there now (forceAt), and the guns of the enemy
 * structures round it it has seen before and can't see now. A wave that judged a base by its
 * station alone found the platforms and yards round it on arrival, turned back, forgot them, and
 * came again. */
function knownForce(w: World, b: Brain, x: number, y: number, r: number) {
  let v = forceAt(w, b.o, x, y, r)
  for (const [id, [wx, wy, g]] of Object.entries(b.walls)) {
    const u = w.byId.get(Number(id))
    if (u && !u.dead && sees(w, b.o, u)) continue
    if (sq(wx - x) + sq(wy - y) < sq(r)) v += g
  }
  return v
}

/** The enemy fleet it believes in: what it remembers, or with nothing seen yet, a guess at an even
 * mix of the enemy's early ships. */
function foeMix(w: World, b: Brain): [UnitType, number][] {
  const seen = Object.entries(b.foes).filter(([id]) => UNIT[id])
  if (seen.length) return seen.map(([id, v]) => [UNIT[id], v])
  const enemy: FactionId = w.players.find((q) => q.team !== w.players[b.o].team)?.faction ?? 'republic'
  return (['fighter', 'gunship', 'frigate'] as Tier[]).map((t) => [unitOf(enemy, t), 600])
}

/**
 * What to save up for next. Every ship it could build is weighed by how well it counters the enemy
 * fleet it believes in (the damage it deals to that mix per credit, times how long it lasts under
 * that mix's fire, from the same tables the guns use), by how far up the classes it is (bigger ships once the
 * station allows them, rather than more of the early ones), and by its profile's taste; then one is
 * drawn by weight with the battle's dice. Specialists by what they're for: a repair tender once
 * there's a fleet worth mending, ion ships against shields, repair craft once unlocked.
 */
export function pickShip(w: World, b: Brain, only?: (t: UnitType) => boolean): string | null {
  const p = w.players[b.o]
  const S = PROFILES[b.profile]
  const Doc = DOCTRINE[p.faction] ?? DOCTRINE.republic
  const options = buildable(p.faction).filter((t) => {
    if (only && !only(t)) return false
    const why = cantBuild(w, b.o, t.id)
    return !why || why === 'Not enough credits'
  })
  if (!options.length) return null
  const mix = foeMix(w, b)
  const total = mix.reduce((s, [, v]) => s + v, 0) || 1
  const shielded = mix.reduce((s, [t, v]) => s + (t.shield > 0 && t.tier !== 'fighter' ? v : 0), 0) / total
  const small = mix.reduce((s, [t, v]) => s + (t.tier === 'fighter' || t.tier === 'gunship' ? v : 0), 0) / total
  const off = new Map<UnitType, number>()
  const risk = new Map<UnitType, number>()
  for (const t of options) {
    off.set(t, mix.reduce((s, [e, v]) => s + v * dpsVs(t, e.tier), 0) * t.squad / Math.max(1, t.cost))
    risk.set(t, mix.reduce((s, [e, v]) => s + (v / Math.max(1, e.cost / e.squad)) * dpsVs(e, t.tier), 0) / Math.max(1, t.hull + t.shield))
  }
  // Damage dealt to that fleet per credit before it's shot down: what it hits for, against how
  // fast it dies (fire per credit, times staying power).
  const eff = new Map(options.map((t) => [t, off.get(t)! / Math.max(1e-6, risk.get(t)!)]))
  const effMax = Math.max(...eff.values()) || 1
  const army = fleet(w, b.o).filter((u) => !u.parent)
  const queued = allQueued(w, b.o)
  const count = (id: string) => army.filter((u) => u.t.id === id).length / UNIT[id].squad + queued.filter((q) => q.unit === id).length
  const tenders = army.filter((u) => u.t.kind === 'support').length
  const menders = army.filter((u) => u.t.kind === 'repair').length / 2
  const warships = army.filter(warship).length
  // Up the classes: the biggest the station allows are wanted most, the early ones less once
  // there's better, unless they're what counters the enemy.
  const base: Record<string, number> = { fighter: 1, gunship: 1, frigate: 1.6, cruiser: 2.4, capital: 4 }
  const armyValue = value(army)
  const tierPref = (t: UnitType) => {
    let v = base[t.tier] ?? 1
    // A flagship takes a long saving up: worth it once there's a fleet to fight beside it.
    if (t.tier === 'capital') v *= Math.min(1, armyValue / 5000)
    if (p.level >= 3 && (t.tier === 'fighter' || t.tier === 'gunship')) v *= 0.45
    if (p.level >= 4 && t.tier === 'frigate') v *= 0.7
    return v * (S.tiers[t.tier] ?? 1) * (Doc.tiers[t.tier] ?? 1)
  }
  const weight = (t: UnitType) => {
    let v = tierPref(t) * (0.1 + eff.get(t)! / effMax)
    // Ion barely scratches a hull, whatever its numbers say: one ship to strip shields for every
    // few warships, and only against shields.
    // (A spinal lance is its side's shield breaker of choice: worth a little more.)
    if (t.kind === 'ion') v *= ((shielded > 0.4 ? 0.6 : 0.15) * (spinalOn(t) ? 1.5 : 1)) / (1 + count(t.id))
    if (t.kind === 'bomber') v *= 1 - small * 0.6
    // A fire-control ship makes every warship round it hit harder: worth more the more there are.
    if (t.fireControl) v *= 1 + Math.min(1.5, warships / 6) * t.fireControl.bonus * 4
    // A drain ship heals the fleet it flies with: worth more with a fleet, one or two at most.
    if (t.drain) v *= (army.length >= 5 ? 1.3 : 0.6) / (1 + 0.6 * count(t.id))
    // Living hulls mend themselves between fights: a little more staying power than the numbers say.
    if (t.regrow) v *= 1.1
    // Quick to build (the Swarm's way): ships out of the yard sooner count for more.
    if (Doc.quick) v *= Math.pow(30 / Math.max(5, t.build), Doc.quick)
    // A mix rather than one kind: each one already flying makes the next a little less wanted.
    return v / (1 + 0.12 * count(t.id))
  }
  const line = options.map((t) => (t.kind === 'support' || t.kind === 'repair' ? 0 : Math.pow(weight(t), 1.5)))
  const top = Math.max(...line, 0.01)
  // Specialists by need, next to the best of the line ships: a repair tender for a fleet worth
  // mending, a squadron or two of repair craft once there are warships to look after.
  const ws = options.map((t, i) =>
    t.kind === 'support' ? (army.length >= 6 && tenders < 1 + army.length / 10 ? top * 0.35 : 0)
      : t.kind === 'repair' ? (warships >= 1 && menders < Math.min(2, warships / 2) ? top * 0.3 : 0)
        : line[i])
  let r = rand(w) * ws.reduce((s, v) => s + v, 0)
  for (let i = 0; i < options.length; i++) {
    r -= ws[i]
    if (r <= 0) return options[i].id
  }
  return options[options.length - 1].id
}

/** How much each kind of research is worth per point of effect (0.25 hull is a quarter's worth). */
const EFFECT_WORTH: Record<string, number> = {
  range: 1.4, hull: 1, shield: 0.9, regen: 0.3, damage: 1.1, cooldown: 1.1, speed: 0.35, build: 0.4, hangar: 0.9, repair: 0.7, mines: 0,
  // The faction mechanics' research (see TechEffect): an aura's few points of bonus go a long way.
  shieldDamage: 0.8, aura: 5, auraRadius: 0.6, regrow: 0.6, regrowDelay: 0.5, drain: 0.8, drainHeal: 0.5,
}

/**
 * The research worth doing next, or null: the station's refinery once there are mines to pay it
 * back, its guns (more for a defensive admiral, and while its base is under attack), the repair
 * dock once it has heavy ships to mend; for the ships, upgrades for what it flies most, by the
 * credits of them it has (or is building), what the upgrade does (range, armour and shields first)
 * and its price; and the repair craft unlock once it has warships. Only what it can start now.
 */
function pickTech(w: World, b: Brain, mines: number): Tech | null {
  const p = w.players[b.o]
  const S = PROFILES[b.profile]
  const D = DIFFICULTY[b.diff]
  const army = fleet(w, b.o).filter((u) => !u.parent)
  const flying = new Map<string, number>()
  for (const u of army) flying.set(u.t.id, (flying.get(u.t.id) ?? 0) + u.t.cost / u.t.squad)
  for (const q of p.queue) flying.set(q.unit, (flying.get(q.unit) ?? 0) + UNIT[q.unit].cost)
  const heavy = army.filter((u) => u.t.tier === 'cruiser' || u.t.tier === 'capital').length + p.queue.filter((q) => UNIT[q.unit].tier === 'cruiser' || UNIT[q.unit].tier === 'capital').length
  const warships = army.filter(warship).length
  const st = w.byId.get(p.station)
  let best: Tech | null = null
  let score = 0.5
  for (const t of TECHS) {
    if (t.faction !== p.faction || researchLock(p, t.id)) continue
    // At level 1 every credit goes into mines and ships, bar the refinery that pays for itself.
    if (p.level < 2 && !t.effect.mines) continue
    let s = 0
    const e = t.effect
    if (UNIT[t.for]?.tier === 'station' || t.for === st?.t.id) {
      if (e.mines) s = mines >= 2 ? 2.5 + mines : 0.3
      else if (e.damage) s = b.alarm >= 0 || (b.beaten >= 0 && w.time - b.beaten < 120) ? S.fortify * 2 : p.level >= 2 ? S.fortify : 0
      else if (e.repair) s = heavy ? 4 : warships >= 2 ? 1.2 : 0.2
      // Every ship built faster: worth it with a fleet to build, the more so for a side that wins by
      // numbers (DOCTRINE build).
      else if (e.fleetBuild) s = (army.length >= 4 ? 1.6 : 0.5) * Math.abs(e.fleetBuild) * 10 * DOCTRINE[p.faction].build
      // Every living hull grows back faster: worth it once there is a fleet to mend.
      else if (e.regrow || e.regrowDelay) s = warships >= 3 ? 1.8 : army.length >= 4 ? 0.8 : 0.2
    } else if (t.id === RUSH_TECH[p.faction]) {
      // Rushed construction is decided on its own (see think): not weighed against the upgrades.
      s = 0
    } else if (!Object.keys(e).length) {
      // An unlock: the repair craft.
      s = warships >= 2 || (st && st.hull < st.hullMax * 0.8) ? 0.6 + D.menders * 12 : 0
    } else {
      const have = flying.get(t.for) ?? 0
      const worth = Object.entries(e).reduce((sum, [k, v]) => sum + Math.abs(v ?? 0) * (EFFECT_WORTH[k] ?? 0.5) * (k === 'build' ? DOCTRINE[p.faction].build : 1) * 4, 0)
      s = (have / 1000) * worth * (600 / Math.max(300, t.cost))
    }
    s *= 0.9 + rand(w) * 0.2
    if (s > score) {
      score = s
      best = t
    }
  }
  return best
}

export function think(w: World, b: Brain, dt: number) {
  rest(b, dt)
  b.t -= dt
  if (b.t > 0 || w.winner !== -1) return
  const D = DIFFICULTY[b.diff]
  const S = PROFILES[b.profile]
  b.t = D.think * (0.8 + rand(w) * 0.4)
  const o = b.o
  const p = w.players[o]
  const st = w.byId.get(p.station)
  if (!st || st.dead) return
  const team = p.team
  remember(w, b)
  // The nearest enemy station still standing.
  const enemySt = w.players
    .filter((q) => q.alive && q.team !== team)
    .map((q) => w.byId.get(q.station))
    .filter((u): u is Unit => !!u && !u.dead)
    .sort((a, c) => d2(a, st) - d2(c, st))[0]
  // Rally in front of the station, towards the nearest enemy (or the middle of the map), out of
  // any nebula or asteroid field; or, better, on the beacon nearest home (on our side of the map,
  // not too far out), so the fleet waiting there holds it: beacons pay and raise the fleet limit.
  const aim = enemySt ?? { x: w.w / 2, y: w.h / 2 }
  const ad = M.hypot(aim.x - st.x, aim.y - st.y) || 1
  const front = clearSpot(w, st, st.x + ((aim.x - st.x) / ad) * mapDist(560), st.y + ((aim.y - st.y) / ad) * mapDist(560))
  // (Out in the middle only while its fleet is a match for what it has seen of the enemy's.)
  const mainNow = value(fleet(w, o).filter((u) => !u.parent && !worker(u) && !b.scouts.has(u.id) && !b.raid.includes(u.id)))
  const seenNow = Object.values(b.foes).reduce((sum, v) => sum + v, 0)
  const homeBeacon = mainNow >= seenNow * 0.9 && mainNow >= 2000
    ? w.beacons
      .filter((bc) => (!enemySt || d2(bc, st) <= d2(bc, enemySt) * 1.02) && d2(bc, st) < sq(S.beaconReach) && !inside(w.map.nebulas, bc.x, bc.y, 150))
      .sort((x, y) => d2(x, st) - d2(y, st))[0]
    : undefined
  const rally = homeBeacon ? clearSpot(w, st, homeBeacon.x + (st.x - homeBeacon.x) * 0.04, homeBeacon.y + (st.y - homeBeacon.y) * 0.04) : front
  // (Only when it has moved: leaving it where it is takes no hands.)
  if (d2(rally, p.rally) > sq(60)) act(b, () => cmdRally(w, o, rally.x, rally.y), true)

  // --- The economy ---------------------------------------------------------------------------------
  const mines = w.units.filter((u) => u.owner === o && u.t.tier === 'mine').length
  const platforms = w.units.filter((u) => u.owner === o && u.t.tier === 'defense').length
  // Ore counts as ours to take when it's nearer to us than to any enemy station, and nearer to us
  // than to an ally's, so allies don't take each other's.
  const enemyStations = w.players.filter((q) => q.alive && q.team !== team).map((q) => w.byId.get(q.station)).filter((u): u is Unit => !!u)
  const allyStations = w.players.filter((q) => q.alive && q.team === team && q !== p).map((q) => w.byId.get(q.station)).filter((u): u is Unit => !!u)
  const nearerUs = (n: { x: number; y: number }) => allyStations.every((a) => d2(n, st) <= d2(n, a))
  // Once every claim on our half has something on it, it reaches for the ore in the middle.
  const homeFull = w.nodes.every((n) => !(enemyStations.every((e) => d2(n, st) < d2(n, e) * 1.05) && nearerUs(n)) || (n.owner === team && n.site))
  const reach = homeFull && D.research ? 1.8 : 1.05
  const mineToTake = (n: { x: number; y: number }) => enemyStations.every((e) => d2(n, st) < d2(n, e) * reach) && nearerUs(n)
  // Build on our team's claims nearest us; an ally's own patch is theirs (unless they're gone).
  const ours = w.nodes.filter((n) => n.owner === team && !n.site && nearerUs(n)).sort((a, c) => d2(a, st) - d2(c, st))
  // Mining expands steadily, one more from station level 3; platforms by profile and level.
  const mineGoal = D.mines + (D.research ? S.mines : 0) + (p.level >= 3 && D.research ? 1 : 0)
  const platGoal = D.defenses ? Math.min(S.platMax, S.platforms + Math.floor(Math.max(0, p.level - 2) * S.platPerLevel)) : 0
  // Surveyed ore with nothing on it is money left on the table: save for a mine before more ships.
  // (A gun platform goes up once a couple of mines are and there is a claim to spare for it, or
  // once every mine it wants is up: then the last free claim is its. A claim kept for a platform
  // the money never came for left a turtle mining on two asteroids all game.)
  const platNext = platforms < platGoal && mines >= 2 && (ours.length >= 2 || mines >= mineGoal)
  const savingForMine = !!ours[0] && mines < mineGoal && !(platNext && ours.length === 1)
  // What is attacking our station, mines or platforms right now (as far as we can see).
  const assets = w.units.filter((u) => u.owner === o && (u.t.tier === 'station' || u.t.tier === 'mine' || u.t.tier === 'defense' || u.t.tier === 'yard'))
  let threat: Unit | undefined
  let threatValue = 0
  let hit: Unit | undefined
  for (const a of assets) {
    const seen = visibleEnemies(w, o, a.x, a.y, rangeDist(1000))
    const v = value(seen)
    if (seen.length && v > threatValue) {
      threat = seen.sort((x, y) => d2(x, a) - d2(y, a))[0]
      threatValue = v
      hit = a
    }
  }
  if (!threat) {
    // An attack on the base that came to nothing: worth striking back while they're weak.
    if (b.alarm >= 0 && b.threatPeak >= 600) {
      b.beaten = w.time
      b.threatPeakLast = b.threatPeak
    }
    b.alarm = -1
    b.threatPeak = 0
  } else {
    if (b.alarm < 0) b.alarm = w.time
    b.threatPeak = Math.max(b.threatPeak, threatValue)
  }
  // Heavy ships sent home to mend stay out of the fighting until they're whole again.
  b.mending = b.mending.filter((id) => {
    const u = w.byId.get(id)
    return !!u && !u.dead && u.hull < u.hullMax * 0.9
  })
  const mendingIds = new Set(b.mending)
  const army = fleet(w, o).filter((u) => !u.parent)
  const armyValue = value(army)

  // Rush launch: a desperate measure. With its base under a real attack, or the enemy's warships
  // near home well outnumbering ours there, the Capital Yard sends out its ship half built rather
  // than lose it unfinished; never otherwise (a rushed ship costs build time and the yard's pace).
  if (w.hybrid) {
    const cy = w.units.find((u) => !u.dead && u.owner === o && worksOf(u.t) === 'cyard' && !u.site)
    if (cy && !cantRush(w, o, cy.id)) {
      const R = rangeDist(2500)
      const theirs = value(visibleEnemies(w, o, st.x, st.y, R))
      const mine = value(army.filter((u) => d2(u, st) < sq(R)))
      if ((threat && threatValue >= 500) || theirs > Math.max(600, mine * 2)) act(b, () => cmdRush(w, o, cy.id), true)
    }
  }

  // The station goes up a level on its profile's timetable (or sooner when rich), once there's a
  // fleet to protect the investment. When it's due, it saves for it first.
  const next = UPGRADES[p.level + 1]
  const leveling = p.research.some((r) => r.id === LEVEL_UP)
  const levelAt = S.levels[Math.min(2, p.level - 1)] * D.pace
  const upgradeDue = p.level < MAX_LEVEL && !leveling && !!next && (w.time >= levelAt || p.credits >= next.cost * 2) && armyValue >= p.level * S.levelArmy
  // While it saves for the station, a base under an attack bigger than its fleet still gets ships.
  // It stops buying ships only once the upgrade is within about 45 seconds' income; further off,
  // the yard keeps one order going meanwhile.
  const saving = upgradeDue && !(threatValue > armyValue * 0.8) && p.credits + p.income * 45 >= next!.cost
  const lean = upgradeDue && !saving
  // Hybrid bases: the yards, their engineers and guards (yardSaving: it is saving up for one, so
  // the extras below wait too).
  const yardSaving = w.hybrid ? planYard(w, b, D, S, st, enemySt, army) && !(threatValue > armyValue * 0.8) : false
  const savingNow = saving || yardSaving

  if (ours[0]) {
    // A gun platform goes where it covers most, on the claim nearest the enemy, once a couple of
    // mines are up; mines go on the claims nearest home.
    const front = enemySt ? [...ours].sort((a, c) => d2(a, enemySt) - d2(c, enemySt))[0] : ours[ours.length - 1]
    const plat = platNext
    if (plat && (!savingNow || b.alarm >= 0 || S.turtle) && p.credits >= 650 + (S.turtle ? 100 : 400)) act(b, () => cmdSite(w, o, front.id, defenseFor(w, o)), true)
    else if (mines < mineGoal && p.credits >= 500) {
      const spot = plat ? ours.find((n) => n !== front) : ours[0]
      if (spot) act(b, () => cmdSite(w, o, spot.id, unitOf(p.faction, 'mine').id), true)
    }
  }

  // Spare money deepens the drills: a mining platform pays its upgrades back within minutes.
  if (p.credits > 1200 && !savingNow) {
    const site = w.units.find((u) => u.owner === o && !u.dead && u.t.tier === 'mine' && !cantUpgradeSite(w, o, u, 'yield'))
    if (site) act(b, () => cmdUpgradeSite(w, o, site.id, 'yield'), true)
  }
  // Richer still, platforms get shield generators (a defensive admiral sooner, and armour too).
  if (p.credits > (S.turtle ? 1500 : 1900) && !savingNow) {
    const site = w.units.find((u) => u.owner === o && !u.dead && u.t.tier === 'mine' && !cantUpgradeSite(w, o, u, 'shield'))
    if (site) act(b, () => cmdUpgradeSite(w, o, site.id, 'shield'), true)
    else if (S.turtle) {
      const plate = w.units.find((u) => u.owner === o && !u.dead && u.t.tier === 'mine' && !cantUpgradeSite(w, o, u, 'armor'))
      if (plate) act(b, () => cmdUpgradeSite(w, o, plate.id, 'armor'), true)
    }
  }
  // Badly damaged structures get a repair crew when there's money to spare.
  for (const u of w.units) {
    if (u.owner !== o || u.dead || (u.t.tier !== 'station' && u.t.tier !== 'mine' && u.t.tier !== 'defense' && u.t.tier !== 'yard')) continue
    if (savingNow && !(u.t.tier === 'station' && u.hull < u.hullMax * 0.5)) continue
    if (u.hull < u.hullMax * 0.6 || u.hps.some((h) => h.hp <= 0)) if (!cantRepair(w, o, u) && p.credits > 900) act(b, () => cmdRepair(w, o, u.id), true)
  }

  if (upgradeDue && p.credits >= next!.cost && p.research.length === 0) act(b, () => cmdResearch(w, o, LEVEL_UP), true)

  // Research with a purpose, one at a time (the station's level shares the queue), once the yard
  // is busy (or it's saving up for a ship), keeping some credits in hand.
  const yards = w.units.filter((u) => !u.dead && u.owner === o && u.t.tier === 'yard' && !building(u)).length
  const queued = allQueued(w, o).length

  if (D.research && !saving && !yardSaving && p.research.length === 0 && queued >= 1 && w.time > 90) {
    const tech = pickTech(w, b, mines)
    const capitalSaved = !!b.want && UNIT[b.want].tier === 'capital'
    if (tech && p.credits >= tech.cost + S.keep + (capitalSaved ? 800 : 0) && !cantResearch(w, o, tech.id)) act(b, () => cmdResearch(w, o, tech.id), true)
  }

  // Rushed construction: insurance for the Capital Yard, once it stands. A defensive admiral takes
  // it out as soon as it can pay for it, a balanced one with credits to spare, an offensive one only
  // when it is rich.
  const rushTech = RUSH_TECH[p.faction]
  if (D.research && w.hybrid && p.research.length === 0 && !saving && !p.techs.includes(rushTech) && !cantResearch(w, o, rushTech)) {
    const spare = S.fortify >= 2 ? 0 : S.fortify >= 1 ? 600 : 1800
    if (p.credits >= TECH[rushTech].cost + spare) act(b, () => cmdResearch(w, o, rushTech), true)
  }

  // Expansions for the station and the yards, by profile, with credits to spare.
  const modSaving = w.hybrid && !saving && !yardSaving ? planModules(w, b, D, S, threatValue > armyValue * 0.8) : false

  // Keep two orders in the yard, saving up for the one we picked rather than buying whatever's cheap.
  // A yard standing idle is saved up for first: its next ship is one of its own (frigates and
  // corvettes at the Frigate Yard, cruisers and flagships at the Capital Yard).
  // (The Capital Yard first: its ships are the ones worth saving for.)
  const idleYard = w.units.filter((u) => !u.dead && u.owner === o && u.t.tier === 'yard' && !!u.yq && !u.yq.length && !building(u)).sort((x, y) => (worksOf(y.t) === 'cyard' ? 1 : 0) - (worksOf(x.t) === 'cyard' ? 1 : 0))[0]
  const idleKind = idleYard ? worksOf(idleYard.t) : null
  if (idleKind && !saving && !yardSaving && !(b.want && builtAt(UNIT[b.want]) === idleKind)) b.want = pickShip(w, b, (t) => builtAt(t) === idleKind) ?? b.want
  // Hybrid bases: once the Capital slip stands, a flagship is what it saves for (within a minute's
  // income, with a fleet worth guarding it and nothing attacking its base). With the fleet at its
  // limit it sends its cheapest warships home through hyperspace (part of their price comes back,
  // those not out with a wave first) to make room for it.
  const flag = flagshipFor(w, b)
  const full = 'Fleet at its limit: capture beacons or upgrade the station'
  const flagWhy = w.hybrid && b.alarm < 0 && !saving && !yardSaving && armyValue >= 4000 && p.credits + p.income * 60 >= flag.cost ? cantBuild(w, o, flag.id) : 'no'
  const flagship = flagWhy === null || flagWhy === 'Not enough credits' || flagWhy === full
  if (flagship) b.want = flag.id
  if (flagship && flagWhy === full && p.credits >= flag.cost) {
    const room = p.popCap - p.pop - allQueued(w, o).reduce((sum, q) => sum + UNIT[q.unit].pop, 0)
    const spare = army
      .filter((u) => canRetreat(u) && u.retreat <= 0 && !mendingIds.has(u.id) && (u.t.tier === 'gunship' || u.t.tier === 'frigate' || u.t.tier === 'cruiser'))
      .sort((x, y) => (b.troops.includes(x.id) ? 1 : 0) - (b.troops.includes(y.id) ? 1 : 0) || x.t.cost - y.t.cost || x.id - y.id)
    const out: Unit[] = []
    let freed = room
    for (const u of spare) {
      if (freed >= flag.pop) break
      out.push(u)
      freed += u.t.pop
    }
    if (freed >= flag.pop && out.length) act(b, () => cmdRetreat(w, o, out.map((u) => u.id)))
  }
  // (A yard is one more to keep busy.)
  if (queued < (savingForMine || lean ? 1 : 2) + yards && !saving && !yardSaving && !modSaving && !(savingForMine && p.credits < 500)) {
    if (b.want && cantBuild(w, o, b.want) && cantBuild(w, o, b.want) !== 'Not enough credits' && !(flagship && b.want === flag.id)) b.want = null
    b.want ??= pickShip(w, b)
    const want = b.want
    if (want && act(b, () => cmdBuild(w, o, want), true)) b.want = null
  }

  // Reinforcements from hyperspace, for the surcharge, only where flying out from home is too slow.
  reinforcements(w, b, st, army)

  // Abilities, when they'd help.
  for (const u of army) {
    if (!D.abilities || !u.t.ability || u.abilityCd > 0 || u.t.ability === 'fieldRepair') continue
    const near = visibleEnemies(w, o, u.x, u.y, ABILITIES[u.t.ability].range ?? rangeDist(650))
    if (!near.length) continue
    const ok =
      // A nebula would drain a boost straight away.
      u.t.ability === 'shieldBoost' ? u.shield < shieldMax(u) * 0.4 && !u.nebula
        : u.t.ability === 'repairSwarm' ? u.hull < u.hullMax * 0.65
          : u.t.ability === 'flakBarrage' ? near.some((f) => f.t.tier === 'fighter')
            // A tractor lock is worth it on warships, or on a crowd.
            : u.t.ability === 'tractor' ? near.some((f) => warship(f)) || near.length >= 4
              : true
    if (ok) act(b, () => cmdAbility(w, o, [u.id]))
  }

  mend(w, b, army, st)
  escort(w, b, army, mendingIds)

  // Cruisers and flagships badly hurt go home to be mended (by the station's repair dock, or its
  // repair craft) rather than fight on to the end, and rejoin once they're whole.
  const dock = moduleUp(st, 'dock')
  const crews = army.some((u) => u.t.kind === 'repair')
  if (dock || crews) {
    for (const u of army) {
      if ((u.t.tier !== 'cruiser' && u.t.tier !== 'capital') || mendingIds.has(u.id) || u.retreat > 0 || u.hull >= u.hullMax * S.mendAt) continue
      const toward = M.atan2(rally.y - st.y, rally.x - st.x)
      const d = radius(st.t) + radius(u.t) + 160
      if (act(b, () => cmdMove(w, o, [u.id], st.x + M.cos(toward + 0.6) * d, st.y + M.sin(toward + 0.6) * d))) {
        b.mending.push(u.id)
        mendingIds.add(u.id)
      }
    }
  }

  // Living hulls (UnitType regrow) grow back out of the fight: one badly hurt and away from the
  // rally point pulls back there, out of the wave, and rejoins once it has grown back (see
  // b.mending), rather than fight on to the end. It needs no dock or repair craft.
  for (const u of army) {
    if (!u.t.regrow || u.t.tier === 'fighter' || mendingIds.has(u.id) || u.retreat > 0 || u.hull >= u.hullMax * Math.max(0.35, S.mendAt)) continue
    if (d2(u, p.rally) < sq(mapDist(900))) continue
    if (act(b, () => cmdMove(w, o, [u.id], p.rally.x, p.rally.y))) {
      b.mending.push(u.id)
      mendingIds.add(u.id)
    }
  }

  // Defend: anything hitting our station or mines gets the whole home fleet, once it has noticed
  // (ships already heading there to fight need no new order).
  // Repair craft keep to their own work (see mend), out of the waves; so do raiders, scouts and
  // ships at home being mended.
  const scoutsBefore = b.scouts.size
  b.scouts = new Set([...b.scouts].filter((id) => w.byId.get(id) && !mendingIds.has(id)))
  // A scout lost: the next one waits a while, rather than going the same way into the same guns.
  if (b.scouts.size < scoutsBefore && w.time > 60) b.scoutWait = w.time + 45
  b.raid = b.raid.filter((id) => w.byId.get(id) && !mendingIds.has(id))
  const raiders = new Set(b.raid)
  // (Escorts go wherever their flagship goes: they keep out of the waves' orders too.)
  const guards = new Set([...b.guards, ...b.escort])
  const main = army.filter((u) => !b.scouts.has(u.id) && !raiders.has(u.id) && !mendingIds.has(u.id) && !guards.has(u.id) && !worker(u))
  const mainValue = value(main)
  if (threat && w.time - b.alarm >= D.react) {
    // A wave out while something big hits home: called back, the more readily the more defensive;
    // but only when it is more than the guns there and the ships at home can hold off by themselves,
    // and for an outlying mine or platform only when it is bigger than the wave (a wave called back
    // from every raid never gets anywhere).
    const base = !!hit && (hit.t.tier === 'station' || hit.t.tier === 'yard')
    let guard = 0
    if (b.attacking && hit)
      near(w, hit.x, hit.y, rangeDist(1100), (u) => {
        if (u.owner === o && !u.dead) guard += isShip(u.t) ? (b.troops.includes(u.id) || worker(u) ? 0 : value([u])) : guns(u)
      })
    if (b.attacking && threatValue > mainValue * (base ? S.recall : Math.max(1, S.recall)) && threatValue > guard) {
      b.attacking = false
      b.home = w.time
      b.troops = []
    }
    if (!b.attacking) {
      const at = threat
      const home = army.filter((u) => !worker(u) && !raiders.has(u.id) && !guards.has(u.id) && d2(u, st) < sq(mapDist(3200)))
      // It fights for an outlying mine or platform only when it can win there (with the guns of
      // its own structures nearby); against more, it pulls the fleet in under the station's guns
      // and waits for them there. An attack on the station itself is always met.
      let ours = value(home)
      near(w, at.x, at.y, rangeDist(1100), (u) => {
        if (u.owner === o && !isShip(u.t)) ours += guns(u)
      })
      const atHome = !!hit && hit.t.tier === 'station'
      const theirs = forceAt(w, o, at.x, at.y, rangeDist(1100))
      if (atHome || ours >= theirs * S.hold) {
        const go = home.filter((u) => u.order.k !== 'attack' && !(u.order.k === 'move' && u.order.attack && d2(u.order, at) < sq(500)))
        if (go.length) act(b, () => cmdMove(w, o, go.map((u) => u.id), at.x, at.y, true))
      } else {
        const toward = M.atan2(at.y - st.y, at.x - st.x)
        const spot = { x: st.x + M.cos(toward) * (radius(st.t) + 250), y: st.y + M.sin(toward) * (radius(st.t) + 250) }
        const go = home.filter((u) => !(u.order.k === 'move' && d2(u.order, spot) < sq(600)) && d2(u, spot) > sq(600))
        if (go.length) act(b, () => cmdMove(w, o, go.map((u) => u.id), spot.x, spot.y, true))
      }
      b.muster = -1
      return
    }
  }

  // Ore we've claimed but can't build on because enemy ships sit by it: the home fleet clears
  // them off, when it can win there, so mining keeps growing.
  if (!b.attacking && mines < mineGoal) {
    const mineId = unitOf(p.faction, 'mine').id
    const blocked = ours.find((n) => cantSite(w, o, n.id, mineId) === 'Enemy ships are in the way')
    if (blocked && forceAt(w, o, blocked.x, blocked.y, rangeDist(1000)) * S.hold <= mainValue) {
      const go = main.filter((u) => d2(u, st) < sq(mapDist(3200)) && !(u.order.k === 'move' && u.order.attack && d2(u.order, blocked) < sq(500)) && u.order.k !== 'attack')
      if (go.length) act(b, () => cmdMove(w, o, go.map((u) => u.id), blocked.x, blocked.y, true))
    }
  }

  // Scouts: a couple of fast ships keep the beacons ours.
  if (!b.attacking && b.scouts.size < 2 && w.time >= b.scoutWait) {
    // (A drain ship stays with the fleet: it's no use on its own.)
    const spare = army.find((u) => (u.t.tier === 'gunship' || u.t.tier === 'frigate') && !u.t.drain && !b.scouts.has(u.id) && !raiders.has(u.id) && !mendingIds.has(u.id) && !guards.has(u.id))
    if (spare) b.scouts.add(spare.id)
  }
  // Early on, before there are spare warships, the starting fighters do the surveying.
  if (!b.attacking && b.scouts.size < 2 && w.time < 240 && w.time >= b.scoutWait) {
    const f = army.find((u) => u.t.tier === 'fighter' && !worker(u) && !b.scouts.has(u.id) && !raiders.has(u.id))
    if (f) for (const id of army.filter((u) => u.squad && u.squad === f.squad).map((u) => u.id)) b.scouts.add(id)
  }
  // They pick beacons they can hold, and come home from fights they'd lose.
  const scouts = [...b.scouts].map((id) => w.byId.get(id)!)
  const scoutValue = value(scouts)
  // Unsurveyed ore on our half comes first, then beacons.
  // While calm, only neutral ones: nothing the player already holds.
  const calm = w.time < calmOf(b)
  // Ore nearer to us than to any enemy station, so allies don't race each other for it.
  const ore = w.nodes.filter((n) => !n.site && n.owner !== team && (!calm || n.owner === -1) && mineToTake(n))
  // Wrecks on our side of the map are free credits for a parked scout.
  const hulks = w.wrecks.filter((h) => h.left > 200 && h.team !== team && mineToTake(h))
  // Beacons out in the middle are the main fleet's to hold (it waits on one when it can, see the
  // rally point); after its quiet start scouts only go for those on our side, rather than being
  // picked off out there one by one.
  const ourSide = (g: { x: number; y: number }) => !enemySt || d2(g, st) < d2(g, enemySt) * 0.8
  const wanted = [...ore, ...hulks, ...w.beacons.filter((bc) => bc.owner !== team && (!calm || bc.owner === -1) && (calm || ourSide(bc) || !!homeBeacon))]
    .filter((g) => threatAt(w, o, g.x, g.y) < scoutValue * 0.9)
    .sort((a, c) => d2(a, st) - d2(c, st))
  // A squadron scouts as one: one order for all of it.
  const parties = [...new Set(scouts.map((x) => x.squad || -x.id))].map((k) => scouts.filter((x) => (x.squad || -x.id) === k))
  parties.forEach((party, slot) => {
    const s = party[0]
    const ids = party.map((x) => x.id)
    if (threatAt(w, o, s.x, s.y, rangeDist(700)) > scoutValue * 1.3 && d2(s, st) > sq(mapDist(1500))) {
      if (!(s.order.k === 'move' && d2(s.order, p.rally) < sq(300))) act(b, () => cmdMove(w, o, ids, p.rally.x, p.rally.y))
      return
    }
    // Each scout (or squadron) takes a different goal, and stays there while it claims it.
    const goal = wanted[slot % Math.max(1, wanted.length)]
    if (goal && party.every((x) => x.order.k === 'idle') && d2(s, goal) > sq(260)) {
      const x = goal.x + (rand(w) - 0.5) * 160
      const y = goal.y + (rand(w) - 0.5) * 160
      act(b, () => cmdMove(w, o, ids, x, y, !calm))
    }
  })

  // Raiders (offensive): a few fast ships after the enemy's mines, from the end of the quiet start.
  // (Not before there's a fleet at home worth the name.)
  if (S.raiders && !calm && w.time > 240 && enemySt && (b.raid.length || mainValue >= 2500)) raid(w, b, army, st, enemySt, S.raiders)

  waves(w, b, D, S, st, enemySt, main, mainValue, calm)
}

/**
 * Raiders: up to `n` fast ships (gunships, strike craft) harass the enemy's mines. They go for
 * mines and platforms they can see, else probe the ore on the enemy's side of the map (the map
 * itself is no secret), one asteroid after another, and come home from fights they'd lose.
 */
function raid(w: World, b: Brain, army: Unit[], st: Unit, enemySt: Unit, n: number) {
  const o = b.o
  const p = w.players[o]
  if (b.raid.length < n) {
    const taken = new Set([...b.raid, ...b.scouts, ...b.mending, ...b.troops, ...b.guards, ...b.escort])
    const spare = army.find((u) => (u.t.tier === 'gunship' || (u.t.tier === 'fighter' && !worker(u))) && u.t.kind !== 'support' && !u.t.drain && !taken.has(u.id))
    if (spare) for (const u of army.filter((x) => x === spare || (spare.squad && x.squad === spare.squad))) b.raid.push(u.id)
  }
  const crew = b.raid.map((id) => w.byId.get(id)!).filter(Boolean)
  if (!crew.length) return
  const c = centre(crew)
  const crewValue = value(crew)
  const ids = crew.map((u) => u.id)
  if (threatAt(w, o, c.x, c.y, rangeDist(900)) > crewValue * 0.8) {
    if (!crew.every((u) => u.order.k === 'move' && d2(u.order, p.rally) < sq(400))) act(b, () => cmdMove(w, o, ids, p.rally.x, p.rally.y))
    return
  }
  const seen = w.units.filter((u) => foes(w, u.owner, o) && (u.t.tier === 'mine' || u.t.tier === 'defense') && sees(w, o, u) && !u.dead)
  const prey = seen.filter((u) => u.t.tier === 'mine').sort((a, z) => d2(a, c) - d2(z, c))[0]
  let goal: { x: number; y: number } | undefined = prey
  if (!goal) {
    // Probe the enemy's ore, nearest their station first, moving on as each turns out empty.
    const theirs = w.nodes.filter((nd) => d2(nd, enemySt) < d2(nd, st)).sort((a, z) => d2(a, enemySt) - d2(z, enemySt))
    if (!theirs.length) return
    if (b.raidAt < 0 || !theirs.some((nd) => nd.id === b.raidAt)) b.raidAt = theirs[0].id
    const at = theirs.find((nd) => nd.id === b.raidAt)!
    if (d2(c, at) < sq(300) && crew.every((u) => u.order.k === 'idle')) {
      b.raidAt = theirs[(theirs.indexOf(at) + 1) % theirs.length].id
    }
    goal = theirs.find((nd) => nd.id === b.raidAt)!
  }
  const idle = crew.filter((u) => u.order.k === 'idle' || (u.order.k === 'move' && d2(u.order, goal!) > sq(450)))
  if (idle.length) act(b, () => cmdMove(w, o, idle.map((u) => u.id), goal!.x, goal!.y, true))
}

/** A wave that set out with the fleet at its limit turns back only once it is down to its profile's
 * share of what it set out with divided by this, or meets this many times more than it otherwise
 * would: a fleet that can't grow any more has nothing to gain by waiting, and games between two
 * capped fleets went on for ever with every wave turning back half way. */
const ALL_IN = 2
/** Late in a long battle every wave presses on harder, as if it set out all in: from `from` seconds
 * its grit (see ALL_IN) grows by one every `ramp` seconds, up to `max`. Two admirals each strong
 * enough at home to beat off the other's waves would otherwise trade them until the end of time. */
const LATE = { from: 1200, ramp: 600, max: 3 }
/** Seconds a wave going for the enemy station waits at most for its ships to gather (see waves). */
const SIEGE_GATHER = 40

/**
 * Attack waves. Once the fleet is big enough (or the yard is full, or it has waited long enough,
 * or there's a chance to strike back), it first gathers at the rally point, then goes out together.
 * Out there the wave keeps to one goal (enemy mines nearest it, then beacons, then the station),
 * its guns on one target at a time, and turns back once it has lost too much or meets a much
 * bigger fleet. Ships built while it's out don't trickle after it one by one: they wait at the rally
 * point and follow in batches.
 */
function waves(w: World, b: Brain, D: Level, S: Style, st: Unit, enemySt: Unit | undefined, main: Unit[], mainValue: number, calm: boolean) {
  const o = b.o
  const p = w.players[o]
  const team = p.team
  // Waves go out once the fleet is big enough, or the yard is full, or (so poor maps don't stall)
  // after four quiet minutes with at least half a wave ready (see below).
  // An ally already pushing into enemy space: go with them rather than one wave at a time.
  const pushing: Unit[] = []
  for (const u of w.units) {
    if (u.dead || u.owner === o || foes(w, u.owner, o) || !isShip(u.t) || u.order.k !== 'move' || !u.order.attack) continue
    const home = w.byId.get(w.players[u.owner].station)
    if (home && d2(u, home) > sq(mapDist(2200))) pushing.push(u)
  }
  const push = value(pushing) > 1200 ? centre(pushing) : null
  const joinAlly = !!push && mainValue >= b.wave * 0.3
  // Striking back: just after an attack on its base was beaten off, or when what it has seen of
  // the enemy's fleet is small next to its own.
  const seenFoes = Object.values(b.foes).reduce((s, v) => s + v, 0)
  // (A restless wave, too, is at least a match for what it has seen of the enemy fleet: sent out
  // short of that, it only fed the enemy, and kept both sides too poor to ever finish the other.)
  const restless = w.time - Math.max(b.lastWave, calmOf(b)) > 240 && mainValue >= b.wave * 0.5 && mainValue >= seenFoes
  const counter =
    S.counter &&
    mainValue >= b.wave * 0.6 &&
    ((b.beaten >= 0 && w.time - b.beaten < 40 && mainValue >= b.threatPeakLast * 1.3) || (S.turtle && seenFoes > 0 && mainValue >= seenFoes * 2.5))
  // A wave waits until it is bigger than what it has seen of the enemy fleet, by its profile's
  // margin, and than the guns round the enemy station it has found (a wave short of those only
  // bounced off the base, again and again), unless the yard is full or it has waited long enough.
  let walls = 0
  for (const [wx, wy, g] of Object.values(b.walls)) if (enemySt && sq(wx - enemySt.x) + sq(wy - enemySt.y) < sq(rangeDist(1400))) walls += g
  const ahead = mainValue >= Math.max(seenFoes, walls) * S.edge
  const Doc = doctrineOf(w, b)
  const ready = !calm && w.time - b.home >= S.rest && ((mainValue >= b.wave * Doc.wave && ahead) || p.pop >= p.popCap - 2 || restless || joinAlly || counter)
  if (!b.attacking) {
    if (!ready) {
      b.muster = -1
      const loose = main.filter((u) => u.order.k === 'idle' && d2(u, p.rally) > sq(700))
      if (loose.length) act(b, () => cmdMove(w, o, loose.map((u) => u.id), p.rally.x, p.rally.y), true)
      return
    }
    // Gather first, so the wave goes out as one.
    const R = mapDist(900)
    if (b.muster < 0) {
      b.muster = w.time
      const far = main.filter((u) => d2(u, p.rally) > sq(R * 0.6))
      if (far.length) act(b, () => cmdMove(w, o, far.map((u) => u.id), p.rally.x, p.rally.y))
      return
    }
    const gathered = value(main.filter((u) => d2(u, p.rally) < sq(R)))
    if (gathered < mainValue * 0.8 && w.time - b.muster < 45 && !counter) {
      const far = main.filter((u) => u.order.k === 'idle' && d2(u, p.rally) > sq(R))
      if (far.length) act(b, () => cmdMove(w, o, far.map((u) => u.id), p.rally.x, p.rally.y))
      return
    }
    b.attacking = true
    b.siege = -1
    b.storm = false
    b.allIn = p.pop >= p.popCap - 2
    b.muster = -1
    b.lastWave = w.time
    b.peak = mainValue
    b.troops = main.map((u) => u.id)
    b.focus = 0
  }
  const inMain = new Set(main.map((u) => u.id))
  b.troops = b.troops.filter((id) => inMain.has(id))
  const troops = b.troops.map((id) => w.byId.get(id)!)
  const troopValue = value(troops)
  const c = troops.length ? centre(troops) : centre(main)
  // (And the longer the battle has gone on, the harder its waves press on: see LATE.)
  const late = 1 + Math.min(LATE.max - 1, Math.max(0, w.time - LATE.from) / LATE.ramp)
  const grit = Math.max(b.allIn ? ALL_IN : 1, late)
  const outgunned = forceAt(w, o, c.x, c.y, rangeDist(1100)) > troopValue * S.outgunned * grit && d2(c, st) > sq(mapDist(1800))
  if (!troops.length || troopValue < (b.peak * S.regroup) / grit || outgunned) {
    b.attacking = false
    b.home = w.time
    b.wave = Math.min(9000, b.wave * 1.15)
    b.troops = []
    b.focus = 0
    act(b, () => cmdMove(w, o, main.map((u) => u.id), p.rally.x, p.rally.y))
    return
  }
  // New ships wait at the rally point and follow in batches.
  const fresh = main.filter((u) => !b.troops.includes(u.id))
  if (fresh.length) {
    const ready = fresh.filter((u) => d2(u, p.rally) < sq(mapDist(900)))
    if (ready.length >= 3 || value(ready) >= Math.max(1200, troopValue * 0.25)) {
      if (act(b, () => cmdMove(w, o, ready.map((u) => u.id), c.x, c.y, true))) b.troops.push(...ready.map((u) => u.id))
    } else {
      const loose = fresh.filter((u) => u.order.k === 'idle' && d2(u, p.rally) > sq(700))
      if (loose.length) act(b, () => cmdMove(w, o, loose.map((u) => u.id), p.rally.x, p.rally.y), true)
    }
  }
  // Pick a goal: enemy mines nearest our fleet (or the ally we're backing up), then beacons, then
  // the station; but only one it can take: what guards it (ships and guns we can see) must be well
  // short of the wave. With nothing it can take, the nearest anyway. Once it could take the enemy
  // station, the wave goes for it and keeps to it until it turns back: that ends the battle, where
  // mines, yards and beacons only bleed the enemy (a wave going back and forth between them and
  // the station as what it sees changes never got anywhere).
  const from = push ?? c
  const targets = [
    // Yards count as targets too: raiding the enemy's production is worth a wave.
    ...w.units.filter((u) => foes(w, u.owner, o) && (u.t.tier === 'mine' || u.t.tier === 'defense' || u.t.tier === 'yard') && sees(w, o, u)),
    ...w.beacons.filter((bc) => bc.owner !== team),
  ].sort((a, z) => d2(a, from) - d2(z, from))
  const takeable = (g: { x: number; y: number }) => forceAt(w, o, g.x, g.y, rangeDist(1100)) < troopValue * 0.8
  if (enemySt && b.siege < 0 && knownForce(w, b, enemySt.x, enemySt.y, rangeDist(1400)) < troopValue * 0.8) b.siege = w.time
  // Before it goes in, the wave gathers just out of the station's reach, so its ships (spread out
  // on the way, the slow ones behind) go in together rather than one by one into its guns; for
  // SIEGE_GATHER seconds at most.
  if (enemySt && b.siege >= 0 && !b.storm) {
    const out = radius(enemySt.t) + Math.max(0, ...enemySt.t.hardpoints.map((h) => h.weapon?.range ?? 0)) + 250
    const dx = c.x - enemySt.x
    const dy = c.y - enemySt.y
    const dd = M.hypot(dx, dy) || 1
    const spot = { x: Math.min(w.w - 150, Math.max(150, enemySt.x + (dx / dd) * out)), y: Math.min(w.h - 150, Math.max(150, enemySt.y + (dy / dd) * out)) }
    if (value(troops.filter((u) => d2(u, spot) < sq(mapDist(700)))) >= troopValue * 0.8 || w.time - b.siege > SIEGE_GATHER) b.storm = true
    else {
      const go = troops.filter((u) => u.order.k !== 'attack' && d2(u, spot) > sq(mapDist(500)) && !(u.order.k === 'move' && d2(u.order, spot) < sq(400))).map((u) => u.id)
      if (go.length) act(b, () => cmdMove(w, o, go, spot.x, spot.y, true))
      return
    }
  }
  const goal = (b.siege >= 0 ? enemySt : undefined) ?? targets.find(takeable) ?? (enemySt && takeable(enemySt) ? enemySt : undefined) ?? targets[0] ?? enemySt
  if (!goal) return
  // Focus fire: the wave's guns on one target at a time, kept until it's dead or gone. Storming the
  // station with no enemy warships about, on the station itself: left to themselves the ships shot
  // at whatever was nearest, the yards and platforms round it soaking up the whole wave's fire.
  const storming = b.storm && goal === enemySt && !visibleEnemies(w, o, c.x, c.y, rangeDist(1150)).some((e) => e.t.tier !== 'fighter')
  if (D.focus && storming) stormFire(w, b, troops, enemySt!)
  else if (D.focus) focusFire(w, b, troops, c)
  // Drain ships (UnitType drain) keep in among the enemy with the wave: over its focus when that is
  // near, else the middle of the wave.
  const drainers = troops.filter((u) => u.t.drain)
  if (drainers.length) {
    const f = b.focus ? w.byId.get(b.focus) : undefined
    const at = f && !f.dead && d2(f, c) < sq(rangeDist(1500)) ? f : c
    const r = drainers[0].t.drain!.radius * 0.5
    const lag = drainers.filter((u) => d2(u, at) > sq(r) && !(u.order.k === 'move' && d2(u.order, at) < sq(r * 0.6)))
    if (lag.length) act(b, () => cmdMove(w, o, lag.map((u) => u.id), at.x, at.y))
  }
  // Flanking (DOCTRINE flank): the wave's fast warships go round to a spot beside the goal, on our
  // side of it, and come in from there, where that is cheap: not while storming the station (its
  // guns reach all round), and only to a spot on the map clear of nebulas and asteroid fields.
  let flank: { x: number; y: number } | null = null
  const speeds = troops.filter((u) => u.t.tier !== 'fighter').map((u) => u.t.speed).sort((a, z) => a - z)
  const quick = speeds.length ? speeds[Math.floor(speeds.length / 2)] * 1.15 : Infinity
  const flanker = (u: Unit) => !!flank && (u.t.tier === 'gunship' || u.t.tier === 'frigate') && !u.t.drain && u.t.speed >= quick && d2(u, flank) > sq(mapDist(450))
  if (Doc.flank && goal !== enemySt && troops.length >= 4) {
    const ax = goal.x - st.x
    const ay = goal.y - st.y
    const ad = M.hypot(ax, ay) || 1
    const side = b.o % 2 ? 1 : -1
    const off = mapDist(750)
    const fx = goal.x + (-ay / ad) * off * side - (ax / ad) * off * 0.35
    const fy = goal.y + (ax / ad) * off * side - (ay / ad) * off * 0.35
    if (fx > 200 && fy > 200 && fx < w.w - 200 && fy < w.h - 200 && !inside(w.map.nebulas, fx, fy, 200) && !inside(w.map.fields, fx, fy, 200)) flank = { x: fx, y: fy }
  }
  // The ships not yet on their way there go together, as one order (the flankers as another).
  const go: number[] = []
  const round: number[] = []
  for (const u of troops) {
    if (u.order.k === 'attack' || u.t.drain) continue
    if (flank && flanker(u)) {
      if (u.order.k === 'idle' || (u.order.k === 'move' && d2(u.order, flank) > sq(400))) round.push(u.id)
      continue
    }
    // A move ends clear of the structure it was aimed at (see offRocks in sim.ts), so a big hull's
    // spot sits further from it: only a move really aimed elsewhere is given again.
    if (u.order.k === 'idle' || (u.order.k === 'move' && d2(u.order, goal) > sq(400 + radius(u.t)))) go.push(u.id)
  }
  if (go.length) {
    const x = goal.x + (rand(w) - 0.5) * 300
    const y = goal.y + (rand(w) - 0.5) * 300
    act(b, () => cmdMove(w, o, go, x, y, true))
  }
  if (round.length && flank) {
    const at = flank
    act(b, () => cmdMove(w, o, round, at.x, at.y, true))
  }
}

/**
 * Focus fire: picks one enemy near the wave for its warships to fire on together, the one worth
 * most for the least work (what it costs and how hard it hits, against how much hull and shields it
 * has left; strike craft only when there's nothing bigger), and keeps it until it's dead, out of
 * sight or left behind, so the guns don't flit from one to the next. Heavy guns aim at its shield
 * generators while they stand, then its turrets.
 */
function focusFire(w: World, b: Brain, troops: Unit[], c: { x: number; y: number }) {
  const o = b.o
  const cur = b.focus ? w.byId.get(b.focus) : undefined
  let e = cur && !cur.dead && sees(w, o, cur) && d2(cur, c) < sq(rangeDist(1500)) ? cur : undefined
  if (!e) {
    let best = 0
    near(w, c.x, c.y, rangeDist(1150), (u) => {
      if (!foes(w, u.owner, o) || !sees(w, o, u) || u.t.tier === 'station') return
      const small = u.t.tier === 'fighter'
      const hit = dpsVs(u.t, 'frigate') + dpsVs(u.t, 'cruiser')
      const s = ((u.t.cost / u.t.squad || 2000) + 40 * hit) / (u.hull + u.shield + 200) * (2 - u.hull / u.hullMax) * (small ? 0.05 : 1)
      if (s > best) {
        best = s
        e = u
      }
    })
  }
  b.focus = e?.id ?? 0
  if (!e) return
  const target = e
  // The warships near it that aren't on it yet (strike craft keep their own runs).
  // (A side that concentrates its fire, DOCTRINE focus, pulls its warships in from further off.)
  const reach = rangeDist(1400) * doctrineOf(w, b).focus
  const shooters = troops.filter((u) => u.t.tier !== 'fighter' && !(u.order.k === 'attack' && u.order.id === target.id) && d2(u, target) < sq(reach) && dpsVs(u.t, target.t.tier) > 0)
  if (!shooters.length) return
  const gen = target.hps.length ? target.t.hardpoints.findIndex((h, i) => h.kind === 'shield' && target.hps[i].hp > 0) : -1
  const gun = target.hps.length ? target.t.hardpoints.findIndex((h, i) => h.kind === 'turret' && target.hps[i].hp > 0) : -1
  const hp = gen >= 0 ? gen : gun
  act(b, () => cmdAttack(w, o, shooters.map((u) => u.id), target.id, hp))
}

/** A wave storming the enemy station: its warships near it fire on it, its shield generators first
 * while they stand, then its guns. */
function stormFire(w: World, b: Brain, troops: Unit[], st: Unit) {
  const shooters = troops.filter((u) => u.t.tier !== 'fighter' && !(u.order.k === 'attack' && u.order.id === st.id) && d2(u, st) < sq(rangeDist(1600)) && dpsVs(u.t, 'station') > 0)
  if (!shooters.length) return
  const gen = st.t.hardpoints.findIndex((h, i) => h.kind === 'shield' && st.hps[i]?.hp > 0)
  const gun = st.t.hardpoints.findIndex((h, i) => h.kind === 'turret' && st.hps[i]?.hp > 0)
  act(b, () => cmdAttack(w, b.o, shooters.map((u) => u.id), st.id, gen >= 0 ? gen : gun))
}

/** The ship or station of ours most worth a Field repair near (x, y): the most damaged, weighted by
 * what it's worth, so a battered flagship or station comes before a scratched gunship. */
function patient(w: World, o: Owner, x: number, y: number, r: number): Unit | undefined {
  let best: Unit | undefined
  let score = 0
  for (const t of w.units) {
    if (t.dead || cantMend(w, o, t) || d2(t, { x, y }) > sq(r)) continue
    const need = 1 - t.hull / t.hullMax
    if (need < 0.15) continue
    const s = need * Math.sqrt(t.t.cost || 3000)
    if (s > score) {
      score = s
      best = t
    }
  }
  return best
}

/**
 * Repair craft: each squadron with its ability ready goes to the ship or station that needs it most
 * (Admirals that use abilities only; the sim's idle crews still help themselves). Between runs a
 * squadron guards the fleet's most valuable warship, or the station, so it's at hand when that one
 * gets hurt.
 */
function mend(w: World, b: Brain, army: Unit[], st: Unit) {
  const o = b.o
  const D = DIFFICULTY[b.diff]
  const ward = army.filter((u) => u.t.tier === 'frigate' || u.t.tier === 'cruiser' || u.t.tier === 'capital').sort((a, c) => c.t.cost - a.t.cost || a.id - c.id)[0] ?? st
  const squads = new Map<number, Unit[]>()
  for (const u of army) if (u.t.kind === 'repair') squads.set(u.squad || -u.id, [...(squads.get(u.squad || -u.id) ?? []), u])
  for (const crew of squads.values()) {
    const lead = crew[0]
    if (lead.aid) continue
    const ids = crew.map((u) => u.id)
    const sick = D.abilities && lead.abilityCd <= 0 ? patient(w, o, lead.x, lead.y, ABILITIES.fieldRepair.range!) : undefined
    if (sick) {
      act(b, () => cmdAbility(w, o, ids, sick.id) || 'nothing to mend')
      continue
    }
    if (!(lead.order.k === 'guard' && lead.order.id === ward.id)) act(b, () => cmdGuard(w, o, ids, ward.id), true)
  }
}

/** What escorts its flagship: a repair tender and two gunships. */
const ESCORTS = { tenders: 1, gunships: 2 }

/**
 * Escorts: with a flagship out, a repair tender (where its side has one) and a couple of gunships
 * fly over it as its escort (a guard order on a ship two classes bigger, see sim.ts escorts), going
 * where it goes, fighting off what comes near it and patching it up. Only the flagship, and only a
 * few: the rest of the fleet is the waves'. When the flagship is lost the escorts go back to the
 * fleet.
 */
function escort(w: World, b: Brain, army: Unit[], mendingIds: Set<number>) {
  const o = b.o
  const flag = army.filter((u) => u.t.tier === 'capital' && u.retreat <= 0).sort((a, c) => c.t.cost - a.t.cost || a.id - c.id)[0]
  if (!flag) {
    b.escort = []
    return
  }
  b.escort = b.escort.filter((id) => {
    const u = w.byId.get(id)
    return !!u && !u.dead && u.owner === o && u.retreat <= 0 && !mendingIds.has(id)
  })
  // Back on the job: an escort whose orders were dropped (or that was given others) guards it again.
  for (const id of b.escort) {
    const u = w.byId.get(id)!
    if (!(u.order.k === 'guard' && u.order.id === flag.id)) act(b, () => cmdGuard(w, o, [u.id], flag.id))
  }
  const have = b.escort.map((id) => w.byId.get(id)!)
  const taken = new Set([...b.guards, ...b.scouts, ...b.raid, ...b.mending, ...b.escort])
  const free = army.filter((u) => u.t.tier === 'gunship' && !taken.has(u.id) && u.retreat <= 0).sort((a, z) => d2(a, flag) - d2(z, flag) || a.id - z.id)
  const tender = have.filter((u) => u.t.kind === 'support').length < ESCORTS.tenders ? free.find((u) => u.t.kind === 'support') : undefined
  const gun = have.filter((u) => u.t.kind !== 'support').length < ESCORTS.gunships ? free.find((u) => u.t.kind !== 'support') : undefined
  for (const pick of [tender, gun]) {
    if (!pick || !act(b, () => cmdGuard(w, o, [pick.id], flag.id), true)) continue
    b.escort.push(pick.id)
    b.troops = b.troops.filter((id) => id !== pick.id)
  }
}

/**
 * Hybrid bases: the Frigate Yard. Once its profile says it's time (some seconds after station level
 * 2; an offensive admiral buys its engineers while the upgrade is still under way), it buys an
 * engineer squadron if it has none, saves up and puts the yard on the safe side of its station
 * (see yardSpot), or rebuilds it on its ruin. Once the yard stands it keeps a few warships guarding
 * it and its rally point on the station's. Answers whether it is saving up for the yard or its
 * engineers, so the ship purchases wait.
 */
function planYard(w: World, b: Brain, D: Level, S: Style, st: Unit, enemySt: Unit | undefined, army: Unit[]): boolean {
  const o = b.o
  const p = w.players[o]
  const yt = yardOf(p.faction)
  if (p.level >= 2 && b.lv2 < 0) b.lv2 = w.time
  const mine = w.units.find((u) => !u.dead && u.owner === o && u.t.id === yt.id)
  const engineers = army.filter((u) => isEngineer(u.t))
  const eng = UNIT[`${prefixOf(p.faction)}-engineer`]
  // Engineers lost: a minute before it sends more the same way.
  if (engineers.length < b.engSeen) b.engWait = w.time + 60
  b.engSeen = engineers.length
  // With nothing to build they wait behind the station, away from the fighting (new ones head for
  // the rally point out in front, like every ship).
  const away = enemySt ? M.atan2(st.y - enemySt.y, st.x - enemySt.x) : M.atan2(st.y - w.h / 2, st.x - w.w / 2)
  const haven = { x: Math.min(w.w - 150, Math.max(150, st.x + M.cos(away) * (radius(st.t) + 260))), y: Math.min(w.h - 150, Math.max(150, st.y + M.sin(away) * (radius(st.t) + 260))) }
  const loose = engineers.filter((u) => (u.order.k === 'idle' || (u.order.k === 'move' && d2(u.order, p.rally) < sq(400))) && d2(u, haven) > sq(450))
  if (loose.length) act(b, () => cmdMove(w, o, loose.map((u) => u.id), haven.x, haven.y), true)
  /** No engineers: buy a squadron (answers whether it is saving up for one). Not while its base is
   * under attack, nor just after losing the last ones. */
  const hire = () => {
    if (p.queue.some((q) => q.unit === eng.id) || w.time < b.engWait || b.alarm >= 0) return false
    if (p.credits >= eng.cost) act(b, () => cmdBuild(w, o, eng.id), true)
    return true
  }
  if (p.level >= 3 && b.lv3 < 0) b.lv3 = w.time
  // A site of ours: at least one squadron on it (new ones, if the last were lost).
  const site = w.units.find((u) => !u.dead && u.owner === o && u.t.tier === 'yard' && building(u))
  if (site) {
    if (!engineers.length) return hire()
    if (!engineers.some((u) => u.order.k === 'construct' && u.order.id === site.id)) act(b, () => cmdConstruct(w, o, engineers.map((u) => u.id), site.id))
    return false
  }
  // A shot-off expansion is welded back by the engineers (for part of its price) when they're free.
  const broken = w.units.find((u) => !u.dead && u.owner === o && (u.t.tier === 'station' || u.t.tier === 'yard') && u.t.hardpoints.some((h, i) => h.exp && u.hps[i].hp <= 0 && p.credits >= moduleRebuildCost(h.exp)))
  if (broken && engineers.length && !engineers.some((u) => u.order.k === 'construct')) act(b, () => cmdConstruct(w, o, engineers.map((u) => u.id), broken.id), true)
  // The Capital Yard, once its time has come after station level 3 (and the Frigate Yard stands).
  const ct = yardOf(p.faction, 'cyard')
  let saveCyard = false
  if (mine && !building(mine) && !w.units.some((u) => !u.dead && u.owner === o && u.t.id === ct.id) && p.level >= 3 && w.time >= b.lv3 + S.cyardDelay * D.pace && b.alarm < 0) {
    const ruin = (w.ruins ?? []).find((r) => r.owner === o && r.unit === ct.id)
    const cost = ruin ? Math.round(ct.cost * REBUILD) : ct.cost
    if (!engineers.length) saveCyard = hire()
    // (It stops buying ships for it only once it's within 45 seconds' income.)
    else if (p.credits < cost) saveCyard = p.credits + p.income * 45 >= cost
    else {
      const spot = ruin && !placement(w, o, ct.id, ruin.x, ruin.y).why ? ruin : yardSpot(w, o, st, enemySt, ct.id)
      if (spot) act(b, () => cmdPlace(w, o, engineers.map((u) => u.id), ct.id, spot.x, spot.y), true)
    }
  }
  const cyard = w.units.find((u) => !u.dead && u.owner === o && u.t.id === ct.id && !building(u))
  if (cyard?.yr && sq(cyard.yr.x - p.rally.x) + sq(cyard.yr.y - p.rally.y) > sq(60)) act(b, () => cmdRally(w, o, p.rally.x, p.rally.y, cyard.id), true)
  if (mine) {
    // Its ships gather where the station's do, and a few warships stand guard over it.
    if (mine.yr && sq(mine.yr.x - p.rally.x) + sq(mine.yr.y - p.rally.y) > sq(60)) act(b, () => cmdRally(w, o, p.rally.x, p.rally.y, mine.id), true)
    b.guards = b.guards.filter((id) => {
      const u = w.byId.get(id)
      return !!u && !u.dead && u.owner === o
    })
    for (const id of b.guards) {
      const u = w.byId.get(id)!
      if (u.order.k === 'idle' && d2(u, mine) > sq(radius(mine.t) + 600)) act(b, () => cmdGuard(w, o, [u.id], mine.id))
    }
    if (b.guards.length < S.yardGuards) {
      const taken = new Set([...b.guards, ...b.scouts, ...b.raid, ...b.troops, ...b.mending, ...b.escort])
      const pick = army
        .filter((u) => (u.t.tier === 'gunship' || u.t.tier === 'frigate') && u.t.kind !== 'support' && !taken.has(u.id) && u.retreat <= 0)
        .sort((a, z) => d2(a, mine) - d2(z, mine) || a.id - z.id)[0]
      if (pick && act(b, () => cmdGuard(w, o, [pick.id], mine.id))) b.guards.push(pick.id)
    }
    return saveCyard
  }
  b.guards = []
  const leveling = p.research.some((r) => r.id === LEVEL_UP)
  const due = p.level >= 2 ? w.time >= b.lv2 + S.yardDelay * D.pace : S.yardDelay === 0 && leveling
  if (!due) return false
  if (!engineers.length) return hire()
  if (p.level < 2) return false
  const ruin = (w.ruins ?? []).find((r) => r.owner === o && r.unit === yt.id)
  const cost = ruin ? Math.round(yt.cost * REBUILD) : yt.cost
  if (p.credits < cost) return true
  const spot = ruin && !placement(w, o, yt.id, ruin.x, ruin.y).why ? ruin : yardSpot(w, o, st, enemySt, yt.id)
  if (spot) act(b, () => cmdPlace(w, o, engineers.map((u) => u.id), yt.id, spot.x, spot.y), true)
  return false
}

/**
 * Hybrid bases: expansions for the Command Station and the yards. With spare credits (its profile's
 * reserve kept back, and the base not under attack), one at a time, it orders the first one on its
 * profile's list it can build now; the Capital slip comes first of all once the station reaches
 * level 4, so an admiral who likes flagships gets to them: that one it saves up for once it's within
 * half a minute's income (the answer: whether it is saving, so the ship purchases wait). The rest
 * are cheap enough to skip: with no money to spare it simply goes on building ships.
 */
function planModules(w: World, b: Brain, D: Level, S: Style, attacked: boolean): boolean {
  const o = b.o
  const p = w.players[o]
  if (!D.research || attacked || w.time < 150) return false
  const works = w.units.filter((u) => !u.dead && u.owner === o && (u.t.tier === 'station' || u.t.tier === 'yard') && !building(u))
  // One at a time: while one is under way it waits.
  if (works.some((u) => u.xq?.length)) return false
  const order: ModuleId[] = ['capitalSlip', ...S.modules.filter((id) => id !== 'capitalSlip')]
  // The Capital slip and the first two on its list are worth saving up for once they're within
  // reach (about twenty seconds' income); the rest wait for money to spare.
  const keen = new Set<ModuleId>(['capitalSlip', ...S.modules.slice(0, 2)])
  let next = 0
  for (const id of order) {
    const at = works.find((u) => worksOf(u.t) === (MODULE[id].on as Works))
    if (!at) continue
    const why = cantExpand(w, o, at.id, id)
    if (why === 'Already built' || why?.startsWith('Needs station level')) continue
    const cost = MODULE[id].cost
    // (The rest also leave the ship it is saving for alone.)
    const spare = keen.has(id) ? 100 : S.keep + 300 + (b.want ? UNIT[b.want].cost : 0)
    if (!why && p.credits >= cost + spare) {
      act(b, () => cmdExpand(w, o, at.id, id), true)
      return false
    }
    if (keen.has(id) && (!why || why === 'Not enough credits')) return p.credits + p.income * 20 >= cost + spare
    // Only the first two it can't have yet are looked at: it doesn't shop down the whole list.
    if (++next >= 2) return false
  }
  return false
}

/**
 * Where an admiral puts a yard: inside the build radius on the side of its station away from the
 * nearest enemy station (or from the middle of the map), as near the station as it fits, keeping
 * clear of the survey rings round ore so its mines can still go up; failing that, anywhere it fits.
 */
function yardSpot(w: World, o: Owner, st: Unit, enemySt: Unit | undefined, id: string): { x: number; y: number } | null {
  const away = enemySt ? M.atan2(st.y - enemySt.y, st.x - enemySt.x) : M.atan2(st.y - w.h / 2, st.x - w.w / 2)
  const r = radius(UNIT[id])
  const r0 = radius(st.t) + r + 220
  for (const strict of [true, false])
    for (let d = r0; d <= BUILD_RADIUS - 40; d += 220)
      for (const off of [0, 0.45, -0.45, 0.9, -0.9, 1.35, -1.35, 1.8, -1.8, 2.3, -2.3, 2.8, -2.8]) {
        const x = st.x + M.cos(away + off) * d
        const y = st.y + M.sin(away + off) * d
        if (placement(w, o, id, x, y).why) continue
        if (strict && w.nodes.some((n) => d2(n, { x, y }) < sq(SURVEY_RADIUS + r))) continue
        return { x, y }
      }
  return null
}

/** The defense platform to build against what the enemy has been flying: flak against a swarm
 * of strike craft, heavy guns against warships, else the balanced one. */
function defenseFor(w: World, o: Owner): string {
  const p = w.players[o]
  let small = 0
  let big = 0
  for (const u of w.units) {
    if (u.dead || !foes(w, u.owner, o) || !sees(w, o, u) || !isShip(u.t)) continue
    if (u.t.tier === 'fighter' || u.t.tier === 'gunship') small += u.t.pop / u.t.squad
    else big += u.t.pop
  }
  const id = small > big * 1.6 ? 'defense-flak' : big > small * 1.6 ? 'defense-gun' : 'defense'
  return `${prefixOf(p.faction)}-${id}`
}

// --- Fleet battles ---------------------------------------------------------------------------------

/**
 * The admiral in a galactic conquest fleet battle: no economy, only the fleet. It keeps the field
 * topped up from the ships waiting in orbit, sends idle ships at the nearest enemy (the side holding
 * the planet waits by its station until the attackers come close), fires abilities, and an attacker
 * that is clearly losing pulls its fleet out rather than lose it all. Its profile sets how far the
 * holder goes out to meet them and how soon an attacker gives up (PROFILES `sally`, `bail`).
 */
export function fleetThink(w: World, b: Brain, dt: number) {
  rest(b, dt)
  b.t -= dt
  const f = w.fleet
  if (!f || b.t > 0 || w.winner !== -1) return
  const D = DIFFICULTY[b.diff]
  const S = PROFILES[b.profile]
  b.t = Math.min(1.5, D.think) * (0.8 + rand(w) * 0.4)
  const o = b.o
  const p = w.players[o]
  const mine = fleet(w, o).filter((u) => !u.parent && u.retreat <= 0)
  const st = w.byId.get(p.station)
  const holder = !!st && !st.dead
  const entry = f.entry[o]
  const mid = { x: w.w / 2, y: w.h / 2 }

  // Reinforcements: keep the field at the battle's fleet size.
  let onField = mine.reduce((s, u) => s + u.t.pop / u.t.squad, 0) + w.arrivals.filter((a) => a.owner === o).reduce((s, a) => s + UNIT[a.unit].pop, 0)
  for (const id of [...p.reserve].sort((a, c) => UNIT[c].pop - UNIT[a].pop)) {
    if (onField + UNIT[id].pop > f.cap && onField > 0) continue
    const toMid = M.atan2(mid.y - entry.y, mid.x - entry.x)
    for (let i = 0; i < 12; i++) {
      const a = toMid + (rand(w) - 0.5) * 1.8
      const d = 200 + rand(w) * (entry.r - 350)
      const x = entry.x + M.cos(a) * d
      const y = entry.y + M.sin(a) * d
      if (act(b, () => cmdDeploy(w, o, id, x, y, toMid))) {
        onField += UNIT[id].pop
        break
      }
      if (b.hands < 1) break
    }
  }

  // The enemy, as far as we can see; or where they came in, if we can't see any.
  const foesSeen = w.units.filter((u) => !u.dead && foes(w, u.owner, o) && sees(w, o, u) && u.retreat <= 0)
  const theirValue = value(foesSeen.filter((u) => isShip(u.t))) + w.players.filter((_, i) => foes(w, i, o)).reduce((s, q) => s + q.reserve.reduce((v, id) => v + UNIT[id].cost, 0), 0)
  const ourValue = value(mine) + p.reserve.reduce((v, id) => v + UNIT[id].cost, 0)
  // A beaten attacker jumps out (sooner the more defensive): whatever escapes goes back to its fleet.
  if (!holder && b.diff !== 'veryEasy' && w.time > 30 && ourValue < theirValue * S.bail) {
    const out = mine.filter(canRetreat)
    if (out.length) act(b, () => cmdRetreat(w, o, out.map((u) => u.id)))
    p.reserve.length = 0
    return
  }
  const nearest = (u: Unit) => foesSeen.reduce<Unit | null>((best, e) => (!best || d2(e, u) < d2(best, u) ? e : best), null)
  const enemyEntry = f.entry.find((_, i) => foes(w, i, o)) ?? mid
  // Idle ships go at the enemy nearest them: those after the same one go together, as one order.
  const groups = new Map<Unit | null, number[]>()
  for (const u of mine) {
    const busy = u.order.k !== 'idle' || u.target
    if (D.abilities && u.t.ability === 'fieldRepair' && u.abilityCd <= 0 && !u.aid) {
      const sick = patient(w, o, u.x, u.y, ABILITIES.fieldRepair.range!)
      if (sick) act(b, () => cmdAbility(w, o, [u.id], sick.id))
    } else if (D.abilities && u.t.ability && u.abilityCd <= 0 && threatAt(w, o, u.x, u.y, rangeDist(700)) > 0) act(b, () => cmdAbility(w, o, [u.id]))
    if (busy) continue
    const e = nearest(u)
    // The holder keeps the line by the station until they come within reach of it (an offensive
    // admiral goes out further to meet them).
    if (holder && !(e && d2(e, st!) < sq(mapDist(2600) * S.sally))) continue
    groups.set(e, [...(groups.get(e) ?? []), u.id])
  }
  for (const [e, ids] of groups) {
    const to = e ?? enemyEntry
    if (!act(b, () => cmdMove(w, o, ids, to.x, to.y, true))) break
  }
}

// --- Teamwork ---------------------------------------------------------------------------------------

/** An AI admiral with credits to spare helps out a player on its team who's broke. */
export const AID = {
  /** It has at least this many credits... */
  rich: 3000,
  /** ...and a teammate without an admiral (a person) has fewer than this... */
  broke: 200,
  /** ...so it sends them this many... */
  amount: 500,
  /** ...at most once in this many seconds. */
  every: 90,
}

/**
 * The AI admirals' gifts for the turn: modest and rare, so an admiral still fights its own battle,
 * and all on the battle's clock, so every copy of a multiplayer battle sends the same. Only people
 * get them (the seats without an admiral in `brains`); fleet battles have no allies.
 */
export function aidAllies(w: World, brains: Brain[]) {
  if (w.fleet) return
  for (const b of brains) {
    const p = w.players[b.o]
    if (!p?.alive || p.credits < AID.rich || (p.lastGift !== undefined && w.time - p.lastGift < AID.every)) continue
    const needy = w.players.findIndex((q, i) => i !== b.o && q.alive && q.team === p.team && q.credits < AID.broke && !brains.some((x) => x.o === i))
    if (needy >= 0) cmdGive(w, b.o, needy, AID.amount)
  }
}
