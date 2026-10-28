import { api } from '../os/account'
import { synced } from '../os/synced'
import { useEffect, useState } from 'react'
import { parseSkillConfig, type SkillConfig } from './agentSkillRules'
import { getNote } from './notes'
import type { ImageProgress } from './imageModels'
import { generateImageLabel, modelDetailsLabel } from './imageToolLabel'
import { effortFor, type Effort } from './agentModelNames'
import type { ThreadStats } from './agentStats'
import { isHeifFile, isRawFile, stillPicture } from './stillPicture'

// The Agents app's side of server/agents.ts: threads, a turn streamed as JSON lines, memory and
// the models Ollama Cloud offers. The shapes match the server's.

export type Mode = 'quick' | 'deep'
/** A step in the agent's plan for a long job. */
export type Todo = { text: string; status: 'pending' | 'active' | 'done' }
export type Thread = { id: string; title: string; mode: Mode; model: string; archived: boolean; createdAt: number; updatedAt: number; running: boolean; titling: boolean; contextTokens: number | null; tools: ToolGroup[]; projectId: number | null; pinned: boolean; todos: Todo[]; quick: boolean; workdir: Workdir | null; permission: Permission; queue: QueuedMessage[]; interrupted: Interruption | null; titleSource: 'auto' | 'user'; aliases: TitleAlias[]; checkingTitle: boolean; /** A short answer you could give to what the agent's last message asked (null: none, or the message is no longer the last) */ suggestedReply?: string | null; /** A suggested reply is being thought of, in the background */ suggestingReply?: boolean; /** Until when (server time) mail reads run without asking in this thread, while the user allowed them for a while */ mailReadsUntil?: number | null; /** The user allows mail reads always, in every thread (Settings → Agents → Permissions) */ mailReadsAlways?: boolean; /** Always-on skills (by name) and rule instructions (rule:<id>) switched off in this thread, with its chips */ skillsOff?: string[]; /** The thinking effort picked for this thread (null: as the mode has it) */ effort?: Effort | null }
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
/** `ref`: a picture gpt_image made, as the agent can draw from it again (gpt:<id>). */
export type Attachment = { name: string; source: string; kind: 'text' | 'image'; mime: string; size: number; text?: string; data?: string; ref?: string }
export type AttachmentInfo = Omit<Attachment, 'text' | 'data'>
/**
 * `checked` (tool results): why it ran without asking, such as a web read Auto's check cleared.
 * Role 'compact': a compaction, its content the summary the model gets in place of everything
 * before it (the window still shows all of it, with a divider here).
 */
