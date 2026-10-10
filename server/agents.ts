import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { User } from './auth.ts'
import { database, decrypt, encrypt } from './db.ts'
import { HttpError, SECURITY } from './http.ts'
import { search as codeSearch } from './search.ts'
import { fileLink, libraries, listDir, mkdir, removeItems, rename, seafile, seafileInfo, transfer, type Library } from './seafile.ts'
import { readState } from './state.ts'
import { webSearch } from './websearch.ts'
import { AGENTS_MD } from '../src/data/agentsPrompt.ts'

// The Agents app: a research assistant on Ollama Cloud, for the signed-in owner. Threads and their
// messages live in SQLite; each turn runs here, on the server, calling Ollama's chat API with a
// small set of tools and streaming what happens to the window as JSON lines.
//
// Most tools only read: the web through Ollama's own search and fetch, the owner's notes, code
// hosts and Seafile. `remember` and `update_memory` keep the agent's memory, either about the owner
// or about the thread's project, sorted into categories; the Memory view shows and edits it.
// `update_todos` keeps a plan for long jobs, which lets a turn run for many more rounds. The Seafile tools that change something (a folder, a file written, renamed, moved or
// deleted) wait for the owner to allow each call in the window, because a page or file the
// agent read could have talked it into one. Nothing runs code.
//
// The API key comes from Settings → Integrations (stored encrypted, like updown's) or
// OLLAMA_API_KEY on the server.

// OLLAMA_URL points it elsewhere (a stand-in for testing); the real API is ollama.com.
const OLLAMA = (process.env.OLLAMA_URL || 'https://ollama.com').replace(/\/+$/, '')
const NAME = 'ollama'

// --- the key ----------------------------------------------------------------------------------

function storedKey(user: User): string | null {
  const row = database().prepare('SELECT secret FROM integrations WHERE user_id = ? AND name = ?').get(user.id, NAME) as { secret: string } | undefined
  return row ? decrypt(row.secret) : process.env.OLLAMA_API_KEY?.trim() || null
}

/** Where the key comes from, for Settings: saved there, or the server's environment. */
export const ollamaSource = (user: User): 'settings' | 'server' | null =>
  database().prepare('SELECT 1 FROM integrations WHERE user_id = ? AND name = ?').get(user.id, NAME) ? 'settings' : process.env.OLLAMA_API_KEY?.trim() ? 'server' : null

/** Checks the key with Ollama (which costs nothing), then stores it encrypted. */
export async function setOllamaKey(user: User, body: { key?: string }) {
  const key = body.key?.trim()
  if (!key) throw new HttpError(400, 'Paste an Ollama API key')
  const res = await fetch(`${OLLAMA}/api/me`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null)
  if (!res) throw new HttpError(502, 'Ollama did not answer')
  if (res.status === 401 || res.status === 403) throw new HttpError(400, 'Ollama refused that key')
  if (!res.ok) throw new HttpError(502, `Ollama answered ${res.status}`)
  database()
    .prepare('INSERT INTO integrations (user_id, name, secret, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET secret = excluded.secret')
    .run(user.id, NAME, encrypt(key), Date.now())
}

export function removeOllamaKey(user: User) {
  database().prepare('DELETE FROM integrations WHERE user_id = ? AND name = ?').run(user.id, NAME)
}

function requireKey(user: User): string {
  const key = storedKey(user)
  if (!key) throw new HttpError(409, 'Add an Ollama API key in Settings → Integrations first')
  return key
}

