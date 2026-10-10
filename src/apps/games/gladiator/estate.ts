import { item, weaponType, type Item, type WeaponKind } from './data'

// The estate: where the materials for gear come from, and a long game of its own. Four natural
// work sites (woods, pastures, mine, river) and the workshop sit on a map of the grounds, with
// plots around them to clear and build on. Jobs run on real time (an hour to ten), and so does
// construction, so it all keeps going while the game is closed and on every device the save
// syncs to.
//
// Buildings refine what the sites gather (planks, bricks, leather, cloth), add crews, bring in
// rents, raise market prices and, a little, help in the arena. Each has a long upgrade path, and
// most fork at a level where you choose what the rest of the path does. Every level built adds to
// the estate's rank, which opens more plots and higher levels.
//
// Gear is no longer bought: a blueprint is, once, and then each piece is crafted from materials
// (from the estate, or the market) plus a smith's fee, taking longer the finer the material.

export type ResId = 'timber' | 'hide' | 'wool' | 'copper' | 'tin' | 'iron' | 'coal' | 'gold' | 'gems' | 'starmetal' | 'stone' | 'clay' | 'planks' | 'bricks' | 'leather' | 'cloth'
export type SiteId = 'woodland' | 'pastures' | 'mine' | 'river' | 'workshop'
export type Bag = Partial<Record<ResId, number>>
type Cost = Bag & { coins: number }

/** `kind` groups the storehouse: what gear is made of, what buildings are made of, and trade goods. */
export const RESOURCES: { id: ResId; name: string; glyph: string; price: number; stock: number; text: string; kind: 'gear' | 'build' | 'goods' }[] = [
  { id: 'timber', name: 'Timber', glyph: '🪵', price: 4, stock: 60, text: 'Hafts, shafts, shield cores and every building.', kind: 'gear' },
  { id: 'hide', name: 'Hides', glyph: '🟫', price: 6, stock: 40, text: 'Leather for the first armour, straps for the rest.', kind: 'gear' },
  { id: 'wool', name: 'Wool', glyph: '🧶', price: 5, stock: 40, text: 'Woven into capes.', kind: 'gear' },
  { id: 'copper', name: 'Copper', glyph: '🟠', price: 7, stock: 40, text: 'With tin, it makes bronze.', kind: 'gear' },
  { id: 'tin', name: 'Tin', glyph: '⚪', price: 9, stock: 30, text: 'The other half of bronze.', kind: 'gear' },
  { id: 'iron', name: 'Iron ore', glyph: '⛓️', price: 12, stock: 30, text: 'Iron, and with charcoal, steel.', kind: 'gear' },
  { id: 'coal', name: 'Charcoal', glyph: '⚫', price: 8, stock: 30, text: 'Fuel for hot forges, kilns and steel.', kind: 'gear' },
  { id: 'gold', name: 'Gold', glyph: '🟡', price: 30, stock: 12, text: 'Gilding and chasing.', kind: 'gear' },
  { id: 'gems', name: 'Gems', glyph: '💎', price: 45, stock: 6, text: 'Set into imperial gear and casting foci.', kind: 'gear' },
  { id: 'starmetal', name: 'Star metal', glyph: '☄️', price: 140, stock: 2, text: 'Fallen from the sky. Mythic gear is made of it.', kind: 'gear' },
  { id: 'stone', name: 'Stone', glyph: '🪨', price: 3, stock: 80, text: 'Foundations and walls.', kind: 'build' },
  { id: 'clay', name: 'Clay', glyph: '🟤', price: 3, stock: 80, text: 'Dug from the river banks; fired into bricks.', kind: 'build' },
  { id: 'planks', name: 'Planks', glyph: '🪚', price: 10, stock: 40, text: 'Sawn timber for floors, roofs and scaffolds.', kind: 'build' },
  { id: 'bricks', name: 'Bricks', glyph: '🧱', price: 11, stock: 40, text: 'Fired clay, for buildings that last.', kind: 'build' },
  { id: 'leather', name: 'Leather', glyph: '👜', price: 16, stock: 25, text: 'Tanned hides: saddles, harness and trade.', kind: 'goods' },
  { id: 'cloth', name: 'Cloth', glyph: '🧵', price: 15, stock: 25, text: 'Woven wool: awnings, bath linen and trade.', kind: 'goods' },
]
export const resource = (id: ResId) => RESOURCES.find((r) => r.id === id)!

// --- The map ---------------------------------------------------------------------------------------

/** Where things sit on the map, in percent of its width and height (the picture is 3:2). */
export type Pos = { x: number; y: number }
export type Terrain = 'hill' | 'river' | 'wood' | 'field' | 'villa'
export const TERRAIN_NAMES: Record<Terrain, string> = { hill: 'Hillside', river: 'Riverside', wood: 'Woodland', field: 'Open field', villa: 'The villa' }

export const SITES: ({ id: SiteId; name: string; text: string; glyph: string } & Pos)[] = [
  { id: 'woodland', name: 'Woodland', text: 'Timber, and charcoal burned from it.', glyph: '🌲', x: 12, y: 36 },
  { id: 'pastures', name: 'Pastures', text: 'Hides from the hunt, wool from the flock.', glyph: '🐑', x: 87, y: 43 },
  { id: 'mine', name: 'Mine', text: 'Stone, copper, tin, iron, and deep down, star metal.', glyph: '⛏️', x: 22.5, y: 6.5 },
  { id: 'river', name: 'River', text: 'Clay from the banks, gold from the gravel, gems from the old pits.', glyph: '🏞️', x: 58.5, y: 48 },
  { id: 'workshop', name: 'Workshop', text: 'Where your gear is forged. More benches, faster work.', glyph: '🔨', x: 80.5, y: 24 },
]
export const site = (id: SiteId) => SITES.find((s) => s.id === id)!

/** Ranks needed to clear a plot, and what it costs. Index = rank. */
const CLEAR: (Cost & { hours: number })[] = [
  { coins: 0, hours: 0 },
  { coins: 80, hours: 0.25, timber: 6 },
  { coins: 180, hours: 0.5, timber: 12, stone: 10 },
  { coins: 350, hours: 1, timber: 20, stone: 25, planks: 6 },
  { coins: 600, hours: 1.5, stone: 40, planks: 15, bricks: 6 },
  { coins: 950, hours: 2, stone: 60, planks: 25, bricks: 15 },
  { coins: 1400, hours: 3, stone: 80, planks: 40, bricks: 30, iron: 10 },
  { coins: 2000, hours: 4, stone: 100, planks: 50, bricks: 50, gold: 10 },
]

/** The plots: open from the start, or overgrown until cleared (`rank` says when you may). */
export type PlotDef = { id: string; name: string; terrain: Terrain; rank: number } & Pos
export const PLOTS: PlotDef[] = [
  { id: 'villa', name: 'The villa', terrain: 'villa', rank: 0, x: 81.5, y: 9 },
  { id: 'p-willow', name: 'Willow meadow', terrain: 'field', rank: 0, x: 36.1, y: 54.7 },
  { id: 'p-ford', name: 'River meadow', terrain: 'river', rank: 0, x: 60.5, y: 65.6 },
  { id: 'p-edge', name: 'Woodland edge', terrain: 'wood', rank: 0, x: 34.5, y: 41.2 },
  { id: 'p-cross', name: 'Crossroads', terrain: 'field', rank: 0, x: 49.8, y: 78.1 },
  { id: 'p-bridge', name: 'Bridge field', terrain: 'field', rank: 1, x: 69.7, y: 27.1 },
  { id: 'p-terrace', name: 'Mine terrace', terrain: 'hill', rank: 2, x: 29.5, y: 23.5 },
  { id: 'p-east', name: 'East bank', terrain: 'river', rank: 2, x: 61.2, y: 33.4 },
  { id: 'p-wheat', name: 'Wheat road', terrain: 'field', rank: 2, x: 32.2, y: 75 },
  { id: 'p-gate', name: 'Villa gate', terrain: 'field', rank: 3, x: 68, y: 16.1 },
  { id: 'p-arch', name: 'Old bridge bank', terrain: 'river', rank: 3, x: 72.3, y: 71.1 },
  { id: 'p-ledge', name: 'Headframe ledge', terrain: 'hill', rank: 4, x: 42.6, y: 19 },
  { id: 'p-burn', name: 'Charcoal clearing', terrain: 'wood', rank: 4, x: 24.4, y: 65.4 },
  { id: 'p-fold', name: 'Pasture corner', terrain: 'field', rank: 5, x: 94.2, y: 59.6 },
  { id: 'p-lower', name: 'Lower ford', terrain: 'river', rank: 5, x: 67.1, y: 85.9 },
  { id: 'p-ridge', name: 'Upper ridge', terrain: 'hill', rank: 6, x: 36.5, y: 6.5 },
  { id: 'p-upper', name: 'Upper terrace', terrain: 'field', rank: 7, x: 94, y: 22.3 },
]
export const plotDef = (id: string) => PLOTS.find((p) => p.id === id)
export const clearCost = (p: PlotDef) => CLEAR[p.rank]

// --- What the estate gives: bonuses ------------------------------------------------------------------

