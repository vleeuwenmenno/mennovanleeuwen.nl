import { randomUUID } from 'node:crypto'
import type { User } from './auth.ts'
import { database } from './db.ts'
import { HttpError } from './http.ts'
import { checkRoom } from './quota.ts'
import { imageSource, type ImageSource } from './agentImageSources.ts'
import { validateInpaintMask, type MaskStats } from './agentImageInpaint.ts'

const UUID = /^[0-9a-f-]{36}$/
// A mask stays live while any owned artifact or tool call references it. Rewind may remove
// the call, but a generated artifact still needs its mask for Again.
const referenced = `(EXISTS (SELECT 1 FROM agent_images i JOIN agent_threads t ON t.id = i.thread_id
  WHERE t.user_id = ? AND json_extract(CASE WHEN json_valid(i.metadata) THEN i.metadata ELSE '{}' END, '$.mask.id') = m.id)
  OR EXISTS (SELECT 1 FROM agent_messages x JOIN agent_threads t ON t.id = x.thread_id, json_each(CASE WHEN json_valid(x.tool_calls) THEN x.tool_calls ELSE '[]' END) c
  WHERE t.user_id = ? AND json_extract(c.value, '$.arguments.mask_id') = m.id))`
// Editor drafts abandoned by interrupted clients stay bounded at 8 a thread. Masks the agent made
// are the thread's mask history (listed and shown in the chat), so far more of them are kept.
const KEEP = { editor: 7, auto: 39 } as const
function pruneDrafts(user: User, thread: string, origin: 'editor' | 'auto' = 'editor') {
  const db = database()
  const drafts = db.prepare(`SELECT m.id FROM agent_image_masks m WHERE m.thread_id = ? AND m.origin = ? AND NOT ${referenced} ORDER BY m.created_at DESC, m.rowid DESC LIMIT -1 OFFSET ${KEEP[origin]}`).all(thread, origin, user.id, user.id) as { id: string }[]
  for (const draft of drafts) db.prepare('DELETE FROM agent_image_masks WHERE id = ?').run(draft.id)
}
export function discardImageMask(user: User, id: string) {
  const db = database()
  if (!db.prepare('SELECT 1 FROM agent_image_masks m JOIN agent_threads t ON t.id = m.thread_id WHERE m.id = ? AND t.user_id = ?').get(id, user.id)) throw new HttpError(404, 'No such image mask')
  if (db.prepare(`SELECT 1 FROM agent_image_masks m WHERE m.id = ? AND ${referenced}`).get(id, user.id, user.id)) throw new HttpError(409, 'This mask is referenced by a generation and must be retained for repeat actions')
  db.prepare('DELETE FROM agent_image_masks WHERE id = ?').run(id)
}
export type ImageMask = ImageSource & { source_id: string; origin: string }
/** What make_image_mask selected; stored with the mask so every attempt can be listed later. */
export type AutoMaskDetails = { target: string; exclude: string; grow: number; threshold: number | null; phrases?: { phrase: string; role: 'target' | 'exclude'; coverage_percent: number }[]; coverage: number; bbox: MaskStats['bbox']; verdict: 'ok' | 'empty' | 'too_large'; source_url: string }
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
  const { width, height, coverage, bbox } = validateInpaintMask(bytes, source)
  pruneDrafts(user, thread)
  checkRoom(user, bytes.length)
  const id = randomUUID()
  database().prepare('INSERT INTO agent_image_masks(id, thread_id, source_id, body, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, thread, source.id, bytes, width, height, Date.now())
  return { id, source_image_id: source.id, url: `/api/agents/image-masks/${id}`, width, height, size: bytes.length, coverage, bbox }
}
/** A mask make_image_mask produced, kept even when empty or too large: the thread's history of attempts. */
export function saveAutoMask(user: User, thread: string, source: ImageSource, bytes: Buffer, details: Omit<AutoMaskDetails, 'coverage' | 'bbox' | 'source_url'>) {
  ownThread(user, thread)
  const { width, height, coverage, bbox } = validateInpaintMask(bytes, source, true)
  pruneDrafts(user, thread, 'auto')
  checkRoom(user, bytes.length)
  const id = randomUUID()
  const stored: AutoMaskDetails = { ...details, coverage, bbox, source_url: source.url }
  database().prepare("INSERT INTO agent_image_masks(id, thread_id, source_id, body, width, height, created_at, origin, details) VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?)").run(id, thread, source.id, bytes, width, height, Date.now(), JSON.stringify(stored))
  return { id, url: `/api/agents/image-masks/${id}`, width, height, size: bytes.length, ...stored }
}
/** `view`: serving the PNG itself, where an empty attempt is still shown; edits never accept one. */
export function imageMask(user: User, id: unknown, source?: ImageSource, view = false): ImageMask {
  if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(400, 'Choose mask_id from make_image_mask, the mask editor or list_image_masks')
  const row = database().prepare('SELECT m.* FROM agent_image_masks m JOIN agent_threads t ON t.id = m.thread_id WHERE m.id = ? AND t.user_id = ?').get(id, user.id) as { id: string; source_id: string; body: Uint8Array; width: number; height: number; origin: string } | undefined
  if (!row) throw new HttpError(404, 'No such image mask')
  if (source && source.id !== row.source_id) throw new HttpError(400, 'This mask belongs to a different source image')
  const bytes = Buffer.from(row.body)
  const { width, height, mime } = validateInpaintMask(bytes, source ?? row, view)
  return { id: row.id, source_id: row.source_id, origin: row.origin, name: 'Image edit mask', url: `/api/agents/image-masks/${row.id}`, bytes, width, height, mime }
}
/** The owned source's private address, without loading its bytes. */
function sourceUrl(user: User, id: string) {
  if (UUID.test(id)) return `/api/agents/images/${id}`
  const match = /^attachment:([1-9][0-9]{0,14}):([0-9])$/.exec(id)
  if (!match) return null
  const row = database().prepare(`SELECT m.thread_id FROM agent_messages m JOIN agent_threads t ON t.id = m.thread_id WHERE m.id = ? AND t.user_id = ?
    UNION ALL SELECT m.thread_id FROM agent_image_source_aliases a JOIN agent_messages m ON m.id = a.message_id JOIN agent_threads t ON t.id = m.thread_id WHERE a.source_id = ? AND t.user_id = ? LIMIT 1`).get(Number(match[1]), user.id, id, user.id) as { thread_id: string } | undefined
  return row ? `/api/agents/threads/${row.thread_id}/messages/${match[1]}/attachments/${match[2]}` : null
}
export function listImageMasks(user: User, thread: string, args: Record<string, unknown>) {
  if (Object.keys(args).some(k => k !== 'thread_id')) throw new HttpError(400, 'Supply only an optional owned thread_id')
  const id = args.thread_id ?? thread
  if (typeof id !== 'string') throw new HttpError(400, 'Invalid thread_id')
  ownThread(user, id)
  // Used means a saved picture was made with it, not merely that a call named it.
  const rows = database().prepare(`SELECT m.id, m.source_id, m.width, m.height, m.origin, m.details, EXISTS (SELECT 1 FROM agent_images i JOIN agent_threads t ON t.id = i.thread_id
    WHERE t.user_id = ? AND json_extract(CASE WHEN json_valid(i.metadata) THEN i.metadata ELSE '{}' END, '$.mask.id') = m.id) AS used FROM agent_image_masks m WHERE m.thread_id = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT 20`).all(user.id, id) as { id: string; source_id: string; width: number; height: number; origin: string; details: string | null; used: number }[]
  const seen = new Set<string>()
  const masks = rows.map((row) => {
    let details: Partial<AutoMaskDetails> = {}
    try { details = row.details ? JSON.parse(row.details) : {} } catch { /* An unreadable record still lists the mask itself. */ }
    // Newest first: the first mask seen for a source is its latest attempt; older unused ones were superseded.
    const latest = !seen.has(row.source_id)
    seen.add(row.source_id)
    const status = row.used ? 'used' : details.verdict === 'empty' || (details.verdict === 'too_large' && !latest) ? 'rejected' : latest ? 'ready' : 'superseded'
    return {
      mask_id: row.id, source_image_id: row.source_id, width: row.width, height: row.height, made_by: row.origin === 'auto' ? 'agent' : 'user', status,
      ...(row.origin === 'auto' ? { target: details.target, ...(details.exclude ? { exclude: details.exclude } : {}), coverage_percent: typeof details.coverage === 'number' ? Math.round(details.coverage * 1000) / 10 : undefined, bbox: details.bbox, ...(details.phrases ? { phrases: details.phrases } : {}), ...(details.verdict === 'too_large' ? { warning: 'Covered over 60% of the image' } : {}) } : {}),
      mask_url: `/api/agents/image-masks/${row.id}`, source_url: sourceUrl(user, row.source_id),
    }
  })
  return { thread_id: id, masks, guidance: 'Newest first. made_by agent are make_image_mask attempts (status used, ready, rejected or superseded); made_by user come from the mask editor. Use a mask with generate_image (operation remove or inpaint) and its matching source_image_id. White edits, black preserves. The app shows each mask as a tinted preview with Edit mask. Never invent mask IDs.' }
}

