import { derive, has, type Derived, type Gladiator, type Rand } from './character'
import { POTIONS, spell, type PotionId, type SpellId } from './data'

// The fight itself, with no drawing in it: positions on a line, health, stamina, mana, the crowd's
// favour and status effects. Each turn returns a list of events for the arena to animate; every
// event carries a snapshot of both fighters, so the bars change when the blow lands on screen and
// not when it was decided.

export const ARENA_MIN = 130
export const ARENA_MAX = 1150
/** Closest two fighters' centres get. */
export const CONTACT = 84
export const START_X: [number, number] = [420, 860]

export type AttackType = 'quick' | 'normal' | 'power'
export type Action =
  | { kind: 'advance' }
  | { kind: 'retreat' }
  | { kind: 'attack'; type: AttackType }
  | { kind: 'taunt' }
  | { kind: 'rest' }
  | { kind: 'spell'; id: SpellId }
  | { kind: 'potion'; id: PotionId }
  | { kind: 'skip' }

export type StatusId = 'burning' | 'slowed' | 'weakened' | 'blinded' | 'stunned' | 'frenzy'
export type Status = { id: StatusId; turns: number; power: number }
export const STATUS_NAMES: Record<StatusId, string> = { burning: 'Burning', slowed: 'Slowed', weakened: 'Weakened', blinded: 'Blinded', stunned: 'Stunned', frenzy: 'Crowd frenzy' }

export type Fighter = {
  side: 0 | 1
  g: Gladiator
  d: Derived
  x: number
  hp: number
  sta: number
  mana: number
  favour: number
  statuses: Status[]
  potions: Record<PotionId, number>
  secondWind: boolean
  tally: { dealt: number; hits: number; misses: number; crits: number; taunts: number; peakFavour: number }
}

export type Snap = { hp: number; sta: number; mana: number; favour: number; x: number; statuses: StatusId[] }

export type Ev = { snap: [Snap, Snap]; text?: string } & (
  | { t: 'turn'; who: 0 | 1 }
  | { t: 'move'; who: 0 | 1; from: number; to: number }
  | { t: 'attack'; who: 0 | 1; type: AttackType; riposte?: boolean }
  | { t: 'hit'; who: 0 | 1; dmg: number; crit: boolean; blocked: boolean; type: AttackType; push: number; stun: boolean }
  | { t: 'miss'; who: 0 | 1; type: AttackType }
  | { t: 'cast'; who: 0 | 1; spell: SpellId }
  | { t: 'spell'; who: 0 | 1; spell: SpellId; dmg: number; heal: number; missed: boolean }
  | { t: 'taunt'; who: 0 | 1; ok: boolean; line: string }
  | { t: 'rest'; who: 0 | 1 }
  | { t: 'potion'; who: 0 | 1; id: PotionId }
  | { t: 'dot'; who: 0 | 1; dmg: number }
  | { t: 'stunned'; who: 0 | 1 }
  | { t: 'frenzy'; who: 0 | 1 }
  | { t: 'secondWind'; who: 0 | 1; heal: number }
  | { t: 'ko'; who: 0 | 1 }
)
type EvBody = Ev extends infer E ? (E extends Ev ? Omit<E, 'snap'> : never) : never

export type Fight = {
  f: [Fighter, Fighter]
  turn: 0 | 1
  turns: number
  winner: 0 | 1 | null
  events: Ev[]
}

export function newFighter(g: Gladiator, side: 0 | 1, potions = true): Fighter {
  const d = derive(g)
  return {
    side,
    g,
    d,
    x: START_X[side],
    hp: d.maxHp,
    sta: d.maxSta,
    mana: d.maxMana,
    favour: 0,
    statuses: [],
    potions: potions ? { ...g.potions } : { health: 0, stamina: 0, mana: 0 },
    secondWind: false,
    tally: { dealt: 0, hits: 0, misses: 0, crits: 0, taunts: 0, peakFavour: 0 },
  }
}

