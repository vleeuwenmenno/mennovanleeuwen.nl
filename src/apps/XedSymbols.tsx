import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { getAccount, subscribeAccount } from '../os/account'
import { lookup, readFileText } from '../terminal/fs'
import { allows } from '../terminal/modes'
import { SHELL_BUILTINS } from '../terminal/msh/interp'
import { completeSymbols, indexProject, resolveSymbol, SYMBOL_LIMITS, type Completion, type SymbolDef, type SymbolProject } from '../terminal/msh/symbols'
import { isMsh, offsetAt } from './XedDebug'

// Static intelligence is separate from the debugger's runtime snapshots. It may inspect open
// buffers and authorized local files, but never evaluates shell or fetches remote source files.
export function useXedSymbols({ path, buffers, root, caret, go, insert, say, lineHeight, pad }: {
  path: string | null; buffers: Record<string, { text: string; loading?: boolean; error?: string }>; root: string; caret: number
  go: (path: string, line: number, col: number, len: number) => void
  insert: (completion: Completion) => void; say: (message: string) => void; lineHeight: number; pad: number
}) {
  const [index, setIndex] = useState<{ key: object; project: SymbolProject } | null>(null)
  const [inspectAt, setInspectAt] = useState<number | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const [revoked, setRevoked] = useState(false)
  const history = useRef<{ path: string; line: number; col: number }[]>([])
  const live = useRef(true)
  const authorityRevoked = useRef(false)
  const navigation = useRef<AbortController | null>(null)
  const currentCaret = useRef(caret); currentCaret.current = caret
  const generation = useRef(0)
  const buffer = path ? buffers[path] : null
  const enabled = !revoked && !!path && !!buffer && !buffer.loading && !buffer.error && isMsh(path, buffer.text)
  const key = useMemo(() => ({}), [path, buffers, root, epoch])
  const currentKey = useRef(key); currentKey.current = key
  useEffect(() => {
    live.current = true
    let account = getAccount().user?.id
    const clear = () => { authorityRevoked.current = true; navigation.current?.abort(); setRevoked(true); generation.current++; history.current = []; setIndex(null); setInspectAt(null); setExpanded(false); setCompleting(false); setEpoch(n => n + 1) }
    const unsubscribe = subscribeAccount(() => { const next = getAccount().user?.id; if (next !== account) { account = next; clear() } })
    window.addEventListener('mvlos:forget', clear)
    return () => { live.current = false; navigation.current?.abort(); generation.current++; unsubscribe(); window.removeEventListener('mvlos:forget', clear) }
  }, [])
  const readLocal = async (target: string, signal: AbortSignal): Promise<string | null> => {
    if (signal.aborted) return null
    // Unsaved open buffers always take precedence over disk, including sourced files.
    const b = buffers[target]
    if (b && !b.loading && !b.error) return b.text
    const node = lookup(target)
    if (!node || node.type !== 'file' || node.sf || node.dev || (node.size ?? 0) > SYMBOL_LIMITS.characters) return null
    if (!allows(target, node, 'r', false)) throw new Error('Permission denied')
    const result = await readFileText(target, false, { root: false, signal })
    return signal.aborted ? null : result?.text ?? null
  }
  useEffect(() => {
    const controller = new AbortController(), gen = ++generation.current
    setInspectAt(null); setCompleting(false)
    if (!enabled || !path) { setIndex(null); return () => controller.abort() }
    const timer = setTimeout(() => {
      void indexProject(path, root, readLocal, controller.signal).then(project => {
        if (!controller.signal.aborted && live.current && gen === generation.current && key === currentKey.current) setIndex({ key, project })
      }).catch(() => { /* A cancelled/unavailable index cannot replace newer editor state. */ })
    }, 120)
    return () => { clearTimeout(timer); controller.abort(); navigation.current?.abort() }
  }, [key, enabled, path, root, buffers])
  const project = index?.key === key ? index.project : null
  const resolution = useMemo(() => project && path ? (resolveSymbol(project, path, inspectAt ?? caret) ?? (inspectAt === null && caret > 0 ? resolveSymbol(project, path, caret - 1) : null)) : null, [project, path, inspectAt, caret])
  const completions = useMemo(() => completing && project && path ? completeSymbols(project, path, caret, SHELL_BUILTINS) : [], [completing, project, path, caret])
  const navigate = async (d: SymbolDef) => {
    if (!live.current || authorityRevoked.current || !project || !path || !buffer || currentKey.current !== key) return
    navigation.current?.abort()
    const controller = new AbortController(); navigation.current = controller
    // An open buffer is the authority. A closed source may have changed since it was indexed.
    if (buffers[d.path]?.loading || buffers[d.path]?.error) { say('Source is still loading or unavailable'); return }
    if (!buffers[d.path]) {
      let latest: string | null
      try { latest = await readLocal(d.path, controller.signal) }
      catch { if (!controller.signal.aborted) say('Source is no longer readable'); return }
      if (controller.signal.aborted || !live.current || authorityRevoked.current || currentKey.current !== key || currentCaret.current !== caret) return
      if (latest !== project.files.get(d.path)?.text) { setEpoch(n => n + 1); say('Source changed; rebuilding symbols before navigation'); return }
    }
    const before = buffer.text.slice(0, caret)
    history.current = [...history.current, { path, line: before.split('\n').length - 1, col: before.length - before.lastIndexOf('\n') - 1 }].slice(-32)
    go(d.path, d.line - 1, d.column - 1, d.end - d.start)
    setInspectAt(null); setCompleting(false)
  }
  const definition = (at = caret) => {
    if (!live.current || authorityRevoked.current) return
    setExpanded(true); setInspectAt(at)
    const found = project && path ? (resolveSymbol(project, path, at) ?? (at === caret && at > 0 ? resolveSymbol(project, path, at - 1) : null)) : null
    if (found?.reliable && found.definitions.length === 1) navigate(found.definitions[0])
    else say(!project ? 'Symbol index is loading' : found?.note ?? 'No msh symbol at the caret')
  }
  const back = () => {
    const previous = history.current.pop()
    if (previous) go(previous.path, previous.line, previous.col, 0)
  }
  const click = (e: MouseEvent<HTMLTextAreaElement>) => {
    if (!enabled || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.button !== 0) return
    const at = offsetAt(e.currentTarget, e.clientX, e.clientY, lineHeight, pad)
    if (at === null) return
    e.preventDefault(); definition(at)
  }
  const hover = (e: MouseEvent<HTMLTextAreaElement>) => {
    if (!enabled) return
    const at = offsetAt(e.currentTarget, e.clientX, e.clientY, lineHeight, pad)
    setInspectAt(at)
  }
  const complete = () => { setExpanded(true); setCompleting(true); setInspectAt(null) }
  const apply = (c: Completion) => { if (live.current && !authorityRevoked.current && project && currentKey.current === key) insert(c); setCompleting(false) }
  return { enabled, project, resolution, completions, completing, complete, apply, click, hover, leave: () => setInspectAt(null), definition, back, canBack: history.current.length > 0, expanded, setExpanded, navigate }
}
export type XedSymbolsCtl = ReturnType<typeof useXedSymbols>