/** Keep masks referenced by artifacts that survived deletion of their originating thread. */
export function retainImageMasks(user: User, thread: string) {
  const db = database()
  const masks = db.prepare(`SELECT m.id, (SELECT i.thread_id FROM agent_images i JOIN agent_threads t ON t.id = i.thread_id
    WHERE t.user_id = ? AND t.id != m.thread_id AND json_extract(CASE WHEN json_valid(i.metadata) THEN i.metadata ELSE '{}' END, '$.mask.id') = m.id LIMIT 1) AS artifact_survivor,
    (SELECT x.thread_id FROM agent_messages x JOIN agent_threads t ON t.id = x.thread_id, json_each(CASE WHEN json_valid(x.tool_calls) THEN x.tool_calls ELSE '[]' END) c
    WHERE t.user_id = ? AND t.id != m.thread_id AND json_extract(c.value, '$.arguments.mask_id') = m.id LIMIT 1) AS call_survivor,
    (SELECT x.thread_id FROM agent_messages x JOIN agent_threads t ON t.id = x.thread_id
    WHERE t.user_id = ? AND t.id != m.thread_id AND x.role = 'tool' AND x.tool_name IN ('make_image_mask', 'list_image_masks') AND instr(x.content, m.id) > 0 LIMIT 1) AS shown_survivor
    FROM agent_image_masks m WHERE m.thread_id = ?`).all(user.id, user.id, user.id, thread) as { id: string; artifact_survivor: string | null; call_survivor: string | null; shown_survivor: string | null }[]
  for (const mask of masks) {
    // A branch that still shows the mask in its chat keeps it, so Edit mask keeps working there.
    const survivor = mask.artifact_survivor ?? mask.call_survivor ?? mask.shown_survivor
    if (survivor) db.prepare('UPDATE agent_image_masks SET thread_id = ? WHERE id = ?').run(survivor, mask.id)
  }
}
