import { api } from '../os/account'
import { synced } from '../os/synced'

// The Agents app's side of server/agents.ts: threads, a turn streamed as JSON lines, memory and
// the models Ollama Cloud offers. The shapes match the server's.

export type Mode = 'quick' | 'deep'
/** A step in the agent's plan for a long job. */
export type Todo = { text: string; status: 'pending' | 'active' | 'done' }
export type Thread = { id: string; title: string; mode: Mode; model: string; archived: boolean; createdAt: number; updatedAt: number; running: boolean; titling: boolean; contextTokens: number | null; tools: ToolGroup[]; projectId: number | null; pinned: boolean; todos: Todo[] }
/** A group of threads in the sidebar, with a memory of its own. */
export type Project = { id: number; name: string; sort: number; createdAt: number }
export type ToolCall = { name: string; arguments: Record<string, unknown> }
/** A file sent with a message: text files as text, pictures as base64 (for models that can see). */
export type Attachment = { name: string; source: string; kind: 'text' | 'image'; mime: string; size: number; text?: string; data?: string }
export type AttachmentInfo = Omit<Attachment, 'text' | 'data'>
export type AgentMessage = { id: number; role: 'user' | 'assistant' | 'tool'; content: string; thinking?: string; toolCalls?: ToolCall[]; toolName?: string; attachments?: AttachmentInfo[]; createdAt: number }

/** What a thread may use, switched in the composer. */
export type ToolGroup = 'web' | 'notes' | 'code' | 'seafile' | 'seafile_write' | 'memory' | 'projects'
export const TOOL_GROUPS: { id: ToolGroup; name: string; detail: string; seafile?: boolean }[] = [
  { id: 'web', name: 'Web', detail: 'Search the web and read pages' },
  { id: 'notes', name: 'Notes', detail: 'Search your notes' },
  { id: 'code', name: 'Code hosts', detail: 'Repositories, issues and pull requests' },
  { id: 'seafile', name: 'Seafile', detail: 'Find and read files', seafile: true },
  { id: 'seafile_write', name: 'Seafile changes', detail: 'Folders, writing, renaming, moving, deleting; asks you first', seafile: true },
  { id: 'memory', name: 'Memory', detail: 'Remember what you tell it' },
  { id: 'projects', name: 'Projects', detail: 'Make and rename projects, move this thread; asks you first' },
]
export const ALL_TOOLS = TOOL_GROUPS.map((g) => g.id)
/** The groups there were before choices remembered which groups existed. */
const LEGACY_TOOLS: ToolGroup[] = ['web', 'notes', 'code', 'seafile', 'seafile_write', 'memory']
/** About the owner (projectId null) or one project, filed under a category path like "People/Friends". */
export type Memory = { id: number; text: string; category: string; projectId: number | null; threadId: string | null; createdAt: number; updatedAt: number | null }
export type ModelInfo = { name: string; thinking: boolean; vision: boolean; contextLength: number | null }

/**
 * A form from the agent's ask_user. Each question has a type the window draws (and any other type
 * falls back to a text field), so the set can grow one type at a time on both sides.
 */
export type QuestionType = 'choice' | 'multi' | 'confirm' | 'text' | 'number' | 'scale' | 'date' | 'info'
export type Option = { value: string; label: string; hint?: string }
export type Question = {
  id: string
  type: QuestionType | string
  label: string
  hint?: string
  options?: Option[]
  allowOther?: boolean
  min?: number
  max?: number
  step?: number
  minLabel?: string
  maxLabel?: string
  unit?: string
  placeholder?: string
  multiline?: boolean
  required?: boolean
  default?: unknown
}
export type Form = { title: string; intro?: string; questions: Question[]; submit?: string }

/** Something the agent waits on: a change to allow, or a form to answer; which reply asked and which call. */
export type PendingApproval = { callId: string; messageId: number; index: number; kind: 'approval' | 'question'; form?: Form }

