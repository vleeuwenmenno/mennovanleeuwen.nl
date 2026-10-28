import type { Schedule } from './agentTaskSchedule.ts'

// Agent tasks (server/agentTasks.ts): what a task is, and the permission policy a task's runs work
// under. Shared by the browser (the Tasks tab's editor and its plain-words summary) and the server,
// where taskDecide is the only authority over a task run's tool calls: the thread permission modes,
// "always allow" grants, allowed sites and mail read grants never reach a task run. No DOM or Node
// APIs here.
//
// Every tool the agents know is in TASK_TOOLS with what kind of thing it does. A tool that is not
// in the table is blocked, and so is one a task's policy has not seen yet (a tool added in a later
// release starts blocked for tasks that already exist, unlike threads, where new groups start on).

export type Verdict = 'allow' | 'ask' | 'block'
/**
 * What a tool does, for the defaults and the warnings: reads public things, reads private things
 * (`private`), changes something (`write`), sends something out (`egress`), costs money or quota
 * (`cost`), keeps something beyond the run (`lasting`), or belongs to the run itself (`internal`).
 */
export type ToolClass = 'read' | 'private' | 'write' | 'egress' | 'cost' | 'lasting' | 'internal'
export type TaskGroup = 'web' | 'notes' | 'calendar' | 'mail' | 'code' | 'seafile' | 'seafile_write' | 'memory' | 'projects' | 'threads' | 'skills' | 'gpt_images' | 'images' | 'files' | 'terminal' | 'chat' | 'tasks' | 'run'
export type TaskTool = {
  group: TaskGroup
  class: ToolClass
  /** What it does, for the editor */
  label: string
  /** Where it starts on a new task */
  default: Verdict
  /** The most it may be: mail sends, calendar writes and the like never run without asking */
  cap?: Verdict
  /** Reads what other people wrote (web pages, mail): a way in for instructions that are not the user's */
  untrusted?: boolean
  /** Why it is not there in task runs (never offered, whatever the policy says) */
  unavailable?: string
}

const NO_FOLDER = 'Tasks have no work folder yet'
const NOT_IN_TASKS = 'Not in task runs: nobody is there to answer'
const NO_IMAGES = 'Image generation is not available in task runs yet'

