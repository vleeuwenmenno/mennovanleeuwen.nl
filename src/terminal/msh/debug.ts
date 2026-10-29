import type { Budget } from '../limits'
import type { Node, SourceSpan } from './parse'

export type DebugState = 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'
/** Why the session stopped: the first command, a step, a breakpoint or a pause request. */
export type PauseReason = 'entry' | 'step' | 'breakpoint' | 'pause'
/** A script (msh file, source, ./script, msh -c), a function call or a $(…) substitution. */
export type FrameKind = 'script' | 'function' | 'substitution'
/** One level of the call stack at a pause; `line`/`column` is where that frame is now. */
export type DebugFrame = { kind: FrameKind; name: string; filename: string; line: number; column: number }
export type DebugSnapshot = {
  id: string; label: string; state: DebugState; location?: SourceSpan
  variables: Readonly<Record<string, string>>; status?: number; breakpoints: readonly string[]
  /** Positional parameters of the paused frame ($1…), bounded like variables. */
  args: readonly string[]
  /** Names made `local` by the innermost function at the pause. */
  locals: readonly string[]
  /** Innermost first. Empty unless paused. */
  frames: readonly DebugFrame[]
  reason?: PauseReason
  /** Increases with every pause, so a viewer can tell a new stop from the same one. */
  pauses: number
}
/** How the session runs after a resume. `over`/`out` compare frame depth at the time of the step. */
type Mode = { kind: 'run' } | { kind: 'into' } | { kind: 'over'; depth: number } | { kind: 'out'; depth: number } | { kind: 'entry'; filename: string }
/** Where a new session first stops: before its first command, only at breakpoints, or at the first command of a file. */
export type DebugStart = 'first' | 'run' | { entry: string }
type Frame = { kind: FrameKind; name: string; filename: string; call?: SourceSpan; at?: SourceSpan; last?: { line: number; start: number; filename: string } }

const MAX_SESSIONS = 16
const MAX_POINTS = 256
const MAX_VARS = 256
const MAX_VALUE = 4096
const MAX_ARGS = 64
const MAX_FRAMES = 128
const MAX_SOURCES = 64

/**
 * The nodes the debugger stops before: simple commands, (( )), and for/case heads. Lists, pipelines,
 * groups and if/while are made of commands that stop on their own, so no place is stopped at twice.
 */
export const STOP_NODES: ReadonlySet<Node['t']> = new Set<Node['t']>(['simple', 'arith', 'for', 'case'])

/** The lines of a parsed file that have a command to stop at (a breakpoint elsewhere never stops). */
export function commandLines(tree: Node): Set<number> {
  const lines = new Set<number>()
  const walk = (n: Node | null | undefined) => {
    if (!n || lines.size > 100_000) return
    if (n.span && STOP_NODES.has(n.t)) lines.add(n.span.line)
    switch (n.t) {
      case 'list': for (const it of n.items) walk(it.node); break
      case 'pipeline': for (const c of n.cmds) walk(c); break
      case 'andor': walk(n.first); for (const [, c] of n.rest) walk(c); break
      case 'group': case 'subshell': case 'for': case 'func': walk(n.body); break
      case 'while': walk(n.cond); walk(n.body); break
      case 'if': for (const [c, b] of n.clauses) { walk(c); walk(b) } walk(n.else); break
      case 'case': for (const arm of n.arms) walk(arm.body); break
    }
  }
  walk(tree)
  return lines
}

const sessions = new Map<string, DebugSession>()
const listeners = new Set<() => void>()
let serial = 0
let revision = 0
const emit = () => { revision++; for (const listener of listeners) listener() }
export const debugRevision = () => revision
export const subscribeDebug = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const debugSessions = () => [...sessions.values()]
const key = (filename: string, line: number) => `${filename}:${line}`

/** FNV-1a over the text: tells whether an editor buffer is the source a session is running. */
export function sourceHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return `${text.length}:${(h >>> 0).toString(16)}`
}

