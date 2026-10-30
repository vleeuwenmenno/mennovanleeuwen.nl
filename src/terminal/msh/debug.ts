import { getAccount, subscribeAccount } from '../../os/account'
import type { Budget } from '../limits'
import type { Node, SourceSpan } from './parse'

export type DebugState = 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'
/** Why the session stopped: the first command, a step, a breakpoint or a pause request. */
export type PauseReason = 'entry' | 'step' | 'breakpoint' | 'pause'
/** A script (msh file, source, ./script, msh -c), a function call or a $(…) substitution. */
export type FrameKind = 'script' | 'function' | 'substitution'
/** One level of the call stack at a pause; `line`/`column` is where that frame is now. */
export type DebugFrame = { id: string; values?: DebugValues; kind: FrameKind; name: string; filename: string; line: number; column: number }
export type DebugBindings = {
  args: readonly string[]; params: Iterable<string>; locals: Iterable<string>
  entries: () => Iterable<{ name: string; value: string | undefined; scope: 'parameter' | 'local' | 'global'; inherited: boolean; identity: string }>
}
export type DebugValues = {
  variables: Readonly<Record<string, string>>; args: readonly string[]
  cut: { variables: Readonly<Record<string, number>>; args: Readonly<Record<number, number>> }
  argCount: number; variableCount: number
  locals: readonly string[]; params: readonly string[]; unset: readonly string[]
  scopes: Readonly<Record<string, { kind: 'parameter' | 'local' | 'global'; inherited: boolean; identity: string }>>
  /** Prior complete values only, for the same session/frame/binding, bounded to display text. */
  changes: Readonly<Record<string, string>>
}
export type DebugSnapshot = DebugValues & {
  id: string; label: string; state: DebugState; location?: SourceSpan
  status?: number; breakpoints: readonly string[]
  /** Innermost first. Empty unless paused. A frame beyond the shared capture bound has no values. */
  frames: readonly DebugFrame[]
  reason?: PauseReason
  pauses: number
}
const emptyValues = (): DebugValues => ({ variables: {}, args: [], cut: { variables: {}, args: {} }, argCount: 0, variableCount: 0, locals: [], params: [], unset: [], scopes: {}, changes: {} })
/** How the session runs after a resume. `over`/`out` compare frame depth at the time of the step. */
type Mode = { kind: 'run' } | { kind: 'into' } | { kind: 'over'; depth: number } | { kind: 'out'; depth: number } | { kind: 'entry'; filename: string }
/** Where a new session first stops: before its first command, only at breakpoints, or at the first command of a file. */
export type DebugStart = 'first' | 'run' | { entry: string }
type Frame = { id: string; bindings?: () => DebugBindings; kind: FrameKind; name: string; filename: string; call?: SourceSpan; at?: SourceSpan; last?: { line: number; start: number; filename: string } }

