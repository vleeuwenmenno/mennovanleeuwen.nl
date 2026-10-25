import { database } from './db.ts'

// Long-lived connections (the notification stream, the Empires socket, the Agents turn streams)
// are authenticated once, when they open. Each is bound here to the stored session that
// authenticated it (sessions.id, the hash of the cookie), so that session ending ends it:
//
// - signing out closes the connections of that session, not the account's other sessions
//   (endSession); signing out everywhere, a ban and deleting the account close all of the
//   account's (endAccount);
// - a session that runs out closes its connections at its expiry, by one timer per session
//   (re-armed when the expiry is further away than a timer can wait), not by polling;
// - a connection also asks `check()` before it delivers something private or acts: that is the
//   session's expiry in memory, plus a lookup of the stored session at most every RECHECK_MS (or
//   every time with `fresh`), so a session deleted or banned behind the server's back is noticed
//   too without a database hit per message;
// - a slow sweep (SWEEP_MS, only while something is open) checks every tracked session once more.
//
// Single process: the registry is in memory, like the connections it holds.

/** The stored session a connection was opened with. */
export type SessionBinding = { key: string; userId: number; expiresAt: number }

/** How long a connection may go without looking the stored session up again, when it only checks in memory. */
const RECHECK_MS = 5_000
/** The longest a timer waits (setTimeout can't count past 2^31 ms; a session lasts 30 days). */
const MAX_WAIT = 2 ** 31 - 1
/** How often every tracked session is looked up as a safety net. */
const SWEEP_MS = 60_000

type Entry = { close: (why: string) => void; ended: boolean }
type Group = { userId: number; expiresAt: number; checkedAt: number; entries: Set<Entry>; timer: NodeJS.Timeout | null }

const groups = new Map<string, Group>() // session key → connections
const byUser = new Map<number, Set<string>>() // account → session keys
let sweeper: NodeJS.Timeout | null = null

/** Whether the stored session is still there, unexpired, and its account not banned. */
function storedValid(key: string, userId: number): boolean {
  const row = database()
    .prepare('SELECT 1 AS ok FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.user_id = ? AND s.expires_at > ? AND u.banned_at IS NULL')
    .get(key, userId, Date.now()) as { ok: number } | undefined
  return !!row
}

function arm(key: string, g: Group) {
  if (g.timer) clearTimeout(g.timer)
  g.timer = setTimeout(() => {
    g.timer = null
    if (groups.get(key) !== g) return
    if (Date.now() >= g.expiresAt) endSession(key, 'session expired')
    else arm(key, g)
  }, Math.min(MAX_WAIT, Math.max(0, g.expiresAt - Date.now()))).unref()
}

function startSweep() {
  if (sweeper) return
  sweeper = setInterval(sweep, SWEEP_MS).unref()
}

/** Looks up every tracked session once, and ends the ones that are gone. Runs on its own; exported for tests. */
export function sweep() {
  for (const [key, g] of [...groups]) if (Date.now() >= g.expiresAt || !storedValid(key, g.userId)) endSession(key, 'session ended')
}

function release(key: string, g: Group) {
  if (groups.get(key) !== g) return
  groups.delete(key)
  if (g.timer) clearTimeout(g.timer)
  const keys = byUser.get(g.userId)
  keys?.delete(key)
  if (keys && !keys.size) byUser.delete(g.userId)
  if (!groups.size && sweeper) {
    clearInterval(sweeper)
    sweeper = null
  }
}

/**
 * Binds a connection to its session. `close` ends it for good (it runs once, at once, when the
 * session ends). Returns what the connection asks before it delivers or acts, and `stop` for when
 * it ends by itself (always call it: it is what keeps the registry from growing).
 */
export function track(binding: SessionBinding, close: (why: string) => void) {
  let g = groups.get(binding.key)
  if (!g) {
    g = { userId: binding.userId, expiresAt: binding.expiresAt, checkedAt: Date.now(), entries: new Set(), timer: null }
    groups.set(binding.key, g)
    const keys = byUser.get(binding.userId) ?? new Set<string>()
    byUser.set(binding.userId, keys.add(binding.key))
    arm(binding.key, g)
    startSweep()
  }
  const group = g
  const entry: Entry = { close, ended: false }
  group.entries.add(entry)
  return {
    /** Whether the session behind this connection is still good. False once it has ended, and the connection is closed. `fresh`: look the stored session up now. */
    check(fresh = false): boolean {
      if (entry.ended) return false
      const now = Date.now()
      const stale = fresh || now - group.checkedAt >= RECHECK_MS
      if (now >= group.expiresAt || (stale && !storedValid(binding.key, group.userId))) {
        endSession(binding.key, 'session ended')
        return false
      }
      if (stale) group.checkedAt = now
      return !entry.ended
    },
    /** The connection ended by itself. */
    stop() {
      entry.ended = true
      group.entries.delete(entry)
      if (!group.entries.size) release(binding.key, group)
    },
  }
}

/** Closes every connection of one session (signing out). The account's other sessions stay. */
export function endSession(key: string, why = 'signed out') {
  const g = groups.get(key)
  if (!g) return
  release(key, g)
  for (const e of [...g.entries]) {
    e.ended = true
    try {
      e.close(why)
    } catch {
      /* already gone */
    }
  }
  g.entries.clear()
}

/** Closes every connection of every session of an account (signed out everywhere, banned, deleted). */
export function endAccount(userId: number, why = 'signed out') {
  for (const key of [...(byUser.get(userId) ?? [])]) endSession(key, why)
}

/** For tests: how many sessions and connections are tracked. */
export const liveCount = () => ({ sessions: groups.size, connections: [...groups.values()].reduce((n, g) => n + g.entries.size, 0), accounts: byUser.size, timers: [...groups.values()].filter((g) => g.timer).length, sweeping: !!sweeper })
