import { api } from '../os/account'
import { synced } from '../os/synced'
import { getNote } from './notes'

// The Agents app's side of server/agents.ts: threads, a turn streamed as JSON lines, memory and
// the models Ollama Cloud offers. The shapes match the server's.

export type Mode = 'quick' | 'deep'
/** A step in the agent's plan for a long job. */
export type Todo = { text: string; status: 'pending' | 'active' | 'done' }
export type Thread = { id: string; title: string; mode: Mode; model: string; archived: boolean; createdAt: number; updatedAt: number; running: boolean; titling: boolean; contextTokens: number | null; tools: ToolGroup[]; projectId: number | null; pinned: boolean; todos: Todo[]; quick: boolean; workdir: Workdir | null; permission: Permission; queue: QueuedMessage[]; interrupted: Interruption | null; titleSource: 'auto' | 'user'; aliases: TitleAlias[]; checkingTitle: boolean }
/**
 * A title a thread had until `until`, newest first on the thread: the title model changed it when
 * the conversation moved on, or the user renamed it. Shown as "also known as", and found by search.
 */
export type TitleAlias = { title: string; until: number }
/** Whether a thread's title, or one of its earlier titles, has `query` in it (lower case already). */
export const threadMatches = (t: Pick<Thread, 'title' | 'aliases'>, query: string) => !query || [t.title, ...(t.aliases ?? []).map((a) => a.title)].some((x) => x.toLowerCase().includes(query))
/** "Also known as: A, B", or null when the thread never had another title. */
export const alsoKnownAs = (t: Pick<Thread, 'aliases'>) => (t.aliases?.length ? `Also known as: ${t.aliases.map((a) => a.title).join(', ')}` : null)
/**
 * How the last turn was cut short, when it was: the server restarted (a deploy) or stopped without
 * a word (a crash) while it ran, it failed, or it was stopped. Retry runs it again.
 */
export type Interruption = { reason: 'restart' | 'crash' | 'failed' | 'stopped'; error?: string; at: number; /** A /compact was cut short: Retry compacts again (nothing is removed) */ compact?: { instructions?: string } }
/** What a cut-short turn says in the thread. */
export const interruptionText = (i: Interruption) =>
  i.reason === 'restart' ? 'Interrupted: the server restarted (an update)' : i.reason === 'crash' ? 'Interrupted: the server stopped unexpectedly' : i.reason === 'failed' ? `Stopped by an error${i.error ? `: ${i.error}` : ''}` : 'Stopped'
/**
 * A message written while the agent was working, waiting to be sent when it is done (the server
 * keeps the queue and sends them one by one). `editing`: a window is editing it, and the queue waits.
 */
export type QueuedMessage = { id: string; text: string; attachments: AttachmentInfo[]; createdAt: number; editing: boolean }
/** A thread's work folder: a Seafile folder (library and path), and how the terminal showed it (~/Projects/x). */
export type Workdir = { repo: string; path: string; label: string }
/**
 * How changes are allowed: each one asks (Ask first); Auto, the same but web addresses the agent
 * built itself are checked automatically; file edits go through (also checked like Auto); read only
 * while planning; or Bypass, where nothing asks but calendar changes and the agent's own steering
 * files. In the order the chip's menu shows them.
 */
export type Permission = 'default' | 'auto' | 'acceptEdits' | 'plan' | 'bypass'
export const PERMISSIONS: Permission[] = ['default', 'auto', 'acceptEdits', 'plan', 'bypass']
/** A group of threads in the sidebar, with a memory of its own. */
export type Project = { id: number; name: string; sort: number; createdAt: number }
export type ToolCall = { name: string; arguments: Record<string, unknown> }
/** A file sent with a message: text files as text, pictures as base64 (for models that can see). */
export type Attachment = { name: string; source: string; kind: 'text' | 'image'; mime: string; size: number; text?: string; data?: string }
export type AttachmentInfo = Omit<Attachment, 'text' | 'data'>
/**
 * `checked` (tool results): why it ran without asking, such as a web read Auto's check cleared.
 * Role 'compact': a compaction, its content the summary the model gets in place of everything
 * before it (the window still shows all of it, with a divider here).
 */