/** Everything buildings (and the sites' specialisations) add up to. Fractions unless noted. */
export type Bonus = {
  /** Spare crews, who can work a job at any site or building. */
  crews: number
  /** More construction at once. */
  builders: number
  jobSpeed: number
  /** Extra yield per material, or `all` for every job. */
  yield: Partial<Record<ResId | 'all', number>>
  /** Jobs that earn coins pay this much more. */
  coinJobs: number
  /** Added to the half of the going rate the market pays. */
  sell: number
  buy: number
  stock: number
  /** Coins an hour. */
  income: number
  /** Hours of rents that pile up before the steward stops counting. */
  incomeCap: number
  buildCost: number
  buildSpeed: number
  craftWeapon: number
  craftArmour: number
  salvage: number
  xp: number
  purse: number
  fame: number
  surgeon: number
  train: number
  respec: number
}
type Part = Partial<Omit<Bonus, 'yield'>> & { yield?: Bonus['yield'] }

const ZERO: Bonus = { crews: 0, builders: 0, jobSpeed: 0, yield: {}, coinJobs: 0, sell: 0, buy: 0, stock: 0, income: 0, incomeCap: 12, buildCost: 0, buildSpeed: 0, craftWeapon: 0, craftArmour: 0, salvage: 0, xp: 0, purse: 0, fame: 0, surgeon: 0, train: 0, respec: 0 }
// Anything that reaches into the arena stays small: combat was balanced without the estate.
const CAPS: Partial<Record<keyof Bonus, number>> = { xp: 0.08, purse: 0.08, fame: 0.2, surgeon: 0.06, train: 0.3, respec: 0.4, jobSpeed: 0.3, buildCost: 0.25, buildSpeed: 0.3, sell: 0.35, buy: 0.2, craftWeapon: 0.35, craftArmour: 0.35, salvage: 0.15, coinJobs: 0.4 }

/** Levels at or past `from`: how far into a specialisation a building is. */
const past = (level: number, from: number) => Math.max(0, level - from + 1)

// --- Buildings ---------------------------------------------------------------------------------------

export type BuildingId =
  | 'villa' | 'sawmill' | 'kiln' | 'quarry' | 'claypit' | 'tannery' | 'weaver' | 'smelter' | 'goldsmith'
  | 'quarters' | 'granary' | 'storehouse' | 'tradepost' | 'vineyard' | 'bathhouse' | 'shrine' | 'training' | 'stables'
export type Category = 'home' | 'production' | 'workforce' | 'economy' | 'arena'
export const CATEGORIES: Record<Category, string> = { home: 'Home', production: 'Production', workforce: 'Workforce', economy: 'Economy', arena: 'For the arena' }
export type Branch = { id: string; name: string; text: string }

export type BuildingDef = {
  id: BuildingId
  name: string
  glyph: string
  cat: Category
  text: string
  terrain: Terrain[]
  /** Estate rank needed to build it at all. */
  rank: number
  max: number
  /** Level 1's price; it grows each level. */
  cost: Cost
  /** Finer materials that join the bill from the specialisation on. */
  late: Bag
  /** The level where the path forks, and the forks. */
  branchAt?: number
  branches?: Branch[]
  effect: (level: number, branch?: string) => Part
}