/** A request to Ollama's API, with its errors turned into ones the window can show. */
async function ollama(key: string, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const res = await fetch(`${OLLAMA}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }).catch((e: Error) => {
    if (signal.aborted) throw e
    throw new HttpError(502, 'Ollama did not answer')
  })
  if (res.ok) return res
  const message = ((await res.json().catch(() => null)) as { error?: string } | null)?.error
  if (res.status === 401 || res.status === 403) throw new HttpError(409, 'Ollama refused the API key: set it again in Settings → Integrations')
  if (res.status === 429) throw new HttpError(429, message || 'Ollama says the usage limit is reached for now')
  throw new HttpError(502, message ? `Ollama: ${message}` : `Ollama answered ${res.status}`)
}

// --- models ------------------------------------------------------------------------------------

export type ModelInfo = { name: string; thinking: boolean; vision: boolean; contextLength: number | null }
export type Mode = 'quick' | 'deep'

/** Picked when a thread does not say: quick wants speed, deep a stronger reasoner. */
const PREFERRED: Record<Mode, string[]> = { quick: ['glm-5.3-flash', 'deepseek-v4.1-flash', 'gpt-oss:120b'], deep: ['kimi-k3', 'glm-5.3', 'gpt-oss:120b'] }

let modelCache: { at: number; ttl: number; value: Promise<ModelInfo[]> } | null = null

/** Ollama's cloud models that can call tools, cached for an hour. The list and details are public. */
export function models(): Promise<ModelInfo[]> {
  if (modelCache && Date.now() - modelCache.at < modelCache.ttl) return modelCache.value
  const value = (async () => {
    const tags = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? (r.json() as Promise<{ models?: { name: string }[] }>) : null))
    const names = (tags?.models ?? []).map((m) => m.name)
    if (!names.length) throw new HttpError(502, 'Ollama sent no models')
    const shown = await Promise.all(
      names.map((name) =>
        fetch(`${OLLAMA}/api/show`, { method: 'POST', body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(10_000) })
          .then((r) => (r.ok ? (r.json() as Promise<{ capabilities?: string[]; model_info?: Record<string, unknown> }>) : null))
          .catch(() => null),
      ),
    )
    return names
      .map((name, i) => ({ name, caps: shown[i]?.capabilities ?? [], info: shown[i]?.model_info ?? {} }))
      .filter((m) => m.caps.includes('tools'))
      .map((m) => {
        const ctx = Object.entries(m.info).find(([k]) => k.endsWith('.context_length'))?.[1]
        return { name: m.name, thinking: m.caps.includes('thinking'), vision: m.caps.includes('vision'), contextLength: typeof ctx === 'number' ? ctx : null }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  })()
  const entry = { at: Date.now(), ttl: 3600_000, value }
  modelCache = entry
  value.catch(() => (entry.ttl = 60_000))
  return value
}

/** The model a new thread gets: the owner's pick for the mode (Settings), else a sensible one. */
async function defaultModel(mode: Mode, user?: User): Promise<string> {
  const list = await models().catch(() => [] as ModelInfo[])
  const chosen = user ? agentSettings(user)[mode === 'deep' ? 'deepModel' : 'quickModel'] : null
  if (chosen && (!list.length || list.some((m) => m.name === chosen))) return chosen
  return PREFERRED[mode].find((n) => list.some((m) => m.name === n)) ?? list[0]?.name ?? PREFERRED[mode][0]
}

/** What "Automatic" means right now, for Settings: the model each choice falls back to. */
export async function automaticModels(): Promise<{ quick: string; deep: string; title: string }> {
  const [quick, deep] = await Promise.all([defaultModel('quick'), defaultModel('deep')])
  return { quick, deep, title: quick }
}

// --- tool groups -----------------------------------------------------------------------------

/** What a thread may use, switched in the window: each group is one or more tools. */
export const TOOL_GROUPS = ['web', 'notes', 'code', 'seafile', 'seafile_write', 'memory', 'projects'] as const
export type ToolGroup = (typeof TOOL_GROUPS)[number]
const GROUP_OF: Record<string, ToolGroup> = {
  web_search: 'web',
  web_fetch: 'web',
  search_notes: 'notes',
  search_code: 'code',
  seafile_list: 'seafile',
  seafile_search: 'seafile',
  seafile_read: 'seafile',
  seafile_mkdir: 'seafile_write',
  seafile_write: 'seafile_write',
  seafile_rename: 'seafile_write',
  seafile_move: 'seafile_write',
  seafile_delete: 'seafile_write',
  remember: 'memory',
  update_memory: 'memory',
  list_projects: 'projects',
  create_project: 'projects',
  rename_project: 'projects',
  move_thread: 'projects',
}
const toolGroups = (v: unknown): ToolGroup[] | null => (Array.isArray(v) ? TOOL_GROUPS.filter((g) => v.includes(g)) : null)

// --- attachments -------------------------------------------------------------------------------

/** A file sent with a message: text goes into the prompt, a picture to models that can see. */
export type Attachment = { name: string; source: string; kind: 'text' | 'image'; mime: string; size: number; text?: string; data?: string }
export type AttachmentInfo = Omit<Attachment, 'text' | 'data'>

function checkAttachments(v: unknown): Attachment[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > 10) throw new HttpError(400, 'Up to 10 attachments')
  let total = 0
  return v.map((a: Partial<Attachment>) => {
    const name = String(a?.name ?? '').slice(0, 200) || 'file'
    const source = String(a?.source ?? '').slice(0, 300)
    if (a?.kind === 'text') {
      const text = String(a.text ?? '')
      if (text.length > 400_000) throw new HttpError(413, `${name} is too long (over 400,000 characters)`)
      total += text.length
      return { name, source, kind: 'text', mime: String(a.mime ?? 'text/plain').slice(0, 100), size: text.length, text }
    }
    if (a?.kind === 'image') {
      const data = String(a.data ?? '')
      if (!/^[A-Za-z0-9+/=]+$/.test(data)) throw new HttpError(400, `${name} is not a picture`)
      if (data.length > 7_000_000) throw new HttpError(413, `${name} is too big (over 5 MB)`)
      total += data.length
      return { name, source, kind: 'image', mime: String(a.mime ?? 'image/png').slice(0, 100), size: Math.floor((data.length * 3) / 4), data }
    }
    throw new HttpError(400, 'Attachments are text files or pictures')
  }).map((a) => {
    if (total > 14_000_000) throw new HttpError(413, 'The attachments are too big together')
    return a as Attachment
  })
}

// --- threads -----------------------------------------------------------------------------------

export type Todo = { text: string; status: 'pending' | 'active' | 'done' }
export type Thread = { id: string; title: string; mode: Mode; model: string; archived: boolean; createdAt: number; updatedAt: number; running: boolean; projectId: number | null; pinned: boolean; todos: Todo[]; /** A title is being thought of */ titling: boolean; /** Tokens the last reply took up in the model's context, as Ollama counted them */ contextTokens: number | null; /** Tool groups it may use */ tools: ToolGroup[]; /** Asked from Spotlight and not continued in the app yet */ quick: boolean }
export type ToolCall = { name: string; arguments: Record<string, unknown> }
export type AgentMessage = { id: number; role: 'user' | 'assistant' | 'tool'; content: string; thinking?: string; toolCalls?: ToolCall[]; toolName?: string; attachments?: AttachmentInfo[]; createdAt: number }

type ThreadRow = { id: string; title: string; mode: string; model: string; archived: number; created_at: number; updated_at: number; context_tokens: number | null; tools: string | null; project_id: number | null; pinned: number; todos: string | null; quick: number }
type MessageRow = { id: number; role: string; content: string; thinking: string | null; tool_calls: string | null; tool_name: string | null; attachments: string | null; created_at: number }

const NEW_TITLE = 'New thread'
const running = new Map<string, AbortController>()
const titling = new Set<string>()

/** A change waiting for the owner: which reply asked for it (message and call index) and how to answer. */
type Pending = { callId: string; messageId: number; index: number; kind: 'approval' | 'question'; form?: Form; resolve: (answer: unknown) => void }
export type PendingApproval = Omit<Pending, 'resolve'>
const pending = new Map<string, Pending[]>() // by thread
const APPROVAL_WAIT = 15 * 60_000

const toThread = (r: ThreadRow): Thread => ({ id: r.id, title: r.title, mode: r.mode === 'deep' ? 'deep' : 'quick', model: r.model, archived: !!r.archived, createdAt: r.created_at, updatedAt: r.updated_at, running: running.has(r.id), projectId: r.project_id ?? null, pinned: !!r.pinned, todos: r.todos ? (JSON.parse(r.todos) as Todo[]) : [], titling: titling.has(r.id), contextTokens: r.context_tokens ?? null, tools: (r.tools ? toolGroups(JSON.parse(r.tools)) : null) ?? [...TOOL_GROUPS], quick: !!r.quick })
const toMessage = (r: MessageRow): AgentMessage => ({
  id: r.id,
  role: r.role as AgentMessage['role'],
  content: r.content,
  ...(r.thinking ? { thinking: r.thinking } : {}),
  ...(r.tool_calls ? { toolCalls: JSON.parse(r.tool_calls) as ToolCall[] } : {}),
  ...(r.tool_name ? { toolName: r.tool_name } : {}),
  ...(r.attachments ? { attachments: (JSON.parse(r.attachments) as Attachment[]).map(({ text: _t, data: _d, ...info }) => info) } : {}),
  createdAt: r.created_at,
})

const threadId = (v: unknown) => {
  const id = String(v ?? '')
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, 'Bad thread id')
  return id
}

function ownThread(user: User, id: string): ThreadRow {
  const row = database().prepare('SELECT * FROM agent_threads WHERE id = ? AND user_id = ?').get(threadId(id), user.id) as ThreadRow | undefined
  if (!row) throw new HttpError(404, 'No such thread')
  return row
}

const modeOf = (v: unknown, fallback: Mode = 'quick'): Mode => (v === 'deep' ? 'deep' : v === 'quick' ? 'quick' : fallback)
const modelName = (v: unknown) => {
  const name = String(v ?? '').trim()
  if (!/^[\w.:/-]{1,80}$/.test(name)) throw new HttpError(400, 'Bad model name')
  return name
}

// --- projects ----------------------------------------------------------------------------------

/** A group of threads in the sidebar, in the owner's order, with a memory of its own. */
export type Project = { id: number; name: string; sort: number; createdAt: number }
type ProjectRow = { id: number; name: string; sort: number; created_at: number }
const toProject = (r: ProjectRow): Project => ({ id: r.id, name: r.name, sort: r.sort, createdAt: r.created_at })

export const listProjects = (user: User): Project[] =>
  (database().prepare('SELECT id, name, sort, created_at FROM agent_projects WHERE user_id = ? ORDER BY sort, id').all(user.id) as ProjectRow[]).map(toProject)

function ownProject(user: User, id: unknown): ProjectRow {
  const row = database().prepare('SELECT id, name, sort, created_at FROM agent_projects WHERE id = ? AND user_id = ?').get(Number(id), user.id) as ProjectRow | undefined
  if (!row) throw new HttpError(404, 'No such project')
  return row
}
/** A project id from a request: null for none, else one of the owner's. */
const projectRef = (user: User, v: unknown): number | null => (v === null || v === undefined || v === '' ? null : ownProject(user, v).id)
const projectName = (v: unknown) => {
  const name = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  if (!name) throw new HttpError(400, 'Give the project a name')
  return name
}

export function createProject(user: User, body: { name?: string }): Project {
  const { n } = database().prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM agent_projects WHERE user_id = ?').get(user.id) as { n: number }
  const r = database().prepare('INSERT INTO agent_projects (user_id, name, sort, created_at) VALUES (?, ?, ?, ?)').run(user.id, projectName(body.name), n, Date.now())
  return toProject(ownProject(user, Number(r.lastInsertRowid)))
}

export function renameProject(user: User, id: unknown, body: { name?: string }): Project {
  const row = ownProject(user, id)
  database().prepare('UPDATE agent_projects SET name = ? WHERE id = ?').run(projectName(body.name), row.id)
  return toProject(ownProject(user, row.id))
}

/** The owner's order, from dragging projects in the sidebar. */
export function orderProjects(user: User, body: { ids?: unknown }): Project[] {
  if (!Array.isArray(body.ids)) throw new HttpError(400, 'Which order?')
  const set = database().prepare('UPDATE agent_projects SET sort = ? WHERE id = ? AND user_id = ?')
  body.ids.forEach((id, i) => set.run(i, Number(id), user.id))
  return listProjects(user)
}

/** Deletes a project and its memory; its threads stay, outside any project. */
export function deleteProject(user: User, id: unknown) {
  const row = ownProject(user, id)
  const db = database()
  db.prepare('UPDATE agent_threads SET project_id = NULL WHERE project_id = ? AND user_id = ?').run(row.id, user.id)
  db.prepare('DELETE FROM agent_memories WHERE project_id = ? AND user_id = ?').run(row.id, user.id)
  db.prepare('DELETE FROM agent_projects WHERE id = ?').run(row.id)
}

export function listThreads(user: User, archived: boolean): Thread[] {
  const rows = database().prepare('SELECT * FROM agent_threads WHERE user_id = ? AND archived = ? AND quick = 0 ORDER BY updated_at DESC LIMIT 500').all(user.id, archived ? 1 : 0) as ThreadRow[]
  return rows.map(toThread)
}

/** How long Spotlight keeps a quick answer that was not continued in the app (Settings → Spotlight). */
const QUICK_KEEP: Record<string, number> = { '1h': 3600_000, '1d': 864e5, '1w': 7 * 864e5, '30d': 30 * 864e5 }
const quickKeep = (user: User): number | null => {
  const v = (readState(user).spotlight?.value ?? {}) as { answersKeep?: unknown }
  return v.answersKeep === 'never' ? null : (QUICK_KEEP[String(v.answersKeep)] ?? QUICK_KEEP['1d'])
}

export type QuickAnswer = { thread: Thread; question: string; answer: string }

/** Spotlight's recent answers, newest first; the ones older than the owner keeps them are deleted first. */
export function listQuick(user: User): QuickAnswer[] {
  const keep = quickKeep(user)
  if (keep !== null) {
    const old = database().prepare('SELECT id FROM agent_threads WHERE user_id = ? AND quick = 1 AND updated_at < ?').all(user.id, Date.now() - keep) as { id: string }[]
    for (const { id } of old) if (!running.has(id)) database().prepare('DELETE FROM agent_threads WHERE id = ?').run(id)
  }
  const rows = database().prepare('SELECT * FROM agent_threads WHERE user_id = ? AND quick = 1 ORDER BY updated_at DESC LIMIT 100').all(user.id) as ThreadRow[]
  return rows.map((r) => {
    const messages = messagesOf(r.id)
    return {
      thread: toThread(r),
      question: messages.find((m) => m.role === 'user')?.content ?? '',
      answer: messages.filter((m) => m.role === 'assistant' && m.content.trim()).map((m) => m.content.trim()).join('\n\n'),
    }
  })
}

/** Forgets every quick answer that is not answering right now. */
export function clearQuick(user: User) {
  const rows = database().prepare('SELECT id FROM agent_threads WHERE user_id = ? AND quick = 1').all(user.id) as { id: string }[]
  for (const { id } of rows) if (!running.has(id)) database().prepare('DELETE FROM agent_threads WHERE id = ?').run(id)
}

export async function createThread(user: User, body: { mode?: string; model?: string; tools?: unknown; projectId?: unknown; quick?: unknown }): Promise<Thread> {
  const mode = modeOf(body.mode)
  const project = projectRef(user, body.projectId)
  const model = body.model ? modelName(body.model) : await defaultModel(mode, user)
  const tools = toolGroups(body.tools)
  const now = Date.now()
  const id = randomUUID()
  database()
    .prepare('INSERT INTO agent_threads (id, user_id, title, mode, model, archived, created_at, updated_at, tools, project_id, quick) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)')
    .run(id, user.id, NEW_TITLE, mode, model, now, now, tools ? JSON.stringify(tools) : null, project, body.quick === true ? 1 : 0)
  return toThread(ownThread(user, id))
}

const messagesOf = (id: string) => (database().prepare('SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY id').all(id) as MessageRow[]).map(toMessage)

export function getThread(user: User, id: string): { thread: Thread; messages: AgentMessage[]; pending: PendingApproval[] } {
  const row = ownThread(user, id)
  return { thread: toThread(row), messages: messagesOf(row.id), pending: (pending.get(row.id) ?? []).map(({ resolve: _, ...p }) => p) }
}

/** The owner's answer to a change the agent asked to make. */
export function approve(user: User, id: string, body: { callId?: string; allow?: boolean }) {
  const row = ownThread(user, id)
  const list = pending.get(row.id) ?? []
  const p = list.find((x) => x.callId === body.callId && x.kind === 'approval')
  if (!p) throw new HttpError(404, 'Nothing is waiting for that')
  p.resolve(body.allow === true)
}

/** The owner's answers to a form the agent asked (or `skip`, to say no answer is coming). */
export function answer(user: User, id: string, body: { callId?: string; answers?: unknown; skip?: boolean }) {
  const row = ownThread(user, id)
  const p = (pending.get(row.id) ?? []).find((x) => x.callId === body.callId && x.kind === 'question')
  if (!p || !p.form) throw new HttpError(404, 'Nothing is waiting for that')
  if (body.skip) return p.resolve(null)
  const given = (body.answers && typeof body.answers === 'object' ? body.answers : {}) as Record<string, unknown>
  const answers: Record<string, unknown> = {}
  for (const q of p.form.questions) {
    if (q.type === 'info') continue
    const v = given[q.id]
    answers[q.id] = Array.isArray(v) ? v.slice(0, 50).map((x) => String(x).slice(0, 2000)) : typeof v === 'boolean' || typeof v === 'number' ? v : v === undefined || v === null ? null : String(v).slice(0, 4000)
  }
  p.resolve(answers)
}

/**
 * Renames, archives or unarchives, pins, moves to a project, or switches the mode, model or tools.
 * `quick: false` takes a quick answer from Spotlight into the app (there is no way back).
 */
export async function updateThread(user: User, id: string, body: { title?: string; archived?: boolean; mode?: string; model?: string; tools?: unknown; pinned?: boolean; projectId?: unknown; quick?: boolean }): Promise<Thread> {
  const row = ownThread(user, id)
  const title = body.title === undefined ? row.title : String(body.title).trim().slice(0, 120) || row.title
  const archived = body.archived === undefined ? row.archived : body.archived ? 1 : 0
  const mode = body.mode === undefined ? modeOf(row.mode) : modeOf(body.mode)
  // Switching mode without naming a model takes that mode's usual one.
  const model = body.model !== undefined ? modelName(body.model) : body.mode !== undefined && mode !== row.mode ? await defaultModel(mode, user) : row.model
  const tools = body.tools === undefined ? row.tools : JSON.stringify(toolGroups(body.tools) ?? [...TOOL_GROUPS])
  const pinned = body.pinned === undefined ? row.pinned : body.pinned ? 1 : 0
  const project = body.projectId === undefined ? row.project_id : projectRef(user, body.projectId)
  const quick = body.quick === false ? 0 : row.quick
  database().prepare('UPDATE agent_threads SET title = ?, archived = ?, mode = ?, model = ?, tools = ?, pinned = ?, project_id = ?, quick = ? WHERE id = ?').run(title, archived, mode, model, tools, pinned, project, quick, row.id)
  return toThread(ownThread(user, row.id))
}

export function deleteThread(user: User, id: string) {
  const row = ownThread(user, id)
  running.get(row.id)?.abort()
  database().prepare('DELETE FROM agent_threads WHERE id = ?').run(row.id)
}

export function stopThread(user: User, id: string) {
  running.get(ownThread(user, id).id)?.abort()
}

// --- settings, AGENTS.md and titles -----------------------------------------------------------

/**
 * The Agents app's own settings, synced like the rest of the desktop (state key "agents"): the
 * model that names threads, and where ~/AGENTS.md is in Seafile when Seafile is home (the window
 * works that out from /etc/fstab and keeps it up to date).
 */
type AgentSettings = { titleModel: string | null; quickModel: string | null; deepModel: string | null; promptFile: { repo: string; path: string } | null }

function agentSettings(user: User): AgentSettings {
  const v = (readState(user).agents?.value ?? {}) as { titleModel?: unknown; quickModel?: unknown; deepModel?: unknown; promptFile?: { repo?: unknown; path?: unknown } | null }
  const name = (x: unknown) => (typeof x === 'string' && /^[\w.:/-]{1,80}$/.test(x) ? x : null)
  const titleModel = name(v.titleModel)
  const f = v.promptFile
  const promptFile = f && typeof f.repo === 'string' && /^[0-9a-f-]{36}$/i.test(f.repo) && typeof f.path === 'string' && f.path.startsWith('/') && !f.path.split('/').includes('..') ? { repo: f.repo, path: f.path } : null
  return { titleModel, quickModel: name(v.quickModel), deepModel: name(v.deepModel), promptFile }
}

export type PromptInfo = { text: string; source: 'seafile' | 'builtin'; repo: string | null; path: string | null; missing: boolean; error: string | null }
const promptCache = new Map<number, { at: number; key: string; value: Promise<PromptInfo> }>()

/** ~/AGENTS.md: the owner's own from Seafile when home is there and it exists, else the built-in one. */
export function agentsPrompt(user: User, fresh = false): Promise<PromptInfo> {
  const { promptFile } = agentSettings(user)
  const builtin: PromptInfo = { text: AGENTS_MD, source: 'builtin', repo: promptFile?.repo ?? null, path: promptFile?.path ?? null, missing: false, error: null }
  if (!promptFile || !seafileInfo(user)) return Promise.resolve(builtin)
  const key = `${promptFile.repo}:${promptFile.path}`
  const hit = promptCache.get(user.id)
  if (!fresh && hit && hit.key === key && Date.now() - hit.at < 30_000) return hit.value
  const value = (async (): Promise<PromptInfo> => {
    try {
      const { url } = await fileLink(user, promptFile.repo, promptFile.path, 'download')
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (res.status === 404) return { ...builtin, missing: true }
      if (!res.ok) throw new Error(`Seafile answered ${res.status}`)
      const text = (await res.text()).slice(0, 64 * 1024)
      return { ...builtin, text, source: 'seafile' }
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return { ...builtin, missing: true }
      return { ...builtin, error: e instanceof HttpError && e.status === 423 ? 'its library is locked' : (e as Error).message }
    }
  })()
  promptCache.set(user.id, { at: Date.now(), key, value })
  return value
}

const TITLE_PROMPT = [
  'You write the title of a chat thread, shown in one short line of a sidebar.',
  'Answer with JSON: {"title": "…"}. The title is a noun phrase of 2 to 5 words, at most 40 characters, naming the subject itself, in the language of the conversation, capitalised like a headline.',
  'Never describe the conversation, the request or the people in it ("The user wants…", "A title for…", "Question about…"): name what it is about.',
].join('\n')
/** Worked examples, given as earlier turns: models follow these better than rules. */
const TITLE_SHOTS: [string, string][] = [
  ['what is example.com used for?', "Example.com's purpose"],
  ['can you find my notes about the move and summarise them', 'Moving notes summary'],
  ['compare postgres and sqlite for a small app', 'Postgres vs SQLite'],
  ['hoe laat gaat de laatste trein naar Utrecht', 'Laatste trein naar Utrecht'],
]
/** A title that talks about the chat instead of its subject: the model got it wrong. */
const META_TITLE = /^(?:(?:the|this|a|an)\s+)?(?:user|owner|person|assistant|model|conversation|thread|chat)(?:'s)?\s+(?:is|are|was|wants?|asks?|asking|needs?|requests?|requesting|says|said|would|about|on|title|question)\b|\b(?:a|the|its|this)\s+title\b|\btitle\s+(?:for|of)\b|\b(?:wants?|asks?|asking)\s+(?:a|an|the|for|to|about|me|you)\b/i

/** Openers that describe the chat instead of naming its subject: cut off when a model adds them anyway. */
const META_OPENER = /^(?:the |this |a )?(?:user|owner|person|conversation|thread|chat|discussion|question|request|query|inquiry)(?:'s)?(?:\s+(?:is|are|was|wants|wanting|needs|asking|asks|requesting|requests|looking|trying|talking|seeking|question|questions|request))*\s+(?:about|regarding|on|of|for|to|into|how to|help with|what|whether|if)\s+/i
const HELP_OPENER = /^(?:help|assistance|information|info|explanation)\s+(?:with|on|about|of)\s+/i

export function cleanTitle(raw: string): string | null {
  let t =
    raw
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  const trim = (x: string) => x.replace(/^["'“”‘’#*\-–\s]+|["'“”‘’.!?*\s]+$/g, '')
  t = trim(trim(t).replace(/^(title|titel)\s*:\s*/i, ''))
  t = t.replace(META_OPENER, '').replace(HELP_OPENER, '')
  if (!t) return null
  t = t[0].toUpperCase() + t.slice(1)
  // One short line: cut at a word before 42 characters.
  if (t.length > 42) t = `${t.slice(0, 42).replace(/\s+\S*$/, '')}…`
  return t
}

/** A title for the thread so far, from the title model (Settings in the app; a fast one otherwise). */
async function makeTitle(user: User, key: string, thread: string): Promise<string | null> {
  const msgs = messagesOf(thread)
  const first = msgs.find((m) => m.role === 'user')
  const firstAsk = [first?.content ?? '', ...(first?.attachments ?? []).map((a) => `(attached: ${a.name})`)].filter(Boolean).join(' ')
  const lastAsk = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? ''
  const answer = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content ?? ''
  if (!firstAsk) return null
  const convo = [`Owner: ${clip(firstAsk, 1500)}`, lastAsk !== firstAsk ? `Owner, later: ${clip(lastAsk, 800)}` : '', answer ? `Agent: ${clip(answer, 1500)}` : ''].filter(Boolean).join('\n\n')
  const model = agentSettings(user).titleModel ?? (await defaultModel('quick'))
  const info = (await models().catch(() => [] as ModelInfo[])).find((m) => m.name === model)
  const think = info?.thinking ? (model.startsWith('gpt-oss') ? 'low' : false) : undefined
  const messages = [
    { role: 'system', content: TITLE_PROMPT },
    ...TITLE_SHOTS.flatMap(([q, title]) => [
      { role: 'user', content: `Owner: ${q}` },
      { role: 'assistant', content: JSON.stringify({ title }) },
    ]),
    { role: 'user', content: convo },
  ]
  // Twice at most: a model that answers with a description of the request gets one more go.
  for (const temperature of [0.2, 0.6]) {
    const body = { model, stream: false, options: { temperature, num_predict: 60 }, messages, ...(think === undefined ? {} : { think }) }
    // Structured output holds the model to {"title": "…"}; a model that refuses it is asked plainly.
    const format = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
    const res = await ollama(key, '/api/chat', { ...body, format }, AbortSignal.timeout(30_000)).catch((e) => {
      if (e instanceof HttpError && e.status === 409) throw e // the key itself
      return ollama(key, '/api/chat', body, AbortSignal.timeout(30_000))
    })
    const answer = (await res.json()) as { message?: { content?: string } }
    const title = pickTitle(answer.message?.content ?? '')
    if (title) return title
  }
  return null
}

/**
 * The title in a model's answer: the JSON's, or else the first line that is a clean title (when
 * reasoning leaked into the answer, the title is usually its last line).
 */
export function pickTitle(raw: string): string | null {
  const ok = (t: string | null) => (t && !META_TITLE.test(t) && t.length <= 60 ? t : null)
  try {
    const parsed = JSON.parse(raw) as unknown
    const t = typeof parsed === 'string' ? parsed : (parsed as { title?: unknown })?.title
    if (typeof t === 'string') return ok(cleanTitle(t))
  } catch {
    /* not JSON: look through the lines */
  }
  const lines = raw.replace(/<think>[\s\S]*?<\/think>/g, '').split('\n').map((l) => l.trim()).filter(Boolean)
  for (const line of lines.reverse()) {
    const t = ok(cleanTitle(line))
    if (t) return t
  }
  return null
}

/** A new title to offer when renaming; nothing is saved. */
export async function suggestTitle(user: User, id: string): Promise<{ title: string | null }> {
  const row = ownThread(user, id)
  return { title: await makeTitle(user, requireKey(user), row.id) }
}

/** What the next turn sends the model, part by part, with a rough token count (about 4 characters a token). */
export async function contextOf(user: User, id: string) {
  const row = ownThread(user, id)
  const mode = modeOf(row.mode)
  const prompt = await agentsPrompt(user)
  const memories = listMemories(user).filter((m) => m.projectId === null || m.projectId === row.project_id)
  const thread = toThread(row)
  const history = chatHistory(row.id)
  const tokens = (s: string) => Math.ceil(s.length / 4)
  const sum = (role: string, f: (m: ChatMessage) => string = (m) => m.content) => history.filter((m) => m.role === role).reduce((n, m) => n + tokens(f(m)), 0)
  const count = (role: string) => history.filter((m) => m.role === role).length
  const parts = [
    { label: prompt.source === 'seafile' ? 'AGENTS.md (yours, from Seafile)' : 'AGENTS.md (built in)', tokens: tokens(prompt.text) },
    { label: 'Date and mode', tokens: tokens(modeLine(mode)) + 20 },
    { label: `Memories (${memories.length})`, tokens: tokens(memoryLines(memories)) },
    { label: `Tool definitions (${toolsFor(user, thread.tools, row.project_id !== null).length})`, tokens: tokens(JSON.stringify(toolsFor(user, thread.tools, row.project_id !== null))) },
    { label: `Your messages (${count('user')})`, tokens: sum('user') },
    { label: `Replies (${count('assistant')})`, tokens: sum('assistant', (m) => m.content + JSON.stringify(m.tool_calls ?? '')) },
    { label: 'Thinking (this turn)', tokens: sum('assistant', (m) => m.thinking ?? '') },
    { label: `Tool results (${count('tool')})`, tokens: sum('tool') },
    { label: 'Pictures', tokens: history.reduce((n, m) => n + (m.images?.length ?? 0) * 800, 0) },
  ]
  const info = (await models().catch(() => [] as ModelInfo[])).find((m) => m.name === row.model)
  return { model: row.model, contextLength: info?.contextLength ?? null, measured: row.context_tokens ?? null, estimate: parts.reduce((n, p) => n + p.tokens, 0), parts }
}

// --- memory -----------------------------------------------------------------------------------

/**
 * What the agent remembers: about the owner (projectId null) or about one project, each in a
 * category path such as "People/Friends" or "Work/Tools", as deep as the agent finds useful.
 */
export type Memory = { id: number; text: string; category: string; projectId: number | null; threadId: string | null; createdAt: number; updatedAt: number | null }
type MemoryRow = { id: number; text: string; category: string; project_id: number | null; thread_id: string | null; created_at: number; updated_at: number | null }
const MAX_MEMORIES = 1000

const toMemory = (r: MemoryRow): Memory => ({ id: r.id, text: r.text, category: r.category ?? '', projectId: r.project_id ?? null, threadId: r.thread_id, createdAt: r.created_at, updatedAt: r.updated_at ?? null })

export const listMemories = (user: User): Memory[] =>
  (database().prepare('SELECT id, text, category, project_id, thread_id, created_at, updated_at FROM agent_memories WHERE user_id = ? ORDER BY category, id').all(user.id) as MemoryRow[]).map(toMemory)

/** "people / friends /" → "People/Friends": up to six levels of up to 40 characters. */
const cleanCategory = (v: unknown) =>
  String(v ?? '')
    .split('/')
    .map((part) => part.replace(/\s+/g, ' ').trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 6)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('/')
const cleanText = (v: unknown) => {
  const text = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)
  if (!text) throw new HttpError(400, 'Nothing to remember')
  return text
}

function ownMemory(user: User, id: unknown): MemoryRow {
  const row = database().prepare('SELECT id, text, category, project_id, thread_id, created_at, updated_at FROM agent_memories WHERE id = ? AND user_id = ?').get(Number(id), user.id) as MemoryRow | undefined
  if (!row) throw new HttpError(404, 'No such memory')
  return row
}

/** Saves a memory (from the agent, or written by hand in the Memory view). */
export function addMemory(user: User, body: { text?: unknown; category?: unknown; projectId?: unknown }, thread: string | null = null): Memory {
  const db = database()
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM agent_memories WHERE user_id = ?').get(user.id) as { n: number }
  if (n >= MAX_MEMORIES) throw new HttpError(409, `Memory is full (${MAX_MEMORIES} items): delete some in the Memory view`)
  const r = db
    .prepare('INSERT INTO agent_memories (user_id, text, category, project_id, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, cleanText(body.text), cleanCategory(body.category), projectRef(user, body.projectId), thread, Date.now())
  return toMemory(ownMemory(user, Number(r.lastInsertRowid)))
}

/** Changes a memory's text, category or scope (the owner or a project). */
export function updateMemory(user: User, id: unknown, body: { text?: unknown; category?: unknown; projectId?: unknown }): Memory {
  const row = ownMemory(user, id)
  database()
    .prepare('UPDATE agent_memories SET text = ?, category = ?, project_id = ?, updated_at = ? WHERE id = ?')
    .run(body.text === undefined ? row.text : cleanText(body.text), body.category === undefined ? row.category : cleanCategory(body.category), body.projectId === undefined ? row.project_id : projectRef(user, body.projectId), Date.now(), row.id)
  return toMemory(ownMemory(user, row.id))
}

export function deleteMemory(user: User, id: number) {
  database().prepare('DELETE FROM agent_memories WHERE user_id = ? AND id = ?').run(user.id, id)
}

/** Memories as the model reads them: by category, each with its id (for update_memory). */
function memoryLines(list: Memory[]): string {
  const byCat = new Map<string, Memory[]>()
  for (const m of list) byCat.set(m.category, [...(byCat.get(m.category) ?? []), m])
  return [...byCat]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([cat, items]) => `${cat || '(no category)'}\n${items.map((m) => `- [#${m.id}] ${m.text}`).join('\n')}`)
    .join('\n')
}

// --- forms the agent asks the owner -------------------------------------------------------------

/**
 * A form from ask_user, drawn by the window. Each question has a type; the window draws the types
 * it knows and falls back to a text field for any other, so new types can be added on both sides
 * one at a time.
 */
export const QUESTION_TYPES = ['choice', 'multi', 'confirm', 'text', 'number', 'scale', 'date', 'info'] as const
export type Option = { value: string; label: string; hint?: string }
export type Question = {
  id: string
  type: (typeof QUESTION_TYPES)[number]
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

const shortText = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined)

/** Checks and tidies what the model sent: known types, unique ids, options where they are needed. */
function normalizeForm(args: Record<string, unknown>): Form {
  const raw = Array.isArray(args.questions) ? (args.questions as Record<string, unknown>[]) : []
  if (!raw.length) throw new Error('A form needs at least one question')
  const seen = new Set<string>()
  const questions = raw.slice(0, 12).map((q, i): Question => {
    let id = shortText(q.id, 40).replace(/[^\w-]/g, '_') || `q${i + 1}`
    while (seen.has(id)) id += '_'
    seen.add(id)
    const type = (QUESTION_TYPES as readonly string[]).includes(String(q.type)) ? (q.type as Question['type']) : 'text'
    const options = Array.isArray(q.options)
      ? (q.options as unknown[]).slice(0, 24).map((o, j) => {
          const opt = (typeof o === 'string' ? { value: o, label: o } : (o ?? {})) as Record<string, unknown>
          const label = shortText(opt.label ?? opt.value, 120) || `Option ${j + 1}`
          return { value: shortText(opt.value ?? label, 120) || label, label, ...(shortText(opt.hint, 200) ? { hint: shortText(opt.hint, 200) } : {}) }
        })
      : undefined
    if ((type === 'choice' || type === 'multi') && !options?.length) throw new Error(`Question ${id} (${type}) needs options`)
    return {
      id,
      type,
      label: shortText(q.label ?? q.question, 300) || `Question ${i + 1}`,
      ...(shortText(q.hint, 400) ? { hint: shortText(q.hint, 400) } : {}),
      ...(options ? { options } : {}),
      ...(q.allow_other === true || q.allowOther === true ? { allowOther: true } : {}),
      ...(num(q.min) !== undefined ? { min: num(q.min) } : {}),
      ...(num(q.max) !== undefined ? { max: num(q.max) } : {}),
      ...(num(q.step) !== undefined ? { step: num(q.step) } : {}),
      ...(shortText(q.min_label ?? q.minLabel, 60) ? { minLabel: shortText(q.min_label ?? q.minLabel, 60) } : {}),
      ...(shortText(q.max_label ?? q.maxLabel, 60) ? { maxLabel: shortText(q.max_label ?? q.maxLabel, 60) } : {}),
      ...(shortText(q.unit, 20) ? { unit: shortText(q.unit, 20) } : {}),
      ...(shortText(q.placeholder, 120) ? { placeholder: shortText(q.placeholder, 120) } : {}),
      ...(q.multiline === true ? { multiline: true } : {}),
      ...(q.required === false ? { required: false } : {}),
      ...(q.default !== undefined ? { default: q.default } : {}),
    }
  })
  return { title: shortText(args.title, 120) || 'A question', ...(shortText(args.intro, 1000) ? { intro: shortText(args.intro, 1000) } : {}), questions, ...(shortText(args.submit_label ?? args.submit, 40) ? { submit: shortText(args.submit_label ?? args.submit, 40) } : {}) }
}

/** The answers as the model reads them back: by id, plus "Question: answer" lines with labels. */
function answerText(form: Form, answers: Record<string, unknown> | null): string {
  if (!answers) return JSON.stringify({ skipped: true, note: 'The owner closed the form without answering.' })
  const lines = form.questions
    .filter((q) => q.type !== 'info')
    .map((q) => {
      const v = answers[q.id]
      const label = (x: unknown) => q.options?.find((o) => o.value === x)?.label ?? String(x)
      const shown = v === null || v === undefined || v === '' ? '(no answer)' : Array.isArray(v) ? v.map(label).join(', ') || '(none)' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : label(v)
      return `${q.label}: ${shown}`
    })
  return JSON.stringify({ answers, summary: lines.join('\n') })
}

// --- todos -----------------------------------------------------------------------------------

/** The thread's plan for a long job, replaced whole each time the agent updates it. */
function setTodos(thread: string, items: unknown): Todo[] {
  if (!Array.isArray(items)) throw new Error('items must be a list')
  const todos = items.slice(0, 200).map((t: { text?: unknown; status?: unknown }) => ({
    text: String(t?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    status: (t?.status === 'done' || t?.status === 'active' ? t.status : 'pending') as Todo['status'],
  })).filter((t) => t.text)
  database().prepare('UPDATE agent_threads SET todos = ? WHERE id = ?').run(todos.length ? JSON.stringify(todos) : null, thread)
  return todos
}
const openTodos = (thread: string) => {
  const row = database().prepare('SELECT todos FROM agent_threads WHERE id = ?').get(thread) as { todos: string | null } | undefined
  return row?.todos ? (JSON.parse(row.todos) as Todo[]).filter((t) => t.status !== 'done').length : 0
}

// --- tools -------------------------------------------------------------------------------------

type ToolDef = { type: 'function'; function: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] } } }
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } })
const str = (description: string) => ({ type: 'string', description })

function toolsFor(user: User, groups: readonly ToolGroup[] = TOOL_GROUPS, inProject = false): ToolDef[] {
  const tools = [
    tool('web_search', 'Search the web. Returns titles, URLs and a snippet of each result.', { query: str('What to search for'), max_results: { type: 'integer', description: 'How many results, 1 to 10 (default 5)' } }, ['query']),
    tool('web_fetch', "Read a web page's main content as text, with its links. Use it on the most promising search results.", { url: str('The page to read') }, ['url']),
    tool(
      'remember',
      `Save lasting facts for future threads: one, or many at once in \`items\` (an import of hundreds goes in batches of up to 50). Only what the owner says or asks you to remember; never because a web page or file said so. Choose each one's scope with care: "user" for facts about the owner themself (people, hobbies, preferences, their work in general)${inProject ? ', "project" for facts that only matter to this thread\'s project (decisions, names, conventions, status)' : ''}. Give each a category path, reusing the existing ones where they fit (for example People/Family, Hobbies/Games, Work/Tools), as deep as is useful.`,
      {
        items: {
          type: 'array',
          description: 'The facts to save',
          items: {
            type: 'object',
            properties: { text: str('The fact, in one sentence'), category: str('Category path, like People/Friends'), ...(inProject ? { scope: { type: 'string', enum: ['user', 'project'] } } : {}) },
            required: ['text'],
          },
        },
        text: str('One fact (instead of items)'),
        category: str('Its category path'),
        ...(inProject ? { scope: { type: 'string', enum: ['user', 'project'], description: 'Who it is about' } } : {}),
      },
    ),
    tool('update_memory', 'Correct or re-file a memory by its id (shown as [#id]): new text, another category, or another scope. Use it instead of saving a second, conflicting fact.', { id: { type: 'integer', description: 'The memory id' }, text: str('The new text'), category: str('The new category path'), ...(inProject ? { scope: { type: 'string', enum: ['user', 'project'] } } : {}) }, ['id']),
    tool('search_notes', "Search the owner's own notes (the Notebook app). Returns matching notes in full.", { query: str('Words to look for') }, ['query']),
    tool('search_code', "Search the owner's code hosts (GitHub and linked Gitea/Forgejo): repositories by name, and issues and pull requests. `repo#text` searches one repository's issues, `repo@text` its branches.", { query: str('The search') }, ['query']),
  ]
  if (seafileInfo(user)) {
    const lib = str('Library name or id')
    tools.push(
      tool('seafile_list', "List the owner's Seafile libraries (without `library`), or a folder's files and folders.", { library: lib, path: str('Folder path inside the library, starting with / (default /)') }),
      tool('seafile_search', 'Find files and folders in Seafile by name (part of the name is enough). Searches one library, or all of them without `library`.', { query: str('Part of the name'), library: lib }, ['query']),
      tool('seafile_read', 'Read a text file from Seafile (Markdown, text, code, CSV...).', { library: lib, path: str('File path inside the library, starting with /') }, ['library', 'path']),
      tool('seafile_mkdir', 'Make a folder in Seafile (the owner is asked first).', { library: lib, path: str('The new folder path, starting with /') }, ['library', 'path']),
      tool('seafile_write', 'Write a text file in Seafile: a new one, or replace an existing one with `overwrite` (the owner is asked first; Seafile keeps the old version).', { library: lib, path: str('File path, starting with /'), content: str('The whole file content'), overwrite: { type: 'boolean', description: 'Replace the file if it exists (default false)' } }, ['library', 'path', 'content']),
      tool('seafile_rename', 'Rename a file or folder in place (the owner is asked first).', { library: lib, path: str('Its path, starting with /'), name: str('The new name, without a path') }, ['library', 'path', 'name']),
      tool('seafile_move', 'Move or copy a file or folder into another folder, in the same or another library (the owner is asked first).', { library: lib, path: str('Its path, starting with /'), to_folder: str('The folder to put it in, starting with /'), to_library: str('Target library (default: the same one)'), copy: { type: 'boolean', description: 'Copy instead of move (default false)' } }, ['library', 'path', 'to_folder']),
      tool('seafile_delete', "Delete a file or folder (the owner is asked first). It goes to the library's trash, where it can be restored while the library keeps history.", { library: lib, path: str('Its path, starting with /') }, ['library', 'path']),
    )
  }
  tools.push(
    tool(
      'list_projects',
      "The owner's projects (which group threads in the sidebar, each with its own memory), with how many threads each has and which one this thread is in.",
      {},
    ),
    tool('create_project', 'Make a project. Ask the owner first with ask_user unless they asked for it. `move_here` puts this thread in it.', { name: str('Its name, short'), move_here: { type: 'boolean', description: 'Move this thread into it' } }, ['name']),
    tool('rename_project', 'Rename a project (ask first unless the owner asked).', { project: str('Its id or current name'), name: str('The new name') }, ['project', 'name']),
    tool('move_thread', 'Move this thread into a project, or out of any (project empty or "none"). Ask first unless the owner asked.', { project: str('The project id or name, or "none"') }, ['project']),
    tool(
      'ask_user',
      'Ask the owner something with a small form in the window instead of in prose, and wait for the answers: when you need a decision, a choice between options, details you lack, or a yes or no before doing something. Question types: choice (pick one of options), multi (pick any of options; min and max), confirm (yes or no), text (placeholder; multiline for longer), number (min, max, step, unit), scale (a rating from min to max with min_label and max_label), date, and info (text to read, no answer). Several questions can go in one form. Answers come back by question id.',
      {
        title: str('What the form is about, a few words'),
        intro: str('A sentence or two of context (optional)'),
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: str('A short id for the answer'),
              type: { type: 'string', enum: [...QUESTION_TYPES] },
              label: str('The question'),
              hint: str('Extra explanation (optional)'),
              options: { type: 'array', items: { type: 'object', properties: { value: str('What comes back'), label: str('What the owner sees'), hint: str('Optional detail') }, required: ['value', 'label'] } },
              allow_other: { type: 'boolean', description: 'choice/multi: also let them type their own' },
              min: { type: 'number' },
              max: { type: 'number' },
              step: { type: 'number' },
              min_label: str('scale: what the low end means'),
              max_label: str('scale: what the high end means'),
              unit: str('number: unit to show'),
              placeholder: str('text: example text'),
              multiline: { type: 'boolean' },
              required: { type: 'boolean', description: 'Default true' },
            },
            required: ['type', 'label'],
          },
        },
        submit_label: str('The button text (optional)'),
      },
      ['questions'],
    ),
    tool(
      'update_todos',
      'Your plan for a job with many steps or items (an import, research in many parts, a batch of file changes): the whole list each time, each item pending, active or done. The owner sees it. Write it before you start, keep exactly one item active, and mark items done as you finish them; while items are open you may keep working for many more rounds.',
      { items: { type: 'array', items: { type: 'object', properties: { text: str('The step'), status: { type: 'string', enum: ['pending', 'active', 'done'] } }, required: ['text', 'status'] } } },
      ['items'],
    ),
  )
  // update_todos and ask_user belong to no group: they are always there.
  return tools.filter((t) => !GROUP_OF[t.function.name] || groups.includes(GROUP_OF[t.function.name]))
}

