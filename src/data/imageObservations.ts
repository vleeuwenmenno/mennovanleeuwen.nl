import { IMAGE_PRESETS } from './imageModels.ts'

// Image observations ("learnings") as fields to show, read from what server/agentImageLearning.ts
// stores: the structured image_learning JSON when the server has it, or the memory text it writes
// next to it ("Image learning · profile 3 · vision · <task>" / "Interpretation (not verified): …" /
// "Evidence #12: …" / "Image: <uuid>" / "Recorded settings: {…}"). A row that fits neither keeps its
// raw text, and only then is that text shown. Shared by the server route and the Memory view.

export type ObservationSource = 'user_feedback' | 'vision' | 'suggestion'
export type ObservationHires = { base_width: number | null; base_height: number | null; width: number | null; height: number | null; denoise: number | null; seed: number | null; steps: number | null; cfg: number | null; sampler: string; scheduler: string; upscale_model: string }
export type ObservationSettings = { operation?: 'generate' | 'upscale' | 'refine'; upscale_model?: string; denoise?: number | null; hires?: ObservationHires; preset: string; model: string; clip: string; vae: string; steps: number | null; cfg: number | null; sampler: string; scheduler: string; width: number | null; height: number | null; seed: number | null; loras: { name: string; weight: number }[] }
export type Observation = {
  id: number
  profileId: number | null
  source: ObservationSource | null
  task: string
  note: string
  /** The exact words the note rests on: the user's message or the vision model's analysis. Empty for a guess. */
  quote: string
  messageId: number | null
  imageId: string | null
  settings: ObservationSettings | null
  prompt: string
  negativePrompt: string
  threadId: string | null
  createdAt: number
  updatedAt: number
  /** Saved against the ComfyUI connected now; null when the row does not say. */
  currentBackend: boolean | null
  /** The picture is still there (its thread was not deleted); null when not checked. */
  imageAvailable: boolean | null
  /** Set only when the row could not be read as an observation. */
  raw?: string
}

/** A style profile as the overview shows it: what it holds, when it last changed, who pins it. */
export type ObservationProfile = { id: number; name: string; description: string; origin: 'user' | 'suggestion'; observations: number; lastTouched: number; threads: { id: string; title: string }[]; threadCount: number }
/** GET /api/agents/images/observations: the newest `limit` observations of `total`, and every profile. */
export type ObservationsView = { observations: Observation[]; total: number; limit: number; unfiled: number; profiles: ObservationProfile[] }

export const OBSERVATION_SOURCES: { id: ObservationSource; label: string; detail: string }[] = [
  { id: 'user_feedback', label: 'Yours', detail: 'From what you said about the picture' },
  { id: 'vision', label: 'Vision', detail: 'From what a vision model saw in the picture' },
  { id: 'suggestion', label: 'Agent’s own guess', detail: 'The agent’s own idea, with no evidence behind it' },
]
export const sourceLabel = (s: ObservationSource | null) => OBSERVATION_SOURCES.find((x) => x.id === s)?.label ?? 'Unknown source'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isSource = (v: unknown): v is ObservationSource => v === 'user_feedback' || v === 'vision' || v === 'suggestion'
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

/** Recorded generation settings, reduced to what is shown; the prompt is split off. */
function readSettings(value: unknown): { settings: ObservationSettings | null; prompt: string; negativePrompt: string } {
  const s = obj(value)
  if (!s) return { settings: null, prompt: '', negativePrompt: '' }
  const h = obj(s.hires)
  const hires: ObservationHires | undefined = h ? { base_width: num(h.base_width), base_height: num(h.base_height), width: num(h.width), height: num(h.height), denoise: num(h.denoise), seed: num(h.seed), steps: num(h.steps), cfg: num(h.cfg), sampler: str(h.sampler), scheduler: str(h.scheduler), upscale_model: str(h.upscale_model) } : undefined
  const loras = Array.isArray(s.loras) ? s.loras.flatMap((l) => { const o = obj(l); return o && typeof o.name === 'string' ? [{ name: o.name, weight: num(o.weight) ?? 1 }] : [] }) : []
  return {
    settings: { operation: s.operation === 'upscale' ? 'upscale' : s.operation === 'refine' ? 'refine' : 'generate', upscale_model: str(s.upscale_model), denoise: num(s.denoise), ...(hires ? { hires } : {}), preset: str(s.preset), model: str(s.model), clip: str(s.clip), vae: str(s.vae), steps: num(s.steps), cfg: num(s.cfg), sampler: str(s.sampler), scheduler: str(s.scheduler), width: num(s.width), height: num(s.height), seed: num(s.seed), loras },
    prompt: str(s.prompt),
    negativePrompt: str(s.negative_prompt),
  }
}

type Row = { id: number; threadId: string | null; createdAt: number; updatedAt: number | null }
const base = (row: Row) => ({ id: row.id, threadId: row.threadId, createdAt: row.createdAt, updatedAt: row.updatedAt ?? row.createdAt, currentBackend: null, imageAvailable: null })

/** The structured record (agent_memories.image_learning). Null when it is not one. */
export function observationFromLearning(row: Row, data: unknown): (Observation & { scope: string }) | null {
  const l = obj(data)
  const source = obj(l?.source)
  if (!l || !source || !isSource(source.kind) || typeof l.task !== 'string' || typeof l.note !== 'string') return null
  const artifact = str(l.artifactId)
  return { ...base(row), profileId: num(l.profileId), source: source.kind, task: l.task, note: l.note, quote: str(source.quote), messageId: num(source.messageId), imageId: UUID.test(artifact) ? artifact : null, ...readSettings(l.settings), scope: str(l.scope) }
}

