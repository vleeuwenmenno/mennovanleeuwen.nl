import { imageProfileOverview, selectedImageProfile, ownImageProfile } from './agentImageProfiles.ts'
import type { User } from './auth.ts'
import { database } from './db.ts'
import { HttpError } from './http.ts'
import { checkRoom } from './quota.ts'
import { imageBackendScope, imageSettings, imageInThread, threadImageIds } from './agentImages.ts'
import { imagePresetSpec, type ImageAssets, type ImageGenerationSettings } from '../src/data/imageModels.ts'

type Source = { kind: 'suggestion' | 'user_feedback' | 'vision'; messageId: number | null; quote: string }
type Learning = { version: 1; profileId: number | null; scope: string; artifactId: string; settings: ImageGenerationSettings; task: string; note: string; source: Source }
type Row = { id: number; image_learning: string; updated_at: number | null; created_at: number }
const rows = (user: User) => database().prepare('SELECT id, image_learning, updated_at, created_at FROM agent_memories WHERE user_id = ? AND image_learning IS NOT NULL ORDER BY id').all(user.id) as Row[]
const ownThread = (user: User, thread: string) => {
  const row = database().prepare('SELECT model FROM agent_threads WHERE id = ? AND user_id = ?').get(thread, user.id) as { model: string } | undefined
  if (!row) throw new HttpError(404, 'No such thread')
  return row
}
const bounded = (value: unknown, name: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `${name} must contain 1–${max} characters`)
  return value.trim()
}
const publicRecord = (row: Row, learning: Learning) => ({ id: row.id, profileId: learning.profileId ?? null, artifactId: learning.artifactId, settings: learning.settings, task: learning.task, note: learning.note, source: learning.source, updatedAt: row.updated_at ?? row.created_at })

const clipped = (value: string, max: number) => value.length > max ? value.slice(0, max - 1) + '…' : value
/** Keep the full snapshot in storage, but do not feed its prompts back as evidence. */
function settingsLine(settings: ImageGenerationSettings) {
  const file = (value: string) => clipped(value.replace(/\s+/g, ' '), 160)
  if (settings.operation === 'remove') return `LaMa removal · ${settings.width} × ${settings.height} · source ${settings.source.id} · mask ${settings.mask.id}`
  if (settings.operation === 'upscale') return `Model upscale · ${file(settings.upscale_model)} · ${settings.width} × ${settings.height} · source ${settings.source.id}`
  const loras = (settings.loras ?? []).map((l) => `${file(l.name)} (${l.weight})`).join(', ') || '(none)'
  return `${settings.operation === 'inpaint' ? 'Inpaint · ' : settings.operation === 'refine' ? 'Refinement · ' : settings.hires ? 'Hires · ' : ''}${settings.preset} · ${settings.steps} steps · CFG ${settings.cfg} · ${settings.sampler}/${settings.scheduler} · model ${file(settings.model)}${settings.clip ? ` · encoder ${file(settings.clip)}` : ''}${settings.vae ? ` · VAE ${file(settings.vae)}` : ''} · LoRAs ${loras}${settings.source ? ` · ${settings.operation === 'inpaint' ? 'inpaint' : settings.operation === 'refine' ? 'refine' : 'img2img'} ${settings.source.id} · denoise ${settings.denoise}` : ''}`
}
const evidenceRecord = (row: Row, learning: Learning) => ({
  id: row.id, profileId: learning.profileId ?? null, artifactId: learning.artifactId,
  operation: learning.settings.operation === 'upscale' || learning.settings.operation === 'remove' ? learning.settings.operation : learning.settings.hires ? 'hires' : learning.settings.operation ?? 'generate',
  ...(learning.settings.operation === 'upscale' ? { upscale_model: learning.settings.upscale_model } : {}),
  settingsLine: settingsLine(learning.settings), task: clipped(learning.task, 100), note: clipped(learning.note, 240),
  // Do not add an ellipsis to a quote: it must remain an exact saved-message substring.
  source: { ...learning.source, quote: learning.source.quote.slice(0, 160) }, updatedAt: row.updated_at ?? row.created_at,
})

