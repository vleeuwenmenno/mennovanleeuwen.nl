// The game's tables: stats, gear, spells, potions, perks and leagues. Everything here is plain
// data so the combat engine, the shops and the renderer all read from one place.

export type StatKey = 'str' | 'atk' | 'def' | 'vit' | 'agi' | 'cha' | 'end' | 'mag'
export type Stats = Record<StatKey, number>

export const STATS: { key: StatKey; name: string; text: string }[] = [
  { key: 'str', name: 'Strength', text: 'Damage, knockback and heavy gear' },
  { key: 'atk', name: 'Attack', text: 'Chance to land a blow' },
  { key: 'def', name: 'Defence', text: 'Blocking and soaking up damage' },
  { key: 'vit', name: 'Vitality', text: 'Health' },
  { key: 'agi', name: 'Agility', text: 'Dodging, footwork and critical hits' },
  { key: 'cha', name: 'Charisma', text: 'Taunts, the crowd and prize money' },
  { key: 'end', name: 'Stamina', text: 'Energy for attacks and moves' },
  { key: 'mag', name: 'Magic', text: 'Mana and spell power' },
]
export const STAT_KEYS = STATS.map((s) => s.key)

/** Every stat starts here; creation hands out extra points, each level a few more. */
export const BASE_STAT = 3
export const CREATION_POINTS = 9
export const POINTS_PER_LEVEL = 4
export const MAX_LEVEL = 30

export const emptyStats = (v = 0): Stats => ({ str: v, atk: v, def: v, vit: v, agi: v, cha: v, end: v, mag: v })

// --- Gear ----------------------------------------------------------------------------------------

export type Slot = 'head' | 'body' | 'shoulders' | 'arms' | 'legs' | 'feet' | 'cape' | 'shield' | 'weapon'
export const ARMOUR_SLOTS: Slot[] = ['head', 'body', 'shoulders', 'arms', 'legs', 'feet', 'cape', 'shield']
export const SLOT_NAMES: Record<Slot, string> = {
  head: 'Helmet',
  body: 'Cuirass',
  shoulders: 'Pauldrons',
  arms: 'Bracers',
  legs: 'Greaves',
  feet: 'Boots',
  cape: 'Cape',
  shield: 'Shield',
  weapon: 'Weapon',
}

/** Seven tiers of material, from a farmhand's leather to gear the gods would envy. */
export type Material = { name: string; level: number; base: string; light: string; dark: string; trim: string; glow?: string }
export const MATERIALS: Material[] = [
  { name: 'Leather', level: 1, base: '#8a5a34', light: '#b07a4c', dark: '#5a381e', trim: '#3e2614' },
  { name: 'Bronze', level: 4, base: '#c0803a', light: '#e8b06a', dark: '#7e4e1e', trim: '#5a3612' },
  { name: 'Iron', level: 8, base: '#7c838c', light: '#a9b0b8', dark: '#4c5259', trim: '#33373c' },
  { name: 'Steel', level: 12, base: '#b8c3cf', light: '#eef3f8', dark: '#77828e', trim: '#c8a24a' },
  { name: 'Gilded', level: 17, base: '#e2b53e', light: '#fff0a8', dark: '#a37514', trim: '#f4f1e6' },
  { name: 'Imperial', level: 22, base: '#3a3442', light: '#6f6680', dark: '#1d1924', trim: '#e2b53e' },
  { name: 'Mythic', level: 27, base: '#2f5f74', light: '#8fe3ff', dark: '#173342', trim: '#e8f8ff', glow: '#6fd8ff' },
]

/** Capes are cloth, so they have their own colours per tier. */
export const CAPE_COLOURS = ['#7a6a52', '#9c3b2c', '#2f5a8a', '#3d7a44', '#b0263a', '#5c2a7a', '#e8eef5']