export function XedSymbolsPanel({ ctl }: { ctl: XedSymbolsCtl }) {
  if (!ctl.enabled) return null
  const r = ctl.resolution
  return <section className="xed-symbols" aria-label="msh symbols">
    <div className="xed-symbol-actions">
      <button onClick={() => ctl.definition()} title="Go to Definition (Ctrl/Cmd+Click or Alt+G)" aria-keyshortcuts="Alt+G">Go to Definition</button>
      <button onClick={ctl.back} disabled={!ctl.canBack} title="Back from definition (Alt+Left)" aria-keyshortcuts="Alt+ArrowLeft">Back</button>
      <button onClick={ctl.complete} title="Complete msh symbol (Ctrl+Space)" aria-keyshortcuts="Control+Space">Complete</button>
      <button onClick={() => ctl.setExpanded(!ctl.expanded)} aria-expanded={ctl.expanded}>Symbols</button>
      {r && <span className="xed-symbol-summary">Static: {r.reference.name} · {r.reference.kind === 'positional' ? 'positional argument' : r.definitions[0]?.kind ?? r.reference.kind}{r.definitions[0] ? ` · ${r.definitions[0].path}:${r.definitions[0].line}` : ''}{!r.reliable && r.definitions.length ? ' (candidate)' : ''}</span>}
    </div>
    {ctl.expanded && <div className="xed-symbol-details">
      {!ctl.project ? <p>Indexing msh symbols…</p> : <>
        {ctl.completing && <ul className="xed-completions" aria-label="msh completions">{ctl.completions.length ? ctl.completions.map(c => <li key={c.name}><button onClick={() => ctl.apply(c)}><b>{c.name}</b> <span>{c.detail}</span></button></li>) : <li>No matching symbols</li>}</ul>}
        {r ? <><p>{r.note}</p><ul className="xed-definitions">{r.definitions.map(d => <li key={d.id}><button onClick={() => ctl.navigate(d)}>{d.signature ?? d.name} · {d.kind} · {d.path}:{d.line}:{d.column}{r.reliable ? '' : ' · candidate'}</button></li>)}</ul></> : <p>Place the caret on a shell symbol, or hover over one. Static origins are separate from paused runtime values.</p>}
        {ctl.project.notes.map(note => <p className="muted" key={note}>{note}</p>)}
      </>}
    </div>}
  </section>
}