export const TASK_TOOLS: Record<string, TaskTool> = {
  web_search: { group: 'web', class: 'read', label: 'Search the web', default: 'allow', untrusted: true },
  web_fetch: { group: 'web', class: 'read', label: 'Read web pages (only on the sites you list without asking)', default: 'allow', untrusted: true },
  find_image: { group: 'web', class: 'lasting', label: 'Find and keep real photos from the web', default: 'block', untrusted: true },
  search_threads: { group: 'threads', class: 'private', label: 'Search your past threads', default: 'ask' },
  read_thread: { group: 'threads', class: 'private', label: 'Read a past thread', default: 'ask' },
  search_notes: { group: 'notes', class: 'private', label: 'Search your notes', default: 'allow' },
  create_note: { group: 'notes', class: 'lasting', label: 'Make a note', default: 'block' },
  update_note: { group: 'notes', class: 'write', label: 'Change a note', default: 'block' },
  delete_note: { group: 'notes', class: 'write', label: 'Delete a note', default: 'block' },
  calendar_list_calendars: { group: 'calendar', class: 'private', label: 'List your calendars', default: 'allow' },
  calendar_list_events: { group: 'calendar', class: 'private', label: 'Look through events', default: 'allow' },
  calendar_create_event: { group: 'calendar', class: 'write', label: 'Add an event', default: 'block', cap: 'ask' },
  calendar_update_event: { group: 'calendar', class: 'write', label: 'Change an event', default: 'block', cap: 'ask' },
  calendar_delete_event: { group: 'calendar', class: 'write', label: 'Delete an event', default: 'block', cap: 'ask' },
  notes_for_event: { group: 'calendar', class: 'private', label: 'Notes linked to an event', default: 'allow' },
  events_for_note: { group: 'calendar', class: 'private', label: 'Events linked to a note', default: 'allow' },
  link_note_to_event: { group: 'calendar', class: 'write', label: 'Link a note to an event', default: 'block', cap: 'ask' },
  unlink_note_from_event: { group: 'calendar', class: 'write', label: 'Unlink a note from an event', default: 'block', cap: 'ask' },
  make_meeting_note: { group: 'calendar', class: 'write', label: 'Make a meeting note', default: 'block', cap: 'ask' },
  mail_list_accounts: { group: 'mail', class: 'private', label: 'List your mail accounts', default: 'ask' },
  mail_search: { group: 'mail', class: 'private', label: 'Search mail', default: 'ask', untrusted: true },
  mail_read: { group: 'mail', class: 'private', label: 'Read mail', default: 'ask', untrusted: true },
  mail_draft: { group: 'mail', class: 'write', label: 'Save a draft', default: 'block' },
  mail_send: { group: 'mail', class: 'egress', label: 'Send mail', default: 'block', cap: 'ask' },
  mail_update: { group: 'mail', class: 'write', label: 'Archive, move, flag or mark mail', default: 'block' },
  search_code: { group: 'code', class: 'read', label: 'Search your code hosts', default: 'allow' },
  seafile_list: { group: 'seafile', class: 'private', label: 'List Seafile folders', default: 'ask' },
  seafile_search: { group: 'seafile', class: 'private', label: 'Find Seafile files', default: 'ask' },
  seafile_read: { group: 'seafile', class: 'private', label: 'Read Seafile files', default: 'ask' },
  seafile_mkdir: { group: 'seafile_write', class: 'write', label: 'Make Seafile folders', default: 'block' },
  seafile_write: { group: 'seafile_write', class: 'write', label: 'Write Seafile files', default: 'block' },
  seafile_rename: { group: 'seafile_write', class: 'write', label: 'Rename in Seafile', default: 'block' },
  seafile_move: { group: 'seafile_write', class: 'write', label: 'Move or copy in Seafile', default: 'block' },
  seafile_delete: { group: 'seafile_write', class: 'write', label: 'Delete in Seafile', default: 'block' },
  save_generated_image: { group: 'seafile_write', class: 'write', label: 'Save a generated picture to Seafile', default: 'block', unavailable: NO_IMAGES },
  remember: { group: 'memory', class: 'lasting', label: 'Remember facts', default: 'block' },
  update_memory: { group: 'memory', class: 'lasting', label: 'Change a memory', default: 'block' },
  list_projects: { group: 'projects', class: 'read', label: 'List projects', default: 'allow' },
  create_project: { group: 'projects', class: 'lasting', label: 'Make a project', default: 'block' },
  rename_project: { group: 'projects', class: 'lasting', label: 'Rename a project', default: 'block' },
  move_thread: { group: 'projects', class: 'lasting', label: 'Move the thread', default: 'block', unavailable: 'A run has no thread of its own to move' },
  use_skill: { group: 'skills', class: 'read', label: 'Read a skill', default: 'allow' },
  read_skill_file: { group: 'skills', class: 'read', label: "Read a skill's file", default: 'allow' },
  gpt_image: { group: 'gpt_images', class: 'cost', label: 'Draw a picture with gpt-image (counts against your daily limit)', default: 'block' },
  list_icons: { group: 'gpt_images', class: 'read', label: 'List your icons', default: 'allow' },
  generate_image: { group: 'images', class: 'cost', label: 'Generate a picture', default: 'block', unavailable: NO_IMAGES },
  plan_video: { group: 'images', class: 'lasting', label: 'Plan a video', default: 'block', unavailable: NO_IMAGES },
  render_video: { group: 'images', class: 'cost', label: 'Render a video (minutes of your GPU)', default: 'block', unavailable: NO_IMAGES },
  make_image_mask: { group: 'images', class: 'lasting', label: 'Select part of a picture', default: 'block', unavailable: NO_IMAGES },
  list_image_masks: { group: 'images', class: 'read', label: 'List masks', default: 'block', unavailable: NO_IMAGES },
  list_image_attachments: { group: 'images', class: 'read', label: 'List pictures', default: 'block', unavailable: NO_IMAGES },
  list_image_models: { group: 'images', class: 'read', label: 'List image models', default: 'block', unavailable: NO_IMAGES },
  model_details: { group: 'images', class: 'read', label: 'Image model details', default: 'block', unavailable: NO_IMAGES },
  list_generated_images: { group: 'images', class: 'read', label: 'List generated pictures', default: 'block', unavailable: NO_IMAGES },
  view_generated_image: { group: 'images', class: 'read', label: 'Look at a picture', default: 'block', unavailable: NO_IMAGES },
  read_image_learnings: { group: 'images', class: 'read', label: 'Read image learnings', default: 'block', unavailable: NO_IMAGES },
  save_image_learning: { group: 'images', class: 'lasting', label: 'Save an image learning', default: 'block', unavailable: NO_IMAGES },
  save_image_profile: { group: 'images', class: 'lasting', label: 'Save an image profile', default: 'block', unavailable: NO_IMAGES },
  read_file: { group: 'files', class: 'private', label: 'Read a file', default: 'block', unavailable: NO_FOLDER },
  list_dir: { group: 'files', class: 'private', label: 'List a folder', default: 'block', unavailable: NO_FOLDER },
  glob: { group: 'files', class: 'private', label: 'Find files', default: 'block', unavailable: NO_FOLDER },
  grep: { group: 'files', class: 'private', label: 'Search files', default: 'block', unavailable: NO_FOLDER },
  write_file: { group: 'files', class: 'write', label: 'Write a file', default: 'block', unavailable: NO_FOLDER },
  edit_file: { group: 'files', class: 'write', label: 'Edit a file', default: 'block', unavailable: NO_FOLDER },
  multi_edit: { group: 'files', class: 'write', label: 'Edit a file', default: 'block', unavailable: NO_FOLDER },
  make_dir: { group: 'files', class: 'write', label: 'Make a folder', default: 'block', unavailable: NO_FOLDER },
  move_path: { group: 'files', class: 'write', label: 'Move a file', default: 'block', unavailable: NO_FOLDER },
  delete_path: { group: 'files', class: 'write', label: 'Delete a file', default: 'block', unavailable: NO_FOLDER },
  terminal: { group: 'terminal', class: 'write', label: 'Run terminal commands', default: 'block', unavailable: 'The terminal runs in your browser: not there for a run in the background' },
  ask_user: { group: 'chat', class: 'internal', label: 'Ask you with a form', default: 'block', unavailable: NOT_IN_TASKS },
  exit_plan_mode: { group: 'chat', class: 'internal', label: 'Show a plan', default: 'block', unavailable: NOT_IN_TASKS },
  create_task: { group: 'tasks', class: 'lasting', label: 'Make a task', default: 'block', unavailable: 'Tasks never make tasks' },
  update_task: { group: 'tasks', class: 'lasting', label: 'Change a task', default: 'block', unavailable: 'Tasks never change tasks' },
  cancel_task: { group: 'tasks', class: 'lasting', label: 'Cancel a task', default: 'block', unavailable: 'Tasks never cancel tasks' },
  update_todos: { group: 'run', class: 'internal', label: 'Keep a todo list', default: 'allow' },
  task_report: { group: 'run', class: 'internal', label: 'Say how the run went (always there)', default: 'allow' },
}