/** Tools that change the owner's files: each call waits for the owner to allow it. */
const NEEDS_APPROVAL = new Set(['seafile_mkdir', 'seafile_write', 'seafile_rename', 'seafile_move', 'seafile_delete'])

/** How far a turn may go while its todo list has open items. */
const LONG_ROUNDS = 150
const LONG_TIME = 60 * 60_000

const MODES = {
  quick: { rounds: 4, think: 'low', pageChars: 8_000 },
  deep: { rounds: 24, think: 'high', pageChars: 16_000 },
} as const

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[… ${s.length - n} more characters left out]` : s)
const argString = (args: Record<string, unknown>, k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() : '')
/** A path inside a library as Seafile wants it: "Documents/a.md" and "/Documents/a.md/" both become "/Documents/a.md". */
const absPath = (raw: string) => `/${raw.replace(/^\/+/, '')}`.replace(/(.)\/+$/, '$1')

async function findLibrary(user: User, ref: string): Promise<Library> {
  const libs = await libraries(user)
  const lib = libs.find((l) => l.id === ref) ?? libs.find((l) => l.name.toLowerCase() === ref.toLowerCase())
  if (!lib) throw new Error(ref ? `No library called "${ref}". Libraries: ${libs.map((l) => l.name).join(', ')}` : 'Say which library')
  return lib
}
const libraryId = async (user: User, ref: string) => (await findLibrary(user, ref)).id

/** "/a/b/c.md" → ["/a/b", "c.md"]; the root has no name. */
function splitPath(raw: string): [string, string] {
  const p = absPath(raw)
  if (p === '/') throw new Error('That is the library itself, not a file or folder')
  const i = p.lastIndexOf('/')
  return [p.slice(0, i) || '/', p.slice(i + 1)]
}

/** The entry at a path (from its folder's listing), or null when there is nothing there. */
async function entryAt(user: User, repo: string, path: string) {
  const [dir, name] = splitPath(path)
  const listing = await listDir(user, repo, dir).catch((e) => {
    if (e instanceof HttpError && e.status === 404) return null
    throw e
  })
  return listing?.entries.find((e) => e.name === name) ?? null
}

type SearchHit = { path: string; type?: string; size?: number; mtime?: string }

/** Files and folders whose name contains `query`, by Seafile's own name search, per library. */
async function seafileSearch(user: User, query: string, ref: string) {
  if (!query) throw new Error('A query is required')
  const libs = ref ? [await findLibrary(user, ref)] : (await libraries(user)).filter((l) => !l.encrypted).slice(0, 25)
  const found = await Promise.all(
    libs.map((l) =>
      seafile<{ data?: SearchHit[] }>(user, `/api/v2.1/search-file/?repo_id=${l.id}&q=${encodeURIComponent(query)}`)
        .then((r) => (r.data ?? []).map((h) => ({ library: l.name, path: h.path, folder: h.type === 'dir', size: h.size ?? 0, modified: h.mtime ?? null })))
        .catch(() => []),
    ),
  )
  const hits = found.flat()
  return { results: hits.slice(0, 60), ...(hits.length > 60 ? { more: hits.length - 60 } : {}) }
}

/** Uploads text as a file through Seafile's file server, replacing it when asked. */
async function writeFile(user: User, repo: string, path: string, content: string, overwrite: boolean, signal: AbortSignal) {
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('That is more than 2 MB of text')
  const [dir, name] = splitPath(path)
  const existing = await entryAt(user, repo, path)
  if (existing?.dir) throw new Error('There is a folder with that name')
  if (existing && !overwrite) throw new Error('That file exists already: set overwrite to replace it')
  if (!existing && dir !== '/' && !(await entryAt(user, repo, dir))) await mkdir(user, { repo, path: dir })
  const { url } = await fileLink(user, repo, dir, 'upload')
  const form = new FormData()
  form.append('parent_dir', dir)
  form.append('replace', existing ? '1' : '0')
  form.append('file', new Blob([content], { type: 'text/plain' }), name)
  const res = await fetch(`${url}?ret-json=1`, { method: 'POST', body: form, signal })
  if (!res.ok) throw new Error(`Seafile answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return { written: absPath(path), bytes: Buffer.byteLength(content), replaced: !!existing }
}