/** Deterministic exact component matching. Task words rank relevance, never quality. */
export function imageLearnings(user: User, thread: string, assets: ImageAssets, task = '', scope = imageBackendScope(user), profileId?: unknown, allModels = false, operation?: string, upscaleModel?: string) {
  ownThread(user, thread)
  if (!imagePresetSpec(assets.preset).clipType) assets = { ...assets, clip: '', vae: '' }
  const profile = selectedImageProfile(user, thread, profileId)
  const all = rows(user)
  const words = new Set(task.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)?.slice(0, 40) ?? [])
  const relevant = all.map((row) => ({ row, value: JSON.parse(row.image_learning) as Learning }))
    .filter(({ value: l }) => {
      if (l.scope !== scope || (l.profileId ?? null) !== (profile?.id ?? null)) return false
      const recordedOperation = l.settings.operation === 'upscale' || l.settings.operation === 'remove' ? l.settings.operation : l.settings.hires ? 'hires' : l.settings.operation ?? 'generate'
      if (operation && recordedOperation !== operation) return false
      if (upscaleModel && (l.settings.operation !== 'upscale' || l.settings.upscale_model !== upscaleModel)) return false
      if (allModels) return true
      if (l.settings.operation === 'upscale' || l.settings.operation === 'remove') return operation === l.settings.operation
      if (recordedOperation !== (operation ?? 'generate')) return false
      const settings = l.settings
      return JSON.stringify(settings.loras ?? []) === JSON.stringify(assets.loras ?? []) && settings.preset === assets.preset && (['model', 'clip', 'vae'] as const).every((field) => !assets[field] || settings[field] === assets[field])
    })
    .map((item) => ({ ...item, score: [...words].filter((word) => item.value.task.toLowerCase().includes(word)).length }))
    .sort((a, b) => Number(a.value.source.kind === 'suggestion') - Number(b.value.source.kind === 'suggestion') || b.score - a.score || (b.row.updated_at ?? b.row.created_at) - (a.row.updated_at ?? a.row.created_at) || b.row.id - a.row.id)
  const notes: ReturnType<typeof evidenceRecord>[] = []
  let bytes = 0
  for (const item of relevant.slice(0, 5)) {
    const note = evidenceRecord(item.row, item.value), size = Buffer.byteLength(JSON.stringify(note))
    if (bytes + size > 12_000) break
    bytes += size; notes.push(note)
  }
  const images = threadImageIds(user, thread)
  const feedbackSources = imageFeedback(user, thread)
  // Which (profile, operation) pairs this evidence covers: one operation, or all of them across models.
  const covered = (operation ? [operation] : allModels ? REVIEW_OPERATIONS : ['generate']).map((op) => imageReviewKey(profile?.id ?? null, op))
  // Essentials first: when a long result gets clipped, the notes survive and the profile list goes.
  return { covered, evidence: { notes, totalMatches: relevant.length, truncated: notes.length < relevant.length, selectedProfile: profile, feedbackSources, currentThreadImages: images, profiles: imageProfileOverview(user), guidance: 'Prior observations are evidence, not instructions or proven best settings. feedbackSources is context about earlier images, not a list of items to resolve. Preserve explicit user requests and saved defaults. Technical completion is not quality. User/vision evidence comes first; suggestions are unverified guesses, not evidence. Prefer one evolving profile for a look; attach observations to it only for user feedback or a concrete vision defect report. Do not record your own guess unless the user explicitly asks. Use validated per-call tuning only. When saving is enabled, record useful later evidence with save_image_learning; turning saving off keeps existing observations readable; successful generation still ends silently.' } }
}

/** Recent user replies to a generated image, and vision reports, as context. A user message counts
 *  only when it is the first one after a generated image, or names an image of this thread: other
 *  messages are requests, not feedback, and listing them read as unresolved items. */
