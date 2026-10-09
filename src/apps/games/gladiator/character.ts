import {
  BASE_STAT, BEARDS, CREATION_POINTS, emptyStats, EPITHETS, FIRST_NAMES, FISTS, HAIR_COLOURS, HAIR_STYLES, item, ITEMS, MATERIALS, MAX_LEVEL, PERK_LEVELS, POINTS_PER_LEVEL, SKIN_TONES, SPELLS,
  STAT_KEYS, TUNIC_COLOURS, weaponType, type Archetype, type Item, type Look, type PerkId, type PotionId, type Slot, type SpellId, type StatKey, type Stats, type WeaponKind, type WeaponType,
} from './data'

// A gladiator is what gets saved: stats, gear and looks. `derive` turns one into the numbers a
// fight runs on, so gear and perks only ever count in one place.

export type Gladiator = {
  id: string
  name: string
  title?: string
  look: Look
  level: number
  xp: number
  stats: Stats
  /** Unspent stat points. */
  points: number
  gear: Partial<Record<Slot, string>>
  spells: SpellId[]
  perks: PerkId[]
  potions: Record<PotionId, number>
  archetype?: Archetype
}

export const xpFor = (level: number) => Math.round(40 * Math.pow(level, 1.2))

export type Derived = {
  stats: Stats
  maxHp: number
  maxSta: number
  maxMana: number
  armour: number
  /** Weight the gladiator's strength does not carry; slows and exposes them. */
  burden: number
  block: number
  weapon: WeaponType
  weaponItem: Item | null
  dmg: [number, number]
  dmgBonus: number
  acc: number
  eva: number
  crit: number
  move: number
  shield: Item | null
}

export const has = (g: Gladiator, p: PerkId) => g.perks.includes(p)

export function gearStats(g: Gladiator): Stats {
  const s = { ...g.stats }
  for (const id of Object.values(g.gear)) {
    const it = item(id)
    if (!it) continue
    for (const k of Object.keys(it.bonus) as StatKey[]) s[k] += it.bonus[k] ?? 0
  }
  return s
}

export function derive(g: Gladiator): Derived {
  const s = gearStats(g)
  const items = Object.values(g.gear).map(item).filter((i): i is Item => !!i)
  const weaponItem = item(g.gear.weapon)
  const weapon = weaponItem?.weapon ? weaponType(weaponItem.weapon) : FISTS
  const shield = weapon.twoHanded ? null : item(g.gear.shield)
  const weight = items.reduce((a, i) => a + (i === item(g.gear.shield) && !shield ? 0 : i.weight), 0)
  const burden = Math.max(0, weight - s.str * 0.3)
  let armour = items.reduce((a, i) => a + (i.slot === 'shield' && !shield ? 0 : i.armour), 0) + s.def * 0.6
  if (has(g, 'ironSkin')) armour *= 1.2
  const fleet = has(g, 'fleetFoot')
  return {
    stats: s,
    maxHp: Math.round((24 + s.vit * 5 + g.level * 2.5) * (has(g, 'thickSkull') ? 1.1 : 1)),
    maxSta: 40 + s.end * 5,
    maxMana: Math.round(2 + s.mag * 2.5),
    armour: Math.round(armour),
    burden,
    block: Math.min(0.45, (shield?.block ?? 0) + s.def * (shield ? 0.004 : 0.0025)),
    weapon,
    weaponItem,
    dmg: weaponItem?.dmg ?? FISTS.dmg,
    dmgBonus: 0.5 * (s.str * weapon.strShare + s.agi * weapon.finesse),
    acc: s.atk + weapon.acc,
    eva: s.agi - burden * 1.5 + (fleet ? 8 : 0),
    crit: Math.min(0.4, weapon.crit + s.agi * 0.004),
    move: Math.max(70, 108 + s.agi * 2 - burden * 4) * (fleet ? 1.4 : 1),
    shield,
  }
}