export const BUILDINGS: BuildingDef[] = [
  {
    id: 'villa', name: 'Villa', glyph: '🏛️', cat: 'home', terrain: ['villa'], rank: 0, max: 12,
    text: 'Your house. Rents from the tenants, and the steward who runs the builders.',
    cost: { coins: 400, timber: 20, stone: 20 }, late: { bricks: 12, planks: 10, gold: 2 },
    branchAt: 6,
    branches: [
      { id: 'patron', name: "Patron's hall", text: 'Entertain the city. More fame from wins, a little more prize money.' },
      { id: 'counting', name: 'Counting house', text: 'A steward who squeezes the tenants: more rents, better market deals.' },
    ],
    effect: (l, b) => ({
      income: 3 * l + (b === 'counting' ? 6 * past(l, 6) : 0),
      builders: (l >= 4 ? 1 : 0) + (l >= 9 ? 1 : 0),
      fame: b === 'patron' ? 0.015 * past(l, 6) : 0,
      purse: b === 'patron' ? 0.005 * past(l, 6) : 0,
      sell: b === 'counting' ? 0.01 * past(l, 6) : 0,
    }),
  },
  {
    id: 'sawmill', name: 'Sawmill', glyph: '🪚', cat: 'production', terrain: ['wood', 'river'], rank: 1, max: 10,
    text: 'Saws timber into planks for building.',
    cost: { coins: 60, timber: 12, stone: 6 }, late: { bricks: 6, iron: 3 },
    branchAt: 5,
    branches: [
      { id: 'lumber', name: 'Lumber yard', text: 'More planks from every log, more timber from the woods.' },
      { id: 'joiner', name: "Joiner's shop", text: 'Fitted timber makes every construction cheaper; carts to sell.' },
    ],
    effect: (l, b) => ({
      yield: b === 'lumber' ? { planks: 0.06 * past(l, 5), timber: 0.03 * past(l, 5) } : {},
      buildCost: b === 'joiner' ? 0.015 * past(l, 5) : 0,
    }),
  },
  {
    id: 'kiln', name: 'Brick kiln', glyph: '🧱', cat: 'production', terrain: ['hill', 'field'], rank: 1, max: 10,
    text: 'Fires clay into bricks, and timber into charcoal.',
    cost: { coins: 60, stone: 10, clay: 8 }, late: { planks: 6, iron: 3 },
    branchAt: 5,
    branches: [
      { id: 'brickworks', name: 'Brickworks', text: 'More bricks from every firing.' },
      { id: 'charburner', name: 'Charcoal burner', text: 'More charcoal, and great charcoal pits.' },
      { id: 'potter', name: 'Pottery', text: 'Amphorae for the market: clay into coins.' },
    ],
    effect: (l, b) => ({
      yield: b === 'brickworks' ? { bricks: 0.06 * past(l, 5) } : b === 'charburner' ? { coal: 0.06 * past(l, 5) } : {},
      coinJobs: b === 'potter' ? 0.02 * past(l, 5) : 0,
    }),
  },
  {
    id: 'quarry', name: 'Quarry', glyph: '🪨', cat: 'production', terrain: ['hill'], rank: 1, max: 10,
    text: 'Cuts stone from the hillside.',
    cost: { coins: 70, timber: 10, copper: 3 }, late: { planks: 6, iron: 4 },
    branchAt: 5,
    branches: [
      { id: 'deep', name: 'Deep quarry', text: 'More stone, and a whole new face to cut.' },
      { id: 'mason', name: "Masons' lodge", text: 'Masons who make every construction cheaper and quicker.' },
    ],
    effect: (l, b) => ({
      yield: { stone: 0.02 * l + (b === 'deep' ? 0.06 * past(l, 5) : 0) },
      buildCost: b === 'mason' ? 0.02 * past(l, 5) : 0,
      buildSpeed: b === 'mason' ? 0.03 * past(l, 5) : 0,
    }),
  },
  {
    id: 'claypit', name: 'Clay pit', glyph: '🟤', cat: 'production', terrain: ['river'], rank: 1, max: 10,
    text: 'Digs the river clay that bricks are fired from.',
    cost: { coins: 50, timber: 8, stone: 4 }, late: { planks: 6, bricks: 4 },
    branchAt: 5,
    branches: [
      { id: 'beds', name: 'Clay beds', text: 'More clay, and the deep marl beds.' },
      { id: 'gravel', name: 'Gravel works', text: 'Washes the spoil for gold and the odd gem.' },
    ],
    effect: (l, b) => ({
      yield: b === 'beds' ? { clay: 0.07 * past(l, 5) } : b === 'gravel' ? { gold: 0.03 * past(l, 5), gems: 0.03 * past(l, 5) } : {},
    }),
  },
  {
    id: 'tannery', name: 'Tannery', glyph: '👜', cat: 'production', terrain: ['river'], rank: 1, max: 10,
    text: 'Tans hides into leather, for trade and for building.',
    cost: { coins: 80, timber: 10, stone: 8 }, late: { planks: 6, bricks: 6 },
    branchAt: 5,
    branches: [
      { id: 'tanyard', name: 'Tan yard', text: 'More leather per hide, more hides from the pastures.' },
      { id: 'saddler', name: 'Saddlery', text: 'Saddles for sale: leather into coins, and every coin job pays more.' },
    ],
    effect: (l, b) => ({
      yield: { hide: 0.02 * l + (b === 'tanyard' ? 0.03 * past(l, 5) : 0), leather: b === 'tanyard' ? 0.06 * past(l, 5) : 0 },
      coinJobs: b === 'saddler' ? 0.03 * past(l, 5) : 0,
    }),
  },
  {
    id: 'weaver', name: 'Weaving shed', glyph: '🧵', cat: 'production', terrain: ['field'], rank: 1, max: 10,
    text: 'Weaves wool into cloth.',
    cost: { coins: 80, timber: 12, wool: 4 }, late: { planks: 8, bricks: 4 },
    branchAt: 5,
    branches: [
      { id: 'fuller', name: 'Fullery', text: 'More cloth per fleece, more wool from the flock.' },
      { id: 'dyer', name: 'Dye works', text: 'Purple cloth for senators: cloth into coins, and coin jobs pay more.' },
    ],
    effect: (l, b) => ({
      yield: { wool: 0.02 * l + (b === 'fuller' ? 0.03 * past(l, 5) : 0), cloth: b === 'fuller' ? 0.06 * past(l, 5) : 0 },
      coinJobs: b === 'dyer' ? 0.03 * past(l, 5) : 0,
    }),
  },
  {
    id: 'smelter', name: 'Smelter', glyph: '🔥', cat: 'production', terrain: ['hill'], rank: 2, max: 10,
    text: 'Smelts ore out of rock. Every level, more metal from the mine.',
    cost: { coins: 120, stone: 16, clay: 10, copper: 4 }, late: { bricks: 10, iron: 6 },
    branchAt: 5,
    branches: [
      { id: 'blast', name: 'Blast furnace', text: 'Iron by the cartload.' },
      { id: 'foundry', name: 'Bronze foundry', text: 'Founders who help at the workshop: all forging goes faster. Bells to sell.' },
    ],
    effect: (l, b) => ({
      yield: { iron: 0.02 * l + (b === 'blast' ? 0.04 * past(l, 5) : 0), copper: 0.02 * l, tin: 0.02 * l },
      craftWeapon: b === 'foundry' ? 0.03 * past(l, 5) : 0,
      craftArmour: b === 'foundry' ? 0.03 * past(l, 5) : 0,
    }),
  },
  {
    id: 'goldsmith', name: 'Goldsmith', glyph: '💍', cat: 'production', terrain: ['field'], rank: 3, max: 10,
    text: 'Turns gold and gems into jewellery, and jewellery into coins.',
    cost: { coins: 200, stone: 12, planks: 6, gold: 2 }, late: { bricks: 8, gems: 1 },
    branchAt: 5,
    branches: [
      { id: 'jeweller', name: 'Jeweller', text: 'Every coin job pays more; diadems for the court.' },
      { id: 'lapidary', name: 'Gem cutter', text: 'Finds gems in plain stone; more gems and gold from every job.' },
    ],
    effect: (l, b) => ({
      coinJobs: b === 'jeweller' ? 0.05 * past(l, 5) : 0,
      yield: b === 'lapidary' ? { gems: 0.05 * past(l, 5), gold: 0.02 * past(l, 5) } : {},
    }),
  },
  {
    id: 'quarters', name: "Workers' quarters", glyph: '🏠', cat: 'workforce', terrain: ['field', 'wood'], rank: 1, max: 10,
    text: 'Room for more hands: spare crews who work wherever there is a free job.',
    cost: { coins: 70, timber: 14, stone: 6 }, late: { planks: 8, bricks: 6 },
    branchAt: 5,
    branches: [
      { id: 'longhouse', name: 'Longhouse', text: 'Even more spare crews.' },
      { id: 'overseer', name: "Overseer's house", text: 'An overseer: every job finishes sooner.' },
    ],
    effect: (l, b) => ({
      crews: 1 + (l >= 3 ? 1 : 0) + (l >= 6 ? 1 : 0) + (l >= 9 ? 1 : 0) + (b === 'longhouse' ? (l >= 7 ? 1 : 0) + (l >= 10 ? 1 : 0) : 0),
      jobSpeed: b === 'overseer' ? 0.02 * past(l, 5) : 0,
    }),
  },
  {
    id: 'granary', name: 'Granary', glyph: '🌾', cat: 'workforce', terrain: ['field'], rank: 2, max: 10,
    text: 'Well-fed crews work faster. Sells the surplus grain.',
    cost: { coins: 90, timber: 10, stone: 10, clay: 6 }, late: { bricks: 8, planks: 6 },
    branchAt: 5,
    branches: [
      { id: 'mill', name: 'Flour mill', text: 'Bread for everyone: more from every job.' },
      { id: 'mess', name: 'Mess hall', text: 'Feeds more mouths: more spare crews.' },
    ],
    effect: (l, b) => ({
      jobSpeed: 0.012 * l,
      yield: b === 'mill' ? { all: 0.02 * past(l, 5) } : {},
      crews: b === 'mess' ? (l >= 5 ? 1 : 0) + (l >= 8 ? 1 : 0) : 0,
    }),
  },
  {
    id: 'storehouse', name: 'Storehouse', glyph: '📦', cat: 'economy', terrain: ['field', 'river'], rank: 1, max: 10,
    text: 'Room to buy in bulk at the market, a strongbox for rents, and a sharper eye for scrap.',
    cost: { coins: 80, timber: 16, stone: 8 }, late: { planks: 10, iron: 3 },
    branchAt: 5,
    branches: [
      { id: 'strongroom', name: 'Strongroom', text: 'Rents keep piling up for longer, and the vault earns interest.' },
      { id: 'depot', name: 'Trade depot', text: 'Bigger lots at the market, bought cheaper.' },
    ],
    effect: (l, b) => ({
      stock: 0.08 * l + (b === 'depot' ? 0.1 * past(l, 5) : 0),
      incomeCap: 2 * l + (b === 'strongroom' ? 3 * past(l, 5) : 0),
      income: b === 'strongroom' ? 3 * past(l, 5) : 0,
      buy: b === 'depot' ? 0.015 * past(l, 5) : 0,
      salvage: 0.01 * l,
    }),
  },
  {
    id: 'tradepost', name: 'Trading post', glyph: '⚖️', cat: 'economy', terrain: ['river', 'field'], rank: 2, max: 10,
    text: 'Your own stall: the market pays more for what you sell.',
    cost: { coins: 150, timber: 10, wool: 4, stone: 6 }, late: { cloth: 6, planks: 8 },
    branchAt: 5,
    branches: [
      { id: 'guild', name: "Merchants' guild", text: 'Even better prices, selling and buying.' },
      { id: 'caravan', name: 'Caravan route', text: 'Caravans that bring in coins on their own, and convoys to send.' },
    ],
    effect: (l, b) => ({
      sell: 0.02 * l + (b === 'guild' ? 0.015 * past(l, 5) : 0),
      buy: b === 'guild' ? 0.01 * past(l, 5) : 0,
      income: b === 'caravan' ? 8 * past(l, 5) : 0,
    }),
  },
  {
    id: 'vineyard', name: 'Vineyard', glyph: '🍇', cat: 'economy', terrain: ['hill', 'field'], rank: 2, max: 10,
    text: 'Vines on the slope: rents from the tenants and a harvest to sell.',
    cost: { coins: 100, timber: 8, clay: 8 }, late: { bricks: 4, planks: 6 },
    branchAt: 5,
    branches: [
      { id: 'winery', name: 'Winery', text: 'Vintages that fetch a price; every coin job pays more.' },
      { id: 'olives', name: 'Olive press', text: 'Olive groves between the vines: more rents.' },
    ],
    effect: (l, b) => ({
      income: 2 * l + (b === 'olives' ? 4 * past(l, 5) : 0),
      coinJobs: b === 'winery' ? 0.04 * past(l, 5) : 0,
    }),
  },
  {
    id: 'bathhouse', name: 'Bathhouse', glyph: '♨️', cat: 'arena', terrain: ['river'], rank: 3, max: 10,
    text: 'Hot baths and a good surgeon: you recover more between tournament rounds.',
    cost: { coins: 220, stone: 20, bricks: 8, copper: 6 }, late: { cloth: 6, bricks: 12 },
    branchAt: 5,
    branches: [
      { id: 'thermae', name: 'Thermae', text: 'The surgeon works wonders between rounds.' },
      { id: 'palaestra', name: 'Palaestra', text: 'An exercise court: the crowd talks about you, and training costs less.' },
    ],
    effect: (l, b) => ({
      surgeon: 0.005 * l + (b === 'thermae' ? 0.004 * past(l, 5) : 0),
      fame: b === 'palaestra' ? 0.015 * past(l, 5) : 0,
      train: b === 'palaestra' ? 0.02 * past(l, 5) : 0,
    }),
  },
  {
    id: 'shrine', name: 'Shrine', glyph: '🔥', cat: 'arena', terrain: ['hill', 'wood'], rank: 2, max: 10,
    text: 'A shrine on your land. Choose the god it is raised to.',
    cost: { coins: 150, stone: 18, gold: 1 }, late: { bricks: 6, gold: 2, gems: 1 },
    branchAt: 3,
    branches: [
      { id: 'mars', name: 'Mars', text: 'The war god: more experience from every fight.' },
      { id: 'fortuna', name: 'Fortuna', text: 'Luck: more prize money from every win.' },
      { id: 'nemesis', name: 'Nemesis', text: "The gladiators' goddess: more fame from every win." },
    ],
    effect: (l, b) => ({
      xp: 0.005 * Math.min(l, 2) + (b === 'mars' ? 0.008 * past(l, 3) : 0),
      purse: b === 'fortuna' ? 0.008 * past(l, 3) : 0,
      fame: b === 'nemesis' ? 0.02 * past(l, 3) : 0,
    }),
  },
  {
    id: 'training', name: 'Training ground', glyph: '🎯', cat: 'arena', terrain: ['field'], rank: 1, max: 10,
    text: 'Your own yard: training in town costs less.',
    cost: { coins: 100, timber: 14, hide: 6 }, late: { leather: 6, planks: 8 },
    branchAt: 5,
    branches: [
      { id: 'drill', name: 'Drill yard', text: 'Cheaper training still.' },
      { id: 'school', name: "Lanista's school", text: 'A trainer of trainers: retraining costs less, and fights teach a little more.' },
    ],
    effect: (l, b) => ({
      train: 0.02 * l + (b === 'drill' ? 0.01 * past(l, 5) : 0),
      respec: b === 'school' ? 0.05 * past(l, 5) : 0,
      xp: b === 'school' ? 0.004 * past(l, 5) : 0,
    }),
  },
  {
    id: 'stables', name: 'Stables', glyph: '🐎', cat: 'arena', terrain: ['field'], rank: 3, max: 10,
    text: 'Horses for the circus: race them for coins. A stable of your own is talked about.',
    cost: { coins: 180, timber: 16, planks: 6, hide: 6 }, late: { leather: 8, bricks: 6 },
    branchAt: 5,
    branches: [
      { id: 'racing', name: 'Racing stable', text: 'Chariot teams for the Circus: big race purses.' },
      { id: 'stud', name: 'Stud farm', text: 'Breeding stock: hides and leather, and more of both from every job.' },
    ],
    effect: (l, b) => ({
      fame: 0.005 * l,
      yield: { hide: 0.02 * l + (b === 'stud' ? 0.04 * past(l, 5) : 0), leather: b === 'stud' ? 0.03 * past(l, 5) : 0 },
      coinJobs: b === 'racing' ? 0.04 * past(l, 5) : 0,
    }),
  },
]
export const building = (id: BuildingId) => BUILDINGS.find((b) => b.id === id)!