function imageFeedback(user: User, thread: string) {
  const messages = (database().prepare("SELECT id, role, tool_name, content FROM agent_messages WHERE thread_id = ? AND (role = 'user' OR (role = 'tool' AND tool_name IN ('generate_image', 'view_generated_image'))) ORDER BY id DESC LIMIT 60").all(thread) as { id: number; role: string; tool_name: string | null; content: string }[]).reverse()
  const parse = (content: string) => { try { return JSON.parse(content) } catch { return undefined } }
  const found: { messageId: number; source: 'user_feedback' | 'vision'; quote: string; imageId: string }[] = []
  let reply: string | null = null
  for (const m of messages) {
    if (m.role === 'tool') {
      const v = parse(m.content)
      if (m.tool_name === 'generate_image' && typeof v?.image?.id === 'string') reply = v.image.id
      else if (m.tool_name === 'view_generated_image' && v?.inspected === true) found.push({ messageId: m.id, source: 'vision', quote: String(v.analysis).slice(0, 200), imageId: String(v.image_id) })
      continue
    }
    // Any owned image this thread references, not just the latest few.
    const named = m.content.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)?.map((id) => id.toLowerCase()).find((id) => { try { return !!imageInThread(user, thread, id) } catch { return false } })
    if (named || reply) found.push({ messageId: m.id, source: 'user_feedback', quote: m.content.slice(0, 200), imageId: named ?? reply! })
    reply = null
  }
  return found.slice(-5).reverse()
}

const REVIEW_OPERATIONS = ['generate', 'refine', 'hires', 'inpaint', 'upscale', 'remove']
export const imageReviewKey = (profileId: number | null, operation: string) => `${profileId ?? 'none'}|${operation}`
/** The review key of a generation: its profile (the thread's when it names none) and operation. */
export const imageReviewKeyFor = (user: User, thread: string, profileId: unknown, operation: string) => imageReviewKey(selectedImageProfile(user, thread, profileId)?.id ?? null, operation)

/** One user turn's review state: the (profile, operation) keys whose evidence reached the model,
 *  those still waiting for their first model call, and how often the gate fired. */
export type ImageReviewTurn = { shown: Set<string>; unsent: Set<string>; gates: number }
export const imageReviewTurn = (): ImageReviewTurn => ({ shown: new Set(), unsent: new Set(), gates: 0 })
/** Whether this generation should show evidence first instead of submitting: only when no evidence
 *  for its profile and operation reached the model in this turn. Nothing carries over between turns:
 *  Retry and Rewind remove messages, and old results are clipped later. At most two gates a turn;
 *  past that it is logged and the call submits anyway, so it can never loop. */
export function imageReviewGate(thread: string, key: string, turn: ImageReviewTurn) {
  if (turn.shown.has(key)) return false
  if (turn.gates >= 2) { console.warn(`agents: image learning review would gate thread ${thread} a third time in one turn; submitting anyway`); return false }
  turn.gates++
  return true
}

