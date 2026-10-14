import type { Tier } from './data.ts'
import type { Owner, Unit, World } from './sim.ts'

// Control groups: the player's own shortcut to a handful of ships (or a yard, or the station),
// kept by group key ('1' to '9' and '0'). They are this player's view of the battle, not part of
// it: they never go through the lockstep orders, and a battle saved mid-fight keeps them with the
// selection (snapshot.ts). A group holds unit ids; a unit that dies, or stops being ours, drops out.

export type Groups = Map<string, number[]>

/** The group keys in the order the bar shows them: 1 to 9, then 0, as on the keyboard. */
export const GROUP_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const
export type GroupKey = (typeof GROUP_KEYS)[number]

/** Two presses of the same group key within this many milliseconds also look at the group. */
export const DOUBLE_MS = 300

const alive = (w: World, me: Owner, id: number): Unit | undefined => {
  const u = w.byId.get(id)
  return u && !u.dead && u.owner === me ? u : undefined
}

/** The units of group `key` still ours and alive. The group itself is tidied to them. */
export function members(w: World, me: Owner, groups: Groups, key: string): Unit[] {
  const ids = groups.get(key)
  if (!ids) return []
  const out: Unit[] = []
  for (const id of ids) {
    const u = alive(w, me, id)
    if (u) out.push(u)
  }
  if (out.length !== ids.length) {
    if (out.length) groups.set(key, out.map((u) => u.id))
    else groups.delete(key)
  }
  return out
}

/** Group `key` becomes exactly `ids` (Ctrl+number); nothing to put in it clears it. */
export function setGroup(groups: Groups, key: string, ids: number[]) {
  if (ids.length) groups.set(key, [...new Set(ids)])
  else groups.delete(key)
}

/** `ids` join group `key` (Shift+number); answers how many were new to it. */
export function addToGroup(groups: Groups, key: string, ids: number[]) {
  const have = groups.get(key) ?? []
  const set = new Set(have)
  let added = 0
  for (const id of ids)
    if (!set.has(id)) {
      set.add(id)
      added++
    }
  if (set.size) groups.set(key, [...set])
  return added
}

/** Drops dead units (and ones no longer ours) from every group, and groups left empty. */
export function pruneGroups(w: World, me: Owner, groups: Groups) {
  for (const key of [...groups.keys()]) members(w, me, groups, key)
}

/** A group as the HUD shows it: its key, how many it holds, and the picture of its main unit. */
export type GroupInfo = { key: string; count: number; sprite: string }

/** The order units stand in for the group's picture: its biggest warship, else a structure. */
const RANK: Tier[] = ['mine', 'defense', 'yard', 'station', 'fighter', 'gunship', 'frigate', 'cruiser', 'capital']

/** The groups that hold anything, in keyboard order. */
export function groupInfo(w: World, me: Owner, groups: Groups): GroupInfo[] {
  const out: GroupInfo[] = []
  for (const key of GROUP_KEYS) {
    if (!groups.has(key)) continue
    let lead: Unit | null = null
    let count = 0
    for (const id of groups.get(key)!) {
      const u = alive(w, me, id)
      if (!u) continue
      count++
      if (!lead || RANK.indexOf(u.t.tier) > RANK.indexOf(lead.t.tier)) lead = u
    }
    if (count) out.push({ key, count, sprite: lead?.t.sprite ?? '' })
  }
  return out
}

/** The first group key with nothing in it, for touch's "+ Group" button. */
export const freeGroup = (groups: GroupInfo[]) => GROUP_KEYS.find((k) => !groups.some((g) => g.key === k))

/** Spots a second press of the same key soon after the first: a double press (or double tap). */
export class DoublePress {
  private key = ''
  private at = -Infinity
  /** A press of `key` at `now` (ms): whether it's the second of a quick pair. A third press starts
   * a new pair. */
  hit(key: string, now: number) {
    const twice = key === this.key && now - this.at <= DOUBLE_MS
    this.key = twice ? '' : key
    this.at = twice ? -Infinity : now
    return twice
  }
}
