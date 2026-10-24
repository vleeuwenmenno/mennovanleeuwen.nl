import { localPref } from '../../os/localPref'
import { accountGuard, TAB_ACCOUNT } from '../../os/accountSpace'
import { artMode, artBytes, decodeArt, ART_BYTES } from './imageArt'
import { threadsCommand, threadSearchLines } from './threads'
import { mentionAt, mentionText } from '../../data/agentMentions'
import type { ImageLoraHint } from '../../data/imageModels'
import { generatedImage, getImageLoras, getImageProfiles, getImageProfilePin, pinImageProfile, saveImageProfile, deleteImageProfile, getThreadImageSettings, resetThreadImageSettings, saveThreadImageSettings } from '../../data/agentImages'
import {
  addMemory,
  agentModels,
  answerApproval,
  answerForm,
  canAlwaysAllow,
  compactionText,
  createProject,
  createThread,
  deleteMemory,
  deleteThread,
  editQueued,
  expiryText,
  followThread,
  interruptionText,
  isDropped,
  retryTurn,
  branchThread,
  rewindThread,
  getContext,
  getThread,
  listMemories,
  listProjects,
  listShares,
  listSkills,
  listMentionTools,
  type MentionTool,
  listThreads,
  searchPastThreads,
  overrideTurn,
  queueMessage,
  releaseQueued,
  removeQueued,
  saveQueued,
  sendClientResult,
  sendMessage,
  sendQueuedNow,
  setSkillEnabled,
  SHARE_NOTE,
  shareThread,
  stopSharing,
  stopThread,
  suggestTitle,
  regenerateTitle,
  threadMatches,
  agentSettings,
  toAttachment,
  TOOL_GROUPS,
  toolState,
  toolLabel,
  updateThread,
  type AgentMessage,
  type Attachment,
  type CallSummary,
  type Form,
  type ModelInfo,
  type Mode,
  type Permission,
  type QueuedMessage,
  type Share,
  type ShareExpiry,
  type Skill,
  type Thread,
  type ToolCall,
  type ToolGroup,
  type TurnEvent,
  type Workdir,
  siteOf,
  MAIL_READ_TOOLS,
} from '../../data/agents'
import { seafileAt } from '../../data/agentPlaces'
import { imageProgressLabel, type ImageProgress } from '../../data/imageModels'
import { getAccount, hasCalendar } from '../../os/account'
import { loadMailAccounts, mailAccountsNow } from '../../data/mail'
import { lookup, prepareFolder, readFileText, writeFile } from '../fs'
import type { Ctx } from '../types'
import { HOME, prettyPath, resolvePath } from '../vfs'
import { runCommand, workdirPath } from './client'
import { Editor } from './editor'
import { markdown } from './markdown'
import { assistantLines, compactLines, editPreview, filePreview, runningLines, thinkingLines, todoLines, toolLines, userLines } from './render'
import { ago, box, clipLine, count, lines as toMarkup, seg, width, wrap, type Line } from './text'

// The agents command's session: a coding-agent CLI in the MvL OS terminal. Finished messages go to
// the terminal's scrollback; the reply being written, tool calls under way, the prompt box, menus
// and the status line are one live block at the bottom, redrawn as things change.

const imageArtPreference = localPref<boolean>('mvlos.agents.cli.imageArt', (raw) => raw !== 'false', undefined, { account: true })

const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const VERBS = ['Thinking', 'Pondering', 'Brewing', 'Tinkering', 'Mulling', 'Working', 'Noodling', 'Percolating', 'Computing', 'Considering']
/** The modes shift+tab cycles through; Bypass is only ever picked on purpose (/permissions, --permission-mode). */
const MODES: Permission[] = ['default', 'auto', 'acceptEdits', 'plan']
const ALL_MODES: Permission[] = [...MODES, 'bypass']

export type SessionOptions = {
  thread: Thread | null
  messages: AgentMessage[]
  workdir: Workdir | null
  mode: Mode
  model: string | null
  projectId: number | null
  permission: Permission
  tools: ToolGroup[]
  /** A message to send straight away (agents "prompt") */
  first: string | null
}

type LiveCall = { call: ToolCall; messageId: number; index: number; state: 'running' | 'approval' | 'question' | 'client'; /** An image job's status line: "Step 12 of 30 · 40%" */ detail?: string }
/** `summary`: what the change does, from the server, where the call alone doesn't say (a calendar change). */
type Approval = { callId: string; messageId: number; index: number; call: ToolCall | null; summary?: CallSummary; check?: string }
type Asked = { callId: string; messageId: number; index: number; form: Form }
type PickItem = { value: string; label: string; hint?: string; checked?: boolean }
type Option = { label: string; hint?: string; run: () => void }
type Modal =
  | { kind: 'pick'; title: string; items: PickItem[]; sel: number; multi: boolean; filter: string; done: (values: string[] | null) => void }
  | { kind: 'approval'; a: Approval; sel: number; feedback: string | null }
  | { kind: 'form'; q: Asked; at: number; answers: Record<string, unknown>; sel: number; text: string; picked: Set<string>; error: string | null; other: boolean }
  | { kind: 'help' }

const SLASH: [string, string][] = [
  ['/help', 'keys and commands'],
  ['/clear', 'start a new thread (also /new)'],
  ['/resume', 'continue an earlier thread'],
  ['/threads', 'search past threads: <words>, this [words], open <id>'],
  ['/model', 'pick the model'],
  ['/images', 'image settings (show, set JSON, reset); inline preview: art on|off'],
  ['/mode', 'quick answers or deep research'],
  ['/permissions', 'how changes are allowed (also shift+tab)'],
  ['/tools', 'switch tool groups on and off'],
  ['/skills', 'switch skills on and off'],
  ['/workdir', 'the work folder: a path, or none (also /cd)'],
  ['/project', 'put this thread in a project'],
  ['/projects', 'list, rename or delete projects'],
  ['/rename', 'rename the thread (no name: suggest one)'],
  ['/title', 'the title and earlier ones (regen: a fresh one)'],
  ['/pin', 'pin or unpin the thread'],
  ['/archive', 'archive the thread and start a new one'],
  ['/delete', 'delete the thread'],
  ['/todos', "the agent's plan (clear: drop it)"],
  ['/context', 'what takes up the context window'],
  ['/compact', 'summarise the thread so far to free up context (add what to keep)'],
  ['/summary', 'what the last compaction kept: the summary the agent works from'],
  ['/memory', 'what the agent remembers (add, rm)'],
  ['/status', 'account, model, folder, mode'],
  ['/export', 'save the thread as Markdown'],
  ['/copy', 'copy the last reply'],
  ['/retry', 'run your last message again (also ctrl+r)'],
  ['/branch', 'continue in a new thread from the last message, or /branch <message id>'],
  ['/rewind', 'go back to one of your messages and edit it'],
  ['/share', 'share the thread as a link (last: the last answer; 1h, 1d, 7d, 30d)'],
  ['/shares', "this thread's shared links"],
  ['/unshare', 'stop sharing a link: /unshare <id>, or pick one'],
  ['/open', 'open the thread in the Agents app'],
  ['/exit', 'leave (also Ctrl+D, Ctrl+C twice)'],
]

export class Session {
  private ctx: Ctx
  private thread: Thread | null
  private messages: AgentMessage[]
  private workdir: Workdir | null
  private mode: Mode
  private model: string | null
  private projectId: number | null
  private permission: Permission
  private tools: ToolGroup[]
  private first: string | null

  private lastThreadQuery = ''
  private threadHits: string[] = []
  private outputEpoch = 0
  private outputQueue: { lines: Line[]; art?: () => Promise<Line[]> }[] = []
  private outputting = false
  private artController = new AbortController()

  private editor = new Editor()
  private turn: { ctl: AbortController; started: number; content: string; thinking: string; chars: number; verb: string } | null = null
  private follow: AbortController | null = null
  private liveCalls: LiveCall[] = []
  /** Image jobs under way: which call each one is, for its progress events */
  private imageJobs = new Map<string, { messageId: number; index: number }>()
  private approvals: Approval[] = []
  private asked: Asked[] = []
  private modal: Modal | null = null
  /** A queued message being edited in the prompt (the queue waits meanwhile), and what the prompt held before. */
  private editingQ: { id: string; stash: string; renewed: number } | null = null
  /** Typing in the prompt while the agent waits on you: the approval or form stays closed until it is sent or esc. */
  private overriding = false
  private shellContext: string[] = []
  private echo: string | null = null
  private verbose = false
  private showTodos = true
  private ctrlC = 0
  private esc = 0
  private notice: string | null = null
  private pick = 0
  private tick = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private models: ModelInfo[] = []
  private skills: Skill[] = []
  private mentionTools: MentionTool[] = []
  private loras: ImageLoraHint[] | null = null
  private loraLoading = false
  private loraError = ''
  private dismissedCompletion = ''
  private done: (() => void) | null = null
  private closed = false

  constructor(ctx: Ctx, o: SessionOptions) {
    this.ctx = ctx
    this.thread = o.thread
    this.messages = o.messages
    this.workdir = o.workdir
    this.mode = o.mode
    this.model = o.model
    this.projectId = o.projectId
    this.permission = o.permission
    this.tools = o.tools
    this.first = o.first
  }

  // --- life -------------------------------------------------------------------------------------

  run(): Promise<string> {
    return new Promise((resolve) => {
      this.done = () => resolve('')
      this.ctx.onKey((k, t) => this.key(k, t), { raw: true, shift: true })
      this.ctx.onResize?.(() => this.draw())
      this.ctx.signal.addEventListener('abort', () => this.ctrlCKey())
      this.timer = setInterval(() => {
        this.tick++
        if (this.turn || this.liveCalls.length) this.draw()
        // Every few seconds at rest with messages queued: another window may send or change them.
        if (this.tick % 33 === 0) this.lookAtQueue()
        // An edit says it is still going, so the server keeps the queue waiting.
        const ed = this.editingQ
        if (ed && this.thread && Date.now() - ed.renewed > 60_000) {
          ed.renewed = Date.now()
          void editQueued(this.thread.id, ed.id).catch(() => {})
        }
      }, 120)
      agentModels()
        .then((m) => ((this.models = m), this.draw()))
        .catch(() => {})
      this.loadSkills()
      this.welcome()
      if (this.thread) this.history()
      this.draw()
      if (this.thread?.running) void this.followTurn()
      else if (this.first) void this.submitText(this.first)
    })
  }

  private exit() {
    if (this.closed) return
    this.closed = true
    this.resetOutput()
    this.follow?.abort()
    if (this.timer) clearInterval(this.timer)
    if (this.editingQ && this.thread) void releaseQueued(this.thread.id, this.editingQ.id).catch(() => {})
    this.ctx.onKey(null)
    this.ctx.onResize?.(null)
    this.ctx.live(null)
    const lines: Line[] = []
    if (this.turn) lines.push([seg('The agent is still working on it; ', 'muted'), seg('agents -c', 'cyan'), seg(' picks it up again.', 'muted')])
    if (this.thread) lines.push([seg('Resume this thread with ', 'muted'), seg(`agents -r ${this.thread.id.slice(0, 8)}`, 'cyan')])
    if (lines.length) this.ctx.print(toMarkup(lines))
    this.done?.()
  }

  private w() {
    return Math.max(30, this.ctx.size.cols - 1)
  }

  /** Keep asynchronous image art below its links, ahead of the next finished message. */
  private out(lines: Line[], art?: () => Promise<Line[]>) {
    if ((!lines.length && !art) || this.closed) return
    this.outputQueue.push({ lines, art })
    if (!this.outputting) void this.drainOutput()
  }

  private resetOutput() {
    this.outputEpoch++
    this.outputQueue = []
    this.outputting = false
    this.artController.abort()
    this.artController = new AbortController()
  }

  private async drainOutput() {
    this.outputting = true
    const epoch = this.outputEpoch
    const print = (lines: Line[]) => {
      if (!lines.length || this.closed || epoch !== this.outputEpoch) return
      this.ctx.live(null); this.ctx.print(toMarkup(lines)); this.draw()
    }
    try {
      while (this.outputQueue.length && !this.closed && epoch === this.outputEpoch) {
        const next = this.outputQueue.shift()!
        print(next.lines)
        if (next.art) { const art = await next.art().catch(() => []); print([...art, []]) }
      }
    } finally { if (epoch === this.outputEpoch) this.outputting = false }
  }

  private imageArt(result: string): (() => Promise<Line[]>) | undefined {
    const image = generatedImage(result)
    if (!image || image.size > ART_BYTES) return undefined
    return async () => {
      const cols = this.ctx.size.cols, mode = artMode(this.ctx.tty, imageArtPreference.get(), cols, this.ctx.env)
      if (!mode || !accountGuard()) return []
      const signal = AbortSignal.any([this.ctx.signal, this.artController.signal, AbortSignal.timeout(5000)])
      const bytes = await artBytes(image.url, { 'X-MvL-Account': TAB_ACCOUNT }, signal)
      if (!bytes || signal.aborted || !accountGuard()) return []
      const lines = await decodeArt(bytes, cols, mode)
      return signal.aborted || !accountGuard() || !imageArtPreference.get() || this.ctx.size.cols < cols ? [] : lines
    }
  }

  private say(text: string, color = 'muted') {
    this.out(wrap([seg(text, color)], this.w(), [seg('  ⎿  ', 'muted')], [seg('     ')]))
  }

  private welcome() {
    const w = Math.min(this.w(), 72)
    const who = getAccount().user?.login ?? 'you'
    const body: Line[] = [
      [seg('✻ ', 'accent'), seg('Welcome to MvL OS Agents', 'bold'), seg(`, ${who}`)],
      [],
      [seg('  /help for help, /status for your setup', 'muted')],
      [],
      [seg('  folder: ', 'muted'), seg(this.workdir ? this.workdir.label : 'none (cd into a Seafile folder for file tools)')],
    ]
    this.out(box(body, w, { color: 'accent' }))
    if (!this.thread)
      this.out([
        [seg(' Tips for getting started:', 'muted')],
        [seg(' 1. Ask about your files, or ask for changes: edits wait for your yes', 'muted')],
        [seg(' 2. #LoRA, $skill, @tool; @./path attaches a file; ! runs a command', 'muted')],
        [seg(' 3. shift+tab: auto, accept edits, or plan first', 'muted')],
        [],
      ])
  }