const ARMOUR_NAMES: Record<Exclude<Slot, 'weapon'>, string[]> = {
  head: ['Leather Cap', 'Bronze Crested Helm', 'Iron Galea', 'Steel Thraex Helm', 'Gilded Plumed Helm', 'Imperial Centurion Helm', 'Mythic Winged Helm'],
  body: ['Leather Jerkin', 'Bronze Muscle Cuirass', 'Iron Segmented Plate', 'Steel Lorica', 'Gilded Cuirass', 'Imperial Cuirass', 'Mythic Aegis Plate'],
  shoulders: ['Leather Pads', 'Bronze Pauldrons', 'Iron Manica Plates', 'Steel Pauldrons', 'Gilded Pauldrons', 'Imperial Spaulders', 'Mythic Pauldrons'],
  arms: ['Leather Wraps', 'Bronze Bracers', 'Iron Vambraces', 'Steel Manicae', 'Gilded Bracers', 'Imperial Vambraces', 'Mythic Bracers'],
  legs: ['Leather Shin Guards', 'Bronze Greaves', 'Iron Greaves', 'Steel Ocreae', 'Gilded Greaves', 'Imperial Greaves', 'Mythic Greaves'],
  feet: ['Sandals', 'Bronze-Studded Caligae', 'Iron-Shod Boots', 'Steel Sabatons', 'Gilded Boots', 'Imperial Boots', 'Mythic Boots'],
  cape: ['Wool Cloak', 'Red Sagum', 'Blue Paludamentum', 'Hunter’s Mantle', 'Champion’s Cape', 'Imperial Purple', 'Cloak of Stars'],
  shield: ['Leather Buckler', 'Bronze Parma', 'Iron Scutum', 'Steel Scutum', 'Gilded Aspis', 'Imperial Scutum', 'Mythic Aegis'],
}

// How much of a tier's protection each slot carries, and its share of the weight.
const SLOT_SHARE: Record<Exclude<Slot, 'weapon'>, number> = { head: 0.5, body: 1, shoulders: 0.35, arms: 0.3, legs: 0.4, feet: 0.3, cape: 0, shield: 0.6 }
const TIER_ARMOUR = [4, 8, 13, 19, 26, 34, 44]
const TIER_WEIGHT = [1, 2, 3.2, 3, 2.4, 2.2, 1.6]
const TIER_PRICE = [18, 60, 170, 420, 950, 1900, 3800]
const TIER_STR = [0, 5, 10, 15, 20, 26, 32]
// Higher tiers carry a stat bonus that depends on the slot.
const SLOT_BONUS: Record<Exclude<Slot, 'weapon'>, StatKey[]> = {
  head: ['def'],
  body: ['vit'],
  shoulders: ['str'],
  arms: ['atk'],
  legs: ['agi'],
  feet: ['agi'],
  cape: ['cha', 'mag'],
  shield: ['def'],
}

export type ShieldShape = 'buckler' | 'parma' | 'scutum' | 'aspis'
const SHIELD_SHAPES: ShieldShape[] = ['buckler', 'parma', 'scutum', 'scutum', 'aspis', 'scutum', 'aspis']
const SHIELD_BLOCK = [0.07, 0.1, 0.14, 0.16, 0.18, 0.2, 0.23]