export type TurnEvent =
  | { type: 'approval'; callId: string; messageId: number; index: number }
  | { type: 'approved'; callId: string; allow: boolean }
  | { type: 'question'; callId: string; messageId: number; index: number; form: Form }
  | { type: 'answered'; callId: string }
  | { type: 'delta'; content?: string; thinking?: string }
  | { type: 'message'; message: AgentMessage }
  | { type: 'thread'; thread: Thread }
  | { type: 'error'; error: string }
  | { type: 'done' }

export const listThreads = (archived: boolean) => api<Thread[]>(`/api/agents/threads${archived ? '?archived=1' : ''}`)
export const createThread = (input: { mode: Mode; model?: string; tools?: ToolGroup[]; projectId?: number | null }) => api<Thread>('/api/agents/threads', { method: 'POST', json: input })
export const getThread = (id: string) => api<{ thread: Thread; messages: AgentMessage[]; pending: PendingApproval[] }>(`/api/agents/threads/${id}`)
export const answerForm = (id: string, callId: string, answers: Record<string, unknown> | null) =>
  api(`/api/agents/threads/${id}/answer`, { method: 'POST', json: answers ? { callId, answers } : { callId, skip: true } })
export const answerApproval = (id: string, callId: string, allow: boolean) => api(`/api/agents/threads/${id}/approve`, { method: 'POST', json: { callId, allow } })
export const updateThread = (id: string, patch: Partial<Pick<Thread, 'title' | 'archived' | 'mode' | 'model' | 'tools' | 'pinned' | 'projectId'>>) => api<Thread>(`/api/agents/threads/${id}`, { method: 'PATCH', json: patch })
export const deleteThread = (id: string) => api(`/api/agents/threads/${id}`, { method: 'DELETE' })
export const stopThread = (id: string) => api(`/api/agents/threads/${id}/stop`, { method: 'POST' })
export const suggestTitle = (id: string) => api<{ title: string | null }>(`/api/agents/threads/${id}/title`, { method: 'POST' })

export type ContextPart = { label: string; tokens: number }
export type ContextInfo = { model: string; contextLength: number | null; measured: number | null; estimate: number; parts: ContextPart[] }
export const getContext = (id: string) => api<ContextInfo>(`/api/agents/threads/${id}/context`)

export type PromptInfo = { text: string; source: 'seafile' | 'builtin'; repo: string | null; path: string | null; missing: boolean; error: string | null }
export const getDefaults = () => api<{ quick: string; deep: string; title: string }>('/api/agents/defaults')
export const getPrompt = (fresh = false) => api<PromptInfo>(`/api/agents/prompt${fresh ? '?fresh' : ''}`)

/**
 * The app's own settings, synced (and read by the server): the model that names threads, and where
 * ~/AGENTS.md is in Seafile when Seafile is home.
 */
export type AgentSettings = {
  titleModel: string | null
  /** The model a new Quick or Deep thread gets (null: the usual one) */
  quickModel: string | null
  deepModel: string | null
  /** The mode a new thread starts in */
  mode: Mode
  promptFile: { repo: string; path: string } | null
  /** The tools a new thread starts with */
  tools: ToolGroup[]
  /** The tool groups there were when `tools` was last saved: any newer one starts switched on */
  seenTools: ToolGroup[]
}
const settingsStore = synced<AgentSettings>('agents', { titleModel: null, quickModel: null, deepModel: null, mode: 'quick', promptFile: null, tools: ALL_TOOLS, seenTools: ALL_TOOLS }, {
  normalize: (v) => {
    const s = (v ?? {}) as Partial<AgentSettings>
    return {
      titleModel: typeof s.titleModel === 'string' ? s.titleModel : null,
      quickModel: typeof s.quickModel === 'string' ? s.quickModel : null,
      deepModel: typeof s.deepModel === 'string' ? s.deepModel : null,
      mode: s.mode === 'deep' ? 'deep' : 'quick',
      promptFile: s.promptFile && typeof s.promptFile.repo === 'string' && typeof s.promptFile.path === 'string' ? s.promptFile : null,
      // Groups added since the choice was saved are on, like every group is for someone new.
      tools: Array.isArray(s.tools) ? ALL_TOOLS.filter((t) => s.tools!.includes(t) || !(Array.isArray(s.seenTools) ? s.seenTools : LEGACY_TOOLS).includes(t)) : ALL_TOOLS,
      seenTools: ALL_TOOLS,
    }
  },
})
export const useAgentSettings = settingsStore.use
export const agentSettings = settingsStore.get
export const setAgentSettings = (patch: Partial<AgentSettings>) => settingsStore.set((s) => ({ ...s, ...patch }))

