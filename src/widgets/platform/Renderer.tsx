import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useDropTarget, type DragItem } from '../../os/dnd'
import { continueList } from './editor'
import type { BrokerResource, ResourceIntent } from './brokerTypes'
import { Icon } from './icons'
import type { Descriptor } from './package'
const linkOf = (item: DragItem) => {
  const launcher = item.kind === 'launcher' ? item : item.kind === 'file' ? item.launcher : null
  if (!launcher?.url || !/^https?:\/\//i.test(launcher.url)) return null
  return `[${launcher.label.replace(/[[\]]/g, '')}](${launcher.url})`
}
export function NativeEditor({ value, write }: { value: string; write: (text: string, expected: string) => string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const baseline = useRef(value)
  const commit = (el: HTMLTextAreaElement) => {
    const actual = write(el.value, baseline.current)
    baseline.current = actual
    if (el.value !== actual) el.value = actual
  }
  const insert = (start: number, end: number, text: string) => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(start, end)
    // Native edit transaction preserves undo and caret. Fallback is needed in some engines.
    if (!document.execCommand('insertText', false, text)) el.setRangeText(text, start, end, 'end')
    commit(el)
  }
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (composing.current) return
    if (el.value !== value) {
      const start = el.selectionStart, end = el.selectionEnd
      el.value = value
      el.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length))
    }
    baseline.current = value
    el.style.maxHeight = 'none'
    el.style.height = 'auto'
    el.style.height = `${Math.max(90, el.scrollHeight)}px`
  }, [value])
  useDropTarget(ref, {
    accept: drag => drag.items.some(linkOf) ? 'link' : null,
    drop: drag => {
      const el = ref.current
      const links = drag.items.map(linkOf).filter(Boolean).join('\n')
      if (el && links) insert(el.value.length, el.value.length, `${el.value && !el.value.endsWith('\n') ? '\n' : ''}${links}`)
    },
  })
  return <textarea ref={ref} className="wp-editor sticky-text selectable" aria-label="Note text" defaultValue={value} placeholder="Write something… (- [ ] makes a checklist)" spellCheck
    onChange={e => commit(e.currentTarget)}
    onCompositionStart={() => { composing.current = true }}
    onCompositionEnd={e => { composing.current = false; commit(e.currentTarget) }}
    onKeyDown={e => {
      if (e.key !== 'Enter' || e.nativeEvent.isComposing || composing.current || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
      const el = e.currentTarget
      const transaction = continueList(el.value, el.selectionStart, el.selectionEnd)
      if (!transaction) return
      e.preventDefault()
      insert(transaction.start, transaction.end, transaction.text)
    }} />
}
function ResourceDetails({ children, dismissed }: { children: ReactNode[]; dismissed: () => void }) {
  const root = useRef<HTMLDetailsElement>(null)
  const [pinned, setPinned] = useState(false), [hovered, setHovered] = useState(false)
  useEffect(() => {
    if (!pinned) return
    const down = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setPinned(false); dismissed() } }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setPinned(false); dismissed() } }
    document.addEventListener('pointerdown', down, true); document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true) }
  }, [pinned])
  return <details ref={root} className="wp-details" open={pinned || hovered} onPointerEnter={event => event.pointerType === 'mouse' && setHovered(true)} onPointerLeave={() => setHovered(false)}>
    <summary onClick={event => { event.preventDefault(); event.stopPropagation(); setPinned(value => !value) }}>{children[0]}</summary>
    <div role="status" className="wp-detail-body">{children.slice(1)}</div>
  </details>
}
export function Renderer({ view, note, write, event, actionsEnabled = true, resource }: { view: Descriptor; note?: string; write?: (text: string, expected: string) => string; actionsEnabled?: boolean; event: (id: string) => void; resource?: (handle: string) => BrokerResource | undefined }) {
  const closedAt = useRef(0)
  const [feedback, setFeedback] = useState('')
  const pending = useRef(new Set<string>())
  const resolve = (node: Descriptor, kind: BrokerResource['kind']) => actionsEnabled && node.resource ? (() => { const value = resource?.(node.resource!); return value?.kind === kind ? value : undefined })() : undefined
  const perform = (node: Descriptor, expected: 'action' | 'link', intent: ResourceIntent) => {
    const value = resolve(node, expected)
    if (!value?.run || !node.resource || pending.current.has(node.resource)) return
    pending.current.add(node.resource)
    try { Promise.resolve(value.run(intent)).then(() => setFeedback(value.label === 'Copy address' ? 'Copied ✓' : ''), () => setFeedback('Action unavailable')).finally(() => pending.current.delete(node.resource!)) }
    catch { pending.current.delete(node.resource); setFeedback('Action unavailable') }
  }
  const render = (node: Descriptor, path: string): ReactNode => {
    // 'wp-grid' belongs to the wallpaper, so the grid node's class is wp-lattice.
    const className = `wp-${node.type === 'grid' ? 'lattice' : node.type} wp-${node.tone ?? 'normal'}`
    const children = node.children?.map((child,index) => render(child,`${path}.${index}`))
    // Presentation fields become data attributes the stylesheet maps to host tokens; none is free-form.
    const look = { 'data-size': node.size, 'data-weight': node.weight, 'data-align': node.align, 'data-justify': node.justify, 'data-gap': node.gap, 'data-pad': node.pad, 'data-clamp': node.clamp, 'data-nowrap': node.wrap === false ? '' : undefined, 'data-span': node.span }
    const placed = node.columns ? { gridTemplateColumns: node.columns.map(t => t === 'auto' ? 'auto' : t === 'min' ? 'min-content' : `minmax(0, ${t})`).join(' ') } : undefined
    if (node.type === 'text') return <span key={path} className={className} title={node.hint} {...look}>{node.text}</span>
    if (node.type === 'badge') return <span key={path} className={className} title={node.hint} {...look}>{node.text}</span>
    if (node.type === 'icon') return <Icon key={path} name={node.name!} className={className} size={node.size} span={node.span} />
    if (node.type === 'progress') return <span key={path} className={className} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((node.value ?? 0) * 100)} {...look}><span style={{ width: `${(node.value ?? 0) * 100}%` }} /></span>
    if (node.type === 'divider') return <hr key={path} className="wp-divider" {...look} />
    if (node.type === 'spacer') return <span key={path} className="wp-spacer" aria-hidden {...look} />
    if (node.type === 'grid') return <div key={path} className={className} style={placed} {...look}>{children}</div>
    if (node.type === 'button') return <button key={path} type="button" className={className} {...look} disabled={!node.event || !actionsEnabled} onClick={() => node.event && event(node.event)}>{node.text}</button>
    if (node.type === 'editor') return null
    if (node.type === 'image') { const value = resolve(node,'image'); return value?.href ? <img key={path} className="wp-image" src={value.href} alt={node.text ?? ''} title={value.label} width={24} height={24} draggable={false} /> : <span key={path}>{node.text}</span> }
    if (node.type === 'dot') { const value = resolve(node,'color'); return <span key={path} className="wp-dot" style={{background:value?.color ?? 'var(--accent)'}} /> }
    if (node.type === 'action') return <button key={path} type="button" className={className} {...look} title={node.hint} disabled={!resolve(node,'action')} role={node.checked === undefined ? undefined : 'checkbox'} aria-checked={node.checked} onClick={e => { e.stopPropagation(); perform(node,'action',{modified:false,button:0}) }}>{node.text}{children}</button>
    if (node.type === 'link') {
      const value = resolve(node,'link')
      return <a key={path} className={className} {...look} href={value?.href} target="_blank" rel="noopener noreferrer" title={node.hint} aria-disabled={!value} tabIndex={value?0:-1} role={value?.href?undefined:"button"} onKeyDown={e=>{if(!value?.href&&(e.key==="Enter"||e.key===" ")){e.preventDefault();perform(node,"link",{modified:false,button:0})}}} onClick={e => {
        e.stopPropagation()
        if (!resolve(node,'link')) { e.preventDefault(); return }
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
        e.preventDefault(); perform(node,'link',{modified:false,button:0})
      }} onAuxClick={e => { e.stopPropagation(); if (!resolve(node,'link')) e.preventDefault() }}>{node.text}{children}</a>
    }
    if (node.type === 'details') return <ResourceDetails key={path} dismissed={() => { closedAt.current = Date.now() }}>{children ?? []}</ResourceDetails>
    if (node.type === 'card') return <div key={path} className="wp-card" {...look} title={node.hint} onClick={e => {
      if ((e.target as Element).closest('a,button,details,summary,textarea') || Date.now()-closedAt.current<400) return
      perform(node,'action',{modified:false,button:0})
    }}>{children}</div>
    return <div key={path} className={className} {...look}>{children}</div>
  }
  return <>{note !== undefined && write && <NativeEditor key="native-editor" value={note} write={write} />}{render(view, 'root')}{feedback && <span role="status">{feedback}</span>}</>
}
