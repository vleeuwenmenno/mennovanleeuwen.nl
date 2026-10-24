import type { IncomingMessage, ServerResponse } from 'node:http'
import type { User } from './auth.ts'
import { database } from './db.ts'
import { json } from './http.ts'
import { imageProfiles } from './agentImageProfiles.ts'
import { imageBackendScope } from './agentImages.ts'
import { readObservation, type ObservationsView } from '../src/data/imageObservations.ts'

// Read-only overview of the account's image observations and style profiles, for the
// Observations panel (src/apps/AgentsObservations.tsx). Saving, revising and deleting stay with
// server/agentImageLearning.ts, server/agentImageProfiles.ts and the memory routes.

/** Newest first; the server keeps at most 100 per account today, so this is room to spare. */
export const OBSERVATIONS_LIMIT = 200
/** Threads named per profile; the count says how many there are in all. */
const THREADS_PER_PROFILE = 20


type MemoryRow = { id: number; text: string; image_learning: string | null; thread_id: string | null; created_at: number; updated_at: number | null }

export function imageObservations(user: User): ObservationsView {
  const db = database()
  const rows = db.prepare('SELECT id, text, image_learning, thread_id, created_at, updated_at FROM agent_memories WHERE user_id = ? AND image_learning IS NOT NULL ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT ?').all(user.id, OBSERVATIONS_LIMIT) as MemoryRow[]
  const total = (db.prepare('SELECT COUNT(*) AS n FROM agent_memories WHERE user_id = ? AND image_learning IS NOT NULL').get(user.id) as { n: number }).n
  let scope = ''
  try { scope = imageBackendScope(user) } catch { /* no ComfyUI settings readable: every row says "unknown" */ }
  const read = rows.map((r) => readObservation({ id: r.id, threadId: r.thread_id, createdAt: r.created_at, updatedAt: r.updated_at }, r.text, r.image_learning))
  const ids = [...new Set(read.flatMap((o) => (o.imageId ? [o.imageId] : [])))]
  const present = new Set(ids.length ? (db.prepare(`SELECT i.id FROM agent_images i JOIN agent_threads t ON t.id = i.thread_id WHERE t.user_id = ? AND i.id IN (${ids.map(() => '?').join(',')})`).all(user.id, ...ids) as { id: string }[]).map((r) => r.id) : [])
  const observations = read.map(({ scope: own, ...o }) => ({ ...o, currentBackend: own && scope ? own === scope : null, imageAvailable: o.imageId ? present.has(o.imageId) : null }))

  // Counts and last activity over every observation, not just the newest LIMIT.
  const stats = new Map((db.prepare("SELECT json_extract(image_learning, '$.profileId') AS profile, COUNT(*) AS n, MAX(COALESCE(updated_at, created_at)) AS at FROM agent_memories WHERE user_id = ? AND image_learning IS NOT NULL GROUP BY profile").all(user.id) as { profile: number | null; n: number; at: number }[]).map((r) => [r.profile, r]))
  const touched = new Map((db.prepare('SELECT id, COALESCE(updated_at, created_at) AS at FROM agent_memories WHERE user_id = ? AND image_profile IS NOT NULL').all(user.id) as { id: number; at: number }[]).map((r) => [r.id, r.at]))
  const pins = db.prepare('SELECT id, title, image_profile_id AS profile FROM agent_threads WHERE user_id = ? AND image_profile_id IS NOT NULL ORDER BY updated_at DESC').all(user.id) as { id: string; title: string; profile: number }[]
  const profiles = imageProfiles(user).map((p) => {
    const using = pins.filter((t) => t.profile === p.id)
    return { ...p, observations: stats.get(p.id)?.n ?? 0, lastTouched: Math.max(touched.get(p.id) ?? 0, stats.get(p.id)?.at ?? 0), threads: using.slice(0, THREADS_PER_PROFILE).map(({ id, title }) => ({ id, title })), threadCount: using.length }
  })
  return { observations, total, limit: OBSERVATIONS_LIMIT, unfiled: stats.get(null)?.n ?? 0, profiles }
}

export function handleImageObservationsApi(req: IncomingMessage, res: ServerResponse, user: User, path: string) {
  if (path !== '/api/agents/images/observations' || (req.method !== 'GET' && req.method !== 'HEAD')) return false
  json(res, 200, imageObservations(user))
  return true
}