export function newFight(a: Gladiator, b: Gladiator, r: Rand = Math.random, opts: { hp?: [number, number] } = {}): Fight {
  const f: [Fighter, Fighter] = [newFighter(a, 0), newFighter(b, 1)]
  if (opts.hp) f.forEach((x, i) => (x.hp = Math.max(1, Math.round(x.d.maxHp * opts.hp![i]))))
  // The quicker gladiator moves first, with some luck in it.
  const first = f[0].d.stats.agi + r() * 10 >= f[1].d.stats.agi + r() * 10 ? 0 : 1
  return { f, turn: first, turns: 0, winner: null, events: [] }
}

const snapOf = (x: Fighter): Snap => ({ hp: x.hp, sta: x.sta, mana: x.mana, favour: x.favour, x: x.x, statuses: x.statuses.map((s) => s.id) })
const statusOf = (x: Fighter, id: StatusId) => x.statuses.find((s) => s.id === id)
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
export const dist = (fight: Fight) => Math.abs(fight.f[0].x - fight.f[1].x)
/** +1 when `x` faces right, towards higher x. */
export const facing = (fight: Fight, who: 0 | 1) => (fight.f[who].x <= fight.f[1 - who].x ? 1 : -1)

export const ATTACKS: Record<AttackType, { name: string; base: number; dmg: number; sta: number; push: number; favour: number; text: string }> = {
  quick: { name: 'Quick', base: 0.86, dmg: 0.62, sta: 7, push: 0, favour: 3, text: 'Likely to land, light damage' },
  normal: { name: 'Strike', base: 0.74, dmg: 1, sta: 12, push: 14, favour: 5, text: 'A solid, honest blow' },
  power: { name: 'Power', base: 0.58, dmg: 1.65, sta: 20, push: 40, favour: 8, text: 'Big, slow, knocks them back' },
}

export const attackCost = (x: Fighter, type: AttackType) => Math.round(ATTACKS[type].sta * x.d.weapon.cost)
export const moveCost = (x: Fighter) => Math.round(3 + x.d.burden * 0.6)
export const spellCost = (x: Fighter, id: SpellId) => Math.round(spell(id).mana * (has(x.g, 'arcane') ? 0.8 : 1))
export const TAUNT_COST = 5
export const inReach = (fight: Fight, who: 0 | 1) => dist(fight) <= CONTACT + fight.f[who].d.weapon.reach + 2

/** Hit chance of a melee attack; also what the buttons show. */
export function hitChance(fight: Fight, who: 0 | 1, type: AttackType) {
  const a = fight.f[who]
  const b = fight.f[1 - who]
  const acc = a.d.acc * (statusOf(a, 'weakened') ? 0.75 : 1) + 4
  const eva = Math.max(0, b.d.eva * (statusOf(b, 'slowed') ? 0.6 : 1)) + 4
  let p = ATTACKS[type].base + (0.6 * (acc - eva)) / (acc + eva + 12)
  if (statusOf(a, 'blinded')) p -= 0.3
  if (statusOf(b, 'stunned')) p += 0.15
  return clamp(p, 0.06, 0.97)
}

export function spellChance(fight: Fight, who: 0 | 1) {
  const a = fight.f[who]
  const b = fight.f[1 - who]
  const eva = Math.max(0, b.d.eva)
  return clamp(0.84 - (0.3 * eva) / (eva + a.d.stats.mag + 20) - (statusOf(a, 'blinded') ? 0.2 : 0), 0.3, 0.95)
}