/** An absolute path with `.`, `..` and repeated slashes resolved; anything else is refused. */
export function canonicalPath(path: string): string | null {
  if (!path.startsWith('/')) return null
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

// --- editor breakpoints -----------------------------------------------------------------------------
// Set in Xed's gutter and shared by every Xed window in this page. They are not persisted. Only
// sessions that opted in (launched from Xed, or explicitly attached there) stop at them.

export type EditorBreakpoint = { path: string; line: number; enabled: boolean }
const editorPoints = new Map<string, Map<number, boolean>>()
let editorCount = 0
export const editorBreakpoints = (): EditorBreakpoint[] =>
  [...editorPoints].flatMap(([path, lines]) => [...lines].map(([line, enabled]) => ({ path, line, enabled }))).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
export const breakpointsIn = (path: string): ReadonlyMap<number, boolean> => editorPoints.get(path) ?? new Map()
const editorHit = (filename: string, line: number) => editorPoints.get(filename)?.get(line) === true

/** Adds or removes the breakpoint on a line (1-based). False when the path or line is not valid, or the list is full. */
export function toggleBreakpoint(path: string, line: number): boolean {
  const at = canonicalPath(path)
  if (!at || !Number.isInteger(line) || line < 1) return false
  const lines = editorPoints.get(at) ?? new Map<number, boolean>()
  if (lines.has(line)) { lines.delete(line); editorCount-- }
  else if (editorCount >= MAX_POINTS) return false
  else { lines.set(line, true); editorCount++ }
  if (lines.size) editorPoints.set(at, lines)
  else editorPoints.delete(at)
  emit()
  return true
}
export function setBreakpointEnabled(path: string, line: number, enabled: boolean) {
  const lines = editorPoints.get(path)
  if (!lines?.has(line) || lines.get(line) === enabled) return
  lines.set(line, enabled); emit()
}
export function removeBreakpoints(path?: string, line?: number) {
  for (const [p, lines] of [...editorPoints]) {
    if (path !== undefined && p !== path) continue
    for (const l of [...lines.keys()]) if (line === undefined || l === line) { lines.delete(l); editorCount-- }
    if (!lines.size) editorPoints.delete(p)
  }
  emit()
}
/**
 * Lines of `path` were edited: from line `from` (1-based) on, `removed` lines went and `added` came in
 * their place. Breakpoints below move with their text; those on removed lines go.
 */
export function shiftBreakpoints(path: string, from: number, removed: number, added: number) {
  const lines = editorPoints.get(path)
  if (!lines || removed === added) return
  const next = new Map<number, boolean>()
  for (const [line, enabled] of lines) {
    if (line < from) next.set(line, enabled)
    else if (line >= from + removed) next.set(line - removed + added, enabled)
    else editorCount--
  }
  if (next.size) editorPoints.set(path, next)
  else editorPoints.delete(path)
  emit()
}
/** A file or folder moved: its breakpoints follow it. */
export function moveBreakpoints(from: string, to: string) {
  let moved = false
  for (const [p, lines] of [...editorPoints]) {
    const dest = p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : null
    if (dest === null) continue
    editorPoints.delete(p)
    const into = editorPoints.get(dest)
    if (into) { for (const [l, e] of lines) { if (into.has(l)) editorCount--; into.set(l, e) } }
    else editorPoints.set(dest, lines)
    moved = true
  }
  if (moved) emit()
}

/** Explicit opt-in only. No terminal or agent execution is observed implicitly. */
export class DebugSession {
  readonly id = `msh-${++serial}`
  readonly abort = new AbortController()
  private points = new Set<string>()
  private mode: Mode
  private pauseRequested = false
  /** Stop at the editor's breakpoints too (Xed launched it, or the user attached Xed to it). */
  private editor = false
  private frames: Frame[] = []
  private root: Frame = { kind: 'script', name: '-c', filename: '-c' }
  private sources = new Map<string, string>()
  private release?: () => void
  private snapshot: DebugSnapshot
  /** start: 'first' stops before the first command (the default), 'run' only at breakpoints, a path at the first command of that file. */
  constructor(label: string, start: DebugStart = 'first') {
    // Completed sessions are evicted first; live sessions are never silently detached.
    if (sessions.size >= MAX_SESSIONS) {
      const old = [...sessions.values()].find(s => s.done)
      if (!old) throw new Error(`msh debug: ${MAX_SESSIONS} active sessions; stop one first`)
      sessions.delete(old.id)
    }
    this.mode = start === 'first' ? { kind: 'into' } : start === 'run' ? { kind: 'run' } : { kind: 'entry', filename: start.entry }
    this.snapshot = { id: this.id, label, state: 'running', variables: {}, breakpoints: [], args: [], locals: [], frames: [], pauses: 0 }
    sessions.set(this.id, this)
    emit()
  }
  get current(): DebugSnapshot { return this.snapshot }
  get done() { return ['completed', 'cancelled', 'failed'].includes(this.snapshot.state) }
  get usesEditorBreakpoints() { return this.editor }
  /** Xed opts a session in to its gutter breakpoints when it launches or attaches to it. */
  useEditorBreakpoints() { if (!this.editor) { this.editor = true; emit() } }
  /** The hash of a file's text as this session parsed it (see sourceHash), if it ran that file. */
  sourceOf(filename: string) { return this.sources.get(filename) }
  /** Toggles a session-only breakpoint (separate from the editor's). */
  breakpoint(filename: string, line: number) {
    if (!Number.isInteger(line) || line < 1) return
    const at = key(filename, line)
    if (this.points.has(at)) this.points.delete(at)
    else if (this.points.size < MAX_POINTS) this.points.add(at)
    this.snapshot = { ...this.snapshot, breakpoints: [...this.points] }; emit()
  }
  /** Stop at the next command, whatever frame it is in. */
  pause() { if (!this.done && this.snapshot.state === 'running') this.pauseRequested = true }
  continue() { this.resume({ kind: 'run' }) }
  /** Step into: the next command, entering functions, sourced files and scripts. */
  stepInto() { this.resume({ kind: 'into' }) }
  /** Step over: the next command in this frame or a frame it returns to. */
  stepOver() { this.resume({ kind: 'over', depth: this.frames.length }) }
  /** Step out: the next command after the current function or script returns. */
  stepOut() { this.resume({ kind: 'out', depth: this.frames.length }) }
  /** The original single step, kept for callers that used it: step into. */
  step() { this.stepInto() }
  private resume(mode: Mode) {
    if (this.snapshot.state !== 'paused') return
    this.mode = mode
    this.pauseRequested = false
    this.snapshot = { ...this.snapshot, state: 'running', frames: [] }
    const release = this.release; this.release = undefined; release?.(); emit()
  }
  cancel() { if (!this.done) { this.abort.abort(); this.finish(130) } }
  finish(status: number) {
    if (this.done) return
    this.snapshot = { ...this.snapshot, status, frames: [], state: this.abort.signal.aborted || status === 130 ? 'cancelled' : status ? 'failed' : 'completed' }
    const release = this.release; this.release = undefined; release?.(); emit()
  }

  // --- frames, from the interpreter -----------------------------------------------------------------
  /** A script, function or substitution starts. Returns the matching `leave`. */
  enter(kind: FrameKind, name: string, filename: string, source?: string): () => void {
    if (source !== undefined && filename.startsWith('/') && (this.sources.has(filename) || this.sources.size < MAX_SOURCES)) this.sources.set(filename, sourceHash(source))
    const top = this.frames[this.frames.length - 1] ?? this.root
    const frame: Frame = { kind, name: name.slice(0, 200), filename, call: top.at }
    this.frames.push(frame)
    let left = false
    return () => {
      if (left) return
      left = true
      const i = this.frames.lastIndexOf(frame)
      if (i >= 0) this.frames.splice(i)
    }
  }

  private stack(location: SourceSpan): DebugFrame[] {
    const out: DebugFrame[] = []
    let at: SourceSpan | undefined = location
    for (let i = this.frames.length - 1; i >= 0 && out.length < MAX_FRAMES; i--) {
      const f = this.frames[i]
      out.push({ kind: f.kind, name: f.name, filename: at?.filename ?? f.filename, line: at?.line ?? 0, column: at?.column ?? 0 })
      at = f.call
    }
    if (at && out.length < MAX_FRAMES) out.push({ kind: 'script', name: this.snapshot.label.slice(0, 200), filename: at.filename, line: at.line, column: at.column })
    return out
  }

  async checkpoint(location: SourceSpan, variables: Record<string, string>, signal: AbortSignal, budget?: Budget, extra?: { args?: readonly string[]; locals?: Iterable<string> }) {
    if (this.done || signal.aborted || this.abort.signal.aborted) return
    const depth = this.frames.length
    const frame = this.frames[depth - 1] ?? this.root
    frame.at = location
    // A line event, as in Python's debugger: execution reaches another line, or jumps back (a loop).
    const last = frame.last
    const lineEvent = !last || last.filename !== location.filename || last.line !== location.line || location.start <= last.start
    frame.last = { line: location.line, start: location.start, filename: location.filename }
    // $(…) text has no file of its own (-c coordinates): stepping passes over it into what it calls.
    const sourceless = location.filename === '-c' && frame.kind === 'substitution'
    const mode = this.mode
    let reason: PauseReason | null = null
    if (this.pauseRequested) reason = 'pause'
    else if (lineEvent && (this.points.has(key(location.filename, location.line)) || (this.editor && editorHit(location.filename, location.line)))) reason = 'breakpoint'
    else if (sourceless) reason = null
    else if (mode.kind === 'into') reason = 'step'
    else if (mode.kind === 'over' && depth <= mode.depth) reason = 'step'
    else if (mode.kind === 'out' && depth < mode.depth) reason = 'step'
    else if (mode.kind === 'entry' && location.filename === mode.filename) reason = 'entry'
    // Capture only at stops, with explicit bounds. No polling or frame work while idle.
    if (!reason) return
    if (this.snapshot.pauses === 0 && reason === 'step' && mode.kind === 'into') reason = 'entry'
    const copy: Record<string, string> = Object.create(null)
    let count = 0, held = 0
    for (const k in variables) {
      if (!Object.hasOwn(variables, k)) continue
      if (count++ >= MAX_VARS) break
      const value = variables[k].slice(0, MAX_VALUE)
      if (budget?.step() || budget?.write(k.length + value.length, held)) return
      held += k.length + value.length
      copy[k] = value
    }
    const args: string[] = []
    for (const a of extra?.args?.slice(0, MAX_ARGS) ?? []) {
      const value = a.slice(0, MAX_VALUE)
      if (budget?.write(value.length, held)) return
      held += value.length
      args.push(value)
    }
    const locals = [...(extra?.locals ?? [])].slice(0, MAX_VARS)
    this.pauseRequested = false
    let stop = () => {}
    try {
      await new Promise<void>(resolve => {
        stop = () => { this.finish(130); resolve() }
        this.release = resolve
        signal.addEventListener('abort', stop, { once: true })
        this.abort.signal.addEventListener('abort', stop, { once: true })
        this.snapshot = {
          ...this.snapshot, state: 'paused', reason, pauses: this.snapshot.pauses + 1,
          location: { ...location, expression: location.expression.slice(0, MAX_VALUE) }, variables: copy, args, locals, frames: this.stack(location),
        }
        emit()
      })
    } finally {
      signal.removeEventListener('abort', stop)
      this.abort.signal.removeEventListener('abort', stop)
    }
  }
}