export type AgentMessage = { id: number; role: 'user' | 'assistant' | 'tool' | 'compact' | 'report'; content: string; thinking?: string; toolCalls?: ToolCall[]; toolName?: string; attachments?: AttachmentInfo[]; checked?: string; compact?: Compaction; createdAt: number }
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
export type ToolGroup = 'web' | 'notes' | 'calendar' | 'mail' | 'code' | 'seafile' | 'seafile_write' | 'memory' | 'projects' | 'files' | 'terminal' | 'skills' | 'images' | 'gpt_images' | 'threads'
/** `seafile`, `calendar` and `mail`: only with Seafile linked, a calendar connected, or a mail account linked. */
export const ALWAYS_ON_TOOLS: ToolGroup[] = ['web', 'skills']
export const TOOL_GROUPS: { id: ToolGroup; name: string; detail: string; seafile?: boolean; calendar?: boolean; mail?: boolean }[] = [
  { id: 'threads', name: 'Past threads', detail: 'Look back through your earlier conversations, in every project' },
  { id: 'images', name: 'Images', detail: 'Generate and tune pictures, inspect output, and learn style profiles from feedback' },
  { id: 'gpt_images', name: 'GPT images', detail: 'Pictures and small icons for diagrams with OpenAI gpt-image, once set up in Settings → Agents → Images' },
  { id: 'notes', name: 'Notes', detail: 'Search and make notes; changing or deleting one asks you first' },
  { id: 'calendar', name: 'Calendar', detail: 'Look through your calendars; adding, changing or deleting an event asks you first', calendar: true },
  { id: 'mail', name: 'Mail', detail: 'Search, read, draft, send and file email in your linked accounts; drafts, sends and changes ask you first every time; searches and reads too, unless you allow them (15 minutes in a thread, or always)', mail: true },
  { id: 'code', name: 'Code hosts', detail: 'Repositories, issues and pull requests' },
  { id: 'seafile', name: 'Seafile', detail: 'Find and read files', seafile: true },
  { id: 'seafile_write', name: 'Seafile changes', detail: 'Folders, writing, renaming, moving, deleting; asks you first', seafile: true },
  { id: 'memory', name: 'Memory', detail: 'Remember what you tell it' },
  { id: 'projects', name: 'Projects', detail: 'Make and rename projects, move this thread; asks you first' },
  { id: 'files', name: 'Work folder', detail: "Read, search and edit files in the thread's work folder" },
  { id: 'terminal', name: 'Terminal', detail: 'Run msh commands, from the agents command in the terminal' },
]
/** The groups a thread can switch: every one but the always-on ones. */
export const ALL_TOOLS = TOOL_GROUPS.map((g) => g.id)
/** A thread's switchable groups out of its tools (which always carry the always-on ones). */
export const choosableTools = (tools: ToolGroup[]) => tools.filter((t) => !ALWAYS_ON_TOOLS.includes(t))
/** Why a group does nothing yet, as the hint reads when it is on (`on`, after "On, but") and when it is off (`off`, after "Turning it on needs"). */
const TOOL_BLOCKED: Partial<Record<ToolGroup, { on: string; off: string }>> = {
  calendar: { on: 'no calendar connected (Settings → Integrations → Calendars)', off: 'a connected calendar (Settings → Integrations → Calendars)' },
  mail: { on: 'nothing to use: link a mail account first (Settings → Integrations → Mail)', off: 'a linked mail account (Settings → Integrations → Mail)' },
  seafile: { on: 'nothing to use: link Seafile first (Settings → Integrations → Seafile)', off: 'Seafile linked (Settings → Integrations → Seafile)' },
  seafile_write: { on: 'nothing to use: link Seafile first (Settings → Integrations → Seafile)', off: 'Seafile linked (Settings → Integrations → Seafile)' },
  files: { on: 'no work folder chosen (the folder button above)', off: 'a work folder (the folder button above)' },
  terminal: { on: 'only from the agents command in the terminal, not in this app', off: 'the agents command in the terminal; it does not work in this app' },
}
/**
 * What a group's row says. Three states: on and usable (its own detail), on but unable to do anything
 * here (the cause first), off (what turning it on needs; only said when it is blocked, else its detail).
 * `muted` greys the row; a blocked group may still be switched off, only switching it on is refused.
 */
export function toolState(g: (typeof TOOL_GROUPS)[number], on: boolean, blocked: boolean): { hint: string; muted: boolean } {
  const why = blocked ? TOOL_BLOCKED[g.id] : undefined
  if (!why) return { hint: g.detail, muted: false }
  return { hint: on ? `On, but ${why.on}` : `Off. Turning it on needs ${why.off}`, muted: true }
}
/** The groups there were before choices remembered which groups existed. */
const LEGACY_TOOLS: ToolGroup[] = ['web', 'notes', 'code', 'seafile', 'seafile_write', 'memory']
/** About the user (projectId null) or one project, filed under a category path like "People/Friends". */
export type Memory = { id: number; text: string; category: string; projectId: number | null; threadId: string | null; createdAt: number; updatedAt: number | null; imageLearning?: boolean; imageProfile?: boolean }
export { EFFORTS, EFFORT_NAMES, type Effort } from './agentModelNames'
/**
 * A model a thread can run on: Ollama Cloud's, or OpenAI's (ids prefixed chatgpt/ or openai/).
 * `label` is the provider's own name for it; `efforts` the thinking levels it takes (none: it cannot be set).
 */
export type ModelInfo = { name: string; thinking: boolean; vision: boolean; contextLength: number | null; provider?: 'ollama' | 'chatgpt' | 'openai'; label?: string; efforts?: Effort[]; defaultEffort?: Effort }
/**
 * The effort a thread runs with: its own pick when the model takes it (else the nearest the model
 * has), or what the mode means (quick low, deep high; Ollama's on/off models: on).
 */