/** The groups the editor shows, in order, with a name each. */
export const TASK_GROUPS: { id: TaskGroup; name: string }[] = [
  { id: 'web', name: 'Web' },
  { id: 'code', name: 'Code hosts' },
  { id: 'notes', name: 'Notes' },
  { id: 'calendar', name: 'Calendar' },
  { id: 'mail', name: 'Mail' },
  { id: 'seafile', name: 'Seafile' },
  { id: 'seafile_write', name: 'Seafile changes' },
  { id: 'threads', name: 'Past threads' },
  { id: 'memory', name: 'Memory' },
  { id: 'projects', name: 'Projects' },
  { id: 'skills', name: 'Skills' },
  { id: 'gpt_images', name: 'GPT images' },
  { id: 'images', name: 'Images' },
  { id: 'files', name: 'Work folder' },
  { id: 'terminal', name: 'Terminal' },
  { id: 'chat', name: 'Chat only' },
  { id: 'tasks', name: 'Tasks' },
  { id: 'run', name: 'The run itself' },
]

/** Files that steer the agent: writes to them never go further than asking. */
export const STEERING_PATH = /(^|\/)(AGENTS\.md|CLAUDE\.md|\.agents|\.claude)(\/|$)/i

export type SeafileScope = { library: string; path: string; write: boolean }
export type MailScope = {
  /** Account ids (as strings) or labels the task may use; empty: any linked one */
  accounts: string[]
  /** Sends go only to your own addresses, or only to the listed ones */
  send: 'self' | 'listed'
  recipients: string[]
}
export type TaskPolicy = {
  /** Per tool, over its group's and its own default */
  tools: Record<string, Verdict>
  /** Per group */
  groups: Partial<Record<TaskGroup, Verdict>>
  /** The tools there were when it was saved: any tool added since is blocked until the policy is saved again */
  seen: string[]
  /** Web pages on these sites (and their www.) are read as the policy says; "*" is any site */
  sites: string[]
  /** Pages on other sites: ask, or never */
  otherSites: 'ask' | 'block'
  /** Seafile: only these folders (empty: anywhere), and writing only where `write` */
  seafile: SeafileScope[]
  /** Calendar changes only in these calendars (ids or names; empty: any) */
  calendars: string[]
  mail: MailScope
  /** Whether what the agent remembers about you goes into the run's prompt */
  memories: boolean
}

export const VERDICTS: Verdict[] = ['allow', 'ask', 'block']
const rank: Record<Verdict, number> = { block: 0, ask: 1, allow: 2 }
/** The stricter of two verdicts. */
export const stricter = (a: Verdict, b: Verdict): Verdict => (rank[a] <= rank[b] ? a : b)
const isVerdict = (v: unknown): v is Verdict => v === 'allow' || v === 'ask' || v === 'block'

export const TOOL_NAMES = Object.keys(TASK_TOOLS)

/** A new task's policy: read-only tools run, private reads ask, everything else is blocked. */
export function defaultPolicy(): TaskPolicy {
  return { tools: {}, groups: {}, seen: [...TOOL_NAMES], sites: [], otherSites: 'ask', seafile: [], calendars: [], mail: { accounts: [], send: 'self', recipients: [] }, memories: false }
}