/** Why each action can't be taken right now, or null when it can. */
export function blockers(fight: Fight, who: 0 | 1) {
  const a = fight.f[who]
  const dir = facing(fight, who)
  const out: Record<string, string | null> = {}
  const close = dist(fight) <= CONTACT + 1
  const wallBehind = dir > 0 ? a.x <= ARENA_MIN + 1 : a.x >= ARENA_MAX - 1
  out.advance = close ? 'Already toe to toe' : a.sta < moveCost(a) ? 'Too tired' : null
  out.retreat = wallBehind ? 'Back against the wall' : a.sta < moveCost(a) ? 'Too tired' : null
  for (const t of ['quick', 'normal', 'power'] as AttackType[]) out[t] = !inReach(fight, who) ? 'Out of reach' : a.sta < attackCost(a, t) ? 'Too tired' : null
  out.taunt = a.sta < TAUNT_COST ? 'Too tired' : null
  out.rest = null
  for (const s of a.g.spells) out[`spell:${s}`] = a.mana < spellCost(a, s) ? 'Not enough mana' : s === 'heal' && a.hp >= a.d.maxHp ? 'Unhurt' : null
  for (const p of POTIONS) {
    const full = p.id === 'health' ? a.hp >= a.d.maxHp : p.id === 'stamina' ? a.sta >= a.d.maxSta : a.mana >= a.d.maxMana
    out[`potion:${p.id}`] = a.potions[p.id] <= 0 ? 'None left' : full ? 'Already full' : null
  }
  return out
}

export const actionKey = (a: Action) => (a.kind === 'attack' ? a.type : a.kind === 'spell' ? `spell:${a.id}` : a.kind === 'potion' ? `potion:${a.id}` : a.kind)

const TAUNTS = [
  'My grandmother hits harder!',
  'Is that a sword or a soup ladle?',
  'The lions are laughing at you.',
  'I have fought scarier chickens.',
  'Wave to your mother, she paid for a seat!',
  'Are you dancing or fighting?',
  'Rome will forget your name by supper.',
  'You fight like a senator.',
  'Come closer, I won’t bite. Much.',
  'I’ve seen tougher bread.',
]

// --- Turns ---------------------------------------------------------------------------------------

function emitter(fight: Fight) {
  return (e: EvBody) => {
    const ev = { ...e, snap: [snapOf(fight.f[0]), snapOf(fight.f[1])] } as Ev
    fight.events.push(ev)
    return ev
  }
}

/**
 * Starts the current fighter's turn: burns, regeneration, stuns. Returns false when the fighter
 * can't act this turn (stunned, or knocked out by a burn), in which case the turn is already over.
 */
export function startTurn(fight: Fight, r: Rand = Math.random): boolean {
  const emit = emitter(fight)
  const a = fight.f[fight.turn]
  fight.turns++
  a.sta = Math.min(a.d.maxSta, a.sta + 3 + a.d.stats.end * 0.15)
  a.mana = Math.min(a.d.maxMana, a.mana + 1 + a.d.stats.mag * 0.05)
  emit({ t: 'turn', who: a.side })
  const burn = statusOf(a, 'burning')
  if (burn) {
    const dmg = Math.max(1, Math.round(burn.power))
    a.hp = Math.max(0, a.hp - dmg)
    emit({ t: 'dot', who: a.side, dmg, text: `${a.g.name} burns for ${dmg}.` })
    if (checkKo(fight, a, r)) return false
  }
  const stun = statusOf(a, 'stunned')
  if (stun) {
    a.statuses = a.statuses.filter((s) => s !== stun)
    emit({ t: 'stunned', who: a.side, text: `${a.g.name} is seeing stars and loses the turn.` })
    endTurn(fight)
    return false
  }
  return true
}

function endTurn(fight: Fight) {
  const a = fight.f[fight.turn]
  for (const s of a.statuses) if (s.id !== 'stunned') s.turns--
  a.statuses = a.statuses.filter((s) => s.turns > 0)
  if (fight.winner === null) fight.turn = (1 - fight.turn) as 0 | 1
}

