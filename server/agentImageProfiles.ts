import type { User } from './auth.ts'
import { database } from './db.ts'
import { HttpError, json, readJson } from './http.ts'
import { checkRoom } from './quota.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

export type ImageProfile = { id: number; name: string; description: string; origin: 'user' | 'suggestion' }
export function imageProfiles(user: User): ImageProfile[] {
  return (database().prepare('SELECT id, image_profile FROM agent_memories WHERE user_id = ? AND image_profile IS NOT NULL ORDER BY id').all(user.id) as { id: number; image_profile: string }[]).map((r) => ({ id: r.id, ...JSON.parse(r.image_profile) }))
}
export function ownImageProfile(user: User, id: unknown) {
  const profile = imageProfiles(user).find((p) => p.id === id)
  if (!profile) throw new HttpError(404, 'No such image profile')
  return profile
}
export function selectedImageProfile(user: User, thread: string, override?: unknown): ImageProfile | null {
  const row = database().prepare('SELECT image_profile_id FROM agent_threads WHERE id = ? AND user_id = ?').get(thread, user.id) as { image_profile_id: number | null } | undefined
  if (!row) throw new HttpError(404, 'No such thread')
  const id = override === undefined ? row.image_profile_id : override
  return id === null ? null : ownImageProfile(user, id)
}
export function pinImageProfile(user: User, thread: string, id: unknown) {
  selectedImageProfile(user, thread)
  if (id !== null) ownImageProfile(user, id)
  database().prepare('UPDATE agent_threads SET image_profile_id = ? WHERE id = ? AND user_id = ?').run(id as number | null, thread, user.id)
  return selectedImageProfile(user, thread)
}
export function saveImageProfile(user: User, input: Record<string, unknown>, agent = false): ImageProfile {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Supply a profile object')
  if (Object.keys(input).some((k) => !['id', 'name', 'description'].includes(k))) throw new HttpError(400, 'Only profile id, name and description are supported')
  const old = input.id === undefined ? undefined : ownImageProfile(user, input.id)
  if (agent && old?.origin === 'user') throw new HttpError(409, 'User-confirmed profile preferences cannot be overwritten by the agent. Record a separate suggestion or ask the user to edit the profile.')
  const name = input.name ?? old?.name, description = input.description ?? old?.description
  if (typeof name !== 'string' || !name.trim() || name.length > 60 || typeof description !== 'string' || description.length > 400) throw new HttpError(400, 'Use a profile name of 1–60 characters and preferences up to 400 characters')
  const profiles = imageProfiles(user)
  if (profiles.some((p) => p.id !== old?.id && p.name.toLowerCase() === name.trim().toLowerCase())) throw new HttpError(409, 'An image profile already has that name')
  const count = (database().prepare('SELECT COUNT(*) AS n FROM agent_memories WHERE user_id = ?').get(user.id) as { n: number }).n
  if (!old && (profiles.length >= 20 || count >= 1000)) throw new HttpError(409, 'Profile memory is full (20 profiles / 1000 total memories)')
  const profile = { name: name.trim(), description: description.trim(), origin: agent ? 'suggestion' as const : 'user' as const }
  const data = JSON.stringify(profile), text = `Image profile · ${profile.name} · ${profile.origin}\n${profile.description}`
  checkRoom(user, Buffer.byteLength(data + text))
  let id = old?.id
  if (id) database().prepare('UPDATE agent_memories SET text = ?, image_profile = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(text, data, Date.now(), id, user.id)
  else id = Number(database().prepare('INSERT INTO agent_memories (user_id, text, category, created_at, image_profile) VALUES (?, ?, ?, ?, ?)').run(user.id, text, 'Images/Profiles', Date.now(), data).lastInsertRowid)
  return { id, ...profile }
}
export function forgetImageProfile(user: User, id: unknown, reset = false) {
  ownImageProfile(user, id)
  const db = database()
  db.exec('BEGIN')
  try {
    db.prepare("DELETE FROM agent_memories WHERE user_id = ? AND image_learning IS NOT NULL AND json_extract(image_learning, '$.profileId') = ?").run(user.id, id as number)
    if (!reset) {
      db.prepare('UPDATE agent_threads SET image_profile_id = NULL WHERE user_id = ? AND image_profile_id = ?').run(user.id, id as number)
      db.prepare('DELETE FROM agent_memories WHERE user_id = ? AND id = ?').run(user.id, id as number)
    }
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
}
export async function handleImageProfileApi(req: IncomingMessage, res: ServerResponse, user: User, path: string) {
  if (path === '/api/agents/image-profiles') {
    if (req.method === 'GET') return json(res, 200, imageProfiles(user)), true
    if (req.method === 'POST') return json(res, 200, saveImageProfile(user, await readJson(req, 4096))), true
  }
  const thread = /^\/api\/agents\/image-profiles\/threads\/([0-9a-f-]{36})$/.exec(path)
  if (thread) {
    if (req.method === 'GET') return json(res, 200, { profile: selectedImageProfile(user, thread[1]) }), true
    if (req.method === 'PUT') {
      const body = await readJson<Record<string, unknown>>(req, 1024)
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'id') || !('id' in body)) throw new HttpError(400, 'Supply only a profile id or null')
      return json(res, 200, { profile: pinImageProfile(user, thread[1], body.id) }), true
    }
  }
  const match = /^\/api\/agents\/image-profiles\/(\d+)(\/reset)?$/.exec(path)
  if (match && req.method === 'DELETE') return forgetImageProfile(user, Number(match[1]), !!match[2]), json(res, 200, { ok: true }), true
  return false
}