export type WeaponKind = 'dagger' | 'gladius' | 'axe' | 'mace' | 'spear' | 'trident' | 'greatsword' | 'warhammer'
export type WeaponType = {
  kind: WeaponKind
  name: string
  /** Reach beyond touching distance, in arena units. */
  reach: number
  dmg: [number, number]
  acc: number
  crit: number
  /** Stamina cost multiplier. */
  cost: number
  stun: number
  twoHanded: boolean
  thrust: boolean
  strShare: number
  /** How much agility adds to damage: quick, light blades reward footwork. */
  finesse: number
}
export const WEAPON_TYPES: WeaponType[] = [
  { kind: 'dagger', name: 'Pugio', reach: 28, dmg: [3, 5], acc: 8, crit: 0.08, cost: 0.7, stun: 0, twoHanded: false, thrust: true, strShare: 0.5, finesse: 0.6 },
  { kind: 'gladius', name: 'Gladius', reach: 52, dmg: [4, 7], acc: 4, crit: 0.04, cost: 0.9, stun: 0, twoHanded: false, thrust: false, strShare: 0.8, finesse: 0.4 },
  { kind: 'axe', name: 'Axe', reach: 48, dmg: [3, 10], acc: -2, crit: 0.06, cost: 1.05, stun: 0, twoHanded: false, thrust: false, strShare: 1, finesse: 0 },
  { kind: 'mace', name: 'Mace', reach: 46, dmg: [5, 8], acc: 0, crit: 0.02, cost: 1.1, stun: 0.12, twoHanded: false, thrust: false, strShare: 1.1, finesse: 0 },
  { kind: 'spear', name: 'Spear', reach: 125, dmg: [4, 7], acc: 2, crit: 0.03, cost: 1, stun: 0, twoHanded: false, thrust: true, strShare: 0.9, finesse: 0.3 },
  { kind: 'trident', name: 'Trident', reach: 112, dmg: [5, 8], acc: 0, crit: 0.05, cost: 1.05, stun: 0, twoHanded: true, thrust: true, strShare: 1, finesse: 0.2 },
  { kind: 'greatsword', name: 'Greatsword', reach: 86, dmg: [8, 13], acc: -5, crit: 0.06, cost: 1.35, stun: 0.04, twoHanded: true, thrust: false, strShare: 1.4, finesse: 0 },
  { kind: 'warhammer', name: 'Warhammer', reach: 70, dmg: [9, 15], acc: -9, crit: 0.03, cost: 1.55, stun: 0.22, twoHanded: true, thrust: false, strShare: 1.6, finesse: 0 },
]
export const WEAPON_MATERIALS = ['Wooden', 'Bronze', 'Iron', 'Steel', 'Damascus', 'Imperial', 'Mythic']
const WEAPON_SCALE = [1, 1.6, 2.3, 3.1, 4, 5, 6.2]
const WEAPON_PRICE = [10, 50, 150, 380, 880, 1800, 3600]

export type Item = {
  id: string
  slot: Slot
  name: string
  tier: number
  level: number
  price: number
  armour: number
  weight: number
  str: number
  bonus: Partial<Stats>
  block?: number
  shape?: ShieldShape
  weapon?: WeaponKind
  dmg?: [number, number]
}

function makeArmour(): Item[] {
  const out: Item[] = []
  for (const slot of ARMOUR_SLOTS as Exclude<Slot, 'weapon'>[]) {
    for (let t = 0; t < MATERIALS.length; t++) {
      const share = SLOT_SHARE[slot]
      const bonus: Partial<Stats> = {}
      const keys = SLOT_BONUS[slot]
      const amount = slot === 'cape' ? t + 1 : t - 2
      if (amount > 0) keys.forEach((k, i) => (bonus[k] = i === 0 ? amount : Math.max(0, amount - 3)))
      for (const k of Object.keys(bonus) as StatKey[]) if (!bonus[k]) delete bonus[k]
      out.push({
        id: `${slot}-${t}`,
        slot,
        name: ARMOUR_NAMES[slot][t],
        tier: t,
        level: MATERIALS[t].level,
        price: Math.round(TIER_PRICE[t] * (slot === 'cape' ? 0.4 : 0.35 + share)),
        armour: Math.round(TIER_ARMOUR[t] * share),
        weight: Math.round(TIER_WEIGHT[t] * share * 10) / 10,
        str: Math.round(TIER_STR[t] * share),
        bonus,
        ...(slot === 'shield' ? { block: SHIELD_BLOCK[t], shape: SHIELD_SHAPES[t] } : {}),
      })
    }
  }
  return out
}

