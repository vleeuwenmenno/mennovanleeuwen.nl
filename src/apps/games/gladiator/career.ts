import { ARCHETYPES, gearStats, has, makeOpponent, pick, randomLook, randomName, rng, xpFor, type Gladiator } from './character'
import { simulate } from './combat'
import { league, LEAGUES, MAX_LEVEL, PERK_LEVELS, POINTS_PER_LEVEL, type Archetype, type LeagueId, type Look } from './data'

// The career around the fights: what is saved, which fights are on offer, tournaments, rivals and
// what a win or a loss is worth.

export type Mode = 'normal' | 'hardcore'

export type Rival = { id: string; name: string; look: Look; archetype: Archetype; seed: number; offset: number; wins: number; losses: number }

/** Someone to fight: rebuilt from seed and level whenever needed, so saves stay small. */
export type Foe = { seed: number; level: number; archetype: Archetype; rival?: string; champion?: LeagueId }
export type Offer = Foe & { purse: number; label: string }

export type Tournament = {
  league: LeagueId
  entrants: Record<string, Foe | 'you'>
  /** Ids per round: 8, then 4, then 2, then the winner. */
  rounds: string[][]
  hp: number
  out: boolean
}

export type Save = {
  version: 1
  mode: Mode
  g: Gladiator
  gold: number
  fame: number
  beaten: LeagueId[]
  tourneyWins: Record<LeagueId, number>
  record: { wins: number; losses: number }
  rivals: Rival[]
  offers: Offer[]
  league: LeagueId
  tournament: Tournament | null
  trained: number
  pendingPerks: number
  nextSeed: number
  created: number
  updated: number
  dead?: boolean
  emperor?: boolean
}

export type HallEntry = { name: string; level: number; mode: Mode; fate: 'fell' | 'emperor' | 'retired'; wins: number; losses: number; fame: number; date: number; look: Look; gear: Gladiator['gear']; by?: string }

const KEY = 'mvlos.gladiator.v1'
type Store = { slots: (Save | null)[]; hall: HallEntry[] }
export const SLOTS = 3

export function readStore(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Store | null
    if (s && Array.isArray(s.slots)) return { slots: [...s.slots, null, null, null].slice(0, SLOTS), hall: s.hall ?? [] }
  } catch {
    /* fresh store */
  }
  return { slots: [null, null, null], hall: [] }
}

export function writeStore(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* the save just won't persist */
  }
}

export function saveSlot(i: number, save: Save | null) {
  const s = readStore()
  s.slots[i] = save ? { ...save, updated: Date.now() } : null
  writeStore(s)
}

export function addHall(e: HallEntry) {
  const s = readStore()
  s.hall = [e, ...s.hall].slice(0, 30)
  writeStore(s)
}

// --- Starting out --------------------------------------------------------------------------------

export function newSave(g: Gladiator, mode: Mode): Save {
  const seed = Math.floor(Math.random() * 1e9)
  const r = rng(seed)
  const archs = [...ARCHETYPES].sort(() => r() - 0.5)
  const rivals: Rival[] = [-1, 0, 1, 2].map((offset, i) => ({
    id: `rival-${i}`,
    name: randomName(r),
    look: randomLook(r),
    archetype: archs[i],
    seed: Math.floor(r() * 1e9),
    offset,
    wins: 0,
    losses: 0,
  }))
  const save: Save = {
    version: 1,
    mode,
    g,
    gold: 60,
    fame: 0,
    beaten: [],
    tourneyWins: { pits: 0, city: 0, colosseum: 0 },
    record: { wins: 0, losses: 0 },
    rivals,
    offers: [],
    league: 'pits',
    tournament: null,
    trained: 0,
    pendingPerks: 0,
    nextSeed: seed,
    created: Date.now(),
    updated: Date.now(),
  }
  return refreshOffers(save)
}

export const unlocked = (s: Save, id: LeagueId) => id === 'pits' || (id === 'city' && s.beaten.includes('pits')) || (id === 'colosseum' && s.beaten.includes('city'))

// --- Opponents -----------------------------------------------------------------------------------

export function rivalLevel(s: Save, r: Rival) {
  return Math.max(1, Math.min(MAX_LEVEL, s.g.level + r.offset))
}