const MAX_SESSIONS = 16
const MAX_POINTS = 256
export const SNAPSHOT_LIMITS = { variables: 256, value: 4096, args: 64, characters: 65536 } as const
const MAX_VARS = SNAPSHOT_LIMITS.variables
const MAX_VALUE = SNAPSHOT_LIMITS.value
const MAX_ARGS = SNAPSHOT_LIMITS.args
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
  private nextFrame = 0
  private previous = new Map<string, DebugValues>()
  private root: Frame = { id: 'root', kind: 'script', name: '-c', filename: '-c' }
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
    this.snapshot = { id: this.id, label, state: 'running', ...emptyValues(), breakpoints: [], frames: [], pauses: 0 }
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
    this.previous = new Map(this.snapshot.frames.flatMap(f => f.values ? [[f.id, f.values] as const] : []))
    this.snapshot = { ...this.snapshot, ...emptyValues(), state: 'running', frames: [] }
    const release = this.release; this.release = undefined; release?.(); emit()
  }
  clearHistory() {
    this.previous.clear()
    this.snapshot = { ...this.snapshot, changes: {}, frames: this.snapshot.frames.map(f => ({ ...f, values: f.values ? { ...f.values, changes: {} } : undefined })) }
  }
  cancel() { if (!this.done) { this.abort.abort(); this.finish(130) } }
  finish(status: number) {
    if (this.done) return
    this.previous.clear()
    this.root.bindings = undefined; this.root.at = undefined
    for (const frame of this.frames) frame.bindings = undefined
    this.snapshot = { ...this.snapshot, ...emptyValues(), status, frames: [], state: this.abort.signal.aborted || status === 130 ? 'cancelled' : status ? 'failed' : 'completed' }
    const release = this.release; this.release = undefined; release?.(); emit()
  }

  // --- frames, from the interpreter -----------------------------------------------------------------
  /** A subshell executes in this frame, but owns a different environment. No extra step/frame. */
  useBindings(bindings: () => DebugBindings): () => void {
    if (this.done) return () => {}
    const frame = this.frames[this.frames.length - 1] ?? this.root
    const saved = frame.bindings
    frame.bindings = bindings
    return () => { frame.bindings = this.done ? undefined : saved }
  }

  /** A script, function or substitution starts. Returns the matching `leave`. */
  enter(kind: FrameKind, name: string, filename: string, source?: string, bindings?: () => DebugBindings): () => void {
    if (source !== undefined && filename.startsWith('/') && (this.sources.has(filename) || this.sources.size < MAX_SOURCES)) this.sources.set(filename, sourceHash(source))
    const top = this.frames[this.frames.length - 1] ?? this.root
    const frame: Frame = { id: `${this.id}:${++this.nextFrame}`, bindings, kind, name: name.slice(0, 200), filename, call: top.at }
    this.frames.push(frame)
    let left = false
    return () => {
      if (left) return
      left = true
      const i = this.frames.lastIndexOf(frame)
      if (i >= 0) for (const removed of this.frames.splice(i)) this.previous.delete(removed.id)
    }
  }

  private stack(location: SourceSpan, capture: (f: Frame) => DebugValues | undefined): DebugFrame[] {
    const out: DebugFrame[] = []
    let at: SourceSpan | undefined = location
    for (let i = this.frames.length - 1; i >= 0 && out.length < MAX_FRAMES; i--) {
      const f = this.frames[i]
      out.push({ id: f.id, values: capture(f), kind: f.kind, name: f.name, filename: at?.filename ?? f.filename, line: at?.line ?? 0, column: at?.column ?? 0 })
      at = f.call
    }
    if (at && out.length < MAX_FRAMES) out.push({ id: this.root.id, values: capture(this.root), kind: 'script', name: this.snapshot.label.slice(0, 200), filename: at.filename, line: at.line, column: at.column })
    return out
  }

  async checkpoint(location: SourceSpan, variables: Record<string, string>, signal: AbortSignal, budget?: Budget, extra?: { args?: readonly string[]; locals?: Iterable<string>; bindings?: () => DebugBindings }) {
    if (this.done || signal.aborted || this.abort.signal.aborted) return
    const depth = this.frames.length
    const frame = this.frames[depth - 1] ?? this.root
    frame.at = location
    // The executing shell can change without entering a frame, notably inside ( ... ).
    frame.bindings = extra?.bindings ?? (() => ({ args: extra?.args ?? [], params: [], locals: extra?.locals ?? [], entries: function* () {
      for (const name in variables) if (Object.hasOwn(variables, name)) yield { name, value: variables[name], scope: 'global' as const, inherited: false, identity: name }
    } }))
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
    // One shared bound across every caller and executing frame, not a fresh budget per frame.
    let varsLeft = MAX_VARS, argsLeft = MAX_ARGS, charsLeft = SNAPSHOT_LIMITS.characters as number
    let held = 0
    const charge = (size: number) => {
      if (budget?.step() || budget?.write(size, held)) return false
      held += size
      return true
    }
    const capture = (f: Frame): DebugValues | undefined => {
      if (!f.bindings) return undefined
      const source = f.bindings()
      const values = emptyValues()
      const copy: Record<string, string> = Object.create(null), cutVars: Record<string, number> = Object.create(null)
      const scopes: Record<string, DebugValues['scopes'][string]> = Object.create(null)
      const changes: Record<string, string> = Object.create(null)
      const unset: string[] = [], locals: string[] = [], params: string[] = []
      const previous = this.previous.get(f.id)
      for (const entry of source.entries()) {
        if (budget?.stopped) return undefined
        const { name, value, scope, inherited, identity } = entry
        values.variableCount++
        if (!varsLeft || charsLeft < name.length) continue
        varsLeft--; charsLeft -= name.length
        if (!charge(name.length + identity.length + 32)) return undefined
        scopes[name] = { kind: scope, inherited, identity }
        if (scope === 'parameter' && !inherited) params.push(name)
        if (scope === 'local' && !inherited) locals.push(name)
        if (value === undefined) unset.push(name)
        else {
          const captured = value.slice(0, Math.min(MAX_VALUE, charsLeft))
          charsLeft -= captured.length
          if (!charge(captured.length)) return undefined
          copy[name] = captured
          if (captured.length < value.length) cutVars[name] = value.length
        }
        if (previous?.scopes[name]?.identity === identity && previous.cut.variables[name] === undefined && cutVars[name] === undefined) {
          const wasSet = Object.hasOwn(previous.variables, name)
          if ((wasSet && previous.variables[name] !== value) || (previous.unset.includes(name) && value !== undefined)) {
            const before = wasSet ? previous.variables[name] === '' ? '(empty)' : previous.variables[name].slice(0, 120) + (previous.variables[name].length > 120 ? '…' : '') : '(unset)'
            if (before.length <= charsLeft) {
              if (!charge(before.length)) return undefined
              changes[name] = before; charsLeft -= before.length
            }
          }
        }
      }
      const args: string[] = [], cutArgs: Record<number, number> = Object.create(null)
      for (const arg of source.args) {
        if (!argsLeft || !charsLeft) break
        const value = arg.slice(0, Math.min(MAX_VALUE, charsLeft))
        if (!charge(value.length)) return undefined
        argsLeft--; charsLeft -= value.length
        if (value.length < arg.length) cutArgs[args.length] = arg.length
        args.push(value)
      }
      return { ...values, variables: copy, cut: { variables: cutVars, args: cutArgs }, args, argCount: source.args.length, locals, params, unset, scopes, changes }
    }
    const frames = this.stack(location, capture)
    if (budget?.stopped) return
    const values = frames[0]?.values ?? emptyValues()
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
          location: { ...location, expression: location.expression.slice(0, MAX_VALUE) }, ...values, frames,
        }
        emit()
      })
    } finally {
      signal.removeEventListener('abort', stop)
      this.abort.signal.removeEventListener('abort', stop)
    }
  }
}

// A debugger snapshot is private to the account that created it; never retain it across sign-out.
let debugAccount = getAccount().user?.id
const clearDebugAccount = () => { for (const session of sessions.values()) session.cancel(); sessions.clear(); emit() }
subscribeAccount(() => {
  const next = getAccount().user?.id
  if (next !== debugAccount) { debugAccount = next; clearDebugAccount() }
})
if (typeof window !== 'undefined') window.addEventListener('mvlos:forget', clearDebugAccount)