/** Natural sites fork too, at level 6. */
export const SITE_BRANCHES: Record<SiteId, Branch[]> = {
  woodland: [
    { id: 'forester', name: 'Foresters', text: 'Managed woods: more timber from every job.' },
    { id: 'collier', name: 'Colliers', text: 'Charcoal burners in the woods: more charcoal.' },
  ],
  pastures: [
    { id: 'shepherd', name: 'Shepherds', text: 'A bigger flock: more wool.' },
    { id: 'huntsman', name: 'Huntsmen', text: 'Hounds and hunters: more hides.' },
  ],
  mine: [
    { id: 'deep', name: 'Deep galleries', text: 'Deeper shafts: more iron and star metal.' },
    { id: 'open', name: 'Open cast', text: 'Strip the hillside: more copper, tin and stone.' },
  ],
  river: [
    { id: 'prospector', name: 'Prospectors', text: 'More gold and gems from the gravel.' },
    { id: 'clayworks', name: 'Clay works', text: 'Dig the banks: much more clay.' },
  ],
  workshop: [
    { id: 'weaponsmith', name: 'Weaponsmith', text: 'Weapons are forged faster.' },
    { id: 'armourer', name: 'Armourer', text: 'Armour, shields and capes are made faster.' },
  ],
}
export const SITE_BRANCH_AT = 6
function siteEffect(s: SiteId, level: number, branch?: string): Part {
  const n = past(level, SITE_BRANCH_AT)
  if (!branch || !n) return {}
  const y: Record<string, Bonus['yield']> = {
    forester: { timber: 0.05 * n },
    collier: { coal: 0.07 * n },
    shepherd: { wool: 0.06 * n },
    huntsman: { hide: 0.06 * n },
    deep: { iron: 0.05 * n, starmetal: 0.06 * n },
    open: { copper: 0.05 * n, tin: 0.05 * n, stone: 0.08 * n },
    prospector: { gold: 0.05 * n, gems: 0.05 * n },
    clayworks: { clay: 0.08 * n },
  }
  if (s === 'workshop') return branch === 'weaponsmith' ? { craftWeapon: 0.04 * n } : { craftArmour: 0.04 * n }
  return { yield: y[branch] ?? {} }
}

// --- Jobs ----------------------------------------------------------------------------------------

/** A job at a site (`at` a site id) or a building (`at` a building id; `level` is then its level). */
export type JobDef = { id: string; at: SiteId | BuildingId; name: string; hours: number; level: number; gives: Partial<Record<ResId, [number, number]>>; costs?: Bag; coins?: number; branch?: string }

export const JOBS: JobDef[] = [
  { id: 'deadwood', at: 'woodland', name: 'Gather deadwood', hours: 1, level: 1, gives: { timber: [3, 5] } },
  { id: 'oaks', at: 'woodland', name: 'Fell old oaks', hours: 3, level: 2, gives: { timber: [9, 13] } },
  { id: 'charcoal', at: 'woodland', name: 'Burn charcoal', hours: 4, level: 3, gives: { coal: [6, 9] }, costs: { timber: 4 } },
  { id: 'grove', at: 'woodland', name: 'Clear the old grove', hours: 6, level: 5, gives: { timber: [18, 24], coal: [3, 5] } },
  { id: 'oldgrowth', at: 'woodland', name: 'Fell the old growth', hours: 7, level: 6, gives: { timber: [30, 40] } },
  { id: 'coppice', at: 'woodland', name: 'Burn the coppice', hours: 6, level: 8, gives: { coal: [14, 20] }, costs: { timber: 6 } },
  { id: 'royaloaks', at: 'woodland', name: 'The royal oaks', hours: 9, level: 10, gives: { timber: [50, 64], coal: [6, 9] } },
  { id: 'hunt', at: 'pastures', name: 'Hunt deer', hours: 1.5, level: 1, gives: { hide: [2, 4] } },
  { id: 'shear', at: 'pastures', name: 'Shear the flock', hours: 2, level: 2, gives: { wool: [4, 7] } },
  { id: 'boar', at: 'pastures', name: 'Boar hunt', hours: 4, level: 3, gives: { hide: [6, 10] } },
  { id: 'drive', at: 'pastures', name: 'Great drive', hours: 6, level: 5, gives: { wool: [12, 16], hide: [3, 5] } },
  { id: 'hillflock', at: 'pastures', name: 'Graze the hill flock', hours: 6, level: 6, gives: { wool: [18, 24], hide: [4, 6] } },
  { id: 'aurochs', at: 'pastures', name: 'Aurochs hunt', hours: 7, level: 8, gives: { hide: [18, 26] } },
  { id: 'fair', at: 'pastures', name: 'The summer fair', hours: 9, level: 10, gives: { wool: [26, 34], hide: [12, 16] } },
  { id: 'stone', at: 'mine', name: 'Break stone', hours: 1, level: 1, gives: { stone: [5, 8] } },
  { id: 'surface', at: 'mine', name: 'Surface copper', hours: 2, level: 1, gives: { copper: [3, 5], tin: [1, 3] } },
  { id: 'rubble', at: 'mine', name: 'Clear the spoil heaps', hours: 3, level: 2, gives: { stone: [14, 20], copper: [1, 2] } },
  { id: 'tinseam', at: 'mine', name: 'Work the tin seam', hours: 3, level: 2, gives: { tin: [4, 6], copper: [2, 3] } },
  { id: 'iron', at: 'mine', name: 'Iron seam', hours: 4, level: 3, gives: { iron: [5, 8] } },
  { id: 'deep', at: 'mine', name: 'Deep shaft', hours: 6, level: 4, gives: { iron: [9, 13], coal: [2, 4] } },
  { id: 'starfall', at: 'mine', name: 'Starfall vein', hours: 8, level: 5, gives: { starmetal: [1, 2], iron: [3, 5] } },
  { id: 'lode', at: 'mine', name: 'The copper lode', hours: 6, level: 6, gives: { copper: [14, 20], tin: [6, 9] } },
  { id: 'deepiron', at: 'mine', name: 'Deep iron galleries', hours: 7, level: 8, gives: { iron: [18, 26], coal: [4, 6] } },
  { id: 'starshaft', at: 'mine', name: 'The star shaft', hours: 10, level: 10, gives: { starmetal: [2, 4], iron: [6, 9] } },
  { id: 'clay', at: 'river', name: 'Dig clay', hours: 1, level: 1, gives: { clay: [5, 8] } },
  { id: 'pan', at: 'river', name: 'Pan for gold', hours: 3, level: 1, gives: { gold: [1, 3] } },
  { id: 'claybank', at: 'river', name: 'Cut the clay banks', hours: 3, level: 2, gives: { clay: [14, 20] } },
  { id: 'sluice', at: 'river', name: 'Run the sluice', hours: 5, level: 2, gives: { gold: [3, 5] } },
  { id: 'gravel', at: 'river', name: 'Dig the gem gravel', hours: 6, level: 3, gives: { gems: [1, 2] } },
  { id: 'gempit', at: 'river', name: 'Old gem pit', hours: 8, level: 4, gives: { gems: [2, 4], gold: [1, 2] } },
  { id: 'dredge', at: 'river', name: 'Dredge the bend', hours: 6, level: 6, gives: { gold: [6, 9] } },
  { id: 'shoals', at: 'river', name: 'The gem shoals', hours: 8, level: 8, gives: { gems: [4, 6] } },
  { id: 'hoard', at: 'river', name: 'The drowned hoard', hours: 10, level: 10, gives: { gold: [8, 12], gems: [3, 5] } },

  { id: 'saw', at: 'sawmill', name: 'Saw planks', hours: 1.5, level: 1, gives: { planks: [3, 4] }, costs: { timber: 6 } },
  { id: 'beams', at: 'sawmill', name: 'Square oak beams', hours: 4, level: 3, gives: { planks: [9, 11] }, costs: { timber: 16 } },
  { id: 'carts', at: 'sawmill', name: 'Build carts to sell', hours: 5, level: 6, gives: {}, costs: { planks: 10 }, coins: 320, branch: 'joiner' },
  { id: 'raft', at: 'sawmill', name: 'Raft logs downriver', hours: 6, level: 7, gives: { planks: [16, 20] }, costs: { timber: 24 }, branch: 'lumber' },
  { id: 'bricks', at: 'kiln', name: 'Fire bricks', hours: 2, level: 1, gives: { bricks: [3, 4] }, costs: { clay: 6, coal: 1 } },
  { id: 'kilncoal', at: 'kiln', name: 'Char timber', hours: 3, level: 2, gives: { coal: [5, 7] }, costs: { timber: 5 } },
  { id: 'brickstack', at: 'kiln', name: 'Fire a full stack', hours: 5, level: 4, gives: { bricks: [9, 11] }, costs: { clay: 16, coal: 3 } },
  { id: 'amphorae', at: 'kiln', name: 'Throw amphorae', hours: 4, level: 5, gives: {}, costs: { clay: 10 }, coins: 150, branch: 'potter' },
  { id: 'charpit', at: 'kiln', name: 'The great charcoal pit', hours: 6, level: 6, gives: { coal: [16, 20] }, costs: { timber: 12 }, branch: 'charburner' },
  { id: 'cut', at: 'quarry', name: 'Cut stone', hours: 2, level: 1, gives: { stone: [8, 12] } },
  { id: 'slabs', at: 'quarry', name: 'Split slabs', hours: 4, level: 3, gives: { stone: [20, 26] } },
  { id: 'dress', at: 'quarry', name: 'Dress stone for the city', hours: 5, level: 6, gives: {}, costs: { stone: 24 }, coins: 170, branch: 'mason' },
  { id: 'face', at: 'quarry', name: 'Open a new face', hours: 7, level: 7, gives: { stone: [55, 70] }, branch: 'deep' },
  { id: 'dig', at: 'claypit', name: 'Dig the pit', hours: 1.5, level: 1, gives: { clay: [8, 12] } },
  { id: 'puddle', at: 'claypit', name: 'Puddle the clay beds', hours: 4, level: 4, gives: { clay: [22, 28] } },
  { id: 'wash', at: 'claypit', name: 'Wash the spoil', hours: 5, level: 6, gives: { gold: [2, 3], gems: [0, 1] }, costs: { stone: 6 }, branch: 'gravel' },
  { id: 'marl', at: 'claypit', name: 'The deep marl', hours: 7, level: 7, gives: { clay: [50, 64] }, branch: 'beds' },
  { id: 'tan', at: 'tannery', name: 'Tan hides', hours: 3, level: 1, gives: { leather: [3, 4] }, costs: { hide: 6 } },
  { id: 'cure', at: 'tannery', name: 'Cure in bulk', hours: 6, level: 4, gives: { leather: [8, 10] }, costs: { hide: 14 } },
  { id: 'saddles', at: 'tannery', name: 'Make saddles', hours: 5, level: 6, gives: {}, costs: { leather: 6 }, coins: 240, branch: 'saddler' },
  { id: 'weave', at: 'weaver', name: 'Weave cloth', hours: 3, level: 1, gives: { cloth: [3, 4] }, costs: { wool: 6 } },
  { id: 'bolts', at: 'weaver', name: 'Weave whole bolts', hours: 6, level: 4, gives: { cloth: [8, 10] }, costs: { wool: 14 } },
  { id: 'purple', at: 'weaver', name: 'Dye senatorial purple', hours: 6, level: 6, gives: {}, costs: { cloth: 6 }, coins: 300, branch: 'dyer' },
  { id: 'bog', at: 'smelter', name: 'Smelt bog ore', hours: 3, level: 1, gives: { iron: [3, 5] }, costs: { stone: 8, coal: 2 } },
  { id: 'roast', at: 'smelter', name: 'Roast copper ore', hours: 4, level: 3, gives: { copper: [5, 7], tin: [2, 3] }, costs: { stone: 10, coal: 3 } },
  { id: 'bells', at: 'smelter', name: 'Cast bronze bells', hours: 5, level: 6, gives: {}, costs: { copper: 8, tin: 4 }, coins: 260, branch: 'foundry' },
  { id: 'blast', at: 'smelter', name: 'Run the blast furnace', hours: 6, level: 7, gives: { iron: [14, 18] }, costs: { stone: 20, coal: 8 }, branch: 'blast' },
  { id: 'gild', at: 'goldsmith', name: 'Gild trinkets', hours: 4, level: 1, gives: {}, costs: { gold: 2, copper: 3 }, coins: 110 },
  { id: 'rings', at: 'goldsmith', name: 'Set rings', hours: 5, level: 3, gives: {}, costs: { gold: 3, gems: 1 }, coins: 260 },
  { id: 'cutgems', at: 'goldsmith', name: 'Cut river stones', hours: 6, level: 6, gives: { gems: [1, 2] }, costs: { stone: 14 }, branch: 'lapidary' },
  { id: 'diadem', at: 'goldsmith', name: 'A diadem for the court', hours: 8, level: 7, gives: {}, costs: { gold: 6, gems: 3 }, coins: 720, branch: 'jeweller' },
  { id: 'grain', at: 'granary', name: 'Sell the surplus', hours: 5, level: 1, gives: {}, coins: 60 },
  { id: 'convoy', at: 'tradepost', name: 'Send a convoy', hours: 8, level: 6, gives: {}, costs: { cloth: 4, leather: 4 }, coins: 420, branch: 'caravan' },
  { id: 'harvest', at: 'vineyard', name: 'Harvest the grapes', hours: 6, level: 1, gives: {}, coins: 90 },
  { id: 'oil', at: 'vineyard', name: 'Press the olives', hours: 6, level: 6, gives: {}, coins: 150, branch: 'olives' },
  { id: 'vintage', at: 'vineyard', name: 'Lay down a vintage', hours: 8, level: 6, gives: {}, costs: { clay: 4 }, coins: 320, branch: 'winery' },
  { id: 'race', at: 'stables', name: 'Race at the circus', hours: 6, level: 2, gives: {}, coins: 160 },
  { id: 'breed', at: 'stables', name: 'Breed the herd', hours: 8, level: 6, gives: { hide: [10, 14], leather: [2, 3] }, branch: 'stud' },
  { id: 'grandrace', at: 'stables', name: 'The grand race', hours: 8, level: 7, gives: {}, coins: 480, branch: 'racing' },
]
export const jobDef = (id: string) => JOBS.find((j) => j.id === id)
const isSite = (k: string): k is SiteId => SITES.some((s) => s.id === k)