export function foeGladiator(s: Save, f: Foe): Gladiator {
  if (f.champion) {
    const c = league(f.champion).champion
    return makeOpponent(c.level, c.archetype, c.seed, { name: c.name, title: c.title, gearBoost: 1 })
  }
  const rival = f.rival ? s.rivals.find((r) => r.id === f.rival) : undefined
  if (rival) return { ...makeOpponent(f.level, rival.archetype, rival.seed + f.level, { name: rival.name, look: rival.look, title: 'your rival' }), id: rival.id }
  return makeOpponent(f.level, f.archetype, f.seed)
}

const nextSeed = (s: Save) => (s.nextSeed = (Math.imul(s.nextSeed ^ 0x5bd1e995, 1664525) + 1013904223) >>> 0)

/** Gold for beating someone of `level`. */
export function purseFor(level: number, kind: 'exhibition' | 'rival' | 'tournament' | 'champion' = 'exhibition') {
  const base = 20 + 7 * Math.pow(level, 1.25)
  const k = kind === 'rival' ? 1.5 : kind === 'champion' ? 4 : kind === 'tournament' ? 0.7 : 1
  return Math.round(base * k)
}

/** Three fresh exhibition bouts in the chosen league, and sometimes a rival calling you out. */
export function refreshOffers(save: Save, leagueId: LeagueId = save.league): Save {
  const s = { ...save }
  const L = league(leagueId)
  const r = rng(nextSeed(s))
  const lv = (d: number) => Math.max(L.levels[0], Math.min(L.levels[1], s.g.level + d))
  const offers: Offer[] = [
    { label: 'Warm-up', d: -1 },
    { label: 'Even match', d: 0 },
    { label: 'Tough draw', d: 2 },
  ].map(({ label, d }) => {
    const level = lv(d + (r() < 0.3 ? 1 : 0))
    return { seed: Math.floor(r() * 1e9), level, archetype: pick(r, ARCHETYPES), label, purse: purseFor(level) }
  })
  const rivals = s.rivals.filter((rv) => {
    const l = rivalLevel(s, rv)
    return l >= L.levels[0] - 1 && l <= L.levels[1] + 2
  })
  if (rivals.length && r() < 0.45) {
    const rv = pick(r, rivals)
    const level = rivalLevel(s, rv)
    offers.push({ seed: rv.seed, level, archetype: rv.archetype, rival: rv.id, label: 'Grudge match', purse: purseFor(level, 'rival') })
  }
  return { ...s, league: leagueId, offers }
}

// --- Tournaments ---------------------------------------------------------------------------------

export function enterTournament(save: Save, leagueId: LeagueId): Save {
  const s = { ...save }
  const L = league(leagueId)
  const r = rng(nextSeed(s))
  const entrants: Tournament['entrants'] = { you: 'you' }
  const lo = Math.max(L.levels[0], s.g.level - 2)
  const hi = Math.max(lo, Math.min(L.levels[1], s.g.level + 2))
  const rivals = s.rivals.filter((rv) => rivalLevel(s, rv) >= L.levels[0] && rivalLevel(s, rv) <= L.levels[1] + 1).slice(0, 2)
  for (const rv of rivals) entrants[rv.id] = { seed: rv.seed, level: rivalLevel(s, rv), archetype: rv.archetype, rival: rv.id }
  let n = 0
  while (Object.keys(entrants).length < 8) entrants[`t${n++}`] = { seed: Math.floor(r() * 1e9), level: lo + Math.floor(r() * (hi - lo + 1)), archetype: pick(r, ARCHETYPES) }
  const ids = Object.keys(entrants).sort(() => r() - 0.5)
  return { ...s, gold: s.gold - L.entry, tournament: { league: leagueId, entrants, rounds: [ids], hp: 1, out: false } }
}

/** Your opponent in the current round, or null when you're out or it's over. */
export function tournamentFoe(t: Tournament): { id: string; foe: Foe } | null {
  const round = t.rounds[t.rounds.length - 1]
  if (t.out || round.length < 2) return null
  const i = round.indexOf('you')
  if (i < 0) return null
  const id = round[i ^ 1]
  return { id, foe: t.entrants[id] as Foe }
}

/** Settles a round: your result plus every other bout, simulated. */
export function advanceTournament(s: Save, t: Tournament, youWon: boolean, hpLeft: number): Tournament {
  const round = t.rounds[t.rounds.length - 1]
  const next: string[] = []
  for (let i = 0; i < round.length; i += 2) {
    const a = round[i]
    const b = round[i + 1]
    if (a === 'you' || b === 'you') next.push(youWon ? 'you' : a === 'you' ? b : a)
    else next.push(simulate(foeGladiator(s, t.entrants[a] as Foe), foeGladiator(s, t.entrants[b] as Foe)) === 0 ? a : b)
  }
  // Between rounds the surgeon patches up a third of what's missing.
  return { ...t, rounds: [...t.rounds, next], hp: Math.min(1, hpLeft + (1 - hpLeft) * 0.35), out: !youWon }
}

