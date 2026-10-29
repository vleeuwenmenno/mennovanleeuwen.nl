import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { debugRevision, debugSessions, subscribeDebug, type DebugSession } from '../terminal/msh/debug'
import { launchDebug } from '../terminal/msh/interp'
import '../terminal/commands' // install the normal executable/command/security hooks
import { analyzeMsh, formatDiagnostic } from '../terminal/msh/analysis'
import type { Token } from '../terminal/msh/parse'
import { useWM } from '../os/wm'
import { HOME } from '../terminal/vfs'
import { setAccent } from '../os/theme'

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
export const isMsh = (path: string, text: string) => /\.(msh|sh)$/.test(path) || /^#!.*\bmsh\b/.test(text)

export function MshHighlight({ text, tokens }: { text: string; tokens: Token[] }) {
  let end = 0
  return <>{tokens.map((t, i) => {
    const gap = text.slice(end, t.start)
    end = t.end
    const cls = t.k === 'op' || t.k === 'io' ? 'md-punct' : t.k === 'arith' ? 'md-code' : t.k === 'word' && /^(if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function)$/.test(t.v) ? 'md-bullet' : t.k === 'word' && /['"$`]/.test(t.v) ? 'md-code' : undefined
    return <span key={i}>{gap}<span className={cls}>{text.slice(t.start, t.end)}</span></span>
  })}{text.slice(end)}</>
}

/** Xed owns only sessions it launches; attaching never adopts their lifetime. */
export function XedDebug({ path, text, saved, root, line, jump }: { path: string | null; text: string; saved: boolean; root: string; line: number; jump: (path: string, line: number, col: number) => void }) {
  const wm = useWM()
  useSyncExternalStore(subscribeDebug, debugRevision)
  const [selected, select] = useState('')
  const [output, setOutput] = useState('')
  const owned = useRef<DebugSession[]>([])
  useEffect(() => () => { for (const session of owned.current) session.cancel() }, [])
  const sessions = debugSessions()
  const session = sessions.find(s => s.id === selected)
  const state = session?.current
  const msh = !!path && isMsh(path, text)
  const launch = () => {
    if (!path || !saved) return
    setOutput('')
    let cwd = root
    try {
      const result = launchDebug(`msh ${quote(path)}`, {
        cwd, setCwd: p => { cwd = p }, env: { HOME, PWD: root, SHELL: '/bin/msh' }, history: [], windows: wm.windows,
        openApp: wm.open, openNewApp: wm.openNew, closeWindow: wm.close, clear() {}, exit() {}, setAccent,
        print: s => setOutput(o => (o + s + '\n').slice(-32768)), live() {}, size: { cols: 80, rows: 24 }, onKey() {}, signal: new AbortController().signal,
      }, path)
      owned.current = [...owned.current.filter(s => !s.done), result.session]
      select(result.session.id)
      void result.done.catch(e => setOutput(String(e)))
    } catch (e) { setOutput(String(e)) }
  }
  if (!msh && !sessions.length) return null
  const diagnostics = msh ? analyzeMsh(text, path!).diagnostics : []
  return <section className="xed-debug" aria-label="msh debugger">
    <div className="xed-debug-controls">
      <button disabled={!msh || !saved || !!session && !session.done} onClick={launch} title="Save changes first. Runs the saved file through msh with normal file and command permissions.">Debug saved file</button>
      <select aria-label="Attach debug session" value={selected} onChange={e => select(e.target.value)}>
        <option value="">Attach explicit session…</option>
        {sessions.map(s => <option key={s.id} value={s.id}>{s.id} · {s.current.label} · {s.current.state}</option>)}
      </select>
      <button disabled={!session || session.done || state?.state === 'paused'} onClick={() => session?.pause()}>Pause</button>
      <button disabled={state?.state !== 'paused'} onClick={() => session?.continue()}>Continue</button>
      <button disabled={state?.state !== 'paused'} onClick={() => session?.step()}>Step</button>
      <button disabled={!session || session.done} onClick={() => session?.cancel()}>Stop</button>
      <button disabled={!session || !path} onClick={() => path && session?.breakpoint(path, line + 1)}>Breakpoint line {line + 1}</button>
    </div>
    {diagnostics.map((d, i) => <button key={i} className="xed-diagnostic" onClick={() => jump(d.filename, d.line - 1, d.column - 1)}>{formatDiagnostic(d)}</button>)}
    {state && <>
      <div role="status">{state.state}{state.status !== undefined ? ` · status ${state.status}` : ''} {state.location && <button disabled={state.location.filename === '-c'} onClick={() => jump(state.location!.filename, state.location!.line - 1, state.location!.column - 1)}>{state.location.filename}:{state.location.line}:{state.location.column} · {state.location.expression}</button>}</div>
      <div>Breakpoints: {state.breakpoints.join(', ') || 'none'}</div>
      <details><summary>Variables at pause ({Object.keys(state.variables).length})</summary><pre>{Object.entries(state.variables).map(([k, v]) => `${k}=${v}`).join('\n')}</pre></details>
    </>}
    {output && <pre aria-label="Debug output">{output}</pre>}
  </section>
}
