import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { debugRevision, debugSessions, editorBreakpoints, removeBreakpoints, setBreakpointEnabled, sourceHash, subscribeDebug, toggleBreakpoint, type DebugSession, type DebugStart } from '../terminal/msh/debug'
import { launchDebug } from '../terminal/msh/interp'
import '../terminal/commands' // install the normal executable/command/security hooks
import { formatDiagnostic, type Diagnostic } from '../terminal/msh/analysis'
import type { Token } from '../terminal/msh/parse'
import { evaluateWatch, MAX_WATCHES, variableAt, WATCH_DISPLAY, watchError, type WatchResult } from '../terminal/msh/watch'
import { useWM } from '../os/wm'
import { HOME } from '../terminal/vfs'
import { setAccent } from '../os/theme'
import { toUi } from '../os/uiScale'

// Xed's msh debugger: the run/step toolbar, the panel under the editor (output, variables, watches,
// breakpoints, call stack, problems), the hover over variables and the paused-line marker. The
// sessions, frames and breakpoints themselves live in terminal/msh/debug.ts.

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
export const isMsh = (path: string, text: string) => /\.(msh|sh)$/.test(path) || /^#!.*\bmsh\b/.test(text)
const OUTPUT_LIMIT = 32768
const fileName = (p: string) => p.split('/').pop() || p
const dirName = (p: string) => p.replace(/\/[^/]*$/, '') || '/'