const strings = (v: unknown, max: number, len = 200) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, len)).filter(Boolean))].slice(0, max) : [])
const host = (raw: string) => {
  const s = raw.trim().toLowerCase()
  if (s === '*') return s
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, '').replace(/\.$/, '')
  } catch {
    return ''
  }
}
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

/** A policy as sent or stored, cleaned up: unknown tools and groups dropped, lists capped. */
export function normalizePolicy(v: unknown): TaskPolicy {
  const p = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const tools: Record<string, Verdict> = {}
  for (const [k, x] of Object.entries((p.tools && typeof p.tools === 'object' ? p.tools : {}) as Record<string, unknown>)) if (TASK_TOOLS[k] && isVerdict(x)) tools[k] = x
  const groups: Partial<Record<TaskGroup, Verdict>> = {}
  for (const [k, x] of Object.entries((p.groups && typeof p.groups === 'object' ? p.groups : {}) as Record<string, unknown>)) if (TASK_GROUPS.some((g) => g.id === k) && isVerdict(x)) groups[k as TaskGroup] = x
  const m = (p.mail && typeof p.mail === 'object' ? p.mail : {}) as Record<string, unknown>
  const seafile = Array.isArray(p.seafile)
    ? (p.seafile as unknown[]).flatMap((x) => {
        const f = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
        const library = typeof f.library === 'string' ? f.library.trim().slice(0, 200) : ''
        const path = typeof f.path === 'string' ? `/${f.path.trim().replace(/^\/+/, '')}`.replace(/(.)\/+$/, '$1').slice(0, 500) : '/'
        return library && !path.split('/').includes('..') ? [{ library, path, write: f.write === true }] : []
      }).slice(0, 20)
    : []
  return {
    tools,
    groups,
    seen: Array.isArray(p.seen) ? strings(p.seen, 500, 80) : [...TOOL_NAMES],
    sites: strings(p.sites, 100, 300).map(host).filter(Boolean),
    otherSites: p.otherSites === 'block' ? 'block' : 'ask',
    seafile,
    calendars: strings(p.calendars, 50),
    mail: { accounts: strings(m.accounts, 20), send: m.send === 'listed' ? 'listed' : 'self', recipients: strings(m.recipients, 50, 320).map((x) => x.toLowerCase()).filter((x) => EMAIL.test(x)) },
    memories: p.memories === true,
  }
}

/** What the policy says for a tool before anything about the call itself: its own entry, its group's, its default, within its cap. */
export function toolVerdict(policy: TaskPolicy, name: string): Verdict {
  const t = TASK_TOOLS[name]
  if (!t || t.unavailable) return 'block'
  if (t.class === 'internal') return t.default
  if (!policy.seen.includes(name)) return 'block'
  const v = policy.tools[name] ?? policy.groups[t.group] ?? t.default
  return t.cap ? stricter(v, t.cap) : v
}

/** What a call is about, worked out on the server before it is decided (the account, the recipients, the calendar). */
export type CallScope = {
  /** Mail: the accounts it uses (ids as strings, and labels), every recipient, and the account's own addresses */
  mailAccounts?: { id: string; label: string }[]
  recipients?: string[]
  own?: string[]
  /** Calendar changes: every calendar it touches (a move touches two) */
  calendars?: { id: string; name: string }[]
  /** Seafile places that steer the agent besides AGENTS.md and friends: the user's ~/AGENTS.md and skills folder (library id and name, path). Changes there never go beyond Ask. */
  steering?: { libraries: string[]; path: string }[]
}

export type DecideContext = {
  /** Private things are in the run's context already (memories, private tool results) */
  holdsPrivate: boolean
  /** Whether an address came from outside the model (search results, the task's instruction, links of pages read) */
  given: (url: string) => boolean
  /** A dry run: every change asks */
  dryRun: boolean
  scope?: CallScope
}

export type Decision = { verdict: Verdict; reason: string }

const siteOf = (url: string): string | null => {
  try {
    const u = new URL(url)
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') : null
  } catch {
    return null
  }
}
const listedSite = (policy: TaskPolicy, site: string) => policy.sites.includes('*') || policy.sites.includes(site)
const argText = (args: Record<string, unknown>, k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() : '')
const absPath = (raw: string) => `/${raw.replace(/^\/+/, '')}`.replace(/(.)\/+$/, '$1')
const within = (path: string, folder: string) => folder === '/' || path === folder || path.startsWith(`${folder}/`)

/** Whether a Seafile path is inside the task's folders (by library name or id), and writable there when `write`. */
function seafileAllowed(policy: TaskPolicy, library: string, path: string, write: boolean): boolean {
  if (!policy.seafile.length) return true
  const lib = library.toLowerCase()
  return policy.seafile.some((f) => f.library.toLowerCase() === lib && within(absPath(path || '/'), f.path) && (!write || f.write))
}

