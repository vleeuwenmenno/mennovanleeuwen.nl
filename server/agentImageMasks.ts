import { randomUUID } from 'node:crypto'
import type { User } from './auth.ts'
import { database } from './db.ts'
import { HttpError } from './http.ts'
import { checkRoom } from './quota.ts'
import { imageSource, type ImageSource } from './agentImageSources.ts'
import { validateInpaintMask } from './agentImageInpaint.ts'

const UUID = /^[0-9a-f-]{36}$/
export type ImageMask = ImageSource & { source_id: string }
function ownThread(user: User, thread: string) {
  if (!database().prepare('SELECT 1 FROM agent_threads WHERE id = ? AND user_id = ?').get(thread, user.id)) throw new HttpError(404, 'No such thread')
}
export function saveImageMask(user: User, thread: string, input: { source_image_id?: unknown; data?: unknown }) {
  ownThread(user, thread)
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['source_image_id', 'data'].includes(k))) throw new HttpError(400, 'Supply source_image_id and a PNG mask')
  const source = imageSource(user, input.source_image_id)
  if (typeof input.data !== 'string' || input.data.length > Math.ceil(8 * 1024 * 1024 / 3) * 4) throw new HttpError(413, 'Mask must be at most 8 MiB')
  if (input.data.length % 4 || /[^A-Za-z0-9+/=]/.test(input.data)) throw new HttpError(400, 'Invalid base64 mask')
  const bytes = Buffer.from(input.data, 'base64')
  if (bytes.toString('base64') !== input.data) throw new HttpError(400, 'Invalid base64 mask')
  const { width, height } = validateInpaintMask(bytes, source)
  checkRoom(user, bytes.length)
  const id = randomUUID()
  database().prepare('INSERT INTO agent_image_masks(id, thread_id, source_id, body, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, thread, source.id, bytes, width, height, Date.now())
  return { id, source_image_id: source.id, url: `/api/agents/image-masks/${id}`, width, height, size: bytes.length }
}
export function imageMask(user: User, id: unknown, source?: ImageSource): ImageMask {
  if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(400, 'Choose mask_id from the mask editor or list_image_masks')
  const row = database().prepare('SELECT m.* FROM agent_image_masks m JOIN agent_threads t ON t.id = m.thread_id WHERE m.id = ? AND t.user_id = ?').get(id, user.id) as { id: string; source_id: string; body: Uint8Array; width: number; height: number } | undefined
  if (!row) throw new HttpError(404, 'No such image mask')
  if (source && source.id !== row.source_id) throw new HttpError(400, 'This mask belongs to a different source image')
  const bytes = Buffer.from(row.body)
  const dimensions = validateInpaintMask(bytes, source ?? row)
  return { id: row.id, source_id: row.source_id, name: 'Image edit mask', url: `/api/agents/image-masks/${row.id}`, bytes, ...dimensions }
}
export function listImageMasks(user: User, thread: string, args: Record<string, unknown>) {
  if (Object.keys(args).some(k => k !== 'thread_id')) throw new HttpError(400, 'Supply only an optional owned thread_id')
  const id = args.thread_id ?? thread
  if (typeof id !== 'string') throw new HttpError(400, 'Invalid thread_id')
  ownThread(user, id)
  const masks = database().prepare('SELECT id AS mask_id, source_id AS source_image_id, width, height FROM agent_image_masks WHERE thread_id = ? ORDER BY created_at DESC LIMIT 20').all(id)
  return { thread_id: id, masks, guidance: 'Use operation inpaint with the matching source_image_id and mask_id. White edits, black preserves the resized working source. Never invent mask IDs.' }
}

/** Keep masks referenced by artifacts that survived deletion of their originating thread. */
export function retainImageMasks(user: User, thread: string) {
  const db = database()
  const masks = db.prepare(`SELECT m.id, (SELECT i.thread_id FROM agent_images i JOIN agent_threads t ON t.id = i.thread_id
    WHERE t.user_id = ? AND t.id != m.thread_id AND json_extract(CASE WHEN json_valid(i.metadata) THEN i.metadata ELSE '{}' END, '$.mask.id') = m.id LIMIT 1) AS survivor
    FROM agent_image_masks m WHERE m.thread_id = ?`).all(user.id, thread) as { id: string; survivor: string | null }[]
  for (const mask of masks) if (mask.survivor) db.prepare('UPDATE agent_image_masks SET thread_id = ? WHERE id = ?').run(mask.survivor, mask.id)
}