/** A project named by the model: its id, or its name (any case). */
function findProject(user: User, ref: unknown): Project {
  const list = listProjects(user)
  const s = String(ref ?? '').trim()
  const p = list.find((x) => String(x.id) === s) ?? list.find((x) => x.name.toLowerCase() === s.toLowerCase())
  if (!p) throw new Error(`No project "${s}". Projects: ${list.map((x) => `${x.id} ${x.name}`).join(', ') || 'none yet'}`)
  return p
}

const threadProject = (thread: string) => (database().prepare('SELECT project_id FROM agent_threads WHERE id = ?').get(thread) as { project_id: number | null } | undefined)?.project_id ?? null

/** Runs one tool call. Answers what the model reads back; failures are told to it, not thrown. */
async function runTool(user: User, key: string, thread: string, mode: Mode, call: ToolCall, signal: AbortSignal): Promise<string> {
  const args = call.arguments ?? {}
  const limit = AbortSignal.any([signal, AbortSignal.timeout(45_000)])
  try {
    switch (call.name) {
      case 'web_search': {
        const query = argString(args, 'query')
        if (!query) throw new Error('A query is required')
        const max = Math.min(10, Math.max(1, Math.round(Number(args.max_results) || 5)))
        // Ollama's search, or the provider picked in Settings → Agents → Web search.
        const { results } = await webSearch(user, key, query, max, limit)
        return JSON.stringify(results)
      }
      case 'web_fetch': {
        const url = argString(args, 'url')
        if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs')
        const res = await ollama(key, '/api/web_fetch', { url }, limit)
        const page = (await res.json()) as { title?: string; content?: string; links?: string[] }
        return JSON.stringify({ title: page.title ?? null, content: clip(page.content ?? '', MODES[mode].pageChars), links: (page.links ?? []).slice(0, 40) })
      }
      case 'remember': {
        const project = threadProject(thread)
        const list = Array.isArray(args.items) ? (args.items as Record<string, unknown>[]) : [args]
        if (list.length > 50) throw new Error('At most 50 at a time: save the rest in the next call')
        const saved: { id: number; category: string }[] = []
        const failed: string[] = []
        for (const item of list) {
          try {
            const m = addMemory(user, { text: item.text, category: item.category, projectId: item.scope === 'project' ? project : null }, thread)
            saved.push({ id: m.id, category: m.category })
          } catch (e) {
            failed.push((e as Error).message)
          }
        }
        return JSON.stringify({ saved: saved.length, ids: saved.map((m) => m.id), ...(failed.length ? { failed } : {}) })
      }
      case 'update_memory': {
        const project = threadProject(thread)
        const m = updateMemory(user, args.id, { text: args.text, category: args.category, projectId: args.scope === undefined ? undefined : args.scope === 'project' ? project : null })
        return JSON.stringify({ updated: m.id, text: m.text, category: m.category, scope: m.projectId ? 'project' : 'user' })
      }
      case 'list_projects': {
        const counts = new Map((database().prepare('SELECT project_id, COUNT(*) AS n FROM agent_threads WHERE user_id = ? AND project_id IS NOT NULL AND archived = 0 GROUP BY project_id').all(user.id) as { project_id: number; n: number }[]).map((r) => [r.project_id, r.n]))
        const here = threadProject(thread)
        return JSON.stringify({ projects: listProjects(user).map((p) => ({ id: p.id, name: p.name, threads: counts.get(p.id) ?? 0, thisThread: p.id === here })) })
      }
      case 'create_project': {
        const p = createProject(user, { name: argString(args, 'name') })
        if (args.move_here === true) database().prepare('UPDATE agent_threads SET project_id = ? WHERE id = ?').run(p.id, thread)
        return JSON.stringify({ created: { id: p.id, name: p.name }, ...(args.move_here === true ? { moved: true } : {}) })
      }
      case 'rename_project': {
        const p = findProject(user, args.project)
        const renamed = renameProject(user, p.id, { name: argString(args, 'name') })
        return JSON.stringify({ renamed: { id: renamed.id, from: p.name, to: renamed.name } })
      }
      case 'move_thread': {
        const ref = argString(args, 'project')
        const to = !ref || /^(none|null|no project)$/i.test(ref) ? null : findProject(user, ref)
        database().prepare('UPDATE agent_threads SET project_id = ? WHERE id = ?').run(to?.id ?? null, thread)
        return JSON.stringify({ moved: to ? { id: to.id, name: to.name } : 'out of any project' })
      }
      case 'update_todos': {
        const todos = setTodos(thread, args.items)
        return JSON.stringify({ done: todos.filter((t) => t.status === 'done').length, of: todos.length })
      }
      case 'search_notes': {
        const words = argString(args, 'query').toLowerCase().split(/\s+/).filter(Boolean)
        const notes = (readState(user).notes?.value ?? []) as { id: string; text: string; updated?: number; deleted?: boolean; purged?: boolean }[]
        const hits = notes
          .filter((n) => !n.deleted && !n.purged && typeof n.text === 'string')
          .filter((n) => words.every((w) => n.text.toLowerCase().includes(w)))
          .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
          .slice(0, 6)
        return JSON.stringify(hits.length ? hits.map((n) => ({ text: clip(n.text, 3000), updated: n.updated ? new Date(n.updated).toISOString() : null })) : { found: 0 })
      }
      case 'search_code': {
        const { hits, errors } = await codeSearch(user, argString(args, 'query'))
        const items = hits.slice(0, 15).map((h) =>
          h.kind === 'repo'
            ? { type: 'repo', name: h.fullName, description: h.description, url: h.url, language: h.language, pushedAt: h.pushedAt }
            : h.kind === 'branch'
              ? { type: 'branch', repo: h.repo, name: h.name, url: h.url, lastCommit: h.commitMessage ?? null }
              : { type: h.kind, repo: h.repo, number: h.number, title: h.title, state: h.state, url: h.url, updatedAt: h.updatedAt, body: clip(h.body ?? '', 400) },
        )
        return JSON.stringify({ results: items, ...(errors.length ? { errors } : {}) })
      }
      case 'seafile_list': {
        const ref = argString(args, 'library')
        if (!ref) return JSON.stringify((await libraries(user)).map((l) => ({ name: l.name, id: l.id, encrypted: l.encrypted, size: l.size })))
        const { entries } = await listDir(user, await libraryId(user, ref), absPath(argString(args, 'path')))
        return JSON.stringify(entries.slice(0, 300).map((e) => ({ name: e.name, folder: e.dir, size: e.size, modified: new Date(e.mtime).toISOString() })))
      }
      case 'seafile_read': {
        const repo = await libraryId(user, argString(args, 'library'))
        const { url } = await fileLink(user, repo, absPath(argString(args, 'path')), 'download')
        const res = await fetch(url, { signal: limit })
        if (!res.ok) throw new Error(`Seafile answered ${res.status}`)
        if (Number(res.headers.get('content-length')) > 4 * 1024 * 1024) throw new Error('That file is too big to read here (over 4 MB)')
        const bytes = Buffer.from(await res.arrayBuffer())
        if (bytes.subarray(0, 8000).includes(0)) throw new Error('That is not a text file')
        return JSON.stringify({ content: clip(bytes.toString('utf8'), MODES[mode].pageChars * 2) })
      }
      case 'seafile_search':
        return JSON.stringify(await seafileSearch(user, argString(args, 'query'), argString(args, 'library')))
      case 'seafile_mkdir': {
        const repo = await libraryId(user, argString(args, 'library'))
        return JSON.stringify(await mkdir(user, { repo, path: absPath(argString(args, 'path')) }))
      }
      case 'seafile_write': {
        const repo = await libraryId(user, argString(args, 'library'))
        return JSON.stringify(await writeFile(user, repo, argString(args, 'path'), typeof args.content === 'string' ? args.content : '', args.overwrite === true, limit))
      }
      case 'seafile_rename': {
        const repo = await libraryId(user, argString(args, 'library'))
        const path = argString(args, 'path')
        const entry = await entryAt(user, repo, path)
        if (!entry) throw new Error(`Nothing at ${path}`)
        return JSON.stringify(await rename(user, { repo, path: absPath(path), dir: entry.dir, name: argString(args, 'name') }))
      }
      case 'seafile_move': {
        const repo = await libraryId(user, argString(args, 'library'))
        const to = argString(args, 'to_library') ? await libraryId(user, argString(args, 'to_library')) : repo
        const [parent, name] = splitPath(argString(args, 'path'))
        const folder = absPath(argString(args, 'to_folder'))
        const op = args.copy === true ? 'copy' : 'move'
        await transfer(user, { op, from: { repo, parent }, names: [name], to: { repo: to, parent: folder } })
        return JSON.stringify({ [op === 'copy' ? 'copied' : 'moved']: `${parent === '/' ? '' : parent}/${name}`, to: folder })
      }
      case 'seafile_delete': {
        const repo = await libraryId(user, argString(args, 'library'))
        const [parent, name] = splitPath(argString(args, 'path'))
        if (!(await entryAt(user, repo, argString(args, 'path')))) throw new Error(`Nothing at ${argString(args, 'path')}`)
        await removeItems(user, { repo, parent, names: [name] })
        return JSON.stringify({ deleted: `${parent === '/' ? '' : parent}/${name}`, note: "In the library's trash while it keeps history" })
      }
      default:
        throw new Error(`There is no tool called ${call.name}`)
    }
  } catch (e) {
    if (signal.aborted) throw e
    const message = e instanceof HttpError && e.status === 423 ? 'That library is encrypted and locked: the owner can unlock it in Files' : (e as Error).message
    return JSON.stringify({ error: message })
  }
}

