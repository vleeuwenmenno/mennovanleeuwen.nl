import { item, weaponType, type Item, type WeaponKind } from './data'

// The estate: where the materials for gear come from. Work sites run jobs on real time (an hour
// to eight), so they keep going while the game is closed and on every device the save syncs to.
// Levelling a site buys more job slots, bigger yields, shorter timers and better jobs. The
// workshop's level sets how many things can be forged at once and how fast.
//
// Gear is no longer bought: a blueprint is, once, and then each piece is crafted from materials
// (from the estate, or the market) plus a smith's fee, taking longer the finer the material.

export type ResId = 'timber' | 'hide' | 'wool' | 'copper' | 'tin' | 'iron' | 'coal' | 'gold' | 'gems' | 'starmetal'
export type SiteId = 'woodland' | 'pastures' | 'mine' | 'river' | 'workshop'
export type Bag = Partial<Record<ResId, number>>

export const RESOURCES: { id: ResId; name: string; glyph: string; price: number; stock: number; text: string }[] = [
  { id: 'timber', name: 'Timber', glyph: '🪵', price: 4, stock: 60, text: 'Hafts, shafts and shield cores.' },
  { id: 'hide', name: 'Hides', glyph: '🟫', price: 6, stock: 40, text: 'Leather for the first armour, straps for the rest.' },
  { id: 'wool', name: 'Wool', glyph: '🧶', price: 5, stock: 40, text: 'Woven into capes.' },
  { id: 'copper', name: 'Copper', glyph: '🟠', price: 7, stock: 40, text: 'With tin, it makes bronze.' },
  { id: 'tin', name: 'Tin', glyph: '⚪', price: 9, stock: 30, text: 'The other half of bronze.' },
  { id: 'iron', name: 'Iron ore', glyph: '⛓️', price: 12, stock: 30, text: 'Iron, and with charcoal, steel.' },
  { id: 'coal', name: 'Charcoal', glyph: '⚫', price: 8, stock: 30, text: 'Fuel for hot forges and steel.' },
  { id: 'gold', name: 'Gold', glyph: '🟡', price: 30, stock: 12, text: 'Gilding and chasing.' },
  { id: 'gems', name: 'Gems', glyph: '💎', price: 45, stock: 6, text: 'Set into imperial gear and casting foci.' },
  { id: 'starmetal', name: 'Star metal', glyph: '☄️', price: 140, stock: 2, text: 'Fallen from the sky. Mythic gear is made of it.' },
]
export const resource = (id: ResId) => RESOURCES.find((r) => r.id === id)!

export type JobDef = { id: string; site: SiteId; name: string; hours: number; level: number; gives: Partial<Record<ResId, [number, number]>>; costs?: Bag }
export const SITES: { id: SiteId; name: string; text: string; glyph: string }[] = [
  { id: 'woodland', name: 'Woodland', text: 'Timber, and charcoal burned from it.', glyph: '🌲' },
  { id: 'pastures', name: 'Pastures', text: 'Hides from the hunt, wool from the flock.', glyph: '🐑' },
  { id: 'mine', name: 'Mine', text: 'Copper, tin, iron, and deep down, star metal.', glyph: '⛏️' },
  { id: 'river', name: 'River', text: 'Gold from the gravel, gems from the old pits.', glyph: '🏞️' },
  { id: 'workshop', name: 'Workshop', text: 'Where your gear is forged. More benches, faster work.', glyph: '🔨' },
]
export const site = (id: SiteId) => SITES.find((s) => s.id === id)!