// --- Levels --------------------------------------------------------------------------------------

export const MAX_SITE_LEVEL = 10
export const MAX_WORKSHOP_LEVEL = 12
export const maxSiteLevel = (s: SiteId) => (s === 'workshop' ? MAX_WORKSHOP_LEVEL : MAX_SITE_LEVEL)
// Cost to raise a site to each level (index = the new level).
const UPGRADES: Cost[] = [
  { coins: 0 },
  { coins: 0 },
  { coins: 120, timber: 8 },
  { coins: 350, timber: 16, copper: 8 },
  { coins: 900, timber: 24, iron: 16 },
  { coins: 2200, timber: 30, iron: 30, gold: 8, gems: 3 },
  { coins: 3000, timber: 40, stone: 40, planks: 20, bricks: 20 },
  { coins: 4500, stone: 60, planks: 35, bricks: 35, iron: 20 },
  { coins: 6500, stone: 90, planks: 50, bricks: 50, gold: 10 },
  { coins: 9500, stone: 120, planks: 70, bricks: 75, gold: 16, gems: 4 },
  { coins: 14000, stone: 160, planks: 100, bricks: 100, gems: 8, starmetal: 2 },
  { coins: 19000, stone: 200, planks: 130, bricks: 130, gems: 12, starmetal: 3 },
  { coins: 26000, stone: 250, planks: 170, bricks: 170, gems: 16, starmetal: 5 },
]
const SITE_HOURS = [0, 0, 0.1, 0.25, 0.5, 1, 2, 3, 4, 6, 8, 10, 12]
/** What raising a site from `level` costs, before any discount. */
export const upgradeCost = (level: number) => UPGRADES[level + 1]

/** How many jobs (or forgings, for the workshop) a site runs at once at a level. */
export const slotsAt = (level: number) => (level >= 11 ? 5 : level >= 8 ? 4 : level >= 5 ? 3 : level >= 3 ? 2 : 1)
// Past level 5 a site still improves, but by less each level.
export const yieldAt = (level: number) => (level <= 5 ? 1 + 0.15 * (level - 1) : 1.6 + 0.1 * (level - 5))
export const speedAt = (level: number) => (level <= 5 ? 1 - 0.08 * (level - 1) : 0.68 - 0.03 * (level - 5))
// Buildings' own jobs: more and quicker each level, gently.
export const bSlotsAt = (level: number) => (level >= 8 ? 3 : level >= 4 ? 2 : 1)
export const bYieldAt = (level: number) => 1 + 0.1 * (level - 1)
export const bSpeedAt = (level: number) => 1 - 0.035 * (level - 1)

/** Estate rank needed to raise anything to `level`. */
export const rankFor = (level: number) => Math.max(1, Math.min(10, level - 2))

export const RANKS = [
  { at: 0, name: 'Smallholding' },
  { at: 8, name: 'Farmstead' },
  { at: 14, name: 'Holding' },
  { at: 22, name: 'Manor' },
  { at: 32, name: 'Villa rustica' },
  { at: 44, name: 'Estate' },
  { at: 58, name: 'Great estate' },
  { at: 74, name: 'Domain' },
  { at: 92, name: 'Latifundium' },
  { at: 115, name: "A senator's domain" },
]

// --- State ---------------------------------------------------------------------------------------

export type Job = { id: string; site: string; job: string; start: number; end: number; gives: Bag; coins?: number }
export type Craft = { id: string; item: string; start: number; end: number }
/** A plot: cleared or not, and what stands on it. */
export type Plot = { cleared: boolean; building?: BuildingId; level: number; branch?: string }
/** Construction under way: clearing a plot, putting up a building, or raising a site or building. */
export type Work = { id: string; target: string; kind: 'clear' | 'build' | 'upgrade'; to: number; building?: BuildingId; branch?: string; start: number; end: number }