export function entrantName(s: Save, t: Tournament, id: string) {
  if (id === 'you') return s.g.name
  return foeGladiator(s, t.entrants[id] as Foe).name
}

// --- Results -------------------------------------------------------------------------------------

export type Result = {
  won: boolean
  gold: number
  xp: number
  fame: number
  levels: number
  notes: string[]
  dead: boolean
}

export type FightKind = 'exhibition' | 'rival' | 'tournament' | 'champion'

/** Pays out (or takes away) after a fight and levels the gladiator up. */
export function settle(s: Save, foe: Foe, kind: FightKind, won: boolean, peakFavour: number, spared = false): { save: Save; result: Result } {
  const g = { ...s.g }
  const notes: string[] = []
  const cha = gearStats(g).cha
  const crowd = 1 + peakFavour / 200
  const tongue = has(g, 'goldTongue') ? 1.25 : 1
  const ratio = Math.max(0.4, Math.min(2, Math.pow(foe.level / g.level, 1.1)))
  let xp = Math.round((18 + 14 * foe.level) * ratio * (kind === 'champion' ? 2 : 1))
  let gold = 0
  let fame = 0
  let save: Save = { ...s, record: { ...s.record } }
  let dead = false

  if (won) {
    gold = Math.round(purseFor(foe.level, kind) * (1 + cha * 0.01) * crowd * tongue)
    fame = Math.round((1 + foe.level / 3) * (kind === 'champion' ? 6 : kind === 'rival' ? 2 : 1) * tongue)
    save.record.wins++
    if (peakFavour >= 80) notes.push('The crowd loved you: bigger purse.')
  } else {
    xp = Math.round(xp * 0.25)
    save.record.losses++
    if (s.mode === 'hardcore' && !spared) {
      dead = true
      notes.push('The crowd turns its thumbs down.')
    } else {
      gold = -Math.round(s.gold * 0.2)
      fame = -Math.min(s.fame, 2)
      if (gold) notes.push('The doctor and the bookmakers take their cut.')
    }
  }

  // Rivals remember.
  if (foe.rival) {
    save.rivals = s.rivals.map((r) => (r.id === foe.rival ? { ...r, wins: r.wins + (won ? 0 : 1), losses: r.losses + (won ? 1 : 0), offset: Math.max(-1, Math.min(3, r.offset + (won ? -1 : 1))) } : r))
    const rv = s.rivals.find((r) => r.id === foe.rival)!
    notes.push(won ? `${rv.name} swears revenge.` : `${rv.name} will be insufferable about this.`)
  }

  if (foe.champion && won) {
    const L = league(foe.champion)
    save.beaten = [...new Set([...s.beaten, foe.champion])]
    const nextL = LEAGUES[LEAGUES.findIndex((l) => l.id === foe.champion) + 1]
    // The purse for a champion's title is paid once; rematches pay the bout.
    if (!s.beaten.includes(foe.champion)) gold += L.prize
    if (nextL) notes.push(`Champion of the ${L.name}! The ${nextL.name} opens its gates.`)
    else {
      save.emperor = true
      notes.push('The Emperor himself crowns you Champion of Rome!')
    }
    g.title = nextL ? `Champion of the ${L.name}` : 'Champion of Rome'
  }

  g.xp += xp
  let levels = 0
  while (g.level < MAX_LEVEL && g.xp >= xpFor(g.level)) {
    g.xp -= xpFor(g.level)
    g.level++
    g.points += POINTS_PER_LEVEL
    levels++
    if (PERK_LEVELS.includes(g.level)) save.pendingPerks++
  }
  if (g.level >= MAX_LEVEL) g.xp = Math.min(g.xp, xpFor(MAX_LEVEL))
  save = { ...save, g, gold: Math.max(0, s.gold + gold), fame: Math.max(0, s.fame + fame), dead }
  return { save, result: { won, gold, xp, fame, levels, notes, dead } }
}

export const trainPrice = (s: Save) => Math.round(60 * Math.pow(1.3, s.trained))
export const respecPrice = (s: Save) => 40 + s.g.level * 30