export const JOBS: JobDef[] = [
  { id: 'deadwood', site: 'woodland', name: 'Gather deadwood', hours: 1, level: 1, gives: { timber: [3, 5] } },
  { id: 'oaks', site: 'woodland', name: 'Fell old oaks', hours: 3, level: 2, gives: { timber: [9, 13] } },
  { id: 'charcoal', site: 'woodland', name: 'Burn charcoal', hours: 4, level: 3, gives: { coal: [6, 9] }, costs: { timber: 4 } },
  { id: 'grove', site: 'woodland', name: 'Clear the old grove', hours: 6, level: 5, gives: { timber: [18, 24], coal: [3, 5] } },
  { id: 'hunt', site: 'pastures', name: 'Hunt deer', hours: 1.5, level: 1, gives: { hide: [2, 4] } },
  { id: 'shear', site: 'pastures', name: 'Shear the flock', hours: 2, level: 2, gives: { wool: [4, 7] } },
  { id: 'boar', site: 'pastures', name: 'Boar hunt', hours: 4, level: 3, gives: { hide: [6, 10] } },
  { id: 'drive', site: 'pastures', name: 'Great drive', hours: 6, level: 5, gives: { wool: [12, 16], hide: [3, 5] } },
  { id: 'surface', site: 'mine', name: 'Surface copper', hours: 2, level: 1, gives: { copper: [3, 5], tin: [1, 3] } },
  { id: 'tinseam', site: 'mine', name: 'Work the tin seam', hours: 3, level: 2, gives: { tin: [4, 6], copper: [2, 3] } },
  { id: 'iron', site: 'mine', name: 'Iron seam', hours: 4, level: 3, gives: { iron: [5, 8] } },
  { id: 'deep', site: 'mine', name: 'Deep shaft', hours: 6, level: 4, gives: { iron: [9, 13], coal: [2, 4] } },
  { id: 'starfall', site: 'mine', name: 'Starfall vein', hours: 8, level: 5, gives: { starmetal: [1, 2], iron: [3, 5] } },
  { id: 'pan', site: 'river', name: 'Pan for gold', hours: 3, level: 1, gives: { gold: [1, 3] } },
  { id: 'sluice', site: 'river', name: 'Run the sluice', hours: 5, level: 2, gives: { gold: [3, 5] } },
  { id: 'gravel', site: 'river', name: 'Dig the gem gravel', hours: 6, level: 3, gives: { gems: [1, 2] } },
  { id: 'gempit', site: 'river', name: 'Old gem pit', hours: 8, level: 4, gives: { gems: [2, 4], gold: [1, 2] } },
]
export const jobDef = (id: string) => JOBS.find((j) => j.id === id)!

export const MAX_SITE_LEVEL = 5
// Cost to reach each level (index = the new level).
const UPGRADES: (Bag & { coins: number })[] = [
  { coins: 0 },
  { coins: 0 },
  { coins: 120, timber: 8 },
  { coins: 350, timber: 16, copper: 8 },
  { coins: 900, timber: 24, iron: 16 },
  { coins: 2200, timber: 30, iron: 30, gold: 8, gems: 3 },
]
export const upgradeCost = (level: number) => UPGRADES[level + 1]

/** How many jobs (or forgings, for the workshop) a site runs at once at a level. */
export const slotsAt = (level: number) => (level >= 5 ? 3 : level >= 3 ? 2 : 1)
export const yieldAt = (level: number) => 1 + 0.15 * (level - 1)
export const speedAt = (level: number) => 1 - 0.08 * (level - 1)

export type Job = { id: string; site: SiteId; job: string; start: number; end: number; gives: Bag }
export type Craft = { id: string; item: string; start: number; end: number }
export type Estate = {
  levels: Record<SiteId, number>
  jobs: Job[]
  crafting: Craft[]
  res: Bag
  /** Item ids whose blueprint is owned. Plain-material (tier 0) blueprints are always known. */
  blueprints: string[]
  market: { day: string; bought: Bag }
}

export function newEstate(): Estate {
  return {
    levels: { woodland: 1, pastures: 1, mine: 1, river: 1, workshop: 1 },
    jobs: [],
    crafting: [],
    res: { timber: 4, hide: 6 },
    blueprints: [],
    market: { day: '', bought: {} },
  }
}

export const have = (e: Estate, bag: Bag) => (Object.keys(bag) as ResId[]).every((k) => (e.res[k] ?? 0) >= (bag[k] ?? 0))
export function addBag(a: Bag, b: Bag, sign = 1): Bag {
  const out = { ...a }
  for (const k of Object.keys(b) as ResId[]) out[k] = Math.max(0, (out[k] ?? 0) + sign * (b[k] ?? 0))
  return out
}