export const effectiveEffort = (m: ModelInfo | undefined, picked: Effort | null | undefined, mode: Mode): Effort | null => effortFor(m?.efforts, picked, mode)

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
export type CallSummary = { image?: { name: string; url: string; size: number }; title: string; rows: [string, string][]; /** A text shown whole: the body of an email that would go out */ body?: string; /** create_task, update_task: the task as the server checked it, for the card's editor */ spec?: unknown }
/** Something the agent waits on: a change to allow, or a form to answer; which reply asked and which call. `check`: what Auto's check said about a web read it would not clear. */
export type PendingApproval = { callId: string; messageId: number; index: number; kind: 'approval' | 'question' | 'client' | 'image'; width?: number; height?: number; /** An image job's latest progress */ progress?: ImageProgress; /** A gpt_image picture being drawn */ gpt?: GptDrawing; form?: Form; call?: ToolCall; summary?: CallSummary; check?: string }
/**
 * A gpt_image picture being drawn: a typical time for it (ms), when it started (the server's clock;
 * the window turns it into its own with `elapsed`, how long it had been drawing when the window
 * heard of it) and how many rough previews there are so far.
 */
export type GptDrawing = { expected: number; startedAt: number; elapsed?: number; previews: number }

export type TurnEvent =
  | { type: 'imageGeneration'; callId: string; messageId: number; index: number; width: number; height: number; gpt?: GptDrawing }
  /** A gpt_image picture being drawn has a new rough preview */
  | { type: 'gptPreview'; callId: string; previews: number }
  /** Where an image job is (at most 4 a second) */
  | { type: 'imageProgress'; callId: string; progress: ImageProgress }
  | { type: 'imageGenerationDone'; callId: string }
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
export const createThread = (input: { mode: Mode; model?: string; tools?: ToolGroup[]; projectId?: number | null; quick?: boolean; workdir?: Workdir | null; permission?: Permission; skillsOff?: string[]; effort?: Effort | null }) => api<Thread>('/api/agents/threads', { method: 'POST', json: input })
export const getThread = (id: string) => api<{ thread: Thread; messages: AgentMessage[]; pending: PendingApproval[] }>(`/api/agents/threads/${id}`)
export const answerForm = (id: string, callId: string, answers: Record<string, unknown> | null) =>
  api(`/api/agents/threads/${id}/answer`, { method: 'POST', json: answers ? { callId, answers } : { callId, skip: true } })
/**
 * Allows or declines a change. `always`: allow edits from now on, this command, (a web read) the
 * address's site for good, in all threads, or (a mail search or read) mail reads in this thread for
 * 15 minutes, or always (the setting in Settings → Agents → Permissions); `feedback`: why not, for the agent; `mode`: the permission mode a plan starts in
 * (exit_plan_mode); `edit`: a background task as changed on its card (create_task, update_task).
 */
export const answerApproval = (id: string, callId: string, allow: boolean, extra: { always?: 'edits' | 'command' | 'domain' | 'mail_reads' | 'mail_reads_always'; feedback?: string; mode?: Permission; /** create_task, update_task: the task as edited on the card */ edit?: unknown } = {}) =>
  api(`/api/agents/threads/${id}/approve`, { method: 'POST', json: { callId, allow, ...extra } })
/** The mail tools that only read: their cards offer "allow mail reads for 15 minutes" in the thread (server/agents.ts). */
export const MAIL_READ_TOOLS = new Set(['mail_list_accounts', 'mail_search', 'mail_read'])
/** Mail reads (the agent's mail searches and reads): ask each time (the default), or always allowed. */
export type MailReadsMode = 'ask' | 'always'
/** Said on window when the setting changes here, so open threads show it at once. */
export const MAIL_READS_EVENT = 'mvlos:agents-mail-reads'
export const getMailReads = () => api<{ mode: MailReadsMode }>('/api/agents/mail-reads')
export const setMailReads = (mode: MailReadsMode) =>
  api<{ mode: MailReadsMode }>('/api/agents/mail-reads', { method: 'PUT', json: { mode } }).then((r) => (window.dispatchEvent(new CustomEvent(MAIL_READS_EVENT, { detail: r.mode })), r))