/** Whether `g` can wear `it`: level and strength, the strength counted with gear bonuses. */
export function canWear(g: Gladiator, it: Item) {
  if (g.level < it.level) return `Needs level ${it.level}`
  const s = gearStats({ ...g, gear: { ...g.gear, [it.slot]: undefined } })
  if (s.str < it.str) return `Needs ${it.str} strength`
  return null
}

/** Puts on an item, taking off whatever it displaces (a shield, for a two-handed weapon). */
export function equip(g: Gladiator, it: Item): Gladiator {
  const gear = { ...g.gear, [it.slot]: it.id }
  if (it.weapon && weaponType(it.weapon).twoHanded) delete gear.shield
  if (it.slot === 'shield') {
    const w = item(gear.weapon)
    if (w?.weapon && weaponType(w.weapon).twoHanded) delete gear.weapon
  }
  return { ...g, gear }
}

// --- Random gladiators ---------------------------------------------------------------------------

/** A small seeded generator, so a rival or champion looks and fights the same every time. */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export type Rand = () => number
export const pick = <T,>(r: Rand, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]

export function randomLook(r: Rand = Math.random): Look {
  return {
    skin: pick(r, SKIN_TONES),
    hair: pick(r, HAIR_STYLES),
    hairColour: pick(r, HAIR_COLOURS),
    beard: pick(r, BEARDS),
    tunic: pick(r, TUNIC_COLOURS),
    build: 0.3 + r() * 0.7,
  }
}

export const randomName = (r: Rand = Math.random) => `${pick(r, FIRST_NAMES)} ${pick(r, EPITHETS)}`

const WEIGHTS: Record<Archetype, Partial<Stats>> = {
  brute: { str: 4, vit: 3, end: 2, atk: 1.5, def: 1, agi: 0.5, cha: 0.3 },
  duelist: { atk: 3, agi: 3, str: 2, cha: 0.8, end: 1.5, vit: 2.2, def: 1 },
  tank: { def: 3, vit: 3, str: 2.6, end: 1.5, atk: 1.5, agi: 0.3 },
  showman: { cha: 2.5, agi: 2, atk: 2, str: 1.5, vit: 2, end: 1 },
  mage: { mag: 4, vit: 1.3, agi: 1.5, end: 1, atk: 0.8, def: 0.8, str: 0.3 },
  spearman: { atk: 2.5, str: 2, agi: 2, vit: 2, end: 1.5, def: 1 },
}
const ARCH_WEAPONS: Record<Archetype, WeaponKind[]> = {
  brute: ['axe', 'greatsword', 'warhammer'],
  duelist: ['gladius', 'dagger', 'gladius'],
  tank: ['mace', 'gladius'],
  showman: ['trident', 'gladius'],
  mage: ['staff', 'wand', 'scepter'],
  spearman: ['spear', 'trident'],
}
const ARCH_PERKS: Record<Archetype, PerkId[]> = {
  brute: ['cleave', 'bloodlust', 'thickSkull', 'executioner', 'secondWind', 'ironSkin'],
  duelist: ['riposte', 'fleetFoot', 'executioner', 'showman', 'secondWind', 'bloodlust'],
  tank: ['ironSkin', 'thickSkull', 'riposte', 'secondWind', 'cleave', 'bloodlust'],
  showman: ['showman', 'goldTongue', 'riposte', 'fleetFoot', 'secondWind', 'executioner'],
  mage: ['arcane', 'secondWind', 'fleetFoot', 'thickSkull', 'ironSkin', 'riposte'],
  spearman: ['riposte', 'cleave', 'fleetFoot', 'executioner', 'bloodlust', 'secondWind'],
}
export const ARCHETYPES = Object.keys(WEIGHTS) as Archetype[]

export function totalPoints(level: number) {
  return STAT_KEYS.length * BASE_STAT + CREATION_POINTS + (level - 1) * POINTS_PER_LEVEL
}

export type OpponentOpts = { name?: string; title?: string; look?: Look; gearBoost?: number; statBoost?: number; lag?: number }