export type AgentMessage = { id: number; role: 'user' | 'assistant' | 'tool' | 'compact'; content: string; thinking?: string; toolCalls?: ToolCall[]; toolName?: string; attachments?: AttachmentInfo[]; checked?: string; compact?: Compaction; createdAt: number }
/**
 * How a compaction came about (server/agents.ts): asked for with /compact (and what to focus on),
 * or by itself, when the context passed the threshold or the model said it was too long; how many
 * messages it stands in for, and roughly how many tokens they took against the summary's.
 */
export type Compaction = { auto: boolean; reason?: 'threshold' | 'overflow'; instructions?: string; messages: number; before: number; after: number; model: string; request?: string; files?: string[] }
/** "Compacted by itself: the context was nearly full" and the like, for the divider. */
export const compactionText = (c: Compaction | undefined) =>
  !c?.auto ? 'Conversation compacted' : c.reason === 'overflow' ? 'Conversation compacted by itself: the model said it was too long' : 'Conversation compacted by itself: the context was nearly full'
/** "/compact keep the API details": a compaction instead of a message (the server sees it the same way). */
export const isCompact = (text: string) => /^\/compact(?:\s|$)/i.test(text.trim())

/** What a thread may use, switched in the composer. */
export type ToolGroup = 'web' | 'notes' | 'calendar' | 'code' | 'seafile' | 'seafile_write' | 'memory' | 'projects' | 'files' | 'terminal' | 'skills'
/** `seafile` and `calendar`: only with Seafile linked, or a calendar connected. */
export const TOOL_GROUPS: { id: ToolGroup; name: string; detail: string; seafile?: boolean; calendar?: boolean }[] = [
  { id: 'web', name: 'Web', detail: 'Search the web and read pages' },
  { id: 'notes', name: 'Notes', detail: 'Search and make notes; changing or deleting one asks you first' },
  { id: 'calendar', name: 'Calendar', detail: 'Look through your calendars; adding, changing or deleting an event asks you first', calendar: true },
  { id: 'code', name: 'Code hosts', detail: 'Repositories, issues and pull requests' },
  { id: 'seafile', name: 'Seafile', detail: 'Find and read files', seafile: true },
  { id: 'seafile_write', name: 'Seafile changes', detail: 'Folders, writing, renaming, moving, deleting; asks you first', seafile: true },
  { id: 'memory', name: 'Memory', detail: 'Remember what you tell it' },
  { id: 'projects', name: 'Projects', detail: 'Make and rename projects, move this thread; asks you first' },
  { id: 'files', name: 'Work folder', detail: "Read, search and edit files in the thread's work folder" },
  { id: 'terminal', name: 'Terminal', detail: 'Run msh commands, from the agents command in the terminal' },
  { id: 'skills', name: 'Skills', detail: 'Read the skills in ~/.agents/skills and the work folder when a task calls for one' },
]
export const ALL_TOOLS = TOOL_GROUPS.map((g) => g.id)
/** The groups there were before choices remembered which groups existed. */
const LEGACY_TOOLS: ToolGroup[] = ['web', 'notes', 'code', 'seafile', 'seafile_write', 'memory']
/** About the user (projectId null) or one project, filed under a category path like "People/Friends". */
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

/** What a change does, worked out by the server where the call alone doesn't say (a calendar change): a headline and label/value rows. */
export type CallSummary = { title: string; rows: [string, string][] }
/** Something the agent waits on: a change to allow, or a form to answer; which reply asked and which call. `check`: what Auto's check said about a web read it would not clear. */
export type PendingApproval = { callId: string; messageId: number; index: number; kind: 'approval' | 'question' | 'client'; form?: Form; call?: ToolCall; summary?: CallSummary; check?: string }

