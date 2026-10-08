import type { Ball } from './physics'

// Two rule sets. Eight-ball, close to WPA rules but without calling pockets: the table stays open
// after the break, the first ball legally potted decides the groups, and the 8 wins only once
// your group is gone. Simple: every object ball is the same, a pot earns another shot, and the
// first to 8 balls wins. Fouls give the other player ball in hand anywhere.
//
// Solo play uses either set's balls: clear the table in as few shots as you can (with eight-ball
// balls the 8 has to go last), a foul costing a shot.

export type Rules = 'eight' | 'simple'
export type Group = 'solids' | 'stripes'
export type Match = {
  rules: Rules
  solo: boolean
  turn: 0 | 1
  groups: [Group | null, Group | null]
  isBreak: boolean
  /** Simple: balls potted by each player. */
  scores: [number, number]
  /** Solo: shots taken, fouls included. */
  shots: number
}
export type ShotLog = { first: number | null; rail: boolean; pocketed: number[] }

export const groupOf = (id: number): Group => (id < 8 ? 'solids' : 'stripes')
export const newLog = (): ShotLog => ({ first: null, rail: false, pocketed: [] })
export const newMatch = (rules: Rules, solo: boolean, turn: 0 | 1 = 0): Match => ({ rules, solo, turn, groups: [null, null], isBreak: true, scores: [0, 0], shots: 0 })
export const WIN_SIMPLE = 8

export type Outcome = {
  foul: string | null
  /** Who won, once the game is over. In solo play 0 means the table was cleared, 1 that it was lost. */
  winner: 0 | 1 | null
  next: 0 | 1
  groups: [Group | null, Group | null]
  scores: [number, number]
  shots: number
  ballInHand: boolean
  respot8: boolean
  /** Why the game ended, when it did. */
  reason?: string
}

/** Object balls of `group` still on the table (all of them, 8 aside, without a group). */
export function remaining(balls: Ball[], group: Group | null) {
  return balls.filter((b) => b.on && b.id !== 0 && b.id !== 8 && (!group || groupOf(b.id) === group))
}

export function legalTargets(balls: Ball[], m: Match) {
  const objects = balls.filter((b) => b.on && b.id !== 0)
  if (m.rules === 'simple') return objects
  const left = remaining(balls, m.solo ? null : m.groups[m.turn])
  return left.length ? left : objects.filter((b) => b.id === 8)
}

/** `before` is the ids on the table before the shot. */
export function judge(m: Match, log: ShotLog, before: number[]): Outcome {
  return m.solo || m.rules === 'simple' ? judgeSimple(m, log, before) : judgeEight(m, log, before)
}

function judgeSimple(m: Match, log: ShotLog, before: number[]): Outcome {
  const me = m.turn
  const opp = m.solo ? me : ((1 - me) as 0 | 1)
  const potted = log.pocketed.filter((id) => id !== 0)
  const scores: [number, number] = [...m.scores]
  scores[me] += potted.length
  const shots = m.shots + (log.pocketed.includes(0) ? 2 : 1)
  let foul: string | null = null
  if (log.pocketed.includes(0)) foul = 'Scratch'
  else if (log.first === null) foul = 'No ball hit'
  const base = { foul, groups: m.groups, scores, shots, respot8: false }
  const left = before.filter((id) => id !== 0 && !potted.includes(id))

  if (m.solo) {
    if (m.rules === 'eight' && potted.includes(8) && left.length) return { ...base, winner: 1, next: me, ballInHand: false, reason: '8 potted before the rest' }
    if (!left.length) return { ...base, winner: 0, next: me, ballInHand: false, reason: `cleared in ${shots} shots` }
    return { ...base, winner: null, next: me, ballInHand: !!foul }
  }
  if (scores[me] >= WIN_SIMPLE) return { ...base, winner: me, next: me, ballInHand: false, reason: `${scores[me]} balls to ${scores[opp]}` }
  const keep = !foul && potted.length > 0
  return { ...base, winner: null, next: keep ? me : opp, ballInHand: !!foul }
}

function judgeEight(m: Match, log: ShotLog, before: number[]): Outcome {
  const me = m.turn
  const opp = (1 - me) as 0 | 1
  const groups: [Group | null, Group | null] = [...m.groups]
  const mine = groups[me]
  const cleared = mine !== null && !before.some((id) => id !== 0 && id !== 8 && groupOf(id) === mine)
  const potted = log.pocketed.filter((id) => id !== 0)
  const eight = potted.includes(8)
  const base = { scores: m.scores, shots: m.shots + 1 }

  let foul: string | null = null
  if (log.pocketed.includes(0)) foul = 'Scratch'
  else if (log.first === null) foul = 'No ball hit'
  else if (!m.isBreak) {
    if (mine) {
      if (cleared && log.first !== 8) foul = 'The 8 had to be hit first'
      else if (!cleared && (log.first === 8 || groupOf(log.first) !== mine)) foul = log.first === 8 ? 'Hit the 8 first' : `Hit a ${mine === 'solids' ? 'stripe' : 'solid'} first`
    } else if (log.first === 8) foul = 'Hit the 8 first'
    if (!foul && potted.length === 0 && !log.rail) foul = 'No rail after contact'
  }

  if (eight && !m.isBreak) {
    const end = { ...base, foul, groups, ballInHand: false, respot8: false }
    if (foul) return { ...end, winner: opp, next: opp, reason: `8 potted on a foul (${foul.toLowerCase()})` }
    if (!cleared) return { ...end, winner: opp, next: opp, reason: '8 potted too early' }
    return { ...end, winner: me, next: me, reason: '8 potted' }
  }

  if (!mine && !m.isBreak && !foul) {
    const firstPot = potted.find((id) => id !== 8)
    if (firstPot !== undefined) {
      groups[me] = groupOf(firstPot)
      groups[opp] = groupOf(firstPot) === 'solids' ? 'stripes' : 'solids'
    }
  }
  const now = groups[me]
  const scored = potted.some((id) => id !== 8 && (!now || groupOf(id) === now))
  const keep = !foul && scored
  return { ...base, foul, winner: null, next: keep ? me : opp, groups, ballInHand: !!foul, respot8: eight }
}