/** Ends the mail reads allowed in a thread before their time. */
export const revokeMailReads = (id: string) => api<Thread>(`/api/agents/threads/${id}/mail-reads`, { method: 'DELETE' })
/** Whole minutes left of mail reads allowed in a thread (rounded up), or 0 when there are none. */
export const mailReadsLeft = (t: Pick<Thread, 'mailReadsUntil'> | null | undefined, now = Date.now()) => (t?.mailReadsUntil && t.mailReadsUntil > now ? Math.ceil((t.mailReadsUntil - now) / 60_000) : 0)
/** What the terminal printed for a terminal tool call. */
export const sendClientResult = (id: string, callId: string, output: string, status: number) => api(`/api/agents/threads/${id}/result`, { method: 'POST', json: { callId, output, status } })
/** `todos: null` dismisses the thread's plan (for the agent too). */
export const updateThread = (id: string, patch: Partial<Pick<Thread, 'title' | 'archived' | 'mode' | 'model' | 'tools' | 'pinned' | 'projectId' | 'quick' | 'workdir' | 'permission' | 'skillsOff' | 'effort'>> & { todos?: null }) => api<Thread>(`/api/agents/threads/${id}`, { method: 'PATCH', json: patch })
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
/** The thread's stats for nerds: each model call and tool call, turn by turn (src/data/agentStats.ts adds them up). */
export const getThreadStats = (id: string) => api<ThreadStats>(`/api/agents/threads/${id}/stats`)

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
  /** The empty message box suggests an answer when the agent's last message asks you something (the server thinks of it) */
  replySuggestions: boolean
  /**
   * Where the model picker's stars were kept before they had a synced set of their own
   * (src/data/agentFavourites.ts moves them over): read only, never changed any more.
   */
  favoriteModels: string[]
  /** How the Agents sidebar looks (src/apps/agentsSidebar/): one of SIDEBAR_STYLES */
  sidebarStyle: SidebarStyle
  /** The model background tasks run on unless a task names its own (null: the Quick model); the server reads it (server/agents.ts taskModel) */
  taskModel: string | null
  /** Where a new task's reports go by default (server/agentTasks.ts reads it) */
  taskReport: TaskReportDefaults
  /** How many runs each task keeps in its history unless it says otherwise: one of RETENTION */
  taskKeep: number
}
/** The report targets a new task starts with (Settings → Apps → Agents → Tasks). */
export type TaskReportDefaults = { when: 'always' | 'failure' | 'condition'; thread: 'none' | 'new' | 'fixed'; notify: boolean; email: 'off' | 'always' | 'unseen' }
const TASK_REPORT_DEFAULTS: TaskReportDefaults = { when: 'condition', thread: 'fixed', notify: true, email: 'off' }
const taskReportOf = (v: unknown): TaskReportDefaults => {
  const r = (v && typeof v === 'object' ? v : {}) as Partial<TaskReportDefaults>
  return {
    when: r.when === 'always' || r.when === 'failure' ? r.when : 'condition',
    thread: r.thread === 'none' || r.thread === 'new' ? r.thread : 'fixed',
    notify: r.notify !== false,
    email: r.email === 'always' || r.email === 'unseen' ? r.email : 'off',
  }
}
/** The history sizes Settings offers for task runs (src/data/agentTaskPolicy.ts has the same). */
export const TASK_KEEP = [20, 50, 100, 250, 500]
/**
 * The looks the Agents sidebar can have, to compare for a while: the first is today's. Each one is
 * a component of its own in src/apps/agentsSidebar/ and a block of CSS beside it, so the ones not
 * kept can be removed with their entry here.
 */
