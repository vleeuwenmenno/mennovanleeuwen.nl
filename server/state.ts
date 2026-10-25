import type { User } from './auth.ts'
import { database } from './db.ts'
import { HttpError } from './http.ts'
import { checkRoom } from './quota.ts'

// Synced desktop state, one JSON document per key: notes, window layouts, desktop icons,
// launchers, dock order. Last write wins; the browser keeps its own copy in localStorage and
// sends `updatedAt` so an older tab can't silently overwrite a newer save.

const KEY = /^[a-z][a-z0-9:._-]{0,63}$/
const MAX_KEYS = 64

/**
 * `writeId`: the id the browser gave the save that made this version (src/os/synced.ts uses it to
 * tell whether anything was saved since one of its own saves). None for versions saved before
 * ids, or written by the server itself (the agents' note tools).
 */
export type StateEntry = { value: unknown; updatedAt: number; writeId?: string }

const WRITE_ID = /^[A-Za-z0-9-]{1,64}$/
type Row = { value: string; updated_at: number; write_id: string | null }
const entry = (r: Row): StateEntry => ({ value: JSON.parse(r.value), updatedAt: r.updated_at, ...(r.write_id ? { writeId: r.write_id } : {}) })

export function readState(user: User): Record<string, StateEntry> {
  const rows = database().prepare('SELECT key, value, updated_at, write_id FROM state WHERE user_id = ?').all(user.id) as (Row & { key: string })[]
  return Object.fromEntries(rows.map((r) => [r.key, entry(r)]))
}

/** Saves `value` unless the stored copy is newer than `base` (the version the browser last saw). */
export function writeState(user: User, key: string, body: { value?: unknown; base?: number; writeId?: unknown }): StateEntry & { conflict?: boolean } {
  if (!KEY.test(key)) throw new HttpError(400, 'Bad key')
  if (body.value === undefined) throw new HttpError(400, 'Missing value')
  const db = database()
  const current = db.prepare('SELECT value, updated_at, write_id FROM state WHERE user_id = ? AND key = ?').get(user.id, key) as Row | undefined
  if (current && typeof body.base === 'number' && current.updated_at > body.base) {
    return { ...entry(current), conflict: true }
  }
  const writeId = typeof body.writeId === 'string' && WRITE_ID.test(body.writeId) ? body.writeId : null
  if (!current) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM state WHERE user_id = ?').get(user.id) as { n: number }
    if (n >= MAX_KEYS) throw new HttpError(400, 'Too many keys')
  }
  const text = JSON.stringify(body.value)
  checkRoom(user, text.length - (current?.value.length ?? 0))
  const updatedAt = Math.max(Date.now(), (current?.updated_at ?? 0) + 1)
  db.prepare('INSERT INTO state (user_id, key, value, updated_at, write_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, write_id = excluded.write_id').run(
    user.id,
    key,
    text,
    updatedAt,
    writeId,
  )
  return { value: body.value, updatedAt, ...(writeId ? { writeId } : {}) }
}