/**
 * The one authority over a call in a task run: allow, ask or block, with why. Starts from what the
 * policy says for the tool, and only gets stricter from there: scope limits (sites, folders,
 * calendars, mail accounts and recipients), hard caps (mail sends, calendar changes and the agent's
 * steering files never run without asking), the given-address rule for web reads once private
 * things are in the run, and a dry run's "every change asks". Unknown tools are blocked.
 */
export function taskDecide(policy: TaskPolicy, call: { name: string; arguments?: Record<string, unknown> }, ctx: DecideContext): Decision {
  const t = TASK_TOOLS[call.name]
  if (!t) return { verdict: 'block', reason: 'Not a tool tasks know' }
  if (t.unavailable) return { verdict: 'block', reason: t.unavailable }
  let verdict = toolVerdict(policy, call.name)
  if (verdict === 'block') return { verdict, reason: policy.seen.includes(call.name) || t.class === 'internal' ? "Blocked by the task's policy" : 'New since the policy was saved: blocked until you allow it' }
  let reason = verdict === 'allow' ? "Allowed by the task's policy" : "The task's policy asks first"
  const lower = (to: Verdict, why: string) => {
    if (rank[to] < rank[verdict]) (verdict = to), (reason = why)
  }
  const args = call.arguments ?? {}
  if (call.name === 'web_fetch' || (call.name === 'find_image' && argText(args, 'page'))) {
    const url = argText(args, call.name === 'web_fetch' ? 'url' : 'page')
    const site = siteOf(url)
    if (site && !listedSite(policy, site)) lower(policy.otherSites, policy.otherSites === 'block' ? `${site} is not one of the task's sites` : `${site} is not one of the task's sites, so it asks`)
    if (site && ctx.holdsPrivate && !ctx.given(url)) lower('ask', 'An address the agent built while it holds private data: it asks')
  }
  if (t.group === 'seafile' || t.group === 'seafile_write') {
    const write = t.group === 'seafile_write'
    const library = argText(args, 'library')
    if (policy.seafile.length) {
      if (!library) {
        // Changes always name their library; a search across all of them could find anything, so it
        // asks. A list of the libraries is narrowed to the task's own (scopeResult).
        if (write) lower('block', 'Say which library: the task may only change some folders')
        else if (call.name === 'seafile_search') lower('ask', 'A search across every library, while the task may only see some folders: it asks')
      } else if (call.name === 'seafile_search') {
        if (!policy.seafile.some((f) => f.library.toLowerCase() === library.toLowerCase())) lower('block', 'Not a library the task may look in')
      } else if (call.name === 'seafile_list') {
        // A folder on the way to one of the task's folders can be listed: only that way shows (scopeResult).
        const path = absPath(argText(args, 'path') || '/')
        if (!policy.seafile.some((f) => f.library.toLowerCase() === library.toLowerCase() && (within(path, f.path) || within(f.path, path)))) lower('block', 'Outside the folders the task may read')
      } else if (!seafileAllowed(policy, library, argText(args, 'path'), write)) lower('block', write ? 'Outside the folders the task may change' : 'Outside the folders the task may read')
      if (call.name === 'seafile_move' && library) {
        const to = argText(args, 'to_library') || library
        if (!seafileAllowed(policy, to, argText(args, 'to_folder'), true)) lower('block', 'The target is outside the folders the task may change')
      }
    }
    if (write) {
      const paths = ['path', 'to_folder', 'name'].map((k) => argText(args, k)).filter(Boolean)
      if (paths.some((p) => STEERING_PATH.test(p))) lower('ask', 'It changes a file that steers the agent: it asks')
      // The user's own ~/AGENTS.md and skills folder, wherever they are: a change there, or to a folder holding them, asks.
      const lib = library.toLowerCase()
      const targets: [string, string][] = [[lib, absPath(argText(args, 'path') || '/')]]
      if (call.name === 'seafile_move') targets.push([(argText(args, 'to_library') || library).toLowerCase(), absPath(argText(args, 'to_folder') || '/')])
      const hit = (ctx.scope?.steering ?? []).some((s) => targets.some(([l, p]) => s.libraries.some((x) => x.toLowerCase() === l) && (within(p, s.path) || within(s.path, p))))
      if (hit) lower('ask', 'It changes your AGENTS.md or skills folder, which steer the agent: it asks')
    }
  }
  if (t.group === 'calendar' && t.class === 'write' && policy.calendars.length) {
    const touched = ctx.scope?.calendars ?? []
    const ok = touched.length > 0 && touched.every((c) => policy.calendars.some((x) => x === c.id || x.toLowerCase() === c.name.toLowerCase()))
    if (!ok) lower('block', 'Not in one of the calendars the task may change')
  }
  if (t.group === 'mail' && call.name !== 'mail_list_accounts') {
    const used = ctx.scope?.mailAccounts ?? []
    if (policy.mail.accounts.length && (!used.length || !used.every((a) => policy.mail.accounts.some((x) => x === a.id || x.toLowerCase() === a.label.toLowerCase())))) lower('block', 'Not one of the mail accounts the task may use (name the account)')
    if (call.name === 'mail_send') {
      const own = new Set((ctx.scope?.own ?? []).map((x) => x.toLowerCase()))
      const allowed = policy.mail.send === 'listed' ? new Set([...own, ...policy.mail.recipients]) : own
      const to = (ctx.scope?.recipients ?? []).map((x) => x.toLowerCase())
      if (!to.length || to.some((x) => !allowed.has(x))) lower('block', policy.mail.send === 'self' ? 'The task may only send mail to you' : 'The task may only send mail to the listed people')
    }
  }
  if (t.cap) lower(t.cap, t.class === 'egress' ? 'Mail is never sent without asking' : 'Calendar changes never happen without asking')
  if (ctx.dryRun && (t.class === 'write' || t.class === 'egress' || t.class === 'cost' || t.class === 'lasting')) lower('ask', 'Dry run: every change asks')
  return { verdict, reason }
}