/** "12.3k" */
export const tokenCount = (n: number) => (n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`)

export const listMemories = () => api<Memory[]>('/api/agents/memories')
export const deleteMemory = (id: number) => api(`/api/agents/memories/${id}`, { method: 'DELETE' })
export const addMemory = (input: { text: string; category?: string; projectId?: number | null }) => api<Memory>('/api/agents/memories', { method: 'POST', json: input })
export const updateMemory = (id: number, patch: Partial<Pick<Memory, 'text' | 'category' | 'projectId'>>) => api<Memory>(`/api/agents/memories/${id}`, { method: 'PATCH', json: patch })

export const listProjects = () => api<Project[]>('/api/agents/projects')
export const createProject = (name: string) => api<Project>('/api/agents/projects', { method: 'POST', json: { name } })
export const renameProject = (id: number, name: string) => api<Project>(`/api/agents/projects/${id}`, { method: 'PATCH', json: { name } })
export const orderProjects = (ids: number[]) => api<Project[]>('/api/agents/projects/order', { method: 'PUT', json: { ids } })
export const deleteProject = (id: number) => api(`/api/agents/projects/${id}`, { method: 'DELETE' })

let modelList: Promise<ModelInfo[]> | null = null
/** Ollama's cloud models that can use tools; asked once per page. */
export function agentModels(): Promise<ModelInfo[]> {
  modelList ??= api<ModelInfo[]>('/api/agents/models').catch((e) => {
    modelList = null
    throw e
  })
  return modelList
}

/**
 * Sends the owner's message and reads the answer as it streams: each JSON line is one event.
 * Aborting `signal` stops the turn on the server too.
 */
export async function sendMessage(id: string, text: string, attachments: Attachment[], onEvent: (e: TurnEvent) => void, signal: AbortSignal) {
  const res = await fetch(`/api/agents/threads/${id}/messages`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, attachments }),
    signal,
  })
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `Request failed (${res.status})`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) onEvent(JSON.parse(line) as TurnEvent)
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as TurnEvent)
}

const size = (n: number) => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** What a tool call did, in a few words, for its card. */
export function toolLabel(call: ToolCall): string {
  const a = call.arguments ?? {}
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  switch (call.name) {
    case 'web_search':
      return `Searched the web for “${s('query')}”`
    case 'web_fetch':
      return `Read ${s('url').replace(/^https?:\/\/(www\.)?/, '').slice(0, 80)}`
    case 'remember': {
      const n = Array.isArray(a.items) ? a.items.length : 1
      return n > 1 ? `Saved ${n} memories` : 'Saved to memory'
    }
    case 'update_memory':
      return `Updated memory #${String(a.id ?? '')}`
    case 'ask_user':
      return `Asked: ${s('title') || 'a question'}`
    case 'list_projects':
      return 'Looked at your projects'
    case 'create_project':
      return `Made the project “${s('name')}”`
    case 'rename_project':
      return `Renamed project ${s('project')} to “${s('name')}”`
    case 'move_thread':
      return !s('project') || /^none$/i.test(s('project')) ? 'Moved this thread out of its project' : `Moved this thread to ${s('project')}`
    case 'update_todos': {
      const items = Array.isArray(a.items) ? (a.items as { status?: string }[]) : []
      return `Updated the plan: ${items.filter((t) => t.status === 'done').length}/${items.length} done`
    }
    case 'search_notes':
      return `Searched notes for “${s('query')}”`
    case 'search_code':
      return `Searched code for “${s('query')}”`
    case 'seafile_list':
      return s('library') ? `Listed ${s('library')}${s('path') && s('path') !== '/' ? ` ${s('path')}` : ''}` : 'Listed Seafile libraries'
    case 'seafile_read':
      return `Read ${s('path').split('/').pop() || s('path')} in ${s('library')}`
    case 'seafile_search':
      return `Searched ${s('library') || 'Seafile'} for “${s('query')}”`
    case 'seafile_mkdir':
      return `Make folder ${s('path')} in ${s('library')}`
    case 'seafile_write':
      return `${a.overwrite === true ? 'Replace' : 'Write'} ${s('path')} in ${s('library')} (${size(new TextEncoder().encode(s('content')).length)})`
    case 'seafile_rename':
      return `Rename ${s('path')} in ${s('library')} to ${s('name')}`
    case 'seafile_move':
      return `${a.copy === true ? 'Copy' : 'Move'} ${s('path')} in ${s('library')} to ${s('to_folder')}${s('to_library') ? ` in ${s('to_library')}` : ''}`
    case 'seafile_delete':
      return `Delete ${s('path')} in ${s('library')}`
    default:
      return call.name
  }
}