/** Applies `action` for the fighter whose turn it is, and ends the turn. */
export function act(fight: Fight, action: Action, r: Rand = Math.random) {
  const emit = emitter(fight)
  const who = fight.turn
  const a = fight.f[who]
  const b = fight.f[1 - who]
  const dir = facing(fight, who)

  switch (action.kind) {
    case 'advance':
    case 'retreat': {
      const step = a.d.move * (statusOf(a, 'slowed') ? 0.5 : 1)
      const from = a.x
      let to = from + (action.kind === 'advance' ? dir : -dir) * step
      if (action.kind === 'advance') to = dir > 0 ? Math.min(to, b.x - CONTACT) : Math.max(to, b.x + CONTACT)
      to = clamp(to, ARENA_MIN, ARENA_MAX)
      a.x = to
      a.sta -= moveCost(a)
      if (action.kind === 'retreat') addFavour(fight, a, -3, r)
      emit({ t: 'move', who, from, to })
      break
    }
    case 'attack':
      a.sta -= attackCost(a, action.type)
      attack(fight, who, action.type, r, false)
      break
    case 'taunt': {
      a.sta -= TAUNT_COST
      const ca = a.d.stats.cha
      const cb = b.d.stats.cha
      const ok = r() < clamp(0.55 + (0.35 * (ca - cb)) / (ca + cb + 10), 0.15, 0.92)
      const line = TAUNTS[Math.floor(r() * TAUNTS.length)]
      if (ok) {
        b.sta = Math.max(0, b.sta - (8 + ca * 0.8))
        a.tally.taunts++
      }
      emit({ t: 'taunt', who, ok, line, text: ok ? `${a.g.name}: “${line}” The crowd roars and ${b.g.name} loses heart.` : `${a.g.name}: “${line}” Nobody laughs.` })
      addFavour(fight, a, ok ? 10 : 1, r)
      break
    }
    case 'rest': {
      a.sta = Math.min(a.d.maxSta, a.sta + a.d.maxSta * 0.3 + a.d.stats.end)
      a.hp = Math.min(a.d.maxHp, a.hp + Math.round(a.d.maxHp * 0.03))
      a.mana = Math.min(a.d.maxMana, a.mana + a.d.maxMana * 0.15)
      emit({ t: 'rest', who, text: `${a.g.name} catches their breath.` })
      addFavour(fight, a, -4, r)
      break
    }
    case 'potion': {
      const p = POTIONS.find((x) => x.id === action.id)!
      a.potions[p.id]--
      if (p.id === 'health') a.hp = Math.min(a.d.maxHp, a.hp + Math.round(a.d.maxHp * p.amount))
      if (p.id === 'stamina') a.sta = Math.min(a.d.maxSta, a.sta + a.d.maxSta * p.amount)
      if (p.id === 'mana') a.mana = Math.min(a.d.maxMana, a.mana + a.d.maxMana * p.amount)
      emit({ t: 'potion', who, id: p.id, text: `${a.g.name} downs a ${p.name.toLowerCase()}.` })
      break
    }
    case 'spell':
      cast(fight, who, action.id, r)
      break
    case 'skip':
      break
  }
  endTurn(fight)
}

function addFavour(fight: Fight, a: Fighter, n: number, r: Rand) {
  if (n > 0) n *= (has(a.g, 'showman') ? 2 : 1) * (1 + a.d.stats.cha / 40)
  a.favour = clamp(a.favour + n, 0, 100)
  a.tally.peakFavour = Math.max(a.tally.peakFavour, a.favour)
  if (a.favour >= 100 && !statusOf(a, 'frenzy')) {
    a.favour = 35
    a.statuses.push({ id: 'frenzy', turns: 3, power: 1.25 })
    a.hp = Math.min(a.d.maxHp, a.hp + Math.round(a.d.maxHp * 0.1))
    emitter(fight)({ t: 'frenzy', who: a.side, text: `The crowd goes wild for ${a.g.name}! Frenzy: harder hits for three turns.` })
  }
  void r
}

function damage(from: Fighter, to: Fighter, n: number) {
  to.hp = Math.max(0, to.hp - n)
  from.tally.dealt += n
}