export const SIDEBAR_STYLES = [
  { id: 'classic', label: 'Classic', blurb: 'The original list: projects, then threads by day, with the time on the right.' },
  { id: 'compact', label: 'Compact', blurb: 'One dense line per thread, thin sticky headers and a New thread button next to the search: the most threads at a glance.' },
  { id: 'detailed', label: 'Detailed', blurb: 'Two lines per thread: a title that wraps, then its project or model and when. Running and unread threads have a status bar and badge.' },
  { id: 'focus', label: 'Focus', blurb: 'Filter chips (All, Running, Unread, projects), a Running now section on top and icon buttons below, to see what needs you.' },
] as const
export type SidebarStyle = (typeof SIDEBAR_STYLES)[number]['id']
/** Anything that is not one of the styles is the classic one. */
export const sidebarStyleOf = (v: unknown): SidebarStyle => SIDEBAR_STYLES.find((s) => s.id === v)?.id ?? 'classic'
/** The intervals for the title check that Settings offers, in your messages (server/agents.ts has the same). */
export const TITLE_EVERY = [3, 4, 6, 10]
/** How full the context may get before a thread is compacted by itself, as Settings offers it (server/agents.ts has the same). */
export const COMPACT_AT = [60, 70, 80, 85, 90, 95]
const settingsStore = synced<AgentSettings>('agents', { titleModel: null, checkModel: null, quickModel: null, deepModel: null, mode: 'quick', promptFile: null, tools: ALL_TOOLS, seenTools: ALL_TOOLS, skillsFolder: null, skillsOff: [], titleRefresh: true, titleEvery: 3, autoCompact: true, compactAt: 85, replySuggestions: true, favoriteModels: [], sidebarStyle: 'classic', taskModel: null, taskReport: TASK_REPORT_DEFAULTS, taskKeep: 100 }, {
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
      titleEvery: TITLE_EVERY.includes(Number(s.titleEvery)) ? Number(s.titleEvery) : 3,
      autoCompact: s.autoCompact !== false,
      compactAt: COMPACT_AT.includes(Number(s.compactAt)) ? Number(s.compactAt) : 85,
      replySuggestions: s.replySuggestions !== false,
      favoriteModels: Array.isArray(s.favoriteModels) ? [...new Set(s.favoriteModels.filter((x): x is string => typeof x === 'string' && x.length <= 80))].slice(0, 50) : [],
      sidebarStyle: sidebarStyleOf(s.sidebarStyle),
      taskModel: typeof s.taskModel === 'string' && s.taskModel ? s.taskModel : null,
      taskReport: taskReportOf(s.taskReport),
      taskKeep: TASK_KEEP.includes(Number(s.taskKeep)) ? Number(s.taskKeep) : 100,
    }
  },
})
export const useAgentSettings = settingsStore.use
export const agentSettings = settingsStore.get
export const setAgentSettings = (patch: Partial<AgentSettings>) => settingsStore.set((s) => ({ ...s, ...patch }))
/** Called when newer agents settings arrive from the server or another tab. */
export const onAgentSettingsRemote = settingsStore.onRemote

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
export type Skill = { name: string; description: string; source: 'builtin' | 'user' | 'project'; folder: { repo: string; path: string } | null; label: string; userOnly: boolean; enabled: boolean; /** Its SKILL.md's size in bytes (what it takes always on) */ size: number }
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
/**
 * Always-on skills, where they apply, project overrides and rules (src/data/agentSkillRules.ts):
 * kept with the account on the server, which validates every save. One copy per page, shared by
 * every window that shows it.
 */