// --- a turn -----------------------------------------------------------------------------------

type ChatMessage = { role: string; content: string; thinking?: string; tool_calls?: { function: ToolCall }[]; tool_name?: string; images?: string[] }

const modeLine = (mode: Mode) =>
  mode === 'quick'
    ? 'Mode: Quick. Answer quickly and directly. Use a tool only when the answer depends on current or specific facts you do not know; one or two searches is usually enough. Keep the answer short.'
    : 'Mode: Deep research. Research this thoroughly before you answer. Break the question into parts, search from several angles, read the most relevant primary sources with web_fetch rather than relying on snippets, compare what they say and note where they disagree. Then write a well-structured answer, with headings and lists where they help, that ends with the key sources.'

/** AGENTS.md, then today's date, the mode, how to work, the project and the memories. */
async function systemPrompt(user: User, mode: Mode, projectId: number | null = null): Promise<string> {
  const all = listMemories(user)
  const name = user.name || user.login
  const base = (await agentsPrompt(user)).text.replaceAll('{{owner}}', name)
  const project = projectId ? listProjects(user).find((p) => p.id === projectId) : null
  const mine = all.filter((m) => m.projectId === null)
  const theirs = project ? all.filter((m) => m.projectId === project.id) : []
  return [
    base.trim(),
    `Today is ${new Date().toUTCString().slice(0, 16)}.`,
    modeLine(mode),
    'When you need a decision, a choice or details from the owner, ask with ask_user (a small form: choices, multiple choice, yes or no, text, numbers, ratings, dates) rather than asking in prose, and use the answers. Keep forms short. Ask before creating, renaming or moving projects unless the owner already asked for it.',
    'Long jobs (many items or many steps, such as importing a long list, research in many parts or a batch of file changes): write a todo list with update_todos first, then work through it, keeping it up to date; while items are open you can keep going for many rounds. Batch where tools allow it (remember takes up to 50 facts per call), and report briefly at the end.',
    project
      ? `This thread belongs to the project "${project.name}". Facts that only matter to this project go in its memory (remember with scope "project"); facts about ${name} themself go in the user memory.`
      : '',
    mine.length ? `What you remember about ${name} (user memory; the [#id] is for update_memory):\n${memoryLines(mine)}` : `You do not remember anything about ${name} yet.`,
    project ? (theirs.length ? `What you remember about the project "${project.name}":\n${memoryLines(theirs)}` : `Nothing is remembered about the project "${project.name}" yet.`) : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** The thread as Ollama reads it. Older tool output is shortened; this turn's stays whole. */
function chatHistory(thread: string, vision = true): ChatMessage[] {
  const rows = database().prepare('SELECT id, attachments FROM agent_messages WHERE thread_id = ? AND attachments IS NOT NULL').all(thread) as { id: number; attachments: string }[]
  const files = new Map(rows.map((r) => [r.id, JSON.parse(r.attachments) as Attachment[]]))
  const all = messagesOf(thread)
  const lastUser = all.map((m) => m.role).lastIndexOf('user')
  // A long turn keeps its last 16 tool results whole; older ones are shortened like earlier turns'.
  const toolIdx = all.flatMap((m, i) => (m.role === 'tool' ? [i] : []))
  const keepWhole = new Set(toolIdx.filter((i) => i > lastUser).slice(-16))
  return all.map((m, i) => {
    if (m.role === 'tool') return { role: 'tool', tool_name: m.toolName ?? '', content: keepWhole.has(i) ? m.content : clip(m.content, 1500) }
    const current = i >= lastUser
    if (m.role === 'assistant')
      return { role: 'assistant', content: m.content, ...(current && m.thinking ? { thinking: m.thinking } : {}), ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: c })) } : {}) }
    const attached = files.get(m.id) ?? []
    const texts = attached.map((a) =>
      a.kind === 'text'
        ? `<attachment name="${a.name}" from="${a.source}">\n${a.text}\n</attachment>`
        : vision
          ? `<attachment name="${a.name}" from="${a.source}">(the picture is attached)</attachment>`
          : `<attachment name="${a.name}" from="${a.source}">(a picture; this model cannot see pictures, so say so if it matters)</attachment>`,
    )
    const images = vision ? attached.filter((a) => a.kind === 'image').map((a) => a.data!) : []
    return { role: 'user', content: [m.content, ...texts].filter(Boolean).join('\n\n'), ...(images.length ? { images } : {}) }
  })
}

