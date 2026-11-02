import type { User } from './auth.ts'
import { appSetting, database } from './db.ts'
import { HttpError } from './http.ts'

// How much of the database each account takes up, now that anyone can sign up: synced desktop
// state, Agents threads (with their attachments), generated images and memories, and the Video
// Studio's videos (files on disk, counted by their size). The most one
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

/**
 * The eleven stores an account's quota counts, each one query: `n` is its bytes, about (the
 * length of every stored text, in characters, and of every blob, in bytes; so a picture kept as
 * base64 counts as its base64), `c` how many there are. These are the quota's own sums: usedBytes,
 * Settings → Users (server/admin.ts), checkRoom and Settings → Sync's breakdown all add up exactly
 * these and nothing else. `files` splits the messages' attachments out of the messages' sum.
 */
const AGGREGATES = [
  ['settings', 'SELECT SUM(LENGTH(value) + LENGTH(key)) AS n, COUNT(*) AS c FROM state WHERE user_id = ?'],
  ['references', 'SELECT SUM(LENGTH(a.source_id) + 16) AS n, COUNT(*) AS c FROM agent_image_source_aliases a JOIN agent_messages m ON m.id = a.message_id JOIN agent_threads t ON t.id = m.thread_id WHERE t.user_id = ?'],
  ['messages', `SELECT SUM(LENGTH(m.content) + IFNULL(LENGTH(m.thinking), 0) + IFNULL(LENGTH(m.tool_calls), 0) + IFNULL(LENGTH(m.attachments), 0)) AS n, COUNT(*) AS c,
       SUM(IFNULL(LENGTH(m.attachments), 0)) AS files, COUNT(m.attachments) AS fc
       FROM agent_messages m JOIN agent_threads t ON t.id = m.thread_id WHERE t.user_id = ?`],
  ['masks', 'SELECT SUM(LENGTH(m.body) + IFNULL(LENGTH(CAST(m.details AS BLOB)), 0)) AS n, COUNT(*) AS c FROM agent_image_masks m JOIN agent_threads t ON t.id = m.thread_id WHERE t.user_id = ?'],
  ['images', 'SELECT SUM(LENGTH(i.body) + IFNULL(LENGTH(i.metadata), 0)) AS n, COUNT(*) AS c FROM agent_images i JOIN agent_threads t ON t.id = i.thread_id WHERE t.user_id = ?'],
  ['icons', 'SELECT SUM(LENGTH(body) + LENGTH(prompt) + LENGTH(slug)) AS n, COUNT(*) AS c FROM agent_icons WHERE user_id = ?'],
  ['found', 'SELECT SUM(LENGTH(body) + LENGTH(source_url) + IFNULL(LENGTH(page_url), 0) + LENGTH(title)) AS n, COUNT(*) AS c FROM agent_found_images WHERE user_id = ?'],
  ['memories', 'SELECT SUM(LENGTH(text) + LENGTH(category) + IFNULL(LENGTH(image_learning), 0) + IFNULL(LENGTH(image_profile), 0)) AS n, COUNT(*) AS c FROM agent_memories WHERE user_id = ?'],
  // The Video Studio: its projects and keyframes in the database, and its videos as files on disk (their recorded size).
  ['projects', 'SELECT SUM(LENGTH(data) + LENGTH(title)) AS n, COUNT(*) AS c FROM agent_video_projects WHERE user_id = ?'],
  ['keyframes', 'SELECT SUM(LENGTH(body)) AS n, COUNT(*) AS c FROM agent_video_sources WHERE user_id = ?'],
  ['videos', 'SELECT SUM(bytes + LENGTH(settings)) AS n, COUNT(*) AS c FROM agent_videos WHERE user_id = ?'],
] as const

type Store = (typeof AGGREGATES)[number][0]
type Row = { n: number | null; c: number; files?: number | null; fc?: number }
/** One store's sum: null when it could not be read (`strict` throws instead, as the quota must). */
type Measured = { store: Store; bytes: number | null; count: number | null; files?: { bytes: number; count: number } }

function measure(userId: number, strict: boolean): Measured[] {
  const db = database()
  return AGGREGATES.map(([store, sql]) => {
    try {
      const r = db.prepare(sql).get(userId) as unknown as Row
      return { store, bytes: r.n ?? 0, count: r.c ?? 0, ...(store === 'messages' ? { files: { bytes: r.files ?? 0, count: r.fc ?? 0 } } : {}) }
    } catch (e) {
      if (strict) throw e
      return { store, bytes: null, count: null }
    }
  })
}