export type Estate = {
  /** Site levels. */
  levels: Record<SiteId, number>
  /** Running jobs. `site` is a site id, or the id of the plot whose building runs the job. */
  jobs: Job[]
  crafting: Craft[]
  res: Bag
  /** Item ids whose blueprint is owned. Plain-material (tier 0) blueprints are always known. */
  blueprints: string[]
  market: { day: string; bought: Bag }
  plots: Record<string, Plot>
  works: Work[]
  /** Sites' chosen specialisations. */
  branches: Partial<Record<SiteId, string>>
  /** When rents were last collected. */
  rents: number
}

function freshPlots(): Record<string, Plot> {
  const out: Record<string, Plot> = {}
  for (const p of PLOTS) out[p.id] = p.id === 'villa' ? { cleared: true, building: 'villa', level: 1 } : { cleared: p.rank === 0, level: 0 }
  return out
}

export function newEstate(now = Date.now()): Estate {
  return {
    levels: { woodland: 1, pastures: 1, mine: 1, river: 1, workshop: 1 },
    jobs: [],
    crafting: [],
    res: { timber: 4, hide: 6 },
    blueprints: [],
    market: { day: '', bought: {} },
    plots: freshPlots(),
    works: [],
    branches: {},
    rents: now,
  }
}

/**
 * Brings an estate from an older save up to date: the map, plots and building works arrived later,
 * so they're added empty (a fresh villa, the open plots cleared). Nothing that was there is lost.
 */
export function fixEstate(e: Estate, now = Date.now()): Estate {
  if (e.plots && e.works && e.branches && typeof e.rents === 'number') return e
  const plots = { ...freshPlots(), ...(e.plots ?? {}) }
  return { ...e, plots, works: e.works ?? [], branches: e.branches ?? {}, rents: typeof e.rents === 'number' ? e.rents : now, jobs: e.jobs ?? [], crafting: e.crafting ?? [], res: e.res ?? {}, blueprints: e.blueprints ?? [], market: e.market ?? { day: '', bought: {} } }
}

export const have = (e: Estate, bag: Bag) => (Object.keys(bag) as ResId[]).every((k) => (e.res[k] ?? 0) >= (bag[k] ?? 0))
export function addBag(a: Bag, b: Bag, sign = 1): Bag {
  const out = { ...a }
  for (const k of Object.keys(b) as ResId[]) out[k] = Math.max(0, (out[k] ?? 0) + sign * (b[k] ?? 0))
  return out
}

// --- Construction --------------------------------------------------------------------------------

/** The estate as it stands at `now`: brought up to date and with finished construction applied. */
export const live = (e: Estate, now = Date.now()) => finishWorks(fixEstate(e, now), now)

/** Applies every finished construction. Pure: the estate as it stands at `now`. */
export function finishWorks(e: Estate, now = Date.now()): Estate {
  const done = e.works.filter((w) => w.end <= now)
  if (!done.length) return e
  let levels = e.levels
  let branches = e.branches
  const plots = { ...e.plots }
  for (const w of done.sort((a, b) => a.end - b.end)) {
    if (isSite(w.target)) {
      levels = { ...levels, [w.target]: Math.max(levels[w.target], w.to) }
      if (w.branch) branches = { ...branches, [w.target]: w.branch }
    } else {
      const p = plots[w.target] ?? { cleared: false, level: 0 }
      if (w.kind === 'clear') plots[w.target] = { ...p, cleared: true }
      else if (w.kind === 'build') plots[w.target] = { cleared: true, building: w.building, level: 1, branch: w.branch }
      else plots[w.target] = { ...p, level: Math.max(p.level, w.to), branch: w.branch ?? p.branch }
    }
  }
  return { ...e, levels, branches, plots, works: e.works.filter((w) => w.end > now) }
}

/** Where a building stands, if it's built. */
export const plotOf = (e: Estate, b: BuildingId) => Object.keys(e.plots).find((k) => e.plots[k].building === b)

/** Everything the estate adds up to, capped where it touches the arena. */
export function bonuses(e: Estate): Bonus {
  const out: Bonus = { ...ZERO, yield: {} }
  const add = (p: Part) => {
    for (const [k, v] of Object.entries(p) as [keyof Bonus, unknown][]) {
      if (k === 'yield') for (const [r, n] of Object.entries(v as Bonus['yield'])) out.yield[r as ResId] = (out.yield[r as ResId] ?? 0) + (n ?? 0)
      else (out[k] as number) += (v as number) ?? 0
    }
  }
  for (const p of Object.values(e.plots ?? {})) if (p.building && p.level > 0) add(building(p.building).effect(p.level, p.branch))
  for (const s of SITES) add(siteEffect(s.id, e.levels[s.id], e.branches?.[s.id]))
  for (const [k, cap] of Object.entries(CAPS) as [keyof Bonus, number][]) (out[k] as number) = Math.min(cap, out[k] as number)
  return out
}

/** Every level built, summed: the estate's standing. */
export function rankOf(e: Estate) {
  let points = 0
  for (const s of SITES) points += e.levels[s.id]
  for (const p of Object.values(e.plots ?? {})) if (p.building) points += p.level
  let i = 0
  while (i + 1 < RANKS.length && points >= RANKS[i + 1].at) i++
  const next = RANKS[i + 1]
  return { rank: i + 1, name: RANKS[i].name, points, from: RANKS[i].at, next: next?.at ?? null, nextName: next?.name ?? null }
}

export const builders = (e: Estate) => 1 + bonuses(e).builders

const nice = (n: number) => (n >= 200 ? Math.round(n / 10) * 10 : n >= 40 ? Math.round(n / 5) * 5 : Math.round(n))
function discounted(c: Cost, off: number): Cost {
  const out: Cost = { coins: c.coins }
  for (const [k, v] of Object.entries(c) as [ResId | 'coins', number][]) if (k !== 'coins' && v > 0) out[k] = Math.max(1, nice(v * (1 - off)))
  return out
}

/** A building's price to reach `level`, before discounts: everything grows each level. */
export function buildingCost(d: BuildingDef, level: number): Cost {
  const g = Math.pow(1.38, level - 1)
  const out: Cost = { coins: nice(d.cost.coins * Math.pow(1.45, level - 1)) }
  for (const [k, v] of Object.entries(d.cost) as [ResId | 'coins', number][]) if (k !== 'coins') out[k] = nice(v * g)
  if (level >= 5) for (const [k, v] of Object.entries(d.late) as [ResId, number][]) out[k] = (out[k] ?? 0) + nice(v * Math.pow(1.38, level - 5))
  return out
}
export const buildingHours = (level: number) => 0.15 * Math.pow(1.45, level - 1)

export type Plan = { target: string; kind: Work['kind']; to: number; building?: BuildingId; branch?: string; cost: Cost; ms: number; rank: number; why: string | null; needsBranch: Branch[] | null }

/**
 * What a piece of construction would take, and why it can't start yet (`why`). For a level that
 * forks, `needsBranch` lists the choices and `branch` must be one of them.
 */
export function plan(e: Estate, target: string, kind: Work['kind'], coins: number, opts: { building?: BuildingId; branch?: string } = {}): Plan {
  const b = bonuses(e)
  const { rank } = rankOf(e)
  let cost: Cost
  let hours: number
  let to = 1
  let need = 1
  let forks: Branch[] | null = null
  let max = 0
  let current = 0
  if (isSite(target)) {
    current = e.levels[target]
    to = current + 1
    max = maxSiteLevel(target)
    cost = UPGRADES[Math.min(to, UPGRADES.length - 1)]
    hours = SITE_HOURS[Math.min(to, SITE_HOURS.length - 1)]
    need = to <= 5 ? 1 : rankFor(to)
    if (to === SITE_BRANCH_AT) forks = SITE_BRANCHES[target]
  } else {
    const p = e.plots[target]
    const def = plotDef(target)
    if (kind === 'clear') {
      const c = def ? CLEAR[def.rank] : CLEAR[1]
      const { hours: h, ...rest } = c
      cost = rest
      hours = h
      need = def?.rank ?? 1
      to = 0
      max = 1
    } else {
      const id = kind === 'build' ? opts.building : p?.building
      const d = id ? building(id) : null
      if (!d) return { target, kind, to: 0, cost: { coins: 0 }, ms: 0, rank: 0, why: 'Nothing to build', needsBranch: null }
      current = kind === 'build' ? 0 : p.level
      to = current + 1
      max = d.max
      cost = buildingCost(d, to)
      hours = buildingHours(to)
      need = Math.max(kind === 'build' ? d.rank : 1, rankFor(to))
      if (d.branchAt === to) forks = d.branches ?? null
    }
  }
  cost = discounted(cost, b.buildCost)
  const { coins: price, ...materials } = cost
  const ms = hours * 3600_000 * (1 - b.buildSpeed)
  const busy = e.works.length >= 1 + b.builders
  const inWork = e.works.some((w) => w.target === target)
  // The screens only offer what fits, but the rules hold here too: build on a cleared, empty plot,
  // and clear only what's still overgrown.
  const plot = isSite(target) ? null : e.plots[target]
  const notFree = kind === 'build' && (!plot?.cleared || !!plot.building)
  const clearedAlready = kind === 'clear' && !!plot?.cleared
  // Each building stands once, on a plot of a kind it suits.
  const taken = kind === 'build' && !!opts.building && (!!plotOf(e, opts.building) || e.works.some((w) => w.kind === 'build' && w.building === opts.building))
  const misfit = kind === 'build' && !!opts.building && !building(opts.building).terrain.includes(plotDef(target)?.terrain ?? 'field')
  const why =
    inWork ? 'Already under construction'
    : notFree ? 'This plot is not free'
    : clearedAlready ? 'Already cleared'
    : taken ? 'Already built elsewhere'
    : misfit ? 'Not on this kind of ground'
    : kind !== 'clear' && current >= max ? 'Fully built'
    : rank < need ? `Needs estate rank ${need}`
    : forks && !forks.some((f) => f.id === opts.branch) ? 'Choose a specialisation'
    : busy ? 'Every builder is busy'
    : coins < price ? 'Not enough coins'
    : !have(e, materials) ? 'Not enough materials'
    : null
  return { target, kind, to, building: opts.building, branch: forks ? opts.branch : undefined, cost, ms, rank: need, why, needsBranch: forks }
}