/** Second wind and knock-outs. True when the fight ended. */
function checkKo(fight: Fight, x: Fighter, r: Rand) {
  const emit = emitter(fight)
  if (x.hp > 0 && x.hp < x.d.maxHp * 0.25 && has(x.g, 'secondWind') && !x.secondWind) {
    x.secondWind = true
    const heal = Math.round(x.d.maxHp * 0.3)
    x.hp += heal
    emit({ t: 'secondWind', who: x.side, heal, text: `${x.g.name} finds a second wind!` })
  }
  if (x.hp > 0) return false
  fight.winner = (1 - x.side) as 0 | 1
  emit({ t: 'ko', who: x.side, text: `${x.g.name} goes down!` })
  void r
  return true
}

function attack(fight: Fight, who: 0 | 1, type: AttackType, r: Rand, riposte: boolean) {
  const emit = emitter(fight)
  const a = fight.f[who]
  const b = fight.f[1 - who]
  const kind = ATTACKS[type]
  emit({ t: 'attack', who, type, riposte, ...(riposte ? { text: `${a.g.name} ripostes!` } : {}) })

  if (r() >= hitChance(fight, who, type)) {
    a.tally.misses++
    emit({ t: 'miss', who, type, text: `${a.g.name} ${type === 'power' ? 'swings wide' : 'misses'}.` })
    addFavour(fight, b, 2, r)
    maybeRiposte(fight, b, r, riposte)
    return
  }

  const crit = r() < a.d.crit
  const [lo, hi] = a.d.dmg
  let raw = (lo + r() * (hi - lo) + a.d.dmgBonus * (statusOf(a, 'weakened') ? 0.7 : 1)) * kind.dmg
  if (crit) raw *= 1.75
  // A crowd on your side puts fire in your arm.
  raw *= 1 + a.favour / 400
  if (statusOf(a, 'frenzy')) raw *= 1.25
  if (type === 'power' && has(a.g, 'cleave')) raw *= 1.25
  if (has(a.g, 'executioner') && b.hp < b.d.maxHp * 0.3) raw *= 1.3
  const dir = facing(fight, who)
  const pinned = dir > 0 ? b.x >= ARENA_MAX - 1 : b.x <= ARENA_MIN + 1
  if (pinned) raw *= 1.15
  const blocked = !crit && r() < b.d.block * (type === 'power' ? 0.7 : 1)
  if (blocked) raw *= 0.3
  const mitigation = b.d.armour / (b.d.armour + 40 + 6 * a.g.level)
  const dmg = Math.max(1, Math.round(raw * (1 - mitigation)))

  let push = type === 'power' ? kind.push + a.d.stats.str * 0.6 : kind.push
  if (type === 'power' && has(a.g, 'cleave')) push *= 1.5
  if (blocked) push *= 0.5
  const from = b.x
  b.x = clamp(b.x + dir * push, ARENA_MIN, ARENA_MAX)
  const stunChance = a.d.weapon.stun * (type === 'power' ? 2 : 1) + (crit ? 0.1 : 0)
  const stun = !blocked && !has(b.g, 'thickSkull') && !statusOf(b, 'stunned') && r() < stunChance
  if (stun) b.statuses.push({ id: 'stunned', turns: 1, power: 0 })

  damage(a, b, dmg)
  a.tally.hits++
  if (crit) a.tally.crits++
  if (has(a.g, 'bloodlust')) a.hp = Math.min(a.d.maxHp, a.hp + Math.round(dmg * 0.12))
  const verb = crit ? 'lands a crushing blow on' : blocked ? 'batters the guard of' : type === 'power' ? 'smashes' : type === 'quick' ? 'nicks' : 'strikes'
  emit({ t: 'hit', who, dmg, crit, blocked, type, push: b.x - from, stun, text: `${a.g.name} ${verb} ${b.g.name} for ${dmg}${pinned ? ' against the wall' : ''}${stun ? ', stunning them' : ''}.` })
  addFavour(fight, a, kind.favour + (crit ? 8 : 0) + (pinned ? 3 : 0), r)
  if (checkKo(fight, b, r)) return
  if (blocked) maybeRiposte(fight, b, r, riposte)
}