// --- reading files to attach ------------------------------------------------------------------

const MAX_TEXT = 1024 * 1024
const MAX_IMAGE = 5 * 1024 * 1024
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|toml|x-sh|sql|csv))/
const TEXT_NAMES = /\.(md|markdown|txt|csv|tsv|json|ya?ml|toml|ini|conf|cfg|log|xml|html?|css|s?js|jsx|tsx?|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|fish|zsh|sql|lua|swift|r|tex|env|gitignore|dockerfile)$/i

const base64 = (buf: ArrayBuffer) => {
  let bin = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** A file (from this computer or fetched from Seafile) as an attachment: text, or a picture. */
export async function toAttachment(blob: Blob, name: string, source: string): Promise<Attachment> {
  const mime = blob.type || ''
  // PDFs go in as their text, read here with pdf.js (loaded only now), page by page.
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) {
    if (blob.size > 40 * 1024 * 1024) throw new Error(`${name} is over 40 MB`)
    const { pdfText } = await import('./pdfjs')
    let read
    try {
      read = await pdfText(await blob.arrayBuffer())
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`)
    }
    const note = read.read < read.pages ? `\n\n[only the first ${read.read} of ${read.pages} pages were read]` : ''
    const text = read.text.length > 390_000 ? `${read.text.slice(0, 390_000)}\n\n[the rest of the PDF was left out: it is too long]` : read.text + note
    return { name, source, kind: 'text', mime: 'application/pdf', size: blob.size, text }
  }
  if (/^image\/(png|jpe?g|webp|gif)$/.test(mime) || /\.(png|jpe?g|webp|gif)$/i.test(name)) {
    if (blob.size > MAX_IMAGE) throw new Error(`${name} is over 5 MB`)
    return { name, source, kind: 'image', mime: mime || 'image/png', size: blob.size, data: base64(await blob.arrayBuffer()) }
  }
  if (blob.size > MAX_TEXT) throw new Error(`${name} is over 1 MB; text files, PDFs and pictures can be attached`)
  const text = await blob.text()
  if (!(TEXT_TYPES.test(mime) || TEXT_NAMES.test(name) || !mime) || text.slice(0, 8000).includes('\u0000')) throw new Error(`${name} is not a text file, PDF or picture`)
  return { name, source, kind: 'text', mime: mime || 'text/plain', size: blob.size, text }
}

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