  /** The thread so far, when resuming. */
  private history() {
    const w = this.w()
    const out: Line[] = [[seg(`Resumed “${this.thread!.title}”`, 'muted')], []]
    const msgs = this.messages
    msgs.forEach((m, i) => {
      if (m.role === 'user') out.push(...userLines(m.content, w), [])
      else if (m.role === 'compact') out.push(...compactLines(m, w, this.verbose), [])
      else if (m.role === 'assistant') {
        if (m.content.trim()) out.push(...assistantLines(m.content, w), [])
        ;(m.toolCalls ?? []).forEach((c, k) => {
          const result = msgs.slice(i + 1).filter((x) => x.role === 'tool')[k]
          if (result) {
            out.push(...toolLines(c, result.content, w, false), [])
            if (c.name === 'generate_image') { this.out(out.splice(0), this.imageArt(result.content)) }
          }
        })
      }
    })
    this.out(out)
    this.showInterrupted()
  }

  private loadSkills() {
    listMentionTools().then((items) => { this.mentionTools = items; this.draw() }, () => {})
    listSkills(this.thread ? { thread: this.thread.id } : { folder: this.workdir })
      .then((s) => (this.skills = s))
      .catch(() => {})
  }

  // --- drawing ----------------------------------------------------------------------------------

  private draw() {
    if (this.closed) return
    const w = this.w()
    const L: Line[] = []
    if (this.turn) {
      if (this.turn.content) L.push(...assistantLines(this.turn.content, w).slice(-Math.max(6, this.ctx.size.rows - 14)), [])
      else if (this.turn.thinking && this.verbose) L.push(...thinkingLines(this.turn.thinking, true, w).slice(-8), [])
    }
    const blink = this.tick % 8 < 4
    for (const c of this.liveCalls) L.push(...runningLines(c.call, c.state, w, blink, c.detail), [])
    if (this.turn) {
      const t = this.turn
      const secs = Math.floor((Date.now() - t.started) / 1000)
      const tokens = Math.round(t.chars / 4)
      L.push([seg(`${FRAMES[this.tick % FRAMES.length]} `, 'accent'), seg(`${t.verb}… `, 'accent'), seg(`(${secs}s${tokens ? ` · ↓ ${count(tokens)} tokens` : ''} · esc to interrupt)`, 'muted')])
      if (this.showTodos && this.thread?.todos.length) L.push(...todoLines(this.thread.todos, w))
      L.push([])
    }
    this.queue().forEach((q, n) => {
      const files = q.attachments.length ? ` +${q.attachments.length} file${q.attachments.length === 1 ? '' : 's'}` : ''
      const state = this.editingQ?.id === q.id ? '  (editing)' : q.editing ? '  (queued, editing elsewhere)' : `  (queued${this.turn ? '' : ', waiting'} ${n + 1})`
      L.push(...userLines(q.text || q.attachments.map((a) => a.name).join(', '), w).slice(0, 3).map((l, i) => (i === 0 ? [...l, seg(`${files}${state}`, this.editingQ?.id === q.id ? 'accent' : 'muted')] : l)))
    })
    if (this.modal) L.push(...this.drawModal(w))
    else L.push(...this.drawPrompt(w), ...this.drawFooter(w))
    this.ctx.live(toMarkup(L), { hideInput: true })
  }

  private shellMode() {
    return this.editor.text.startsWith('!')
  }
  private memoryMode() {
    return this.editor.text.startsWith('#')
  }

  private drawPrompt(w: number): Line[] {
    const color = this.shellMode() ? 'magenta' : this.memoryMode() ? 'cyan' : 'muted'
    const inner = w - 4
    const text = this.editor.text
    const lead = this.shellMode() ? '! ' : this.memoryMode() ? '# ' : '> '
    const body: Line[] = []
    if (!text) {
      const hint = this.editingQ ? 'The queued message (empty: ctrl+x removes it)' : this.overriding ? 'Tell it what to do instead' : this.turn ? 'Type to queue a message for when it is done' : this.workdir ? 'Ask about this folder, or ask for a change' : 'Ask anything'
      body.push([seg(lead, 'muted'), seg(' ', 'inverse'), seg(hint, 'muted')])
    } else {
      // Rows of the text, hard-wrapped, with the cursor drawn as an inverse cell.
      const shown = this.shellMode() || this.memoryMode() ? text.slice(1).replace(/^ /, '') : text
      const offset = text.length - shown.length
      const cur = Math.max(0, this.editor.cursor - offset)
      const avail = Math.max(4, inner - 2)
      let pos = 0
      const logical = shown.split('\n')
      logical.forEach((ln, li) => {
        const chunks: string[] = []
        for (let k = 0; k < Math.max(1, Math.ceil(ln.length / avail)); k++) chunks.push(ln.slice(k * avail, (k + 1) * avail))
        if (ln.length && ln.length % avail === 0) chunks.push('')
        chunks.forEach((ch, ci) => {
          const start = pos + ci * avail
          const prefix = li === 0 && ci === 0 ? seg(lead, color === 'muted' ? 'muted' : color) : seg('  ')
          const at = cur - start
          if (at >= 0 && at <= ch.length && !(at === ch.length && ci < chunks.length - 1)) body.push([prefix, seg(ch.slice(0, at)), seg(ch[at] ?? ' ', 'inverse'), seg(ch.slice(at + 1))])
          else body.push([prefix, seg(ch)])
        })
        pos += ln.length + 1
      })
    }
    const n = this.editingQ ? this.queue().findIndex((q) => q.id === this.editingQ!.id) + 1 : 0
    const framed = this.editingQ ? box(body, w, { color: 'accent', title: `editing queued message ${n}` }) : this.overriding ? box(body, w, { color: 'yellow', title: `tell it what to do instead of ${this.waitingOn()}` }) : box(body, w, { color })
    return [...framed, ...this.drawCompletions(w)]
  }