/**
 * What a Seafile call that ran gives back, narrowed to the task's folders: the list of libraries to
 * the task's libraries, a folder listing to what lies in (or on the way to) the task's folders, and
 * search results to those inside them. Other calls, and a task without folders, as they are.
 */
export function scopeResult(policy: TaskPolicy, call: { name: string; arguments?: Record<string, unknown> }, output: string): string {
  if (!policy.seafile.length || !['seafile_list', 'seafile_search'].includes(call.name)) return output
  let v: unknown
  try {
    v = JSON.parse(output)
  } catch {
    return JSON.stringify({ error: "Hidden: the answer could not be narrowed to the task's folders" })
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && 'error' in v) return output
  const args = call.arguments ?? {}
  const sameLib = (f: SeafileScope, name: unknown, id?: unknown) => [name, id].some((x) => typeof x === 'string' && x.toLowerCase() === f.library.toLowerCase())
  const library = argText(args, 'library')
  if (call.name === 'seafile_list' && !library && Array.isArray(v)) return JSON.stringify(v.filter((l) => policy.seafile.some((f) => sameLib(f, (l as { name?: unknown }).name, (l as { id?: unknown }).id))))
  if (call.name === 'seafile_list' && Array.isArray(v)) {
    const dir = absPath(argText(args, 'path') || '/')
    const folders = policy.seafile.filter((f) => sameLib(f, library))
    return JSON.stringify(v.filter((e) => {
      const full = absPath(`${dir}/${String((e as { name?: unknown }).name ?? '')}`)
      return folders.some((f) => within(full, f.path) || within(f.path, full))
    }))
  }
  if (call.name === 'seafile_search' && v && typeof v === 'object' && Array.isArray((v as { results?: unknown }).results)) {
    const results = (v as { results: { library?: unknown; path?: unknown }[] }).results.filter((r) => policy.seafile.some((f) => sameLib(f, r.library ?? library) && within(absPath(String(r.path ?? '')), f.path)))
    return JSON.stringify({ results, note: "Only what is inside the task's folders" })
  }
  return JSON.stringify({ error: "Hidden: the answer could not be narrowed to the task's folders" })
}

/** The fields that say what a call does, first (where it goes, what it reads), then the rest, with long text last and clipped. For approving a call. */
const KEY_ARGS = ['path', 'url', 'to', 'cc', 'bcc', 'to_folder', 'to_library', 'name', 'library', 'page', 'reply_to', 'forward', 'subject', 'event_id', 'calendar', 'account', 'query', 'id', 'message_ids', 'thread_ids', 'action', 'mailbox']
const LONG_ARGS = ['content', 'body', 'text', 'description', 'prompt']
export function askArgLines(args: Record<string, unknown>, max = 4000): [string, string][] {
  const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))
  const keys = Object.keys(args)
  const order = [...KEY_ARGS.filter((k) => keys.includes(k)), ...keys.filter((k) => !KEY_ARGS.includes(k) && !LONG_ARGS.includes(k)), ...LONG_ARGS.filter((k) => keys.includes(k))]
  return order.filter((k) => args[k] !== undefined && args[k] !== null && args[k] !== '').map((k) => {
    const v = show(args[k])
    return [k, v.length > max ? `${v.slice(0, max)}… (${v.length - max} more characters)` : v]
  })
}

/** The groups that are used at all (a tool not blocked), for the run's tool set. */
export function usedGroups(policy: TaskPolicy): TaskGroup[] {
  return TASK_GROUPS.map((g) => g.id).filter((g) => TOOL_NAMES.some((n) => TASK_TOOLS[n].group === g && TASK_TOOLS[n].class !== 'internal' && toolVerdict(policy, n) !== 'block'))
}