export function startWork(e: Estate, p: Plan, coins: number, now = Date.now()): { estate: Estate; coins: number } | null {
  if (p.why) return null
  const { coins: price, ...bag } = p.cost
  const w: Work = { id: `${p.target}-${now}`, target: p.target, kind: p.kind, to: p.to, building: p.building, branch: p.branch, start: now, end: now + p.ms }
  return { estate: { ...e, works: [...e.works, w], res: addBag(e.res, bag, -1) }, coins: coins - price }
}

/** Tears a building down to an empty plot. Nothing comes back; its jobs must be finished first. */
export function demolish(e: Estate, plot: string): Estate | null {
  const p = e.plots[plot]
  if (!p?.building || p.building === 'villa' || e.jobs.some((j) => j.site === plot) || e.works.some((w) => w.target === plot)) return null
  return { ...e, plots: { ...e.plots, [plot]: { cleared: true, level: 0 } } }
}

// --- Jobs ----------------------------------------------------------------------------------------

/** The place (site id or plot id) a job runs at, if it can run at all. */
export function placeOf(e: Estate, d: JobDef) {
  return isSite(d.at) ? d.at : plotOf(e, d.at as BuildingId)
}
export const placeLevel = (e: Estate, place: string) => (isSite(place) ? e.levels[place] : (e.plots[place]?.level ?? 0))
export const ownSlots = (e: Estate, place: string) => (isSite(place) ? slotsAt(e.levels[place]) : e.plots[place]?.building ? bSlotsAt(e.plots[place].level) : 0)
export const jobsAt = (e: Estate, place: string) => e.jobs.filter((j) => j.site === place)

/** Spare crews: how many there are, and how many are out working past a place's own crews. */
export function crews(e: Estate) {
  const spare = bonuses(e).crews
  const places = new Set(e.jobs.map((j) => j.site))
  let used = 0
  for (const p of places) used += Math.max(0, jobsAt(e, p).length - ownSlots(e, p))
  return { spare, used, free: Math.max(0, spare - used) }
}

/** Whether a place can take another job: its own crew, or a spare one. */
export const hasCrew = (e: Estate, place: string) => jobsAt(e, place).length < ownSlots(e, place) || crews(e).free > 0

/** A job's yield range, coins and time where it would run now, with every bonus applied. */
export function jobPreview(e: Estate, d: JobDef, b = bonuses(e)) {
  const place = placeOf(e, d)
  const level = place ? placeLevel(e, place) : 0
  const site = isSite(d.at)
  const yl = site ? yieldAt(level) : bYieldAt(level)
  const sp = (site ? speedAt(level) : bSpeedAt(level)) * (1 - b.jobSpeed)
  const gives: Partial<Record<ResId, [number, number]>> = {}
  for (const [k, [lo, hi]] of Object.entries(d.gives) as [ResId, [number, number]][]) {
    const m = yl * (1 + (b.yield[k] ?? 0) + (b.yield.all ?? 0))
    gives[k] = [Math.round(lo * m), Math.round(hi * m)]
  }
  const coins = d.coins ? Math.round(d.coins * yl * (1 + b.coinJobs)) : 0
  return { place, level, gives, coins, ms: d.hours * 3600_000 * sp }
}

/** Why a job can't start, or null if it can. */
export function jobBlock(e: Estate, d: JobDef): string | null {
  const place = placeOf(e, d)
  if (!place) return 'Not built'
  const level = placeLevel(e, place)
  if (level < d.level) return `Needs level ${d.level}`
  if (d.branch && (isSite(d.at) ? e.branches[d.at as SiteId] : e.plots[place].branch) !== d.branch) return 'Another specialisation'
  if (!hasCrew(e, place)) return 'Every crew is busy'
  if (d.costs && !have(e, d.costs)) return 'Not enough materials'
  return null
}

/** Starts a job. The yield is rolled now, so what you'll get is shown up front. */
export function startJob(e: Estate, id: string, now = Date.now()): Estate {
  const d = jobDef(id)
  if (!d || jobBlock(e, d)) return e
  const p = jobPreview(e, d)
  const gives: Bag = {}
  for (const [k, [lo, hi]] of Object.entries(p.gives) as [ResId, [number, number]][]) {
    const n = Math.round(lo + Math.random() * (hi - lo))
    if (n > 0) gives[k] = n
  }
  const job: Job = { id: `${id}-${now}`, site: p.place!, job: id, start: now, end: now + p.ms, gives, ...(p.coins ? { coins: p.coins } : {}) }
  return { ...e, jobs: [...e.jobs, job], res: d.costs ? addBag(e.res, d.costs, -1) : e.res }
}

/** Brings in every finished job; returns what came in, coins included. */
export function collectJobs(e: Estate, now = Date.now()): { estate: Estate; got: Bag; coins: number } {
  const done = e.jobs.filter((j) => j.end <= now)
  if (!done.length) return { estate: e, got: {}, coins: 0 }
  const got = done.reduce<Bag>((a, j) => addBag(a, j.gives), {})
  const coins = done.reduce((a, j) => a + (j.coins ?? 0), 0)
  return { estate: { ...e, jobs: e.jobs.filter((j) => j.end > now), res: addBag(e.res, got) }, got, coins }
}

// --- Rents ---------------------------------------------------------------------------------------

/** Rents waiting: coins an hour since the last collection, up to the strongbox's hours. */
export function pendingRents(e: Estate, now = Date.now()) {
  const b = bonuses(e)
  const hours = Math.min(b.incomeCap, Math.max(0, (now - (e.rents ?? now)) / 3600_000))
  return { coins: Math.floor(hours * b.income), rate: b.income, cap: b.incomeCap, full: hours >= b.incomeCap }
}
export function collectRents(e: Estate, now = Date.now()): { estate: Estate; coins: number } {
  return { estate: { ...e, rents: now }, coins: pendingRents(e, now).coins }
}

// --- Describing bonuses -----------------------------------------------------------------------------

const pct = (n: number) => `${+(n * 100).toFixed(1)}%`
/** Plain lines for what a building (or a difference between two levels) does. */
export function describe(p: Part): string[] {
  const out: string[] = []
  const n = (k: keyof Bonus) => (p[k] as number | undefined) ?? 0
  if (n('crews')) out.push(`+${n('crews')} spare ${n('crews') === 1 ? 'crew' : 'crews'}`)
  if (n('builders')) out.push(`+${n('builders')} ${n('builders') === 1 ? 'builder' : 'builders'}`)
  if (n('income')) out.push(`${n('income')} coins an hour in rents`)
  if (n('incomeCap')) out.push(`Rents pile up ${n('incomeCap')} hours longer`)
  if (n('jobSpeed')) out.push(`Every job ${pct(n('jobSpeed'))} faster`)
  for (const [k, v] of Object.entries(p.yield ?? {}) as [ResId | 'all', number][]) if (v) out.push(k === 'all' ? `+${pct(v)} from every job` : `+${pct(v)} ${resource(k).name.toLowerCase()}`)
  if (n('coinJobs')) out.push(`Coin jobs pay ${pct(n('coinJobs'))} more`)
  if (n('sell')) out.push(`Market pays ${pct(n('sell'))} more of the going rate`)
  if (n('buy')) out.push(`${pct(n('buy'))} off market prices`)
  if (n('stock')) out.push(`${pct(n('stock'))} bigger market lots`)
  if (n('buildCost')) out.push(`Construction needs ${pct(n('buildCost'))} less material`)
  if (n('buildSpeed')) out.push(`Construction ${pct(n('buildSpeed'))} faster`)
  if (n('craftWeapon') && n('craftWeapon') === n('craftArmour')) out.push(`All forging ${pct(n('craftWeapon'))} faster`)
  else {
    if (n('craftWeapon')) out.push(`Weapons forged ${pct(n('craftWeapon'))} faster`)
    if (n('craftArmour')) out.push(`Armour made ${pct(n('craftArmour'))} faster`)
  }
  if (n('salvage')) out.push(`+${pct(n('salvage'))} back from old gear`)
  if (n('xp')) out.push(`+${pct(n('xp'))} experience from fights`)
  if (n('purse')) out.push(`+${pct(n('purse'))} prize money`)
  if (n('fame')) out.push(`+${pct(n('fame'))} fame from wins`)
  if (n('surgeon')) out.push(`Surgeon heals ${pct(n('surgeon'))} more between rounds`)
  if (n('train')) out.push(`Training ${pct(n('train'))} cheaper`)
  if (n('respec')) out.push(`Retraining ${pct(n('respec'))} cheaper`)
  return out
}
/** The difference between two sets of bonuses, for "what the next level brings". */
export function partDiff(a: Part, b: Part): Part {
  const out: Part = { yield: {} }
  for (const k of Object.keys(b) as (keyof Bonus)[]) {
    if (k === 'yield') {
      for (const [r, v] of Object.entries(b.yield ?? {}) as [ResId, number][]) {
        const dv = v - (a.yield?.[r] ?? 0)
        if (Math.abs(dv) > 1e-9) out.yield![r] = dv
      }
    } else {
      const dv = ((b[k] as number) ?? 0) - ((a[k] as number) ?? 0)
      if (Math.abs(dv) > 1e-9) (out[k] as number) = dv
    }
  }
  return out
}
/** What going from one level (and fork) to another changes. */
export const effectDiff = (d: BuildingDef, from: number, to: number, branch?: string, toBranch?: string) => partDiff(from > 0 ? d.effect(from, branch) : {}, d.effect(to, toBranch ?? branch))
export const siteEffectOf = siteEffect