export type TurnEvent =
  | { type: 'approval'; callId: string; messageId: number; index: number; call?: ToolCall; summary?: CallSummary; check?: string }
  /** A terminal tool call for the terminal to run; clientDone when it is answered or given up */
  | { type: 'client'; callId: string; messageId: number; index: number; call: ToolCall }
  | { type: 'clientDone'; callId: string }
  | { type: 'approved'; callId: string; allow: boolean }
  | { type: 'question'; callId: string; messageId: number; index: number; form: Form }
  | { type: 'answered'; callId: string }
  | { type: 'delta'; content?: string; thinking?: string }
  | { type: 'message'; message: AgentMessage }
  | { type: 'thread'; thread: Thread }
  /** The thread's queue changed */
  | { type: 'queue'; queue: QueuedMessage[] }
  | { type: 'error'; error: string }
  /** A compaction began (its message follows, role 'compact'), or failed; `auto` when nobody asked for it */
  | { type: 'compact'; state: 'start' | 'failed'; auto: boolean; error?: string }
  | { type: 'done' }
  /** First on a follow stream: the thread as it is, with the reply being written so far (null when not running) */
  | { type: 'snapshot'; thread: Thread; messages: AgentMessage[]; pending: PendingApproval[]; live: { content: string; thinking: string } | null }

export const listThreads = (archived: boolean) => api<Thread[]>(`/api/agents/threads${archived ? '?archived=1' : ''}`)
export const createThread = (input: { mode: Mode; model?: string; tools?: ToolGroup[]; projectId?: number | null; quick?: boolean; workdir?: Workdir | null; permission?: Permission }) => api<Thread>('/api/agents/threads', { method: 'POST', json: input })
export const getThread = (id: string) => api<{ thread: Thread; messages: AgentMessage[]; pending: PendingApproval[] }>(`/api/agents/threads/${id}`)
export const answerForm = (id: string, callId: string, answers: Record<string, unknown> | null) =>
  api(`/api/agents/threads/${id}/answer`, { method: 'POST', json: answers ? { callId, answers } : { callId, skip: true } })
/**
 * Allows or declines a change. `always`: allow edits from now on, this command, or (a web read)
 * the address's site for good, in all threads; `feedback`: why not, for the agent; `mode`: the
 * permission mode a plan starts in (exit_plan_mode).
 */
export const answerApproval = (id: string, callId: string, allow: boolean, extra: { always?: 'edits' | 'command' | 'domain'; feedback?: string; mode?: Permission } = {}) =>
  api(`/api/agents/threads/${id}/approve`, { method: 'POST', json: { callId, allow, ...extra } })
/** What the terminal printed for a terminal tool call. */
export const sendClientResult = (id: string, callId: string, output: string, status: number) => api(`/api/agents/threads/${id}/result`, { method: 'POST', json: { callId, output, status } })
/** `todos: null` dismisses the thread's plan (for the agent too). */
export const updateThread = (id: string, patch: Partial<Pick<Thread, 'title' | 'archived' | 'mode' | 'model' | 'tools' | 'pinned' | 'projectId' | 'quick' | 'workdir' | 'permission'>> & { todos?: null }) => api<Thread>(`/api/agents/threads/${id}`, { method: 'PATCH', json: patch })
export const deleteThread = (id: string) => api(`/api/agents/threads/${id}`, { method: 'DELETE' })
export const stopThread = (id: string) => api(`/api/agents/threads/${id}/stop`, { method: 'POST' })

