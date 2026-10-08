import type { User } from './auth.ts'
import { database } from './db.ts'
import { HttpError } from './http.ts'

// Synced desktop state, one JSON document per key: notes, window layouts, desktop icons,
// launchers, dock order. Last write wins; the browser keeps its own copy in localStorage and
// sends `updatedAt` so an older tab can't silently overwrite a newer save.

const KEY = /^[a-z][a-z0-9:._-]{0,63}$/
const MAX_KEYS = 64

export type StateEntry = { value: unknown; updatedAt: number }

export function readState(user: User): Record<string, StateEntry> {
  const rows = database().prepare('SELECT key, value, updated_at FROM state WHERE user_id = ?').all(user.id) as { key: string; value: string; updated_at: number }[]
  return Object.fromEntries(rows.map((r) => [r.key, { value: JSON.parse(r.value), updatedAt: r.updated_at }]))
}

/** Saves `value` unless the stored copy is newer than `base` (the version the browser last saw). */
export function writeState(user: User, key: string, body: { value?: unknown; base?: number }): StateEntry & { conflict?: boolean } {
  if (!KEY.test(key)) throw new HttpError(400, 'Bad key')
  if (body.value === undefined) throw new HttpError(400, 'Missing value')
  const db = database()
  const current = db.prepare('SELECT value, updated_at FROM state WHERE user_id = ? AND key = ?').get(user.id, key) as { value: string; updated_at: number } | undefined
  if (current && typeof body.base === 'number' && current.updated_at > body.base) {
    return { value: JSON.parse(current.value), updatedAt: current.updated_at, conflict: true }
  }
  if (!current) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM state WHERE user_id = ?').get(user.id) as { n: number }
    if (n >= MAX_KEYS) throw new HttpError(400, 'Too many keys')
  }
  const updatedAt = Math.max(Date.now(), (current?.updated_at ?? 0) + 1)
  db.prepare('INSERT INTO state (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(
    user.id,
    key,
    JSON.stringify(body.value),
    updatedAt,
  )
  return { value: body.value, updatedAt }
}