function maybeRiposte(fight: Fight, x: Fighter, r: Rand, already: boolean) {
  if (already || fight.winner !== null || !has(x.g, 'riposte') || !inReach(fight, x.side) || r() >= 0.3) return
  attack(fight, x.side, 'quick', r, true)
}

function cast(fight: Fight, who: 0 | 1, id: SpellId, r: Rand) {
  const emit = emitter(fight)
  const a = fight.f[who]
  const b = fight.f[1 - who]
  const sp = spell(id)
  a.mana -= spellCost(a, id)
  emit({ t: 'cast', who, spell: id })
  const power = (sp.power + a.d.stats.mag * sp.perMag) * (0.85 + r() * 0.3) * (has(a.g, 'arcane') ? 1.15 : 1) * (statusOf(a, 'frenzy') ? 1.25 : 1)

  if (id === 'heal') {
    const heal = Math.min(a.d.maxHp - a.hp, Math.round(power))
    a.hp += heal
    emit({ t: 'spell', who, spell: id, dmg: 0, heal, missed: false, text: `${a.g.name} glows and heals ${heal}.` })
    addFavour(fight, a, 3, r)
    return
  }
  if (r() >= spellChance(fight, who)) {
    emit({ t: 'spell', who, spell: id, dmg: 0, heal: 0, missed: true, text: `${b.g.name} dodges the ${sp.name.toLowerCase()}.` })
    addFavour(fight, b, 2, r)
    return
  }
  const armour = b.d.armour / (b.d.armour + 40 + 6 * a.g.level)
  const dmg = sp.power ? Math.max(1, Math.round(power * (1 - armour * 0.5))) : 0
  if (dmg) damage(a, b, dmg)
  const add = (s: Status) => {
    b.statuses = b.statuses.filter((x) => x.id !== s.id)
    b.statuses.push(s)
  }
  let extra = ''
  if (id === 'fireball' && r() < 0.35) {
    add({ id: 'burning', turns: 3, power: 1 + a.d.stats.mag * 0.15 })
    extra = ' and sets them alight'
  }
  if (id === 'frost') add({ id: 'slowed', turns: 2, power: 0 })
  if (id === 'weaken') add({ id: 'weakened', turns: 3, power: 0 })
  if (id === 'blind') add({ id: 'blinded', turns: 2, power: 0 })
  if (id === 'thunder' && !has(b.g, 'thickSkull') && r() < 0.35) {
    add({ id: 'stunned', turns: 1, power: 0 })
    extra = ', stunning them'
  }
  const what = dmg ? `${sp.name} hits ${b.g.name} for ${dmg}${extra}.` : `${b.g.name} is ${id === 'weaken' ? 'weakened' : 'blinded'}.`
  emit({ t: 'spell', who, spell: id, dmg, heal: 0, missed: false, text: what })
  addFavour(fight, a, 6, r)
  checkKo(fight, b, r)
}

// --- Computer player -----------------------------------------------------------------------------

/** Average damage of a landed melee attack, after armour, for planning. */
function expectedHit(fight: Fight, who: 0 | 1, type: AttackType) {
  const a = fight.f[who]
  const b = fight.f[1 - who]
  const raw = ((a.d.dmg[0] + a.d.dmg[1]) / 2 + a.d.dmgBonus) * ATTACKS[type].dmg * (1 + a.d.crit * 0.75)
  return raw * (1 - b.d.armour / (b.d.armour + 40 + 6 * a.g.level)) * (1 - b.d.block * 0.7)
}