const nameList = (names: string[]) => names.map((n) => TASK_TOOLS[n].label.replace(/ \(.*\)$/, '').toLowerCase())
const join = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** The policy in plain words, and what to watch out for. `available`: groups the account can use (linked mail, Seafile…); others are left out. */
export function policySummary(policy: TaskPolicy, available?: (g: TaskGroup) => boolean): { lines: string[]; warnings: string[] } {
  const usable = TOOL_NAMES.filter((n) => {
    const t = TASK_TOOLS[n]
    return !t.unavailable && t.class !== 'internal' && (!available || available(t.group))
  })
  const allow = usable.filter((n) => toolVerdict(policy, n) === 'allow')
  const ask = usable.filter((n) => toolVerdict(policy, n) === 'ask')
  const lines: string[] = []
  lines.push(allow.length ? `Without asking it may ${join(nameList(allow))}.` : 'Nothing runs without asking.')
  if (ask.length) lines.push(`It asks you first to ${join(nameList(ask))}.`)
  lines.push(allow.length + ask.length ? 'Everything else is blocked.' : 'Everything else is blocked: it can only think and report.')
  const web = toolVerdict(policy, 'web_fetch') !== 'block'
  if (web) lines.push(policy.sites.includes('*') ? 'Web pages: any site.' :policy.sites.length ? `Web pages: ${policy.sites.join(', ')}; other sites ${policy.otherSites === 'block' ? 'never' : 'ask'}.` : `Web pages: no sites listed, so every page ${policy.otherSites === 'block' ? 'is blocked' : 'asks'}.`)
  if (policy.seafile.length) lines.push(`Seafile: only ${policy.seafile.map((f) => `${f.library}${f.path === '/' ? '' : f.path}${f.write ? ' (may change)' : ''}`).join(', ')}.`)
  if (policy.calendars.length) lines.push(`Calendar changes: only in ${policy.calendars.join(', ')}.`)
  if (toolVerdict(policy, 'mail_send') !== 'block') lines.push(policy.mail.send === 'self' ? 'Mail it sends goes only to you.' : `Mail it sends goes only to you and ${policy.mail.recipients.join(', ') || 'nobody else'}.`)
  if (policy.mail.accounts.length) lines.push(`Mail accounts: ${policy.mail.accounts.join(', ')}.`)
  lines.push(policy.memories ? 'It knows what the agent remembers about you.' : 'It does not see what the agent remembers about you.')
  const on = (n: string) => usable.includes(n) && toolVerdict(policy, n) !== 'block'
  const untrusted = usable.filter((n) => TASK_TOOLS[n].untrusted && on(n))
  const changes = usable.filter((n) => on(n) && ['write', 'egress', 'cost', 'lasting'].includes(TASK_TOOLS[n].class))
  const privateReads = usable.some((n) => on(n) && TASK_TOOLS[n].class === 'private') || policy.memories
  const egress = usable.filter((n) => on(n) && (TASK_TOOLS[n].class === 'egress' || n === 'web_fetch' || n === 'web_search' || n === 'find_image' || n === 'gpt_image'))
  const warnings: string[] = []
  if (untrusted.length && changes.length) warnings.push(`It reads what others wrote (${join(nameList(untrusted))}) and can also ${join(nameList(changes))}. A page or mail could try to talk it into a change: keep changes on Ask unless you trust every source.`)
  if (privateReads && egress.length) warnings.push(`It can read private things and also reach outside (${join(nameList(egress))}). Addresses it builds itself ask while it holds private data, but keep the site list short.`)
  return { lines, warnings }
}

/** Whether `next` lets a task do anything `prev` did not: a looser verdict, a new site, folder, calendar, account or recipient, memories. */
export function widens(prev: TaskPolicy, next: TaskPolicy): boolean {
  if (TOOL_NAMES.some((n) => rank[toolVerdict(next, n)] > rank[toolVerdict(prev, n)])) return true
  if (next.sites.some((s) => !prev.sites.includes(s)) || (prev.otherSites === 'block' && next.otherSites === 'ask')) return true
  const looser = (a: string[], b: string[]) => (a.length > 0 && b.length === 0) || b.some((x) => !a.includes(x))
  if (looser(prev.calendars, next.calendars) || looser(prev.mail.accounts, next.mail.accounts)) return true
  if (prev.seafile.length && (!next.seafile.length || next.seafile.some((f) => !prev.seafile.some((g) => g.library === f.library && g.path === f.path && (g.write || !f.write))))) return true
  if (prev.mail.send === 'self' && next.mail.send === 'listed') return true
  if (next.mail.send === 'listed' && next.mail.recipients.some((r) => !prev.mail.recipients.includes(r))) return true
  return !prev.memories && next.memories
}

// --- tasks and runs, as the API gives them --------------------------------------------------------

