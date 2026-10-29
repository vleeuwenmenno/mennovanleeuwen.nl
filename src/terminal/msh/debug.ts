import type { Budget } from '../limits'
import type { SourceSpan } from './parse'

export type DebugState = 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'
export type DebugSnapshot = {
  id: string; label: string; state: DebugState; location?: SourceSpan
  variables: Readonly<Record<string, string>>; status?: number; breakpoints: readonly string[]
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

/** Explicit opt-in only. No terminal or agent execution is observed implicitly. */
export class DebugSession {
  readonly id = `msh-${++serial}`
  readonly abort = new AbortController()
  private points = new Set<string>()
  private stopping = true
  private release?: () => void
  private snapshot: DebugSnapshot
  constructor(label: string) {
    // Completed sessions are evicted first; live sessions are never silently detached.
    if (sessions.size >= 16) {
      const old = [...sessions.values()].find(s => s.done)
      if (!old) throw new Error('msh debug: 16 active sessions; stop one first')
      sessions.delete(old.id)
    }
    this.snapshot = { id: this.id, label, state: 'running', variables: {}, breakpoints: [] }
    sessions.set(this.id, this)
    emit()
  }
  get current(): DebugSnapshot { return this.snapshot }
  get done() { return ['completed', 'cancelled', 'failed'].includes(this.snapshot.state) }
  breakpoint(filename: string, line: number) {
    if (!Number.isInteger(line) || line < 1) return
    const at = key(filename, line)
    if (this.points.has(at)) this.points.delete(at)
    else if (this.points.size < 256) this.points.add(at)
    this.snapshot = { ...this.snapshot, breakpoints: [...this.points] }; emit()
  }
  pause() { if (!this.done) this.stopping = true }
  continue() { this.resume(false) }
  step() { this.resume(true) }
  private resume(step: boolean) {
    if (this.done) return
    this.stopping = step
    this.snapshot = { ...this.snapshot, state: 'running' }
    const release = this.release; this.release = undefined; release?.(); emit()
  }
  cancel() { if (!this.done) { this.abort.abort(); this.finish(130) } }
  finish(status: number) {
    if (this.done) return
    this.snapshot = { ...this.snapshot, status, state: this.abort.signal.aborted || status === 130 ? 'cancelled' : status ? 'failed' : 'completed' }
    const release = this.release; this.release = undefined; release?.(); emit()
  }
  async checkpoint(location: SourceSpan, variables: Record<string, string>, signal: AbortSignal, budget?: Budget) {
    if (this.done || signal.aborted || this.abort.signal.aborted) return
    // Capture only at stops, with explicit bounds. No polling or frame work while idle.
    if (!this.stopping && !this.points.has(key(location.filename, location.line))) return
    const copy: Record<string, string> = Object.create(null)
    let count = 0, held = 0
    for (const k in variables) {
      if (!Object.hasOwn(variables, k)) continue
      if (count++ >= 256) break
      const value = variables[k].slice(0, 4096)
      if (budget?.step() || budget?.write(k.length + value.length, held)) return
      held += k.length + value.length
      copy[k] = value
    }
    let stop = () => {}
    try {
      await new Promise<void>(resolve => {
        stop = () => { this.finish(130); resolve() }
        this.release = resolve
        signal.addEventListener('abort', stop, { once: true })
        this.abort.signal.addEventListener('abort', stop, { once: true })
        this.snapshot = { ...this.snapshot, state: 'paused', location: { ...location, expression: location.expression.slice(0, 4096) }, variables: copy }
        emit()
      })
    } finally {
      signal.removeEventListener('abort', stop)
      this.abort.signal.removeEventListener('abort', stop)
    }
  }
}