// --- Recipes, blueprints and crafting ------------------------------------------------------------

// Materials for a full-size piece (a cuirass) of each tier; other slots need a share of it.
const TIER_RECIPE: Bag[] = [
  { hide: 3 },
  { hide: 4, copper: 1 },
  { copper: 4, tin: 2 },
  { copper: 5, tin: 3, hide: 1 },
  { iron: 5, coal: 2 },
  { iron: 7, coal: 3 },
  { iron: 8, coal: 6 },
  { iron: 10, coal: 8 },
  { iron: 7, coal: 6, gold: 3 },
  { iron: 8, coal: 7, gold: 5 },
  { iron: 9, coal: 8, gold: 6, gems: 2 },
  { iron: 11, coal: 9, gold: 7, gems: 4 },
  { starmetal: 4, gems: 5, gold: 5 },
]
const SLOT_RECIPE_SHARE: Record<string, number> = { body: 1, head: 0.55, shoulders: 0.4, arms: 0.35, legs: 0.45, feet: 0.35, shield: 0.65, weapon: 0.7 }
const HAFTED: WeaponKind[] = ['spear', 'trident', 'axe', 'mace', 'warhammer', 'staff', 'scepter']
// Hours to forge a full-size piece of each tier: leather is quick, star metal takes the night.
const TIER_HOURS = [0, 0, 0.08, 0.17, 0.33, 0.66, 1, 1.5, 2, 3, 4, 5, 8]

// Materials are the main cost of gear: past the first leathers, every recipe is this much bigger.
const MATERIAL_WEIGHT = 1.7

function scale(bag: Bag, share: number): Bag {
  const out: Bag = {}
  for (const [k, v] of Object.entries(bag) as [ResId, number][]) out[k] = Math.max(1, Math.round(v * share))
  return out
}

/** What an item takes to make. */
export function recipe(it: Item): Bag {
  const t = it.tier
  if (it.slot === 'cape') {
    // Cloth: wool, then gold thread, gems and at the very top, star metal.
    const r: Bag = { wool: 3 + Math.round(t * 1.5) }
    if (t >= 8) r.gold = Math.round((t - 6) * 1.5)
    if (t >= 10) r.gems = t - 8
    if (t >= 12) r.starmetal = 2
    return r
  }
  if (it.weapon) {
    const w = weaponType(it.weapon)
    const base: Bag = t === 0 ? { timber: 3 } : t === 1 ? { timber: 4, copper: 1 } : scale(TIER_RECIPE[t], SLOT_RECIPE_SHARE.weapon * (w.twoHanded ? 1.3 : 1) * MATERIAL_WEIGHT)
    if (t > 1 && HAFTED.includes(it.weapon)) base.timber = (base.timber ?? 0) + 2 + Math.floor(t / 3)
    if (w.spell && t >= 4) base.gems = (base.gems ?? 0) + 1 + Math.floor((t - 4) / 3)
    return base
  }
  const r = scale(TIER_RECIPE[t], (SLOT_RECIPE_SHARE[it.slot] ?? 0.5) * (t >= 2 ? MATERIAL_WEIGHT : 1))
  if (it.slot === 'shield' && t > 0) r.timber = (r.timber ?? 0) + 2
  return r
}

// The blueprint is a one-off; the fee pays the smith each time. Both are small next to materials.
export const blueprintPrice = (it: Item) => (it.tier === 0 ? 0 : Math.round(it.price * 0.3))
export const craftFee = (it: Item) => Math.round(it.price * 0.07)
export const knowsBlueprint = (e: Estate, it: Item) => it.tier === 0 || e.blueprints.includes(it.id)

/** How long forging takes at the current workshop level (and with the estate's help), in ms. */
export function craftTime(estate: Estate, it: Item) {
  const e = live(estate)
  const share = it.slot === 'cape' ? 0.5 : (SLOT_RECIPE_SHARE[it.slot] ?? 0.5)
  const b = bonuses(e)
  const faster = it.weapon ? b.craftWeapon : b.craftArmour
  return TIER_HOURS[it.tier] * Math.max(0.5, share) * 3600_000 * speedAt(e.levels.workshop) * (1 - faster)
}

/** Benches in the workshop now, counting an upgrade that finished while nobody looked at the estate. */
export const benches = (e: Estate) => slotsAt(live(e).levels.workshop)

export function startCraft(estate: Estate, it: Item, now = Date.now()): Estate | null {
  const e = live(estate, now)
  const need = recipe(it)
  if (!knowsBlueprint(e, it) || !have(e, need) || e.crafting.length >= slotsAt(e.levels.workshop)) return null
  const craft: Craft = { id: `${it.id}-${now}`, item: it.id, start: now, end: now + craftTime(e, it) }
  return { ...e, crafting: [...e.crafting, craft], res: addBag(e.res, need, -1) }
}

/** Breaking down a piece you replaced gives back about a third of what it took (more with a storehouse). */
export function salvage(it: Item | null, extra = 0): Bag {
  if (!it) return {}
  const out: Bag = {}
  for (const [k, v] of Object.entries(recipe(it)) as [ResId, number][]) {
    const n = Math.floor(v * (0.35 + extra))
    if (n > 0) out[k] = n
  }
  return out
}

// --- The market ----------------------------------------------------------------------------------

export const today = (now = Date.now()) => new Date(now).toLocaleDateString('sv-SE')

/** A price swing for one material on one day: the same for everyone, all day. */
function swing(day: string, id: ResId) {
  let h = 2166136261
  for (const c of `${day}:${id}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return 0.75 + ((h >>> 0) % 1000) / 1000 * 0.55
}

/** Today's prices. With an estate, its trading post and depot move them in your favour. */
export function marketPrice(id: ResId, difficultyPrices: number, now = Date.now(), e?: Estate) {
  const day = today(now)
  const yesterday = today(now - 86400_000)
  const base = resource(id).price
  const b = e ? bonuses(live(e, now)) : null
  const buy = Math.max(1, Math.round(base * swing(day, id) * difficultyPrices * (1 - (b?.buy ?? 0))))
  // However good the trading post, selling never beats buying back: no buy-low, sell-high loop.
  const sell = Math.max(1, Math.min(buy - 1, Math.round(base * swing(day, id) * (0.5 + (b?.sell ?? 0)))))
  return { buy, sell, trend: swing(day, id) - swing(yesterday, id) }
}

/** How much of a material the market brings each day; a storehouse buys bigger lots. */
export const dailyStock = (e: Estate, id: ResId) => Math.round(resource(id).stock * (1 + bonuses(live(e)).stock))

/** What's left to buy of a material today. */
export function stockLeft(e: Estate, id: ResId, now = Date.now()) {
  const bought = e.market?.day === today(now) ? (e.market.bought[id] ?? 0) : 0
  return Math.max(0, dailyStock(e, id) - bought)
}

export function trade(e: Estate, id: ResId, n: number, coins: number, difficultyPrices: number, now = Date.now()): { estate: Estate; coins: number } | null {
  const p = marketPrice(id, difficultyPrices, now, e)
  const day = today(now)
  const bought = e.market.day === day ? e.market.bought : {}
  if (n > 0) {
    if (n > stockLeft(e, id, now) || coins < p.buy * n) return null
    return { estate: { ...e, res: addBag(e.res, { [id]: n }), market: { day, bought: { ...bought, [id]: (bought[id] ?? 0) + n } } }, coins: coins - p.buy * n }
  }
  const m = -n
  if ((e.res[id] ?? 0) < m) return null
  return { estate: { ...e, res: addBag(e.res, { [id]: m }, -1), market: { day, bought } }, coins: coins + p.sell * m }
}

// --- Saves from before the estate -----------------------------------------------------------------

/** An estate for a gladiator who had none: starter stock scaled to how far they got. */
export function estateFor(level: number, gear: Record<string, string | undefined>): Estate {
  const e = newEstate()
  const owned = Object.values(gear).filter((id): id is string => !!id && !!item(id))
  return {
    ...e,
    blueprints: owned,
    res: { timber: 10 + level, hide: 8, wool: 4, copper: 4 + level, tin: 2 + Math.floor(level / 2), iron: level >= 8 ? level : 0, coal: level >= 8 ? Math.floor(level / 2) : 0 },
  }
}

export const prettyHours = (ms: number) => {
  const m = Math.max(0, Math.ceil(ms / 60000))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}