function makeWeapons(): Item[] {
  const out: Item[] = []
  for (const w of WEAPON_TYPES) {
    for (let t = 0; t < WEAPON_MATERIALS.length; t++) {
      const k = WEAPON_SCALE[t]
      const heavy = w.twoHanded ? 1.6 : w.strShare
      out.push({
        id: `weapon-${w.kind}-${t}`,
        slot: 'weapon',
        name: `${WEAPON_MATERIALS[t]} ${w.name}`,
        tier: t,
        level: MATERIALS[t].level,
        price: Math.round(WEAPON_PRICE[t] * (0.6 + 0.4 * heavy)),
        armour: 0,
        weight: Math.round(heavy * (1 + t * 0.15) * 10) / 10,
        str: Math.round(t * 4.5 * w.strShare),
        bonus: t >= 4 ? { atk: t - 3 } : {},
        weapon: w.kind,
        dmg: [Math.round(w.dmg[0] * k), Math.round(w.dmg[1] * k)],
      })
    }
  }
  return out
}

export const ITEMS: Item[] = [...makeArmour(), ...makeWeapons()]
export const ITEM_BY_ID = new Map(ITEMS.map((i) => [i.id, i]))
export const item = (id: string | null | undefined) => (id ? ITEM_BY_ID.get(id) ?? null : null)
export const weaponType = (kind: WeaponKind) => WEAPON_TYPES.find((w) => w.kind === kind)!
/** Bare fists, when nothing is in the weapon slot. */
export const FISTS: WeaponType = { kind: 'dagger', name: 'Fists', reach: 18, dmg: [1, 3], acc: 6, crit: 0.03, cost: 0.6, stun: 0.02, twoHanded: false, thrust: true, strShare: 0.6, finesse: 0.3 }

// --- Magic and potions ---------------------------------------------------------------------------

export type SpellId = 'fireball' | 'frost' | 'heal' | 'weaken' | 'blind' | 'thunder'
export type Spell = { id: SpellId; name: string; text: string; mana: number; level: number; price: number; power: number; perMag: number; ranged: boolean; colour: string }
export const SPELLS: Spell[] = [
  { id: 'fireball', name: 'Fireball', text: 'Hurls fire at any range. May set the target burning.', mana: 14, level: 2, price: 140, power: 4, perMag: 0.55, ranged: true, colour: '#ff8a2a' },
  { id: 'heal', name: 'Healing Light', text: 'Closes wounds mid-fight.', mana: 16, level: 4, price: 260, power: 10, perMag: 1.5, ranged: false, colour: '#8cf28a' },
  { id: 'frost', name: 'Frost Lance', text: 'Damages and slows: shorter steps, worse dodging.', mana: 15, level: 6, price: 380, power: 3, perMag: 0.45, ranged: true, colour: '#8fe3ff' },
  { id: 'weaken', name: 'Weaken', text: 'Saps the target’s strength and aim for three turns.', mana: 10, level: 9, price: 560, power: 0, perMag: 0, ranged: true, colour: '#b48cff' },
  { id: 'blind', name: 'Blinding Flash', text: 'The target swings at shadows for two turns.', mana: 12, level: 11, price: 720, power: 0, perMag: 0, ranged: true, colour: '#fff6b0' },
  { id: 'thunder', name: 'Thunderbolt', text: 'A bolt from Jupiter. Heavy damage, may stun.', mana: 26, level: 15, price: 1300, power: 7, perMag: 0.9, ranged: true, colour: '#d6e8ff' },
]
export const spell = (id: SpellId) => SPELLS.find((s) => s.id === id)!

export type PotionId = 'health' | 'stamina' | 'mana'
export type Potion = { id: PotionId; name: string; text: string; amount: number; colour: string }
export const POTIONS: Potion[] = [
  { id: 'health', name: 'Healing Draught', text: 'Restores 40% health.', amount: 0.4, colour: '#e0344a' },
  { id: 'stamina', name: 'Stamina Tonic', text: 'Restores 60% stamina.', amount: 0.6, colour: '#58c454' },
  { id: 'mana', name: 'Mana Elixir', text: 'Restores 60% mana.', amount: 0.6, colour: '#4a8cf0' },
]
export const MAX_POTIONS = 3
export const potionPrice = (level: number) => 18 + level * 6

// --- Perks ---------------------------------------------------------------------------------------