/** Picks an action for the fighter whose turn it is. `skill` 0..1: low is erratic, high is sharp. */
export function choose(fight: Fight, r: Rand = Math.random, skill = 0.7): Action {
  const who = fight.turn
  const a = fight.f[who]
  const b = fight.f[1 - who]
  const can = blockers(fight, who)
  const arch = a.g.archetype ?? 'duelist'
  const hpFrac = a.hp / a.d.maxHp
  const options: { action: Action; score: number }[] = []
  const add = (action: Action, score: number) => {
    if (can[actionKey(action)] === null && score > 0) options.push({ action, score })
  }

  add({ kind: 'potion', id: 'health' }, hpFrac < 0.3 ? 3 : 0)
  add({ kind: 'spell', id: 'heal' }, hpFrac < 0.45 ? 2.6 : 0)
  add({ kind: 'potion', id: 'stamina' }, a.sta < a.d.maxSta * 0.2 ? 1.6 : 0)
  add({ kind: 'potion', id: 'mana' }, arch === 'mage' && a.mana < 12 ? 1.4 : 0)

  let bestHit = 0
  for (const type of ['quick', 'normal', 'power'] as AttackType[]) {
    if (can[type] !== null) continue
    const ev = hitChance(fight, who, type) * expectedHit(fight, who, type)
    const perSta = ev / (attackCost(a, type) + 8)
    let score = 1.2 + perSta * 3 + ev / Math.max(10, b.hp) // finishing blows look good
    if (arch === 'brute' && type === 'power') score *= 1.3
    if (arch === 'duelist' && type !== 'power') score *= 1.15
    if (a.sta - attackCost(a, type) < 6 && type === 'power') score *= 0.6
    if (ev >= b.hp) score += 2
    bestHit = Math.max(bestHit, score)
    add({ kind: 'attack', type }, score)
  }
  const reachable = inReach(fight, who)
  for (const s of a.g.spells) {
    if (s === 'heal') continue
    const sp = spell(s)
    const ev = sp.power ? (sp.power + a.d.stats.mag * sp.perMag) * spellChance(fight, who) : 0
    let score = sp.power ? 1 + ev / 12 : 1.3
    if (s === 'weaken' && b.statuses.some((x) => x.id === 'weakened')) score = 0
    if (s === 'blind' && b.statuses.some((x) => x.id === 'blinded')) score = 0
    if (s === 'frost' && b.statuses.some((x) => x.id === 'slowed')) score *= 0.5
    if (arch === 'mage') score *= 1.5
    else score *= 0.6
    add({ kind: 'spell', id: s }, score)
  }
  if (!reachable) add({ kind: 'advance' }, arch === 'mage' ? 0.8 : 2.2)
  if (arch === 'mage' && reachable && a.mana >= 12) add({ kind: 'retreat' }, 1.4)
  if (arch === 'spearman' && dist(fight) < CONTACT + 30 && a.d.weapon.reach > 80) add({ kind: 'retreat' }, 0.9)
  add({ kind: 'taunt' }, (arch === 'showman' ? 1.4 : 0.35) * (b.sta > 10 ? 1 : 0.3) * (reachable ? 0.6 : 1))
  add({ kind: 'rest' }, a.sta < 14 ? 2.5 : a.sta < a.d.maxSta * 0.35 && !bestHit ? 1 : 0.05)

  if (!options.length) return { kind: 'rest' }
  // Sharper fighters lean harder towards the best-looking option.
  const sharp = 1 + skill * 4
  const weights = options.map((o) => Math.pow(o.score, sharp) * (0.8 + r() * 0.4))
  let x = r() * weights.reduce((s, w) => s + w, 0)
  for (let i = 0; i < options.length; i++) {
    x -= weights[i]
    if (x <= 0) return options[i].action
  }
  return options[0].action
}

/** Runs a whole fight between two computer gladiators, for the other bouts of a tournament. */
export function simulate(a: Gladiator, b: Gladiator, r: Rand = Math.random): 0 | 1 {
  const fight = newFight(a, b, r)
  while (fight.winner === null && fight.turns < 300) {
    if (startTurn(fight, r) && fight.winner === null) act(fight, choose(fight, r, 0.7), r)
    fight.events.length = 0
  }
  if (fight.winner !== null) return fight.winner
  return fight.f[0].hp / fight.f[0].d.maxHp >= fight.f[1].hp / fight.f[1].d.maxHp ? 0 : 1
}