/** Where a run's report goes: a thread (a new one each run, or one fixed thread), a notification, email. */
export type ReportTargets = {
  thread: 'none' | 'new' | 'fixed'
  /** The fixed thread (defaults to the thread the task was made in) */
  threadId: string | null
  notify: boolean
  /** Email to yourself from your own mail account: never, always, or only when the notification was not seen in time */
  email: 'off' | 'always' | 'unseen'
  emailAccount: number | null
  /** When it reports: every run, only when something failed or needs you, or when the report condition says so */
  when: 'always' | 'failure' | 'condition'
}
export type TaskCaps = { minutes: number; toolCalls: number; tokens: number }
export type TaskOptions = {
  /** A run due while the last one still runs: skipped, or queued to run after it */
  overlap: 'skip' | 'queue'
  /** Runs missed while the server was down: one run to catch up, or none */
  missed: 'once' | 'skip'
  /** When the done condition is met: complete, or report and keep watching */
  keepWatching: boolean
  /** A "still watching" note now and then, when nothing was reported for that long */
  heartbeat: 'off' | 'weekly' | 'monthly'
  /** Runs kept in the history (null: Settings' default) */
  keep: number | null
}
export type TaskStatus = 'active' | 'paused' | 'completed' | 'expired'
export type TaskSpec = {
  title: string
  instruction: string
  /** "Tell me when…" (empty: report as `when` says) */
  condition: string
  /** "Done when…" (empty: never done; one-off tasks are done after their run) */
  doneWhen: string
  schedule: Schedule
  timezone: string
  policy: TaskPolicy
  report: ReportTargets
  caps: TaskCaps
  /** null: Settings → Apps → Agents' task model */
  model: string | null
  options: TaskOptions
  /** When it stops by itself (ms; null: never) */
  expiresAt: number | null
}
export type Task = TaskSpec & {
  id: string
  status: TaskStatus
  stateNote: string
  policyVersion: number
  nextRunAt: number | null
  lastRunAt: number | null
  failures: number
  createdFromThread: string | null
  createdAt: number
  updatedAt: number
  /** The latest run, for the list */
  lastRun: TaskRunInfo | null
  /** Runs going now (running, queued or waiting) */
  active: number
}
export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'denied' | 'interrupted'
export type RunVerdict = { report: boolean; reason: string; summary: string; done: boolean; state?: string }
/** A call waiting for the user in a run, until `deadline`. */
export type RunAsk = { index: number; name: string; arguments: Record<string, unknown>; summary: { title: string; rows: [string, string][]; body?: string } | null; reason: string }
export type TaskRunInfo = {
  id: string
  taskId: string
  status: RunStatus
  trigger: 'schedule' | 'manual' | 'dry' | 'retry' | 'catchup'
  dry: boolean
  quiet: boolean
  reported: boolean
  reportReason: string | null
  summary: string | null
  verdict: RunVerdict | null
  policyVersion: number
  queuedAt: number
  startedAt: number | null
  endedAt: number | null
  tokensIn: number
  tokensOut: number
  toolCalls: number
  threadId: string | null
  error: string | null
  asks: RunAsk[]
  deadline: number | null
  /** Where the report went */
  delivered: string[]
}

/** How a tool call in a run was decided, as its row says it (stored with the result, server/agents.ts). */
export const CALL_VERDICTS = {
  allowed: "Allowed by the task's policy",
  approved: 'Approved by you',
  denied: 'Denied',
  expired: 'Denied: nobody answered within 12 hours',
  blocked: "Blocked by the task's policy",
} as const
export type CallVerdictKind = keyof typeof CALL_VERDICTS
/** The kind of a stored verdict line, or null for anything else. */
export const callVerdictKind = (checked: string | undefined): CallVerdictKind | null => (Object.entries(CALL_VERDICTS).find(([, text]) => checked === text || checked?.startsWith(`${text}:`))?.[0] as CallVerdictKind | undefined) ?? null

export const DEFAULT_CAPS: TaskCaps = { minutes: 10, toolCalls: 40, tokens: 400_000 }
export const DEFAULT_OPTIONS: TaskOptions = { overlap: 'skip', missed: 'once', keepWatching: false, heartbeat: 'off', keep: null }
export const DEFAULT_REPORT: ReportTargets = { thread: 'none', threadId: null, notify: true, email: 'off', emailAccount: null, when: 'condition' }
export const RETENTION = [20, 50, 100, 250, 500]
/** How long a new task lasts before it expires by itself. */
export const DEFAULT_EXPIRY_MS = 182 * 86400_000
export const RUN_STATUS_LABEL: Record<RunStatus, string> = { queued: 'Queued', running: 'Running', waiting: 'Needs you', succeeded: 'Done', failed: 'Failed', cancelled: 'Cancelled', denied: 'Needs you (denied)', interrupted: 'Interrupted' }