export type PerkId = 'riposte' | 'cleave' | 'showman' | 'secondWind' | 'ironSkin' | 'fleetFoot' | 'bloodlust' | 'arcane' | 'thickSkull' | 'executioner' | 'goldTongue'
export const PERKS: { id: PerkId; name: string; text: string }[] = [
  { id: 'riposte', name: 'Riposte', text: '30% chance to strike back when a blow misses you or is blocked.' },
  { id: 'cleave', name: 'Cleave', text: 'Power attacks deal 25% more damage and knock foes further.' },
  { id: 'showman', name: 'Showman', text: 'Taunts and big hits win the crowd twice as fast.' },
  { id: 'secondWind', name: 'Second Wind', text: 'Once per fight, below 25% health, recover 30% of it.' },
  { id: 'ironSkin', name: 'Iron Skin', text: '20% more armour.' },
  { id: 'fleetFoot', name: 'Fleet Foot', text: 'Move 40% further and dodge more often.' },
  { id: 'bloodlust', name: 'Bloodlust', text: 'Heal 12% of the melee damage you deal.' },
  { id: 'arcane', name: 'Arcane Mind', text: 'Spells hit 15% harder and cost 20% less mana.' },
  { id: 'thickSkull', name: 'Thick Skull', text: 'Cannot be stunned, and 10% more health.' },
  { id: 'executioner', name: 'Executioner', text: '30% more damage against foes below 30% health.' },
  { id: 'goldTongue', name: 'Golden Tongue', text: '25% more gold and fame from every fight.' },
]
export const perk = (id: PerkId) => PERKS.find((p) => p.id === id)!
export const PERK_LEVELS = [5, 10, 15, 20, 25, 30]

// --- Leagues -------------------------------------------------------------------------------------

export type LeagueId = 'pits' | 'city' | 'colosseum'
export type League = {
  id: LeagueId
  name: string
  blurb: string
  arena: string
  levels: [number, number]
  entry: number
  prize: number
  champion: { name: string; title: string; level: number; archetype: Archetype; seed: number }
}
export type Archetype = 'brute' | 'duelist' | 'tank' | 'showman' | 'mage' | 'spearman'
export const LEAGUES: League[] = [
  {
    id: 'pits',
    name: 'Village Pits',
    blurb: 'Straw, splinters and a crowd that throws turnips.',
    arena: 'arena-pits',
    levels: [1, 9],
    entry: 25,
    prize: 220,
    champion: { name: 'Gorgo', title: 'the Butcher of Capua', level: 10, archetype: 'brute', seed: 7031 },
  },
  {
    id: 'city',
    name: 'City Arena',
    blurb: 'Stone stands, real prize money, real blood.',
    arena: 'arena-city',
    levels: [9, 19],
    entry: 120,
    prize: 1100,
    champion: { name: 'Varro', title: 'the Unbroken', level: 20, archetype: 'tank', seed: 4127 },
  },
  {
    id: 'colosseum',
    name: 'Imperial Colosseum',
    blurb: 'Fifty thousand voices and the Emperor’s thumb.',
    arena: 'arena-colosseum',
    levels: [19, 30],
    entry: 450,
    prize: 4200,
    champion: { name: 'Aurelia', title: 'the Emperor’s Blade', level: 32, archetype: 'duelist', seed: 9907 },
  },
]
export const league = (id: LeagueId) => LEAGUES.find((l) => l.id === id)!

// --- Difficulty ----------------------------------------------------------------------------------