let skillConfigValue: SkillConfig | null = null
let skillConfigLoad: Promise<SkillConfig> | null = null
const skillConfigListeners = new Set<() => void>()
const setSkillConfigValue = (c: SkillConfig) => {
  skillConfigValue = c
  skillConfigListeners.forEach((f) => f())
}
export function loadSkillConfig(fresh = false): Promise<SkillConfig> {
  if (fresh || !skillConfigLoad)
    skillConfigLoad = api<unknown>('/api/agents/skill-config').then(
      (raw) => {
        // Read as the server does: whatever is not a valid config counts as none.
        const c = parseSkillConfig(raw).config
        setSkillConfigValue(c)
        return c
      },
      (e) => {
        skillConfigLoad = null
        throw e
      },
    )
  return skillConfigLoad
}
/** Saves the whole config; the server answers it as stored (or refuses it with why). */
export const saveSkillConfig = (c: SkillConfig) => api<unknown>('/api/agents/skill-config', { method: 'PUT', json: c }).then((raw) => parseSkillConfig(raw).config).then((saved) => (setSkillConfigValue(saved), (skillConfigLoad = Promise.resolve(saved)), saved))
/** The config, loaded on first use (null until it is), kept current in every window of the page. */
export function useSkillConfig(): SkillConfig | null {
  const [, bump] = useState(0)
  useEffect(() => {
    const on = () => bump((n) => n + 1)
    skillConfigListeners.add(on)
    void loadSkillConfig().catch(() => {})
    return () => void skillConfigListeners.delete(on)
  }, [])
  return skillConfigValue
}

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
/** Asks for the model list again next time (after signing in with ChatGPT or out, or a new OpenAI key). */
export const forgetAgentModels = () => void (modelList = null)
/** The models a thread can run on (Ollama Cloud's that can use tools, and OpenAI's once set up); asked once per page. */
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