// The queue (server/agents.ts): messages written while the agent works, sent one by one after it.
const client = () => ({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
/** Adds a message to the queue (on a thread at rest with nothing queued, it is simply sent: follow the thread). */
export const queueMessage = (id: string, text: string, attachments: Attachment[]) => api<{ thread: Thread }>(`/api/agents/threads/${id}/queue`, { method: 'POST', json: { text, attachments, client: client() } })
/**
 * While the agent waits on you (changes to allow, a plan, a form): the message answers all of them
 * instead, declining the changes with it as the reason. Waiting on nothing by then, it is queued.
 */
export const overrideTurn = (id: string, text: string, attachments: Attachment[]) => api<{ thread: Thread; queued: boolean }>(`/api/agents/threads/${id}/override`, { method: 'POST', json: { text, attachments, client: client() } })
/** Starts editing a queued message: the queue waits (say so again within two minutes to keep it waiting), and the whole message comes back. */
export const editQueued = (id: string, qid: string) => api<{ thread: Thread; item: { id: string; text: string; attachments: Attachment[] } }>(`/api/agents/threads/${id}/queue/${qid}`, { method: 'PATCH', json: { editing: true } })
/** Saves an edited queued message (leave out `attachments` to keep them), which ends the edit. */
export const saveQueued = (id: string, qid: string, patch: { text: string; attachments?: Attachment[] }) => api<{ thread: Thread }>(`/api/agents/threads/${id}/queue/${qid}`, { method: 'PATCH', json: patch })
/** Ends an edit without saving: the queue goes on. */
export const releaseQueued = (id: string, qid: string) => api<{ thread: Thread }>(`/api/agents/threads/${id}/queue/${qid}`, { method: 'PATCH', json: { editing: false } })
export const removeQueued = (id: string, qid: string) => api<{ thread: Thread }>(`/api/agents/threads/${id}/queue/${qid}`, { method: 'DELETE' })
/** Send now: stops the agent if it is working and sends this message next; while it waits on you, the message answers instead. */
export const sendQueuedNow = (id: string, qid: string) => api<{ thread: Thread }>(`/api/agents/threads/${id}/queue/${qid}/send`, { method: 'POST' })
/** Quick answers asked from Spotlight and not continued in the app, newest first (expired ones pruned). */
export type QuickAnswerInfo = { thread: Thread; question: string; answer: string }
export const listQuick = () => api<QuickAnswerInfo[]>('/api/agents/quick')
export const clearQuick = () => api('/api/agents/quick', { method: 'DELETE' })
export const suggestTitle = (id: string) => api<{ title: string | null }>(`/api/agents/threads/${id}/title`, { method: 'POST' })
/**
 * Regenerate title: a fresh title for what the thread talks about now, saved at once. The title
 * model looks after the title again from then on, also when it was renamed by hand before.
 */
export const regenerateTitle = (id: string) => api<{ thread: Thread }>(`/api/agents/threads/${id}/retitle`, { method: 'POST' })

export type ContextPart = { label: string; tokens: number }
/**
 * `compaction`: the last one, when the thread has been compacted (how many messages before it the
 * summary stands in for, and how many times in all); `autoCompact`: the threshold in percent of the
 * window, null when compacting by itself is off.
 */
export type ContextInfo = { model: string; contextLength: number | null; measured: number | null; estimate: number; parts: ContextPart[]; compaction: { at: number; auto: boolean; hidden: number; times: number } | null; autoCompact: number | null }
export const getContext = (id: string) => api<ContextInfo>(`/api/agents/threads/${id}/context`)

export type PromptInfo = { text: string; source: 'seafile' | 'builtin'; repo: string | null; path: string | null; missing: boolean; error: string | null }
export const getDefaults = () => api<{ quick: string; deep: string; title: string; check: string }>('/api/agents/defaults')

/** A web site you allowed for good ("Allow github.com"): every thread reads addresses there without asking. */
export type AllowedSite = { host: string; createdAt: number }
export const listSites = () => api<AllowedSite[]>('/api/agents/sites')
export const allowSite = (host: string) => api<AllowedSite[]>('/api/agents/sites', { method: 'POST', json: { host } })
export const removeSite = (host: string) => api<AllowedSite[]>(`/api/agents/sites/${encodeURIComponent(host)}`, { method: 'DELETE' })
/** The site an address is on, as "Allow …" names it: without www. */
export const siteOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}
export const getPrompt = (fresh = false) => api<PromptInfo>(`/api/agents/prompt${fresh ? '?fresh' : ''}`)

/**
 * The app's own settings, synced (and read by the server): the model that names threads, and where
 * ~/AGENTS.md is in Seafile when Seafile is home.
 */
export type AgentSettings = {
  titleModel: string | null
  /** The safety check model: checks web addresses the agent built itself, in Auto (null: the usual one) */
  checkModel: string | null
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
  /** ~/.agents/skills in Seafile, when home is there (src/data/agentPlaces.ts keeps it up to date) */
  skillsFolder: { repo: string; path: string; label: string } | null
  /** Skills switched off: the agents do not see them */
  skillsOff: string[]
  /** Titles are checked against the conversation now and then, and changed when it moved on (the server does it) */
  titleRefresh: boolean
  /** Every how many of your messages that check runs: one of TITLE_EVERY */
  titleEvery: number
  /** Long threads are compacted by themselves when the context gets full (the server does it) */
  autoCompact: boolean
  /** How full, in percent of the model's context window: one of COMPACT_AT */
  compactAt: number
}
/** The intervals for the title check that Settings offers, in your messages (server/agents.ts has the same). */
export const TITLE_EVERY = [3, 4, 6, 10]
/** How full the context may get before a thread is compacted by itself, as Settings offers it (server/agents.ts has the same). */
export const COMPACT_AT = [60, 70, 80, 85, 90, 95]
const settingsStore = synced<AgentSettings>('agents', { titleModel: null, checkModel: null, quickModel: null, deepModel: null, mode: 'quick', promptFile: null, tools: ALL_TOOLS, seenTools: ALL_TOOLS, skillsFolder: null, skillsOff: [], titleRefresh: true, titleEvery: 4, autoCompact: true, compactAt: 85 }, {
  normalize: (v) => {
    const s = (v ?? {}) as Partial<AgentSettings>
    return {
      titleModel: typeof s.titleModel === 'string' ? s.titleModel : null,
      checkModel: typeof s.checkModel === 'string' ? s.checkModel : null,
      quickModel: typeof s.quickModel === 'string' ? s.quickModel : null,
      deepModel: typeof s.deepModel === 'string' ? s.deepModel : null,
      mode: s.mode === 'deep' ? 'deep' : 'quick',
      promptFile: s.promptFile && typeof s.promptFile.repo === 'string' && typeof s.promptFile.path === 'string' ? s.promptFile : null,
      // Groups added since the choice was saved are on, like every group is for someone new.
      tools: Array.isArray(s.tools) ? ALL_TOOLS.filter((t) => s.tools!.includes(t) || !(Array.isArray(s.seenTools) ? s.seenTools : LEGACY_TOOLS).includes(t)) : ALL_TOOLS,
      seenTools: ALL_TOOLS,
      skillsFolder: s.skillsFolder && typeof s.skillsFolder.repo === 'string' && typeof s.skillsFolder.path === 'string' ? { repo: s.skillsFolder.repo, path: s.skillsFolder.path, label: String(s.skillsFolder.label ?? s.skillsFolder.path) } : null,
      skillsOff: Array.isArray(s.skillsOff) ? s.skillsOff.filter((x): x is string => typeof x === 'string') : [],
      titleRefresh: s.titleRefresh !== false,
      titleEvery: TITLE_EVERY.includes(Number(s.titleEvery)) ? Number(s.titleEvery) : 4,
      autoCompact: s.autoCompact !== false,
      compactAt: COMPACT_AT.includes(Number(s.compactAt)) ? Number(s.compactAt) : 85,
    }
  },
})
export const useAgentSettings = settingsStore.use
export const agentSettings = settingsStore.get
export const setAgentSettings = (patch: Partial<AgentSettings>) => settingsStore.set((s) => ({ ...s, ...patch }))

/**
 * Whether "don't ask again" makes sense for a terminal command: never for commands that run other
 * command lines or change files (the server asks for those anyway), nor for lines that write a file.
 */
const NEVER_ALWAYS = new Set(['msh', 'sh', 'bash', 'eval', 'source', '.', 'xargs', 'find', 'fd', 'sudo', 'env', 'command', 'watch', 'exec', 'rm', 'mv', 'cp', 'curl', 'wget'])
export function canAlwaysAllow(command: string): boolean {
  const names = command.split(/[|;&\n]/).map((p) => p.trim().split(/\s+/)[0]).filter(Boolean)
  return !!names.length && !names.some((n) => NEVER_ALWAYS.has(n)) && !/(^|[^<>&0-9])(\d?>{1,2}|&>)\s*(?!&|\/dev\/null\b)\S/.test(command)
}

/** A skill: instructions for a kind of task, in a folder with a SKILL.md (server/skills.ts). */
export type Skill = { name: string; description: string; source: 'builtin' | 'user' | 'project'; folder: { repo: string; path: string } | null; label: string; userOnly: boolean; enabled: boolean }
/** Where to look for skills besides the user's and the built-in ones: a thread's work folder, or a folder. */
export type SkillsWhere = { thread?: string; folder?: Workdir | null; fresh?: boolean }
const skillsQuery = (w: SkillsWhere = {}) => {
  const q = new URLSearchParams()
  if (w.fresh) q.set('fresh', '1')
  if (w.thread) q.set('thread', w.thread)
  else if (w.folder) Object.entries(w.folder).forEach(([k, v]) => q.set(k, v))
  const s = q.toString()
  return s ? `?${s}` : ''
}
export const listSkills = (w?: SkillsWhere) => api<Skill[]>(`/api/agents/skills${skillsQuery(w)}`)
export const skillInfo = (name: string, w?: SkillsWhere) => api<Skill & { body: string; files: string[] }>(`/api/agents/skills/${encodeURIComponent(name)}${skillsQuery(w)}`)
/** Installs skills from GitHub into a skills folder (the user's, unless `folder` says another). */
export const installSkills = (input: { source: string; skill?: string; force?: boolean; folder?: Workdir | null }) =>
  api<{ installed: { name: string; files: number; label: string }[]; from: string }>('/api/agents/skills/install', { method: 'POST', json: input })
export const removeSkill = (name: string, folder?: Workdir | null) => api('/api/agents/skills/remove', { method: 'POST', json: { name, folder } })
export const setSkillEnabled = (name: string, on: boolean) => setAgentSettings({ skillsOff: on ? agentSettings().skillsOff.filter((n) => n !== name) : [...new Set([...agentSettings().skillsOff, name])] })

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
 * Sends the user's message and reads the answer as it streams: each JSON line is one event.
 * Aborting `signal` stops the turn on the server too.
 */
export async function sendMessage(id: string, text: string, attachments: Attachment[], onEvent: (e: TurnEvent) => void, signal: AbortSignal, opts: { terminal?: boolean } = {}) {
  const res = await fetch(`/api/agents/threads/${id}/messages`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    // From the terminal's agents command, which can run the terminal tool. The time zone gives the
    // agent today's date and the calendar tools' times where the user is.
    body: JSON.stringify({ text, attachments, client: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(opts.terminal ? { terminal: true } : {}) } }),
    signal,
  })
  await readEvents(res, onEvent)
}