export type Difficulty = 'easy' | 'normal' | 'hard' | 'legendary'
export type DifficultyRules = {
  name: string
  text: string
  /** Added to the computer's sharpness (0 erratic, 1 and above near-perfect). */
  skill: number
  /** Multiplies the stat points opponents have earned above the base. */
  stats: number
  /** Chance an opponent's piece of gear is a tier behind the best their level allows. */
  lag: number
  /** Level offsets of the three bouts on offer, from the warm-up to the tough draw. */
  offers: [number, number, number]
  /** Tournament entrants' level range around yours. */
  field: [number, number]
  /** Share of missing health the surgeon restores between tournament rounds. */
  surgeon: number
  /** Extra levels for league champions. */
  champion: number
  /** Gold and experience multiplier, so harder is worth it. */
  reward: number
}
export const DIFFICULTIES: Record<Difficulty, DifficultyRules> = {
  easy: { name: 'Easy', text: 'Forgiving opponents with hand-me-down gear.', skill: -0.1, stats: 0.9, lag: 0.85, offers: [-1, 0, 1], field: [-2, 1], surgeon: 0.5, champion: -2, reward: 0.85 },
  normal: { name: 'Normal', text: 'Opponents who fight back and keep up with your kit.', skill: 0.15, stats: 1, lag: 0.5, offers: [0, 1, 2], field: [-1, 2], surgeon: 0.35, champion: 0, reward: 1 },
  hard: { name: 'Hard', text: 'Sharp, stronger opponents in up-to-date gear. Better pay.', skill: 0.3, stats: 1.05, lag: 0.35, offers: [0, 1, 3], field: [0, 3], surgeon: 0.2, champion: 2, reward: 1.25 },
  legendary: { name: 'Legendary', text: 'Everyone is stronger than you. No surgeon. Glory pays double... almost.', skill: 0.45, stats: 1.25, lag: 0, offers: [1, 2, 3], field: [1, 3], surgeon: 0, champion: 3, reward: 1.5 },
}
export const DIFFICULTY_IDS = Object.keys(DIFFICULTIES) as Difficulty[]

// --- Names and looks -----------------------------------------------------------------------------

export const FIRST_NAMES = [
  'Marcus', 'Spartacus', 'Crixus', 'Flamma', 'Priscus', 'Verus', 'Carpophorus', 'Tetraites', 'Commodus', 'Hermes', 'Tigris', 'Atticus', 'Brutus', 'Cassius', 'Decimus',
  'Felix', 'Gaius', 'Lucius', 'Maximus', 'Nero', 'Octavian', 'Quintus', 'Rufus', 'Severus', 'Titus', 'Ursus', 'Vibius', 'Draco', 'Leonidas', 'Ajax', 'Orion', 'Kaeso',
  'Ganicus', 'Oenomaus', 'Barca', 'Agron', 'Duro', 'Naevia', 'Mira', 'Achillia', 'Amazonia', 'Livia', 'Valeria', 'Sabina', 'Junia', 'Camilla', 'Hilara', 'Tullia',
]
export const EPITHETS = [
  'the Bold', 'the Mad', 'the Bull', 'Ironjaw', 'the Wolf', 'the Viper', 'Bonecrusher', 'the Swift', 'the Red', 'the Lion', 'the Gaul', 'the Thracian', 'Skullsplitter',
  'the Butcher', 'the Unlucky', 'Goldenhair', 'the Giant', 'the Fox', 'Stonefist', 'the Gentle', 'the Hammer', 'the Storm', 'Halfear', 'the Smiling', 'the Bear',
]

export const SKIN_TONES = ['#f3d2b3', '#e8b98f', '#d39a6a', '#b77a4c', '#8d5a36', '#643c22']
export const HAIR_COLOURS = ['#1d1612', '#3e2a1c', '#6e4424', '#a8642a', '#d8b060', '#9a9a9a', '#b8342a']
export const TUNIC_COLOURS = ['#b8342a', '#2f5a8a', '#3d7a44', '#c79a32', '#6a3a8a', '#e6dccb', '#3a3a3a']
export const HAIR_STYLES = ['bald', 'short', 'curly', 'long', 'mohawk', 'ponytail'] as const
export const BEARDS = ['none', 'stubble', 'goatee', 'full', 'braided'] as const
export type HairStyle = (typeof HAIR_STYLES)[number]
export type Beard = (typeof BEARDS)[number]
export type Look = { skin: string; hair: HairStyle; hairColour: string; beard: Beard; tunic: string; build: number }