/** Start an idle branch through this message, leaving the original untouched. */
export const branchThread = (id: string, messageId: number) => api<{ thread: Thread; messages: AgentMessage[]; pending: PendingApproval[] }>(`/api/agents/threads/${id}/branch`, { method: 'POST', json: { messageId } })
export async function generateAnother(id: string, imageId: string, onEvent: (e: TurnEvent) => void, signal: AbortSignal) {
  const res = await fetch(`/api/agents/threads/${id}/images/${imageId}/again`, { method: 'POST', credentials: 'same-origin', signal })
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

export async function readEvents(res: Response, onEvent: (e: TurnEvent) => void) {
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

/** A note-and-event tool's result (server/agentNoteLinks.ts): which event, and when. */
function linkOutcome(result: string | undefined): { event: string; when: string } | null {
  if (!result) return null
  try {
    const r = JSON.parse(result) as Record<string, { event?: unknown; title?: unknown; when?: unknown } | undefined>
    const done = r.linked ?? r.unlinked ?? r.linked_to
    const event = done?.event ?? done?.title
    if (typeof event === 'string') return { event, when: String(done?.when ?? '') }
  } catch {
    /* not JSON */
  }
  return null
}

/** What a tool call did, in a few words, for its card; `result`, when it is in, can say more (a calendar event's title). */
export function toolLabel(call: ToolCall, result?: string): string {
  const a = call.arguments ?? {}
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  const note = () => noteName(getNote(s('note_id'))?.text ?? '') || 'a note'
  const linked = linkOutcome(result)
  const event = linked ? `“${linked.event}”${linked.when ? `, ${linked.when}` : ''}` : 'an event'
  const made = call.name.startsWith('calendar_') ? calendarOutcome(result) : null
  if (made) return `${made.done === 'created' ? 'Created' : made.done === 'updated' ? 'Changed' : 'Deleted'} event: ${made.title}${made.when ? `, ${made.when}` : ''}`
  switch (call.name) {
    case 'search_threads': return `Searched past threads for “${s('query')}”`
    case 'read_thread': {
      try { const title = JSON.parse(result ?? '{}').title; if (typeof title === 'string' && title) return `Read “${title}”` } catch { /* The result may not have arrived yet. */ }
      return 'Read an earlier thread'
    }
    case 'read_image_learnings': return 'Read image learning evidence'
    case 'save_image_learning': return 'Save image observation'
    case 'save_image_profile': return 'Save suggested style profile'
    case 'make_image_mask': return `${result ? 'Made a mask' : 'Making a mask'}: “${s('target').slice(0, 80)}”${s('exclude') ? `, keeping “${s('exclude').slice(0, 80)}”` : ''}`
    case 'list_image_masks': return 'Listed image masks'
    case 'generate_image':
      return generateImageLabel(a, result)
    case 'view_generated_image':
      return 'Inspect generated image with vision'
    case 'list_image_models':
      return 'Discover image models'
    case 'model_details':
      return modelDetailsLabel(a, result)
    case 'web_search':
      return `Searched the web for “${s('query')}”`
    case 'find_image':
      return `${result ? 'Found pictures of' : 'Finding pictures of'} “${s('query').slice(0, 80)}”`
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
    case 'notes_for_event':
      return 'Looked at the notes linked to an event'
    case 'events_for_note':
      return `Looked at the events “${note()}” is linked to`
    case 'link_note_to_event':
      return `${linked ? 'Linked' : 'Link'} “${note()}” to ${event}`
    case 'unlink_note_from_event':
      return `${linked ? 'Unlinked' : 'Unlink'} “${note()}” from ${event}`
    case 'make_meeting_note':
      return `${linked ? 'Made' : 'Make'} a meeting note for ${event}`
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
    case 'mail_list_accounts':
      return 'Looked at your mail accounts'
    case 'mail_search':
      return s('query') ? `Searched mail for “${s('query')}”` : `Looked at ${s('mailbox') || 'the Inbox'}`
    case 'mail_read':
      return s('thread_id') && !s('message_id') ? 'Read a conversation' : 'Read an email'
    case 'mail_draft':
      return `${s('forward') ? 'Draft a forward' : s('reply_to') ? 'Draft a reply' : 'Draft an email'}${s('subject') ? `: “${s('subject')}”` : ''}`
    case 'mail_send':
      return `${s('forward') ? 'Forward an email' : s('reply_to') ? 'Reply' : 'Send an email'}${s('subject') ? `: “${s('subject')}”` : ''}`
    case 'mail_update': {
      const n = (Array.isArray(a.message_ids) ? a.message_ids.length : 0) + (Array.isArray(a.thread_ids) ? a.thread_ids.length : 0)
      const verb: Record<string, string> = { archive: 'Archive', trash: 'Trash', move: `Move to ${s('mailbox')}:`, mark_read: 'Mark read:', mark_unread: 'Mark unread:', flag: 'Flag', unflag: 'Unflag', junk: 'Mark as junk:', not_junk: 'Not junk:' }
      return `${verb[s('action')] ?? 'Change'} ${n || ''} ${n === 1 ? 'email' : 'emails'}`.replace(/\s+/g, ' ')
    }
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
    case 'list_generated_images':
      return 'Listed generated images in this thread'
    case 'save_generated_image':
      return `${a.overwrite === true ? 'Save/replace' : 'Save'} generated PNG ${s('path')} in ${s('library')}`
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
  // A camera raw goes as its embedded preview, a HEIC as a JPEG where the browser can decode it, and
  // a multi-picture JPEG (iPhone gain or depth maps) as its primary picture (data/stillPicture.ts).
  const converted = isRawFile(name, mime) || isHeifFile(name, mime)
  if (converted || /^image\/(png|jpe?g|webp|gif)$/.test(mime) || /\.(png|jpe?g|webp|gif)$/i.test(name)) {
    const still = await stillPicture(blob, name, MAX_IMAGE)
    if (still.size > MAX_IMAGE) throw new Error(`${name} is over 5 MB`)
    return { name, source, kind: 'image', mime: converted ? 'image/jpeg' : still.type || mime || 'image/png', size: still.size, data: base64(await still.arrayBuffer()) }
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

export type MentionTool = { name: string; group: ToolGroup | null }
export const listMentionTools = () => api<MentionTool[]>('/api/agents/mention-tools')

/** Explicit user history searches use the same bounded result as the agent tool. */
export type ThreadSearchResult = { error: string } | { found: 0; searched: string; note: string } | {
  note: string; more_threads: boolean; capped: boolean; truncated: boolean;
  threads: { thread_id: string; title: string; project: { id: number | null; name: string } | null; archived: boolean; started: string; last_active: string; also_known_as: string[]; matched: string[]; hits: { message_id: number; from: string; date: string; excerpt: string; attachments?: { name: string; kind: string }[] }[] }[];
}
export const searchPastThreads = (query: string, currentThread: string | null, current = false) => api<ThreadSearchResult>('/api/agents/threads/search', {
  method: 'POST', json: { query, ...(currentThread ? { current_thread: currentThread } : {}), ...(current ? { thread: 'this' } : {}), client: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } },
})