function addMessage(thread: string, m: Omit<AgentMessage, 'id' | 'createdAt' | 'attachments'>, files: Attachment[] = []): AgentMessage {
  const now = Date.now()
  const r = database()
    .prepare('INSERT INTO agent_messages (thread_id, role, content, thinking, tool_calls, tool_name, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(thread, m.role, m.content, m.thinking || null, m.toolCalls?.length ? JSON.stringify(m.toolCalls) : null, m.toolName ?? null, files.length ? JSON.stringify(files) : null, now)
  database().prepare('UPDATE agent_threads SET updated_at = ? WHERE id = ?').run(now, thread)
  return { ...m, ...(m.toolCalls?.length ? {} : { toolCalls: undefined }), ...(files.length ? { attachments: files.map(({ text: _t, data: _d, ...info }) => info) } : {}), id: Number(r.lastInsertRowid), createdAt: now }
}

type ChunkCall = { function: { name: string; arguments: Record<string, unknown> | string } }

/** One call to Ollama's chat API, streamed: deltas go out as they come, the whole reply is answered. */
async function chat(key: string, body: object, signal: AbortSignal, onDelta: (d: { content?: string; thinking?: string }) => void) {
  const res = await ollama(key, '/api/chat', { ...body, stream: true }, signal)
  let content = ''
  let thinking = ''
  let used: number | null = null
  const calls: ToolCall[] = []
  let buffer = ''
  const decoder = new TextDecoder()
  const line = (text: string) => {
    if (!text.trim()) return
    const chunk = JSON.parse(text) as { message?: { content?: string; thinking?: string; tool_calls?: ChunkCall[] }; error?: string; done?: boolean; prompt_eval_count?: number; eval_count?: number }
    if (chunk.error) throw new HttpError(502, `Ollama: ${chunk.error}`)
    if (chunk.done && typeof chunk.prompt_eval_count === 'number') used = chunk.prompt_eval_count + (chunk.eval_count ?? 0)
    const m = chunk.message
    if (!m) return
    if (m.thinking) {
      thinking += m.thinking
      onDelta({ thinking: m.thinking })
    }
    if (m.content) {
      content += m.content
      onDelta({ content: m.content })
    }
    for (const c of m.tool_calls ?? []) {
      const raw = c.function.arguments
      let args: Record<string, unknown> = {}
      try {
        args = typeof raw === 'string' ? ((JSON.parse(raw || '{}') as Record<string, unknown>) ?? {}) : (raw ?? {})
      } catch {
        /* the tool reports the missing arguments */
      }
      calls.push({ name: c.function.name, arguments: args })
    }
  }
  if (!res.body) throw new HttpError(502, 'Ollama sent nothing')
  for await (const piece of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(piece, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      line(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
    }
  }
  line(buffer)
  return { content, thinking, calls, used }
}

/** Waits for the owner to allow or decline a change (declined when stopped or after 15 minutes). */
function askOwner(thread: string, messageId: number, index: number, signal: AbortSignal, send: (e: TurnEvent) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const callId = randomUUID()
    const done = (allow: boolean) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      const left = (pending.get(thread) ?? []).filter((p) => p.callId !== callId)
      if (left.length) pending.set(thread, left)
      else pending.delete(thread)
      send({ type: 'approved', callId, allow })
      resolve(allow)
    }
    const onAbort = () => done(false)
    const timer = setTimeout(() => done(false), APPROVAL_WAIT)
    signal.addEventListener('abort', onAbort)
    pending.set(thread, [...(pending.get(thread) ?? []), { callId, messageId, index, kind: 'approval', resolve: (a) => done(a === true) }])
    send({ type: 'approval', callId, messageId, index })
  })
}