// --- Jobs ----------------------------------------------------------------------------------------

export const jobsAt = (e: Estate, s: SiteId) => e.jobs.filter((j) => j.site === s)

/** Starts a job. The yield is rolled now, so what you'll get is shown up front. */
export function startJob(e: Estate, id: string, now = Date.now()): Estate {
  const d = jobDef(id)
  const level = e.levels[d.site]
  if (level < d.level || jobsAt(e, d.site).length >= slotsAt(level) || (d.costs && !have(e, d.costs))) return e
  const gives: Bag = {}
  for (const [k, [lo, hi]] of Object.entries(d.gives) as [ResId, [number, number]][]) gives[k] = Math.round((lo + Math.random() * (hi - lo)) * yieldAt(level))
  const ms = d.hours * 3600_000 * speedAt(level)
  const job: Job = { id: `${id}-${now}`, site: d.site, job: id, start: now, end: now + ms, gives }
  return { ...e, jobs: [...e.jobs, job], res: d.costs ? addBag(e.res, d.costs, -1) : e.res }
}

/** Brings in every finished job; returns what came in. */
export function collectJobs(e: Estate, now = Date.now()): { estate: Estate; got: Bag } {
  const done = e.jobs.filter((j) => j.end <= now)
  if (!done.length) return { estate: e, got: {} }
  const got = done.reduce<Bag>((a, j) => addBag(a, j.gives), {})
  return { estate: { ...e, jobs: e.jobs.filter((j) => j.end > now), res: addBag(e.res, got) }, got }
}

export function upgradeSite(e: Estate, s: SiteId, coins: number): { estate: Estate; coins: number } | null {
  const level = e.levels[s]
  if (level >= MAX_SITE_LEVEL) return null
  const { coins: price, ...bag } = upgradeCost(level)
  if (coins < price || !have(e, bag)) return null
  return { estate: { ...e, levels: { ...e.levels, [s]: level + 1 }, res: addBag(e.res, bag, -1) }, coins: coins - price }
}

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

/** How long forging takes at the current workshop level, in ms. */
export function craftTime(e: Estate, it: Item) {
  const share = it.slot === 'cape' ? 0.5 : (SLOT_RECIPE_SHARE[it.slot] ?? 0.5)
  return TIER_HOURS[it.tier] * Math.max(0.5, share) * 3600_000 * speedAt(e.levels.workshop)
}

export function startCraft(e: Estate, it: Item, now = Date.now()): Estate | null {
  const need = recipe(it)
  if (!knowsBlueprint(e, it) || !have(e, need) || e.crafting.length >= slotsAt(e.levels.workshop)) return null
  const craft: Craft = { id: `${it.id}-${now}`, item: it.id, start: now, end: now + craftTime(e, it) }
  return { ...e, crafting: [...e.crafting, craft], res: addBag(e.res, need, -1) }
}

/** Breaking down a piece you replaced gives back about a third of what it took. */
export function salvage(it: Item | null): Bag {
  if (!it) return {}
  const out: Bag = {}
  for (const [k, v] of Object.entries(recipe(it)) as [ResId, number][]) {
    const n = Math.floor(v * 0.35)
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

export function marketPrice(id: ResId, difficultyPrices: number, now = Date.now()) {
  const day = today(now)
  const yesterday = today(now - 86400_000)
  const base = resource(id).price
  const buy = Math.max(1, Math.round(base * swing(day, id) * difficultyPrices))
  const sell = Math.max(1, Math.round(base * swing(day, id) * 0.5))
  return { buy, sell, trend: swing(day, id) - swing(yesterday, id) }
}

/** What's left to buy of a material today. */
export function stockLeft(e: Estate, id: ResId, now = Date.now()) {
  const bought = e.market.day === today(now) ? (e.market.bought[id] ?? 0) : 0
  return Math.max(0, resource(id).stock - bought)
}

export function trade(e: Estate, id: ResId, n: number, coins: number, difficultyPrices: number, now = Date.now()): { estate: Estate; coins: number } | null {
  const p = marketPrice(id, difficultyPrices, now)
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