const TEXT = /^Image learning · profile (\d+|none) · (\w+) · ([\s\S]*?)\nInterpretation \(not verified\): ([\s\S]*?)\nEvidence #(\d+|none): ([\s\S]*?)\nImage: ([^\n]*)\nRecorded settings: ([\s\S]*)$/

/** The memory text the server writes for an observation. Null when the text does not have that shape. */
export function observationFromText(row: Row, text: string): Observation | null {
  const m = TEXT.exec(text.trim())
  if (!m || !isSource(m[2])) return null
  let settings: unknown = null
  try { settings = JSON.parse(m[8]) } catch { /* settings hand-edited away: the rest still reads */ }
  const image = m[7].trim()
  return {
    ...base(row),
    profileId: m[1] === 'none' ? null : Number(m[1]),
    source: m[2],
    task: m[3].trim(),
    note: m[4].trim(),
    quote: m[2] === 'suggestion' ? '' : m[6].trim(),
    messageId: m[5] === 'none' ? null : Number(m[5]),
    imageId: UUID.test(image) ? image : null,
    ...readSettings(settings),
  }
}

/** Structured record first, then the text, then the raw text as the last resort. */
export function readObservation(row: Row, text: string, data?: string | null): Observation & { scope?: string } {
  if (data) {
    try {
      const parsed = observationFromLearning(row, JSON.parse(data))
      if (parsed) return parsed
    } catch { /* fall through to the text */ }
  }
  return observationFromText(row, text) ?? { ...base(row), profileId: null, source: null, task: '', note: '', quote: '', messageId: null, imageId: null, settings: null, prompt: '', negativePrompt: '', raw: text }
}

/** "Krea2/Turbo/model.safetensors" → "model". */
export const fileTitle = (path: string) => path.split(/[\\/]/).pop()!.replace(/\.(safetensors|ckpt|gguf|pt|pth|bin)$/i, '')
export const presetTitle = (preset: string) => IMAGE_PRESETS.find((p) => p.id === preset)?.title ?? preset

/** "Krea2 Turbo · 8 steps · CFG 1 · euler_ancestral/beta · model · detail 0.8, style 1". */
export function settingsLine(s: ObservationSettings | null): string {
  if (!s) return ''
  if (s.operation === 'upscale') return ['Upscale', s.upscale_model ? fileTitle(s.upscale_model) : 'Unknown upscale model', s.width !== null && s.height !== null && `${s.width} × ${s.height}`].filter(Boolean).join(' · ')
  return [
    s.operation === 'refine' && 'Refine',
    s.operation === 'refine' && s.denoise != null && `strength ${s.denoise}`,
    s.preset && presetTitle(s.preset),
    s.steps !== null && `${s.steps} steps`,
    s.cfg !== null && `CFG ${s.cfg}`,
    (s.sampler || s.scheduler) && [s.sampler, s.scheduler].filter(Boolean).join('/'),
    s.model && fileTitle(s.model),
    s.loras.length > 0 && s.loras.map((l) => `${fileTitle(l.name)} ${l.weight}`).join(', '),
    s.upscale_model && `upscaler ${fileTitle(s.upscale_model)}`,
    s.hires && ['Hires', s.hires.base_width !== null && s.hires.base_height !== null && `${s.hires.base_width} × ${s.hires.base_height}`, s.hires.width !== null && s.hires.height !== null && `to ${s.hires.width} × ${s.hires.height}`, s.hires.denoise !== null && `strength ${s.hires.denoise}`, s.hires.steps !== null && `${s.hires.steps} steps`, s.hires.cfg !== null && `CFG ${s.hires.cfg}`, [s.hires.sampler, s.hires.scheduler].filter(Boolean).join('/'), s.hires.upscale_model && fileTitle(s.hires.upscale_model), s.hires.seed !== null && `seed ${s.hires.seed}`].filter(Boolean).join(' · '),
  ].filter(Boolean).join(' · ')
}

/** What the model filter groups by: the workflow and the model file. */
export const modelKey = (o: Observation) => (o.settings ? o.settings.operation === 'upscale' ? `upscale|${o.settings.upscale_model ?? ''}` : `${o.settings.hires ? 'hires|' : o.settings.operation === 'refine' ? 'refine|' : ''}${o.settings.preset}|${o.settings.model}${o.settings.hires ? `|${o.settings.hires.upscale_model}` : ''}` : '')

export type ObservationFilter = { profile: number | 'none' | 'all'; source: ObservationSource | 'all'; model: string; query: string }
export const NO_FILTER: ObservationFilter = { profile: 'all', source: 'all', model: '', query: '' }
export function matchesObservation(o: Observation, f: ObservationFilter): boolean {
  if (f.profile !== 'all' && (f.profile === 'none' ? o.profileId !== null : o.profileId !== f.profile)) return false
  if (f.source !== 'all' && o.source !== f.source) return false
  if (f.model && modelKey(o) !== f.model) return false
  const q = f.query.trim().toLowerCase()
  return !q || `${o.task}\n${o.note}\n${o.raw ?? ''}`.toLowerCase().includes(q)
}