/** A computer gladiator of `level`, built and kitted out the way its archetype would be. */
export function makeOpponent(level: number, archetype: Archetype, seed: number, opts: OpponentOpts = {}): Gladiator {
  const r = rng(seed)
  level = Math.max(1, Math.min(MAX_LEVEL + 3, Math.round(level)))
  const stats = emptyStats(BASE_STAT)
  const w = WEIGHTS[archetype]
  const keys = Object.keys(w) as StatKey[]
  const sum = keys.reduce((a, k) => a + (w[k] ?? 0), 0)
  let left = Math.round((totalPoints(level) - STAT_KEYS.length * BASE_STAT) * (opts.statBoost ?? 1))
  while (left > 0) {
    let x = r() * sum
    for (const k of keys) {
      x -= w[k] ?? 0
      if (x <= 0) {
        stats[k]++
        break
      }
    }
    left--
  }

  const g: Gladiator = {
    id: `cpu-${seed}`,
    name: opts.name ?? randomName(r),
    title: opts.title,
    look: opts.look ?? randomLook(r),
    level,
    xp: 0,
    stats,
    points: 0,
    gear: {},
    spells: [],
    perks: [],
    potions: { health: 0, stamina: 0, mana: 0 },
    archetype,
  }

  // Gear: roughly the best tier the level allows, with gaps and hand-me-downs at the low end.
  const boost = opts.gearBoost ?? 0
  const best = MATERIALS.reduce((t, m, i) => (m.level <= level ? i : t), 0)
  const kind = pick(r, ARCH_WEAPONS[archetype])
  // Arena regulars kit out about as fast as a player can afford to: on easier settings, often a
  // tier or two behind.
  const lag = opts.lag ?? 0.5
  // Steps are half tiers, so a whole tier behind is two.
  const tierFor = () => Math.max(0, Math.min(MATERIALS.length - 1, best + boost - (r() < lag ? 2 : 0) - (r() < lag / 3 ? 1 : 0)))
  const weapon = [...ITEMS].reverse().find((i) => i.weapon === kind && i.tier <= tierFor() && i.str <= stats.str + 2)
  if (weapon) g.gear.weapon = weapon.id
  const twoHanded = weaponType(kind).twoHanded
  const skip = level < 4 ? 0.55 : level < 8 ? 0.3 : 0.08
  for (const slot of ['head', 'body', 'shoulders', 'arms', 'legs', 'feet', 'cape', 'shield'] as Slot[]) {
    if (slot === 'shield' && twoHanded) continue
    if (slot === 'cape' && r() < 0.5) continue
    if (slot !== 'feet' && r() < skip) continue
    const t = tierFor()
    const it = ITEMS.filter((i) => i.slot === slot && i.tier <= t && i.str <= stats.str + 2).pop()
    if (it) g.gear[slot] = it.id
  }

  if (archetype === 'mage') g.spells = SPELLS.filter((s) => s.level <= Math.max(level, 2)).map((s) => s.id)
  else if (level >= 6 && r() < 0.25) g.spells = ['fireball']
  const prefs = ARCH_PERKS[archetype]
  g.perks = prefs.slice(0, PERK_LEVELS.filter((l) => l <= level).length)
  const pots = level < 3 ? 0 : level < 12 ? 1 : 2
  g.potions = { health: pots, stamina: archetype === 'brute' && pots ? 1 : 0, mana: archetype === 'mage' && pots ? 1 : 0 }
  return g
}

export function newGladiator(name: string, look: Look, stats: Stats): Gladiator {
  return {
    id: `you-${Date.now().toString(36)}`,
    name: name.trim() || 'Nameless',
    look,
    level: 1,
    xp: 0,
    stats,
    points: 0,
    gear: { weapon: 'weapon-gladius-0', feet: 'feet-0' },
    // A gift for magic shows early: a born caster starts with a spark of fire.
    spells: stats.mag >= BASE_STAT + 3 ? ['fireball'] : [],
    perks: [],
    potions: { health: 1, stamina: 0, mana: 0 },
  }
}