/**
 * Retry: the thread's last turn again (its partial, failed or finished reply goes), streamed like
 * sendMessage. Queued messages run after it.
 */
export async function retryTurn(id: string, onEvent: (e: TurnEvent) => void, signal: AbortSignal, opts: { terminal?: boolean } = {}) {
  const res = await fetch(`/api/agents/threads/${id}/retry`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(opts.terminal ? { terminal: true } : {}) } }),
    signal,
  })
  await readEvents(res, onEvent)
}

/**
 * Rewind to one of your messages: it and everything after it leave the thread (a running turn is
 * stopped first), and it comes back, files and all, to edit and send again. What tools changed is
 * not undone.
 */
export const rewindThread = (id: string, messageId: number) => api<{ thread: Thread; removed: number; message: { text: string; attachments: Attachment[] } }>(`/api/agents/threads/${id}/rewind`, { method: 'POST', json: { messageId } })

/**
 * A shared link (server/shares.ts): a snapshot of a whole thread, or of one answer with the message
 * it answers, that anyone with `url` can read until it expires or sharing stops.
 */
export type Share = { token: string; url: string; kind: 'thread' | 'response'; title: string; threadId: string; messageId: number | null; createdAt: number; expiresAt: number | null; views: number }
export type ShareExpiry = 'never' | '1h' | '1d' | '7d' | '30d'
export const SHARE_EXPIRY: { value: ShareExpiry; label: string }[] = [
  { value: 'never', label: 'Never expires' },
  { value: '1h', label: '1 hour' },
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
]
/** What a share leaves out, said wherever one is made. */
export const SHARE_NOTE = 'Shares the questions and answers. Tool results, files, memories and thinking are not included; the steps it took show as short labels.'
export const shareThread = (id: string, input: { kind: 'thread' | 'response'; messageId?: number; expires: ShareExpiry }) => api<Share>(`/api/agents/threads/${id}/share`, { method: 'POST', json: input })
export const listShares = (thread?: string) => api<Share[]>(`/api/agents/shares${thread ? `?thread=${thread}` : ''}`)
export const stopSharing = (token: string) => api(`/api/agents/shares/${token}`, { method: 'DELETE' })
/** When a share stops working, in words: "never expires", "expires in 6 days". */
export function expiryText(s: Share): string {
  if (s.expiresAt === null) return 'never expires'
  const left = s.expiresAt - Date.now()
  if (left <= 0) return 'expired'
  const min = Math.round(left / 60_000)
  const h = Math.round(left / 3600_000)
  return `expires in ${min < 60 ? `${Math.max(1, min)} min` : h < 48 ? `${h} h` : `${Math.round(h / 24)} days`}`
}