/** Shows the owner a form and waits for the answers (none when stopped, skipped, or after 30 minutes). */
function askForm(thread: string, messageId: number, index: number, form: Form, signal: AbortSignal, send: (e: TurnEvent) => void): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const callId = randomUUID()
    const done = (answers: Record<string, unknown> | null) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      const left = (pending.get(thread) ?? []).filter((p) => p.callId !== callId)
      if (left.length) pending.set(thread, left)
      else pending.delete(thread)
      send({ type: 'answered', callId })
      resolve(answers)
    }
    const onAbort = () => done(null)
    const timer = setTimeout(() => done(null), 30 * 60_000)
    signal.addEventListener('abort', onAbort)
    pending.set(thread, [...(pending.get(thread) ?? []), { callId, messageId, index, kind: 'question', form, resolve: (a) => done((a as Record<string, unknown> | null) ?? null) }])
    send({ type: 'question', callId, messageId, index, form })
  })
}

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

/**
 * Adds the owner's message and answers it, streaming JSON lines (TurnEvent) to the response. The
 * turn stops when the window goes away or Stop is pressed; what was finished by then stays saved.
 */
export async function runTurn(res: ServerResponse, user: User, id: string, body: { text?: string; attachments?: unknown }) {
  const row = ownThread(user, id)
  const text = String(body.text ?? '').trim()
  const files = checkAttachments(body.attachments)
  if (!text && !files.length) throw new HttpError(400, 'Write something first')
  if (text.length > 20_000) throw new HttpError(413, 'That message is too long')
  if (running.has(row.id)) throw new HttpError(409, 'This thread is still answering')
  const key = requireKey(user)
  const mode = modeOf(row.mode)
  const info = (await models().catch(() => [] as ModelInfo[])).find((m) => m.name === row.model)

  const ctl = new AbortController()
  running.set(row.id, ctl)
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', ...SECURITY })
  // The turn goes on when the window closes (a long job can take a while); only Stop ends it, and
  // the window picks it up again from the saved messages.
  const send = (e: TurnEvent) => void (!res.writableEnded && !res.destroyed && res.write(`${JSON.stringify(e)}\n`))

  try {
    send({ type: 'message', message: addMessage(row.id, { role: 'user', content: text }, files) })
    // A new thread gets its title from the title model, alongside the answer; the first line of
    // the question stands in if that fails.
    if (row.title === NEW_TITLE && !titling.has(row.id)) {
      titling.add(row.id)
      const firstLine = (text || files.map((f) => f.name).join(', ')).split('\n')[0].replace(/\s+/g, ' ').trim()
      makeTitle(user, key, row.id)
        .catch(() => null)
        .then((title) => {
          const t = title || (firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine)
          database().prepare('UPDATE agent_threads SET title = ? WHERE id = ? AND title = ?').run(t, row.id, NEW_TITLE)
        })
        .finally(() => {
          titling.delete(row.id)
          const after = database().prepare('SELECT * FROM agent_threads WHERE id = ?').get(row.id) as ThreadRow | undefined
          if (after) send({ type: 'thread', thread: toThread(after) })
        })
    }
    send({ type: 'thread', thread: toThread(ownThread(user, row.id)) })

    const tools = toolsFor(user, toThread(row).tools, row.project_id !== null)
    const offered = new Set(tools.map((t) => t.function.name))
    const started = Date.now()
    // Thinking is on in both modes (the window shows it, folded). gpt-oss takes a level for it.
    const think = !info?.thinking ? undefined : row.model.startsWith('gpt-oss') ? MODES[mode].think : true
    for (let round = 0; ; round++) {
      // The mode's rounds, or many more while a todo list has open items (within an hour).
      const budget = openTodos(row.id) ? LONG_ROUNDS : MODES[mode].rounds
      const last = round >= budget || Date.now() - started > LONG_TIME // out of rounds: answer with what was found
      const system = (await systemPrompt(user, mode, row.project_id)) + (last ? '\n\nYou have used all your tool calls for this turn: answer now with what you have, and say what is left to do.' : '')
      const messages = [{ role: 'system', content: system }, ...chatHistory(row.id, info?.vision ?? false)]
      const reply = await chat(key, { model: row.model, messages, ...(last || !tools.length ? {} : { tools }), ...(think === undefined ? {} : { think }) }, ctl.signal, (d) => send({ type: 'delta', ...d }))
      const calls = last ? [] : reply.calls
      if (reply.used !== null) database().prepare('UPDATE agent_threads SET context_tokens = ? WHERE id = ?').run(reply.used, row.id)
      const saved = addMessage(row.id, { role: 'assistant', content: reply.content, thinking: reply.thinking, toolCalls: calls })
      send({ type: 'message', message: saved })
      if (!calls.length) break
      // Several calls in one reply (a few searches, say) run side by side. Changes wait for the owner.
      const assistant = saved.id
      const outputs = await Promise.all(
        calls.map(async (c, index) => {
          // Only what this thread offered: a model can still name a tool that is switched off.
          if (!offered.has(c.name)) return JSON.stringify({ error: `${c.name} is switched off for this thread` })
          if (NEEDS_APPROVAL.has(c.name) && !(await askOwner(row.id, assistant, index, ctl.signal, send))) return JSON.stringify({ error: 'The owner declined this change.' })
          if (c.name === 'ask_user') {
            let form: Form
            try {
              form = normalizeForm(c.arguments ?? {})
            } catch (e) {
              return JSON.stringify({ error: (e as Error).message })
            }
            return answerText(form, await askForm(row.id, assistant, index, form, ctl.signal, send))
          }
          return runTool(user, key, row.id, mode, c, ctl.signal)
        }),
      )
      calls.forEach((c, i) => send({ type: 'message', message: addMessage(row.id, { role: 'tool', toolName: c.name, content: outputs[i] }) }))
      // Todo lists and titles show in the window as they change.
      send({ type: 'thread', thread: toThread(ownThread(user, row.id)) })
    }
    send({ type: 'done' })
  } catch (e) {
    if (!ctl.signal.aborted) {
      if (!(e instanceof HttpError)) console.error('agents:', e)
      send({ type: 'error', error: e instanceof HttpError ? e.message : 'Something went wrong' })
    } else send({ type: 'done' })
  } finally {
    running.delete(row.id)
    // Gone when it was deleted while answering.
    const after = database().prepare('SELECT * FROM agent_threads WHERE id = ?').get(row.id) as ThreadRow | undefined
    if (after) send({ type: 'thread', thread: toThread(after) })
    res.end()
  }
}