  /** Shared mentions, slash commands and explicit @./path file attachments. */
  private completions(): { start: number; items: PickItem[] } | null {
    const at = this.editor.wordAtCursor()
    if (this.modal || this.dismissedCompletion === `${this.editor.cursor}:${this.editor.text}`) return null
    const mention = mentionAt(this.editor.text, this.editor.cursor)
    if (mention) {
      if (mention.sigil === '#' && this.loras === null && !this.loraLoading && !this.loraError) {
        this.loraLoading = true
        void getImageLoras().then((result) => { this.loras = result.loras }, () => { this.loraError = 'Connect ComfyUI in Settings → Agents → Images; reopen this CLI to retry.' }).finally(() => { this.loraLoading = false; this.draw() })
      }
      const choices = mention.sigil === '#' ? (this.loras ?? []).map((l) => ({ name: l.name, hint: l.baseModel || 'Base model unknown' }))
        : mention.sigil === '$' ? this.skills.filter((s) => s.enabled).map((s) => ({ name: s.name, hint: s.description }))
        : this.mentionTools.map((t) => ({ name: t.name, hint: `${t.group ?? 'Always available'} · ${!t.group || (this.thread?.tools ?? this.tools).includes(t.group) ? 'on' : 'off'}` }))
      const items = choices.filter((c) => c.name.toLowerCase().includes(mention.query)).slice(0, 50).map((c) => ({ value: mentionText(mention.sigil, c.name), label: `${mention.sigil}${c.name}`, hint: c.hint }))
      return items.length ? { start: mention.start, items } : null
    }
    if (!at) return null
    if (at.word.startsWith('/') && at.start === 0) {
      const all: PickItem[] = [...SLASH.map(([v, h]) => ({ value: v, label: v, hint: h })), ...this.skills.map((s) => ({ value: `/${s.name}`, label: `/${s.name}`, hint: `skill: ${s.description}` }))]
      const items = all.filter((x) => x.value.startsWith(at.word))
      return items.length && !(items.length === 1 && items[0].value === at.word) ? { start: 0, items } : null
    }
    if (/^@(?:[.~]?\/|\\)/.test(at.word)) {
      const base = this.baseDir()
      const typed = at.word.slice(1)
      const slash = typed.lastIndexOf('/')
      const dirPart = slash >= 0 ? typed.slice(0, slash + 1) : ''
      const abs = resolvePath(base, dirPart || '.')
      const node = lookup(abs)
      if (node?.type !== 'dir') {
        void prepareFolder(abs).then(() => this.draw())
        return null
      }
      const name = typed.slice(slash + 1)
      const items = [...node.children.values()]
        .filter((n) => n.name.startsWith(name) && (name.startsWith('.') || !n.name.startsWith('.')))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 50)
        .map((n) => ({ value: `@${dirPart}${n.name}${n.type === 'dir' ? '/' : ''}`, label: `${dirPart}${n.name}${n.type === 'dir' ? '/' : ''}`, hint: n.type === 'dir' ? 'folder' : '' }))
      return items.length ? { start: at.start, items } : null
    }
    return null
  }

  private drawCompletions(w: number): Line[] {
    if (this.dismissedCompletion === `${this.editor.cursor}:${this.editor.text}`) return []
    const c = this.completions()
    if (!c) return mentionAt(this.editor.text, this.editor.cursor)?.sigil === '#' ? [[seg(this.loraLoading ? ' Loading LoRAs…' : this.loraError || ' No installed LoRAs match.', 'muted')]] : []
    this.pick = Math.min(this.pick, c.items.length - 1)
    const from = Math.max(0, Math.min(this.pick - 3, c.items.length - 8))
    const nameW = Math.min(24, Math.max(...c.items.map((i) => i.label.length)) + 2)
    return c.items.slice(from, from + 8).map((it, k) => {
      const on = from + k === this.pick
      return clipLine([seg(on ? ' ❯ ' : '   ', 'accent'), seg(it.label.padEnd(nameW), on ? 'accent' : undefined), seg(it.hint ?? '', 'muted')], w)
    })
  }

  private drawFooter(w: number): Line[] {
    let left: Line
    if (this.ctrlC && Date.now() - this.ctrlC < 2000) left = [seg('  Press Ctrl+C again to exit', 'yellow')]
    else if (this.esc && Date.now() - this.esc < 1500 && this.editor.text) left = [seg('  Press Esc again to clear', 'yellow')]
    else if (this.notice) left = [seg(`  ${this.notice}`, 'muted')]
    else if (this.editingQ) left = [seg('  enter saves · esc puts it back · ctrl+enter sends it now · ctrl+x removes it', 'accent')]
    else if (this.overriding) left = [seg('  enter sends it instead · esc goes back', 'yellow')]
    else if (this.queue().length && !this.editor.text) left = [seg(`  ${this.turn ? '' : `${this.queue().length} waiting · `}↑ edits the last · ctrl+enter sends ${this.turn ? 'the next now' : 'the next'} · ctrl+x removes the last`, 'muted')]
    else if (this.permission === 'acceptEdits') left = [seg('  ⏵⏵ accept edits on', 'magenta'), seg(' (shift+tab to cycle)', 'muted')]
    else if (this.permission === 'plan') left = [seg('  ⏸ plan mode on', 'cyan'), seg(' (shift+tab to cycle)', 'muted')]
    else if (this.permission === 'bypass') left = [seg('  ⚠ bypass on: nothing asks', 'red'), seg(' (shift+tab to leave)', 'muted')]
    else if (this.permission === 'auto') left = [seg('  ⏵ auto: web reads checked', 'accent'), seg(' (shift+tab to cycle)', 'muted')]
    else if (this.shellMode()) left = [seg('  ! shell mode: runs in msh, the output goes along with your next message', 'magenta')]
    else if (this.memoryMode()) left = [seg('  # memory: saved to what the agent remembers', 'cyan')]
    else left = [seg('  ? for shortcuts', 'muted')]
    const model = this.thread?.model ?? this.model ?? 'default model'
    const info = this.models.find((m) => m.name === model)
    const used = this.thread?.contextTokens
    const pct = used && info?.contextLength ? Math.round((used / info.contextLength) * 100) : null
    const right = `${this.mode === 'deep' ? 'deep · ' : ''}${model}${pct !== null ? ` · ${pct}% context` : ''}`
    const lw = width(left)
    if (lw + right.length + 2 > w) return [clipLine(left, w), [seg(`  ${right}`, 'muted')]]
    return [[...left, seg(' '.repeat(w - lw - right.length)), seg(right, 'muted')]]
  }

  private drawModal(w: number): Line[] {
    const m = this.modal!
    const bw = Math.min(w, 100)
    if (m.kind === 'help') {
      const keys: [string, string][] = [
        ['enter', 'send; while it works: queue it for when it is done'],
        ['enter while it asks you something', 'send it instead: declines the changes, answers the form'],
        ['↑ in an empty prompt', 'edit the last queued message'],
        ['ctrl+enter', 'send the next queued message now (stops the agent)'],
        ['ctrl+x', 'remove the last queued message'],
        ['shift+enter, alt+enter, \\ enter', 'new line'],
        ['esc', 'stop the agent; twice: clear the prompt'],
        ['shift+tab', 'cycle: ask for changes, auto, accept edits, plan'],
        ['! ', 'run a command in msh; its output goes with your next message'],
        ['# ', 'remember something'],
        ['#name[:weight], $name, @name', 'mention a LoRA, skill or tool (Tab completes)'],
        ['@./path', 'add a file (Tab completes)'],
        ['ctrl+o', 'show thinking and full tool output'],
        ['ctrl+t', 'show or hide the plan'],
        ['ctrl+r', 'retry: run your last message again'],
        ['ctrl+l', 'clear the screen'],
        ['ctrl+c twice, ctrl+d', 'leave'],
      ]
      const body: Line[] = [[seg('Keys', 'bold')], ...keys.map(([k, d]) => [seg(`  ${k.padEnd(34)}`, 'accent'), seg(d)]), [], [seg('Commands', 'bold')], ...SLASH.map(([k, d]) => [seg(`  ${k.padEnd(34)}`, 'accent'), seg(d)]), [], [seg('Any key closes this.', 'muted')]]
      return box(body, bw, { color: 'accent', title: 'Help' })
    }
    if (m.kind === 'pick') {
      const shown = m.items.filter((i) => !m.filter || `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(m.filter.toLowerCase()))
      m.sel = Math.max(0, Math.min(m.sel, shown.length - 1))
      const rows = Math.max(5, Math.min(14, this.ctx.size.rows - 10))
      const from = Math.max(0, Math.min(m.sel - Math.floor(rows / 2), shown.length - rows))
      const body: Line[] = []
      if (m.filter) body.push([seg('Filter: ', 'muted'), seg(m.filter)])
      shown.slice(from, from + rows).forEach((it, k) => {
        const on = from + k === m.sel
        const mark = m.multi ? (it.checked ? '[x] ' : '[ ] ') : it.checked ? '✔ ' : '  '
        body.push([seg(on ? '❯ ' : '  ', 'accent'), seg(mark, it.checked ? 'green' : 'muted'), seg(it.label, on ? 'accent' : undefined), ...(it.hint ? [seg(`  ${it.hint}`, 'muted')] : [])])
      })
      if (!shown.length) body.push([seg('  nothing matches', 'muted')])
      body.push([], [seg(m.multi ? '↑↓ move · space toggle · enter done · esc cancel · type to filter' : '↑↓ move · enter pick · esc cancel · type to filter', 'muted')])
      return box(body, bw, { color: 'accent', title: m.title })
    }
    if (m.kind === 'approval') return this.drawApproval(m, bw)
    return this.drawForm(m, bw)
  }

  // --- approvals --------------------------------------------------------------------------------

  /** What a change looks like, and the answers on offer, by tool. */
  private approvalSpec(a: Approval, w: number): { title: string; preview: Line[]; question: string; options: Option[] } {
    const call = a.call ?? { name: 'change', arguments: {} }
    const sarg = (k: string) => (typeof call.arguments?.[k] === 'string' ? (call.arguments[k] as string) : '')
    const allow = (extra: Parameters<typeof answerApproval>[3] = {}) => () => void this.answer(a, true, extra)
    const no: Option = { label: 'No, and tell the agent what to do differently', hint: 'esc', run: () => this.modal?.kind === 'approval' && ((this.modal.feedback = ''), this.draw()) }
    const inner = w - 4
    const file = sarg('path').split('/').pop() || sarg('path')
    // A calendar change: what the server worked out, as label and value rows.
    if (a.summary) {
      const labelW = Math.min(12, Math.max(...a.summary.rows.map(([l]) => l.length)) + 2)
      const rows = a.summary.rows.flatMap(([label, value]) => wrap([seg(value)], inner, [seg(label.padEnd(labelW), 'muted')], [seg(' '.repeat(labelW))]))
      // An email's text, whole (up to 40 lines here; the window shows all of it).
      const body = a.summary.body === undefined ? [] : [[], ...filePreview(a.summary.body || '(no text)', inner, 40)]
      const MAIL_VERBS: Record<string, string> = { mail_send: 'Send this email?', mail_draft: 'Save this draft?', mail_read: 'Let it read this?', mail_search: 'Let it search your mail?', mail_list_accounts: 'Let it look at your mail accounts?', mail_update: 'Make this change?' }
      const verb = MAIL_VERBS[call.name] ?? (call.name === 'calendar_delete_event' ? 'Delete this event?' : call.name === 'calendar_create_event' ? 'Add this event?' : 'Make this change?')
      // A mail search or read: also mail reads in this thread for 15 minutes, or (after No, out of
      // the way) always, in every thread. Drafts, sends and changes still ask either way.
      const reads = MAIL_READ_TOOLS.has(call.name)
      const forAWhile: Option[] = reads ? [{ label: 'Yes, and allow mail reads in this thread for 15 min', hint: 'sends still ask', run: allow({ always: 'mail_reads' }) }] : []
      const always: Option[] = reads ? [{ label: 'Yes, and always allow mail reads', hint: 'every thread; change in Settings → Agents → Permissions', run: allow({ always: 'mail_reads_always' }) }] : []
      return { title: a.summary.title, preview: [...rows, ...body], question: verb, options: [{ label: 'Yes', run: allow() }, ...forAWhile, no, ...always] }
    }
    switch (call.name) {
      case 'edit_file':
      case 'multi_edit':
        return { title: 'Edit file', preview: [[seg(sarg('path'), 'bold')], ...editPreview(call, inner, 30).lines], question: `Make this edit to ${file}?`, options: [{ label: 'Yes', run: allow() }, { label: 'Yes, allow all edits from now on', hint: 'shift+tab', run: allow({ always: 'edits' }) }, no] }
      case 'write_file':
        return { title: 'Write file', preview: [[seg(sarg('path'), 'bold')], ...filePreview(sarg('content'), inner, 20)], question: `Write ${file}?`, options: [{ label: 'Yes', run: allow() }, { label: 'Yes, allow all edits from now on', hint: 'shift+tab', run: allow({ always: 'edits' }) }, no] }
      case 'make_dir':
      case 'move_path':
        return { title: call.name === 'make_dir' ? 'Make folder' : 'Move', preview: [[seg(toolLabel(call))]], question: 'Do it?', options: [{ label: 'Yes', run: allow() }, { label: 'Yes, allow all edits from now on', hint: 'shift+tab', run: allow({ always: 'edits' }) }, no] }
      case 'terminal': {
        const cmd = sarg('command')
        const names = [...new Set(cmd.split(/[|;&\n]/).map((p) => p.trim().split(/\s+/)[0]).filter((n) => n && /^[\w.[-]+$/.test(n)))]
        return {
          title: 'Terminal command',
          preview: [...wrap([seg(cmd, 'green')], inner, [seg('  ')]), ...(sarg('description') ? [[seg(`  ${sarg('description')}`, 'muted')]] : [])],
          question: 'Run this command?',
          options: [{ label: 'Yes', run: allow() }, ...(canAlwaysAllow(cmd) ? [{ label: `Yes, and don't ask again for ${names.slice(0, 3).join(', ') || 'these'} commands in this thread`, run: allow({ always: 'command' }) }] : []), no],
        }
      }
      case 'exit_plan_mode':
        return {
          title: 'Ready to code?',
          preview: [[seg('Here is the plan:', 'bold')], [], ...markdown(sarg('plan'), inner)],
          question: 'Go ahead?',
          options: [{ label: 'Yes, and allow edits', run: allow({ mode: 'acceptEdits' }) }, { label: 'Yes, and ask for each edit', hint: 'auto', run: allow({ mode: 'auto' }) }, { label: 'No, keep planning', hint: 'esc', run: no.run }],
        }
      case 'web_fetch':
        return {
          title: 'Read an address',
          preview: [[seg(sarg('url'), 'cyan')], [seg('The agent was not given this address; with private data in the thread, it could leak some.', 'muted')], ...(a.check ? [[seg(a.check, 'muted')]] : [])],
          question: 'Read it?',
          options: [{ label: 'Yes', run: allow() }, ...(siteOf(sarg('url')) ? [{ label: `Yes, and allow ${siteOf(sarg('url'))} from now on`, hint: 'all threads', run: allow({ always: 'domain' }) }] : []), no],
        }
      case 'delete_path':
        return { title: 'Delete', preview: [[seg(sarg('path'), 'red')], [seg("It goes to the library's trash.", 'muted')]], question: `Delete ${file}?`, options: [{ label: 'Yes', run: allow() }, no] }
      default: {
        const content = sarg('content') || sarg('text')
        return { title: 'Allow a change', preview: [[seg(toolLabel(call))], ...(content ? filePreview(content, inner, 12) : [])], question: 'Allow it?', options: [{ label: 'Yes', run: allow() }, no] }
      }
    }
  }

  private drawApproval(m: Modal & { kind: 'approval' }, w: number): Line[] {
    const spec = this.approvalSpec(m.a, w)
    const body: Line[] = [...spec.preview.slice(0, Math.max(6, this.ctx.size.rows - 14)), []]
    if (m.feedback !== null) {
      body.push([seg('What should the agent do instead? ', 'bold'), seg('(enter sends, empty just declines; esc goes back)', 'muted')])
      body.push([seg('> ', 'accent'), seg(m.feedback), seg(' ', 'inverse')])
    } else {
      body.push([seg(spec.question, 'bold')])
      spec.options.forEach((o, i) => body.push([seg(i === m.sel ? '❯ ' : '  ', 'accent'), seg(`${i + 1}. ${o.label}`, i === m.sel ? 'accent' : undefined), ...(o.hint ? [seg(` (${o.hint})`, 'muted')] : [])]))
      body.push([], [seg(`or just type to tell it what to do instead${this.approvals.length + this.asked.length > 1 ? ` (answers all ${this.approvals.length + this.asked.length} waiting)` : ''}`, 'muted')])
    }
    return box(body, w, { color: 'yellow', title: spec.title })
  }

  private async answer(a: Approval, allow: boolean, extra: Parameters<typeof answerApproval>[3] = {}) {
    this.modal = null
    this.approvals = this.approvals.filter((x) => x.callId !== a.callId)
    if (extra.always === 'edits') this.permission = 'acceptEdits'
    this.draw()
    try {
      await answerApproval(this.thread!.id, a.callId, allow, extra)
      if (extra.always === 'mail_reads') this.say('Mail searches and reads run without asking in this thread for 15 minutes. Drafts, sends and changes still ask.', 'muted')
      if (extra.always === 'mail_reads_always') this.say('Mail searches and reads run without asking from now on, in every thread (Settings → Agents → Permissions changes it). Drafts, sends and changes still ask.', 'muted')
    } catch (e) {
      this.say(`Could not answer: ${(e as Error).message}`, 'red')
    }
    this.next()
  }

  private approvalKey(m: Modal & { kind: 'approval' }, k: string, text?: string): boolean {
    if (m.feedback !== null) {
      if (k === 'Enter') void this.answer(m.a, false, m.feedback.trim() ? { feedback: m.feedback.trim() } : {})
      else if (k === 'Escape') m.feedback = null
      else if (k === 'Backspace') m.feedback = m.feedback.slice(0, -1)
      else if (k === 'Paste' || k === 'Text') m.feedback += (text ?? '').replace(/\s+/g, ' ')
      else if (k.length === 1) m.feedback += k
      this.draw()
      return true
    }
    const spec = this.approvalSpec(m.a, this.w())
    if ((k.length === 1 && !/^[0-9 ]$/.test(k)) || k === 'Text' || k === 'Paste') return this.startOverride(k.length === 1 ? k : (text ?? '')), true
    if (k === 'ArrowUp' || k === '^P') m.sel = (m.sel - 1 + spec.options.length) % spec.options.length
    else if (k === 'ArrowDown' || k === '^N' || k === 'Tab') m.sel = (m.sel + 1) % spec.options.length
    else if (k === 'Enter') spec.options[m.sel].run()
    else if (/^[1-9]$/.test(k) && Number(k) <= spec.options.length) spec.options[Number(k) - 1].run()
    // Esc is No (the option marked esc), wherever it sits: a lasting choice may come after it.
    else if (k === 'Escape') (spec.options.find((o) => o.hint === 'esc') ?? spec.options[spec.options.length - 1]).run()
    else if (k === 'S-Tab' && spec.options.some((o) => o.hint === 'shift+tab')) spec.options.find((o) => o.hint === 'shift+tab')!.run()
    else if (k === '^C') return this.ctrlCKey(), true
    this.draw()
    return true
  }

  // --- forms (ask_user) -------------------------------------------------------------------------

  private openForm(q: Asked) {
    const answers: Record<string, unknown> = {}
    this.modal = { kind: 'form', q, at: 0, answers, sel: 0, text: '', picked: new Set(), error: null, other: false }
    this.prepareQuestion()
  }

  /** Fills the controls with a question's default. */
  private prepareQuestion() {
    const m = this.modal
    if (m?.kind !== 'form') return
    const q = m.q.form.questions[m.at]
    if (!q) return
    const d = q.default
    m.text = q.type === 'text' || q.type === 'number' || q.type === 'date' ? (d === undefined || d === null ? '' : String(d)) : ''
    m.picked = new Set(Array.isArray(d) ? d.map(String) : [])
    m.other = false
    m.error = null
    m.sel = 0
    if (q.type === 'choice' && typeof d === 'string') m.sel = Math.max(0, q.options?.findIndex((o) => o.value === d) ?? 0)
    if (q.type === 'confirm') m.sel = d === false ? 1 : 0
    if (q.type === 'scale') {
      const min = q.min ?? 1
      const max = q.max ?? 5
      m.sel = typeof d === 'number' ? d - min : Math.floor((max - min) / 2)
    }
  }

  private drawForm(m: Modal & { kind: 'form' }, w: number): Line[] {
    const form = m.q.form
    const q = form.questions[m.at]
    const inner = w - 4
    const body: Line[] = []
    if (form.intro && m.at === 0) body.push(...wrap([seg(form.intro, 'muted')], inner), [])
    const askable = form.questions.filter((x) => x.type !== 'info').length
    const n = form.questions.slice(0, m.at + 1).filter((x) => x.type !== 'info').length
    body.push(...wrap([seg(q.label, 'bold'), ...(q.type !== 'info' && askable > 1 ? [seg(`  (${n}/${askable})`, 'muted')] : [])], inner))
    if (q.hint) body.push(...wrap([seg(q.hint, 'muted')], inner))
    body.push([])
    const opt = (on: boolean, label: string, hint?: string, mark = ''): Line => [seg(on ? '❯ ' : '  ', 'accent'), seg(mark, 'green'), seg(label, on ? 'accent' : undefined), ...(hint ? [seg(`  ${hint}`, 'muted')] : [])]
    const input = (): Line => [seg('> ', 'accent'), seg(m.text.replace(/\n/g, ' ⏎ ')), seg(' ', 'inverse'), ...(q.placeholder && !m.text ? [seg(q.placeholder, 'muted')] : []), ...(q.unit ? [seg(` ${q.unit}`, 'muted')] : [])]
    switch (q.type) {
      case 'choice': {
        const opts = q.options ?? []
        opts.forEach((o, i) => body.push(opt(m.sel === i, o.label, o.hint)))
        if (q.allowOther) body.push(opt(m.sel === opts.length, 'Other…'))
        if (m.other) body.push(input())
        break
      }
      case 'multi':
        ;(q.options ?? []).forEach((o, i) => body.push(opt(m.sel === i, o.label, o.hint, m.picked.has(o.value) ? '[x] ' : '[ ] ')))
        if (q.allowOther) body.push(opt(m.sel === (q.options ?? []).length, 'Other…', undefined, m.other ? '[x] ' : '[ ] '), ...(m.other ? [input()] : []))
        break
      case 'confirm':
        body.push(opt(m.sel === 0, 'Yes'), opt(m.sel === 1, 'No'))
        break
      case 'scale': {
        const min = q.min ?? 1
        const max = q.max ?? 5
        const line: Line = [seg('  ')]
        if (q.minLabel) line.push(seg(`${q.minLabel}  `, 'muted'))
        for (let v = min; v <= max; v++) line.push(v - min === m.sel ? seg(` ${v} `, 'inverse') : seg(` ${v} `))
        if (q.maxLabel) line.push(seg(`  ${q.maxLabel}`, 'muted'))
        body.push(line)
        break
      }
      case 'info':
        break
      default:
        body.push(input())
    }
    if (m.error) body.push([], [seg(m.error, 'red')])
    const typing = ['text', 'number', 'date'].includes(q.type) || m.other
    const hint = (typing ? '' : 'type to tell it something else instead · ') + (q.type === 'info' ? 'enter to go on · esc closes the form' : q.type === 'multi' ? 'space to tick · enter to go on · esc closes the form' : q.type === 'scale' ? '←→ to choose · enter to go on · esc closes the form' : q.type === 'choice' || q.type === 'confirm' ? '↑↓ to choose · enter to go on · esc closes the form' : `enter to go on${q.multiline ? ' · shift+enter new line' : ''} · esc closes the form`)
    body.push([], [seg(hint, 'muted')])
    return box(body, w, { color: 'cyan', title: form.title })
  }

  private formKey(m: Modal & { kind: 'form' }, k: string, text?: string): boolean {
    const q = m.q.form.questions[m.at]
    const typing = ['text', 'number', 'date'].includes(q.type) || m.other
    if (k === 'Escape') {
      this.modal = null
      this.asked = this.asked.filter((x) => x.callId !== m.q.callId)
      void answerForm(this.thread!.id, m.q.callId, null).catch(() => {})
      this.next()
      return true
    }
    if (k === '^C') return this.ctrlCKey(), true
    if (k === 'Enter') return this.formNext(m), true
    // A letter where the question takes none: a message instead of the answers.
    if (!typing && ((k.length === 1 && !/^[0-9 yn]$/.test(k)) || k === 'Text' || k === 'Paste')) return this.startOverride(k.length === 1 ? k : (text ?? '')), true
    if (typing) {
      if (k === 'Backspace') m.text = m.text.slice(0, -1)
      else if (k === 'Paste' || k === 'Text') m.text += text ?? ''
      else if ((k === 'S-Enter' || k === 'M-Enter') && q.multiline) m.text += '\n'
      else if (k.length === 1) m.text += k
      else if (!m.other) return true
    }
    const n = (q.options ?? []).length + (q.allowOther ? 1 : 0)
    if (q.type === 'choice' || q.type === 'multi' || q.type === 'confirm') {
      const total = q.type === 'confirm' ? 2 : n
      if (k === 'ArrowUp') m.sel = (m.sel - 1 + total) % total
      else if (k === 'ArrowDown' || k === 'Tab') m.sel = (m.sel + 1) % total
      else if (k === ' ' && q.type === 'multi') {
        const o = q.options?.[m.sel]
        if (o) m.picked.has(o.value) ? m.picked.delete(o.value) : m.picked.add(o.value)
        else m.other = !m.other
      } else if (/^[1-9]$/.test(k) && Number(k) <= total && !typing) {
        m.sel = Number(k) - 1
        if (q.type !== 'multi') this.formNext(m)
      } else if (q.type === 'confirm' && (k === 'y' || k === 'n')) {
        m.sel = k === 'y' ? 0 : 1
        this.formNext(m)
      }
      if (q.type === 'choice') m.other = !!q.allowOther && m.sel === (q.options ?? []).length
    }
    if (q.type === 'scale') {
      const span = (q.max ?? 5) - (q.min ?? 1)
      if (k === 'ArrowLeft') m.sel = Math.max(0, m.sel - 1)
      else if (k === 'ArrowRight') m.sel = Math.min(span, m.sel + 1)
      else if (/^\d$/.test(k) && Number(k) - (q.min ?? 1) >= 0 && Number(k) - (q.min ?? 1) <= span) m.sel = Number(k) - (q.min ?? 1)
    }
    this.draw()
    return true
  }

  /** Takes the current answer (or says what is wrong with it) and moves on; the last one sends the form. */
  private formNext(m: Modal & { kind: 'form' }) {
    const form = m.q.form
    const q = form.questions[m.at]
    const required = q.required !== false
    let value: unknown = null
    switch (q.type) {
      case 'choice':
        value = m.other ? m.text.trim() || null : (q.options?.[m.sel]?.value ?? null)
        break
      case 'multi':
        value = [...m.picked, ...(m.other && m.text.trim() ? [m.text.trim()] : [])]
        if (required && !(value as string[]).length) return void ((m.error = 'Tick at least one'), this.draw())
        if (q.max !== undefined && (value as string[]).length > q.max) return void ((m.error = `At most ${q.max}`), this.draw())
        if (q.min !== undefined && (value as string[]).length < q.min) return void ((m.error = `At least ${q.min}`), this.draw())
        break
      case 'confirm':
        value = m.sel === 0
        break
      case 'scale':
        value = (q.min ?? 1) + m.sel
        break
      case 'number': {
        if (!m.text.trim()) value = null
        else {
          const v = Number(m.text.trim())
          if (!Number.isFinite(v)) return void ((m.error = 'That is not a number'), this.draw())
          if (q.min !== undefined && v < q.min) return void ((m.error = `At least ${q.min}`), this.draw())
          if (q.max !== undefined && v > q.max) return void ((m.error = `At most ${q.max}`), this.draw())
          value = v
        }
        break
      }
      case 'date':
        if (m.text.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(m.text.trim())) return void ((m.error = 'Write it as YYYY-MM-DD'), this.draw())
        value = m.text.trim() || null
        break
      case 'info':
        value = undefined
        break
      default:
        value = m.text.trim() || null
    }
    if (q.type !== 'info' && required && (value === null || value === '')) return void ((m.error = 'This one needs an answer'), this.draw())
    if (q.type !== 'info') m.answers[q.id] = value
    if (m.at + 1 < form.questions.length) {
      m.at++
      this.prepareQuestion()
      this.draw()
      return
    }
    this.modal = null
    this.asked = this.asked.filter((x) => x.callId !== m.q.callId)
    this.draw()
    answerForm(this.thread!.id, m.q.callId, m.answers).catch((e: Error) => this.say(`Could not send the answers: ${e.message}`, 'red'))
    this.next()
  }

  /** Opens the next thing waiting for the user: a change to allow, then a form. */
  private next() {
    if (this.modal || this.overriding) return this.draw()
    const a = this.approvals[0]
    if (a) this.modal = { kind: 'approval', a, sel: 0, feedback: null }
    else if (this.asked[0]) this.openForm(this.asked[0])
    this.draw()
  }

  // --- keys -------------------------------------------------------------------------------------

  private ctrlCKey() {
    if (this.closed) return
    if (this.modal?.kind === 'pick') return this.modal.done(null)
    if (this.turn) return void this.interrupt()
    if (this.editor.text) {
      this.editor.clear()
      return this.draw()
    }
    if (this.ctrlC && Date.now() - this.ctrlC < 2000) return this.exit()
    this.ctrlC = Date.now()
    this.draw()
    setTimeout(() => this.draw(), 2100)
  }

  private key(k: string, text?: string): boolean {
    if (this.closed) return false
    this.notice = null
    if (k !== '^C') this.ctrlC = 0
    const m = this.modal
    if (m?.kind === 'help') {
      this.modal = null
      this.draw()
      return true
    }
    if (m?.kind === 'approval') return this.approvalKey(m, k, text)
    if (m?.kind === 'form') return this.formKey(m, k, text)
    if (m?.kind === 'pick') return this.pickKey(m, k, text)
    const e = this.editor
    const comp = this.completions()
    if ((comp || mentionAt(e.text, e.cursor)) && k === 'Escape') { this.dismissedCompletion = `${e.cursor}:${e.text}`; this.draw(); return true }
    if (comp && (k === 'ArrowUp' || k === 'ArrowDown' || k === 'Tab' || (k === 'Enter' && (mentionAt(e.text, e.cursor) || comp.items[this.pick]?.value !== e.wordAtCursor()?.word)))) {
      if (k === 'ArrowUp') this.pick = (this.pick - 1 + comp.items.length) % comp.items.length
      else if (k === 'ArrowDown') this.pick = (this.pick + 1) % comp.items.length
      else {
        const it = comp.items[this.pick]
        e.complete(comp.start, it.value + (it.value.endsWith('/') ? '' : ' '))
        this.pick = 0
      }
      this.draw()
      return true
    }
    switch (k) {
      case 'Enter':
        if (e.text.endsWith('\\') && e.cursor === e.text.length) {
          e.backspace()
          e.insert('\n')
        } else void this.submit()
        break
      case 'S-Enter':
      case 'M-Enter':
      case '^J':
        e.insert('\n')
        break
      case 'Backspace':
        e.backspace()
        break
      case 'Delete':
      case '^D':
        if (k === '^D' && !e.text) return this.exit(), true
        e.del()
        break
      case 'ArrowLeft':
      case '^B':
        e.left()
        break
      case 'ArrowRight':
      case '^F':
        e.right()
        break
      case 'Home':
      case '^A':
        e.home()
        break
      case 'End':
      case '^E':
        e.end()
        break
      case 'M-b':
      case '^ArrowLeft':
        e.wordLeft()
        break
      case 'M-f':
      case '^ArrowRight':
        e.wordRight()
        break
      case '^K':
        e.killToEnd()
        break
      case '^U':
        e.killToStart()
        break
      case '^W':
      case 'M-Backspace':
        e.killWord()
        break
      case 'ArrowUp':
      case '^P':
        // Up in an empty prompt edits the last queued message, as in Claude Code.
        if (k === 'ArrowUp' && !e.text && !this.editingQ && !this.overriding && this.queue().length) void this.editQueued(this.queue()[this.queue().length - 1])
        else e.up()
        break
      case '^X': {
        const q = this.editingQ ? this.queue().find((x) => x.id === this.editingQ!.id) : !e.text ? this.queue()[this.queue().length - 1] : undefined
        if (!q) return false
        void this.removeQueued(q)
        break
      }
      case '^Enter': {
        const q = this.editingQ ? this.queue().find((x) => x.id === this.editingQ!.id) : this.queue()[0]
        if (!q) return false
        void this.sendNow(q)
        break
      }
      case 'ArrowDown':
      case '^N':
        e.down()
        break
      case 'Paste':
        e.paste(text ?? '')
        break
      case 'Text':
        if ((text ?? '').includes('\n')) e.paste(text ?? '')
        else e.insert(text ?? '')
        this.pick = 0
        break
      case 'Escape':
        if (this.editingQ) this.cancelEdit()
        else if (this.overriding) {
          // Back to what it asked.
          this.overriding = false
          e.clear()
          this.next()
        } else if (this.turn) void this.interrupt()
        else if (e.text && this.esc && Date.now() - this.esc < 1500) {
          e.clear()
          this.esc = 0
        } else this.esc = Date.now()
        break
      case 'S-Tab':
        void this.setPermission(MODES[(MODES.indexOf(this.permission) + 1) % MODES.length])
        break
      case '^C':
        this.ctrlCKey()
        return true
      case '^L':
        this.resetOutput()
        this.ctx.clear()
        this.welcome()
        break
      case '^O':
        this.verbose = !this.verbose
        this.notice = this.verbose ? 'Showing thinking and full tool output' : 'Showing short tool output'
        break
      case '^T':
        this.showTodos = !this.showTodos
        break
      case '^R':
        if (this.turn || !this.thread) return false
        void this.retry()
        break
      case 'Tab':
        break
      default:
        if (k === '?' && !e.text) {
          this.modal = { kind: 'help' }
          break
        }
        if (k.length !== 1) return false
        e.insert(k)
        this.pick = 0
    }
    this.draw()
    return true
  }

  private pickKey(m: Modal & { kind: 'pick' }, k: string, text?: string): boolean {
    const shown = m.items.filter((i) => !m.filter || `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(m.filter.toLowerCase()))
    if (k === 'ArrowUp' || k === '^P') m.sel = Math.max(0, m.sel - 1)
    else if (k === 'ArrowDown' || k === '^N' || k === 'Tab') m.sel = Math.min(shown.length - 1, m.sel + 1)
    else if (k === 'PageUp') m.sel = Math.max(0, m.sel - 10)
    else if (k === 'PageDown') m.sel = Math.min(shown.length - 1, m.sel + 10)
    else if (k === 'Escape' || k === '^C') {
      this.modal = null
      m.done(null)
    } else if (k === ' ' && m.multi) {
      const it = shown[m.sel]
      if (it) it.checked = !it.checked
    } else if (k === 'Enter') {
      this.modal = null
      if (m.multi) m.done(m.items.filter((i) => i.checked).map((i) => i.value))
      else if (shown[m.sel]) m.done([shown[m.sel].value])
      else m.done(null)
    } else if (k === 'Backspace') m.filter = m.filter.slice(0, -1)
    else if ((k.length === 1 && k !== ' ') || k === 'Text') {
      m.filter += k === 'Text' ? (text ?? '') : k
      m.sel = 0
    }
    this.draw()
    return true
  }

  /** A menu; resolves with the picked values (null when closed). */
  private choose(title: string, items: PickItem[], multi = false): Promise<string[] | null> {
    return new Promise((resolve) => {
      const sel = Math.max(0, multi ? 0 : items.findIndex((i) => i.checked))
      this.modal = {
        kind: 'pick',
        title,
        items,
        sel,
        multi,
        filter: '',
        done: (v) => {
          this.modal = null
          resolve(v)
          this.next()
        },
      }
      this.draw()
    })
  }

  // --- sending ----------------------------------------------------------------------------------

  private async submit() {
    const raw = this.editor.expanded()
    const text = raw.trim()
    if (this.editingQ) return this.saveEdit(text)
    if (!text) return
    this.editor.remember(this.editor.text)
    this.editor.clear()
    this.pick = 0
    await this.submitText(text)
  }

  private async submitText(text: string) {
    if (text.startsWith('!')) return this.shell(text.slice(1).trim())
    if (/^#\s/.test(text)) return this.remember(text.slice(1).trim())
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.split(/\s+/)
      const handled = await this.slash(cmd.toLowerCase(), rest.join(' ').trim(), text)
      if (handled) return
    }
    // While it asks you something, a message answers it instead; while it works, it is queued.
    if (this.thread && (this.overriding || this.waitingOn())) return this.sayInstead(text)
    if (this.turn && this.thread) return this.enqueue(text)
    if (this.turn) return this.say('One moment: the thread is still being made', 'yellow')
    await this.send(text)
  }

  // --- the queue (kept by the server, sent one by one when a turn is done) -----------------------

  private queue(): QueuedMessage[] {
    return this.thread?.queue ?? []
  }

  /** What the agent waits on you for, in a few words ('' when nothing). */
  private waitingOn(): string {
    const n = this.approvals.length
    const forms = this.asked.length
    return [n ? (n === 1 ? 'the change it asks for' : `the ${n} changes it asks for`) : '', forms ? (forms === 1 ? 'its question' : 'its questions') : ''].filter(Boolean).join(' and ')
  }

  /** A letter typed in an approval or a form: the prompt takes it, to tell the agent what to do instead. */
  private startOverride(text: string) {
    this.modal = null
    this.overriding = true
    this.editor.insert(text.replace(/\s+/g, ' '))
    this.draw()
  }

  private async sayInstead(text: string) {
    this.overriding = false
    const thread = this.thread!
    let files: Attachment[] = []
    try {
      files = await this.attachments(text)
    } catch {
      /* said already */
    }
    // Shown first: the turn goes on as soon as the server has it, and its output follows this.
    this.out([...userLines(text, this.w()).map((l, i) => (i === 0 ? [...l, seg('  (instead)', 'muted')] : l)), []])
    try {
      const r = await overrideTurn(thread.id, text, files)
      this.thread = r.thread
      if (r.queued) this.say('It was no longer waiting on you, so this is queued for when it is done')
    } catch (e) {
      this.say(`Could not send that: ${(e as Error).message}`, 'red')
    }
    this.next()
  }

  private async enqueue(text: string) {
    let files: Attachment[] = []
    try {
      files = await this.attachments(text)
    } catch {
      /* said already */
    }
    try {
      this.thread = (await queueMessage(this.thread!.id, text, files)).thread
    } catch (e) {
      this.say(`Could not queue that: ${(e as Error).message}`, 'red')
    }
    this.draw()
  }

  /** Takes a queued message into the prompt to edit; the queue waits until it is saved or put back. */
  private async editQueued(q: QueuedMessage) {
    if (!this.thread) return
    try {
      const r = await editQueued(this.thread.id, q.id)
      this.thread = r.thread
      this.editingQ = { id: q.id, stash: this.editor.text, renewed: Date.now() }
      this.editor.set(r.item.text)
    } catch (e) {
      this.say(`Could not edit it: ${(e as Error).message}`, 'red')
    }
    this.draw()
  }

  /** Back to what the prompt held before the edit. */
  private endEdit() {
    if (!this.editingQ) return
    this.editor.set(this.editingQ.stash)
    this.editingQ = null
  }

  private cancelEdit() {
    if (this.editingQ && this.thread) void releaseQueued(this.thread.id, this.editingQ.id).then((r) => ((this.thread = r.thread), this.draw()), () => {})
    this.endEdit()
    this.draw()
  }

  /** Saves the edited message in its place (its files stay); true when saved. */
  private async saveEdit(text: string): Promise<boolean> {
    if (!this.editingQ || !this.thread) return false
    if (!text) return this.say('Nothing left to send: ctrl+x removes it', 'yellow'), false
    try {
      this.thread = (await saveQueued(this.thread.id, this.editingQ.id, { text })).thread
      this.endEdit()
      return true
    } catch (e) {
      this.say(`Could not save it: ${(e as Error).message}`, 'red')
      return false
    } finally {
      this.draw()
    }
  }

  private async removeQueued(q: QueuedMessage) {
    if (!this.thread) return
    if (this.editingQ?.id === q.id) this.endEdit()
    try {
      this.thread = (await removeQueued(this.thread.id, q.id)).thread
      this.notice = 'Removed from the queue'
    } catch (e) {
      this.say(`Could not remove it: ${(e as Error).message}`, 'red')
    }
    this.draw()
  }

  /** Send now: stops the agent if it works and sends this one next (while it asks something, this answers it). */
  private async sendNow(q: QueuedMessage) {
    if (!this.thread) return
    if (this.editingQ?.id === q.id && !(await this.saveEdit(this.editor.expanded().trim()))) return
    try {
      this.thread = (await sendQueuedNow(this.thread.id, q.id)).thread
    } catch (e) {
      return this.say(`Could not send it: ${(e as Error).message}`, 'red')
    }
    // Sent from a thread at rest: the server answers it, and this follows along.
    if (!this.turn && this.thread.running) void this.followTurn()
    this.draw()
  }

  /** At rest with messages queued: another window may have sent, changed or started them. */
  private lookAtQueue() {
    if (this.turn || this.closed || !this.thread?.queue.length) return
    void getThread(this.thread.id).then(
      (r) => {
        if (this.turn || this.closed || r.thread.id !== this.thread?.id) return
        this.thread = r.thread
        if (r.thread.running) void this.followTurn()
        else this.draw()
      },
      () => {},
    )
  }

  /** The folder @files and ! commands start from: the work folder when it is mounted, else where agents was started. */
  private baseDir(): string {
    return (this.workdir && workdirPath(this.workdir)) || this.ctx.cwd
  }

  /** @path in a message: the file goes along as an attachment. */
  private async attachments(text: string): Promise<Attachment[]> {
    const out: Attachment[] = []
    const base = this.baseDir()
    for (const m of text.matchAll(/(?:^|\s)@((?:[.~]?\/|\\)[^\s]+)/g)) {
      const abs = resolvePath(base, m[1])
      const node = lookup(abs)
      if (node?.type !== 'file') continue
      try {
        const r = await readFileText(abs)
        if (!r) continue
        out.push(await toAttachment(new Blob([r.text], { type: 'text/plain' }), node.name, prettyPath(abs)))
        this.say(`Read ${prettyPath(abs)} (${r.text.split('\n').length} lines)`)
      } catch (e) {
        this.say(`Could not read ${m[1]}: ${(e as Error).message}`, 'red')
      }
    }
    for (const ctxText of this.shellContext.splice(0)) out.push({ name: 'terminal output', source: 'terminal', kind: 'text', mime: 'text/plain', size: ctxText.length, text: ctxText })
    return out
  }

  private async ensureThread(): Promise<Thread> {
    if (this.thread) return this.thread
    this.thread = await createThread({ mode: this.mode, model: this.model ?? undefined, tools: this.tools, projectId: this.projectId, workdir: this.workdir, permission: this.permission })
    this.loadSkills()
    return this.thread
  }

  private async send(text: string) {
    this.echo = text
    this.out([...userLines(text, this.w()), []])
    let files: Attachment[] = []
    try {
      files = await this.attachments(text)
    } catch {
      /* said already */
    }
    const ctl = new AbortController()
    this.turn = { ctl, started: Date.now(), content: '', thinking: '', chars: 0, verb: VERBS[Math.floor(Math.random() * VERBS.length)] }
    this.draw()
    let dropped = false
    try {
      const thread = await this.ensureThread()
      await sendMessage(thread.id, text, files, (e) => this.onEvent(e), ctl.signal, { terminal: true })
    } catch (e) {
      if (ctl.signal.aborted) {
        /* stopped */
      } else if (isDropped(e) && this.thread) dropped = this.dropTurn()
      else this.say(`Error: ${(e as Error).message}`, 'red')
    } finally {
      this.endTurn()
    }
    if (dropped) void this.reconnect()
  }

  /**
   * /compact: the server has the thread's model summarise the conversation so far, and the agent
   * works from the summary from then on. Streamed like a message (the divider comes as a message);
   * no files go with it, so the shell output waiting for the next message stays waiting.
   */
  private async compact(text: string) {
    this.out([[seg('> ', 'muted'), seg(text, 'accent')], []])
    const ctl = new AbortController()
    this.turn = { ctl, started: Date.now(), content: '', thinking: '', chars: 0, verb: 'Compacting the conversation' }
    this.draw()
    let dropped = false
    try {
      await sendMessage(this.thread!.id, text, [], (e) => this.onEvent(e), ctl.signal, { terminal: true })
    } catch (e) {
      if (ctl.signal.aborted) {
        /* stopped */
      } else if (isDropped(e)) dropped = this.dropTurn()
      else this.say(`Could not compact: ${(e as Error).message}`, 'red')
    } finally {
      this.endTurn()
    }
    if (dropped) void this.reconnect()
  }

  /** The stream broke: what was being written is not the answer (the server has it, or lost it). */
  private dropTurn(): true {
    if (this.turn) (this.turn.content = ''), (this.turn.thinking = '')
    this.notice = null
    return true
  }

  /**
   * After a dropped stream: finds the thread again (the server may be restarting for an update),
   * trying for a minute, a little slower each time. Still running: follow it; ended meanwhile:
   * show what came, and how it ended.
   */
  private async reconnect() {
    if (!this.thread || this.closed) return
    const id = this.thread.id
    this.say('The connection dropped · reconnecting (the server may be restarting)…', 'yellow')
    const start = Date.now()
    for (let wait = 1000; !this.closed && Date.now() - start < 60_000; wait = Math.min(wait * 2, 5000)) {
      try {
        const r = await getThread(id)
        if (this.thread?.id !== id || this.turn) return
        if (r.thread.running) return void this.followTurn()
        this.onEvent({ type: 'snapshot', thread: r.thread, messages: r.messages, pending: r.pending, live: null })
        this.showInterrupted()
        return
      } catch {
        await new Promise((ok) => setTimeout(ok, wait))
      }
    }
    if (!this.closed) this.say('The connection dropped and the server did not come back · /retry (ctrl+r) runs your last message again', 'red')
  }

  /** How the last turn was cut short, when it was, with the way to run it again. */
  private showInterrupted() {
    const cut = this.thread?.interrupted
    if (cut && !this.thread?.running) this.say(`${interruptionText(cut)} · ctrl+r or /retry runs it again`, cut.reason === 'stopped' ? 'yellow' : 'red')
  }

  /** Retry: the last turn again; what the agent wrote for it goes, and your message is answered anew. */
  private async retry() {
    if (!this.thread) return this.say('Nothing to retry yet')
    if (this.turn) return this.say('Wait for the agent to finish (esc stops it)', 'yellow')
    // A /compact cut short is compacted again: nothing goes.
    const compact = !!this.thread.interrupted?.compact
    const last = [...this.messages].reverse().find((m) => m.role === 'user')
    if (!last && !compact) return this.say('Nothing to retry yet')
    this.say(compact ? 'Compacting again' : 'Retrying your last message')
    // The server sends the message again: it shows again, under what went before.
    this.echo = null
    const ctl = new AbortController()
    this.turn = { ctl, started: Date.now(), content: '', thinking: '', chars: 0, verb: compact ? 'Compacting the conversation' : VERBS[Math.floor(Math.random() * VERBS.length)] }
    if (!compact && last) this.messages = this.messages.filter((m) => m.id < last.id)
    this.draw()
    let dropped = false
    try {
      await retryTurn(this.thread.id, (e) => this.onEvent(e), ctl.signal, { terminal: true })
    } catch (e) {
      if (ctl.signal.aborted) {
        /* stopped */
      } else if (isDropped(e)) dropped = this.dropTurn()
      else this.say(`Error: ${(e as Error).message}`, 'red')
    } finally {
      this.endTurn()
    }
    if (dropped) void this.reconnect()
  }

  /** /rewind: pick one of your messages; it and everything after it go, and it comes back to edit. */
  private async rewindPick() {
    if (!this.thread) return this.say('Nothing to rewind yet')
    const mine = this.messages.filter((m) => m.role === 'user')
    if (!mine.length) return this.say('Nothing to rewind yet')
    const items = mine
      .map((m) => ({ value: String(m.id), label: (m.content.split('\n')[0] || (m.attachments ?? []).map((a) => a.name).join(', ')).slice(0, 80), hint: `${this.messages.filter((x) => x.id > m.id && x.role !== 'compact').length} after it${this.messages.some((x) => x.id > m.id && x.role === 'compact') ? ', and a compaction' : ''}` }))
      .reverse()
    const picked = await this.choose('Rewind to which message? It and everything after it go', items)
    if (!picked) return
    const id = Number(picked[0])
    const after = this.messages.filter((x) => x.id > id && x.role !== 'compact').length
    const compactions = this.messages.filter((x) => x.id > id && x.role === 'compact').length
    const sure = await this.choose(`Remove it and the ${after} after it?${compactions ? ` A compaction after it goes too: the agent works from the messages before it again.` : ''}${this.turn ? ' The agent is stopped first.' : ''}`, [
      { value: 'yes', label: 'Yes, rewind', hint: 'it comes back into the prompt to edit' },
      { value: 'no', label: 'No' },
      { value: 'info', label: 'Not undone: memories, the plan, notes, calendar events, and files changed in the work folder' },
    ])
    if (sure?.[0] !== 'yes') return
    try {
      if (this.turn) {
        this.turn.content = ''
        this.turn.ctl.abort()
        this.follow?.abort()
      }
      const r = await rewindThread(this.thread.id, id)
      this.thread = r.thread
      this.messages = this.messages.filter((m) => m.id < id)
      // The screen shows the thread as it is now.
      this.resetOutput()
      this.ctx.clear()
      this.welcome()
      this.history()
      this.say(`Rewound: ${r.removed} ${r.removed === 1 ? 'message' : 'messages'} removed. Not undone: memories, the plan, notes, calendar events and work folder files.`)
      this.editor.set(r.message.text)
      if (r.message.attachments.length) this.say(`Its ${r.message.attachments.length} attached ${r.message.attachments.length === 1 ? 'file is' : 'files are'} not brought back here: @ them again`, 'yellow')
    } catch (e) {
      this.say(`Could not rewind: ${(e as Error).message}`, 'red')
    }
    this.draw()
  }

  private endTurn() {
    if (this.turn?.content.trim()) this.out([...assistantLines(this.turn.content, this.w()), []])
    this.turn = null
    this.liveCalls = []
    this.overriding = false
    this.draw()
  }

  private async interrupt() {
    const t = this.turn
    if (!t || !this.thread) return
    t.ctl.abort()
    this.follow?.abort()
    stopThread(this.thread.id).catch(() => {})
    this.modal = null
    this.approvals = []
    this.asked = []
    this.overriding = false
    // The queue stays (on the server) for you to send, edit or drop.
    this.say(`Interrupted · What should the agent do instead?${this.queue().length ? ` (${this.queue().length} queued: ctrl+enter sends the next)` : ''}`, 'yellow')
  }

  /** Joins a turn that is running already (resumed while it works). */
  private async followTurn() {
    if (!this.thread) return
    const ctl = new AbortController()
    this.follow = ctl
    this.turn = { ctl, started: Date.now(), content: '', thinking: '', chars: 0, verb: VERBS[0] }
    this.draw()
    let dropped = false
    try {
      await followThread(this.thread.id, (e) => this.onEvent(e), ctl.signal, { terminal: true })
    } catch (e) {
      if (ctl.signal.aborted) {
        /* stopped */
      } else if (isDropped(e)) dropped = this.dropTurn()
      else this.say(`Error: ${(e as Error).message}`, 'red')
    } finally {
      this.follow = null
      this.endTurn()
    }
    if (dropped) void this.reconnect()
  }

  private onEvent(e: TurnEvent) {
    const w = this.w()
    switch (e.type) {
      case 'snapshot': {
        this.thread = e.thread
        const known = new Set(this.messages.map((m) => m.id))
        const fresh = e.messages.filter((m) => !known.has(m.id))
        this.messages = e.messages
        for (const m of fresh) this.showMessage(m)
        if (e.live && this.turn) {
          this.turn.content = e.live.content
          this.turn.thinking = e.live.thinking
        }
        // Calls of the last reply that have no result yet are under way.
        const lastA = [...e.messages].reverse().find((m) => m.role === 'assistant')
        if (lastA?.toolCalls?.length) {
          const results = e.messages.slice(e.messages.indexOf(lastA) + 1).filter((m) => m.role === 'tool').length
          this.liveCalls = lastA.toolCalls.slice(results).map((call, k) => ({ call, messageId: lastA.id, index: results + k, state: 'running' }))
        }
        for (const p of e.pending) {
          const call = this.messages.find((m) => m.id === p.messageId)?.toolCalls?.[p.index] ?? p.call ?? null
          if (p.kind === 'approval') this.approvals.push({ callId: p.callId, messageId: p.messageId, index: p.index, call, summary: p.summary, check: p.check })
          else if (p.kind === 'question' && p.form) this.asked.push({ callId: p.callId, messageId: p.messageId, index: p.index, form: p.form })
          else if (p.kind === 'client' && call) void this.runClient(p.callId, p.messageId, p.index, call)
          this.setCallState(p.messageId, p.index, p.kind === 'image' ? 'running' : p.kind === 'question' ? 'question' : p.kind)
          if (p.kind === 'image') this.imageProgress(p.callId, p.messageId, p.index, p.progress)
        }
        this.next()
        break
      }
      case 'delta':
        if (!this.turn) break
        this.turn.content += e.content ?? ''
        this.turn.thinking += e.thinking ?? ''
        this.turn.chars += (e.content ?? '').length + (e.thinking ?? '').length
        this.draw()
        break
      case 'message':
        this.messages.push(e.message)
        // The next queued message, answered on the same stream: a new turn.
        if (e.message.role === 'user' && this.turn) this.turn.started = Date.now()
        this.showMessage(e.message)
        break
      case 'queue':
        if (this.thread) this.thread = { ...this.thread, queue: e.queue }
        if (this.editingQ && !e.queue.some((q) => q.id === this.editingQ!.id)) {
          this.editingQ = null
          this.notice = 'That queued message was sent or removed meanwhile; what you wrote is still here'
        }
        this.draw()
        break
      case 'thread': {
        const before = this.thread
        this.thread = e.thread
        this.permission = e.thread.permission
        this.mode = e.thread.mode
        this.workdir = e.thread.workdir
        if (before && before.title !== e.thread.title && before.id === e.thread.id) this.notice = before.title === 'New thread' ? `Thread: ${e.thread.title}` : `Thread renamed: ${e.thread.title} (was ${before.title})`
        this.draw()
        break
      }
      case 'approval': {
        const call = e.call ?? this.messages.find((m) => m.id === e.messageId)?.toolCalls?.[e.index] ?? null
        this.approvals.push({ callId: e.callId, messageId: e.messageId, index: e.index, call, summary: e.summary, check: e.check })
        this.setCallState(e.messageId, e.index, 'approval')
        this.next()
        break
      }
      case 'approved':
      case 'answered':
      case 'clientDone':
        this.approvals = this.approvals.filter((a) => a.callId !== e.callId)
        this.asked = this.asked.filter((a) => a.callId !== e.callId)
        if ((this.modal?.kind === 'approval' && this.modal.a.callId === e.callId) || (this.modal?.kind === 'form' && this.modal.q.callId === e.callId)) this.modal = null
        for (const c of this.liveCalls) if (c.state !== 'running' && !this.approvals.some((a) => a.messageId === c.messageId && a.index === c.index) && !this.asked.some((a) => a.messageId === c.messageId && a.index === c.index)) c.state = 'running'
        this.next()
        break
      case 'question':
        this.asked.push({ callId: e.callId, messageId: e.messageId, index: e.index, form: e.form })
        this.setCallState(e.messageId, e.index, 'question')
        this.next()
        break
      case 'client':
        this.setCallState(e.messageId, e.index, 'client')
        void this.runClient(e.callId, e.messageId, e.index, e.call)
        break
      case 'imageGeneration':
        this.imageProgress(e.callId, e.messageId, e.index)
        break
      case 'imageProgress': {
        const job = this.imageJobs.get(e.callId)
        if (job) this.imageProgress(e.callId, job.messageId, job.index, e.progress)
        break
      }
      case 'imageGenerationDone':
        this.imageJobs.delete(e.callId)
        break
      case 'error':
        this.out([...wrap([seg(`Error: ${e.error}`, 'red'), seg(' · ctrl+r or /retry runs it again', 'muted')], w, [seg('  ⎿  ', 'muted')], [seg('     ')]), []])
        break
      case 'compact':
        // A compaction under way (asked for, or by itself when the context is nearly full).
        if (e.state === 'start' && this.turn) {
          this.turn.verb = e.auto ? 'Context nearly full: compacting the conversation' : 'Compacting the conversation'
          this.turn.started = Date.now()
        } else if (e.state === 'failed' && e.auto) this.say(`Could not compact the conversation: ${e.error ?? 'something went wrong'}`, 'yellow')
        this.draw()
        break
      case 'done':
        break
    }
  }

  /** An image job's progress on its call's status line (ComfyUI's step and percentage, or its place in the queue). */
  private imageProgress(callId: string, messageId: number, index: number, progress?: ImageProgress) {
    this.imageJobs.set(callId, { messageId, index })
    const c = this.liveCalls.find((x) => x.messageId === messageId && x.index === index)
    if (!c) return
    c.detail = (c.call.arguments?.operation === 'upscale' || c.call.arguments?.operation === 'refine') && (!progress || progress.phase === 'running') ? c.call.arguments.operation === 'refine' ? 'Refining image…' : 'Upscaling image…' : imageProgressLabel(progress)
    this.draw()
  }

  private setCallState(messageId: number, index: number, state: LiveCall['state']) {
    const c = this.liveCalls.find((x) => x.messageId === messageId && x.index === index)
    if (c) c.state = state
  }

  /** A message as it comes in: yours, a reply (then its tool calls are under way), or a tool result. */
  private showMessage(m: AgentMessage) {
    const w = this.w()
    if (m.role === 'user') {
      if (this.echo !== null && m.content === this.echo) this.echo = null
      else this.out([...userLines(m.content, w), []])
      return
    }
    if (m.role === 'compact') {
      this.out([...compactLines(m, w, this.verbose), []])
      if (this.turn) this.turn.verb = VERBS[Math.floor(Math.random() * VERBS.length)]
      return
    }
    if (m.role === 'assistant') {
      const out: Line[] = [...thinkingLines(m.thinking ?? '', this.verbose, w)]
      if (m.content.trim()) out.push(...assistantLines(m.content, w))
      if (out.length) this.out([...out, []])
      if (this.turn) {
        this.turn.content = ''
        this.turn.thinking = ''
      }
      this.liveCalls.push(...(m.toolCalls ?? []).map((call, index) => ({ call, messageId: m.id, index, state: 'running' as const })))
      this.draw()
      return
    }
    // A tool result answers the oldest call still under way.
    const k = this.liveCalls.findIndex((c) => c.call.name === m.toolName)
    const live = this.liveCalls.splice(k >= 0 ? k : 0, 1)[0]
    const call = live?.call ?? { name: m.toolName ?? 'tool', arguments: {} }
    this.out([...toolLines(call, m.content, w, this.verbose), []], call.name === 'generate_image' ? this.imageArt(m.content) : undefined)
  }

  /** Runs a terminal tool call here and sends back what it printed. */
  private async runClient(callId: string, messageId: number, index: number, call: ToolCall) {
    const command = typeof call.arguments?.command === 'string' ? call.arguments.command : ''
    const dir = this.workdir ? workdirPath(this.workdir) : this.ctx.cwd
    let result: { output: string; status: number }
    if (!dir) result = { output: `The work folder ${this.workdir?.label} is not mounted in this terminal (check /etc/fstab).`, status: 1 }
    else result = await runCommand(this.ctx, dir, command, this.turn?.ctl.signal ?? this.ctx.signal)
    try {
      await sendClientResult(this.thread!.id, callId, result.output, result.status)
    } catch {
      /* the turn ended meanwhile */
    }
    this.setCallState(messageId, index, 'running')
    this.draw()
  }

  // --- ! and # ----------------------------------------------------------------------------------

  private async shell(command: string) {
    if (!command) return
    const dir = this.baseDir()
    const w = this.w()
    this.out([[seg('! ', 'magenta'), seg(command)]])
    const r = await runCommand(this.ctx, dir, command, this.ctx.signal)
    const shown = r.output.split('\n').slice(0, 30)
    this.out([...shown.map((l, i) => clipLine([seg(i === 0 ? '  ⎿  ' : '     ', 'muted'), seg(l)], w)), ...(r.output.split('\n').length > 30 ? [[seg(`     … +${r.output.split('\n').length - 30} lines`, 'muted')]] : []), ...(r.status ? [[seg(`     exit code ${r.status}`, 'red')]] : []), []])
    this.shellContext.push(`$ ${command}\n${r.output}${r.status ? `\n(exit code ${r.status})` : ''}`)
  }

  private async remember(text: string) {
    if (!text) return
    try {
      await addMemory({ text, projectId: this.thread?.projectId ?? this.projectId })
      this.out([[seg('# ', 'cyan'), seg(text)], [seg('  ⎿  ', 'muted'), seg('Remembered', 'green')], []])
    } catch (e) {
      this.say(`Could not remember that: ${(e as Error).message}`, 'red')
    }
  }

  // --- settings that live on the thread ---------------------------------------------------------

  private async patch(p: Parameters<typeof updateThread>[1]) {
    if (!this.thread) return
    try {
      this.thread = await updateThread(this.thread.id, p)
    } catch (e) {
      this.say(`Could not change that: ${(e as Error).message}`, 'red')
    }
  }

  private async setPermission(p: Permission) {
    this.permission = p
    this.draw()
    await this.patch({ permission: p })
  }

  // --- slash commands ---------------------------------------------------------------------------

  /** Runs a /command; false when it is not one (then it goes to the agent as typed, for skills). */
  private async slash(cmd: string, arg: string, raw: string): Promise<boolean> {
    const w = this.w()
    const busy = () => {
      if (!this.turn) return false
      this.say('Wait for the agent to finish (esc stops it)', 'yellow')
      return true
    }
    switch (cmd) {
      case '/help':
      case '/?':
        this.modal = { kind: 'help' }
        this.draw()
        return true
      case '/exit':
      case '/quit':
        this.exit()
        return true
      case '/clear':
      case '/new':
      case '/reset':
        if (busy()) return true
        this.thread = null
        this.messages = []
        this.resetOutput()
        this.ctx.clear()
        this.welcome()
        this.loadSkills()
        this.draw()
        return true
      case '/resume': {
        if (busy()) return true
        const threads = await listThreads(false).catch(() => [] as Thread[])
        const items = threads.filter((t) => threadMatches(t, arg.toLowerCase())).map((t) => ({ value: t.id, label: t.title, hint: `${ago(t.updatedAt)} ago${t.workdir ? ` · ${t.workdir.label}` : ''}${t.running ? ' · working' : ''}`, checked: t.id === this.thread?.id }))
        if (!items.length) return this.say('No threads to resume'), true
        const picked = await this.choose('Resume a thread', items)
        if (picked) await this.open(picked[0])
        return true
      }
      case '/threads': {
        if (busy()) return true
        const command = threadsCommand(arg, this.lastThreadQuery)
        if (command.kind === 'error') { this.say(command.error); return true }
        if (command.kind === 'open') {
          const matches = this.threadHits.filter((id) => id.startsWith(command.id))
          if (matches.length > 1 || command.id.length < 36 && matches.length !== 1) { this.say('Use a full thread id or a unique prefix from the last results.'); return true }
          await this.open(matches[0] ?? command.id, true)
          return true
        }
        if (command.current && !this.thread) { this.say('Open a thread before using /threads this.'); return true }
        try {
          const result = await searchPastThreads(command.query, this.thread?.id ?? null, command.current)
          this.lastThreadQuery = command.query
          this.threadHits = 'threads' in result ? result.threads.map((t) => t.thread_id) : []
          this.out(threadSearchLines(result, Math.max(1, this.ctx.size.cols - 1)))
        } catch (e) { this.say(`Thread search: ${(e as Error).message}`, 'red') }
        return true
      }
      case '/images': {
        if (/^art(?:\s|$)/.test(arg)) {
          const choice = arg.slice(3).trim()
          if (choice !== 'on' && choice !== 'off') { this.say('/images art on|off (inline image previews)'); return true }
          imageArtPreference.set(choice === 'on')
          if (choice === 'off') { this.artController.abort(); this.artController = new AbortController() }
          this.say(`Inline image art ${choice}.`)
          return true
        }
        if (busy()) return true
        try {
          const thread = await this.ensureThread()
          if (arg.startsWith('profile')) {
            const command = arg.slice(7).trim()
            if (command.startsWith('save ')) {
              const value = JSON.parse(command.slice(5))
              const profile = await saveImageProfile(value)
              this.say(`Saved profile #${profile.id}: ${profile.name}`)
            } else if (command.startsWith('select ')) {
              const value = command.slice(7).trim()
              const pin = await pinImageProfile(thread.id, value === 'none' ? null : Number(value))
              this.say(`Profile: ${pin.profile?.name ?? 'none'}`)
            } else if (/^(delete|reset) /.test(command)) {
              const [action, id] = command.split(/\s+/)
              await deleteImageProfile(Number(id), action === 'reset')
              this.say(action === 'reset' ? 'Profile observations reset.' : 'Profile and observations deleted.')
            } else {
              const pin = await getImageProfilePin(thread.id)
              for (const p of await getImageProfiles()) this.say(`#${p.id} ${p.name}${pin.profile?.id === p.id ? ' (selected)' : ''} [${p.origin}, ${p.observations} ${p.observations === 1 ? 'observation' : 'observations'}]: ${p.description}`)
              this.say('/images profile select <id|none> | save {"name":"…","description":"…"} (optional id edits) | reset <id> | delete <id>')
            }
          } else if (!arg.trim()) {
            const { openSessionImages } = await import('../../apps/AgentsSessionImages')
            await openSessionImages(thread.id)
          } else {
            const patch = arg.startsWith('set ') ? JSON.parse(arg.slice(4)) : undefined
            if (arg.startsWith('set ') && (!patch || typeof patch !== 'object' || Array.isArray(patch))) throw new Error('Use a JSON object of image settings')
            const settings = arg === 'reset' ? await resetThreadImageSettings(thread.id)
              : arg === 'show' ? await getThreadImageSettings(thread.id)
              : arg.startsWith('set ') ? await saveThreadImageSettings(thread.id, { ...(await getThreadImageSettings(thread.id)).overrides, ...patch })
              : null
            if (!settings) { this.say('Usage: /images | /images show | /images reset | /images set {"width":768,"height":1024,"seed":42}', 'yellow'); return true }
            this.out([[seg('Session image settings', 'bold')], ...Object.entries(settings.effective).flatMap(([key, value]) => wrap([seg(`${key}: ${Array.isArray(value) ? value.map((l) => `${l.name} (${l.weight})`).join(', ') || '(none)' : value === null ? 'random' : value === '' ? '(not configured)' : value} (${key in settings.overrides ? 'session override' : 'account default / preset'})`)], w)), []])
            for (const [field, selected] of Object.entries(settings.selection ?? {})) this.say(`${field}: ${selected.automatic ? 'automatic' : 'manual'} · ${selected.error ?? selected.reason}`, selected.error ? 'yellow' : 'gray')
            if (settings.sampling) this.say(`Recommended sampling: ${settings.sampling.steps} steps · CFG ${settings.sampling.cfg} · ${settings.sampling.sampler}/${settings.sampling.scheduler}`, 'gray')
            if (settings.discoveryError) this.say(settings.discoveryError, 'yellow')
          }
        } catch (e) { this.say(`Image settings: ${(e as Error).message}`, 'red') }
        this.draw()
        return true
      }
      case '/model': {
        const models = this.models.length ? this.models : await agentModels().catch(() => [] as ModelInfo[])
        const current = this.thread?.model ?? this.model
        const choose = async (name: string) => {
          this.model = name
          await this.patch({ model: name })
          this.say(`Model: ${name}`)
        }
        if (arg) return await choose(arg), true
        const picked = await this.choose('Model', models.map((m) => ({ value: m.name, label: m.name, hint: [m.thinking ? 'thinks' : '', m.vision ? 'sees' : '', m.contextLength ? `${count(m.contextLength)} context` : ''].filter(Boolean).join(' · '), checked: m.name === current })))
        if (picked) await choose(picked[0])
        return true
      }
      case '/mode': {
        const next: Mode = arg === 'deep' || arg === 'quick' ? arg : this.mode === 'quick' ? 'deep' : 'quick'
        this.mode = next
        await this.patch({ mode: next })
        this.say(next === 'deep' ? 'Deep research: thorough, many sources' : 'Quick: short, direct answers')
        return true
      }
      case '/permissions':
      case '/permission': {
        const names: Record<Permission, string> = { default: 'Ask before each change', auto: 'Auto: web addresses it builds are checked for you', acceptEdits: 'Accept edits in the work folder', plan: 'Plan first (read only)', bypass: 'Bypass: nothing asks (but calendar changes, mail and AGENTS.md)' }
        const p = (ALL_MODES as string[]).includes(arg) ? (arg as Permission) : (await this.choose('Permissions', ALL_MODES.map((m) => ({ value: m, label: names[m], checked: m === this.permission }))))?.[0]
        if (p) await this.setPermission(p as Permission)
        return true
      }
      case '/tools': {
        const current = this.thread?.tools ?? this.tools
        const seafile = !!getAccount().seafile
        const calendar = hasCalendar(getAccount())
        if (mailAccountsNow() === null) await loadMailAccounts()
        const mail = !!mailAccountsNow()?.length
        const blocked = (g: (typeof TOOL_GROUPS)[number]) => !!((g.seafile && !seafile) || (g.calendar && !calendar) || (g.mail && !mail) || (g.id === 'files' && !(this.thread ? this.thread.workdir : this.workdir)))
        const picked = await this.choose('Tools', TOOL_GROUPS.map((g) => ({ value: g.id, label: g.name, hint: toolState(g, current.includes(g.id), blocked(g)).hint, checked: current.includes(g.id) })), true)
        if (!picked) return true
        // A blocked group can be switched off, not on.
        const refused = TOOL_GROUPS.filter((g) => blocked(g) && picked.includes(g.id) && !current.includes(g.id))
        this.tools = picked.filter((id) => !refused.some((g) => g.id === id)) as ToolGroup[]
        await this.patch({ tools: this.tools })
        this.say(`Tools: ${this.tools.join(', ') || 'none'}`)
        for (const g of refused) this.say(`${g.name} stays off. ${toolState(g, false, true).hint.replace(/^Off\. /, '')}`)
        return true
      }
      case '/skills': {
        const list = await listSkills(this.thread ? { thread: this.thread.id, fresh: true } : { folder: this.workdir, fresh: true }).catch(() => [] as Skill[])
        this.skills = list
        if (!list.length) return this.say('No skills. skills add owner/repo installs some; skills new <name> makes one.'), true
        const picked = await this.choose('Skills (on: the agent may use them)', list.map((s) => ({ value: s.name, label: s.name, hint: `${s.source === 'builtin' ? 'built in' : s.label} · ${s.description}`, checked: s.enabled })), true)
        if (!picked) return true
        for (const s of list) if (s.enabled !== picked.includes(s.name)) setSkillEnabled(s.name, picked.includes(s.name))
        this.skills = list.map((s) => ({ ...s, enabled: picked.includes(s.name) }))
        this.say(`Skills on: ${picked.join(', ') || 'none'}`)
        return true
      }
      case '/workdir':
      case '/cd': {
        if (!arg) return this.say(`Work folder: ${this.workdir?.label ?? 'none'}`), true
        if (arg === 'none' || arg === '-') {
          this.workdir = null
          await this.patch({ workdir: null })
          this.say('No work folder: the file tools are off')
          return true
        }
        const abs = resolvePath(this.baseDir(), arg.replace(/^~(?=\/|$)/, HOME))
        await prepareFolder(abs)
        const at = seafileAt(abs)
        if (lookup(abs)?.type !== 'dir') return this.say(`${arg}: no such folder`, 'red'), true
        if (!at) return this.say(`${prettyPath(abs)} is not on Seafile, so the agent cannot work in it`, 'red'), true
        this.workdir = { ...at, label: prettyPath(abs) }
        await this.patch({ workdir: this.workdir })
        this.loadSkills()
        this.say(`Work folder: ${this.workdir.label}`)
        return true
      }
      case '/project': {
        const projects = await listProjects().catch(() => [])
        const current = this.thread?.projectId ?? this.projectId
        let id: number | null | undefined
        if (arg.startsWith('new ')) id = (await createProject(arg.slice(4).trim())).id
        else if (arg === 'none') id = null
        else if (arg) id = projects.find((p) => p.name.toLowerCase() === arg.toLowerCase())?.id ?? (await createProject(arg)).id
        else {
          const picked = await this.choose('Project', [{ value: '', label: 'No project', checked: current === null }, ...projects.map((p) => ({ value: String(p.id), label: p.name, checked: p.id === current }))])
          if (!picked) return true
          id = picked[0] ? Number(picked[0]) : null
        }
        this.projectId = id ?? null
        await this.patch({ projectId: this.projectId })
        this.say(`Project: ${(await listProjects().catch(() => [])).find((p) => p.id === this.projectId)?.name ?? 'none'}`)
        return true
      }
      case '/projects': {
        const projects = await listProjects().catch(() => [])
        const [sub, ...rest] = arg.split(/\s+/)
        if (sub === 'delete' || sub === 'rm') {
          const p = projects.find((x) => x.name.toLowerCase() === rest.join(' ').toLowerCase())
          if (!p) return this.say('No such project', 'red'), true
          const ok = await this.choose(`Delete the project “${p.name}” and its memory? Its threads stay.`, [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes, delete it' }])
          if (ok?.[0] === 'yes') {
            const { deleteProject } = await import('../../data/agents')
            await deleteProject(p.id)
            this.say(`Deleted ${p.name}`)
          }
          return true
        }
        if (sub === 'rename') {
          const [from, to] = rest.join(' ').split(/\s*(?:→|->|\bto\b)\s*/)
          const p = projects.find((x) => x.name.toLowerCase() === (from ?? '').toLowerCase())
          if (!p || !to) return this.say('Usage: /projects rename <name> to <new name>', 'red'), true
          const { renameProject } = await import('../../data/agents')
          await renameProject(p.id, to)
          this.say(`Renamed to ${to}`)
          return true
        }
        if (sub === 'new' || sub === 'add') {
          const p = await createProject(rest.join(' '))
          this.say(`Made ${p.name}`)
          return true
        }
        const threads = await listThreads(false).catch(() => [] as Thread[])
        this.out([...(projects.length ? projects.map((p) => [seg('  • ', 'muted'), seg(p.name, 'bold'), seg(`  ${threads.filter((t) => t.projectId === p.id).length} threads`, 'muted')]) : [[seg('  No projects yet. /projects new <name>', 'muted')]]), []])
        return true
      }
      case '/rename': {
        if (!this.thread) return this.say('Send a message first: then there is a thread to rename'), true
        let title = arg
        if (!title) {
          this.notice = 'Thinking of a title…'
          this.draw()
          title = (await suggestTitle(this.thread.id).catch(() => ({ title: null }))).title ?? ''
          if (!title) return this.say('No title came to mind', 'yellow'), true
        }
        await this.patch({ title })
        this.say(`Renamed to “${title}”`)
        return true
      }
      case '/title': {
        if (!this.thread) return this.say('Send a message first: then the thread has a title'), true
        if (arg === 'regen' || arg === 'regenerate') {
          this.notice = 'Thinking of a title…'
          this.draw()
          try {
            const before = this.thread.title
            this.thread = (await regenerateTitle(this.thread.id)).thread
            this.say(this.thread.title === before ? `Still “${before}”: no better title came to mind` : `Renamed to “${this.thread.title}”`)
          } catch (e) {
            this.say(`No new title: ${(e as Error).message}`, 'red')
          }
          return true
        }
        if (arg) return this.say('Usage: /title shows the title, /title regen asks for a fresh one, /rename <title> sets your own', 'yellow'), true
        // Looked up again: a check after the last answer may have changed it since.
        const t = await getThread(this.thread.id).then((r) => r.thread, () => this.thread!)
        this.thread = t
        const s = agentSettings()
        const row = (k: string, v: string): Line => [seg(`  ${k.padEnd(14)}`, 'muted'), seg(v)]
        this.out([
          [seg('Title ', 'bold'), seg(t.title)],
          row('named by', t.titleSource === 'user' ? 'you: kept as it is (/title regen hands it back)' : !s.titleRefresh ? 'the title model; not kept up to date (Settings → Agents → Models)' : `the title model, checked every ${s.titleEvery} of your messages`),
          ...(t.aliases.length ? t.aliases.map((a, i) => row(i ? '' : 'also known as', `${a.title}  (until ${ago(a.until)} ago)`)) : [row('also known as', 'nothing yet')]),
          [],
        ])
        return true
      }
      case '/pin':
        if (!this.thread) return this.say('Nothing to pin yet'), true
        await this.patch({ pinned: !this.thread.pinned })
        this.say(this.thread.pinned ? 'Pinned' : 'Unpinned')
        return true
      case '/archive':
        if (busy() || !this.thread) return true
        await this.patch({ archived: true })
        this.say('Archived; starting a new thread')
        this.thread = null
        this.messages = []
        return true
      case '/delete': {
        if (busy() || !this.thread) return true
        const ok = await this.choose(`Delete “${this.thread.title}”? This cannot be undone.`, [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes, delete it' }])
        if (ok?.[0] !== 'yes') return true
        await deleteThread(this.thread.id).catch((e: Error) => this.say(e.message, 'red'))
        this.thread = null
        this.messages = []
        this.say('Deleted; starting a new thread')
        return true
      }
      case '/todos': {
        if (arg === 'clear') {
          await this.patch({ todos: null })
          this.say('Plan cleared')
          return true
        }
        const todos = this.thread?.todos ?? []
        this.out(todos.length ? [...todoLines(todos, w), []] : [[seg('  No plan in this thread', 'muted')], []])
        return true
      }
      case '/context': {
        if (!this.thread) return this.say('Nothing sent yet'), true
        const c = await getContext(this.thread.id).catch(() => null)
        if (!c) return this.say('Could not get the context', 'red'), true
        const total = c.measured ?? c.estimate
        const cap = c.contextLength
        const barW = Math.min(40, w - 30)
        const filled = cap ? Math.round((total / cap) * barW) : 0
        const out: Line[] = [[seg('Context ', 'bold'), seg(`${c.model} · ${count(total)}${cap ? ` of ${count(cap)} tokens (${Math.round((total / cap) * 100)}%)` : ' tokens'}`, 'muted')]]
        if (cap) out.push([seg('█'.repeat(filled), 'accent'), seg('░'.repeat(Math.max(0, barW - filled)), 'muted')])
        for (const p of c.parts.filter((x) => x.tokens > 0)) out.push([seg(`  ${p.label.padEnd(36)}`, p.label.startsWith('Summary') ? 'accent' : undefined), seg(count(p.tokens).padStart(7), 'muted')])
        if (c.compaction) out.push(...wrap([seg(`Compacted ${c.compaction.times === 1 ? 'once' : `${c.compaction.times} times`}, last ${c.compaction.auto ? 'by itself' : 'on request'} ${ago(c.compaction.at)} ago: the summary stands in for the ${c.compaction.hidden} messages before it (/summary shows it).`, 'muted')], w, [seg('  ')]))
        out.push(...wrap([seg(c.autoCompact !== null ? `It compacts by itself at ${c.autoCompact}% of the window; /compact does it now.` : 'Compacting by itself is off (Settings → Agents); /compact does it now.', 'muted')], w, [seg('  ')]))
        this.out([...out, []])
        return true
      }
      case '/compact': {
        if (!this.thread) return this.say('Nothing to compact yet: /compact summarises the conversation so far'), true
        const since = this.messages.slice(this.messages.map((m) => m.role).lastIndexOf('compact') + 1)
        if (!since.some((m) => m.role === 'user' || m.role === 'assistant')) return this.say(since.length < this.messages.length ? 'Nothing new to compact since the last time' : 'Nothing to compact yet'), true
        // While it works (or asks you something), the compaction waits its turn in the queue.
        if (this.turn) {
          await this.enqueue(raw)
          this.say('Queued: it compacts when the agent is done')
          return true
        }
        await this.compact(raw)
        return true
      }
      case '/summary': {
        const last = [...this.messages].reverse().find((m) => m.role === 'compact')
        if (!last) return this.say('This thread has not been compacted. /compact does it.'), true
        this.out([...compactLines(last, w, true), []])
        return true
      }
      case '/memory':
      case '/memories': {
        const [sub, ...rest] = arg.split(/\s+/)
        if (sub === 'reset-images') {
          const notes = (await listMemories()).filter((m) => m.imageLearning)
          for (const note of notes) await deleteMemory(note.id)
          this.say(`Forgot ${notes.length} image learnings. Other memories and image settings remain.`)
          return true
        }
        if (sub === 'add' && rest.length) return await this.remember(rest.join(' ')), true
        if ((sub === 'rm' || sub === 'delete') && rest[0]) {
          await deleteMemory(Number(rest[0].replace('#', ''))).catch((e: Error) => this.say(e.message, 'red'))
          this.say(`Forgot #${rest[0].replace('#', '')}`)
          return true
        }
        const mem = await listMemories().catch(() => [])
        const out: Line[] = []
        const cats = [...new Set(mem.map((m) => m.category || '(no category)'))]
        for (const cat of cats) {
          out.push([seg(cat, 'bold')])
          for (const m of mem.filter((x) => (x.category || '(no category)') === cat)) out.push(...wrap([seg(`#${m.id} `, 'muted'), seg(m.text), ...(m.projectId ? [seg(' (project)', 'muted')] : [])], w, [seg('  ')], [seg('    ')]))
        }
        this.out(out.length ? [...out, [seg('  # text or /memory add text remembers; /memory rm <id> forgets', 'muted')], []] : [[seg('  Nothing remembered yet. # text remembers something.', 'muted')], []])
        return true
      }
      case '/status': {
        const a = getAccount()
        const t = this.thread
        const row = (k: string, v: string): Line => [seg(`  ${k.padEnd(14)}`, 'muted'), seg(v)]
        this.out([
          [seg('Status', 'bold')],
          row('account', a.user ? `${a.user.login} (GitHub)` : 'not signed in'),
          row('thread', t ? `${t.title} (${t.id.slice(0, 8)})` : 'new (made on your first message)'),
          ...(t?.aliases.length ? [row('also known as', t.aliases.map((a) => a.title).join(', '))] : []),
          row('model', t?.model ?? this.model ?? 'default for the mode'),
          row('mode', this.mode === 'deep' ? 'deep research' : 'quick'),
          row('permissions', { default: 'ask before each change', auto: 'auto (web reads checked)', acceptEdits: 'accept edits', plan: 'plan (read only)', bypass: 'bypass (nothing asks)' }[this.permission]),
          row('work folder', this.workdir ? this.workdir.label : 'none'),
          row('context', [this.messages.some((m) => m.role === 'compact') ? `compacted ${this.messages.filter((m) => m.role === 'compact').length}×, last ${ago(this.messages.filter((m) => m.role === 'compact').at(-1)!.createdAt)} ago` : 'not compacted', agentSettings().autoCompact ? `compacts by itself at ${agentSettings().compactAt}%` : 'compacting by itself is off'].join(' · ')),
          row('tools', (t?.tools ?? this.tools).join(', ')),
          row('skills', this.skills.filter((s) => s.enabled).map((s) => s.name).join(', ') || 'none'),
          row('seafile', a.seafile ? 'linked' : 'not linked (no work folders or skills)'),
          [],
        ])
        return true
      }
      case '/export': {
        if (!this.thread) return this.say('Nothing to export yet'), true
        const name = arg || `${this.thread.title.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'thread'}.md`
        const md = this.markdown()
        try {
          await writeFile(this.baseDir(), name, md, false, false, 'export')
          this.say(`Saved ${prettyPath(resolvePath(this.baseDir(), name))}`, 'green')
        } catch (e) {
          this.say(`Could not save: ${(e as Error).message}`, 'red')
        }
        return true
      }
      case '/retry':
        await this.retry()
        return true
      case '/branch': {
        if (busy()) return true
        const messageId = arg.trim() ? Number(arg.trim()) : this.messages.at(-1)?.id
        if (!this.thread || !Number.isSafeInteger(messageId) || !messageId) { this.say('Use /branch [message id] in a thread with messages.'); return true }
        try {
          const result = await branchThread(this.thread.id, messageId)
          await this.open(result.thread.id)
          this.say('Branched here; the original thread is unchanged.')
        } catch (e) { this.say((e as Error).message, 'red') }
        return true
      }
      case '/rewind':
        await this.rewindPick()
        return true
      case '/copy': {
        const last = [...this.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim())
        if (!last) return this.say('No reply to copy yet'), true
        await navigator.clipboard.writeText(last.content).then(
          () => this.say('Copied the last reply', 'green'),
          () => this.say('The browser did not allow copying', 'red'),
        )
        return true
      }
      case '/share': {
        if (!this.thread) return this.say('Send a message first: then there is a thread to share'), true
        const words = arg.toLowerCase().split(/\s+/).filter(Boolean)
        const EXPIRES = ['never', '1h', '1d', '7d', '30d']
        const one = words.some((x) => x === 'last' || x === 'response' || x === 'answer')
        if (words.some((x) => !EXPIRES.includes(x) && x !== 'last' && x !== 'response' && x !== 'answer')) return this.say('Usage: /share [last] [1h|1d|7d|30d|never]: the thread, or its last answer, as a link', 'red'), true
        const expires = (words.find((x) => EXPIRES.includes(x)) ?? 'never') as ShareExpiry
        const answer = [...this.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim())
        if (!answer) return this.say('There is no answer to share yet'), true
        try {
          const s = await shareThread(this.thread.id, { kind: one ? 'response' : 'thread', messageId: one ? answer.id : undefined, expires })
          const copied = await navigator.clipboard?.writeText(s.url).then(() => true, () => false)
          this.out([
            [seg('✓ ', 'green'), seg(one ? 'Shared the last answer' : 'Shared this thread', 'bold'), seg(` · ${expiryText(s)}${copied ? ' · link copied' : ''}`, 'muted')],
            [seg('  '), { t: s.url, link: s.url }],
            ...wrap([seg(`${SHARE_NOTE} A snapshot: later messages are not added. /shares lists the links.`, 'muted')], w, [seg('  ')], [seg('  ')]),
            [],
          ])
        } catch (e) {
          this.say(`Could not share: ${(e as Error).message}`, 'red')
        }
        return true
      }
      case '/shares': {
        if (!this.thread) return this.say('Nothing shared from a thread not made yet'), true
        const list = await listShares(this.thread.id).catch((e: Error) => (this.say(e.message, 'red'), null))
        if (!list) return true
        if (!list.length) return this.say('This thread is not shared. /share shares it, /share last its last answer'), true
        const out: Line[] = [[seg('Shared links', 'bold'), seg(` · ${this.thread.title}`, 'muted')]]
        for (const s of list) out.push([seg(`  ${s.token.slice(0, 8)}  `, 'accent'), seg(s.kind === 'response' ? 'one answer' : 'whole thread'), seg(` · made ${ago(s.createdAt)} ago · ${expiryText(s)} · ${s.views} ${s.views === 1 ? 'view' : 'views'}`, 'muted')], [seg('            '), { t: s.url, link: s.url }])
        this.out([...out, [seg('  /unshare <id> stops sharing one (/unshare alone picks)', 'muted')], []])
        return true
      }
      case '/unshare': {
        const all = await listShares().catch((e: Error) => (this.say(e.message, 'red'), null))
        if (!all) return true
        let target: Share | undefined
        if (arg) {
          const hits = all.filter((s) => s.token.startsWith(arg.trim()))
          if (hits.length !== 1) return this.say(hits.length ? `${arg} matches more than one link: give more of it` : `No shared link ${arg}. /shares lists them`, 'red'), true
          target = hits[0]
        } else {
          const mine = this.thread ? all.filter((s) => s.threadId === this.thread!.id) : all
          if (!mine.length) return this.say('Nothing shared here'), true
          const picked = await this.choose('Stop sharing which link? It stops working at once', mine.map((s) => ({ value: s.token, label: `${s.token.slice(0, 8)}  ${s.kind === 'response' ? 'one answer' : 'whole thread'}`, hint: `made ${ago(s.createdAt)} ago · ${expiryText(s)} · ${s.views} views` })))
          target = mine.find((s) => s.token === picked?.[0])
          if (!target) return true
        }
        await stopSharing(target.token).then(
          () => this.say(`Stopped sharing ${target.token.slice(0, 8)}: the link no longer works`, 'green'),
          (e: Error) => this.say(e.message, 'red'),
        )
        return true
      }
      case '/open':
        if (!this.thread) return this.say('Send a message first'), true
        this.ctx.openApp('agents', { thread: this.thread.id, t: String(Date.now()) })
        this.say('Opened in the Agents app')
        return true
    }
    // /name for a skill goes to the agent as typed (the server adds the skill's instructions).
    const skill = this.skills.find((s) => `/${s.name}` === cmd)
    if (skill) return false
    this.say(`Unknown command ${raw.split(/\s/)[0]}. /help lists them.`, 'yellow')
    return true
  }

  /** Switches to another thread. */
  private async open(id: string, pastOnly = false) {
    try {
      const { thread, messages, pending } = await getThread(id)
      if (pastOnly && thread.quick) throw new Error('No such past thread')
      this.thread = thread
      this.messages = messages
      this.workdir = thread.workdir
      this.permission = thread.permission
      this.mode = thread.mode
      this.model = thread.model
      this.resetOutput()
      this.ctx.clear()
      this.welcome()
      this.history()
      this.loadSkills()
      if (thread.running) void this.followTurn()
      else if (pending.length) this.onEvent({ type: 'snapshot', thread, messages, pending, live: null })
      this.draw()
    } catch (e) {
      this.say(`Could not open it: ${(e as Error).message}`, 'red')
    }
  }

  /** The thread as Markdown, for /export. */
  private markdown(): string {
    const out = [`# ${this.thread?.title ?? 'Thread'}`]
    for (const m of this.messages) {
      if (m.role === 'user') out.push(`## You\n\n${m.content}`)
      else if (m.role === 'assistant') {
        const steps = (m.toolCalls ?? []).map((c) => `- ${toolLabel(c)}`).join('\n')
        if (m.content.trim() || steps) out.push(`## Agent\n\n${[steps, m.content.trim()].filter(Boolean).join('\n\n')}`)
      } else if (m.role === 'compact') out.push(`---\n\n*${compactionText(m.compact)}. The summary the agent works from since:*\n\n${m.content.split('\n').map((l) => `> ${l}`).join('\n')}\n\n---`)
    }
    return `${out.join('\n\n')}\n`
  }
}
