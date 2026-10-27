import type { User } from './auth.ts'
import { appSetting, database } from './db.ts'
import { HttpError } from './http.ts'

// How much of the database each account takes up, now that anyone can sign up: synced desktop
// state, Agents threads (with their attachments), generated images and memories. The most one
// account may hold is the admin's setting in Settings → Users (server/admin.ts), else
// USER_STORAGE_MB (default 2048, 2 GB); reads and deletes keep working when it is full.

const DEFAULT_LIMIT_MB = 2048

/** The most one account may store, in MB: the admin's setting, else USER_STORAGE_MB, else 2048. */
export function limitMb(): number {
  const set = Number(appSetting('user_storage_mb') ?? process.env.USER_STORAGE_MB)
  return Number.isInteger(set) && set > 0 ? set : DEFAULT_LIMIT_MB
}

/** The limit as it is written: `2 GB`, `500 MB`. */
export const limitLabel = () => (limitMb() >= 1024 ? `${Math.round((limitMb() / 1024) * 10) / 10} GB` : `${limitMb()} MB`)

const limit = () => limitMb() * 1024 * 1024

/** Bytes this account stores, about: the length of every stored text. */
export function usedBytes(userId: number): number {
  const db = database()
  const one = (sql: string) => (db.prepare(sql).get(userId) as { n: number | null }).n ?? 0
  return (
    one('SELECT SUM(LENGTH(value) + LENGTH(key)) AS n FROM state WHERE user_id = ?') +
    one('SELECT SUM(LENGTH(a.source_id) + 16) AS n FROM agent_image_source_aliases a JOIN agent_messages m ON m.id = a.message_id JOIN agent_threads t ON t.id = m.thread_id WHERE t.user_id = ?') +
    one(`SELECT SUM(LENGTH(m.content) + IFNULL(LENGTH(m.thinking), 0) + IFNULL(LENGTH(m.tool_calls), 0) + IFNULL(LENGTH(m.attachments), 0)) AS n
         FROM agent_messages m JOIN agent_threads t ON t.id = m.thread_id WHERE t.user_id = ?`) +
    one('SELECT SUM(LENGTH(m.body) + IFNULL(LENGTH(CAST(m.details AS BLOB)), 0)) AS n FROM agent_image_masks m JOIN agent_threads t ON t.id = m.thread_id WHERE t.user_id = ?') +
    one('SELECT SUM(LENGTH(i.body) + IFNULL(LENGTH(i.metadata), 0)) AS n FROM agent_images i JOIN agent_threads t ON t.id = i.thread_id WHERE t.user_id = ?') +
    one('SELECT SUM(LENGTH(body) + LENGTH(prompt) + LENGTH(slug)) AS n FROM agent_icons WHERE user_id = ?') +
    one('SELECT SUM(LENGTH(body) + LENGTH(source_url) + IFNULL(LENGTH(page_url), 0) + LENGTH(title)) AS n FROM agent_found_images WHERE user_id = ?') +
    one('SELECT SUM(LENGTH(text) + LENGTH(category) + IFNULL(LENGTH(image_learning), 0) + IFNULL(LENGTH(image_profile), 0)) AS n FROM agent_memories WHERE user_id = ?')
  )
}

/** Refuses a save of about `adding` more bytes when the account would go over its limit. */
export function checkRoom(user: User, adding: number) {
  if (usedBytes(user.id) + adding > limit()) throw new HttpError(413, `Your storage is full (${limitLabel()}): delete old threads or attachments first`)
}