/** A stream that broke on the way (the network, or the server restarting), not one the server refused. */
export const isDropped = (e: unknown) => e instanceof TypeError || (e as Error)?.name === 'NetworkError'

/**
 * Joins a turn this window did not start (opened again while it runs, or another tab): a snapshot
 * with the reply written so far, then its events live. Resolves when the turn ends.
 */
export async function followThread(id: string, onEvent: (e: TurnEvent) => void, signal: AbortSignal, opts: { terminal?: boolean } = {}) {
  await readEvents(await fetch(`/api/agents/threads/${id}/follow${opts.terminal ? '?client=terminal' : ''}`, { credentials: 'same-origin', signal }), onEvent)
}

async function readEvents(res: Response, onEvent: (e: TurnEvent) => void) {
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

/** A note's first line, without Markdown's marks, for a tool card. */
const noteName = (text: string) => (text.split('\n').find((l) => l.trim()) ?? '').replace(/^\s*(#{1,6}\s+|[-*+]\s+)/, '').trim().slice(0, 60)

/**
 * A time the agent gave a calendar tool ("2026-10-14T10:00", in your zone unless it has an offset)
 * as "Tue 14 Oct 10:00"; a date alone without the time.
 */
export function calendarTime(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(raw.trim())
  if (!m) return raw
  const [, y, mo, d, h, mi, off] = m
  const at = h === undefined ? new Date(+y, +mo - 1, +d) : off ? new Date(raw.trim()) : new Date(+y, +mo - 1, +d, +h, +mi)
  if (isNaN(at.getTime())) return raw
  const day = at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(at.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }).replace(',', '')
  return h === undefined ? day : `${day} ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
}

/** A calendar tool's result: the event it made, changed or deleted, as the server describes it. */
function calendarOutcome(result: string | undefined): { done: 'created' | 'updated' | 'deleted'; title: string; when: string } | null {
  if (!result) return null
  try {
    const r = JSON.parse(result) as Record<string, { title?: unknown; when?: unknown } | undefined>
    for (const done of ['created', 'updated', 'deleted'] as const) if (r[done] && typeof r[done]!.title === 'string') return { done, title: r[done]!.title as string, when: String(r[done]!.when ?? '') }
  } catch {
    /* not JSON: no outcome */
  }
  return null
}

/** What a tool call did, in a few words, for its card; `result`, when it is in, can say more (a calendar event's title). */
export function toolLabel(call: ToolCall, result?: string): string {
  const a = call.arguments ?? {}
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  const made = call.name.startsWith('calendar_') ? calendarOutcome(result) : null
  if (made) return `${made.done === 'created' ? 'Created' : made.done === 'updated' ? 'Changed' : 'Deleted'} event: ${made.title}${made.when ? `, ${made.when}` : ''}`
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
      return s('query') ? `Searched notes for “${s('query')}”` : 'Looked at your latest notes'
    case 'create_note':
      return `Made the note “${noteName(s('text'))}”`
    case 'update_note':
      return `${a.append === true ? 'Add to' : 'Change'} the note “${noteName(getNote(s('id'))?.text ?? '') || 'a note'}”`
    case 'delete_note':
      return `Move the note “${noteName(getNote(s('id'))?.text ?? '') || 'a note'}” to the trash`
    case 'calendar_list_calendars':
      return 'Looked at your calendars'
    case 'calendar_list_events': {
      const range = s('from') || s('to') ? ` ${s('from') ? calendarTime(s('from')) : 'now'} – ${s('to') ? calendarTime(s('to')) : 'later'}` : ''
      return s('query') ? `Searched your calendar for “${s('query')}”${range}` : `Looked at your calendar${range || ', the next 14 days'}`
    }
    case 'calendar_create_event':
      return `Add event “${s('title')}”${s('start') ? `, ${calendarTime(s('start'))}` : ''}`
    case 'calendar_update_event':
      return `Change an event${s('title') ? ` to “${s('title')}”` : ''}${s('start') ? `, ${calendarTime(s('start'))}` : ''}`
    case 'calendar_delete_event':
      return a.all_occurrences === true ? 'Delete a repeating event' : 'Delete an event'
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
    case 'read_file':
      return `Read ${s('path')}${a.offset ? ` from line ${String(a.offset)}` : ''}`
    case 'write_file':
      return `Write ${s('path')} (${s('content').split('\n').length} lines)`
    case 'edit_file':
      return `Edit ${s('path')}`
    case 'multi_edit':
      return `Edit ${s('path')} (${Array.isArray(a.edits) ? a.edits.length : 0} changes)`
    case 'list_dir':
      return `Listed ${s('path') || 'the work folder'}`
    case 'glob':
      return `Found files matching ${s('pattern')}`
    case 'grep':
      return `Searched for “${s('pattern')}”${s('path') ? ` in ${s('path')}` : ''}`
    case 'make_dir':
      return `Make folder ${s('path')}`
    case 'move_path':
      return `Move ${s('from')} to ${s('to')}`
    case 'delete_path':
      return `Delete ${s('path')}`
    case 'terminal':
      return s('description') || `Ran ${s('command').split('\n')[0].slice(0, 80)}`
    case 'exit_plan_mode':
      return 'Presented a plan'
    case 'use_skill':
      return `Read the skill ${s('name')}`
    case 'read_skill_file':
      return `Read ${s('path')} from the skill ${s('name')}`
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

/** The longest message the server takes as typed text (server/agents.ts); longer goes as a file. */
export const MAX_MESSAGE = 20_000
/** A paste this long becomes an attachment instead of filling the message box. */
export const PASTE_AS_FILE = 5_000

/** Text (a long paste or message) as a text attachment. */
export function textAttachment(text: string, name: string): Attachment {
  if (text.length > 400_000) throw new Error(`${name} is too long (over 400,000 characters)`)
  return { name, source: 'Pasted', kind: 'text', mime: 'text/plain', size: new Blob([text]).size, text }
}

/** Where a picture sent with a message loads from (server/agents.ts messagePicture): `index` among the message's attachments. */
export const pictureUrl = (thread: string, message: number, index: number) => `/api/agents/threads/${thread}/messages/${message}/attachments/${index}`

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
