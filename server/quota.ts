import type { User } from './auth.ts'
import { database } from './db.ts'
import { HttpError } from './http.ts'

// How much of the database each account takes up, now that anyone can sign up: synced desktop
// state, Agents threads (with their attachments) and memories. USER_STORAGE_MB (default 200)
// is the most one account may hold; reads and deletes keep working when it is full.

const limit = () => Math.max(1, Number(process.env.USER_STORAGE_MB) || 200) * 1024 * 1024

/** Bytes this account stores, about: the length of every stored text. */
export function usedBytes(userId: number): number {
  const db = database()
  const one = (sql: string) => (db.prepare(sql).get(userId) as { n: number | null }).n ?? 0
  return (
    one('SELECT SUM(LENGTH(value) + LENGTH(key)) AS n FROM state WHERE user_id = ?') +
    one(`SELECT SUM(LENGTH(m.content) + IFNULL(LENGTH(m.thinking), 0) + IFNULL(LENGTH(m.tool_calls), 0) + IFNULL(LENGTH(m.attachments), 0)) AS n
         FROM agent_messages m JOIN agent_threads t ON t.id = m.thread_id WHERE t.user_id = ?`) +
    one('SELECT SUM(LENGTH(i.body) + IFNULL(LENGTH(i.metadata), 0)) AS n FROM agent_images i JOIN agent_threads t ON t.id = i.thread_id WHERE t.user_id = ?') +
    one('SELECT SUM(LENGTH(text) + LENGTH(category)) AS n FROM agent_memories WHERE user_id = ?')
  )
}

/** Refuses a save of about `adding` more bytes when the account would go over its limit. */
export function checkRoom(user: User, adding: number) {
  if (usedBytes(user.id) + adding > limit()) throw new HttpError(413, `Your storage is full (${Math.round(limit() / 1024 / 1024)} MB): delete old threads or attachments first`)
}