export function MshHighlight({ text, tokens }: { text: string; tokens: Token[] }) {
  let end = 0
  return <>{tokens.map((t, i) => {
    const gap = text.slice(end, t.start)
    end = t.end
    const cls = t.k === 'op' || t.k === 'io' ? 'md-punct' : t.k === 'arith' ? 'md-code' : t.k === 'word' && /^(if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function)$/.test(t.v) ? 'md-bullet' : t.k === 'word' && /['"$`]/.test(t.v) ? 'md-code' : undefined
    return <span key={i}>{gap}<span className={cls}>{text.slice(t.start, t.end)}</span></span>
  })}{text.slice(end)}</>
}

export type DebugUiState = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
type Tab = 'output' | 'variables' | 'watch' | 'breakpoints' | 'stack' | 'problems'
type Inspect = { name: string; result: WatchResult | { ok: false; error: string } }

/**
 * The debugger of one Xed window. Xed owns only sessions it launches (stopped when the window
 * closes); attaching to another session in this page shows it and applies the editor's
 * breakpoints to it, but never takes over its lifetime.
 */
export function useXedDebug({ path, text, dirty, ready, root, caret, save, reveal, say, lineHeight, pad }: {
  /** The active tab's file, or null. */
  path: string | null; text: string; dirty: boolean; ready: boolean; root: string
  /** The caret's offset in `text`, for inspecting the variable under it. */
  caret: number
  /** Saves the active file; true once it is saved. */
  save: () => Promise<boolean>
  /** Shows a file at a line (0-based) without moving the caret or selection of other files. */
  reveal: (path: string, line: number) => void
  say: (message: string) => void
  lineHeight: number; pad: number
}) {
  const wm = useWM()
  useSyncExternalStore(subscribeDebug, debugRevision)
  const [selected, select] = useState('')
  const [output, setOutput] = useState('')
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('output')
  const [height, setHeight] = useState(220)
  const [watches, setWatches] = useState<string[]>([])
  const [hover, setHover] = useState<{ x: number; y: number; inspect: Inspect } | null>(null)
  const owned = useRef<DebugSession[]>([])
  const starting = useRef(false)
  useEffect(() => () => { for (const s of owned.current) s.cancel() }, [])

  const sessions = debugSessions()
  const session = sessions.find(s => s.id === selected) ?? null
  const snap = session?.current ?? null
  const state: DebugUiState = snap?.state ?? 'idle'
  const paused = state === 'paused'
  const live = state === 'running' || paused
  const msh = !!path && isMsh(path, text)
  const runnable = !path ? 'Open an msh script to run it' : !msh ? 'Run works for msh scripts: .msh or .sh files, or an msh shebang' : !path.startsWith('/') ? 'Only files on the file system can run' : !ready ? 'The file is still loading' : null
  const owner = !!session && owned.current.includes(session)

  // Whether the editor shows the text this session parsed for the file. Hashing only when it ran it.
  const ran = session && path ? session.sourceOf(path) : undefined
  const differs = useMemo(() => ran !== undefined && ran !== sourceHash(text), [ran, text])
  const pausedLine = paused && snap?.location && snap.location.filename === path ? snap.location.line : null
  const inStack = paused && !!path && !!snap && (snap.location?.filename === path || snap.frames.some(f => f.filename === path))

  // A new pause shows its source: another file's tab opens, the editor scrolls there.
  const shown = useRef('')
  useEffect(() => {
    if (!paused || !snap?.location) return
    const at = `${snap.id}:${snap.pauses}`
    if (shown.current === at) return
    shown.current = at
    setOpen(true)
    if (snap.location.filename.startsWith('/')) reveal(snap.location.filename, snap.location.line - 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, snap?.id, snap?.pauses])

  const launch = async (start: DebugStart) => {
    if (live || starting.current) return
    if (runnable || !path) return say(runnable ?? 'Nothing to run')
    starting.current = true
    try {
      if (dirty) {
        say(`Saving ${fileName(path)} before running it…`)
        if (!(await save())) return say(`Not run: ${fileName(path)} could not be saved, and running would use the old saved text`)
      }
      setOutput('')
      let cwd = root
      const result = launchDebug(`msh ${quote(path)}`, {
        cwd, setCwd: p => { cwd = p }, env: { HOME, PWD: root, SHELL: '/bin/msh' }, history: [], windows: wm.windows,
        openApp: wm.open, openNewApp: wm.openNew, closeWindow: wm.close, clear() {}, exit() {}, setAccent,
        print: s => setOutput(o => (o + s + '\n').slice(-OUTPUT_LIMIT)), live() {}, size: { cols: 80, rows: 24 }, onKey() {}, signal: new AbortController().signal,
      }, path, { start, editorBreakpoints: true })
      owned.current = [...owned.current.filter(s => !s.done), result.session]
      select(result.session.id)
      setOpen(true)
      setTab('output')
      void result.done.catch(e => setOutput(o => (o + String(e) + '\n').slice(-OUTPUT_LIMIT)))
    } catch (e) {
      setOutput(String(e))
      setOpen(true)
    } finally {
      starting.current = false
    }
  }

  const actions = {
    /** F5: continue a pause, or run the active script (saving it first) until a breakpoint. */
    run: () => (paused ? session!.continue() : state === 'running' ? say('Already running. Pause with F6 or stop with Shift+F5') : void launch('run')),
    stepOver: () => (paused ? session!.stepOver() : !live && path ? void launch({ entry: path }) : undefined),
    stepInto: () => (paused ? session!.stepInto() : !live && path ? void launch({ entry: path }) : undefined),
    stepOut: () => paused && session!.stepOut(),
    pause: () => state === 'running' && session!.pause(),
    stop: () => live && session!.cancel(),
    attach: (id: string) => {
      select(id)
      const s = debugSessions().find(x => x.id === id)
      if (!s) return
      s.useEditorBreakpoints()
      setOpen(true)
    },
    toggleBreakpoint: (line: number) => {
      if (!path || !msh) return say('Breakpoints go in msh scripts')
      if (!path.startsWith('/')) return say('Breakpoints need a file on the file system')
      if (!toggleBreakpoint(path, line + 1)) say('Breakpoint list is full (256)')
    },
  }

  const inspect = (name: string): Inspect | null => {
    if (!paused || !snap) return null
    if (!inStack) return { name, result: { ok: false, error: 'This file is not in the paused call stack' } }
    return { name, result: evaluateWatch(name, snap) }
  }
  const atCaret = paused && msh ? variableAt(text, caret) : null
  const caretInspect = atCaret ? inspect(atCaret) : null

  /** Mouse over the editor while paused: the variable under the pointer, from the pause's snapshot. */
  const hoverAt = (e: ReactMouseEvent<HTMLTextAreaElement>) => {
    if (!paused || !msh) return hover && setHover(null)
    const el = e.currentTarget
    const offset = offsetAt(el, e.clientX, e.clientY, lineHeight, pad)
    const name = offset === null ? null : variableAt(el.value, offset)
    const found = name ? inspect(name) : null
    if (!found) return hover && setHover(null)
    const box = el.getBoundingClientRect()
    const scale = box.width / (el.offsetWidth || 1)
    const next = { x: (e.clientX - box.left) / scale, y: Math.floor(((e.clientY - box.top) / scale - pad) / lineHeight) * lineHeight + pad + lineHeight, inspect: found }
    if (!hover || hover.inspect.name !== name || hover.y !== next.y || Math.abs(hover.x - next.x) > 40) setHover(next)
  }
  useEffect(() => { if (!paused) setHover(null) }, [paused])

  const hoverTip = hover && paused ? (
    <div className="xed-hover" role="tooltip" style={{ left: hover.x, top: hover.y }}>
      <InspectLine inspect={hover.inspect} differs={differs} />
    </div>
  ) : null

  const addWatch = (expr: string) => {
    const e = expr.trim()
    if (!e) return false
    if (watches.length >= MAX_WATCHES) { say(`At most ${MAX_WATCHES} watches`); return false }
    const why = watchError(e)
    if (why) { say(`Not watched: ${why}`); return false }
    if (!watches.includes(e)) setWatches(w => [...w, e])
    setOpen(true)
    return true
  }

  return {
    session, snap, state, paused, live, owner, msh, runnable, dirty, differs, pausedLine, sessions, selected,
    output, setOutput, open, setOpen, tab, setTab, height, setHeight, watches, setWatches, addWatch,
    caretInspect, hoverAt, hoverOut: () => setHover(null), hoverTip, inStack, actions,
  }
}
export type XedDebugCtl = ReturnType<typeof useXedDebug>

/** The character offset under a point of the editor's textarea (monospace, tabs of 2), or null. */
function offsetAt(el: HTMLTextAreaElement, clientX: number, clientY: number, lineHeight: number, pad: number): number | null {
  const box = el.getBoundingClientRect()
  const scale = box.width / (el.offsetWidth || 1)
  const x = (clientX - box.left) / scale
  const y = (clientY - box.top) / scale - pad
  if (y < 0) return null
  const line = Math.floor(y / lineHeight)
  const lines = el.value.split('\n')
  if (line >= lines.length) return null
  const width = charWidth(el)
  if (!width) return null
  const col = x / width
  const text = lines[line]
  let visual = 0
  for (let i = 0; i < text.length; i++) {
    const w = text[i] === '\t' ? 2 - (visual % 2) : 1
    if (col < visual + w) return lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + i
    visual += w
  }
  return null
}
let measured: { font: string; width: number } | null = null
function charWidth(el: HTMLElement) {
  const style = getComputedStyle(el)
  const font = `${style.fontSize} ${style.fontFamily}`
  if (measured?.font === font) return measured.width
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return 0
  ctx.font = font
  measured = { font, width: ctx.measureText('0'.repeat(100)).width / 100 }
  return measured.width
}

function shown(value: string) {
  return value.length > WATCH_DISPLAY ? `${value.slice(0, WATCH_DISPLAY)}…` : value
}

function InspectLine({ inspect, differs }: { inspect: Inspect; differs?: boolean }) {
  const r = inspect.result
  return <>
    <span className="xed-var-name">{inspect.name}</span>
    {r.ok ? <> = <span className="xed-var-value">{shown(r.value) || <span className="muted">(empty)</span>}</span>{(r.value.length > WATCH_DISPLAY || ('truncated' in r && r.truncated)) && <span className="muted"> ({r.value.length}{'truncated' in r && r.truncated ? '+' : ''} characters)</span>}</> : <span className="xed-var-error"> {r.error}</span>}
    {differs && <span className="xed-var-note">The editor text differs from what is running</span>}
  </>
}

// --- toolbar ----------------------------------------------------------------------------------------

const Icon = ({ d, fill }: { d: string; fill?: boolean }) => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
)
const ICONS = {
  run: 'M4.5 2.8v10.4L13 8z',
  pause: 'M4 3h3v10H4zM9 3h3v10H9z',
  stop: 'M3.5 3.5h9v9h-9z',
  over: 'M2.5 9a5.5 5.5 0 0 1 11 0M13.5 4.5V9H9M8 12.2a1.3 1.3 0 1 0 0 .1',
  into: 'M8 1.5v7M5 5.5l3 3 3-3M8 12.2a1.3 1.3 0 1 0 0 .1',
  out: 'M8 9V2M5 5l3-3 3 3M8 12.2a1.3 1.3 0 1 0 0 .1',
}

export function stateText(ctl: XedDebugCtl) {
  const s = ctl.snap
  switch (ctl.state) {
    case 'idle': return 'Not running'
    case 'running': return 'Running'
    case 'paused': {
      const at = s?.location
      const why = s?.reason === 'breakpoint' ? 'breakpoint' : s?.reason === 'pause' ? 'paused' : s?.reason === 'entry' ? 'entry' : 'step'
      return at ? `Paused (${why}) · ${at.filename === '-c' ? 'launch line' : `${fileName(at.filename)}:${at.line}`}` : 'Paused'
    }
    case 'completed': return `Completed · exit ${s?.status ?? 0}`
    case 'failed': return `Failed · exit ${s?.status ?? 1}`
    case 'cancelled': return 'Stopped'
  }
}

/** The state in a few characters, for phones: the full text stays in the title and for screen readers. */
function shortState(ctl: XedDebugCtl) {
  const s = ctl.snap
  switch (ctl.state) {
    case 'idle': return 'Idle'
    case 'running': return 'Running'
    case 'paused': return s?.location && s.location.filename !== '-c' ? `Paused :${s.location.line}` : 'Paused'
    case 'completed': case 'failed': return `Exit ${s?.status ?? ''}`
    case 'cancelled': return 'Stopped'
  }
}

export function XedDebugToolbar({ ctl }: { ctl: XedDebugCtl }) {
  const { state, paused, live, runnable, actions } = ctl
  const canStart = !live && !runnable
  const runLabel = paused ? 'Continue' : 'Run'
  const runTitle = paused ? 'Continue (F5)' : runnable ?? (ctl.state === 'running' ? 'Running' : `Run ${ctl.msh ? 'this script' : ''} until a breakpoint (F5)${canStart && ctl.dirty ? '. Saves the file first' : ''}`)
  return (
    <div className={`xed-dbg-bar is-${state}`} role="toolbar" aria-label="Debugger">
      <button className="xed-dbg-btn is-run" onClick={actions.run} disabled={!paused && !canStart} title={runTitle} aria-label={runLabel} aria-keyshortcuts="F5">
        <Icon d={ICONS.run} fill />
        <span className="xed-dbg-label">{paused ? 'Continue' : ctl.state === 'running' ? 'Running' : ctl.dirty && canStart ? 'Save & Run' : 'Run'}</span>
      </button>
      <button className="xed-dbg-btn" onClick={actions.pause} disabled={state !== 'running'} title="Pause at the next command (F6)" aria-label="Pause" aria-keyshortcuts="F6"><Icon d={ICONS.pause} fill /></button>
      <button className="xed-dbg-btn is-stop" onClick={actions.stop} disabled={!live} title="Stop (Shift+F5)" aria-label="Stop" aria-keyshortcuts="Shift+F5"><Icon d={ICONS.stop} fill /></button>
      <span className="xed-dbg-sep" aria-hidden />
      <button className="xed-dbg-btn" onClick={actions.stepOver} disabled={!paused && !canStart} title={paused ? 'Step over: the next command here, running calls to the end (F10)' : 'Start and stop at the first command (F10)'} aria-label="Step over" aria-keyshortcuts="F10"><Icon d={ICONS.over} /></button>
      <button className="xed-dbg-btn" onClick={actions.stepInto} disabled={!paused && !canStart} title={paused ? 'Step into: the next command, inside functions and sourced files (F11)' : 'Start and stop at the first command (F11)'} aria-label="Step into" aria-keyshortcuts="F11"><Icon d={ICONS.into} /></button>
      <button className="xed-dbg-btn" onClick={actions.stepOut} disabled={!paused} title="Step out: run to the end of this function or script (Shift+F11)" aria-label="Step out" aria-keyshortcuts="Shift+F11"><Icon d={ICONS.out} /></button>
      <span className={`xed-dbg-state is-${state}`} role="status" aria-live="polite" title={ctl.snap ? `${stateText(ctl)} · ${ctl.snap.id} · ${ctl.snap.label}` : undefined}>
        <span className="xed-dbg-long">{stateText(ctl)}</span>
        <span className="xed-dbg-short" aria-hidden>{shortState(ctl)}</span>
      </span>
    </div>
  )
}

// --- panel ------------------------------------------------------------------------------------------

export function XedDebugPanel({ ctl, path, caretLine, diagnostics, commands, jump }: {
  ctl: XedDebugCtl; path: string | null; caretLine: number
  diagnostics: Diagnostic[]
  /** Lines of the active file with a command to stop at (null when unknown). */
  commands: ReadonlySet<number> | null
  jump: (path: string, line: number, col: number) => void
}) {
  const { snap, paused, actions, tab, setTab } = ctl
  const points = editorBreakpoints()
  const frames = paused && snap ? snap.frames : []
  const varCount = paused && snap ? Object.keys(snap.variables).length + snap.args.length : 0
  const tabs: [Tab, string, number | null][] = [
    ['output', 'Output', null], ['variables', 'Variables', paused ? varCount : null], ['watch', 'Watch', ctl.watches.length || null],
    ['breakpoints', 'Breakpoints', points.length || null], ['stack', 'Call stack', frames.length || null], ['problems', 'Problems', diagnostics.length || null],
  ]
  const resize = (e: ReactPointerEvent) => {
    e.preventDefault()
    const startY = toUi(e.clientY)
    const startH = ctl.height
    const room = ((e.currentTarget as HTMLElement).closest('.zed-main')?.clientHeight ?? 600) - 120
    const move = (ev: PointerEvent) => ctl.setHeight(Math.round(Math.max(90, Math.min(room, startH - (toUi(ev.clientY) - startY)))))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const go = (file: string, line: number, col = 1) => file.startsWith('/') && jump(file, line - 1, col - 1)
  let body: ReactNode
  if (tab === 'output') {
    body = <>
      {ctl.session && !ctl.owner && <p className="xed-dbg-empty">This session was started elsewhere; its output goes where it was started.</p>}
      {ctl.output ? <pre className="xed-dbg-output selectable" aria-label="Debug output">{ctl.output}</pre> : ctl.owner || !ctl.session ? <p className="xed-dbg-empty">{ctl.runnable ?? 'Run the script (F5) to see its output here. Interactive input is not available; use the terminal panel for that.'}</p> : null}
    </>
  } else if (tab === 'variables') {
    if (!paused || !snap) body = <p className="xed-dbg-empty">{notPaused(ctl)}</p>
    else {
      const locals = new Set(snap.locals)
      const names = Object.keys(snap.variables).sort((a, b) => Number(locals.has(b)) - Number(locals.has(a)) || a.localeCompare(b))
      body = <table className="xed-vars selectable" aria-label="Variables at this pause">
        <tbody>
          {snap.args.map((v, i) => <VarRow key={`$${i + 1}`} name={`$${i + 1}`} tag="argument" value={v} onWatch={() => ctl.addWatch(`$${i + 1}`)} />)}
          {names.map(k => <VarRow key={k} name={k} tag={locals.has(k) ? 'local' : undefined} value={snap.variables[k]} onWatch={() => ctl.addWatch(k)} />)}
        </tbody>
      </table>
    }
  } else if (tab === 'watch') {
    body = <WatchList ctl={ctl} />
  } else if (tab === 'breakpoints') {
    body = <>
      <div className="xed-dbg-actions">
        <button onClick={() => actions.toggleBreakpoint(caretLine)} disabled={!ctl.msh} title="Toggle a breakpoint on the caret's line (F9)" aria-keyshortcuts="F9">Toggle line {caretLine + 1}</button>
        <button onClick={() => removeBreakpoints()} disabled={!points.length}>Remove all</button>
      </div>
      {!points.length ? <p className="xed-dbg-empty">No breakpoints. Click the gutter next to a line number, or press F9 on a line.</p> : (
        <ul className="xed-bps" aria-label="Breakpoints">
          {points.map(b => {
            const dead = b.path === path && commands !== null && !commands.has(b.line)
            return <li key={`${b.path}:${b.line}`} className={b.enabled ? '' : 'is-off'}>
              <input type="checkbox" checked={b.enabled} onChange={e => setBreakpointEnabled(b.path, b.line, e.target.checked)} aria-label={`Enable breakpoint ${fileName(b.path)} line ${b.line}`} />
              <button className="xed-link" onClick={() => go(b.path, b.line)} title={`${b.path}:${b.line}`}>{fileName(b.path)}:{b.line}</button>
              <span className="muted xed-bp-dir">{dirName(b.path)}</span>
              {dead && <span className="xed-bp-note" title="Execution never stops on a line without a command">no command on this line</span>}
              <button className="xed-x" onClick={() => removeBreakpoints(b.path, b.line)} aria-label={`Remove breakpoint ${fileName(b.path)} line ${b.line}`} title="Remove">×</button>
            </li>
          })}
        </ul>
      )}
      {points.length > 0 && !ctl.session?.usesEditorBreakpoints && ctl.session && <p className="xed-dbg-empty">The selected session does not use these breakpoints.</p>}
    </>
  } else if (tab === 'stack') {
    body = !paused ? <p className="xed-dbg-empty">{notPaused(ctl)}</p> : (
      <ol className="xed-stack" aria-label="Call stack">
        {frames.map((f, i) => (
          <li key={i} className={i === 0 ? 'is-top' : ''}>
            <button className="xed-link" disabled={!f.filename.startsWith('/')} onClick={() => go(f.filename, f.line, f.column)} title={f.filename.startsWith('/') ? `${f.filename}:${f.line}:${f.column}` : 'No source file: the launch line or $(…) text'}>
              <span className="xed-frame-name">{f.kind === 'function' ? `${f.name}()` : f.kind === 'substitution' ? '$(…)' : fileName(f.name)}</span>
              <span className="muted"> {f.filename.startsWith('/') ? `${fileName(f.filename)}:${f.line}` : 'launch line'}</span>
            </button>
          </li>
        ))}
      </ol>
    )
  } else {
    body = !diagnostics.length ? <p className="xed-dbg-empty">No problems found by the msh parser.</p> : diagnostics.map((d, i) => <button key={i} className="xed-diagnostic xed-link" onClick={() => jump(d.filename, d.line - 1, d.column - 1)}>{formatDiagnostic(d)}</button>)
  }
  return (
    <section className="xed-dbg" aria-label="msh debugger" style={{ height: ctl.height }}>
      <div className="zed-dock-grip" onPointerDown={resize} role="separator" aria-orientation="horizontal" aria-label="Resize the debug panel" />
      <div className="xed-dbg-head">
        <div className="xed-dbg-tabs" role="tablist" aria-label="Debug views">
          {tabs.map(([id, label, count]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={`xed-dbg-tab ${tab === id ? 'is-active' : ''} ${id === 'problems' && count ? 'has-problems' : ''}`} onClick={() => setTab(id)}>
              {label}{count !== null && <span className="xed-dbg-count">{count}</span>}
            </button>
          ))}
        </div>
        <select className="xed-dbg-session" aria-label="Debug session" value={ctl.selected} onChange={e => actions.attach(e.target.value)} title="Sessions in this page. Choosing one Xed did not start attaches to it: it then stops at these breakpoints too.">
          <option value="">No session</option>
          {ctl.sessions.map(s => <option key={s.id} value={s.id}>{s.id} · {fileName(s.current.label)} · {s.current.state}</option>)}
        </select>
        <button className="zed-dock-btn" onClick={() => ctl.setOpen(false)} title="Hide the debug panel" aria-label="Hide the debug panel">⌄</button>
      </div>
      {ctl.caretInspect && <div className="xed-dbg-caret" aria-live="polite"><span className="muted">At caret:</span> <InspectLine inspect={ctl.caretInspect} /> <button className="xed-link" onClick={() => ctl.addWatch(ctl.caretInspect!.name)}>Watch</button></div>}
      {ctl.differs && ctl.live && <div className="xed-dbg-warn" role="note">The editor text of this file differs from the source this session is running (it was edited or changed on disk). Lines and markers may not match; stop and run again to use the new text.</div>}
      <div className="xed-dbg-body" role="tabpanel">{body}</div>
    </section>
  )
}

function notPaused(ctl: XedDebugCtl) {
  if (ctl.state === 'running') return 'Running. Values show while paused (F6 pauses).'
  if (ctl.state === 'idle') return 'Not running. Values show when the script is paused at a breakpoint or a step.'
  return 'The session has ended; values from its last pause are cleared.'
}

function VarRow({ name, value, tag, onWatch }: { name: string; value: string; tag?: string; onWatch: () => void }) {
  return <tr>
    <th scope="row"><span className="xed-var-name">{name}</span>{tag && <span className="xed-var-tag">{tag}</span>}</th>
    <td className="xed-var-value" title={value.length > WATCH_DISPLAY ? `${value.length} characters` : undefined}>{shown(value) || <span className="muted">(empty)</span>}</td>
    <td><button className="xed-link" onClick={onWatch} aria-label={`Watch ${name}`}>Watch</button></td>
  </tr>
}

function WatchList({ ctl }: { ctl: XedDebugCtl }) {
  const [draft, setDraft] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ctl.addWatch(draft)) setDraft('')
  }
  return <>
    <form className="xed-watch-add" onSubmit={submit}>
      <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="name, $1, ${#name} or text with $refs" aria-label="Add watch expression" maxLength={200} spellCheck={false} autoCapitalize="off" />
      <button type="submit" disabled={!draft.trim() || ctl.watches.length >= MAX_WATCHES}>Add</button>
    </form>
    {!ctl.watches.length ? <p className="xed-dbg-empty">Watches read variables of the paused script. They never run commands.</p> : (
      <ul className="xed-watches selectable" aria-label="Watches">
        {ctl.watches.map(w => {
          const r = ctl.paused && ctl.snap ? evaluateWatch(w, ctl.snap) : null
          return <li key={w}>
            <span className="xed-var-name">{w}</span>
            {r ? (r.ok ? <span className="xed-var-value"> = {shown(r.value) || <span className="muted">(empty)</span>}{(r.truncated || r.value.length > WATCH_DISPLAY) && <span className="muted"> (truncated)</span>}</span> : <span className="xed-var-error"> {r.error}</span>) : <span className="muted"> — not paused</span>}
            <button className="xed-x" onClick={() => ctl.setWatches(ws => ws.filter(x => x !== w))} aria-label={`Remove watch ${w}`} title="Remove">×</button>
          </li>
        })}
      </ul>
    )}
  </>
}