/** Bytes this account stores, about: the length of every stored text. */
export function usedBytes(userId: number): number {
  return measure(userId, true).reduce((sum, m) => sum + m.bytes!, 0)
}

/** What Settings → Sync shows for each part, in this order; never a stored key, value or path. */
const PARTS = [
  { id: 'settings', store: 'settings', label: 'Desktop and app settings', purpose: 'Your synced desktop, dock, notes, launchers and app settings', unit: 'items' },
  { id: 'messages', store: 'messages', label: 'Agents conversations', purpose: 'Messages, thinking and tool calls in your Agents threads', unit: 'messages' },
  { id: 'files', store: 'messages', label: 'Files in conversations', purpose: 'Pictures and files sent in Agents threads, and gpt-image pictures, kept as text', unit: 'messages with files' },
  { id: 'images', store: 'images', label: 'Generated pictures', purpose: 'Pictures made with ComfyUI in Agents and Image Studio, and pictures uploaded to Image Studio', unit: 'pictures' },
  { id: 'masks', store: 'masks', label: 'Selection masks', purpose: 'Areas drawn to change part of a picture', unit: 'masks' },
  { id: 'references', store: 'references', label: 'Picture references', purpose: 'Links that let a thread use an earlier picture again', unit: 'references' },
  { id: 'icons', store: 'icons', label: 'Icon library', purpose: 'Icons drawn with gpt-image', unit: 'icons' },
  { id: 'found', store: 'found', label: 'Found pictures', purpose: 'Pictures from the web that Agents kept', unit: 'pictures' },
  { id: 'memories', store: 'memories', label: 'Agents memories', purpose: 'What Agents remembers about you, and your picture preferences', unit: 'memories' },
  { id: 'projects', store: 'projects', label: 'Video projects', purpose: 'Video Studio projects and their timelines', unit: 'projects' },
  { id: 'keyframes', store: 'keyframes', label: 'Video keyframes', purpose: 'Pictures used as frames in Video Studio', unit: 'pictures' },
  { id: 'videos', store: 'videos', label: 'Videos', purpose: 'Video Studio clips, kept as files on the server', unit: 'videos' },
] as const

export type StoragePart = { id: (typeof PARTS)[number]['id']; label: string; purpose: string; unit: string; bytes: number | null; count: number | null }
/** `used`/`remaining` are null when a part could not be read (unknown, never zero). */
export type StorageReport = { used: number | null; limit: number; remaining: number | null; over: boolean; complete: boolean; parts: StoragePart[] }

/**
 * The signed-in account's storage, as its quota counts it, from one read of the database (all
 * eleven sums see the same moment). Over the limit, `used` is still the real figure; `remaining`
 * is never below zero.
 */
export function storageReport(userId: number): StorageReport {
  const db = database()
  const own = !db.isTransaction
  if (own) db.exec('BEGIN')
  let measured: Measured[]
  try { measured = measure(userId, false) } finally { if (own) db.exec('ROLLBACK') }
  const of = (store: Store) => measured.find((m) => m.store === store)!
  const parts: StoragePart[] = PARTS.map((p) => {
    const m = of(p.store)
    const files = p.store === 'messages' ? m.files : undefined
    const bytes = m.bytes === null ? null : p.id === 'files' ? files!.bytes : p.id === 'messages' ? m.bytes - files!.bytes : m.bytes
    const count = m.count === null ? null : p.id === 'files' ? files!.count : m.count
    return { id: p.id, label: p.label, purpose: p.purpose, unit: p.unit, bytes, count }
  })
  const complete = measured.every((m) => m.bytes !== null)
  const used = complete ? measured.reduce((sum, m) => sum + m.bytes!, 0) : null
  const max = limit()
  return { used, limit: max, remaining: used === null ? null : Math.max(0, max - used), over: used !== null && used > max, complete, parts }
}

/** Bytes the account can still store before its limit. */
export const roomLeft = (userId: number) => Math.max(0, limit() - usedBytes(userId))

/** Refuses a save of about `adding` more bytes when the account would go over its limit. */
export function checkRoom(user: User, adding: number) {
  if (usedBytes(user.id) + adding > limit()) throw new HttpError(413, `Your storage is full (${limitLabel()}): delete old threads or attachments first`)
}