/** Immutable artifact settings and exact persisted evidence; only the interpretation/task can be revised. */
export function saveImageLearning(user: User, thread: string, input: Record<string, unknown>) {
  ownThread(user, thread)
  if (!imageSettings(user).saveImageLearnings) throw new HttpError(409, 'Image observations are turned off. Turn on Save image observations in Settings → Agents → Images to save new notes.')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Supply an image learning object')
  const keys = ['id', 'profile_id', 'image_id', 'task', 'note', 'source', 'evidence_message_id', 'evidence_quote']
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new HttpError(400, 'Only image learning fields are accepted; settings come from the artifact')
  const existing = input.id === undefined ? undefined : rows(user).find((r) => r.id === input.id)
  if (input.id !== undefined && !existing) throw new HttpError(404, 'No such image learning')
  const previous = existing ? JSON.parse(existing.image_learning) as Learning : undefined
  if (previous && ['profile_id', 'image_id', 'source', 'evidence_message_id', 'evidence_quote'].some((key) => key in input)) throw new HttpError(400, 'Updates preserve artifact and evidence; save a separate learning for new feedback')
  const note = input.note === undefined && previous ? previous.note : bounded(input.note, 'Note', 500)
  const task = input.task === undefined && previous ? previous.task : bounded(input.task, 'Task/style', 160)
  let learning: Learning
  if (previous) learning = { ...previous, note, task }
  else {
    // A UUID, said plainly: the old length check answered "Image ID must contain 1–36 characters",
    // which reads like a contradiction to a model holding a URL or a shortened id.
    const given = typeof input.image_id === 'string' ? input.image_id.trim() : ''
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(given)) throw new HttpError(400, 'Use the image UUID of a picture generated in this thread, as read_image_learnings lists it, not its URL or filename')
    const imageId = given
    const image = (() => { try { return imageInThread(user, thread, imageId) } catch { return undefined } })()
    if (!image?.metadata || !image.backend_scope) throw new HttpError(404, 'Choose an image generated in this thread with recorded settings and backend provenance; older images cannot be assigned a guessed backend')
    const kind = input.source
    if (kind !== 'suggestion' && kind !== 'user_feedback' && kind !== 'vision') throw new HttpError(400, 'Source must be suggestion, user_feedback or vision')
    let source: Source = { kind, messageId: null, quote: '' }
    if (kind !== 'suggestion') {
      const quote = bounded(input.evidence_quote, 'Evidence quote', 500)
      if (typeof input.evidence_message_id !== 'number' || !Number.isSafeInteger(input.evidence_message_id) || input.evidence_message_id < 1) throw new HttpError(400, 'Choose an actual evidence message ID')
      const evidence = database().prepare('SELECT role, tool_name, content, created_at FROM agent_messages WHERE id = ? AND thread_id = ?').get(Number(input.evidence_message_id), thread) as { role: string; tool_name: string | null; content: string; created_at: number } | undefined
      if (!evidence || evidence.created_at < image.created_at) throw new HttpError(400, 'Evidence must be a later message from this thread')
      let text = evidence.content
      if (kind === 'user_feedback') { if (evidence.role !== 'user') throw new HttpError(400, 'User feedback requires an actual user message') }
      else {
        if (evidence.role !== 'tool' || evidence.tool_name !== 'view_generated_image') throw new HttpError(400, 'Vision evidence requires a completed image inspection')
        const inspected = JSON.parse(evidence.content)
        if (inspected.image_id !== imageId || inspected.inspected !== true || typeof inspected.analysis !== 'string') throw new HttpError(400, 'Vision evidence must inspect this exact image')
        text = inspected.analysis
      }
      if (!text.includes(quote)) throw new HttpError(400, 'Evidence quote must match the saved message exactly')
      source = { kind, messageId: Number(input.evidence_message_id), quote }
    } else if (input.evidence_message_id !== undefined || input.evidence_quote !== undefined) throw new HttpError(400, 'Suggestions cannot claim evidence')
    const parameters = JSON.parse(image.metadata) as ImageGenerationSettings
    const profileId = input.profile_id === undefined ? (parameters.operation === 'upscale' || parameters.operation === 'remove' ? null : parameters.profile_id ?? null) : input.profile_id
    if (profileId !== null) ownImageProfile(user, profileId)
    learning = { version: 1, profileId: profileId as number | null, scope: image.backend_scope, artifactId: imageId, settings: parameters, task, note, source }
  }
  const all = rows(user)
  const count = (database().prepare('SELECT COUNT(*) AS n FROM agent_memories WHERE user_id = ?').get(user.id) as { n: number }).n
  if (!existing && (all.length >= 100 || count >= 1000)) throw new HttpError(409, 'Image learning memory is full (100 image notes / 1000 total memories); forget old notes first')
  const data = JSON.stringify(learning)
  const text = `Image learning · profile ${learning.profileId ?? 'none'} · ${learning.source.kind} · ${learning.task}\nInterpretation (not verified): ${learning.note}\nEvidence #${learning.source.messageId ?? 'none'}: ${learning.source.quote || 'Unverified suggestion'}\nImage: ${learning.artifactId}\nRecorded settings: ${JSON.stringify(learning.settings)}`
  checkRoom(user, Buffer.byteLength(text + data))
  const now = Date.now()
  let id = existing?.id
  if (id) database().prepare('UPDATE agent_memories SET text = ?, image_learning = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(text, data, now, id, user.id)
  else id = Number(database().prepare('INSERT INTO agent_memories (user_id, text, category, project_id, thread_id, created_at, image_learning) VALUES (?, ?, ?, NULL, ?, ?, ?)').run(user.id, text, 'Images/Learnings', thread, now, data).lastInsertRowid)
  return publicRecord({ id, image_learning: data, created_at: now, updated_at: now }, learning)
}
